#!/usr/bin/env sh
# Start the AI chat room server (macOS / Linux) and open it in the browser.
# Ctrl+C stops the room. First time? Run ./setup.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  case "${LC_ALL:-${LC_MESSAGES:-$LANG}}" in
    ko*) echo "Node.js를 찾을 수 없어. 처음이라면 ./setup.sh를 먼저 실행해 줘." ;;
    ja*) echo "Node.jsが見つからないよ。初めてなら、先に./setup.shを実行してね。" ;;
    *) echo "Node.js wasn't found. First time here? Run ./setup.sh first." ;;
  esac
  exit 1
fi
exec node server.mjs --open "$@"
