# Tool-loop Shared-Core Extraction (PR-2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task with review checkpoints. Each task ends in exactly one commit. Do NOT batch tasks.

## Goal

Two tool-execution loops in `@mcp-abap-adt/llm-agent-libs` share a large, proven-identical core but have genuinely diverged on four behavioral bands. Extract the identical/equiv-plumbing core into shared free functions in a NEW module `packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts`, and make BOTH loops delegate to those helpers. This is **Option B** (shared-core extraction) — NOT Option A (full convergence, which was rejected because it would break CI on both callers by unifying divergent behavior). After each commit both callers behave IDENTICALLY to before; only duplication is removed.

**The two loops:**
- **Loop A** — `SmartAgent._runStreamingToolLoop` in `packages/llm-agent-libs/src/agent.ts` (~737–1499). An async generator; `yield`s `Result<LlmStreamChunk, OrchestratorError>`; deps from `this.*` + method params.
- **Loop B** — `ToolLoopHandler.execute` in `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` (~99–1003). Returns `Promise<boolean>`; deps from `ctx`; emits via `ctx.yield(...)`.

**Spec / divergence map:** `.superpowers/sdd/tool-loop-divergence-spike.md` (the Phase table classifies each phase IDENTICAL / EQUIV-PLUMBING / DIVERGENT; the dep-mapping table binds `this.<x>`↔`ctx.<x>`, `activeTools` param↔`ctx.activeTools`, generator `yield`↔`ctx.yield`, `return`↔`return true/false`).

## Architecture

