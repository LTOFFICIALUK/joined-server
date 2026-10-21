#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
runtime="${TMPDIR:-/tmp}/joined-dev"
mkdir -p "$runtime"

if ! pg_isready -q; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Postgres is not running." >&2
    exit 1
  fi
  if brew list --versions postgresql@16 >/dev/null 2>&1; then
    brew services start postgresql@16
  elif brew list --versions postgresql@14 >/dev/null 2>&1; then
    brew services start postgresql@14
  elif brew list --versions postgresql >/dev/null 2>&1; then
    brew services start postgresql
  else
    brew install postgresql@16
    brew services start postgresql@16
  fi
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if pg_isready -q; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "Postgres did not start." >&2
    exit 1
  fi
fi

if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'joined'" | grep -q 1; then
  createdb joined
fi

if [[ ! -f .env ]]; then
  umask 077
  secret="$(openssl rand -hex 32)"
  cat > .env <<EOF
PORT=8080
DATABASE_URL=postgresql://$(whoami)@127.0.0.1:5432/joined
CORS_ORIGIN=https://joined.fun,https://www.joined.fun,http://localhost:3000
SESSION_SECRET=${secret}
HL_INFO_URL=https://api.hyperliquid.xyz/info
HL_WS_URL=wss://api.hyperliquid.xyz/ws
ONECLICK_JWT=
ONECLICK_BASE_URL=https://1click.chaindefuser.com
ONECLICK_CONFIDENTIAL_JWT=
ONECLICK_CONFIDENTIAL_BASE_URL=
SOLANA_RPC=https://api.mainnet-beta.solana.com
ARB_RPC=https://arb1.arbitrum.io/rpc
ARB_RELAYER_KEY=
HOUSE_HL_KEY=
ADMIN_KEY=
EOF
  unset secret
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

db_schema="$(cd "$root/../database" && pwd)/prisma/schema.prisma"
npx prisma migrate deploy --schema "$db_schema" >/dev/null

port="${PORT:-8080}"
if [[ -f "$runtime/server.pid" ]]; then
  old="$(cat "$runtime/server.pid" || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 0.4
  fi
fi
listener="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -n "$listener" ]]; then
  command_line="$(ps -p "$listener" -o command= || true)"
  if [[ "$command_line" == *"src/index.ts"* || "$command_line" == *"dist/index.js"* ]]; then
    kill "$listener" 2>/dev/null || true
    sleep 0.4
  else
    echo "Port ${port} is already in use." >&2
    exit 1
  fi
fi

if [[ -f "$runtime/tunnel.pid" ]]; then
  old="$(cat "$runtime/tunnel.pid" || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 0.3
  fi
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  brew install cloudflared
fi

: > "$runtime/server.log"
nohup node --env-file="$root/.env" --import tsx "$root/src/index.ts" >>"$runtime/server.log" 2>&1 &
echo $! > "$runtime/server.pid"

up=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    up=1
    break
  fi
  if ! kill -0 "$(cat "$runtime/server.pid")" 2>/dev/null; then
    echo "Server exited before it was healthy." >&2
    exit 1
  fi
  sleep 0.5
done
if [[ "$up" -ne 1 ]]; then
  echo "Server did not become healthy." >&2
  exit 1
fi

: > "$runtime/tunnel.log"
nohup cloudflared tunnel --url "http://127.0.0.1:${port}" >>"$runtime/tunnel.log" 2>&1 &
echo $! > "$runtime/tunnel.pid"

url=""
for _ in $(seq 1 40); do
  url="$(grep -oE 'https://[-a-z0-9]+\.trycloudflare\.com' "$runtime/tunnel.log" | head -n 1 || true)"
  if [[ -n "$url" ]]; then
    break
  fi
  if ! kill -0 "$(cat "$runtime/tunnel.pid")" 2>/dev/null; then
    echo "Tunnel exited." >&2
    exit 1
  fi
  sleep 0.5
done
if [[ -z "$url" ]]; then
  echo "Tunnel did not print a URL." >&2
  exit 1
fi

echo "$url"
echo "WebSocket: ${url/https:/wss:}/stream"
echo "Point joined.fun at it with: scripts/set-vercel-api.sh ${url}"
