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
#   LLM_API_KEY   — provider API key (or AICORE_SERVICE_KEY for sap-ai-sdk)
#   LLM_MODEL     — model name as the provider expects
#
# Optional:
#   MCP_ENDPOINT  — MCP server URL (default: none)
#   PORT          — llm-agent port (default: 4004)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present (safe parsing — handles special chars in values)
if [[ -f "$PROJECT_DIR/.env" ]]; then
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    # Trim whitespace
    key="$(echo "$key" | xargs)"
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

cleanup() {
  if [[ -n "$AGENT_PID" ]]; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Start llm-agent in background
echo "Starting llm-agent on port $PORT..."
cd "$PROJECT_DIR"
npx llm-agent &
AGENT_PID=$!

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

echo "llm-agent ready. Launching Claude CLI..."
echo ""

# Launch Claude CLI pointing to llm-agent
# Note: do NOT set ANTHROPIC_API_KEY — it conflicts with claude.ai login.
# llm-agent does not validate the auth header; Claude CLI uses its own token.
ANTHROPIC_BASE_URL="http://localhost:$PORT" \
  claude "$@"
