# DAG-coordinator ↔ MCP integration check (manual)

Proves the **DAG coordinator** dispatches tool-using work to worker subagents that
run their own RAG tool-select + tool-loop against live MCP — i.e. it does **not**
exhibit [#157](https://github.com/fr0ster/llm-agent/issues/157) (the linear
coordinator's `SelfDispatch` runs a toolless `llm.chat()` and hallucinates).

This is a **manual** check: it needs live external services and cannot run in CI.

## Prerequisites

- SAP MCP reachable at `MCP_ENDPOINT` (default `http://localhost:3001/mcp/stream/http`)
- `DEEPSEEK_API_KEY` — planner + worker LLM
- `AICORE_SERVICE_KEY` — SAP AI Core embedder (tool-select); `SAP_AI_RESOURCE_GROUP`,
  `EMBEDDING_MODEL` optional
- `jq`, `curl`

## Run

```bash
npm run build
bash scripts/integration/dag-coordinator-mcp/run.sh
```

Exit `0` = PASS (real `[SmartAgent: Executing <Tool>...]` markers observed in the
response, and `09_dag_coordinator_final.json` trace present). Non-zero = FAIL.

## Files

| File | Role |
|------|------|
| `smart-server-dag.yaml` | DAG-coordinator server (`coordinator.planner` + `subagents:`), `activation: explicit` → coordinator always on |
| `abap-analyst.yaml`     | Worker subagent — full pipeline with its OWN MCP + tool-loop |
| `run.sh`                | Boots server, sends the analysis prompt, asserts MCP tools were called |

Artifacts land in `./.run/` (gitignored): `server.log`, `response.json`, `sessions/`.

## TODO

Migrate this manual script into a proper Jest integration test (env-gated, skipped
when prerequisites are absent). Tracked in a follow-up issue.
