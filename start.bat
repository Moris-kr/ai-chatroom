@echo off
rem Start the AI chat room server and open it in the browser. Closing this window stops the room.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js를 찾을 수 없어. 처음이라면 setup.bat을 먼저 실행해 줘.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
