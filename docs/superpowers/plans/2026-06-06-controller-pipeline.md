# Controller Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new built-in `controller` pipeline plugin — a deterministic Coordinator orchestrating three opaque subagent roles (evaluator / planner-reviewer / executor) through an incremental, goal-driven loop, with a durable per-session bundle, internal/external tool routing, and stateless suspend/resume.

**Architecture:** A new `IPipelinePlugin` (`controller`) whose `build()` wires a `ControllerCoordinatorHandler` (an `IStageHandler<PipelineContext>`) via `ctx.createAgentBuilder().withStepperCoordinator(handler)`. The handler is constructed with subagent `ILlm`s (from `ctx.makeLlm`), a durable `KnowledgeBackend` (session-keyed; survives graph dispose, purged on delete), and an embedder. At `execute(pipelineCtx)` it runs: hydrate bundle → evaluator(target-state) → loop[planner(next)→executor(exec)→route tools→memorize→planner(observe)] → finalize → persist/escalate. Stepper is NOT touched.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, `node:test` + `node:assert/strict` (`node --import tsx/esm --test`), Biome. Spec: `docs/superpowers/specs/2026-06-06-controller-pipeline-design.md`.

**Test command (per package):** `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec 'src/<path>.test.ts'`. Always `npx biome check --write <files>` before committing.

---

## File Structure

All new code under `packages/llm-agent-server-libs/src/`:

| File | Responsibility |
|------|----------------|
| `smart-agent/controller/types.ts` | shared types: `SubagentResult`, `SessionBundle`, `PendingMarker`, `ControllerConfig`, `NextStep` |
| `smart-agent/controller/subagent-client.ts` | `makeSubagentClient(llm)` — normalizes `ILlm.chat` → `SubagentResult` (`content|tool_call|error`) |
| `smart-agent/controller/session-bundle.ts` | `hydrateBundle` / `persistBundle` over a `KnowledgeBackend` keyed by `sessionId` (bundle latest-wins; artifacts accumulate) |
| `smart-agent/controller/memorizer.ts` | `writeArtifact(rag, {type,name,source,content})` → session-memory |
| `smart-agent/controller/need-resolver.ts` | `resolveNeed(rag, needText, k)` → semantic search of session-memory |
| `smart-agent/controller/target-state.ts` | `establishTargetState(deps, prompt, strategy)` — evaluator formulate + embedder distance + confirm escalation |
| `smart-agent/controller/controller-coordinator-handler.ts` | `ControllerCoordinatorHandler implements IStageHandler<PipelineContext>` — the loop |
| `pipelines/controller.ts` | `ControllerPipelinePlugin implements IPipelinePlugin` — `parseConfig` + `build` |
| `pipelines/__tests__/*.test.ts` | per-unit tests + conformance |

Reuse (no duplication): `ILlm`/`makeLlm`, `IServerPipelineContext`/`createAgentBuilder`, `KnowledgeBackend`/`KnowledgeRag`/`JsonlKnowledgeBackend`, `buildExternalResults`/`externalToolCallId`, `ClarifySignal`, `IEmbedder`, `withStepperCoordinator`.

---

## Phase 1 — Foundational units (full TDD)

### Task 1: Shared types

**Files:** Create `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`; Test `…/controller/__tests__/types.test.ts`

- [ ] **Step 1: failing test**
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ControllerConfig, NextStep, PendingMarker, SessionBundle, SubagentResult } from '../types.js';

