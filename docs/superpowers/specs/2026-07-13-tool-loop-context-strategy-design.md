# Tool-Loop Context Strategy — Design

**Status:** Design (approved via brainstorming dialogue 2026-07-13)

**Goal:** Stop the tool-calling loops (controller `runStep` and the shared
`tool-loop-core`) from accumulating raw tool results in a growing message
transcript and re-sending the whole thing every round (measured O(N²): a single
controller run spent **1.42M** of ~1.58M tokens in the executor — 125 LLM calls ×
~11k avg prompt). Replace accumulation with **per-round context formation from RAG
collections**, behind a consumer-owned, swappable strategy.

**Architecture (one sentence):** the context for each LLM call in a tool-calling
loop is **formed fresh** — never grown — via a new focused
`IToolLoopContextStrategy` (record + form) that the pipeline injects; our example
compositions inject a RAG-recall implementation, but the consumer may inject a
RAG-less window, a legacy accumulator, or their own.

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome, Node ≥22.
Packages touched: `@mcp-abap-adt/llm-agent` (interface), `@mcp-abap-adt/llm-agent-libs`
(strategies + core loop + default pipeline + builder), `@mcp-abap-adt/llm-agent-server-libs`
(controller wiring).

---

## Global Constraints

- **We never decide the consumer's implementation.** Everything is interface + DI +
  strategy. RAG-less context management is *allowed* (the consumer may assemble any
  pipeline); our example compositions (SmartServer / controller / default pipeline)
  inject the **RAG-managed** strategy — the app IS the example. See
  `feedback_consumer_chooses_seams_rag_examples`.
- **Library default = backward-compat.** When no strategy is injected, behavior is
  **byte-identical to today** (the `LegacyAccumulateContextStrategy`). We do NOT
  frame a behavior change (windowing) as the default.
- **Build ON components.** Reuse `recall.ts` (`runScopedRecall` / `buildRecallBlock` /
  `relevantExtract`), the existing `writeArtifact`, `IContextAssembler`, and
  `historyMemory`. Do not reimplement recall/ranking. The `RagRecallContextStrategy`
  is *generic* — parameterized by injected `recall` + `record` functions — so the
  controller wires its run-scoped recall and the default pipeline wires its history
  RAG, without moving `recall.ts` across packages.
- **ISP.** ADD a new focused interface (`IToolLoopContextStrategy`); do NOT grow an
  existing one.
- **Don't break the 20.4.0 fail-loud work.** `classifyToolResult` / escalate on an
  MCP-unavailable failure runs BEFORE `record` and is unchanged; a tool-level error
  stays LLM feedback text.
- **DI/programmatic only — NO YAML / `SmartServerConfig` change** (code strategy, like
  `IMcpFailureClassifier` / `IMcpRequestHeadersStrategy`).
- **File-size control.** Moving the raw-push logic into the strategy must *reduce*
  `controller-coordinator-handler.ts` (currently 1716 lines); new modules stay small
  and focused.

---

## The Interface (Produces)

`packages/llm-agent/src/interfaces/tool-loop-context-strategy.ts` (NEW, barrel-exported):

