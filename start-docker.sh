#!/usr/bin/env bash
# Build the Podcast Studio image, (re)start its container, and open the app in the browser.
#   ./start-docker.sh                 # http://localhost:3000
#   PORT=3001 ./start-docker.sh       # another host port
#   OPEN_BROWSER=0 ./start-docker.sh  # don't open a browser
#   FORCE=1 ./start-docker.sh         # if the port is busy, stop whatever holds it without asking
# Stop it with:  docker stop podcast-studio     Logs:  docker logs -f podcast-studio
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"
IMAGE="${IMAGE:-podcast-studio}"
NAME="${CONTAINER_NAME:-podcast-studio}"
# shellcheck source=start-common.sh
source ./start-common.sh

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/get-docker/" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop and try again." >&2
  exit 1
fi

# Check the port before the build. This script's own container is replaced below without asking.
rc=0
free_port "$NAME" || rc=$?
if [ "$rc" -eq 2 ]; then open_browser; exit 0; fi
[ "$rc" -eq 0 ] || exit 1

echo "Building image ${IMAGE}..."
docker build -t "$IMAGE" .
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Keys and episodes live on the host. .env must exist as a file, or Docker would mount an empty directory in its place.
mkdir -p output
if [ ! -e .env ]; then
  touch .env
  chmod 600 .env
fi

echo "Starting container ${NAME}..."
# --init forwards SIGTERM to node (as PID 1 it would ignore it), so `docker stop` takes a moment, not 10 s.
docker run -d --init \
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
