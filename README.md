# Handball Stream Overlay

Lokaler Node.js-Server für Score-Overlay und Admin-Panel (OBS / Browser).

- **Overlay:** http://localhost:3000/overlay  
- **Admin:** http://localhost:3000/admin  

---

## Voraussetzungen (auf jedem PC)

Nur diese beiden Programme – **kein GitHub-Login**, wenn das Repo öffentlich ist:

1. **[Git](https://git-scm.com/downloads)**  
   - Windows: „Git for Windows“ installieren, Optionen Standard lassen  
2. **[Node.js LTS](https://nodejs.org/)** (enthält `npm`)  
   - Nach der Installation Terminal/PowerShell **neu öffnen**

Prüfen:

```bash
git --version
node --version
npm --version
```

---

## Repo öffentlich machen (einmalig, von zu Hause)

Ohne Login auf den Hallen-PCs muss das Repo **Public** sein:

1. https://github.com/Faitzbi/handball-stream-overlay → **Settings**  
2. ganz unten **Danger Zone** → **Change repository visibility** → **Public**

Pushen weiterhin nur du mit deinem Account. Andere PCs brauchen nur `git clone` / `git pull`.

---

## Ersteinrichtung auf einem anderen PC

```bash
git clone https://github.com/Faitzbi/handball-stream-overlay.git
cd handball-stream-overlay
git checkout version2-test
```

Dann Abhängigkeiten installieren:

| System | Aktion |
|--------|--------|
| **Windows** | Doppelklick auf `installieren.bat` |
| **macOS / Linux** | `chmod +x scripts/*.sh` (einmalig), dann `./scripts/installieren.sh` |

---

## Alltag: starten, stoppen & updaten

| Aktion | Windows | macOS / Linux |
|--------|---------|---------------|
| Server starten | `starten.bat` | `./scripts/starten.sh` |
| Server stoppen | `stoppen.bat` | `./scripts/stoppen.sh` |
| Updates holen | `aktualisieren.bat` | `./scripts/aktualisieren.sh` |
| Prüfen ob Updates da sind | `status.bat` | `./scripts/status.sh` |

Nach einem Update: zuerst **stoppen**, dann **aktualisieren**, danach wieder **starten**.  
(Alternativ: Fenster mit dem laufenden Server schließen bzw. Ctrl+C.)

Alternativ im Terminal:

```bash
npm start
```

---

## Von zu Hause deployen

```bash
git add .
git commit -m "Kurzbeschreibung"
git push
```

Auf dem anderen PC: `aktualisieren.bat` bzw. `./scripts/aktualisieren.sh`.

---

## Hinweise

- Der Server muss laufen, solange Overlay/Admin genutzt werden.  
- Zum Updaten braucht der PC Internet; zum Streamen reicht oft localhost.  
- **`data/score.json` und `data/config.json` sind lokal** (in `.gitignore`). Jeder PC behält eigene Admin-Einstellungen und Spielstände; Updates überschreiben sie nicht. Beim ersten Start legt der Server die Dateien an, falls sie fehlen. Vorlagen: `data/*.example.json`.  
- Logos/Spielerbilder unter `assets/` bleiben im Repo und werden mit `aktualisieren` mitverteilt.  
- Debug-Modus: `npm run debug` (macOS/Linux) bzw. `set DEBUG=1 && node server.js` (Windows).
