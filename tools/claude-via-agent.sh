#!/usr/bin/env bash
# Launch Claude CLI through llm-agent SmartServer.
#
# Usage:
#   ./tools/claude-via-agent.sh                               # auto-selects pipeline by LLM_PROVIDER
#   ./tools/claude-via-agent.sh --config pipelines/deepseek.yaml  # explicit pipeline
#
# All credentials in .env:
#   LLM_PROVIDER       — selects pipeline: pipelines/<provider>.yaml
#   DEEPSEEK_API_KEY   — for deepseek pipeline
#   AICORE_SERVICE_KEY — for sap-ai-core pipeline (JSON)
#   MCP_ENDPOINT       — MCP server URL (optional)
#   PORT               — llm-agent port (default: 4004)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PORT="${PORT:-4004}"
AGENT_PID=""
AGENT_STARTED_BY_US=false

# Select pipeline config: explicit --config, or by LLM_PROVIDER from env/.env
CONFIG=""
if [[ "${1:-}" == "--config" && -n "${2:-}" ]]; then
  CONFIG="$2"
  shift 2
else
  # Read LLM_PROVIDER from .env if not in env
  PROVIDER="${LLM_PROVIDER:-}"
  if [[ -z "$PROVIDER" && -f "$PROJECT_DIR/.env" ]]; then
    PROVIDER=$(grep "^LLM_PROVIDER=" "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2)
  fi
  if [[ -n "$PROVIDER" && -f "$PROJECT_DIR/pipelines/${PROVIDER}.yaml" ]]; then
    CONFIG="pipelines/${PROVIDER}.yaml"
  fi
fi

cleanup() {
  if [[ "$AGENT_STARTED_BY_US" == true && -n "$AGENT_PID" ]]; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
    echo "llm-agent stopped."
  fi
}
trap cleanup EXIT INT TERM

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
