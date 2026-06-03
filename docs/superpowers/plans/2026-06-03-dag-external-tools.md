# DAG external (client-provided) tools — Implementation Plan (#171)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make client-provided external (consumer-executed) tools work under the DAG coordinator: always offered (mode-independent), surfaced as standard `tool_calls`, with deterministic content-addressed ids and protocol-safe stateless resume.

**Architecture:** Implements the spec `docs/superpowers/specs/2026-06-03-dag-external-tools.md` (D1–D4 + review #2–#5). No new transport — standard OpenAI/Anthropic multi-turn. Parallel executors' external calls are collected FIFO into one terminal assistant turn; resume is stateless (content-addressed `extId` + session-knowledge short-circuit); incoming external history is consumed into a validated map and stripped from internal LLM message lists.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Biome, `node --import tsx/esm --test`, lockstep workspace build.

**Read first:** the spec (above). Every design rationale lives there; this plan is the task breakdown.

---

## File structure

- `packages/llm-agent/src/artifact-identity.ts` — ADD `deepStableArgsKey`, `shortHash`, `externalToolCallId`. (contracts)
- `packages/llm-agent/src/interfaces/subagent.ts` — `ISubAgentResult.status` + `pendingExternalToolCalls`.
- `packages/llm-agent/src/interfaces/interpreter.ts` — `NodeResult.status += 'awaiting-external'`; `InterpretResult.pendingExternalToolCalls`.
- `packages/llm-agent/src/external-results.ts` — CREATE `buildExternalResults(messages)` (validated map + sanitized messages). (contracts — pure, reusable by flat + DAG)
- `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` — external surfacing (drop hard-mode external drop; extId rewrite; map lookup; awaiting-external).
- `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts` — collect `pendingExternalToolCalls` FIFO; collect-all-at-settle barrier.
- `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` — no-finalizer branch: emit terminal turn with collected calls.
- `packages/llm-agent-libs/src/coordinator/dag/<planner>` — route a "call external X" objective to a node (#171 obs 2c).
- `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — build externalResults from incoming history at the coordinator boundary; thread the validated map + sanitized messages down.
- Docs: `docs/ARCHITECTURE.md` (D4 `hard` reconciliation), `docs/INTEGRATION.md`, `scripts/integration/dag-coordinator-mcp/`.

---

### Task 1: deterministic external tool-call id helpers (contracts)

**Files:** `packages/llm-agent/src/artifact-identity.ts`; test `packages/llm-agent/src/__tests__/external-tool-id.test.ts`.

- [ ] **Step 1 — failing tests** (encode the spec's required tests D1 + review#3/#4):
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepStableArgsKey, externalToolCallId } from '../artifact-identity.js';

test('deepStableArgsKey: nested key order is canonical (same key)', () => {
  assert.equal(deepStableArgsKey({ filter: { a: 1, b: 2 } }), deepStableArgsKey({ filter: { b: 2, a: 1 } }));
});
test('deepStableArgsKey: arrays preserve order (different key)', () => {
  assert.notEqual(deepStableArgsKey({ x: [1, 2] }), deepStableArgsKey({ x: [2, 1] }));
});
test('externalToolCallId: case-distinct args → distinct id', () => {
  assert.notEqual(externalToolCallId('rag_add', { content: 'Hello' }), externalToolCallId('rag_add', { content: 'hello' }));
});
test('externalToolCallId: same tool+args → same id; shape ext:<16hex>', () => {
  const id = externalToolCallId('rag_add', { collection: 'context', content: 'x' });
  assert.equal(id, externalToolCallId('rag_add', { collection: 'context', content: 'x' }));
  assert.match(id, /^ext:[0-9a-f]{16}$/);
});
```
- [ ] **Step 2 — run → FAIL** `cd packages/llm-agent && node --import tsx/esm --test src/__tests__/external-tool-id.test.ts`.
- [ ] **Step 3 — implement** in `artifact-identity.ts` (leave `stableArgsKey`/`artifactIdentityKey` untouched):
```ts
import { createHash } from 'node:crypto';

/** DEEP canonical JSON: recursively sort object keys at every depth; arrays keep
 *  order; case-PRESERVING. Used for external tool-call identity (NOT lowercased). */
export function deepStableArgsKey(args: unknown): string {
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canon(o[k]);
    return out;
  };
  return JSON.stringify(canon(args));
}

/** First 16 hex chars of sha256. */
export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Deterministic, content-addressed id for a client-provided external tool call
 *  (spec D1). NUL separator avoids toolName/args boundary collisions. */
export function externalToolCallId(toolName: string, args: unknown): string {
  return `ext:${shortHash(`${toolName} ${deepStableArgsKey(args)}`)}`;
}
```
- [ ] **Step 4 — run → PASS**; **Step 5 — build** `npx tsc -b packages/llm-agent`; **Step 6 — biome + commit** `feat(contracts): deterministic content-addressed external tool-call id (#171)`.

---

### Task 2: typed awaiting-external contract (contracts)

**Files:** `interfaces/subagent.ts`, `interfaces/interpreter.ts`; test `packages/llm-agent/src/interfaces/__tests__/awaiting-external.test.ts`.

- [ ] **Step 1 — failing test** (type-level + value): a `NodeResult` with `status:'awaiting-external'` and an `InterpretResult.pendingExternalToolCalls` array compile and round-trip.
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InterpretResult, NodeResult } from '../interpreter.js';
import type { ISubAgentResult } from '../subagent.js';

test('awaiting-external types compile', () => {
  const nr: NodeResult = { nodeId: 'n0', output: '', status: 'awaiting-external', durationMs: 0 };
  const r: ISubAgentResult = { output: '', status: 'awaiting-external', pendingExternalToolCalls: [{ id: 'ext:0123456789abcdef', name: 'rag_add', arguments: {} }] };
  const ir: InterpretResult = { nodeResults: { n0: nr }, ok: true, output: '', executionOrder: ['n0'], pendingExternalToolCalls: r.pendingExternalToolCalls };
  assert.equal(ir.pendingExternalToolCalls?.length, 1);
});
```
- [ ] **Step 2 — run → FAIL** (`status`/`pendingExternalToolCalls` not on the types yet).
- [ ] **Step 3 — implement:**
  - `subagent.ts` `ISubAgentResult`: add `status?: 'complete' | 'awaiting-external';` and `pendingExternalToolCalls?: LlmToolCall[];` (import `LlmToolCall` if not already).
  - `interpreter.ts` `NodeResult.status`: extend union to `'done' | 'failed' | 'skipped' | 'awaiting-external'`.
  - `interpreter.ts` `InterpretResult`: add `pendingExternalToolCalls?: LlmToolCall[];`.
- [ ] **Step 4 — run → PASS**; **Step 5 — build** `npx tsc -b packages/llm-agent`; **Step 6 — commit** `feat(contracts): typed awaiting-external path for external tool calls (#171)`.

---

### Task 3: validated externalResults map + history sanitization (contracts)

**Files:** CREATE `packages/llm-agent/src/external-results.ts`; export from `src/index.ts`; test `src/__tests__/external-results.test.ts`.

Implements spec D1 adjacency validation + review#5 sanitization. Pure function over the request message list.

- [ ] **Step 1 — failing tests** (the spec's required tests):
```ts
// adjacency: result accepted only if it immediately follows the declaring assistant turn
// reject: orphan / non-adjacent / unknown-id results
// partial set: assistant declares two ext:* ids, history has ONE adjacent result →
//   map has that one; sanitizedMessages contains NO assistant tool_calls/tool turns
//   (so no provider-facing list has an unmatched tool_calls)
```
Write 4 concrete `node:test` cases asserting: (a) adjacent result → in map; (b) orphan result → rejected; (c) partial set → 1 in map + `sanitizedMessages` has zero `role:'tool'` and zero assistant-with-tool_calls messages; (d) Anthropic shape (tool_result first in a user turn immediately after the tool_use turn) → accepted.
- [ ] **Step 2 — run → FAIL**.
- [ ] **Step 3 — implement** `buildExternalResults(messages, opts?): { results: Map<string, string>; sanitizedMessages: Message[] }`:
  - Walk `messages`; identify assistant turns whose `tool_calls` ids match `/^ext:/`.
  - Accept a following `role:'tool'` (OpenAI) or `tool_result` block in the next `user` turn (Anthropic) ONLY if it immediately follows the declaring assistant turn and its id is declared there → `results.set(id, content)`.
  - `sanitizedMessages` = `messages` with EVERY external-`assistant(tool_calls)` turn and its paired `tool`/`tool_result` turn REMOVED (so internal LLM calls never see an unmatched `tool_calls`). Non-external messages pass through unchanged.
  - Reject (do not add) any `ext:` tool result that is orphan/non-adjacent.
- [ ] **Step 4 — run → PASS**; **Step 5 — build**; **Step 6 — commit** `feat(contracts): buildExternalResults — validated map + history sanitization (#171)`.

---

### Task 4: tool-loop surfaces external tool calls (libs)

**Files:** `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts`; test `.../__tests__/tool-loop-external.test.ts`.

- [ ] **Step 1 — failing tests:**
  - hard mode now KEEPS external tools (`externalTools` length unchanged when `mode:'hard'`).
  - an external tool_call is NOT executed server-side; the node ends with `status:'awaiting-external'` + `pendingExternalToolCalls` carrying the `extId`-rewritten call.
  - when `externalResults` has the `extId` → the result is injected as a tool message and the loop CONTINUES (no awaiting-external).
- [ ] **Step 2 — run → FAIL**.
- [ ] **Step 3 — implement:**
  - line ~112: `const externalTools = ctx.externalTools;` (drop the `mode==='hard' ? []`).
  - Thread `ctx.externalResults?: Map<string,string>` (added in Task 6 to the pipeline context; for the unit test, inject via the test ctx).
  - When the streamed assistant turn contains a tool_call whose name ∈ `externalToolNames`: compute `extId = externalToolCallId(name, args)`; if `externalResults?.has(extId)` → push a `role:'tool'` message with that content + the `extId` id and CONTINUE the loop; else → set `status:'awaiting-external'`, push the call (id rewritten to `extId`) into `pendingExternalToolCalls`, and END the worker turn (do NOT loop, do NOT execute).
  - Keep the existing internal-tool path unchanged.
- [ ] **Step 4 — run → PASS**; **Step 5 — build** `npx tsc -b packages/llm-agent packages/llm-agent-libs`; **Step 6 — commit** `feat(libs): tool-loop surfaces external tool calls with deterministic ids (#171)`.

---

### Task 5: DAG interpreter collects pending external calls (collect-all-at-settle) (libs)

**Files:** `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`; test `.../__tests__/dag-interpreter-external.test.ts`.

- [ ] **Step 1 — failing test:** two parallel nodes both reach `awaiting-external` (stubbed workers) → `InterpretResult.pendingExternalToolCalls` contains BOTH calls in FIFO (plan/topo) order; a mix of (one done, one awaiting-external) → result carries the one pending call and the done node's artefact is recorded. The interpreter does NOT emit until ALL scheduled parallel nodes settle.
- [ ] **Step 2 — run → FAIL**.
- [ ] **Step 3 — implement:** when a node's `ISubAgentResult.status==='awaiting-external'`, record the node `status:'awaiting-external'` and append its `pendingExternalToolCalls` to an interpreter-level FIFO accumulator (ordered by plan/topo index, dedup by `extId`). Settle the whole current parallel wave before returning; surface the accumulator as `InterpretResult.pendingExternalToolCalls`.
- [ ] **Step 4 — PASS**; **Step 5 — build**; **Step 6 — commit** `feat(libs): DAG interpreter collects pending external tool calls (collect-all-at-settle) (#171)`.

---

### Task 6: coordinator no-finalizer branch + externalResults threading (libs + server-libs)

**Files:** `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`; pipeline context type (`packages/llm-agent-libs/src/pipeline/context.ts`); `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`; test `.../__tests__/dag-coordinator-external.test.ts`.

- [ ] **Step 1 — failing test:** when `InterpretResult.pendingExternalToolCalls` is non-empty, the coordinator yields a terminal assistant turn carrying those calls with `finishReason:'tool_calls'` and does NOT invoke the finalizer; when empty, the finalizer runs as today.
- [ ] **Step 2 — run → FAIL**.
- [ ] **Step 3 — implement:**
  - Add `externalResults?: Map<string,string>` to `PipelineContext` (threaded to the interpreter/workers).
  - In `dag-coordinator.ts`, after `interpreter.interpret(...)`: if `result.pendingExternalToolCalls?.length` → `ctx.yield` an assistant chunk with `toolCalls` = the collected calls + a terminal chunk with `finishReason:'tool_calls'`; RETURN without calling `this.finalizer.finalize(...)`. Else → existing finalizer path.
  - In `smart-server.ts` chat handler: `const { results, sanitizedMessages } = buildExternalResults(normalizedMessages);` set `ctx.externalResults = results` and pass `sanitizedMessages` (not raw) into the agent so internal LLM calls never see unmatched tool_calls (review#5).
- [ ] **Step 4 — PASS**; **Step 5 — build** all 4 packages; **Step 6 — commit** `feat: DAG coordinator emits collected external tool_calls (no-finalizer) + externalResults threading (#171)`.

---

### Task 7: planner routes a bare external-tool objective to a node (#171 obs 2c) (libs)

**Files:** the DAG planner (`grep -rn "class .*Planner" packages/llm-agent-libs/src/coordinator`); test alongside it.

- [ ] **Step 1 — failing test:** a prompt that is purely "call external tool X with args Y" yields a plan with at least one node (not empty) that a worker can run to emit the external call.
- [ ] **Step 2 → FAIL**; **Step 3 — implement** the minimal planner change (allow an external-tool action to map to a node; do not require an MCP-tool match); **Step 4 → PASS**; **Step 5 — build**; **Step 6 — commit** `fix(libs): planner routes bare external-tool requests to a node (#171)`.

---

### Task 8: docs + integration (D4)

**Files:** `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`, `scripts/integration/dag-coordinator-mcp/`, `packages/llm-agent-server-libs/src/__tests__/dag-coordinator-mcp.integration.test.ts`.

- [ ] **Step 1 — ARCHITECTURE.md** decision point (1): change `hard` wording to "`hard` forces the worker to execute only internal MCP tools; client/external tools are still offered and their calls surfaced to the consumer" (D4).
- [ ] **Step 2 — INTEGRATION.md:** short "external/client tools under the coordinator" note (always available, consumer-executed, standard round-trip, deterministic ids, stateless resume).
- [ ] **Step 3 — integration test:** extend the (env-gated) DAG↔MCP test with an external-tool round-trip case (assistant surfaces an `ext:*` call → simulated client result fed back → run completes), gated like the existing one.
- [ ] **Step 4 — commit** `docs+test: external tools under the DAG coordinator (#171)`.

---

### Task 9: full build + lint + tests

- [ ] `npm run build` → exit 0; `npm run lint:check`; `npm test` → 0 failures. Commit any lint fixes.

---

## Self-Review

**Spec coverage:** D1 (Task 1 ids + Task 3 map/adjacency + Task 4 lookup), D2 (Task 2 types + Task 4/5/6 usage), D3 collect-all-at-settle (Task 5) + no-finalizer (Task 6), D4 mode + docs (Task 4 drop + Task 8), review#5 sanitization (Task 3 + Task 6 threading), obs 2c planner (Task 7). ✓

**Type consistency:** `externalToolCallId`/`deepStableArgsKey`/`shortHash` (Task 1) used in Task 3/4; `ISubAgentResult.status/pendingExternalToolCalls` + `InterpretResult.pendingExternalToolCalls` (Task 2) produced in Task 4/5, consumed in Task 6; `ctx.externalResults` (Task 6) consumed in Task 4. `LlmToolCall` shape `{id,name,arguments}` consistent.

**Placeholder scan:** Task 7's planner edit is the least-specified (depends on the concrete planner class) — the implementer must grep the planner first; not a literal TODO but flagged. Task 3/4 test bodies are described precisely but the implementer writes the concrete asserts following the named conditions.

## Risk notes

- Order Task 1→2→3 (contracts) before 4→7 (consumers). Task 6 threads the context field Task 4 reads — if implemented out of order, stub `ctx.externalResults` in Task 4's unit test.
- DAG is otherwise behaviour-preserving: the no-finalizer branch only triggers when external calls are pending; the existing finalizer path is unchanged when there are none.
