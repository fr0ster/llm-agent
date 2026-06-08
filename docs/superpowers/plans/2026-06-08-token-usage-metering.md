# End-to-End Token Usage Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `response.usage` (and `/v1/usage`) account for every LLM and embedder call on every pipeline path (flat, stepper, dag, controller, pass), via a single aggregator (`IRequestLogger`).

**Architecture:** Reuse the existing `IRequestLogger`/`SessionRequestLogger` aggregator. Add request-time logging where it is currently absent: route the controller's `logUsage` into `ctx.requestLogger`; wrap the global embedder in a `UsageLoggingEmbedder` (enumeration-proof — `QueryEmbedding` memoizes one `embed()` per instance). Unify delivery: every successful path emits exactly one terminal usage chunk built from `getSummary(traceId)` incl. `models`. Normalize `traceId` into `opts` so logging is request-scoped.

**Tech Stack:** TypeScript ESM (`.js` import extensions), Node ≥22, tests via `node --import tsx/esm --test` (`node:test` + `node:assert/strict`), Biome.

**Reference spec:** `docs/superpowers/specs/2026-06-08-token-usage-metering-design.md`

**Build/test commands:**
- Build all: `npm run build`
- Test one package: `npm -w @mcp-abap-adt/llm-agent test` (or `-w @mcp-abap-adt/llm-agent-libs`, `-w @mcp-abap-adt/llm-agent-server-libs`)
- Test one file: `node --import tsx/esm --test --test-reporter=spec packages/<pkg>/src/<path>.test.ts`

**Ordering note:** Tasks are dependency-ordered. The removals (controller private `total`; `rag-query.ts:102` inline embedding log) MUST land together with their replacements (Tasks 7, 5) to avoid a double-count/under-count window — they are sequenced accordingly.

---

### Task 1: Contract additions (`@mcp-abap-adt/llm-agent`)

**Files:**
- Modify: `packages/llm-agent/src/interfaces/request-logger.ts` (add `'executor'` to `LlmComponent`)
- Modify: `packages/llm-agent/src/interfaces/types.ts:24` (add `requestLogger?` to `CallOptions`)
- Modify: `packages/llm-agent/src/interfaces/knowledge-rag.ts:60` (`IToolsRagHandle.query` options param)
- Modify: `packages/llm-agent-libs/src/logger/default-request-logger.ts:24` (`CATEGORY_MAP.executor`)
- Test: `packages/llm-agent/src/interfaces/__tests__/llm-component.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/interfaces/__tests__/llm-component.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORY_MAP } from '../../../../llm-agent-libs/src/logger/default-request-logger.js';
import type { LlmComponent } from '../request-logger.js';

test("LlmComponent includes 'executor' mapped to 'request'", () => {
  const c: LlmComponent = 'executor';
  assert.equal(CATEGORY_MAP[c], 'request');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/llm-component.test.ts`
Expected: FAIL — type error / `CATEGORY_MAP.executor` is `undefined`.

- [ ] **Step 3: Implement the contract additions**

In `request-logger.ts`, add `'executor'` to the union (after `'evaluator'`):

```ts
  | 'evaluator'
  | 'executor'
  | 'reviewer'
```

In `types.ts`, add to `CallOptions` (after `sessionLogger`) — import the type at top of file: `import type { IRequestLogger } from './request-logger.js';`:

```ts
  /** Per-request logger used by the embedder-boundary usage wrapper to attribute
   *  embedding spend to this request. Structural, optional. */
  requestLogger?: IRequestLogger;
```

In `knowledge-rag.ts`, change the `query` signature (import `CallOptions` if not present):

```ts
  query(
    text: string,
    k?: number,
    options?: CallOptions,
  ): Promise<readonly LlmTool[]>;
```

In `default-request-logger.ts` `CATEGORY_MAP`, add after `evaluator`:

```ts
  evaluator: 'auxiliary',
  executor: 'request',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/llm-component.test.ts`
Expected: PASS. Then `npm run build` — Expected: clean (the `IToolsRagHandle.query` widening is backward-compatible; existing callers compile).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces packages/llm-agent-libs/src/logger/default-request-logger.ts
git commit -m "feat(contracts): LlmComponent 'executor', CallOptions.requestLogger, IToolsRagHandle.query options"
```

---

### Task 2: Embedding categorized by `scope` in `aggregate()`

**Files:**
- Modify: `packages/llm-agent-libs/src/logger/session-request-logger.ts:52`
- Modify: `packages/llm-agent-libs/src/logger/default-request-logger.ts:99`
- Test: `packages/llm-agent-libs/src/logger/__tests__/embedding-category.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/logger/__tests__/embedding-category.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../session-request-logger.js';

test('request-scoped embedding is categorized as request, not initialization', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t1');
  log.logLlmCall({
    component: 'embedding', model: 'embedder',
    promptTokens: 8, completionTokens: 0, totalTokens: 8,
    durationMs: 0, scope: 'request', requestId: 't1',
  });
  const s = log.getSummary('t1');
  assert.equal(s.byCategory.request?.totalTokens, 8);
  assert.equal(s.byCategory.initialization, undefined);
});

