# DAG Streaming Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward worker token deltas through `IInterpreter` and `DagCoordinatorHandler` so `/v1/chat/completions?stream=true` clients see incremental content during DAG execution.

**Architecture:** Optional `onPartial: (chunk) => void` callback threaded through `ISubAgentInput` → `InterpretContext` → `FinalizerInput`. Each layer wires the callback it received downward; absence preserves today's behaviour. Worker tool-loop emits content/tool-call deltas; interpreter annotates with `nodeId` and emits node-start/-end; handler maps content chunks to `ctx.yield`.

**Tech Stack:** TypeScript strict, ESM with `.js` import suffixes, Biome, node `--test` via tsx. Touches `@mcp-abap-adt/llm-agent` (contracts), `@mcp-abap-adt/llm-agent-libs` (interpreter + finalizers + tool-loop), `@mcp-abap-adt/llm-agent-server` (CHANGELOG only).

**Spec:** `docs/superpowers/specs/2026-05-29-dag-streaming-coordinator-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/llm-agent/src/interfaces/streaming.ts` | NEW | `StreamChunk` union + `OnPartial` type |
| `packages/llm-agent/src/interfaces/sub-agent.ts` | EDIT | Add `onPartial?` to `ISubAgentInput` |
| `packages/llm-agent/src/interfaces/interpreter.ts` | EDIT | Add `onPartial?` to `InterpretContext` |
| `packages/llm-agent/src/interfaces/finalizer.ts` | EDIT | Add `onPartial?` to `FinalizerInput` |
| `packages/llm-agent/src/index.ts` | EDIT | Re-export new types |
| `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` | EDIT | Emit content/tool-call deltas via `input.onPartial` |
| `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts` | EDIT | Annotate `nodeId`, emit `node-start`/`node-end`, forward callback |
| `packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts` | EDIT | Switch to `streamChat`, emit deltas |
| `packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts` | EDIT | One-shot `onPartial` call with full output |
| `packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts` | EDIT | One-shot `onPartial` call with rendered output |
| `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` | EDIT | Wire `onPartial = c => ctx.yield(...)` into interpret + finalize |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter-stream.test.ts` | NEW | Interpreter forwarding tests |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-finalizer-stream.test.ts` | NEW | LlmFinalizer streaming test |
| `packages/llm-agent-libs/src/coordinator/dag/__tests__/passthrough-finalizer-stream.test.ts` | NEW | Passthrough one-shot emit test |
| `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-stream.test.ts` | NEW | Handler wires partial deltas to ctx.yield |
| `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts` | NEW | Worker tool-loop emits via onPartial |
| `CHANGELOG.md` | EDIT | 17.1.0 entry |

---

## Tasks

### Task 1 — `StreamChunk` + `OnPartial` contract

