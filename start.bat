@echo off
rem Start the AI chat room server and open it in the browser. Closing this window stops the room.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node server.mjs --open
if errorlevel 1 pause
exit /b

rem No Node.js: say so in the Windows display language (ko / ja / else en).
:nonode
setlocal
set "LNG=en"
for /f "delims=" %%L in ('powershell -NoProfile -Command "(Get-Culture).TwoLetterISOLanguageName" 2^>nul') do set "LNG=%%L"
if /i "%LNG%"=="ko" echo Node.js를 찾을 수 없어. 처음이라면 setup.bat을 먼저 실행해 줘.
if /i "%LNG%"=="ja" echo Node.jsが見つからないよ。初めてなら、先にsetup.batを実行してね。
if /i not "%LNG%"=="ko" if /i not "%LNG%"=="ja" echo Node.js wasn't found. First time here? Run setup.bat first.
pause
exit /b 1
