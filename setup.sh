#!/usr/bin/env sh
# One-touch setup (macOS / Linux): checks Node.js 22+ (offers Homebrew on macOS), then runs
# setup.mjs, which finds, installs and logs in the member CLIs and writes config.json.
cd "$(dirname "$0")" || exit 1

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
}

if ! node_ok; then
  echo "Node.js 22 이상이 필요해."
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    printf "Homebrew로 설치할까? (brew install node) [y/N] "
    read -r ans
    case "$ans" in
      y|Y|yes|YES) brew install node ;;
    esac
  fi
  if ! node_ok; then
    echo "https://nodejs.org/en/download 에서 설치한 뒤 ./setup.sh를 다시 실행해 줘."
    exit 1
  fi
fi

exec node setup.mjs "$@"
