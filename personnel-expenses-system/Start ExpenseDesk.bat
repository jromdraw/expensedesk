@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not on PATH.
  echo Install Node.js 22.5 or later, then run this file again.
  pause
  exit /b 1
)
echo Starting ExpenseDesk...
start "ExpenseDesk Server" /D "%~dp0" cmd /k npm start
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"
endlocal
