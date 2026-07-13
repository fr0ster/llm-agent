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

/** One completed tool round: the model's tool call and the executed result. */
export interface ToolRound {
  call: { id: string; name: string; arguments: unknown };
  /** Raw tool result text (what callTool/callMcp returned). */
  result: string;
  /** Stable identity (tool+args) for dedup / recall keying. */
  identityKey?: string;
  /** Round ordinal within the current loop/step (0-based). */
  ordinal?: number;
}

/** The invariant context the strategy MUST preserve when forming a round. */
export interface ToolLoopContextBase {
  /** Static prefix (system prompt + the step/action user message + any
   *  step-start recall the caller already built). Emitted FIRST by form(). */
  prefix: Message[];
  /** The immediate assistant tool_call + tool result pair for THIS round that
   *  the OpenAI protocol requires the model to see to continue. Empty on the
   *  first round. MUST appear verbatim at the TAIL of form(). */
  immediate: Message[];
  /** Query text the strategy may use to rank/recall relevant prior context
   *  (e.g. the step instructions). */
  queryText?: string;
}

/** Consumer-owned strategy that OWNS per-round context formation for a
 *  tool-calling loop. The loop calls record() after each tool result and form()
 *  before each LLM call; the loop NEVER accumulates raw results itself. The impl
 *  decides which RAG collections, K, and how — or a RAG-less window, or nothing. */
export interface IToolLoopContextStrategy {
  /** Record a completed tool round wherever the impl wants (RAG write, in-memory
   *  window, or nothing). Called after each SUCCESSFUL tool execution. */
  record(round: ToolRound, options?: CallOptions): Promise<void>;

  /** Form the bounded Message[] for the NEXT LLM call. MUST emit base.prefix
   *  first and base.immediate at the tail; everything between is the impl's
   *  bounded recall/window over prior rounds. */
  form(base: ToolLoopContextBase, options?: CallOptions): Promise<Message[]>;

