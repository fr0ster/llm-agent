# End-to-End Token Usage Metering — Design

**Date:** 2026-06-08
**Status:** Design (approved for planning)

## Problem

`response.usage` undercounts real token spend on the **controller** pipeline, and
streaming clients can miss usage on coordinator/pass paths. Root causes:

1. **Controller subagent + embedding calls never reach the aggregator.** The flat
   path and the **Stepper** log every LLM call into the per-session
   `IRequestLogger` (default impl `SessionRequestLogger`) — the flat path via
   semantic call sites (`preprocessor.ts`→`translate`, `classifier.ts`→
   `classifier`, `tool-loop.ts`→`tool-loop`, embeddings via `rag-query.ts:102`
   reading `QueryEmbedding.getUsage()`), the Stepper via a per-role `LoggingLlm`
   decorator (`coordinator/stepper/logging-llm.ts`, `build-stepper-root.ts:242`).
   The **controller** does neither: it keeps a private `total` and emits it on its
   terminal chunk. Its subagent spend (evaluator/planner/executor/finalizer) and
   its embedder calls (`controller/target-state.ts:75-76`, toolsRag) never enter
   the logger.

2. **The controller's `response.usage` is a second, divergent total.** The flat
   path emits `summaryToUsage(getSummary(traceId))` as one terminal usage chunk
   inside `streamProcess` (`agent.ts:1237,1595,1711,1753`), which `process()` sums
   (`:616-622`) for non-streaming and SSE forwards for streaming. The controller
   instead emits its own hand-rolled total on its terminal chunk — a separate
   aggregator that can diverge from `getSummary`/`/v1/usage`.

3. **`traceId` is generated but not visible to the logger.** `agent.ts:653` does
   `traceId = options?.trace?.traceId ?? randomUUID()` but never writes it into
   `opts`. Downstream `logLlmCall` entries then carry no `requestId`, so they land
   in the session-cumulative bucket only and the per-request delta is empty.

4. **No final usage chunk on streaming coordinator/pass paths.** `streamProcess`
   pass (`agent.ts:700-722`) and pipeline (`:726-738`) paths forward chunks and
   return without the terminal `getSummary` usage chunk the flat path emits.

## Key insight — the architecture already exists in the flat path

Two concerns are **already decoupled** by the flat path, and the fix is to make
the coordinator/pass paths conform — not to invent new machinery:

- **Internal accounting (uniform):** every LLM/embedder call logs into the
  `IRequestLogger` interface. One aggregator, many loggers (semantic sites +
  per-role `LoggingLlm`). Component attribution is fixed per site/role.
- **Consumer delivery (protocol-specific, single source):** `streamProcess`
  yields **exactly one** terminal usage chunk built from
  `summaryToUsage(getSummary(traceId))`. The **streaming** consumer (SSE) reads
  that chunk as the final usage event; the **non-streaming** consumer
  (`process()`) sums chunk usage (`:616-622`) — which is just that one chunk.

No separate `IRequestLogger` implementation is needed for streaming vs
non-streaming: logging is uniform; only delivery differs, and both delivery modes
read the same terminal chunk. This does not change the flat path (which already
works this way), so it does not break existing implementations.

## Goals

1. **Accurate** — `response.usage` equals the sum of every LLM and embedder call,
   on every path (flat, stepper, controller, pass).
2. **One internal aggregator** — the `IRequestLogger` interface (default impl
   `SessionRequestLogger`). The controller's private sum is removed; all paths'
   usage comes from `getSummary(traceId)`.
3. **Internal logging decoupled from consumer delivery** — logging is uniform;
   delivery is one terminal `getSummary` usage chunk, consumed by SSE (streaming)
   or summed by `process()` (non-streaming). Reuse the existing `LoggingLlm`
   `ILlm` decorator; add an analogous `LoggingEmbedder`.
4. **Reuse, minimal delta, additive-only** — keep every existing logging site;
   only *add* logging where it is currently absent (controller subagents,
   controller embeddings), *fix* the systemic traceId/derivation/stream issues,
   and *remove* only the controller's private total + its terminal-chunk usage.

## Non-Goals

- A new `IUsageMeter` / `IUsageRecorder`, `CallOptions.usageComponent`,
  AsyncLocalStorage scope, a blanket decorator replacing all logging, or
  protocol-specific logger implementations. Earlier drafts proposed these; they
  duplicate `IRequestLogger`/`LoggingLlm` and would double-count. **Dropped.**
- Removing `process()`'s chunk-usage summation (`:616-622`) — the flat path
  relies on it to turn the terminal `getSummary` chunk into `response.usage`.
- Globally wrapping the embedder — `rag-query.ts:102` already logs embeddings;
  a global wrap would double-count.