test('embedding without request scope stays initialization', () => {
  const log = new SessionRequestLogger();
  log.startRequest('t2');
  log.logLlmCall({
    component: 'embedding', model: 'embedder',
    promptTokens: 8, completionTokens: 0, totalTokens: 8,
    durationMs: 0, requestId: 't2',
  });
  assert.equal(log.getSummary('t2').byCategory.initialization?.totalTokens, 8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/logger/__tests__/embedding-category.test.ts`
Expected: FAIL — first test: `byCategory.request` is `undefined` (embedding statically maps to `initialization`).

- [ ] **Step 3: Implement scope-aware categorization**

In `session-request-logger.ts:52`, replace:

```ts
    const catKey = CATEGORY_MAP[c.component] ?? 'request';
```

with:

```ts
    const catKey =
      c.component === 'embedding' && c.scope === 'request'
        ? 'request'
        : (CATEGORY_MAP[c.component] ?? 'request');
```

In `default-request-logger.ts:99`, replace:

```ts
      const cat = CATEGORY_MAP[call.component] ?? 'request';
```

with:

```ts
      const cat =
        call.component === 'embedding' && call.scope === 'request'
          ? 'request'
          : (CATEGORY_MAP[call.component] ?? 'request');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/logger/__tests__/embedding-category.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/logger
git commit -m "feat(logger): categorize request-scoped embeddings as 'request'"
```

---

### Task 3: `UsageLoggingEmbedder` + `wrapEmbedder` factory

**Files:**
- Create: `packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts`
- Test: `packages/llm-agent-libs/src/adapters/__tests__/usage-logging-embedder.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/adapters/__tests__/usage-logging-embedder.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IEmbedder, IEmbedderBatch, LlmCallEntry } from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '../usage-logging-embedder.js';

function makeLogger() {
  const entries: LlmCallEntry[] = [];
  return { entries, logLlmCall: (e: LlmCallEntry) => entries.push(e),
    logRagQuery() {}, logToolCall() {}, startRequest() {}, endRequest() {},
    dropRequest() {}, getSummary() { return {} as never; }, reset() {} };
}
const opts = (logger: ReturnType<typeof makeLogger>) =>
  ({ trace: { traceId: 'r1' }, requestLogger: logger });

test('logs provider-reported usage verbatim', async () => {
  const logger = makeLogger();
  const inner: IEmbedder = { embed: async () => ({ vector: [1], usage: { promptTokens: 5, totalTokens: 5 } }) };
  await wrapEmbedder(inner).embed('hi', opts(logger) as never);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].component, 'embedding');
  assert.equal(logger.entries[0].model, 'embedder');
  assert.equal(logger.entries[0].scope, 'request');
  assert.equal(logger.entries[0].totalTokens, 5);
  assert.notEqual(logger.entries[0].estimated, true);
});

test('estimates when provider returns no usage', async () => {
  const logger = makeLogger();
  const inner: IEmbedder = { embed: async () => ({ vector: [1] }) };
  await wrapEmbedder(inner).embed('12345678', opts(logger) as never); // len 8 -> ceil(8/4)=2
  assert.equal(logger.entries[0].estimated, true);
  assert.equal(logger.entries[0].totalTokens, 2);
});

test('no requestLogger -> no log (startup vectorization)', async () => {
  const inner: IEmbedder = { embed: async () => ({ vector: [1] }) };
  const r = await wrapEmbedder(inner).embed('hi', { trace: { traceId: 'r1' } } as never);
  assert.deepEqual(r.vector, [1]);
});

test('idempotent: re-wrapping returns the same instance', () => {
  const inner: IEmbedder = { embed: async () => ({ vector: [1] }) };
  const w = wrapEmbedder(inner);
  assert.equal(wrapEmbedder(w), w);
});

test('preserves IEmbedderBatch and logs summed batch usage', async () => {
  const logger = makeLogger();
  let batchCalls = 0;
  const inner: IEmbedderBatch = {
    embed: async () => ({ vector: [1], usage: { promptTokens: 5, totalTokens: 5 } }),
    embedBatch: async (texts) => { batchCalls++; return texts.map(() => ({ vector: [1], usage: { promptTokens: 3, totalTokens: 3 } })); },
  };
  const w = wrapEmbedder(inner);
  assert.equal(isBatchEmbedder(w), true);
  await (w as IEmbedderBatch).embedBatch(['a', 'b'], opts(logger) as never);
  assert.equal(batchCalls, 1); // one call, not N
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].totalTokens, 6); // 3+3 summed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/adapters/__tests__/usage-logging-embedder.test.ts`
Expected: FAIL — `wrapEmbedder` not exported.

- [ ] **Step 3: Implement the wrapper + factory**

Create `packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts`:

```ts
import type {
  CallOptions,
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-embedder');

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Log one embedding entry from a result (or an estimate when usage is absent). */
function logEmbed(options: CallOptions | undefined, text: string, usage: IEmbedResult['usage']): void {
  const logger = options?.requestLogger;
  if (!logger) return; // outside a request (e.g. startup vectorization) -> no-op
  const measured = usage?.totalTokens;
  const totalTokens = measured ?? estimateTokens(text);
  logger.logLlmCall({
    component: 'embedding',
    model: 'embedder',
    promptTokens: usage?.promptTokens ?? totalTokens,
    completionTokens: 0,
    totalTokens,
    durationMs: 0,
    scope: 'request',
    requestId: options?.trace?.traceId,
    ...(measured === undefined ? { estimated: true } : {}),
  });
}

class UsageLoggingEmbedder implements IEmbedder {
  readonly [BRAND] = true;
  constructor(protected readonly inner: IEmbedder) {}
  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    const r = await this.inner.embed(text, options);
    logEmbed(options, text, r.usage);
    return r;
  }
}

class UsageLoggingBatchEmbedder extends UsageLoggingEmbedder implements IEmbedderBatch {
  constructor(protected readonly inner: IEmbedderBatch) {
    super(inner);
  }
  async embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]> {
    const results = await this.inner.embedBatch(texts, options);
    const logger = options?.requestLogger;
    if (logger) {
      let prompt = 0;
      let total = 0;
      let anyMeasured = false;
      results.forEach((r, i) => {
        if (r.usage?.totalTokens !== undefined) {
          prompt += r.usage.promptTokens;
          total += r.usage.totalTokens;
          anyMeasured = true;
        } else {
          const est = estimateTokens(texts[i] ?? '');
          prompt += est;
          total += est;
        }
      });
      logger.logLlmCall({
        component: 'embedding',
        model: 'embedder',
        promptTokens: prompt,
        completionTokens: 0,
        totalTokens: total,
        durationMs: 0,
        scope: 'request',
        requestId: options?.trace?.traceId,
        ...(anyMeasured ? {} : { estimated: true }),
      });
    }
    return results;
  }
}

/** Idempotent: returns `inner` unchanged if already wrapped; batch-capable when
 *  `inner` is an IEmbedderBatch (preserves `isBatchEmbedder`). */
export function wrapEmbedder(inner: IEmbedder): IEmbedder {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  return isBatchEmbedder(inner)
    ? new UsageLoggingBatchEmbedder(inner)
    : new UsageLoggingEmbedder(inner);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/adapters/__tests__/usage-logging-embedder.test.ts`
Expected: PASS (all 5). Then `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts packages/llm-agent-libs/src/adapters/__tests__/usage-logging-embedder.test.ts
git commit -m "feat(libs): UsageLoggingEmbedder + idempotent batch-preserving wrapEmbedder"
```

---

### Task 4: Wire `wrapEmbedder` at construction; export it

**Files:**
- Modify: `packages/llm-agent-libs/src/index.ts` (export `wrapEmbedder`)
- Modify: `packages/llm-agent-libs/src/builder.ts:451` (`withEmbedder` wraps)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.ts` (canonical owner — wrap before return)
- Test: covered by Task 3 (idempotency) + Task 6 integration.

- [ ] **Step 1: Wrap in `resolve-agent-embedder.ts` (canonical owner)**

In `resolve-agent-embedder.ts`, import and wrap the resolved embedder. Change the body so every return path wraps:

```ts
import { wrapEmbedder } from '@mcp-abap-adt/llm-agent-libs';
// ...
export async function resolveAgentEmbedder(
  rag: RagConfig | undefined,
  diEmbedder: IEmbedder | undefined,
  extraFactories?: Record<string, EmbedderFactory>,
): Promise<IEmbedder | undefined> {
  if (diEmbedder) return wrapEmbedder(diEmbedder);
  if (!rag) return undefined;
  const resolved = resolveEmbedder(rag, { extraFactories });
  return resolved ? wrapEmbedder(resolved) : undefined;
}
```

(Adapt to the file's actual control flow; the rule is: wrap on every non-`undefined` return.)

- [ ] **Step 2: Wrap in `builder.ts` `withEmbedder` (idempotent — safe even if already wrapped)**

In `builder.ts:451`:

```ts
  withEmbedder(embedder: IEmbedder): this {
    this._embedder = wrapEmbedder(embedder);
    return this;
  }
```

Add `import { wrapEmbedder } from './adapters/usage-logging-embedder.js';` at the top of `builder.ts`.

- [ ] **Step 3: Export `wrapEmbedder` from the package index**

In `packages/llm-agent-libs/src/index.ts`, add:

```ts
export { wrapEmbedder } from './adapters/usage-logging-embedder.js';
```

- [ ] **Step 4: Build to verify wiring**

Run: `npm run build`
Expected: clean. (`resolve-agent-embedder` can import from `@mcp-abap-adt/llm-agent-libs` — it is in `llm-agent-server-libs`, which depends on libs.)

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/index.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.ts
git commit -m "feat: wrap the global embedder with wrapEmbedder at construction (resolve + builder)"
```

---

### Task 5: Remove the inline embedding log in `rag-query.ts`

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts:99-117` (delete the `embeddingUsageLogged` block)
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/rag-query-embed-log.test.ts` (Create)

> **Coupling:** this removal is only safe because Task 4 wired the wrapper. Keep Tasks 4 → 5 adjacent.