  /** Optional: clear per-loop state (window buffers, ordinals) at the start of a
   *  new loop/step. */
  reset?(): void;
}
```

---

## Provided Implementations (all in `@mcp-abap-adt/llm-agent-libs`, swappable)

`packages/llm-agent-libs/src/pipeline/context/tool-loop-context/`:

### 1. `LegacyAccumulateContextStrategy` (library default — backward-compat)
- Maintains an internal running list of every round's message pair.
- `record()` — no-op (`form()` does the accumulation; the pair arrives via `base.immediate`).
- `form(base)` — appends `base.immediate` to the internal running list, then returns
  `base.prefix` + the full running list (every prior pair, in order). This reproduces
  today's growing transcript **byte-identically**.
- `reset()` — clears the running list at the start of a new loop/step.
- Purpose: when nobody injects a strategy, nothing changes. Existing tool-loop /
  controller tests remain green unmodified.

### 2. `WindowContextStrategy` (RAG-less bounded window)
- Config: `keepLastRounds` (default e.g. 3), `elideMarker(round)` → a one-line string.
- `record(round)` — pushes a compact reference (identity + truncated head + char count)
  into a bounded buffer.
- `form(base)` — `prefix` + the last `keepLastRounds` rounds raw (as their message pairs)
  + a single compact "[N earlier tool results elided]" marker for the rest + `immediate`.
- Purpose: graceful-degrade for a consumer who wants bounding without a results-RAG.

### 3. `RagRecallContextStrategy` (generic, RAG-managed — what our examples inject)
- Constructed with injected functions so it stays package-agnostic:
  ```ts
  interface RagRecallDeps {
    /** Persist a completed round's result to the consumer's RAG. */
    record(round: ToolRound, options?: CallOptions): Promise<void>;
    /** Return a bounded, ranked recall block (string) for the query text. */
    recall(queryText: string, options?: CallOptions): Promise<string>;
  }
  ```
- `record()` → `deps.record(round, options)`.
- `form(base)` → `prefix` + (a single `{role:'user', content: await deps.recall(base.queryText)}`
  bounded recall message, when non-empty) + `immediate`.
- Purpose: the RAG way. The **controller** wires `deps.record` = `writeArtifact(mcp-result)`
  and `deps.recall` = `runScopedRecall` + `buildRecallBlock` (run-scoped). The **default
  pipeline** wires `deps.record` = history-RAG upsert and `deps.recall` = its RAG-query +
  `IContextAssembler`-style bounded block.

---

## Integration

### Controller `runStep` (`controller-coordinator-handler.ts`, ~1049-1355)
- The raw push at ~1337-1352 (`messages.push(assistant tool_call)` + `messages.push(tool result)`
  then loop back re-sending all of `messages`) is REPLACED:
  1. On escalate (MCP-unavailable) — unchanged (fail-loud abort, before record).
  2. On a successful result — build `ToolRound{call, result, identityKey}`, call
     `await strategy.record(round, ctx.options)`.
  3. Set `base = { prefix: staticPrefix, immediate: [assistantToolCall, toolResult], queryText: step.instructions }`
     and `messages = await strategy.form(base, ctx.options)` for the next `deps.executor.send`.
- The `writeArtifact(mcp-result)` currently at ~1316 moves INTO the controller's
  `RagRecallContextStrategy.record` wiring (the pipeline owns "where results go").
- The step-start recall block (~920-945) is produced by the same `strategy.form` on the
  first round (`immediate` empty), so recall is applied **every** round, not just at step start.
- `inFlightStep.transcript` (durable raw tail) is reduced to the durable minimum the
  strategy needs to reconstruct: the RAG is durable via the backend; on resume,
  `strategy.form` re-queries RAG deterministically, plus the persisted immediate pair.
- Net effect: `controller-coordinator-handler.ts` shrinks (raw-transcript management leaves it).

### Shared `tool-loop-core` / `tool-loop.ts`
- `tool-loop.ts` ~829 `messages = [...messages, ...outcome.toolMessages]` (accumulation)
  is REPLACED by: for each produced tool result, `await strategy.record(round)`; then
  `messages = await strategy.form({prefix, immediate, queryText})` for the next iteration.
- `tool-loop-core.ts` `executeToolBatchWithHeartbeat` continues to PRODUCE the per-batch
  tool messages/rounds; the CALLER (the loop in `tool-loop.ts` / `agent.ts`) applies the
  strategy. The `IExecuteToolBatchArgs` gains `toolLoopContextStrategy?` only if the
  strategy must be consulted inside the batch (otherwise it is applied by the caller —
  the implementer picks the seam that keeps the batch function cohesive).
- The default-pipeline `assemble` handler still runs once for the first round; subsequent
  rounds are formed by the injected `RagRecallContextStrategy` (default pipeline wiring),
  keeping the "form from RAG per round" model.

### DI threading (mirror `IMcpFailureClassifier`)
Add optional `toolLoopContextStrategy?: IToolLoopContextStrategy` to:
`IPipelineContext` (pipeline-plugin.ts), `SmartAgentDeps`, `PipelineDeps`, `BuildAgentDeps`,
`ControllerHandlerDeps`, and (if consulted in-batch) `IExecuteToolBatchArgs`. Add
`builder.withToolLoopContextStrategy(s): this`. Populate `ctx.toolLoopContextStrategy` in
`_buildContext` / `buildServerCtx`. Default resolves to `new LegacyAccumulateContextStrategy()`
at the point of use. Our compositions inject `RagRecallContextStrategy` (controller wiring
via `recall.ts`; default pipeline via history RAG). **No YAML.**

---

## Correctness Invariants

1. **OpenAI tool protocol.** `form()` always ends with `base.immediate` (the assistant
   `tool_call` + its `tool` result). Older pairs are never left dangling — they are elided
   as a whole (window) or replaced by recall (RAG). First round: `immediate` empty, `form()`
   = prefix (+ recall/window if any).
2. **Determinism / resume (controller).** Durable state = the RAG (via backend) + the
   persisted immediate pair, NOT a growing raw tail. On resume `strategy.form` re-queries
   RAG → same bounded context. A crash/suspend never rebuilds a *shorter* context than the
   executor saw (the recall is a superset selection, ranked; the immediate pair is persisted).
3. **Fail-loud unchanged.** `classifyToolResult`/escalate runs before `record`; an
   MCP-unavailable failure still aborts loud; a tool-level error stays LLM feedback text.
4. **Backward-compat.** No injection → `LegacyAccumulateContextStrategy` → byte-identical
   messages; all existing tool-loop/controller tests pass unmodified.

---

## Testing

- **Flatness (discriminating).** A fake tool-loop driven for N ∈ {1, 10, 50} tool rounds:
  with `RagRecallContextStrategy` (stub recall returning a fixed bounded block) and with
  `WindowContextStrategy`, assert `form()` output size (message count AND total char length)
  stays within a bounded constant as N grows; with `LegacyAccumulateContextStrategy` it grows
  linearly. This directly proves O(N²)→O(N). RED on legacy, GREEN on bounded.
- **Protocol.** For each strategy, assert `form()` output ends with exactly `base.immediate`
  and contains no assistant `tool_call` without a following `tool` message.
- **Multi-call step completes.** A scripted executor making 3 tool calls then content, with
  `RagRecallContextStrategy`: the step completes and yields the final content (recall carried
  cross-round reasoning). Verifies the strategy doesn't starve the executor.
- **Resume.** Suspend mid-loop, resume: assert the reconstructed context is deterministic
  (re-query RAG) and the run continues to completion.
- **Fail-loud unchanged.** MCP-unavailable mid-loop → loud escalate; `record` not reached.
  The 20.4.0 `controller-mcp-failloud` + `controller-mcp-classifier` tests stay green.
- **Backward-compat.** No strategy injected → existing tool-loop-timing-log / controller
  handler tests byte-identical (green, unmodified).
- **Live acceptance.** Re-run the controller P3 ("Create ABAP class ZCL_MCP_AUTHOR_READER",
  the 1.1M-token run) on trial `:9001` with `RagRecallContextStrategy` injected: assert the
  executor `sum_prompt` is no longer O(N²) (per-round prompt stays bounded) and total tokens
  drop sharply, AND the delivered class is still correct. (Uses the existing
  `.run/eval/run.sh` harness pattern.)

---

## File Structure

- **NEW** `packages/llm-agent/src/interfaces/tool-loop-context-strategy.ts` — interface + types
  (`IToolLoopContextStrategy`, `ToolRound`, `ToolLoopContextBase`); add to interfaces barrel.
- **NEW** `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/`:
  - `legacy-accumulate-context-strategy.ts`
  - `window-context-strategy.ts`
  - `rag-recall-context-strategy.ts` (+ `RagRecallDeps`)
  - `index.ts` barrel.
- **MODIFY** `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` (per-round form/record;
  ~829 accumulation replaced), `tool-loop-core.ts` (`IExecuteToolBatchArgs` field if needed),
  `packages/llm-agent-libs/src/agent.ts` (`SmartAgentDeps` + direct-loop wiring),
  `builder.ts` (`withToolLoopContextStrategy`), `pipeline/default-pipeline.ts` +
  `interfaces/pipeline.ts` (`PipelineDeps`) + default-pipeline `RagRecallContextStrategy` wiring,
  `interfaces/pipeline-plugin.ts` (`IPipelineContext`).
- **MODIFY** `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
  (replace raw push with strategy record/form; shrink), `smart-server.ts` (`BuildAgentDeps` +
  `buildServerCtx` populate) and the controller composition (`pipelines/controller.ts`) to wire
  `RagRecallContextStrategy` from `recall.ts` + `writeArtifact`.

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
