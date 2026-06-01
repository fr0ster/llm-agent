# Recursive Stepper — per-role configurations (18.0)

Production-shaped examples for the Stepper coordinator introduced in release
**18.0.0**. Every example sets `coordinator.mode` (or `coordinator.flow`) + a
`coordinator.stepper.*` block.

| File | Mode | Use it for |
|---|---|---|
| [`01-cyclic-react.yaml`](./01-cyclic-react.yaml) | `cyclic-react` | Bounded tasks; single executor loop, no planning overhead. |
| [`02-planned-react.yaml`](./02-planned-react.yaml) | `planned-react` | Multi-step tasks; LLM planner + parallel Stepper workers + knowledge-RAG blackboard. |
| [`04-flow-composition.yaml`](./04-flow-composition.yaml) | _(explicit `flow`)_ | Compose directly; granularity × executor knobs + a nested composition tree. |

> The recursive `deep-stepper` mode (and `flow.executor: recursive`) is **not
> shipped in 18.0** — its recursive control runs away; both are rejected by config
> parsing. Hardening (Evaluator + identity-dedup + dependsOn-dataflow) is the 18.1
> work. Declared structural recursion via nested `flow.nodes` is available.
| [`04-flow-composition.yaml`](./04-flow-composition.yaml) | _(explicit `flow`)_ | Describe the composition directly (no `mode`): the `planner.granularity` × `executor.type` knobs + a NESTED composition tree (a node nests its own `flow` = a sub-cycle). |

`worker.yaml` is the shared subagent pipeline referenced by the coordinator yamls.
It is a complete smart-agent config (`mode: smart` + `pipeline.*`) — exactly what a
Stepper executor dispatches steps to.

## `coordinator.flow` — composition over modes

`mode` is a **preset** that expands to a `coordinator.flow`. Writing `flow` directly
(see `04-flow-composition.yaml`) gives full control:

- **`flow.planner`** — `{ type: none | llm | static, granularity: shallow | detailed }`.
  `granularity` is the eager-decomposition knob (how much the LLM planner decomposes up front).
- **`flow.executor`** — `{ type: simple | cyclic-react }`. `simple` = single pass;
  `cyclic-react` = ReAct loop. (`recursive` is deferred to 18.1.)
- **`flow.reviewer` / `flow.finalizer`** — orchestration phases.
- **`flow.nodes`** — a declared composition TREE. A node is a leaf (`id`, `goal`, `dependsOn`)
  or nests its own `flow` → a child Stepper. A level with `nodes` is static over them (the nodes
  ARE the plan). This is a **FINITE** tree (you write N levels and stop) — NOT recursion.

### Finite composition vs recursion

A `flow` is declarative — the yaml controls everything. But **recursion cannot be expressed as a
finite yaml structure**: recursion is unbounded self-similar expansion to a termination condition,
and its depth is unknown at config time (data-dependent). Nesting `flow.nodes` only gives a
FIXED, finite tree.

| | Finite composition (`flow.nodes`) | Recursion |
|---|---|---|
| What yaml holds | the exact N-level tree | at most a FLAG ("recurse here") + maxDepth, or a named-flow self-reference |
| Expansion | none — it IS the tree | RUNTIME (a node spawns a same-shaped child until termination) |
| Depth | fixed, written by hand | unknown at config time; bounded by maxDepth + the termination check |
| 18.0 | shipped (`04-flow-composition.yaml` is a finite 2-level tree) | NOT shipped — `executor: recursive` / `mode: deep-stepper` are rejected by parsing |

So in 18.0 a `flow` gives **finite declared trees only**. True recursion (a node flag /
self-reference + runtime expansion + a termination condition) is the 18.1 work — it needs the
Evaluator (the termination judge) and identity-keyed dedup so it does not run away.

Domain operations (fetch source, read includes, run a check) are **never** declared in `flow` —
the planner/executor obtain data via the consumer's RAG skills (`knowledgeSeed`). Nodes are
analysis/orchestration intents, not tool calls.

