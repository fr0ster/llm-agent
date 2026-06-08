# End-to-End Token Usage Metering — Design

**Date:** 2026-06-08
**Status:** Design (approved for planning)

## Problem

`response.usage` undercounts real token spend on the **controller** pipeline, and
streaming clients can miss usage on coordinator/pass paths. Root causes:

1. **Controller spend never reaches the aggregator.** The flat path and the
   **Stepper** log every LLM call into the per-session `IRequestLogger` (default
   impl `SessionRequestLogger`). The **controller** does not: it keeps a private
   `total` and emits it on its terminal chunk. Its subagent LLM spend
   (evaluator/planner/executor/finalizer), its target-state embedder calls
   (`controller/target-state.ts:75-76`), and its toolsRag query embeddings never
   enter the logger.

2. **The controller's `response.usage` is a second, divergent total.** The flat
   path emits `summaryToUsage(getSummary(traceId))` as one terminal usage chunk
   inside `streamProcess` (`agent.ts:1237,1595,1711,1753`), which `process()` sums
   (`:616-622`) for non-streaming and SSE forwards for streaming. The controller
   instead emits its own hand-rolled total — a separate aggregator that can
   diverge from `getSummary`/`/v1/usage`.

3. **`traceId` is generated but not visible to the logger.** `agent.ts:653` does
   `traceId = options?.trace?.traceId ?? randomUUID()` but never writes it into
   `opts`. Downstream `logLlmCall` entries then carry no `requestId`, so they land
   in the session-cumulative bucket only and the per-request delta is empty.

4. **No final usage chunk on streaming coordinator/pass paths.** `streamProcess`
   pass (`agent.ts:700-722`) and pipeline (`:726-738`) paths forward chunks and
   return without the terminal `getSummary` usage chunk the flat path emits.

## Key insight — the architecture already exists in the flat path

Two concerns are **already decoupled** by the flat path; the fix is to make the
controller/coordinator/pass paths conform, not to invent machinery:

- **Internal accounting (uniform):** every LLM/embedder call logs into the
  `IRequestLogger` interface. One aggregator, many loggers.
- **Consumer delivery (protocol-specific, single source):** `streamProcess`
  yields **exactly one** terminal usage chunk built from
  `summaryToUsage(getSummary(traceId))`. The **streaming** consumer (SSE) reads it
  as the final usage event; the **non-streaming** consumer (`process()`) sums
  chunk usage (`:616-622`) — which is just that one chunk.

No separate `IRequestLogger` implementation is needed for streaming vs
non-streaming: logging is uniform, only delivery differs, and both delivery modes
read the same terminal chunk. The flat path is untouched, so existing
implementations are not broken.

### Why the controller logs at request time, not via a build-time decorator

