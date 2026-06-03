# DAG-coordinator ↔ MCP integration check (manual)

Proves the **DAG coordinator** dispatches tool-using work to worker subagents that
run their own RAG tool-select + tool-loop against live MCP — i.e. it does **not**
exhibit [#157](https://github.com/fr0ster/llm-agent/issues/157) (the linear
coordinator's `SelfDispatch` runs a toolless `llm.chat()` and hallucinates).

This was originally a **manual** check. It is now automated as an env-gated
`node:test` integration test (issue #159) that skips cleanly in CI:

> `packages/llm-agent-server-libs/src/__tests__/dag-coordinator-mcp.integration.test.ts`

The test boots this same `smart-server-dag.yaml` (spawning the CLI on port 4099)
and runs only when `MCP_ENDPOINT` is reachable AND `DEEPSEEK_API_KEY` +
`AICORE_SERVICE_KEY` are set; otherwise it skips. `run.sh` is kept as a manual
fallback for ad-hoc local runs.

> **Stale-assertion note:** the original check grepped the response **content**
> for `[SmartAgent: Executing <Tool>...]` markers. As of commit `32db195` those
> liveness markers are `ephemeral` and are **excluded from non-streaming
> (`stream:false`) content**, so that grep no longer detects tool use in plain
> mode. Both the test and `run.sh` now assert tool execution via **structured
> signals** instead: a `dag_coordinator_final` session trace plus `dag_stream`
> `mcp-call`/`mcp-result` chunks naming real tools, and a `prompt_tokens`
> grounding floor (`> 20000` — a toolless hallucination spends ~1-2k).

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

Exit `0` = PASS (`usage.prompt_tokens > 20000` grounding floor met, a
`dag_coordinator_final` trace present, and `dag_stream` `mcp-call`/`mcp-result`
chunks naming real tools). Non-zero = FAIL.

## Files

| File | Role |
|------|------|
| `smart-server-dag.yaml` | DAG-coordinator server (`coordinator.planner` + `subagents:`), `activation: explicit` → coordinator always on |
| `abap-analyst.yaml`     | Worker subagent — full pipeline with its OWN MCP + tool-loop |
| `run.sh`                | Boots server, sends the analysis prompt, asserts MCP tools were called |

Artifacts land in `./.run/` (gitignored): `server.log`, `response.json`, `sessions/`.

## Automated test

The CI-safe automated equivalent lives at
`packages/llm-agent-server-libs/src/__tests__/dag-coordinator-mcp.integration.test.ts`
(node:test, env-gated). It reuses the yaml configs in this directory verbatim,
spawns the CLI on port 4099, and asserts the structured signals described above.
Run it directly with:

```bash
cd packages/llm-agent-server-libs
node --import tsx/esm --test src/__tests__/dag-coordinator-mcp.integration.test.ts
```

With no services/keys it reports `skipped` and exits `0`.
