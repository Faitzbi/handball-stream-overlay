// Utility functions
async function jget(url) { 
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json(); 
}

async function jpost(url, data) { 
  const response = await fetch(url, {
    method: "POST", 
    headers: {"Content-Type": "application/json"}, 
    body: JSON.stringify(data)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json(); 
}

// Toast notification system
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// Loading state management
function setLoading(element, loading = true) {
  if (loading) {
    element.classList.add('loading');
    element.disabled = true;
    const originalText = element.innerHTML;
    element.setAttribute('data-original-text', originalText);
    element.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Wird gespeichert...';
  } else {
    element.classList.remove('loading');
    element.disabled = false;
    const originalText = element.getAttribute('data-original-text');
    if (originalText) {
      element.innerHTML = originalText;
      element.removeAttribute('data-original-text');
    }
  }
}

// Load configuration and score data
async function load() {
  try {
    const [cfg, score] = await Promise.all([
      jget("/api/config"),
      jget("/api/score")
    ]);
    
    // Populate form fields
    document.getElementById("tickerUrl").value = cfg.tickerUrl || "";
    document.getElementById("scheduleUrl").value = cfg.scheduleUrl || "";
    document.getElementById("ourTeamName").value = cfg.ourTeamName || "";
    document.getElementById("homeLogoUrl").value = cfg.homeLogoUrl || "";
    document.getElementById("awayLogoUrl").value = cfg.awayLogoUrl || "";
    document.getElementById("teamType").value = cfg.teamType || "herren1";
    document.getElementById("overlayLink").textContent = `${location.origin}/overlay`;
    updateScheduleButtonState();
    updateSelectedMatchUI(cfg.tickerUrl || "");

    // Populate score fields
    for (const k of ["homeTeam","awayTeam","homeGoals","awayGoals","clock","period","lastScorer"]) {
      document.getElementById(k).value = score[k] ?? "";
    }
    
    showToast('Daten erfolgreich geladen', 'success');
  } catch (error) {
    console.error('Fehler beim Laden der Daten:', error);
    showToast('Fehler beim Laden der Daten: ' + error.message, 'error');
  }
}

// Save configuration
async function saveConfiguration(button) {
  try {
    if (button) setLoading(button, true);
    const payload = {
      tickerUrl: document.getElementById("tickerUrl").value.trim(),
      scheduleUrl: document.getElementById("scheduleUrl").value.trim(),
      ourTeamName: document.getElementById("ourTeamName").value.trim(),
      homeLogoUrl: document.getElementById("homeLogoUrl").value.trim(),
      awayLogoUrl: document.getElementById("awayLogoUrl").value.trim(),
      teamType: document.getElementById("teamType").value,
    };
    await jpost("/api/config", payload);
    showToast("Konfiguration erfolgreich gespeichert! Fetcher läuft (falls URL gesetzt).", 'success');
    updateScheduleButtonState();
    updateSelectedMatchUI(payload.tickerUrl || "");
  } catch (error) {
    console.error('Fehler beim Speichern der Konfiguration:', error);
    showToast('Fehler beim Speichern: ' + error.message, 'error');
  } finally {
    if (button) setLoading(button, false);
  }
}

document.getElementById("saveCfg").addEventListener("click", async () => {
  await saveConfiguration(document.getElementById("saveCfg"));
});
const saveCfgAdvanced = document.getElementById("saveCfgAdvanced");
if (saveCfgAdvanced) {
  saveCfgAdvanced.addEventListener("click", async () => {
    await saveConfiguration(saveCfgAdvanced);
  });
}
function updateSelectedMatchUI(tickerUrl, label) {
  const panel = document.getElementById("selectedMatchPanel");
  const titleEl = document.getElementById("selectedMatchLabel");
  const metaEl = document.getElementById("selectedMatchMeta");
  const url = (tickerUrl || "").trim();
  if (!panel || !titleEl) return;

  const listEl = document.getElementById("upcomingGamesList");
  if (listEl) {
    listEl.querySelectorAll(".upcoming-game-item").forEach((btn) => {
      btn.classList.toggle("selected", !!(url && btn.dataset.tickerUrl === url));
    });
  }

  if (!url) {
    panel.style.display = "none";
    titleEl.textContent = "—";
    if (metaEl) metaEl.textContent = "";
    return;
  }

  let displayLabel = (label || "").trim();
  if (!displayLabel && listEl) {
    listEl.querySelectorAll(".upcoming-game-item").forEach((btn) => {
      if (btn.dataset.tickerUrl === url) {
        displayLabel = (btn.dataset.label || "").trim();
        if (!displayLabel) {
          const firstText = Array.from(btn.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
          displayLabel = firstText ? firstText.textContent.trim() : (btn.textContent || "").trim();
        }
      }
    });
  }
  if (!displayLabel) {
    const m = url.match(/\/match\/(\d+)/i);
    displayLabel = m ? `Match ${m[1]}` : url;
  }

  titleEl.textContent = displayLabel;
  if (metaEl) metaEl.textContent = url;
  panel.style.display = "block";
}

function markSelectedUpcomingGame(tickerUrl) {
  updateSelectedMatchUI(tickerUrl);
}

// Spielplan: Button-Zustand je nach scheduleUrl. Nach Fehler Retry erlauben (keepEnabledAfterError = true).
function updateScheduleButtonState(keepEnabledAfterError) {
  const scheduleUrl = (document.getElementById("scheduleUrl") && document.getElementById("scheduleUrl").value || "").trim();
  const btn = document.getElementById("loadUpcoming");
  const hint = document.getElementById("scheduleLoadHint");
  if (btn) btn.disabled = keepEnabledAfterError ? false : !scheduleUrl;
  if (hint) hint.style.display = scheduleUrl ? "none" : "inline";
}

// Nächste Spiele laden und anzeigen
const loadUpcomingEl = document.getElementById("loadUpcoming");
if (loadUpcomingEl) {
  loadUpcomingEl.addEventListener("click", async () => {
  const btn = document.getElementById("loadUpcoming");
  const listEl = document.getElementById("upcomingGamesList");
  const container = document.getElementById("upcomingGames");
  let errorOccurred = false;
  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade...';
    }
    const res = await fetch("/api/schedule/upcoming");
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (_) { /* Body kein JSON */ }
      throw new Error(errMsg);
    }
    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error("Ungültige Antwort vom Server (kein gültiges JSON).");
    }
    const games = Array.isArray(data) ? data : [];
    listEl.innerHTML = "";
    const currentTickerUrl = (document.getElementById("tickerUrl") && document.getElementById("tickerUrl").value || "").trim();
    if (games.length === 0) {
      listEl.innerHTML = '<p style="color: var(--text-secondary);">Keine zukünftigen Spiele gefunden.</p>';
    } else {
      games.forEach((game) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "upcoming-game-item";
        item.dataset.tickerUrl = game.tickerUrl || "";
        item.dataset.label = game.label || "";
        const labelText = document.createTextNode(game.label || "");
        item.appendChild(labelText);
        if (game.dateTime) {
          const small = document.createElement("small");
          small.textContent = game.dateTime;
          item.appendChild(small);
        }
        if (currentTickerUrl && game.tickerUrl === currentTickerUrl) {
          item.classList.add("selected");
        }
        item.addEventListener("click", async () => {
          const tickerUrl = item.dataset.tickerUrl;
          if (!tickerUrl) return;
          document.getElementById("tickerUrl").value = tickerUrl;
          updateSelectedMatchUI(tickerUrl, item.dataset.label || game.label || "");
          listEl.querySelectorAll(".upcoming-game-item").forEach((btn) => btn.classList.remove("selected"));
          item.classList.add("selected");
          try {
            const currentCfg = await jget("/api/config");
            await jpost("/api/config", { ...currentCfg, tickerUrl });
            showToast("Match ausgewählt und gespeichert.", "success");
          } catch (e) {
            console.error("Ticker setzen fehlgeschlagen:", e);
            showToast("Fehler beim Speichern: " + e.message, "error");
          }
        });
        listEl.appendChild(item);
      });
    }
    container.style.display = "block";
    updateSelectedMatchUI(currentTickerUrl);
  } catch (error) {
    errorOccurred = true;
    showToast(error.message || "Spiele konnten nicht geladen werden.", "error");
  } finally {
    if (btn) btn.innerHTML = '<i class="fas fa-sync-alt"></i> Nächste Spiele laden';
    updateScheduleButtonState(errorOccurred);
  }
  });
}

