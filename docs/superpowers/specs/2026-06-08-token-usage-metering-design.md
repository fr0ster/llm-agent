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

1. **Accurate** — `response.usage` accounts for every LLM call on every path
   (flat, stepper, controller, pass) and **every embedder call** — all routed
   through the embedder-boundary wrapper, so coverage does not depend on
   enumerating `QueryEmbedding` sites. LLM and embedder usage use provider-reported
   counts where available; embedders that return no `usage` (Ollama, SAP AI Core —
   `IEmbedResult.usage` is optional) get an **estimate** (the per-entry
   `LlmCallEntry.estimated` flag is set for diagnostics), so embeddings are always
   *counted*. (Surfacing an estimated-vs-measured split in the aggregated
   `RequestSummary` / `/v1/usage` is deferred — see Deferred.)
2. **One internal aggregator** — the `IRequestLogger` interface (default impl
   `SessionRequestLogger`). The controller's private sum is removed; all paths'
   usage comes from `getSummary(traceId)`.
3. **Internal logging decoupled from consumer delivery** — logging is uniform;
   delivery is one terminal `getSummary` usage chunk (SSE event, or summed by
   `process()`).
4. **Reuse, minimal delta** — keep every existing logging site **except** the
   `rag-query.ts:102` inline embedding log (superseded by the embedder wrapper to
   avoid double-counting); *add* logging where it is currently absent (controller
   LLM, embeddings via the wrapper); *fix* the systemic traceId/derivation/stream
   issues; *replace* the controller's terminal-chunk usage source (private total →
   logger-derived); and *remove* the now-unused private `total` accumulator.

## Non-Goals

- A new `IUsageMeter` / `IUsageRecorder`, `CallOptions.usageComponent`,
  AsyncLocalStorage scope, a blanket decorator replacing all logging, or
  protocol-specific logger implementations. **Dropped** (duplicate
  `IRequestLogger`; would double-count).
