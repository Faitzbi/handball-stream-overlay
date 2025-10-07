# Handball Stream Overlay - Anti-Flackern System

## Problem gelöst
Das "Flackern" im Handball-Overlay wurde durch Nicht-Determinismus in der Quellreihenfolge und zurückspringende Summary-Werte verursacht. Das System wurde komplett überarbeitet mit strengen Guards und monotoner Logik.

## Implementierte Guards

### 1. Single-Source & Monotonicity
- **API-like URLs** (`/api/` oder `combined`) verarbeiten nur JSON-Antworten
- **Monotone sourceStamp**: `max(summary.updatedAt, newestEvent.timestamp, Date.now())`
- **Stale Packet Protection**: Pakete mit kleineren Stamps werden ignoriert

### 2. Event-Auswahl (neueste gewinnt)
- **Deterministische Sortierung**: timestamp desc → id desc → gameTime desc
- **Event-Monotonicity**: Events werden nur aktualisiert wenn `newEventTime >= currentEventTime`
- **Konsistente Auswahl**: Immer dasselbe "neueste" Event bei identischen Daten

### 3. Score-Regression-Schutz
- **Gesamt-Score**: Darf nicht sinken außer bei Spielwechsel
- **MAX-Logik**: `Math.max(newScore, currentScore)` verhindert temporäre Rücksprünge
- **Spielwechsel-Erkennung**: Team-Namen-Änderung oder klarer Reset (vorher > 0, jetzt ≤ 2)

### 4. Fetch-Lock & Atomare Writes
- **Fetch-Lock**: Verhindert überlappende Requests
- **Deep-Diff**: Nur schreiben bei echten Änderungen
- **Idempotente Writes**: Schreibvorgänge sind sicher

### 5. Client-seitige Guards
- **Score-Regression-Schutz**: Client ignoriert Score-Rücksprünge
- **Game-Switch-Erkennung**: Erlaubt Reset bei Spielwechsel

## Debug-System

### Aktivierung
```bash
# Server-seitig
DEBUG=1 node server.js

# Client-seitig
http://localhost:3000/overlay?debug=1
# ODER
localStorage.setItem('DEBUG', '1')
```

### Debug-Ausgaben
- **Console-Logs**: `[DEBUG-SECTION]` Präfixe
- **JSON-Dumps**: `data/debug/parsed-<reqId>.json`
- **HTML-Dumps**: `data/debug/parsed-<reqId>.html`
- **Request-Korrelation**: Incremental `reqId`

### Debug-Sektionen
- `POLL_START/END`: Request-Timing und Latenz
- `VERSIONING`: sourceStamp vs lastSourceStamp, accept/ignore
- `EVENT_SELECTION`: Neuestes Event und Auswahl-Logik
- `SCORE_REGRESSION_BLOCKED`: Score-Schutz-Aktivierung
- `GAME_SWITCH`: Spielwechsel-Erkennung
- `WRITE_DECISION`: Finale Schreib-Entscheidung

## Beispiel-Logausgaben

```
[DEBUG-VERSIONING] 2025-10-07T15:01:15.428Z: {"reqId":73,"sourceStamp":1759849275428,"lastSourceStamp":1759849275000,"isStalePacket":false,"decision":"accept"}

[DEBUG-SCORE_REGRESSION_BLOCKED] 2025-10-07T15:01:15.428Z: {"reqId":73,"newTotal":2,"currentTotal":3,"reason":"total score decreased"}

[DEBUG-WRITE_DECISION] 2025-10-07T15:01:15.428Z: {"reqId":73,"action":"accepted","changes":["homeGoals","lastEvent"]}
```

## Edge Cases abgedeckt

1. **Identische Events**: Deterministische Auswahl via ID/Timestamp
2. **API-Summary-Rücksprünge**: Score-Schutz verhindert Anzeige-Regression
3. **Timeout nach Tor**: Event-Monotonicity verhindert Rücksprung
4. **Fehlende Logos**: Unverändert lassen, niemals undefined

## Testplan

### Manuelle Tests
1. **Paket A**: Event "Tor 06:30", Score 3:0 → akzeptiert
2. **Paket B** (älter): Event "Timeout 05:40", Score 2:0 → ignoriert (stale/regression)
3. **Paket C**: Event "Tor 06:52", Score 4:0 → akzeptiert

### Erwartete Logs
- `stale ignored` oder `regression blocked` bei B
- Monotone sourceStamp, kein UI-Flackern
- Saubere Spielwechsel-Erkennung

## Changelog

### Guards implementiert
- **server.js**: Monotone sourceStamp, Event-Auswahl, Score-Schutz, Fetch-Lock
- **overlay.js**: Client-seitige Score-Regression-Schutz
- **Beide**: Game-Switch-Erkennung, Deep-Diff, Plausibilitäts-Checks

### Beispiel-Logausgaben
- `accepted`: Normale Updates
- `stale ignored`: Ältere Pakete
- `regression blocked`: Score-Rücksprünge
- `game switch detected`: Spielwechsel erkannt
