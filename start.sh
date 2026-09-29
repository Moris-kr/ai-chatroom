#!/usr/bin/env sh
# Start the AI chat room server (macOS / Linux). Then open http://localhost:8321
# (or the port set in config.json). Ctrl+C stops the room.
cd "$(dirname "$0")" || exit 1
exec node server.mjs
