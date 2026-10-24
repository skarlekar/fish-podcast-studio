#!/usr/bin/env bash
# Start Podcast Studio with Node (npm start) and open it in the browser once it is ready.
#   ./start.sh                 # http://localhost:3000
#   PORT=3001 ./start.sh       # another port
#   OPEN_BROWSER=0 ./start.sh  # don't open a browser
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
export PORT

open_browser() {
  [ "${OPEN_BROWSER:-1}" = "0" ] && return 0
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."
  fi
}

ready() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/config" 2>/dev/null; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org/" >&2
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node -v))." >&2
  exit 1
fi

if ready; then
  echo "Podcast Studio is already running at $URL"
  open_browser
  exit 0
fi
# Test lsof's output, not its exit status: it exits non-zero on unrelated warnings (e.g. network mounts).
if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "Port $PORT is in use by another program. Try: PORT=3001 ./start.sh" >&2
  exit 1
fi

# Wait for the server in the background, then open the browser; the server itself runs in the foreground.
(
  for _ in $(seq 1 60); do
    if ready; then open_browser; exit 0; fi
    sleep 0.5
  done
  echo "Podcast Studio did not answer on $URL within 30 seconds." >&2
) &
waiter=$!
trap 'kill "$waiter" 2>/dev/null || true' EXIT

npm start
