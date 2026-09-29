@echo off
rem One-touch setup (Windows): installs Node.js if needed (asks first), then runs setup.mjs,
rem which finds, installs and logs in the member CLIs and writes config.json.
chcp 65001 >nul
cd /d "%~dp0"
setlocal
title AI 단톡방 설치 도우미

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 없어. 단톡방 서버를 돌리려면 Node.js 22 이상이 필요해.
  goto offer
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 버전이 22보다 낮아. 새 버전이 필요해.
  goto offer
)
goto run

:offer
where winget >nul 2>nul
if errorlevel 1 goto manual
echo.
echo winget으로 Node.js LTS를 설치할 수 있어:
echo   winget install -e --id OpenJS.NodeJS.LTS
choice /c YN /n /m "지금 설치할까? [Y/N] "
if errorlevel 2 goto manual
winget install -e --id OpenJS.NodeJS.LTS
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto again
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto again
echo.
goto run

:again
echo.
echo 설치가 끝났으면 이 창을 닫고 setup.bat을 다시 실행해 줘.
pause
exit /b 1

:manual
echo.
echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 setup.bat을 다시 실행해 줘.
start "" "https://nodejs.org/"
pause
exit /b 1

:run
node setup.mjs %*
echo.
pause
