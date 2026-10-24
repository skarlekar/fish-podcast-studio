# Shared helpers for start.sh and start-docker.sh (sourced, not run). Expects PORT and URL to be set.

open_browser() {
  [ "${OPEN_BROWSER:-1}" = "0" ] && return 0
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."
  fi
}

ready() { curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/config" 2>/dev/null; }

# Test lsof's output, not its exit status: it exits non-zero on unrelated warnings (e.g. network mounts).
port_pids() { command -v lsof >/dev/null 2>&1 && lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true; }

# Docker publishes ports through its own backend process, so stop the container, never that process.
port_container() { command -v docker >/dev/null 2>&1 && docker ps --filter "publish=${PORT}" --format '{{.Names}}' 2>/dev/null | head -n 1 || true; }

confirm() {
  [ "${FORCE:-0}" = "1" ] && return 0
  if [ ! -t 0 ]; then
    echo "Not running interactively, so not stopping it. Re-run with FORCE=1 to stop it automatically." >&2
    return 1
  fi
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# Make sure PORT is free. If something holds it, say what and offer to stop it.
# $1 (optional): a container name to replace silently (start-docker.sh's own container).
# Returns 1 if the port stays busy; returns 2 if the user declined but Podcast Studio is already serving there.
free_port() {
  local own_container="${1:-}" container pids
  container="$(port_container)"
  pids="$(port_pids)"
  [ -z "$container" ] && [ -z "$pids" ] && return 0
  [ -n "$container" ] && [ "$container" = "$own_container" ] && return 0

  if [ -n "$container" ]; then
    echo "Port $PORT is in use by Docker container '$container'."
  elif ps -o command= -p "$(echo "$pids" | paste -sd, -)" 2>/dev/null | grep -qiE 'com\.docker|vpnkit|docker-proxy'; then
    echo "Port $PORT is held by Docker, but no running container publishes it. Check Docker Desktop, or try: PORT=3001 $0" >&2
    return 1
  else
    echo "Port $PORT is in use by:"
    ps -o pid=,command= -p "$(echo "$pids" | paste -sd, -)" | sed 's/^/  /'
  fi
  ready && echo "(That is a running Podcast Studio.)"

  if ! confirm "Stop it and start Podcast Studio here?"; then
    if ready; then
      echo "Leaving it running and opening it: $URL"
      return 2
    fi
    echo "Leaving it running. To use another port: PORT=3001 $0" >&2
    return 1
  fi

  if [ -n "$container" ]; then
    echo "Stopping container $container..."
    docker stop "$container" >/dev/null
  else
    echo "Stopping process(es) $(echo "$pids" | paste -sd' ' -)..."
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 20); do [ -z "$(port_pids)" ] && break; sleep 0.25; done
    # shellcheck disable=SC2086
    [ -n "$(port_pids)" ] && kill -9 $(port_pids) 2>/dev/null || true
  fi

  for _ in $(seq 1 20); do
    [ -z "$(port_pids)" ] && [ -z "$(port_container)" ] && return 0
    sleep 0.25
  done
  echo "Port $PORT is still busy (it may belong to another user). Try: PORT=3001 $0" >&2
  return 1
}