**Files:**
- Create: `packages/llm-agent/src/interfaces/streaming.ts`
- Modify: `packages/llm-agent/src/index.ts` (or `interfaces/index.ts` barrel — match the IFinalizer pattern from PR #163)

- [ ] **1a. Write failing test.** Create `packages/llm-agent/src/interfaces/__tests__/streaming.contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '../streaming.js';

test('StreamChunk discriminated union accepts every kind', () => {
  const accept: OnPartial = (c: StreamChunk) => {
    switch (c.kind) {
      case 'content':    return c.delta.length;
      case 'tool-call':  return c.name.length;
      case 'node-start': return c.nodeId.length + c.goal.length;
      case 'node-end':   return c.ok ? 1 : 0;
    }
  };
  accept({ kind: 'content', delta: 'x' });
  accept({ kind: 'tool-call', name: 'GetProgram' });
  accept({ kind: 'node-start', nodeId: 'a', goal: 'g' });
  accept({ kind: 'node-end', nodeId: 'a', ok: true });
  assert.equal(typeof accept, 'function');
});
```

Run: `cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/streaming.contract.test.ts` — expect FAIL.

- [ ] **1b. Implement.** Create `packages/llm-agent/src/interfaces/streaming.ts`:

```ts
/**
 * Per-event chunk type emitted by `onPartial` callbacks along the
 * worker → interpreter → coordinator path.
 *
 * `content` carries an LLM-output delta; `tool-call` flags a tool
 * invocation; `node-start` / `node-end` wrap a DAG node execution at
 * the interpreter layer. `nodeId` is supplied by the interpreter when
 * forwarding worker-emitted chunks (workers don't know their node id).
 */
export type StreamChunk =
  | { kind: 'content'; nodeId?: string; delta: string }
  | { kind: 'tool-call'; nodeId?: string; name: string; args?: unknown }
  | { kind: 'node-start'; nodeId: string; goal: string }
  | { kind: 'node-end'; nodeId: string; ok: boolean };

export type OnPartial = (chunk: StreamChunk) => void;
```

Edit `packages/llm-agent/src/interfaces/index.ts` (or `src/index.ts`) — re-export:
```ts
export type { OnPartial, StreamChunk } from './streaming.js';
```

- [ ] **1c. Build + test.**
```
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/streaming.contract.test.ts
```

- [ ] **1d. Commit.**
```
git add packages/llm-agent/src/interfaces/streaming.ts \
        packages/llm-agent/src/interfaces/__tests__/streaming.contract.test.ts \
        packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(contracts): add StreamChunk + OnPartial for DAG streaming

Discriminated union over content / tool-call / node-start / node-end
events. OnPartial is the fire-and-forget callback threaded through
worker, interpreter, and finalizer inputs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2 — Thread `onPartial` through ISubAgentInput

**Files:**
- Modify: `packages/llm-agent/src/interfaces/sub-agent.ts`

- [ ] **2a. Write failing test.** APPEND to existing `packages/llm-agent/src/interfaces/__tests__/sub-agent.contract.test.ts` (if it doesn't exist, create with one prior pass-through test as well):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent, ISubAgentInput, OnPartial } from '../../index.js';

test('ISubAgentInput exposes optional onPartial; absence is the default', async () => {
  const partials: string[] = [];
  const op: OnPartial = (c) => { if (c.kind === 'content') partials.push(c.delta); };
  const agent: ISubAgent = {
    name: 'stub',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run(input: ISubAgentInput) {
      input.onPartial?.({ kind: 'content', delta: 'hi' });
      return { output: 'final' };
    },
  };
  await agent.run({ task: 't' });                       // absence → noop, no throw
  await agent.run({ task: 't', onPartial: op });
  assert.deepEqual(partials, ['hi']);
});
```

Run: `cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/sub-agent.contract.test.ts` — expect FAIL (`onPartial` not on type).

- [ ] **2b. Implement.** Edit `packages/llm-agent/src/interfaces/sub-agent.ts` — extend `ISubAgentInput`:

```ts
import type { OnPartial } from './streaming.js';

export interface ISubAgentInput {
  task: string;
  sessionId?: string;
  signal?: AbortSignal;
  trace?: { traceId: string };
  sessionLogger?: { logStep(name: string, data: unknown): void };
  /** Optional per-event callback for streaming worker output upstream.
   *  Fire-and-forget — implementations must never let the callback throw
   *  break the run. Absence preserves today's silent behaviour. */
  onPartial?: OnPartial;
}
```

- [ ] **2c. Build + test + commit.**
```
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/sub-agent.contract.test.ts
git add packages/llm-agent/src/interfaces/sub-agent.ts \
        packages/llm-agent/src/interfaces/__tests__/sub-agent.contract.test.ts
git commit -m "feat(contracts): extend ISubAgentInput with optional onPartial

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3 — Thread `onPartial` through InterpretContext + FinalizerInput

**Files:**
- Modify: `packages/llm-agent/src/interfaces/interpreter.ts`
- Modify: `packages/llm-agent/src/interfaces/finalizer.ts`

- [ ] **3a. Write failing tests.** Create `packages/llm-agent/src/interfaces/__tests__/interpreter-stream.contract.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InterpretContext, OnPartial } from '../../index.js';

test('InterpretContext exposes optional onPartial', () => {
  const op: OnPartial = () => {};
  const ctx: InterpretContext = {
    inputText: 'x',
    workers: new Map(),
    sessionId: 's',
    onPartial: op,
  };
  assert.equal(typeof ctx.onPartial, 'function');
});
```

APPEND to existing `packages/llm-agent/src/interfaces/__tests__/finalizer.contract.test.ts`:

```ts
test('FinalizerInput exposes optional onPartial', () => {
  const op: OnPartial = () => {};
  const input: FinalizerInput = {
    prompt: 'p', objective: 'o',
    interpreterOutput: 'i', executionTrace: [],
    onPartial: op,
  };
  assert.equal(typeof input.onPartial, 'function');
});
```

Run both — expect FAIL.

- [ ] **3b. Implement.** Edit `packages/llm-agent/src/interfaces/interpreter.ts` — add to `InterpretContext`:
```ts
import type { OnPartial } from './streaming.js';
// inside InterpretContext:
  /** Forwarded into each `worker.run({ ..., onPartial })`; the
   *  interpreter annotates `nodeId` before calling and emits
   *  `node-start` / `node-end` itself. */
  onPartial?: OnPartial;
