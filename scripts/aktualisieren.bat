@echo off
setlocal
cd /d "%~dp0.."

where git >nul 2>&1
if errorlevel 1 (
  echo Fehler: Git ist nicht installiert oder nicht im PATH.
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

echo ==^> Hole Updates von GitHub ^(git pull^) ...
git pull --ff-only
if errorlevel 1 (
  echo git pull fehlgeschlagen. Gibt es lokale Aenderungen oder Konflikte?
  pause
  exit /b 1
)

echo.
echo ==^> Aktualisiere Abhaengigkeiten ^(npm install^) ...
call npm install
if errorlevel 1 (
  echo npm install fehlgeschlagen.
  pause
  exit /b 1
)

echo.
echo Fertig. Server neu starten mit: starten.bat
timeout /t 2 /nobreak >nul
exit /b 0
