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
  pipeline). Our example compositions inject a **bounded** strategy — the **controller**
  injects the RAG-managed `RagRecallContextStrategy` (it has a run-scoped per-round results
  RAG), and the **default pipeline / direct SmartAgent** inject the RAG-less
  `WindowContextStrategy` (no per-round results RAG there yet — see "Default pipeline / core").
  A RAG-managed default pipeline is a documented follow-up. See
  `feedback_consumer_chooses_seams_rag_examples`.
- **Library default = backward-compat.** When no strategy factory is injected, behavior is
  **byte-identical to today** (the `LegacyAccumulateContextStrategy`). We do NOT
  frame a behavior change (windowing) as the default.
- **Build ON components.** Reuse `recall.ts` (`runScopedRecall` / `buildRecallBlock` /
  `relevantExtract`), the existing `writeArtifact`, `IContextAssembler`, and
  `historyMemory`. Do not reimplement recall/ranking. The `RagRecallContextStrategy`
  is *generic* — parameterized by injected `recall` + `record` functions — so the
  controller wires its run-scoped recall without moving `recall.ts` across packages.
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

  /** Serialize the impl's durable state so an in-flight loop survives suspend/resume.
   *  MUST return a **plain JSON-serializable** value (no Map/Set/class/function/cyclic
   *  refs) — it is persisted into the backend `bundle` and JSON round-tripped. MUST
   *  carry a `version` for forward-compat. RAG-backed impls may return a minimal marker
   *  (results live in RAG). See "Durable state & resume". */
  snapshot(): SerializableStrategyState;
  /** Restore from a prior snapshot() on resume (instead of reset()). MUST tolerate a
   *  `version` it does not recognize by falling back to a clean state (never throw). */
  restore(state: SerializableStrategyState): void;
}

/** Plain JSON-serializable strategy state. `version` is mandatory; the rest is the
 *  impl's own shape. Persisted in the durable bundle → NO Map/Set/class/function/cyclic. */
export interface SerializableStrategyState {
  readonly version: number;
  readonly [k: string]: JsonValue;
}
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [k: string]: JsonValue };

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
  and `deps.recall` = `runScopedRecall(['mcp-result'], runId, …)` + `buildRecallBlock` — it
  already has a run-scoped, per-round results RAG. **The controller is our RAG-managed example.**

### Default pipeline / core = `WindowContextStrategy` (honest scope) — P2 fix
The default pipeline does NOT today have a per-round tool-RESULT RAG: `history-upsert`
(`history-upsert.ts:48`) writes ONE post-turn SUMMARY keyed `turn:${sessionId}:${turnIndex}` with
generic metadata, and history retrieval runs ONCE before the tool-loop (`default-pipeline.ts:328`)
— neither is per-round tool-result storage. So OUR default-pipeline / direct-SmartAgent composition
injects the **`WindowContextStrategy`** (RAG-less bounded) — it still eliminates the O(N²) growth
without overclaiming a RAG we don't have. A genuine RAG-managed default pipeline (a new per-round
tool-loop-round store + schema/metadata + query/exclude rules, distinct from the turn-summary
history store) is a **deferred follow-up**, not this spec. A consumer who wants it wires a
`RagRecallContextStrategy` factory over their own results store.

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
- **The external-tool pair is a `ToolRound`.** On resume of a pending external-tool call
  (`bundle.pending.kind==='external-tool'`, ~1225-1242) the injected `assistant(tool_call)`→`tool(result)`
  pair is `record`ed as a round — so it enters the strategy and is bounded/recalled like any result,
  NOT special-cased.
