const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const cors = require('cors');
const handball = require('./lib/handball');

const {
  parseMatchTickerUrl,
  parseTeamScheduleUrl,
  parseClubId,
  teamScheduleUrl,
  fetchUpcomingForTeamId,
  fetchClubTeams,
  fetchMatchDataBundle,
  parseNewMatchApi,
  buildTimeoutPopupFromNewApi,
  buildHalftimePopupFromNewApi,
  eventIndicatesGameStartOrResume,
  isHalbzeitpauseBlock,
  newestTimestamp,
  DEFAULT_ORIGIN,
} = handball;

const DEFAULT_CLUB_ID = '0w1rgr0';

// Debug helper function
const DEBUG = process.env.DEBUG === '1';
let reqIdCounter = 0;
let fetchLock = false; // Prevent overlapping fetches

function dbg(section, obj) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const compactJson = JSON.stringify(obj, null, 0);
  console.log(`[DEBUG-${section}] ${timestamp}: ${compactJson}`);
}

// Monotonic sourceStamp calculation
function calculateSourceStamp(summary, events) {
  const summaryTime = summary?.updatedAt ? new Date(summary.updatedAt).getTime() : 0;
  const newestEventTime = events && events.length > 0 ?
    Math.max(...events.map(e => new Date(e.timestamp || e.time || 0).getTime())) : 0;
  // Use content-based timestamp, not current time, to allow new games
  return Math.max(summaryTime, newestEventTime);
}

// Score regression protection
function protectScoreRegression(newScore, currentScore, isGameSwitch) {
  if (isGameSwitch) return newScore; // Allow reset on game switch

  const newTotal = (newScore.homeGoals || 0) + (newScore.awayGoals || 0);
  const currentTotal = (currentScore.homeGoals || 0) + (currentScore.awayGoals || 0);

  // Block regression unless it's a clear game switch
  if (newTotal < currentTotal) {
    dbg('SCORE_REGRESSION_BLOCKED', {
      newTotal,
      currentTotal,
      newScore,
      currentScore,
      reason: 'total score decreased'
    });
    return currentScore; // Keep current score
  }

  // Use MAX for individual team scores to prevent temporary dips
  return {
    homeGoals: Math.max(newScore.homeGoals || 0, currentScore.homeGoals || 0),
    awayGoals: Math.max(newScore.awayGoals || 0, currentScore.awayGoals || 0)
  };
}

// Game switch detection
function detectGameSwitch(newData, currentData) {
  const newTeams = `${newData.homeTeam || ''} vs ${newData.awayTeam || ''}`;
  const currentTeams = `${currentData.homeTeam || ''} vs ${currentData.awayTeam || ''}`;

  // Team names changed
  const teamChanged = newTeams !== currentTeams &&
    newTeams !== ' vs ' && currentTeams !== ' vs ' &&
    newData.homeTeam && newData.awayTeam;

  // Clear reset: previous > 0 goals, now ≤ 2 and smaller
  const newTotal = (newData.homeGoals || 0) + (newData.awayGoals || 0);
  const currentTotal = (currentData.homeGoals || 0) + (currentData.awayGoals || 0);
  const clearReset = currentTotal > 0 && newTotal <= 2 && newTotal < currentTotal;

  return teamChanged || clearReset;
}

// Deep diff for atomic writes
function hasRealChanges(newData, currentData) {
  const fields = ['homeTeam', 'awayTeam', 'homeGoals', 'awayGoals', 'period', 'lastScorer', 'lastEvent', 'lastEventType', 'lastEventPhotoUrl', 'gameStatus', 'homeLogoUrl', 'awayLogoUrl'];
  return fields.some(field => newData[field] !== currentData[field]);
}

// Helper: placeholder detection for team names
function isPlaceholderTeam(name) {
  const s = (name || '').trim().toLowerCase();
  return s === '' || s === 'heim' || s === 'gast';
}

// Preserve non-placeholder teams if incoming data contains placeholders
function preserveTeamsIfPlaceholder(newScoreData, currentScore) {
  const merged = { ...newScoreData };
  if (isPlaceholderTeam(merged.homeTeam) && !isPlaceholderTeam(currentScore.homeTeam)) {
    merged.homeTeam = currentScore.homeTeam;
  }
  if (isPlaceholderTeam(merged.awayTeam) && !isPlaceholderTeam(currentScore.awayTeam)) {
    merged.awayTeam = currentScore.awayTeam;
  }
  return merged;
}

