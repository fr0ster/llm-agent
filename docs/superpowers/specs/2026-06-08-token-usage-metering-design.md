# End-to-End Token Usage Metering — Design

**Date:** 2026-06-08
**Status:** Design (approved for planning)

## Problem

`response.usage` undercounts real token spend on the **controller** pipeline, and
streaming clients can miss usage on coordinator/pass paths. Root causes:

1. **Controller subagent calls are never logged to the aggregator.** The flat
   path and the **Stepper** already log every LLM call into the per-session
   `IRequestLogger` (default impl `SessionRequestLogger`) — the flat path via
   semantic call sites (`preprocessor.ts`→`translate`, `classifier.ts`→
   `classifier`, `tool-loop.ts`→`tool-loop`, …) and the Stepper via a per-role
   `LoggingLlm` decorator (`coordinator/stepper/logging-llm.ts`,
   `build-stepper-root.ts:242`). The **controller** does neither: it keeps a
   private `total` and emits it on its terminal chunk. Its subagent spend
   (evaluator/planner/executor/finalizer) and embeddings never enter the logger.

2. **The coordinator `response.usage` derivation differs from the flat path.**
   The flat path derives `response.usage` from
   `summaryToUsage(getSummary(traceId))` (`agent.ts:1237,1595,1711,1753`). The
   coordinator branch (`agent.ts:567-635`) instead sums `usage` from yielded
   stream **chunks** into a private `totalUsage` (and *overwrites* `models` at
   `:621`). For the controller that chunk carries the controller's own hand-rolled
   total — a *second* aggregator that can diverge from the logger. A single
   potential discrepancy nullifies the point of accounting.

3. **`traceId` is generated but not written back into `CallOptions`.**
   `agent.ts:653` does `traceId = options?.trace?.traceId ?? randomUUID()` but
   never puts the generated id into `opts`. Downstream `logLlmCall` entries then
   carry no `requestId` (→ session-cumulative only), and `getSummary(undefined)`
   returns the session-cumulative bucket (including prior requests) instead of
   this request's delta.

4. **No final usage chunk on streaming coordinator/pass paths.** `streamProcess`
   pass (`agent.ts:700-722`) and pipeline (`:726-738`) paths forward chunks and
   return without emitting an aggregate usage chunk, so SSE clients get no
   `usage` once the controller stops emitting its own.

The aggregator and the logging decorator **already exist and are correct**. This
design does **not** introduce a new aggregator, a new recorder interface, or an
AsyncLocalStorage scope. It (a) routes the missing calls (controller subagents +
embeddings) into the existing `IRequestLogger` using the existing `LoggingLlm`
pattern, and (b) fixes three systemic issues so every path derives and emits the
same logger-backed `response.usage`.

## Goals

1. **Accurate** — `response.usage` equals the sum of every LLM and embedder call
   in the request, on every path (flat, stepper, controller, pass).
2. **Single source of truth** — exactly one aggregator, the `IRequestLogger`
   interface (default impl `SessionRequestLogger`). All paths derive
   `response.usage` from `getSummary(traceId)`; the controller's private sum and
   the chunk-sum path are removed.
3. **Work through interfaces** — consume the aggregator via `IRequestLogger`,
   never a concrete class; reuse the existing `LoggingLlm` `ILlm` decorator and a
   new analogous `LoggingEmbedder` `IEmbedder` decorator.
4. **Reuse, minimal delta** — keep every existing logging site; only *add* the
   controller/embedder logging and *fix* the systemic derivation/traceId/stream
   issues. No mass refactor of working logging paths.

## Non-Goals

- A new `IUsageMeter` / `IUsageRecorder` interface, `CallOptions.usageComponent`,
  AsyncLocalStorage scope, or a "blanket decorator that replaces all logging."
  Earlier drafts proposed these; they duplicate `IRequestLogger`/`LoggingLlm` and
  would double-count against the ~15 existing logging sites. **Dropped.**
- Reconciling the controller's `[controller]` DEBUG per-call lines with
  `response.usage`. Those per-subagent diagnostics stay; the controller's
  aggregate `turn total` line and terminal-chunk `usage` are removed.
- Provider-side numeric accuracy (a provider mis-reporting its own `usage`).

## Architecture

### Aggregator — `IRequestLogger` (default impl `SessionRequestLogger`)

Unchanged. Already routes each `logLlmCall(entry)` to a per-`requestId` delta
**and** the session-cumulative bucket; aggregates `byModel`/`byComponent`/
`byCategory` + `requests`; yields `response.usage` via `getSummary(traceId)` →
`summaryToUsage` and `/v1/usage` via `getSummary()`; nested-safe for workers.
Pluggability is the interface: a different rollup = a different `IRequestLogger`
wired into the `SessionGraph`.

