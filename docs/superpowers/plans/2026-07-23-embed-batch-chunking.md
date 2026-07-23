# Embedder Batch Chunking, Retry and Tool-Catalog Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop MCP tool vectorization from sending an unchunked `embedBatch` that a capped provider rejects, retry rate-limited embedding calls, and make a partially vectorized tool catalog visible in `/health`.

**Architecture:** Chunking and retry become `IEmbedder` decorators composed once in `resolveEmbedder`, not glue in the caller. Each decorator layer picks its class by `isBatchEmbedder(inner)` so batch capability is preserved rather than fabricated. `vectorizeMcpTools` returns an aggregated summary that the builder publishes to a status holder, which `HealthChecker` reads to report `degraded`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-07-23-embed-batch-chunking-design.md`

**Issue:** [#236](https://github.com/fr0ster/llm-agent/issues/236)

## Global Constraints

- All artifacts (code, comments, docs, commit messages) in **English**.
- ESM only — every relative import ends in `.js`.
- TypeScript strict mode; avoid `any` (Biome warns).
- Interfaces are prefixed with `I`.
- Additive changes only — no existing exported signature may become incompatible. Every new parameter is optional.
- Biome: 2 spaces, single quotes, always semicolons. The gate is `npm run lint:check` (a **check**, not `format` — import sorting is part of it).
- Package dependency order is `llm-agent-server → llm-agent-server-libs → llm-agent-libs → {llm-agent-mcp, llm-agent-rag} → llm-agent`. `llm-agent` is the leaf: its only runtime dependency is `zod`. Never import from a higher package into a lower one.
- Per-package test command: `npm test --workspace @mcp-abap-adt/<pkg>` which runs `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`.
- Build before running anything through `npm run dev`: workspace imports resolve to `dist/`.
- Do not modify `RetryLlm`, `CircuitBreakerEmbedder`, or the `LogEvent` union — all three are explicitly out of scope in the spec.

---

## File Structure

**`packages/llm-agent`** (leaf contracts + decorators)

- `src/interfaces/rag.ts` — modify: add `IBatchSizeLimited`, `isBatchSizeLimited`.
- `src/interfaces/tool-catalog.ts` — create: `ToolCatalogStatus`, `IToolCatalogReporter`, `isToolCatalogReporter`.
- `src/interfaces/health.ts` — modify: optional `toolCatalog` on `HealthComponentStatus`.
- `src/resilience/embedder-resilience.ts` — create: `RESILIENCE_META` symbol, metadata type, `getResilienceMetadata`, `composeResilientEmbedder`.
- `src/resilience/retry-embedder.ts` — create: `extractStatusCode`, `RetryEmbedder`, `RetryBatchEmbedder`, `withRetry`.
- `src/resilience/batch-chunking-embedder.ts` — create: `BatchChunkingEmbedder`, `DEFAULT_MAX_BATCH_SIZE`.
- `src/index.ts`, `src/interfaces/index.ts`, `src/resilience/index.ts` — modify: re-exports.

**`packages/sap-aicore-embedder`**

- `src/foundation-embedder.ts` — modify: conditional `maxBatchSize`.

**`packages/llm-agent-libs`**

- `src/adapters/usage-logging-embedder.ts` — modify: propagate resilience metadata.
- `src/mcp/tool-catalog-status.ts` — create: the holder.
- `src/mcp/vectorize-mcp-tools.ts` — modify: summary, single write helper, write-success criterion, skip on read-only store.
- `src/agent.ts` — modify: `toolCatalogStatus` dep + `getToolCatalogStatus()` delegation.
- `src/builder.ts` — modify: create holder, publish summary, pass to agent deps.
- `src/health/health-checker.ts` — modify: read the reporter, extend the degraded condition.

**`packages/llm-agent-rag`**

- `src/rag-factories.ts` — modify: cap resolution + composition in `resolveEmbedder`, `logger` on both options types, thread into `makeRag`.

**`packages/llm-agent-server-libs`**

- `src/smart-agent/smart-server.ts` — modify: `maxBatchSize` on `SmartServerRagConfig`.
- `src/smart-agent/resolve-agent-embedder.ts` — modify: `logger` parameter on both functions.

---

### Task 1: `IBatchSizeLimited` contract

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts:56-65`
- Test: `packages/llm-agent/src/interfaces/rag.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `interface IBatchSizeLimited { readonly maxBatchSize: number }` and `isBatchSizeLimited(e: IEmbedder): e is IEmbedder & IBatchSizeLimited`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/interfaces/rag.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from './rag.js';
import { isBatchSizeLimited } from './rag.js';

const embed = async (): Promise<IEmbedResult> => ({ vector: [1] });

describe('isBatchSizeLimited', () => {
  it('accepts a positive safe integer', () => {
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: 250 }), true);
  });

  it('rejects undefined, zero, negative and fractional values', () => {
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: undefined }), false);
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: 0 }), false);
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: -1 }), false);
    assert.equal(isBatchSizeLimited({ embed, maxBatchSize: 1.5 }), false);
  });

  it('rejects an embedder without the property', () => {
    assert.equal(isBatchSizeLimited({ embed }), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: FAIL — `isBatchSizeLimited` is not exported from `./rag.js`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/llm-agent/src/interfaces/rag.ts`, directly after `isBatchEmbedder` (line 65):

```ts
/**
 * An embedder that declares a provider-imposed cap on `embedBatch` input size.
 * Deliberately TINY and SEPARATE from IEmbedderBatch (ISP) — an embedder with
 * no known cap simply does not implement it.
 */
export interface IBatchSizeLimited {
  /** Maximum number of texts accepted in a single embedBatch call. */
  readonly maxBatchSize: number;
}

/**
 * Value guard, NOT a key-presence guard: an implementer may declare
 * `maxBatchSize?: number` and leave it undefined for models whose cap is
 * unknown. Under ES2022 class fields that still creates an own property, so
 * `'maxBatchSize' in e` would wrongly accept it.
 */
export function isBatchSizeLimited(
  e: IEmbedder,
): e is IEmbedder & IBatchSizeLimited {
  const v = (e as { maxBatchSize?: unknown }).maxBatchSize;
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: PASS — 3 tests in `isBatchSizeLimited`.

- [ ] **Step 5: Export from the package barrel**

In `packages/llm-agent/src/interfaces/index.ts`, find the line
`export { isBatchEmbedder } from './rag.js';` (line 153) and add below it:

```ts
export { isBatchSizeLimited } from './rag.js';
export type { IBatchSizeLimited } from './rag.js';
```

Confirm `packages/llm-agent/src/index.ts` re-exports the interfaces barrel; if `IEmbedderBatch` is listed explicitly there, add `IBatchSizeLimited` and `isBatchSizeLimited` in the same style.

- [ ] **Step 6: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/interfaces/rag.ts packages/llm-agent/src/interfaces/rag.test.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): add IBatchSizeLimited contract for provider batch caps"
```

---

### Task 2: Retry decorators with status extraction

**Files:**
- Create: `packages/llm-agent/src/resilience/retry-embedder.ts`
- Test: `packages/llm-agent/src/resilience/retry-embedder.test.ts`
- Modify: `packages/llm-agent/src/resilience/index.ts`

**Interfaces:**
- Consumes: `isBatchEmbedder` from Task 1's file (pre-existing), `IEmbedder`, `IEmbedderBatch`, `IEmbedResult`, `CallOptions`, `RagError`.
- Produces:
  - `extractStatusCode(err: unknown): number | undefined`
  - `interface EmbedderRetryOptions { maxAttempts: number; backoffMs: number; retryOn: number[] }`
  - `class RetryEmbedder implements IEmbedder`
  - `class RetryBatchEmbedder extends RetryEmbedder implements IEmbedderBatch`
  - `withRetry(inner: IEmbedder, options?: Partial<EmbedderRetryOptions>): IEmbedder`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/resilience/retry-embedder.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallOptions, IEmbedResult } from '../index.js';
import { isBatchEmbedder, RagError } from '../index.js';
import { extractStatusCode, withRetry } from './retry-embedder.js';

const FAST = { backoffMs: 1 };

class ScriptedEmbedder {
  calls = 0;
  constructor(private readonly script: Array<'ok' | unknown>) {}
  async embed(_text: string, _o?: CallOptions): Promise<IEmbedResult> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (step === 'ok') return { vector: [1] };
    throw step;
  }
  async embedBatch(texts: string[], o?: CallOptions): Promise<IEmbedResult[]> {
    await this.embed(texts[0] ?? '', o);
    return texts.map(() => ({ vector: [1] }));
  }
}

class EmbedOnly {
  async embed(): Promise<IEmbedResult> {
    return { vector: [1] };
  }
}

describe('extractStatusCode', () => {
  it('reads status, statusCode and cause', () => {
    assert.equal(extractStatusCode({ status: 429 }), 429);
    assert.equal(extractStatusCode({ statusCode: 503 }), 503);
    assert.equal(extractStatusCode({ cause: { status: 500 } }), 500);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    assert.equal(extractStatusCode(a), undefined);
  });
});

