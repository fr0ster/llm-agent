#!/usr/bin/env bash
# Launch Claude CLI through llm-agent SmartServer.
#
# The server starts in the background, Claude CLI connects via ANTHROPIC_BASE_URL,
# and the server stops when Claude exits.
#
# Usage:
#   ./tools/claude-via-agent.sh                  # uses defaults from .env
#   LLM_MODEL=gpt-4o ./tools/claude-via-agent.sh # override model
#
# Required environment (set in .env or export before running):
#   LLM_PROVIDER  — openai | anthropic | deepseek | sap-ai-sdk
#   LLM_MODEL     — model name as the provider expects
#
# For API key providers (openai, anthropic, deepseek):
#   LLM_API_KEY   — provider API key
#
# For SAP AI Core (sap-ai-sdk):
#   AICORE_CLIENT_ID      — OAuth2 client ID
#   AICORE_CLIENT_SECRET  — OAuth2 client secret
#   AICORE_AUTH_URL       — OAuth2 token endpoint base URL
#   AICORE_BASE_URL       — SAP AI Core API base URL
#
# Optional:
#   MCP_ENDPOINT  — MCP server URL (default: none)
#   PORT          — llm-agent port (default: 4004)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present (safe parsing — handles special chars and trailing = in values)
if [[ -f "$PROJECT_DIR/.env" ]]; then
  while IFS= read -r line; do
    # Skip comments and blank lines
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Split on first = only
    key="${line%%=*}"
    value="${line#*=}"
    # Trim whitespace from key
    key="$(echo "$key" | xargs)"
    [[ -z "$key" ]] && continue
    # Strip surrounding quotes from value
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    export "$key=$value"
  done < "$PROJECT_DIR/.env"
fi

PORT="${PORT:-4004}"
AGENT_PID=""
AGENT_STARTED_BY_US=false

# For sap-ai-sdk: build AICORE_SERVICE_KEY JSON from separate env vars
# (SAP AI SDK reads this single JSON env var for auth)
# Uses printf to avoid bash interpreting $ and ! in credentials
if [[ "${LLM_PROVIDER:-}" == "sap-ai-sdk" && -z "${AICORE_SERVICE_KEY:-}" ]]; then
  if [[ -n "${AICORE_CLIENT_ID:-}" && -n "${AICORE_CLIENT_SECRET:-}" && -n "${AICORE_AUTH_URL:-}" && -n "${AICORE_BASE_URL:-}" ]]; then
    AICORE_SERVICE_KEY=$(printf '{"clientid":"%s","clientsecret":"%s","url":"%s","serviceurls":{"AI_API_URL":"%s"}}' \
      "$AICORE_CLIENT_ID" "$AICORE_CLIENT_SECRET" "$AICORE_AUTH_URL" "$AICORE_BASE_URL")
    export AICORE_SERVICE_KEY
  fi
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
  # Start llm-agent in background
  echo "Starting llm-agent on port $PORT..."
  cd "$PROJECT_DIR"
  npx llm-agent &
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
# If no login, set a placeholder key so Claude CLI accepts the connection.
CLAUDE_AUTH_FILE="${HOME}/.claude/.credentials.json"
if [[ -f "$CLAUDE_AUTH_FILE" ]] && grep -q "accessToken" "$CLAUDE_AUTH_FILE" 2>/dev/null; then
  unset ANTHROPIC_API_KEY 2>/dev/null || true
else
  export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-placeholder}"
fi

ANTHROPIC_BASE_URL="http://localhost:$PORT" \
  claude "$@"
