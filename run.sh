#!/usr/bin/env bash
# Installs dependencies, builds, and starts the group chat.
# Usage: ./run.sh          real models (needs OPENAI_API_KEY in .env)
#        ./run.sh --fake   scripted fake models, no API key needed
set -euo pipefail
cd "$(dirname "$0")"

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( node_major < 22 )); then
  echo "Node 22 or newer is required (found: $(node -v 2>/dev/null || echo none))." >&2
  exit 1
fi

if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "Installing dependencies..."
  npm ci
fi

[[ -f .env ]] || cp .env.example .env

if [[ "${1:-}" == "--fake" ]]; then
  export MODEL_AGENT=fake:x MODEL_GATE=fake:x MODEL_CLASSIFIER=fake:x FAKE_SCRIPT=e2e
  echo "Using scripted fake models."
elif ! grep -Eq '^OPENAI_API_KEY=.+' .env; then
  echo "OPENAI_API_KEY is not set in .env. Add it, or run ./run.sh --fake." >&2
  exit 1
fi

echo "Building..."
npm run build
mkdir -p data

echo "Starting on http://localhost:${PORT:-8080}"
exec npm start
