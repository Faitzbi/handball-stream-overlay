@echo off
setlocal
cd /d "%~dp0.."

where git >nul 2>&1
if errorlevel 1 (
  echo Fehler: Git ist nicht installiert oder nicht im PATH.
  pause
  exit /b 1
)

echo ==^> Pruefe auf Updates ...
git fetch --quiet
if errorlevel 1 (
  echo git fetch fehlgeschlagen. Internet / Repo-URL pruefen.
  pause
  exit /b 1
)

for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%i
for /f "delims=" %%i in ('git rev-parse HEAD') do set LOCAL=%%i

git rev-parse @{u} >nul 2>&1
if errorlevel 1 (
  echo Branch: %BRANCH%
  echo Kein Upstream-Branch gesetzt.
  pause
  exit /b 0
)

for /f "delims=" %%i in ('git rev-parse @{u}') do set REMOTE=%%i

echo Branch: %BRANCH%
echo Lokal:  %LOCAL%
echo Remote: %REMOTE%
echo.

if "%LOCAL%"=="%REMOTE%" (
  echo Alles aktuell - keine neuen Updates.
) else (
  for /f "delims=" %%i in ('git rev-list --count HEAD..@{u}') do set BEHIND=%%i
  echo Updates verfuegbar: %BEHIND% Commit^(s^) hinter dem Remote.
  echo Zum Aktualisieren: aktualisieren.bat
)

echo.
pause