describe('controller types', () => {
  it('SubagentResult discriminates content|tool_call|error', () => {
    const r: SubagentResult = { kind: 'content', content: 'x' };
    assert.equal(r.kind, 'content');
  });
  it('SessionBundle + PendingMarker + NextStep + ControllerConfig are usable', () => {
    const marker: PendingMarker = { kind: 'external-tool', extId: 'ext:1', toolName: 't', args: {}, position: 'step:0' };
    const next: NextStep = { kind: 'next', step: { name: 's', instructions: 'do' } };
    const bundle: SessionBundle = { goal: 'g', plannerPrivate: '', budgets: { stepsUsed: 0, rewindsUsed: 0 }, pending: marker };
    const cfg: ControllerConfig = {
      subagents: { evaluator: { provider: 'openai', apiKey: 'k' }, planner: { provider: 'openai', apiKey: 'k' }, executor: { provider: 'openai', apiKey: 'k' } },
      targetState: { strategy: 'auto', distanceThreshold: 0.25 },
      sessionMemory: { collection: 'session-memory' },
      budgets: { maxSteps: 20, maxRetries: 3, maxRewinds: 5 },
    };
    assert.equal(next.kind, 'next');
    assert.equal(bundle.budgets.stepsUsed, 0);
    assert.equal(cfg.budgets.maxSteps, 20);
  });
});
```
- [ ] **Step 2: run → FAIL** (`cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec 'src/smart-agent/controller/__tests__/types.test.ts'`) — `Cannot find module '../types.js'`.
- [ ] **Step 3: implement** `types.ts`:
```ts
import type { SmartServerLlmConfig } from '../smart-server.js';
import type { StreamToolCall } from '@mcp-abap-adt/llm-agent';

export type SubagentResult =
  | { kind: 'content'; content: string }
  | { kind: 'tool_call'; toolCalls: StreamToolCall[] }
  | { kind: 'error'; error: string };

export interface Step { name: string; instructions: string; type?: string }
export type NextStep =
  | { kind: 'next'; step: Step }
  | { kind: 'done'; result: string }
  | { kind: 'rewind'; reason: string };

export type PendingMarker =
  | { kind: 'external-tool'; extId: string; toolName: string; args: unknown; position: string }
  | { kind: 'clarify'; question: string; position: string };

export interface SessionBundle {
  goal: string;                       // target state (clean-global anchor)
  plannerPrivate: string;             // opaque planner context blob
  budgets: { stepsUsed: number; rewindsUsed: number };
  pending?: PendingMarker;
}

export interface ControllerConfig {
  subagents: { evaluator: SmartServerLlmConfig; planner: SmartServerLlmConfig; executor: SmartServerLlmConfig };
  targetState: { strategy: 'consumer-confirm' | 'semantic-distance' | 'auto'; distanceThreshold: number };
  sessionMemory: { collection: string };
  budgets: { maxSteps: number; maxRetries: number; maxRewinds: number };
}
```
(`StreamToolCall` is exported from `@mcp-abap-adt/llm-agent` — confirm; if the name differs grep `export interface StreamToolCall` and use the real one.)
- [ ] **Step 4: run → PASS** (2 tests). `cd /home/okyslytsia/prj/llm-agent && npm run build` → clean.
- [ ] **Step 5: commit** `git add packages/llm-agent-server-libs/src/smart-agent/controller && git commit -m "feat(controller): shared types"`

### Task 2: subagent-client

**Files:** Create `…/controller/subagent-client.ts`; Test `…/controller/__tests__/subagent-client.test.ts`

- [ ] **Step 1: failing test**
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { makeSubagentClient } from '../subagent-client.js';

const llm = (resp: unknown): ILlm => ({ model: 's', chat: async () => resp as never, streamChat: async function* () {} }) as ILlm;

describe('makeSubagentClient', () => {
  it('content response → kind:content', async () => {
    const c = makeSubagentClient(llm({ ok: true, value: { content: 'hello', toolCalls: [] } }));
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), { kind: 'content', content: 'hello' });
  });
  it('tool_calls response → kind:tool_call', async () => {
    const tc = [{ id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } }];
    const c = makeSubagentClient(llm({ ok: true, value: { content: '', toolCalls: tc } }));
    const r = await c.send([{ role: 'user', content: 'hi' }]);
    assert.equal(r.kind, 'tool_call');
  });
  it('error result → kind:error', async () => {
    const c = makeSubagentClient(llm({ ok: false, error: { message: 'boom' } }));
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), { kind: 'error', error: 'boom' });
  });
});
```
- [ ] **Step 2: run → FAIL** (module missing).
- [ ] **Step 3: implement**
```ts
import type { ILlm, LlmTool, Message } from '@mcp-abap-adt/llm-agent';
import type { SubagentResult } from './types.js';

export interface ISubagentClient {
  send(messages: Message[], tools?: LlmTool[]): Promise<SubagentResult>;
}

export function makeSubagentClient(llm: ILlm): ISubagentClient {
  return {
    async send(messages, tools) {
      const r = await llm.chat(messages, tools);
      if (!r.ok) return { kind: 'error', error: r.error?.message ?? 'subagent llm error' };
      const v = r.value;
      if (v.toolCalls && v.toolCalls.length > 0) return { kind: 'tool_call', toolCalls: v.toolCalls };
      return { kind: 'content', content: v.content ?? '' };
    },
  };
}
```
(Verify `LlmResponse` — the `r.value` type — has `content`/`toolCalls`; grep `interface LlmResponse`. Adjust field access to the real shape; the test fakes match it.)
- [ ] **Step 4: run → PASS (3). build → clean. biome → clean.**
- [ ] **Step 5: commit** `feat(controller): subagent client (ILlm → SubagentResult)`

