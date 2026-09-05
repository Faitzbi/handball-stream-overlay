#!/usr/bin/env bash
# Gemeinsame Hilfsfunktionen für die Shell-Skripte

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Fehler: '$1' ist nicht installiert oder nicht im PATH."
    echo "Siehe README.md – Abschnitt \"Voraussetzungen\"."
    exit 1
  fi
}
