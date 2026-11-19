#!/bin/sh
# start.sh — the desk's two local servers, with no inherited DPI_* configuration.
#
# WHY THIS EXISTS (measured 2026-11-18, this host).
# Agent shells here export the hub's DPI_*: DPI_TOKEN, DPI_PORT=4780, DPI_PROVIDER, DPI_HOME,
# DPI_START_DIRS, DPI_HOST, DPI_DEVICE_NAME, DPI_PROVIDERS. The backend reads DPI_TOKEN from the
# environment BEFORE it reads its own env file, and process.loadEnvFile does not override a variable
# that is already set. So a desk backend started in an agent shell authenticates with the HUB's token:
# the desk's own token gets 401 and the hub's gets 200 on the same port. The two-command recipe in
# README.md therefore cannot work as written in any shell that has the hub's environment, which is
# every agent shell here. An isolation that the caller's environment can silently override is not an
# isolation, so this script drops every inherited DPI_* first and the desk's own env file is the only
# source of the desk's configuration.
#
# Usage:  apps/dpi-desk/start.sh          # both servers; Ctrl-C stops both
#         DESK_DPI_HOME=... DESK_ROOT=... apps/dpi-desk/start.sh     # overrides
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

# 1. Drop every inherited DPI_* variable. Nothing the caller exported may configure the desk.
for v in $(env | sed -n 's/^\(DPI_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$v"
done

# 2. The desk's own configuration. DESK_* names survive step 1.
export DPI_HOME="${DESK_DPI_HOME:-$HOME/.dpi-desk}"
export DESK_ROOT="${DESK_ROOT:-$ROOT/fixtures/desk}"
export DPI_PROVIDER=faux
export DPI_PORT=4790
export DESK_PORT=4791

# 3. The shell owns the token: it reads $DPI_HOME/backend.env, or generates one and writes it 0600.
#    It must start first, because the backend exits when it finds no token of its own.
#
#    The shell is TypeScript, so it needs tsx. `node apps/dpi-desk/server.ts` does NOT work: its
#    `import ... from "./static.js"` is not remapped to static.ts, so node exits ERR_MODULE_NOT_FOUND
#    before the server binds. tsx comes from the clone's dpi-backend install; nothing is installed here.
TSX="$ROOT/apps/dpi-backend/node_modules/.bin/tsx"
if [ -x "$TSX" ]; then
  "$TSX" "$ROOT/apps/dpi-desk/server.ts" &
else
  echo "start.sh: no tsx at $TSX — run npm install in the clone first" >&2
  exit 1
fi
SHELL_PID=$!

for _ in $(seq 1 50); do
  [ -f "$DPI_HOME/backend.env" ] && break
  sleep 0.1
done
if [ ! -f "$DPI_HOME/backend.env" ]; then
  echo "start.sh: no token file at $DPI_HOME/backend.env — the shell did not start" >&2
  kill "$SHELL_PID" 2>/dev/null || true
  exit 1
fi

# 4. The desk's own backend.
npm --prefix "$ROOT/apps/dpi-backend" start &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" "$SHELL_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
  wait "$SHELL_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 5. Wait for the backend, then say so. The shell answers /v1 with 502 until it is up.
for _ in $(seq 1 100); do
  if curl -fsS -o /dev/null "http://127.0.0.1:4790/healthz" 2>/dev/null; then
    echo "desk ready on http://127.0.0.1:4791/   (data: $DESK_ROOT)"
    break
  fi
  sleep 0.2
done

wait "$BACKEND_PID" 2>/dev/null || true
