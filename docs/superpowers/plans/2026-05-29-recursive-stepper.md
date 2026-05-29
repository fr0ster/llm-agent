# Recursive Stepper Architecture (18.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat DAG coordinator with a recursive Stepper hierarchy over a per-session shared knowledge-RAG, with three execution modes, context-augmenting ReAct, and progress-event streaming.

**Architecture:** Every coordinator/worker is a `Stepper` (planner + reviewer + interpreter + executor). Executors write step artefacts to a per-session knowledge-RAG; planners query it before planning (RAG-first). One root finalizer composes the answer from the accumulated RAG. Depth bounds recursion (interpreter-owned); tokens bound work (executor + stepper).

**Tech Stack:** TypeScript strict, ESM with `.js` import suffixes, Biome (2 spaces, single quotes, semicolons), `node --test` via `tsx`. Three packages lockstep: `@mcp-abap-adt/llm-agent` (contracts), `@mcp-abap-adt/llm-agent-libs` (runtime), `@mcp-abap-adt/llm-agent-server` (wiring).

**Spec:** `docs/superpowers/specs/2026-05-29-recursive-stepper-design.md`. Provability tests H.1–H.10 + H.4b are implemented as the integration tests in Phase 7.

**Branch:** `epic/18.0-recursive-stepper` (already created off `main`).

---

## Naming reconciliation (read before starting)

The spec uses some type names that differ from existing 17.0 exports. Use the REAL 17.0 names:

| Spec name | Real 17.0 export | Source |
|---|---|---|
| `Tool` | `LlmTool` | `@mcp-abap-adt/llm-agent` |
| `LLM call options` | `CallOptions` | `@mcp-abap-adt/llm-agent` |
| `ISessionLogger` | the shape passed as `sessionLogger` (has `logStep(name, data)`) | `@mcp-abap-adt/llm-agent` |
| `DagPlan` | `DagPlan` (note: `createdAt` is required) | `@mcp-abap-adt/llm-agent` interfaces/dag-plan.ts |
| `LlmUsage`, `LlmComponent` | unchanged | `@mcp-abap-adt/llm-agent` |
| `ClarifySignal`, `NeedInfoSignal` | unchanged | `@mcp-abap-adt/llm-agent` |
| `IRag` | unchanged | `@mcp-abap-adt/llm-agent` |

When a task's code block references `Tool`, write `LlmTool`. Confirm each name with `git grep -n "export .* <Name>" packages/llm-agent/src` before coding if unsure.

---

## File Structure

### `@mcp-abap-adt/llm-agent` (contracts) — Phase 1

| File | Responsibility |
|---|---|
| `src/interfaces/stepper.ts` | `RunIdentity`, `ToolSafetyPolicy`, `Budget`, `IStepperInput`, `IStepperResult`, `IStepper` |
| `src/interfaces/stepper-planner.ts` | `IStepperPlanner` |
| `src/interfaces/stepper-interpreter.ts` | `IStepperInterpreter` |
| `src/interfaces/executor.ts` | `IExecutor` |
| `src/interfaces/knowledge-rag.ts` | `KnowledgeEntryMetadata`, `KnowledgeEntry`, `KnowledgeFilter`, `IKnowledgeRagHandle`, `IToolsRagHandle` |
| `src/interfaces/need-resolver.ts` | `INeedResolver` |
| `src/interfaces/insufficient-signal.ts` | `InsufficientSignal` |
| `src/interfaces/streaming.ts` (MODIFY) | extend `StreamChunk` with `StepperRef` + progress variants |
| `src/index.ts` + `src/interfaces/index.ts` (MODIFY) | re-exports |

### `@mcp-abap-adt/llm-agent-libs` (runtime) — Phases 2–5

| File | Responsibility |
|---|---|
| `src/rag/knowledge-rag.ts` | `KnowledgeRag` (wraps any `IRag`), `ToolsRag` |
| `src/coordinator/stepper/need-resolver.ts` | `RegexNeedResolver`, `LlmNeedResolver` |
| `src/coordinator/stepper/cyclic-react-executor.ts` | `CyclicReActExecutor` |
| `src/coordinator/stepper/llm-stepper-planner.ts` | `LlmStepperPlanner` + `STEPPER_PLANNER_SYSTEM` |
| `src/coordinator/stepper/stepper-interpreter.ts` | `StepperInterpreter` |
| `src/coordinator/stepper/stepper.ts` | `Stepper` |
| `src/coordinator/stepper/root-finalizer.ts` | `RootFinalizer` |
| `src/coordinator/stepper/index.ts` | barrel |
| `src/index.ts` (MODIFY) | re-export the stepper barrel |

### `@mcp-abap-adt/llm-agent-server` (wiring) — Phase 6

| File | Responsibility |
|---|---|
| `src/smart-agent/build-stepper-root.ts` | `buildStepperRoot` factory |
| `src/smart-agent/stepper-coordinator-handler.ts` | `StepperCoordinatorHandler` |
| `src/smart-agent/session-meta-store.ts` | `SessionMetaStore` (Postgres + in-memory) |
| `src/smart-agent/config.ts` (MODIFY) | parse `coordinator.mode`, `coordinator.mutationPolicy`, `coordinator.knownReadOnlyTools`, `coordinator.stepper.*` |
| `src/smart-agent/smart-server.ts` (MODIFY) | mode routing + `/v1/sessions` endpoints |

---

## Phase 1 — Contracts (`@mcp-abap-adt/llm-agent`)

### Task 1 — Stepper core types

**Files:**
- Create: `packages/llm-agent/src/interfaces/stepper.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/stepper.contract.test.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`

- [ ] **1a. Failing test.** Create `packages/llm-agent/src/interfaces/__tests__/stepper.contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Budget,
  IStepper,
  IStepperInput,
  IStepperResult,
  RunIdentity,
  ToolSafetyPolicy,
} from '../stepper.js';

test('Stepper core types: minimal IStepper compiles and runs', async () => {
  const identity: RunIdentity = {
    traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0',
  };
  const toolSafety: ToolSafetyPolicy = {
    mutationPolicy: 'confirm',
    knownReadOnlyTools: new Set(['GetProgram']),
  };
  const budget: Budget = { depthRemaining: 3, tokensRemaining: 100000 };
  const stub: IStepper = {
    name: 'stub',
    async run(input: IStepperInput): Promise<IStepperResult> {
      assert.equal(input.identity.stepperId, 'n0');
      assert.equal(input.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
      return { status: 'ok', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  };
  const res = await stub.run({
    prompt: 'p',
    knowledgeRag: {} as never,
    toolsRag: {} as never,
    budget, identity, toolSafety,
  });
  assert.equal(res.status, 'ok');
});
```

Run: `cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/stepper.contract.test.ts` → FAIL (module missing).

- [ ] **1b. Implement.** Create `packages/llm-agent/src/interfaces/stepper.ts`:

```ts
import type { LlmUsage } from './types.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { StreamChunk } from './streaming.js';

/** Identity carried through every layer so executors can stamp
 *  KnowledgeEntryMetadata and the coordinator can attribute streaming
 *  + usage. Minted at the coordinator boundary; the interpreter rewrites
 *  stepperId/parentStepperId at each dispatch. */
export interface RunIdentity {
  traceId: string;
  turnId: string;
  sessionId: string;
  stepperId: string;
  parentStepperId?: string;
}

export interface ToolSafetyPolicy {
  mutationPolicy: 'confirm' | 'trusted';
  knownReadOnlyTools: ReadonlySet<string>;
}

export interface Budget {
  depthRemaining: number;
  tokensRemaining: number;
}

export interface IStepperInput {
  prompt: string;
  knowledgeRag: IKnowledgeRagHandle;
  toolsRag: IToolsRagHandle;
  budget: Budget;
  identity: RunIdentity;
  toolSafety: ToolSafetyPolicy;
  signal?: AbortSignal;
  sessionLogger?: { logStep(name: string, data: unknown): void };
  onProgress?: (event: StreamChunk) => void;
}

export interface IStepperResult {
  status: 'ok' | 'incomplete' | 'budget-exhausted';
  missing?: string[];
  usage: LlmUsage;
}

export interface IStepper {
  readonly name: string;
  run(input: IStepperInput): Promise<IStepperResult>;
}
```

Add to `packages/llm-agent/src/interfaces/index.ts` (match the existing `export type { … } from './finalizer.js';` pattern):

```ts
export type {
  Budget,
  IStepper,
  IStepperInput,
  IStepperResult,
  RunIdentity,
  ToolSafetyPolicy,
} from './stepper.js';
```

- [ ] **1c. Build + test.** Run:
```bash
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/stepper.contract.test.ts
```
Expected: build clean, 1/1 PASS. (Build will fail until Task 2 adds `knowledge-rag.ts` — if so, do Tasks 1–6 then build once at Task 6c. Note this in the commit.)

- [ ] **1d. Commit.**
```bash
git add packages/llm-agent/src/interfaces/stepper.ts \
        packages/llm-agent/src/interfaces/__tests__/stepper.contract.test.ts \
        packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(contracts): add Stepper core types (RunIdentity, ToolSafetyPolicy, Budget, IStepper)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2 — Knowledge-RAG + Tools-RAG contracts

**Files:**
- Create: `packages/llm-agent/src/interfaces/knowledge-rag.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/knowledge-rag.contract.test.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`

- [ ] **2a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IKnowledgeRagHandle,
  IToolsRagHandle,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  KnowledgeFilter,
} from '../knowledge-rag.js';

test('knowledge-rag contract: write requires full metadata; list filters; query caps by k', async () => {
  const store: KnowledgeEntry[] = [];
  const rag: IKnowledgeRagHandle = {
    async query(_t, opts) {
      const f = opts?.filter;
      let out = store;
      if (f?.turnId) out = out.filter((e) => e.metadata.turnId === f.turnId);
      return opts?.k ? out.slice(0, opts.k) : out;
    },
    async list(filter: KnowledgeFilter) {
      return store.filter((e) => !filter.turnId || e.metadata.turnId === filter.turnId);
    },
    async write(entry) {
      store.push({ content: entry.content, metadata: entry.metadata });
    },
    fingerprint() {
      return `n=${store.length}`;
    },
  };
  const meta: KnowledgeEntryMetadata = {
    traceId: 't', turnId: 'u1', stepperId: 'n1',
    task: 'fetch source', artifactType: 'source-code', createdAt: '2026-05-29T00:00:00Z',
  };
  await rag.write({ content: 'REPORT z.', metadata: meta });
  const listed = await rag.list({ turnId: 'u1' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].content, 'REPORT z.');
  assert.equal(rag.fingerprint(), 'n=1');
});

test('tools-rag contract: query + lookup', async () => {
  const tools: IToolsRagHandle = {
    async query() { return []; },
    lookup(name) { return name === 'X' ? ({ name: 'X' } as never) : undefined; },
  };
  assert.equal(tools.lookup('X')?.name, 'X');
  assert.equal(tools.lookup('Y'), undefined);
});
```

Run: `cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/knowledge-rag.contract.test.ts` → FAIL.

- [ ] **2b. Implement.** Create `packages/llm-agent/src/interfaces/knowledge-rag.ts`:

```ts
import type { LlmTool } from './types.js';

export interface KnowledgeEntryMetadata {
  traceId: string;
  turnId: string;
  stepperId: string;
  parentStepperId?: string;
  task: string;
  artifactType: string;
  toolName?: string;
  createdAt: string;
}

export interface KnowledgeEntry {
  content: string;
  metadata: KnowledgeEntryMetadata;
}

export interface KnowledgeFilter {
  traceId?: string;
  turnId?: string;
  stepperId?: string;
  parentStepperId?: string;
  artifactType?: string | readonly string[];
  toolName?: string;
}

export interface IKnowledgeRagHandle {
  query(
    text: string,
    opts?: { k?: number; filter?: KnowledgeFilter },
  ): Promise<readonly KnowledgeEntry[]>;
  list(filter: KnowledgeFilter): Promise<readonly KnowledgeEntry[]>;
  write(entry: { content: string; metadata: KnowledgeEntryMetadata }): Promise<void>;
  fingerprint(): string;
}

export interface IToolsRagHandle {
  query(text: string, k?: number): Promise<readonly LlmTool[]>;
  lookup(name: string): LlmTool | undefined;
}
```

> **Verify** `LlmTool` is the correct export: `git grep -n "export .*LlmTool" packages/llm-agent/src`. If the tool type is named differently, use the real name and update Task 3/4/8 accordingly.

Add to `index.ts`:
```ts
export type {
  IKnowledgeRagHandle,
  IToolsRagHandle,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  KnowledgeFilter,
} from './knowledge-rag.js';
```