// Valid-Packet Gate
function isValidPacket(nextData, currentData, ctx) {
  const reasons = [];
  const nextHome = (nextData.homeTeam || '').trim();
  const nextAway = (nextData.awayTeam || '').trim();
  const curHome = (currentData.homeTeam || '').trim();
  const curAway = (currentData.awayTeam || '').trim();

  if (!nextHome || !nextAway) {
    reasons.push('emptyTeams');
  }

  const nextHasPlaceholder = isPlaceholderTeam(nextHome) || isPlaceholderTeam(nextAway);
  const curBothPlaceholder = isPlaceholderTeam(curHome) && isPlaceholderTeam(curAway);
  if (nextHasPlaceholder && !curBothPlaceholder) {
    reasons.push('placeholderTeams');
  }

  const hg = nextData.homeGoals;
  const ag = nextData.awayGoals;
  const goalsFinite = Number.isFinite(hg) && Number.isFinite(ag);
  if (!goalsFinite) reasons.push('missingScore');
  if (goalsFinite && (hg < 0 || ag < 0 || hg > 80 || ag > 80)) reasons.push('implausibleScore');

  const sourceStamp = ctx && typeof ctx.sourceStamp === 'number' ? ctx.sourceStamp : null;
  const lastSourceStamp = ctx && typeof ctx.lastSourceStamp === 'number' ? ctx.lastSourceStamp : null;
  const isGameSwitch = !!(ctx && ctx.isGameSwitch);
  if (sourceStamp !== null && lastSourceStamp !== null) {
    if (!isGameSwitch && sourceStamp <= lastSourceStamp) {
      reasons.push('staleStamp');
    }
  }

  // If totally unreliable: placeholders and missing/zeroed score
  if (nextHasPlaceholder && (!goalsFinite || (hg === 0 && ag === 0)) && (!nextData.lastEvent || nextData.lastEvent.trim() === '')) {
    reasons.push('noReliableFields');
  }

  if (reasons.length > 0) {
    dbg('VALIDATION_REJECT', {
      reqId: ctx && ctx.reqId,
      reasons: Array.from(new Set(reasons)),
      preview: {
        homeTeam: nextHome, awayTeam: nextAway,
        homeGoals: hg, awayGoals: ag,
        lastEvent: (nextData.lastEvent || '').slice(0, 120)
      }
    });
    return false;
  }
  return true;
}


const app = express();
const PORT = 3000;

const DIR = __dirname;
const PUBLIC_DIR = path.join(DIR, 'public');
const ASSETS_DIR = path.join(DIR, 'assets');
const LOGO_DIR = path.join(ASSETS_DIR, 'logos');
const LOGO_DIR_ONLY_SPONSOR = path.join(ASSETS_DIR, 'logos_onlySponsor');
const PLAYERS_DIR = path.join(ASSETS_DIR, 'players');
const CLUB_LOGO_DIR = path.join(ASSETS_DIR, 'club_logo');
const TEAM_DIR = path.join(ASSETS_DIR, 'teams');
const DATA_DIR = path.join(DIR, 'data');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
const SCORE_FILE = path.join(DATA_DIR, 'score.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const ASSET_UPLOAD_TYPES = {
  sponsors: { dir: LOGO_DIR, urlPrefix: '/assets/logos', exts: /\.(png|jpe?g|gif|svg|webp)$/i },
  sponsorsOnly: { dir: LOGO_DIR_ONLY_SPONSOR, urlPrefix: '/assets/logos_onlySponsor', exts: /\.(png|jpe?g|gif|svg|webp)$/i },
  players: { dir: PLAYERS_DIR, urlPrefix: '/assets/players', exts: /\.(png|jpe?g|webp)$/i }
};

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use('/public', express.static(PUBLIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));

for (const d of [PUBLIC_DIR, ASSETS_DIR, LOGO_DIR, LOGO_DIR_ONLY_SPONSOR, PLAYERS_DIR, CLUB_LOGO_DIR, TEAM_DIR, DATA_DIR, DEBUG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
if (!fs.existsSync(SCORE_FILE)) fs.writeFileSync(SCORE_FILE, JSON.stringify({
  homeTeam: 'Heim', awayTeam: 'Gast',
  homeGoals: 0, awayGoals: 0,
  clock: '00:00', period: '1. Halbzeit', lastScorer: '',
  lastEvent: '', gameStatus: 'Live'
}, null, 2));
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  tickerUrl: '',
  homeLogoUrl: '',
  awayLogoUrl: '',
  clubId: DEFAULT_CLUB_ID,
  selectedTeamId: '',
  ourTeamId: '',
  scheduleUrl: '',
  ourTeamName: '',
  teamType: 'herren1',
}, null, 2));

const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; } };
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');

// Intelligente Event-Erkennung basierend auf Timestamps
function readSponsorLogos(logoDir, teamType) {
  try {
    const files = fs.readdirSync(logoDir)
      .filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f));
    console.log(`[logos] ${files.length} Sponsorlogos (${teamType})`);
  } catch (e) {
    console.log(`[logos] 0 Sponsorlogos (${teamType}) - Ordner existiert noch nicht`);
  }
}

// Initiale Logos für beide Verzeichnisse lesen
function readAllSponsorLogos() {
  const config = readJSON(CONFIG_FILE, {});
  readSponsorLogos(LOGO_DIR, 'herren1');
  readSponsorLogos(LOGO_DIR_ONLY_SPONSOR, 'onlySponsor');
}
readAllSponsorLogos();

// Separate Handler für jedes Verzeichnis
chokidar.watch(LOGO_DIR, { ignoreInitial: true })
  .on('add', () => readSponsorLogos(LOGO_DIR, 'herren1'))
  .on('unlink', () => readSponsorLogos(LOGO_DIR, 'herren1'))
  .on('change', () => readSponsorLogos(LOGO_DIR, 'herren1'));
