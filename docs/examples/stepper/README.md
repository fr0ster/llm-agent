# Recursive Stepper — per-role configurations (18.0)

Three production-shaped examples for the recursive Stepper coordinator introduced
in release **18.0.0**. Every example sets `coordinator.mode` + a full
`coordinator.stepper.*` block.

| File | Mode | Use it for |
|---|---|---|
| [`01-cyclic-react.yaml`](./01-cyclic-react.yaml) | `cyclic-react` | Bounded tasks; single executor loop, no planning overhead. |
| [`02-planned-react.yaml`](./02-planned-react.yaml) | `planned-react` | Multi-step tasks; LLM planner + parallel Stepper workers + knowledge-RAG blackboard. |
| [`03-deep-stepper.yaml`](./03-deep-stepper.yaml) | `deep-stepper` | Hierarchical tasks; each Stepper can recursively spawn child Steppers up to `maxDepth`. |

`worker.yaml` is the shared subagent pipeline referenced by all three coordinator
yamls. It is a complete smart-agent config (`mode: smart` + `pipeline.*`) —
exactly what a Stepper executor dispatches steps to.

---

## The three modes

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

### `deep-stepper` — recursive multi-level hierarchy

Each Stepper can itself plan and spawn child Steppers, building a recursive
execution tree up to `coordinator.stepper.maxDepth`. Every level shares the
same per-session knowledge-RAG blackboard, so a grandchild can read artefacts
written by its uncle. The root finalizer synthesizes the full accumulated tree.

Best for: hierarchical tasks (system review → package → object → function),
long-horizon discovery tasks where intermediate findings open new questions.
Wider token budgets and tighter `maxParallelSteps` are recommended.

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

# 3. List active sessions.
curl http://localhost:4021/v1/sessions

# 4. Fetch a specific session's knowledge-RAG entries.
curl http://localhost:4021/v1/sessions/<sessionId>
```

The server issues a `sid` cookie on the first request. Subsequent requests
that carry the same cookie are routed to the same session object graph,
including the same `KnowledgeRag` instance backed by the durable JSONL file.

---

## readOnly tool-safety policy

The Stepper executor enforces a safety gate before every MCP tool call.
Configure it via `coordinator.mutationPolicy` and `coordinator.knownReadOnlyTools`.

### Three policy levels

| Config | Behaviour |
|---|---|
| `mutationPolicy: confirm` (default) | Undeclared tools raise `ClarifySignal` (budget-extension request) before calling. Tools with `readOnly: true` in the MCP schema or listed in `knownReadOnlyTools` bypass the gate. |
| `knownReadOnlyTools: [...]` | Per-tool allowlist. A tool listed here is treated as read-only even if the MCP schema does not declare `readOnly: true`. |
| `mutationPolicy: trusted` | All tools are permitted without confirmation. Use only on read-only MCP proxies. |

### Example: safest default

```yaml
coordinator:
  mode: planned-react
  mutationPolicy: confirm
  knownReadOnlyTools:
    - GetProgram
    - GetInclude
    - SearchRepository
```

### Example: fully trusted (read-only MCP only)

```yaml
coordinator:
  mode: deep-stepper
  mutationPolicy: trusted
```

### Example: mixed (some tools trusted, mutation tools still require confirmation)

```yaml
coordinator:
  mode: planned-react
  mutationPolicy: confirm
  knownReadOnlyTools:
    - GetProgram
    - GetClass
    # CreateClass, ActivateObject etc. are NOT listed → require confirmation
```

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
