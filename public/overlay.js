function $(s) { return document.querySelector(s); }
var lastScorerSeen = "";
var playerDisplayTimeout = null;
var playerDisplayTimeoutAway = null;
var timeoutPopupHideTimer = null;
var timeoutPopupEventKey = "";  // lastEvent|lastEventType beim Anzeigen – Popup schließen bei neuem Event
var halftimePopupHideTimer = null;
var halftimePopupEventKey = ""; // Halbzeit-Popup: bei neuem Event schließen
var stableEventText = "";
var lastShownEventKey = "";

// Debug helper function for client-side
var DEBUG = window.location.search.includes('debug=1') || localStorage.getItem('DEBUG') === '1';
var clientReqIdCounter = 0;
var scoreAnimTimeout = null; // cleanup for score highlight
var barAnimTimeout = null;   // cleanup for bar glow classes

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

// Prüft, ob ein Event-Pop-up angezeigt werden soll: wenn ourTeamName gesetzt ist, nur wenn das Event unser Team betrifft
function eventIsForOurTeam(score, eventMessage) {
  var our = (score.ourTeamName && typeof score.ourTeamName === "string") ? score.ourTeamName.trim() : "";
  if (!our) return true;
  var msg = (eventMessage && typeof eventMessage === "string") ? eventMessage : "";
  return msg.indexOf(our) !== -1;
}

