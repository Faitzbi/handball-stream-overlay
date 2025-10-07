function $(s){ return document.querySelector(s); }
var lastScorerSeen = "";
var playerDisplayTimeout = null;
var stableEventText = "";

// Debug helper function for client-side
var DEBUG = window.location.search.includes('debug=1') || localStorage.getItem('DEBUG') === '1';
var clientReqIdCounter = 0;

function dbg(section, obj) {
  if (!DEBUG) return;
  var timestamp = new Date().toISOString();
  var compactJson = JSON.stringify(obj, null, 0);
  console.log('[DEBUG-CLIENT-' + section + '] ' + timestamp + ': ' + compactJson);
}

// Client-seitige Debouncing gegen Race Conditions
var lastClientUpdate = 0;
var CLIENT_UPDATE_INTERVAL = 500; // Mindestens 500ms zwischen Client-Updates

// Intelligente Event-Erkennung ohne Verzögerung
var lastKnownEvent = "";
var lastKnownScore = { homeGoals: 0, awayGoals: 0 };

// Client-seitige Event-Stabilitätsprüfung
var clientEventStabilityCount = 0;
var CLIENT_EVENT_STABILITY_THRESHOLD = 1; // Weniger restriktiv

// Client-seitige Event-Format-Normalisierung
function normalizeClientEventFormat(event) {
  if (!event || event.trim() === '') return '';
  
  // Normalisiere Whitespace
  var normalized = event.trim().replace(/\s+/g, ' ');
  
  // Normalisiere Zeitstempel-Format (z.B. "36:36" -> "36:36")
  normalized = normalized.replace(/(\d{1,2}):(\d{2})/g, function(match, minutes, seconds) {
    return minutes + ':' + seconds;
  });
  
  // Normalisiere Tor-Format
  normalized = normalized.replace(/Tor\s+durch\s+/g, 'Tor durch ');
  
  return normalized;
}

// Client-seitige intelligente Event-Erkennung
function checkClientEventStability(newEvent, currentEvent) {
  // Normalisiere Events für Vergleich
  var normalizedNewEvent = normalizeClientEventFormat(newEvent);
  var normalizedCurrentEvent = normalizeClientEventFormat(currentEvent);
  
  // Wenn das Event identisch ist, erhöhe den Stabilitätszähler
  if (normalizedNewEvent === normalizedCurrentEvent && normalizedNewEvent.trim() !== '') {
    clientEventStabilityCount++;
    console.log(`[client-event-stability] Event stable ${clientEventStabilityCount}/${CLIENT_EVENT_STABILITY_THRESHOLD}: ${normalizedNewEvent}`);
    
    // Wenn Event stabil genug ist, akzeptiere es
    if (clientEventStabilityCount >= CLIENT_EVENT_STABILITY_THRESHOLD) {
      return true;
    }
    return false;
  } else {
    // Event hat sich geändert - prüfe ob es ein echtes neues Event ist
    var isRealNewEvent = isClientRealNewEvent(newEvent, currentEvent);
    
    if (isRealNewEvent) {
      // Echtes neues Event - sofort akzeptieren
      clientEventStabilityCount = 0;
      console.log(`[client-event-stability] Real new event detected: ${normalizedCurrentEvent} -> ${normalizedNewEvent}`);
      return true;
    } else {
      // Möglicher Pendulum-Effekt - reset Stabilitätszähler
      clientEventStabilityCount = 0;
      console.log(`[client-event-stability] Possible pendulum, reset counter: ${normalizedCurrentEvent} -> ${normalizedNewEvent}`);
      return false;
    }
  }
}

