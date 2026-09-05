const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

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

// Deterministic newest event selection
function selectNewestEvent(events) {
  if (!events || events.length === 0) return null;

  // Sort events deterministically: timestamp desc → id desc → gameTime/minute desc
  const sortedEvents = events.slice().sort((a, b) => {
    const timeA = new Date(a.timestamp || a.time || 0).getTime();
    const timeB = new Date(b.timestamp || b.time || 0).getTime();
    if (timeA !== timeB) return timeB - timeA;

    const idA = Number(a.id || a.eventId || 0);
    const idB = Number(b.id || b.eventId || 0);
    if (idA !== idB) return idB - idA;

    const gameTimeA = extractGameTime(a.minute || a.gameTime || a.time || '');
    const gameTimeB = extractGameTime(b.minute || b.gameTime || b.time || '');
    return gameTimeB - gameTimeA;
  });

  return sortedEvents[0];
}

// Extract game time in seconds from mm:ss format
function extractGameTime(timeStr) {
  if (!timeStr) return 0;
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (match) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    return minutes * 60 + seconds;
  }
  return 0;
}

// Prüft, ob ein Event den Spielbeginn oder die Fortsetzung anzeigt
function eventIndicatesGameStartOrResume(ev) {
  if (!ev) return false;
  const overlayType = mapNewApiEventToOverlayType(ev);
  if (overlayType === 'Timeout') return false;
  const typeName = (ev.event_type?.name || ev.type || ev.eventType || '').toString().trim().toLowerCase();
  const msg = (ev.message || '').trim().toLowerCase();
  const block = (ev.block || '').toString().trim().toLowerCase();
  if (typeName === 'startperiod' || typeName === 'resume' || typeName === 'startseite teil') return true;
  if (/1\.\s*halbzeit|2\.\s*halbzeit/.test(block) && /start/i.test(typeName)) return true;
  return /spiel\s+gestartet|anpfiff|spielbeginn|spiel\s+läuft\s+weiter|auszeit\s+beendet|halbzeit\s+beendet|zweite\s+halbzeit\s+gestartet/.test(msg);
}