describe('withRetry', () => {
  it('retries a 429 and succeeds on the second attempt', async () => {
    const inner = new ScriptedEmbedder([{ status: 429 }, 'ok']);
    const r = await withRetry(inner, FAST).embed('x');
    assert.deepEqual(r.vector, [1]);
    assert.equal(inner.calls, 2);
  });

  it('throws after exhausting attempts', async () => {
    const inner = new ScriptedEmbedder([{ status: 429 }]);
    await assert.rejects(() =>
      withRetry(inner, { ...FAST, maxAttempts: 2 }).embed('x'),
    );
    assert.equal(inner.calls, 3);
  });

  it('does not retry a non-retryable status', async () => {
    const inner = new ScriptedEmbedder([{ status: 400 }]);
    await assert.rejects(() => withRetry(inner, FAST).embed('x'));
    assert.equal(inner.calls, 1);
  });

  it('does not retry when the message merely contains a retryable number', async () => {
    const inner = new ScriptedEmbedder([
      new RagError('batchSize of 429 is not allowed', 'EMBED_ERROR'),
    ]);
    const retrying = withRetry(inner, FAST);
    await assert.rejects(() => retrying.embed('x'));
    assert.equal(inner.calls, 4);
  });

  it('preserves batch capability instead of fabricating it', () => {
    assert.equal(isBatchEmbedder(withRetry(new ScriptedEmbedder(['ok']))), true);
    assert.equal(isBatchEmbedder(withRetry(new EmbedOnly())), false);
  });

  it('stops when the signal is aborted', async () => {
    const inner = new ScriptedEmbedder([{ status: 429 }]);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() =>
      withRetry(inner, FAST).embed('x', { signal: ac.signal }),
    );
    assert.equal(inner.calls, 0);
  });
});
```

Note on the fourth test: a message-only match is the last resort, so
`'batchSize of 429 is not allowed'` **is** matched by the word-boundary
fallback and retried — 1 initial call + 3 retries = 4. It is asserted to pin
that behaviour, since the alternative (never matching messages) would break
providers that only report status in text.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: FAIL — cannot find module `./retry-embedder.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent/src/resilience/retry-embedder.ts`:

```ts
/**
 * RetryEmbedder — IEmbedder decorators that retry transient failures with
 * exponential backoff. Ported from RetryLlm (llm-agent-libs) onto IEmbedder,
 * which throws instead of returning a Result.
 *
 * Two classes behind a factory, following wrapEmbedder: a single class exposing
 * embedBatch unconditionally would make every non-batch embedder look
 * batch-capable to isBatchEmbedder.
 */

import type {
  CallOptions,
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
import { RagError } from '../interfaces/types.js';

export interface EmbedderRetryOptions {
  /** Maximum number of retries (total calls = maxAttempts + 1). Default: 3. */
  maxAttempts: number;
  /** Initial backoff delay in ms. Doubles each attempt. Default: 2000. */
  backoffMs: number;
  /** HTTP status codes that trigger a retry. Default: [429, 500, 502, 503]. */
  retryOn: number[];
}

const DEFAULT_OPTIONS: EmbedderRetryOptions = {
  maxAttempts: 3,
  backoffMs: 2000,
  retryOn: [429, 500, 502, 503],
};

const MAX_CAUSE_DEPTH = 5;

/**
 * Resolve an HTTP status from an unknown thrown value: own status/statusCode,
 * then the same walking `cause`, bounded by depth and a visited set so a cyclic
 * chain cannot hang. Returns undefined when no numeric status is present.
 */
export function extractStatusCode(err: unknown): number | undefined {
  const visited = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || visited.has(cur)) return;
    visited.add(cur);
    const rec = cur as {
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    if (typeof rec.status === 'number') return rec.status;
    if (typeof rec.statusCode === 'number') return rec.statusCode;
    cur = rec.cause;
  }
  return undefined;
}

export class RetryEmbedder implements IEmbedder {
  protected readonly opts: EmbedderRetryOptions;

  constructor(
    protected readonly inner: IEmbedder,
    options?: Partial<EmbedderRetryOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.run(() => this.inner.embed(text, options), options);
  }

  protected async run<T>(
    call: () => Promise<T>,
    options?: CallOptions,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (options?.signal?.aborted) {
        throw new RagError('Aborted', 'ABORTED');
      }
      try {
        return await call();
      } catch (err) {
        if (attempt >= this.opts.maxAttempts || !this.isRetryable(err)) throw err;
        await this.backoff(attempt, options?.signal);
      }
    }
  }

  protected isRetryable(err: unknown): boolean {
    const status = extractStatusCode(err);
    if (status !== undefined) return this.opts.retryOn.includes(status);
    // Last resort: some adapters report the status only in the message. Match
    // on word boundaries rather than a bare substring, so an id or a byte count
    // containing "429" does not trigger a retry.
    const msg = err instanceof Error ? err.message : String(err);
    return this.opts.retryOn.some((code) =>
      new RegExp(`\\b${code}\\b`).test(msg),
    );
  }

  protected async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const delay = this.opts.backoffMs * 2 ** attempt;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export class RetryBatchEmbedder
  extends RetryEmbedder
  implements IEmbedderBatch
{
  constructor(
    protected readonly inner: IEmbedderBatch,
    options?: Partial<EmbedderRetryOptions>,
  ) {
    super(inner, options);
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    return this.run(() => this.inner.embedBatch(texts, options), options);
  }
}

/** Preserves batch capability: never turns a non-batch embedder into one. */
export function withRetry(
  inner: IEmbedder,
  options?: Partial<EmbedderRetryOptions>,
): IEmbedder {
  return isBatchEmbedder(inner)
    ? new RetryBatchEmbedder(inner, options)
    : new RetryEmbedder(inner, options);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: PASS — 8 tests across the two describes.

- [ ] **Step 5: Export from the resilience barrel**

In `packages/llm-agent/src/resilience/index.ts`, add:

```ts
export {
  type EmbedderRetryOptions,
  extractStatusCode,
  RetryBatchEmbedder,
  RetryEmbedder,
  withRetry,
} from './retry-embedder.js';
```

Mirror the existing `CircuitBreakerEmbedder` line in `packages/llm-agent/src/index.ts` (line 58) with the same names.

- [ ] **Step 6: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/resilience/retry-embedder.ts packages/llm-agent/src/resilience/retry-embedder.test.ts packages/llm-agent/src/resilience/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): add RetryEmbedder with status-aware retry classification"
```

---

### Task 3: `BatchChunkingEmbedder`

**Files:**
- Create: `packages/llm-agent/src/resilience/batch-chunking-embedder.ts`
- Test: `packages/llm-agent/src/resilience/batch-chunking-embedder.test.ts`
- Modify: `packages/llm-agent/src/resilience/index.ts`, `packages/llm-agent/src/index.ts`

**Interfaces:**
- Consumes: `IEmbedderBatch`, `IEmbedResult`, `CallOptions`, `RagError`.
- Produces: `DEFAULT_MAX_BATCH_SIZE = 100` and `class BatchChunkingEmbedder implements IEmbedderBatch` with constructor `(inner: IEmbedderBatch, maxBatchSize: number)`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/resilience/batch-chunking-embedder.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '../index.js';
import { BatchChunkingEmbedder } from './batch-chunking-embedder.js';

class CountingBatchEmbedder {
  readonly sizes: number[] = [];
  constructor(private readonly short = false) {}
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    this.sizes.push(texts.length);
    const out = texts.map((t) => ({ vector: [Number(t)] }));
    return this.short ? out.slice(1) : out;
  }
}

describe('BatchChunkingEmbedder', () => {
  it('splits 356 texts at a cap of 250 and preserves order', async () => {
    const inner = new CountingBatchEmbedder();
    const texts = Array.from({ length: 356 }, (_, i) => String(i));
    const out = await new BatchChunkingEmbedder(inner, 250).embedBatch(texts);
    assert.deepEqual(inner.sizes, [250, 106]);
    assert.equal(out.length, 356);
    assert.deepEqual(out[0].vector, [0]);
    assert.deepEqual(out[250].vector, [250]);
    assert.deepEqual(out[355].vector, [355]);
  });

  it('makes a single call when the cap is not exceeded', async () => {
    const inner = new CountingBatchEmbedder();
    await new BatchChunkingEmbedder(inner, 250).embedBatch(['1', '2']);
    assert.deepEqual(inner.sizes, [2]);
  });

  it('does not call the inner embedder for empty input', async () => {
    const inner = new CountingBatchEmbedder();
    const out = await new BatchChunkingEmbedder(inner, 250).embedBatch([]);
    assert.deepEqual(out, []);
    assert.deepEqual(inner.sizes, []);
  });

  it('rejects an invalid cap at construction', () => {
    const inner = new CountingBatchEmbedder();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new BatchChunkingEmbedder(inner, bad), /positive/);
    }
  });

  it('throws when a chunk returns the wrong number of embeddings', async () => {
    const inner = new CountingBatchEmbedder(true);
    await assert.rejects(
      () => new BatchChunkingEmbedder(inner, 10).embedBatch(['1', '2']),
      /expected 2/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: FAIL — cannot find module `./batch-chunking-embedder.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent/src/resilience/batch-chunking-embedder.ts`:

```ts
/**
 * BatchChunkingEmbedder — splits embedBatch input into provider-safe chunks.
 *
 * Applied ONLY over a batch-capable inner (see composeResilientEmbedder): a
 * decorator exposing embedBatch unconditionally would make a non-batch embedder
 * look batch-capable to isBatchEmbedder.
 */