// Save score
document.getElementById("saveScore").addEventListener("click", async () => {
  const button = document.getElementById("saveScore");
  
  try {
    setLoading(button, true);
    
    const data = {};
    for (const k of ["homeTeam","awayTeam","homeGoals","awayGoals","clock","period","lastScorer"]) {
      let v = document.getElementById(k).value;
      if (k === "homeGoals" || k === "awayGoals") {
        v = parseInt(v || "0", 10);
        if (isNaN(v)) {
          throw new Error(`${k} muss eine gültige Zahl sein`);
        }
      }
      data[k] = v;
    }
    
    await jpost("/api/score", data);
    showToast("Score erfolgreich gespeichert!", 'success');
  } catch (error) {
    console.error('Fehler beim Speichern des Scores:', error);
    showToast('Fehler beim Speichern des Scores: ' + error.message, 'error');
  } finally {
    setLoading(button, false);
  }
});

// Input validation and real-time feedback
function setupInputValidation() {
  const numberInputs = ['homeGoals', 'awayGoals'];
  const timeInput = 'clock';
  
  // Number input validation
  numberInputs.forEach(id => {
    const input = document.getElementById(id);
    input.addEventListener('input', (e) => {
      const value = e.target.value;
      if (value && (isNaN(value) || parseInt(value) < 0)) {
        e.target.style.borderColor = 'var(--danger)';
        e.target.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.1)';
      } else {
        e.target.style.borderColor = '';
        e.target.style.boxShadow = '';
      }
    });
  });
  
  // Time input validation (MM:SS format)
  const clockInput = document.getElementById(timeInput);
  clockInput.addEventListener('input', (e) => {
    const value = e.target.value;
    const timeRegex = /^([0-5]?[0-9]):([0-5][0-9])$/;
    if (value && !timeRegex.test(value)) {
      e.target.style.borderColor = 'var(--warning)';
      e.target.style.boxShadow = '0 0 0 3px rgba(245, 158, 11, 0.1)';
    } else {
      e.target.style.borderColor = '';
      e.target.style.boxShadow = '';
    }
  });
}

