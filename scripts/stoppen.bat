@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0.."

set STOPPED=0

if exist ".server.pid" (
  set /p PID=<".server.pid"
  echo ==^> Stoppe Server ^(PID !PID!^) ...
  taskkill /PID !PID! /F >nul 2>&1
  if not errorlevel 1 set STOPPED=1
  del /f /q ".server.pid" >nul 2>&1
)

REM Fallback: node-Prozesse mit server.js in der Kommandozeile
for /f "skip=1 tokens=2 delims=," %%A in ('wmic process where "name='node.exe' and commandline like '%%server.js%%'" get processid /format:csv 2^>nul') do (
  if not "%%A"=="" (
    echo ==^> Stoppe node server.js ^(PID %%A^) ...
    taskkill /PID %%A /F >nul 2>&1
    if not errorlevel 1 set STOPPED=1
  )
)

if "%STOPPED%"=="1" (
  echo Server gestoppt.
) else (
  echo Kein laufender Overlay-Server gefunden.
)

echo.
pause
