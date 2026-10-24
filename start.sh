#!/usr/bin/env bash
# Start Podcast Studio with Node (npm start) and open it in the browser once it is ready.
#   ./start.sh                 # http://localhost:3000
#   PORT=3001 ./start.sh       # another port
#   OPEN_BROWSER=0 ./start.sh  # don't open a browser
#   FORCE=1 ./start.sh         # if the port is busy, stop whatever holds it without asking
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
export PORT
# shellcheck source=start-common.sh
source ./start-common.sh

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required: https://nodejs.org/" >&2
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Node.js 18+ is required (found $(node -v))." >&2
  exit 1
fi

rc=0
free_port || rc=$?
if [ "$rc" -eq 2 ]; then open_browser; exit 0; fi
[ "$rc" -eq 0 ] || exit 1

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
