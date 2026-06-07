# End-to-End Token Usage Metering — Design

**Date:** 2026-06-08
**Status:** Design (approved for planning)

## Problem

`response.usage` (and the `/v1/usage` session rollup) **undercounts** real token
spend. The host `SmartAgent` runs per-turn preamble helpers — RAG query
translation (`_toEnglishForRag`), history summarization (`_summarizeHistory`),
intent classification (`_classifier.classify`), query expansion
(`queryExpander.expand`) — whose LLM usage is **discarded** (the helpers return
values, not stream chunks). `agent.process` only sums `usage` from yielded
stream chunks (`agent.ts:616`), so those tokens vanish.

There is also a **structural** defect: usage is summed in **two places**. A
pipeline (e.g. the controller) accumulates its own `total` and emits it as one
value on its terminal chunk labelled `turn total`; the agent then sums chunk
usage and happens to receive only that single value. The two can diverge the
moment any call is counted in one place but not the other. A single potential
discrepancy nullifies the point of accounting.

Additional latent inaccuracies (see *Edge cases*): streaming responses often do
not return `usage` in the call result; per-model attribution is **overwritten**
rather than merged (`agent.ts:621`); embeddings are not counted at all; session
totals use a parallel `sessionManager.addTokens` path (`session-manager.ts:15`).

## Goals

1. **Accurate** — `response.usage` equals the sum of *every* LLM (and embedder)
   call made during the turn, by construction.
2. **End-to-end (наскрізний)** — captures host preamble, pipeline subagents,
   tool-loop rounds, streaming usage, and embeddings — regardless of call site.
3. **Single source of truth** — exactly one aggregator per turn. No second
   "total" that can diverge. Session `/v1/usage` and `response.usage.models` are
   fed from the same aggregator (no parallel `addTokens`).
4. **One interface for all counting needs** — including the shape returned over
   the llm-agent protocol.
5. **Pluggable granularity** — total-only / per-model / per-component is a choice
   of *implementation*, not of call sites.

## Non-Goals

- Reconciling the controller's internal `[controller]` DEBUG per-call log with
  `response.usage` by special plumbing. The DEBUG lines stay as diagnostics; the
  controller stops emitting/labelling its own aggregate "turn total". The single
  authoritative total is `response.usage`, read from the meter.
- Fixing provider-side numeric accuracy (a provider that mis-reports its own
  `usage` is out of our control; see *Edge cases*).

## Architecture

Two layers plus an ALS bridge.

### Layer 1 — System (host / agent): the aggregator

- **`IUsageMeter`** — the turn-scoped aggregator. Holds running totals, exposes a
  `snapshot()`. The chosen *implementation* decides detail level.
- **AsyncLocalStorage turn scope** — the agent opens
  `usageScope.run(meter, () => <entire turn>)` at the start of each turn. A fresh
  meter is created **inside** the scope (never a singleton) so concurrent turns
  never share a meter.
- **Surfacing** — at turn end, `meter.snapshot()` becomes `response.usage`
  (including `usage.models`). The same snapshot feeds the session `/v1/usage`
  rollup. The old paths are **removed**: the controller's self-summation +
  terminal-chunk total, the chunk-usage aggregation at `agent.ts:616-622`, and
  `sessionManager.addTokens` driven from `agent.ts:1514`.

### Layer 2 — Providers: self-reporting

- **`IUsageRecorder`** — a tiny contract injected into every provider:
  `record(usage, attribution?)`.
- Each provider (`openai`, `anthropic`, `deepseek`, `sap-aicore`, `ollama` for
  LLM; `openai`, `ollama`, `sap-aicore` for embedders) calls
  `recorder.record(...)` **whenever it observes usage** — on the non-stream
  result **and** on the streaming usage event. Recording at the provider is what
  captures streaming usage accurately: the provider is the only component that
  sees the stream's usage frame.

### Bridge — providers stay ignorant of ALS

- Providers depend only on `IUsageRecorder` (a contracts-level type), never on
  AsyncLocalStorage.
- `makeLlm` / `makeDefaultLlm` (`providers.ts:176`, `:300`) and the embedder
  factories inject a **system-supplied recorder implementation** at construction.
  That implementation resolves the *current* turn meter from the ALS scope on
  each `record()` and forwards to it.
- One injected recorder reference is correct across all turns, because ALS
  yields the right meter per async context. When `record()` fires outside any
  turn scope (e.g. the startup health/warmup call), `getStore()` is `undefined`
  and the call is a safe no-op.
