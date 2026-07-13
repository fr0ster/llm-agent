# Tool-Loop Context Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(N²) raw tool-result accumulation in the controller `runStep` loop and the shared tool-loops with per-round context formation behind a consumer-swappable `IToolLoopContextStrategy`.

**Architecture:** A new focused interface (`record` + `form`, per-loop factory) owns the messages sent each LLM round; the loop never grows a raw transcript. Provided implementations: `LegacyAccumulate` (library default, byte-identical), `Window` (RAG-less bounded), `RagRecall` (generic, RAG-managed), `LegacyTranscript` (migration-only). Our controller composition injects `RagRecall`; the default pipeline / direct SmartAgent inject `Window`; a bare library consumer falls back to `Legacy`.

**Tech Stack:** TypeScript (ESM `.js` imports), `node:test` + `tsx`, Biome, Node ≥22. Packages: `@mcp-abap-adt/llm-agent` (interface), `@mcp-abap-adt/llm-agent-libs` (strategies + loops + builder), `@mcp-abap-adt/llm-agent-server-libs` (controller wiring).

**Design spec:** `docs/superpowers/specs/2026-07-13-tool-loop-context-strategy-design.md` (authoritative — read it).

## Global Constraints

- Interfaces + DI + strategies; **we never decide the consumer's implementation.** No YAML / `SmartServerConfig` change (code strategy).
- **Library default (no factory injected) = `LegacyAccumulateContextStrategy` → byte-identical to today.** Window/RagRecall live ONLY in our app/server composition, never auto-injected by `DefaultPipeline`/`SmartAgent`.
- **Build ON components:** reuse `recall.ts` (`runScopedRecall`/`buildRecallBlock`), `writeArtifact`; do not reimplement recall/ranking.
- All interfaces `I`-prefixed. `snapshot()` returns **plain JSON-serializable** state with a mandatory `version`; `restore()` tolerates an unknown version (clean fallback, never throws).
- **Protocol invariant:** a `ToolRound` (one `assistant` with N `tool_calls` + N `tool` results) is atomic — `form()` emits the most-recent round RAW and WHOLE at the tail; older rounds are elided/recalled as whole rounds.
- Do NOT break the 20.4.0 fail-loud: `classifyToolResult`/escalate runs BEFORE `record`; a tool-level error IS recorded (`meta.isError`).
- `Message` = `{ role: 'user'|'assistant'|'system'|'tool'; content: string|null; tool_call_id?: string; tool_calls?: Array<{id;type;function:{name;arguments}}> }` (`packages/llm-agent/src/types.ts:7`).
- ESM `.js` import extensions; Biome (2-space, single quotes, semicolons); `npm run build` before live tests. Run one test file: `node --import tsx/esm --test --test-reporter=spec <path>`.

---

## File Structure

- **NEW** `packages/llm-agent/src/interfaces/tool-loop-context-strategy.ts` — interface + types.
- **NEW** `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/{legacy-accumulate,window,rag-recall,legacy-transcript}-context-strategy.ts` + `index.ts`.
- **MODIFY** interfaces barrel, `pipeline-plugin.ts`, `agent.ts` (`SmartAgentDeps` + direct loop), `builder.ts`, `pipeline/default-pipeline.ts`, `interfaces/pipeline.ts` (`PipelineDeps`), `pipeline/handlers/tool-loop.ts`, `pipeline/handlers/tool-loop-core.ts`.
- **MODIFY** `smart-agent/controller/controller-coordinator-handler.ts`, `controller/types.ts`, `smart-agent/smart-server.ts`, `pipelines/controller.ts`, `pipelines/default`/server composition.

---

### Task 1: Interface + types (`@mcp-abap-adt/llm-agent`)

**Files:**
- Create: `packages/llm-agent/src/interfaces/tool-loop-context-strategy.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (barrel export)
- Test: `packages/llm-agent/src/__tests__/tool-loop-context-strategy.types.test.ts`

**Interfaces (Produces):** `IToolLoopContextStrategy`, `ToolRound`, `ToolLoopContextBase`, `ToolLoopContextStrategyFactory`, `ToolLoopContextStrategyDeps`, `SerializableStrategyState`, `JsonValue`.

- [ ] **Step 1: Write the failing test** — `tool-loop-context-strategy.types.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IToolLoopContextStrategy,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

