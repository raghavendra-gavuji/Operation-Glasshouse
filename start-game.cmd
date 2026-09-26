@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\tsx\dist\cli.mjs" (
  echo Installing Operation Glasshouse dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo Dependency installation failed. Check the error above.
    pause
    exit /b 1
  )
)
set PORT=4317
echo.
echo Operation Glasshouse will be available at http://127.0.0.1:4317
echo Keep this window open while you play. Press Ctrl+C to stop.
echo.
call npm.cmd run dev
if errorlevel 1 (
  echo The game server stopped with an error. Check whether port 4317 is already in use.
  pause
  exit /b 1
)
