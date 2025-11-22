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
    document.getElementById("homeLogoUrl").value = cfg.homeLogoUrl || "";
    document.getElementById("awayLogoUrl").value = cfg.awayLogoUrl || "";
    document.getElementById("teamType").value = cfg.teamType || "herren1";
    document.getElementById("overlayLink").textContent = `${location.origin}/overlay`;

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
document.getElementById("saveCfg").addEventListener("click", async () => {
  const button = document.getElementById("saveCfg");
  
  try {
    setLoading(button, true);
    
    const payload = {
      tickerUrl: document.getElementById("tickerUrl").value.trim(),
      homeLogoUrl: document.getElementById("homeLogoUrl").value.trim(),
      awayLogoUrl: document.getElementById("awayLogoUrl").value.trim(),
      teamType: document.getElementById("teamType").value,
    };
    
    await jpost("/api/config", payload);
    showToast("Konfiguration erfolgreich gespeichert! Fetcher läuft (falls URL gesetzt).", 'success');
  } catch (error) {
    console.error('Fehler beim Speichern der Konfiguration:', error);
    showToast('Fehler beim Speichern: ' + error.message, 'error');
  } finally {
    setLoading(button, false);
  }
});

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

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  load();
  setupInputValidation();
  // setupAutoSave(); // Uncomment if you want auto-save functionality
});