```

Edit `packages/llm-agent/src/interfaces/finalizer.ts` — add to `FinalizerInput`:
```ts
import type { OnPartial } from './streaming.js';
// inside FinalizerInput:
  /** Optional streaming sink for finalizer-produced content.
   *  LlmFinalizer streams synthesis deltas; Passthrough/Template
   *  emit one chunk equal to their full output. */
  onPartial?: OnPartial;
```

- [ ] **3c. Build + test + commit.**
```
npm --workspace @mcp-abap-adt/llm-agent run build
cd packages/llm-agent && npx tsx --test src/interfaces/__tests__/interpreter-stream.contract.test.ts src/interfaces/__tests__/finalizer.contract.test.ts
git add packages/llm-agent/src/interfaces/interpreter.ts \
        packages/llm-agent/src/interfaces/finalizer.ts \
        packages/llm-agent/src/interfaces/__tests__/interpreter-stream.contract.test.ts \
        packages/llm-agent/src/interfaces/__tests__/finalizer.contract.test.ts
git commit -m "feat(contracts): extend InterpretContext + FinalizerInput with onPartial

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 — Worker `tool-loop` emits deltas via `input.onPartial`

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts`

- [ ] **4a. Write failing test.** Create the test file:
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial } from '@mcp-abap-adt/llm-agent';
import { ToolLoopHandler } from '../tool-loop.js';

test('tool-loop emits content deltas via input.onPartial when present', async () => {
  // Stub LLM that streamChat yields three deltas.
  const llm = {
    name: 'stub',
    async chat() { return { ok: true, value: { content: 'abc' } }; },
    async *streamChat() {
      yield { ok: true, value: { content: 'a' } };
      yield { ok: true, value: { content: 'b' } };
      yield { ok: true, value: { content: 'c', finishReason: 'stop' } };
    },
  } as never;
  const deltas: string[] = [];
  const onPartial: OnPartial = c => c.kind === 'content' && deltas.push(c.delta);
  const handler = new ToolLoopHandler({ /* fill required deps shape */ });
  // Synthesise a minimal PipelineContext with onPartial in scope:
  await handler.execute(
    { /* ctx */ inputText: 'x', onPartial, yield(){}, requestLogger: { logLlmCall(){}, getSummary(){return{}}, startRequest(){} } } as never,
    {},
    {} as never,
  );
  assert.deepEqual(deltas, ['a','b','c']);
});

test('tool-loop without onPartial does not emit', async () => {
  // Same stub; absent callback — completes silently, returns full content.
});
```

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/tool-loop-stream.test.ts` — expect FAIL.

- [ ] **4b. Implement.** In `tool-loop.ts` locate the `for await (const chunk of stream)` (or equivalent `streamChat` consumer). Add:
```ts
const onPartial = ctx.onPartial;  // forwarded from caller via context, or read from a per-call input shape
// inside the for-await loop, right where chunk.value.content is observed:
if (onPartial && chunk.value?.content) {
  onPartial({ kind: 'content', delta: chunk.value.content });
}
if (onPartial && chunk.toolCalls?.length) {
  for (const tc of chunk.toolCalls) {
    if (tc.name) onPartial({ kind: 'tool-call', name: tc.name, args: tc.arguments });
  }
}
```

If `ctx.onPartial` is not the right place to read from (the actual data path is via the request input not the context), thread it from the subagent run signature:
- In `DirectLlmSubAgent` (or whichever ISubAgent impl runs the pipeline), pass `input.onPartial` into the PipelineContext build.

The implementer should read `packages/llm-agent-libs/src/sub-agent/direct-llm-sub-agent.ts` (or equivalent) to confirm exact threading.

- [ ] **4c. Test + commit.**
```
cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/tool-loop-stream.test.ts
git add packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts \
        packages/llm-agent-libs/src/sub-agent/direct-llm-sub-agent.ts \
        packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts
git commit -m "feat(dag): tool-loop emits content + tool-call deltas via onPartial