---

## The modes

### `cyclic-react` — tight executor loop

A single `CyclicReActExecutor` runs in a ReAct loop (reason → act → observe)
until the task is complete or the token budget is exhausted. There is no
planning pass. The executor writes step artefacts to the knowledge-RAG; the
root finalizer reads them to compose the answer.

Best for: bounded retrieval tasks, single-focus questions, latency-sensitive
scenarios where planning overhead is not justified.

### `planned-react` — planner + parallel Stepper workers (default)

The `LlmStepperPlanner` decomposes the request into named steps. The
`StepperInterpreter` schedules the steps (respecting `dependsOn` graph edges)
up to `maxParallelSteps` concurrent Steppers. Each child Stepper runs its own
`CyclicReActExecutor` and writes findings to the shared per-session
knowledge-RAG blackboard. Sibling steps can read each other's artefacts once
they are written. The root `RootFinalizer` synthesizes the accumulated
knowledge-RAG into the final answer.

Best for: multi-dimension analyses, broad reviews, tasks whose scope is clear
upfront. The most common production shape: flagship model for planning + cheap
model for execution.

> ### `deep-stepper` — recursive multi-level hierarchy _(deferred to 18.1)_
>
> A future mode where each Stepper plans and spawns child Steppers up to
> `maxDepth`. NOT shipped in 18.0 — its recursive control runs away (re-plans
> overlapping sub-goals; no identity-dedup); `mode: deep-stepper` and
> `flow.executor: recursive` are rejected by config parsing. The hardening
> (Evaluator that judges prompt completeness WITH RAG context, identity-keyed
> blackboard dedup, dataflow along `dependsOn`, layered decomposition) is 18.1.
> Declared structural recursion via nested `flow.nodes` is available today.

---

## Provider profiles (env override)

The mode (`coordinator`) and the provider (`llm:` / `rag:`) are **orthogonal** —
all three example configs default to **SAP AI Core** but read the provider, the
per-role models, and the embedder from environment variables, so you swap the
whole pipeline to another provider without editing YAML.

**Keep ONE provider per pipeline.** Mix only to fill a capability gap — e.g.
DeepSeek and Anthropic have no embedder, so pair them with Ollama or OpenAI for
`EMBEDDER_PROVIDER`. SAP AI Core covers LLM + embedder in one provider.

Env vars (defaults shown apply when unset):

| Var | Purpose | Default |
|-----|---------|---------|
| `LLM_PROVIDER` | LLM provider for every role | `sap-ai-sdk` |
| `LLM_API_KEY` | API key (deepseek/openai/anthropic) | _(empty; SAP AI Core uses `AICORE_SERVICE_KEY`)_ |
| `LLM_URL` | base URL (Ollama / OpenAI-compatible) | _(empty → provider default)_ |
| `LLM_MAIN_MODEL` / `LLM_PLANNER_MODEL` / `LLM_EXECUTOR_MODEL` / `LLM_REVIEWER_MODEL` / `LLM_FINALIZER_MODEL` | per-role model | SAP AI Core sonnet/haiku |
| `EMBEDDER_PROVIDER` | embedder provider | `sap-ai-core` |
| `EMBEDDER_API_KEY` / `EMBEDDER_URL` / `EMBEDDING_MODEL` | embedder credentials/model | _(empty / provider default)_ |

Profiles (one provider each):