- Reconciling the controller's `[controller]` DEBUG per-call lines with
  `response.usage`. Those stay; only the controller's aggregate `turn total` line
  and terminal-chunk `usage` are removed.
- Provider-side numeric accuracy.

## Architecture

### Aggregator — `IRequestLogger` (default impl `SessionRequestLogger`)

Unchanged. Per-`requestId` delta (for `response.usage`) + session-cumulative
(for `/v1/usage`); `byModel`/`byComponent`/`byCategory` + `requests`; nested-safe.
Pluggability is the interface: a different rollup = a different `IRequestLogger`
wired into the `SessionGraph`.

### Internal logging — reuse `LoggingLlm`, add `LoggingEmbedder`, additive-only

- **Controller subagents:** wrap each subagent LLM built via `ctx.makeLlm` in the
  existing `LoggingLlm`, binding the callback to `ctx.requestLogger.logLlmCall`
  with `requestId: traceId`, exactly as `stepper-coordinator-handler.ts:97` +
  `build-stepper-root.ts:242` do. Components `evaluator`/`planner`/`executor`/
  `finalizer` (add `'executor'` to `LlmComponent`).
- **Controller embeddings:** the controller does **not** go through `rag-query.ts`,
  so its `target-state`/toolsRag embed calls are unlogged today. Add a
  `LoggingEmbedder` (`adapters/logging-embedder.ts`, analogous to `LoggingLlm`,
  `component:'embedding'`) wrapping **only the controller's embedder**. This is
  additive — the flat path's embedding logging (`rag-query.ts`) is untouched and
  no instance is double-wrapped.
- **Everything else is kept as-is** (see Migration inventory).

### Consumer delivery — one terminal `getSummary` chunk on every path

`streamProcess` yields **exactly one** usage-bearing chunk per request,
`{ content: '', usage: summaryToUsage(getSummary(traceId)) + byModel }`, built
from the locally-normalized `traceId`:

- flat — already does this (unchanged).
- **coordinator** (controller/stepper/dag): emit it before the pipeline branch
  returns (`:736`). The controller stops emitting its own total.
- **pass**: log the single passthrough call once to `IRequestLogger` (pass does
  not run the tool-loop handler, so this is additive — no double count), then emit
  the same `getSummary` terminal chunk before returning (`:722`).

Intermediate provider stream usage is consumed by `LoggingLlm` for logging but is
**not** surfaced to the consumer as a usage-bearing chunk — preserving the flat
path's existing invariant of exactly one usage chunk per request, so `process()`'s
sum is correct and never doubles.

### Systemic fix — traceId normalization