```ts
import type { CallOptions, Message } from './types.js';

/** One completed tool ROUND = the atomic OpenAI-protocol group: a single
 *  assistant message carrying one OR MORE tool_calls, plus the tool result
 *  message for each call (in order). The batch is the unit: it is recorded and
 *  represented as a whole so the protocol (assistant.tool_calls ↔ tool results)
 *  can never be split, reordered, or half-elided. */
export interface ToolRound {
  /** role:'assistant', content:null, tool_calls:[...] — the model's batch of calls. */
  assistant: Message;
  /** One role:'tool' message per tool_call id, in the SAME order as assistant.tool_calls. */
  results: Message[];
  /** Per-result metadata (aligned to `results`) for recall keying and so a
   *  RAG/window impl can surface WHY a call failed, not just success. */
  meta?: Array<{
    /** Stable identity (tool name + args) for dedup / recall keying. */
    identityKey?: string;
    /** True when the tool returned a tool-LEVEL error (fed back to the LLM as
     *  text — NOT an MCP-unavailable escalate, which never reaches record()). */
    isError?: boolean;
  }>;
  /** Round ordinal within the current loop/step (0-based). */
  ordinal?: number;
}

/** The static context the strategy prepends when forming a round. */
export interface ToolLoopContextBase {
  /** Static prefix, built ONCE per step/loop by the caller and passed unchanged
   *  every round: system prompt + the step/action user message + any STEP-SCOPED
   *  recall the caller owns (e.g. the controller's step-result recall block —
   *  see "Recall split" below). Emitted FIRST by form(). */
  prefix: Message[];
  /** Query text the strategy uses to rank/recall relevant prior ROUNDS
   *  (e.g. the step instructions). */
  queryText?: string;
}

/** Consumer-owned strategy that OWNS per-round context formation for a
 *  tool-calling loop. `record()` is the SOLE mutation point (the loop calls it
 *  after each non-escalated tool batch); `form()` is a PURE read that returns the
 *  bounded messages for the next LLM call. The loop NEVER accumulates raw results
 *  itself. The impl decides which RAG collections, K, and how — or a RAG-less
 *  window, or nothing.
 *
 *  Instances are STATEFUL and per-loop: obtained fresh from the injected factory
 *  for each step/loop (see DI seam) — never shared across concurrent requests. */
export interface IToolLoopContextStrategy {
  /** SOLE mutation point. Record a completed tool BATCH round wherever the impl
   *  wants (RAG write, in-memory window, running list). Called after each
   *  NON-ESCALATED tool batch — including tool-LEVEL errors (isError), which the
   *  model must still see. NOT called on an MCP-unavailable escalate. */
  record(round: ToolRound, options?: CallOptions): Promise<void>;

  /** PURE. Form the bounded Message[] for the NEXT LLM call from the rounds
   *  recorded so far. Contract: emit `base.prefix` FIRST; the MOST-RECENT recorded
   *  round MUST appear RAW (its assistant + all its result messages, verbatim, in
   *  order) at the TAIL (OpenAI protocol — the model continues its own last call);
   *  older rounds are the impl's bounded representation (full for legacy, window
   *  for window, recall for RAG). Emits exactly `base.prefix` when nothing recorded. */
  form(base: ToolLoopContextBase, options?: CallOptions): Promise<Message[]>;

  /** Serialize the impl's durable state (running list / window buffer / recall
   *  params) so an in-flight loop survives suspend/resume. RAG-backed impls may
   *  return a minimal marker (results live in RAG). See "Durable state & resume". */
  snapshot(): unknown;
  /** Restore from a prior snapshot() on resume (instead of reset()). */
  restore(state: unknown): void;
}

/** Per-loop factory — the DI seam. The pipeline calls it ONCE per step/loop to
 *  get a fresh instance (no shared mutable state across requests). `deps` carries
 *  the per-run bits an impl needs (e.g. the run-scoped RAG handle, runId, logger). */
export type ToolLoopContextStrategyFactory = (
  deps: ToolLoopContextStrategyDeps,
) => IToolLoopContextStrategy;

export interface ToolLoopContextStrategyDeps {
  /** Consumer-defined per-run context (RAG handle, runId, options, …). Opaque to
   *  the loop; the factory and impl agree on its shape. */
  readonly run?: unknown;
}
```

---

## Provided Implementations (all in `@mcp-abap-adt/llm-agent-libs`, swappable)

`packages/llm-agent-libs/src/pipeline/context/tool-loop-context/`:

Each impl is created per-loop by a factory (below). `record()` is the sole mutation;
`form()` is pure; the most-recent recorded round is always emitted RAW at the tail.

### 1. `LegacyAccumulateContextStrategy` (library default — backward-compat)
- Maintains an internal ordered list of recorded `ToolRound`s.
- `record(round)` — appends `round` to the list (SOLE mutation).
- `form(base)` — returns `base.prefix` + every recorded round expanded to its raw messages
  in order (`round.assistant`, then `round.results`), for ALL rounds. Because every round is
  raw and the list preserves insertion order, the most-recent round is naturally the tail.
  Reproduces today's growing transcript **byte-identically** (same messages, same order,
  current batch present exactly once — no duplication, since `form` never appends).