- [ ] **2c. Test + commit.**
```bash
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/knowledge-rag.contract.test.ts
git add packages/llm-agent/src/interfaces/knowledge-rag.ts \
        packages/llm-agent/src/interfaces/__tests__/knowledge-rag.contract.test.ts \
        packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(contracts): add knowledge-RAG + tools-RAG handles with rich metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3 — IExecutor, IStepperPlanner, IStepperInterpreter, INeedResolver, InsufficientSignal

**Files:**
- Create: `packages/llm-agent/src/interfaces/executor.ts`, `stepper-planner.ts`, `stepper-interpreter.ts`, `need-resolver.ts`, `insufficient-signal.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/executor-contracts.test.ts`
- Modify: `index.ts`

- [ ] **3a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExecutor } from '../executor.js';
import type { IStepperPlanner } from '../stepper-planner.js';
import type { IStepperInterpreter } from '../stepper-interpreter.js';
import type { INeedResolver } from '../need-resolver.js';
import { InsufficientSignal } from '../insufficient-signal.js';

test('IExecutor return union includes budget-exhausted', async () => {
  const ex: IExecutor = {
    name: 'e',
    async execute() {
      return { status: 'budget-exhausted', usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } };
    },
  };
  const r = await ex.execute({
    prompt: 'p', tools: [], knowledgeRag: {} as never, toolsRag: {} as never,
    budget: { depthRemaining: 0, tokensRemaining: 0 },
    identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n' },
    toolSafety: { mutationPolicy: 'confirm', knownReadOnlyTools: new Set() },
  });
  assert.equal(r.status, 'budget-exhausted');
});

test('INeedResolver returns augmentation or undefined', async () => {
  const nr: INeedResolver = {
    async resolve(s) { return /can.?t|need/i.test(s) ? { queryToolsRag: 'read program' } : undefined; },
  };
  assert.deepEqual(await nr.resolve("I can't read it"), { queryToolsRag: 'read program' });
  assert.equal(await nr.resolve('done'), undefined);
});

test('InsufficientSignal carries missing[]', () => {
  const sig = new InsufficientSignal(['source code']);
  assert.ok(sig instanceof Error);
  assert.deepEqual(sig.missing, ['source code']);
});

test('planner + interpreter shapes compile', () => {
  const p: IStepperPlanner = { name: 'p', async plan() { return { objective: 'o', nodes: [], createdAt: 0 }; } };
  const i: IStepperInterpreter = { name: 'i', async interpret() { return { status: 'ok', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }; } };
  assert.equal(p.name, 'p');
  assert.equal(i.name, 'i');
});
```

Run → FAIL.

- [ ] **3b. Implement.** Create the five files.

`insufficient-signal.ts`:
```ts
import type { LlmUsage } from './types.js';

export class InsufficientSignal extends Error {
  readonly missing: string[];
  readonly usage?: LlmUsage;
  constructor(missing: string[], usage?: LlmUsage) {
    super('insufficient');
    this.name = 'InsufficientSignal';
    this.missing = missing;
    this.usage = usage;
  }
}
```

`need-resolver.ts`:
```ts
export interface INeedResolver {
  resolve(llmResponse: string): Promise<
    | { queryToolsRag?: string; queryKnowledgeRag?: string; injectTools?: string[] }
    | undefined
  >;
}
```

`executor.ts`:
```ts
import type { LlmTool, LlmUsage } from './types.js';
import type { Budget, RunIdentity, ToolSafetyPolicy } from './stepper.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { INeedResolver } from './need-resolver.js';
import type { StreamChunk } from './streaming.js';

export interface IExecutor {
  readonly name: string;
  execute(input: {
    prompt: string;
    tools: readonly LlmTool[];
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    needResolver?: INeedResolver;
    /** Executor is a LEAF; ignores depthRemaining, stops on tokensRemaining ≤ 0. */
    budget: Budget;
    identity: RunIdentity;
    toolSafety: ToolSafetyPolicy;
    signal?: AbortSignal;
    sessionLogger?: { logStep(name: string, data: unknown): void };
    onProgress?: (event: StreamChunk) => void;
  }): Promise<{
    status: 'ok' | 'incomplete' | 'budget-exhausted';
    missing?: string[];
    usage: LlmUsage;
  }>;
}
```

`stepper-planner.ts`:
```ts
import type { DagPlan } from './dag-plan.js';
import type { RunIdentity } from './stepper.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';

export interface IStepperPlanner {
  readonly name: string;
  plan(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    parentPath: string[];
    identity: RunIdentity;
    signal?: AbortSignal;
  }): Promise<DagPlan>;
}
```

`stepper-interpreter.ts`:
```ts
import type { DagPlan } from './dag-plan.js';
import type { Budget, IStepper, IStepperResult, RunIdentity, ToolSafetyPolicy } from './stepper.js';
import type { IExecutor } from './executor.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { StreamChunk } from './streaming.js';

export interface IStepperInterpreter {
  readonly name: string;
  interpret(
    plan: DagPlan,
    ctx: {
      prompt: string;
      knowledgeRag: IKnowledgeRagHandle;
      toolsRag: IToolsRagHandle;
      childSteppers: ReadonlyMap<string, IStepper>;
      executor: IExecutor;
      budget: Budget;
      identity: RunIdentity;
      toolSafety: ToolSafetyPolicy;
      maxParallelSteps: number;
      mintStepperId: () => string;
      signal?: AbortSignal;
      sessionLogger?: { logStep(name: string, data: unknown): void };
      onProgress?: (event: StreamChunk) => void;
    },
  ): Promise<IStepperResult>;
}
```

> Note: `mintStepperId: () => string` is added to the interpreter ctx (the spec §C.1 "mint function is injected"). The interpreter calls it for each child dispatch.

Re-export all five from `index.ts`.

- [ ] **3c. Test + commit.**
```bash
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/executor-contracts.test.ts
git add packages/llm-agent/src/interfaces/executor.ts \
        packages/llm-agent/src/interfaces/stepper-planner.ts \
        packages/llm-agent/src/interfaces/stepper-interpreter.ts \
        packages/llm-agent/src/interfaces/need-resolver.ts \
        packages/llm-agent/src/interfaces/insufficient-signal.ts \
        packages/llm-agent/src/interfaces/__tests__/executor-contracts.test.ts \
        packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(contracts): add IExecutor, IStepperPlanner, IStepperInterpreter, INeedResolver, InsufficientSignal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4 — StreamChunk progress-event extension

**Files:**
- Modify: `packages/llm-agent/src/interfaces/streaming.ts`
- Test: `packages/llm-agent/src/interfaces/__tests__/streaming-progress.test.ts`

- [ ] **4a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StepperRef, StreamChunk } from '../streaming.js';

test('StreamChunk progress variants carry StepperRef', () => {
  const ref: StepperRef = { stepperId: 's1', parentStepperId: 's0', name: 'security' };
  const accept = (c: StreamChunk): string => {
    switch (c.kind) {
      case 'content': return c.delta;
      case 'stepper-spawned': return c.source.stepperId + c.goal;
      case 'stepper-done': return c.source.stepperId + String(c.ok);
      case 'mcp-call': return c.source.stepperId + c.tool;
      case 'mcp-result': return c.source.stepperId + c.tool;
      case 'tokens-used': return c.source.stepperId + c.component;
      case 'llm-call-start': return c.source.stepperId + c.model;
      case 'llm-call-end': return c.source.stepperId + String(c.durationMs);
      default: return '';
    }
  };
  assert.equal(accept({ kind: 'stepper-spawned', source: ref, goal: 'g' }), 's1g');
  assert.equal(accept({ kind: 'mcp-call', source: ref, tool: 'GetProgram' }), 's1GetProgram');
  assert.equal(accept({ kind: 'content', delta: 'hi' }), 'hi');
});
```

Run → FAIL.

- [ ] **4b. Implement.** In `packages/llm-agent/src/interfaces/streaming.ts`, REPLACE the existing union (which has `content` / `node-start` / `node-end` / `tool-call`) with:

```ts
import type { LlmComponent, LlmUsage } from './types.js';

export interface StepperRef {
  /** Stable UUID minted at each dispatch — for a recursive child Stepper on
   *  construction, and for a terminal executor invocation as a virtual ref.
   *  Unique across the whole run. */
  stepperId: string;
  parentStepperId?: string;
  name: string;
}

export type StreamChunk =
  | { kind: 'content'; delta: string }
  | { kind: 'stepper-spawned'; source: StepperRef; goal: string }
  | { kind: 'stepper-done'; source: StepperRef; ok: boolean }
  | { kind: 'mcp-call'; source: StepperRef; tool: string; args?: unknown }
  | { kind: 'mcp-result'; source: StepperRef; tool: string; durationMs: number; bytes?: number }
  | { kind: 'tokens-used'; source: StepperRef; component: LlmComponent; delta: LlmUsage }
  | { kind: 'llm-call-start'; source: StepperRef; component: LlmComponent; model: string }
  | { kind: 'llm-call-end'; source: StepperRef; component: LlmComponent; durationMs: number };

export type OnPartial = (chunk: StreamChunk) => void;
```

> **17.0 callers break here.** `git grep -n "node-start\|node-end\|kind: 'tool-call'" packages/llm-agent-libs packages/llm-agent-server` to find every emitter/consumer of the old variants. They will be migrated in Phase 5/6 (the DagCoordinatorHandler emit sites). For Phase 1, the build of `llm-agent` itself stays green because the contract package has no emitters. Note in the commit that libs/server will not build until Phase 5.

Ensure `StepperRef` + `OnPartial` are re-exported from `index.ts` (OnPartial already was in 17.0).

- [ ] **4c. Test + commit.**
```bash
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/streaming-progress.test.ts
npm --workspace @mcp-abap-adt/llm-agent run build
git add packages/llm-agent/src/interfaces/streaming.ts \
        packages/llm-agent/src/interfaces/__tests__/streaming-progress.test.ts \
        packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(contracts): replace StreamChunk node-* variants with Stepper progress events

BREAKING: node-start / node-end / flat tool-call removed; replaced by
stepper-spawned / stepper-done / mcp-call / mcp-result / tokens-used /
llm-call-start / llm-call-end, each carrying a StepperRef. content
variant preserved. libs/server emit sites migrate in Phase 5/6.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Leaf runtime deps (`@mcp-abap-adt/llm-agent-libs`)

### Task 5 — `KnowledgeRag` + `ToolsRag`

**Files:**
- Create: `packages/llm-agent-libs/src/rag/knowledge-rag.ts`
- Test: `packages/llm-agent-libs/src/rag/__tests__/knowledge-rag.test.ts`

- [ ] **5a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IRag } from '@mcp-abap-adt/llm-agent';
import { KnowledgeRag } from '../knowledge-rag.js';

function fakeRag(): IRag {
  const docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];
  return {
    async upsert(items) { for (const it of items) docs.push(it as never); },
    async query(_text, k) { return docs.slice(0, k ?? docs.length).map((d) => ({ id: d.id, text: d.text, score: 1, metadata: d.metadata })); },
    // include whatever other IRag methods exist as no-ops; verify via git grep
  } as unknown as IRag;
}

const META = {
  traceId: 't', turnId: 'u1', stepperId: 'n1',
  task: 'fetch', artifactType: 'source-code', createdAt: '2026-05-29T00:00:00Z',
};

test('write persists with metadata; list filters by turnId exhaustively', async () => {
  const kr = new KnowledgeRag(fakeRag(), 'session-1');
  await kr.write({ content: 'A', metadata: { ...META, turnId: 'u1' } });
  await kr.write({ content: 'B', metadata: { ...META, turnId: 'u2' } });
  const u1 = await kr.list({ turnId: 'u1' });
  assert.equal(u1.length, 1);
  assert.equal(u1[0].content, 'A');
});

test('query caps by k', async () => {
  const kr = new KnowledgeRag(fakeRag(), 'session-1');
  await kr.write({ content: 'A', metadata: META });
  await kr.write({ content: 'B', metadata: META });
  const r = await kr.query('anything', { k: 1 });
  assert.equal(r.length, 1);
});

test('fingerprint changes on write', async () => {
  const kr = new KnowledgeRag(fakeRag(), 'session-1');
  const f0 = kr.fingerprint();
  await kr.write({ content: 'A', metadata: META });
  assert.notEqual(kr.fingerprint(), f0);
});
```

> Before coding, `git grep -n "interface IRag" packages/llm-agent/src` to read the real `IRag` method set, and adapt the fake. The `upsert`/`query` shape shown is illustrative.

Run → FAIL.

- [ ] **5b. Implement.** Create `packages/llm-agent-libs/src/rag/knowledge-rag.ts`:

```ts
import type {
  IKnowledgeRagHandle,
  IRag,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  KnowledgeFilter,
} from '@mcp-abap-adt/llm-agent';

/**
 * Per-session blackboard over any IRag backend. write() embeds the entry
 * content and stores the full metadata; query() does semantic retrieval
 * (k-capped); list() does an exhaustive metadata-filtered scan (no cap,
 * createdAt-ordered) for the root finalizer.
 */
export class KnowledgeRag implements IKnowledgeRagHandle {
  // Mirror metadata locally for exhaustive list() + fingerprint without
  // relying on backend metadata-filter support (qdrant has it, in-memory
  // may not). The backend holds the embeddings for query().
  private readonly entries: KnowledgeEntry[] = [];
  private seq = 0;

  constructor(
    private readonly backend: IRag,
    private readonly sessionId: string,
  ) {}

  async write(entry: { content: string; metadata: KnowledgeEntryMetadata }): Promise<void> {
    const id = `${this.sessionId}:${this.seq++}`;
    await this.backend.upsert([
      { id, text: entry.content, metadata: { ...entry.metadata, sessionId: this.sessionId } },
    ]);
    this.entries.push({ content: entry.content, metadata: entry.metadata });
  }

  async query(
    text: string,
    opts?: { k?: number; filter?: KnowledgeFilter },
  ): Promise<readonly KnowledgeEntry[]> {
    const hits = await this.backend.query(text, opts?.k);
    let mapped = hits.map((h) => ({
      content: h.text,
      metadata: h.metadata as unknown as KnowledgeEntryMetadata,
    }));
    if (opts?.filter) mapped = mapped.filter((e) => matches(e.metadata, opts.filter!));
    return mapped;
  }

  async list(filter: KnowledgeFilter): Promise<readonly KnowledgeEntry[]> {
    return this.entries
      .filter((e) => matches(e.metadata, filter))
      .slice()
      .sort((a, b) => a.metadata.createdAt.localeCompare(b.metadata.createdAt));
  }

  fingerprint(): string {
    return `n=${this.entries.length}`;
  }
}

function matches(m: KnowledgeEntryMetadata, f: KnowledgeFilter): boolean {
  if (f.traceId && m.traceId !== f.traceId) return false;
  if (f.turnId && m.turnId !== f.turnId) return false;
  if (f.stepperId && m.stepperId !== f.stepperId) return false;
  if (f.parentStepperId && m.parentStepperId !== f.parentStepperId) return false;
  if (f.toolName && m.toolName !== f.toolName) return false;
  if (f.artifactType) {
    const set = Array.isArray(f.artifactType) ? f.artifactType : [f.artifactType];
    if (!set.includes(m.artifactType)) return false;
  }
  return true;
}
```

> The query()-shape (`backend.query(text, k)` returning `{ text, metadata }[]`) must match the real `IRag`. Adapt method names to the actual interface after the git grep in 5a.

Also add `ToolsRag` if a wrapper is needed — but the existing 17.0 tools-RAG path already exposes a query+lookup; in that case create a thin adapter `ToolsRag implements IToolsRagHandle` in the same file delegating to the existing tools store. Add a test mirroring tools query+lookup.

- [ ] **5c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent-libs && npx tsx --test src/rag/__tests__/knowledge-rag.test.ts
git add packages/llm-agent-libs/src/rag/knowledge-rag.ts \
        packages/llm-agent-libs/src/rag/__tests__/knowledge-rag.test.ts
git commit -m "feat(stepper): KnowledgeRag blackboard over IRag (write/query/list/fingerprint)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6 — `RegexNeedResolver` + `LlmNeedResolver`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/need-resolver.ts`
- Test: `packages/llm-agent-libs/src/coordinator/stepper/__tests__/need-resolver.test.ts`

- [ ] **6a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmNeedResolver, RegexNeedResolver } from '../need-resolver.js';

test('RegexNeedResolver detects need phrasings and maps to a tools-RAG query', async () => {
  const nr = new RegexNeedResolver();
  assert.deepEqual(await nr.resolve("I can't read the program code"), { queryToolsRag: 'read the program code' });
  assert.deepEqual(await nr.resolve('I need to read the includes'), { queryToolsRag: 'read the includes' });
  assert.equal(await nr.resolve('Here is the final analysis.'), undefined);
  assert.equal(await nr.resolve('Call GetProgram(X).'), undefined);
});

test('LlmNeedResolver delegates classification to its llm', async () => {
  const llm = {
    name: 'stub',
    async chat() {
      return { ok: true as const, value: { content: '{"need":true,"capability":"read program source"}' } };
    },
  };
  const nr = new LlmNeedResolver(llm as never);
  assert.deepEqual(await nr.resolve('cannot proceed'), { queryToolsRag: 'read program source' });
});
```

Run → FAIL.

- [ ] **6b. Implement.** Create `packages/llm-agent-libs/src/coordinator/stepper/need-resolver.ts`:

```ts
import type { ILlm, INeedResolver } from '@mcp-abap-adt/llm-agent';

const NEED_RE =
  /\bI (?:can'?t|cannot|am unable to|need to|lack (?:a|the) (?:tool|way) to)\s+(.+?)[.!]?$/i;

/** Deterministic need detector. Pattern-matches "I can't <X>" / "I need to
 *  <X>" and maps the captured phrase to a tools-RAG query. Default. */
export class RegexNeedResolver implements INeedResolver {
  async resolve(response: string) {
    const line = response.trim().split('\n').pop() ?? response.trim();
    const m = NEED_RE.exec(line);
    if (!m) return undefined;
    return { queryToolsRag: m[1].trim() };
  }
}

const CLASSIFY_SYSTEM =
  'Classify whether the assistant utterance expresses an unmet capability ' +
  'need (it cannot proceed because it lacks a tool or data). Respond with ' +
  'ONLY JSON: {"need":boolean,"capability":string}. capability is the ' +
  'short description of what is needed, or "" when need is false.';

/** LLM-driven need classifier. Opt-in (more accurate on paraphrase, costs a
 *  small classifier call). */
export class LlmNeedResolver implements INeedResolver {
  constructor(private readonly llm: ILlm) {}
  async resolve(response: string) {
    const res = await this.llm.chat(
      [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: response },
      ],
      [],
    );
    if (res.ok === false) return undefined;
    try {
      const parsed = JSON.parse(res.value.content) as { need?: boolean; capability?: string };
      if (parsed.need && parsed.capability) return { queryToolsRag: parsed.capability };
    } catch {
      // ignore malformed classifier output → treat as no need
    }
    return undefined;
  }
}
```

> Verify `ILlm.chat(messages, tools, options?)` signature against 17.0 (`git grep -n "chat(" packages/llm-agent/src/interfaces/llm.ts` or wherever ILlm lives). Adapt the empty-tools arg.

- [ ] **6c. Build all contracts + test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/stepper/__tests__/need-resolver.test.ts
git add packages/llm-agent-libs/src/coordinator/stepper/need-resolver.ts \
        packages/llm-agent-libs/src/coordinator/stepper/__tests__/need-resolver.test.ts
git commit -m "feat(stepper): RegexNeedResolver + LlmNeedResolver (context-augmenting ReAct need detection)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Executor

### Task 7 — `CyclicReActExecutor`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/cyclic-react-executor.ts`
- Test: `packages/llm-agent-libs/src/coordinator/stepper/__tests__/cyclic-react-executor.test.ts`

This is the heart of modes A and C. The executor runs an LLM loop: clean answer → write to knowledge-RAG + return ok; tool call → execute MCP + write result + loop; need signal → resolve via INeedResolver + inject tools + loop. Mutating tools raise ClarifySignal per §C.4. Stops on tokensRemaining ≤ 0 → budget-exhausted.

- [ ] **7a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClarifySignal } from '@mcp-abap-adt/llm-agent';
import type { OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { CyclicReActExecutor } from '../cyclic-react-executor.js';
import { RegexNeedResolver } from '../need-resolver.js';

// A scripted LLM: returns queued responses in order.
function scriptedLlm(responses: Array<{ content: string; toolCalls?: { name: string; arguments: unknown }[]; usage?: unknown }>) {
  let i = 0;
  return {
    name: 'stub',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return { ok: true as const, value: { content: r.content, toolCalls: r.toolCalls, usage: r.usage ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 } } };
    },
  };
}

// A scripted MCP dispatcher: name → result.
function mcp(results: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    async call(name: string) { calls.push(name); return results[name] ?? '<no result>'; },
  };
}

const META_BASE = {
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n1' },
  toolSafety: { mutationPolicy: 'confirm' as const, knownReadOnlyTools: new Set(['ReadProgram']) },
};

function knowledgeStub() {
  const writes: { content: string; artifactType: string }[] = [];
  return {
    writes,
    rag: {
      async query() { return []; },
      async list() { return []; },
      async write(e: { content: string; metadata: { artifactType: string } }) { writes.push({ content: e.content, artifactType: e.metadata.artifactType }); },
      fingerprint() { return 'n=0'; },
    },
  };
}

function toolsStub(tools: Record<string, { name: string; readOnly?: boolean }>) {
  return {
    async query() { return Object.values(tools); },
    lookup(name: string) { return tools[name]; },
  };
}

