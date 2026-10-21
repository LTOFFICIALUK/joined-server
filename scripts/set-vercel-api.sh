#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/set-vercel-api.sh <https://api-url>" >&2
  exit 1
fi

api="${1%/}"
if [[ "$api" != https://* ]]; then
  echo "Pass an https URL." >&2
  exit 1
fi

ws="${api/https:/wss:}/stream"
frontend="$(cd "$(dirname "$0")/../../frontend" && pwd)"
scope="avie-lts-projects"
project="joined-frontend"

vercel env add NEXT_PUBLIC_API_URL production --value "$api" --yes --force --no-sensitive --scope "$scope" --cwd "$frontend"
vercel env add NEXT_PUBLIC_WS_URL production --value "$ws" --yes --force --no-sensitive --scope "$scope" --cwd "$frontend"
vercel deploy --prod --yes --project "$project" --scope "$scope" --cwd "$frontend"
