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
#
# Manual fallback only — the CI-safe automated equivalent is
#   packages/llm-agent-server-libs/src/__tests__/dag-coordinator-mcp.integration.test.ts
# (node:test, env-gated). Prefer that for repeatable runs.
#
# NOTE: this script asserts tool execution via STRUCTURED signals
# (prompt_tokens grounding floor + dag_stream mcp-call/mcp-result trace), NOT the
# `[SmartAgent: Executing <Tool>...]` content markers. As of commit 32db195 those
# markers are `ephemeral` and are excluded from non-streaming (stream:false)
# content, so grepping the response body no longer detects tool use.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
CONFIG="$HERE/smart-server-dag.yaml"
# yaml `logDir`/`log` are cwd-relative (`./.run`); the server runs from REPO_ROOT.
RUN_DIR="$REPO_ROOT/.run"
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

echo "=== assertions ==="
# 1. Token grounding: real MCP-grounded analysis pulls tens of thousands of
#    prompt tokens; a toolless hallucination (#157) spends ~1-2k.
PROMPT_TOKENS="$(jq -r '.usage.prompt_tokens // 0' "$RUN_DIR/response.json" 2>/dev/null || echo 0)"
if [ "$PROMPT_TOKENS" -gt 20000 ]; then
  echo "PASS: prompt_tokens=$PROMPT_TOKENS (> 20000 grounding floor — not toolless)"
else
  echo "FAIL: prompt_tokens=$PROMPT_TOKENS not > 20000 (looks toolless — #157 regression)"
  jq -r '.choices[0].message.content' "$RUN_DIR/response.json" 2>/dev/null | head -c 800
  exit 1
fi

# 2. Structured trace: a DAG coordinator final trace plus dag_stream chunks that
#    name real MCP tool executions (mcp-call / mcp-result).
LATEST_REQ="$(ls -1dt "$RUN_DIR"/sessions/*/req_* 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_REQ" ] && ls "$LATEST_REQ"/*dag_coordinator_final*.json >/dev/null 2>&1; then
  echo "PASS: DAG coordinator final trace present in $LATEST_REQ"
else
  echo "FAIL: no *dag_coordinator_final*.json trace found (check $RUN_DIR/sessions)"
  exit 1
fi
if grep -lqE '"kind": *"mcp-(call|result)"' "$LATEST_REQ"/*dag_stream*.json 2>/dev/null; then
  echo "PASS: real MCP tool executions recorded in dag_stream trace:"
  grep -hoE '"tool": *"[^"]+"' "$LATEST_REQ"/*dag_stream*.json 2>/dev/null | sort -u | sed 's/^/      /'
else
  echo "FAIL: no mcp-call/mcp-result chunks naming real tools (looks toolless — #157 regression)"
  exit 1
fi

echo ">>> DONE — PR DAG-coordinator path uses MCP tools (no #157)."