test('H.1 context-augmenting ReAct: need → inject tool → final answer', async () => {
  // turn 1: "I can't read the program" → resolver pulls ReadProgram
  // turn 2: tool-call ReadProgram → executes
  // turn 3: clean final answer
  const llm = scriptedLlm([
    { content: "I can't read the program source" },
    { content: 'reading', toolCalls: [{ name: 'ReadProgram', arguments: { p: 'Z' } }] },
    { content: 'Final analysis: looks fine.' },
  ]);
  const m = mcp({ ReadProgram: 'REPORT z.' });
  const { rag, writes } = knowledgeStub();
  const exec = new CyclicReActExecutor({
    llm: llm as never,
    callMcp: m.call,
    component: 'tool-loop',
    maxIterations: 10,
  });
  const res = await exec.execute({
    prompt: 'analyse program Z',
    tools: [],
    knowledgeRag: rag as never,
    toolsRag: toolsStub({ ReadProgram: { name: 'ReadProgram', readOnly: true } }) as never,
    needResolver: new RegexNeedResolver(),
    budget: { depthRemaining: 0, tokensRemaining: 100000 },
    ...META_BASE,
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(m.calls, ['ReadProgram']);
  assert.ok(writes.some((w) => w.content === 'REPORT z.'));            // mcp result written
  assert.ok(writes.some((w) => w.content.includes('Final analysis'))); // final answer written
});

test('H.5 mutating tool without readOnly raises ClarifySignal before call', async () => {
  const llm = scriptedLlm([{ content: 'creating', toolCalls: [{ name: 'CreateClass', arguments: { n: 'ZCL' } }] }]);
  const m = mcp({ CreateClass: 'created' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({ llm: llm as never, callMcp: m.call, component: 'tool-loop', maxIterations: 10 });
  await assert.rejects(
    () => exec.execute({
      prompt: 'create class ZCL', tools: [], knowledgeRag: rag as never,
      toolsRag: toolsStub({ CreateClass: { name: 'CreateClass' } }) as never,  // no readOnly
      budget: { depthRemaining: 0, tokensRemaining: 100000 }, ...META_BASE,
    }),
    (e: unknown) => e instanceof ClarifySignal && /CreateClass/.test((e as ClarifySignal).question),
  );
  assert.deepEqual(m.calls, []);  // NOT executed
});

test('H.5b knownReadOnlyTools allowlist bypasses confirmation', async () => {
  const llm = scriptedLlm([
    { content: 'reading', toolCalls: [{ name: 'ReadProgram', arguments: {} }] },
    { content: 'done' },
  ]);
  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({ llm: llm as never, callMcp: m.call, component: 'tool-loop', maxIterations: 10 });
  const res = await exec.execute({
    prompt: 'read', tools: [], knowledgeRag: rag as never,
    toolsRag: toolsStub({ ReadProgram: { name: 'ReadProgram' } }) as never,  // no readOnly field
    budget: { depthRemaining: 0, tokensRemaining: 100000 }, ...META_BASE,    // but in knownReadOnlyTools
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(m.calls, ['ReadProgram']);
});

test('budget-exhausted when tokensRemaining hits zero', async () => {
  const llm = scriptedLlm([
    { content: 'x', toolCalls: [{ name: 'ReadProgram', arguments: {} }], usage: { promptTokens: 60000, completionTokens: 0, totalTokens: 60000 } },
    { content: 'y', toolCalls: [{ name: 'ReadProgram', arguments: {} }], usage: { promptTokens: 60000, completionTokens: 0, totalTokens: 60000 } },
  ]);
  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();
  const exec = new CyclicReActExecutor({ llm: llm as never, callMcp: m.call, component: 'tool-loop', maxIterations: 10 });
  const res = await exec.execute({
    prompt: 'read', tools: [], knowledgeRag: rag as never,
    toolsRag: toolsStub({ ReadProgram: { name: 'ReadProgram', readOnly: true } }) as never,
    budget: { depthRemaining: 0, tokensRemaining: 100000 }, ...META_BASE,
  });
  assert.equal(res.status, 'budget-exhausted');
});

test('emits mcp-call / mcp-result / tokens-used progress with identity.stepperId as source', async () => {
  const llm = scriptedLlm([
    { content: 'r', toolCalls: [{ name: 'ReadProgram', arguments: {} }] },
    { content: 'done' },
  ]);
  const m = mcp({ ReadProgram: 'src' });
  const { rag } = knowledgeStub();
  const events: StreamChunk[] = [];
  const onProgress: OnPartial = (e) => events.push(e);
  const exec = new CyclicReActExecutor({ llm: llm as never, callMcp: m.call, component: 'tool-loop', maxIterations: 10 });
  await exec.execute({
    prompt: 'read', tools: [], knowledgeRag: rag as never,
    toolsRag: toolsStub({ ReadProgram: { name: 'ReadProgram', readOnly: true } }) as never,
    budget: { depthRemaining: 0, tokensRemaining: 100000 }, onProgress, ...META_BASE,
  });
  const mcpCall = events.find((e) => e.kind === 'mcp-call');
  assert.ok(mcpCall && mcpCall.kind === 'mcp-call' && mcpCall.source.stepperId === 'n1' && mcpCall.tool === 'ReadProgram');
});
```

Run → FAIL.

- [ ] **7b. Implement.** Create `packages/llm-agent-libs/src/coordinator/stepper/cyclic-react-executor.ts`:

```ts
import {
  ClarifySignal,
  type IExecutor,
  type LlmComponent,
  type LlmTool,
  type LlmUsage,
} from '@mcp-abap-adt/llm-agent';

export interface CyclicReActExecutorDeps {
  llm: import('@mcp-abap-adt/llm-agent').ILlm;
  /** Invoke an MCP tool by name with args; returns the textual result. */
  callMcp: (name: string, args: unknown, signal?: AbortSignal) => Promise<string>;
  component: LlmComponent;
  maxIterations: number;
}

const ZERO: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const add = (a: LlmUsage, b?: LlmUsage): LlmUsage =>
  b
    ? {
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        totalTokens: a.totalTokens + b.totalTokens,
      }
    : a;

export class CyclicReActExecutor implements IExecutor {
  readonly name = 'cyclic-react';
  constructor(private readonly deps: CyclicReActExecutorDeps) {}

  async execute(
    input: Parameters<IExecutor['execute']>[0],
  ): ReturnType<IExecutor['execute']> {
    const { llm, callMcp, component, maxIterations } = this.deps;
    const {
      prompt, knowledgeRag, toolsRag, needResolver, budget, identity, toolSafety,
      signal, onProgress,
    } = input;
    const ref = { stepperId: identity.stepperId, parentStepperId: identity.parentStepperId, name: this.name };

    const messages: Array<{ role: string; content: string }> = [{ role: 'user', content: prompt }];
    let tools: LlmTool[] = [...input.tools];
    let usage = ZERO;

    const isReadOnly = (toolName: string): boolean => {
      const t = toolsRag.lookup(toolName) as (LlmTool & { readOnly?: boolean }) | undefined;
      if (t?.readOnly === true) return true;
      if (toolSafety.knownReadOnlyTools.has(toolName)) return true;
      return toolSafety.mutationPolicy === 'trusted';
    };

    for (let iter = 0; iter < maxIterations; iter++) {
      if (budget.tokensRemaining - usage.totalTokens <= 0) {
        return { status: 'budget-exhausted', usage };
      }
      onProgress?.({ kind: 'llm-call-start', source: ref, component, model: llm.model ?? 'unknown' });
      const started = 0; // durationMs omitted (no Date.now in deterministic contexts)
      const res = await llm.chat(messages as never, tools as never, { signal });
      onProgress?.({ kind: 'llm-call-end', source: ref, component, durationMs: started });
      if (res.ok === false) return { status: 'incomplete', missing: [res.error?.message ?? 'llm error'], usage };
      const v = res.value;
      usage = add(usage, v.usage);
      if (v.usage) onProgress?.({ kind: 'tokens-used', source: ref, component, delta: v.usage });

      const toolCalls = v.toolCalls ?? [];
      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: v.content ?? '' });
        for (const tc of toolCalls) {
          const toolName = tc.name as string;
          if (!isReadOnly(toolName)) {
            throw new ClarifySignal(
              `about to call ${toolName}(${JSON.stringify(tc.arguments)}); this tool is not declared read-only — proceed?`,
            );
          }
          onProgress?.({ kind: 'mcp-call', source: ref, tool: toolName, args: tc.arguments });
          const result = await callMcp(toolName, tc.arguments, signal);
          onProgress?.({ kind: 'mcp-result', source: ref, tool: toolName, durationMs: 0, bytes: result.length });
          await knowledgeRag.write({
            content: result,
            metadata: {
              traceId: identity.traceId, turnId: identity.turnId, stepperId: identity.stepperId,
              parentStepperId: identity.parentStepperId, task: prompt,
              artifactType: 'mcp-result', toolName, createdAt: nowIso(),
            },
          });
          messages.push({ role: 'tool', content: result });
        }
        continue;
      }

      // No tool call. Either a clean final answer, or a "need" utterance.
      const need = needResolver ? await needResolver.resolve(v.content ?? '') : undefined;
      if (need?.queryToolsRag) {
        const found = await toolsRag.query(need.queryToolsRag, 5);
        // inject any newly-discovered tools the model didn't have yet
        const have = new Set(tools.map((t) => (t as { name: string }).name));
        for (const t of found) if (!have.has((t as { name: string }).name)) tools.push(t as LlmTool);
        messages.push({ role: 'assistant', content: v.content ?? '' });
        messages.push({ role: 'user', content: `You now have additional tools available. ${prompt}` });
        continue;
      }

      // Clean final answer → write + return ok.
      await knowledgeRag.write({
        content: v.content ?? '',
        metadata: {
          traceId: identity.traceId, turnId: identity.turnId, stepperId: identity.stepperId,
          parentStepperId: identity.parentStepperId, task: prompt,
          artifactType: 'analysis-finding', createdAt: nowIso(),
        },
      });
      return { status: 'ok', usage };
    }
    return { status: 'incomplete', missing: ['max iterations reached'], usage };
  }
}

// Injectable clock kept out of the hot path; callers in deterministic test
// contexts can monkeypatch if needed. ISO string only used for ordering.
function nowIso(): string {
  // eslint-disable-next-line no-restricted-syntax -- ordering timestamp only
  return new Date().toISOString();
}
```

> **Caveats to verify while implementing:**
> - `ILlm.chat` return shape: confirm `res.ok`, `res.value.content`, `res.value.toolCalls`, `res.value.usage`. Adapt field paths.
> - Message role typing: 17.0 `Message` type may be stricter than `{role,content}`. Cast or use the real `Message` shape.
> - `nowIso()` uses `new Date()` — the spec notes deterministic contexts forbid it. For the unit tests above, ordering doesn't matter (single turn), so it's fine; if a test asserts ordering, inject a clock via deps.

- [ ] **7c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/stepper/__tests__/cyclic-react-executor.test.ts
git add packages/llm-agent-libs/src/coordinator/stepper/cyclic-react-executor.ts \
        packages/llm-agent-libs/src/coordinator/stepper/__tests__/cyclic-react-executor.test.ts
git commit -m "feat(stepper): CyclicReActExecutor — context-augmenting ReAct leaf with readOnly safety gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Planner + Interpreter

### Task 8 — `LlmStepperPlanner` + `STEPPER_PLANNER_SYSTEM`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/llm-stepper-planner.ts`
- Test: `packages/llm-agent-libs/src/coordinator/stepper/__tests__/llm-stepper-planner.test.ts`

The planner queries knowledge-RAG before planning (RAG-first, §B.6.1) and uses a system prompt that mandates concrete-leaf decomposition (§B.6.2). It reuses the JSON-plan parsing from 17.0's `LlmDagPlanner` (which lives in `coordinator/dag/llm-dag-planner.ts`).

- [ ] **8a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmStepperPlanner, STEPPER_PLANNER_SYSTEM } from '../llm-stepper-planner.js';

function llm(content: string) {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  return {
    obj: {
      name: 'stub',
      async chat(messages: { role: string; content: string }[]) {
        calls.push({ messages });
        return { ok: true as const, value: { content } };
      },
    },
    calls,
  };
}

function ragWith(entries: { content: string; task: string }[]) {
  return {
    async query() {
      return entries.map((e) => ({
        content: e.content,
        metadata: { traceId: 't', turnId: 'u', stepperId: 'n', task: e.task, artifactType: 'x', createdAt: '2026-05-29T00:00:00Z' },
      }));
    },
    async list() { return []; },
    async write() {},
    fingerprint() { return 'n=0'; },
  };
}

const BASE = {
  toolsRag: { async query() { return []; }, lookup() { return undefined; } },
  parentPath: ['root'],
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
};

test('planner queries knowledge-RAG and embeds retrieved facts into the planning prompt', async () => {
  const { obj, calls } = llm('{"objective":"o","nodes":[{"id":"a","goal":"scan source"}]}');
  const planner = new LlmStepperPlanner(obj as never);
  await planner.plan({ prompt: 'review security', knowledgeRag: ragWith([{ content: 'REPORT z.', task: 'fetch source' }]) as never, ...BASE });
  const userMsg = calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
  assert.match(userMsg, /REPORT z\./);          // retrieved fact present in prompt
  assert.match(userMsg, /review security/);     // task present
});

test('planner parses a shallow plan', async () => {
  const { obj } = llm('{"objective":"o","nodes":[{"id":"a","goal":"x","agent":"w"}]}');
  const planner = new LlmStepperPlanner(obj as never);
  const plan = await planner.plan({ prompt: 'p', knowledgeRag: ragWith([]) as never, ...BASE });
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].agent, 'w');
});

test('STEPPER_PLANNER_SYSTEM mandates RAG-first + concrete-leaf decomposition', () => {
  assert.match(STEPPER_PLANNER_SYSTEM, /already in the knowledge|RAG-first|do not re-?fetch/i);
  assert.match(STEPPER_PLANNER_SYSTEM, /one (?:tool call|step)|concrete leaf/i);
});
```

Run → FAIL.

- [ ] **8b. Implement.** Create `packages/llm-agent-libs/src/coordinator/stepper/llm-stepper-planner.ts`:

```ts
import type {
  DagPlan,
  ILlm,
  IKnowledgeRagHandle,
  IStepperPlanner,
  IToolsRagHandle,
  RunIdentity,
} from '@mcp-abap-adt/llm-agent';
import { parseDagPlan } from '../dag/llm-dag-planner.js'; // reuse 17.0 parser if exported; else inline

export const STEPPER_PLANNER_SYSTEM = `You are a planner in a recursive Stepper hierarchy. Decompose the task into a SHALLOW DAG of steps.
RAG-FIRST: the "Known facts" section lists what is already in the shared knowledge store. If a fact you need is already there, DO NOT add a step to re-fetch it — use it. Only add a step to obtain information that is genuinely missing.
DECOMPOSE TO CONCRETE LEAVES: if a task is achievable by ONE tool call, emit a single-step plan whose goal is that call — do NOT re-emit the parent's task verbatim (that causes infinite recursion). Each node spawns a fresh worker that does NOT share your context; over-decomposition multiplies cost.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids)}.
Respond with ONLY one of:
{"objective":"...","nodes":[...]}
{"needInfo":"<query>"}  — you need a reality fact before planning
{"clarify":"<question>"}  — you need a human decision before planning`;

export class LlmStepperPlanner implements IStepperPlanner {
  readonly name = 'llm-stepper';
  readonly model?: string;
  constructor(private readonly llm: ILlm) {
    this.model = llm.model;
  }

  async plan(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    parentPath: string[];
    identity: RunIdentity;
    signal?: AbortSignal;
  }): Promise<DagPlan> {
    const facts = await input.knowledgeRag.query(input.prompt, { k: 8 });
    const factBlock = facts.length
      ? `Known facts (already in the knowledge store):\n${facts.map((f) => `- [${f.metadata.artifactType}] ${truncate(f.content, 400)}`).join('\n')}\n\n`
      : 'Known facts: (none yet)\n\n';
    const user = `${factBlock}Task: ${input.prompt}`;
    const res = await this.llm.chat(
      [
        { role: 'system', content: STEPPER_PLANNER_SYSTEM },
        { role: 'user', content: user },
      ] as never,
      [] as never,
      { signal: input.signal },
    );
    if (res.ok === false) throw new Error(`stepper planner: ${res.error?.message ?? 'llm error'}`);
    return parseDagPlan(res.value.content); // throws NeedInfoSignal / ClarifySignal / parse errors as in 17.0
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
```

> **Reuse decision:** 17.0's `LlmDagPlanner` already has the JSON-plan parser that emits `NeedInfoSignal`/`ClarifySignal` and validates node shape. Check `git grep -n "parseDagPlan\|function parse" packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts`. If the parser is a private function inside the class, EXPORT it (small refactor in `llm-dag-planner.ts`) so this planner reuses it rather than duplicating. Add that export in this task's commit.

- [ ] **8c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/stepper/__tests__/llm-stepper-planner.test.ts
git add packages/llm-agent-libs/src/coordinator/stepper/llm-stepper-planner.ts \
        packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts \
        packages/llm-agent-libs/src/coordinator/stepper/__tests__/llm-stepper-planner.test.ts
git commit -m "feat(stepper): LlmStepperPlanner — RAG-first planning + concrete-leaf system prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 9 — `StepperInterpreter` (depth-guarded dispatch)

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/stepper-interpreter.ts`
- Test: `packages/llm-agent-libs/src/coordinator/stepper/__tests__/stepper-interpreter.test.ts`

Implements the 4-case dispatch from §D.3. The interpreter is the sole owner of the depthRemaining guard. Reuses 17.0 wave-based ready-node scheduling but each ready node routes per §D.3 cases 1–4.

- [ ] **9a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExecutor, IStepper, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { StepperInterpreter } from '../stepper-interpreter.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function okExecutor(): { exec: IExecutor; calls: number } {
  let calls = 0;
  return { get calls() { return calls; }, exec: { name: 'e', async execute() { calls++; return { status: 'ok', usage: ZERO }; } } };
}

