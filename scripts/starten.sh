#!/usr/bin/env bash
# Overlay-Server im Hintergrund starten und Browser öffnen
source "$(dirname "$0")/_common.sh"

need_cmd node

OVERLAY_URL="http://localhost:3000/overlay"
ADMIN_URL="http://localhost:3000/admin"

open_browser() {
  echo "==> Öffne Browser …"
  if command -v open >/dev/null 2>&1; then
    open "$OVERLAY_URL" "$ADMIN_URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$OVERLAY_URL" >/dev/null 2>&1 &
    xdg-open "$ADMIN_URL" >/dev/null 2>&1 &
  else
    echo "Kein Browser-Befehl gefunden. Bitte manuell öffnen:"
    echo "  $OVERLAY_URL"
    echo "  $ADMIN_URL"
  fi
}

wait_for_server() {
  local i
  for i in $(seq 1 30); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS -o /dev/null --connect-timeout 1 "$OVERLAY_URL" 2>/dev/null; then
        return 0
      fi
    else
      sleep 1
      return 0
    fi
    sleep 0.2
  done
  return 1
}

if [ ! -d "node_modules" ]; then
  echo "node_modules fehlt – führe zuerst ./scripts/installieren.sh aus."
  exit 1
fi

PID_FILE="$ROOT/.server.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Server läuft bereits (PID $OLD_PID)."
    open_browser
    exit 0
  fi
  rm -f "$PID_FILE"
fi

echo "==> Starte Overlay-Server …"
echo "  Overlay: $OVERLAY_URL"
echo "  Admin:   $ADMIN_URL"
echo "  Beenden: ./scripts/stoppen.sh"
echo

# Losgelöst starten, damit dieses Terminal beendet werden kann
nohup node server.js >/dev/null 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
disown "$PID" 2>/dev/null || true

if wait_for_server; then
  open_browser
  echo "Server läuft (PID $PID)."
else
  echo "Server antwortet noch nicht – Browser trotzdem öffnen."
  open_browser
fi

exit 0
