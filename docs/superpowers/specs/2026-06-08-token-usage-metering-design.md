# End-to-End Token Usage Metering — Design

**Date:** 2026-06-08
**Status:** Design (approved for planning)

## Problem

`response.usage` undercounts real token spend on the **coordinator pipeline
path** (controller / stepper / dag). Two distinct causes:

1. **Two response.usage derivations.** The flat/tool-loop path already derives
   `response.usage` from the mature `SessionRequestLogger` via
   `getSummary(traceId)` + `summaryToUsage` (`agent.ts:1237,1595,1711,1753`). But
   the coordinator path (`agent.ts:567-635`) instead sums `usage` from yielded
   stream **chunks** into a private `totalUsage`. For the controller, that chunk
   carries the controller's own hand-rolled aggregate — a *second* authoritative
   total that can (and does) diverge from the logger. A single potential
   discrepancy nullifies the point of accounting.

2. **Some LLM/embedder calls never reach the logger.** The agent's
   `_toEnglishForRag` (`agent.ts:1939`) returns a string and does not
   `logLlmCall`; controller subagent calls (`makeSubagentClient`,
   `subagent-client.ts`) report usage to the controller's private sum but not to
   `SessionRequestLogger`; embedders never log token usage; streaming usage is
   only captured if the provider emits it on a stream chunk and someone reads it.

The key realisation: **the aggregator abstraction already exists and is
correct.** It is the `IRequestLogger` interface (contracts), whose default wired
implementation `SessionRequestLogger` keys per-traceId deltas (for
`response.usage`) and a session-cumulative bucket (for `/v1/usage`), with
`byModel` / `byComponent` / `byCategory` + request counts, **call-scoped
`component` per `LlmCallEntry`**, and nested-safe coordinator/worker semantics.
This design does **not** introduce a new aggregator interface; it routes every
LLM/embedder call into `IRequestLogger` and makes the coordinator path read from
it.

## Goals

1. **Accurate** — `response.usage` equals the sum of every LLM and embedder call
   in the request, on every pipeline path.
2. **End-to-end (наскрізний)** — host preamble (translate/summarize/classify/
   expand), pipeline subagents, tool-loop rounds, streaming usage, and
   embeddings all counted, regardless of call site.
3. **Single source of truth** — exactly one aggregator, behind the
   `IRequestLogger` interface (default impl `SessionRequestLogger`). The
   coordinator path derives `response.usage` from it; the controller's private
   summation and the chunk-usage path are removed. `/v1/usage` is unchanged
   (already logger-fed).
4. **Work through interfaces** — providers/decorators depend on the narrow
   `IUsageRecorder` seam, never a concrete logger; the aggregator is consumed via
   `IRequestLogger`, never a concrete class.
5. **Pluggable granularity** — a different rollup is a different `IRequestLogger`
   implementation, wired once into the `SessionGraph`; no call-site change. The
   response/`/v1/usage` shape already supports per-model and per-component.

## Non-Goals

- A new `IUsageMeter` / AsyncLocalStorage turn scope. The earlier draft proposed
  this; it duplicates `SessionRequestLogger` and the ALS-around-async-generator
  scoping is error-prone. **Dropped.** Propagation is explicit via `requestId`
  on `CallOptions` (already present as `opts.trace.traceId`).
- Reconciling the controller's `[controller]` DEBUG per-call log with
  `response.usage`. The per-subagent `[controller] tokens <role>` lines stay as
  diagnostics; the controller's aggregate `turn total` line and terminal-chunk
  usage are removed. The authoritative total is `response.usage` from the logger.
- Fixing provider-side numeric accuracy (a provider that mis-reports its own
  `usage` is out of our control).

## Architecture

### The aggregator — the `IRequestLogger` interface (default impl `SessionRequestLogger`)

Consumers depend on the `IRequestLogger` interface; `SessionRequestLogger` is the
default implementation wired into the `SessionGraph`. It is the single
authoritative aggregator and already:
- routes each `logLlmCall(entry)` to the per-`requestId` delta **and** the
  session-cumulative bucket;
