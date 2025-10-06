function $(s){ return document.querySelector(s); }
var lastScorerSeen = "";
var playerDisplayTimeout = null;

/* einfache JSON-Fetch-Funktion */
function j(url){
  return fetch(url, { cache: "no-store" }).then(function(r){ return r.json(); });
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

/* Score aktualisieren */
function refreshScore(){
  return j("/api/score")
    .then(function(s){
      setIf($("#homeTeam"), s.homeTeam, "Heim");
      setIf($("#awayTeam"), s.awayTeam, "Gast");
      setIf($("#homeGoals"), s.homeGoals, 0);
      setIf($("#awayGoals"), s.awayGoals, 0);
      setIf($("#clock"), s.clock, "00:00");
      
      // Status und Ereignis aktualisieren
      updateGameStatus(s);
      updateLastEvent(s);

      return j("/api/config")
        .then(function(cfg){
          setLogo($("#homeLogo"), (cfg && cfg.homeLogoUrl) ? cfg.homeLogoUrl : "");
          setLogo($("#awayLogo"), (cfg && cfg.awayLogoUrl) ? cfg.awayLogoUrl : "");

          if (s.lastScorer && s.lastScorer !== lastScorerSeen){
            lastScorerSeen = s.lastScorer;
            
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
              var homeGoals = parseInt(s.homeGoals) || 0;
              var awayGoals = parseInt(s.awayGoals) || 0;
              var lastHomeGoals = parseInt($("#homeGoals").textContent) || 0;
              var lastAwayGoals = parseInt($("#awayGoals").textContent) || 0;
              
              // Entferne alle vorherigen Tor-Klassen
              broadcastBar.classList.remove("home-goal", "away-goal");
              
              // Bestimme welches Team das Tor gemacht hat
              var isHomeGoal = homeGoals > lastHomeGoals;
              var isAwayGoal = awayGoals > lastAwayGoals;
              
              // Prüfe ob es ein Tor von HSG Kastellaun/Simmern ist
              var isOurTeam = (s.homeTeam && s.homeTeam.includes("HSG Kastellaun/Simmern")) || 
                              (s.awayTeam && s.awayTeam.includes("HSG Kastellaun/Simmern"));
              
              console.log("Team Check:", {
                homeTeam: s.homeTeam,
                awayTeam: s.awayTeam,
                isOurTeam: isOurTeam,
                isHomeGoal: isHomeGoal,
                isAwayGoal: isAwayGoal,
                scorer: s.lastScorer
              });
              
              if (isHomeGoal) {
                broadcastBar.classList.add("goal-animation", "home-goal");
                if (isOurTeam) {
                  // Spieler-Anzeige für unser Team (HSG Kastellaun/Simmern) - kein Toast
                  console.log("Showing player goal for our team");
                  showPlayerGoal(s.lastScorer, false);
                } else {
                  // Toast nur für andere Teams
                  console.log("Showing toast for other team");
                  showToast("Tor: " + s.lastScorer);
                }
              } else if (isAwayGoal) {
                broadcastBar.classList.add("goal-animation", "away-goal");
                if (isOurTeam) {
                  // Spieler-Anzeige für unser Team (HSG Kastellaun/Simmern) - kein Toast
                  console.log("Showing player goal for our team (away)");
                  showPlayerGoal(s.lastScorer, false);
                } else {
                  // Toast nur für andere Teams
                  console.log("Showing toast for other team (away)");
                  showToast("Tor: " + s.lastScorer);
                }
              } else {
                broadcastBar.classList.add("goal-animation");
                // Fallback - prüfe nochmal ob es unser Team ist
                if (isOurTeam) {
                  console.log("Fallback: Showing player goal for our team");
                  showPlayerGoal(s.lastScorer, false);
                } else {
                  console.log("Fallback: Showing toast for other team");
                  showToast("Tor: " + s.lastScorer);
                }
              }
              
              setTimeout(function(){ 
                broadcastBar.classList.remove("goal-animation", "home-goal", "away-goal"); 
              }, 2000);
            }
          }
        });
    })
    .catch(function(err){
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
  setInterval(refreshScore, 1000);   // jede Sekunde (wegen Spielzeit)
}

init();