- A controller-side `LoggingLlm` / `LoggingEmbedder` build-time wrapper — cannot
  bind the request `traceId` nor distinguish the shared planner/finalizer client
  (review #1). Controller logs at request time instead.
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
- **Embeddings — logged at the embedder boundary** (see the dedicated section
  below). The controller's `target-state` and toolsRag embeddings, and every flat
  `QueryEmbedding` site, are all covered by one wrapper — no per-site logging, no
  `logUsage('embedding', …)`.
- **Everything else is kept as-is** (Migration inventory).

### Embedding accounting — embedder boundary (enumeration-proof)

There are ~10 `new QueryEmbedding(` sites and the list keeps growing, so per-site
logging is fragile (review #1). But `QueryEmbedding` is **lazy + memoized**
(`query-embedding.ts:_getResult` calls `embedder.embed()` **exactly once** per
instance), so the single chokepoint for every embedding token cost is
`embedder.embed(text, options)`. Wrap the embedder once:

- **`UsageLoggingEmbedder`** — an `IEmbedder` decorator: on `embed(text, options)`
  it logs the result `usage` via `options.requestLogger?.logLlmCall({ component:'embedding', model:'embedder', scope:'request', durationMs:0, requestId: options.trace?.traceId })`,
  then returns the result. One log per `embed()` call ⇒ one per `QueryEmbedding`
  instance (memoization) ⇒ no dedup bookkeeping needed (no `WeakSet`, review #2).
- **Estimation fallback (review #1):** `IEmbedResult.usage` is optional and Ollama /
  SAP AI Core embedders return none. When `result.usage` is absent, the wrapper
  estimates `promptTokens = ceil(text.length / 4)`, `completionTokens = 0`,
  `totalTokens = promptTokens`, and logs with `estimated: true` (the existing
  per-entry `LlmCallEntry.estimated` flag). Provider-reported usage is used verbatim
  (`estimated` unset). So embeddings are always counted. Note: the aggregated
  `RequestSummary`/`TokenBucket` does **not** currently carry an estimated split, so
  `/v1/usage` reports a combined total; surfacing the split is deferred.
  (`embedBatch`: estimate per text, sum.)
- **Preserve `IEmbedderBatch` (review #3):** the structural `isBatchEmbedder(e)`
  check (`rag.ts:60`, `'embedBatch' in e`) drives batch vectorization
  (`builder.ts:974`). A plain `IEmbedder` wrapper would hide `embedBatch` and force
  N single embeds. So wrap via a factory `wrapEmbedder(inner)`: if
  `isBatchEmbedder(inner)`, return a batch-capable decorator that **also** proxies
  `embedBatch(texts, options)` — delegating to `inner.embedBatch` and logging the
  summed `usage` of all results as one `embedding` entry; otherwise return the
  plain decorator. Either way `embed` is logged as above.
- **Idempotent wrap (review #2):** the embedder is wrapped at one canonical owner —
  `resolve-agent-embedder.ts` (the server's embedder construction). But
  `SmartAgentBuilder.withEmbedder` is a second possible entry, so `wrapEmbedder`
  must be **idempotent**: the decorators carry a brand (`readonly __usageLogged = true`
  via a module symbol), and `wrapEmbedder(inner)` returns `inner` unchanged if
  already branded. Double-wrapping (resolve + builder) therefore cannot
  double-log; new entry points are safe by construction.
- **Binding (global embedder, per-session logger):** the embedder is a global
  singleton (`smart-server.ts:479` locked invariant), so the wrapper resolves the
  per-request logger **per call** from `CallOptions`. Add `requestLogger?: IRequestLogger`
  to `CallOptions`; the agent populates `opts.requestLogger = this.requestLogger`
  where it normalizes `opts.trace.traceId` (so the request-scoped logger + traceId
  travel together). Sites that pass `ctx.options` (rag-query, tool-select,
  skill-select, tool-loop, agent.ts:812/945/1349, vector-rag) are covered
  automatically.
- **Single mechanism — remove the old per-site logging:** delete the inline
  embedding `logLlmCall` in `rag-query.ts:102` (now done by the wrapper) so each
  embed is logged exactly once.
- **Sites without a request logger:** `builder.ts:707` (startup vectorization,
  `{ signal }` only) has no request context → `options.requestLogger` is absent →
  the wrapper no-ops (correct: startup is `initialization`, not request spend).
  toolsRag is handled via its `query` options below.
- **No double-count vs LLM logging:** the wrapper touches only the embedder; LLM
  logging is untouched.

### `IToolsRagHandle.query` — pass `CallOptions`

`query` builds its own `QueryEmbedding(text, resolvedEmbedder)` with **no**
options (`smart-server.ts:1945`), so the embedder wrapper has no `requestLogger`/
`traceId`. Extend the interface (`interfaces/knowledge-rag.ts:60`) to accept
`CallOptions` and thread it into the `QueryEmbedding`:

```ts
query(text: string, k?: number, options?: CallOptions): Promise<readonly LlmTool[]>;
```

The handle does `new QueryEmbedding(text, resolvedEmbedder, options)`; because
`resolvedEmbedder` is the **wrapped** embedder and `options` carries
`requestLogger` + `trace.traceId`, its single `embed()` is logged by the boundary
wrapper — no bespoke accounting type, same mechanism as every other site. The
parameter is **optional** (existing callers compile unchanged).

**Injecting `options` without threading it through every contract (review #1).**
The controller's `selectTools` is a `deps` function it controls, so it forwards
`ctx.options` directly. The **Stepper** is different: it passes the raw `toolsRag`
into `rootStepper.run({ toolsRag, … })` (`stepper-coordinator-handler.ts:142`), and
deep internal callers (`llm-evaluator.ts:65`, planner, executor) call
`input.toolsRag.query(prompt, 15)` with no options — threading `CallOptions` through
`IStepperInput` and every child contract would be invasive. Instead, the **handler
builds a request-bound facade** (it already holds `ctx.options`/`traceId`) and
passes *that* into `rootStepper.run`:

```ts
const boundToolsRag: IToolsRagHandle = {
  query: (text, k) => toolsRag.query(text, k, ctx.options),
  lookup: (name) => toolsRag.lookup(name),
};
```

Internal callers keep their 2-arg `query(text, k)` signature; the facade injects
`ctx.options` so the wrapped embedder logs every Stepper toolsRag embed. This
closes the Stepper gap (Goal #1) with no change to the stepper internal contracts.

### Consumer delivery — one terminal `getSummary` chunk on every path

Exactly one usage-bearing chunk per request. **Canonical terminal-usage object
(review #4)** — every emitter builds the SAME shape the flat path uses
(`agent.ts:1243`), preserving the per-model breakdown:

```ts
const summary = ctx.requestLogger.getSummary(traceId);
const usage = { ...summaryToUsage(summary), models: summary.byModel };
```

`summaryToUsage()` alone returns only the flat triple — callers **must** add
`models: summary.byModel` or the per-model breakdown is lost. The chunk is emitted
by whichever component owns the path — **not** a generic agent-level chunk on the
pipeline branch (that would double the Stepper/DAG chunk, review #1-prev):

- flat — already emits it (unchanged).
- **Stepper / DAG handlers** — already emit it on most terminal branches
  (`stepper-coordinator-handler.ts:172,229,274`, `dag-coordinator.ts`). **Gap to
  fix (review #2):** the Stepper `InsufficientSignal` branch (`:257-267`) yields a
  stop chunk **without** usage — add the canonical terminal-usage object (incl.
  `models`) there so every Stepper terminal branch carries it. (Audit all
  coordinator terminal yields for the same omission; the existing `:172,229,274`
  yields should also carry `models`.)
- **controller handler** — the `surface*` methods (`:552-584`) already accept a
  `usage?` parameter; `execute()` (which holds `meta.traceId`) builds the canonical
  terminal-usage object (incl. `models: summary.byModel`) and passes it in place of
  the private `total` (`surface*` need no new access to `meta`; the caller supplies
  the usage). One chunk, same pattern as Stepper/DAG.
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

In `streamProcess`, write the derived `traceId` back into `opts`:
`opts = { ...opts, trace: { ...opts?.trace, traceId } }`. **Ordering (review #2):**
this must run **after** the timeout-merge block (`agent.ts:659-664`, which rebuilds
`opts = { ...options, signal }` from the *original* `options` and would otherwise
clobber the trace) — i.e. spread from `opts`, not `options`, and normalize last
(~`:665`). Every downstream `logLlmCall` then carries `requestId`, and the
terminal-chunk `getSummary(traceId)` reads this request's delta. `process()` is
unchanged — it sums the terminal chunk and never calls `getSummary` itself, so it
needs no traceId.

```
 flat sites · stepper LoggingLlm · controller logUsage→requestLogger · UsageLoggingEmbedder (all embeds) · pass(once)
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
  `dag-coordinator.ts:115`
- `builder.ts:1025,1059,1094,1254`, `agent.ts:1983`
- Stepper: `coordinator/stepper/logging-llm.ts`, `build-stepper-root.ts:242`,
  `stepper-coordinator-handler.ts:97`

**ADD** (currently unlogged → additive):
- Controller `logUsage` → `ctx.requestLogger.logLlmCall` (subagent LLMs).
- `UsageLoggingEmbedder` wrapping the global embedder → logs **every** embedding
  (controller target-state, toolsRag, all flat `QueryEmbedding` sites) once each.
- `opts.requestLogger` populated by the agent; `IToolsRagHandle.query` + Stepper
  pass `CallOptions` so toolsRag embeds carry the logger.
- Pass-path single-call logging.

**REPLACE**:
- Controller terminal-chunk usage source: private `total` → the canonical
  terminal-usage object `{ ...summaryToUsage(summary), models: summary.byModel }`.

**REMOVE**:
- `rag-query.ts:102` inline embedding `logLlmCall` — now done by the embedder
  wrapper (kept single-logged).
- Controller private `total` accumulator + the `[controller] turn total` aggregate
  line (per-role `[controller] tokens <role>` lines stay).

No embed is logged twice: the wrapper logs once per `embed()` (memoized → once per
`QueryEmbedding`), and the only prior embedding log (`rag-query.ts:102`) is removed.
No LLM call is logged twice (the wrapper touches only the embedder). One terminal
usage chunk owned by the path's component.

## Contract changes (`@mcp-abap-adt/llm-agent`)

- Add `'executor'` to the `LlmComponent` union; map it to `'request'` in
  `CATEGORY_MAP`.
- Add `requestLogger?: IRequestLogger` to `CallOptions` (`interfaces/types.ts`) —
  the per-request logger the embedder-boundary wrapper reads (consistent with the
  existing structural `sessionLogger` field).
- **Embedding categorization (review #3):** `CATEGORY_MAP.embedding` is statically
  `'initialization'`, so the request-time embeddings the wrapper now logs
  (`scope:'request'`) would be mis-bucketed in `/v1/usage.byCategory`. Fix:
  `aggregate()` categorizes `embedding` by the entry's `scope` —
  `c.component === 'embedding' && c.scope === 'request' ? 'request' : CATEGORY_MAP[c.component]`.
  The wrapper sets `scope:'request'`; startup vectorization (no request logger →
  unlogged here, or logged elsewhere as init) keeps `initialization`.
- Extend `IToolsRagHandle.query` with the optional `options?: CallOptions`
  parameter above.
- No new aggregator/recorder interfaces. Reuse `IRequestLogger`, `LlmCallEntry`,
  `RequestSummary`, `summaryToUsage`, `QueryEmbedding.getUsage`.

## Changes by package

- **`@mcp-abap-adt/llm-agent`** — `'executor'` in `LlmComponent` + `CATEGORY_MAP`;
  `requestLogger?: IRequestLogger` on `CallOptions`; `IToolsRagHandle.query`
  `options?: CallOptions` param.
- **`@mcp-abap-adt/llm-agent-libs`** —
  - `aggregate()` (`session-request-logger.ts` + `default-request-logger.ts`):
    categorize `embedding` by `scope` (request-scoped → `'request'`, else
    `'initialization'`) — review #3.
  - `adapters/usage-logging-embedder.ts` (new) — `UsageLoggingEmbedder`
    (`IEmbedder`) + a batch-capable variant (`IEmbedderBatch`, proxies `embedBatch`)
    + an **idempotent** `wrapEmbedder(inner)` factory: picks the variant via
    `isBatchEmbedder(inner)` (review #3) and returns `inner` unchanged if already
    branded (review #2). Canonical wrap owner: `resolve-agent-embedder.ts`; builder
    `withEmbedder` also calls `wrapEmbedder` (idempotent, so no double-wrap). Remove
    the inline embedding `logLlmCall` from `rag-query.ts`.
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
    (subagent roles only — `durationMs: 0`; model from `deps.models[role]`,
    finalizer → `deps.models.planner`). **Embeddings are NOT logged here** (review
    #4) — the embedder wrapper does that. `surfaceFinal`/`surfaceClarify`/
    `surfaceToolCall` (`:552-584`) emit the canonical terminal-usage object
    (`{ ...summaryToUsage(summary), models: summary.byModel }`) (one terminal
    chunk, like Stepper/DAG); delete the private `total` accumulator and the
    `turn total` line.
  - `stepper-coordinator-handler.ts`: attach the canonical terminal-usage object
    (incl. `models`) to the `InsufficientSignal` terminal stop chunk (`:263`); build
    a request-bound `toolsRag` facade injecting `ctx.options` and pass it into
    `rootStepper.run` (`:142`) — review #1.
  - `controller/target-state.ts` (review #1): `establishTargetState` gains an
    `options?: CallOptions` parameter and calls `embedder.embed(target, options)` /
    `embedder.embed(prompt, options)` (`:74-76` currently pass no options, so the
    wrapper would not see them); the handler passes `ctx.options`.
  - `ControllerHandlerDeps.selectTools` (review #2): extend the signature to
    `(query: string, k?: number, options?: CallOptions) => Promise<readonly LlmTool[]>`;
    `controller.ts:115` forwards `options` to `toolsRag.query`; both handler call
    sites (`:218,:386`) pass `ctx.options`.
  - `smart-server.ts` `_toolsRagHandle.query`: accept `options?: CallOptions` and
    build `new QueryEmbedding(text, resolvedEmbedder, options)` so the wrapped
    embedder logs it.
- **Provider packages** — touched **only** to emit streaming `usage` on a stream
  chunk (`include_usage` or equivalent) so the flat/stepper `LoggingLlm.streamChat`
  accumulation is non-empty. No provider-internal logging.

## Edge cases & handling

| # | Risk | Handling |
|---|------|----------|
| 1 | Controller `LoggingLlm` can't bind traceId / distinguish shared planner+finalizer | Controller logs at **request time** via `logUsage`→`ctx.requestLogger`, role explicit at the call site, `requestId = meta.traceId`. No build-time wrapper. |
| 2 | toolsRag embeddings (startup-bound embedder) unlogged | `IToolsRagHandle.query` accepts `CallOptions`; the handle builds `QueryEmbedding(text, wrappedEmbedder, options)` → the boundary wrapper logs it (controller/Stepper pass `ctx.options`). |
| 3 | `process()` can't see generated `traceId` | `process()` does not call `getSummary`; it sums the terminal chunk built (in `streamProcess`) from the locally-normalized `traceId`. |
| 4 | Pass path diverges from single source | Pass logs its one call into `IRequestLogger`, then emits the same `getSummary` terminal chunk → `response.usage == /v1/usage`. |
| 5 | Double counting | Embedder IS wrapped, but logs once per `embed()` (memoized → once per `QueryEmbedding`) and the only prior embedding log (`rag-query.ts:102`) is removed; LLM sites unchanged; exactly one usage-bearing chunk per request, emitted by the owning component (flat / Stepper / DAG / controller handler / pass), **never** a generic agent-level chunk on the pipeline branch. |
| 9 | Controller `logUsage` lacks `durationMs` | Use `durationMs: 0` (rag-query.ts:108 precedent); per-call timing deferred. |
| 10 | Stepper toolsRag query-embedding (deep internal callers, no options) | Handler builds a request-bound `toolsRag` facade injecting `ctx.options`, passed into `rootStepper.run` — no internal-contract threading (review #1). |
| 20 | Double-wrap of the embedder (resolve + builder) | `wrapEmbedder` is idempotent via a brand; returns already-wrapped instances unchanged (review #2). |
| 21 | Embedder returns no `usage` (Ollama, SAP AI Core) | Wrapper estimates `ceil(text.length/4)` tokens, logs `estimated: true`; provider-reported usage used verbatim (review #1). |
| 11 | Pass forwards provider `usage` chunks → double with terminal chunk | Pass yields chunk copies with `usage` omitted; accumulates + logs provider usage once; one terminal `getSummary` chunk (review #1). |
| 12 | A coordinator terminal branch yields no usage (e.g. Stepper `InsufficientSignal` `:263`) | Fix that branch to attach `getSummary` usage; audit all terminal yields (review #2). |
| 13 | Finalizer model unknown (no `subagents.finalizer`) | Finalizer runs on the planner client → `model: plannerLlm.model ?? 'unknown'`. |
| 14 | Flat tool/skill/reselect + legacy embeddings unlogged | All covered by the embedder-boundary wrapper (every `QueryEmbedding` that passes `ctx.options`); no per-site enumeration. |
| 15 | Request embeddings mis-bucketed as `initialization` | `aggregate()` categorizes `embedding` by `scope` (review #3). |
| 16 | Trace normalization clobbered by timeout merge | Normalize after the timeout-merge block, spread from `opts` (review #2). |
| 17 | Terminal chunk drops per-model breakdown | All emitters build `{ ...summaryToUsage(summary), models: summary.byModel }` (review #4). |
| 18 | Wrapper hides `IEmbedderBatch` → N single embeds | `wrapEmbedder` returns a batch-capable decorator when `isBatchEmbedder(inner)`, proxying + logging `embedBatch` (review #3). |
| 19 | target-state / toolsRag embeds bypass the wrapper (no options) | `establishTargetState` and `selectTools` gain `options?: CallOptions`; the handler passes `ctx.options` (reviews #1/#2). |
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
- **Embedder wrapper (review #1/#2)**: `UsageLoggingEmbedder.embed` with
  `options.requestLogger` + `trace` logs one `embedding` entry; without
  `requestLogger` it no-ops (startup vectorization). One log per memoized
  `QueryEmbedding` even when reused across stages (no `WeakSet` needed).
- **toolsRag via options**: `toolsRag.query(text, k, ctx.options)` results in one
  `embedding` entry; `query(text, k)` (no options) logs none (back-compat).
- **Batch preservation (review #3)**: `isBatchEmbedder(wrapEmbedder(batchInner))`
  is `true`; calling `embedBatch` delegates to `inner.embedBatch` (one call, not N)
  and logs one summed `embedding` entry.
- **target-state coverage (review #1)**: a controller turn with the distance
  strategy logs two `embedding` entries (target + prompt) under the request delta.
- **Stepper facade (review #1)**: a Stepper turn logs `embedding` entries for its
  internal toolsRag queries (the facade injects `ctx.options`).
- **Idempotent wrap (review #2)**: `const w = wrapEmbedder(e); assert.equal(wrapEmbedder(w), w)`
  (re-wrapping a wrapped instance returns it unchanged); one embed → exactly one log
  even when both resolve + builder wrap.
- **Estimation fallback (review #1)**: an embedder returning no `usage` produces a
  logged entry with `estimated: true` and `totalTokens = ceil(text.length/4)`; an
  embedder that reports `usage` logs it verbatim (no `estimated`).
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
- **Per-model breakdown (review #4)**: a controller/pass turn's terminal chunk
  carries `usage.models` (per-model buckets), not just the flat triple.
- **Embedding category (review #3)**: a request-time query embedding lands in
  `/v1/usage.byCategory.request`, not `initialization`; startup vectorization
  stays `initialization`.
- **Flat embedding coverage (review #1)**: a turn that hits tool-select /
  skill-select / tool-loop reselection logs an `embedding` entry for each.
- **No regression**: a flat turn's `response.usage` total is unchanged (the added
  embedding sites were genuinely unlogged spend; assert the LLM-only components are
  byte-identical and the new embedding delta is exactly the embed tokens).

## Migration / rollout

One coherent change: controller request-time LLM logging + the embedder-boundary
wrapper (with `opts.requestLogger` + `IToolsRagHandle.query` options) + pass
logging + traceId normalization + the terminal `getSummary` chunk on coordinator/
pass + the Stepper `InsufficientSignal` fix, and **replace** the controller's
private-total terminal usage with logger-derived usage (the terminal chunk is kept;
only its source changes) while removing the private `total` accumulator and the
old `rag-query.ts:102` inline embedding log — all in the **same** commit, so there
is never a window with two live `response.usage` derivations or a double-logged
embedding. Lockstep.

## Deferred

- **Estimated-vs-measured split in the aggregate** — `LlmCallEntry.estimated` is
  recorded per entry, but `RequestSummary`/`TokenBucket` don't aggregate it, so
  `/v1/usage` reports a combined total. Extending `TokenBucket` with an
  `estimatedTokens` sub-count is a follow-up (review #1).
- Surfacing a per-component breakdown on `response.usage` (already in
  `RequestSummary.byComponent`; `/v1/usage` exposes it).