- aggregates `byModel`/`byComponent`/`byCategory` with `requests` counts;
- yields `response.usage` via `getSummary(traceId)` → `summaryToUsage`, and
  `/v1/usage` via `getSummary()`.

Swapping the rollup later = a different `IRequestLogger` impl wired in; nothing
else changes.

### The provider boundary — `IUsageRecorder` + a logging decorator

- **`IUsageRecorder`** (contracts) — narrow seam the LLM/embedder boundary
  depends on instead of the full `IRequestLogger`:
  `record(usage, meta: { model: string; component: LlmComponent; requestId?: string; estimated?: boolean })`.
- **`UsageLoggingLlm`** — an `ILlm` decorator (sibling of `retry-llm`,
  `circuit-breaker-llm`) that wraps **any** `ILlm`. It is constructed with a
  fixed `component` tag and an `IUsageRecorder`. On `chat()` it records
  `res.value.usage`; on `streamChat()` it records the `usage` from the terminal
  stream chunk (`LlmStreamChunk.usage`). `requestId` is read **per call** from
  `options.trace.traceId`.
- **`UsageLoggingEmbedder`** — the analogous `IEmbedder` decorator, tagged
  `component:'embedding'`, recording embedding token usage (providers that
  return it) from `embed()`.
- **An `IRequestLogger`→`IUsageRecorder` adapter** bridges the two:
  `record(u, m)` → `logger.logLlmCall({ ...u, model: m.model, component: m.component, requestId: m.requestId, durationMs, estimated })`. The decorator holds the
  `IUsageRecorder`; the adapter holds the `IRequestLogger`. No second store, and
  no concrete-class dependency at the boundary.