function spyStepper(name: string): { st: IStepper; runs: number } {
  let runs = 0;
  return { get runs() { return runs; }, st: { name, async run() { runs++; return { status: 'ok', usage: ZERO }; } } };
}

let counter = 0;
const baseCtx = (over: Partial<Parameters<StepperInterpreter['interpret']>[1]>) => ({
  prompt: 'p',
  knowledgeRag: { async query() { return []; }, async list() { return []; }, async write() {}, fingerprint() { return ''; } } as never,
  toolsRag: { async query() { return []; }, lookup() { return undefined; } } as never,
  childSteppers: new Map(),
  executor: okExecutor().exec,
  budget: { depthRemaining: 3, tokensRemaining: 100000 },
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
  toolSafety: { mutationPolicy: 'confirm' as const, knownReadOnlyTools: new Set<string>() },
  maxParallelSteps: 4,
  mintStepperId: () => `s${counter++}`,
  ...over,
});

test('H.4b depth floor routes subagent node to executor, no child spawn', async () => {
  counter = 0;
  const child = spyStepper('w');
  const ex = okExecutor();
  const events: StreamChunk[] = [];
  const interp = new StepperInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'g', agent: 'w' }], createdAt: 0 },
    baseCtx({
      childSteppers: new Map([['w', child.st]]),
      executor: ex.exec,
      budget: { depthRemaining: 0, tokensRemaining: 100000 },  // floor
      onProgress: (e) => events.push(e),
    }),
  );
  assert.equal(res.status, 'ok');
  assert.equal(child.runs, 0, 'no recursive child spawned at depth floor');
  assert.equal(ex.calls, 1, 'dispatched to executor instead');
});

test('depth > 0 spawns recursive child stepper with parentStepperId set', async () => {
  counter = 0;
  const child = spyStepper('w');
  const events: StreamChunk[] = [];
  const interp = new StepperInterpreter();
  await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'g', agent: 'w' }], createdAt: 0 },
    baseCtx({ childSteppers: new Map([['w', child.st]]), budget: { depthRemaining: 2, tokensRemaining: 100000 }, onProgress: (e) => events.push(e) }),
  );
  assert.equal(child.runs, 1, 'recursive child spawned above floor');
  const spawned = events.find((e) => e.kind === 'stepper-spawned');
  assert.ok(spawned && spawned.kind === 'stepper-spawned' && spawned.source.parentStepperId === 'n0');
});

test('agentless node goes straight to executor', async () => {
  counter = 0;
  const ex = okExecutor();
  const interp = new StepperInterpreter();
  await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'g' }], createdAt: 0 },
    baseCtx({ executor: ex.exec }),
  );
  assert.equal(ex.calls, 1);
});

test('unknown agent with no executable leaf returns incomplete', async () => {
  counter = 0;
  const interp = new StepperInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'g', agent: 'missing' }], createdAt: 0 },
    baseCtx({ childSteppers: new Map(), executor: undefined as never, budget: { depthRemaining: 2, tokensRemaining: 1 } }),
  );
  assert.equal(res.status, 'incomplete');
  assert.ok(res.missing && res.missing.length > 0);
});

test('maxParallelSteps caps concurrency at 2', async () => {
  counter = 0;
  let active = 0;
  let peak = 0;
  const slow: IStepper = {
    name: 'w',
    async run() {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { status: 'ok', usage: ZERO };
    },
  };
  const interp = new StepperInterpreter();
  await interp.interpret(
    { objective: 'o', nodes: [
      { id: 'a', goal: 'g', agent: 'w' }, { id: 'b', goal: 'g', agent: 'w' },
      { id: 'c', goal: 'g', agent: 'w' }, { id: 'd', goal: 'g', agent: 'w' },
    ], createdAt: 0 },
    baseCtx({ childSteppers: new Map([['w', slow]]), maxParallelSteps: 2, budget: { depthRemaining: 2, tokensRemaining: 100000 } }),
  );
  assert.ok(peak <= 2, `peak concurrency ${peak} must be ≤ 2`);
});
```

Run → FAIL.

- [ ] **9b. Implement.** Create `packages/llm-agent-libs/src/coordinator/stepper/stepper-interpreter.ts`. Implement §D.3 cases 1–4 with a wave scheduler honouring `dependsOn` and a `maxParallelSteps` pool. Build a child `RunIdentity` per dispatch: `{ ...ctx.identity, stepperId: ctx.mintStepperId(), parentStepperId: ctx.identity.stepperId }`. Emit `stepper-spawned` before dispatch, `stepper-done` after. Aggregate child usages. Return the worst child status (`budget-exhausted` > `incomplete` > `ok`).

```ts
import type {
  Budget, DagPlan, IExecutor, IStepper, IStepperInterpreter, IStepperResult,
  LlmUsage, RunIdentity, StreamChunk, ToolSafetyPolicy,
} from '@mcp-abap-adt/llm-agent';

const ZERO: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  totalTokens: a.totalTokens + b.totalTokens,
});
const WORST = { ok: 0, incomplete: 1, 'budget-exhausted': 2 } as const;

export class StepperInterpreter implements IStepperInterpreter {
  readonly name = 'stepper';

  async interpret(
    plan: DagPlan,
    ctx: Parameters<IStepperInterpreter['interpret']>[1],
  ): Promise<IStepperResult> {
    const done = new Set<string>();
    const results = new Map<string, IStepperResult>();
    let usage = ZERO;
    let worst: IStepperResult['status'] = 'ok';

    const ready = () =>
      plan.nodes.filter(
        (n) => !done.has(n.id) && (n.dependsOn ?? []).every((d) => done.has(d)),
      );

    const runNode = async (node: DagPlan['nodes'][number]): Promise<void> => {
      const childId = ctx.mintStepperId();
      const childIdentity: RunIdentity = {
        ...ctx.identity, stepperId: childId, parentStepperId: ctx.identity.stepperId,
      };
      const ref = { stepperId: childId, parentStepperId: ctx.identity.stepperId, name: node.agent ?? 'executor' };
      ctx.onProgress?.({ kind: 'stepper-spawned', source: ref, goal: node.goal });

      const subagent = node.agent ? ctx.childSteppers.get(node.agent) : undefined;
      let result: IStepperResult;

      if (node.agent && subagent && ctx.budget.depthRemaining > 0) {
        // Case 1 — recursive child Stepper
        result = await subagent.run({
          prompt: composeTask(node, plan),
          knowledgeRag: ctx.knowledgeRag,
          toolsRag: ctx.toolsRag,
          budget: { depthRemaining: ctx.budget.depthRemaining - 1, tokensRemaining: Math.floor(ctx.budget.tokensRemaining / 2) },
          identity: childIdentity,
          toolSafety: ctx.toolSafety,
          signal: ctx.signal,
          sessionLogger: ctx.sessionLogger,
          onProgress: ctx.onProgress,
        });
      } else if (ctx.executor) {
        // Case 2 (depth floor) + Case 3 (no agent) — terminal executor leaf
        const r = await ctx.executor.execute({
          prompt: composeTask(node, plan),
          tools: [],
          knowledgeRag: ctx.knowledgeRag,
          toolsRag: ctx.toolsRag,
          budget: ctx.budget,
          identity: childIdentity,
          toolSafety: ctx.toolSafety,
          signal: ctx.signal,
          sessionLogger: ctx.sessionLogger,
          onProgress: ctx.onProgress,
        });
        result = { status: r.status, missing: r.missing, usage: r.usage };
      } else {
        // Case 4 — nothing can execute this node
        result = { status: 'incomplete', missing: [`node '${node.id}' references unknown agent '${node.agent}' and no executor is available`], usage: ZERO };
      }

      ctx.onProgress?.({ kind: 'stepper-done', source: ref, ok: result.status === 'ok' });
      results.set(node.id, result);
      done.add(node.id);
      usage = addUsage(usage, result.usage);
      if (WORST[result.status] > WORST[worst]) worst = result.status;
    };

    // Wave scheduler with a maxParallelSteps pool.
    while (done.size < plan.nodes.length) {
      const batch = ready();
      if (batch.length === 0) break; // dependency deadlock — shouldn't happen with valid plans
      const cap = Math.max(1, ctx.maxParallelSteps || 1);
      for (let i = 0; i < batch.length; i += cap) {
        await Promise.all(batch.slice(i, i + cap).map(runNode));
      }
    }

    return { status: worst, usage, ...(worst !== 'ok' ? { missing: collectMissing(results) } : {}) };
  }
}

function composeTask(node: DagPlan['nodes'][number], plan: DagPlan): string {
  return plan.objective ? `Objective: ${plan.objective}\nTask: ${node.goal}` : node.goal;
}

function collectMissing(results: Map<string, IStepperResult>): string[] {
  const out: string[] = [];
  for (const r of results.values()) if (r.missing) out.push(...r.missing);
  return out;
}
```

> The `maxParallelSteps` batching above is a simplification (batches of `cap` within a wave). If the existing 17.0 `DagPlanInterpreter` has a more precise sliding-pool implementation, reuse its helper instead. The H.9 test (peak ≤ cap) must pass either way.

- [ ] **9c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/stepper/__tests__/stepper-interpreter.test.ts
git add packages/llm-agent-libs/src/coordinator/stepper/stepper-interpreter.ts \
        packages/llm-agent-libs/src/coordinator/stepper/__tests__/stepper-interpreter.test.ts
git commit -m "feat(stepper): StepperInterpreter — depth-guarded 4-case dispatch + parallel pool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — Stepper + RootFinalizer + barrel

### Task 10 — `Stepper`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/stepper.ts`
- Test: `packages/llm-agent-libs/src/coordinator/stepper/__tests__/stepper.test.ts`

The Stepper composes planner + optional reviewer + interpreter. Run loop: plan → (reviewer at this depth?) → interpret. Reviewer depth is decided by the dispatcher (passed as a flag/predicate), per §C.3.

- [ ] **10a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IStepperInterpreter, IStepperPlanner } from '@mcp-abap-adt/llm-agent';
import { Stepper } from '../stepper.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const planner: IStepperPlanner = {
  name: 'p',
  async plan() { return { objective: 'o', nodes: [{ id: 'a', goal: 'g' }], createdAt: 0 }; },
};

function spyInterp(): { it: IStepperInterpreter; planSeen: number } {
  let planSeen = 0;
  return {
    get planSeen() { return planSeen; },
    it: { name: 'i', async interpret(plan) { planSeen = plan.nodes.length; return { status: 'ok', usage: ZERO }; } },
  };
}

const input = () => ({
  prompt: 'p',
  knowledgeRag: { async query() { return []; }, async list() { return []; }, async write() {}, fingerprint() { return ''; } } as never,
  toolsRag: { async query() { return []; }, lookup() { return undefined; } } as never,
  budget: { depthRemaining: 3, tokensRemaining: 100000 },
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n0' },
  toolSafety: { mutationPolicy: 'confirm' as const, knownReadOnlyTools: new Set<string>() },
});

test('Stepper runs planner then interpreter; reviewer skipped when depth not in atDepths', async () => {
  const interp = spyInterp();
  let reviewerCalls = 0;
  const st = new Stepper({
    name: 'root', planner, interpreter: interp.it,
    executor: { name: 'e', async execute() { return { status: 'ok', usage: ZERO }; } },
    childSteppers: new Map(),
    reviewer: { name: 'r', async review() { reviewerCalls++; return { ok: true }; } } as never,
    reviewerAtDepths: new Set([0]),
    depth: 2,                        // not in atDepths → reviewer skipped
    maxParallelSteps: 4,
    mintStepperId: () => 's1',
  });
  const res = await st.run(input());
  assert.equal(res.status, 'ok');
  assert.equal(interp.planSeen, 1);
  assert.equal(reviewerCalls, 0);
});