```bash
# SAP AI Core (default — nothing to set beyond AICORE_SERVICE_KEY)

# DeepSeek LLM + Ollama embedder (DeepSeek has no embedder)
export LLM_PROVIDER=deepseek LLM_API_KEY=$DEEPSEEK_API_KEY
export LLM_PLANNER_MODEL=deepseek-reasoner LLM_EXECUTOR_MODEL=deepseek-chat \
       LLM_REVIEWER_MODEL=deepseek-chat LLM_FINALIZER_MODEL=deepseek-reasoner
export EMBEDDER_PROVIDER=ollama EMBEDDER_URL=http://localhost:11434 EMBEDDING_MODEL=nomic-embed-text

# Fully local Ollama (LLM + embedder)
export LLM_PROVIDER=ollama LLM_URL=http://localhost:11434
export LLM_MAIN_MODEL=qwen2.5 LLM_PLANNER_MODEL=qwen2.5 LLM_EXECUTOR_MODEL=qwen2.5 \
       LLM_REVIEWER_MODEL=qwen2.5 LLM_FINALIZER_MODEL=qwen2.5
export EMBEDDER_PROVIDER=ollama EMBEDDER_URL=http://localhost:11434 EMBEDDING_MODEL=nomic-embed-text

# OpenAI (LLM + embedder)
export LLM_PROVIDER=openai LLM_API_KEY=$OPENAI_API_KEY
export LLM_PLANNER_MODEL=gpt-5 LLM_EXECUTOR_MODEL=gpt-5-mini
export EMBEDDER_PROVIDER=openai EMBEDDER_API_KEY=$OPENAI_API_KEY EMBEDDING_MODEL=text-embedding-3-small
```

> DeepSeek note: `deepseek-reasoner` ignores `temperature` and (historically)
> does not support function-calling — keep it on no-tool roles (planner/reviewer/
> finalizer) and run the tool-using executor on `deepseek-chat`.

Provider quirks (temperature support, tool-calling, embedder availability) are
handled per-provider in each provider package, not in the Stepper. The model
names above are illustrative — use whatever your provider exposes.

---

## Session persistence and `/v1/sessions` resume

The Stepper coordinator persists session state so a long-running analysis
can survive a process restart. The durable backend is `JsonlKnowledgeBackend`
(one JSONL file per session under `logDir`). Sessions are indexed in memory
(or Postgres when `sessionStore: pg` is configured — see `docs/DEPLOYMENT.md`).

### Resume flow

```bash
# 1. Start a session — note the session cookie in the response headers.
curl -i -X POST http://localhost:4021/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Review package ZMY_PKG for CleanCore compliance"}],"stream":true}' \
  | grep -E 'Set-Cookie|data:'

# 2. If the server restarts mid-run, resume with the cookie.
curl -X POST http://localhost:4021/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Cookie: sid=<value-from-step-1>' \
  -d '{"messages":[{"role":"user","content":"Continue"}],"stream":true}'

# 3. List sessions for the current identity — you MUST send the sid cookie.
#    Without it the server mints a NEW identity and returns its (empty) list.
curl -b 'sid=<value-from-step-1>' http://localhost:4021/v1/sessions

# 4. Resume a session by id (claims it + marks it idle so it can be re-entered).
curl -X POST -b 'sid=<value-from-step-1>' \
  http://localhost:4021/v1/sessions/<sessionId>/resume

# 5. Delete a session (drops metadata + evicts its knowledge-RAG entries).
curl -X DELETE -b 'sid=<value-from-step-1>' \
  http://localhost:4021/v1/sessions/<sessionId>
```

Implemented endpoints: `GET /v1/sessions`, `POST /v1/sessions/:id/resume`,
`DELETE /v1/sessions/:id`. All are scoped to the `sid`-cookie identity.

The server issues a `sid` cookie on the first request. Subsequent requests
that carry the same cookie are routed to the same session object graph,
including the same `KnowledgeRag` instance backed by the durable JSONL file.

---

## Tool permissioning

**Tool permissioning is the MCP SERVER's responsibility — there is NO agent-side
gate.** This is not a plain MCP client; it is an agent that ENCAPSULATES MCP. When
the consumer wires the agent to an MCP server, it exposes ONLY the permitted tools
(e.g. a read-only MCP proxy, or a scoped tool set). Whatever the server returns from
`tools/list` is allowed — the agent calls it.

