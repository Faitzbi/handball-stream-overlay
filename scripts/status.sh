#!/usr/bin/env bash
# Zeigt, ob Updates auf GitHub verfügbar sind
source "$(dirname "$0")/_common.sh"

need_cmd git

echo "==> Prüfe auf Updates …"
git fetch --quiet

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "@{u}" 2>/dev/null || true)"

echo "Branch: $BRANCH"
echo "Lokal:  $LOCAL"

if [ -z "$REMOTE" ]; then
  echo "Kein Upstream-Branch gesetzt. Push/Pull ggf. manuell prüfen."
  exit 0
fi

echo "Remote: $REMOTE"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo
  echo "Alles aktuell – keine neuen Updates."
else
  BEHIND="$(git rev-list --count HEAD.."@{u}" 2>/dev/null || echo "?")"
  AHEAD="$(git rev-list --count "@{u}"..HEAD 2>/dev/null || echo "?")"
  echo
  echo "Updates verfügbar: $BEHIND Commit(s) hinter dem Remote."
  if [ "$AHEAD" != "0" ] && [ "$AHEAD" != "?" ]; then
    echo "Achtung: lokal $AHEAD Commit(s) voraus (nicht gepusht)."
  fi
  echo "Zum Aktualisieren: ./scripts/aktualisieren.sh"
fi
