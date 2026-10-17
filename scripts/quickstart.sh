#!/usr/bin/env bash
# GameSaloon quickstart (Linux/macOS/WSL). Needs Node >= 22.18 and git (unless run inside a checkout).
#   curl -fsSL <raw-url>/scripts/quickstart.sh | GAMESALOON_REPO=<git-url> bash
# Env: GAMESALOON_REPO (clone source, needed outside a checkout), GAMESALOON_DIR (default ./gamesaloon), PORT (default 8787).
set -euo pipefail
PORT="${PORT:-8787}"
command -v node >/dev/null || { echo "Node >= 22.18 is required (https://nodejs.org)"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a==22&&b>=18)?0:1)' \
  || { echo "Node >= 22.18 required, found $(node -v)"; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/../package.json" ] && [ -d "$here/../src" ]; then
  cd "$here/.."
else
  : "${GAMESALOON_REPO:?set GAMESALOON_REPO to the git url}"
  dir="${GAMESALOON_DIR:-gamesaloon}"
  [ -d "$dir/.git" ] || git clone --depth 1 "$GAMESALOON_REPO" "$dir"
  cd "$dir"
fi

npm install --no-audit --no-fund
npm run build
PORT="$PORT" node dist/main.js &
pid=$!
trap 'kill $pid 2>/dev/null || true' INT TERM
for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Health: $(curl -fs http://127.0.0.1:$PORT/health)"
    echo "GameSaloon is up: ws://127.0.0.1:$PORT/ws   (Ctrl+C to stop)"
    echo "Try: node examples/hello-client.mjs ws://127.0.0.1:$PORT/ws"
    wait $pid
    exit $?
  fi
  kill -0 $pid 2>/dev/null || { echo "server exited"; exit 1; }
  sleep 1
done
echo "health check failed"; kill $pid; exit 1