- `snapshot()` → the recorded list; `restore(state)` → replaces the list.
- Purpose: when nobody injects a strategy, nothing changes. Existing tool-loop /
  controller tests remain green unmodified.

### 2. `WindowContextStrategy` (RAG-less bounded window)
- Config: `keepLastRounds` (default 3), `elide(round)` → a one-line marker string
  (identity + result char count).
- `record(round)` — appends to an internal list.
- `form(base)` — `base.prefix` + a single `{role:'user'}` marker summarizing the elided
  older rounds (all but the last `keepLastRounds`) + the last `keepLastRounds` rounds RAW
  (assistant + results, in order). The most-recent round is always within the window → raw
  at the tail. `keepLastRounds ≥ 1` is enforced so the protocol tail is guaranteed.
- `snapshot()`/`restore()` → the internal list (RAG-less → the buffer IS the durable state).
- Purpose: graceful-degrade for a consumer who wants bounding without a results-RAG.

### 3. `RagRecallContextStrategy` (generic, RAG-managed — what our examples inject)
- Constructed with injected functions so it stays package-agnostic:
  ```ts
  interface RagRecallDeps {
    /** Persist a completed round's results to the consumer's RAG (durable). */
    record(round: ToolRound, options?: CallOptions): Promise<void>;
    /** Return a bounded, ranked recall block (string) for the query text —
     *  over the ROUNDS recorded THIS run, EXCLUDING the most-recent round (that
     *  one is emitted raw). Deterministic given the same RAG contents + query. */
    recall(queryText: string, excludeIdentityKeys: string[], options?: CallOptions): Promise<string>;
  }
  ```
- Holds only the MOST-RECENT recorded round in memory (for the raw tail); all rounds' results
  are durable in RAG via `deps.record`.
- `record(round)` → `await deps.record(round, options)`; keep `round` as `last`.
- `form(base)` → `base.prefix` + (one `{role:'user', content: await deps.recall(...)}`
  bounded recall message over prior rounds, when non-empty) + the `last` round RAW
  (assistant + results) at the tail.
- `snapshot()` → `{ last }` (a minimal marker; the bulk lives in RAG). `restore({last})` →
  re-establishes the raw tail; prior rounds are re-recalled from RAG (deterministic).
- Purpose: the RAG way. The **controller** wires `deps.record` = `writeArtifact(mcp-result)`
  and `deps.recall` = `runScopedRecall(['mcp-result'], runId, …)` + `buildRecallBlock`. The
  **default pipeline** wires `deps.record` = history-RAG upsert and `deps.recall` = its
  RAG-query + `IContextAssembler`-style bounded block.

