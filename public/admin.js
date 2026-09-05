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
  if (!response.ok) {
    let msg = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const err = await response.json();
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return response.json(); 
}

async function jdelete(url) {
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) {
    let msg = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const err = await response.json();
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return response.json();
}

async function jput(url, data) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    let msg = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const err = await response.json();
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return response.json();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.readAsDataURL(file);
  });
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

function validatePlayerNameClient(name) {
  const displayName = String(name || '').trim().replace(/\s+/g, ' ');
  if (!displayName) return { ok: false, error: 'Name fehlt', displayName: '', basename: '' };
  const parts = displayName.split(' ');
  if (parts.length < 2) {
    return { ok: false, error: 'Format: Vorname Nachname', displayName, basename: '' };
  }
  const basename = normalizePlayerBasename(displayName);
  if (!basename || !basename.includes('_')) {
    return { ok: false, error: 'Ungültiger Name', displayName, basename: '' };
  }
  return { ok: true, error: '', displayName, basename };
}

const PLAYER_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88">
      <rect width="88" height="88" rx="8" fill="#e2e8f0"/>
      <circle cx="44" cy="34" r="14" fill="#94a3b8"/>
      <path d="M18 76c4-16 16-24 26-24s22 8 26 24" fill="#94a3b8"/>
    </svg>`
  );

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderAssetList(containerId, type, files) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!files?.length) {
    el.innerHTML = '<p class="asset-empty">Noch keine Dateien.</p>';
    return;
  }
  el.innerHTML = files.map(f => `
    <div class="asset-item" data-type="${type}" data-name="${escapeHtml(f.name)}">
      <img src="${f.url}" alt="${escapeHtml(f.name)}" loading="lazy" />
      <span class="asset-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <button type="button" class="btn-delete-asset" data-type="${type}" data-name="${escapeHtml(f.name)}" title="Löschen">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `).join('');
}

function playerFilenameHint(basename, ext = '.jpg') {
  if (!basename) return { text: '→ vorname_nachname.jpg', ok: false };
  return { text: `→ ${basename}${ext}`, ok: true };
}