chokidar.watch(LOGO_DIR_ONLY_SPONSOR, { ignoreInitial: true })
  .on('add', () => readSponsorLogos(LOGO_DIR_ONLY_SPONSOR, 'onlySponsor'))
  .on('unlink', () => readSponsorLogos(LOGO_DIR_ONLY_SPONSOR, 'onlySponsor'))
  .on('change', () => readSponsorLogos(LOGO_DIR_ONLY_SPONSOR, 'onlySponsor'));

app.get('/api/logos', (req, res) => {
  try {
    // Lade Config um teamType zu prüfen
    const config = readJSON(CONFIG_FILE, {});
    const teamType = config.teamType || 'herren1';

    // Wähle den richtigen Ordner basierend auf teamType
    const logoDir = teamType === 'onlySponsor' ? LOGO_DIR_ONLY_SPONSOR : LOGO_DIR;
    const logoPathPrefix = teamType === 'onlySponsor' ? '/assets/logos_onlySponsor' : '/assets/logos';

    // Read, filter and sort logos deterministically (natural filename order)
    const entries = fs.readdirSync(logoDir)
      .filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(f => `${logoPathPrefix}/${encodeURIComponent(f)}`);
    res.json({ logos: entries });
  } catch (e) {
    console.error('[logos] Error listing logos:', e.message);
    res.json({ logos: [] });
  }
});

function sanitizeAssetFilename(name, allowedExts) {
  const base = path.basename(String(name || '')).trim();
  if (!base || base === '.' || base === '..') return null;
  if (!allowedExts.test(base)) return null;
  if (/[\\/]/.test(base)) return null;
  return base;
}

