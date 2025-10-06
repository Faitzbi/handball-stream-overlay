const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

const DIR = __dirname;
const PUBLIC_DIR = path.join(DIR, 'public');
const ASSETS_DIR = path.join(DIR, 'assets');
const LOGO_DIR = path.join(ASSETS_DIR, 'logos');
const TEAM_DIR = path.join(ASSETS_DIR, 'teams');
const DATA_DIR = path.join(DIR, 'data');
const SCORE_FILE = path.join(DATA_DIR, 'score.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(PUBLIC_DIR));
app.use('/assets', express.static(ASSETS_DIR));

for (const d of [PUBLIC_DIR, ASSETS_DIR, LOGO_DIR, TEAM_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
if (!fs.existsSync(SCORE_FILE)) fs.writeFileSync(SCORE_FILE, JSON.stringify({
  homeTeam: 'Heim', awayTeam: 'Gast',
  homeGoals: 0, awayGoals: 0,
  clock: '00:00', period: '1. Halbzeit', lastScorer: ''
}, null, 2));
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify({
  tickerUrl: '', homeLogoUrl: '', awayLogoUrl: ''
}, null, 2));

const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; } };
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');

let CONFIG = readJSON(CONFIG_FILE, { tickerUrl: '', homeLogoUrl: '', awayLogoUrl: '', mascotUrl: '' });
let logos = [];

function readSponsorLogos() {
  const files = fs.readdirSync(LOGO_DIR)
    .filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f))
    .map(f => `/assets/logos/${encodeURIComponent(f)}`);
  logos = files;
  console.log(`[logos] ${logos.length} Sponsorlogos`);
}
readSponsorLogos();
chokidar.watch(LOGO_DIR, { ignoreInitial: true })
  .on('add', readSponsorLogos)
  .on('unlink', readSponsorLogos)
  .on('change', readSponsorLogos);

app.get('/api/logos', (req, res) => res.json({ logos }));

app.get('/api/score', (req, res) => res.json(readJSON(SCORE_FILE, {})));
app.post('/api/score', (req, res) => {
  const s = readJSON(SCORE_FILE, {});
  const next = { ...s, ...req.body };
  writeJSON(SCORE_FILE, next);
  res.json({ ok: true, score: next });
});

