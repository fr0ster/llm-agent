#!/usr/bin/env bash
# Manual integration check: prove the DAG coordinator dispatches MCP-tool-using
# work to worker subagents (i.e. it does NOT have issue #157, where the linear
# coordinator's SelfDispatch runs a toolless llm.chat() and hallucinates).
#
# Prerequisites (NOT runnable in CI — needs live external services):
#   - SAP MCP reachable at $MCP_ENDPOINT (default http://localhost:3001/mcp/stream/http)
#   - DEEPSEEK_API_KEY      (planner + worker LLM)
#   - AICORE_SERVICE_KEY    (SAP AI Core embedder for tool-select)
#   - SAP_AI_RESOURCE_GROUP, EMBEDDING_MODEL optional (sensible defaults)
#
# Usage (from repo root):
#   npm run build
#   bash scripts/integration/dag-coordinator-mcp/run.sh
#
# Exit code 0 = PASS (real MCP tool calls observed), non-zero = FAIL.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
CONFIG="$HERE/smart-server-dag.yaml"
RUN_DIR="$HERE/.run"
PORT=4014
BASE="http://localhost:$PORT"
PROMPT='Зроби аналіз пакету ZOK_BOOK_LIBRARY і вигрузи результат в файл маркдаун формату'

cd "$REPO_ROOT"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR/sessions"

cleanup() { pkill -f "cli.ts --config $CONFIG" 2>/dev/null || true; }
trap cleanup EXIT

echo ">>> starting DAG server ($CONFIG) on :$PORT"
npm run dev -- --config "$CONFIG" >"$RUN_DIR/stdout.log" 2>&1 &

echo ">>> waiting for server_started ..."
for i in $(seq 1 60); do
  if grep -aq '"event":"server_started"' "$RUN_DIR/server.log" 2>/dev/null; then
    echo ">>> server up after ~$((i*2))s"; break
  fi
  sleep 2
  [ "$i" = "60" ] && { echo "FAIL: server did not start"; tail -20 "$RUN_DIR/stdout.log"; exit 1; }
done

echo ">>> sending prompt: $PROMPT"
curl -s --max-time 600 -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg c "$PROMPT" '{model:"deepseek-chat",stream:false,messages:[{role:"user",content:$c}]}')" \
  -o "$RUN_DIR/response.json" -w "HTTP %{http_code} in %{time_total}s\n"

CONTENT="$(jq -r '.choices[0].message.content' "$RUN_DIR/response.json" 2>/dev/null || echo '')"

echo "=== assertions ==="
# 1. The worker must have executed real MCP tools (not a toolless llm.chat()).
if echo "$CONTENT" | grep -qE '\[SmartAgent: Executing [A-Z][A-Za-z]+'; then
  echo "PASS: worker executed MCP tools:"
  echo "$CONTENT" | grep -oE 'Executing [A-Z][A-Za-z]+' | sort -u | sed 's/^/      /'
else
  echo "FAIL: no MCP tool execution markers found (looks toolless — #157 regression)"
  echo "$CONTENT" | head -c 800
  exit 1
fi

# 2. The top-level coordinator stage must have engaged and skipped the tool-loop.
LATEST_REQ="$(ls -1dt "$RUN_DIR"/sessions/*/req_* 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_REQ" ] && [ -f "$LATEST_REQ/09_dag_coordinator_final.json" ]; then
  echo "PASS: DAG coordinator ran — $(jq -c . "$LATEST_REQ/09_dag_coordinator_final.json")"
else
  echo "WARN: no 09_dag_coordinator_final.json trace found (check $RUN_DIR/sessions)"
fi

echo ">>> DONE — PR DAG-coordinator path uses MCP tools (no #157)."