When the calling subagent passes input.onPartial, every streamChat
content chunk and tool-call event is forwarded as a StreamChunk.
Absence preserves silent behaviour.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5 — Interpreter forwards + annotates `nodeId`, emits node-start/-end

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter-stream.test.ts`

- [ ] **5a. Write failing test.**
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISubAgent, OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { DagPlanInterpreter } from '../dag-plan-interpreter.js';

test('interpreter wraps worker.run with nodeId-annotated onPartial and emits node-start/-end', async () => {
  const calls: StreamChunk[] = [];
  const op: OnPartial = c => calls.push(c);
  const worker: ISubAgent = {
    name: 'w', description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run(input) {
      input.onPartial?.({ kind: 'content', delta: 'X' });
      return { output: 'X' };
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 },
    { inputText: 'x', workers: new Map([['w', worker]]), sessionId: 's', onPartial: op },
  );
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    { kind: 'node-start', nodeId: 'a', goal: 'ga' },
    { kind: 'content', nodeId: 'a', delta: 'X' },
    { kind: 'node-end', nodeId: 'a', ok: true },
  ]);
});
```

Run — expect FAIL.

- [ ] **5b. Implement.** In `dag-plan-interpreter.ts` per-node run helper:
```ts
const onPartial = ctx.onPartial;
onPartial?.({ kind: 'node-start', nodeId: node.id, goal: node.goal });
try {
  const res = await worker.run({
    task: composeNodeTask(node, ...),
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    trace: ctx.trace,
    sessionLogger: ctx.sessionLogger,
    onPartial: onPartial
      ? c => onPartial({ ...c, nodeId: 'nodeId' in c ? c.nodeId ?? node.id : node.id })
      : undefined,
  });
  onPartial?.({ kind: 'node-end', nodeId: node.id, ok: true });
  return res;
} catch (e) {
  onPartial?.({ kind: 'node-end', nodeId: node.id, ok: false });
  throw e;
}
```
The literal `'nodeId' in c` test is needed because `node-start`/`node-end` carry `nodeId` already; `content`/`tool-call` get it injected.

- [ ] **5c. Test + commit.**
```
cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/dag-plan-interpreter-stream.test.ts
git add packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter-stream.test.ts
git commit -m "feat(dag): interpreter forwards onPartial, annotates nodeId

Wraps worker.run with an onPartial that injects the current node.id
into content/tool-call chunks and emits node-start / node-end around
the call. Failure path also emits node-end with ok:false.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6 — `PassthroughFinalizer` / `TemplateFinalizer` one-shot emit

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/passthrough-finalizer-stream.test.ts`

- [ ] **6a. Write failing test.**
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OnPartial, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { PassthroughFinalizer } from '../passthrough-finalizer.js';

test('PassthroughFinalizer fires onPartial once with the full output', async () => {
  const f = new PassthroughFinalizer();
  const chunks: StreamChunk[] = [];
  const op: OnPartial = c => chunks.push(c);
  const res = await f.finalize({
    prompt: 'p', objective: 'o',
    interpreterOutput: 'HELLO', executionTrace: [],
    onPartial: op,
  });
  assert.equal(res.output, 'HELLO');
  assert.deepEqual(chunks, [{ kind: 'content', delta: 'HELLO' }]);
});
```
Same pattern for TemplateFinalizer (compose its rendered output, expect ONE chunk).

- [ ] **6b. Implement.** Add `input.onPartial?.({ kind: 'content', delta: <output> })` immediately before returning. Trivial; no logic change otherwise.

- [ ] **6c. Test + commit.**
```
git add packages/llm-agent-libs/src/coordinator/dag/passthrough-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/dag/template-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/passthrough-finalizer-stream.test.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/template-finalizer-stream.test.ts
git commit -m "feat(dag): Passthrough/Template finalizers emit one-shot onPartial

Preserves single-yield semantics for non-LLM finalizers — the chunk
arrives at the very end, matching the pre-streaming behaviour for
those modes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7 — `LlmFinalizer` switches to `streamChat`, emits deltas

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-finalizer-stream.test.ts`

- [ ] **7a. Write failing test.**
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, OnPartial } from '@mcp-abap-adt/llm-agent';
import { LlmFinalizer } from '../llm-finalizer.js';

test('LlmFinalizer streams deltas via onPartial and returns concatenated output', async () => {
  const llm: ILlm = {
    name: 'stub',
    async chat() { return { ok: true, value: { content: 'unused' } }; },
    async *streamChat() {
      yield { ok: true, value: { content: 'A' } };
      yield { ok: true, value: { content: 'B' } };
      yield { ok: true, value: { content: 'C', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 3, totalTokens: 4 } } };
    },
  };
  const f = new LlmFinalizer(llm);
  const deltas: string[] = [];
  const op: OnPartial = c => c.kind === 'content' && deltas.push(c.delta);
  const res = await f.finalize({
    prompt: 'p', objective: 'o',
    interpreterOutput: 'I', executionTrace: [],
    onPartial: op,
  });
  assert.equal(res.output, 'ABC');
  assert.deepEqual(deltas, ['A','B','C']);
  assert.deepEqual(res.usage, { promptTokens: 1, completionTokens: 3, totalTokens: 4 });
});
```