function renderPlayerManager(players) {
  const root = document.getElementById('playerManager');
  if (!root) return;

  const addCard = `
    <div class="player-card is-new" data-role="new">
      <div class="player-photo-wrap">
        <img class="player-photo" src="${PLAYER_PLACEHOLDER}" alt="Neues Foto" />
        <button type="button" class="player-photo-btn" data-action="pick-photo">Foto wählen</button>
        <input type="file" class="player-file-input" accept="image/jpeg,image/png,image/webp" hidden />
      </div>
      <div class="player-card-body">
        <input type="text" class="player-name-input" placeholder="Vorname Nachname" autocomplete="off" />
        <div class="player-file-hint">→ vorname_nachname.jpg</div>
        <div class="player-card-actions">
          <button type="button" class="btn btn-primary" data-action="add-player">
            <i class="fas fa-plus"></i> Hinzufügen
          </button>
        </div>
      </div>
    </div>
  `;

  const cards = (players || []).map((p) => {
    const hint = playerFilenameHint(p.basename, pathExt(p.filename));
    return `
      <div class="player-card" data-filename="${escapeHtml(p.filename)}" data-role="existing">
        <div class="player-photo-wrap">
          <img class="player-photo" src="${p.url}?t=${Date.now()}" alt="${escapeHtml(p.displayName)}" />
          <button type="button" class="player-photo-btn" data-action="pick-photo">Foto ändern</button>
          <input type="file" class="player-file-input" accept="image/jpeg,image/png,image/webp" hidden />
        </div>
        <div class="player-card-body">
          <input type="text" class="player-name-input" value="${escapeHtml(p.displayName)}" placeholder="Vorname Nachname" autocomplete="off" />
          <div class="player-file-hint">${escapeHtml(hint.text)}</div>
          <div class="player-card-actions">
            <button type="button" class="btn btn-secondary" data-action="save-player">
              <i class="fas fa-save"></i> Speichern
            </button>
            <button type="button" class="btn btn-danger-soft" data-action="delete-player">
              <i class="fas fa-trash"></i> Löschen
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  root.innerHTML = addCard + cards;
}

function pathExt(filename) {
  const m = String(filename || '').match(/\.(jpe?g|png|webp)$/i);
  if (!m) return '.jpg';
  return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
}

function updateCardNameHint(card) {
  const input = card.querySelector('.player-name-input');
  const hint = card.querySelector('.player-file-hint');
  if (!input || !hint) return;
  const validated = validatePlayerNameClient(input.value);
  const pendingFile = card._pendingFile;
  let ext = '.jpg';
  if (pendingFile?.type?.includes('png')) ext = '.png';
  else if (pendingFile?.type?.includes('webp')) ext = '.webp';
  else if (card.dataset.filename) ext = pathExt(card.dataset.filename);
  if (!validated.ok) {
    hint.textContent = validated.error || 'Format: Vorname Nachname';
    hint.classList.add('invalid');
  } else {
    hint.textContent = playerFilenameHint(validated.basename, ext).text;
    hint.classList.remove('invalid');
  }
}

async function loadPlayers() {
  const data = await jget('/api/players');
  renderPlayerManager(data.players || []);
}

async function loadAssetLists() {
  const sponsorType = document.getElementById('sponsorUploadTarget')?.value || 'sponsors';
  try {
    const [sponsors] = await Promise.all([
      jget(`/api/assets/list?type=${encodeURIComponent(sponsorType)}`),
      loadPlayers()
    ]);
    renderAssetList('sponsorAssetList', sponsorType, sponsors.files || []);
  } catch (error) {
    console.error('Asset-Liste Fehler:', error);
  }
}

async function uploadAsset({ type, file, playerName, filename }) {
  const dataBase64 = await fileToDataUrl(file);
  return jpost('/api/assets/upload', {
    type,
    filename: filename || file.name,
    playerName: playerName || '',
    dataBase64
  });
}

function setupAssetUploads() {
  document.getElementById('sponsorUploadTarget')?.addEventListener('change', (e) => {
    e.target.dataset.userTouched = '1';
    loadAssetLists();
  });

  document.getElementById('uploadSponsorBtn')?.addEventListener('click', async () => {
    const type = document.getElementById('sponsorUploadTarget')?.value || 'sponsors';
    const input = document.getElementById('sponsorFileInput');
    const file = input?.files?.[0];
    if (!file) {
      showToast('Bitte zuerst eine Logo-Datei wählen.', 'error');
      return;
    }
    const btn = document.getElementById('uploadSponsorBtn');
    try {
      setLoading(btn, true);
      await uploadAsset({ type, file, filename: file.name });
      if (input) input.value = '';
      showToast('Sponsor-Logo hochgeladen', 'success');
      await loadAssetLists();
    } catch (error) {
      showToast('Upload fehlgeschlagen: ' + error.message, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  document.addEventListener('click', async (e) => {
    const deleteAssetBtn = e.target.closest('.btn-delete-asset');
    if (deleteAssetBtn) {
      const type = deleteAssetBtn.getAttribute('data-type');
      const name = deleteAssetBtn.getAttribute('data-name');
      if (!type || !name) return;
      if (!confirm(`„${name}“ wirklich löschen?`)) return;
      try {
        await jdelete(`/api/assets/${encodeURIComponent(type)}/${encodeURIComponent(name)}`);
        showToast('Datei gelöscht', 'success');
        await loadAssetLists();
      } catch (error) {
        showToast('Löschen fehlgeschlagen: ' + error.message, 'error');
      }
      return;
    }

    const card = e.target.closest('.player-card');
    if (!card) return;

    const actionBtn = e.target.closest('[data-action]');
    if (!actionBtn) return;
    const action = actionBtn.getAttribute('data-action');

    if (action === 'pick-photo') {
      card.querySelector('.player-file-input')?.click();
      return;
    }

    if (action === 'add-player') {
      const nameInput = card.querySelector('.player-name-input');
      const validated = validatePlayerNameClient(nameInput?.value);
      if (!validated.ok) {
        showToast(validated.error, 'error');
        updateCardNameHint(card);
        return;
      }
      const file = card._pendingFile;
      if (!file) {
        showToast('Bitte zuerst ein Foto wählen.', 'error');
        return;
      }
      try {
        setLoading(actionBtn, true);
        const dataBase64 = await fileToDataUrl(file);
        await jpost('/api/players', {
          playerName: validated.displayName,
          dataBase64
        });
        showToast(`Spieler angelegt: ${validated.displayName}`, 'success');
        await loadPlayers();
      } catch (error) {
        showToast('Anlegen fehlgeschlagen: ' + error.message, 'error');
      } finally {
        setLoading(actionBtn, false);
      }
      return;
    }

    if (action === 'save-player') {
      const filename = card.dataset.filename;
      const nameInput = card.querySelector('.player-name-input');
      const validated = validatePlayerNameClient(nameInput?.value);
      if (!validated.ok) {
        showToast(validated.error, 'error');
        updateCardNameHint(card);
        return;
      }
      try {
        setLoading(actionBtn, true);
        const payload = { playerName: validated.displayName };
        if (card._pendingFile) {
          payload.dataBase64 = await fileToDataUrl(card._pendingFile);
        }
        await jput(`/api/players/${encodeURIComponent(filename)}`, payload);
        showToast('Spieler gespeichert', 'success');
        await loadPlayers();
      } catch (error) {
        showToast('Speichern fehlgeschlagen: ' + error.message, 'error');
      } finally {
        setLoading(actionBtn, false);
      }
      return;
    }

    if (action === 'delete-player') {
      const filename = card.dataset.filename;
      const label = card.querySelector('.player-name-input')?.value || filename;
      if (!confirm(`Spieler „${label}“ wirklich löschen?`)) return;
      try {
        await jdelete(`/api/players/${encodeURIComponent(filename)}`);
        showToast('Spieler gelöscht', 'success');
        await loadPlayers();
      } catch (error) {
        showToast('Löschen fehlgeschlagen: ' + error.message, 'error');
      }
    }
  });

  document.addEventListener('input', (e) => {
    if (!e.target.classList?.contains('player-name-input')) return;
    const card = e.target.closest('.player-card');
    if (card) updateCardNameHint(card);
  });

  document.addEventListener('change', (e) => {
    if (!e.target.classList?.contains('player-file-input')) return;
    const card = e.target.closest('.player-card');
    if (!card) return;
    const file = e.target.files?.[0];
    if (!file) return;
    card._pendingFile = file;
    const img = card.querySelector('.player-photo');
    if (img) img.src = URL.createObjectURL(file);
    updateCardNameHint(card);

    // Bestehende Spieler: Bild sofort speichern, Name unverändert
    if (card.dataset.role === 'existing' && card.dataset.filename) {
      (async () => {
        try {
          const dataBase64 = await fileToDataUrl(file);
          await jput(`/api/players/${encodeURIComponent(card.dataset.filename)}`, {
            dataBase64
          });
          card._pendingFile = null;
          showToast('Foto aktualisiert', 'success');
          await loadPlayers();
        } catch (error) {
          showToast('Foto-Update fehlgeschlagen: ' + error.message, 'error');
        }
      })();
    }
  });
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
    const sponsorTarget = document.getElementById("sponsorUploadTarget");
    if (sponsorTarget && !sponsorTarget.dataset.userTouched) {
      sponsorTarget.value = (cfg.teamType === "onlySponsor") ? "sponsorsOnly" : "sponsors";
    }
    updateScheduleButtonState();
    updateSelectedMatchUI(cfg.tickerUrl || "");
    loadAssetLists();

    // Populate score fields
    for (const k of ["homeTeam","awayTeam","homeGoals","awayGoals","clock","period","lastScorer"]) {
      document.getElementById(k).value = score[k] ?? "";
    }
    
    showToast('Daten erfolgreich geladen', 'success');

    // Beim Start automatisch nächste Spiele laden, wenn Team-URL schon hinterlegt ist
    if ((cfg.scheduleUrl || "").trim()) {
      await loadUpcomingGames({ persistConfig: false });
    }
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

const scheduleUrlInput = document.getElementById("scheduleUrl");
if (scheduleUrlInput) {
  scheduleUrlInput.addEventListener("input", () => updateScheduleButtonState());
}

/**
 * Nächste Spiele laden und anzeigen.
 * @param {{ persistConfig?: boolean }} [options]
 * - persistConfig: Formularwerte vor dem Laden speichern (Button-Klick)
 */
async function loadUpcomingGames(options = {}) {
  const { persistConfig = true } = options;
  const btn = document.getElementById("loadUpcoming");
  const listEl = document.getElementById("upcomingGamesList");
  const container = document.getElementById("upcomingGames");
  let errorOccurred = false;
  try {
    const scheduleUrl = (document.getElementById("scheduleUrl") && document.getElementById("scheduleUrl").value || "").trim();
    if (!scheduleUrl) {
      throw new Error("Bitte zuerst eine Team-URL eintragen.");
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = persistConfig
        ? '<i class="fas fa-spinner fa-spin"></i> Speichere & lade...'
        : '<i class="fas fa-spinner fa-spin"></i> Lade...';
    }

    if (persistConfig) {
      const currentCfg = await jget("/api/config");
      const payload = {
        ...currentCfg,
        tickerUrl: document.getElementById("tickerUrl").value.trim(),
        scheduleUrl,
        ourTeamName: document.getElementById("ourTeamName").value.trim(),
        homeLogoUrl: document.getElementById("homeLogoUrl").value.trim(),
        awayLogoUrl: document.getElementById("awayLogoUrl").value.trim(),
        teamType: document.getElementById("teamType").value,
      };
      await jpost("/api/config", payload);
      updateScheduleButtonState();
      if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Lade...';
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
    if (listEl) listEl.innerHTML = "";
    const currentTickerUrl = (document.getElementById("tickerUrl") && document.getElementById("tickerUrl").value || "").trim();
    if (!listEl) return;
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
          listEl.querySelectorAll(".upcoming-game-item").forEach((b) => b.classList.remove("selected"));
          item.classList.add("selected");
          try {
            const cfg = await jget("/api/config");
            await jpost("/api/config", { ...cfg, tickerUrl });
            showToast("Match ausgewählt und gespeichert.", "success");
          } catch (e) {
            console.error("Ticker setzen fehlgeschlagen:", e);
            showToast("Fehler beim Speichern: " + e.message, "error");
          }
        });
        listEl.appendChild(item);
      });
    }
    if (container) container.style.display = "block";
    updateSelectedMatchUI(currentTickerUrl);
  } catch (error) {
    errorOccurred = true;
    console.warn("Nächste Spiele laden:", error.message || error);
    showToast(error.message || "Spiele konnten nicht geladen werden.", "error");
  } finally {
    if (btn) btn.innerHTML = '<i class="fas fa-sync-alt"></i> Nächste Spiele laden';
    updateScheduleButtonState(errorOccurred);
  }
}

const loadUpcomingEl = document.getElementById("loadUpcoming");
if (loadUpcomingEl) {
  loadUpcomingEl.addEventListener("click", () => loadUpcomingGames({ persistConfig: true }));
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
  setupAssetUploads();
  loadAssetLists();
  // setupAutoSave(); // Uncomment if you want auto-save functionality
});