#!/usr/bin/env sh
# One-touch setup (macOS / Linux): checks Node.js 22+ (offers Homebrew on macOS), then runs
# setup.mjs, which picks the room language, finds, installs and logs in the member CLIs and
# writes config.json. The messages here follow the system language (ko / ja / else en).
cd "$(dirname "$0")" || exit 1

case "${LC_ALL:-${LC_MESSAGES:-$LANG}}" in
  ko*)
    T_NEED="Node.js 22 이상이 필요해."
    T_BREW="Homebrew로 설치할까? (brew install node) [y/N] "
    T_MANUAL="https://nodejs.org/en/download 에서 설치한 뒤 ./setup.sh를 다시 실행해 줘."
    ;;
  ja*)
    T_NEED="Node.js 22以上が必要だよ。"
    T_BREW="Homebrewでインストールする？ (brew install node) [y/N] "
    T_MANUAL="https://nodejs.org/en/download からインストールしてから、./setup.shをもう一度実行してね。"
    ;;
  *)
    T_NEED="Node.js 22 or newer is needed."
    T_BREW="Install it with Homebrew? (brew install node) [y/N] "
    T_MANUAL="Install it from https://nodejs.org/en/download, then run ./setup.sh again."
    ;;
esac

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
}

if ! node_ok; then
  echo "$T_NEED"
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    printf "%s" "$T_BREW"
    read -r ans
    case "$ans" in
      y|Y|yes|YES|예|네|응|ㅛ|はい|うん) brew install node ;;
    esac
  fi
  if ! node_ok; then
    echo "$T_MANUAL"
    exit 1
  fi
fi

exec node setup.mjs "$@"