The Stepper wraps its role LLMs in a build-time `LoggingLlm`. That does **not**
work for the controller (review #1): the controller builds its LLMs/embedder in
`pipelines/controller.ts:100` **before** `execute(ctx)`, so a wrapper cannot see
the request `traceId`; and the `planner`/`finalizer` roles share one client, so a
fixed-component wrapper cannot distinguish them. The controller therefore logs at
**request time** through `ctx.requestLogger`, where both the `traceId`
(`synthMeta`→`meta.traceId`, handler `:783`) and the explicit role/component are
known. The controller already has the seam: the request-time `logUsage(role, u)`
(handler `:122`, called as `logUsage('evaluator'…)`, `'executor'`, and via the
callback for `planner`/`finalizer`).

## Goals

1. **Accurate** — `response.usage` equals the sum of every LLM call on every path
   (flat, stepper, controller, pass) and every embedder call **except** the
   Stepper's toolsRag query-embedding, which remains a pre-existing minor gap
   (deferred; trivially closable via the same `accounting` param). Controller and
   flat embeddings are fully accounted.
2. **One internal aggregator** — the `IRequestLogger` interface (default impl
   `SessionRequestLogger`). The controller's private sum is removed; all paths'
   usage comes from `getSummary(traceId)`.
3. **Internal logging decoupled from consumer delivery** — logging is uniform;
   delivery is one terminal `getSummary` usage chunk (SSE event, or summed by
   `process()`).
4. **Reuse, minimal delta, additive-only** — keep every existing logging site;
   only *add* request-time logging where it is currently absent (controller LLM +
   embeddings), *fix* the systemic traceId/derivation/stream issues, *replace* the
   controller's terminal-chunk usage source (private total → logger-derived), and
   *remove* only the now-unused private `total` accumulator.

## Non-Goals

- A new `IUsageMeter` / `IUsageRecorder`, `CallOptions.usageComponent`,
  AsyncLocalStorage scope, a blanket decorator replacing all logging, or
  protocol-specific logger implementations. **Dropped** (duplicate
  `IRequestLogger`; would double-count).
- A controller-side `LoggingLlm` / `LoggingEmbedder` build-time wrapper — cannot
  bind the request `traceId` nor distinguish the shared planner/finalizer client
  (review #1). Controller logs at request time instead.
- Globally wrapping the embedder — `rag-query.ts:102` already logs flat-path
  embeddings; a global wrap would double-count.
- Removing `process()`'s chunk-usage summation (`:616-622`).
- Reconciling the controller's `[controller]` DEBUG per-call lines with
  `response.usage`. Those stay; only the controller's aggregate `turn total` line
  and the private `total` accumulator are removed (the terminal-chunk `usage` is
  kept — its source becomes logger-derived).
- Provider-side numeric accuracy.

## Architecture

### Aggregator — `IRequestLogger` (default impl `SessionRequestLogger`)

Unchanged. Per-`requestId` delta (for `response.usage`) + session-cumulative (for
`/v1/usage`); `byModel`/`byComponent`/`byCategory` + `requests`; nested-safe.
Pluggability is the interface.

### Internal logging — controller logs at request time (additive-only)

- **Subagent LLMs:** repurpose the existing `logUsage(role, usage)` (handler
  `:122`) to call
  `ctx.requestLogger.logLlmCall({ component: role, model: <per-role configured model>, promptTokens, completionTokens, totalTokens, durationMs: 0, requestId: meta.traceId })`
  instead of accumulating a private `total`. Components `evaluator`/`planner`/
  `executor`/`finalizer` (add `'executor'` to `LlmComponent`). The role is
  explicit at the call site, so the shared planner/finalizer client is attributed
  correctly. **Model attribution (review #1 / prev #3):** `LlmCallEntry.model` is
  **required**, but `SmartServerLlmConfig.model` is **optional** — so do **not**
  read the config. Pass the **actual built instances'** `.model` into the handler:
  `evaluatorLlm.model` / `plannerLlm.model` / `executorLlm.model` (each with a
  `?? 'unknown'` fallback). The controller builds only `evaluator`/`planner`/
  `executor` (`controller.ts:100`); the finalizer runs on the **planner** client,
  so its entry uses `plannerLlm.model`. Thread these three resolved model strings
  into the handler (e.g. `deps.models = { evaluator, planner, executor }`). `durationMs` is **`0`** — the current `logUsage(role, usage)` callback
  receives no timing (review #3); this matches the existing `rag-query.ts:108`
  precedent (`durationMs: 0` when not separately measurable). Per-call timing is a
  deferred nicety (would require threading a duration through `SubagentResult`).
  The `[controller] tokens <role>` DEBUG line stays (logUsage emits it).
- **Target-state embeddings:** `establishTargetState` already returns the
  evaluator LLM `usage`; extend it to also return the summed embedding `usage`
  from its two `embedder.embed()` calls (`target-state.ts:75-76`). Embeddings are
  **not** routed through `deps.models` (which holds only the LLM roles, review #1):
  the handler logs them with fixed `component:'embedding', model:'embedder'`
  (matching `rag-query.ts`), `durationMs: 0`, `requestId: meta.traceId`. (Concretely,
  `logUsage` resolves `model = role === 'embedding' ? 'embedder' : (deps.models[role] ?? 'unknown')`.)
- **toolsRag query embeddings:** extend the `IToolsRagHandle.query` contract to be
  request-aware (see below) so the controller's `deps.selectTools` calls
  (handler `:218,:386`) log their query-embedding usage.
- **Everything else is kept as-is** (Migration inventory).

### `IToolsRagHandle` contract extension (review #2)

`query` closes over the startup `resolvedEmbedder` (`smart-server.ts:1940`) and
takes no `CallOptions`, so a controller-side wrapper cannot reach it. Extend the
interface (`interfaces/knowledge-rag.ts:60`):

```ts
query(
  text: string,
  k?: number,
  accounting?: { requestLogger: IRequestLogger; requestId?: string },
): Promise<readonly LlmTool[]>;
```

When `accounting` is present, the handle reads the `QueryEmbedding`'s usage
(`QueryEmbedding.getUsage()`, as `rag-query.ts` does) and logs
`logLlmCall({ component:'embedding', model:'embedder', …, requestId })`. The
parameter is **optional**: existing callers (stepper, cyclic-factory,
need-resolver) compile and behave unchanged; the controller passes
`{ requestLogger: ctx.requestLogger, requestId: meta.traceId }`. (The Stepper has
the same minor toolsRag-embedding gap today and can adopt the same param later;
out of scope here.)

### Consumer delivery — one terminal `getSummary` chunk on every path

Exactly one usage-bearing chunk per request,
`{ content:'', usage: summaryToUsage(getSummary(traceId)) + byModel }`, emitted by
whichever component owns the path — **not** a generic agent-level chunk on the
pipeline branch (that would double the Stepper/DAG chunk, review #1):

- flat — already emits it (unchanged).
- **Stepper / DAG handlers** — already emit it on most terminal branches
  (`stepper-coordinator-handler.ts:172,229,274`, `dag-coordinator.ts`). **Gap to
  fix (review #2):** the Stepper `InsufficientSignal` branch (`:257-267`) yields a
  stop chunk **without** usage — add `summaryToUsage(getSummary(traceId))` there so
  every Stepper terminal branch carries the chunk. (Audit all coordinator terminal
  yields for the same omission.)
- **controller handler** — the `surface*` methods (`:552-584`) already accept a
  `usage?` parameter; `execute()` (which holds `meta.traceId`) computes
  `summaryToUsage(ctx.requestLogger.getSummary(meta.traceId))` and passes it in
  place of the private `total` (review #2 — `surface*` need no new access to
  `meta`; the caller supplies the usage). One chunk, same pattern as Stepper/DAG.
- **pass** — has no coordinator handler, so the agent handles it (`agent.ts:700-722`):
  the pass loop currently forwards provider chunks **including** `chunk.value.usage`
  (`:714`). To keep one usage-bearing chunk (review #1): accumulate provider usage
  across the stream, **yield each chunk as a copy with `usage` omitted**, log the
  accumulated usage once into `IRequestLogger` (pass does not run the tool-loop
  handler → additive, no double count), then emit the single `getSummary` terminal
  chunk. The pass log entry uses `component:'tool-loop'` (the main model produces
  the answer), `model: this._mainLlm.model ?? 'unknown'`, `durationMs:` measured
  around the pass stream, `requestId: traceId`.

The agent's pipeline branch (`:736`) is **not** changed — each coordinator handler
owns its single terminal usage chunk.

Intermediate provider stream usage is logged but **not** surfaced as a
usage-bearing chunk — preserving the flat path's invariant of exactly one usage
chunk per request, so `process()`'s sum is correct and never doubles.

### Systemic fix — traceId normalization

In `streamProcess` (`agent.ts:~653`), after deriving `traceId`, write it back:
`opts = { ...opts, trace: { ...opts?.trace, traceId } }`. Every downstream
`logLlmCall` then carries `requestId`, and the terminal-chunk `getSummary(traceId)`
reads this request's delta. `process()` is unchanged — it sums the terminal chunk
and never calls `getSummary` itself, so it needs no traceId (review #1).

```
 flat sites · stepper LoggingLlm · controller logUsage→requestLogger · target-state emb · toolsRag(accounting) · pass(once)
        │   (all → logLlmCall, requestId = normalized traceId)
        ▼
   IRequestLogger (per-traceId delta + cumulative)
        │ getSummary(traceId)                          getSummary() → /v1/usage
        ▼
   streamProcess yields ONE terminal usage chunk
        ├─ SSE consumer: final usage event
        └─ process(): sums chunk usage → response.usage
```

## Migration inventory (review #2)

**KEEP** (already feed `IRequestLogger`):
- `rag/preprocessor.ts:84,141,215`, `rag/query-expander.ts:49`,
  `rag/tool-indexing-strategy.ts:103`, `classifier/llm-classifier.ts:143`
- `pipeline/handlers/tool-loop.ts:518`, `summarize.ts:51`, `translate.ts:44`,
  `rag-query.ts:102` (**flat-path embeddings — kept; not re-wrapped**),
  `dag-coordinator.ts:115`
- `builder.ts:1025,1059,1094,1254`, `agent.ts:1983`
- Stepper: `coordinator/stepper/logging-llm.ts`, `build-stepper-root.ts:242`,
  `stepper-coordinator-handler.ts:97`

**ADD** (currently unlogged → additive):
- Controller `logUsage` → `ctx.requestLogger.logLlmCall` (subagent LLMs).
- Controller target-state embedding logging (via returned usage).
- Controller toolsRag query-embedding logging (via `accounting` param).
- Pass-path single-call logging.

**REPLACE**:
- Controller terminal-chunk usage source: private `total` → `summaryToUsage(getSummary(meta.traceId))`.

**REMOVE**:
- Controller private `total` accumulator + the `[controller] turn total` aggregate
  line (per-role `[controller] tokens <role>` lines stay).

No call is logged twice: every ADD targets a currently-unlogged site; no blanket
decorator; the embedder is not globally wrapped; one terminal usage chunk owned by
the path's component.

## Contract changes (`@mcp-abap-adt/llm-agent`)

- Add `'executor'` to the `LlmComponent` union; map it to `'request'` in
  `CATEGORY_MAP`.
- Extend `IToolsRagHandle.query` with the optional `accounting` parameter above.
- No new aggregator/recorder interfaces. Reuse `IRequestLogger`, `LlmCallEntry`,
  `RequestSummary`, `summaryToUsage`, `QueryEmbedding.getUsage`.

## Changes by package

- **`@mcp-abap-adt/llm-agent`** — `'executor'` in `LlmComponent` + `CATEGORY_MAP`;
  `IToolsRagHandle.query` `accounting` param.
- **`@mcp-abap-adt/llm-agent-libs`** —
  - `agent.ts`: normalize `opts.trace.traceId` at `~:653`; on the **pass** path
    (`:700-722`) accumulate provider usage, yield chunks with `usage` omitted, log
    the accumulated usage once, then emit the terminal `getSummary` usage chunk.
    **Do not** change the pipeline branch (`:736`) or `process()` (`:616-622`); the
    flat path is unchanged.
- **`@mcp-abap-adt/llm-agent-server-libs`** —
  - `controller.ts`: thread the built instances' resolved models into the handler
    (`deps.models = { evaluator: evaluatorLlm.model ?? 'unknown', planner:
    plannerLlm.model ?? 'unknown', executor: executorLlm.model ?? 'unknown' }`).
  - controller handler: `logUsage` writes to `ctx.requestLogger.logLlmCall`
    (subagent roles, `durationMs: 0`; model from `deps.models[role]`, finalizer →
    `deps.models.planner`) and logs target-state embedding usage; `surfaceFinal`/
    `surfaceClarify`/
    `surfaceToolCall` (`:552-584`) emit
    `summaryToUsage(ctx.requestLogger.getSummary(meta.traceId))` (one terminal
    chunk, like Stepper/DAG); delete the private `total` accumulator and the
    `turn total` line.
  - `stepper-coordinator-handler.ts`: attach `summaryToUsage(getSummary(traceId))`
    to the `InsufficientSignal` terminal stop chunk (`:263`) — review #2.
  - `controller/target-state.ts`: return summed embedding usage.
  - `controller.ts` `deps.selectTools`: pass `accounting` to `toolsRag.query`.
  - `smart-server.ts` `_toolsRagHandle.query`: accept `accounting`, log the
    query-embedding usage via `QueryEmbedding.getUsage()`.
- **Provider packages** — touched **only** to emit streaming `usage` on a stream
  chunk (`include_usage` or equivalent) so the flat/stepper `LoggingLlm.streamChat`
  accumulation is non-empty. No provider-internal logging.

## Edge cases & handling

| # | Risk | Handling |
|---|------|----------|
| 1 | Controller `LoggingLlm` can't bind traceId / distinguish shared planner+finalizer | Controller logs at **request time** via `logUsage`→`ctx.requestLogger`, role explicit at the call site, `requestId = meta.traceId`. No build-time wrapper. |
| 2 | toolsRag embeddings (startup-bound embedder) unlogged | `IToolsRagHandle.query` gains an optional `accounting` param; the handle logs query-embedding usage; the controller passes `ctx.requestLogger` + `traceId`. |
| 3 | `process()` can't see generated `traceId` | `process()` does not call `getSummary`; it sums the terminal chunk built (in `streamProcess`) from the locally-normalized `traceId`. |
| 4 | Pass path diverges from single source | Pass logs its one call into `IRequestLogger`, then emits the same `getSummary` terminal chunk → `response.usage == /v1/usage`. |
| 5 | Double counting | Every ADD is a currently-unlogged site; embedder not globally wrapped; exactly one usage-bearing chunk per request — emitted by the owning component (flat / Stepper / DAG / controller handler / pass), **never** a generic agent-level chunk on the pipeline branch (review #1). |
| 9 | Controller `logUsage` lacks `durationMs` | Use `durationMs: 0` (rag-query.ts:108 precedent); per-call timing deferred. |
| 10 | Stepper toolsRag query-embedding still unlogged | Accepted pre-existing gap; Goal #1 scoped accordingly; closable later via the optional `accounting` param. |
| 11 | Pass forwards provider `usage` chunks → double with terminal chunk | Pass yields chunk copies with `usage` omitted; accumulates + logs provider usage once; one terminal `getSummary` chunk (review #1). |
| 12 | A coordinator terminal branch yields no usage (e.g. Stepper `InsufficientSignal` `:263`) | Fix that branch to attach `getSummary` usage; audit all terminal yields (review #2). |
| 13 | Finalizer model unknown (no `subagents.finalizer`) | Finalizer runs on the planner client → `model: plannerLlm.model ?? 'unknown'`. |
| 6 | Per-model overwrite (`agent.ts:621`) | Only one usage chunk carries `models`; the terminal chunk carries the full `getSummary` `byModel`. |
| 7 | Stream usage absent from provider | `LoggingLlm.streamChat` accumulates `chunk.usage`; providers enable `include_usage`. |
| 8 | Concurrent requests | `SessionRequestLogger` keys deltas by `requestId`; reliable once `traceId` is normalized into `opts`. |

## Testing

- **traceId normalization (review #1-prev)**: `process('x')` with no `trace` →
  `logLlmCall` entries carry a non-empty `requestId`; `response.usage` equals
  `getSummary(thatId)` (request-scoped, not cumulative).
- **Controller request-time logging (review #1)**: a controller turn →
  `byComponent` has `evaluator`/`planner`/`executor`/`finalizer` (planner and
  finalizer distinct despite the shared client) + `embedding`;
  `response.usage == summaryToUsage(getSummary(traceId))` and equals the
  independent sum of all subagent + embedder calls.
- **toolsRag accounting (review #2)**: a stubbed `toolsRag.query` with
  `accounting` logs one `embedding` entry per `selectTools` call; without
  `accounting`, no entry (back-compat).
- **Single-usage-chunk invariant**: `streamProcess` (controller, pass, flat)
  yields exactly one usage-bearing chunk; `process()` sums it to
  `getSummary(traceId)`.
- **Pass unification + single chunk (review #1)**: a streamed pass response yields
  exactly one usage-bearing chunk (forwarded provider chunks carry no `usage`), and
  `response.usage` equals its `/v1/usage` delta.
- **Stepper InsufficientSignal (review #2)**: a Stepper turn that hits
  `InsufficientSignal` still yields a terminal chunk with `getSummary`-derived
  usage (non-empty when calls were logged).
- **Finalizer model (review #3)**: a controller turn whose finalizer fires logs a
  `finalizer` entry under `byModel[plannerLlm.model]`.
- **No regression**: a flat turn's `response.usage` is byte-identical to today.

## Migration / rollout

One coherent change: controller request-time logging (LLM + embeddings) + toolsRag
`accounting` + pass logging + traceId normalization + the terminal `getSummary`
chunk on coordinator/pass + the Stepper `InsufficientSignal` fix, and **replace**
the controller's private-total terminal usage with logger-derived usage (the
terminal chunk is kept; only its source changes) while removing the private `total`
accumulator — all in the **same** commit, so there is never a window with two live
`response.usage` derivations. Lockstep.

## Deferred

- Stepper toolsRag query-embedding logging (same optional `accounting` param;
  pre-existing minor gap).
- Surfacing a per-component breakdown on `response.usage` (already in
  `RequestSummary.byComponent`; `/v1/usage` exposes it).
