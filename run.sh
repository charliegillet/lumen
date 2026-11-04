#!/usr/bin/env bash
# Installs dependencies, builds, and starts the group chat.
# Usage: ./run.sh          real models (OpenAI ones need OPENAI_API_KEY, from the environment or .env)
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

# A setting from the environment, else from .env (quotes stripped), else $2.
setting() {
  local v="${!1:-}"
  if [[ -z "$v" ]]; then
    v=$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  fi
  echo "${v:-$2}"
}

if [[ "${1:-}" == "--fake" ]]; then
  export MODEL_AGENT=fake:x MODEL_GATE=fake:x MODEL_CLASSIFIER=fake:x FAKE_SCRIPT=e2e
  echo "Using scripted fake models."
else
  needs_openai=0
  for k in MODEL_AGENT MODEL_GATE MODEL_CLASSIFIER; do
    [[ "$(setting "$k" openai:)" == openai:* ]] && needs_openai=1
  done
  if (( needs_openai )) && [[ -z "$(setting OPENAI_API_KEY '')" ]]; then
    echo "OPENAI_API_KEY is not set (environment or .env). Add it, or run ./run.sh --fake." >&2
    exit 1
  fi
fi

echo "Building..."
npm run build
mkdir -p data

echo "Starting on http://localhost:${PORT:-8080}"
exec npm start
