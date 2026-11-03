@echo off
where node >nul 2>nul || (
  echo Node.js 24 LTS (24.22.2 or newer) is required: https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0scripts\native-host\install.mjs" %*
pause