- The new module holds ONLY the identical/equiv-plumbing spine as internal free functions. It is NOT exported from any barrel (`src/index.ts`).
- Divergent bands stay per-caller and are NOT touched: (i) span structure (A's `smart_agent.tool_loop` parent span), (ii) streaming-emission modes (`streamMode:'final'` / `clientAdapter` / `onBeforeStream` vs live + `onPartial`), (iii) external-tool handling (A live deltas + fire-async return; B extId HIT/MISS resume), (iv) observability + terminal-usage shape (`summaryToUsage` vs local `usage` + `components`/`categories`; B's per-iter `logLlmCall`, `logRagQuery`, context-summary warning log).
- The **exec-batch heartbeat helper is an async generator**: it `yield`s the heartbeat + escalation chunks and *returns* a `BatchOutcome` value. Loop A consumes it via `yield*` (chunks flow to A's consumer, `yield*` captures the return value). Loop B drains it manually (`while (!step.done) ctx.yield(step.value)`) then reads `step.value`. Both produce byte-identical emissions and control flow.

## Tech Stack

- TypeScript strict, ESM (`.js` import specifiers), Node ≥ 22.
- Test runner: `node --test` via `tsx/esm` (`npm test -w @mcp-abap-adt/llm-agent-libs`). Tests use `node:test` + `node:assert/strict`.
- Lint/format: Biome.

## Global Constraints

- **Behavior-preserving.** Extracted helpers are byte-faithful; the 4 DIVERGENT bands (streaming-emission modes, external-tool handling, span structure, observability/usage-shape) stay PER-CALLER and are NOT touched. Both callers' behavior is IDENTICAL after each commit. No convergence of divergent behavior (Option A is out of scope).
- **Public API byte-stable.** `SmartAgent` + its exported types, and `ToolLoopHandler` (+ `IStageHandler`), keep their signatures. The new `tool-loop-core.ts` helpers are internal — NOT on any barrel (`src/index.ts`).
- **Both test suites are the gate.** Loop A tests in `src/__tests__/` (`streaming`, `on-before-stream`, `tool-priority`, `tool-reselection`, `parallel-mixed-tool-calls`, `agent-hard-mode-external`, `agent-mcp-unavailable-escalates`); Loop B tests in `src/pipeline/handlers/__tests__/` (`tool-loop-external`, `external-results-threading`, `tool-loop-stream`, `tool-loop-usage-accumulation`, `traceid-stamping`, `tool-loop-reset`, `tool-loop-mcp-unavailable`, `rag-query-*`). Run the FULL `npm test -w @mcp-abap-adt/llm-agent-libs` each task (both suites live in the same package). NOTE: `external-results-threading.test.ts` and `parallel-mixed-tool-calls.test.ts` physically live under `src/__tests__/` (they drive `ToolLoopHandler` / `SmartAgent` respectively) — the single package-wide `npm test` runs them regardless.
- ESM `.js`, TS strict, Biome. `noUnusedLocals: true` — remove dead imports after each extraction. **Lint gate:** `npm run format` → `npx @biomejs/biome check --write <files>` → `npm run lint:check` requiring **exit code 0** (warnings/infos fine; ~38 pre-existing). Do NOT grep for "Found 0 errors."
- **Post-check:** `wc -l` — `tool-loop-core.ts` must stay < 500 (if it approaches, that's fine to note but each helper is small); `agent.ts` and `tool-loop.ts` both shrink after each extraction.
- Each task ends in exactly one commit (`test:` for Task 0, `refactor:` for 1–6).

## File Structure

```
packages/llm-agent-libs/src/
  pipeline/handlers/
    tool-loop-core.ts                         (NEW — internal shared helpers; grows one helper per task; NOT on any barrel)
    tool-loop.ts                              (MODIFIED — Loop B delegates; duplicated blocks deleted)
  agent.ts                                    (MODIFIED — Loop A delegates; duplicated blocks deleted)
  __tests__/
    tool-loop-characterization.test.ts        (NEW — Task 0 — Loop A: tool_loop span structure + A reselect read-only keeps-all + skip log)
  pipeline/handlers/__tests__/
    tool-loop-reselect-readonly.test.ts       (NEW — Task 0 — Loop B: reselect read-only restores prevSelectedTools, no skip log)
```

Import paths **from** `pipeline/handlers/tool-loop-core.ts`:
- `@mcp-abap-adt/llm-agent` → `CallOptions`, `IMcpClient`, `IToolCache`, `LlmStreamChunk`, `LlmTool`, `Message`, `Result`, `TimingEntry`, and the value `OrchestratorError` (sourced from its TRUE origin — `agent.ts` itself imports `OrchestratorError` from `@mcp-abap-adt/llm-agent`; importing it here rather than from `../../agent.js` keeps `tool-loop-core.ts` free of any `agent.js` value-cycle)
- `../../tracer/types.js` → `ISpan`, `ITracer`
- `../../metrics/types.js` → `IMetrics`
- `../../validator/types.js` → `IOutputValidator`
- `./escalate-if-unavailable.js` → `classifyToolResult` (REUSE — do not re-extract)
- `../../policy/tool-availability-registry.js` → `isToolContextUnavailableError`, `ToolAvailabilityRegistry`
- `../../policy/pending-tool-results-registry.js` → `PendingToolResultsRegistry`

---

### Task 0 — Characterization guards FIRST (`test:`)

Localize/strengthen coverage of two behaviors adjacent to the cut zone BEFORE any extraction, so later refactors cannot silently regress them:
- **#2** — Loop A's dedicated `smart_agent.tool_loop` span that parents all sub-spans and is ended on exit. (NOTE: this is already covered generally by `src/tracer/__tests__/tracer.test.ts` — which asserts `smart_agent.tool_loop` parents `llm_call`/`tool_call`. This new test STRENGTHENS/LOCALIZES that guard right next to the refactor, driven end-to-end through `SmartAgent.process`; it is not filling a gap in missing coverage.)
- **#4** — the reselect READ-ONLY branch: this IS genuinely under-guarded — `tool-reselection.test.ts` exercises reselect but does not distinguish A's "keep full refreshed set + log `tools_reselect_skipped`" from B's "restore `prevSelectedTools`, no skip log". This is the guard that actually matters.

**Files:**
- `packages/llm-agent-libs/src/__tests__/tool-loop-characterization.test.ts` (NEW)
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-reselect-readonly.test.ts` (NEW)

**Interfaces:** none new. Loop A driven via `SmartAgent.process(...)` with an injected `makeCapturingTracer()` (from `../testing/index.js`, which records `{name, parentName, ended}` per span). Loop B driven via `new ToolLoopHandler().execute(ctx, config, span)` with a hand-built `PipelineContext` mirroring `tool-loop-external.test.ts`'s `makeCtx`.

**Steps:**

- [ ] Create `src/__tests__/tool-loop-characterization.test.ts`. Mirror the harness of `src/__tests__/tool-reselection.test.ts` (`makeDefaultDeps`, `makeAssembler`, `makeRag`) but inject a capturing tracer. Sub-test A1 pins the span tree:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import {
  makeAssembler,
  makeCapturingTracer,
  makeDefaultDeps,
  makeRag,
} from '../testing/index.js';

// A streaming LLM: iteration 1 → one tool call; iteration 2 → stop.
function makeToolThenStopLlm(
  toolName: string,
  onCall?: (i: number, tools: LlmTool[]) => void,
) {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async chat() {
      return { ok: true as const, value: { content: 'ok', finishReason: 'stop' as const } };
    },
    async *streamChat(
      _msgs: Message[],
      tools?: LlmTool[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      callCount++;
      onCall?.(callCount, tools ?? []);
      if (callCount === 1) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ index: 0, id: 'tc_1', name: toolName, arguments: '{}' }],
            finishReason: 'tool_calls',
          },
        };
      } else {
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      }
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  };
}

describe('Loop A characterization — tool_loop span structure (#2)', () => {
  it('opens a smart_agent.tool_loop span that parents sub-spans and is ended', async () => {
    const tracer = makeCapturingTracer();
    const llm = makeToolThenStopLlm('CreateClass');
    const { deps } = makeDefaultDeps({
      tracer,
      assembler: makeAssembler([
        { role: 'system', content: '## Available Tools\n- CreateClass: create' },
        { role: 'user', content: 'create a class' },
      ]),
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                { name: 'CreateClass', description: 'create', inputSchema: { type: 'object' } },
              ],
            };
          },
          async callTool() {
            return { ok: true as const, value: { content: 'ok' } };
          },
        },
      ],
    });
    deps.mainLlm = llm;
    const agent = new SmartAgent(deps, { maxIterations: 5 });
    await agent.process('create a class', { sessionId: 'span-char' });

    const loopSpans = tracer.spans.filter((s) => s.name === 'smart_agent.tool_loop');
    assert.equal(loopSpans.length, 1, 'exactly one smart_agent.tool_loop span');
    assert.ok(loopSpans[0].ended, 'tool_loop span must be ended on exit');
    // Every loop sub-span is parented by tool_loop (nesting one level deeper than B).
    const subNames = ['smart_agent.llm_call', 'smart_agent.tool_call'];
    const subs = tracer.spans.filter((s) => subNames.includes(s.name));
    assert.ok(subs.length >= 2, 'expected llm_call + tool_call sub-spans');
    for (const s of subs) {
      assert.equal(
        s.parentName,
        'smart_agent.tool_loop',
        `${s.name} must be parented by smart_agent.tool_loop`,
      );
    }
  });
});
```

- [ ] Add sub-test A2 (same file) pinning A's reselect **read-only** branch: capture the tools offered on iteration 2 and assert A keeps the FULL refreshed set (all MCP tools) AND emits `tools_reselect_skipped`:

```ts
describe('Loop A characterization — reselect read-only keeps full set + skip log (#4)', () => {
  it('on a read-only retry keeps ALL refreshed tools and logs tools_reselect_skipped', async () => {
    const logSteps: Array<{ step: string; data: Record<string, unknown> }> = [];
    const offered: LlmTool[][] = [];
    const llm = makeToolThenStopLlm('SearchClass', (_i, tools) => offered.push(tools));
    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([
        { role: 'system', content: '## Available Tools\n- SearchClass: search' },
        { role: 'user', content: 'search classes' },
      ]),
      ragStores: {
        tools: makeRag([
          { text: 'Tool: UpdateClass', score: 0.9, metadata: { id: 'tool:UpdateClass' } },
        ]),
      },
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                { name: 'SearchClass', description: 'search', inputSchema: { type: 'object' } },
                { name: 'UpdateClass', description: 'update', inputSchema: { type: 'object' } },
              ],
            };
          },
          async callTool() {
            return { ok: true as const, value: { content: 'found 3 results' } };
          },
        },
      ],
    });
    deps.mainLlm = llm;
    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      toolReselectPerIteration: true,
    });
    await agent.process('search classes', {
      sessionId: 'a-readonly',
      sessionLogger: {
        logStep(step: string, data: Record<string, unknown>) {
          logSteps.push({ step, data });
        },
      },
    });

    const skip = logSteps.find((l) => l.step === 'tools_reselect_skipped');
    assert.ok(skip, 'A must log tools_reselect_skipped on read-only retry');
    // Iteration 2 offered the FULL refreshed set (both MCP tools), not a narrowed subset.
    const iter2 = offered[1] ?? [];
    const names = new Set(iter2.map((t) => t.name));
    assert.ok(
      names.has('SearchClass') && names.has('UpdateClass'),
      'A keeps ALL refreshed MCP tools on the read-only retry',
    );
  });
});
```

- [ ] Create `src/pipeline/handlers/__tests__/tool-loop-reselect-readonly.test.ts`. Reuse the `makeCtx` shape from `tool-loop-external.test.ts` (copy its `NoopLogger`, `makeSpan`, ctx literal), but wire: `refreshToolsPerIteration: true`, `toolReselectPerIteration: true`, `mcpClients` whose `listTools` returns **BOTH `SearchClass` AND `UpdateClass`** (the per-iteration REFRESH set — deliberately STRICTLY LARGER than the seed), `activeTools = [SearchClass]` and `toolClientMap` seeded with only `SearchClass` (so `prevSelectedTools`, snapshotted before the refresh, is the single-tool set), and an `llmCallStrategy` that captures per-call tools and returns: call 1 → read-only tool call `SearchClass`; call 2 → stop. **This size gap is what makes the test discriminate:** on a read-only retry B restores `currentTools = prevSelectedTools` (`tool-loop.ts:262`) → iteration 2 must offer EXACTLY `[SearchClass]`; if that restore line were deleted, `currentTools` would remain the refreshed `[SearchClass, UpdateClass]` and the assertion would fail. (If the refresh set were also just `[SearchClass]`, the test would pass with or without the restore — a non-guarding guard.) Assert B narrows back to the single-tool set on iteration 2 AND emits NO `tools_reselect_skipped`:

```ts
// capture tools per call via llmCallStrategy (see tool-loop-external.test.ts makeCtx)
const captured: LlmTool[][] = [];
const logSteps: string[] = [];
// ... build ctx with sessionLogger.logStep(step) => logSteps.push(step)
// activeTools/currentTools seed = [searchTool] (=> prevSelectedTools = [SearchClass]);
// mcpClients.listTools returns [SearchClass, UpdateClass] (refresh set STRICTLY larger),
// so the read-only restore is observable: iter2 must be exactly [SearchClass].
const ok = await new ToolLoopHandler().execute(ctx, {}, makeSpan());
assert.equal(ok, true);
assert.ok(!logSteps.includes('tools_reselect_skipped'), 'B does NOT log skip');
const iter2 = captured[1] ?? [];
assert.deepEqual(
  iter2.map((t) => t.name),
  ['SearchClass'],
  'B restores prevSelectedTools (narrowed subset) on read-only retry',
);
```

- [ ] Run `npm test -w @mcp-abap-adt/llm-agent-libs` — the two new files must be GREEN against current (unmodified) code. This is the baseline.
- [ ] Lint gate on the two new files: `npm run format` → `npx @biomejs/biome check --write packages/llm-agent-libs/src/__tests__/tool-loop-characterization.test.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-reselect-readonly.test.ts` → `npm run lint:check` (exit 0).
- [ ] Commit: `test: characterize tool-loop span structure + reselect read-only (PR-2b guard)`.

---

### Task 1 — `injectToolPriority` + `injectPendingResults` (setup phase) (`refactor:`)

Setup-phase helpers. Spike: tool-priority injection IDENTICAL (A 763–774 / B 127–138); pending-results injection EQUIV-PLUMBING (A 776–793 / B 140–157).

**Files:** `tool-loop-core.ts` (NEW), `agent.ts`, `tool-loop.ts`.

**Interfaces (define at top of `tool-loop-core.ts`):**

```ts
import type {
  CallOptions,
  LlmTool,
  Message,
} from '@mcp-abap-adt/llm-agent';
import type { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';

/** Append the client-tool priority instruction to the system message when
 *  external tools are present. Returns messages unchanged otherwise. */
export function injectToolPriority(
  messages: Message[],
  externalTools: LlmTool[],
): Message[] {
  if (externalTools.length > 0) {
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      const sys = messages[systemIdx];
      const next = [...messages];
      next[systemIdx] = {
        ...sys,
        content: `${sys.content}\n\nIMPORTANT: You have internal tools and client-provided tools (marked [client-provided] in their description). Always prefer internal tools when they can accomplish the task. Use client-provided tools only when no internal tool can do the job.`,
      };
      return next;
    }
  }
  return messages;
}

/** Inject pending internal tool results from a prior mixed-call request. */
export async function injectPendingResults(
  messages: Message[],
  pendingToolResults: PendingToolResultsRegistry,
  sessionId: string,
  options: CallOptions | undefined,
): Promise<Message[]> {
  if (pendingToolResults.has(sessionId)) {
    const pending = await pendingToolResults.consume(sessionId);
    if (pending) {
      const next = [
        ...messages,
        pending.assistantMessage,
        ...pending.results.map((r) => ({
          role: 'tool' as const,
          content: r.text,
          tool_call_id: r.toolCallId,
        })),
      ];
      options?.sessionLogger?.logStep('pending_tool_results_injected', {
        toolNames: pending.results.map((r) => r.toolName),
      });
      return next;
    }
  }
  return messages;
}
```

**Steps:**

- [ ] Create `tool-loop-core.ts` with the header comment, the two imports, and the two functions above (verbatim from the confirmed A/B blocks).
- [ ] Loop A rewrite in `agent.ts`: DELETE lines 763–793 (the tool-priority `if` block + the pending-results `if` block) and replace with:

```ts
messages = injectToolPriority(messages, externalTools);
messages = await injectPendingResults(
  messages,
  this.pendingToolResults,
  sessionId,
  opts,
);
```

Add `import { injectPendingResults, injectToolPriority } from './pipeline/handlers/tool-loop-core.js';` to `agent.ts`.

- [ ] Loop B rewrite in `tool-loop.ts`: DELETE lines 127–157 and replace with:

```ts
messages = injectToolPriority(messages, externalTools);
messages = await injectPendingResults(
  messages,
  ctx.pendingToolResults,
  ctx.sessionId,
  ctx.options,
);
```

Add `import { injectPendingResults, injectToolPriority } from './tool-loop-core.js';` to `tool-loop.ts`.

- [ ] Remove any import made dead by the deletions (none expected here; `noUnusedLocals` will flag if so).
- [ ] `npm test -w @mcp-abap-adt/llm-agent-libs` — full suite GREEN.
- [ ] Lint gate on `tool-loop-core.ts`, `agent.ts`, `tool-loop.ts` (format → biome check --write → `lint:check` exit 0). `wc -l tool-loop-core.ts` < 500.
- [ ] Commit: `refactor: extract injectToolPriority + injectPendingResults to tool-loop-core`.

---

### Task 2 — `filterAvailableTools` (`refactor:`)

Availability filter. Spike: IDENTICAL (A 968–978 / B 348–358).

**Files:** `tool-loop-core.ts`, `agent.ts`, `tool-loop.ts`.

**Interface (append to `tool-loop-core.ts`):**

```ts
import type { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';

/** Filter out session-blocked tools; log the blocked set when non-empty.
 *  Returns the allowed subset. */
export function filterAvailableTools(
  registry: ToolAvailabilityRegistry,
  sessionId: string,
  currentTools: LlmTool[],
  iteration: number,
  options: CallOptions | undefined,
): LlmTool[] {
  const filtered = registry.filterTools(sessionId, currentTools);
  if (filtered.blocked.length > 0) {
    options?.sessionLogger?.logStep('active_tools_filtered_in_iteration', {
      iteration: iteration + 1,
      blocked: filtered.blocked,
    });
  }
  return filtered.allowed;
}
```

**Steps:**

- [ ] Append the `ToolAvailabilityRegistry` import and `filterAvailableTools` to `tool-loop-core.ts`.
- [ ] Loop A rewrite (`agent.ts` 968–978): replace the `filterTools` block with:

```ts
currentTools = filterAvailableTools(
  this.toolAvailabilityRegistry,
  sessionId,
  currentTools,
  iteration,
  opts,
);
```

- [ ] Loop B rewrite (`tool-loop.ts` 348–358): replace with:

```ts
currentTools = filterAvailableTools(
  ctx.toolAvailabilityRegistry,
  ctx.sessionId,
  currentTools,
  iteration,
  ctx.options,
);
```

- [ ] Extend the existing `tool-loop-core.js` import statements in both files to include `filterAvailableTools`.
- [ ] `npm test -w @mcp-abap-adt/llm-agent-libs` — GREEN. Lint gate (exit 0). `wc -l` < 500.
- [ ] Commit: `refactor: extract filterAvailableTools to tool-loop-core`.

---

### Task 3 — `classifyToolCalls` (`refactor:`)

Internal / external / blocked / hallucinated split. Spike: IDENTICAL (A 1181–1197 / B 593–610).

**Files:** `tool-loop-core.ts`, `agent.ts`, `tool-loop.ts`.

**Interface (append):**

```ts
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';

export type ParsedToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export interface IClassifiedToolCalls {
  internalCalls: ParsedToolCall[];
  validExternalCalls: ParsedToolCall[];
  blockedCalls: ParsedToolCall[];
  hallucinations: ParsedToolCall[];
}

/** Partition tool calls into internal / valid-external / blocked / hallucinated. */
export function classifyToolCalls(
  toolCalls: ParsedToolCall[],
  toolClientMap: Map<string, IMcpClient>,
  externalToolNames: Set<string>,
  toolAvailabilityRegistry: ToolAvailabilityRegistry,
  sessionId: string,
): IClassifiedToolCalls {
  const internalCalls = toolCalls.filter((tc) => toolClientMap.has(tc.name));
  const validExternalCalls = toolCalls.filter((tc) =>
    externalToolNames.has(tc.name),
  );
  const blockedToolNames =
    toolAvailabilityRegistry.getBlockedToolNames(sessionId);
  const blockedCalls = toolCalls.filter((tc) => blockedToolNames.has(tc.name));
  const hallucinations = toolCalls.filter(
    (tc) =>
      !blockedToolNames.has(tc.name) &&
      !toolClientMap.has(tc.name) &&
      !externalToolNames.has(tc.name),
  );
  return { internalCalls, validExternalCalls, blockedCalls, hallucinations };
}
```

**Steps:**

- [ ] Append `IMcpClient` to the `@mcp-abap-adt/llm-agent` import, and add `ParsedToolCall`, `IClassifiedToolCalls`, `classifyToolCalls` to `tool-loop-core.ts`. (`ParsedToolCall` is shared by Task 4/5 too.)
- [ ] Loop A rewrite (`agent.ts` 1181–1197): replace the four `const internalCalls/validExternalCalls/blockedToolNames/blockedCalls/hallucinations` declarations with:

```ts
const { internalCalls, validExternalCalls, blockedCalls, hallucinations } =
  classifyToolCalls(
    toolCalls,
    toolClientMap,
    externalToolNames,
    this.toolAvailabilityRegistry,
    sessionId,
  );
```

- [ ] Loop B rewrite (`tool-loop.ts` 593–610): replace with:

```ts
const { internalCalls, validExternalCalls, blockedCalls, hallucinations } =
  classifyToolCalls(
    toolCalls,
    ctx.toolClientMap,
    externalToolNames,
    ctx.toolAvailabilityRegistry,
    ctx.sessionId,
  );
```

- [ ] Extend the `tool-loop-core.js` import in both files with `classifyToolCalls`. Verify `toolCalls` local type in both loops matches `ParsedToolCall[]` (both build `toolCalls` as `{ id, name, arguments: Record<string, unknown> }[]` from the stream accumulator — confirm by reading the `toolCalls` construction just above each classify block; if the inferred element type is structurally identical, pass through directly).
- [ ] `npm test -w @mcp-abap-adt/llm-agent-libs` — GREEN. Lint gate (exit 0). `wc -l` < 500.
- [ ] Commit: `refactor: extract classifyToolCalls to tool-loop-core`.

---

### Task 4 — `buildBlockedToolMessages` + `buildHallucinatedToolMessages` (`refactor:`)

Blocked/hallucinated message synthesis. Spike: both IDENTICAL (blocked A 1198–1228 / B 613–643; hallucinated A 1229–1256 / B 645–673). Note: the blocked assistant message carries `blockedCalls` as `tool_calls`; the hallucinated assistant message carries ALL `toolCalls`, then iterates `hallucinations` for the tool errors. Blocked logs `blocked_tool_calls_intercepted`; hallucinated logs nothing.

**Files:** `tool-loop-core.ts`, `agent.ts`, `tool-loop.ts`.

**Interface (append):**

```ts
/** Append an assistant(tool_calls=blocked) + per-blocked tool-error messages;
 *  log the interception. Returns the extended messages. */
export function buildBlockedToolMessages(
  messages: Message[],
  content: string,
  blockedCalls: ParsedToolCall[],
  options: CallOptions | undefined,
): Message[] {
  let next: Message[] = [
    ...messages,
    {
      role: 'assistant' as const,
      content: content || null,
      tool_calls: blockedCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    },
  ];
  for (const blocked of blockedCalls) {
    next = [
      ...next,
      {
        role: 'tool' as const,
        content: `Error: Tool "${blocked.name}" is temporarily unavailable in this session.`,
        tool_call_id: blocked.id,
      },
    ];
  }
  options?.sessionLogger?.logStep('blocked_tool_calls_intercepted', {
    toolNames: blockedCalls.map((tc) => tc.name),
  });
  return next;
}

/** Append an assistant(tool_calls=ALL calls) + per-hallucination "not found"
 *  tool messages. Returns the extended messages. */
export function buildHallucinatedToolMessages(
  messages: Message[],
  content: string,
  toolCalls: ParsedToolCall[],
  hallucinations: ParsedToolCall[],
): Message[] {
  let next: Message[] = [
    ...messages,
    {
      role: 'assistant' as const,
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    },
  ];
  for (const h of hallucinations) {
    next = [
      ...next,
      {
        role: 'tool' as const,
        content: `Error: Tool "${h.name}" not found.`,
        tool_call_id: h.id,
      },
    ];
  }
  return next;
}
```

**Steps:**

- [ ] Append both functions to `tool-loop-core.ts`.
- [ ] Loop A rewrite (`agent.ts` 1198–1256): replace the `if (blockedCalls.length > 0) { … continue; }` body's message-building + log with `messages = buildBlockedToolMessages(messages, content, blockedCalls, opts);` (keep the `if` guard and `continue;`). Replace the `if (hallucinations.length > 0) { … continue; }` body with `messages = buildHallucinatedToolMessages(messages, content, toolCalls, hallucinations);` (keep guard + `continue;`).
- [ ] Loop B rewrite (`tool-loop.ts` 613–673): identical replacement using `ctx.options` for the blocked helper. Blocked → `messages = buildBlockedToolMessages(messages, content, blockedCalls, ctx.options);`; hallucinated → `messages = buildHallucinatedToolMessages(messages, content, toolCalls, hallucinations);`.
- [ ] Extend the `tool-loop-core.js` import in both files with the two builders.
- [ ] `npm test -w @mcp-abap-adt/llm-agent-libs` — GREEN. Lint gate (exit 0). `wc -l` < 500.
- [ ] Commit: `refactor: extract buildBlocked/HallucinatedToolMessages to tool-loop-core`.

---

### Task 5 — `executeToolBatchWithHeartbeat` (`refactor:`)

Concurrent exec + heartbeat race + cache + `classifyToolResult` escalation + blacklist. Spike: EQUIV-PLUMBING (A 1354–1496 / B 844–1000). B additionally records the per-tool `cached` flag and calls `ctx.requestLogger.logToolCall` per executed tool (spike #14, B 989–999) which A lacks — the helper carries `cached` on its result type (harmless for A) and takes an **OPTIONAL `onToolExecuted?` callback** that B passes (its `logToolCall`) and A omits. Behavior-preserving.

This helper is an **async generator**: it `yield`s heartbeat chunks (and the escalation error chunk) and *returns* a `BatchOutcome`. Loop A consumes via `yield*`; Loop B drains manually.

**Files:** `tool-loop-core.ts`, `agent.ts`, `tool-loop.ts`.

**Interface (append):**

```ts
import type {
  IToolCache,
  LlmStreamChunk,
  Result,
  TimingEntry,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import type { ISpan, ITracer } from '../../tracer/types.js';
import type { IMetrics } from '../../metrics/types.js';
import { classifyToolResult } from './escalate-if-unavailable.js';
import { isToolContextUnavailableError } from '../../policy/tool-availability-registry.js';

export type ToolExecResult = {
  tc: ParsedToolCall;
  text: string;
  res: Result<
    { content: string | Record<string, unknown>; isError?: boolean },
    { message: string }
  > | null;
  duration: number;
  cached: boolean;
};

export type BatchOutcome =
  | { escalated: true }
  | {
      escalated: false;
      currentTools: LlmTool[];
      toolCallCount: number;
      toolMessages: Message[];
    };

export interface IExecuteToolBatchArgs {
  batch: ParsedToolCall[];
  toolClientMap: Map<string, IMcpClient>;
  toolCache: IToolCache;
  tracer: ITracer;
  metrics: IMetrics;
  parentSpan: ISpan; // toolLoopSpan (A) / parentSpan (B)
  toolAvailabilityRegistry: ToolAvailabilityRegistry;
  sessionId: string;
  externalToolNames: Set<string>;
  currentTools: LlmTool[];
  toolCallCount: number;
  timingLog: TimingEntry[]; // pushed into (per-tool timing)
  heartbeatMs: number;
  options: CallOptions | undefined;
  onToolExecuted?: (r: ToolExecResult) => void; // B: logToolCall; A: omitted
}

/** Execute a batch of internal tool calls concurrently, yielding heartbeat
 *  chunks while they run; on an MCP-availability escalation yield an error
 *  chunk and return `{ escalated: true }`; otherwise return the updated
 *  currentTools / toolCallCount / tool messages. */
export async function* executeToolBatchWithHeartbeat(
  args: IExecuteToolBatchArgs,
): AsyncGenerator<Result<LlmStreamChunk, OrchestratorError>, BatchOutcome> {
  const {
    batch,
    toolClientMap,
    toolCache,
    tracer,
    metrics,
    parentSpan,
    toolAvailabilityRegistry,
    sessionId,
    externalToolNames,
    timingLog,
    heartbeatMs,
    options,
    onToolExecuted,
  } = args;
  let currentTools = args.currentTools;
  let toolCallCount = args.toolCallCount;

  const toolExecPromises = batch.map(async (tc): Promise<ToolExecResult> => {
    const toolStart = Date.now();
    options?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
      arguments: tc.arguments,
    });
    const client = toolClientMap.get(tc.name);
    if (!client) return { tc, text: '', res: null, duration: 0, cached: false };
    const toolSpan = tracer.startSpan('smart_agent.tool_call', {
      parent: parentSpan,
      attributes: { 'tool.name': tc.name },
    });
    const cachedValue = toolCache.get(tc.name, tc.arguments);
    const wasCached = !!cachedValue;
    const res = cachedValue
      ? (() => {
          metrics.toolCacheHitCount.add();
          toolSpan.setAttribute('cache', 'hit');
          return { ok: true as const, value: cachedValue };
        })()
      : await (async () => {
          const r = await client.callTool(tc.name, tc.arguments, options);
          if (r.ok) toolCache.set(tc.name, tc.arguments, r.value);
          return r;
        })();
    const text = !res.ok
      ? res.error.message
      : typeof res.value.content === 'string'
        ? res.value.content
        : JSON.stringify(res.value.content);
    toolSpan.setStatus(res.ok ? 'ok' : 'error', res.ok ? undefined : text);
    toolSpan.end();
    return { tc, text, res, duration: Date.now() - toolStart, cached: wasCached };
  });

  const allDone = Promise.all(toolExecPromises);
  const pendingTools = new Set(batch.map((tc) => tc.name));
  const toolStartTime = Date.now();
  let results: ToolExecResult[] = [];
  let settled = false;

  for (const [i, p] of toolExecPromises.entries()) {
    p.then(() => pendingTools.delete(batch[i].name));
  }

  while (!settled) {
    const winner = await Promise.race([
      allDone.then((r) => ({ tag: 'done' as const, results: r })),
      new Promise<{ tag: 'tick' }>((resolve) =>
        setTimeout(() => resolve({ tag: 'tick' }), heartbeatMs),
      ),
    ]);
    if (winner.tag === 'done') {
      results = winner.results;
      settled = true;
    } else {
      for (const tool of pendingTools) {
        yield {
          ok: true,
          value: {
            content: '',
            heartbeat: { tool, elapsed: Date.now() - toolStartTime },
          },
        };
      }
    }
  }

  for (const r of results) {
    timingLog.push({ phase: `tool_${r.tc.name}`, duration: r.duration });
  }

  const toolMessages: Message[] = [];
  for (const r of results) {
    const { tc, text, res } = r;
    if (!res) continue;
    // FAIL LOUD on an MCP availability failure — yield an error chunk (→ the
    // caller returns ok:false) instead of feeding "MCP error" to the LLM.
    const decision = classifyToolResult(res);
    if (decision.escalate) {
      yield {
        ok: false,
        error: new OrchestratorError(decision.escalate.message, 'MCP_UNAVAILABLE'),
      };
      return { escalated: true };
    }
    if (
      !res.ok &&
      isToolContextUnavailableError(text) &&
      !externalToolNames.has(tc.name)
    ) {
      const entry = toolAvailabilityRegistry.block(sessionId, tc.name, text);
      currentTools = currentTools.filter((t) => t.name !== tc.name);
      options?.sessionLogger?.logStep(`tool_blacklisted_${tc.name}`, {
        reason: text,
        blockedUntil: entry.blockedUntil,
      });
    }
    options?.sessionLogger?.logStep(`mcp_result_${tc.name}`, { result: text });
    toolCallCount++;
    metrics.toolCallCount.add();
    toolMessages.push({
      role: 'tool' as const,
      content: text,
      tool_call_id: tc.id,
    });
    onToolExecuted?.(r);
  }
  return { escalated: false, currentTools, toolCallCount, toolMessages };
}
```

**Steps:**

- [ ] Append the imports + `ToolExecResult` + `BatchOutcome` + `IExecuteToolBatchArgs` + `executeToolBatchWithHeartbeat` to `tool-loop-core.ts`. `OrchestratorError`, `classifyToolResult`, `isToolContextUnavailableError` are now *used* in the core module — add them as real (value) imports.
- [ ] Loop A rewrite (`agent.ts` 1354–1496): DELETE the local `type ToolExecResult`, the `toolExecPromises` map, the heartbeat race, the timing collection, and the result-processing loop through `messages = [...messages, ...toolMessages];` — but KEEP the pre-batch progress-message loop (1344–1352) and `const heartbeatMs = this.config.heartbeatIntervalMs ?? 5000;` (1341) as-is (per-caller). Replace the deleted region with:

```ts
const outcome = yield* executeToolBatchWithHeartbeat({
  batch,
  toolClientMap,
  toolCache: this.toolCache,
  tracer: this.tracer,
  metrics: this.metrics,
  parentSpan: toolLoopSpan,
  toolAvailabilityRegistry: this.toolAvailabilityRegistry,
  sessionId,
  externalToolNames,
  currentTools,
  toolCallCount,
  timingLog,
  heartbeatMs,
  options: opts,
});
if (outcome.escalated) return;
currentTools = outcome.currentTools;
toolCallCount = outcome.toolCallCount;
messages = [...messages, ...outcome.toolMessages];
```

(Confirm A's escalation branch previously did `yield {ok:false…}; return;` with NO `toolLoopSpan.end()` — the helper preserves this: it yields the error and the caller `return`s without ending the span, exactly as before.)

- [ ] Loop B rewrite (`tool-loop.ts` 844–1000): DELETE the local `type ToolExecResult` (with `cached`), the `toolExecPromises` map, the heartbeat race, the timing collection, and the result-processing loop through `messages = [...messages, ...toolMessages];`. `heartbeatMs` is already computed at the top of `execute` (108–111) — keep it. Replace the deleted region with the manual drain:

```ts
const batchGen = executeToolBatchWithHeartbeat({
  batch,
  toolClientMap: ctx.toolClientMap,
  toolCache: ctx.toolCache,
  tracer: ctx.tracer,
  metrics: ctx.metrics,
  parentSpan,
  toolAvailabilityRegistry: ctx.toolAvailabilityRegistry,
  sessionId: ctx.sessionId,
  externalToolNames,
  currentTools,
  toolCallCount,
  timingLog,
  heartbeatMs,
  options: ctx.options,
  onToolExecuted: (r) =>
    ctx.requestLogger.logToolCall({
      // Stamp requestId so tool executions land in the per-traceId delta
      // bucket — without it, getSummary(traceId).toolCalls stays 0.
      requestId: ctx.options?.trace?.traceId,
      toolName: r.tc.name,
      success: !!r.res?.ok,
      durationMs: r.duration,
      cached: r.cached,
    }),
});
let step = await batchGen.next();
while (!step.done) {
  ctx.yield(step.value);
  step = await batchGen.next();
}
const outcome = step.value;
if (outcome.escalated) return false;
currentTools = outcome.currentTools;
toolCallCount = outcome.toolCallCount;
messages = [...messages, ...outcome.toolMessages];
```

- [ ] Extend the `tool-loop-core.js` import in both files with `executeToolBatchWithHeartbeat`. Remove now-dead imports in each caller if the deletion orphaned any (`classifyToolResult`, `isToolContextUnavailableError`, `OrchestratorError` may still be used elsewhere in `agent.ts`/`tool-loop.ts` — verify with grep before removing; `noUnusedLocals` will flag genuine orphans).
- [ ] `npm test -w @mcp-abap-adt/llm-agent-libs` — GREEN. Pay special attention to `traceid-stamping.test.ts` (per-tool `logToolCall` still fires via `onToolExecuted`), `tool-loop-usage-accumulation.test.ts`, `agent-mcp-unavailable-escalates.test.ts` / `tool-loop-mcp-unavailable.test.ts` (escalation path), and `parallel-mixed-tool-calls.test.ts` (heartbeat/concurrent exec).
- [ ] Lint gate (exit 0). `wc -l tool-loop-core.ts` < 500 (expected ~300–340).
- [ ] Commit: `refactor: extract executeToolBatchWithHeartbeat to tool-loop-core`.

---

### Task 6 — `runOutputValidationReprompt` (`refactor:`)

No-tool-call output-validation + reprompt. Spike: IDENTICAL (A 1118–1137 / B 545–563). The surrounding guard `if (finishReason !== 'tool_calls' || toolCalls.length === 0)` and everything AFTER the reprompt (final-response assembly — DIVERGENT) stay per-caller.

**Files:** `tool-loop-core.ts`, `agent.ts`, `tool-loop.ts`.

**Interface (append):**

```ts
import type { IOutputValidator } from '../../validator/types.js';

export interface IReprompt {
  reprompt: boolean;
  messages: Message[];
}

/** Validate the no-tool-call output; on invalid, append the assistant reply +
 *  a correction user message and signal a reprompt. Otherwise pass through. */
export async function runOutputValidationReprompt(
  outputValidator: IOutputValidator,
  content: string,
  messages: Message[],
  currentTools: LlmTool[],
  options: CallOptions | undefined,
): Promise<IReprompt> {
  const valResult = await outputValidator.validate(
    content,
    { messages, tools: currentTools },
    options,
  );
  if (valResult.ok && !valResult.value.valid) {
    const correction =
      valResult.value.correctedContent ?? valResult.value.reason;
    return {
      reprompt: true,
      messages: [
        ...messages,
        { role: 'assistant' as const, content },
        {
          role: 'user' as const,
          content: `Your previous response was rejected by validation: ${correction}. Please try again.`,
        },
      ],
    };
  }
  return { reprompt: false, messages };
}
```

**Steps:**

- [ ] Append `IOutputValidator` import + `IReprompt` + `runOutputValidationReprompt` to `tool-loop-core.ts`.
- [ ] Loop A rewrite (`agent.ts` 1119–1137): inside the existing `if (finishReason !== 'tool_calls' || toolCalls.length === 0) {` guard, replace the `outputValidator.validate(...)` call and the `if (valResult.ok && !valResult.value.valid) { … continue; }` block with:

```ts
const val = await runOutputValidationReprompt(
  this.outputValidator,
  content,
  messages,
  currentTools,
  opts,
);
if (val.reprompt) {
  messages = val.messages;
  continue;
}
```

Leave lines 1138+ (`opts?.sessionLogger?.logStep('final_response', …)`, `onBeforeStream`, clientAdapter wrap, `summaryToUsage` terminal chunk) UNCHANGED — DIVERGENT band.

- [ ] Loop B rewrite (`tool-loop.ts` 546–563): inside its guard, replace the validate + invalid-reprompt block with:

```ts
const val = await runOutputValidationReprompt(
  ctx.outputValidator,
  content,
  messages,
  currentTools,
  ctx.options,
);
if (val.reprompt) {
  messages = val.messages;
  continue;
}
```

Leave B's lines 564+ (final_response log with `byComponent/byModel/byCategory`, local-`usage` terminal chunk with `components`/`categories`) UNCHANGED — DIVERGENT band.

- [ ] Extend the `tool-loop-core.js` import in both files with `runOutputValidationReprompt`. Remove any orphaned import.
- [ ] `npm test -w @mcp-abap-adt/llm-agent-libs` — GREEN. Watch `streaming.test.ts`, `on-before-stream.test.ts` (A final-response divergent band untouched) and `tool-loop-stream.test.ts` / `tool-loop-usage-accumulation.test.ts` (B divergent band untouched).
- [ ] Lint gate (exit 0). `wc -l tool-loop-core.ts` < 500. Confirm both `agent.ts` and `tool-loop.ts` are smaller than at Task 0 baseline (`git diff --stat`).
- [ ] Commit: `refactor: extract runOutputValidationReprompt to tool-loop-core`.

---

## Done criteria

- 7 commits on `refactor/tool-loop-core`: 1 `test:` guard + 6 `refactor:` helpers.
- `tool-loop-core.ts` holds 8 helpers (`injectToolPriority`, `injectPendingResults`, `filterAvailableTools`, `classifyToolCalls`, `buildBlockedToolMessages`, `buildHallucinatedToolMessages`, `executeToolBatchWithHeartbeat`, `runOutputValidationReprompt`) + shared types (`ParsedToolCall`, `IClassifiedToolCalls`, `ToolExecResult`, `BatchOutcome`, `IExecuteToolBatchArgs`, `IReprompt`); `wc -l` < 500; not on any barrel.
- Both loops delegate; the duplicated blocks are deleted from both; the 4 DIVERGENT bands remain per-caller and untouched.
- Full `npm test -w @mcp-abap-adt/llm-agent-libs` GREEN at every commit; lint `lint:check` exit 0.
- Do NOT commit this plan file.
