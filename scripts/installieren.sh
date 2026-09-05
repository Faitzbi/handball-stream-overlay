#!/usr/bin/env bash
# Einmalige Einrichtung: Abhängigkeiten installieren
source "$(dirname "$0")/_common.sh"

need_cmd node
need_cmd npm

echo "==> Installiere Abhängigkeiten (npm install) …"
npm install
echo
echo "Fertig. Server starten mit: ./scripts/starten.sh"
echo "  Overlay: http://localhost:3000/overlay"
echo "  Admin:   http://localhost:3000/admin"
