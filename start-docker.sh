#!/usr/bin/env bash
# Build the Podcast Studio image, (re)start its container, and open the app in the browser.
#   ./start-docker.sh                 # http://localhost:3000
#   PORT=3001 ./start-docker.sh       # another host port
#   OPEN_BROWSER=0 ./start-docker.sh  # don't open a browser
# Stop it with:  docker stop podcast-studio     Logs:  docker logs -f podcast-studio
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
IMAGE="${IMAGE:-podcast-studio}"
NAME="${CONTAINER_NAME:-podcast-studio}"

open_browser() {
  [ "${OPEN_BROWSER:-1}" = "0" ] && return 0
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."
  fi
}

ready() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/config" 2>/dev/null; }

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/get-docker/" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop and try again." >&2
  exit 1
fi

echo "Building image ${IMAGE}..."
docker build -t "$IMAGE" .

# Replace any previous container of the same name, then make sure the port is free.
docker rm -f "$NAME" >/dev/null 2>&1 || true
# Test lsof's output, not its exit status: it exits non-zero on unrelated warnings (e.g. network mounts).
if command -v lsof >/dev/null 2>&1 && [ -n "$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "Port $PORT is already in use (is ./start.sh or npm start running?). Stop it, or try: PORT=3001 ./start-docker.sh" >&2
  exit 1
fi

# Keys and episodes live on the host. .env must exist as a file, or Docker would mount an empty directory in its place.
mkdir -p output
if [ ! -e .env ]; then
  touch .env
  chmod 600 .env
fi

echo "Starting container ${NAME}..."
docker run -d \
  --name "$NAME" \
  --user "$(id -u):$(id -g)" \
  -p "127.0.0.1:${PORT}:3000" \
  -v "$PWD/.env:/app/.env" \
  -v "$PWD/output:/app/output" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if ready; then
    echo "Podcast Studio is running at $URL (container: $NAME)"
    echo "  Logs: docker logs -f $NAME    Stop: docker stop $NAME"
    open_browser
    exit 0
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then break; fi
  sleep 0.5
done

echo "Podcast Studio did not come up. Container logs:" >&2
docker logs "$NAME" >&2 || true
exit 1
