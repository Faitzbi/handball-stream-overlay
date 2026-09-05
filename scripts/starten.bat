@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."

where node >nul 2>&1
if errorlevel 1 (
  echo Fehler: Node.js ist nicht installiert oder nicht im PATH.
  echo Siehe README.md - Abschnitt "Voraussetzungen".
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo node_modules fehlt - bitte zuerst installieren.bat ausfuehren.
  pause
  exit /b 1
)

if exist ".server.pid" (
  set /p OLD_PID=<".server.pid"
  tasklist /FI "PID eq !OLD_PID!" 2>nul | find "!OLD_PID!" >nul
  if not errorlevel 1 (
    echo Server laeuft bereits ^(PID !OLD_PID!^).
    echo Zum Beenden: stoppen.bat
    pause
    exit /b 1
  )
  del /f /q ".server.pid" >nul 2>&1
)

echo ==^> Starte Overlay-Server ...
echo   Overlay: http://localhost:3000/overlay
echo   Admin:   http://localhost:3000/admin
echo   Beenden: Ctrl+C oder stoppen.bat
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -PassThru -NoNewWindow; Set-Content -Path '.server.pid' -Value $p.Id -NoNewline; try { Wait-Process -Id $p.Id } finally { if (Test-Path '.server.pid') { Remove-Item '.server.pid' -Force -ErrorAction SilentlyContinue } }"

echo.
pause
