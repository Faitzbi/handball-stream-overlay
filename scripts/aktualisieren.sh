#!/usr/bin/env bash
# Neueste Version von GitHub holen und Abhängigkeiten aktualisieren
source "$(dirname "$0")/_common.sh"

need_cmd git
need_cmd npm

echo "==> Hole Updates von GitHub (git pull) …"
git pull --ff-only

echo
echo "==> Aktualisiere Abhängigkeiten (npm install) …"
npm install

echo
echo "Fertig. Server neu starten mit: ./scripts/starten.sh"
