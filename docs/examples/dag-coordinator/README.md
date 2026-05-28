# DAG coordinator — per-role LLM configurations

Three production-shaped examples that exercise the per-role LLM map and
the coordinator role surface delivered by PR #163 (release **17.0.0**).

| File | Roles wired | Use it for |
|---|---|---|
| [`01-all-sonnet.yaml`](./01-all-sonnet.yaml) | planner=sonnet, worker=sonnet (finalizer = Passthrough default) | Quality ceiling — single model on every role. Baseline to compare against. |
| [`02-hybrid-sonnet-haiku.yaml`](./02-hybrid-sonnet-haiku.yaml) | planner=sonnet, worker=haiku, finalizer=passthrough | Cost-optimised: flagship planning + cheap execution. The most common production shape. |
| [`03-full-roles.yaml`](./03-full-roles.yaml) | planner=sonnet, reviewer=haiku, finalizer=LLM(haiku), stateOracle=subagent, errorStrategy=replan | Full surface — every coordinator role active. Reference template when you need synthesis + per-node review + NeedInfo round-trips. |

The two worker yamls (`worker-sonnet.yaml`, `worker-haiku.yaml`) and the
`inspector-haiku.yaml` (used as stateOracle in `03-full-roles.yaml`) are
shared subagent pipelines — they are full smart-agent configs in their
own right (`mode: smart` + `pipeline.*`) because that is exactly what a
DAG worker is.

## Why this is the meaningful comparison

A flat smart-agent pipeline is a single LLM in a tool-loop. The DAG
coordinator adds a planning step + role separation, so the cost story
is **how each role is staffed**, not just which one flagship model you
chose. The hybrid shape (planner=sonnet, worker=haiku) typically yields
5–10× cheaper worker tokens at the same plan quality.

## Lookup chain

Per-role LLM resolution (see `resolveLlmConfig` in `config.ts`):

```
llm.<role-name>  →  llm.main  →  pipeline.llm.main  →  ConfigError
```

`'helper'` and `'planner'` accept the prebuilt `pipeline.llm.helper`
fallback even when no `llm:` block is set, so legacy `plannerLlm: helper`
configs keep working.

## Running an example

```bash
# 1. start MCP proxy (separate terminal)
mcp-abap-adt-proxy --config ~/.config/mcp-abap-adt/proxy/<your>.yaml \
                   --http-host=0.0.0.0 --http-port=3003

# 2. start the example
MCP_ENDPOINT=http://localhost:3003/mcp/stream/http \
SAP_AI_RESOURCE_GROUP=default \
  llm-agent --config docs/examples/dag-coordinator/02-hybrid-sonnet-haiku.yaml

# 3. stream a prompt and read the byComponent breakdown
docs/examples/dag-coordinator/stream-test.sh 4016 hybrid \
  'Review ABAP program zexample, check security, performance, CleanCore'
```

The expected `byComponent` keys after a successful DAG run on
`03-full-roles.yaml`:

| Component | Source | Notes |
|---|---|---|
| `planner` | `coordinator.planner` | One call per plan; reusable across replans. |
| `reviewer` | `coordinator.reviewer` | One call per executed node. |
| `finalizer` | `coordinator.finalizer` | One call at the end (zero in Passthrough mode). |
| `tool-loop`, `classifier` | worker subagent pipeline | N calls per executed node — the bulk of the bill. |
| `oracle` | NeedInfo round-trip via stateOracle | `usage: undefined` from `SubAgentStateOracle` (double-count contract); raw oracle tokens land under `tool-loop` of the inspector pipeline instead, attributed by traceId. |

## Streaming + per-component view

`stream-test.sh` reads SSE `data:` lines from `/v1/chat/completions`,
prints content deltas in real time, then calls `/v1/usage` with the
session cookie to dump the same SessionRequestLogger summary the
server uses internally. No extra logging code on your side — every
role's tokens already flow through the shared session logger keyed
on `traceId`.