test('IToolLoopContextStrategy shape compiles and is usable', () => {
  const round: ToolRound = {
    assistant: { role: 'assistant', content: null, tool_calls: [] },
    results: [{ role: 'tool', tool_call_id: 'c1', content: 'r' }],
  };
  const base: ToolLoopContextBase = { prefix: [], queryText: 'q' };
  const state: SerializableStrategyState = { version: 1 };
  const s: IToolLoopContextStrategy = {
    async record() {},
    async form() {
      return base.prefix;
    },
    snapshot: () => state,
    restore: () => {},
  };
  assert.equal(typeof s.form, 'function');
  assert.equal(round.results.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --import tsx/esm --test packages/llm-agent/src/__tests__/tool-loop-context-strategy.types.test.ts` → FAIL (module `tool-loop-context-strategy` not exported).

- [ ] **Step 3: Create the interface file** (verbatim from spec "The Interface"):

```ts
import type { CallOptions, Message } from '../types.js';

export interface ToolRound {
  assistant: Message;
  results: Message[];
  meta?: Array<{ identityKey?: string; isError?: boolean }>;
  ordinal?: number;
  roundId?: string;
}

export interface ToolLoopContextBase {
  prefix: Message[];
  queryText?: string;
}

export interface IToolLoopContextStrategy {
  record(round: ToolRound, options?: CallOptions): Promise<void>;
  form(base: ToolLoopContextBase, options?: CallOptions): Promise<Message[]>;
  snapshot(): SerializableStrategyState;
  restore(state: SerializableStrategyState): void;
}

export type ToolLoopContextStrategyFactory = (
  deps: ToolLoopContextStrategyDeps,
) => IToolLoopContextStrategy;

export interface ToolLoopContextStrategyDeps {
  readonly run?: unknown;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface SerializableStrategyState {
  readonly version: number;
  readonly [k: string]: JsonValue;
}
```

> Note: `CallOptions` and `Message` both live in `packages/llm-agent/src/types.js`. Verify the import path resolves (the file is under `src/interfaces/`, so `../types.js`).

- [ ] **Step 4: Add barrel export** — in `packages/llm-agent/src/interfaces/index.ts`, after the `mcp-failure-classifier.js` block add:

```ts
export type {
  IToolLoopContextStrategy,
  JsonValue,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolLoopContextStrategyDeps,
  ToolLoopContextStrategyFactory,
  ToolRound,
} from './tool-loop-context-strategy.js';
```

- [ ] **Step 5: Build + run test** — `npm run build` (llm-agent compiles); `node --import tsx/esm --test packages/llm-agent/src/__tests__/tool-loop-context-strategy.types.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/tool-loop-context-strategy.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/__tests__/tool-loop-context-strategy.types.test.ts
git commit -m "feat(llm-agent): IToolLoopContextStrategy interface + types"
```

---

### Task 2: `LegacyAccumulateContextStrategy` (library default)

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/legacy-accumulate-context-strategy.ts`
- Create: `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/index.ts` (barrel; append in later tasks)
- Test: `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/__tests__/legacy-accumulate.test.ts`

**Interfaces:**
- Consumes: `IToolLoopContextStrategy`, `ToolRound`, `ToolLoopContextBase`, `SerializableStrategyState` (Task 1).
- Produces: `class LegacyAccumulateContextStrategy implements IToolLoopContextStrategy`.

- [ ] **Step 1: Write the failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { LegacyAccumulateContextStrategy } from '../legacy-accumulate-context-strategy.js';

const mkRound = (id: string, text: string): ToolRound => ({
  assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'T', arguments: '{}' } }] },
  results: [{ role: 'tool', tool_call_id: id, content: text }],
});
const prefix: Message[] = [{ role: 'system', content: 'S' }];

test('form returns prefix + all recorded rounds raw, in order; current batch once', async () => {
  const s = new LegacyAccumulateContextStrategy();
  await s.record(mkRound('c1', 'r1'));
  await s.record(mkRound('c2', 'r2'));
  const msgs = await s.form({ prefix });
  assert.equal(msgs[0].content, 'S');
  // prefix(1) + 2 rounds × (assistant+tool)=4 → 5 messages
  assert.equal(msgs.length, 5);
  assert.equal(msgs[4].content, 'r2'); // most-recent tool result is the tail
});

test('empty history → prefix only', async () => {
  const s = new LegacyAccumulateContextStrategy();
  assert.deepEqual(await s.form({ prefix }), prefix);
});

test('snapshot/restore round-trips as JSON and is versioned', async () => {
  const s = new LegacyAccumulateContextStrategy();
  await s.record(mkRound('c1', 'r1'));
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  assert.equal(snap.version, 1);
  const s2 = new LegacyAccumulateContextStrategy();
  s2.restore(snap);
  assert.equal((await s2.form({ prefix })).length, 3);
  // unknown version → clean
  const s3 = new LegacyAccumulateContextStrategy();
  s3.restore({ version: 999 } as never);
  assert.deepEqual(await s3.form({ prefix }), prefix);
});
```

- [ ] **Step 2: Run test → FAIL** (module not found).

- [ ] **Step 3: Implement:**

```ts
import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

/** Library default — reproduces today's growing transcript byte-identically. */
export class LegacyAccumulateContextStrategy implements IToolLoopContextStrategy {
  private rounds: ToolRound[] = [];

  async record(round: ToolRound): Promise<void> {
    this.rounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix];
    for (const r of this.rounds) {
      out.push(r.assistant, ...r.results);
    }
    return out;
  }

  snapshot(): SerializableStrategyState {
    return { version: 1, rounds: this.rounds as unknown as never };
  }

  restore(state: SerializableStrategyState): void {
    this.rounds =
      state?.version === 1 && Array.isArray((state as { rounds?: unknown }).rounds)
        ? ((state as unknown as { rounds: ToolRound[] }).rounds)
        : [];
  }
}
```

- [ ] **Step 4: Add barrel** — create `index.ts` with `export { LegacyAccumulateContextStrategy } from './legacy-accumulate-context-strategy.js';`.

- [ ] **Step 5: Build + test → PASS.**

- [ ] **Step 6: Commit** — `feat(libs): LegacyAccumulateContextStrategy (byte-identical default)`.

---

### Task 3: `WindowContextStrategy` (RAG-less bounded)

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/window-context-strategy.ts`
- Test: `.../__tests__/window.test.ts`

**Interfaces:**
- Produces: `class WindowContextStrategy implements IToolLoopContextStrategy` (ctor `{ keepLastRounds?: number }`, default 3, enforced ≥1).

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { WindowContextStrategy } from '../window-context-strategy.js';

const mkRound = (id: string, text: string): ToolRound => ({
  assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'T', arguments: '{}' } }] },
  results: [{ role: 'tool', tool_call_id: id, content: text }],
});
const prefix: Message[] = [{ role: 'system', content: 'S' }];

test('form keeps only last keepLastRounds raw + one elide marker; context is bounded as N grows', async () => {
  const s = new WindowContextStrategy({ keepLastRounds: 2 });
  for (let i = 0; i < 10; i++) await s.record(mkRound(`c${i}`, `r${i}`));
  const msgs = await s.form({ prefix });
  // prefix(1) + marker(1) + 2 rounds × 2 = 6, regardless of the 10 recorded
  assert.equal(msgs.length, 6);
  assert.equal(msgs.at(-1)?.content, 'r9'); // most-recent tool result is the raw tail
  assert.ok(msgs.some((m) => m.role === 'user' && String(m.content).includes('elided')));
});