// Client-seitige Event-Format-Normalisierung
function normalizeClientEventFormat(event) {
  if (!event || event.trim() === '') return '';

  // Normalisiere Whitespace
  var normalized = event.trim().replace(/\s+/g, ' ');

  // Normalisiere Zeitstempel-Format (z.B. "36:36" -> "36:36")
  normalized = normalized.replace(/(\d{1,2}):(\d{2})/g, function (match, minutes, seconds) {
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
function j(url) {
  return fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); });
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

// Aktualisiert die Liste der Sponsor-Logos, ohne die Rotation oder den Index zurückzusetzen
function updateSponsorRotation(urls) {
  var newUrls = (urls && urls.length) ? urls.slice() : ["/public/placeholder.svg"];

  // Wenn es noch keinen Intervall gibt, initialisieren wir später nach dem ersten Render
  var hadInterval = !!sponsorRotationInterval;

  // Wenn dies die erste Initialisierung ist
  if (!sponsorUrls.length) {
    sponsorUrls = newUrls;
    currentSponsorIndex = 0;
    showCurrentSponsor();
    if (!hadInterval) sponsorRotationInterval = setInterval(rotateSponsor, 20000);
    return;
  }

  // Prüfe, ob sich die Liste tatsächlich geändert hat (gleiche Reihenfolge und Inhalte)
  var isSameList = sponsorUrls.length === newUrls.length && sponsorUrls.every(function (u, i) { return u === newUrls[i]; });
  if (isSameList) {
    // Nichts zu tun, Rotation und Index behalten
    if (!hadInterval) sponsorRotationInterval = setInterval(rotateSponsor, 20000);
    return;
  }

  // Versuche den aktuellen Sponsor in der neuen Liste wiederzufinden
  var currentUrl = sponsorUrls[currentSponsorIndex] || '';
  sponsorUrls = newUrls;
  var foundIndex = sponsorUrls.indexOf(currentUrl);
  if (foundIndex >= 0) {
    currentSponsorIndex = foundIndex;
  } else {
    // Falls aktueller nicht mehr existiert, klemme Index in neue Länge
    currentSponsorIndex = currentSponsorIndex % sponsorUrls.length;
  }

  // Zeige den (ggf. gleichen) aktuellen Sponsor aus der neuen Liste
  showCurrentSponsor();

  // Intervall nicht neu starten, um gleichmäßige Zeitabstände zu bewahren
  if (!hadInterval) sponsorRotationInterval = setInterval(rotateSponsor, 20000);
}

function showCurrentSponsor() {
  var logoEl = $("#sponsor-logo");
  if (!logoEl || !sponsorUrls.length) return;

  var currentUrl = sponsorUrls[currentSponsorIndex];
  logoEl.classList.remove("show");
  logoEl.classList.add("hide");
  setTimeout(function () {
    logoEl.src = currentUrl;
    logoEl.alt = "Sponsor Logo";
    logoEl.classList.remove("hide");
    logoEl.classList.add("show");
  }, 400);
}

function rotateSponsor() {
  if (sponsorUrls.length <= 1) return;

  currentSponsorIndex = (currentSponsorIndex + 1) % sponsorUrls.length;
  showCurrentSponsor();
}

/* Logos laden und Sponsor-Rotation aktualisieren */
function refreshLogos() {
  return j("/api/logos")
    .then(function (res) {
      var urls = (res && res.logos && res.logos.length) ? res.logos : ["/public/placeholder.svg"];
      updateSponsorRotation(urls);
    })
    .catch(function (err) {
      console.error("Logo fetch error:", err);
    });
}

/* Text/Logo-Helfer */
function setIf(el, v, f) {
  if (!el) return;
  if (v === null || v === undefined || v === "") el.textContent = f || "";
  else el.textContent = v;
}
function setLogo(el, url) {
  if (!el) return;
  var placeholder = "/public/team-placeholder.svg";
  var apply = function (src, isPlaceholder) {
    el.onerror = null;
    el.onload = null;
    el.src = src;
    el.style.display = "inline-block";
    el.classList.toggle("team-logo-placeholder", !!isPlaceholder);
  };
  if (url && String(url).trim().length) {
    el.classList.remove("team-logo-placeholder");
    el.onerror = function () {
      apply(placeholder, true);
    };
    el.onload = function () {
      el.classList.remove("team-logo-placeholder");
    };
    el.src = url;
    el.style.display = "inline-block";
  } else {
    apply(placeholder, true);
  }
}

function setPopupLogo(el, url) {
  if (!el) return;
  var placeholder = "/public/team-placeholder.svg";
  if (url && String(url).trim().length) {
    el.onerror = function () {
      el.onerror = null;
      el.src = placeholder;
      el.style.display = "";
    };
    el.src = url;
    el.style.display = "";
  } else {
    el.onerror = null;
    el.src = placeholder;
    el.style.display = "";
  }
}

/* Score aktualisieren mit intelligenter Event-Erkennung */
function refreshScore() {
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
    .then(function (s) {
      var fetchEndTime = Date.now();
      var fetchLatency = fetchEndTime - fetchStartTime;

      var currentEventKey = (s.lastEvent || "") + "|" + (s.lastEventType || "");

      // Timeout-Popup: schließen wenn ein neues Event kam (z. B. nächstes Tor, oder „Spiel läuft weiter“ / „Auszeit beendet“, falls die API das sendet); sonst Fallback 30 s
      var timeoutPopupEl = $("#timeout-popup");
      if (timeoutPopupEl && timeoutPopupEl.classList.contains("show") && timeoutPopupEventKey !== "") {
        if (currentEventKey !== timeoutPopupEventKey) {
          hideTimeoutPopup();
        }
      }
      // Halbzeit-Popup: schließen wenn ein neues Event kam (z. B. „2. Halbzeit gestartet“); sonst Fallback 8 Min
      var halftimePopupEl = $("#halftime-popup");
      if (halftimePopupEl && halftimePopupEl.classList.contains("show") && halftimePopupEventKey !== "") {
        if (currentEventKey !== halftimePopupEventKey) {
          hideHalftimePopup();
        }
      }

      // Vom Admin ausgelöstes Test-Event einmalig anzeigen (Standard: links)
      if (s._testEvent && s._testEvent.eventType) {
        showEventPopup({
          message: s._testEvent.message || "",
          eventType: s._testEvent.eventType || "Goal",
          playerName: s._testEvent.playerName || ""
        }, s._testEvent.side || "left");
      }

      // Auszeit-Popup einmalig anzeigen (Payload vom Server)
      if (s._timeoutPopup && s._timeoutPopup.team != null) {
        showTimeoutPopup(s._timeoutPopup, currentEventKey);
      }

      // Halbzeit-Popup einmalig anzeigen (Payload vom Server)
      if (s._halftimePopup && s._halftimePopup.homePlayers) {
        showHalftimePopup(s._halftimePopup, currentEventKey);
      }

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

      // Safety: Im Vorbereitungszustand mit 0:0 immer das neue Event übernehmen
      if (!shouldUpdateEvent && newStatus === 'Vorbereitung' && newHomeGoals === 0 && newAwayGoals === 0) {
        dbg('CLIENT_PREGAME_FORCE_EVENT', {
          reqId: reqId,
          newEvent: newEvent,
          currentEvent: currentEvent
        });
        shouldUpdateEvent = true;
      }

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

          // Alter Score-Flash entfernt

          // Score-Container und konkrete Zahl hervorheben
          var scoreMain = document.querySelector('.score-main');
          var homeNumEl = $("#homeGoals");
          var awayNumEl = $("#awayGoals");

          // Entferne vorherige Klassen und Timer
          if (scoreMain) {
            scoreMain.classList.remove('scored-home', 'scored-away');
          }
          if (homeNumEl) homeNumEl.classList.remove('scored-home', 'scored-away');
          if (awayNumEl) awayNumEl.classList.remove('scored-home', 'scored-away');
          if (scoreAnimTimeout) { clearTimeout(scoreAnimTimeout); scoreAnimTimeout = null; }

          // Gesamter Balken Tor-Animation mit Team-Erkennung
          var broadcastBar = $(".broadcast-container");
          if (broadcastBar) {
            // Bestimme welches Team das Tor gemacht hat
            var isHomeGoal = newHomeGoals > currentHomeGoals;
            var isAwayGoal = newAwayGoals > currentAwayGoals;

            // Entferne alle vorherigen Tor-Klassen
            broadcastBar.classList.remove("home-goal", "away-goal");

            console.log("Intelligente Tor-Animation:", {
              homeTeam: s.homeTeam,
              awayTeam: s.awayTeam,
              isHomeGoal: isHomeGoal,
              isAwayGoal: isAwayGoal,
              scorer: s.lastScorer,
              newScore: newHomeGoals + ":" + newAwayGoals,
              oldScore: currentHomeGoals + ":" + currentAwayGoals
            });

            // Player-Goal-Display für beide Teams: Heim links, Auswärts rechts; bei gesetztem ourTeamName nur für unser Team
            var lastType = (s.lastEventType || "").trim();
            var isGoalEventType = lastType === "Goal" || lastType === "SevenMeterGoal";
            var goalEventType = lastType === "SevenMeterGoal" ? "SevenMeterGoal" : "Goal";
            var shouldShowPlayerGoal = s.lastScorer && isGoalEventType && eventIsForOurTeam(s, s.lastEvent);
            var eventSide = isHomeGoal ? "left" : (isAwayGoal ? "right" : "left");

            if (isHomeGoal) {
              broadcastBar.classList.add("goal-animation", "home-goal");
              if (scoreMain) scoreMain.classList.add('scored-home');
              if (homeNumEl) homeNumEl.classList.add('scored-home');
              if (shouldShowPlayerGoal) {
                showEventPopup({ message: s.lastEvent || "", eventType: goalEventType, playerName: s.lastScorer, photoUrl: s.lastEventPhotoUrl || "" }, eventSide);
                lastShownEventKey = (s.lastEvent || "") + "|" + lastType;
              }
            } else if (isAwayGoal) {
              broadcastBar.classList.add("goal-animation", "away-goal");
              if (scoreMain) scoreMain.classList.add('scored-away');
              if (awayNumEl) awayNumEl.classList.add('scored-away');
              if (shouldShowPlayerGoal) {
                showEventPopup({ message: s.lastEvent || "", eventType: goalEventType, playerName: s.lastScorer, photoUrl: s.lastEventPhotoUrl || "" }, eventSide);
                lastShownEventKey = (s.lastEvent || "") + "|" + lastType;
              }
            } else {
              broadcastBar.classList.add("goal-animation");
              if (shouldShowPlayerGoal) {
                showEventPopup({ message: s.lastEvent || "", eventType: goalEventType, playerName: s.lastScorer, photoUrl: s.lastEventPhotoUrl || "" }, eventSide);
                lastShownEventKey = (s.lastEvent || "") + "|" + lastType;
              }
            }

            if (barAnimTimeout) { clearTimeout(barAnimTimeout); }
            barAnimTimeout = setTimeout(function () {
              broadcastBar.classList.remove("goal-animation", "home-goal", "away-goal");
            }, 1000);
          }

          // Cleanup der Score-Highlights (Container + Zahlen)
          if (scoreMain || homeNumEl || awayNumEl) {
            scoreAnimTimeout = setTimeout(function () {
              if (scoreMain) scoreMain.classList.remove('scored-home', 'scored-away');
              if (homeNumEl) homeNumEl.classList.remove('scored-home', 'scored-away');
              if (awayNumEl) awayNumEl.classList.remove('scored-home', 'scored-away');
            }, 1000);
          }
        }

        setIf($("#homeGoals"), newHomeGoals, 0);
        setIf($("#awayGoals"), newAwayGoals, 0);
      }

      // Event-Update
      if (shouldUpdateEvent) {
        stableEventText = newEvent;
        $("#lastEvent").textContent = newEvent;

        // Pop-up für Karten/2 Min/Rote Karte für beide Teams: Heim links, Auswärts rechts (einmal pro Event)
        var eventType = (s.lastEventType || "").trim();
        var cardPopupTypes = ["Warning", "TwoMinutePenalty", "Disqualification", "BlueCard"];
        var isCardPopupType = cardPopupTypes.indexOf(eventType) !== -1;
        var eventKey = (newEvent || "") + "|" + eventType;
        var homeTeamName = (s.homeTeam && typeof s.homeTeam === "string") ? s.homeTeam.trim() : "";
        var awayTeamName = (s.awayTeam && typeof s.awayTeam === "string") ? s.awayTeam.trim() : "";
        var eventSide = homeTeamName && newEvent.indexOf(homeTeamName) !== -1 ? "left" : (awayTeamName && newEvent.indexOf(awayTeamName) !== -1 ? "right" : "left");
        if (isCardPopupType && eventKey !== lastShownEventKey && eventIsForOurTeam(s, newEvent)) {
          showEventPopup({ message: newEvent || "", eventType: eventType, playerName: "", photoUrl: s.lastEventPhotoUrl || "" }, eventSide);
          lastShownEventKey = eventKey;
        }
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
    .catch(function (err) {
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

/* Event-Icons als SVG (nur gelb, 2min, rot, blau – Tor und 7m ohne Icon) */
function getEventIconSVG(eventType) {
  var t = (eventType || "").trim();
  if (t === "Goal" || t === "SevenMeterGoal") return "";
  var icons = {
    Warning: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="40" height="44" rx="4" fill="#EAB308" stroke="#fff" stroke-width="1.5"/></svg>',
    TwoMinutePenalty: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="40" height="44" rx="4" fill="#1a1a1a" stroke="#fff" stroke-width="1.5"/><text x="24" y="32" text-anchor="middle" fill="#fff" font-size="24" font-weight="bold" font-family="sans-serif">2' + "'" + '</text></svg>',
    Disqualification: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="40" height="44" rx="4" fill="#DC2626" stroke="#fff" stroke-width="1.5"/></svg>',
    BlueCard: '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="40" height="44" rx="4" fill="#2563EB" stroke="#fff" stroke-width="1.5"/></svg>'
  };
  return icons[t] || "";
}

/* Überschrift pro Event-Typ (einheitliches Pop-up: oben Überschrift, unten Spielername) */
function getEventHeadline(eventType) {
  var t = (eventType || "").trim();
  var headlines = {
    Goal: "Tor durch",
    SevenMeterGoal: "7-Meter-Tor durch",
    Warning: "Gelbe Karte für",
    TwoMinutePenalty: "Zwei Minuten für",
    Disqualification: "Rote Karte für",
    BlueCard: "Blaue Karte für"
  };
  return headlines[t] || "Tor durch";
}

/* Einheitliches Event-Pop-up: immer Icon + Bild/Platzhalter + Überschrift + Spielername. side = "left" | "right" */
function showEventPopup(options, side) {
  var message = options.message || "";
  var eventType = (options.eventType || "").trim();
  var playerName = options.playerName || "";
  if (side !== "left" && side !== "right") side = "left";
  var isRight = side === "right";
  var playerDisplay = isRight ? $("#player-goal-display-away") : $("#player-goal-display");
  var eventIconEl = isRight ? $("#event-icon-away") : $("#event-icon");
  var playerImageEl = isRight ? $("#player-image-away") : $("#player-image");
  var playerNameEl = isRight ? $("#player-name-away") : $("#player-name");
  var goalTextEl = isRight ? $("#goal-text-away") : $("#goal-text");
  var eventMessageEl = isRight ? $("#event-message-away") : $("#event-message");
  var playerImageContainer = playerDisplay ? playerDisplay.querySelector(".player-image-container") : null;
  if (!playerDisplay || !eventIconEl) return;

  if (isRight) {
    if (playerDisplayTimeoutAway) {
      clearTimeout(playerDisplayTimeoutAway);
      playerDisplayTimeoutAway = null;
    }
  } else {
    if (playerDisplayTimeout) {
      clearTimeout(playerDisplayTimeout);
      playerDisplayTimeout = null;
    }
  }

  var iconSvg = getEventIconSVG(eventType);
  eventIconEl.innerHTML = iconSvg;
  eventIconEl.style.display = iconSvg ? "" : "none";

  if (!playerName) {
    playerName = extractPlayerNameFromEventMessage(message);
  }

  if (goalTextEl) {
    goalTextEl.textContent = getEventHeadline(eventType);
    goalTextEl.style.display = "";
  }
  if (playerNameEl) {
    playerNameEl.textContent = playerName || "";
    playerNameEl.style.display = "";
  }
  if (eventMessageEl) {
    var cardTypes = ["Warning", "TwoMinutePenalty", "Disqualification", "BlueCard"];
    var isCardType = cardTypes.indexOf(eventType) !== -1;
    var shortMsg = (message || "").replace(/^\d{1,2}:\d{2}\s*-\s*/, "").trim();
    if (isCardType && !playerName && shortMsg) {
      eventMessageEl.textContent = shortMsg;
      eventMessageEl.classList.remove("hidden");
    } else {
      eventMessageEl.textContent = "";
      eventMessageEl.classList.add("hidden");
    }
  }
  if (playerImageContainer) {
    playerImageContainer.style.display = "";
    loadPlayerImage(playerName, playerImageEl, options.photoUrl || "");
  }

  playerDisplay.classList.remove("hidden");
  playerDisplay.classList.add("show");

  if (isRight) {
    playerDisplayTimeoutAway = setTimeout(function () {
      hidePlayerGoal("right");
    }, 10000);
  } else {
    playerDisplayTimeout = setTimeout(function () {
      hidePlayerGoal("left");
    }, 10000);
  }
}

var PLACEHOLDER_AVATAR_SVG = '<svg width="120" height="120" viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg"><circle cx="75" cy="75" r="75" fill="#4A5568"/><circle cx="75" cy="55" r="20" fill="#E2E8F0"/><path d="M37.5 112.5c0-20.71 16.79-37.5 37.5-37.5s37.5 16.79 37.5 37.5" fill="#E2E8F0"/></svg>';

function setPlaceholderAvatar(playerImageEl) {
  if (!playerImageEl) return;
  playerImageEl.src = "data:image/svg+xml;base64," + btoa(PLACEHOLDER_AVATAR_SVG);
  playerImageEl.style.display = "block";
  playerImageEl.classList.add("placeholder-avatar");
}

function loadPlayerImage(playerName, playerImageEl, photoUrl) {
  if (!playerImageEl) return;
  if (photoUrl && /^https?:\/\//i.test(String(photoUrl))) {
    var remote = new Image();
    remote.onload = function () {
      playerImageEl.src = photoUrl;
      playerImageEl.style.display = "block";
      playerImageEl.classList.remove("placeholder-avatar");
    };
    remote.onerror = function () {
      loadPlayerImage(playerName, playerImageEl, null);
    };
    remote.src = photoUrl;
    return;
  }
  if (!playerName) {
    setPlaceholderAvatar(playerImageEl);
    return;
  }
  var imageFileName = generateImageFileName(playerName);
  var imagePath = "/assets/players/" + imageFileName;
  var img = new Image();
  img.onload = function () {
    playerImageEl.src = imagePath;
    playerImageEl.style.display = "block";
    playerImageEl.classList.remove("placeholder-avatar");
  };
  img.onerror = function () {
    setPlaceholderAvatar(playerImageEl);
  };
  img.src = imagePath;
}

/* Spieler-Tor-Anzeige (ruft showEventPopup mit Goal/SevenMeterGoal auf) */
function showPlayerGoal(playerName, isHomeTeam) {
  showEventPopup({
    message: "Tor durch " + (playerName || ""),
    eventType: "Goal",
    playerName: playerName || ""
  }, isHomeTeam ? "left" : "right");
}

function hidePlayerGoal(side) {
  if (!side || side === "left") {
    var playerDisplayLeft = $("#player-goal-display");
    if (playerDisplayLeft) {
      playerDisplayLeft.classList.remove("show");
      setTimeout(function () {
        playerDisplayLeft.classList.add("hidden");
      }, 500);
    }
    if (playerDisplayTimeout) {
      clearTimeout(playerDisplayTimeout);
      playerDisplayTimeout = null;
    }
  }
  if (!side || side === "right") {
    var playerDisplayRight = $("#player-goal-display-away");
    if (playerDisplayRight) {
      playerDisplayRight.classList.remove("show");
      setTimeout(function () {
        playerDisplayRight.classList.add("hidden");
      }, 500);
    }
    if (playerDisplayTimeoutAway) {
      clearTimeout(playerDisplayTimeoutAway);
      playerDisplayTimeoutAway = null;
    }
  }
}

/* Auszeit-Popup: groß, Mitte (Team-Logo, Sponsor, letzte 5 Events, Top-3-Torschützen) */
function showTimeoutPopup(payload, eventKey) {
  var popup = $("#timeout-popup");
  if (!popup) return;

  if (timeoutPopupHideTimer) {
    clearTimeout(timeoutPopupHideTimer);
    timeoutPopupHideTimer = null;
  }
  timeoutPopupEventKey = (eventKey != null && eventKey !== undefined) ? String(eventKey) : "";

  hidePlayerGoal();

  var teamLogoEl = $("#timeout-team-logo");
  var sponsorLogoEl = $("#timeout-sponsor-logo");
  var eventsList = $("#timeout-events-list");
  var homeList = $("#timeout-scorers-home-list");
  var awayList = $("#timeout-scorers-away-list");
  var homeHeadingLogo = $("#timeout-scorers-home-logo");
  var awayHeadingLogo = $("#timeout-scorers-away-logo");

  if (homeHeadingLogo) setPopupLogo(homeHeadingLogo, payload.homeLogoUrl || "");
  if (awayHeadingLogo) setPopupLogo(awayHeadingLogo, payload.awayLogoUrl || "");

  if (teamLogoEl) setPopupLogo(teamLogoEl, payload.teamLogoUrl || "");
  if (teamLogoEl) teamLogoEl.style.display = "block";

  var sponsorUrl = (sponsorUrls.length && sponsorUrls[currentSponsorIndex]) ? sponsorUrls[currentSponsorIndex] : "";
  if (sponsorLogoEl) {
    if (sponsorUrl) {
      sponsorLogoEl.src = sponsorUrl;
      sponsorLogoEl.style.display = "block";
    } else {
      sponsorLogoEl.style.display = "none";
    }
  }
  rotateSponsor();

  if (eventsList) {
    eventsList.innerHTML = "";
    var events = payload.last5Events || [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var li = document.createElement("li");
      var timeSpan = document.createElement("span");
      timeSpan.className = "timeout-event-time";
      timeSpan.textContent = (e.time || "").trim() || "–";
      li.appendChild(timeSpan);
      li.appendChild(document.createTextNode(" " + (e.message || "").trim()));
      eventsList.appendChild(li);
    }
  }

  function fillScorersList(listEl, scorers) {
    if (!listEl) return;
    listEl.innerHTML = "";
    var arr = Array.isArray(scorers) ? scorers : [];
    for (var j = 0; j < 3; j++) {
      var item = document.createElement("div");
      item.className = "timeout-scorer-item";
      var img = document.createElement("img");
      img.className = "timeout-scorer-avatar";
      img.alt = "";
      var numberEl = document.createElement("span");
      numberEl.className = "timeout-scorer-number";
      var nameEl = document.createElement("span");
      nameEl.className = "timeout-scorer-name";
      var goalsEl = document.createElement("span");
      goalsEl.className = "timeout-scorer-goals";
      var number = "";
      var name = "";
      var goals = 0;
      if (arr[j]) {
        number = (arr[j].number != null && arr[j].number !== "") ? String(arr[j].number) : "";
        name = (arr[j].name || "").trim() || "–";
        goals = typeof arr[j].goals === "number" ? arr[j].goals : parseInt(arr[j].goals, 10) || 0;
      } else {
        name = "–";
      }
      numberEl.textContent = number ? "Nr. " + number : "";
      nameEl.textContent = name;
      goalsEl.textContent = goals;
      loadPlayerImage(name === "–" ? "" : name, img);
      item.appendChild(img);
      item.appendChild(numberEl);
      item.appendChild(nameEl);
      item.appendChild(goalsEl);
      listEl.appendChild(item);
    }
  }
  fillScorersList(homeList, payload.top3Home);
  fillScorersList(awayList, payload.top3Away);

  var sponsorDisplay = $("#sponsor-display");
  if (sponsorDisplay) sponsorDisplay.style.display = "none";

  popup.classList.remove("hidden");
  popup.classList.add("show");

  timeoutPopupHideTimer = setTimeout(function () {
    hideTimeoutPopup();
    timeoutPopupHideTimer = null;
  }, 30000);
}

function hideTimeoutPopup() {
  var popup = $("#timeout-popup");
  if (popup) {
    popup.classList.remove("show");
    setTimeout(function () {
      popup.classList.add("hidden");
    }, 350);
  }
  if (timeoutPopupHideTimer) {
    clearTimeout(timeoutPopupHideTimer);
    timeoutPopupHideTimer = null;
  }
  timeoutPopupEventKey = "";
  var halftimePopup = $("#halftime-popup");
  var sponsorDisplay = $("#sponsor-display");
  if (sponsorDisplay && (!halftimePopup || !halftimePopup.classList.contains("show"))) {
    sponsorDisplay.style.display = "";
  }
}

/* Halbzeit-Popup: Spielerübersicht beider Teams (Nr., Name, Tore, Gelb, 2 Min, Rot, Blau) */
function showHalftimePopup(payload, eventKey) {
  var popup = $("#halftime-popup");
  if (!popup) return;

  if (halftimePopupHideTimer) {
    clearTimeout(halftimePopupHideTimer);
    halftimePopupHideTimer = null;
  }
  halftimePopupEventKey = (eventKey != null && eventKey !== undefined) ? String(eventKey) : "";

  var titleEl = $("#halftime-popup-title");
  if (titleEl) titleEl.textContent = (payload.title || "Halbzeit").trim();

  var homeNameEl = $("#halftime-home-name");
  var awayNameEl = $("#halftime-away-name");
  if (homeNameEl) homeNameEl.textContent = payload.homeTeam || "Heim";
  if (awayNameEl) awayNameEl.textContent = payload.awayTeam || "Gast";

  var homeLogoEl = $("#halftime-home-logo");
  var awayLogoEl = $("#halftime-away-logo");
  if (homeLogoEl) setPopupLogo(homeLogoEl, payload.homeLogoUrl || "");
  if (awayLogoEl) setPopupLogo(awayLogoEl, payload.awayLogoUrl || "");

  function numVal(v) {
    return typeof v === "number" ? v : (parseInt(v, 10) || 0);
  }
  function valueCellHtml(val, hasValue, columnType) {
    var n = numVal(val);
    var text = n === 0 ? "–" : String(n);
    if (hasValue) {
      var pillClass = "halftime-value-pill halftime-pill-" + (columnType || "goals");
      return "<span class=\"" + pillClass + "\">" + text + "</span>";
    }
    return text;
  }
  function fillHalftimeTable(tbodyId, players) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = "";
    var arr = Array.isArray(players) ? players : [];
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i];
      var tr = document.createElement("tr");
      var goals = numVal(p.goals);
      var yc = numVal(p.yellowCards);
      var t2 = numVal(p.timePenalties);
      var rc = numVal(p.redCards);
      var bc = numVal(p.blueCards);
      tr.innerHTML =
        "<td>" + (p.number != null && p.number !== "" ? p.number : "–") + "</td>" +
        "<td class=\"halftime-cell-name\">" + (p.name || "–") + "</td>" +
        "<td class=\"" + (goals > 0 ? "halftime-cell-value" : "") + "\">" + valueCellHtml(p.goals, goals > 0, "goals") + "</td>" +
        "<td class=\"" + (yc > 0 ? "halftime-cell-value" : "") + "\">" + valueCellHtml(p.yellowCards, yc > 0, "yellow") + "</td>" +
        "<td class=\"" + (t2 > 0 ? "halftime-cell-value" : "") + "\">" + valueCellHtml(p.timePenalties, t2 > 0, "2min") + "</td>" +
        "<td class=\"" + (rc > 0 ? "halftime-cell-value" : "") + "\">" + valueCellHtml(p.redCards, rc > 0, "red") + "</td>" +
        "<td class=\"" + (bc > 0 ? "halftime-cell-value" : "") + "\">" + valueCellHtml(p.blueCards, bc > 0, "blue") + "</td>";
      tbody.appendChild(tr);
    }
  }
  fillHalftimeTable("halftime-home-tbody", payload.homePlayers || []);
  fillHalftimeTable("halftime-away-tbody", payload.awayPlayers || []);

  var sponsorDisplay = $("#sponsor-display");
  if (sponsorDisplay) sponsorDisplay.style.display = "none";

  popup.classList.remove("hidden");
  popup.classList.add("show");

  var durationMs = (payload.isTest === true) ? 30000 : 8 * 60 * 1000; // 30s Test, sonst 8 Min
  halftimePopupHideTimer = setTimeout(function () {
    hideHalftimePopup();
    halftimePopupHideTimer = null;
  }, durationMs);
}

function hideHalftimePopup() {
  var popup = $("#halftime-popup");
  if (popup) {
    popup.classList.remove("show");
    setTimeout(function () {
      popup.classList.add("hidden");
    }, 350);
  }
  if (halftimePopupHideTimer) {
    clearTimeout(halftimePopupHideTimer);
    halftimePopupHideTimer = null;
  }
  halftimePopupEventKey = "";
  var timeoutPopup = $("#timeout-popup");
  var sponsorDisplay = $("#sponsor-display");
  if (sponsorDisplay && (!timeoutPopup || !timeoutPopup.classList.contains("show"))) {
    sponsorDisplay.style.display = "";
  }
}

/* Spielername aus Event-Message extrahieren.
 * - Tore: "Tor durch Name (9.)" oder "7-Meter Tor durch Name (17.) (Verein)" → Name
 * - Karten/Strafen: "Name (9.) (Verein) erhält ..." → Name
 */
function extractPlayerNameFromEventMessage(message) {
  if (!message || typeof message !== "string") return "";
  var text = message.replace(/^\d{1,2}:\d{2}\s*-\s*/, "").trim();
  // Zuerst Tor/7m-Muster: optional "7-Meter " dann "Tor durch Name (nr.)"
  var goalMatch = text.match(/(?:7-Meter\s+)?Tor durch ([^(]+?)\s*\(\d+\.\)/);
  if (goalMatch) {
    var name = (goalMatch[1] || "").trim();
    if (name.length >= 2 && /[a-zA-Z\u00C0-\u024F]/.test(name)) return name;
    return "";
  }
  // Karten/Strafen: "Name (nr.) (Verein) ..."
  var m = text.match(/^([^(]+?)\s*\(\d+\.\)\s*\([^)]+\)/);
  if (!m) return "";
  var name = (m[1] || "").trim();
  if (name.length < 2 || !/[a-zA-Z\u00C0-\u024F]/.test(name)) return "";
  return name;
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
function showToast(text) {
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

  setTimeout(function () {
    el.classList.remove("show");
    setTimeout(function () {
      el.classList.add("hidden");
    }, 300);
  }, 3200);
}

/* Team-Typ basierte Anzeige-Steuerung */
var currentTeamType = "herren1";

function updateDisplayBasedOnTeamType() {
  var broadcastWrapper = $(".broadcast-wrapper");
  var gameInfoBar = $(".game-info-bar");
  var sponsorDisplay = $("#sponsor-display");
  var playerGoalDisplayLeft = $("#player-goal-display");
  var playerGoalDisplayRight = $("#player-goal-display-away");
  var clubLogoDisplay = $("#club-logo-display");

  if (currentTeamType === "onlySponsor") {
    if (broadcastWrapper) broadcastWrapper.style.display = "none";
    if (gameInfoBar) gameInfoBar.style.display = "none";
    if (sponsorDisplay) sponsorDisplay.style.display = "";
    if (playerGoalDisplayLeft) {
      playerGoalDisplayLeft.classList.add("hidden");
      playerGoalDisplayLeft.style.display = "none";
    }
    if (playerGoalDisplayRight) {
      playerGoalDisplayRight.classList.add("hidden");
      playerGoalDisplayRight.style.display = "none";
    }
    if (clubLogoDisplay) {
      clubLogoDisplay.classList.remove("hidden");
      loadClubLogo();
    }
  } else {
    if (broadcastWrapper) broadcastWrapper.style.display = "";
    if (gameInfoBar) gameInfoBar.style.display = "";
    if (sponsorDisplay) sponsorDisplay.style.display = "";
    if (playerGoalDisplayLeft) {
      playerGoalDisplayLeft.classList.remove("hidden");
      playerGoalDisplayLeft.style.display = "";
    }
    if (playerGoalDisplayRight) {
      playerGoalDisplayRight.classList.remove("hidden");
      playerGoalDisplayRight.style.display = "";
    }
    if (clubLogoDisplay) clubLogoDisplay.classList.add("hidden");
  }
}

/* Vereinslogo laden */
function loadClubLogo() {
  var clubLogoEl = $("#club-logo");
  if (!clubLogoEl) return;

  j("/api/club-logo")
    .then(function (res) {
      if (res && res.logo) {
        clubLogoEl.src = res.logo;
        clubLogoEl.style.display = "block";
      } else {
        clubLogoEl.style.display = "none";
      }
    })
    .catch(function () {
      clubLogoEl.style.display = "none";
    });
}

/* Config laden und Team-Typ prüfen */
function refreshConfig() {
  return j("/api/config")
    .then(function (cfg) {
      var newTeamType = cfg.teamType || "herren1";
      if (newTeamType !== currentTeamType) {
        currentTeamType = newTeamType;
        updateDisplayBasedOnTeamType();
        console.log("Team-Typ geändert:", currentTeamType);
        // Logos neu laden wenn sich teamType geändert hat
        refreshLogos();
        // Score-Refresh-Interval basierend auf Team-Typ aktualisieren
        updateScoreRefreshInterval();
      }
    })
    .catch(function (err) {
      console.error("Config fetch error:", err);
    });
}

/* Initialisierung */
var scoreRefreshInterval = null;

function init() {
  // Config laden und Display basierend auf Team-Typ anpassen
  refreshConfig().then(function () {
    updateDisplayBasedOnTeamType();
    refreshLogos();
    // Score nur laden wenn nicht "onlySponsor"
    if (currentTeamType !== "onlySponsor") {
      refreshScore();
    }
    // Score-Refresh-Interval basierend auf Team-Typ starten/stoppen
    updateScoreRefreshInterval();
  });

  setInterval(refreshConfig, 5000);  // Config alle 5 Sekunden aktualisieren
  setInterval(refreshLogos, 60000);  // Sponsoren alle 60 Sekunden aktualisieren
}

function updateScoreRefreshInterval() {
  // Altes Interval löschen
  if (scoreRefreshInterval) {
    clearInterval(scoreRefreshInterval);
    scoreRefreshInterval = null;
  }

  // Nur wenn Score angezeigt wird
  if (currentTeamType !== "onlySponsor") {
    scoreRefreshInterval = setInterval(refreshScore, 1000);   // alle 1 Sekunde für schnellere Updates
  }
}

init();
