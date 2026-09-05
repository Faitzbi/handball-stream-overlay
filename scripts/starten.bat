@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."

set OVERLAY_URL=http://localhost:3000/overlay
set ADMIN_URL=http://localhost:3000/admin

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
    echo ==^> Oeffne Browser ...
    start "" "!OVERLAY_URL!"
    start "" "!ADMIN_URL!"
    timeout /t 2 /nobreak >nul
    exit /b 0
  )
  del /f /q ".server.pid" >nul 2>&1
)

echo ==^> Starte Overlay-Server ...
echo   Overlay: %OVERLAY_URL%
echo   Admin:   %ADMIN_URL%
echo   Beenden: stoppen.bat
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$overlay='http://localhost:3000/overlay'; $admin='http://localhost:3000/admin'; $p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -PassThru -WindowStyle Hidden; Set-Content -Path '.server.pid' -Value $p.Id -NoNewline; for($i=0; $i -lt 30; $i++){ try { Invoke-WebRequest -Uri $overlay -UseBasicParsing -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 200 } }; Write-Host ('Server laeuft (PID ' + $p.Id + ').'); Write-Host '==> Oeffne Browser ...'; Start-Process $overlay; Start-Process $admin"

timeout /t 2 /nobreak >nul
exit /b 0
