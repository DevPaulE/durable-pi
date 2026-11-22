#!/bin/sh
# start.sh — the desk's two local servers, with no inherited DPI_* configuration.
#
# WHY THIS EXISTS (measured 2026-11-18, this host).
# Agent shells here export the hub's DPI_*: DPI_TOKEN, DPI_PORT=4780, DPI_PROVIDER, DPI_HOME,
# DPI_START_DIRS, DPI_HOST, DPI_DEVICE_NAME, DPI_PROVIDERS. The backend reads DPI_TOKEN from the
# environment BEFORE it reads its own env file, and process.loadEnvFile does not override a variable
# that is already set. So a desk backend started in an agent shell authenticates with the HUB's token:
# the desk's own token gets 401 and the hub's gets 200 on the same port. A recipe that starts the
# backend by hand therefore cannot work as written in any shell that has the hub's environment, which
# is every agent shell here. An isolation that the caller's environment can silently override is not an
# isolation, so this script drops every inherited DPI_* first and the desk's own env file is the only
# source of the desk's configuration.
#
# Usage:  apps/dpi-desk/start.sh          # both servers; Ctrl-C stops both
#         DESK_DPI_HOME=... DESK_ROOT=... apps/dpi-desk/start.sh     # overrides
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

# 0. Refuse to start a desk somebody else is already running. `desk ready` was printed from a bare 200
#    on 4790, so it appeared while a foreign process answered /healthz there (L1-5a), while the shell
#    was dead with 4791 held by another process (L1-5b), and for a second start.sh beside a running
#    desk (L4-4). Both ports are therefore checked before anything binds: a held port is named, with
#    the holder, as the first line, and the script exits non-zero having started nothing at all.
DESK_BACKEND_PORT=4790
DESK_SHELL_PORT=4791

port_holder() { # port_holder <port> -> "pid command"; prints nothing when the port is free
  command -v lsof >/dev/null 2>&1 || return 0
  pid=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1)
  [ -n "$pid" ] || return 0
  printf '%s %s' "$pid" "$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-120)"
}

for port in $DESK_BACKEND_PORT $DESK_SHELL_PORT; do
  held=$(port_holder "$port")
  if [ -n "$held" ]; then
    printf '%s\n' "start.sh: port $port is already held by pid $held"
    printf '%s\n' "start.sh: the desk is already running, or another process holds this port. Stop it and re-run; nothing was started." >&2
    exit 1
  fi
done

# 1. Drop every inherited DPI_* variable. Nothing the caller exported may configure the desk.
for v in $(env | sed -n 's/^\(DPI_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$v"
done

# 2. The desk's own configuration. DESK_* names survive step 1.
export DPI_HOME="${DESK_DPI_HOME:-$HOME/.dpi-desk}"
export DESK_ROOT="${DESK_ROOT:-$ROOT/fixtures/desk}"
export DPI_PORT=$DESK_BACKEND_PORT
export DESK_PORT=$DESK_SHELL_PORT

# 2a. Provider credentials come from the desk's own env file only, never the caller's shell. The
#     backend loads $DPI_HOME/backend.env itself, but process.loadEnvFile does not override a
#     variable that is already set — so an inherited provider key would beat the file. Drop them
#     here, exactly as step 1 drops DPI_*, and let the file be the only source.
for v in OPENROUTER_API_KEY RADIUS_API_KEY OLLAMA_API_KEY OLLAMA_BASE_URL OLLAMA_DEFAULT_MODEL; do
  unset "$v" 2>/dev/null || true
done

# 2b. Provider: the file's own if it names one, otherwise the default stays faux (G55). Never
#     exported from the caller's shell. When the file names DPI_PROVIDER we leave it unset here so
#     that the backend's loadEnvFile is what sets it; setting it ourselves is what would pin faux.
if [ -f "$DPI_HOME/backend.env" ] && grep -qE '^[[:space:]]*DPI_PROVIDER=' "$DPI_HOME/backend.env"; then
  :
else
  export DPI_PROVIDER=faux
fi

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

# 5. Wait for this desk, then say so — and say nothing unless it is true. "Ready" means the two
#    processes this script started are both alive AND both answering: the shell serves `/` on 4791
#    and the backend answers /healthz on 4790. Both ports were free a moment ago (step 0) and these
#    are the processes that took them, so a 200 here is ours; a dead child is the end of the wait,
#    never a reason to keep polling. If the desk does not come up, the script exits non-zero without
#    ever printing the word ready.
ready=0
for _ in $(seq 1 100); do
  if kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$SHELL_PID" 2>/dev/null \
     && curl -fsS -o /dev/null "http://127.0.0.1:$DESK_BACKEND_PORT/healthz" 2>/dev/null \
     && curl -fsS -o /dev/null "http://127.0.0.1:$DESK_SHELL_PORT/" 2>/dev/null; then
    ready=1
    break
  fi
  kill -0 "$BACKEND_PID" 2>/dev/null || break
  sleep 0.2
done

if [ "$ready" -eq 1 ]; then
  echo "desk ready on http://127.0.0.1:$DESK_SHELL_PORT/   (data: $DESK_ROOT)"
else
  echo "start.sh: the desk did not come up — its shell and backend must both answer before this script says ready." >&2
  echo "start.sh: see the lines above from the shell and the backend for why." >&2
  exit 1
fi

wait "$BACKEND_PID" 2>/dev/null || true