In `agent.ts` (the `streamProcess` entry, `~:653`), after deriving `traceId`,
write it back: `opts = { ...opts, trace: { ...opts?.trace, traceId } }`. Every
downstream `logLlmCall` then carries `requestId`, and the terminal-chunk
`getSummary(traceId)` reads this request's delta. `process()` is unchanged — it
sums the terminal chunk and never calls `getSummary` itself, so it needs no
traceId (resolves review #1).

```
 flat sites · stepper LoggingLlm · controller LoggingLlm · LoggingEmbedder · pass(once)
        │  (all → logLlmCall, requestId = normalized traceId)
        ▼
   IRequestLogger (per-traceId delta + cumulative)
        │ getSummary(traceId)                         getSummary() → /v1/usage
        ▼
   streamProcess yields ONE terminal usage chunk
        ├─ SSE consumer: final usage event
        └─ process(): sums chunk usage → response.usage
```

## Migration inventory (review #2)

**KEEP** (already feed `IRequestLogger`; consumed via `getSummary`):
- `rag/preprocessor.ts:84,141,215`, `rag/query-expander.ts:49`,
  `rag/tool-indexing-strategy.ts:103`
- `classifier/llm-classifier.ts:143`
- `pipeline/handlers/tool-loop.ts:518`, `summarize.ts:51`, `translate.ts:44`,
  `rag-query.ts:102` (**embeddings — kept; not re-wrapped**), `dag-coordinator.ts:115`
- `builder.ts:1025,1059,1094,1254`, `agent.ts:1983` (`_summarizeHistory`)
- Stepper: `coordinator/stepper/logging-llm.ts`, `build-stepper-root.ts:242`,
  `stepper-coordinator-handler.ts:97`

**ADD** (currently unlogged → additive):
- Controller subagent + finalizer logging via `LoggingLlm`.
- Controller embedder via `LoggingEmbedder`.
- Pass-path single-call logging.

**REMOVE**:
- Controller private `total` accumulator + `[controller] turn total` line +
  terminal-chunk `usage`.

No call is logged twice: every ADD targets a call site that is **not** logged
today; no blanket decorator is layered over a logged site; the embedder is wrapped
only for the controller.

## Contract changes (`@mcp-abap-adt/llm-agent`)

- Add `'executor'` to the `LlmComponent` union; map it to `'request'` in
  `CATEGORY_MAP`. No new interfaces. Reuse `IRequestLogger`, `LlmCallEntry`,
  `RequestSummary`, `summaryToUsage`.

## Changes by package

- **`@mcp-abap-adt/llm-agent`** — `'executor'` in `LlmComponent` + `CATEGORY_MAP`.
- **`@mcp-abap-adt/llm-agent-libs`** —
  - `adapters/logging-embedder.ts` (new `LoggingEmbedder`).
  - `agent.ts`: normalize `opts.trace.traceId` at `~:653`; emit the terminal
    `getSummary` usage chunk on the pipeline path (`:736`) and the pass path
    (`:722`); for pass, log its single call once before emitting. Leave
    `process()` (`:616-622`) and the flat path unchanged.
- **`@mcp-abap-adt/llm-agent-server-libs`** — controller handler: wrap subagent
  LLMs in `LoggingLlm` (bound to `ctx.requestLogger` + `traceId`); wrap the
  controller embedder in `LoggingEmbedder`; delete the private `total`, the
  `turn total` line, and the terminal-chunk `usage`.
- **Provider packages** — touched **only** to ensure streaming `usage` is emitted
  on a stream chunk (`stream_options.include_usage` or equivalent) so
  `LoggingLlm.streamChat` accumulation is non-empty. No provider-internal logging.
- **Embedder packages** — touched **only** if they must surface token usage in
  `IEmbedResult` for `LoggingEmbedder`/`QueryEmbedding.getUsage` to record.

## Edge cases & handling

| # | Risk | Handling |
|---|------|----------|
| 1 | `process()` can't see the generated `traceId` | `process()` does not call `getSummary`; it sums the terminal chunk that `streamProcess` builds from the locally-normalized `traceId`. |
| 2 | `LoggingEmbedder` double-counts vs `rag-query.ts` | Embedder wrapped **only** for the controller (the unlogged path); `rag-query.ts` embedding logging kept untouched. |
| 3 | Pass path diverges from the single source | Pass logs its one call into `IRequestLogger`, then emits the same `getSummary` terminal chunk → `response.usage == /v1/usage`. |
| 4 | Double counting from intermediate stream usage | Exactly one usage-bearing chunk per request (the terminal `getSummary` chunk); intermediate provider usage is logged, not surfaced as a usage chunk. |
| 5 | Per-model overwrite (`agent.ts:621`) | Only one usage chunk carries `models`, so the existing assignment is benign; the terminal chunk carries the full `getSummary` `byModel`. |
| 6 | Component mislabel on a shared instance | Existing model retained: semantic sites / per-role wrappers, each a fixed known component. |
| 7 | Stream usage absent from provider | `LoggingLlm.streamChat` accumulates `chunk.usage`; providers enable `include_usage`. |
| 8 | Concurrent requests | `SessionRequestLogger` keys deltas by `requestId`; now reliable because `traceId` is normalized into `opts`. |

## Testing

- **traceId normalization (review #1)**: `process('x')` with no `trace` →
  the stub logger receives `logLlmCall` entries with a non-empty `requestId`, and
  `response.usage` equals `getSummary(thatId)` (request-scoped, not cumulative).
- **Controller integration (the regression)**: a controller turn with a Cyrillic
  prompt (translate) + N subagent calls + embedder calls →
  `response.usage == summaryToUsage(getSummary(traceId))`, includes translate +
  every subagent + finalizer + embeddings, equals the independent sum of all
  provider/embedder invocations; `byComponent` has the role + `embedding` buckets.
- **Single-usage-chunk invariant (review #4)**: `streamProcess` (controller,
  pass, flat) yields exactly one usage-bearing chunk; `process()` sums it to the
  same value `getSummary(traceId)` reports.
- **Pass unification (review #3)**: a pass request's `response.usage` equals its
  `/v1/usage` delta (both from the logger).
- **`LoggingEmbedder` unit**: records `component:'embedding'`; not invoked on the
  flat path (no double count with `rag-query.ts`).
- **No regression**: a flat turn's `response.usage` is byte-identical to today.

## Migration / rollout

One coherent change: add controller subagent/embedder logging + pass logging +
traceId normalization + the terminal `getSummary` chunk on coordinator/pass, and
remove the controller private sum + terminal usage in the **same** commit, so
there is never a window with two live `response.usage` derivations. Lockstep.

## Deferred

- Surfacing a per-component breakdown on `response.usage` (already in
  `RequestSummary.byComponent`; `/v1/usage` exposes it).
- Embedder provider changes beyond surfacing token counts.