// Auto-save functionality for score (optional)
let autoSaveTimeout;
function setupAutoSave() {
  const scoreInputs = ["homeTeam","awayTeam","homeGoals","awayGoals","clock","period","lastScorer"];
  
  scoreInputs.forEach(id => {
    const input = document.getElementById(id);
    input.addEventListener('input', () => {
      clearTimeout(autoSaveTimeout);
      autoSaveTimeout = setTimeout(async () => {
        try {
          const data = {};
          for (const k of scoreInputs) {
            let v = document.getElementById(k).value;
            if (k === "homeGoals" || k === "awayGoals") {
              v = parseInt(v || "0", 10);
            }
            data[k] = v;
          }
          await jpost("/api/score", data);
          // Silent auto-save - no toast notification
        } catch (error) {
          console.warn('Auto-save failed:', error);
        }
      }, 2000); // Auto-save after 2 seconds of inactivity
    });
  });
}

// Overlay-Test-Events: Buttons senden einmaliges Test-Event an Overlay
document.querySelectorAll('.btn-test-event').forEach(btn => {
  btn.addEventListener('click', async () => {
    const eventType = btn.getAttribute('data-type') || 'Goal';
    const defaultMsg = btn.getAttribute('data-msg') || '';
    const customMessage = (document.getElementById('testEventMessage') && document.getElementById('testEventMessage').value.trim()) || '';
    const customPlayer = (document.getElementById('testEventPlayer') && document.getElementById('testEventPlayer').value.trim()) || '';
    const message = customMessage || defaultMsg;
    let playerName = customPlayer;
    if (!playerName && (eventType === 'Goal' || eventType === 'SevenMeterGoal')) {
      // Beide Formate: "Tor durch Name (9.)" und "7-Meter Tor durch Name (17.)"
      const m = message.match(/(?:7-Meter\s+)?Tor durch ([^(]+?)\s*\(\d+\.\)/);
      if (m) playerName = m[1].trim();
    }
    try {
      await jpost('/api/admin/test-event', { eventType, message, playerName });
      showToast('Test-Event gesendet – im Overlay beim nächsten Poll sichtbar.', 'success');
    } catch (error) {
      console.error('Test-Event Fehler:', error);
      showToast('Fehler: ' + error.message, 'error');
    }
  });
});

document.getElementById('testTimeoutPopup')?.addEventListener('click', async () => {
  try {
    await jpost('/api/admin/test-timeout-popup', { team: 'Home' });
    showToast('Auszeit-Popup mit aktuellem Spielstand gesendet – im Overlay beim nächsten Poll sichtbar (30 s).', 'success');
  } catch (error) {
    console.error('Auszeit-Popup Fehler:', error);
    showToast('Fehler: ' + error.message, 'error');
  }
});

document.getElementById('testHalftimePopup')?.addEventListener('click', async () => {
  try {
    await jpost('/api/admin/test-halftime-popup', {});
    showToast('Halbzeit-Popup wird beim nächsten Overlay-Poll angezeigt (max. 30 Sekunden im Test).', 'success');
  } catch (error) {
    console.error('Halbzeit-Popup Fehler:', error);
    showToast('Fehler: ' + error.message, 'error');
  }
});

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  load();
  setupInputValidation();
  // setupAutoSave(); // Uncomment if you want auto-save functionality
});