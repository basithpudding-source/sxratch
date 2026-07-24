@echo off
title SXRATCH dev server
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js is required to run the server — install it from https://nodejs.org
  pause
  exit /b 1
)

echo.
echo   SXRATCH / PAD — dev server
echo   Serving at  http://localhost:5173
echo   Phone on the same Wi-Fi: http://YOUR-PC-IP:5173
echo.
echo   Keep this window open while you play. Close it to stop the server.
echo.

rem Open the browser once the server has had a moment to come up.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:5173"

node server.js