- Because subagent LLMs are also built via `ctx.makeLlm` (controller pipeline
  `controller.ts:101-103`), they are injected the same recorder — no need to
  thread `CallOptions` through `makeSubagentClient.send` (which today omits it).

```
                 ┌───────────────────────── turn scope (ALS) ─────────────────────────┐
 agent.process → │ usageScope.run(meter):                                              │
                 │   preamble helpers ─┐                                               │
                 │   pipeline subagents├─ provider.chat()/embed() → recorder.record()  │
                 │   tool-loop rounds ─┘        │ (resolves current meter via ALS)      │
                 │                              ▼                                       │
                 │                        IUsageMeter (single aggregator)              │
                 └───────────────────────────────│──────────────────────────────────--┘
                                                  ▼
                              snapshot() → response.usage (+ usage.models)
                                          → /v1/usage session rollup
```

## Contract (in `@mcp-abap-adt/llm-agent`)

`AggregatedUsage` is exactly the shape returned over the llm-agent protocol, so
one type feeds chat `response.usage`, the per-model `usage.models` map, and the
`/v1/usage` rollup. It reuses the existing `LlmUsage` / `ModelUsageEntry`
(`interfaces/types.ts:192,198`).

```ts
/** Attribution for one recorded call. component distinguishes the source. */
export interface UsageAttribution {
  model?: string;
  component?:
    | 'main' | 'helper' | 'classifier' | 'expander'   // host preamble + tool-loop
    | 'evaluator' | 'planner' | 'executor' | 'finalizer' // controller subagents
    | 'embedder';
}

/** Sink injected into providers. */
export interface IUsageRecorder {
  record(usage: LlmUsage, attribution?: UsageAttribution): void;
}

/** Protocol-facing aggregate (same shape as response.usage). */
export interface AggregatedUsage extends LlmUsage {
  models?: Record<string, ModelUsageEntry>;
}

/** Turn-scoped aggregator. */
export interface IUsageMeter extends IUsageRecorder {
  snapshot(): AggregatedUsage;
}
```

### Default implementation — `PerModelUsageMeter` (`llm-agent-libs`)

- Accumulates `promptTokens` / `completionTokens` / `totalTokens` additively.
- Maintains `models[model]` as a `ModelUsageEntry` with **additive** merge and a
  `requests` counter (fixes the overwrite bug at `agent.ts:621`).
- `component` is recorded for future per-component reporting; the default
  snapshot exposes per-model. Swapping in a `TotalOnlyUsageMeter` or
  `PerComponentUsageMeter` later requires no provider or call-site change.

### ALS bridge — `AlsUsageRecorder` + `usageScope` (`llm-agent-libs`)

- `usageScope = new AsyncLocalStorage<IUsageMeter>()`.
- `AlsUsageRecorder` implements `IUsageRecorder`; `record()` does
  `usageScope.getStore()?.record(...)`.
- A single `AlsUsageRecorder` instance is injected into all providers/embedders
  at construction.

## Data flow per turn

1. `agent.streamProcess` (the single generator that performs all turn work;
   `process` only aggregates its chunks) creates `meter = new PerModelUsageMeter()`
   at the top and runs the whole generator body inside `usageScope.run(meter, ...)`,
   so every downstream `await`/`yield` stays in scope.
2. Every `chat()` / `embed()` call (preamble, subagents, tool-loop, embeddings)
   reaches a provider that calls `recorder.record(usage, {model, component})`.
3. At turn end the agent reads `meter.snapshot()` → emits it as the turn usage on
   the terminal stream chunk (so streaming SSE clients still get a final `usage`)
   **and** returns it in `SmartAgentResponse.usage`.
4. The session `/v1/usage` rollup adds `snapshot().totalTokens` to the session
   counter (replacing the per-chunk `addTokens`).

