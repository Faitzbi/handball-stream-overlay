#!/usr/bin/env bash
# Overlay-Server starten
source "$(dirname "$0")/_common.sh"

need_cmd node

if [ ! -d "node_modules" ]; then
  echo "node_modules fehlt – führe zuerst ./scripts/installieren.sh aus."
  exit 1
fi

PID_FILE="$ROOT/.server.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Server läuft bereits (PID $OLD_PID)."
    echo "Zum Beenden: ./scripts/stoppen.sh"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

echo "==> Starte Overlay-Server …"
echo "  Overlay: http://localhost:3000/overlay"
echo "  Admin:   http://localhost:3000/admin"
echo "  Beenden: Ctrl+C oder ./scripts/stoppen.sh"
echo

node server.js &
PID=$!
echo "$PID" > "$PID_FILE"

cleanup() {
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

trap cleanup EXIT INT TERM
wait "$PID"
EXIT_CODE=$?
trap - EXIT INT TERM
rm -f "$PID_FILE"
exit "$EXIT_CODE"