test('flatness: 50 rounds does not grow the formed context', async () => {
  const s = new WindowContextStrategy({ keepLastRounds: 3 });
  for (let i = 0; i < 50; i++) await s.record(mkRound(`c${i}`, `r${i}`));
  assert.equal((await s.form({ prefix })).length, 1 + 1 + 3 * 2);
});

test('keepLastRounds < 1 is clamped to 1 (protocol tail guaranteed)', async () => {
  const s = new WindowContextStrategy({ keepLastRounds: 0 });
  await s.record(mkRound('c1', 'r1'));
  assert.equal((await s.form({ prefix })).at(-1)?.content, 'r1');
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**

```ts
import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

export interface WindowContextStrategyOptions {
  keepLastRounds?: number;
}

/** RAG-less bounded window: last K rounds raw + one marker for the rest. */
export class WindowContextStrategy implements IToolLoopContextStrategy {
  private rounds: ToolRound[] = [];
  private readonly keep: number;

  constructor(opts: WindowContextStrategyOptions = {}) {
    this.keep = Math.max(1, opts.keepLastRounds ?? 3);
  }

  async record(round: ToolRound): Promise<void> {
    this.rounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix];
    const tailStart = Math.max(0, this.rounds.length - this.keep);
    const elided = this.rounds.slice(0, tailStart);
    if (elided.length > 0) {
      const chars = elided.reduce(
        (n, r) => n + r.results.reduce((m, x) => m + String(x.content ?? '').length, 0),
        0,
      );
      out.push({
        role: 'user',
        content: `[${elided.length} earlier tool result(s) elided — ${chars} chars]`,
      });
    }
    for (const r of this.rounds.slice(tailStart)) {
      out.push(r.assistant, ...r.results);
    }
    return out;
  }

  snapshot(): SerializableStrategyState {
    return { version: 1, rounds: this.rounds as unknown as never };
  }

  restore(state: SerializableStrategyState): void {
    this.rounds =
      state?.version === 1 && Array.isArray((state as { rounds?: unknown }).rounds)
        ? (state as unknown as { rounds: ToolRound[] }).rounds
        : [];
  }
}
```

- [ ] **Step 4: Barrel** — append `export { WindowContextStrategy } from './window-context-strategy.js';` (and the options type).

- [ ] **Step 5: Build + test → PASS.**

- [ ] **Step 6: Commit** — `feat(libs): WindowContextStrategy (RAG-less bounded window)`.

---

### Task 4: `RagRecallContextStrategy` (generic, RAG-managed)

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/rag-recall-context-strategy.ts`
- Test: `.../__tests__/rag-recall.test.ts`

**Interfaces:**
- Produces: `class RagRecallContextStrategy`, `interface RagRecallDeps { record; recall }`, `interface RagRecallStrategyRunDeps { runId: string }`. Ctor: `(deps: RagRecallDeps, run: RagRecallStrategyRunDeps)`.

- [ ] **Step 1: Failing test (deps stubbed):**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { RagRecallContextStrategy } from '../rag-recall-context-strategy.js';

const mkRound = (id: string, text: string): ToolRound => ({
  assistant: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'T', arguments: '{}' } }] },
  results: [{ role: 'tool', tool_call_id: id, content: text }],
});
const prefix: Message[] = [{ role: 'system', content: 'S' }];

test('form: null last → prefix only, recall NOT called', async () => {
  let recallCalls = 0;
  const s = new RagRecallContextStrategy(
    { record: async () => {}, recall: async () => { recallCalls++; return 'X'; } },
    { runId: 'run1' },
  );
  assert.deepEqual(await s.form({ prefix, queryText: 'q' }), prefix);
  assert.equal(recallCalls, 0);
});

test('record assigns deterministic roundId and excludes it from recall; no double-appearance', async () => {
  const recorded: string[] = [];
  let excluded: string[] = [];
  const s = new RagRecallContextStrategy(
    {
      record: async (r) => { recorded.push(r.roundId!); },
      recall: async (_q, excl) => { excluded = excl; return 'RECALL'; },
    },
    { runId: 'run1' },
  );
  await s.record(mkRound('c1', 'r1'));
  await s.record(mkRound('c2', 'r2'));
  assert.deepEqual(recorded, ['run1:0', 'run1:1']);
  const msgs = await s.form({ prefix, queryText: 'q' });
  // prefix + recall(user) + last round (assistant+tool) = 4
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].content, 'RECALL');
  assert.equal(msgs.at(-1)?.content, 'r2');
  assert.deepEqual(excluded, ['run1:1']); // exclude the raw-tail round
});

test('missing runId fails loud at construction', () => {
  assert.throws(() => new RagRecallContextStrategy({ record: async () => {}, recall: async () => '' }, { runId: '' }));
});

test('counter survives snapshot/restore (stable ids after resume)', async () => {
  const s = new RagRecallContextStrategy({ record: async () => {}, recall: async () => '' }, { runId: 'run1' });
  await s.record(mkRound('c1', 'r1'));
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  assert.equal(snap.counter, 1);
  const s2 = new RagRecallContextStrategy({ record: async () => {}, recall: async () => '' }, { runId: 'run1' });
  s2.restore(snap);
  const captured: string[] = [];
  const s3 = new RagRecallContextStrategy({ record: async (r) => captured.push(r.roundId!), recall: async () => '' }, { runId: 'run1' });
  s3.restore(snap);
  await s3.record(mkRound('c2', 'r2'));
  assert.equal(captured[0], 'run1:1'); // continues from restored counter, not 0
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**

```ts
import type {
  CallOptions,
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

export interface RagRecallDeps {
  record(round: ToolRound, options?: CallOptions): Promise<void>;
  recall(queryText: string, excludeRoundIds: string[], options?: CallOptions): Promise<string>;
}
export interface RagRecallStrategyRunDeps {
  runId: string;
}

/** Generic RAG-managed strategy. Results are durable in the consumer's RAG; only
 *  the most-recent round is held in memory (the raw tail). */
export class RagRecallContextStrategy implements IToolLoopContextStrategy {
  private last: ToolRound | null = null;
  private counter = 0;
  private readonly runId: string;

  constructor(private readonly deps: RagRecallDeps, run: RagRecallStrategyRunDeps) {
    if (!run?.runId) {
      throw new Error('RagRecallContextStrategy requires a non-empty runId');
    }
    this.runId = run.runId;
  }

  async record(round: ToolRound, options?: CallOptions): Promise<void> {
    if (!round.roundId) round.roundId = `${this.runId}:${this.counter}`;
    this.counter++;
    await this.deps.record(round, options);
    this.last = round;
  }

  async form(base: ToolLoopContextBase, options?: CallOptions): Promise<Message[]> {
    if (this.last === null) return [...base.prefix];
    const queryText = base.queryText ?? '';
    const out: Message[] = [...base.prefix];
    const block = await this.deps.recall(queryText, [this.last.roundId as string], options);
    if (block) out.push({ role: 'user', content: block });
    out.push(this.last.assistant, ...this.last.results);
    return out;
  }

  snapshot(): SerializableStrategyState {
    return { version: 1, last: (this.last as unknown as never) ?? null, counter: this.counter };
  }

  restore(state: SerializableStrategyState): void {
    if (state?.version === 1) {
      this.last = ((state as unknown as { last: ToolRound | null }).last) ?? null;
      this.counter = Number((state as unknown as { counter?: number }).counter ?? 0);
    } else {
      this.last = null;
      this.counter = 0;
    }
  }
}
```

> Note: `record` mutates `round.roundId` when unset (the caller passes a fresh object each round). The counter increments once per round regardless.

- [ ] **Step 4: Barrel** — append `export { RagRecallContextStrategy } from './rag-recall-context-strategy.js';` (+ the two deps types).

- [ ] **Step 5: Build + test → PASS.**

- [ ] **Step 6: Commit** — `feat(libs): RagRecallContextStrategy (generic RAG-managed, fail-loud runId + counter)`.

---

### Task 5: `LegacyTranscriptContextStrategy` (migration-only)

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/context/tool-loop-context/legacy-transcript-context-strategy.ts`
- Test: `.../__tests__/legacy-transcript.test.ts`

**Interfaces:**
- Produces: `class LegacyTranscriptContextStrategy` (ctor `{ rawMessages: Message[] }`).

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { LegacyTranscriptContextStrategy } from '../legacy-transcript-context-strategy.js';

const prefix: Message[] = [{ role: 'system', content: 'S' }];
const raw: Message[] = [
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'T', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'r1' },
  { role: 'user', content: 'retry feedback' },
];
const newRound: ToolRound = {
  assistant: { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'T', arguments: '{}' } }] },
  results: [{ role: 'tool', tool_call_id: 'c2', content: 'r2' }],
};