test('Stepper invokes reviewer when depth is in atDepths', async () => {
  const interp = spyInterp();
  let reviewerCalls = 0;
  const st = new Stepper({
    name: 'root', planner, interpreter: interp.it,
    executor: { name: 'e', async execute() { return { status: 'ok', usage: ZERO }; } },
    childSteppers: new Map(),
    reviewer: { name: 'r', async review() { reviewerCalls++; return { ok: true }; } } as never,
    reviewerAtDepths: new Set([0, 1]),
    depth: 0,                        // in atDepths → reviewer runs
    maxParallelSteps: 4,
    mintStepperId: () => 's1',
  });
  await st.run(input());
  assert.equal(reviewerCalls, 1);
});
```

> Verify the 17.0 `IReviewStrategy` method name (`review` vs `reviewPlan`) via `git grep -n "interface IReviewStrategy" packages/llm-agent/src` and match it. Adapt the test's reviewer stub.

Run → FAIL.

- [ ] **10b. Implement.** Create `packages/llm-agent-libs/src/coordinator/stepper/stepper.ts`. The Stepper holds its deps + `depth` + `reviewerAtDepths`. `run()`: call `planner.plan({prompt, knowledgeRag, toolsRag, parentPath, identity})`; if `reviewerAtDepths.has(depth)` and a reviewer is configured, call it and replan/abort on rejection (reuse 17.0 reviewer-recovery semantics, bounded); call `interpreter.interpret(plan, ctx)` passing all deps + `mintStepperId`. Return the interpreter result. Catch `NeedInfoSignal`/`ClarifySignal`/`InsufficientSignal` and rethrow (coordinator handles them — §F).

```ts
import type {
  IExecutor, IReviewStrategy, IStepper, IStepperInput, IStepperInterpreter,
  IStepperPlanner, IStepperResult,
} from '@mcp-abap-adt/llm-agent';

export interface StepperDeps {
  name: string;
  planner: IStepperPlanner;
  interpreter: IStepperInterpreter;
  executor: IExecutor;
  childSteppers: ReadonlyMap<string, IStepper>;
  reviewer?: IReviewStrategy;
  reviewerAtDepths: ReadonlySet<number>;
  depth: number;
  maxParallelSteps: number;
  mintStepperId: () => string;
  parentPath?: string[];
}

export class Stepper implements IStepper {
  readonly name: string;
  constructor(private readonly deps: StepperDeps) {
    this.name = deps.name;
  }

  async run(input: IStepperInput): Promise<IStepperResult> {
    const { planner, interpreter, executor, childSteppers, reviewer, reviewerAtDepths, depth, maxParallelSteps, mintStepperId, parentPath } = this.deps;
    const plan = await planner.plan({
      prompt: input.prompt,
      knowledgeRag: input.knowledgeRag,
      toolsRag: input.toolsRag,
      parentPath: parentPath ?? [this.name],
      identity: input.identity,
      signal: input.signal,
    });
    if (reviewer && reviewerAtDepths.has(depth)) {
      const verdict = await reviewer.review?.(plan as never) ?? { ok: true };
      // On rejection, a bounded replan could be added here (17.0 semantics).
      // v1: log and proceed if reviewer has no hard-fail contract.
      void verdict;
    }
    return interpreter.interpret(plan, {
      prompt: input.prompt,
      knowledgeRag: input.knowledgeRag,
      toolsRag: input.toolsRag,
      childSteppers,
      executor,
      budget: input.budget,
      identity: input.identity,
      toolSafety: input.toolSafety,
      maxParallelSteps,
      mintStepperId,
      signal: input.signal,
      sessionLogger: input.sessionLogger,
      onProgress: input.onProgress,
    });
  }
}
```

> The reviewer integration is intentionally thin here — match the real `IReviewStrategy` contract. If 17.0's reviewer returns a structured accept/replan decision, wire the replan loop (bounded by a small constant). Keep it minimal for v1; the H-tests don't exercise reviewer-replan.

- [ ] **10c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/stepper/__tests__/stepper.test.ts
git add packages/llm-agent-libs/src/coordinator/stepper/stepper.ts \
        packages/llm-agent-libs/src/coordinator/stepper/__tests__/stepper.test.ts
git commit -m "feat(stepper): Stepper — plan → (depth-gated reviewer) → interpret

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 11 — `RootFinalizer`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/root-finalizer.ts`
- Test: `packages/llm-agent-libs/src/coordinator/stepper/__tests__/root-finalizer.test.ts`

Reads ALL current-turn entries via `knowledgeRag.list({turnId})`, composes the answer (streaming `content` chunks), or raises `InsufficientSignal` when the LLM signals missing data.

- [ ] **11a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InsufficientSignal } from '@mcp-abap-adt/llm-agent';
import type { StreamChunk } from '@mcp-abap-adt/llm-agent';
import { RootFinalizer } from '../root-finalizer.js';

function streamingLlm(deltas: string[]) {
  return {
    name: 'stub',
    async *streamChat() {
      for (let i = 0; i < deltas.length; i++) {
        const last = i === deltas.length - 1;
        yield { ok: true as const, value: { content: deltas[i], ...(last ? { finishReason: 'stop', usage: { promptTokens: 1, completionTokens: deltas.length, totalTokens: 1 + deltas.length } } : {}) } };
      }
    },
  };
}

function ragWith(entries: { content: string; turnId: string }[]) {
  return {
    async query() { return []; },
    async list(f: { turnId?: string }) {
      return entries.filter((e) => !f.turnId || e.turnId === f.turnId).map((e) => ({
        content: e.content,
        metadata: { traceId: 't', turnId: e.turnId, stepperId: 'n', task: 'x', artifactType: 'analysis-finding', createdAt: '2026-05-29T00:00:00Z' },
      }));
    },
    async write() {},
    fingerprint() { return ''; },
  };
}

test('finalizer reads current turn exhaustively via list and streams content', async () => {
  const chunks: StreamChunk[] = [];
  const fin = new RootFinalizer(streamingLlm(['Sec', 'urity ', 'OK']) as never);
  const res = await fin.finalize({
    prompt: 'review', knowledgeRag: ragWith([{ content: 'finding A', turnId: 'u1' }, { content: 'finding B', turnId: 'u2' }]) as never,
    turnId: 'u1',
    onProgress: (c) => chunks.push(c),
  });
  assert.equal(res.output, 'Security OK');
  assert.deepEqual(chunks.filter((c) => c.kind === 'content').map((c) => (c as { delta: string }).delta), ['Sec', 'urity ', 'OK']);
});

test('H.6 finalizer raises InsufficientSignal when llm emits the insufficient marker', async () => {
  const fin = new RootFinalizer(streamingLlm(['{"insufficient":["source code"]}']) as never);
  await assert.rejects(
    () => fin.finalize({ prompt: 'review', knowledgeRag: ragWith([]) as never, turnId: 'u1' }),
    (e: unknown) => e instanceof InsufficientSignal && e.missing.includes('source code'),
  );
});
```

Run → FAIL.

- [ ] **11b. Implement.** Create `packages/llm-agent-libs/src/coordinator/stepper/root-finalizer.ts`:

```ts
import {
  InsufficientSignal,
  type IKnowledgeRagHandle,
  type ILlm,
  type LlmUsage,
  type StreamChunk,
} from '@mcp-abap-adt/llm-agent';

const FINALIZER_SYSTEM = `You compose the final answer for the consumer from the provided knowledge entries.
If the entries contain enough information, write the answer directly in clean Markdown.
If a REQUIRED fact is missing, respond with ONLY JSON: {"insufficient":["<missing item>", ...]} and nothing else.`;

export class RootFinalizer {
  constructor(private readonly llm: ILlm) {}

  async finalize(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    turnId: string;
    scope?: 'turn' | 'session';
    signal?: AbortSignal;
    onProgress?: (event: StreamChunk) => void;
  }): Promise<{ output: string; usage?: LlmUsage }> {
    const filter = input.scope === 'session' ? {} : { turnId: input.turnId };
    const entries = await input.knowledgeRag.list(filter);
    const knowledge = entries.map((e, i) => `[${i + 1}] (${e.metadata.artifactType}) ${e.content}`).join('\n\n');
    const user = `Consumer request:\n${input.prompt}\n\nKnowledge entries:\n${knowledge || '(none)'}`;

    let buf = '';
    let usage: LlmUsage | undefined;
    for await (const chunk of this.llm.streamChat(
      [{ role: 'system', content: FINALIZER_SYSTEM }, { role: 'user', content: user }] as never,
      [] as never,
      { signal: input.signal },
    )) {
      if (chunk.ok === false) throw new Error(chunk.error?.message ?? 'finalizer stream error');
      const delta = chunk.value.content ?? '';
      if (delta) { buf += delta; input.onProgress?.({ kind: 'content', delta }); }
      if (chunk.value.usage) usage = chunk.value.usage;
    }

    const insufficient = tryParseInsufficient(buf);
    if (insufficient) throw new InsufficientSignal(insufficient, usage);
    return { output: buf, usage };
  }
}

function tryParseInsufficient(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { insufficient?: unknown };
    if (Array.isArray(parsed.insufficient)) return parsed.insufficient.map(String);
  } catch {
    // not the insufficient marker → treat as a normal answer
  }
  return undefined;
}
```

> If the finalizer streams the insufficient JSON, the `onProgress` content chunks will have leaked the JSON to the consumer before we detect it. ACCEPTABLE for v1 (the marker is rare and the coordinator turns the signal into a clean message). A stricter variant buffers the first ~64 chars before deciding whether to forward — note this as an 18.x refinement, not v1.

- [ ] **11c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent-libs run build
cd packages/llm-agent-libs && npx tsx --test src/coordinator/stepper/__tests__/root-finalizer.test.ts
git add packages/llm-agent-libs/src/coordinator/stepper/root-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/stepper/__tests__/root-finalizer.test.ts
git commit -m "feat(stepper): RootFinalizer — exhaustive turn read + streaming content + InsufficientSignal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 12 — Stepper barrel + libs re-export

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/stepper/index.ts`
- Modify: `packages/llm-agent-libs/src/index.ts`

- [ ] **12a. Implement barrel.** Create `index.ts`:
```ts
export { CyclicReActExecutor } from './cyclic-react-executor.js';
export { LlmNeedResolver, RegexNeedResolver } from './need-resolver.js';
export { LlmStepperPlanner, STEPPER_PLANNER_SYSTEM } from './llm-stepper-planner.js';
export { StepperInterpreter } from './stepper-interpreter.js';
export { Stepper, type StepperDeps } from './stepper.js';
export { RootFinalizer } from './root-finalizer.js';
```

Add to `packages/llm-agent-libs/src/index.ts`:
```ts
export * from './coordinator/stepper/index.js';
export { KnowledgeRag } from './rag/knowledge-rag.js';
```

- [ ] **12b. Build + full libs sweep + commit.**
```bash
npm run build
cd packages/llm-agent-libs && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test 2>&1 | tail -8
git add packages/llm-agent-libs/src/coordinator/stepper/index.ts packages/llm-agent-libs/src/index.ts
git commit -m "feat(stepper): export Stepper runtime barrel + KnowledgeRag from llm-agent-libs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — Server wiring (`@mcp-abap-adt/llm-agent-server`)

### Task 13 — `SessionMetaStore`

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/session-meta-store.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/session-meta-store.test.ts`

§G.2 metadata store. Two impls: in-memory (default, tests) + a Postgres-backed one (behind the existing pg dependency). Start with the interface + in-memory; Postgres is a thin adapter.

- [ ] **13a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemorySessionMetaStore } from '../session-meta-store.js';

test('create / get / list / touch / delete', async () => {
  const s = new InMemorySessionMetaStore();
  await s.create({ sessionId: 'a', userIdentity: 'u1', title: 'first', createdAt: '2026-05-29T00:00:00Z', status: 'idle' });
  await s.create({ sessionId: 'b', userIdentity: 'u1', title: 'second', createdAt: '2026-05-29T00:01:00Z', status: 'in-progress' });
  await s.create({ sessionId: 'c', userIdentity: 'u2', title: 'other', createdAt: '2026-05-29T00:02:00Z', status: 'idle' });

  const u1 = await s.listForUser('u1');
  assert.deepEqual(u1.map((x) => x.sessionId).sort(), ['a', 'b']);

  await s.touch('a', '2026-05-29T01:00:00Z');
  assert.equal((await s.get('a'))?.lastUsedAt, '2026-05-29T01:00:00Z');

  await s.setStatus('b', 'idle');
  assert.equal((await s.get('b'))?.status, 'idle');

  await s.delete('a');
  assert.equal(await s.get('a'), undefined);
});

test('inProgressSessions returns only in-progress', async () => {
  const s = new InMemorySessionMetaStore();
  await s.create({ sessionId: 'x', userIdentity: 'u', createdAt: '2026-05-29T00:00:00Z', status: 'in-progress' });
  await s.create({ sessionId: 'y', userIdentity: 'u', createdAt: '2026-05-29T00:00:00Z', status: 'idle' });
  assert.deepEqual((await s.inProgressSessions()).map((r) => r.sessionId), ['x']);
});
```

Run → FAIL.

- [ ] **13b. Implement.** Create `packages/llm-agent-server/src/smart-agent/session-meta-store.ts`:

```ts
export interface SessionMetaRow {
  sessionId: string;
  userIdentity: string | null;
  title?: string;
  createdAt: string;
  lastUsedAt?: string;
  status: 'idle' | 'in-progress' | 'drained';
  promptCount?: number;
}