// Client-seitige Prüfung ob es ein echtes neues Event ist
function isClientRealNewEvent(newEvent, currentEvent) {
  if (!newEvent || !currentEvent) return true;
  
  // Extrahiere Zeitstempel aus beiden Events
  var newTimestamp = extractEventTimestamp(newEvent);
  var currentTimestamp = extractEventTimestamp(currentEvent);
  
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
  var newTimestamp = extractEventTimestamp(newEvent);
  var currentTimestamp = extractEventTimestamp(currentEvent);
  
  console.log('[chronological-check] Client:', {
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
  var isDifferent = newEvent !== currentEvent;
  var isLonger = newEvent.length > currentEvent.length;
  
  console.log('[chronological-fallback] Client:', {
    isDifferent: isDifferent,
    isLonger: isLonger,
    newLength: newEvent.length,
    currentLength: currentEvent.length,
    shouldAccept: isDifferent && isLonger
  });
  
  return isDifferent && isLonger;
}

// Prüfe ob ein Event stabil ist (verhindert Pendulum)
var lastStableEvent = '';
var eventStabilityCount = 0;
var EVENT_STABILITY_THRESHOLD = 3; // Event muss 3x hintereinander gleich sein

function isEventStable(newEvent, currentEvent) {
  if (!newEvent || !currentEvent) return true;
  
  // Wenn Event sich geändert hat, reset counter
  if (newEvent !== lastStableEvent) {
    lastStableEvent = newEvent;
    eventStabilityCount = 1;
    console.log('[event-stability] Client: Event changed, reset counter:', {
      newEvent: newEvent,
      currentEvent: currentEvent,
      stabilityCount: eventStabilityCount
    });
    return false; // Noch nicht stabil
  }
  
  // Event ist gleich, erhöhe counter
  eventStabilityCount++;
  
  console.log('[event-stability] Client: Event stable:', {
    newEvent: newEvent,
    currentEvent: currentEvent,
    stabilityCount: eventStabilityCount,
    threshold: EVENT_STABILITY_THRESHOLD,
    isStable: eventStabilityCount >= EVENT_STABILITY_THRESHOLD
  });
  
  // Nur akzeptieren wenn Event mehrfach stabil war
  return eventStabilityCount >= EVENT_STABILITY_THRESHOLD;
}

/* einfache JSON-Fetch-Funktion */
function j(url){
  return fetch(url, { cache: "no-store" }).then(function(r){ return r.json(); });
}

/* Intelligente Event-Erkennung basierend auf Timestamps */
function extractEventTimestamp(eventText) {
  if (!eventText) return null;
  
  // Extrahiere Zeitstempel aus Event-Text (z.B. "21:22 - Tor durch...")
  var timeMatch = eventText.match(/^(\d{1,2}:\d{2})/);
  if (timeMatch) {
    var timeStr = timeMatch[1];
    var timeParts = timeStr.split(':');
    var minutes = parseInt(timeParts[0]);
    var seconds = parseInt(timeParts[1]);
    // Konvertiere zu Sekunden seit Spielbeginn
    return minutes * 60 + seconds;
  }
  return null;
}

function isNewerEvent(newEvent, currentEvent) {
  var newTimestamp = extractEventTimestamp(newEvent);
  var currentTimestamp = extractEventTimestamp(currentEvent);
  
  if (!newTimestamp || !currentTimestamp) {
    // Fallback: Vergleiche Text-Länge (neuere Events sind oft länger)
    return newEvent.length > currentEvent.length;
  }
  
  return newTimestamp > currentTimestamp;
}

function isNewerScore(newScore, currentScore) {
  var newTotal = newScore.homeGoals + newScore.awayGoals;
  var currentTotal = currentScore.homeGoals + currentScore.awayGoals;
  
  // Nur wenn die Gesamtzahl der Tore gestiegen ist
  return newTotal > currentTotal;
}

// Spielwechsel-Erkennung
function isGameChange(newData, currentData) {
  var newTeams = (newData.homeTeam || '') + ' vs ' + (newData.awayTeam || '');
  var currentTeams = (currentData.homeTeam || '') + ' vs ' + (currentData.awayTeam || '');
  
  // Prüfe ob sich die Team-Namen geändert haben
  var teamChanged = newTeams !== currentTeams && newTeams !== ' vs ' && currentTeams !== ' vs ';
  
  // Prüfe ob sich der Score drastisch geändert hat (möglicher Spielwechsel)
  var newTotal = (newData.homeGoals || 0) + (newData.awayGoals || 0);
  var currentTotal = (currentData.homeGoals || 0) + (currentData.awayGoals || 0);
  var scoreReset = newTotal < currentTotal && newTotal <= 2; // Score wurde zurückgesetzt
  
  console.log('[game-change-detection] Client:', {
    teamChanged: teamChanged,
    scoreReset: scoreReset,
    newTeams: newTeams,
    currentTeams: currentTeams,
    newTotal: newTotal,
    currentTotal: currentTotal
  });
  
  return teamChanged || scoreReset;
}

/* Sponsor-Rotation verwalten */
var sponsorUrls = [];
var currentSponsorIndex = 0;
var sponsorRotationInterval = null;

function initSponsorRotation(urls) {
  sponsorUrls = (urls && urls.length) ? urls : ["/public/placeholder.svg"];
  currentSponsorIndex = 0;
  
  // Ersten Sponsor anzeigen
  showCurrentSponsor();
  
  // Rotation starten (alle 20 Sekunden)
  if (sponsorRotationInterval) {
    clearInterval(sponsorRotationInterval);
  }
  sponsorRotationInterval = setInterval(rotateSponsor, 20000);
}

function showCurrentSponsor() {
  var logoEl = $("#sponsor-logo");
  if (!logoEl || !sponsorUrls.length) return;
  
  var currentUrl = sponsorUrls[currentSponsorIndex];
  
  // Logo ausblenden
  logoEl.classList.remove("show");
  logoEl.classList.add("hide");
  
  // Nach Animation neues Logo laden
  setTimeout(function() {
    logoEl.src = currentUrl;
    logoEl.alt = "Sponsor Logo";
    
    // Logo einblenden
    logoEl.classList.remove("hide");
    logoEl.classList.add("show");
  }, 400);
}

function rotateSponsor() {
  if (sponsorUrls.length <= 1) return;
  
  currentSponsorIndex = (currentSponsorIndex + 1) % sponsorUrls.length;
  showCurrentSponsor();
}

/* Logos laden und Sponsor-Rotation starten */
function refreshLogos(){
  return j("/api/logos")
    .then(function(res){
      var urls = (res && res.logos && res.logos.length) ? res.logos : ["/public/placeholder.svg"];
      initSponsorRotation(urls);
    })
    .catch(function(err){
      console.error("Logo fetch error:", err);
    });
}

/* Text/Logo-Helfer */
function setIf(el, v, f){
  if (!el) return;
  if (v === null || v === undefined || v === "") el.textContent = f || "";
  else el.textContent = v;
}
function setLogo(el, url){
  if (!el) return;
  if (url && url.length){
    el.src = url;
    el.style.display = "inline-block";
  } else {
    el.style.display = "none";
  }
}

/* Score aktualisieren mit intelligenter Event-Erkennung */
function refreshScore(){
  // Generate unique request ID for this client poll
  var reqId = ++clientReqIdCounter;
  var startTime = Date.now();
  
  dbg('CLIENT_POLL_START', {
    reqId: reqId,
    startTime: new Date(startTime).toISOString()
  });
  
  // Client-seitige Debouncing gegen Race Conditions
  var now = Date.now();
  if (now - lastClientUpdate < CLIENT_UPDATE_INTERVAL) {
    dbg('CLIENT_DEBOUNCE_SKIP', {
      reqId: reqId,
      reason: 'too soon',
      timeSinceLastUpdate: now - lastClientUpdate,
      interval: CLIENT_UPDATE_INTERVAL
    });
    console.log('[client] Skipping update - too soon');
    return Promise.resolve();
  }
  lastClientUpdate = now;
  
  var fetchStartTime = Date.now();
  return j("/api/score")
    .then(function(s){
      var fetchEndTime = Date.now();
      var fetchLatency = fetchEndTime - fetchStartTime;
      
      dbg('CLIENT_REQUEST_DETAILS', {
        reqId: reqId,
        fetchLatency: fetchLatency,
        startTime: new Date(fetchStartTime).toISOString(),
        endTime: new Date(fetchEndTime).toISOString(),
        serverData: s
      });
      
      // Aktuelle DOM-Werte lesen
      var currentHomeTeam = $("#homeTeam").textContent || "";
      var currentAwayTeam = $("#awayTeam").textContent || "";
      var currentHomeGoals = parseInt($("#homeGoals").textContent) || 0;
      var currentAwayGoals = parseInt($("#awayGoals").textContent) || 0;
      var currentEvent = $("#lastEvent").textContent || "";
      var currentStatus = $("#gameStatus").textContent || "";
      
      // Neue Daten aus Server
      var newHomeGoals = parseInt(s.homeGoals) || 0;
      var newAwayGoals = parseInt(s.awayGoals) || 0;
      var newEvent = s.lastEvent || "";
      var newStatus = s.gameStatus || "";
      
      // Client-side diff logging
      var changes = {};
      if (s.homeTeam !== currentHomeTeam) changes.homeTeam = { from: currentHomeTeam, to: s.homeTeam };
      if (s.awayTeam !== currentAwayTeam) changes.awayTeam = { from: currentAwayTeam, to: s.awayTeam };
      if (newHomeGoals !== currentHomeGoals) changes.homeGoals = { from: currentHomeGoals, to: newHomeGoals };
      if (newAwayGoals !== currentAwayGoals) changes.awayGoals = { from: currentAwayGoals, to: newAwayGoals };
      if (newEvent !== currentEvent) changes.lastEvent = { from: currentEvent, to: newEvent };
      if (newStatus !== currentStatus) changes.gameStatus = { from: currentStatus, to: newStatus };
      
      dbg('CLIENT_DIFF_CHANGES', {
        reqId: reqId,
        changes: changes,
        hasChanges: Object.keys(changes).length > 0
      });
      
      // Client-side event logging
      var lastEventId = newEvent ? newEvent.substring(0, 50) : '';
      var lastEventTimestamp = extractEventTimestamp(newEvent);
      var currentEventTimestamp = extractEventTimestamp(currentEvent);
      
      dbg('CLIENT_EVENT_LOGS', {
        reqId: reqId,
        lastEventId: lastEventId,
        lastEventTimestamp: lastEventTimestamp,
        currentEventTimestamp: currentEventTimestamp,
        isNewerEvent: lastEventTimestamp && currentEventTimestamp ? lastEventTimestamp > currentEventTimestamp : true,
        eventText: newEvent ? newEvent.substring(0, 100) : ''
      });
      
      // Client-side cooldown/debounce logs
      var cooldownUntil = s.cooldownUntil || 0;
      var htmlStableCount = s.htmlStableCount || 0;
      var eventKey = newEvent ? newEvent.substring(0, 50) : '';
      
      dbg('CLIENT_COOLDOWN_DEBOUNCE', {
        reqId: reqId,
        cooldownUntil: cooldownUntil,
        htmlStableCount: htmlStableCount,
        eventKey: eventKey,
        isInCooldown: Date.now() < cooldownUntil
      });
      
      // INTELLIGENTE EVENT-ERKENNUNG: Sofortige Updates basierend auf Timestamps
      
      // Prüfe ob es ein Spielwechsel ist
      var isGameSwitch = isGameChange(s, {
        homeTeam: currentHomeTeam,
        awayTeam: currentAwayTeam
      });
      
      dbg('CLIENT_GAME_SWITCH', {
        reqId: reqId,
        isGameSwitch: isGameSwitch,
        newTeams: (s.homeTeam || '') + ' vs ' + (s.awayTeam || ''),
        currentTeams: currentHomeTeam + ' vs ' + currentAwayTeam
      });
      
    // Event-Monotonie erzwingen: Nur akzeptieren, wenn neuer Zeitstempel > aktueller
    var newEventTs = extractEventTimestamp(newEvent);
    var currentEventTs = extractEventTimestamp(currentEvent);
    var isEventRegression = (newEventTs !== null && currentEventTs !== null) && newEventTs < currentEventTs;
    var isEventEqualTime = (newEventTs !== null && currentEventTs !== null) && newEventTs === currentEventTs;
    
    if (isEventRegression && !isGameSwitch) {
      dbg('CLIENT_EVENT_REGRESSION_BLOCKED', {
        reqId: reqId,
        newEvent: newEvent,
        currentEvent: currentEvent,
        newEventTimestamp: newEventTs,
        currentEventTimestamp: currentEventTs,
        reason: 'new event older than current'
      });
    }
    
    // Bei gleicher Zeit bevorzugen wir den bereits angezeigten Text (kein Toggle)
    var allowEqualTimeReplace = false; // konservativ: nicht ersetzen bei gleicher Zeit
    
    var shouldUpdateEvent = newEvent && newEvent.trim() !== "" &&
      (isGameSwitch || (
        // Nur wenn neuer Zeitstempel größer ist, oder keine Zeitinformationen vorliegen
        (!isEventRegression && !isEventEqualTime) ||
        (newEventTs === null || currentEventTs === null && newEvent !== currentEvent)
      ));
      
      // Score regression protection on client side
      var newTotal = newHomeGoals + newAwayGoals;
      var currentTotal = currentHomeGoals + currentAwayGoals;
      var isScoreRegression = newTotal < currentTotal && !isGameSwitch;
      
      if (isScoreRegression) {
        dbg('CLIENT_SCORE_REGRESSION_BLOCKED', {
          reqId: reqId,
          newTotal: newTotal,
          currentTotal: currentTotal,
          newScore: { homeGoals: newHomeGoals, awayGoals: newAwayGoals },
          currentScore: { homeGoals: currentHomeGoals, awayGoals: currentAwayGoals },
          reason: 'total score decreased'
        });
        // Keep current scores, don't update
        newHomeGoals = currentHomeGoals;
        newAwayGoals = currentAwayGoals;
      }
      
      // AGGRESSIVE Score Updates: Immer updaten wenn sich der Score geändert hat
      var newScoreData = { homeGoals: newHomeGoals, awayGoals: newAwayGoals };
      var currentScoreData = { homeGoals: currentHomeGoals, awayGoals: currentAwayGoals };
      var shouldUpdateScore = isGameSwitch || 
        (newHomeGoals !== currentHomeGoals || newAwayGoals !== currentAwayGoals);
        
      dbg('CLIENT_UPDATE_DECISIONS', {
        reqId: reqId,
        shouldUpdateEvent: shouldUpdateEvent,
        shouldUpdateScore: shouldUpdateScore,
        isGameSwitch: isGameSwitch
      });
      
      // Datenstabilitätsprüfung: Verhindere Updates wenn Daten identisch sind
      var isDataIdentical = (
        newHomeGoals === currentHomeGoals &&
        newAwayGoals === currentAwayGoals &&
        newEvent === currentEvent &&
        (s.homeTeam || '') === currentHomeTeam &&
        (s.awayTeam || '') === currentAwayTeam
      );
      
      if (isDataIdentical) {
        console.log('[client] Skipping update - data identical');
        return;
      }
      
      
      // Score-Update mit Tor-Animation
      if (shouldUpdateScore) {
        
        // Tor-Animation nur bei echten Tor-Updates
        var isRealGoal = (newHomeGoals > currentHomeGoals) || (newAwayGoals > currentAwayGoals);
        
        if (isRealGoal) {
          console.log("Echtes Tor erkannt - Animation wird getriggert");
          
          // Score-Sektion Flash-Effekt
          var section = $(".score-section");
          if (section){
            section.classList.add("flash");
            setTimeout(function(){ section.classList.remove("flash"); }, 1800);
          }
          
          // Gesamter Balken Tor-Animation mit Team-Erkennung
          var broadcastBar = $(".broadcast-container");
          if (broadcastBar){
            // Bestimme welches Team das Tor gemacht hat
            var isHomeGoal = newHomeGoals > currentHomeGoals;
            var isAwayGoal = newAwayGoals > currentAwayGoals;
            
            // Entferne alle vorherigen Tor-Klassen
            broadcastBar.classList.remove("home-goal", "away-goal");
            
            // Prüfe ob es ein Tor von HSG Kastellaun/Simmern ist
            var isOurTeam = (s.homeTeam && s.homeTeam.includes("HSG Kastellaun/Simmern")) || 
                            (s.awayTeam && s.awayTeam.includes("HSG Kastellaun/Simmern"));
            
            console.log("Intelligente Tor-Animation:", {
              homeTeam: s.homeTeam,
              awayTeam: s.awayTeam,
              isOurTeam: isOurTeam,
              isHomeGoal: isHomeGoal,
              isAwayGoal: isAwayGoal,
              scorer: s.lastScorer,
              newScore: newHomeGoals + ":" + newAwayGoals,
              oldScore: currentHomeGoals + ":" + currentAwayGoals
            });
            
            if (isHomeGoal) {
              broadcastBar.classList.add("goal-animation", "home-goal");
              if (isOurTeam && s.lastScorer) {
                showPlayerGoal(s.lastScorer, false);
              }
            } else if (isAwayGoal) {
              broadcastBar.classList.add("goal-animation", "away-goal");
              if (isOurTeam && s.lastScorer) {
                showPlayerGoal(s.lastScorer, false);
              }
            } else {
              broadcastBar.classList.add("goal-animation");
              if (isOurTeam && s.lastScorer) {
                showPlayerGoal(s.lastScorer, false);
              }
            }
            
            setTimeout(function(){ 
              broadcastBar.classList.remove("goal-animation", "home-goal", "away-goal"); 
            }, 2000);
          }
        }
        
        setIf($("#homeGoals"), newHomeGoals, 0);
        setIf($("#awayGoals"), newAwayGoals, 0);
      }
      
      // Event-Update
      if (shouldUpdateEvent) {
        stableEventText = newEvent;
        $("#lastEvent").textContent = newEvent;
      }
      
      // Status-Update (ohne Stabilitätsprüfung, da sich selten ändert)
      if (newStatus && newStatus.trim() !== "" && newStatus !== currentStatus) {
        console.log("Status Update durchgeführt:", newStatus);
        $("#gameStatus").textContent = newStatus;
      }
      
      // Team-Namen (bei Spielwechsel oder Änderungen)
      if (s.homeTeam && s.homeTeam !== currentHomeTeam && s.homeTeam.trim() !== "") {
        console.log("Home Team Update:", currentHomeTeam, "->", s.homeTeam);
        setIf($("#homeTeam"), s.homeTeam, "Heim");
      }
      if (s.awayTeam && s.awayTeam !== currentAwayTeam && s.awayTeam.trim() !== "") {
        console.log("Away Team Update:", currentAwayTeam, "->", s.awayTeam);
        setIf($("#awayTeam"), s.awayTeam, "Gast");
      }

      // Logos aus score.json laden (neue Logos werden automatisch übernommen)
      setLogo($("#homeLogo"), (s && s.homeLogoUrl) ? s.homeLogoUrl : "");
      setLogo($("#awayLogo"), (s && s.awayLogoUrl) ? s.awayLogoUrl : "");

      // Tor-Animation-Logik entfernt - wird jetzt durch Stabilitätsprüfung kontrolliert
      
      var endTime = Date.now();
      var totalLatency = endTime - startTime;
      
      dbg('CLIENT_POLL_END', {
        reqId: reqId,
        totalLatency: totalLatency,
        endTime: new Date(endTime).toISOString()
      });
    })
    .catch(function(err){
      var endTime = Date.now();
      var totalLatency = endTime - startTime;
      
      dbg('CLIENT_POLL_ERROR', {
        reqId: reqId,
        error: err.message,
        totalLatency: totalLatency,
        endTime: new Date(endTime).toISOString()
      });
      
      console.error("Score fetch error:", err);
    });
}

/* Spieler-Tor-Anzeige */
function showPlayerGoal(playerName, isHomeTeam) {
  var playerDisplay = $("#player-goal-display");
  var playerImage = $("#player-image");
  var playerNameEl = $("#player-name");
  if (!playerDisplay || !playerNameEl) return;
  
  // Vorherige Anzeige verstecken falls vorhanden
  if (playerDisplayTimeout) {
    clearTimeout(playerDisplayTimeout);
    playerDisplayTimeout = null;
  }
  
  // Spielername setzen
  playerNameEl.textContent = playerName;
  
  // Spielerbild versuchen zu laden
  var imageFileName = generateImageFileName(playerName);
  var imagePath = "/assets/players/" + imageFileName;
  
  // Bild laden und anzeigen
  var img = new Image();
  img.onload = function() {
    playerImage.src = imagePath;
    playerImage.style.display = "block";
    // Entferne Platzhalter-Klassen falls vorhanden
    playerImage.classList.remove("placeholder-avatar");
  };
  img.onerror = function() {
    // Kein Bild gefunden - zeige Platzhalter-Avatar
    playerImage.src = "data:image/svg+xml;base64," + btoa(`
      <svg width="90" height="90" viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg">
        <circle cx="45" cy="45" r="45" fill="#4A5568"/>
        <circle cx="45" cy="33" r="12" fill="#E2E8F0"/>
        <path d="M22.5 67.5c0-12.426 10.074-22.5 22.5-22.5s22.5 10.074 22.5 22.5" fill="#E2E8F0"/>
      </svg>
    `);
    playerImage.style.display = "block";
    playerImage.classList.add("placeholder-avatar");
  };
  img.src = imagePath;
  
  // Anzeige zeigen
  playerDisplay.classList.remove("hidden");
  playerDisplay.classList.add("show");
  
  console.log("Player goal display shown for:", playerName);
  
  // Nach 10 Sekunden verstecken
  playerDisplayTimeout = setTimeout(function() {
    console.log("Hiding player goal display after 10 seconds");
    hidePlayerGoal();
  }, 10000);
}

function hidePlayerGoal() {
  var playerDisplay = $("#player-goal-display");
  if (playerDisplay) {
    playerDisplay.classList.remove("show");
    setTimeout(function() {
      playerDisplay.classList.add("hidden");
    }, 500);
  }
  
  if (playerDisplayTimeout) {
    clearTimeout(playerDisplayTimeout);
    playerDisplayTimeout = null;
  }
}

function generateImageFileName(playerName) {
  // Konvertiere Spielername zu Dateiname
  // Beispiel: "Max Mustermann" -> "max_mustermann.jpg"
  return playerName
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_') + '.jpg';
}

/* Alte Update-Funktionen entfernt - werden durch Stabilitäts-Buffer ersetzt */

/* Tor-Toast anzeigen */
function showToast(text){
  var el = $("#toast");
  if (!el) return;
  
  // Toast-Text setzen
  var toastText = el.querySelector(".toast-text");
  if (toastText) {
    toastText.textContent = text;
  }
  
  // Toast anzeigen
  el.classList.remove("hidden");
  el.classList.add("show");
  
  setTimeout(function(){
    el.classList.remove("show");
    setTimeout(function(){
      el.classList.add("hidden");
    }, 300);
  }, 3200);
}

/* Initialisierung */
function init(){
  refreshLogos().then(function(){ return refreshScore(); });
  setInterval(refreshLogos, 60000);  // Sponsoren alle 60 Sekunden aktualisieren
  setInterval(refreshScore, 1000);   // alle 1 Sekunde für schnellere Updates
}

init();