test('form = prefix + rawMessages verbatim + new rounds', async () => {
  const s = new LegacyTranscriptContextStrategy({ rawMessages: raw });
  let msgs = await s.form({ prefix });
  assert.deepEqual(msgs, [...prefix, ...raw]);
  await s.record(newRound);
  msgs = await s.form({ prefix });
  assert.equal(msgs.length, prefix.length + raw.length + 2);
  assert.equal(msgs.at(-1)?.content, 'r2');
});

test('snapshot/restore preserves rawMessages + newRounds', async () => {
  const s = new LegacyTranscriptContextStrategy({ rawMessages: raw });
  await s.record(newRound);
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const s2 = new LegacyTranscriptContextStrategy({ rawMessages: [] });
  s2.restore(snap);
  assert.equal((await s2.form({ prefix })).length, prefix.length + raw.length + 2);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**

```ts
import type {
  IToolLoopContextStrategy,
  Message,
  SerializableStrategyState,
  ToolLoopContextBase,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';

/** MIGRATION-ONLY: holds a pre-release raw transcript (arbitrary Message[]) that
 *  cannot be expressed as ToolRound[]. Never injected as a factory. */
export class LegacyTranscriptContextStrategy implements IToolLoopContextStrategy {
  private rawMessages: Message[];
  private newRounds: ToolRound[] = [];

  constructor(opts: { rawMessages: Message[] }) {
    this.rawMessages = [...opts.rawMessages];
  }

  async record(round: ToolRound): Promise<void> {
    this.newRounds.push(round);
  }

  async form(base: ToolLoopContextBase): Promise<Message[]> {
    const out: Message[] = [...base.prefix, ...this.rawMessages];
    for (const r of this.newRounds) out.push(r.assistant, ...r.results);
    return out;
  }

  snapshot(): SerializableStrategyState {
    return {
      version: 1,
      rawMessages: this.rawMessages as unknown as never,
      newRounds: this.newRounds as unknown as never,
    };
  }

  restore(state: SerializableStrategyState): void {
    if (state?.version === 1) {
      this.rawMessages = ((state as unknown as { rawMessages?: Message[] }).rawMessages) ?? [];
      this.newRounds = ((state as unknown as { newRounds?: ToolRound[] }).newRounds) ?? [];
    }
  }
}
```

- [ ] **Step 4: Barrel** — append the export.

- [ ] **Step 5: Build + test → PASS.**

- [ ] **Step 6: Commit** — `feat(libs): LegacyTranscriptContextStrategy (migration-only raw transcript)`.

---

### Task 6: DI factory threading (interfaces + builder + deps + ctx)

**Files:**
- Modify: `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (`IPipelineContext.toolLoopContextStrategyFactory?`)
- Modify: `packages/llm-agent-libs/src/agent.ts` (`SmartAgentDeps.toolLoopContextStrategyFactory?`)
- Modify: `packages/llm-agent-libs/src/interfaces/pipeline.ts` (`PipelineDeps.toolLoopContextStrategyFactory?`)
- Modify: `packages/llm-agent-libs/src/builder.ts` (`withToolLoopContextStrategyFactory` + thread into deps/ctx)
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` (`_buildContext` populates `ctx.toolLoopContextStrategyFactory`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`BuildAgentDeps.toolLoopContextStrategyFactory?` + `buildServerCtx` populate)
- Test: `packages/llm-agent-libs/src/__tests__/tool-loop-context-strategy-di.test.ts`

**Interfaces:**
- Consumes: `ToolLoopContextStrategyFactory` (Task 1), the strategies (Tasks 2-5).
- Produces: builder `withToolLoopContextStrategyFactory(f): this`; the factory reachable on `ctx.toolLoopContextStrategyFactory`, `SmartAgentDeps`, `PipelineDeps`, `BuildAgentDeps`.

> Mirror `IMcpFailureClassifier` threading EXACTLY (builder field `_mcpFailureClassifier` @180/@453; ctx populate in `_buildContext`; smart-server `_mcpFailureClassifier` in ctor + `buildServerCtx`). Grep those sites and add a parallel `toolLoopContextStrategyFactory` OPTIONAL field everywhere. All fields optional; nothing resolves a non-Legacy default at this layer.

- [ ] **Step 1: Failing test** — builder threads the factory; default is undefined at the builder level (resolved to Legacy at point-of-use later):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolLoopContextStrategyFactory } from '@mcp-abap-adt/llm-agent';
import { LegacyAccumulateContextStrategy } from '../pipeline/context/tool-loop-context/index.js';
import { SmartAgentBuilder } from '../builder.js';

test('builder.withToolLoopContextStrategyFactory stores the factory', () => {
  const factory: ToolLoopContextStrategyFactory = () => new LegacyAccumulateContextStrategy();
  const b = new SmartAgentBuilder({}).withToolLoopContextStrategyFactory(factory);
  // white-box: the private field is set (mirror the existing withMcpFailureClassifier test's approach)
  assert.equal((b as unknown as { _toolLoopContextStrategyFactory?: unknown })._toolLoopContextStrategyFactory, factory);
});
```

- [ ] **Step 2: Run → FAIL** (`withToolLoopContextStrategyFactory` undefined).

- [ ] **Step 3: Add the interface fields** — in each interface add (exact name):
  `toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;` (import the type from `@mcp-abap-adt/llm-agent`). Sites: `IPipelineContext` (pipeline-plugin.ts), `SmartAgentDeps` (agent.ts), `PipelineDeps` (interfaces/pipeline.ts), `BuildAgentDeps` (smart-server.ts).

- [ ] **Step 4: Builder** — add `private _toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;` and:

```ts
withToolLoopContextStrategyFactory(factory: ToolLoopContextStrategyFactory): this {
  this._toolLoopContextStrategyFactory = factory;
  return this;
}
```
Thread `this._toolLoopContextStrategyFactory` into the `SmartAgentDeps` and the pipeline deps the builder assembles in `build()` (same spots the classifier is threaded).

- [ ] **Step 5: ctx populate** — in `default-pipeline.ts` `_buildContext` add `toolLoopContextStrategyFactory: this.deps.toolLoopContextStrategyFactory,`; in `smart-server.ts` `buildServerCtx` (where `createServerPipelineContext` is called) pass it from `deps.toolLoopContextStrategyFactory`.

- [ ] **Step 6: Build (whole workspace) + test → PASS.**

- [ ] **Step 7: Commit** — `feat(di): thread ToolLoopContextStrategyFactory (builder + ctx + deps)`.

---

### Task 7: `tool-loop-core.ts` — return batch grouped + helper refactor

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop-core.ts` (`executeToolBatchWithHeartbeat` ADDS `resultMeta` to its outcome — it does NOT synthesize an assistant; the caller owns the assistant)
- Modify: the shared helpers `buildBlockedToolMessages` (`tool-loop-core.ts:137`) / `buildHallucinatedToolMessages` (`tool-loop-core.ts:173`) — same file — to RETURN `{ assistant: Message; results: Message[] }` instead of mutating `messages`.
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-core-group.test.ts`

**Interfaces:**
- Produces:
  - `buildBlockedToolMessages(content, blockedCalls)` → `{ assistant: Message; results: Message[] }` (a SYNTHETIC group — these helpers already own both the assistant and the tool responses).
  - `buildHallucinatedToolMessages(content, toolCalls, hallucinations)` → `{ assistant: Message; results: Message[] }`.
  - `executeToolBatchWithHeartbeat` outcome ADDS per-result exec metadata aligned to `toolMessages`: `resultMeta: Array<{ identityKey?: string; isError: boolean }>` (isError = `!r.res?.ok || (r.res.ok && !!r.res.value.isError)`). It does **NOT** build an assistant message — the CALLER owns the assistant (`content || null` + the LLM's `tool_calls`, as at tool-loop.ts:714-719), so the assistant's real `content` is preserved.

> Rationale (P1): the core has no `content` (that is the LLM's, held by the caller); the internal-batch assistant is built by the caller. So core returns only `results` + `resultMeta`, and the caller assembles the `ToolRound` = `{ assistant: <caller's assistant>, results: toolMessages, meta: resultMeta }`. The synthetic blocked/hallucinated helpers DO own their assistant, so they return full `{assistant, results}` groups.

> Additive: this task exposes the grouped/synthetic shapes and `resultMeta` without yet changing loop behavior (Tasks 8-9 consume them). Keep existing call sites compiling by appending `group.assistant, ...group.results` (blocked/hallucinated) exactly as before.

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBlockedToolMessages } from '../tool-loop-core.js';

test('buildBlockedToolMessages returns an {assistant, results} group', () => {
  const g = buildBlockedToolMessages('assistant-content', [{ id: 'c1', name: 'X', arguments: {} }] as never);
  assert.equal(g.assistant.role, 'assistant');
  assert.ok(Array.isArray(g.results));
  assert.equal(g.results[0].role, 'tool');
});
```

- [ ] **Step 2: Run → FAIL** (helper returns `Message[]`/mutates, not a group).

- [ ] **Step 3: Refactor the two synthetic helpers** to build and RETURN `{ assistant, results }` (move construction out of the in-place `messages = [...]` mutation). Update callers in `tool-loop.ts`/`agent.ts` to append `group.assistant, ...group.results` (unchanged behavior for now).

- [ ] **Step 4: `executeToolBatchWithHeartbeat`** — add `resultMeta` (aligned to `toolMessages`) to the returned outcome. Do NOT synthesize an assistant. Keep `toolMessages`.

- [ ] **Step 5: Build + test → PASS. Existing tool-loop tests still green.**

- [ ] **Step 6: Commit** — `refactor(libs): tool-loop-core exposes synthetic groups + resultMeta (caller owns internal assistant)`.

---

### Task 8: `ToolLoopHandler` (`tool-loop.ts`) — per-round strategy

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-strategy.test.ts`

**Interfaces:**
- Consumes: `ctx.toolLoopContextStrategyFactory` (Task 6), the synthetic groups + `resultMeta` (Task 7), the strategies.
- Produces: the loop calls `strategy.record(round)` for EVERY assistant-`tool_calls`+result group and `messages = (await strategy.form({ prefix: staticPrefix, queryText })).concat(controlTail)` each iteration; no `messages = [...messages, ...]` accumulation remains.

- [ ] **Step 1: Failing (flatness) test** — build a `ToolLoopHandler` run with a scripted LLM that emits K tool calls then content, a `WindowContextStrategy` factory on `ctx`, and assert the per-round context stays bounded (capture the `messages` passed to the LLM each round; assert length does not grow with K). Model the harness on the existing `tool-loop-timing-log.test.ts`. Add a SECOND case: a scripted LLM that triggers `runOutputValidationReprompt` once — assert the reprompt correction is still present in the round AFTER the next `form()` (i.e. it did not vanish).

- [ ] **Step 2: Run → FAIL** (current loop accumulates → length grows with K; the reprompt vanishes after a form()).

- [ ] **Step 3: Implement:**
  - Build `staticPrefix` = the assembled messages **after** `injectToolPriority(messages, externalTools)` (tool-loop.ts:134) — so the external-tool priority system hint is inside the prefix and re-emitted every round.
  - `const strategy = (ctx.toolLoopContextStrategyFactory ?? (() => new LegacyAccumulateContextStrategy()))({ run: undefined });` (SmartServer composition injects Window; bare = Legacy).
  - `const controlTail: Message[] = [];` (local — the pipeline loop is stateless, no durable persistence).
  - **`injectPendingResults` (tool-loop.ts:135):** convert its injected assistant/tool group into a `ToolRound` and `await strategy.record(round)` BEFORE the first `form()` (so pending mixed-call results survive subsequent rounds).
  - Replace `messages = [...messages, ...outcome.toolMessages]` (@829): build `ToolRound = { assistant: <the caller-built assistant, content||null + tool_calls>, results: outcome.toolMessages, meta: outcome.resultMeta }`, `await strategy.record(round)`.
  - Replace blocked (:578) / hallucinated (:590) / external-HIT (:622) `messages = <build>(...)`/`[...]`: build a `ToolRound` from the group and `await strategy.record(round)`.
  - **`runOutputValidationReprompt` (:525):** its assistant(content)+user(correction) is NOT a tool round → push both messages into `controlTail` (a bounded local tail, cap at the loop's max reprompts). Prune `controlTail` after the next recorded round.
  - Each iteration (and after every record/reprompt): `messages = (await strategy.form({ prefix: staticPrefix, queryText })).concat(controlTail)` (queryText = the request text).

- [ ] **Step 4: Run both tests → PASS. Existing tool-loop tests green** (no factory → Legacy → byte-identical; reprompt preserved).

- [ ] **Step 5: Commit** — `feat(libs): ToolLoopHandler forms per-round context via strategy (+ controlTail for validation reprompt)`.

---

### Task 9: Direct `SmartAgent._runStreamingToolLoop` (`agent.ts`) — per-round strategy

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts` (`_runStreamingToolLoop`, ~746; paths 1167/1176/1226/1319; injectPendingResults @773)
- Test: `packages/llm-agent-libs/src/__tests__/direct-loop-strategy.test.ts`

**Interfaces:**
- Consumes: `this.deps.toolLoopContextStrategyFactory` (Task 6), grouped helpers (Task 7).
- Produces: the direct loop applies the SAME `ToolRound` record/form rule as Task 8.

- [ ] **Step 1: Failing (flatness) test** — a `SmartAgent` built with a `WindowContextStrategy` factory in deps + a tool that returns results across K rounds; assert the per-round context stays bounded. Model on `streaming.test.ts` harness. Add a reprompt case as in Task 8.

- [ ] **Step 2: Run → FAIL** (agent.ts:1319 accumulates; reprompt vanishes).

- [ ] **Step 3: Implement** — mirror Task 8 in `_runStreamingToolLoop`:
  - `staticPrefix` = messages **after** `injectToolPriority(messages, externalTools)` (agent.ts:772).
  - `const strategy = (this.deps.toolLoopContextStrategyFactory ?? (() => new LegacyAccumulateContextStrategy()))({ run: undefined });` + `const controlTail: Message[] = [];`.
  - `injectPendingResults` (agent.ts:773) → record as a `ToolRound` BEFORE the first `form()`.
  - internal batch (1226/1319) → `ToolRound{ assistant: <caller assistant, content||null + tool_calls>, results: outcome.toolMessages, meta: outcome.resultMeta }` → `record`.
  - blocked (1167) / hallucinated (1176) → `ToolRound` from the group → `record`.
  - `runOutputValidationReprompt` (agent.ts:1101) → push assistant(content)+user(correction) into `controlTail`; prune after next round.
  - each iteration: `messages = (await strategy.form({ prefix: staticPrefix, queryText })).concat(controlTail)`.

- [ ] **Step 4: Run both tests → PASS. Existing agent tests green.**

- [ ] **Step 5: Commit** — `feat(libs): direct SmartAgent tool loop forms per-round context via strategy`.

---

### Task 10: Controller `inFlightStep` durable fields

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` (the in-flight step type)
- Test: covered by Task 11/12 (type-only change; a compile check suffices here).

**Interfaces:**
- Produces: on the in-flight step type add `contextStrategyState?: SerializableStrategyState;` and `controlTail?: Message[];` (import both types). Keep `transcript?` (read-only migration for one release).

- [ ] **Step 1: Add the fields** (import `SerializableStrategyState`, `Message` from `@mcp-abap-adt/llm-agent`). Add a JSDoc note: `transcript` is no longer written; retained one release for resume migration.
- [ ] **Step 2: Build → green (additive).**
- [ ] **Step 3: Commit** — `feat(controller): inFlightStep gains contextStrategyState + controlTail`.

---

### Task 11: Controller `runStep` — strategy record/form + controlTail + external-as-round

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (runStep loop ~1049-1355; step-start prefix ~920-945; deps ~81-95 add `toolLoopContextStrategyFactory?`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-context-strategy.test.ts`

**Interfaces:**
- Consumes: `deps.toolLoopContextStrategyFactory` (Task 6 threaded via `ControllerHandlerDeps`), the strategies, `runScopedRecall`/`buildRecallBlock` (recall.ts).
- Produces: per-round `messages = await strategy.form({ prefix: staticPrefix, queryText: step.instructions }) ++ inFlightStep.controlTail`; `strategy.record(round)` for internal + external-HIT + tool-error rounds; `controlTail` holds the three retry `{role:'user'}` messages; step-result recall stays in `staticPrefix`.

- [ ] **Step 1: Failing (flatness + protocol + controlTail) test** — a controller `runStep` driven (via the existing `controller-mcp-failloud.test.ts` harness) with a scripted executor, a `WindowContextStrategy` factory in deps, a fake `callMcp` returning results; assert:
  - (a) with K tool calls then content — the per-round executor `messages` length stays bounded as K grows;
  - (b) the tail is always the most-recent assistant+tool pair;
  - (c) a tool-level error round is recorded (present in the next `form()`);
  - (d) **controlTail** — a scripted executor turn that triggers a retry `{role:'user'}` (e.g. an unavailable/hallucinated tool, or `res.kind==='error'`): assert the retry message (1) is written into `inFlightStep.controlTail`, (2) is present in the NEXT executor `messages` (after `form()`), (3) is persisted on the bundle, and (4) is pruned (removed from `controlTail`) once the next successful round is recorded.

- [ ] **Step 2: Run → FAIL** (current loop pushes raw + resends all).

- [ ] **Step 3: Implement:**
  - Add `toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory` to `ControllerHandlerDeps`.
  - At step start (after building `staticPrefix` = system + step user msg + **step-result recall** via `runScopedRecall(['step-result'])` + `buildRecallBlock`): `const makeStrategy = () => (deps.toolLoopContextStrategyFactory ?? (() => new LegacyAccumulateContextStrategy()))({ run: { rag, runId: bundle.runId, meta, stepName: step.name } });`. **This task uses the FRESH path only: `const strategy = makeStrategy();`** (resume/migration selection is Task 12 — do NOT reference it here; Task 11 tests drive fresh runs only). Initialize the durable tail IN PLACE so append/prune write to the persisted field: `inFlightStep.controlTail = inFlightStep.controlTail ?? []; const controlTail = inFlightStep.controlTail;` (both alias the SAME array — `controlTail.push(...)`/`controlTail.length = 0` mutate the durable field, which is then persisted with the bundle).
  - Replace the raw pushes: on a successful/tool-error internal result (~1315-1352) — build `ToolRound{assistant, results, meta:[{identityKey, isError}]}`, `await strategy.record(round, ctx.options)`; the `writeArtifact(mcp-result)` moves INTO the injected `RagRecall` `record` (Task 13) so here it is the strategy's job. For an escalate (MCP-unavailable) keep the abort BEFORE record (unchanged).
  - External-tool HIT/resume (~1225-1242): build a `ToolRound` from the injected assistant/tool pair and `record` it (not a control message).
  - The three retry `{role:'user'}` messages (~1140, ~1156, ~1252): append to `inFlightStep.controlTail` (bounded ≤ maxRetries), prune on the next recorded round.
  - Each iteration: `messages = (await strategy.form({ prefix: staticPrefix, queryText: step.instructions }, ctx.options)).concat(inFlightStep.controlTail ?? [])`.
  - After each exchange: `inFlightStep.contextStrategyState = strategy.snapshot();` persist bundle (replaces the old `syncTranscript` raw-append; stop writing `transcript`).

- [ ] **Step 4: Run tests → PASS. `controller-mcp-failloud` + `controller-coordinator-handler` suites green.**

- [ ] **Step 5: Commit** — `feat(controller): per-round context via strategy + controlTail; drop raw transcript accumulation`.

---

### Task 12: Controller resume + migration (LegacyTranscript)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (resume branch)
- Test: `.../__tests__/controller-context-migration.test.ts`

**Interfaces:**
- Consumes: `LegacyTranscriptContextStrategy` (Task 5), `inFlightStep.{contextStrategyState,controlTail,transcript}`.
- Produces: resume reconstruction rule.

- [ ] **Step 1: Failing test** — (a) resume with `contextStrategyState` present → `strategy.restore` + `form ++ controlTail` continues; the external pair survives a further round; (b) a pre-existing in-flight step with only `transcript` (no `contextStrategyState`) → completes under `LegacyTranscriptContextStrategy({rawMessages: transcript})`, no context loss, no crash.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — REPLACE Task 11's fresh `const strategy = makeStrategy();` at step entry with the resume/migration selection:

```ts
let strategy: IToolLoopContextStrategy;
if (inFlightStep?.contextStrategyState !== undefined) {
  strategy = makeStrategy();
  strategy.restore(inFlightStep.contextStrategyState);
} else if (inFlightStep?.transcript?.length) {
  strategy = new LegacyTranscriptContextStrategy({ rawMessages: inFlightStep.transcript });
} else {
  strategy = makeStrategy(); // fresh step
}
```
where `makeStrategy = () => (deps.toolLoopContextStrategyFactory ?? (() => new LegacyAccumulateContextStrategy()))({ run: { rag, runId: bundle.runId, meta, stepName: step.name } })` (same as Task 11). `controlTail` is restored from `inFlightStep.controlTail ?? []`.

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Commit** — `feat(controller): resume via snapshot + one-release LegacyTranscript migration`.

---

### Task 13: Compositions — controller wires RagRecall; server wires Window for default/direct

**Files:**
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts` (build the `RagRecall` factory)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (inject a `Window` factory into the default-pipeline / direct-SmartAgent path via `buildServerCtx` / `BuildAgentDeps` default)
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/controller-context-wiring.test.ts`

**Interfaces:**
- Consumes: `RagRecallContextStrategy` + deps, `WindowContextStrategy`, `runScopedRecall`/`buildRecallBlock`/`writeArtifact`.
- Produces: `ctx.toolLoopContextStrategyFactory` populated per pipeline.

- [ ] **Step 1: Failing test** — build the controller plugin (mirror `controller.test.ts`); assert the controller's constructed strategy is a `RagRecallContextStrategy` whose `record` writes an `mcp-result` artifact and whose `recall` runs `runScopedRecall(['mcp-result'])` (spy the RAG handle: record → a write; form → a query excluding the last roundId).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**
  - In `controller.ts` `build()`: construct
    ```ts
    // The handler calls this factory ONCE PER STEP, passing the per-step run context
    // (`{ rag, runId, meta, stepName }`) — meta/stepName are only known inside runStep.
    const toolLoopContextStrategyFactory: ToolLoopContextStrategyFactory = ({ run }) => {
      const { rag, runId, meta, stepName } = run as {
        rag: IKnowledgeRagHandle;
        runId: string;
        meta: Record<string, unknown>;
        stepName: string;
      };
      return new RagRecallContextStrategy(
        {
          // Mirror the existing mcp-result write (was controller-coordinator-handler.ts:1316).
          // Write roundId as its OWN metadata field so recall can exclude the raw-tail
          // round by roundId — identityKey stays tool+args for dedup and is a DIFFERENT key.
          record: (round, options) =>
            writeArtifact(
              rag,
              {
                ...meta,
                artifactType: 'mcp-result',
                task: stepName,
                runId,
                identityKey: round.meta?.[0]?.identityKey ?? round.roundId,
                roundId: round.roundId,
                content: round.results.map((r) => String(r.content ?? '')).join('\n'),
              },
              options,
            ),
          recall: async (queryText, excludeRoundIds, options) => {
            const rows = await runScopedRecall(rag, queryText, RECALL_K_MCP, runId, mcpBound, ['mcp-result'], options);
            return buildRecallBlock(
              rows.filter((r) => !excludeRoundIds.includes(String(r.metadata?.roundId))),
              RECALL_MAX_CHARS_MCP,
            );
          },
        },
        { runId },
      );
    };
    ```
    and pass it to the handler deps.
  - In the server default-pipeline / direct path composition, default `toolLoopContextStrategyFactory` to `() => new WindowContextStrategy()` when the consumer did not inject one (do this in the SmartServer composition ONLY — not in `DefaultPipeline`/`SmartAgent`).

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Commit** — `feat(server): controller injects RagRecall factory; default/direct inject Window`.

---

### Task 14: Live acceptance (bounded tokens on trial :9001)

**Files:** none (verification only, no commit).

- [ ] **Step 1:** `npm run build`. Ensure mcp-abap-adt is up on `:9001` (trial; relaunch `mcp-abap-adt --transport=streamable-http --host=127.0.0.1 --port=9001 --path=/mcp/stream/http --env=trial --system-type=cloud` if needed).
- [ ] **Step 2:** Re-run the controller P3 prompt ("Create an ABAP class ZCL_MCP_AUTHOR_READER…") via the `.run/eval/run.sh` pattern against `:9001` (controller config).
- [ ] **Step 3:** From the server `.out`, aggregate `[controller] tokens executor: prompt=…` — assert the executor `sum_prompt` is dramatically lower than the pre-fix ~1.42M (per-round prompt stays bounded as tool calls grow), the answer is still a correct ZCL_MCP_AUTHOR_READER class, and there is no silent `(no response)`.
- [ ] **Step 4:** Record the before/after executor token totals in the PR description.

---

## Notes for the implementer

- Grep the `IMcpFailureClassifier` threading (`withMcpFailureClassifier`, `_mcpFailureClassifier`, `buildServerCtx`, `createServerPipelineContext`) as the exact template for Task 6 — the new factory field mirrors it 1:1 (but it is a FACTORY, not a shared instance).
- `writeArtifact` / `runScopedRecall` / `buildRecallBlock` / `RECALL_K_MCP` / `RECALL_MAX_CHARS_MCP` live in `packages/llm-agent-server-libs/src/smart-agent/controller/recall.ts` — reuse verbatim; do not reimplement ranking.
- After every task: `npm run build` (whole workspace, types cross packages), `npm run format`, scoped Biome lint (exit 0), commit only that task's files.