- [ ] **7b. Implement.** Replace `await this.llm.chat(messages, [], opts)` with:
```ts
let buf = '';
let usage: LlmUsage | undefined;
for await (const chunk of this.llm.streamChat(messages, [], { signal, sessionId })) {
  if (chunk.ok === false) throw new Error(chunk.error.message);
  const content = chunk.value.content ?? '';
  if (content) {
    buf += content;
    input.onPartial?.({ kind: 'content', delta: content });
  }
  if (chunk.value.usage) usage = chunk.value.usage;
}
return { output: buf, usage };
```

- [ ] **7c. Test + commit.**
```
git add packages/llm-agent-libs/src/coordinator/dag/llm-finalizer.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-finalizer-stream.test.ts
git commit -m "feat(dag): LlmFinalizer streams via llm.streamChat + onPartial

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8 — `DagCoordinatorHandler` wires `ctx.yield` as `onPartial`

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-stream.test.ts`

- [ ] **8a. Write failing test.**
```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DagPlan, IInterpreter, InterpretResult, IPlanner, ISubAgent } from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

test('handler yields content deltas as soon as interpreter/finalizer emit them', async () => {
  const planner: IPlanner = { name: 'p', async plan() {
    return { plan: { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 } };
  }};
  const worker: ISubAgent = {
    name: 'w', description: 'd', capabilities: { contextPolicy: 'optional' },
    async run() { return { output: 'X' }; },
  };
  const interpreter: IInterpreter<DagPlan, InterpretResult> = {
    name: 'i',
    async interpret(plan, ctx) {
      // Simulate worker streaming.
      ctx.onPartial?.({ kind: 'node-start', nodeId: 'a', goal: 'ga' });
      ctx.onPartial?.({ kind: 'content', nodeId: 'a', delta: 'foo' });
      ctx.onPartial?.({ kind: 'content', nodeId: 'a', delta: 'bar' });
      ctx.onPartial?.({ kind: 'node-end', nodeId: 'a', ok: true });
      return {
        ok: true,
        nodeResults: { a: { nodeId: 'a', output: 'foobar', status: 'done', durationMs: 1 } },
        output: 'foobar',
        executedPlan: plan,
        executionOrder: ['a'],
      };
    },
  };
  const yields: string[] = [];
  const ctx = {
    inputText: 'do', sessionId: 's', history: [],
    requestLogger: { startRequest(){}, getSummary(){return{}}, logLlmCall(){}, logStep(){} },
    yield(c: { value?: { content?: string } }) {
      if (c?.value?.content) yields.push(c.value.content);
    },
    options: { trace: { traceId: 't1' } },
  } as never;
  const h = new DagCoordinatorHandler({ planner, interpreter, workers: new Map([['w', worker]]) });
  await h.execute(ctx, {}, {} as never);
  assert.deepEqual(yields, ['foo','bar','foobar']);  // 2 streamed deltas + 1 Passthrough finalizer one-shot
});
```

(Note: PassthroughFinalizer emits `interpreterOutput` once at the end → 3rd yield.)

- [ ] **8b. Implement.** In `DagCoordinatorHandler.execute` success branch, build:
```ts
const yieldContent = (delta: string) =>
  ctx.yield({ ok: true, value: { content: delta } });
const onPartial: OnPartial = chunk => {
  if (chunk.kind === 'content') yieldContent(chunk.delta);
  // node-start / node-end / tool-call → session log only
  ctx.options?.sessionLogger?.logStep('dag_stream', chunk);
};
const result = await this.deps.interpreter.interpret(plan, {
  ...interpretCtx,
  onPartial,
});
// after if (result.ok), inside the finalRes runRole:
const finalRes = await runRole('finalizer', this.finalizer.model, () =>
  this.finalizer.finalize({
    /* existing fields */,
    onPartial,
  }),
);
// Remove the explicit ctx.yield of finalText — finalizer already streamed it (PassthroughFinalizer fires onPartial with the full text; LlmFinalizer streams per token). Keep the final 'stop' yield with usage.
```

