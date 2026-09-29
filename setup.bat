@echo off
rem One-touch setup (Windows): installs Node.js if needed (asks first), then runs setup.mjs,
rem which picks the room language, finds, installs and logs in the member CLIs and writes
rem config.json. The messages here follow the Windows display language (ko / ja / else en).
chcp 65001 >nul
cd /d "%~dp0"
setlocal

set "LNG=en"
for /f "delims=" %%L in ('powershell -NoProfile -Command "(Get-Culture).TwoLetterISOLanguageName" 2^>nul') do set "LNG=%%L"
if /i not "%LNG%"=="ko" if /i not "%LNG%"=="ja" set "LNG=en"
goto text_%LNG%

:text_ko
set "T_TITLE=AI 단톡방 설치 도우미"
set "T_NONODE=Node.js가 없어. 단톡방 서버를 돌리려면 Node.js 22 이상이 필요해."
set "T_OLDNODE=Node.js 버전이 22보다 낮아. 새 버전이 필요해."
set "T_WINGET=winget으로 Node.js LTS를 설치할 수 있어:"
set "T_ASK=지금 설치할까?"
set "T_AGAIN=설치가 끝났으면 이 창을 닫고 setup.bat을 다시 실행해 줘."
set "T_MANUAL=https://nodejs.org 에서 LTS 버전을 설치한 뒤 setup.bat을 다시 실행해 줘."
goto text_done

:text_ja
set "T_TITLE=AIグループチャット セットアップ"
set "T_NONODE=Node.jsが見つからないよ。ルームのサーバーを動かすにはNode.js 22以上が必要。"
set "T_OLDNODE=Node.jsのバージョンが22より古いよ。新しいバージョンが必要。"
set "T_WINGET=wingetでNode.js LTSをインストールできるよ:"
set "T_ASK=今インストールする？"
set "T_AGAIN=インストールが終わったら、このウィンドウを閉じてsetup.batをもう一度実行してね。"
set "T_MANUAL=https://nodejs.org からLTS版をインストールしてから、setup.batをもう一度実行してね。"
goto text_done

:text_en
set "T_TITLE=AI Group Chat setup"
set "T_NONODE=Node.js isn't installed. The room server needs Node.js 22 or newer."
set "T_OLDNODE=Your Node.js is older than 22. A newer version is needed."
set "T_WINGET=Node.js LTS can be installed with winget:"
set "T_ASK=Install it now?"
set "T_AGAIN=Once it's installed, close this window and run setup.bat again."
set "T_MANUAL=Install the LTS version from https://nodejs.org, then run setup.bat again."

:text_done
title %T_TITLE%

rem Messages are echoed outside ( ) blocks: %T_...% expands before a block is parsed, so text
rem with parentheses would break it.
where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto oldnode
goto run

:nonode
echo %T_NONODE%
goto offer

:oldnode
echo %T_OLDNODE%
goto offer

:offer
where winget >nul 2>nul
if errorlevel 1 goto manual
echo.
echo %T_WINGET%
echo   winget install -e --id OpenJS.NodeJS.LTS
choice /c YN /n /m "%T_ASK% [Y/N] "
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
echo %T_AGAIN%
pause
exit /b 1

:manual
echo.
echo %T_MANUAL%
start "" "https://nodejs.org/"
pause
exit /b 1

:run
node setup.mjs %*
echo.
pause
