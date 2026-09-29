@echo off
rem Start the AI chat room server and open it in the browser. Closing this window stops the room.
chcp 65001 >nul
cd /d "%~dp0"
start "" /min powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://localhost:8321'"
node server.mjs