function isHalbzeitpauseBlock(block) {
  return /halbzeitpause/i.test(String(block || '').trim());
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

// Helper: dedupe/canonicalize event text after building
function dedupeEventText(text) {
  if (!text) return '';
  let t = String(text).trim().replace(/\s+/g, ' ');
  // Remove duplicated canonical phrases
  t = t.replace(/((?:\d{1,2}:\d{2})\s*-\s*[^-]+?)(?:\s+\1)+/gi, '$1');
  t = t.replace(/(Tor durch [^(]+\([^)]*\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(7-Meter\s+Tor durch [^(]+\([^)]*\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(7-Meter verworfen \([^)]+\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(2 Minuten für [^(]+\([^)]+\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(Timeout\s+[^-]+)(?:\s+\1)+/gi, '$1');
  return t;
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


// Vom Overlay unterstützte Event-Typen (getEventHeadline in overlay.js). Andere API-Typen (z. B. StartPeriod, Resume) werden nicht übernommen.
const OVERLAY_EVENT_TYPES = new Set(['Goal', 'SevenMeterGoal', 'Warning', 'TwoMinutePenalty', 'Disqualification', 'BlueCard']);

function toOverlayEventType(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const t = raw.trim();
  return OVERLAY_EVENT_TYPES.has(t) ? t : '';
}

/** Map new handball.net event_type → Overlay-Typ oder 'Timeout' (Popup) oder ''. */
function mapNewApiEventToOverlayType(ev) {
  if (!ev) return '';
  const et = ev.event_type || {};
  const id = Number(et.id);
  const name = String(et.name || ev.type || ev.eventType || '').trim().toLowerCase();
  if (id === 15 || name === 'tor' || (et.is_goal && !/siebenmeter|7[- ]?meter|7m/.test(name))) return 'Goal';
  if (id === 39 || /siebenmeter\s*tor|7[- ]?meter\s*tor|7m[- ]?tor/.test(name)) return 'SevenMeterGoal';
  if (id === 2 || /verwarnung|gelb/.test(name)) return 'Warning';
  if (id === 13 || /zwei\s*minuten|2[- ]?min/.test(name)) return 'TwoMinutePenalty';
  if (id === 30 || /auszeit|timeout/.test(name)) return 'Timeout';
  if (/disqualif|rote\s*karte|red\s*card/.test(name)) return 'Disqualification';
  if (/blau|blue\s*card/.test(name)) return 'BlueCard';
  if (et.is_goal) return /siebenmeter|7[- ]?meter|7m/.test(name) ? 'SevenMeterGoal' : 'Goal';
  return '';
}

function formatNewApiPlayerName(player) {
  if (!player) return '';
  if (typeof player === 'string') return player.trim();
  return [player.first_name, player.last_name].filter(Boolean).join(' ').trim();
}

function buildNewApiEventText(ev, homeTeam, awayTeam) {
  const minute = String(ev.minute || ev.gameTime || ev.time || '').trim();
  const typeName = String(ev.event_type?.name || '').trim() || 'Ereignis';
  const player = formatNewApiPlayerName(ev.player);
  const team = (ev.team && ev.team.name)
    || (ev.is_home === true ? homeTeam : ev.is_home === false ? awayTeam : '')
    || '';
  let body = typeName;
  if (player && team) body = `${typeName} ${player} (${team})`;
  else if (player) body = `${typeName} ${player}`;
  else if (team) body = `${typeName} (${team})`;
  return dedupeEventText(minute ? `${minute} - ${body}` : body);
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
  tickerUrl: '', homeLogoUrl: '', awayLogoUrl: ''
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
app.post('/api/config', (req, res) => {
  // Entferne referer aus der Konfiguration, da er nicht mehr benötigt wird
  const { referer, ...configWithoutReferer } = req.body;
  const currentConfig = readJSON(CONFIG_FILE, {});
  const newConfig = { ...currentConfig, ...configWithoutReferer };
  writeJSON(CONFIG_FILE, newConfig);
  startFetcher();
  res.json({ ok: true, config: newConfig });
});

app.get('/overlay', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'overlay.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// Spielplan + Match-API (handball.net)
// Team:  https://handball.net/team/{id}
// Match: https://handball.net/match/{id}
const HANDBALL_NET_ORIGINS = new Set(['https://www.handball.net', 'https://handball.net']);
const SCHEDULE_PATH_TEAM = /^\/team\/(\d+)\/?$/i;
const MATCH_PATH = /^\/match\/(\d+)\/?$/i;
const CLIENT_TOKEN_TTL_MS = 8 * 60 * 1000;
let cachedClientToken = { origin: '', token: '', fetchedAt: 0 };
let lastHandledTimeoutEventId = null;
let lastHandledHalftimeEventId = null;
let lastSeenMatchBlock = '';

function isHandballNetOrigin(origin) {
  return HANDBALL_NET_ORIGINS.has(origin);
}

function isValidScheduleUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url.trim());
    if (!isHandballNetOrigin(u.origin)) return false;
    return SCHEDULE_PATH_TEAM.test(u.pathname);
  } catch {
    return false;
  }
}

function parseTeamScheduleUrl(url) {
  try {
    const u = new URL(url.trim());
    const match = u.pathname.match(SCHEDULE_PATH_TEAM);
    if (!match || !isHandballNetOrigin(u.origin)) return null;
    return {
      teamId: match[1],
      seasonId: (u.searchParams.get('season_id') || '').trim() || null,
      origin: u.origin,
    };
  } catch {
    return null;
  }
}

function parseMatchTickerUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const match = u.pathname.match(MATCH_PATH);
    if (!match || !isHandballNetOrigin(u.origin)) return null;
    return { matchId: match[1], origin: u.origin };
  } catch {
    return null;
  }
}

function handballBrowserHeaders(origin, accept) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': accept,
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Referer': `${origin}/`,
    'Cache-Control': 'no-cache',
  };
}

function extractClientToken(html) {
  const $ = cheerio.load(html);
  return ($('meta[name="client-token"]').attr('content') || '').trim() || null;
}

async function getHandballClientToken(origin) {
  const now = Date.now();
  if (
    cachedClientToken.token
    && cachedClientToken.origin === origin
    && (now - cachedClientToken.fetchedAt) < CLIENT_TOKEN_TTL_MS
  ) {
    return cachedClientToken.token;
  }
  const pageRes = await fetch(`${origin}/`, {
    headers: handballBrowserHeaders(origin, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
    cache: 'no-store',
  });
  if (!pageRes.ok) {
    const err = new Error(`handball.net Token-Seite nicht erreichbar (HTTP ${pageRes.status}).`);
    err.status = 502;
    throw err;
  }
  const token = extractClientToken(await pageRes.text());
  if (!token) {
    const err = new Error('handball.net Client-Token konnte nicht gelesen werden.');
    err.status = 502;
    throw err;
  }
  cachedClientToken = { origin, token, fetchedAt: now };
  return token;
}

async function handballApiGet(origin, pathAndQuery, token) {
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${origin}${pathAndQuery}`;
  const headers = {
    ...handballBrowserHeaders(origin, 'application/json'),
    'x-client-token': token,
  };
  let res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 403) {
    cachedClientToken = { origin: '', token: '', fetchedAt: 0 };
    const fresh = await getHandballClientToken(origin);
    headers['x-client-token'] = fresh;
    res = await fetch(url, { headers, cache: 'no-store' });
  }
  return res;
}

function formatMatchDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function mapApiMatchToUpcoming(match, origin) {
  const gameId = String(match.id);
  const home = (match.local && match.local.name) || 'Heim';
  const away = (match.visitor && match.visitor.name) || 'Gast';
  return {
    gameId,
    label: `${home} vs ${away}`,
    dateTime: formatMatchDateTime(match.date),
    tickerUrl: `${origin}/match/${gameId}`,
  };
}

async function fetchUpcomingFromTeamApi(scheduleUrl) {
  const parsed = parseTeamScheduleUrl(scheduleUrl);
  if (!parsed) {
    const err = new Error('Ungültige Team-Spielplan-URL.');
    err.status = 400;
    throw err;
  }
  const { teamId, seasonId, origin } = parsed;
  const clientToken = await getHandballClientToken(origin);

  let dateFrom = '2026-07-01';
  let dateTo = '2027-06-30';
  try {
    const seasonsRes = await handballApiGet(origin, '/api/new/seasons', clientToken);
    if (seasonsRes.ok) {
      const seasonsJson = await seasonsRes.json();
      const seasons = Array.isArray(seasonsJson?.data) ? seasonsJson.data : [];
      const season = (seasonId && seasons.find((s) => String(s.id) === String(seasonId)))
        || seasons.find((s) => s.is_active)
        || seasons[0];
      if (season?.start_date) dateFrom = String(season.start_date).slice(0, 10);
      if (season?.end_date) dateTo = String(season.end_date).slice(0, 10);
    }
  } catch (err) {
    console.warn('[schedule] seasons lookup failed, using default range:', err.message);
  }

  const matchesUrl = `/api/new/matches?team_id=${encodeURIComponent(teamId)}&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}&per_page=100`;
  const matchesRes = await handballApiGet(origin, matchesUrl, clientToken);
  if (!matchesRes.ok) {
    const err = new Error(`Spielplan-API nicht erreichbar (HTTP ${matchesRes.status}).`);
    err.status = 502;
    throw err;
  }
  const matchesJson = await matchesRes.json();
  const matches = Array.isArray(matchesJson?.data) ? matchesJson.data : [];
  const now = Date.now();
  return matches
    .filter((m) => m && !m.status?.is_finished)
    .filter((m) => {
      if (!m.date) return true;
      const t = new Date(m.date).getTime();
      return Number.isNaN(t) || t >= now - 6 * 60 * 60 * 1000;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 3)
    .map((m) => mapApiMatchToUpcoming(m, origin));
}

app.get('/api/schedule/upcoming', async (req, res) => {
  const config = readJSON(CONFIG_FILE, {});
  const scheduleUrl = (config.scheduleUrl || '').trim();
  if (!scheduleUrl) {
    return res.status(400).json({ error: 'Kein Spielplan-Link gespeichert. Bitte zuerst Spielplan-Link eintragen und Konfiguration speichern.' });
  }
  if (!isValidScheduleUrl(scheduleUrl)) {
    return res.status(400).json({ error: 'Ungültiger Spielplan-Link. Erlaubt: handball.net/team/{id} (optional ?season_id=…).' });
  }
  try {
    const upcoming = await fetchUpcomingFromTeamApi(scheduleUrl);
    return res.json(upcoming);
  } catch (err) {
    console.error('[schedule] Fetch failed:', err.message);
    const status = err.status || 502;
    return res.status(status).json({ error: err.message || 'Spielplan konnte nicht geladen werden.' });
  }
});

function normalizeLogoUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (raw.startsWith('handball-net:')) {
    return 'https://www.handball.net/' + raw.split(':').slice(1).join(':').replace(/^\/?/, '');
  }
  if (raw.startsWith('/')) return 'https://handball.net' + raw;
  return raw;
}

function playerFromMessage(msg) {
  if (!msg) return '';
  let m = msg.match(/Tor\s+durch\s+(.+?)\s+\(/i);
  if (m) return m[1].trim();
  m = msg.match(/7-Meter\s+Tor\s+durch\s+(.+?)\s+\(/i);
  if (m) return m[1].trim();
  return '';
}

function newestTimestamp(events) {
  if (!events || !events.length) return 0;
  return Math.max(...events.map((e) => new Date(e.timestamp || 0).getTime()).filter((n) => !Number.isNaN(n)), 0);
}

async function fetchMatchDataBundle(tickerUrl, { includeLineups = false } = {}) {
  const parsed = parseMatchTickerUrl(tickerUrl);
  if (!parsed) {
    const err = new Error('Ungültige Match-URL. Erwartet: https://handball.net/match/{id}');
    err.status = 400;
    throw err;
  }
  const { origin, matchId } = parsed;
  const token = await getHandballClientToken(origin);
  const [matchRes, eventsRes, lineupsRes] = await Promise.all([
    handballApiGet(origin, `/api/new/matches?match_id=${encodeURIComponent(matchId)}`, token),
    handballApiGet(origin, `/api/new/matches/${encodeURIComponent(matchId)}/events`, token),
    includeLineups
      ? handballApiGet(origin, `/api/new/matches/${encodeURIComponent(matchId)}/lineups`, token)
      : Promise.resolve(null),
  ]);
  if (!matchRes.ok) {
    const err = new Error(`Match-API nicht erreichbar (HTTP ${matchRes.status}).`);
    err.status = 502;
    throw err;
  }
  if (!eventsRes.ok) {
    const err = new Error(`Events-API nicht erreichbar (HTTP ${eventsRes.status}).`);
    err.status = 502;
    throw err;
  }
  const matchJson = await matchRes.json();
  const eventsJson = await eventsRes.json();
  const match = Array.isArray(matchJson?.data) ? matchJson.data[0] : matchJson?.data;
  if (!match) {
    const err = new Error('Match nicht gefunden.');
    err.status = 404;
    throw err;
  }
  const events = Array.isArray(eventsJson?.data) ? eventsJson.data : [];
  let lineups = null;
  if (lineupsRes && lineupsRes.ok) {
    try {
      const lineupsJson = await lineupsRes.json();
      lineups = lineupsJson?.data || null;
    } catch (_) { /* ignore */ }
  }
  return { origin, matchId, match, events, lineups };
}

function parseNewMatchApi(match, events) {
  const homeTeam = match.local?.name || 'Heim';
  const awayTeam = match.visitor?.name || 'Gast';
  const homeLogoUrl = normalizeLogoUrl(match.local?.club?.logo || '');
  const awayLogoUrl = normalizeLogoUrl(match.visitor?.club?.logo || '');
  const newestEvent = selectNewestEvent(events.slice());
  const status = match.status || {};
  const block = String(newestEvent?.block || '').trim();

  let homeGoals = typeof match.result?.local === 'number' ? match.result.local : 0;
  let awayGoals = typeof match.result?.visitor === 'number' ? match.result.visitor : 0;
  if ((status.is_live || status.is_finished) && newestEvent?.score) {
    if (typeof newestEvent.score.local === 'number') homeGoals = newestEvent.score.local;
    if (typeof newestEvent.score.visitor === 'number') awayGoals = newestEvent.score.visitor;
  }

  let period = block || '';
  let gameStatus = 'Vorbereitung';
  if (status.is_finished) {
    gameStatus = 'Beendet';
    period = period || 'Spiel beendet';
  } else if (status.is_live) {
    if (isHalbzeitpauseBlock(block)) {
      gameStatus = 'Pause';
      period = block || 'Halbzeitpause';
    } else {
      gameStatus = 'Live';
      period = period || 'Jetzt Live!';
    }
  } else {
    gameStatus = 'Vorbereitung';
    period = period || 'Vorbereitung';
  }

  let lastEvent = '';
  let lastScorer = '';
  let lastEventType = '';
  let lastEventPhotoUrl = '';
  let overlayType = '';
  if (newestEvent) {
    overlayType = mapNewApiEventToOverlayType(newestEvent);
    lastEvent = buildNewApiEventText(newestEvent, homeTeam, awayTeam);
    lastEventType = toOverlayEventType(overlayType);
    if (overlayType === 'Goal' || overlayType === 'SevenMeterGoal') {
      lastScorer = formatNewApiPlayerName(newestEvent.player);
    }
    lastEventPhotoUrl = (newestEvent.player && newestEvent.player.photo_url) || '';
  } else if (!status.is_live && !status.is_finished) {
    lastEvent = '00:00 - Spiel noch nicht gestartet';
  }

  return {
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    period,
    gameStatus,
    lastEvent,
    lastScorer,
    lastEventType,
    lastEventPhotoUrl,
    homeLogoUrl,
    awayLogoUrl,
    newestEvent,
    overlayType,
    block,
    eventsCount: events.length,
  };
}

function mapNewLineupPlayers(side, events) {
  const players = Array.isArray(side?.players) ? side.players : [];
  const teamId = side?.team?.id;
  const statsByPlayerId = {};
  for (const ev of events || []) {
    const pid = ev.player?.id;
    if (!pid) continue;
    if (teamId != null && ev.team?.id != null && String(ev.team.id) !== String(teamId)) continue;
    if (!statsByPlayerId[pid]) {
      statsByPlayerId[pid] = { goals: 0, yellowCards: 0, timePenalties: 0, redCards: 0, blueCards: 0 };
    }
    const t = mapNewApiEventToOverlayType(ev);
    if (t === 'Goal' || t === 'SevenMeterGoal') statsByPlayerId[pid].goals += 1;
    if (t === 'Warning') statsByPlayerId[pid].yellowCards += 1;
    if (t === 'TwoMinutePenalty') statsByPlayerId[pid].timePenalties += 1;
    if (t === 'Disqualification') statsByPlayerId[pid].redCards += 1;
    if (t === 'BlueCard') statsByPlayerId[pid].blueCards += 1;
  }
  return players.map((row) => {
    const p = row.player || {};
    const id = p.id;
    const st = statsByPlayerId[id] || { goals: 0, yellowCards: 0, timePenalties: 0, redCards: 0, blueCards: 0 };
    return {
      number: row.number != null ? row.number : '',
      name: formatNewApiPlayerName(p) || '–',
      goals: st.goals,
      yellowCards: st.yellowCards,
      timePenalties: st.timePenalties,
      redCards: st.redCards,
      blueCards: st.blueCards,
      firstname: p.first_name || '',
      lastname: p.last_name || '',
      penaltyGoals: 0,
    };
  });
}

function buildTimeoutPopupFromNewApi(parsed, events, lineups, newestEvent) {
  const homePlayers = mapNewLineupPlayers(lineups?.local, events);
  const awayPlayers = mapNewLineupPlayers(lineups?.visitor, events);
  const top3 = (arr) => arr
    .slice()
    .sort((a, b) => (b.goals || 0) - (a.goals || 0))
    .slice(0, 3)
    .map((p) => ({ name: p.name || '–', goals: p.goals || 0, number: p.number != null ? p.number : '' }));
  const isAway = newestEvent?.is_home === false;
  const sortedEvents = events.slice().sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return tb - ta;
  });
  return {
    team: isAway ? 'Away' : 'Home',
    teamLogoUrl: (isAway ? parsed.awayLogoUrl : parsed.homeLogoUrl) || '',
    homeLogoUrl: parsed.homeLogoUrl || '',
    awayLogoUrl: parsed.awayLogoUrl || '',
    last5Events: sortedEvents.slice(0, 5).map((e) => ({
      time: String(e.minute || '').trim(),
      message: buildNewApiEventText(e, parsed.homeTeam, parsed.awayTeam).replace(/^\d{1,2}:\d{2}\s*-\s*/, ''),
    })),
    top3Home: top3(homePlayers),
    top3Away: top3(awayPlayers),
  };
}

function buildHalftimePopupFromNewApi(parsed, events, lineups, title) {
  const homePlayers = mapNewLineupPlayers(lineups?.local, events);
  const awayPlayers = mapNewLineupPlayers(lineups?.visitor, events);
  const sortByNumber = (arr) => arr.slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  return {
    title: title || 'Halbzeit',
    homeTeam: parsed.homeTeam || '',
    awayTeam: parsed.awayTeam || '',
    homeLogoUrl: parsed.homeLogoUrl || '',
    awayLogoUrl: parsed.awayLogoUrl || '',
    homePlayers: sortByNumber(homePlayers),
    awayPlayers: sortByNumber(awayPlayers),
    isTest: false,
  };
}

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

    const { match, events } = await fetchMatchDataBundle(tickerUrl, { includeLineups: false });
    const parsed = parseNewMatchApi(match, events);
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

    // Live games: always accept if event id changed
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

    const eventIndicatesLive = newestEvent && eventIndicatesGameStartOrResume(newestEvent);
    if (newestEvent) {
      finalEvent = parsed.lastEvent;
      finalScorer = parsed.lastScorer;
      finalEventType = parsed.lastEventType;
      finalPhotoUrl = parsed.lastEventPhotoUrl || '';
    } else if (parsed.gameStatus === 'Vorbereitung') {
      finalEvent = '00:00 - Spiel noch nicht gestartet';
      finalScorer = '';
      finalEventType = '';
      finalPhotoUrl = '';
    }

    let newScoreData = {
      homeTeam: parsed.homeTeam || currentScore.homeTeam || 'Heim',
      awayTeam: parsed.awayTeam || currentScore.awayTeam || 'Gast',
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

    if (
      newScoreData.homeGoals === 0
      && newScoreData.awayGoals === 0
      && parsed.gameStatus === 'Vorbereitung'
      && !eventIndicatesLive
    ) {
      newScoreData.gameStatus = 'Vorbereitung';
      newScoreData.lastEvent = '00:00 - Spiel noch nicht gestartet';
      newScoreData.lastScorer = '';
      newScoreData.lastEventType = '';
      newScoreData.lastEventPhotoUrl = '';
    }

    newScoreData = preserveTeamsIfPlaceholder(newScoreData, currentScore);

    if (!isValidPacket(newScoreData, currentScore, { reqId, sourceStamp, lastSourceStamp, isGameSwitch })) {
      return;
    }

    const changed = hasRealChanges(newScoreData, currentScore)
      || newScoreData.lastEventId !== (currentScore.lastEventId || '')
      || newScoreData.lastEventPhotoUrl !== (currentScore.lastEventPhotoUrl || '');

    if (changed) {
      if (newScoreData.homeGoals > 80 || newScoreData.awayGoals > 80) {
        console.warn('[ticker] Ignoring implausible score:', newScoreData.homeGoals, newScoreData.awayGoals);
        return;
      }
      const configData = readJSON(CONFIG_FILE, {});
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