### Logging at the boundary — reuse `LoggingLlm`, add `LoggingEmbedder`

- `LoggingLlm(inner, (usage, durationMs) => …)` already wraps an `ILlm` and
  reports usage once per `chat`/`streamChat` (accumulating stream-chunk usage).
  It is the authoritative per-role logging path in the Stepper.
- `LoggingEmbedder(inner, (usage, durationMs) => …)` — new, analogous `IEmbedder`
  decorator (`adapters/logging-embedder.ts`) reporting embedding token usage
  (providers that surface it) with `component:'embedding'`.
- Component attribution is **per call site / per role**, the existing model:
  semantic sites pass their own component (`translate`, `query-expander`,
  `classifier`, …); per-role wrappers carry the role (`planner`, `executor`, …).
  No shared-instance mislabel because each wrap/site has a fixed, known component.

### Controller adopts the Stepper logging pattern

The controller wraps each subagent LLM it builds via `ctx.makeLlm` with
`LoggingLlm`, binding the callback to the request logger and `traceId`, exactly as
`stepper-coordinator-handler.ts:97` + `build-stepper-root.ts:242` do:

```
new LoggingLlm(inner, (u, d) => ctx.requestLogger.logLlmCall({
  component, model: inner.model ?? 'unknown',
  promptTokens: u.promptTokens, completionTokens: u.completionTokens,
  totalTokens: u.totalTokens, durationMs: d, requestId: traceId,
}))
```

Components: `evaluator` / `planner` / `executor` / `finalizer` (add `'executor'`
to `LlmComponent`). The controller's private `total` accumulator, the
`[controller] turn total` line, and the terminal-chunk `usage` are removed; the
per-subagent `[controller] tokens <role>` DEBUG lines stay.

### Systemic fixes

- **traceId normalization** (`agent.ts:653`): after deriving `traceId`, write it
  back — `opts = { ...opts, trace: { ...opts?.trace, traceId } }` — so every
  downstream `logLlmCall` carries `requestId` and `getSummary(traceId)` is
  request-scoped.
- **Unified `response.usage` (metered paths)**: the coordinator branch
  (`567-635`) derives `usage = summaryToUsage(getSummary(traceId))` + `byModel`,
  like the flat path. Delete the `totalUsage` accumulator and the `models`
  overwrite (`:621`).
- **Final usage chunk on all streaming paths**: `streamProcess` emits **one**
  terminal chunk `{ content: '', usage }` at the end of each path. Source by path:
  - flat / coordinator (controller, stepper, dag) → `getSummary(traceId)`-derived;
  - **pass** (transparent proxy) → its own accumulated stream-chunk usage. Pass
    calls `_mainLlm.streamChat` directly and is intentionally *not* routed through
    the logger (wrapping `_mainLlm` in `LoggingLlm` would double-count against the
    tool-loop handler), so its single passthrough call's accumulated usage is the
    complete and correct total for that path.

```
 flat sites (translate/classifier/tool-loop/…) ─┐
 stepper LoggingLlm (planner/executor/…) ───────┤
 controller LoggingLlm (evaluator/…/finalizer) ─┼─► IRequestLogger.logLlmCall
 LoggingEmbedder (embedding) ────────────────────┘     │ (per-traceId delta + cumulative)
                                  getSummary(traceId) ▼
              response.usage (+byModel, emitted as final stream chunk)   /v1/usage (cumulative)
```

## Migration inventory (finding #2)

Every existing LLM/embedder logging path, with disposition:

**KEEP** (already feed `IRequestLogger`; consumed by `getSummary` on flat/stepper):
- `rag/preprocessor.ts:84,141,215` (translate / query-expander / helper)
- `rag/query-expander.ts:49`, `rag/tool-indexing-strategy.ts:103`
- `classifier/llm-classifier.ts:143`
- `pipeline/handlers/tool-loop.ts:518`, `summarize.ts:51`, `translate.ts:44`,
  `rag-query.ts:102`, `dag-coordinator.ts:115`
- `builder.ts:1025,1059,1094,1254` (tool-loop / main)
- `agent.ts:1983` (`_summarizeHistory` → helper)
- Stepper: `coordinator/stepper/logging-llm.ts`, `build-stepper-root.ts:242`,
  `stepper-coordinator-handler.ts:97`

**ADD**:
- Controller subagent + finalizer logging via `LoggingLlm`.
- `LoggingEmbedder` around embedders (`component:'embedding'`).

**REMOVE**:
- Controller private `total` accumulator + `[controller] turn total` line +
  terminal-chunk `usage`.
- `agent.ts:567-635` chunk-sum `totalUsage` (coordinator) and the `models`
  overwrite (`:621`); the pass path's lack of a usage chunk.