Why a boundary decorator and not constructor injection into the five provider
packages: the repo also accepts **injected** `ILlm`/`IEmbedder` instances,
builder-provided instances, and plugin-provided ones. Wrapping at the
boundary meters all of them; editing built-in provider internals would miss the
injected/custom ones (review finding #3). Provider packages are touched **only**
if needed to emit `usage` on stream chunks (see #7).

### Attribution is per-call, with a per-instance default (review #4)

The main LLM is reused as the classifier/helper fallback, and the helper LLM is
itself reused for **three** distinct semantic components (`translate`,
`query-expander`, history `helper`/summary — `preprocessor.ts` /
`query-expander.ts` already log these distinctly). So `component` cannot be fixed
on the instance; it must be **resolved per call**:

```
component = options?.usageComponent ?? this.defaultComponent
```

- `CallOptions` gains `usageComponent?: LlmComponent`. Call sites that know their
  semantic role set it: translate → `'translate'`, query-expand →
  `'query-expander'`, history summary → `'helper'`.
- The decorator's `defaultComponent` (construction-time) is the fallback for
  calls that don't set it — and it is correct for those: `_mainLlm` →
  `'tool-loop'`, controller subagents via `ctx.makeLlm` →
  `'evaluator'|'planner'|'executor'`, the finalizer call → `'finalizer'`.
- When the helper falls back to the main provider, the call still carries
  `usageComponent` from the call site, so it is labelled correctly regardless of
  which underlying instance served it.

This makes the decorator the **single** logging path: the scattered explicit
`logLlmCall` calls in `preprocessor.ts` / `query-expander.ts` / `_summarizeHistory`
are **removed** (each sets `usageComponent` instead), so a call is logged exactly
once. Wrappers wrap the **raw** provider (never another wrapper), so no double
counting.

### Decorator ordering

Usage logging must be **innermost** (closest to the provider) so every actual
provider invocation is logged, including retried attempts (real spend):
`retry( circuitBreaker( rateLimiter( usageLogging( provider ) ) ) )`.

### No ALS

`requestId` is already available at every call site via `options.trace.traceId`.
The one site that drops it is `makeSubagentClient.send` (no `options` param) — it
gains an `options?: CallOptions` parameter and the controller handler passes the
turn's options. This removes the need for AsyncLocalStorage and the unsafe
generator-scoping it would require (review #1).

### Unify `response.usage` (the central fix)

The coordinator branch of `agent.process` (`567-635`) stops summing chunk usage
and instead, after the stream completes, derives
`usage = summaryToUsage(this.requestLogger.getSummary(opts?.trace?.traceId))`
plus the `byModel` map — exactly as the flat path already does. The private
`totalUsage` accumulator and the `chunk.value.usage` summation are removed. The
controller handler stops accumulating its own `total` and stops attaching `usage`
to its terminal chunk.

```
 every chat()/embed()  ──►  UsageLoggingLlm/Embedder (role-tagged)
   (preamble, subagents,        │  record(usage, {model, component, requestId})
    tool-loop, embeddings)       ▼
                          IUsageRecorder ── adapter ──► IRequestLogger (SessionRequestLogger)
                                                              │  (per-traceId delta + cumulative)
                                          getSummary(traceId) ▼
                              response.usage (+ byModel)   /v1/usage (cumulative)
```

## Contract changes (in `@mcp-abap-adt/llm-agent`)

- Add `IUsageRecorder` to `interfaces/request-logger.ts`.
- Add `usageComponent?: LlmComponent` to `CallOptions` (`interfaces/types.ts`) —
  the per-call semantic component hint read by the decorator.
- Add `'executor'` to the `LlmComponent` union (controller's executor role; the
  others — `planner`/`evaluator`/`finalizer`/`tool-loop`/`embedding`/`translate`/
  `query-expander`/`helper`/`classifier` — already exist). Map `'executor'` in
  `CATEGORY_MAP` to `'request'`.
- Reuse `LlmCallEntry`, `RequestSummary`, `summaryToUsage` as-is.

## Data flow per request

1. The server starts the request: `logger.startRequest(traceId)` (existing).
2. Every LLM/embedder call goes through a `UsageLogging*` decorator
   → `recorder.record(usage, {model, component, requestId: opts.trace.traceId})`
   → adapter → `IRequestLogger.logLlmCall(entry)` (per-traceId delta + cumulative).
3. On stream completion the agent (both flat and coordinator paths) reads
   `summaryToUsage(getSummary(traceId))` + `byModel` → emits it as the terminal
   chunk usage and returns it in `SmartAgentResponse.usage`.
4. The server reads `getSummary(traceId)` for the HTTP `usage`, then
   `dropRequest(traceId)` (existing). `/v1/usage` reads `getSummary()`.

## Changes by package

- **`@mcp-abap-adt/llm-agent`** — `IUsageRecorder`; `'executor'` added to
  `LlmComponent` + `CATEGORY_MAP`.
- **`@mcp-abap-adt/llm-agent-libs`** —
  - `adapters/usage-logging-llm.ts`, `adapters/usage-logging-embedder.ts` (new
    decorators).
  - an `IRequestLogger`→`IUsageRecorder` adapter (boundary depends on the
    interface, not `SessionRequestLogger`).
  - builder/provider wiring: wrap `_mainLlm`/`_helperLlm`/`_classifierLlm` with
    the recorder and a sensible `defaultComponent`; wrap the embedder; ensure
    usage-logging is the innermost decorator.
  - `agent.ts`: coordinator branch (`567-635`) derives `usage` from
    `getSummary(traceId)`; delete the `totalUsage` chunk summation. `_toEnglishForRag`
    / `_summarizeHistory` set `options.usageComponent` and drop their explicit
    `logLlmCall` (the decorator logs once).
  - `rag/preprocessor.ts`, `rag/query-expander.ts`: set `options.usageComponent`
    (`'translate'` / `'query-expander'`) and remove their explicit `logLlmCall`
    so the decorator is the single logging path.
- **`@mcp-abap-adt/llm-agent-server-libs`** — controller handler: delete the
  `total` accumulator, the `[controller] turn total` aggregate line, and the
  terminal-chunk `usage`. Keep per-subagent `[controller] tokens <role>` DEBUG
  lines. `makeSubagentClient.send` gains `options?: CallOptions`; the handler
  passes the turn options and tags each subagent role. `ctx.makeLlm` returns
  role-wrapped LLMs (or the pipeline wraps them).
- **Provider packages** (`openai`/`anthropic`/`deepseek`/`sap-aicore`/`ollama`)
  — touched **only** to guarantee streaming `usage` is emitted on a stream chunk
  (`stream_options.include_usage` or equivalent). No provider-internal logging.
- **Embedder packages** — touched **only** if they must surface token usage in
  their `IEmbedResult`/stream so the decorator can record it.

## Edge cases & handling

| # | Risk | Handling |
|---|------|----------|
| 1 | ALS around async generator is incorrect | **No ALS.** `requestId` rides `CallOptions`; `makeSubagentClient.send` gains an options param. |
| 2 | A second aggregator already exists | The `IRequestLogger` (impl `SessionRequestLogger`) is **the** aggregator. Coordinator path switched to `getSummary`; controller self-sum + chunk path removed. `/v1/usage` shape preserved. |
| 3 | "Every call" vs factory bypass (injected/custom/plugin) | Boundary **decorator** wraps any `ILlm`/`IEmbedder` at the agent/pipeline ingestion points, not just built-in providers. A provider never handed to the agent is inherently unmetered (true of any design) — documented. |
| 4 | Construction-time component wrong for shared instance | `component` resolved **per call** as `options.usageComponent ?? defaultComponent`; correct even when one shared instance serves translate/expand/summary/fallback. |
| 5 | Per-model overwrite (`agent.ts:621`) | Removed with the chunk path; `byModel` merge in `aggregate()` is already additive. |
| 6 | Double counting | Single log path; wrappers wrap raw providers (no nesting); usage-logging innermost so each provider call logs once. |
| 7 | Streaming omits usage | Decorator reads `LlmStreamChunk.usage`; providers must enable `include_usage`. Main real-world accuracy fix. |
| 8 | Provider mis-reports usage | Out of scope; recorded as returned. `estimated` flag carries through `LlmCallEntry`. |
| 9 | Failed call consumed tokens, returned none | Provider gap; recorded as zero. Documented. |
| 10 | Concurrent requests | `SessionRequestLogger` already keys deltas by `requestId`; nested coordinator/worker semantics already handled. |

## Testing

- **`UsageLoggingLlm` unit**: `chat` records once with the role `component`,
  right `model`, and `requestId` from `options.trace.traceId`; `streamChat`
  records the terminal chunk's `usage`; no `usage` → no record.
- **`UsageLoggingEmbedder` unit**: records `component:'embedding'` token usage.
- **Decorator ordering test**: a retried call (retry over usage-logging) logs
  each attempt.
- **Attribution test (review #4)**: one shared wrapped instance, called with
  `options.usageComponent:'translate'` then with no hint, produces a `'translate'`
  bucket and a `defaultComponent` bucket — proving per-call resolution.
- **Coordinator integration (the regression)**: a controller turn with a
  Cyrillic prompt (triggers translate) and N subagent calls — assert
  `response.usage == summaryToUsage(getSummary(traceId))` and that it includes
  the translate + every subagent call; assert it equals the independent sum of
  all provider invocations.
- **`/v1/usage`**: unchanged shape; cumulative grows by the request's total.

## Migration / rollout

One coherent change: add `IUsageRecorder` + decorators + role wrapping + the
coordinator `getSummary` switch, and remove the controller self-sum + chunk path
in the **same** commit, so there is never a window with two live response.usage
derivations. Lockstep-versioned across affected packages.

## Deferred

- A per-component breakdown surfaced on `response.usage` (the data already exists
  in `RequestSummary.byComponent`; no consumer asked to expose it per-response
  yet — `/v1/usage` already exposes it).
- Embedder provider changes beyond surfacing token counts (e.g. cost models).
