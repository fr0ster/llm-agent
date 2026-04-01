#!/usr/bin/env bash
# Launch Claude CLI through llm-agent SmartServer.
#
# The server starts in the background, Claude CLI connects via ANTHROPIC_BASE_URL,
# and the server stops when Claude exits.
#
# Usage:
#   ./tools/claude-via-agent.sh                  # uses defaults from .env
#   ./tools/claude-via-agent.sh --config pipelines/deepseek.yaml
#
# Environment (set in .env or .env.aicore or export before running):
#   LLM_PROVIDER  — selects pipeline: pipelines/<provider>.yaml
#
# For deepseek/openai:
#   DEEPSEEK_API_KEY or OPENAI_API_KEY
#
# For SAP AI Core:
#   AICORE_CLIENT_ID, AICORE_CLIENT_SECRET, AICORE_AUTH_URL, AICORE_BASE_URL
#
# Optional:
#   MCP_ENDPOINT  — MCP server URL
#   PORT          — llm-agent port (default: 4004)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load env files (safe parsing — handles special chars and trailing = in values)
load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return
  while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    local key="${line%%=*}"
    local value="${line#*=}"
    key="$(echo "$key" | xargs)"
    [[ -z "$key" ]] && continue
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    export "$key=$value"
  done < "$file"
}

load_env_file "$PROJECT_DIR/.env"

# Load provider-specific env file if present
PROVIDER="${LLM_PROVIDER:-}"
[[ -z "$PROVIDER" ]] && PROVIDER=$(grep "^LLM_PROVIDER=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2)
case "$PROVIDER" in
  sap-ai-sdk) load_env_file "$PROJECT_DIR/.env.aicore" ;;
  deepseek)   load_env_file "$PROJECT_DIR/.env.deepseek" ;;
  openai)     load_env_file "$PROJECT_DIR/.env.openai" ;;
  anthropic)  load_env_file "$PROJECT_DIR/.env.anthropic" ;;
esac

PORT="${PORT:-4004}"
AGENT_PID=""
AGENT_STARTED_BY_US=false

# For sap-ai-sdk: build AICORE_SERVICE_KEY JSON from separate env vars
if [[ "${LLM_PROVIDER:-}" == "sap-ai-sdk" && -z "${AICORE_SERVICE_KEY:-}" ]]; then
  if [[ -n "${AICORE_CLIENT_ID:-}" && -n "${AICORE_CLIENT_SECRET:-}" && -n "${AICORE_AUTH_URL:-}" && -n "${AICORE_BASE_URL:-}" ]]; then
    AICORE_SERVICE_KEY=$(printf '{"clientid":"%s","clientsecret":"%s","url":"%s","serviceurls":{"AI_API_URL":"%s"}}' \
      "$AICORE_CLIENT_ID" "$AICORE_CLIENT_SECRET" "$AICORE_AUTH_URL" "$AICORE_BASE_URL")
    export AICORE_SERVICE_KEY
  fi
fi

# Select pipeline config: explicit --config, or by LLM_PROVIDER, or default smart-server.yaml
CONFIG=""
if [[ "${1:-}" == "--config" && -n "${2:-}" ]]; then
  CONFIG="$2"
  shift 2
elif [[ -f "$PROJECT_DIR/pipelines/${LLM_PROVIDER:-}.yaml" ]]; then
  CONFIG="pipelines/${LLM_PROVIDER}.yaml"
fi

cleanup() {
  if [[ "$AGENT_STARTED_BY_US" == true && -n "$AGENT_PID" ]]; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Check if llm-agent is already running on this port
if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 || \
   curl -sf "http://localhost:$PORT/v1/models" >/dev/null 2>&1; then
  echo "llm-agent already running on port $PORT, reusing..."
else
  echo "Starting llm-agent on port $PORT..."
  [[ -n "$CONFIG" ]] && echo "Pipeline: $CONFIG"
  cd "$PROJECT_DIR"

  if [[ -n "$CONFIG" ]]; then
    npx llm-agent --config "$CONFIG" &
  else
    npx llm-agent &
  fi
  AGENT_PID=$!
  AGENT_STARTED_BY_US=true

  # Wait for server to be ready
  for i in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 || \
       curl -sf "http://localhost:$PORT/v1/models" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
      echo "Error: llm-agent failed to start" >&2
      exit 1
    fi
    sleep 1
  done

  if ! kill -0 "$AGENT_PID" 2>/dev/null; then
    echo "Error: llm-agent exited unexpectedly" >&2
    exit 1
  fi
fi

echo "llm-agent ready. Launching Claude CLI..."
echo ""

# Claude CLI auth: if logged into claude.ai, do not set ANTHROPIC_API_KEY (conflicts).
CLAUDE_AUTH_FILE="${HOME}/.claude/.credentials.json"
if [[ -f "$CLAUDE_AUTH_FILE" ]] && grep -q "accessToken" "$CLAUDE_AUTH_FILE" 2>/dev/null; then
  unset ANTHROPIC_API_KEY 2>/dev/null || true
else
  export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-placeholder}"
fi

ANTHROPIC_BASE_URL="http://localhost:$PORT" \
  claude "$@"