app.get('/api/config', (req, res) => {
  // Entferne referer aus der Antwort, da er nicht mehr benötigt wird
  const { referer, ...configWithoutReferer } = CONFIG;
  res.json(configWithoutReferer);
});
app.post('/api/config', (req, res) => {
  // Entferne referer aus der Konfiguration, da er nicht mehr benötigt wird
  const { referer, ...configWithoutReferer } = req.body;
  CONFIG = { ...CONFIG, ...configWithoutReferer };
  writeJSON(CONFIG_FILE, CONFIG);
  startFetcher();
  res.json({ ok: true, config: CONFIG });
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
  const events = Array.isArray(data.events) ? data.events : [];

  const homeTeam = (sum.homeTeam && sum.homeTeam.name) ? sum.homeTeam.name : (currentScore.homeTeam || 'Heim');
  const awayTeam = (sum.awayTeam && sum.awayTeam.name) ? sum.awayTeam.name : (currentScore.awayTeam || 'Gast');
  const homeGoals = (typeof sum.homeGoals === 'number') ? sum.homeGoals : (currentScore.homeGoals|0);
  const awayGoals = (typeof sum.awayGoals === 'number') ? sum.awayGoals : (currentScore.awayGoals|0);

  // Uhr/Phase aus Events extrahieren (neuestes Event hat die aktuelle Zeit)
  let clock = currentScore.clock || '00:00';
  let period = currentScore.period || '';
  
  if (events.length > 0) {
    // Neuestes Event hat die aktuelle Spielzeit
    const latestEvent = events[0];
    if (latestEvent && latestEvent.time) {
      clock = latestEvent.time;
    }
    
    // Halbzeit aus Spielstand ableiten (vereinfacht)
    const totalGoals = homeGoals + awayGoals;
    if (totalGoals <= 15) {
      period = '1. Halbzeit';
    } else {
      period = '2. Halbzeit';
    }
  }

  // Debug-Logging
  console.log(`[debug] Parsed: ${homeTeam} vs ${awayTeam}, Score: ${homeGoals}:${awayGoals}, Clock: ${clock}, Period: ${period}`);

  // letzter Torschütze: nimm das neueste Goal-Event
  let lastScorer = '';
  if (events.length) {
    // Annahme: events[0] ist das Neueste (wie in deinem Beispiel)
    const last = events[0];
    if (last && (last.type === 'Goal' || last.type === 'SevenMeterGoal')) {
      lastScorer = playerFromMessage(last.message);
    }
  }

  // Team-Logos
  const homeLogoUrl = normalizeLogoUrl(sum?.homeTeam?.logo || '');
  const awayLogoUrl = normalizeLogoUrl(sum?.awayTeam?.logo || '');

  console.log(`[debug] Logos: Home=${homeLogoUrl}, Away=${awayLogoUrl}`);

  return { homeTeam, awayTeam, homeGoals, awayGoals, clock, period, lastScorer, homeLogoUrl, awayLogoUrl };
}

// HTML-Parser für handball.net Ticker-Seite
async function parseTickerHTML(html, baseUrl) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  
  console.log('[debug] Parsing HTML ticker page...');

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
      '.match-header', '.game-header', '.score-header'
    ];
    
    for (const selector of teamSelectors) {
      const elements = $(selector);
      if (elements.length >= 2) {
        const texts = elements.map((_, el) => $(el).text().trim()).get().filter(t => t.length > 0);
        if (texts.length >= 2) {
          homeTeam = texts[0].slice(0, 30);
          awayTeam = texts[1].slice(0, 30);
          break;
        }
      }
    }
  }

  // Spielstand extrahieren
  let homeGoals = 0, awayGoals = 0;
  
  // Spezifische Suche nach dem Hauptspielstand
  const scoreEl = $('.text-3xl.font-bold').first();
  if (scoreEl.length) {
    const scoreText = scoreEl.text().trim();
    const match = scoreText.match(/(\d{1,2})\s*:\s*(\d{1,2})/);
    if (match) {
      homeGoals = parseInt(match[1], 10);
      awayGoals = parseInt(match[2], 10);
    }
  }
  
  // Fallback: Suche im gesamten Text
  if (homeGoals === 0 && awayGoals === 0) {
    const allText = $('body').text();
    const scorePatterns = [
      /(\d{1,2})\s*:\s*(\d{1,2})/,
      /(\d{1,2})\s*-\s*(\d{1,2})/,
      /(\d{1,2})\s*\/\s*(\d{1,2})/
    ];
    
    for (const pattern of scorePatterns) {
      const match = allText.match(pattern);
      if (match) {
        homeGoals = parseInt(match[1], 10);
        awayGoals = parseInt(match[2], 10);
        break;
      }
    }
  }

  // Spielzeit extrahieren
  let clock = '00:00';
  
  // Suche nach Spielzeit in den Events (neuestes Event)
  const timeEl = $('.tik3-even-item-meta-state-text').first();
  if (timeEl.length) {
    const timeText = timeEl.text().trim();
    if (timeText && timeText !== '00:00') {
      clock = timeText;
    }
  }
  
  // Fallback: Suche im gesamten Text
  if (clock === '00:00') {
    const allText = $('body').text();
    const timePatterns = [
      /\b([0-5]?\d:[0-5]\d)\b/,
      /\b(\d{1,2}:\d{2})\b/,
      /(\d{1,2}:\d{2})/
    ];
    
    for (const pattern of timePatterns) {
      const match = allText.match(pattern);
      if (match) {
        clock = match[1];
        break;
      }
    }
  }

  // Halbzeit extrahieren
  let period = '';
  
  // Suche nach Spielstatus
  const statusEl = $('.rounded-b.px-1').first();
  if (statusEl.length) {
    const statusText = statusEl.text().trim();
    if (statusText.includes('beendet')) {
      period = 'Spiel beendet';
    } else if (statusText.includes('Halbzeit')) {
      period = statusText;
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

  // Letzter Torschütze
  let lastScorer = '';
  const lines = $('*').map((_, el) => $(el).text().trim()).get();
  for (const line of lines) {
    if (/Tor\b/i.test(line)) {
      const match = line.match(/Tor.*?([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)+)/);
      if (match && match[1]) {
        lastScorer = match[1];
        break;
      }
    }
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

  console.log(`[debug] HTML Parsed: ${homeTeam} vs ${awayTeam}, Score: ${homeGoals}:${awayGoals}, Clock: ${clock}, Period: ${period}`);

  return { homeTeam, awayTeam, homeGoals, awayGoals, clock, period, lastScorer, homeLogoUrl, awayLogoUrl };
}

// Eine Sekunde Polling – erkennt JSON automatisch
async function fetchOnce() {
  const { tickerUrl } = CONFIG;
  if (!tickerUrl) return;

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

  try {
    const res = await fetch(tickerUrl, { headers });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isApiLike = /\/api\//.test(tickerUrl) || /combined/.test(tickerUrl);

    // ***** JSON-API versuchen (falls verfügbar) *****
    if (isApiLike && ct.includes('application/json')) {
      const json = await res.json();
      const cur = readJSON(SCORE_FILE, {});
      const parsed = parseCombinedJSON(json, cur);

      // Logos automatisch übernehmen
      if (parsed.homeLogoUrl) CONFIG.homeLogoUrl = parsed.homeLogoUrl;
      if (parsed.awayLogoUrl) CONFIG.awayLogoUrl = parsed.awayLogoUrl;
      writeJSON(CONFIG_FILE, CONFIG);

      // Plausibilitätsbremse gegen „38:0"-Quatsch
      if (parsed.homeGoals > 80 || parsed.awayGoals > 80) {
        console.warn('[ticker] Ignoring implausible score:', parsed.homeGoals, parsed.awayGoals);
        return;
      }

      const next = {
        homeTeam: parsed.homeTeam || cur.homeTeam || 'Heim',
        awayTeam: parsed.awayTeam || cur.awayTeam || 'Gast',
        homeGoals: Number.isFinite(parsed.homeGoals) ? parsed.homeGoals : (cur.homeGoals|0),
        awayGoals: Number.isFinite(parsed.awayGoals) ? parsed.awayGoals : (cur.awayGoals|0),
        clock: parsed.clock || cur.clock || '00:00',
        period: parsed.period || cur.period || '',
        lastScorer: parsed.lastScorer || ''
      };
      writeJSON(SCORE_FILE, next);
      console.log(`[ticker] ${next.homeTeam} ${next.homeGoals}:${next.awayGoals} ${next.awayTeam} | ${next.clock} ${next.period}`);
      return;
    }

    // ***** HTML-Parsing als Fallback *****
    console.log('[ticker] Using HTML parsing for:', tickerUrl);
    const html = await res.text();
    const parsed = await parseTickerHTML(html, tickerUrl);
    const cur = readJSON(SCORE_FILE, {});
    
    // Logos automatisch übernehmen
    if (parsed.homeLogoUrl) CONFIG.homeLogoUrl = parsed.homeLogoUrl;
    if (parsed.awayLogoUrl) CONFIG.awayLogoUrl = parsed.awayLogoUrl;
    writeJSON(CONFIG_FILE, CONFIG);
    
    const next = {
      homeTeam: parsed.homeTeam || cur.homeTeam || 'Heim',
      awayTeam: parsed.awayTeam || cur.awayTeam || 'Gast',
      homeGoals: Number.isFinite(parsed.homeGoals) ? parsed.homeGoals : (cur.homeGoals|0),
      awayGoals: Number.isFinite(parsed.awayGoals) ? parsed.awayGoals : (cur.awayGoals|0),
      clock: parsed.clock || cur.clock || '00:00',
      period: parsed.period || cur.period || '',
      lastScorer: parsed.lastScorer || ''
    };

    // Bremse
    if (next.homeGoals > 80 || next.awayGoals > 80) {
      console.warn('[ticker] Ignoring implausible score (HTML path):', next.homeGoals, next.awayGoals);
      return;
    }

    writeJSON(SCORE_FILE, next);
    console.log(`[ticker] ${next.homeTeam} ${next.homeGoals}:${next.awayGoals} ${next.awayTeam} | ${next.clock} ${next.period}`);

  } catch (e) {
    console.error('[ticker error]', e.message);
  }
}

function startFetcher() {
  if (fetchTimer) clearInterval(fetchTimer);
  if (CONFIG.tickerUrl) {
    fetchTimer = setInterval(fetchOnce, 1000); // jede Sekunde
    console.log('[ticker] running:', CONFIG.tickerUrl);
  } else {
    console.log('[ticker] idle (no URL)');
  }
}
startFetcher();

app.listen(PORT, () => {
  console.log(`Overlay-Server: http://localhost:${PORT}/overlay`);
  console.log(`Admin-Panel:    http://localhost:${PORT}/admin`);
});