The implementer should be careful: the existing code path also writes `ctx.yield({ ok: true, value: { content: finalText } })`. With Passthrough finalizer the content yielded via onPartial would duplicate that line — delete the explicit yield, let onPartial own all content emission.

- [ ] **8c. Test + commit.**
```
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts \
        packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-stream.test.ts
git commit -m "feat(dag): DagCoordinatorHandler wires onPartial → ctx.yield

content chunks become ctx.yield({content}) immediately; node-start /
node-end / tool-call land in session log as 'dag_stream' steps. The
final 'stop' yield with usage stays unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9 — Per-package test sweep + CHANGELOG

- [ ] **9a. Run every test suite.**
```
npm run build
cd packages/llm-agent       && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test
cd ../llm-agent-libs        && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test
cd ../llm-agent-server      && find src -name "*.test.ts" -print0 | xargs -0 npx tsx --test
cd ../..
npm run lint:check
```
All green. Fix any regressions inline.

- [ ] **9b. CHANGELOG.** APPEND to the existing in-progress 17.0.0 section of `CHANGELOG.md` (do NOT create a 17.1.0 heading — streaming ships in 17.0.0):
```md
### Added (DAG streaming, finalisation of role surface)
- DAG coordinator streams worker token deltas through `IInterpreter` and
  `DagCoordinatorHandler` to `/v1/chat/completions?stream=true` clients.
  Opt-in via the new `onPartial: (StreamChunk) => void` callback on
  `ISubAgentInput`, `InterpretContext`, and `FinalizerInput`; absence
  preserves the previous one-shot SSE behaviour.
- New types `StreamChunk` (content/tool-call/node-start/node-end) and
  `OnPartial` exported from `@mcp-abap-adt/llm-agent`.

### Changed
- `LlmFinalizer` now uses `ILlm.streamChat` internally; the public
  `FinalizerResult.output` value is unchanged (full concatenated text).
- `PassthroughFinalizer` / `TemplateFinalizer` invoke `onPartial` once
  with their full output before resolving (single-yield semantics).
```

- [ ] **9c. Commit.**
```
git add CHANGELOG.md
git commit -m "docs(changelog): 17.1.0 — DAG streaming coordinator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10 — Integration smoke test against `02-hybrid-sonnet-haiku.yaml`

- [ ] **10a. Manual verification (no commit).**
  - Build, start server on `docs/examples/dag-coordinator/02-hybrid-sonnet-haiku.yaml`.
  - Run `docs/examples/dag-coordinator/stream-test.sh 4016 hybrid '<short prompt>'`.
  - Confirm content deltas appear within ≤ 2 s of the first server-side `streamChat chunk received` log line (acceptance criterion from spec §I).
  - Confirm `/v1/usage.byComponent` totals match the previous (one-shot) build for the same prompt within ±1%.

---

## Self-Review (spec ↔ task mapping)

| Spec requirement | Implementing task(s) |
|---|---|
| **A** Today's silence problem | Tasks 4, 5, 8 (forward worker → interpreter → handler) |
| **B** Optional `onPartial` everywhere | Tasks 2, 3 (contracts), 4–7 (impl) |
| **C.1** `StreamChunk` discriminated union | Task 1 |
| **C.2** `ISubAgentInput.onPartial` | Task 2 |
| **C.3** `InterpretContext.onPartial` | Task 3 |
| **C.4** `FinalizerInput.onPartial` | Task 3 |
| **D.1** Worker tool-loop emission | Task 4 |
| **D.2** Interpreter forwarding + node-start/-end | Task 5 |
| **D.3** Coordinator wiring (ctx.yield mapping) | Task 8 |
| **D.4** LlmFinalizer streamChat switch | Task 7 |
| **D.5** Passthrough/Template one-shot emit | Task 6 |
| **E.1–E.8** Provability tests | Tasks 4–8 each include the per-spec test |
| **E.9** SSE integration test | Task 10 (manual smoke) |
| **F** Logger receives non-content as steps | Task 8 (`logStep('dag_stream', chunk)`) |
| **G** Backward compat | All tests pass without `onPartial` (existing tests untouched) |
| **H** Out-of-scope reaffirmation | Reviewer/oracle streaming intentionally NOT touched |
| **I** Acceptance | Task 10 manual verification |