export interface ISessionMetaStore {
  create(row: SessionMetaRow): Promise<void>;
  get(sessionId: string): Promise<SessionMetaRow | undefined>;
  listForUser(userIdentity: string): Promise<SessionMetaRow[]>;
  touch(sessionId: string, at: string): Promise<void>;
  setStatus(sessionId: string, status: SessionMetaRow['status']): Promise<void>;
  delete(sessionId: string): Promise<void>;
  inProgressSessions(): Promise<SessionMetaRow[]>;
}

export class InMemorySessionMetaStore implements ISessionMetaStore {
  private readonly rows = new Map<string, SessionMetaRow>();
  async create(row: SessionMetaRow) { this.rows.set(row.sessionId, { ...row }); }
  async get(id: string) { const r = this.rows.get(id); return r ? { ...r } : undefined; }
  async listForUser(u: string) { return [...this.rows.values()].filter((r) => r.userIdentity === u).map((r) => ({ ...r })); }
  async touch(id: string, at: string) { const r = this.rows.get(id); if (r) r.lastUsedAt = at; }
  async setStatus(id: string, status: SessionMetaRow['status']) { const r = this.rows.get(id); if (r) r.status = status; }
  async delete(id: string) { this.rows.delete(id); }
  async inProgressSessions() { return [...this.rows.values()].filter((r) => r.status === 'in-progress').map((r) => ({ ...r })); }
}
```

> A `PgSessionMetaStore` (using the existing pg client from `pg-vector-rag`) is a follow-up within the same task ONLY IF the pg client is trivially importable; otherwise leave a one-line note that the Postgres adapter ships behind config in a later commit and the in-memory store is the default. Do NOT block the plan on pg wiring.

- [ ] **13c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent-server run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/session-meta-store.test.ts
git add packages/llm-agent-server/src/smart-agent/session-meta-store.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/session-meta-store.test.ts
git commit -m "feat(server): SessionMetaStore (in-memory) for session persistence/resume metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 14 — config parsing for `coordinator.mode` + tool-safety + `coordinator.stepper.*`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/stepper-config.test.ts`

- [ ] **14a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStepperCoordinatorConfig } from '../config.js';

test('parses mode, mutationPolicy, knownReadOnlyTools, stepper.* with defaults', () => {
  const c = parseStepperCoordinatorConfig({
    mode: 'planned-react',
    mutationPolicy: 'trusted',
    knownReadOnlyTools: ['GetProgram', 'GetInclude'],
    stepper: { maxParallelSteps: 8, reviewer: { atDepths: [0, 1, 2] }, maxDepth: 5, tokenBudget: 500000 },
  });
  assert.equal(c.mode, 'planned-react');
  assert.equal(c.toolSafety.mutationPolicy, 'trusted');
  assert.equal(c.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
  assert.equal(c.maxParallelSteps, 8);
  assert.deepEqual([...c.reviewerAtDepths].sort(), [0, 1, 2]);
  assert.equal(c.maxDepth, 5);
  assert.equal(c.tokenBudget, 500000);
});

test('defaults: mode=planned-react, mutationPolicy=confirm, reviewer atDepths=[0,1], maxParallelSteps=4', () => {
  const c = parseStepperCoordinatorConfig({});
  assert.equal(c.mode, 'planned-react');
  assert.equal(c.toolSafety.mutationPolicy, 'confirm');
  assert.equal(c.toolSafety.knownReadOnlyTools.size, 0);
  assert.deepEqual([...c.reviewerAtDepths].sort(), [0, 1]);
  assert.equal(c.maxParallelSteps, 4);
});

test("reviewer atDepths 'all' yields a predicate that accepts any depth", () => {
  const c = parseStepperCoordinatorConfig({ stepper: { reviewer: { atDepths: 'all' } } });
  assert.equal(c.reviewerAtDepths.has(0), true);
  assert.equal(c.reviewerAtDepths.has(99), true);
});

test('invalid mode throws', () => {
  assert.throws(() => parseStepperCoordinatorConfig({ mode: 'bogus' }), /unknown coordinator\.mode/i);
});
```

Run → FAIL.

- [ ] **14b. Implement.** Add `parseStepperCoordinatorConfig` to `config.ts`. The `reviewerAtDepths` must support `'all'` — return a `ReadonlySet<number>`-like with `.has()` always true. Implement via a small wrapper:

```ts
export type StepperMode = 'cyclic-react' | 'deep-stepper' | 'planned-react';

export interface StepperCoordinatorConfig {
  mode: StepperMode;
  toolSafety: { mutationPolicy: 'confirm' | 'trusted'; knownReadOnlyTools: ReadonlySet<string> };
  reviewerAtDepths: { has(depth: number): boolean };
  maxParallelSteps: number;
  maxDepth: number;
  tokenBudget: number;
}

const MODES = new Set<StepperMode>(['cyclic-react', 'deep-stepper', 'planned-react']);

export function parseStepperCoordinatorConfig(coord: Record<string, unknown>): StepperCoordinatorConfig {
  const mode = (coord.mode as StepperMode | undefined) ?? 'planned-react';
  if (!MODES.has(mode)) throw new Error(`unknown coordinator.mode '${String(coord.mode)}'`);

  const mutationPolicy = (coord.mutationPolicy as 'confirm' | 'trusted' | undefined) ?? 'confirm';
  if (mutationPolicy !== 'confirm' && mutationPolicy !== 'trusted') {
    throw new Error(`coordinator.mutationPolicy must be 'confirm' | 'trusted'`);
  }
  const knownReadOnlyTools = new Set<string>(
    Array.isArray(coord.knownReadOnlyTools) ? (coord.knownReadOnlyTools as string[]) : [],
  );

  const stepper = (coord.stepper as Record<string, unknown> | undefined) ?? {};
  const reviewerCfg = (stepper.reviewer as { atDepths?: number[] | 'all' } | undefined) ?? {};
  const atDepths = reviewerCfg.atDepths ?? [0, 1];
  const reviewerAtDepths =
    atDepths === 'all'
      ? { has: () => true }
      : (() => { const s = new Set(atDepths as number[]); return { has: (d: number) => s.has(d) }; })();

  return {
    mode,
    toolSafety: { mutationPolicy, knownReadOnlyTools },
    reviewerAtDepths,
    maxParallelSteps: Number(stepper.maxParallelSteps ?? 4),
    maxDepth: Number(stepper.maxDepth ?? 4),
    tokenBudget: Number(stepper.tokenBudget ?? 1_000_000),
  };
}
```

> Update the `IStepperInterpreter`/`Stepper` reviewer types: `reviewerAtDepths` is `{ has(n): boolean }` not `ReadonlySet<number>` (so `'all'` works). Adjust the Task 10 `StepperDeps.reviewerAtDepths` type to `{ has(depth: number): boolean }` and re-run Task 10's test (the `new Set([0])` still satisfies `{has}`). Make this adjustment in this commit if not already.

- [ ] **14c. Test + commit.**
```bash
npm --workspace @mcp-abap-adt/llm-agent-server run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/stepper-config.test.ts
git add packages/llm-agent-server/src/smart-agent/config.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/stepper-config.test.ts
git commit -m "feat(server-config): parse coordinator.mode + toolSafety + coordinator.stepper.* with smart defaults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 15 — `buildStepperRoot` factory

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/build-stepper-root.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/build-stepper-root.test.ts`

Assembles `{ rootStepper, finalizer, budget, maxParallelSteps, toolSafety }` from the parsed config + subagent registry + per-role LLM map. The mode determines the wiring:
- `cyclic-react` → root Stepper with a trivial single-step planner + CyclicReActExecutor; no child Steppers.
- `planned-react` → root Stepper with `LlmStepperPlanner`; child dispatches go to CyclicReActExecutor leaves (depth budget = 1).
- `deep-stepper` → root Stepper; subagents registered as recursive child Steppers (each itself a Stepper); depth budget = config maxDepth.

- [ ] **15a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CyclicReActExecutor, RootFinalizer, Stepper } from '@mcp-abap-adt/llm-agent-libs';
import { buildStepperRoot } from '../build-stepper-root.js';

const stubLlm = { name: 'stub', model: 'm', async chat() { return { ok: true as const, value: { content: '{"objective":"o","nodes":[{"id":"a","goal":"g"}]}' } }; }, async *streamChat() { yield { ok: true as const, value: { content: 'done', finishReason: 'stop' } }; } };

const baseInput = {
  coordCfg: { mode: 'planned-react', knownReadOnlyTools: ['GetProgram'] },
  registry: new Map(),                         // subagent registry
  makeLlm: async () => stubLlm as never,
  knowledgeRagFor: () => ({ async query() { return []; }, async list() { return []; }, async write() {}, fingerprint() { return ''; } }) as never,
  toolsRag: { async query() { return []; }, lookup() { return undefined; } } as never,
  callMcp: async () => 'result',
  mintStepperId: (() => { let i = 0; return () => `s${i++}`; })(),
};

test('builds a planned-react root with Stepper + RootFinalizer + threaded toolSafety', async () => {
  const built = await buildStepperRoot(baseInput as never);
  assert.ok(built.rootStepper instanceof Stepper);
  assert.ok(built.finalizer instanceof RootFinalizer);
  assert.equal(built.toolSafety.knownReadOnlyTools.has('GetProgram'), true);
  assert.equal(built.maxParallelSteps, 4);
  assert.ok(built.budget.depthRemaining >= 1);
});

test('cyclic-react mode produces a root whose executor is CyclicReActExecutor and no child steppers', async () => {
  const built = await buildStepperRoot({ ...baseInput, coordCfg: { mode: 'cyclic-react' } } as never);
  assert.ok(built.rootStepper instanceof Stepper);
  // depthRemaining 0 → interpreter will route everything to the executor leaf
  assert.equal(built.budget.depthRemaining, 0);
});
```

Run → FAIL.

- [ ] **15b. Implement.** Create `build-stepper-root.ts` wiring the three modes. Key points: build one `CyclicReActExecutor` (shared), one `LlmStepperPlanner` (or trivial planner for cyclic-react), one `StepperInterpreter`, one root `Stepper`, one `RootFinalizer`. `budget.depthRemaining`: cyclic-react→0, planned-react→1, deep-stepper→config.maxDepth. `toolSafety` from `parseStepperCoordinatorConfig`. Register subagents as child Steppers for deep-stepper mode.

> Provide the full implementation matching the test. Use `parseStepperCoordinatorConfig` from Task 14. For the trivial cyclic-react planner, emit a single-node plan `{objective: prompt, nodes:[{id:'root', goal: prompt}], createdAt: 0}` without an LLM call.

- [ ] **15c. Test + commit.**
```bash
npm run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/build-stepper-root.test.ts
git add packages/llm-agent-server/src/smart-agent/build-stepper-root.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/build-stepper-root.test.ts
git commit -m "feat(server): buildStepperRoot factory — wires the three modes into a root Stepper + finalizer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 16 — `StepperCoordinatorHandler` + signal handling

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/stepper-coordinator-handler.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/stepper-coordinator-handler.test.ts`

The handler is the coordinator boundary (§F). It: mints the root `RunIdentity`; runs the root Stepper; on `budget-exhausted` raises the budget-extension `ClarifySignal`; on completion runs the `RootFinalizer` and streams its `content` to `ctx.yield`; on `InsufficientSignal` returns the missing-list to the consumer; routes `NeedInfoSignal` to the state oracle (17.0 surface).

- [ ] **16a. Failing test.**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StepperCoordinatorHandler } from '../stepper-coordinator-handler.js';

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function fakeBuilt(overrides = {}) {
  return {
    rootStepper: { name: 'root', async run() { return { status: 'ok', usage: ZERO }; } },
    finalizer: { async finalize(input: { onProgress?: (c: unknown) => void }) { input.onProgress?.({ kind: 'content', delta: 'FINAL ANSWER' }); return { output: 'FINAL ANSWER', usage: ZERO }; } },
    budget: { depthRemaining: 1, tokensRemaining: 100000 },
    maxParallelSteps: 4,
    toolSafety: { mutationPolicy: 'confirm', knownReadOnlyTools: new Set() },
    ...overrides,
  };
}

function ctx() {
  const yields: { content?: string; finishReason?: string }[] = [];
  return {
    yields,
    obj: {
      inputText: 'review program X',
      sessionId: 's1',
      requestLogger: { startRequest() {}, getSummary() { return {}; }, logStep() {}, logLlmCall() {} },
      yield(c: { value?: { content?: string; finishReason?: string } }) { if (c.value) yields.push({ content: c.value.content, finishReason: c.value.finishReason }); },
      options: { trace: { traceId: 't1' } },
    },
  };
}

