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
  clock: '00:00', period: '1. Halbzeit', lastScorer: '',
  lastEvent: '', gameStatus: 'Live'
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

  return { homeTeam, awayTeam, homeGoals, awayGoals, period, lastScorer, lastEvent, gameStatus, homeLogoUrl, awayLogoUrl };
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
  
  // Bei Live-Spielen: Suche nach dem neuesten Tor-Event (nicht Unterbrechung)
  const allEvents = $('.tik3-flex-event');
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
  console.log('[debug] Events found:', allEvents.length);
  if (allEvents.length > 0) {
    const newestEvent = allEvents.first();
    const timeEl = newestEvent.find('.tik3-even-item-meta-state-text');
    const iconEl = newestEvent.find('.tik3-event-item-icon img');
    
    if (timeEl.length && iconEl.length) {
      const timeText = timeEl.text().trim();
      const iconAlt = iconEl.attr('alt');
      console.log(`[debug] Neuestes Event: ${timeText} - ${iconAlt}`);
    }
  }
  
  // WICHTIG: Wenn keine Events gefunden wurden, extrahiere trotzdem die Hauptdaten
  if (allEvents.length === 0) {
    console.warn('[debug] No events found, but extracting main game data');
    // Extrahiere trotzdem die Hauptdaten (Teams, Spielstand, etc.)
    // aber setze clock auf '00:00' da keine Events vorhanden sind
    clock = '00:00';
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
  
  // Suche nach Spielstatus - neue handball.net Struktur
  const statusEl = $('.rounded-b.px-1').first();
  if (statusEl.length) {
    const statusText = statusEl.text().trim();
    if (statusText.includes('beendet')) {
      period = 'Spiel beendet';
    } else if (statusText.includes('Jetzt Live!')) {
      period = 'Jetzt Live!';
    } else if (statusText.includes('Halbzeit')) {
      period = statusText;
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
    const liveStatusEl = $('.bg-primary.text-white.font-semibold').first();
    if (liveStatusEl.length) {
      const liveText = liveStatusEl.text().trim();
      if (liveText.includes('Jetzt Live!')) {
        period = 'Jetzt Live!';
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
  console.log('[debug] Verwende bereits erkannte Events...');
  
  // Verwende die bereits erkannten Events aus der parseTickerHTML Funktion
  if (allEvents.length > 0) {
    // Verwende das neueste Event (erstes in der Liste)
    const firstEvent = allEvents.first();
    const timeEl = firstEvent.find('.tik3-even-item-meta-state-text');
    const iconEl = firstEvent.find('.tik3-event-item-icon img');
    
    // Debug: Logge das Event für bessere Diagnose
    console.log('[debug] Verarbeite Event:', {
      timeText: timeEl.text().trim(),
      iconAlt: iconEl.attr('alt'),
      eventHtml: firstEvent.html().substring(0, 100)
    });
    
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
      
      console.log('[debug] Event-Details:', {
        timeText: timeText,
        iconAlt: iconAlt,
        eventText: eventText,
        eventTextEl: eventTextEl.length,
        firstEventHtml: firstEvent.html().substring(0, 200)
      });
      
      // Erstelle detailliertes Event-Format basierend auf Event-Typ
      let detailedEvent = '';
      
      if (iconAlt === 'Tor') {
        // Tor: "Zeit - Tor durch [Spieler] für [Team]"
        if (eventText && eventText.length > 0) {
          // Extrahiere Spielername und Team aus dem Event-Text
          let playerName = '';
          let teamInfo = '';
          
          // Parse "Tor durch 9. (TV Wickede-Ruhr 2)" Format
          const torMatch = eventText.match(/Tor durch ([^(]+)\s*\(([^)]+)\)/);
          if (torMatch) {
            playerName = torMatch[1].trim();
            const teamName = torMatch[2].trim();
            
            // Bestimme Team basierend auf Team-Namen
            if (teamName.toLowerCase().includes(homeTeam.toLowerCase())) {
              teamInfo = '(Heim)';
            } else if (teamName.toLowerCase().includes(awayTeam.toLowerCase())) {
              teamInfo = '(Gast)';
            } else {
              teamInfo = `(${teamName})`;
            }
            
            detailedEvent = `${timeText} - Tor durch ${playerName} ${teamInfo}`;
            lastScorer = playerName;
          } else {
            // Fallback: Verwende den gesamten Event-Text
            detailedEvent = `${timeText} - ${eventText}`;
            lastScorer = eventText;
          }
        } else {
          detailedEvent = `${timeText} - Tor`;
        }
      } else if (iconAlt === 'Timeout') {
        // Timeout: "Zeit - Timeout für [Team]"
        let teamInfo = '';
        if (eventText.toLowerCase().includes(homeTeam.toLowerCase())) {
          teamInfo = '(Heim)';
        } else if (eventText.toLowerCase().includes(awayTeam.toLowerCase())) {
          teamInfo = '(Gast)';
        }
        detailedEvent = `${timeText} - Timeout für ${eventText} ${teamInfo}`;
      } else if (iconAlt === 'Zeitstrafe' || iconAlt === '2 Minuten') {
        // Zeitstrafe: "Zeit - 2 Minuten für [Spieler] ([Team])"
        let teamInfo = '';
        if (eventText.toLowerCase().includes(homeTeam.toLowerCase())) {
          teamInfo = '(Heim)';
        } else if (eventText.toLowerCase().includes(awayTeam.toLowerCase())) {
          teamInfo = '(Gast)';
        }
        detailedEvent = `${timeText} - 2 Minuten für ${eventText} ${teamInfo}`;
      } else if (iconAlt === 'Gelbe Karte' || iconAlt === 'Gelb') {
        // Gelbe Karte: "Zeit - Gelbe Karte für [Spieler] ([Team])"
        let teamInfo = '';
        if (eventText.toLowerCase().includes(homeTeam.toLowerCase())) {
          teamInfo = '(Heim)';
        } else if (eventText.toLowerCase().includes(awayTeam.toLowerCase())) {
          teamInfo = '(Gast)';
        }
        detailedEvent = `${timeText} - Gelbe Karte für ${eventText} ${teamInfo}`;
               } else if (iconAlt === 'Rote Karte' || iconAlt === 'Rot') {
                 // Rote Karte: "Zeit - Rote Karte für [Spieler] ([Team])"
                 let teamInfo = '';
                 if (eventText.toLowerCase().includes(homeTeam.toLowerCase())) {
                   teamInfo = '(Heim)';
                 } else if (eventText.toLowerCase().includes(awayTeam.toLowerCase())) {
                   teamInfo = '(Gast)';
                 }
                 detailedEvent = `${timeText} - Rote Karte für ${eventText} ${teamInfo}`;
               } else if (iconAlt === 'Ende' || iconAlt === 'Spielabschluss') {
                 // Spielende: "Zeit - Spiel beendet"
                 detailedEvent = `${timeText} - Spiel beendet`;
               } else {
                 // Andere Events: "Zeit - [Event]"
                 detailedEvent = `${timeText} - ${iconAlt}`;
                 if (eventText) {
                   detailedEvent += ` (${eventText})`;
                 }
               }
      
               // Stabilisierung: Nur aktualisieren wenn sich das Event wirklich geändert hat
               const currentData = readJSON(SCORE_FILE, {});
               const currentLastEvent = currentData.lastEvent || '';

               // Temporär: Immer aktualisieren für Debugging
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

  console.log(`[debug] HTML Parsed: ${homeTeam} vs ${awayTeam}, Score: ${homeGoals}:${awayGoals}, Period: ${period}`);

  return { homeTeam, awayTeam, homeGoals, awayGoals, period, lastScorer, lastEvent, gameStatus, homeLogoUrl, awayLogoUrl };
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
    // Cache-Busting: Add timestamp to prevent caching
    const cacheBuster = `?_=${Date.now()}`;
    const urlWithCacheBuster = tickerUrl.includes('?') ? `${tickerUrl}&_=${Date.now()}` : `${tickerUrl}${cacheBuster}`;
    
    const res = await fetch(urlWithCacheBuster, { 
      headers,
      cache: 'no-store' // Disable caching
    });
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
        lastScorer: parsed.lastScorer || cur.lastScorer || '',
        // Stabile lastEvent: Nur aktualisieren wenn sich wirklich etwas geändert hat
        lastEvent: (parsed.lastEvent && parsed.lastEvent !== cur.lastEvent) ? parsed.lastEvent : (cur.lastEvent || ''),
        // Stabile gameStatus: Nur aktualisieren wenn sich der Status geändert hat
        gameStatus: (parsed.gameStatus && parsed.gameStatus !== cur.gameStatus) ? parsed.gameStatus : (cur.gameStatus || 'Live')
      };
      writeJSON(SCORE_FILE, next);
      console.log(`[ticker] ${next.homeTeam} ${next.homeGoals}:${next.awayGoals} ${next.awayTeam} | ${next.period}`);
      return;
    }

    // ***** HTML-Parsing als Fallback *****
    console.log('[ticker] Using HTML parsing for:', tickerUrl);
    const html = await res.text();
    const parsed = await parseTickerHTML(html, tickerUrl);
    const cur = readJSON(SCORE_FILE, {});
    
    // WICHTIG: Wenn Parser null zurückgibt (keine Events), behalte die aktuellen Daten
    if (parsed === null) {
      console.log('[ticker] Parser returned null, keeping current data');
      return; // Don't update, keep current data
    }
    
    // WICHTIG: Bei neuen Spielen ohne Events, aktualisiere trotzdem die Hauptdaten
    if (parsed.homeGoals === 0 && parsed.awayGoals === 0 && parsed.clock === '00:00') {
      console.log('[ticker] New game detected (no events yet), updating main data');
      // Aktualisiere trotzdem die Hauptdaten (Teams, etc.)
    }
    
    // WICHTIG: Verhindere Flickering bei instabilen Daten
    // Wenn die neuen Daten deutlich von den aktuellen abweichen, prüfe die Plausibilität
    const currentData = readJSON(SCORE_FILE, {});
    if (currentData.homeGoals > 0 || currentData.awayGoals > 0) {
      // Wenn bereits Tore vorhanden sind, aber neue Daten 0:0 zeigen, 
      // könnte das ein Fehler sein - behalte die aktuellen Daten
      if (parsed.homeGoals === 0 && parsed.awayGoals === 0 && parsed.clock === '00:00') {
        console.log('[ticker] Suspicious data (0:0 when goals exist), keeping current data');
        return; // Don't update, keep current data
      }
      
      // WICHTIG: Verhindere auch Sprünge zwischen verschiedenen Spielständen
      // ABER: Nur wenn es wirklich ein neues Spiel ist (z.B. andere Teams)
      const currentTotal = currentData.homeGoals + currentData.awayGoals;
      const newTotal = parsed.homeGoals + parsed.awayGoals;
      
      // Nur verdächtig wenn es das gleiche Spiel ist UND der Stand deutlich niedriger ist
      const isSameGame = (parsed.homeTeam === currentData.homeTeam && parsed.awayTeam === currentData.awayTeam);
      
      // AUSKOMMENTIERT: Diese Logik verhindert korrekte Updates
      // if (isSameGame && newTotal < currentTotal && newTotal > 0) {
      //   console.log(`[ticker] Suspicious data (${parsed.homeGoals}:${parsed.awayGoals} when ${currentData.homeGoals}:${currentData.awayGoals} exists), keeping current data`);
      //   return; // Don't update, keep current data
      // }
      
      // Wenn es ein anderes Spiel ist, aktualisiere trotzdem
      if (!isSameGame) {
        console.log('[ticker] Different game detected, updating data');
      }
    }
    
    // Logos automatisch übernehmen
    if (parsed.homeLogoUrl) CONFIG.homeLogoUrl = parsed.homeLogoUrl;
    if (parsed.awayLogoUrl) CONFIG.awayLogoUrl = parsed.awayLogoUrl;
    writeJSON(CONFIG_FILE, CONFIG);
    
    const next = {
      homeTeam: parsed.homeTeam || cur.homeTeam || 'Heim',
      awayTeam: parsed.awayTeam || cur.awayTeam || 'Gast',
      homeGoals: Number.isFinite(parsed.homeGoals) ? parsed.homeGoals : (cur.homeGoals|0),
      awayGoals: Number.isFinite(parsed.awayGoals) ? parsed.awayGoals : (cur.awayGoals|0),
      // clock entfernt - Zeit ist bereits in lastEvent enthalten
      period: parsed.period || cur.period || '',
      lastScorer: parsed.lastScorer || cur.lastScorer || '',
      // lastEvent: Immer aktualisieren wenn verfügbar
      lastEvent: parsed.lastEvent || cur.lastEvent || '',
      // gameStatus: Immer aktualisieren wenn verfügbar
      gameStatus: parsed.gameStatus || cur.gameStatus || 'Live'
    };
    
    console.log('[debug] Writing to score.json:', {
      lastEvent: next.lastEvent,
      lastScorer: next.lastScorer,
      gameStatus: next.gameStatus
    });

    // Bremse
    if (next.homeGoals > 80 || next.awayGoals > 80) {
      console.warn('[ticker] Ignoring implausible score (HTML path):', next.homeGoals, next.awayGoals);
      return;
    }

    writeJSON(SCORE_FILE, next);
    // Clock entfernt - Zeit wird aus lastEvent extrahiert
    console.log(`[ticker] ${next.homeTeam} ${next.homeGoals}:${next.awayGoals} ${next.awayTeam} | ${next.period}`);

  } catch (e) {
    console.error('[ticker error]', e.message);
  }
}

function startFetcher() {
  if (fetchTimer) clearInterval(fetchTimer);
  if (CONFIG.tickerUrl) {
    fetchTimer = setInterval(fetchOnce, 500); // alle 500ms für schnellere Updates
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