`component` attribution is set by the construction site: `makeLlm` for a given
role passes the role tag so the injected recorder labels it (e.g. the helper LLM
records as `helper`, the controller's executor LLM as `executor`).

## Changes by package

- **`@mcp-abap-adt/llm-agent`** — add `IUsageRecorder`, `IUsageMeter`,
  `AggregatedUsage`, `UsageAttribution` to `interfaces/types.ts`; export them.
- **`@mcp-abap-adt/llm-agent-libs`** —
  - `usage/per-model-usage-meter.ts`, `usage/als-usage-recorder.ts` (new).
  - `providers.ts` — `makeLlm`/`makeDefaultLlm` accept + inject a recorder and a
    `component` tag.
  - `agent.ts` — open `usageScope.run` around the turn; build the meter; read
    `snapshot()` for the terminal usage; **delete** the chunk-usage summation
    (616-622) and the `addTokens(chunk…)` path (1514); feed session rollup from
    the snapshot.
  - embedder factory wiring (so `IEmbedder` providers receive the recorder).
- **Provider packages** (`openai-llm`, `anthropic-llm`, `deepseek-llm`,
  `sap-aicore-llm`, `ollama-llm`) — accept an `IUsageRecorder` (constructor
  option); call `record()` on the non-stream result and on the stream usage
  frame; ensure `stream_options.include_usage` (or provider equivalent) is set so
  streaming usage is actually emitted.
- **Embedder packages** (`openai-embedder`, `ollama-embedder`,
  `sap-aicore-embedder`) — accept the recorder; `record()` embedding token usage
  with `component:'embedder'` (providers that return embedding token counts).
- **`@mcp-abap-adt/llm-agent-server-libs`** — controller handler: delete the
  `total` accumulator and the `[controller] turn total` aggregate line, and stop
  carrying `usage` on the terminal chunk (the agent meter now owns the total).
  Keep the per-subagent `[controller] tokens <role>` DEBUG lines (they read
  `SubagentResult.usage` per call — still valid diagnostics). `ctx.makeLlm`
  passes the role tag for subagents; the `/v1/usage` handler reads the meter-fed
  session rollup.

## Edge cases & how they are handled

| # | Risk | Handling |
|---|------|----------|
| 1 | **Double count during migration** | Single source: remove controller self-sum, chunk aggregation (616), and `addTokens`(1514) in the *same* change that introduces the meter. |
| 2 | **ALS context lost across async boundaries** | Whole turn wrapped in `usageScope.run`; streaming generator + tool-loop created inside the scope. Covered by a test asserting `sum(recorded) == snapshot`. Out-of-scope calls no-op safely. |
| 3 | **Not all LLMs routed through the wrapped factory** | Inject at *both* `makeLlm` and `makeDefaultLlm`; subagents via `ctx.makeLlm`. A provider built bypassing the factory is unmetered — documented; factories are the single construction path in this repo. |
| 4 | **Double-wrap / retries** | Recorder injected once at construction (no decorator stacking). Retries (CircuitBreaker/fallback) record each attempt — that is real spend, intentionally counted. |
| 5 | **Per-model overwrite** | `PerModelUsageMeter` merges additively; `requests` counter per model. |
| 6 | **Concurrent turns** | Fresh meter created inside each `run()`; ALS isolates per async context. |
| 7 | **Streaming omits usage in result** | Provider records on the stream usage frame; enable `include_usage`. This is the main real-world accuracy fix. |
| 8 | **Provider mis-reports usage** | Out of scope; we record what the provider returns. |
| 9 | **Failed call consumed tokens but returned none** | Unavoidable provider gap; recorded as zero. Documented. |
| 10 | **Worker-thread isolation** | ALS does not cross worker threads; workers already keep their own isolated accounting (separate scope). Not a regression. |

## Testing

- **Unit — `PerModelUsageMeter`**: additive totals; per-model additive merge +
  `requests`; snapshot shape equals `AggregatedUsage`.
- **Unit — `AlsUsageRecorder`**: records into the ALS-current meter; no-op when
  no scope; isolates two concurrent `run()` scopes.
- **Provider unit (per package)**: a fake recorder receives `record` once per
  non-stream call and once per stream usage frame, with the right `model`.
- **Integration — agent turn**: a fake provider that reports fixed usage on N
  calls (preamble + subagents + tool-loop); assert `response.usage` equals the
  exact sum and `usage.models` is correctly partitioned. Regression test for the
  original bug: a Cyrillic prompt (triggers `_toEnglishForRag`) must include the
  translate call's tokens in `response.usage`.
- **Embedder unit**: embedding call records `component:'embedder'` tokens.

## Migration / rollout

Single coherent change: introduce contract + meter + ALS + provider self-report,
and in the same commit set remove the three old counting paths so there is never
a window with two live aggregators (avoids #1). Lockstep-versioned across all
affected packages.

## Deferred

- `PerComponentUsageMeter` exposing a per-`component` breakdown over the protocol
  (interface already supports it; no consumer asked yet).
- A selectable meter implementation via config (YAGNI until a second
  implementation is needed).