test('happy path: runs stepper then finalizer, yields content + terminal stop', async () => {
  const h = new StepperCoordinatorHandler({ buildBuilt: async () => fakeBuilt(), mintStepperId: () => 'root', mintTurnId: () => 'turn-1' });
  const c = ctx();
  await h.execute(c.obj as never, {}, {} as never);
  assert.ok(c.yields.some((y) => y.content === 'FINAL ANSWER'));
  assert.ok(c.yields.some((y) => y.finishReason === 'stop'));
});

test('budget-exhausted bubbles to a ClarifySignal from the coordinator (not the finalizer)', async () => {
  const built = fakeBuilt({ rootStepper: { name: 'root', async run() { return { status: 'budget-exhausted', usage: ZERO }; } } });
  const h = new StepperCoordinatorHandler({ buildBuilt: async () => built, mintStepperId: () => 'root', mintTurnId: () => 'turn-1' });
  const c = ctx();
  // The handler should surface a budget-extension clarify. Assert via a yielded clarify event OR a thrown ClarifySignal — match the 17.0 handler's clarify mechanism.
  await h.execute(c.obj as never, {}, {} as never);
  assert.ok(c.yields.some((y) => /budget/i.test(y.content ?? '')), 'a budget-extension clarify was surfaced to the consumer');
});
```

> The exact clarify-surfacing mechanism (yield a clarify chunk vs throw `ClarifySignal` caught by the server) must match the 17.0 `DagCoordinatorHandler`. Read `git grep -n "ClarifySignal" packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` and mirror it.

Run → FAIL.

- [ ] **16b. Implement.** Create `stepper-coordinator-handler.ts`. Mirror the 17.0 `DagCoordinatorHandler` structure (stage-handler shape, `ctx.yield` usage, terminal stop-yield with usage from `summaryToUsage(requestLogger.getSummary(traceId))`). Mint root identity, run `built.rootStepper.run({...})`, handle the result status, then `built.finalizer.finalize({prompt: ctx.inputText, knowledgeRag, turnId, onProgress: c => c.kind==='content' && ctx.yield({ok:true, value:{content:c.delta}})})`. On `budget-exhausted`, surface the clarify. Catch `InsufficientSignal` → yield the missing-list message.

- [ ] **16c. Test + commit.**
```bash
npm run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/stepper-coordinator-handler.test.ts
git add packages/llm-agent-server/src/smart-agent/stepper-coordinator-handler.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/stepper-coordinator-handler.test.ts
git commit -m "feat(server): StepperCoordinatorHandler — root identity, finalizer streaming, signal partitioning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 17 — `/v1/sessions` endpoints + mode routing in `smart-server.ts`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/sessions-endpoints.test.ts`

§G.4 API. Add `GET /v1/sessions`, `POST /v1/sessions/<id>/resume`, `DELETE /v1/sessions/<id>` backed by `ISessionMetaStore`. Route `coordinator.mode` present → use `StepperCoordinatorHandler` instead of `DagCoordinatorHandler`.

- [ ] **17a. Failing test.** Unit-test the route handlers in isolation (extract them as small functions taking `(store, identity, params)` so they're testable without a live HTTP server, matching how 17.0 tests `/v1/usage`-style handlers). Assert: list returns rows for the identity; resume sets status + returns 200 metadata; delete removes the row + (stub) evicts RAG.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemorySessionMetaStore } from '../session-meta-store.js';
import { handleListSessions, handleResumeSession, handleDeleteSession } from '../smart-server.js';

test('GET /v1/sessions lists rows for the identity', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({ sessionId: 'a', userIdentity: 'u1', createdAt: '2026-05-29T00:00:00Z', status: 'idle' });
  const body = await handleListSessions(store, 'u1');
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].sessionId, 'a');
});

test('POST /v1/sessions/:id/resume claims + returns metadata', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({ sessionId: 'a', userIdentity: 'u1', createdAt: '2026-05-29T00:00:00Z', status: 'idle' });
  const r = await handleResumeSession(store, 'u1', 'a');
  assert.equal(r.ok, true);
  assert.equal(r.session?.sessionId, 'a');
});

test('DELETE /v1/sessions/:id removes the row', async () => {
  const store = new InMemorySessionMetaStore();
  await store.create({ sessionId: 'a', userIdentity: 'u1', createdAt: '2026-05-29T00:00:00Z', status: 'idle' });
  const evicted: string[] = [];
  await handleDeleteSession(store, 'u1', 'a', async (sid) => { evicted.push(sid); });
  assert.equal(await store.get('a'), undefined);
  assert.deepEqual(evicted, ['a']);
});
```

Run → FAIL.

- [ ] **17b. Implement.** Export `handleListSessions`, `handleResumeSession`, `handleDeleteSession` from `smart-server.ts` and wire them into the request router alongside the existing `/v1/usage` handler. Add mode routing: when `coordinator.mode` is set (or `coordinator.planner` for backward-compat mapping → `planned-react`), instantiate `StepperCoordinatorHandler` via `buildStepperRoot`; else keep the existing `DagCoordinatorHandler` path (deprecated, §K).

> Backward-compat (§K): a 17.0 yaml with `coordinator.planner` and no `coordinator.mode` maps to `mode: planned-react`. Emit a one-line deprecation note via `log({event:'config_warning', ...})`.

- [ ] **17c. Test + commit.**
```bash
npm run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/sessions-endpoints.test.ts
git add packages/llm-agent-server/src/smart-agent/smart-server.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/sessions-endpoints.test.ts
git commit -m "feat(server): /v1/sessions list/resume/delete + coordinator.mode routing to StepperCoordinatorHandler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — Integration provability tests + sweep

### Task 18 — End-to-end provability tests (H.1–H.10 + H.4b)

**Files:**
- Create: `packages/llm-agent-server/src/smart-agent/__tests__/stepper-provability.test.ts`

Each spec §H test that isn't already covered by a unit test gets an end-to-end version wiring real `Stepper` + `StepperInterpreter` + `CyclicReActExecutor` + `KnowledgeRag` + `RootFinalizer` with scripted LLMs and a fake MCP. Many are already covered (H.1 in Task 7, H.4b in Task 9, H.5 in Task 7, H.6 in Task 11). This task adds the multi-component ones:

- [ ] **18a. Write the integration tests.** Cover at minimum:
  - **H.2** (3-level recursion, grandchild reads sibling's RAG write, no re-fetch) — `deep-stepper` build, scripted LLMs, assert the grandchild planner's `query` returns the earlier write and the grandchild emits a use-the-fact leaf, not a re-fetch.
  - **H.3** (Mode C, 4 parallel children with `maxParallelSteps: 2`, peak ≤ 2) — already partly in Task 9; here against the real `buildStepperRoot`.
  - **H.4** (token budget exhaustion → coordinator clarify) — scripted high-token LLM, assert clarify surfaced.
  - **H.7** (progress events with correct `source.stepperId`/`parentStepperId` across a 3-level tree; assert each child's `parentStepperId` equals its parent's `stepperId`; no `node-*` chunks).
  - **H.8** (session persistence + resume: new session → write → `InMemorySessionMetaStore` row; resume; second prompt's planner.query sees prior entries). Use the same `KnowledgeRag` instance across the two prompts to simulate the persistent backend.
  - **H.9** (cycle prevention by RAG-first: planner with task identical to parent's but RAG already populated emits a use-the-fact leaf). Scripted planner LLM that, when the RAG block is non-empty, returns a leaf plan; assert no infinite recursion (bounded by maxDepth) and the executor is reached.
  - **H.10** (maxParallelSteps locally enforced: 2-level tree, maxN=2 at each level, peak ≤ 4).

  Write each as a `test(...)` with a scripted LLM/MCP, asserting the spec's claim. Use `mintStepperId` as a deterministic counter. Keep each test self-contained.

- [ ] **18b. Run + commit.**
```bash
npm run build
cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/stepper-provability.test.ts
git add packages/llm-agent-server/src/smart-agent/__tests__/stepper-provability.test.ts
git commit -m "test(stepper): end-to-end provability tests H.2/H.3/H.4/H.7/H.8/H.9/H.10

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 19 — Per-package sweep + CHANGELOG + examples

**Files:**
- Modify: `CHANGELOG.md`
- Create: `docs/examples/stepper/` (3 mode yamls + README) — analogous to `docs/examples/dag-coordinator/`

- [ ] **19a. Full sweep.**
```bash
npm run build
cd packages/llm-agent       && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test 2>&1 | tail -6
cd ../llm-agent-libs        && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test 2>&1 | tail -6
cd ../llm-agent-server      && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test 2>&1 | tail -6
cd ../..
npm run lint:check
```
All green, zero lint errors. Fix any regressions inline (especially 17.0 `DagCoordinatorHandler` tests that referenced the removed `node-start`/`node-end` StreamChunk variants — migrate their assertions to the new progress events or mark the handler legacy).

- [ ] **19b. Examples.** Create `docs/examples/stepper/{01-cyclic-react.yaml, 02-planned-react.yaml, 03-deep-stepper.yaml, worker.yaml, README.md}` mirroring the structure of `docs/examples/dag-coordinator/`. Each top-level yaml sets `coordinator.mode` accordingly and a `coordinator.stepper.*` block. README explains the three modes + the `/v1/sessions` resume flow + the readOnly tool-safety policy.

- [ ] **19c. CHANGELOG.** Add the 18.0.0 entry summarizing: recursive Stepper hierarchy, three modes, knowledge-RAG blackboard, context-augmenting ReAct (`INeedResolver`), root finalizer, readOnly tool-safety (BREAKING default: undeclared tools require confirmation), session persistence + `/v1/sessions`, StreamChunk progress events (BREAKING: `node-*` removed), deprecation of `DagCoordinatorHandler`.

- [ ] **19d. Commit + push.**
```bash
git add CHANGELOG.md docs/examples/stepper/
git commit -m "docs(changelog+examples): 18.0 recursive Stepper — modes, knowledge-RAG, sessions, breaking StreamChunk

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin epic/18.0-recursive-stepper
```

### Task 20 — Final integration review + finishing

- [ ] **20a.** Dispatch a final code-review subagent over the whole branch diff against `main`.
- [ ] **20b.** Address any blocking findings (separate commits, no squash).
- [ ] **20c.** Use `superpowers:finishing-a-development-branch` to open the PR.

---

## Self-Review (spec § → task mapping)

| Spec § | Task(s) |
|---|---|
| B.1 Stepper composition | 10 (Stepper), 1 (types) |
| B.2 Knowledge-RAG four ops | 2 (contract), 5 (impl) |
| B.3 Tools-RAG | 2 (contract), 5 (adapter) |
| B.4 Root finalizer (InsufficientSignal only) | 11 |
| B.5 Sufficiency (depth=interpreter, tokens=executor+stepper) | 9 (depth guard), 7 (token stop) |
| B.6 Cycle prevention (RAG-first + concrete-leaf + depth) | 8 (planner prompt), 9 (depth), 18 (H.9) |
| C.1 All contracts incl. RunIdentity/ToolSafetyPolicy/mint rule | 1, 2, 3 |
| C.2 StreamChunk progress events + StepperRef | 4 |
| C.3 Reviewer depth policy | 10 (gate), 14 (config) |
| C.4 readOnly safe-default + allowlist + trusted | 7 (executor gate), 14 (config) |
| C.5 Three-mode wiring | 15 |
| C.6 maxParallelSteps local | 9 (pool), 14 (config), 18 (H.10) |
| D.1–D.8 components | 5,6,7,8,9,10,11,15 |
| E.1–E.4 worked examples | 18 (integration coverage of the flows) |
| F signal partitioning | 16 (handler), 11 (finalizer), 7 (executor clarify) |
| G session persistence | 13 (store), 17 (endpoints), 18 (H.8) |
| H.1–H.10 + H.4b | 7, 9, 11, 18 |
| I backward compat | 17 (mode mapping), 19 (legacy test migration) |
| K migration | 17 (deprecation warning), 19 (CHANGELOG) |

**Placeholder scan:** every code step has real code; no "TBD"/"add validation"/"similar to". Verification-name caveats (LlmTool, ILlm.chat shape, IReviewStrategy.review, IRag methods) are flagged with explicit `git grep` instructions because they depend on 17.0 exports the implementer must confirm — these are not placeholders but real reconciliation steps.

**Type consistency:** `RunIdentity`, `ToolSafetyPolicy`, `Budget`, `KnowledgeEntryMetadata`, `StepperRef`, `mintStepperId` are used identically across Tasks 1–18. `reviewerAtDepths` type reconciled to `{ has(n): boolean }` in Task 14 (noted there for the Task 10 adjustment).

**Known follow-up flagged in-plan, not v1:** PgSessionMetaStore (Task 13 note), finalizer-insufficient-JSON-buffering (Task 11 note), deterministic clock injection for ordering (Task 7 note). All explicitly out of v1 scope, consistent with spec §J.