### Recall split (controller) — P1 fix
The controller today recalls BOTH **step-result** and **mcp-result** at step start. Under this
design the split is explicit: **step-result recall is STEP-SCOPED and stays in `base.prefix`**
(the handler builds it once at step start — step-results don't change mid-step), while
**mcp-result recall is ROUND-SCOPED and owned by the strategy** (it changes every tool round).
The executor therefore never loses prior-step context: it lives in the prefix on every round.

---

## Integration

### Controller `runStep` (`controller-coordinator-handler.ts`, ~1049-1355)
- At step start: create a fresh strategy for this loop via the injected factory
  (`strategy = makeStrategy({run: {rag, runId, …}})`); on an in-flight RESUME,
  `strategy.restore(inFlightStep.contextStrategyState)` instead.
- The raw push at ~1337-1352 (`messages.push(assistant tool_call)` + `messages.push(tool result)`
  then loop back re-sending all of `messages`) is REPLACED:
  1. On escalate (MCP-unavailable) — unchanged (fail-loud abort, BEFORE record).
  2. On any NON-escalated result — including a tool-LEVEL error — build the batch
     `ToolRound{assistant, results, meta:[{identityKey, isError}]}` and
     `await strategy.record(round, ctx.options)`.
  3. `messages = await strategy.form({prefix: staticPrefix, queryText: step.instructions}, ctx.options)`
     for the next `deps.executor.send`. (The last recorded round is the raw tail — protocol.)
- The `writeArtifact(mcp-result)` currently at ~1316 moves INTO the controller's
  `RagRecallContextStrategy.record` wiring (the pipeline owns "where results go").
- **Step-result recall stays in `staticPrefix`** (built once at step start via `runScopedRecall(['step-result'])`
  + `buildRecallBlock`); **mcp-result recall is the strategy's** `form()` (round-scoped). See "Recall split".
- **Control messages that are NOT tool rounds stay in the handler's durable state** and are
  re-applied on resume (they are NOT delegated to the strategy): the retry feedback
  ("Tool X is not available", ~1252) and the pending EXTERNAL-tool assistant/tool pair used by
  suspend/resume (~1225-1242, `bundle.pending.kind==='external-tool'`). These continue to be
  injected into `messages` after `form()` in their existing positions, so external-tool
  round-trips and unavailable-tool retries behave exactly as today.
- Net effect: `controller-coordinator-handler.ts` shrinks (raw-round transcript management leaves it).

### Shared `tool-loop-core` / `tool-loop.ts`
- Create the per-loop strategy from the factory before the loop; `reset()`-equivalent is a fresh instance.
- `tool-loop.ts` ~829 `messages = [...messages, ...outcome.toolMessages]` (accumulation) is
  REPLACED by: build the batch `ToolRound` from the batch's `assistant` message + its `toolMessages`;
  `await strategy.record(round)`; then `messages = await strategy.form({prefix, queryText})` for
  the next iteration.
- `tool-loop-core.ts` `executeToolBatchWithHeartbeat` continues to PRODUCE the per-batch
  tool messages; the CALLER (the loop in `tool-loop.ts` / `agent.ts`) assembles the `ToolRound`
  and applies the strategy. `IExecuteToolBatchArgs` is unchanged unless the batch function must
  emit the grouped `assistant`+`results` shape — in that case it returns them grouped so the
  caller can form a `ToolRound` without re-deriving the assistant tool_calls.
- The default-pipeline `assemble` handler still runs once to build `staticPrefix` for the first
  round; subsequent rounds are formed by the injected strategy, keeping the per-round model.

### DI threading (mirror `IMcpFailureClassifier`, but as a FACTORY)
The strategy is STATEFUL and per-loop, so the seam is a **factory**, not a shared instance —
this eliminates cross-request state leakage. Add optional
`toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory` to:
`IPipelineContext` (pipeline-plugin.ts), `SmartAgentDeps`, `PipelineDeps`, `BuildAgentDeps`,
`ControllerHandlerDeps`. Add `builder.withToolLoopContextStrategyFactory(f): this`. Populate
`ctx.toolLoopContextStrategyFactory` in `_buildContext` / `buildServerCtx`. Default resolves to
`() => new LegacyAccumulateContextStrategy()` at the point of use. Our compositions inject a
factory that builds `RagRecallContextStrategy` bound to the run's RAG (controller via `recall.ts`;
default pipeline via history RAG). Add a durable field `contextStrategyState?: unknown` to the
controller's `inFlightStep` so `snapshot()`/`restore()` survive suspend/resume. **No YAML.**

---

## Correctness Invariants

1. **OpenAI tool protocol.** A ROUND is the atomic unit (one `assistant` with N `tool_calls`
   + N `tool` results). `form()` always emits the most-recent recorded round RAW and whole at
   the tail — never a dangling `tool_call`, never split/reordered results. Older rounds are
   elided/recalled as WHOLE rounds. Empty history → `form()` = `prefix` only.
2. **Fail-loud unchanged.** `classifyToolResult`/escalate runs BEFORE `record`; an
   MCP-unavailable failure still aborts loud. A tool-LEVEL error is recorded (`meta.isError`)
   and stays LLM feedback text — the model still sees why it failed.
3. **Backward-compat.** No factory injected → `LegacyAccumulateContextStrategy` → byte-identical
   messages (same order, current batch once); all existing tool-loop/controller tests pass unmodified.

### Durable state & resume (controller) — enumerated by phase

