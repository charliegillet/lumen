#!/usr/bin/env bash
# Installs dependencies, builds, and starts the group chat.
# Usage: ./run.sh          real models (each provider needs its API key, from the environment or .env)
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
  # The key each provider named in a MODEL_* setting needs.
  for k in MODEL_AGENT MODEL_AGENT_MAYA MODEL_AGENT_THEO MODEL_AGENT_PRIYA MODEL_GATE MODEL_CLASSIFIER; do
    default=openai:; [[ "$k" == MODEL_AGENT_* ]] && default=""
    spec="$(setting "$k" "$default")"
    case "$spec" in
      openai:*) key=OPENAI_API_KEY ;;
      anthropic:*) key=ANTHROPIC_API_KEY ;;
      google:*) key=GOOGLE_GENERATIVE_AI_API_KEY ;;
      *) continue ;;
    esac
    if [[ -z "$(setting "$key" '')" ]]; then
      echo "$key is not set (environment or .env) but $k=$spec needs it. Add it, or run ./run.sh --fake." >&2
      exit 1
    fi
  done
fi

echo "Building..."
npm run build
mkdir -p data

echo "Starting on http://localhost:${PORT:-8080}"
exec npm start
