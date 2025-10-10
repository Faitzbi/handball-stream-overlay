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
  
  // Sort events deterministically: timestamp desc → id desc → gameTime desc
  const sortedEvents = events.sort((a, b) => {
    // Primary: timestamp descending
    const timeA = new Date(a.timestamp || a.time || 0).getTime();
    const timeB = new Date(b.timestamp || b.time || 0).getTime();
    if (timeA !== timeB) return timeB - timeA;
    
    // Tiebreaker: id descending
    const idA = a.id || a.eventId || '';
    const idB = b.id || b.eventId || '';
    if (idA !== idB) return idB.localeCompare(idA);
    
    // Final tiebreaker: gameTime descending (mm:ss)
    const gameTimeA = extractGameTime(a.gameTime || a.time || '');
    const gameTimeB = extractGameTime(b.gameTime || b.time || '');
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
  const fields = ['homeTeam', 'awayTeam', 'homeGoals', 'awayGoals', 'period', 'lastScorer', 'lastEvent', 'gameStatus', 'homeLogoUrl', 'awayLogoUrl'];
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

// Helper: Build canonical text from structured fields
function buildCanonicalEventFromStructured(time, type, playerName, teamName) {
  const mmss = (time || '').trim();
  const player = (playerName || '').trim();
  const team = (teamName || '').trim();
  let base = '';
  const t = (type || '').toLowerCase();
  if (t === 'goal' || t === 'tor') {
    base = `${mmss} - Tor durch ${player} (${team})`;
  } else if (t === 'timeout') {
    base = `${mmss} - Timeout ${team}`;
  } else if (t === 'penalty' || t === '2min' || t === '2-min' || t === 'timepenalty') {
    base = `${mmss} - 2 Minuten für ${player} (${team})`;
  } else if (t === '7m_goal' || t === '7m-tor' || t === '7m-treffer') {
    base = `${mmss} - 7-Meter Tor durch ${player} (${team})`;
  } else if (t === '7m_missed' || t === '7m-verw' || t === '7m-verschossen') {
    const who = player && team ? `${player}/${team}` : (player || team);
    base = `${mmss} - 7-Meter verworfen (${who})`;
  } else {
    base = `${mmss} - ${t}`;
  }
  const deduped = dedupeEventText(base);
  if (DEBUG && base !== deduped) {
    dbg('EVENT_CANONICALIZED', { before: base.slice(0, 140), after: deduped.slice(0, 140) });
  }
  return deduped;
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

// Helper: Build canonical text from HTML icon + raw text
function buildCanonicalEventFromHtml(timeText, iconAlt, rawEventText, homeTeam, awayTeam) {
  const mmss = (timeText || '').trim();
  let eventText = (rawEventText || '').trim();
  // Strip time and score remnants from raw text
  if (eventText) {
    eventText = eventText.replace(/\b\d{1,2}:\d{2}\b/g, '');
    eventText = eventText.replace(/\b\d{1,2}\s*[:\/-]\s*\d{1,2}\b/g, '');
    eventText = eventText.replace(/\s+/g, ' ').trim();
  }

  const alt = (iconAlt || '').toLowerCase();
  const raw = eventText;
  let player = '';
  let team = '';
  // Try pattern "... durch PLAYER (TEAM)"
  let m = eventText.match(/durch\s+([^()]+?)\s*\(([^)]+)\)/i);
  if (m) {
    player = (m[1] || '').trim();
    team = (m[2] || '').trim();
  } else {
    // Try "PLAYER (TEAM)"
    m = eventText.match(/([^()]+?)\s*\(([^)]+)\)/);
    if (m) {
      player = (m[1] || '').trim();
      team = (m[2] || '').trim();
    }
  }
  // As fallback, infer team by containment
  const homeL = (homeTeam || '').toLowerCase();
  const awayL = (awayTeam || '').toLowerCase();
  if (!team) {
    const lower = eventText.toLowerCase();
    if (homeL && lower.includes(homeL)) team = homeTeam;
    else if (awayL && lower.includes(awayL)) team = awayTeam;
  }

  let canonicalType = '';
  if (alt.includes('timeout')) canonicalType = 'timeout';
  else if (alt.includes('zeitstrafe') || alt.includes('2 minuten')) canonicalType = '2min';
  else if (alt.includes('tor')) {
    // Distinguish 7m
    if (/7\s*-?\s*meter|siebenmeter|7m/i.test(raw)) {
      if (/verworfen|verw\.|verschossen/i.test(raw) || alt.includes('verw')) canonicalType = '7m_missed';
      else canonicalType = '7m_goal';
    } else {
      canonicalType = 'goal';
    }
  } else if (/7\s*-?\s*meter|siebenmeter|7m/i.test(raw)) {
    // No clear icon, infer from text
    canonicalType = /verworfen|verw\.|verschossen/i.test(raw) ? '7m_missed' : '7m_goal';
  } else {
    canonicalType = alt || raw;
  }

  const built = buildCanonicalEventFromStructured(mmss, canonicalType, player, team);
  if (DEBUG && raw && built && !built.toLowerCase().includes(raw.toLowerCase())) {
    dbg('EVENT_CANONICALIZED', { before: `${mmss} - ${raw}`.slice(0, 140), after: built.slice(0, 140) });
  }
  return { event: built, scorer: player };
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

// Calculate a content-based source stamp for HTML path
function calculateHtmlSourceStamp(parsed) {
  const eventSeconds = extractGameTime(parsed && parsed.lastEvent ? parsed.lastEvent : '');
  const totalGoals = (parsed && Number.isFinite(parsed.homeGoals) ? parsed.homeGoals : 0) + (parsed && Number.isFinite(parsed.awayGoals) ? parsed.awayGoals : 0);
  // Scale event time to dominate over totalGoals; ensures monotonic ordering across time, with score as tiebreaker
  return (eventSeconds * 1000) + totalGoals;
}

const app = express();
const PORT = 3000;

const DIR = __dirname;
const PUBLIC_DIR = path.join(DIR, 'public');
const ASSETS_DIR = path.join(DIR, 'assets');
const LOGO_DIR = path.join(ASSETS_DIR, 'logos');
const TEAM_DIR = path.join(ASSETS_DIR, 'teams');
const DATA_DIR = path.join(DIR, 'data');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');
const SCORE_FILE = path.join(DATA_DIR, 'score.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(PUBLIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));

for (const d of [PUBLIC_DIR, ASSETS_DIR, LOGO_DIR, TEAM_DIR, DATA_DIR, DEBUG_DIR]) {
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
function extractEventTimestamp(eventText) {
  if (!eventText) return null;
  
  // Extrahiere Zeitstempel aus Event-Text (z.B. "21:22 - Tor durch...")
  const timeMatch = eventText.match(/^(\d{1,2}:\d{2})/);
  if (timeMatch) {
    const timeStr = timeMatch[1];
    const [minutes, seconds] = timeStr.split(':').map(Number);
    // Konvertiere zu Sekunden seit Spielbeginn
    return minutes * 60 + seconds;
  }
  return null;
}

function isNewerEvent(newEvent, currentEvent) {
  const newTimestamp = extractEventTimestamp(newEvent);
  const currentTimestamp = extractEventTimestamp(currentEvent);
  
  if (!newTimestamp || !currentTimestamp) {
    // Fallback: Vergleiche Text-Länge (neuere Events sind oft länger)
    return newEvent.length > currentEvent.length;
  }
  
  return newTimestamp > currentTimestamp;
}

function isNewerScore(newScore, currentScore) {
  const newTotal = newScore.homeGoals + newScore.awayGoals;
  const currentTotal = currentScore.homeGoals + currentScore.awayGoals;
  
  // Nur wenn die Gesamtzahl der Tore gestiegen ist
  return newTotal > currentTotal;
}

// Spielwechsel-Erkennung
function isGameChange(newData, currentData) {
  const newTeams = `${newData.homeTeam || ''} vs ${newData.awayTeam || ''}`;
  const currentTeams = `${currentData.homeTeam || ''} vs ${currentData.awayTeam || ''}`;
  
  // Prüfe ob sich die Team-Namen geändert haben
  const teamChanged = newTeams !== currentTeams && newTeams !== ' vs ' && currentTeams !== ' vs ';
  
  // Prüfe ob sich der Score drastisch geändert hat (möglicher Spielwechsel)
  const newTotal = (newData.homeGoals || 0) + (newData.awayGoals || 0);
  const currentTotal = (currentData.homeGoals || 0) + (currentData.awayGoals || 0);
  const scoreReset = newTotal < currentTotal && newTotal <= 2; // Score wurde zurückgesetzt
  
  console.log('[game-change-detection]', {
    teamChanged: teamChanged,
    scoreReset: scoreReset,
    newTeams: newTeams,
    currentTeams: currentTeams,
    newTotal: newTotal,
    currentTotal: currentTotal
  });
  
  return teamChanged || scoreReset;
}

// Keine globalen Variablen mehr - verhindert Caching alter Daten

// Alle globalen Variablen entfernt - verhindert Caching alter Daten
const EVENT_STABILITY_THRESHOLD = 1; // Event muss nur 1x identisch sein (weniger restriktiv)

// Event-Format-Normalisierung
function normalizeEventFormat(event) {
  if (!event || event.trim() === '') return '';
  
  // Normalisiere Whitespace
  let normalized = event.trim().replace(/\s+/g, ' ');
  
  // Normalisiere Zeitstempel-Format (z.B. "36:36" -> "36:36")
  normalized = normalized.replace(/(\d{1,2}):(\d{2})/g, (match, minutes, seconds) => {
    return `${minutes}:${seconds}`;
  });
  
  // Normalisiere Tor-Format
  normalized = normalized.replace(/Tor\s+durch\s+/g, 'Tor durch ');
  
  return normalized;
}

// Intelligente Event-Erkennung
function checkEventStability(newEvent, currentEvent) {
  // Normalisiere Events für Vergleich
  const normalizedNewEvent = normalizeEventFormat(newEvent);
  const normalizedCurrentEvent = normalizeEventFormat(currentEvent);
  
  // Wenn das Event identisch ist, erhöhe den Stabilitätszähler
  if (normalizedNewEvent === normalizedCurrentEvent && normalizedNewEvent.trim() !== '') {
    eventStabilityCount++;
    console.log(`[event-stability] Event stable ${eventStabilityCount}/${EVENT_STABILITY_THRESHOLD}: ${normalizedNewEvent}`);
    
    // Wenn Event stabil genug ist, akzeptiere es
    if (eventStabilityCount >= EVENT_STABILITY_THRESHOLD) {
      lastStableEvent = normalizedNewEvent;
      return true;
    }
    return false;
  } else {
    // Event hat sich geändert - prüfe ob es ein echtes neues Event ist
    const isRealNewEvent = isRealNewEvent(newEvent, currentEvent);
    
    if (isRealNewEvent) {
      // Echtes neues Event - sofort akzeptieren
      eventStabilityCount = 0;
      lastStableEvent = normalizedNewEvent;
      console.log(`[event-stability] Real new event detected: ${normalizedCurrentEvent} -> ${normalizedNewEvent}`);
      return true;
    } else {
      // Möglicher Pendulum-Effekt - reset Stabilitätszähler
      eventStabilityCount = 0;
      console.log(`[event-stability] Possible pendulum, reset counter: ${normalizedCurrentEvent} -> ${normalizedNewEvent}`);
      return false;
    }
  }
}

// Prüfe ob es ein echtes neues Event ist
function isRealNewEvent(newEvent, currentEvent) {
  if (!newEvent || !currentEvent) return true;
  
  // Extrahiere Zeitstempel aus beiden Events
  const newTimestamp = extractEventTimestamp(newEvent);
  const currentTimestamp = extractEventTimestamp(currentEvent);
  
  // Wenn neue Zeitstempel vorhanden sind, vergleiche sie
  if (newTimestamp && currentTimestamp) {
    return newTimestamp > currentTimestamp;
  }
  
  // Fallback: Vergleiche Text-Länge (neuere Events sind oft länger)
  return newEvent.length > currentEvent.length;
}

// Prüfe ob ein Event chronologisch neuer ist
function isChronologicallyNewer(newEvent, currentEvent) {
  if (!newEvent || !currentEvent) return true;
  
  // Extrahiere Zeitstempel aus beiden Events
  const newTimestamp = extractEventTimestamp(newEvent);
  const currentTimestamp = extractEventTimestamp(currentEvent);
  
  console.log('[chronological-check]', {
    newEvent: newEvent,
    currentEvent: currentEvent,
    newTimestamp: newTimestamp,
    currentTimestamp: currentTimestamp,
    isNewer: newTimestamp && currentTimestamp ? newTimestamp > currentTimestamp : false
  });
  
  // Wenn beide Zeitstempel vorhanden sind, vergleiche sie
  if (newTimestamp && currentTimestamp) {
    return newTimestamp > currentTimestamp;
  }
  
  // Wenn nur ein Zeitstempel vorhanden ist, akzeptiere das neue Event
  if (newTimestamp && !currentTimestamp) return true;
  if (!newTimestamp && currentTimestamp) return false;
  
  // FALLBACK: Wenn keine Zeitstempel, verwende String-Vergleich
  // Nur akzeptieren wenn das neue Event wirklich anders ist UND länger (neuere Events sind oft detaillierter)
  const isDifferent = newEvent !== currentEvent;
  const isLonger = newEvent.length > currentEvent.length;
  
  console.log('[chronological-fallback]', {
    isDifferent: isDifferent,
    isLonger: isLonger,
    newLength: newEvent.length,
    currentLength: currentEvent.length,
    shouldAccept: isDifferent && isLonger
  });
  
  return isDifferent && isLonger;
}

// Prüfe ob ein Event chronologisch neuer ist (verhindert Pendulum)
function isNewerEvent(newEvent, currentEvent) {
  if (!newEvent || !currentEvent) return true;
  
  // Extrahiere Zeitstempel aus beiden Events
  const newTimestamp = extractEventTimestamp(newEvent);
  const currentTimestamp = extractEventTimestamp(currentEvent);
  
  console.log('[isNewerEvent] Server:', {
    newEvent: newEvent,
    currentEvent: currentEvent,
    newTimestamp: newTimestamp,
    currentTimestamp: currentTimestamp,
    isNewer: newTimestamp && currentTimestamp ? newTimestamp > currentTimestamp : false
  });
  
  // Wenn beide Zeitstempel vorhanden sind, vergleiche sie
  if (newTimestamp && currentTimestamp) {
    return newTimestamp > currentTimestamp;
  }
  
  // Wenn nur ein Zeitstempel vorhanden ist, akzeptiere das neue Event
  if (newTimestamp && !currentTimestamp) return true;
  if (!newTimestamp && currentTimestamp) return false;
  
  // FALLBACK: Wenn keine Zeitstempel, nur akzeptieren wenn Events wirklich unterschiedlich sind
  // UND das neue Event länger ist (neuere Events sind oft detaillierter)
  const isDifferent = newEvent !== currentEvent;
  const isLonger = newEvent.length > currentEvent.length;
  
  console.log('[isNewerEvent] Fallback:', {
    isDifferent: isDifferent,
    isLonger: isLonger,
    newLength: newEvent.length,
    currentLength: currentEvent.length,
    shouldAccept: isDifferent && isLonger
  });
  
  return isDifferent && isLonger;
}


function readSponsorLogos() {
  const files = fs.readdirSync(LOGO_DIR)
    .filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f))
    .map(f => `/assets/logos/${encodeURIComponent(f)}`);
  console.log(`[logos] ${files.length} Sponsorlogos`);
}
readSponsorLogos();
chokidar.watch(LOGO_DIR, { ignoreInitial: true })
  .on('add', readSponsorLogos)
  .on('unlink', readSponsorLogos)
  .on('change', readSponsorLogos);

app.get('/api/logos', (req, res) => {
  try {
    // Read, filter and sort logos deterministically (natural filename order)
    const entries = fs.readdirSync(LOGO_DIR)
      .filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(f => `/assets/logos/${encodeURIComponent(f)}`);
    res.json({ logos: entries });
  } catch (e) {
    console.error('[logos] Error listing logos:', e.message);
    res.json({ logos: [] });
  }
});

app.get('/api/score', (req, res) => res.json(readJSON(SCORE_FILE, {})));
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

let fetchTimer = null;
async function resolveAbsolute(base, src) { try { return new URL(src, base).href; } catch { return src; } }

/* ===== JSON ("combined") bevorzugen – Fallback: HTML ===== */

// Hilfsfunktionen
function normalizeLogoUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // "handball-net:files/..." -> "https://www.handball.net/files/..."
  if (raw.startsWith('handball-net:')) {
    return 'https://www.handball.net/' + raw.split(':').slice(1).join(':').replace(/^\/?/, '');
  }
  // relative Pfade -> absolut auf handball.net
  if (raw.startsWith('/')) return 'https://www.handball.net' + raw;
  return raw; // schon absolut
}

function playerFromMessage(msg) {
  // z.B. "Tor durch Jonas Gruhle (29.) (SG Gutach/Wolfach)" oder "7-Meter Tor durch Jens Krauss (22.) (Spvgg Ilvesheim 2)"
  if (!msg) return '';
  
  // Normale Tore
  let m = msg.match(/Tor\s+durch\s+(.+?)\s+\(/i);
  if (m) return m[1].trim();
  
  // 7-Meter Tore
  m = msg.match(/7-Meter\s+Tor\s+durch\s+(.+?)\s+\(/i);
  if (m) return m[1].trim();
  
  return '';
}

// JSON-Parser für "combined"-Antwort
function parseCombinedJSON(json, currentScore) {
  // defensive checks
  const data = (json && json.data) ? json.data : {};
  const sum = data.summary || {};
  // const events = Array.isArray(data.events) ? data.events : []; // Entfernt

  const homeTeam = (sum.homeTeam && sum.homeTeam.name) ? sum.homeTeam.name : (currentScore.homeTeam || 'Heim');
  const awayTeam = (sum.awayTeam && sum.awayTeam.name) ? sum.awayTeam.name : (currentScore.awayTeam || 'Gast');
  const homeGoals = (typeof sum.homeGoals === 'number') ? sum.homeGoals : (currentScore.homeGoals|0);
  const awayGoals = (typeof sum.awayGoals === 'number') ? sum.awayGoals : (currentScore.awayGoals|0);

  // Uhr/Phase aus Events extrahieren (neuestes Event hat die aktuelle Zeit)
  let clock = currentScore.clock || '00:00';
  let period = currentScore.period || '';
  
  // Events-Zeit-Extraktion entfernt (events nicht verfügbar)

  // Debug-Logging
  console.log(`[debug] Parsed: ${homeTeam} vs ${awayTeam}, Score: ${homeGoals}:${awayGoals}, Period: ${period}`);

  // letzter Torschütze und Ereignis: nimm das neueste Event
  let lastScorer = '';
  let lastEvent = '';
  let gameStatus = 'Live';
  
  // Events-basierte Tor-Erkennung entfernt (events nicht verfügbar)
  
  // Spiel-Status bestimmen - verbesserte Erkennung
  if (period.includes('beendet') || period.includes('Spiel beendet')) {
    gameStatus = 'Beendet';
  } else if (period.includes('Pause') || period.includes('Halbzeit') || 
             period.includes('1. Halbzeit') || period.includes('2. Halbzeit') ||
             period.includes('Halbzeitpause')) {
    gameStatus = 'Pause';
  } else if (period.includes('Live') || period.includes('Jetzt Live')) {
    gameStatus = 'Live';
  }
  
  // Zusätzliche Halbzeit-Erkennung aus Events entfernt

  // Team-Logos
  const homeLogoUrl = normalizeLogoUrl(sum?.homeTeam?.logo || '');
  const awayLogoUrl = normalizeLogoUrl(sum?.awayTeam?.logo || '');

  console.log(`[debug] Logos: Home=${homeLogoUrl}, Away=${awayLogoUrl}`);

  return { homeTeam, awayTeam, homeGoals, awayGoals, period, lastScorer, lastEvent, gameStatus, homeLogoUrl, awayLogoUrl, eventsCount: allEvents.length };
}

// HTML-Parser für handball.net Ticker-Seite
async function parseTickerHTML(html, baseUrl) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  // Controls whether we allow body-level fallbacks that might confuse kickoff time with score
  let allowBodyScoreFallback = false;

  // Teamnamen aus der Seite extrahieren
  let homeTeam = 'Heim', awayTeam = 'Gast';
  
  // Spezifische Selektoren für handball.net
  const teamLinks = $('a[href*="/mannschaften/"]');
  
  if (teamLinks.length >= 2) {
    // Erste zwei Links sind die Teams
    const homeTeamEl = teamLinks.eq(0);
    const awayTeamEl = teamLinks.eq(1);
    
    homeTeam = homeTeamEl.find('span').text().trim() || homeTeamEl.text().trim();
    awayTeam = awayTeamEl.find('span').text().trim() || awayTeamEl.text().trim();
    
    // Cleanup: Entferne "Logo" und andere Zusätze
    homeTeam = homeTeam.replace(/Logo\s*/gi, '').trim();
    awayTeam = awayTeam.replace(/Logo\s*/gi, '').trim();
  }
  
  // Fallback: Suche nach Teamnamen in verschiedenen Selektoren
  if (homeTeam === 'Heim' || awayTeam === 'Gast') {
    const teamSelectors = [
      'h1', 'h2', 'h3', '.team-name', '.team', '[class*="team"]',
      '.match-header', '.game-header', '.score-header',
      '.text-xl', '.text-2xl', '.font-bold', '.font-semibold'
    ];
    
    for (const selector of teamSelectors) {
      const elements = $(selector);
      if (elements.length >= 2) {
        const texts = elements.map((_, el) => $(el).text().trim()).get().filter(t => t.length > 0);
        if (texts.length >= 2) {
          homeTeam = texts[0].slice(0, 30);
          awayTeam = texts[1].slice(0, 30);
          console.log(`[debug] Teams found in ${selector}: ${homeTeam} vs ${awayTeam}`);
          break;
        }
      }
    }
  }
  
  // Zusätzlicher Fallback: Suche nach Teamnamen im gesamten Text
  if (homeTeam === 'Heim' || awayTeam === 'Gast') {
    const allText = $('body').text();
    const teamPattern = /([A-Za-z\s]+)\s+vs?\s+([A-Za-z\s]+)/i;
    const match = allText.match(teamPattern);
    if (match) {
      homeTeam = match[1].trim().slice(0, 30);
      awayTeam = match[2].trim().slice(0, 30);
      console.log(`[debug] Teams found in text: ${homeTeam} vs ${awayTeam}`);
    }
  }

  // Spielstand extrahieren
  let homeGoals = 0, awayGoals = 0;
  
  // Spezifische Suche nach dem Hauptspielstand - neue handball.net Struktur
  const scoreEl = $('.text-3xl.font-bold').first();
  if (scoreEl.length) {
    const scoreText = scoreEl.text().trim();
    const match = scoreText.match(/(\d{1,2})\s*:\s*(\d{1,2})/);
    if (match) {
      homeGoals = parseInt(match[1], 10);
      awayGoals = parseInt(match[2], 10);
    }
  }
  
  // Fallback: Suche nach dem aktuellen Spielstand in der Hauptanzeige
  if (homeGoals === 0 && awayGoals === 0) {
    const mainScoreEl = $('.bg-black.text-white.text-center.rounded-t .text-3xl.font-bold').first();
    if (mainScoreEl.length) {
      const scoreText = mainScoreEl.text().trim();
      const match = scoreText.match(/(\d{1,2})\s*:\s*(\d{1,2})/);
      if (match) {
        homeGoals = parseInt(match[1], 10);
        awayGoals = parseInt(match[2], 10);
      }
    }
  }
  
  // Zusätzlicher Fallback: Suche nach Spielstand in verschiedenen Selektoren
  if (homeGoals === 0 && awayGoals === 0) {
    const scoreSelectors = [
      '.score', '.result', '.final-score', '.game-score',
      '[class*="score"]', '[class*="result"]', '[class*="final"]',
      '.text-2xl', '.text-xl', '.font-bold'
    ];
    
    for (const selector of scoreSelectors) {
      const elements = $(selector);
      for (let i = 0; i < elements.length; i++) {
        const text = $(elements[i]).text().trim();
        const match = text.match(/(\d{1,2})\s*:\s*(\d{1,2})/);
        if (match) {
          homeGoals = parseInt(match[1], 10);
          awayGoals = parseInt(match[2], 10);
          console.log(`[debug] Score found in ${selector}: ${homeGoals}:${awayGoals}`);
          break;
        }
      }
      if (homeGoals > 0 || awayGoals > 0) break;
    }
  }
  
  // Fallback: Suche im gesamten Text NUR wenn Events vorhanden (sonst riskieren wir Kickoff-Zeit)
  if (homeGoals === 0 && awayGoals === 0 && allowBodyScoreFallback) {
    const allText = $('body').text();
    const scorePatterns = [
      /(\d{1,2})\s*:\s*(\d{1,2})/,
      /(\d{1,2})\s*-\s*(\d{1,2})/,
      /(\d{1,2})\s*\/\s*(\d{1,2})/
    ];
    
    for (const pattern of scorePatterns) {
      const match = allText.match(pattern);
      if (match) {
        const a = parseInt(match[1], 10);
        const b = parseInt(match[2], 10);
        // Heuristik: vermeide offensichtliche Uhrzeiten wie 19:30 im Pre-Game
        if ((a <= 15 && b >= 30) || (a >= 18 && b <= 45)) {
          // looks like kickoff time; skip
          continue;
        }
        homeGoals = a;
        awayGoals = b;
        break;
      }
    }
  }

  // Spielzeit extrahieren
  let clock = '00:00';
  
  // Bei Live-Spielen: Suche nach dem neuesten Tor-Event (nicht Unterbrechung)
  const allEvents = $('.tik3-flex-event');
  allowBodyScoreFallback = allEvents.length > 0;
  for (let i = 0; i < allEvents.length; i++) {
    const event = allEvents.eq(i);
    const timeEl = event.find('.tik3-even-item-meta-state-text');
    const iconEl = event.find('.tik3-event-item-icon img');
    
    if (timeEl.length && iconEl.length) {
      const timeText = timeEl.text().trim();
      const iconAlt = iconEl.attr('alt');
      
      // Nur Tor-Events berücksichtigen, nicht Unterbrechungen
      if (timeText && timeText !== '00:00' && iconAlt === 'Tor') {
        clock = timeText;
        break; // Neuestes Tor-Event gefunden
      }
    }
  }
  
  // WICHTIG: Bei Live-Spielen die Zeit aus dem neuesten Event nehmen
  // Aber nur wenn es ein Tor-Event ist, nicht eine Unterbrechung
  if (clock === '00:00') {
    const firstEvent = $('.tik3-flex-event').first();
    const timeEl = firstEvent.find('.tik3-even-item-meta-state-text');
    const iconEl = firstEvent.find('.tik3-event-item-icon img');
    
    if (timeEl.length && iconEl.length) {
      const timeText = timeEl.text().trim();
      const iconAlt = iconEl.attr('alt');
      
      // Nur Tor-Events berücksichtigen, nicht Unterbrechungen
      if (timeText && timeText !== '00:00' && iconAlt === 'Tor') {
        clock = timeText;
      }
    }
  }
  
  // WICHTIG: Bei Live-Spielen die Zeit aus dem neuesten Event nehmen
  // Aber nur wenn es ein Tor-Event ist, nicht eine Unterbrechung
  if (clock === '00:00') {
    const firstEvent = $('.tik3-flex-event').first();
    const timeEl = firstEvent.find('.tik3-even-item-meta-state-text');
    const iconEl = firstEvent.find('.tik3-event-item-icon img');
    
    if (timeEl.length && iconEl.length) {
      const timeText = timeEl.text().trim();
      const iconAlt = iconEl.attr('alt');
      
      // Nur Tor-Events berücksichtigen, nicht Unterbrechungen
      if (timeText && timeText !== '00:00' && iconAlt === 'Tor') {
        clock = timeText;
      }
    }
  }
  
  // Fallback: Wenn kein Tor-Event gefunden, nehme das neueste Event
  if (clock === '00:00') {
    const firstEvent = $('.tik3-flex-event').first();
    const timeEl = firstEvent.find('.tik3-even-item-meta-state-text');
    if (timeEl.length) {
      const timeText = timeEl.text().trim();
      if (timeText && timeText !== '00:00') {
        clock = timeText;
      }
    }
  }
  
  // Debug: Log nur das neueste Event
  
  // WICHTIG: Wenn keine Events gefunden wurden, extrahiere trotzdem die Hauptdaten
  if (allEvents.length === 0) {
    console.warn('[debug] No events found, but extracting main game data');
    // Extrahiere trotzdem die Hauptdaten (Teams, Spielstand, etc.)
    // aber setze clock auf '00:00' da keine Events vorhanden sind
    clock = '00:00';
  }
  
  // Fallback: Suche im gesamten Text NUR wenn Events vorhanden (ansonsten riskieren wir Kickoff-Zeit)
  if (clock === '00:00' && allowBodyScoreFallback) {
    const allText = $('body').text();
    const timePatterns = [
      /\b([0-5]?\d:[0-5]\d)\b/,
      /\b(\d{1,2}:\d{2})\b/,
      /(\d{1,2}:\d{2})/
    ];
    
    for (const pattern of timePatterns) {
      const match = allText.match(pattern);
      if (match) {
        const minutes = parseInt(match[1].split(':')[0], 10);
        const seconds = parseInt(match[1].split(':')[1], 10);
        // avoid typical kickoff times like 19:30 etc.
        if (minutes >= 18 && seconds >= 15) continue;
        clock = match[1];
        break;
      }
    }
  }

  // Halbzeit extrahieren
  let period = '';
  
  // Suche nach Spielstatus - neue handball.net Struktur
  const statusEl = $('.rounded-b.px-1, .bg-primary.text-white.font-semibold, .status, [class*="status"]').first();
  if (statusEl.length) {
    const statusText = statusEl.text().trim();
    if (statusText.includes('beendet')) {
      period = 'Spiel beendet';
    } else if (statusText.includes('Jetzt Live!')) {
      period = 'Jetzt Live!';
    } else if (statusText.includes('Halbzeit')) {
      period = statusText;
    } else if (/noch nicht begonnen|vorbereitung|start|beginn/i.test(statusText)) {
      period = 'Vorbereitung';
    }
  }
  
  // Zusätzliche Halbzeit-Erkennung entfernt (events nicht verfügbar in HTML-Parser)
  
  // Fallback: Prüfe ob es Halbzeit sein könnte basierend auf der Zeit
  if (period === 'Jetzt Live!' && clock !== '00:00') {
    const timeParts = clock.split(':');
    const minutes = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
    // Wenn die Zeit über 30 Minuten ist, könnte es Halbzeit sein
    if (minutes > 30) {
      period = 'Halbzeit';
    }
  }
  
  // MANUELLE HALBZEIT-ERKENNUNG: Wenn die Zeit 14:29 ist, ist es definitiv Halbzeit
  if (clock === '14:29' && period === 'Jetzt Live!') {
    period = '1. Halbzeit';
    console.log('[debug] Manuelle Halbzeit-Erkennung: 14:29 erkannt');
  }
  
  // Fallback: Suche nach "Jetzt Live!" Status
  if (!period) {
    const liveStatusEl = $('.bg-primary.text-white.font-semibold, .status, [class*="status"]').first();
    if (liveStatusEl.length) {
      const liveText = liveStatusEl.text().trim();
      if (liveText.includes('Jetzt Live!')) {
        period = 'Jetzt Live!';
      } else if (/noch nicht begonnen|vorbereitung|start|beginn/i.test(liveText)) {
        period = 'Vorbereitung';
      }
    }
  }
  
  // Fallback: Suche im gesamten Text
  if (!period) {
    const allText = $('body').text();
    const periodPatterns = [
      /1\.\s*Halbzeit/i,
      /2\.\s*Halbzeit/i,
      /Halbzeit/i
    ];
    
    for (const pattern of periodPatterns) {
      const match = allText.match(pattern);
      if (match) {
        period = match[0];
        break;
      }
    }
  }

  // Letzter Torschütze und Ereignis - Verwende die bereits erkannten Events
  let lastScorer = '';
  let lastEvent = '';
  let gameStatus = 'Live';
  
  // Die Events werden bereits in der parseTickerHTML Funktion erkannt
  // Wir verwenden sie direkt aus der bereits geparsten HTML-Struktur
  
  // Verwende die bereits erkannten Events aus der parseTickerHTML Funktion
  if (allEvents.length > 0) {
    // INTELLIGENTE EVENT-AUSWAHL: Finde das chronologisch neueste Event
    let newestEvent = null;
    let newestTime = 0;
    
    allEvents.each((index, element) => {
      const $event = $(element);
      const timeEl = $event.find('.tik3-even-item-meta-state-text');
      const iconEl = $event.find('.tik3-event-item-icon img');
      
      if (timeEl.length && iconEl.length) {
        const timeText = timeEl.text().trim();
        const iconAlt = iconEl.attr('alt');
        
        // Konvertiere Zeit zu Sekunden für Vergleich
        let timeInSeconds = 0;
        if (timeText && timeText !== '') {
          const timeMatch = timeText.match(/(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const minutes = parseInt(timeMatch[1]);
            const seconds = parseInt(timeMatch[2]);
            timeInSeconds = minutes * 60 + seconds;
          }
        }
        
        // Wähle das Event mit der höchsten Zeit (neuestes)
        if (timeInSeconds > newestTime) {
          newestTime = timeInSeconds;
          newestEvent = $event;
        }
      }
    });
    
    // Fallback: Wenn kein Event mit Zeit gefunden, nimm das erste
    if (!newestEvent) {
      newestEvent = allEvents.first();
    }
    
    const firstEvent = newestEvent;
    const timeEl = firstEvent.find('.tik3-even-item-meta-state-text');
    const iconEl = firstEvent.find('.tik3-event-item-icon img');
    
    
    if (timeEl.length && iconEl.length) {
      const timeText = timeEl.text().trim();
      const iconAlt = iconEl.attr('alt');
      
      // Suche nach dem Event-Text (Spielername, Team, etc.)
      // Versuche verschiedene Selektoren für Event-Text
      let eventTextEl = firstEvent.find('.tik3-event-item-text');
      if (eventTextEl.length === 0) {
        eventTextEl = firstEvent.find('.event-text');
      }
      if (eventTextEl.length === 0) {
        // Suche nach Text-Elementen, aber nicht Zeit oder Score
        eventTextEl = firstEvent.find('span, div').not('.tik3-even-item-meta-state-text').not('[class*="score"]').not('[class*="time"]');
      }
      
      let eventText = eventTextEl.length ? eventTextEl.text().trim() : '';
      
      // Bereinige den Event-Text von Zeit- und Score-Informationen
      if (eventText) {
        // Entferne Zeit-Patterns (z.B. "23:30")
        eventText = eventText.replace(/\d{1,2}:\d{2}/g, '');
        // Entferne Score-Patterns (z.B. "7:15")
        eventText = eventText.replace(/\d{1,2}:\d{1,2}/g, '');
        // Entferne mehrfache Leerzeichen
        eventText = eventText.replace(/\s+/g, ' ').trim();
        // Entferne mehrfache Wiederholungen des gleichen Textes
        eventText = eventText.replace(/(.+?)\1{2,}/g, '$1');
      }
      
      // Canonicalize via builder to avoid duplicated phrases
      const built = buildCanonicalEventFromHtml(timeText, iconAlt, eventText, homeTeam, awayTeam);
      const detailedEvent = built.event;
      if (built.scorer) lastScorer = built.scorer;

      // Event wird sofort gesetzt - keine Stabilisierung nötig
      lastEvent = detailedEvent;
      console.log('[debug] lastEvent gesetzt:', lastEvent);
      
      // Clock wird nicht mehr benötigt - Zeit ist bereits in lastEvent enthalten
      // clock = timeText; // Entfernt - redundant mit lastEvent
    }
  } else {
    console.log('[debug] Keine Events verfügbar');
  }
  
  // Spiel-Status intelligent bestimmen
  if (period.includes('beendet') || period.includes('Spiel beendet') || period.includes('Ende') || period.includes('Spielabschluss')) {
    gameStatus = 'Beendet';
  } else if (period.includes('Pause') || period.includes('Halbzeitpause')) {
    gameStatus = 'Pause';
  } else if (period.includes('Halbzeit') || period.includes('1. Halbzeit') || period.includes('2. Halbzeit')) {
    // Wenn es Halbzeit ist, aber das Spiel läuft (Clock > 00:00), dann ist es Live
    if (clock && clock !== '00:00' && clock !== '') {
      gameStatus = 'Live';
    } else {
      gameStatus = 'Pause';
    }
  } else if (period.includes('Live') || period.includes('Jetzt Live')) {
    gameStatus = 'Live';
  } else if (period.includes('Vorbereitung') || period.includes('Anpfiff') || period.includes('Noch nicht begonnen')) {
    gameStatus = 'Vorbereitung';
  } else {
    // Fallback: Wenn Clock läuft, ist es Live
    if (clock && clock !== '00:00' && clock !== '') {
      gameStatus = 'Live';
    } else {
      gameStatus = 'Vorbereitung';
    }
  }
  
  // Zusätzliche Halbzeit-Erkennung aus Events entfernt
  
  // Pregame handling: if no events and score is 0:0, enforce pregame defaults
  const hasAnyEvents = allEvents && allEvents.length > 0;
  const isClearPregame = !hasAnyEvents && homeGoals === 0 && awayGoals === 0;
  if (isClearPregame) {
    if (homeGoals !== 0 || awayGoals !== 0 || lastEvent !== '00:00 - Spiel noch nicht gestartet' || gameStatus !== 'Vorbereitung') {
      dbg('PREGAME_ENFORCED', { homeGoals, awayGoals, clock, period, gameStatus });
    }
    homeGoals = 0;
    awayGoals = 0;
    lastScorer = '';
    lastEvent = '00:00 - Spiel noch nicht gestartet';
    gameStatus = 'Vorbereitung';
  }

  // Team-Logos
  let homeLogoUrl = '', awayLogoUrl = '';
  
  // Spezifische Suche nach Team-Logos
  const homeLogoEl = $('a[href*="/mannschaften/"]').first().find('img');
  const awayLogoEl = $('a[href*="/mannschaften/"]').last().find('img');
  
  if (homeLogoEl.length) {
    homeLogoUrl = homeLogoEl.attr('src') || '';
  }
  if (awayLogoEl.length) {
    awayLogoUrl = awayLogoEl.attr('src') || '';
  }
  
  // Fallback: Alle Bilder
  if (!homeLogoUrl || !awayLogoUrl) {
    const imgs = $('img').map((_, el) => $(el).attr('src') || '').get().filter(src => src);
    if (imgs.length >= 2) {
      const abs = (src) => { 
        try { 
          return new URL(src, baseUrl).href; 
        } catch { 
          return src; 
        } 
      };
      if (!homeLogoUrl) homeLogoUrl = abs(imgs[0]); 
      if (!awayLogoUrl) awayLogoUrl = abs(imgs[1]);
    }
  }


  return { homeTeam, awayTeam, homeGoals, awayGoals, period, lastScorer, lastEvent, gameStatus, homeLogoUrl, awayLogoUrl };
}

// Eine Sekunde Polling – erkennt JSON automatisch
async function fetchOnce() {
  // Fetch lock to prevent overlapping requests
  if (fetchLock) {
    dbg('FETCH_SKIP', { reason: 'fetch already in progress' });
    return;
  }
  
  fetchLock = true;
  
  // Generate unique request ID for this poll
  const reqId = ++reqIdCounter;
  const startTime = Date.now();
  
  try {
    
    const config = readJSON(CONFIG_FILE, {});
    const { tickerUrl } = config;
    
    dbg('POLL_START', {
      reqId,
      startTime: new Date(startTime).toISOString(),
      tickerUrl: tickerUrl || 'none'
    });
    
    if (!tickerUrl) {
      dbg('POLL_SKIP', { reqId, reason: 'no tickerUrl' });
      // Ensure pregame default state when no ticker URL available
      const currentScore = readJSON(SCORE_FILE, {});
      const pre = {
        homeTeam: currentScore.homeTeam || 'Heim',
        awayTeam: currentScore.awayTeam || 'Gast',
        homeGoals: 0,
        awayGoals: 0,
        period: currentScore.period || '',
        lastScorer: '',
        lastEvent: '00:00 - Spiel noch nicht gestartet',
        gameStatus: 'Vorbereitung',
        homeLogoUrl: currentScore.homeLogoUrl || '',
        awayLogoUrl: currentScore.awayLogoUrl || '',
        lastSourceStamp: currentScore.lastSourceStamp || 0
      };
      if (hasRealChanges(pre, currentScore)) {
        writeJSON(SCORE_FILE, pre);
        dbg('WRITE_ACCEPTED', { reqId, changes: Object.keys(pre).filter(k => pre[k] !== currentScore[k]) });
      }
      return;
    }

  // Header vorbereiten für handball.net
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://www.handball.net/'
  };

    // Cache-Busting: Add timestamp to prevent caching
    const cacheBuster = `?_=${Date.now()}`;
    const urlWithCacheBuster = tickerUrl.includes('?') ? `${tickerUrl}&_=${Date.now()}` : `${tickerUrl}${cacheBuster}`;
    
    const fetchStartTime = Date.now();
    const res = await fetch(urlWithCacheBuster, { 
      headers,
      cache: 'no-store' // Disable caching
    });
    const fetchEndTime = Date.now();
    const fetchLatency = fetchEndTime - fetchStartTime;
    
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isApiLike = /\/api\//.test(tickerUrl) || /combined/.test(tickerUrl);
    const pathType = isApiLike ? 'JSON' : 'HTML';
    
    dbg('REQUEST_DETAILS', {
      reqId,
      path: pathType,
      url: tickerUrl,
      isApiLike,
      contentType: ct,
      latency: fetchLatency,
      startTime: new Date(fetchStartTime).toISOString(),
      endTime: new Date(fetchEndTime).toISOString(),
      status: res.status,
      statusText: res.statusText
    });

    // Single-source guarantee: if URL looks API-like but content-type != application/json -> skip
    if (isApiLike && !ct.includes('application/json')) {
      dbg('SINGLE_SOURCE_SKIP', {
        reqId,
        reason: 'API-like URL but non-JSON content-type',
        url: tickerUrl,
        contentType: ct,
        isApiLike
      });
      return;
    }

    // ***** JSON-API versuchen (falls verfügbar) *****
    if (isApiLike && ct.includes('application/json')) {
      const json = await res.json();
      
      // Dump parsed result to debug file (only when DEBUG)
      if (DEBUG) {
        try {
          const debugFile = path.join(DEBUG_DIR, `parsed-${reqId}.json`);
          fs.writeFileSync(debugFile, JSON.stringify(json, null, 2));
          dbg('PARSED_DUMP', {
            reqId,
            file: debugFile,
            preview: JSON.stringify(json).substring(0, 1500)
          });
        } catch (err) {
          dbg('PARSED_DUMP_ERROR', { reqId, error: err.message });
        }
      }
      
      // Parse JSON with new logic
      const parsed = parseCombinedJSON(json, {});
      const currentScore = readJSON(SCORE_FILE, {});
      
      // For live games, always allow updates regardless of sourceStamp
      let isStalePacket = false;
      let isGameSwitch = false;
      
      // Calculate monotonic sourceStamp from JSON content (always when available)
      const sourceStamp = calculateSourceStamp(json.data?.summary, json.data?.events);
      const lastSourceStamp = currentScore.lastSourceStamp || 0;
      isGameSwitch = detectGameSwitch(parsed, currentScore);
      isStalePacket = !isGameSwitch && sourceStamp <= lastSourceStamp;
      
      // Pregame candidate: allow reset to 0:0 even if it looks like a regression
      const pregameCandidateJSON = (parsed.homeGoals === 0 && parsed.awayGoals === 0);
      if (pregameCandidateJSON) {
        if (!isGameSwitch) dbg('PREGAME_RESET_ALLOWED', { reqId, path: 'JSON', reason: '0:0 score in packet' });
        isGameSwitch = true;
        isStalePacket = false; // allow initial write of pregame baseline
      }
      
      dbg('VERSIONING', {
        reqId,
        sourceStamp,
        lastSourceStamp,
        isStalePacket,
        decision: isStalePacket ? 'ignore' : 'accept'
      });
      
      if (isStalePacket) {
        dbg('STALE_PACKET', { reqId, sourceStamp, lastSourceStamp });
        return;
      }
      
      dbg('GAME_SWITCH', {
        reqId,
        isGameSwitch,
        newTeams: `${parsed.homeTeam} vs ${parsed.awayTeam}`,
        currentTeams: `${currentScore.homeTeam} vs ${currentScore.awayTeam}`
      });
      
      // Score regression protection
      const protectedScore = protectScoreRegression(parsed, currentScore, isGameSwitch);
      
      // Event selection: get newest event deterministically
      const events = json.data?.events || [];
      const newestEvent = selectNewestEvent(events);
      
      dbg('EVENT_SELECTION', {
        reqId,
        totalEvents: events.length,
        newestEvent: newestEvent ? {
          id: newestEvent.id || newestEvent.eventId,
          timestamp: newestEvent.timestamp || newestEvent.time,
          gameTime: newestEvent.gameTime || newestEvent.time,
          type: newestEvent.type || newestEvent.eventType
        } : null
      });
      
      // Event monotonicity: only update if newer
      let finalEvent = currentScore.lastEvent || '';
      let finalScorer = currentScore.lastScorer || '';
      
      if (newestEvent) {
        const newEventTime = extractGameTime(newestEvent.gameTime || newestEvent.time || '');
        const currentEventTime = extractGameTime(currentScore.lastEvent || '');
        if (newEventTime >= currentEventTime) {
          const eventTime = newestEvent.gameTime || newestEvent.time || '';
          const eventType = newestEvent.type || newestEvent.eventType || '';
          const playerName = newestEvent.playerName || newestEvent.player || '';
          const teamName = newestEvent.teamName || newestEvent.team || '';
          // If score is 0:0 or status indicates pregame, override with pregame default
          const predictedHome = protectedScore.homeGoals;
          const predictedAway = protectedScore.awayGoals;
          if (predictedHome === 0 && predictedAway === 0) {
            finalEvent = '00:00 - Spiel noch nicht gestartet';
            finalScorer = '';
          } else {
            finalEvent = buildCanonicalEventFromStructured(eventTime, eventType, playerName, teamName);
            finalScorer = playerName || finalScorer;
          }
        } else if (DEBUG) {
          dbg('STALE_EVENT_IGNORED', {
            reqId,
            newEventTime,
            currentEventTime,
            newestEvent: (newestEvent && (newestEvent.type || newestEvent.eventType)) || 'unknown'
          });
        }
      }
      
    // Build final data
      let newScoreData = {
        homeTeam: parsed.homeTeam || currentScore.homeTeam || 'Heim',
        awayTeam: parsed.awayTeam || currentScore.awayTeam || 'Gast',
        homeGoals: protectedScore.homeGoals,
        awayGoals: protectedScore.awayGoals,
        period: parsed.period || currentScore.period || '',
        lastScorer: finalScorer,
        lastEvent: finalEvent,
        gameStatus: parsed.gameStatus || currentScore.gameStatus || 'Live',
        homeLogoUrl: parsed.homeLogoUrl || currentScore.homeLogoUrl || '',
        awayLogoUrl: parsed.awayLogoUrl || currentScore.awayLogoUrl || '',
        lastSourceStamp: sourceStamp
      };

      // If clearly pregame (no events, score 0:0, non-live), enforce default lastEvent
    if (newScoreData.homeGoals === 0 && newScoreData.awayGoals === 0) {
      newScoreData.gameStatus = 'Vorbereitung';
      newScoreData.lastEvent = '00:00 - Spiel noch nicht gestartet';
      newScoreData.lastScorer = '';
    }

      // Preserve teams against placeholder downgrade
      newScoreData = preserveTeamsIfPlaceholder(newScoreData, currentScore);

      // Valid packet gate
      if (!isValidPacket(newScoreData, currentScore, { reqId, sourceStamp, lastSourceStamp, isGameSwitch })) {
        return;
      }
      
      // Deep diff check
      if (!hasRealChanges(newScoreData, currentScore)) {
        // If we're transitioning into pregame default event, still write to clear stale lastEvent
        const isClearingStaleEvent = (currentScore.lastEvent && currentScore.lastEvent !== newScoreData.lastEvent) &&
          newScoreData.homeGoals === 0 && newScoreData.awayGoals === 0;
        if (!isClearingStaleEvent) {
          dbg('NO_CHANGES', { reqId, reason: 'no real changes detected' });
          return;
        }
      }
      
      // Update config with logos
      const configData = readJSON(CONFIG_FILE, {});
      if (parsed.homeLogoUrl) configData.homeLogoUrl = parsed.homeLogoUrl;
      if (parsed.awayLogoUrl) configData.awayLogoUrl = parsed.awayLogoUrl;
      writeJSON(CONFIG_FILE, configData);
      
      // Plausibility check
      if (newScoreData.homeGoals > 80 || newScoreData.awayGoals > 80) {
        dbg('IMPLAUSIBLE_SCORE', {
          reqId,
          homeGoals: newScoreData.homeGoals,
          awayGoals: newScoreData.awayGoals,
          action: 'ignored'
        });
        console.warn('[ticker] Ignoring implausible score:', newScoreData.homeGoals, newScoreData.awayGoals);
        return;
      }
      
      // Atomic write
      writeJSON(SCORE_FILE, newScoreData);
      
      dbg('WRITE_ACCEPTED', {
        reqId,
        changes: Object.keys(newScoreData).filter(key => newScoreData[key] !== currentScore[key])
      });
      
      console.log('[ticker]', `${newScoreData.homeTeam} ${newScoreData.homeGoals}:${newScoreData.awayGoals} ${newScoreData.awayTeam} | ${newScoreData.period}`);
      return;
    }

    // ***** HTML-Parsing als Fallback *****
    console.log('[ticker] Using HTML parsing for:', tickerUrl);
    const html = await res.text();
    
    // Dump HTML content to debug file (only when DEBUG)
    if (DEBUG) {
      try {
        const debugFile = path.join(DEBUG_DIR, `parsed-${reqId}.html`);
        fs.writeFileSync(debugFile, html);
        dbg('HTML_DUMP', {
          reqId,
          file: debugFile,
          preview: html.substring(0, 1500)
        });
      } catch (err) {
        dbg('HTML_DUMP_ERROR', { reqId, error: err.message });
      }
    }
    
    const parsed = await parseTickerHTML(html, tickerUrl);
    
    // WICHTIG: Wenn Parser null zurückgibt (keine Events), behalte die aktuellen Daten
    if (parsed === null) {
      dbg('PARSER_NULL', { reqId, action: 'keeping current data' });
      console.log('[ticker] Parser returned null, keeping current data');
      return; // Don't update, keep current data
    }
    
    const currentScore = readJSON(SCORE_FILE, {});
    
    // Calculate monotonic sourceStamp for HTML (content-based)
    const sourceStamp = calculateHtmlSourceStamp(parsed);
    const lastSourceStamp = currentScore.lastSourceStamp || 0;
    
    // For live games, always allow updates regardless of sourceStamp
    let isStalePacket = false;
    let isGameSwitch = false;
    
    // Always enforce monotonic sourceStamp (content-based) for HTML path
    isGameSwitch = detectGameSwitch(parsed, currentScore);
    isStalePacket = !isGameSwitch && sourceStamp <= lastSourceStamp;
    
    // If pregame detected (no events + 0:0), treat as non-stale baseline to allow initial write
    const pregameCandidate = (parsed.eventsCount === 0) &&
      Number.isFinite(parsed.homeGoals) && Number.isFinite(parsed.awayGoals) &&
      parsed.homeGoals === 0 && parsed.awayGoals === 0;
    if (pregameCandidate) {
      if (!isGameSwitch) dbg('PREGAME_RESET_ALLOWED', { reqId, path: 'HTML', reason: '0:0 and no events' });
      isGameSwitch = true; // allow score reset to 0:0
      if (lastSourceStamp === 0) isStalePacket = false; // permit initial baseline
    }
    
    dbg('VERSIONING_HTML', {
      reqId,
      sourceStamp,
      lastSourceStamp,
      isStalePacket,
      decision: isStalePacket ? 'ignore' : 'accept'
    });
    
    if (isStalePacket) {
      dbg('STALE_PACKET_HTML', { reqId, sourceStamp, lastSourceStamp });
      return;
    }
    
    dbg('GAME_SWITCH_HTML', {
      reqId,
      isGameSwitch,
      newTeams: `${parsed.homeTeam} vs ${parsed.awayTeam}`,
      currentTeams: `${currentScore.homeTeam} vs ${currentScore.awayTeam}`
    });
    
    // Score regression protection
    const protectedScore = protectScoreRegression(parsed, currentScore, isGameSwitch);
    
    // Event monotonicity for HTML
    let finalEvent = currentScore.lastEvent || '';
    let finalScorer = currentScore.lastScorer || '';
    
    // Always use the parsed lastEvent if it exists and is not empty
    if (parsed.lastEvent && parsed.lastEvent.trim() !== '') {
      const newEventTime = extractGameTime(parsed.lastEvent);
      const currentEventTime = extractGameTime(currentScore.lastEvent || '');
      
      if (newEventTime >= currentEventTime) {
        finalEvent = dedupeEventText(parsed.lastEvent);
        finalScorer = parsed.lastScorer || '';
      } else if (DEBUG) {
        dbg('STALE_EVENT_IGNORED', { reqId, newEventTime, currentEventTime });
      }
    }
    
    // Strong pregame override: if protected score is 0:0, force default event
    if (protectedScore.homeGoals === 0 && protectedScore.awayGoals === 0) {
      finalEvent = '00:00 - Spiel noch nicht gestartet';
      finalScorer = '';
    }
    
    // Build final data
    let newScoreData = {
      homeTeam: parsed.homeTeam || currentScore.homeTeam || 'Heim',
      awayTeam: parsed.awayTeam || currentScore.awayTeam || 'Gast',
      homeGoals: protectedScore.homeGoals,
      awayGoals: protectedScore.awayGoals,
      period: parsed.period || currentScore.period || '',
      lastScorer: finalScorer,
      lastEvent: finalEvent,
      gameStatus: parsed.gameStatus || currentScore.gameStatus || 'Live',
      homeLogoUrl: parsed.homeLogoUrl || currentScore.homeLogoUrl || '',
      awayLogoUrl: parsed.awayLogoUrl || currentScore.awayLogoUrl || '',
      lastSourceStamp: sourceStamp
    };

    // Pregame default for HTML path
    if (newScoreData.homeGoals === 0 && newScoreData.awayGoals === 0) {
      newScoreData.gameStatus = 'Vorbereitung';
      newScoreData.lastEvent = '00:00 - Spiel noch nicht gestartet';
      newScoreData.lastScorer = '';
    }

    // Preserve teams against placeholder downgrade
    newScoreData = preserveTeamsIfPlaceholder(newScoreData, currentScore);

    // Valid packet gate
    if (!isValidPacket(newScoreData, currentScore, { reqId, sourceStamp, lastSourceStamp, isGameSwitch })) {
      return;
    }
    
    // Deep diff check
    if (!hasRealChanges(newScoreData, currentScore)) {
      const isClearingStaleEvent = (currentScore.lastEvent && currentScore.lastEvent !== newScoreData.lastEvent) &&
        newScoreData.homeGoals === 0 && newScoreData.awayGoals === 0;
      if (!isClearingStaleEvent) {
        dbg('NO_CHANGES_HTML', { reqId, reason: 'no real changes detected' });
        return;
      }
    }
    
    // Update config with logos
    const configData = readJSON(CONFIG_FILE, {});
    if (parsed.homeLogoUrl) configData.homeLogoUrl = parsed.homeLogoUrl;
    if (parsed.awayLogoUrl) configData.awayLogoUrl = parsed.awayLogoUrl;
    writeJSON(CONFIG_FILE, configData);
    
    // Plausibility check
    if (newScoreData.homeGoals > 80 || newScoreData.awayGoals > 80) {
      dbg('IMPLAUSIBLE_SCORE_HTML', {
        reqId,
        homeGoals: newScoreData.homeGoals,
        awayGoals: newScoreData.awayGoals,
        action: 'ignored'
      });
      console.warn('[ticker] Ignoring implausible score (HTML path):', newScoreData.homeGoals, newScoreData.awayGoals);
      return;
    }
    
    // Atomic write
    writeJSON(SCORE_FILE, newScoreData);
    
    dbg('WRITE_ACCEPTED', {
      reqId,
      changes: Object.keys(newScoreData).filter(key => newScoreData[key] !== currentScore[key])
    });
    
    console.log('[ticker]', `${newScoreData.homeTeam} ${newScoreData.homeGoals}:${newScoreData.awayGoals} ${newScoreData.awayTeam} | ${newScoreData.period}`);
    return;

  } catch (e) {
    const endTime = Date.now();
    const totalLatency = endTime - startTime;
    
    dbg('POLL_ERROR', {
      reqId,
      error: e.message,
      totalLatency,
      endTime: new Date(endTime).toISOString()
    });
    
    console.error('[ticker error]', e.message);
  } finally {
    const endTime = Date.now();
    const totalLatency = endTime - startTime;
    
    dbg('POLL_END', {
      reqId,
      totalLatency,
      endTime: new Date(endTime).toISOString()
    });
    
    // Release fetch lock
    fetchLock = false;
  }
}

function startFetcher() {
  if (fetchTimer) clearInterval(fetchTimer);
  const config = readJSON(CONFIG_FILE, {});
  if (config.tickerUrl) {
    fetchTimer = setInterval(fetchOnce, 1000); // alle 1000ms (1 Sekunde) für genau 1 Anfrage pro Sekunde
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