import type {
  CallOptions,
  IEmbedderBatch,
  IEmbedResult,
} from '../interfaces/rag.js';
import { RagError } from '../interfaces/types.js';

/**
 * Used when neither YAML nor the provider declares a cap. Comfortably below the
 * only hard cap we have confirmed (Vertex 250), and large enough that a
 * 356-tool catalog costs 4 requests.
 */
export const DEFAULT_MAX_BATCH_SIZE = 100;

export class BatchChunkingEmbedder implements IEmbedderBatch {
  constructor(
    private readonly inner: IEmbedderBatch,
    private readonly maxBatchSize: number,
  ) {
    if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
      throw new RagError(
        `maxBatchSize must be a positive safe integer, got ${String(maxBatchSize)}`,
        'CONFIG_ERROR',
      );
    }
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.inner.embed(text, options);
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const out: IEmbedResult[] = [];
    // Sequential on purpose: concurrent chunks would reintroduce the rate
    // limiting that chunking exists to avoid.
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const chunk = texts.slice(i, i + this.maxBatchSize);
      const res = await this.inner.embedBatch(chunk, options);
      if (res.length !== chunk.length) {
        throw new RagError(
          `Batch embedding returned ${res.length} embeddings, expected ${chunk.length}`,
          'EMBED_ERROR',
        );
      }
      out.push(...res);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: PASS — 5 tests.

- [ ] **Step 5: Export from the barrels**

Add to `packages/llm-agent/src/resilience/index.ts` and mirror in `packages/llm-agent/src/index.ts`:

```ts
export {
  BatchChunkingEmbedder,
  DEFAULT_MAX_BATCH_SIZE,
} from './batch-chunking-embedder.js';
```

- [ ] **Step 6: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/resilience/batch-chunking-embedder.ts packages/llm-agent/src/resilience/batch-chunking-embedder.test.ts packages/llm-agent/src/resilience/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): add BatchChunkingEmbedder with cardinality checks"
```

---

### Task 4: Resilience metadata and composition helper

**Files:**
- Create: `packages/llm-agent/src/resilience/embedder-resilience.ts`
- Test: `packages/llm-agent/src/resilience/embedder-resilience.test.ts`
- Modify: `packages/llm-agent/src/resilience/index.ts`, `packages/llm-agent/src/index.ts`

**Interfaces:**
- Consumes: `withRetry` (Task 2), `BatchChunkingEmbedder`, `DEFAULT_MAX_BATCH_SIZE` (Task 3), `isBatchEmbedder`, `ILogger`.
- Produces:
  - `const RESILIENCE_META: unique symbol`
  - `interface EmbedderResilienceMetadata { maxBatchSize?: number }`
  - `getResilienceMetadata(e: IEmbedder): EmbedderResilienceMetadata | undefined`
  - `interface ComposeResilienceOptions { explicitMaxBatchSize?: number; fallbackMaxBatchSize?: number; retry?: Partial<EmbedderRetryOptions>; logger?: ILogger }`
  - `composeResilientEmbedder(inner: IEmbedder, options?: ComposeResilienceOptions): IEmbedder`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/resilience/embedder-resilience.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '../index.js';
import { isBatchEmbedder } from '../index.js';
import {
  composeResilientEmbedder,
  getResilienceMetadata,
} from './embedder-resilience.js';

class BatchProvider {
  readonly sizes: number[] = [];
  readonly maxBatchSize?: number;
  constructor(cap?: number) {
    if (cap !== undefined) this.maxBatchSize = cap;
  }
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    this.sizes.push(texts.length);
    return texts.map(() => ({ vector: [0] }));
  }
}

class EmbedOnly {
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
}

function collectingLogger(events: LogEvent[]) {
  return { log: (e: LogEvent) => events.push(e) };
}

describe('composeResilientEmbedder', () => {
  it('chunks at the provider-declared cap', async () => {
    const provider = new BatchProvider(250);
    const composed = composeResilientEmbedder(provider);
    await (composed as { embedBatch(t: string[]): Promise<IEmbedResult[]> })
      .embedBatch(Array.from({ length: 356 }, (_, i) => String(i)));
    assert.deepEqual(provider.sizes, [250, 106]);
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, 250);
  });

  it('prefers an explicit cap over the provider cap', async () => {
    const provider = new BatchProvider(250);
    const composed = composeResilientEmbedder(provider, {
      explicitMaxBatchSize: 50,
    });
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, 50);
  });

  it('falls back to the default when nothing declares a cap', () => {
    const composed = composeResilientEmbedder(new BatchProvider());
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, 100);
  });

  it('preserves non-batch capability', () => {
    const composed = composeResilientEmbedder(new EmbedOnly());
    assert.equal(isBatchEmbedder(composed), false);
    assert.equal(getResilienceMetadata(composed)?.maxBatchSize, undefined);
  });

  it('is idempotent and does not warn without an explicit cap', () => {
    const events: LogEvent[] = [];
    const once = composeResilientEmbedder(new BatchProvider(250));
    const twice = composeResilientEmbedder(once, {
      logger: collectingLogger(events),
    });
    assert.equal(twice, once);
    assert.deepEqual(events, []);
  });

  it('warns and keeps the owned cap when an explicit cap differs', () => {
    const events: LogEvent[] = [];
    const once = composeResilientEmbedder(new BatchProvider(250));
    const twice = composeResilientEmbedder(once, {
      explicitMaxBatchSize: 50,
      logger: collectingLogger(events),
    });
    assert.equal(twice, once);
    assert.equal(events.length, 1);
    assert.match(String((events[0] as { message: string }).message), /250.*50/);
  });

  it('is silent when the explicit cap equals the owned one', () => {
    const events: LogEvent[] = [];
    const once = composeResilientEmbedder(new BatchProvider(250));
    composeResilientEmbedder(once, {
      explicitMaxBatchSize: 250,
      logger: collectingLogger(events),
    });
    assert.deepEqual(events, []);
  });

  it('ignores a look-alike plain property', () => {
    const impostor = { embed: async () => ({ vector: [0] }), resilience: {} };
    assert.equal(getResilienceMetadata(impostor), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: FAIL — cannot find module `./embedder-resilience.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent/src/resilience/embedder-resilience.ts`:

```ts
/**
 * Composition of the embedder resilience chain, and the metadata that travels
 * with it.
 *
 *   wrapEmbedder( BatchChunkingEmbedder( RetryBatchEmbedder( provider ) ) )
 *
 * Retry sits INSIDE chunking so each chunk retries independently.
 *
 * The metadata is keyed by a registered symbol, not a string property: a string
 * key could be matched structurally by an unrelated consumer embedder, and the
 * guard would then read a foreign object as ours.
 */

import type { IEmbedder } from '../interfaces/rag.js';
import { isBatchEmbedder, isBatchSizeLimited } from '../interfaces/rag.js';
import type { ILogger } from '../logger/types.js';
import {
  BatchChunkingEmbedder,
  DEFAULT_MAX_BATCH_SIZE,
} from './batch-chunking-embedder.js';
import type { EmbedderRetryOptions } from './retry-embedder.js';
import { withRetry } from './retry-embedder.js';

export const RESILIENCE_META = Symbol.for(
  '@mcp-abap-adt/embedder-resilience',
);

export interface EmbedderResilienceMetadata {
  /** Absent for a non-batch embedder: retry applies, chunking does not. */
  maxBatchSize?: number;
}

/** Undefined iff the embedder has no resilience layer. */
export function getResilienceMetadata(
  e: IEmbedder,
): EmbedderResilienceMetadata | undefined {
  return (e as { [RESILIENCE_META]?: EmbedderResilienceMetadata })[
    RESILIENCE_META
  ];
}