- [ ] **Step 1: Write the test (wrapper is now the single embedding logger)**

Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/rag-query-embed-log.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('rag-query no longer logs embedding usage inline (wrapper owns it)', () => {
  const src = readFileSync(new URL('../rag-query.ts', import.meta.url), 'utf8');
  assert.equal(src.includes('embeddingUsageLogged'), false);
  assert.equal(/component:\s*'embedding'/.test(src), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/pipeline/handlers/__tests__/rag-query-embed-log.test.ts`
Expected: FAIL — `embeddingUsageLogged` still present.

- [ ] **Step 3: Delete the inline embedding-logging block**

In `rag-query.ts`, remove the entire block (around `:99-117`):

```ts
    // Log embedding usage once (first rag-query stage that uses the embedding)
    if (!ctx.embeddingUsageLogged && embedding?.getUsage) {
      const usage = await embedding.getUsage();
      if (usage) {
        ctx.requestLogger.logLlmCall({ /* ...embedding... */ });
        ctx.embeddingUsageLogged = true;
      }
    }
```

If `ctx.embeddingUsageLogged` is now unused elsewhere, leave the context field in place (harmless) to avoid widening this task; do not remove the interface field.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/pipeline/handlers/__tests__/rag-query-embed-log.test.ts`
Expected: PASS. Then `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/rag-query-embed-log.test.ts
git commit -m "refactor(rag-query): drop inline embedding log (UsageLoggingEmbedder owns it)"
```

---

### Task 6: traceId normalization in `agent.streamProcess`

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts` (after the timeout-merge block, ~`:664`)
- Test: `packages/llm-agent-libs/src/__tests__/traceid-normalization.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/__tests__/traceid-normalization.test.ts`. Build a minimal agent via the test builder helper and assert a no-`trace` call produces request-scoped logging. Use the existing test utilities pattern (a stub `ILlm` + `SessionRequestLogger`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { SmartAgent } from '../agent.js';
// Reuse the project's existing agent test harness; see other agent tests for setup.

test('generated traceId is written into opts so logLlmCall is request-scoped', async () => {
  const logger = new SessionRequestLogger();
  // Arrange a SmartAgent whose helper LLM logs via logger with requestId = opts.trace.traceId.
  // (Follow the construction used in packages/llm-agent-libs/src/__tests__/*agent*.test.ts.)
  // Act: agent.process('hello') with NO options.trace.
  // Assert: at least one logged entry has a non-empty requestId, and
  //         getSummary(thatId).totals.totalTokens === response.usage.total_tokens.
  assert.ok(true); // replace with the harness-backed assertions below in Step 3
});
```

> Implementer note: model this on the nearest existing `agent.process(...)` test in `packages/llm-agent-libs/src/__tests__/`. Capture the `requestId` by passing a `SessionRequestLogger` into the builder and reading `logger.getSummary(id)`; obtain `id` from the single logged entry.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/traceid-normalization.test.ts`
Expected: FAIL once the real assertions are in (entries carry `requestId: undefined`).

- [ ] **Step 3: Implement normalization after the timeout merge**

In `agent.ts`, locate (≈`:659-664`):

```ts
    let opts: CallOptions | undefined = options;
    if (this.config.timeoutMs) {
      const { signal, clear } = createTimeoutSignal(this.config.timeoutMs);
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, signal);
      opts = { ...options, signal: merged.signal };
    }
```

Immediately AFTER that block, add:

```ts
    // Normalize the generated traceId into opts (after the timeout merge, which
    // rebuilds opts from the original options) so every downstream logLlmCall is
    // request-scoped and getSummary(traceId) reads this request's delta.
    opts = {
      ...opts,
      trace: { ...opts?.trace, traceId },
      requestLogger: opts?.requestLogger ?? this.requestLogger,
    };
```

Finalize the Step-1 test with harness-backed assertions:

```ts
  // after building `agent` with `logger` and a stub helper/main LLM that returns usage:
  const res = await agent.process('hello');
  const summary = (logger as SessionRequestLogger).getSummary(/* id from first entry */);
  assert.ok(res.ok);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/traceid-normalization.test.ts`
Expected: PASS. Then `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/__tests__/traceid-normalization.test.ts
git commit -m "fix(agent): normalize generated traceId + requestLogger into opts"
```

---

### Task 7: Controller request-time LLM logging + getSummary terminal usage

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (logUsage body `:122-130`; `surface*` `:552-584`; remove `total`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` (`ControllerHandlerDeps` — add `models`)
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts:100-126` (build `deps.models`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/usage-logging.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/usage-logging.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
// Import the bound logUsage builder if extracted, OR drive via the handler with a fake ctx.

test('logUsage routes per-role usage into the request logger with model + requestId', () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('r1');
  const models = { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' };
  const logUsage = makeLogUsage(logger, 'r1', models); // see Step 3
  const u: LlmUsage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
  logUsage('planner', u);
  logUsage('finalizer', u);
  logUsage('evaluator', u);
  const s = logger.getSummary('r1');
  assert.equal(s.byComponent.planner?.totalTokens, 12);
  assert.equal(s.byComponent.finalizer?.totalTokens, 12);
  assert.equal(s.byModel['m-plan'].requests, 2); // planner + finalizer share the planner model
  assert.equal(s.byComponent.evaluator?.model ?? s.byModel['m-eval'] !== undefined, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/usage-logging.test.ts`
Expected: FAIL — `makeLogUsage` not exported.

- [ ] **Step 3: Implement — extract a request-time `makeLogUsage`, replace the private total**

Add `models` to `ControllerHandlerDeps` (near `selectTools`):

```ts
  /** Resolved model id per subagent role (for usage attribution). */
  models: { evaluator: string; planner: string; executor: string };
```

Add an exported helper at module scope in `controller-coordinator-handler.ts`:

```ts
export function makeLogUsage(
  requestLogger: IRequestLogger,
  requestId: string | undefined,
  models: { evaluator: string; planner: string; executor: string },
  dlog: (m: string) => void,
): (role: string, u?: LlmUsage) => void {
  return (role, u) => {
    if (!u) return;
    const model =
      role === 'finalizer' ? models.planner :
      role === 'embedding' ? 'embedder' :
      (models as Record<string, string>)[role] ?? 'unknown';
    requestLogger.logLlmCall({
      component: role as never, // role is one of evaluator|planner|executor|finalizer
      model,
      promptTokens: u.promptTokens ?? 0,
      completionTokens: u.completionTokens ?? 0,
      totalTokens: u.totalTokens ?? 0,
      durationMs: 0,
      requestId,
    });
    dlog(`tokens ${role}: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`);
  };
}
```

In `execute()`, replace the `total` accumulator + inline `logUsage` (`:117-130`) with:

```ts
    const logUsage = makeLogUsage(ctx.requestLogger, meta.traceId, deps.models, dlog);
    const usageNow = (): LlmUsage & { models?: Record<string, ModelUsageEntry> } => {
      const s = ctx.requestLogger.getSummary(meta.traceId);
      return { ...summaryToUsage(s), models: s.byModel };
    };
```

Import `summaryToUsage` from `@mcp-abap-adt/llm-agent-libs` and `IRequestLogger`, `ModelUsageEntry` from `@mcp-abap-adt/llm-agent`. Change all `surfaceFinal`/`surfaceClarify`/`surfaceToolCall`/`escalate` calls that passed `total` to pass `usageNow()` instead. Delete the `total` object and the `[controller] turn total` dlog line.

In `controller.ts` (after building the three LLMs, ~`:104`), build `deps.models`:

```ts
      models: {
        evaluator: evaluatorLlm.model ?? 'unknown',
        planner: plannerLlm.model ?? 'unknown',
        executor: executorLlm.model ?? 'unknown',
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/usage-logging.test.ts`
Expected: PASS. Then `npm run build` — clean. Run the controller suite: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/*.test.ts` — Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller packages/llm-agent-server-libs/src/pipelines/controller.ts
git commit -m "feat(controller): log subagent usage into requestLogger; terminal chunk from getSummary"
```

---

### Task 8: Controller target-state embeddings via threaded options

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/target-state.ts:40-90`
- Modify: `controller-coordinator-handler.ts` (pass `ctx.options` into `establishTargetState`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/target-state-embed-options.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { establishTargetState } from '../target-state.js';

test('establishTargetState forwards options to embedder.embed', async () => {
  const seen: unknown[] = [];
  const embedder = { embed: async (_t: string, o?: unknown) => { seen.push(o); return { vector: [1, 0, 0] }; } };
  const evaluator = { send: async () => ({ kind: 'content' as const, content: 'Goal: X' }) };
  const opts = { trace: { traceId: 'r1' } };
  await establishTargetState({ evaluator, embedder }, 'do X', { strategy: 'auto', distanceThreshold: 0.7 }, opts as never);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], opts);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/target-state-embed-options.test.ts`
Expected: FAIL — `establishTargetState` takes 3 args; `seen[0]` is `undefined`.

- [ ] **Step 3: Implement options threading**

In `target-state.ts`, add a 4th parameter and pass it to both embeds:

```ts
export async function establishTargetState(
  deps: TargetStateDeps,
  prompt: string,
  cfg: ControllerConfig['targetState'],
  options?: CallOptions,
): Promise<TargetStateOutcome> {
  // ...
    const [te, pe] = await Promise.all([
      deps.embedder.embed(target, options),
      deps.embedder.embed(prompt, options),
    ]);
  // ...
}
```

Import `CallOptions` from `@mcp-abap-adt/llm-agent`. In the handler's call site (`:192`), pass `ctx.options`:

```ts
      const outcome = await establishTargetState(
        { evaluator: deps.evaluator, embedder: deps.embedder },
        prompt,
        deps.config.targetState,
        ctx.options,
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run the test — Expected: PASS. `npm run build` — clean. Controller suite — green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/target-state.ts packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/target-state-embed-options.test.ts
git commit -m "feat(controller): thread CallOptions into target-state embeds (wrapper logs them)"
```

---

### Task 9: `selectTools` carries `CallOptions`

**Files:**
- Modify: `controller-coordinator-handler.ts:63` (deps signature) + call sites `:218,:386`
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts:115`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/select-tools-options.test.ts` (Create)

- [ ] **Step 1: Write the failing test** — assert the wired `selectTools` forwards options to `toolsRag.query`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('selectTools forwards options to toolsRag.query', async () => {
  const seen: unknown[] = [];
  const toolsRag = { query: async (_t: string, _k?: number, o?: unknown) => { seen.push(o); return []; }, lookup: () => undefined };
  const selectTools = (query: string, k?: number, options?: unknown) => toolsRag.query(query, k, options);
  await selectTools('x', 5, { trace: { traceId: 'r1' } });
  assert.deepEqual(seen[0], { trace: { traceId: 'r1' } });
});
```

- [ ] **Step 2: Run test to verify it fails** — initially the inline `selectTools` ignores options.

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/select-tools-options.test.ts`
Expected: FAIL until the wiring matches.

- [ ] **Step 3: Implement signature + wiring**

In `controller-coordinator-handler.ts:63`:

```ts
  selectTools: (query: string, k?: number, options?: CallOptions) => Promise<readonly LlmTool[]>;
```

At both call sites pass `ctx.options`:

```ts
    const relevantForGoal = await deps.selectTools(`${bundle.goal}\n${prompt}`, TOOL_SELECT_K, ctx.options);
    // ...
    const relevant = await deps.selectTools(step.instructions, TOOL_SELECT_K, ctx.options);
```

In `controller.ts:115`:

```ts
    const selectTools = (query: string, k?: number, options?: CallOptions) =>
      toolsRag ? toolsRag.query(query, k, options) : Promise.resolve([]);
```

- [ ] **Step 4: Run test to verify it passes** — PASS; `npm run build` clean; controller suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller packages/llm-agent-server-libs/src/pipelines/controller.ts
git commit -m "feat(controller): selectTools forwards CallOptions to toolsRag.query"
```

---

### Task 10: `_toolsRagHandle.query` accepts options + builds embedding with options

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:1943-1958`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-query-options.test.ts` (Create — unit-test the query closure if extractable, else assert via a small integration)

- [ ] **Step 1: Write the failing test** — assert a request-scoped `toolsRag.query(text, k, options)` produces one `embedding` entry through a wrapped embedder. Construct a `QueryEmbedding(text, wrapEmbedder(stubEmbedder), options)` and verify the wrapper logs. (If the handle closure isn't directly importable, test the equivalent: `wrapEmbedder(stub)` used by `QueryEmbedding` logs once — already covered by Task 3; here assert the handle passes `options` into `QueryEmbedding`.)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryEmbedding } from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder, SessionRequestLogger } from '@mcp-abap-adt/llm-agent-libs';

test('QueryEmbedding(text, wrappedEmbedder, options) logs one embedding entry', async () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('r1');
  const stub = { embed: async () => ({ vector: [1], usage: { promptTokens: 4, totalTokens: 4 } }) };
  const qe = new QueryEmbedding('hi', wrapEmbedder(stub), { trace: { traceId: 'r1' }, requestLogger: logger } as never);
  await qe.toVector();
  assert.equal(logger.getSummary('r1').byComponent.embedding?.totalTokens, 4);
});
```

- [ ] **Step 2: Run test to verify it fails** — passes only once `wrapEmbedder`/exports exist (Tasks 3-4); if run before, FAIL on import.

- [ ] **Step 3: Implement the handle change**

In `smart-server.ts`, change the handle's `query` signature and the `QueryEmbedding` construction:

```ts
      async query(text: string, k?: number, options?: CallOptions) {
        const limit = k ?? 20;
        const catalog = await ensureCatalog();
        if (toolsRag && resolvedEmbedder) {
          const embedding = new QueryEmbedding(text, resolvedEmbedder, options);
          const ragResult = await toolsRag.query(embedding, limit);
          // ...unchanged...
```

Ensure `resolvedEmbedder` here is the **wrapped** instance (it flows from `resolveAgentEmbedder`, Task 4). Import `CallOptions` if needed.

- [ ] **Step 4: Run test to verify it passes** — PASS; `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-query-options.test.ts
git commit -m "feat(server): _toolsRagHandle.query accepts CallOptions, builds wrapped-embedder QueryEmbedding"
```

---

### Task 11: Stepper — `models` on all terminal branches + `InsufficientSignal` + toolsRag facade

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/stepper-coordinator-handler.ts` (`:172,229,274` add `models`; `:257-267` InsufficientSignal add usage; build the toolsRag facade and pass into `rootStepper.run` `:142`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/stepper-usage-models.test.ts` (Create)

- [ ] **Step 1: Write the failing test** — assert the InsufficientSignal terminal chunk carries usage, and the success terminal carries `models`. Drive the handler with a fake ctx whose `requestLogger` has a pre-logged entry; capture yielded chunks.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Build a fake PipelineContext with a SessionRequestLogger pre-populated under traceId 'r1',
// run the stepper handler down the InsufficientSignal path, collect ctx.yield chunks.
test('InsufficientSignal terminal chunk carries getSummary usage', async () => {
  // ... assert the final stop chunk has .usage with totalTokens === getSummary('r1').totals.totalTokens
  assert.ok(true); // replace with harness-backed assertions
});
```

> Implementer note: model on existing stepper handler tests in `packages/llm-agent-server-libs/src/smart-agent/__tests__/`.

- [ ] **Step 2: Run test to verify it fails** — InsufficientSignal stop chunk has no `usage`.

- [ ] **Step 3: Implement**

(a) Define a helper at module scope (mirrors `summaryToUsage` usage already imported there):

```ts
function terminalUsage(ctx: PipelineContext, traceId: string | undefined) {
  if (!traceId) return undefined;
  const s = ctx.requestLogger.getSummary(traceId);
  return { ...summaryToUsage(s), models: s.byModel };
}
```

(b) At `:172,229,274`, replace `summaryToUsage(ctx.requestLogger.getSummary(traceId))` with `terminalUsage(ctx, traceId)`.

(c) In the `InsufficientSignal` branch (`:257-267`), add usage to the stop chunk:

```ts
        ctx.yield({
          ok: true,
          value: { content: '', finishReason: 'stop', ...(terminalUsage(ctx, traceId) ? { usage: terminalUsage(ctx, traceId) } : {}) },
        });
```

(d) Build the request-bound toolsRag facade and pass it into `rootStepper.run` (`:142`). Just before `runOnce`:

```ts
    const boundToolsRag: IToolsRagHandle = {
      query: (text, k) => toolsRag.query(text, k, ctx.options),
      lookup: (name) => toolsRag.lookup(name),
    };
```

and use `toolsRag: boundToolsRag` in `built.rootStepper.run({ ... })`.

- [ ] **Step 4: Run test to verify it passes** — PASS; `npm run build` clean; stepper suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/stepper-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/stepper-usage-models.test.ts
git commit -m "feat(stepper): models on all terminal branches; usage on InsufficientSignal; toolsRag facade"
```

---

### Task 12: DAG — `models` on terminal/clarify yields

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` (terminal/clarify yields ~`:160-168` and the success-path yield)
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-usage-models.test.ts` (Create)

- [ ] **Step 1: Write the failing test** — assert the DAG terminal chunk's `usage` includes `models`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Drive dag-coordinator with a fake ctx whose requestLogger has entries under 'r1' (two models),
// collect the terminal stop chunk, assert usage.models has both model keys.
test('DAG terminal chunk carries usage.models', async () => {
  assert.ok(true); // replace with harness-backed assertions
});
```

- [ ] **Step 2: Run test to verify it fails** — terminal `usage` is the flat triple (no `models`).

- [ ] **Step 3: Implement** — at each `dag-coordinator.ts` yield that sets `usage: summaryToUsage(...)`, change to include models:

```ts
            const summary = ctx.requestLogger.getSummary(traceId);
            const usage = { ...summaryToUsage(summary), models: summary.byModel };
```

and use `...(usage ? { usage } : {})` in the yielded value.

- [ ] **Step 4: Run test to verify it passes** — PASS; `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-usage-models.test.ts
git commit -m "feat(dag): include per-model breakdown on terminal usage chunks"
```

---

### Task 13: Pass path — strip forwarded usage, log once (hasUsage), error-safe, terminal chunk

**Files:**
- Modify: `packages/llm-agent-libs/src/agent.ts:700-722` (the `mode === 'pass'` loop)
- Test: `packages/llm-agent-libs/src/__tests__/pass-usage.test.ts` (Create)

- [ ] **Step 1: Write the failing test** — two cases: (a) success → exactly one usage-bearing chunk + logged entry; (b) error mid-stream → error chunk, no trailing success usage chunk, partial spend logged.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Build a pass-mode SmartAgent whose _mainLlm.streamChat yields:
//  success: [{content:'a'}, {content:'b', usage:{...10}}]
//  error:   [{content:'a', usage:{...4}}, ERROR]
// Collect chunks from streamProcess; assert exactly one chunk carries usage (success),
// none after the error (error case), and logger has the entry with component 'tool-loop'.
test('pass success yields one usage chunk; forwarded chunks carry none', async () => {
  assert.ok(true); // replace with harness-backed assertions
});
test('pass error yields no trailing usage chunk but logs partial spend', async () => {
  assert.ok(true); // replace with harness-backed assertions
});
```

> Implementer note: set `mode: 'pass'` in the agent config; reuse the agent test harness.

- [ ] **Step 2: Run test to verify it fails** — current loop forwards `usage` chunks and emits nothing/at end.

- [ ] **Step 3: Implement the pass loop**

Replace the `mode === 'pass'` loop (`:700-722`) with:

```ts
        const start = Date.now();
        const stream = this._mainLlm.streamChat(messages, externalTools, opts);
        let passContent = '';
        const passToolCalls: unknown[] = [];
        let accPrompt = 0, accCompletion = 0, accTotal = 0, hasUsage = false, errored = false;
        const traceId = opts?.trace?.traceId;
        const logPassUsage = () => {
          if (!hasUsage) return;
          this.requestLogger.logLlmCall({
            component: 'tool-loop',
            model: this._mainLlm.model ?? 'unknown',
            promptTokens: accPrompt, completionTokens: accCompletion, totalTokens: accTotal,
            durationMs: Date.now() - start, requestId: traceId,
          });
        };
        for await (const chunk of stream) {
          if (!chunk.ok) { errored = true; logPassUsage(); yield chunk; }
          else {
            if (chunk.value.reset) { passContent = ''; passToolCalls.length = 0; continue; }
            if (chunk.value.content) passContent += chunk.value.content;
            if (chunk.value.toolCalls) passToolCalls.push(...chunk.value.toolCalls);
            if (chunk.value.usage) { accPrompt += chunk.value.usage.promptTokens; accCompletion += chunk.value.usage.completionTokens; accTotal += chunk.value.usage.totalTokens; hasUsage = true; }
            const { usage: _omit, ...rest } = chunk.value;
            yield { ok: true, value: rest };
          }
          if (errored) { rootSpan.setStatus('ok'); rootSpan.end(); return; }
        }
        opts?.sessionLogger?.logStep('llm_response_pass', { content: passContent, toolCalls: passToolCalls.length > 0 ? passToolCalls : undefined });
        logPassUsage();
        const passSummary = traceId ? this.requestLogger.getSummary(traceId) : undefined;
        yield { ok: true, value: { content: '', finishReason: 'stop', ...(passSummary ? { usage: { ...summaryToUsage(passSummary), models: passSummary.byModel } } : {}) } };
        rootSpan.setStatus('ok');
        rootSpan.end();
        return;
```

Ensure `summaryToUsage` is imported in `agent.ts` (it already is, `:60`).

- [ ] **Step 4: Run test to verify it passes** — PASS (both); `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/agent.ts packages/llm-agent-libs/src/__tests__/pass-usage.test.ts
git commit -m "fix(agent): pass path strips forwarded usage, logs once (hasUsage), error-safe terminal chunk"
```

---

### Task 14: Provider streaming `usage` (`include_usage`)

**Files:**
- Modify: `packages/openai-llm/src/*.ts`, `packages/deepseek-llm/src/*.ts` (set `stream_options: { include_usage: true }` on streaming requests)
- Modify: `packages/anthropic-llm`, `packages/sap-aicore-llm`, `packages/ollama-llm` — verify each emits `usage` on a stream chunk; add the provider-equivalent flag where missing.
- Test: per-package provider test asserting a streamed response surfaces `usage` on a chunk.

- [ ] **Step 1: Write/extend the failing test** — for each provider package, in its existing `__tests__`, add a streaming test that captures chunks and asserts at least one has `usage`. Example (OpenAI), mirroring `packages/openai-llm/src/__tests__/openai-provider.test.ts`:

```ts
test('streamChat surfaces usage when include_usage is set', async () => {
  // Arrange a mock transport returning SSE with a final usage frame.
  // Act: for await (const c of provider.streamChat(msgs)) collect.
  // Assert: chunks.some(c => c.ok && c.value.usage) === true
  //         and the request body included stream_options.include_usage === true.
});
```

- [ ] **Step 2: Run test to verify it fails** — `usage` absent on streamed chunks / flag not sent.

- [ ] **Step 3: Implement** — in each provider's streaming request builder, add the provider-appropriate usage flag. OpenAI/DeepSeek:

```ts
  const body = {
    model, messages, stream: true,
    stream_options: { include_usage: true },
    // ...
  };
```

For providers that already emit stream usage (verify Anthropic/SAP AI Core/Ollama), no change beyond the asserting test; if a provider cannot emit stream usage, document it — the `UsageLoggingLlm.streamChat`/tool-loop accumulation will simply see none (acceptable; non-stream calls still report).

- [ ] **Step 4: Run test to verify it passes** — PASS per package; `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/openai-llm packages/deepseek-llm packages/anthropic-llm packages/sap-aicore-llm packages/ollama-llm
git commit -m "feat(providers): request streaming usage (include_usage) so LoggingLlm accumulates it"
```

---

### Task 15: End-to-end integration regression

**Files:**
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/usage-e2e.test.ts` (Create)

- [ ] **Step 1: Write the integration test** — a controller turn with a fake SAP-AI-style provider + fake embedder, driven through the handler with a real `SessionRequestLogger`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Build the controller handler with fake evaluator/planner/executor LLMs (each returns usage),
// a wrapped fake embedder (target-state + selectTools), and a SessionRequestLogger under traceId 'r1'.
test('controller response.usage == getSummary(traceId) and includes subagents + embeddings', async () => {
  // Act: run the handler to completion; capture the terminal chunk usage.
  // Assert:
  //   terminalChunk.usage.total_tokens === getSummary('r1').totals.totalTokens
  //   byComponent has evaluator/planner/executor (+finalizer if fired) + embedding
  //   usage.models present
  assert.ok(true); // replace with harness-backed assertions
});
```

- [ ] **Step 2: Run — Expected: PASS** (all prior tasks landed).

Run: `npm -w @mcp-abap-adt/llm-agent-server-libs test`
Expected: green.

- [ ] **Step 3: Full build + all suites**

Run: `npm run build && npm -w @mcp-abap-adt/llm-agent test && npm -w @mcp-abap-adt/llm-agent-libs test && npm -w @mcp-abap-adt/llm-agent-server-libs test`
Expected: clean build, all green.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/usage-e2e.test.ts
git commit -m "test: end-to-end controller usage accounting regression"
```

---

## Spec coverage check

- Controller subagent logging → Task 7. Target-state embeddings → Task 8. toolsRag embeddings (controller) → Tasks 9+10. Stepper toolsRag → Task 11 (facade). Flat/legacy embeddings → Tasks 3-4 (wrapper) + 5 (remove old). traceId normalization → Task 6. Coordinator/controller terminal `models` → Tasks 7/11/12. Pass path (strip/hasUsage/error) → Task 13. `aggregate()` embedding-by-scope → Task 2. `LlmComponent 'executor'` / `CallOptions.requestLogger` / `IToolsRagHandle.query` options → Task 1. Estimation fallback + batch + idempotency → Task 3. Provider streaming usage → Task 14. Single-source/no-double-count → enforced by Task 4→5 adjacency + Task 7 removing `total`.
- Deferred (not in plan, per spec): estimated-vs-measured aggregate split; per-component `response.usage` surface.