function normalizePlayerBasename(playerName) {
  return String(playerName || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function filenameToDisplayName(filename) {
  return path.parse(String(filename || '')).name
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function validatePlayerDisplayName(name) {
  const displayName = String(name || '').trim().replace(/\s+/g, ' ');
  if (!displayName) return { ok: false, error: 'Name fehlt' };
  const parts = displayName.split(' ');
  if (parts.length < 2) {
    return { ok: false, error: 'Format: Vorname Nachname (mind. zwei Wörter)' };
  }
  if (!/^[\p{L}][\p{L}'\-.]*(?:\s+[\p{L}][\p{L}'\-.]*)+$/u.test(displayName)) {
    return { ok: false, error: 'Nur Buchstaben, Leerzeichen, Bindestrich/Apostroph' };
  }
  const basename = normalizePlayerBasename(displayName);
  if (!basename || !basename.includes('_')) {
    return { ok: false, error: 'Name ergibt keinen gültigen Dateinamen' };
  }
  return { ok: true, displayName, basename };
}

function parseImageDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return { error: 'Ungültige Bilddaten (Base64 erwartet)' };
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return { error: 'Leere Datei' };
  if (buf.length > 8 * 1024 * 1024) return { error: 'Datei zu groß (max. 8 MB)' };
  const ext = mime.includes('png') ? '.png'
    : mime.includes('webp') ? '.webp'
    : mime.includes('jpeg') || mime.includes('jpg') ? '.jpg'
    : null;
  if (!ext) return { error: 'Nur JPG, PNG oder WEBP erlaubt' };
  return { buf, mime, ext };
}

function safePlayerPath(filename) {
  const clean = sanitizeAssetFilename(filename, ASSET_UPLOAD_TYPES.players.exts);
  if (!clean) return null;
  const dest = path.resolve(PLAYERS_DIR, clean);
  const root = path.resolve(PLAYERS_DIR) + path.sep;
  if (!dest.startsWith(root)) return null;
  return { filename: clean, dest };
}

function listPlayers() {
  if (!fs.existsSync(PLAYERS_DIR)) return [];
  return fs.readdirSync(PLAYERS_DIR)
    .filter((f) => ASSET_UPLOAD_TYPES.players.exts.test(f) && f !== 'README.md')
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((f) => ({
      filename: f,
      displayName: filenameToDisplayName(f),
      basename: path.parse(f).name,
      url: `/assets/players/${encodeURIComponent(f)}`
    }));
}

app.get('/api/assets/list', (req, res) => {
  const type = String(req.query.type || '');
  const meta = ASSET_UPLOAD_TYPES[type];
  if (!meta) return res.status(400).json({ error: 'Ungültiger Typ (sponsors|sponsorsOnly|players)' });
  try {
    if (!fs.existsSync(meta.dir)) return res.json({ files: [] });
    const files = fs.readdirSync(meta.dir)
      .filter(f => meta.exts.test(f) && f !== 'README.md')
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(f => ({
        name: f,
        url: `${meta.urlPrefix}/${encodeURIComponent(f)}`
      }));
    res.json({ files });
  } catch (e) {
    console.error('[assets] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/assets/upload', (req, res) => {
  try {
    const type = String(req.body?.type || '');
    const meta = ASSET_UPLOAD_TYPES[type];
    if (!meta) return res.status(400).json({ error: 'Ungültiger Typ' });

    const dataUrl = String(req.body?.dataBase64 || '');
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Ungültige Bilddaten (Base64 erwartet)' });
    const mime = m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Leere Datei' });
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu groß (max. 8 MB)' });

    let filename = sanitizeAssetFilename(req.body?.filename, meta.exts);
    if (type === 'players') {
      const fromName = normalizePlayerBasename(req.body?.playerName || '');
      const extFromMime = mime.includes('png') ? '.png'
        : mime.includes('webp') ? '.webp'
        : '.jpg';
      const base = fromName || (filename ? path.parse(filename).name : '');
      if (!base) return res.status(400).json({ error: 'Spielername fehlt (z. B. Max Mustermann)' });
      filename = sanitizeAssetFilename(base + extFromMime, meta.exts);
    }
    if (!filename) return res.status(400).json({ error: 'Ungültiger Dateiname / Format' });

    if (!fs.existsSync(meta.dir)) fs.mkdirSync(meta.dir, { recursive: true });
    const dest = path.join(meta.dir, filename);
    if (!dest.startsWith(meta.dir + path.sep)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    fs.writeFileSync(dest, buf);
    console.log(`[assets] uploaded ${type}/${filename} (${buf.length} bytes)`);
    res.json({
      ok: true,
      name: filename,
      url: `${meta.urlPrefix}/${encodeURIComponent(filename)}`
    });
  } catch (e) {
    console.error('[assets] upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/assets/:type/:filename', (req, res) => {
  try {
    const type = String(req.params.type || '');
    const meta = ASSET_UPLOAD_TYPES[type];
    if (!meta) return res.status(400).json({ error: 'Ungültiger Typ' });
    const filename = sanitizeAssetFilename(req.params.filename, meta.exts);
    if (!filename) return res.status(400).json({ error: 'Ungültiger Dateiname' });
    const dest = path.join(meta.dir, filename);
    if (!dest.startsWith(meta.dir + path.sep)) {
      return res.status(400).json({ error: 'Ungültiger Pfad' });
    }
    if (!fs.existsSync(dest)) return res.status(404).json({ error: 'Datei nicht gefunden' });
    fs.unlinkSync(dest);
    console.log(`[assets] deleted ${type}/${filename}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[assets] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/players', (_req, res) => {
  try {
    res.json({ players: listPlayers() });
  } catch (e) {
    console.error('[players] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/players', (req, res) => {
  try {
    const validated = validatePlayerDisplayName(req.body?.playerName);
    if (!validated.ok) return res.status(400).json({ error: validated.error });

    const image = parseImageDataUrl(req.body?.dataBase64);
    if (image.error) return res.status(400).json({ error: image.error });

    if (!fs.existsSync(PLAYERS_DIR)) fs.mkdirSync(PLAYERS_DIR, { recursive: true });
    const filename = `${validated.basename}${image.ext}`;
    const target = safePlayerPath(filename);
    if (!target) return res.status(400).json({ error: 'Ungültiger Dateiname' });
    if (fs.existsSync(target.dest)) {
      return res.status(409).json({ error: `Spieler existiert bereits (${filename})` });
    }

    fs.writeFileSync(target.dest, image.buf);
    console.log(`[players] created ${filename}`);
    res.json({
      ok: true,
      player: {
        filename,
        displayName: validated.displayName,
        basename: validated.basename,
        url: `/assets/players/${encodeURIComponent(filename)}`
      }
    });
  } catch (e) {
    console.error('[players] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/players/:filename', (req, res) => {
  try {
    const current = safePlayerPath(req.params.filename);
    if (!current || !fs.existsSync(current.dest)) {
      return res.status(404).json({ error: 'Spieler nicht gefunden' });
    }

    const hasName = Object.prototype.hasOwnProperty.call(req.body || {}, 'playerName');
    const hasImage = Boolean(req.body?.dataBase64);
    if (!hasName && !hasImage) {
      return res.status(400).json({ error: 'Kein Name und kein Bild zum Speichern' });
    }

    let displayName = filenameToDisplayName(current.filename);
    let basename = path.parse(current.filename).name;
    let ext = path.parse(current.filename).ext.toLowerCase();
    let buf = null;

    if (hasName) {
      const validated = validatePlayerDisplayName(req.body.playerName);
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      displayName = validated.displayName;
      basename = validated.basename;
    }

    if (hasImage) {
      const image = parseImageDataUrl(req.body.dataBase64);
      if (image.error) return res.status(400).json({ error: image.error });
      buf = image.buf;
      ext = image.ext;
    }

    const nextFilename = `${basename}${ext}`;
    const next = safePlayerPath(nextFilename);
    if (!next) return res.status(400).json({ error: 'Ungültiger Dateiname' });

    if (next.filename !== current.filename && fs.existsSync(next.dest)) {
      return res.status(409).json({ error: `Zielname existiert bereits (${nextFilename})` });
    }

    if (buf) {
      fs.writeFileSync(next.dest, buf);
      if (next.filename !== current.filename) fs.unlinkSync(current.dest);
    } else if (next.filename !== current.filename) {
      fs.renameSync(current.dest, next.dest);
    }

    console.log(`[players] updated ${current.filename} -> ${next.filename}`);
    res.json({
      ok: true,
      player: {
        filename: next.filename,
        displayName,
        basename,
        url: `/assets/players/${encodeURIComponent(next.filename)}`
      }
    });
  } catch (e) {
    console.error('[players] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/players/:filename', (req, res) => {
  try {
    const target = safePlayerPath(req.params.filename);
    if (!target) return res.status(400).json({ error: 'Ungültiger Dateiname' });
    if (!fs.existsSync(target.dest)) return res.status(404).json({ error: 'Spieler nicht gefunden' });
    fs.unlinkSync(target.dest);
    console.log(`[players] deleted ${target.filename}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[players] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Test-Event für Overlay (manuell aus Admin auslösbar, einmalig an nächsten Poll)
let pendingTestEvent = null;
// Auszeit-Popup: einmalig an nächsten /api/score-Abruf anhängen, dann zurücksetzen
let pendingTimeoutPopup = null;
// Halbzeit-Popup: einmalig bei Ende 1. Halbzeit oder Admin-Test
let pendingHalftimePopup = null;
let fetchTimer = null;

app.post('/api/admin/test-event', (req, res) => {
  const { eventType, message, playerName } = req.body || {};
  pendingTestEvent = {
    eventType: (eventType || 'Goal').trim(),
    message: (message || '').trim(),
    playerName: (playerName || '').trim()
  };
  res.json({ ok: true, pending: pendingTestEvent });
});

app.post('/api/admin/test-timeout-popup', async (req, res) => {
  const score = readJSON(SCORE_FILE, {});
  const config = readJSON(CONFIG_FILE, {});
  const team = (req.body && req.body.team) === 'Away' ? 'Away' : 'Home';
  const tickerUrl = (config.tickerUrl || '').trim();

  let last5Events = [];
  let top3Home = [];
  let top3Away = [];

  if (parseMatchTickerUrl(tickerUrl)) {
    try {
      const { match, events, lineups } = await fetchMatchDataBundle(tickerUrl, { includeLineups: true });
      const parsed = parseNewMatchApi(match, events);
      const popup = buildTimeoutPopupFromNewApi(parsed, events, lineups, {
        is_home: team !== 'Away',
        team: { name: team === 'Away' ? parsed.awayTeam : parsed.homeTeam },
      });
      last5Events = popup.last5Events;
      top3Home = popup.top3Home;
      top3Away = popup.top3Away;
    } catch (err) {
      console.warn('[test-timeout-popup] Match-API-Fetch fehlgeschlagen:', err.message);
    }
  }

  if (last5Events.length === 0 && score.lastEvent) {
    const timeMatch = (score.lastEvent || '').match(/^(\d{1,2}:\d{2})/);
    last5Events = [{ time: timeMatch ? timeMatch[1] : '–', message: score.lastEvent.replace(/^\d{1,2}:\d{2}\s*-\s*/, '').trim() }];
  }
  if (last5Events.length === 0) {
    last5Events = [{ time: '–', message: 'Auszeit ' + (team === 'Home' ? (score.homeTeam || 'Heim') : (score.awayTeam || 'Gast')) }];
  }

  pendingTimeoutPopup = {
    team,
    teamLogoUrl: team === 'Away' ? (score.awayLogoUrl || '') : (score.homeLogoUrl || ''),
    homeLogoUrl: score.homeLogoUrl || '',
    awayLogoUrl: score.awayLogoUrl || '',
    last5Events,
    top3Home: top3Home.length ? top3Home : [{ name: '–', goals: 0, number: '' }, { name: '–', goals: 0, number: '' }, { name: '–', goals: 0, number: '' }],
    top3Away: top3Away.length ? top3Away : [{ name: '–', goals: 0, number: '' }, { name: '–', goals: 0, number: '' }, { name: '–', goals: 0, number: '' }]
  };
  res.json({ ok: true, message: 'Auszeit-Popup mit aktuellem Spielstand beim nächsten Overlay-Poll anzeigen.' });
});

app.post('/api/admin/test-halftime-popup', async (req, res) => {
  const config = readJSON(CONFIG_FILE, {});
  const score = readJSON(SCORE_FILE, {});
  const tickerUrl = (config.tickerUrl || '').trim();
  let homePlayers = [];
  let awayPlayers = [];
  let title = 'Halbzeit';
  let homeTeam = score.homeTeam || 'Heim';
  let awayTeam = score.awayTeam || 'Gast';
  let homeLogoUrl = score.homeLogoUrl || '';
  let awayLogoUrl = score.awayLogoUrl || '';

  if (parseMatchTickerUrl(tickerUrl)) {
    try {
      const { match, events, lineups } = await fetchMatchDataBundle(tickerUrl, { includeLineups: true });
      const parsed = parseNewMatchApi(match, events);
      const popup = buildHalftimePopupFromNewApi(parsed, events, lineups, title);
      homeTeam = popup.homeTeam;
      awayTeam = popup.awayTeam;
      homeLogoUrl = popup.homeLogoUrl || homeLogoUrl;
      awayLogoUrl = popup.awayLogoUrl || awayLogoUrl;
      homePlayers = popup.homePlayers;
      awayPlayers = popup.awayPlayers;
    } catch (err) {
      console.warn('[test-halftime-popup] Match-API-Fetch fehlgeschlagen:', err.message);
    }
  }

  pendingHalftimePopup = {
    title,
    homeTeam,
    awayTeam,
    homeLogoUrl,
    awayLogoUrl,
    homePlayers,
    awayPlayers,
    isTest: true
  };
  res.json({ ok: true, message: 'Halbzeit-Popup beim nächsten Overlay-Poll anzeigen (max. 30 Sekunden im Test).' });
});

app.get('/api/score', (req, res) => {
  const score = readJSON(SCORE_FILE, {});
  if (pendingTestEvent) {
    score._testEvent = pendingTestEvent;
    pendingTestEvent = null;
  }
  if (pendingTimeoutPopup) {
    score._timeoutPopup = pendingTimeoutPopup;
    pendingTimeoutPopup = null;
  }
  if (pendingHalftimePopup) {
    score._halftimePopup = pendingHalftimePopup;
    pendingHalftimePopup = null;
  }
  const config = readJSON(CONFIG_FILE, {});
  if (config.ourTeamName && typeof config.ourTeamName === 'string') {
    score.ourTeamName = config.ourTeamName.trim();
  }
  if (config.ourTeamId != null && String(config.ourTeamId).trim()) {
    score.ourTeamId = String(config.ourTeamId).trim();
  }
  if (score.ourSide == null && score.ourTeamId && score.homeTeamId && score.awayTeamId) {
    if (String(score.homeTeamId) === String(score.ourTeamId)) score.ourSide = 'home';
    else if (String(score.awayTeamId) === String(score.ourTeamId)) score.ourSide = 'away';
  }
  res.json(score);
});

app.get('/api/club-logo', (req, res) => {
  try {
    const files = fs.readdirSync(CLUB_LOGO_DIR)
      .filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (files.length > 0) {
      const logoPath = `/assets/club_logo/${encodeURIComponent(files[0])}`;
      res.json({ logo: logoPath });
    } else {
      res.json({ logo: null });
    }
  } catch (e) {
    console.error('[club-logo] Error loading club logo:', e.message);
    res.json({ logo: null });
  }
});
app.post('/api/score', (req, res) => {
  const s = readJSON(SCORE_FILE, {});
  const next = { ...s, ...req.body };
  writeJSON(SCORE_FILE, next);
  res.json({ ok: true, score: next });
});

app.get('/api/config', (req, res) => {
  // Entferne referer aus der Antwort, da er nicht mehr benötigt wird
  const config = readJSON(CONFIG_FILE, {});
  const { referer, ...configWithoutReferer } = config;
  res.json(configWithoutReferer);
});
app.get('/overlay', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'overlay.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

let lastHandledTimeoutEventId = null;
let lastHandledHalftimeEventId = null;
let lastSeenMatchBlock = '';

function normalizeConfig(config) {
  const next = { ...config };
  const clubId = parseClubId(next.clubId) || parseClubId(next.clubUrl) || DEFAULT_CLUB_ID;
  next.clubId = clubId;
  delete next.clubUrl;

  if (next.selectedTeamId != null && String(next.selectedTeamId).trim()) {
    next.selectedTeamId = String(next.selectedTeamId).trim();
  } else {
    const fromSchedule = parseTeamScheduleUrl(next.scheduleUrl || '');
    next.selectedTeamId = fromSchedule ? fromSchedule.teamId : (next.selectedTeamId || '');
  }

  if (next.ourTeamId != null && String(next.ourTeamId).trim()) {
    next.ourTeamId = String(next.ourTeamId).trim();
  } else if (next.selectedTeamId) {
    next.ourTeamId = String(next.selectedTeamId);
  } else {
    next.ourTeamId = '';
  }

  if (next.selectedTeamId && !parseTeamScheduleUrl(next.scheduleUrl || '')) {
    next.scheduleUrl = teamScheduleUrl(next.selectedTeamId, { origin: 'https://handball.net' });
  }
  return next;
}

app.post('/api/config', (req, res) => {
  const { referer, ...configWithoutReferer } = req.body || {};
  const currentConfig = readJSON(CONFIG_FILE, {});
  const merged = normalizeConfig({ ...currentConfig, ...configWithoutReferer });
  writeJSON(CONFIG_FILE, merged);
  startFetcher();
  res.json({ ok: true, config: merged });
});

app.get('/api/club/teams', async (req, res) => {
  try {
    const config = readJSON(CONFIG_FILE, {});
    const clubId = parseClubId(req.query.clubId)
      || parseClubId(config.clubId)
      || DEFAULT_CLUB_ID;
    const seasonId = (req.query.season_id || req.query.seasonId || '').trim() || null;
    const result = await fetchClubTeams(clubId, { origin: DEFAULT_ORIGIN, seasonId });
    return res.json(result);
  } catch (err) {
    console.error('[club/teams]', err.message);
    return res.status(err.status || 502).json({ error: err.message || 'Teams konnten nicht geladen werden.' });
  }
});

app.get('/api/schedule/upcoming', async (req, res) => {
  const config = readJSON(CONFIG_FILE, {});
  const teamId = (req.query.teamId || config.selectedTeamId || '').toString().trim()
    || (parseTeamScheduleUrl(config.scheduleUrl || '') || {}).teamId
    || '';
  if (!teamId) {
    return res.status(400).json({
      error: 'Keine Mannschaft gewählt. Bitte im Admin eine Mannschaft auswählen.',
    });
  }
  try {
    const seasonId = (req.query.season_id || '').trim()
      || (parseTeamScheduleUrl(config.scheduleUrl || '') || {}).seasonId
      || null;
    const upcoming = await fetchUpcomingForTeamId(teamId, {
      origin: DEFAULT_ORIGIN,
      seasonId,
      limit: 10,
    });
    return res.json(upcoming);
  } catch (err) {
    console.error('[schedule] Fetch failed:', err.message);
    return res.status(err.status || 502).json({ error: err.message || 'Spielplan konnte nicht geladen werden.' });
  }
});

async function fetchOnce() {
  if (fetchLock) {
    dbg('FETCH_SKIP', { reason: 'fetch already in progress' });
    return;
  }

  const config = readJSON(CONFIG_FILE, {});
  const teamType = config.teamType || 'herren1';
  if (teamType === 'onlySponsor') {
    if (fetchLock) fetchLock = false;
    return;
  }

  fetchLock = true;
  const reqId = ++reqIdCounter;
  const startTime = Date.now();

  try {
    const { tickerUrl } = config;

    dbg('POLL_START', {
      reqId,
      startTime: new Date(startTime).toISOString(),
      tickerUrl: tickerUrl || 'none',
    });

    if (!tickerUrl) {
      dbg('POLL_SKIP', { reqId, reason: 'no tickerUrl' });
      const currentScore = readJSON(SCORE_FILE, {});
      const pre = {
        homeTeam: currentScore.homeTeam || 'Heim',
        awayTeam: currentScore.awayTeam || 'Gast',
        homeGoals: 0,
        awayGoals: 0,
        period: currentScore.period || '',
        lastScorer: '',
        lastEvent: '00:00 - Spiel noch nicht gestartet',
        lastEventType: '',
        lastEventPhotoUrl: '',
        gameStatus: 'Vorbereitung',
        homeLogoUrl: currentScore.homeLogoUrl || '',
        awayLogoUrl: currentScore.awayLogoUrl || '',
        lastSourceStamp: currentScore.lastSourceStamp || 0,
      };
      if (hasRealChanges(pre, currentScore)) writeJSON(SCORE_FILE, pre);
      return;
    }

    if (!parseMatchTickerUrl(tickerUrl)) {
      dbg('POLL_SKIP', { reqId, reason: 'invalid match tickerUrl', tickerUrl });
      console.warn('[ticker] Ungültige Match-URL (erwartet /match/{id}):', tickerUrl);
      return;
    }

    const ourTeamId = (config.ourTeamId || config.selectedTeamId || '').toString().trim() || null;
    const { match, events } = await fetchMatchDataBundle(tickerUrl, { includeLineups: false });
    const parsed = parseNewMatchApi(match, events, { ourTeamId });
    const currentScore = readJSON(SCORE_FILE, {});

    const sourceStamp = calculateSourceStamp(
      { updatedAt: match.updated_at || match.date || newestTimestamp(events) },
      events
    );
    const lastSourceStamp = currentScore.lastSourceStamp || 0;
    let isGameSwitch = detectGameSwitch(parsed, currentScore);
    let isStalePacket = !isGameSwitch && sourceStamp > 0 && sourceStamp <= lastSourceStamp;

    if (parsed.homeGoals === 0 && parsed.awayGoals === 0 && parsed.gameStatus === 'Vorbereitung') {
      isGameSwitch = true;
      isStalePacket = false;
    }

    const newestEvent = parsed.newestEvent;
    const eventId = newestEvent?.id != null ? String(newestEvent.id) : '';
    if (eventId && eventId !== String(currentScore.lastEventId || '')) {
      isStalePacket = false;
    }

    if (isStalePacket) {
      dbg('STALE_PACKET', { reqId, sourceStamp, lastSourceStamp });
      return;
    }

    const protectedScore = protectScoreRegression(parsed, currentScore, isGameSwitch);
    let finalEvent = currentScore.lastEvent || '';
    let finalScorer = currentScore.lastScorer || '';
    let finalEventType = currentScore.lastEventType || '';
    let finalPhotoUrl = currentScore.lastEventPhotoUrl || '';

    const eventIndicatesLive = !!(newestEvent && eventIndicatesGameStartOrResume(newestEvent))
      || !!parsed.liveFromEvents;

    if (newestEvent) {
      finalEvent = parsed.lastEvent;
      finalScorer = parsed.lastScorer;
      finalEventType = parsed.lastEventType;
      finalPhotoUrl = parsed.lastEventPhotoUrl || '';
    } else if (parsed.gameStatus === 'Vorbereitung' && !eventIndicatesLive) {
      finalEvent = '00:00 - Spiel noch nicht gestartet';
      finalScorer = '';
      finalEventType = '';
      finalPhotoUrl = '';
    }

    let newScoreData = {
      homeTeam: parsed.homeTeam || currentScore.homeTeam || 'Heim',
      awayTeam: parsed.awayTeam || currentScore.awayTeam || 'Gast',
      homeTeamId: parsed.homeTeamId || currentScore.homeTeamId || null,
      awayTeamId: parsed.awayTeamId || currentScore.awayTeamId || null,
      ourTeamId: parsed.ourTeamId || ourTeamId || null,
      ourSide: parsed.ourSide || null,
      lastEventTeamId: parsed.lastEventTeamId || null,
      lastEventIsHome: parsed.lastEventIsHome,
      homeGoals: protectedScore.homeGoals,
      awayGoals: protectedScore.awayGoals,
      period: parsed.period || currentScore.period || '',
      lastScorer: finalScorer,
      lastEvent: finalEvent,
      lastEventType: finalEventType,
      lastEventPhotoUrl: finalPhotoUrl,
      lastEventId: eventId || (currentScore.lastEventId || ''),
      gameStatus: parsed.gameStatus || currentScore.gameStatus || 'Live',
      homeLogoUrl: parsed.homeLogoUrl || currentScore.homeLogoUrl || '',
      awayLogoUrl: parsed.awayLogoUrl || currentScore.awayLogoUrl || '',
      lastSourceStamp: Math.max(sourceStamp, lastSourceStamp, Date.now()),
    };

    if (eventIndicatesLive && newScoreData.gameStatus === 'Vorbereitung') {
      newScoreData.gameStatus = 'Live';
      newScoreData.period = parsed.period || 'Jetzt Live!';
    }

    // Vorbereitung-Wipe nur wenn wirklich keine spielrelevanten Events existieren
    if (
      newScoreData.homeGoals === 0
      && newScoreData.awayGoals === 0
      && parsed.gameStatus === 'Vorbereitung'
      && !eventIndicatesLive
      && !(events && events.length && parsed.liveFromEvents)
    ) {
      newScoreData.gameStatus = 'Vorbereitung';
      if (!newestEvent) {
        newScoreData.lastEvent = '00:00 - Spiel noch nicht gestartet';
        newScoreData.lastScorer = '';
        newScoreData.lastEventType = '';
        newScoreData.lastEventPhotoUrl = '';
      }
    }

    newScoreData = preserveTeamsIfPlaceholder(newScoreData, currentScore);

    if (!isValidPacket(newScoreData, currentScore, { reqId, sourceStamp, lastSourceStamp, isGameSwitch })) {
      return;
    }

    const changed = hasRealChanges(newScoreData, currentScore)
      || newScoreData.lastEventId !== (currentScore.lastEventId || '')
      || newScoreData.lastEventPhotoUrl !== (currentScore.lastEventPhotoUrl || '')
      || newScoreData.ourSide !== currentScore.ourSide
      || newScoreData.homeTeamId !== currentScore.homeTeamId
      || newScoreData.awayTeamId !== currentScore.awayTeamId;

    if (changed) {
      if (newScoreData.homeGoals > 80 || newScoreData.awayGoals > 80) {
        console.warn('[ticker] Ignoring implausible score:', newScoreData.homeGoals, newScoreData.awayGoals);
        return;
      }
      const configData = normalizeConfig(readJSON(CONFIG_FILE, {}));
      if (parsed.homeLogoUrl) configData.homeLogoUrl = parsed.homeLogoUrl;
      if (parsed.awayLogoUrl) configData.awayLogoUrl = parsed.awayLogoUrl;
      writeJSON(CONFIG_FILE, configData);
      writeJSON(SCORE_FILE, newScoreData);
      console.log('[ticker]', `${newScoreData.homeTeam} ${newScoreData.homeGoals}:${newScoreData.awayGoals} ${newScoreData.awayTeam} | ${newScoreData.period}`);
    }

    const overlayType = parsed.overlayType;
    const needLineups = (overlayType === 'Timeout' && eventId && eventId !== lastHandledTimeoutEventId)
      || (isHalbzeitpauseBlock(parsed.block) && !isHalbzeitpauseBlock(lastSeenMatchBlock) && eventId && eventId !== lastHandledHalftimeEventId);

    let lineups = null;
    if (needLineups) {
      try {
        const withLineups = await fetchMatchDataBundle(tickerUrl, { includeLineups: true });
        lineups = withLineups.lineups;
      } catch (err) {
        console.warn('[ticker] Lineups fetch failed:', err.message);
      }
    }

    if (overlayType === 'Timeout' && eventId && eventId !== lastHandledTimeoutEventId) {
      lastHandledTimeoutEventId = eventId;
      pendingTimeoutPopup = buildTimeoutPopupFromNewApi(parsed, events, lineups, newestEvent);
    }

    if (
      isHalbzeitpauseBlock(parsed.block)
      && !isHalbzeitpauseBlock(lastSeenMatchBlock)
      && eventId
      && eventId !== lastHandledHalftimeEventId
    ) {
      lastHandledHalftimeEventId = eventId;
      pendingHalftimePopup = buildHalftimePopupFromNewApi(parsed, events, lineups, 'Halbzeit');
    }
    lastSeenMatchBlock = parsed.block || lastSeenMatchBlock;
  } catch (e) {
    dbg('POLL_ERROR', { reqId, error: e.message });
    console.error('[ticker error]', e.message);
  } finally {
    dbg('POLL_END', { reqId, totalLatency: Date.now() - startTime });
    fetchLock = false;
  }
}

function startFetcher() {
  if (fetchTimer) clearInterval(fetchTimer);
  const config = readJSON(CONFIG_FILE, {});
  const teamType = config.teamType || 'herren1';

  if (teamType === 'onlySponsor') {
    console.log('[ticker] disabled (onlySponsor - no score display)');
    return;
  }

  if (config.tickerUrl) {
    fetchTimer = setInterval(fetchOnce, 1000);
    console.log('[ticker] running:', config.tickerUrl);
  } else {
    console.log('[ticker] idle (no URL)');
  }
}
startFetcher();

app.listen(PORT, () => {
  console.log(`Overlay-Server: http://localhost:${PORT}/overlay`);
  console.log(`Admin-Panel:    http://localhost:${PORT}/admin`);
});