### Task 3: memorizer

**Files:** Create `…/controller/memorizer.ts`; Test `…/controller/__tests__/memorizer.test.ts`

- [ ] **Step 1: failing test** — a fake `IKnowledgeRagHandle` capturing writes:
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeArtifact } from '../memorizer.js';

describe('writeArtifact', () => {
  it('writes content with {type,name,source} metadata to the rag handle', async () => {
    const writes: unknown[] = [];
    const rag = { write: async (e: unknown) => { writes.push(e); }, query: async () => [] } as never;
    await writeArtifact(rag, { type: 'code', name: 'ZTEST', source: 'GetProgram', content: 'REPORT ztest.' });
    assert.equal(writes.length, 1);
    assert.deepEqual((writes[0] as { metadata: unknown }).metadata, { type: 'code', name: 'ZTEST', source: 'GetProgram' });
    assert.equal((writes[0] as { content: string }).content, 'REPORT ztest.');
  });
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement**
```ts
import type { IKnowledgeRagHandle } from '@mcp-abap-adt/llm-agent';

export interface Artifact { type: string; name: string; source: string; content: string }

export async function writeArtifact(rag: IKnowledgeRagHandle, a: Artifact): Promise<void> {
  await rag.write({ content: a.content, metadata: { type: a.type, name: a.name, source: a.source } as never });
}
```
(Verify `IKnowledgeRagHandle.write({content, metadata})` shape vs `KnowledgeRag.write` — the report shows `write(entry:{content, metadata: KnowledgeEntryMetadata})`. Match `KnowledgeEntryMetadata` fields; if it requires more, fill minimally.)
- [ ] **Step 4: PASS (1). build. biome.**
- [ ] **Step 5: commit** `feat(controller): memorizer (write artifact to session-memory)`

### Task 4: need-resolver

**Files:** Create `…/controller/need-resolver.ts`; Test `…/controller/__tests__/need-resolver.test.ts`

- [ ] **Step 1: failing test**
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveNeed } from '../need-resolver.js';

describe('resolveNeed', () => {
  it('returns semantic hits from session-memory for the need text', async () => {
    const rag = { write: async () => {}, query: async (text: string, opts?: { k?: number }) => {
      assert.equal(text, 'includes of ZTEST'); assert.equal(opts?.k, 5);
      return [{ content: 'INCLUDE zinc.', metadata: { type: 'code', name: 'ZINC' } }];
    } } as never;
    const hits = await resolveNeed(rag, 'includes of ZTEST', 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, 'INCLUDE zinc.');
  });
  it('empty when nothing relevant', async () => {
    const rag = { write: async () => {}, query: async () => [] } as never;
    assert.deepEqual(await resolveNeed(rag, 'x', 5), []);
  });
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement**
```ts
import type { IKnowledgeRagHandle } from '@mcp-abap-adt/llm-agent';

export async function resolveNeed(rag: IKnowledgeRagHandle, needText: string, k = 5) {
  return rag.query(needText, { k });
}
```
(Verify `IKnowledgeRagHandle.query(text, {k, filter})` matches `KnowledgeRag.query`.)
- [ ] **Step 4: PASS (2). build. biome.**
- [ ] **Step 5: commit** `feat(controller): need-resolver (semantic search of session-memory)`

### Task 5: session-bundle (hydrate/persist over KnowledgeBackend)

**Files:** Create `…/controller/session-bundle.ts`; Test `…/controller/__tests__/session-bundle.test.ts`

The bundle is stored as a single durable entry keyed by `sessionId` with `metadata.type='controller-bundle'` (latest-wins on read). Backed by a `KnowledgeBackend` so the existing `deleteSession(sessionId)` purges it.

- [ ] **Step 1: failing test** — in-memory `KnowledgeBackend` stub:
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hydrateBundle, persistBundle } from '../session-bundle.js';
import type { SessionBundle } from '../types.js';

function memBackend() {
  const store = new Map<string, { content: string; metadata: { type?: string } }[]>();
  return {
    put: async (sid: string, e: never) => { const a = store.get(sid) ?? []; a.push(e as never); store.set(sid, a); },
    semanticQuery: async () => [],
    scan: async (sid: string) => store.get(sid) ?? [],
    deleteSession: async (sid: string) => { store.delete(sid); },
  } as never;
}

describe('session-bundle', () => {
  it('hydrate returns a fresh empty bundle when none persisted', async () => {
    const b = await hydrateBundle(memBackend(), 's1');
    assert.equal(b.goal, '');
    assert.equal(b.budgets.stepsUsed, 0);
    assert.equal(b.pending, undefined);
  });
  it('persist then hydrate round-trips the latest bundle', async () => {
    const be = memBackend();
    const bundle: SessionBundle = { goal: 'build RAP app', plannerPrivate: 'step2 done', budgets: { stepsUsed: 3, rewindsUsed: 1 }, pending: { kind: 'clarify', question: 'which DB?', position: 'step:3' } };
    await persistBundle(be, 's1', bundle);
    const got = await hydrateBundle(be, 's1');
    assert.deepEqual(got, bundle);
  });
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement**
```ts
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import type { SessionBundle } from './types.js';

const BUNDLE_TYPE = 'controller-bundle';
const EMPTY: SessionBundle = { goal: '', plannerPrivate: '', budgets: { stepsUsed: 0, rewindsUsed: 0 } };

export async function hydrateBundle(be: KnowledgeBackend, sessionId: string): Promise<SessionBundle> {
  const entries = await be.scan(sessionId);
  const latest = [...entries].reverse().find((e) => (e.metadata as { type?: string })?.type === BUNDLE_TYPE);
  if (!latest) return structuredClone(EMPTY);
  try { return JSON.parse(latest.content) as SessionBundle; } catch { return structuredClone(EMPTY); }
}

export async function persistBundle(be: KnowledgeBackend, sessionId: string, bundle: SessionBundle): Promise<void> {
  await be.put(sessionId, { content: JSON.stringify(bundle), metadata: { type: BUNDLE_TYPE } } as never);
}
```
(Verify `KnowledgeBackend` is exported from `@mcp-abap-adt/llm-agent-libs` and `KnowledgeEntry` shape `{content, metadata}`. `scan` returns insertion-ordered entries → reverse-find = latest. If the backend dedups by type, simplify.)
- [ ] **Step 4: PASS (2). build. biome.**
- [ ] **Step 5: commit** `feat(controller): session-bundle hydrate/persist (sessionId-keyed, latest-wins)`

### Task 6: target-state (Evaluator)

**Files:** Create `…/controller/target-state.ts`; Test `…/controller/__tests__/target-state.test.ts`

`establishTargetState` formulates the target state via the evaluator subagent, then validates per strategy: `semantic-distance` (embedder cosine vs prompt; ≤ threshold → ok) / `consumer-confirm` (throw `ClarifySignal`) / `auto` (evaluator self-decides → may signal confirm).

- [ ] **Step 1: failing test**
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClarifySignal } from '@mcp-abap-adt/llm-agent';
import { establishTargetState } from '../target-state.js';

const evalClient = (text: string) => ({ send: async () => ({ kind: 'content', content: text }) }) as never;
const embedder = (vec: number[]) => ({ embed: async () => ({ vector: vec }) }) as never;

describe('establishTargetState', () => {
  it('semantic-distance: close → returns target state', async () => {
    const ts = await establishTargetState(
      { evaluator: evalClient('Goal: review ZTEST'), embedder: embedder([1, 0, 0]) },
      'review ZTEST',
      { strategy: 'semantic-distance', distanceThreshold: 0.5 },
    );
    assert.equal(ts, 'Goal: review ZTEST');
  });
  it('semantic-distance: far → throws ClarifySignal', async () => {
    let calls = 0;
    const emb = { embed: async () => ({ vector: calls++ === 0 ? [1, 0] : [0, 1] }) } as never; // orthogonal → distance 1
    await assert.rejects(
      () => establishTargetState({ evaluator: evalClient('Goal: X'), embedder: emb }, 'Y', { strategy: 'semantic-distance', distanceThreshold: 0.1 }),
      ClarifySignal,
    );
  });
  it('consumer-confirm: always throws ClarifySignal with the formulated target', async () => {
    await assert.rejects(
      () => establishTargetState({ evaluator: evalClient('Goal: Z'), embedder: embedder([1]) }, 'p', { strategy: 'consumer-confirm', distanceThreshold: 0.25 }),
      (e: unknown) => e instanceof ClarifySignal && /Goal: Z/.test((e as ClarifySignal).question),
    );
  });
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — formulate via evaluator; cosine distance; route per strategy:
```ts
import { ClarifySignal } from '@mcp-abap-adt/llm-agent';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import type { ISubagentClient } from './subagent-client.js';
import type { ControllerConfig } from './types.js';

interface Deps { evaluator: ISubagentClient; embedder: IEmbedder }

function cosineDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function establishTargetState(
  deps: Deps, prompt: string, cfg: ControllerConfig['targetState'],
): Promise<string> {
  const r = await deps.evaluator.send([
    { role: 'system', content: 'Formulate a concise target state (goal) for the user prompt.' },
    { role: 'user', content: prompt },
  ]);
  const target = r.kind === 'content' ? r.content : '';
  if (cfg.strategy === 'consumer-confirm') {
    throw new ClarifySignal(`Confirm or refine the target state:\n${target}`);
  }
  if (cfg.strategy === 'semantic-distance' || cfg.strategy === 'auto') {
    const [te, pe] = await Promise.all([deps.embedder.embed(target), deps.embedder.embed(prompt)]);
    const dist = cosineDistance((te as { vector: number[] }).vector, (pe as { vector: number[] }).vector);
    if (dist > cfg.distanceThreshold) {
      throw new ClarifySignal(`The goal may be ambiguous (distance ${dist.toFixed(2)}). Confirm or refine:\n${target}`);
    }
  }
  return target;
}
```
(Verify `IEmbedResult` field name — report shows `embed(text) → IEmbedResult`; grep its shape and use the real vector field, e.g. `.embedding` vs `.vector`. Adjust the cast + test fakes to match.)
- [ ] **Step 4: PASS (3). build. biome.**
- [ ] **Step 5: commit** `feat(controller): target-state evaluator (formulate + distance + confirm)`

---

## Phase 2 — Coordinator handler (integration)

### Task 7: ControllerCoordinatorHandler — the loop

**Files:** Create `…/controller/controller-coordinator-handler.ts`; Test `…/controller/__tests__/controller-coordinator-handler.test.ts`

This is the integration core. It implements `IStageHandler<PipelineContext>`. Constructed with: the three `ISubagentClient`s, the `KnowledgeBackend`, a `knowledgeRagFor(sessionId)`, the embedder, and the `ControllerConfig`. At `execute(ctx)`:
1. `sessionId = ctx.sessionId`; `prompt` from `ctx.textOrMessages`.
2. `bundle = await hydrateBundle(backend, sessionId)`.
3. If `bundle.pending` and `ctx.externalResults`/new input matches → resume (feed result, clear marker); else if no goal → `bundle.goal = await establishTargetState(...)` (may throw `ClarifySignal`).
4. loop (while `bundle.budgets.stepsUsed < maxSteps`): planner.send(goal + plannerPrivate + clean-global) → `NextStep`. `done` → finalize via `ctx.yield` final content; `rewind` → bump `rewindsUsed` (≤ maxRewinds) + continue; `next` → executor.send(step) → route `tool_call` (internal `callMcp` / external → surface `ext:` + persist pending + return) / `error` (retry ≤ maxRetries, else replan) / `content` → `writeArtifact` + `bundle.stepsUsed++`.
5. Escalation/clarify → persist bundle + surface; finalize → persist (clear pending).

Because this is a large state machine over the real `PipelineContext`, the task is specified as: the constructor + `execute` skeleton + the **driving tests** (stub subagents/backend/embedder). Build incrementally, one path per test.

- [ ] **Step 1: write the driving tests** (hermetic; stub the three `ISubagentClient`s with scripted `send` queues, an in-memory `KnowledgeBackend`, a stub embedder, a fake `PipelineContext` capturing `yield`). Cover, one `it` each:
  - **happy path:** evaluator→goal; planner `next` → executor `content` → planner `done` → final content yielded; bundle persisted with no pending; `stepsUsed===1`.
  - **internal tool:** executor `tool_call` (name not in externalTools) → handler calls injected `callMcp`, feeds result back, executor `content`, planner `done`.
  - **external tool:** executor `tool_call` (name in `ctx.externalTools`) → handler yields a chunk with `toolCalls=[ext:id]` + `finishReason:'tool_calls'`, persists `pending={kind:'external-tool',extId,…}`, returns; assert the yielded chunk + the persisted marker.
  - **resume external:** `ctx.externalResults` has the `ext:id`, bundle has the matching pending → handler feeds the result to the executor, clears pending, continues to `done`.
  - **rewind:** planner returns `rewind` then `next`→`done`; `rewindsUsed` bumped; bounded by maxRewinds (exceeding → escalate).
  - **budget:** `stepsUsed` reaches `maxSteps` → escalate (clarify content yielded).
  - **clarify (target-state):** `establishTargetState` throws `ClarifySignal` → handler yields the question + persists `pending={kind:'clarify',…}` + returns.

  Write these against the intended public surface:
```ts
const handler = new ControllerCoordinatorHandler({
  evaluator, planner, executor,          // ISubagentClient stubs
  backend,                               // KnowledgeBackend stub
  knowledgeRagFor: async () => ragStub,  // IKnowledgeRagHandle stub
  embedder,                              // IEmbedder stub
  callMcp: async () => 'mcp-result',     // internal tool executor
  config,                                // ControllerConfig
});
const ctx = fakeCtx({ sessionId: 's1', textOrMessages: 'review ZTEST', externalTools: [], externalResults: undefined });
const ok = await handler.execute(ctx, {}, undefined);
assert.equal(ok, true);
// assert ctx.yielded chunks / persisted bundle as per the path
```
  `fakeCtx` is a minimal `PipelineContext` partial: `{ sessionId, textOrMessages, externalTools, externalResults, options, yield: (c)=>yielded.push(c) }` cast `as never` for the unused fields.

- [ ] **Step 2: run → FAIL** (module missing).

- [ ] **Step 3: implement `controller-coordinator-handler.ts`** — the constructor (capturing the deps above) + `async execute(ctx, _config, _span): Promise<boolean>` implementing the state machine in the order of §8 of the spec, using: `hydrateBundle`/`persistBundle` (Task 5), `establishTargetState` (Task 6), `writeArtifact` (Task 3), `resolveNeed` (Task 4), the subagent clients (Task 2), `externalToolCallId` + the `ctx.externalResults` map for external resume, `ClarifySignal` for clarify/budget escalation, and `ctx.yield({ ok: true, value: { content, finishReason } })` to emit. Internal vs external tool = whether the tool name is in `ctx.externalTools`. Persist the bundle before any escalation return and at finalize.
  - Keep the planner/executor/evaluator prompt assembly in small private methods.
  - Parse the planner's `NextStep` from its `content` (the planner returns a JSON line `{kind, …}` per a system-prompt contract OR a tool_call — choose JSON-in-content for MVP; document the contract in the planner system prompt).
  - On `error` from executor: increment a per-step retry counter; ≤ `maxRetries` → re-send with the error appended; else feed the error to the planner for a replan.

- [ ] **Step 4: run → all path tests PASS.** `npm run build` → clean. `npx biome check --write` → clean.

- [ ] **Step 5: commit** `feat(controller): coordinator handler (incremental loop + tool routing + suspend/resume)`

---

## Phase 3 — Plugin + host wiring

### Task 8: ControllerPipelinePlugin

**Files:** Create `packages/llm-agent-server-libs/src/pipelines/controller.ts`; Test `pipelines/__tests__/controller.test.ts`

- [ ] **Step 1: failing test** (reuse the `fakeServerCtx` fixture pattern from the stepper/dag tests; assert `parseConfig` + `build` → `{agent, close}`):
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControllerPipelinePlugin } from '../controller.js';
import { fakeServerCtx } from './fixtures.js';

describe('ControllerPipelinePlugin', () => {
  it('parses config, builds an instance, exposes agent + close', async () => {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: { evaluator: { provider: 'openai', apiKey: 'k' }, planner: { provider: 'openai', apiKey: 'k' }, executor: { provider: 'openai', apiKey: 'k' } },
    });
    assert.equal(cfg.budgets.maxSteps, 20); // defaulted
    const inst = await plugin.build(cfg, fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });
  it('parseConfig rejects missing subagents', () => {
    assert.throws(() => new ControllerPipelinePlugin().parseConfig({}), /subagents/);
  });
});
```
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — `parseConfig` validates/defaults (`targetState.strategy ?? 'auto'`, `budgets` defaults `{20,3,5}`, require `subagents.{evaluator,planner,executor}`); `build` builds the three `ISubagentClient`s via `ctx.makeLlm(roleCfg)` + `makeSubagentClient`, constructs the `ControllerCoordinatorHandler` (passing the `KnowledgeBackend` from the host ctx, `ctx.knowledgeRagFor`, `ctx.embedder` — see note, `ctx.callMcp`), wires `ctx.createAgentBuilder().withStepperCoordinator(handler).build()`, returns `{ agent: handle.agent, close: () => handle.close() }`.
  - NOTE: the handler needs a durable `KnowledgeBackend`. `IServerPipelineContext` does not expose it today → **Task 9 adds it** (or expose via `ctx`); for the unit test, `fakeServerCtx` provides a stub. The plugin reads it from `ctx` (extend the fixture + the server ctx in Task 9).
- [ ] **Step 4: PASS (2). build. biome.**
- [ ] **Step 5: commit** `feat(pipelines): controller pipeline plugin`

### Task 9: host wiring — register plugin + expose durable backend

**Files:** Modify `smart-server.ts` (registry + `IServerPipelineContext` durable-backend exposure); `pipelines/server-context.ts` (+ `knowledgeBackend`/`embedder`/`knowledgeRagFor` on the ctx if absent); `pipelines/__tests__/fixtures.ts` (stub the new ctx fields). In-place; READ first.

- [ ] **Step 1:** add `ControllerPipelinePlugin` to the built-in registry list in `start()` (alongside flat/linear/dag/stepper).
- [ ] **Step 2:** ensure `IServerPipelineContext` exposes what the controller handler needs that the existing fields don't: a durable `KnowledgeBackend` (the `_stepperKnowledgeBackend`), `knowledgeRagFor(sessionId)`, and `embedder`. Add these to `IServerPipelineContext` + `createServerPipelineContext` deps + the server's `buildServerCtx` wiring (source from the already-built `_stepperKnowledgeBackend`, the `knowledgeRagFor` closure, and `resolvedEmbedder`). Update `fakeServerCtx` to stub them.
- [ ] **Step 3:** add config parsing: the `pipeline.name: controller` path already flows through `parseConfig` (the host passes `pipeline.config` verbatim) — confirm no extra server-side parsing needed.
- [ ] **Step 4:** `npm run build` → clean; full server-libs suite → 0 failures (note env-gated skips); biome.
- [ ] **Step 5: commit** `feat(server): register controller pipeline + expose durable backend/embedder on ctx`

---

## Phase 4 — Conformance

### Task 10: conformance + escalation round-trip test

**Files:** Modify `pipelines/__tests__/conformance.test.ts` (add `controller`); Create `…/controller/__tests__/round-trip.test.ts`

- [ ] **Step 1:** add `new ControllerPipelinePlugin()` to the conformance `BUILTINS` list with `MIN_CFG.controller = { subagents: {evaluator,planner,executor: {provider:'openai',apiKey:'k'}} }`; it must `parseConfig → build → streamProcess → close` like the others (subagents stubbed via `fakeServerCtx`).
- [ ] **Step 2:** write a hermetic round-trip test: drive the handler through suspend (external tool) → assert pending persisted + `ext:` surfaced → re-invoke with `ctx.externalResults` carrying the result → assert resume → `done`. (Reuses the Task-7 stubs.)
- [ ] **Step 3:** run both → PASS. build. biome.
- [ ] **Step 4: commit** `test(controller): conformance + suspend/resume round-trip`

---

## Self-Review

**1. Spec coverage:**
- §3/§4 architecture + plugin placement → Tasks 8–9 (plugin + `withStepperCoordinator` wiring). ✓
- §5 subagents (opaque ILlm clients) → Task 2 (subagent-client) + Task 8 (build via `ctx.makeLlm`). ✓
- §6 contexts + light session + durable bundle (sessionId-keyed, survives dispose, purged on delete) → Task 5 (session-bundle over KnowledgeBackend; `deleteSession` reused) + Task 9 (expose backend). ✓
- §7 target-state evaluator (strategies) → Task 6. ✓
- §8 control loop (incremental, rewind, done, need subsumed) → Task 7. ✓
- §9 tool routing (internal/external) → Task 7 (internal `callMcp` / external `ext:`). ✓
- §10 suspend/resume via persisted bundle + `ctx.externalResults` + `ClarifySignal` → Task 7 + Task 10. ✓
- §11 need-resolver + memorizer → Tasks 3–4. ✓
- §12 budgets (persisted per-goal) → Task 1 (bundle.budgets) + Task 7 (enforce). ✓
- §13 reuse + file boundaries → File Structure + per-task imports. ✓
- §14 config → Task 1 (`ControllerConfig`) + Task 8 (`parseConfig` defaults). ✓
- §15 testing (hermetic stubs) → Tasks 2–7, 10. ✓

**2. Placeholder scan:** Tasks 1–6, 8, 10 contain complete code + commands. Tasks 7 and 9 are specified as the public surface + driving tests + exact reuse points (Task 7 is a large state machine built one-path-per-test; Task 9 is an in-place `smart-server.ts` edit) — each notes the exact existing symbols to use and the build/test gate, not vague "handle X".

**3. Type consistency:** `SubagentResult`/`NextStep`/`PendingMarker`/`SessionBundle`/`ControllerConfig` (Task 1) are used verbatim by Tasks 2/5/6/7/8. `ISubagentClient.send` (Task 2) used by Tasks 6/7. `hydrateBundle/persistBundle` (Task 5) used by Task 7. `writeArtifact`/`resolveNeed` (Tasks 3/4) used by Task 7. `establishTargetState` (Task 6) used by Task 7.

**4. Verify-on-implement (tsc/grep will confirm):** `LlmResponse` field names (`content`/`toolCalls`), `IEmbedResult` vector field, `KnowledgeEntryMetadata` shape, `StreamToolCall` export name, `KnowledgeBackend` export from `llm-agent-libs`. Each task notes the field to confirm; adjust casts + test fakes to the real shapes.

> **Note on scope:** Phase 1 (Tasks 1–6) is full-TDD foundation. Task 7 (the loop) is the integration capstone — built incrementally one path per driving test. Tasks 8–10 wire the plugin into the host + conformance. Implement on a feature branch (`feat/controller-pipeline`).