/** Attach metadata to an instance without making it enumerable. */
export function brandResilient(
  e: IEmbedder,
  meta: EmbedderResilienceMetadata,
): void {
  Object.defineProperty(e, RESILIENCE_META, {
    value: meta,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export interface ComposeResilienceOptions {
  /** A cap a human configured. ONLY this may trigger the conflict check. */
  explicitMaxBatchSize?: number;
  /** Provider-derived or default cap; never triggers the conflict check. */
  fallbackMaxBatchSize?: number;
  retry?: Partial<EmbedderRetryOptions>;
  logger?: ILogger;
}

export function composeResilientEmbedder(
  inner: IEmbedder,
  options?: ComposeResilienceOptions,
): IEmbedder {
  const existing = getResilienceMetadata(inner);
  if (existing) {
    const requested = options?.explicitMaxBatchSize;
    // Re-deriving the cap here would fire on every normal boot: wrapEmbedder
    // hides the provider, so a derived value falls to the default and would
    // look like a conflict nobody configured.
    if (requested !== undefined && requested !== existing.maxBatchSize) {
      options?.logger?.log({
        type: 'warning',
        traceId: 'embedder-resolution',
        message:
          `Embedder is already composed with maxBatchSize ${String(existing.maxBatchSize)}; ` +
          `ignoring the requested ${requested}. One shared embedder has one cap.`,
      });
    }
    return inner;
  }

  const cap =
    options?.explicitMaxBatchSize ??
    options?.fallbackMaxBatchSize ??
    (isBatchSizeLimited(inner) ? inner.maxBatchSize : DEFAULT_MAX_BATCH_SIZE);

  const retried = withRetry(inner, options?.retry);
  const composed = isBatchEmbedder(retried)
    ? new BatchChunkingEmbedder(retried, cap)
    : retried;

  brandResilient(composed, isBatchEmbedder(retried) ? { maxBatchSize: cap } : {});
  return composed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: PASS — 8 tests.

- [ ] **Step 5: Export from the barrels**

Add to `packages/llm-agent/src/resilience/index.ts` and mirror in `packages/llm-agent/src/index.ts`:

```ts
export {
  brandResilient,
  type ComposeResilienceOptions,
  composeResilientEmbedder,
  type EmbedderResilienceMetadata,
  getResilienceMetadata,
  RESILIENCE_META,
} from './embedder-resilience.js';
```

- [ ] **Step 6: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/resilience/embedder-resilience.ts packages/llm-agent/src/resilience/embedder-resilience.test.ts packages/llm-agent/src/resilience/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): compose embedder resilience with symbol-keyed metadata"
```

---

### Task 5: Declare the Gemini cap in `sap-aicore-embedder`

**Files:**
- Modify: `packages/sap-aicore-embedder/src/foundation-embedder.ts:42-63`
- Test: `packages/sap-aicore-embedder/src/foundation-embedder.test.ts` (append)

**Interfaces:**
- Consumes: `isBatchSizeLimited` (Task 1).
- Produces: `FoundationModelsEmbedder.maxBatchSize?: number`, set to `250` for the `gemini` family only.

- [ ] **Step 1: Write the failing test**

Append to `packages/sap-aicore-embedder/src/foundation-embedder.test.ts`. Reuse the existing `makeGeminiEmbedder` / `makeOpenAiEmbedder` helpers already defined in that file:

```ts
test('gemini declares the Vertex batch cap of 250', () => {
  const e = makeGeminiEmbedder();
  assert.equal(e.maxBatchSize, 250);
  assert.equal(isBatchSizeLimited(e), true);
});

test('non-gemini declares no cap (undefined, not absent)', () => {
  const e = makeOpenAiEmbedder();
  assert.equal(e.maxBatchSize, undefined);
  assert.equal(isBatchSizeLimited(e), false);
});
```

Add `isBatchSizeLimited` to the existing `@mcp-abap-adt/llm-agent` import in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/sap-aicore-embedder`
Expected: FAIL — `maxBatchSize` is `undefined` for gemini.

- [ ] **Step 3: Write minimal implementation**

In `packages/sap-aicore-embedder/src/foundation-embedder.ts`, add the field
declaration next to the other private fields (after line 49,
`private deploymentIdPromise: Promise<string> | null = null;`):

```ts
  /**
   * Provider batch cap, set only for families with a confirmed limit — see
   * IBatchSizeLimited. Vertex rejects a batchSize of 251 or more:
   * "supported range is from 1 (inclusive) to 251 (exclusive)".
   *
   * NOT `implements IBatchSizeLimited`: one class serves every family, and the
   * interface's property is required, which would give every instance a cap.
   */
  readonly maxBatchSize?: number;
```

Then at the end of the constructor, after
`this.tokenProvider = new TokenProvider({...});` (line 62):

```ts
    if (this.family === 'gemini') this.maxBatchSize = 250;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/sap-aicore-embedder`
Expected: PASS — both new tests, and the pre-existing tests still pass.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sap-aicore-embedder/src/foundation-embedder.ts packages/sap-aicore-embedder/src/foundation-embedder.test.ts
git commit -m "feat(sap-aicore-embedder): declare the Vertex 250 batch cap for gemini models"
```

---

### Task 6: Propagate resilience metadata through `wrapEmbedder`

**Files:**
- Modify: `packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts:97-103`
- Test: `packages/llm-agent-libs/src/adapters/usage-logging-embedder.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: `getResilienceMetadata`, `brandResilient`, `composeResilientEmbedder` (Task 4).
- Produces: no signature change — `wrapEmbedder(inner)` now carries the inner's resilience metadata.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult } from '@mcp-abap-adt/llm-agent';
import {
  composeResilientEmbedder,
  getResilienceMetadata,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from './usage-logging-embedder.js';

class BatchProvider {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('wrapEmbedder resilience metadata', () => {
  it('propagates the inner metadata to the wrapper', () => {
    const composed = composeResilientEmbedder(new BatchProvider());
    const wrapped = wrapEmbedder(composed);
    assert.notEqual(wrapped, composed);
    assert.equal(getResilienceMetadata(wrapped)?.maxBatchSize, 250);
  });

  it('adds no metadata when the inner has none', () => {
    assert.equal(getResilienceMetadata(wrapEmbedder(new BatchProvider())), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — `getResilienceMetadata(wrapped)` is `undefined`; the brand sits on the hidden inner layer because `inner` is `protected`.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `wrapEmbedder` in
`packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts`:

```ts
/**
 * Idempotent: returns `inner` unchanged if already wrapped; batch-capable when
 * `inner` is an IEmbedderBatch (preserves `isBatchEmbedder`).
 *
 * Also propagates the embedder-resilience metadata: `inner` is protected, so a
 * caller holding the wrapper cannot see a brand that sits on a layer below,
 * and re-resolution would compose the decorators a second time.
 */
export function wrapEmbedder(inner: IEmbedder): IEmbedder {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  const wrapped = isBatchEmbedder(inner)
    ? new UsageLoggingBatchEmbedder(inner)
    : new UsageLoggingEmbedder(inner);
  const meta = getResilienceMetadata(inner);
  if (meta) brandResilient(wrapped, meta);
  return wrapped;
}
```

Add to the imports at the top of the file:

```ts
import { brandResilient, getResilienceMetadata } from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts packages/llm-agent-libs/src/adapters/usage-logging-embedder.test.ts
git commit -m "fix(llm-agent-libs): propagate embedder resilience metadata through wrapEmbedder"
```

---

### Task 7: Compose resilience in `resolveEmbedder`

**Files:**
- Modify: `packages/llm-agent-rag/src/rag-factories.ts:107-171` and `:215-220`
- Test: `packages/llm-agent-rag/src/__tests__/resolve-embedder-resilience.test.ts` (create)

**Interfaces:**
- Consumes: `composeResilientEmbedder`, `getResilienceMetadata`, `isBatchSizeLimited`, `DEFAULT_MAX_BATCH_SIZE` (Tasks 1, 3, 4).
- Produces:
  - `EmbedderResolutionConfig.maxBatchSize?: number`
  - `EmbedderResolutionOptions.logger?: ILogger`
  - `RagResolutionOptions.logger?: ILogger`
  - `resolveEmbedder` returns a resilience-composed embedder on every path, including `injectedEmbedder`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-rag/src/__tests__/resolve-embedder-resilience.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '@mcp-abap-adt/llm-agent';
import { getResilienceMetadata } from '@mcp-abap-adt/llm-agent';
import { resolveEmbedder } from '../rag-factories.js';

class GeminiLike {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('resolveEmbedder resilience composition', () => {
  it('composes an injected embedder and adopts its declared cap', () => {
    const e = resolveEmbedder({}, { injectedEmbedder: new GeminiLike() });
    assert.equal(getResilienceMetadata(e)?.maxBatchSize, 250);
  });

  it('lets YAML override the provider cap', () => {
    const e = resolveEmbedder(
      { maxBatchSize: 64 },
      { injectedEmbedder: new GeminiLike() },
    );
    assert.equal(getResilienceMetadata(e)?.maxBatchSize, 64);
  });

  it('re-resolving without an explicit cap keeps the cap and stays silent', () => {
    const events: LogEvent[] = [];
    const first = resolveEmbedder({}, { injectedEmbedder: new GeminiLike() });
    const second = resolveEmbedder(
      {},
      { injectedEmbedder: first, logger: { log: (e) => events.push(e) } },
    );
    assert.equal(second, first);
    assert.equal(getResilienceMetadata(second)?.maxBatchSize, 250);
    assert.deepEqual(events, []);
  });

  it('re-resolving with a different explicit cap warns once', () => {
    const events: LogEvent[] = [];
    const first = resolveEmbedder({}, { injectedEmbedder: new GeminiLike() });
    resolveEmbedder(
      { maxBatchSize: 64 },
      { injectedEmbedder: first, logger: { log: (e) => events.push(e) } },
    );
    assert.equal(events.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-rag`
Expected: FAIL — `getResilienceMetadata` returns `undefined`; `resolveEmbedder` returns the raw embedder.

- [ ] **Step 3: Write minimal implementation**

In `packages/llm-agent-rag/src/rag-factories.ts`, add to the imports:

```ts
import type { ILogger } from '@mcp-abap-adt/llm-agent';
import { composeResilientEmbedder, isBatchSizeLimited, DEFAULT_MAX_BATCH_SIZE } from '@mcp-abap-adt/llm-agent';
```

Add to `EmbedderResolutionConfig` (after `scenario`, line 120):

```ts
  /**
   * Cap on texts per embedBatch call. Precedence: this value → the provider's
   * declared cap → DEFAULT_MAX_BATCH_SIZE. Set it when the tenant's real limit
   * is lower than the model's documented one.
   */
  maxBatchSize?: number;
```

Add to `EmbedderResolutionOptions` (line 123-128) and to `RagResolutionOptions` (line 215-220):

```ts
  /** Receives configuration warnings (e.g. a conflicting maxBatchSize). */
  logger?: ILogger;
```

Replace the body of `resolveEmbedder`:

```ts
export function resolveEmbedder(
  cfg: EmbedderResolutionConfig,
  options?: EmbedderResolutionOptions,
): IEmbedder {
  const compose = (raw: IEmbedder): IEmbedder =>
    composeResilientEmbedder(raw, {
      explicitMaxBatchSize: cfg.maxBatchSize,
      fallbackMaxBatchSize: isBatchSizeLimited(raw)
        ? raw.maxBatchSize
        : DEFAULT_MAX_BATCH_SIZE,
      logger: options?.logger,
    });

  // The injected path is composed too: a consumer's DI'd embedder would
  // otherwise bypass chunking entirely. composeResilientEmbedder is idempotent.
  if (options?.injectedEmbedder) return compose(options.injectedEmbedder);

  const name = cfg.embedder ?? 'ollama';
  const opts = {
    url: cfg.url,
    apiKey: cfg.apiKey,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    resourceGroup: cfg.resourceGroup,
    scenario: cfg.scenario,
  };

  if (name in builtInEmbedderFactories) {
    return compose(builtInEmbedderFactories[name](opts));
  }

  const extraFactory = options?.extraFactories?.[name];
  if (!extraFactory) {
    const known = [
      ...Object.keys(builtInEmbedderFactories),
      ...Object.keys(options?.extraFactories ?? {}),
    ];
    throw new Error(
      `Unknown embedder "${name}". Register a factory or use: ${known.join(', ')}`,
    );
  }
  return compose(extraFactory(opts));
}
```

In `makeRag`, every `resolveEmbedder(cfg, options)` call site (lines 236, 262, 281, 304) already forwards `options`; confirm each passes the same `options` object so the new `logger` reaches the resolver. Where a call site builds a fresh options literal, add `logger: options?.logger`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-rag`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-rag/src/rag-factories.ts packages/llm-agent-rag/src/__tests__/resolve-embedder-resilience.test.ts
git commit -m "feat(llm-agent-rag): compose embedder resilience in resolveEmbedder with configurable cap"
```

---

### Task 8: Thread the cap and logger through SmartServer

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:134-160`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.ts:24-68`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-agent-embedder-resilience.test.ts` (create)

**Interfaces:**
- Consumes: `resolveEmbedder` with `logger` (Task 7), `getResilienceMetadata` (Task 4).
- Produces:
  - `SmartServerRagConfig.maxBatchSize?: number`
  - `resolveAgentEmbedder(rag, diEmbedder, extraFactories, logger?)`
  - `resolveToolsStoreEmbedder(current, toolsStoreCfg, diEmbedder, extraFactories, logger?)`

- [ ] **Step 1: Write the failing test**

Create the test file:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '@mcp-abap-adt/llm-agent';
import { getResilienceMetadata } from '@mcp-abap-adt/llm-agent';
import {
  resolveAgentEmbedder,
  resolveToolsStoreEmbedder,
} from '../resolve-agent-embedder.js';

class GeminiLike {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('SmartServer embedder resilience threading', () => {
  it('keeps the cap through wrapEmbedder and reports no conflict', async () => {
    const events: LogEvent[] = [];
    const logger = { log: (e: LogEvent) => events.push(e) };
    const agentEmbedder = await resolveAgentEmbedder(
      { type: 'qdrant', embedder: 'sap-ai-core' },
      new GeminiLike(),
      {},
      logger,
    );
    assert.equal(getResilienceMetadata(agentEmbedder!)?.maxBatchSize, 250);
    assert.deepEqual(events, []);
  });

  it('warns once when a second store asks for a different cap', async () => {
    const events: LogEvent[] = [];
    const logger = { log: (e: LogEvent) => events.push(e) };
    const shared = await resolveAgentEmbedder(
      { type: 'qdrant', embedder: 'sap-ai-core' },
      new GeminiLike(),
      {},
      logger,
    );
    const reused = await resolveToolsStoreEmbedder(
      shared,
      { type: 'qdrant', embedder: 'sap-ai-core', maxBatchSize: 64 },
      undefined,
      {},
      logger,
    );
    assert.equal(reused, shared);
    assert.equal(getResilienceMetadata(reused!)?.maxBatchSize, 250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs`
Expected: FAIL — `resolveAgentEmbedder` takes three parameters; the fourth argument is a type error, and metadata is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `smart-server.ts`, add to `SmartServerRagConfig` after `dimension?: number;` (line 155):

```ts
  /**
   * Cap on texts per embedBatch call. Precedence: this value → the provider's
   * declared cap → the library default (100).
   */
  maxBatchSize?: number;
```

In `resolve-agent-embedder.ts`, add the optional parameter to both functions and
forward it:

```ts
export async function resolveAgentEmbedder(
  rag: SmartServerRagConfig | undefined,
  diEmbedder: IEmbedder | undefined,
  extraFactories: Record<string, EmbedderFactory>,
  logger?: ILogger,
): Promise<IEmbedder | undefined> {
  if (diEmbedder) {
    return wrapEmbedder(
      resolveEmbedder(rag ?? {}, { injectedEmbedder: diEmbedder, logger }),
    );
  }
  if (!rag || (rag.type === 'in-memory' && rag.embedder == null)) {
    return undefined;
  }
  await prefetchEmbedderFactories([rag.embedder ?? 'ollama']);
  const resolved = resolveEmbedder(rag, { extraFactories, logger });
  return resolved ? wrapEmbedder(resolved) : undefined;
}

export async function resolveToolsStoreEmbedder(
  current: IEmbedder | undefined,
  toolsStoreCfg: SmartServerRagConfig,
  diEmbedder: IEmbedder | undefined,
  extraFactories: Record<string, EmbedderFactory>,
  logger?: ILogger,
): Promise<IEmbedder | undefined> {
  if (current) return current;
  return resolveAgentEmbedder(toolsStoreCfg, diEmbedder, extraFactories, logger);
}
```

Add `import type { ILogger } from '@mcp-abap-adt/llm-agent';` to the imports.

Note the DI branch changed: it previously returned `wrapEmbedder(diEmbedder)`
directly, which would skip chunking for an injected embedder.

Update every call site of these two functions in
`packages/llm-agent-server-libs/src/smart-agent/` to pass the server's logger.
Find them with:

```bash
grep -rn "resolveAgentEmbedder\|resolveToolsStoreEmbedder" packages/llm-agent-server-libs/src | grep -v __tests__
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-server-libs`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-agent-embedder-resilience.test.ts
git commit -m "feat(llm-agent-server-libs): thread maxBatchSize and logger through embedder resolution"
```

---

### Task 9: `ToolCatalogStatus` contract and health field

**Files:**
- Create: `packages/llm-agent/src/interfaces/tool-catalog.ts`
- Modify: `packages/llm-agent/src/interfaces/health.ts:4-8`, `packages/llm-agent/src/interfaces/index.ts`, `packages/llm-agent/src/index.ts`
- Test: `packages/llm-agent/src/interfaces/tool-catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ToolCatalogStatus { total: number; vectorized: number; failed: string[]; clientFailures: number; complete: boolean }`
  - `interface IToolCatalogReporter { getToolCatalogStatus(): ToolCatalogStatus | undefined }`
  - `isToolCatalogReporter(x: unknown): x is IToolCatalogReporter`
  - `HealthComponentStatus.toolCatalog?: { vectorized: number; total: number; complete: boolean; clientFailures: number }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isToolCatalogReporter } from './tool-catalog.js';

describe('isToolCatalogReporter', () => {
  it('accepts an object with the method', () => {
    assert.equal(
      isToolCatalogReporter({ getToolCatalogStatus: () => undefined }),
      true,
    );
  });

  it('rejects null, primitives and objects without the method', () => {
    assert.equal(isToolCatalogReporter(null), false);
    assert.equal(isToolCatalogReporter('x'), false);
    assert.equal(isToolCatalogReporter({}), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: FAIL — cannot find module `./tool-catalog.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent/src/interfaces/tool-catalog.ts`:

```ts
/**
 * Result of an MCP tool-catalog vectorization run.
 *
 * Declared HERE, in the leaf contracts package, rather than next to
 * vectorizeMcpTools: llm-agent must not depend on llm-agent-libs.
 */
export interface ToolCatalogStatus {
  /** Tools successfully listed across all MCP clients. */
  total: number;
  /** Tools whose write returned ok: true. */
  vectorized: number;
  /** Names of tools that failed to be written. */
  failed: string[];
  /** Clients whose listTools() failed; their tools never reached `total`. */
  clientFailures: number;
  /** false when any client failed to list, or any listed tool failed. */
  complete: boolean;
}

/**
 * Reports the last vectorization run. Deliberately TINY and SEPARATE from
 * ISmartAgent (ISP), detected via {@link isToolCatalogReporter}.
 */
export interface IToolCatalogReporter {
  /** undefined = nothing was attempted (no store, or a store with no writer). */
  getToolCatalogStatus(): ToolCatalogStatus | undefined;
}

export function isToolCatalogReporter(x: unknown): x is IToolCatalogReporter {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as IToolCatalogReporter).getToolCatalogStatus === 'function'
  );
}
```

In `packages/llm-agent/src/interfaces/health.ts`, extend `HealthComponentStatus`:

```ts
export interface HealthComponentStatus {
  llm: boolean;
  rag: boolean;
  mcp: Array<{ name: string; ok: boolean; error?: string }>;
  /**
   * Counters only — the full `failed` name list stays behind
   * IToolCatalogReporter, since /health is polled on a hot path.
   */
  toolCatalog?: {
    vectorized: number;
    total: number;
    complete: boolean;
    clientFailures: number;
  };
}
```

Export the new module from `packages/llm-agent/src/interfaces/index.ts` and mirror in `packages/llm-agent/src/index.ts`:

```ts
export {
  type IToolCatalogReporter,
  isToolCatalogReporter,
  type ToolCatalogStatus,
} from './tool-catalog.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/tool-catalog.ts packages/llm-agent/src/interfaces/tool-catalog.test.ts packages/llm-agent/src/interfaces/health.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): add ToolCatalogStatus contract and health component field"
```

---

### Task 10: Rewrite `vectorizeMcpTools`

**Files:**
- Modify: `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` (whole file)
- Test: `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts` (append; reuse its existing `IRag`/`IMcpClient`/`CapturingRequestLogger` stubs)

**Interfaces:**
- Consumes: `ToolCatalogStatus` (Task 9).
- Produces: `type ToolVectorizationSummary = ToolCatalogStatus` and
  `vectorizeMcpTools(clients, toolsRag, requestLogger, logger): Promise<ToolVectorizationSummary | undefined>`.

- [ ] **Step 1: Write the failing test**

Append to the existing test file:

```ts
describe('vectorizeMcpTools summary', () => {
  it('aggregates across clients and flags a listTools failure', async () => {
    const rag = makeWritableRag();
    const ok = makeClient([{ name: 'A', description: 'a' }]);
    const broken = makeFailingListClient();
    const summary = await vectorizeMcpTools(
      [ok, broken],
      rag,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary?.total, 1);
    assert.equal(summary?.vectorized, 1);
    assert.equal(summary?.clientFailures, 1);
    assert.equal(summary?.complete, false);
  });

  it('counts a write that resolves to undefined as failed', async () => {
    const rag = makeRagWhoseWriterReturnsUndefined();
    const summary = await vectorizeMcpTools(
      [makeClient([{ name: 'A', description: 'a' }])],
      rag,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary?.vectorized, 0);
    assert.deepEqual(summary?.failed, ['A']);
    assert.equal(summary?.complete, false);
  });

  it('returns undefined for a read-only store', async () => {
    const readOnly = { query: async () => ({ ok: true, value: [] }) } as unknown as IRag;
    const summary = await vectorizeMcpTools(
      [makeClient([{ name: 'A', description: 'a' }])],
      readOnly,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary, undefined);
  });

  it('emits one warning, not one per tool', async () => {
    const events: LogEvent[] = [];
    const rag = makeRagFailingAllWrites();
    await vectorizeMcpTools(
      [makeClient(Array.from({ length: 20 }, (_, i) => ({ name: `T${i}`, description: 'd' })))],
      rag,
      new CapturingRequestLogger(),
      { log: (e) => events.push(e) },
    );
    assert.equal(events.filter((e) => e.type === 'warning').length, 1);
  });
});
```

Add these helpers next to the file's existing stubs:

```ts
const OK = { ok: true as const, value: undefined };

function ragWith(writer: unknown): IRag {
  return {
    query: async () => ({ ok: true, value: [] }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
    writer: () => writer,
  } as unknown as IRag;
}

function makeWritableRag(): IRag {
  return ragWith({
    upsertRaw: async () => OK,
    upsertPrecomputedRaw: async () => OK,
  });
}

function makeRagWhoseWriterReturnsUndefined(): IRag {
  return ragWith({ upsertRaw: async () => undefined });
}

function makeRagFailingAllWrites(): IRag {
  return ragWith({
    upsertRaw: async () => ({
      ok: false as const,
      error: new RagError('nope', 'RAG_ERROR'),
    }),
  });
}

function makeClient(tools: Array<{ name: string; description: string }>): IMcpClient {
  return {
    listTools: async () => ({ ok: true as const, value: tools }),
  } as unknown as IMcpClient;
}

function makeFailingListClient(): IMcpClient {
  return {
    listTools: async () => ({
      ok: false as const,
      error: new McpError('down', 'MCP_ERROR'),
    }),
  } as unknown as IMcpClient;
}
```

Import `McpError` and `RagError` from `@mcp-abap-adt/llm-agent` in the test file.

Add one more test, the documented-limitation case from the spec — an injected
embedder that claims batch capability it does not have:

```ts
it('completes the catalog when a pre-decorated embedder fakes batch support', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const liar = new CircuitBreakerEmbedder(
    { embed: async () => ({ vector: [0] }) },
    breaker,
  );
  const rag = makeWritableRag();
  (rag as unknown as { embedder: unknown }).embedder = liar;
  const summary = await vectorizeMcpTools(
    [makeClient([{ name: 'A', description: 'a' }])],
    rag,
    new CapturingRequestLogger(),
    undefined,
  );
  assert.equal(summary?.complete, true);
  // The capability check throws BEFORE CircuitBreakerEmbedder's try block, so
  // recordFailure() is never reached and the breaker stays closed.
  assert.equal(breaker.state, 'closed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — `vectorizeMcpTools` resolves to `undefined` (returns `void`), so every assertion on `summary?.total` fails.

- [ ] **Step 3: Write minimal implementation**

Replace `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` with:

```ts
/**
 * MCP tool + skill vectorization.
 *
 * Chunking and retry are properties of the embedder (composeResilientEmbedder),
 * NOT of this file: the batch call below is deliberately naive.
 */

import type {
  IEmbedder,
  ILogger,
  IMcpClient,
  IRag,
  IRagBackendWriter,
  IRequestLogger,
  ISkillManager,
  ToolCatalogStatus,
} from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';

export type ToolVectorizationSummary = ToolCatalogStatus;

const MAX_NAMES_IN_LOG = 10;

/** Preserved from the previous implementation — see the loop below. */
const SEQUENTIAL_PACING_EVERY = 5;
const SEQUENTIAL_PACING_MS = 500;

interface Acc {
  total: number;
  vectorized: number;
  failed: string[];
  clientFailures: number;
}

function toolText(name: string, description: string | undefined): string {
  return `Tool: ${name} — ${description}`;
}

/**
 * Write one record. A tool counts as vectorized ONLY when the write returns
 * ok: true — the previous optional-chain form treated a missing writer as
 * success.
 */
async function writeOne(
  writer: IRagBackendWriter,
  id: string,
  text: string,
  vector: number[] | undefined,
  requestLogger: IRequestLogger,
): Promise<boolean> {
  const start = Date.now();
  const result =
    vector && writer.upsertPrecomputedRaw
      ? await writer.upsertPrecomputedRaw(id, text, vector, {})
      : await writer.upsertRaw(id, text, {});
  const ok = result?.ok === true;
  if (ok) {
    const est = Math.ceil(text.length / 4);
    requestLogger.logLlmCall({
      component: 'embedding',
      model: 'embedder',
      promptTokens: est,
      completionTokens: 0,
      totalTokens: est,
      durationMs: Date.now() - start,
      estimated: true,
      scope: 'initialization',
      detail: 'tools',
    });
  }
  return ok;
}

export async function vectorizeMcpTools(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<ToolVectorizationSummary | undefined> {
  const writer = toolsRag?.writer?.();
  // No store, or a deliberately read-only one: nothing is attempted, and the
  // status stays unknown rather than reporting a permanently incomplete
  // catalog for a configuration that never intended to write.
  if (!toolsRag || !writer) return undefined;

  const acc: Acc = { total: 0, vectorized: 0, failed: [], clientFailures: 0 };
  // biome-ignore lint/suspicious/noExplicitAny: reading the store's private embedder for batch optimisation
  const storeEmbedder = (toolsRag as any).embedder as IEmbedder | undefined;

  for (const adapter of clients) {
    try {
      const toolsResult = await adapter.listTools();
      if (!toolsResult.ok) {
        acc.clientFailures++;
        continue;
      }
      const tools = toolsResult.value;
      acc.total += tools.length;
      const texts = tools.map((t) => toolText(t.name, t.description));

      let vectors: number[][] | undefined;
      if (
        storeEmbedder &&
        isBatchEmbedder(storeEmbedder) &&
        writer.upsertPrecomputedRaw !== undefined
      ) {
        const start = Date.now();
        try {
          const results = await storeEmbedder.embedBatch(texts);
          vectors = results.map((r) => r.vector);
          const real = results.reduce<{ p: number; t: number } | null>(
            (a, r) =>
              r.usage
                ? {
                    p: (a?.p ?? 0) + r.usage.promptTokens,
                    t: (a?.t ?? 0) + r.usage.totalTokens,
                  }
                : a,
            null,
          );
          const est = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
          requestLogger.logLlmCall({
            component: 'embedding',
            model: 'embedder',
            promptTokens: real?.p ?? est,
            completionTokens: 0,
            totalTokens: real?.t ?? est,
            durationMs: Date.now() - start,
            estimated: real === null,
            scope: 'initialization',
            detail: 'tools',
          });
        } catch {
          // Falls through to the sequential path below. Chunking and retry
          // already ran inside the embedder, so reaching here means the
          // provider is genuinely unusable for batch work.
          vectors = undefined;
        }
      }

      for (let i = 0; i < tools.length; i++) {
        const ok = await writeOne(
          writer,
          `tool:${tools[i].name}`,
          texts[i],
          vectors?.[i],
          requestLogger,
        );
        if (!ok) acc.failed.push(tools[i].name);
        else acc.vectorized++;

        // Sequential path only: without precomputed vectors each write embeds
        // one text, so this loop is one provider request per tool. Retry reacts
        // only AFTER a 429 and does not throttle successful calls. The pause is
        // kept because removing it strictly increases pressure — not because it
        // is known to be sufficient: it was active during the incident in #236
        // and the boot still logged 385 rate-limit failures.
        if (
          vectors === undefined &&
          (i + 1) % SEQUENTIAL_PACING_EVERY === 0 &&
          i < tools.length - 1
        ) {
          await new Promise((r) => setTimeout(r, SEQUENTIAL_PACING_MS));
        }
      }
    } catch {
      acc.clientFailures++;
    }
  }

  const summary: ToolVectorizationSummary = {
    total: acc.total,
    vectorized: acc.vectorized,
    failed: acc.failed,
    clientFailures: acc.clientFailures,
    complete: acc.clientFailures === 0 && acc.failed.length === 0,
  };

  if (summary.complete) {
    logger?.log({
      type: 'warning',
      traceId: 'builder',
      message: `vectorized ${summary.vectorized}/${summary.total} MCP tools`,
    });
  } else {
    const shown = summary.failed.slice(0, MAX_NAMES_IN_LOG).join(', ');
    const more =
      summary.failed.length > MAX_NAMES_IN_LOG
        ? ` (+${summary.failed.length - MAX_NAMES_IN_LOG} more)`
        : '';
    logger?.log({
      type: 'warning',
      traceId: 'builder',
      message:
        `vectorized ${summary.vectorized}/${summary.total} MCP tools, ` +
        `${summary.failed.length} failed: ${shown}${more}` +
        (summary.clientFailures > 0
          ? `; ${summary.clientFailures} client(s) failed to list tools`
          : ''),
    });
  }

  return summary;
}

export async function vectorizeSkills(
  skillManager: ISkillManager,
  toolsRag: IRag,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<void> {
  const writer = toolsRag.writer?.();
  if (!writer) return;
  const skillsResult = await skillManager.listSkills();
  if (!skillsResult.ok) return;
  const failed: string[] = [];
  for (const s of skillsResult.value) {
    const text = `Skill: ${s.name}\n${s.description}`;
    const ok = await writeOne(
      writer,
      `skill:${s.name}`,
      text,
      undefined,
      requestLogger,
    );
    if (!ok) failed.push(s.name);
  }
  if (failed.length > 0) {
    logger?.log({
      type: 'warning',
      traceId: 'builder',
      message: `skill vectorization failed for: ${failed.join(', ')}`,
    });
  }
}
```

Note: the success log also uses `type: 'warning'` because `LogEvent` has no
informational variant and extending that union is out of scope. Keep the
message wording exactly as above so operators can grep `vectorized `.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: PASS — the four new tests plus every pre-existing test in the file.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts
git commit -m "feat(llm-agent-libs): return an aggregated tool-vectorization summary"
```

---

### Task 11: Status holder, builder wiring and agent delegation

**Files:**
- Create: `packages/llm-agent-libs/src/mcp/tool-catalog-status.ts`
- Modify: `packages/llm-agent-libs/src/builder.ts:962`, `packages/llm-agent-libs/src/agent.ts:129` and `:474-477`
- Test: `packages/llm-agent-libs/src/mcp/tool-catalog-status.test.ts`

**Interfaces:**
- Consumes: `ToolCatalogStatus`, `IToolCatalogReporter` (Task 9), `vectorizeMcpTools` (Task 10).
- Produces:
  - `class ToolCatalogStatusHolder implements IToolCatalogReporter` with `publish(status: ToolCatalogStatus): void`
  - `SmartAgentDeps.toolCatalogStatus?: IToolCatalogReporter`
  - `SmartAgent.getToolCatalogStatus(): ToolCatalogStatus | undefined`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isToolCatalogReporter } from '@mcp-abap-adt/llm-agent';
import { ToolCatalogStatusHolder } from './tool-catalog-status.js';

describe('ToolCatalogStatusHolder', () => {
  it('stays unknown when nothing is published — the skipped-run path', () => {
    // The builder guards with `if (toolSummary)`, so a read-only store leaves
    // the holder empty rather than storing a zeroed summary. HealthChecker then
    // reports healthy (Task 12).
    assert.equal(new ToolCatalogStatusHolder().getToolCatalogStatus(), undefined);
  });

  it('starts unknown and reports what was published', () => {
    const h = new ToolCatalogStatusHolder();
    assert.equal(isToolCatalogReporter(h), true);
    assert.equal(h.getToolCatalogStatus(), undefined);
    h.publish({
      total: 356,
      vectorized: 338,
      failed: ['A'],
      clientFailures: 0,
      complete: false,
    });
    assert.equal(h.getToolCatalogStatus()?.vectorized, 338);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — cannot find module `./tool-catalog-status.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/llm-agent-libs/src/mcp/tool-catalog-status.ts`:

```ts
import type {
  IToolCatalogReporter,
  ToolCatalogStatus,
} from '@mcp-abap-adt/llm-agent';

/**
 * Holds the last vectorization result. Written once by the builder, read by
 * HealthChecker. Stays undefined when nothing was attempted.
 */
export class ToolCatalogStatusHolder implements IToolCatalogReporter {
  private status: ToolCatalogStatus | undefined;

  publish(status: ToolCatalogStatus): void {
    this.status = status;
  }

  getToolCatalogStatus(): ToolCatalogStatus | undefined {
    return this.status;
  }
}
```

In `packages/llm-agent-libs/src/builder.ts`, replace line 962:

```ts
      const toolSummary = await vectorizeMcpTools(
        mcpClients,
        toolsRag,
        requestLogger,
        log,
      );
      // Published only when defined: a skipped run must leave the holder empty
      // rather than storing a zeroed summary.
      if (toolSummary) toolCatalogStatus.publish(toolSummary);
```

Declare the holder before the MCP block (near the other locals in `build()`):

```ts
    const toolCatalogStatus = new ToolCatalogStatusHolder();
```

and add it to the deps object passed to `new SmartAgent({...})`:

```ts
      toolCatalogStatus,
```

Import it: `import { ToolCatalogStatusHolder } from './mcp/tool-catalog-status.js';`

In `packages/llm-agent-libs/src/agent.ts`, add to `SmartAgentDeps` next to
`connectionStrategy?: IMcpConnectionStrategy;` (line 129):

```ts
  /** Reports the startup tool-catalog vectorization result to health checks. */
  toolCatalogStatus?: IToolCatalogReporter;
```

and add the delegation next to `isReady()` (after line 477):

```ts
  /**
   * Tool-catalog status (implements `IToolCatalogReporter`): delegate to the
   * holder the builder populated. Consumers detect this via
   * `isToolCatalogReporter(agent)` — no growth of `ISmartAgent`.
   */
  getToolCatalogStatus(): ToolCatalogStatus | undefined {
    return this.deps.toolCatalogStatus?.getToolCatalogStatus();
  }
```

Add `IToolCatalogReporter` and `ToolCatalogStatus` to the existing type import from `@mcp-abap-adt/llm-agent` in `agent.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: PASS.

- [ ] **Step 5: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/mcp/tool-catalog-status.ts packages/llm-agent-libs/src/mcp/tool-catalog-status.test.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/agent.ts
git commit -m "feat(llm-agent-libs): publish tool-catalog status from the builder"
```

---

### Task 12: Report a partial catalog as `degraded`

**Files:**
- Modify: `packages/llm-agent-libs/src/health/health-checker.ts:29-74`
- Test: `packages/llm-agent-libs/src/health/health-checker.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: `isToolCatalogReporter` (Task 9), `SmartAgent.getToolCatalogStatus` (Task 11).
- Produces: `HealthStatus.components.toolCatalog` and `status: 'degraded'` when `complete === false`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolCatalogStatus } from '@mcp-abap-adt/llm-agent';
import { HealthChecker } from './health-checker.js';

function makeAgent(status: ToolCatalogStatus | undefined, hasReporter = true) {
  const base = {
    healthCheck: async () => ({
      ok: true as const,
      value: { llm: true, rag: true, mcp: [] },
    }),
  };
  return hasReporter
    ? { ...base, getToolCatalogStatus: () => status }
    : base;
}

const deps = (agent: unknown) =>
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the checker
  ({ agent, startTime: Date.now(), version: '0.0.0' }) as any;

describe('HealthChecker tool catalog', () => {
  it('is degraded when the catalog is incomplete', async () => {
    const s = await new HealthChecker(
      deps(
        makeAgent({
          total: 356,
          vectorized: 338,
          failed: ['A'],
          clientFailures: 0,
          complete: false,
        }),
      ),
    ).check();
    assert.equal(s.status, 'degraded');
    assert.equal(s.components.toolCatalog?.vectorized, 338);
  });

  it('is degraded when a client failed to list even though counts match', async () => {
    const s = await new HealthChecker(
      deps(
        makeAgent({
          total: 10,
          vectorized: 10,
          failed: [],
          clientFailures: 1,
          complete: false,
        }),
      ),
    ).check();
    assert.equal(s.status, 'degraded');
  });

  it('is healthy for a complete catalog', async () => {
    const s = await new HealthChecker(
      deps(
        makeAgent({
          total: 5,
          vectorized: 5,
          failed: [],
          clientFailures: 0,
          complete: true,
        }),
      ),
    ).check();
    assert.equal(s.status, 'healthy');
  });

  it('is healthy when nothing was vectorized or no reporter exists', async () => {
    assert.equal((await new HealthChecker(deps(makeAgent(undefined))).check()).status, 'healthy');
    assert.equal(
      (await new HealthChecker(deps(makeAgent(undefined, false))).check()).status,
      'healthy',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — status is `healthy` and `components.toolCatalog` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/llm-agent-libs/src/health/health-checker.ts`, add the import:

```ts
import { isToolCatalogReporter } from '@mcp-abap-adt/llm-agent';
```

Inside `check()`, after `const components = ...` (line 34):

```ts
    const tc = isToolCatalogReporter(this.agent)
      ? this.agent.getToolCatalogStatus()
      : undefined;
```

Extend the status condition (line 56) and the returned components:

```ts
    // A partial catalog degrades service; it does not prevent it. Keyed on
    // `complete`, not on vectorized === total: a client that failed to list
    // contributes nothing to either counter.
    const toolCatalogOk = !tc || tc.complete;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (!llmOk || !ragOk || !mcpAllOk || anyCircuitOpen || !toolCatalogOk) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    return {
      status,
      uptime: Date.now() - this.startTime,
      version: this.version,
      timestamp: new Date().toISOString(),
      components: {
        ...components,
        ...(tc
          ? {
              toolCatalog: {
                vectorized: tc.vectorized,
                total: tc.total,
                complete: tc.complete,
                clientFailures: tc.clientFailures,
              },
            }
          : {}),
      },
      ...(cbStatuses ? { circuitBreakers: cbStatuses } : {}),
      ...(metricsSnapshot ? { metrics: metricsSnapshot } : {}),
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace @mcp-abap-adt/llm-agent-libs`
Expected: PASS — 5 assertions across 4 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: every workspace passes. Compare the failure count against `main` before blaming this branch.

- [ ] **Step 6: Verify build and lint**

Run: `npm run build && npm run lint:check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-libs/src/health/health-checker.ts packages/llm-agent-libs/src/health/health-checker.test.ts
git commit -m "feat(llm-agent-libs): report an incomplete tool catalog as degraded"
```

---

### Task 13: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PERFORMANCE.md`
- Delete: `docs/superpowers/specs/2026-07-23-embed-batch-chunking-design.md`, `docs/superpowers/plans/2026-07-23-embed-batch-chunking.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Add the CHANGELOG entry**

Under a new unreleased heading, matching the existing entry style:

```markdown
### Fixed

- **MCP tool vectorization no longer exceeds provider batch caps** (#236). Tool
  embedding was sent as one `embedBatch` call for the whole catalog, which SAP AI
  Core `gemini-embedding` rejects above 250 instances; the per-item fallback then
  tripped the provider's rate limiter and silently left the catalog partial.
  Chunking and retry are now `IEmbedder` decorators composed in `resolveEmbedder`.

### Added

- `rag.maxBatchSize` (YAML) caps texts per `embedBatch` call. Precedence:
  `rag.maxBatchSize` → the provider's declared cap → `100`.
- `/health` reports `components.toolCatalog` and returns `status: "degraded"`
  when the tool catalog is incomplete. The HTTP code stays `200` — a partial
  catalog degrades service without preventing it.
```

- [ ] **Step 2: Add the TROUBLESHOOTING entry**

Follow the file's symptom → cause → fix format:

```markdown
### `400 INVALID_ARGUMENT ... batchSize value of N but the supported range is from 1 to 251`

**Cause:** the embedding provider caps batch size (SAP AI Core `gemini-embedding`
routes to Vertex, max 250) and the MCP catalog is larger.

**Fix:** upgrade to the release containing #236, which chunks automatically. If
your tenant's limit is lower than the model's documented one, set
`rag.maxBatchSize` in `smart-server.yaml`.

### `/health` reports `"status": "degraded"` with a `toolCatalog` block

**Cause:** some MCP tools failed to embed, or a client's `tools/list` failed, so
RAG-based tool selection cannot see every tool.

**Fix:** read `components.toolCatalog`. `clientFailures > 0` points at an
unreachable MCP endpoint; `failed` names (via the agent's
`getToolCatalogStatus()`) point at embedding errors — usually rate limiting.
```

- [ ] **Step 3: Document the decorators in ARCHITECTURE.md**

In the section listing `llm-agent`'s lightweight helpers, add
`BatchChunkingEmbedder`, `RetryEmbedder`, and `composeResilientEmbedder`
alongside `CircuitBreaker` and `FallbackRag`, with one sentence: chunking and
retry are embedder properties, composed once in `resolveEmbedder`, so every
`embedBatch` caller inherits them.

- [ ] **Step 4: Document tuning in PERFORMANCE.md**

Add a short subsection: `rag.maxBatchSize` trades requests against per-request
size; the default of 100 is safe for every known provider, and raising it to the
provider's real cap reduces round trips on large catalogs.

- [ ] **Step 5: Verify every documented claim against the source**

For each concrete claim (key names, default values, precedence order, HTTP
codes), grep the implementation and confirm. Documentation subagents and
memory alike get these wrong; the check is not optional.

```bash
grep -rn "maxBatchSize" packages/*/src --include='*.ts' | grep -v test
grep -rn "DEFAULT_MAX_BATCH_SIZE" packages/llm-agent/src
```

- [ ] **Step 6: Delete the spec and this plan**

Per CLAUDE.md, specs and plans live in the tree only while active.

```bash
git rm docs/superpowers/specs/2026-07-23-embed-batch-chunking-design.md docs/superpowers/plans/2026-07-23-embed-batch-chunking.md
```

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: document embedder batch chunking, retry and tool-catalog health (#236)"
```

---

## Final Verification

- [ ] `npm run build` — clean.
- [ ] `npm run lint:check` — clean (check, not format).
- [ ] `npm test` — compare against a `main` baseline before attributing any failure to this branch.
- [ ] Live gate: boot against the 356-tool MCP catalog with `RAG_EMBEDDER=sap-aicore`, `EMBEDDING_MODEL=gemini-embedding`, an empty `mcp_tools` collection. Expect a single `vectorized 356/356 MCP tools` line, no `400`, no `429`, and `/health` reporting `"status": "healthy"` with `toolCatalog.complete: true`.
- [ ] External code review before merge; merge only on the maintainer's explicit word.