The controller today persists the WHOLE dynamic transcript and rebuilds it before each
`executor.send`. That transcript mixes several kinds of content; the resume model specifies
each so a suspend/resume reconstructs an **equivalent** protocol-valid context:

- **Static prefix** — system + step user message + STEP-scoped step-result recall. Rebuilt
  deterministically at step start from `bundle`/RAG (unchanged); not strategy state.
- **Recorded tool rounds** — owned by the strategy:
  - RAG-backed (`RagRecallContextStrategy`): results are durable in RAG via `deps.record`;
    `snapshot()` persists only the `last` round (the raw tail). On resume, `restore({last})`
    re-establishes the tail and prior rounds are **re-recalled** from RAG. Recall is
    **deterministic** given the same RAG contents + the same query params (`queryText` from
    `step.instructions`, `runId`, K, `['mcp-result']`, `excludeIdentityKeys`).
  - RAG-less (`Window`/`Legacy`): the buffer/list IS the durable state → `snapshot()` returns it,
    persisted in `inFlightStep.contextStrategyState`, `restore()` on resume.
- **Non-round control messages** — the unavailable-tool **retry feedback** ("Tool X is not
  available", ~1252) and the pending **external-tool** assistant/tool pair
  (`bundle.pending.kind==='external-tool'`, ~1225-1242). These are interleaved with rounds in
  the live sequence, so splitting-then-re-interleaving is error-prone.
- **Resume mechanism (verbatim restore).** To keep resume simple AND protocol-safe, the handler
  persists the EXACT bounded `messages` sequence it last sent to `executor.send` — the output of
  `form()` plus any control messages, in the order they were appended — into `inFlightStep.transcript`
  (this field is REPURPOSED: it now holds the bounded last-sent sequence, no longer a raw
  O(N) accumulation, so it stays small). On resume the handler restores `messages` from
  `inFlightStep.transcript` **verbatim** (it is already a valid, previously-sent context — no
  re-interleaving) and calls `strategy.restore(inFlightStep.contextStrategyState)`. Going forward,
  each new round is `record`ed and the NEXT context is re-derived by `form()` (+ any new control
  message appended in place). Thus the persisted state is O(bounded), resume is byte-exact for what
  the executor already saw, and interleaving order is preserved by construction.
- Two new/changed durable fields on `inFlightStep`: `contextStrategyState?: unknown` (strategy
  `snapshot()`), and `transcript` semantics change from raw-accumulation to bounded-last-sent.
  Everything else reuses existing `bundle`/`inFlightStep` persistence.

---

## Testing

- **Flatness (discriminating).** A fake tool-loop driven for N ∈ {1, 10, 50} tool rounds:
  with `RagRecallContextStrategy` (stub recall returning a fixed bounded block) and with
  `WindowContextStrategy`, assert `form()` output size (message count AND total char length)
  stays within a bounded constant as N grows; with `LegacyAccumulateContextStrategy` it grows
  linearly. This directly proves O(N²)→O(N). RED on legacy, GREEN on bounded.
- **Protocol (single + batch).** For each strategy, assert `form()` emits the most-recent round
  RAW and WHOLE at the tail (its `assistant` then all its `results`, same order), and contains no
  assistant `tool_call` id without a following `tool` message for that id. Include a **batch round**
  (assistant with 2 tool_calls + 2 tool results): assert the batch is kept/elided/recalled as a
  group — never split or reordered.
- **Tool-level error is recorded.** A round whose result `meta.isError===true` is passed to
  `record()` (NOT skipped) and appears in the next `form()` (raw at tail, or as recall/window text),
  so the model sees the failure reason. (Distinguishes from an MCP-unavailable escalate, which is
  NOT recorded.)
- **Multi-call step completes.** A scripted executor making 3 tool calls then content, with
  `RagRecallContextStrategy`: the step completes and yields the final content (recall carried
  cross-round reasoning). Verifies the strategy doesn't starve the executor.
- **Recall split.** With the controller wiring: step-result recall appears in `base.prefix` on
  EVERY round (not lost when the strategy forms mcp-result recall); assert a prior-step result is
  present in round-2+ context.
- **Resume equivalence.** Suspend mid-loop after a round + a control message (an unavailable-tool
  retry AND, separately, a pending external-tool pair); resume: assert `messages` is restored
  **verbatim** from `inFlightStep.transcript` (bounded, not raw-O(N)), `strategy.restore` re-applied,
  interleaving order preserved, and the run continues to completion. Assert the persisted
  `transcript` length is bounded (does not grow with prior round count).
- **Per-loop isolation (no leakage).** The factory yields a FRESH instance per step/loop; two
  sequential loops sharing the injected factory do NOT see each other's rounds. A strategy instance
  is never shared across concurrent requests.
- **Fail-loud unchanged.** MCP-unavailable mid-loop → loud escalate; `record` not reached.
  The 20.4.0 `controller-mcp-failloud` + `controller-mcp-classifier` tests stay green.
- **Backward-compat.** No factory injected → `LegacyAccumulateContextStrategy` → existing
  tool-loop-timing-log / controller handler tests byte-identical (green, unmodified).
- **Live acceptance.** Re-run the controller P3 ("Create ABAP class ZCL_MCP_AUTHOR_READER",
  the 1.1M-token run) on trial `:9001` with `RagRecallContextStrategy` injected: assert the
  executor `sum_prompt` is no longer O(N²) (per-round prompt stays bounded) and total tokens
  drop sharply, AND the delivered class is still correct. (Uses the existing
  `.run/eval/run.sh` harness pattern.)

---

## File Structure

- **NEW** `packages/llm-agent/src/interfaces/tool-loop-context-strategy.ts` — interface + types
  (`IToolLoopContextStrategy`, `ToolRound`, `ToolLoopContextBase`, `ToolLoopContextStrategyFactory`,
  `ToolLoopContextStrategyDeps`); add to interfaces barrel.
- **NEW** `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/`:
  - `legacy-accumulate-context-strategy.ts`
  - `window-context-strategy.ts`
  - `rag-recall-context-strategy.ts` (+ `RagRecallDeps`)
  - `index.ts` barrel.
- **MODIFY** `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` (per-loop factory instance;
  ~829 accumulation → record/form), `tool-loop-core.ts` (return the batch `assistant`+`results`
  grouped so the caller can build a `ToolRound`), `packages/llm-agent-libs/src/agent.ts`
  (`SmartAgentDeps.toolLoopContextStrategyFactory` + direct-loop wiring), `builder.ts`
  (`withToolLoopContextStrategyFactory`), `pipeline/default-pipeline.ts` + `interfaces/pipeline.ts`
  (`PipelineDeps`) + default-pipeline `RagRecallContextStrategy` wiring,
  `interfaces/pipeline-plugin.ts` (`IPipelineContext.toolLoopContextStrategyFactory?`).
- **MODIFY** `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
  (replace raw push with strategy record/form; per-loop instance via factory;
  `inFlightStep.contextStrategyState?` + `transcript` bounded-last-sent semantics; shrink),
  `smart-server.ts` (`BuildAgentDeps` + `buildServerCtx` populate) and the controller composition
  (`pipelines/controller.ts`) to wire the `RagRecallContextStrategy` factory from `recall.ts`
  (`runScopedRecall(['mcp-result'])` + `buildRecallBlock`) + `writeArtifact`.
- **MODIFY** `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` — add
  `contextStrategyState?: unknown` to the in-flight step type; `transcript` doc note (bounded-last-sent).

---

## Architecture Principles Compliance

1. **Build ON components** — reuses `recall.ts`, `writeArtifact`, `IContextAssembler`,
   `historyMemory`; the strategy is generic and parameterized, not a reimplementation.
2. **The app IS the example** — SmartServer/controller/default pipeline inject the
   RAG-recall strategy, demonstrating the RAG-managed way.
3. **Around interfaces** — consumers depend on `IToolLoopContextStrategy`.
4. **ISP** — a NEW focused interface (record + form), not a method grown onto an existing one.
5. **Consumer variation → strategy + DI** — fully swappable; RAG-less/legacy/own all allowed.
6. **File-size control** — extraction reduces the 1716-line handler; new modules are small.
7. **Don't break components** — additive optional fields; library default byte-identical.