- **The only NON-round control message is the unavailable-tool retry feedback** ("Tool X is not
  available", ~1252) — a `{role:'user'}` message with no recorded round. It lives in a bounded
  **`controlTail: Message[]`** owned by the handler: appended AFTER `form()`'s output on EVERY round
  (so it does not vanish on the next `form()` — closes the post-resume hole), and PRUNED once the
  model's next successful round is recorded (it has served its purpose). `controlTail` is persisted
  in `inFlightStep` and is O(bounded) (at most `maxRetries` entries).
- Each round's sent `messages = await strategy.form({prefix, queryText}) ++ controlTail`. Both parts
  are bounded and persisted; the strategy owns rounds, the handler owns the short control tail.
- Net effect: `controller-coordinator-handler.ts` shrinks (raw-round transcript management leaves it).

### Shared core — applies to BOTH `ToolLoopHandler.execute` (`tool-loop.ts`) AND the direct `SmartAgent._runStreamingToolLoop` (`agent.ts`)
Both loops have the SAME raw-accumulation paths and BOTH adopt the strategy identically (the direct
path is not a vague afterthought — it is a first-class consumer of the same `ToolRound` rule).
- Create the per-loop strategy from the factory before the loop; `reset()`-equivalent is a fresh instance.
- **Uniform rule — every assistant-`tool_calls` + tool-result GROUP is a `ToolRound`.** ALL the
  paths that today do `messages = <build...>(messages, …); continue` (or `messages.push(...)`) —
  growing the raw tail — are routed through `record` + `form` instead of a direct append. Concretely,
  in EACH loop:
  - **internal MCP batch** — `tool-loop.ts` ~829 (`messages = [...messages, ...outcome.toolMessages]`)
    and the direct path `agent.ts:1226`/`1319` → `ToolRound`;
  - **blocked tools** — `tool-loop.ts:578` (`buildBlockedToolMessages`) and `agent.ts:1167` → `ToolRound`;
  - **hallucinated tools** — `tool-loop.ts:590` (`buildHallucinatedToolMessages`) and `agent.ts:1176`
    → `ToolRound`;
  - **external HIT** — `tool-loop.ts:622` matched `assistant(tool_calls=[extId])`→`tool(extId)` pair
    → `ToolRound` (a real external result the model must keep/recall);
  - **pending mixed-call results injected at loop start** — `tool-loop.ts:135` and `agent.ts:773`
    (`injectPendingResults`: an `assistant`/`tool` group for already-resolved internal calls) →
    `ToolRound`, recorded BEFORE the first `form()` so it survives subsequent rounds (else it would
    be present only for the first LLM call and vanish after the next `form()`).
  This makes the invariant "the loop NEVER accumulates raw results itself" literally true in BOTH
  loops — exactly ONE growth site (the strategy's recorded list), which each strategy bounds.
  (external MISS still surfaces + ends the turn — no injection, no round.)
- `tool-loop-core.ts` `executeToolBatchWithHeartbeat` returns the batch `assistant`+`results`
  GROUPED so the caller can build a `ToolRound` without re-deriving the assistant tool_calls; the
  helpers `buildBlockedToolMessages`/`buildHallucinatedToolMessages` (shared by both loops) are
  refactored to RETURN their `{assistant, results}` group (the caller records it) rather than mutate
  `messages` in place.
- The `assemble` handler / the direct path's initial context build runs once for `staticPrefix` on
  the first round; subsequent rounds are formed by the injected strategy. OUR default-pipeline /
  direct-SmartAgent composition injects the `WindowContextStrategy` (see "Default pipeline / core");
  the library default (nothing injected) stays `LegacyAccumulateContextStrategy` (byte-identical).

### DI threading (mirror `IMcpFailureClassifier`, but as a FACTORY)
The strategy is STATEFUL and per-loop, so the seam is a **factory**, not a shared instance —
this eliminates cross-request state leakage. Add optional
`toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory` to:
`IPipelineContext` (pipeline-plugin.ts), `SmartAgentDeps`, `PipelineDeps`, `BuildAgentDeps`,
`ControllerHandlerDeps`. Add `builder.withToolLoopContextStrategyFactory(f): this`. Populate
`ctx.toolLoopContextStrategyFactory` in `_buildContext` / `buildServerCtx`. Default resolves to
`() => new LegacyAccumulateContextStrategy()` at the point of use. Our compositions inject:
the **controller** → a factory building `RagRecallContextStrategy` bound to the run's RAG (via
`recall.ts`); the **default pipeline / direct SmartAgent** → a factory building
`WindowContextStrategy` (RAG-less bounded). Add durable fields
`contextStrategyState?: SerializableStrategyState` + `controlTail?: Message[]` to the controller's
`inFlightStep` so `snapshot()`/`restore()` + the control tail survive suspend/resume. **No YAML.**

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
- **External-tool pair = a round.** The pending external-tool assistant/tool pair
  (`bundle.pending.kind==='external-tool'`, ~1225-1242) is `record`ed as a `ToolRound` on resume →
  it enters the strategy (bounded/recalled), so it is NOT a separate durable concern.
- **The bounded `controlTail`.** The only non-round control message is the unavailable-tool retry
  feedback ("Tool X is not available", ~1252) — a `{role:'user'}` message. It is held in a bounded
  `inFlightStep.controlTail: Message[]` (≤ `maxRetries` entries), appended AFTER `form()` on EVERY
  round, and pruned once the next successful round is recorded. Persisting it (not the whole
  transcript) closes the post-resume hole: after the first post-resume `form()`, the tail is still
  present because it is re-appended each round from durable state, not carried inside `form()`.
- **Resume mechanism.** No raw transcript is persisted. `staticPrefix` is rebuilt deterministically,
  then — after `strategy.restore(inFlightStep.contextStrategyState)` — the SINGLE rule (same as every
  round, incl. resume) is:
  `messages = await strategy.form({ prefix: staticPrefix, queryText }) ++ inFlightStep.controlTail`.
  (`form()` itself emits `prefix` first — the handler never prepends `prefix` separately, so it is
  neither omitted nor duplicated.) Because `form()` always re-derives rounds (RAG re-recall or
  restored buffer) and `controlTail` is re-appended from durable state every round, the ordering
  `prefix → rounds → controlTail` is invariant across suspend/resume and every subsequent
  `record`/`form` — no message vanishes, no interleaving drift.
- **Durable fields on `inFlightStep`:** `contextStrategyState?: SerializableStrategyState` (strategy
  `snapshot()`, JSON-serializable/versioned) and `controlTail?: Message[]` (bounded). The old raw
  `transcript` accumulation is REMOVED (replaced by these two bounded fields). Everything else reuses
  existing `bundle`/`inFlightStep` persistence.

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
- **Resume equivalence.** Suspend mid-loop after several rounds + a pending unavailable-tool retry
  (`controlTail`) AND, separately, a pending external-tool pair; resume: assert the reconstructed
  `messages` = `prefix ++ form() ++ controlTail`, that `strategy.restore` re-derives prior rounds
  (RAG re-recall / restored buffer), that the external pair was recorded as a round, and that BOTH
  the retry feedback and the external result survive a FURTHER `record`/`form` (the post-resume hole).
  Assert `inFlightStep` durable size is bounded (`contextStrategyState` + `controlTail` do NOT grow
  with prior round count; no raw `transcript`).
- **Snapshot is JSON-safe.** `snapshot()` of each provided strategy round-trips through
  `JSON.parse(JSON.stringify(...))` unchanged and carries a `version`; `restore()` of an unknown
  `version` falls back to clean state without throwing.
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
  (`SmartAgentDeps.toolLoopContextStrategyFactory` + direct `_runStreamingToolLoop` wiring — the
  same uniform ToolRound rule; agent.ts:1167/1176/1226/1319 accumulation paths + the pending-results
  injection at agent.ts:773), `builder.ts` (`withToolLoopContextStrategyFactory`),
  `pipeline/default-pipeline.ts` + `interfaces/pipeline.ts` (`PipelineDeps`) + default-pipeline
  `WindowContextStrategy` factory wiring, `interfaces/pipeline-plugin.ts`
  (`IPipelineContext.toolLoopContextStrategyFactory?`).
- **MODIFY** `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
  (replace raw push with strategy record/form; per-loop instance via factory; external pair → round;
  `inFlightStep.contextStrategyState?` + `controlTail?`, remove raw `transcript`; shrink),
  `smart-server.ts` (`BuildAgentDeps` + `buildServerCtx` populate) and the controller composition
  (`pipelines/controller.ts`) to wire the `RagRecallContextStrategy` factory from `recall.ts`
  (`runScopedRecall(['mcp-result'])` + `buildRecallBlock`) + `writeArtifact`.
- **MODIFY** `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` — on the in-flight
  step type: add `contextStrategyState?: SerializableStrategyState` and `controlTail?: Message[]`;
  REMOVE the raw `transcript` accumulation field (replaced by these two bounded fields).

---

## Architecture Principles Compliance

1. **Build ON components** — reuses `recall.ts`, `writeArtifact`, `IContextAssembler`,
   `historyMemory`; the strategy is generic and parameterized, not a reimplementation.
2. **The app IS the example** — the SmartServer **controller** injects the `RagRecallContextStrategy`
   (run-scoped per-round results RAG) — our RAG-managed example; the default pipeline / direct
   SmartAgent inject the bounded `WindowContextStrategy` (honest: no per-round results RAG there yet).
   A RAG-managed default pipeline is a documented follow-up.
3. **Around interfaces** — consumers depend on `IToolLoopContextStrategy`.
4. **ISP** — a NEW focused interface (record + form), not a method grown onto an existing one.
5. **Consumer variation → strategy + DI** — fully swappable; RAG-less/legacy/own all allowed.
6. **File-size control** — extraction reduces the 1716-line handler; new modules are small.
7. **Don't break components** — additive optional fields; library default byte-identical.
