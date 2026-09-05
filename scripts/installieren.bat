@echo off
setlocal
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo Fehler: Node.js ist nicht installiert oder nicht im PATH.
  echo Siehe README.md - Abschnitt "Voraussetzungen".
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo Fehler: npm wurde nicht gefunden.
  pause
  exit /b 1
)

echo ==^> Installiere Abhaengigkeiten ^(npm install^) ...
call npm install
if errorlevel 1 (
  echo Installation fehlgeschlagen.
  pause
  exit /b 1
)

echo.
echo Fertig. Server starten mit: starten.bat
echo   Overlay: http://localhost:3000/overlay
echo   Admin:   http://localhost:3000/admin
echo.
pause