No call is logged twice: the controller subagents and embedders are **not**
currently logged, so adding `LoggingLlm`/`LoggingEmbedder` there is additive-only;
no blanket decorator is layered over already-logged sites.

## Contract changes (`@mcp-abap-adt/llm-agent`)

- Add `'executor'` to the `LlmComponent` union (controller role); map it to
  `'request'` in `CATEGORY_MAP`. All other components already exist.
- No new interfaces. Reuse `IRequestLogger`, `LlmCallEntry`, `RequestSummary`,
  `summaryToUsage`.

## Changes by package

- **`@mcp-abap-adt/llm-agent`** — `'executor'` in `LlmComponent` + `CATEGORY_MAP`.
- **`@mcp-abap-adt/llm-agent-libs`** —
  - `adapters/logging-embedder.ts` (new `LoggingEmbedder`).
  - `agent.ts`: normalize `opts.trace.traceId` at `:653`; coordinator branch
    (`567-635`) derives `usage` from `getSummary(traceId)`; delete `totalUsage` +
    `models` overwrite; emit a final usage chunk on the pipeline path
    (`getSummary`-derived) and the pass path (accumulated stream usage).
  - builder/embedder wiring: wrap the embedder in `LoggingEmbedder`.
- **`@mcp-abap-adt/llm-agent-server-libs`** — controller handler: wrap subagent
  LLMs in `LoggingLlm` bound to `ctx.requestLogger` + `traceId`; delete the
  private `total`, the `turn total` line, and terminal-chunk `usage`.
- **Provider packages** — touched **only** to ensure streaming `usage` is emitted
  on a stream chunk (`stream_options.include_usage` or equivalent) so
  `LoggingLlm.streamChat` accumulation is non-empty. No provider-internal logging.
- **Embedder packages** — touched **only** if they must surface token usage in
  `IEmbedResult` for `LoggingEmbedder` to record.

## Edge cases & handling

| # | Risk | Handling |
|---|------|----------|
| 1 | Generated `traceId` not in `opts` → unscoped logging / cumulative `getSummary` | Normalize `opts.trace.traceId` at `agent.ts:653`. Test: `process('x')` with no `trace` yields a request-scoped `response.usage`. |
| 2 | Double counting from a new decorator over already-logged sites | No blanket decorator; only add logging where it is currently absent (controller subagents, embedders). Full migration inventory above. |
| 3 | Streaming coordinator/pass loses usage | `streamProcess` emits one final usage chunk per path: coordinator/flat from `getSummary(traceId)`, pass from its accumulated stream usage (pass is not logger-routed). |
| 4 | Component mislabel on a shared instance | Existing model retained: log at semantic sites / per-role wrappers, each with a fixed known component. |
| 5 | Per-model overwrite (`agent.ts:621`) | Removed with the chunk path; `aggregate()` `byModel` merge is additive. |
| 6 | Stream usage absent from provider | `LoggingLlm.streamChat` accumulates `chunk.usage`; providers enable `include_usage`. |
| 7 | Provider mis-reports usage | Out of scope; recorded as returned (`estimated` flag carries through). |
| 8 | Concurrent requests | `SessionRequestLogger` keys deltas by `requestId`; nested coordinator/worker semantics already handled — now reliable because `traceId` is normalized into `opts`. |

## Testing

- **traceId normalization (review #1)**: `agent.process('x')` with no `trace` →
  `response.usage` reflects only this request (a stub logger asserts `logLlmCall`
  received a non-empty `requestId`, and `getSummary(thatId)` equals the response).
- **Controller integration (the regression)**: a controller turn with a Cyrillic
  prompt (triggers translate) + N subagent calls → `response.usage ==
  summaryToUsage(getSummary(traceId))`, includes translate + every subagent +
  finalizer, and equals the independent sum of all provider invocations;
  `byComponent` has `evaluator`/`planner`/`executor`/`finalizer` buckets.
- **Streaming usage chunk (review #3)**: a streamed controller and a streamed
  pass response each emit exactly one terminal chunk carrying the aggregate
  `usage`.
- **`LoggingEmbedder` unit**: records `component:'embedding'` token usage.
- **No double-count**: a flat turn's `response.usage` is unchanged from today
  (the KEEP sites are untouched; only derivation path is unified).

## Migration / rollout

One coherent change: add controller/embedder logging + traceId normalization +
the unified `getSummary` derivation + the final-usage-chunk emission, and remove
the controller private sum + chunk path in the **same** commit, so there is never
a window with two live `response.usage` derivations. Lockstep-versioned.

## Deferred

- Surfacing a per-component breakdown on `response.usage` (data already in
  `RequestSummary.byComponent`; `/v1/usage` already exposes it).
- Embedder provider changes beyond surfacing token counts.
