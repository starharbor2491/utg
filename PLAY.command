#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT=4173
if [ -d "dist" ]; then
  echo "Starting untitled tank game at http://127.0.0.1:${PORT} ..."
  if command -v python3 >/dev/null 2>&1; then
    (sleep 1 && open "http://127.0.0.1:${PORT}") &
    exec python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory dist
  else
    exec npx vite preview --port "${PORT}" --host 127.0.0.1 --open
  fi
else
  echo "Building IRON STEPPE..."
  npm run build
  (sleep 1 && open "http://127.0.0.1:${PORT}") &
  exec python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory dist
fi
