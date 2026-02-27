@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not exist "logs" mkdir "logs"

echo [WT] Cleaning stale processes...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3443" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq WT Server" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq WT Tunnel" /F >nul 2>&1
taskkill /IM cloudflared.exe /F >nul 2>&1

if not exist "node_modules" (
  echo [WT] Installing dependencies...
  call npm install
)

echo [WT] Starting server...
start "WT Server" cmd /k "cd /d "%~dp0" && npm start"

timeout /t 4 /nobreak >nul

echo [WT] Starting tunnel...
set "CFG=%USERPROFILE%\.cloudflared\config.yml"
set "TUNNEL_MODE=quick"

where cloudflared >nul 2>&1
if %errorlevel%==0 (
  if exist "%CFG%" (
    set "TUNNEL_MODE=fixed"
    start "WT Tunnel" cmd /k "cloudflared tunnel --protocol http2 --edge-ip-version 4 --config ""%CFG%"" run"
  )
)

if not "%TUNNEL_MODE%"=="fixed" (
  start "WT Tunnel" cmd /k "cd /d "%~dp0" && npm run tunnel:cf"
)

echo.
echo Warehouse Tracker started.
echo Local URL: https://localhost:3443
if "%TUNNEL_MODE%"=="fixed" (
  echo Mobile URL: check your fixed hostname from Cloudflare config.
) else (
  echo Mobile URL: copy trycloudflare URL from WT Tunnel window.
)
echo.
echo To stop: run stop-tracker.bat
pause
