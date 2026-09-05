#!/usr/bin/env bash
# Overlay-Server stoppen
source "$(dirname "$0")/_common.sh"

PID_FILE="$ROOT/.server.pid"
STOPPED=0

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "==> Stoppe Server (PID $PID) …"
    kill "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
    STOPPED=1
  fi
  rm -f "$PID_FILE"
fi

# Fallback: Prozess anhand der Kommandozeile finden
PIDS="$(pgrep -f "[n]ode server.js" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "==> Stoppe weitere node server.js Prozesse: $PIDS"
  # shellcheck disable=SC2086
  kill $PIDS 2>/dev/null || true
  sleep 0.3
  # shellcheck disable=SC2086
  kill -9 $PIDS 2>/dev/null || true
  STOPPED=1
fi

if [ "$STOPPED" -eq 1 ]; then
  echo "Server gestoppt."
else
  echo "Kein laufender Overlay-Server gefunden."
fi