The agent **never** classifies a tool as read-only vs mutating: it cannot reliably
know that (it only has descriptions), and that judgement is not the agent's job —
it belongs to the server / the deployment wiring. There is no `mutationPolicy`, no
`knownReadOnlyTools`, no confirmation gate in the agent. If filtering is ever needed
it belongs in the tool-RAG layer (which tools are discoverable), not at execution.

---

## Gnostification is the consumer's responsibility

The engine is **agnostic** — it hardcodes no tool names and no domain procedures. Making it
thorough for YOUR MCP/domain is **the consumer's job**, supplied as DATA via `coordinator.
knowledgeSeed` (and/or skills): procedural "how an operation is done" records — e.g. *"for a code
review, work from the full source including all includes"* (no tool names needed), or *"the
security checks are X/Y/Z, else fetch them from resource R"*. These are surfaced to the
planner/executor as facts and enrich tool-search.

This matters most for **`cyclic-react`**, which has NO planner — the single executor runs the raw
prompt, so on a bare prompt it satisfices on the main object and does NOT read includes. Add a
high-level `knowledgeSeed` (a principle, no tool names) to make it thorough. `planned-react` /
deep also benefit. The agent will not invent domain completeness rules for you.

---

## `coordinator.stepper.*` reference

| Key | Type | Default | Description |
|---|---|---|---|
| `maxParallelSteps` | integer | `4` | Local fan-out cap per `StepperInterpreter` level. Global in-flight count is bounded by `maxParallelSteps^depth` in the worst case. |
| `maxDepth` | integer | `4` | Maximum recursion depth. The `StepperInterpreter` refuses to spawn children beyond this level. |
| `tokenBudget` | integer | `400000` | Soft token cap shared across all branches. A single `ITokenLedger` is created at the root and passed by reference; each executor checks `exhausted()` before an LLM call. The cap is a soft cap — parallel in-flight calls can overshoot by `in-flight × tokens-per-call`. |
| `reviewer.atDepths` | integer[] or `'all'` | `[0, 1]` | Depths at which the reviewer LLM is invoked after each Stepper completes. Use `'all'` to review every level (expensive). |

---

## Running an example

```bash
# 1. Start MCP proxy (separate terminal).
mcp-abap-adt-proxy --config ~/.config/mcp-abap-adt/proxy/<your>.yaml \
                   --http-host=0.0.0.0 --http-port=3003

# 2. Start the planned-react example.
MCP_ENDPOINT=http://localhost:3003/mcp/stream/http \
SAP_AI_RESOURCE_GROUP=default \
  llm-agent --config docs/examples/stepper/02-planned-react.yaml

# 3. Send a prompt and stream the response.
curl -N -X POST http://localhost:4021/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Review ABAP program ZEXAMPLE for security and CleanCore compliance"}],"stream":true}'
```

### Expected SSE event kinds (18.0)

After a successful Stepper run you will see these `data:` event kinds in the
SSE stream (in addition to the final `content` delta):

| Kind | Source | Notes |
|---|---|---|
| `stepper-spawned` | `StepperInterpreter` | Emitted before each child Stepper is dispatched. Carries `source: StepperRef` with stable `stepperId`. |
| `stepper-done` | `StepperInterpreter` | Emitted after each child completes. `ok: false` if the child raised a signal. |
| `mcp-call` | `CyclicReActExecutor` | Emitted before each MCP tool call. |
| `mcp-result` | `CyclicReActExecutor` | Emitted after the tool returns. Carries `durationMs` and `bytes`. |
| `tokens-used` | executor / Stepper | Per-component token delta. Maps to `byComponent` in `/v1/usage`. |
| `llm-call-start` | executor / planner / reviewer / finalizer | Before each LLM round-trip. Carries `model`. |
| `llm-call-end` | executor / planner / reviewer / finalizer | After each LLM round-trip. Carries `durationMs`. |
| `content` | `RootFinalizer` | LLM output delta. The final synthesized answer. |

The 17.0 `node-start`, `node-end`, and `tool-call` variants have been removed
in 18.0. SSE clients must migrate to the events above.
