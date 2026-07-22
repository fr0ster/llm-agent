# Embedder batch chunking, retry and tool-catalog visibility — design

Issue: [#236](https://github.com/fr0ster/llm-agent/issues/236)

## Problem

Startup MCP tool vectorization sends all N tools in a single `embedBatch` call
(`packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts:45-50`). Against a
provider that caps batch size — SAP AI Core `gemini-embedding` routes to Vertex,
max 250 instances — a catalog of 356 tools fails with `400 INVALID_ARGUMENT`.

The failure drops into a fallback loop that upserts **one tool per iteration**
(lines 108-139). Its `batchSize = 5` only paces a 500 ms sleep; it does not
batch. 356 sequential embedding requests then trip the provider's rate limiter
(`429`), and each failure is a warning with no retry — so tools are silently
dropped.

The result is a partial tool catalog (observed: 245 → 334 → 338 of 356 across
three restarts) while `/health` reports `status: ok` on every boot. RAG-based
tool selection cannot see the missing tools, and nothing distinguishes a
31%-incomplete catalog from a complete one.

Four separable defects:

1. The batch is never chunked to a provider-safe size.
2. The fallback is per-item with no retry or backoff.
3. Three near-identical sequential loops exist in one file (lines 108-139,
   143-174, and `vectorizeSkills` 197-225).
4. A partial catalog is invisible: scattered warnings only, `/health` unaffected.

Note on scope of each fix: chunking cures the `400`. It cures the `429` only
indirectly, by cutting 356 requests down to 2 — the standing guard against rate
limiting is retry with backoff.

## Approach

Chunking and retry become properties of the **embedder**, expressed as
`IEmbedder` decorators, not as glue in the calling code. Every `embedBatch`
caller benefits, not just MCP tool vectorization. This follows the repository's
existing precedents:

- `CircuitBreakerEmbedder` (`packages/llm-agent/src/resilience/circuit-breaker-embedder.ts`)
  — an `IEmbedder` decorator that already proxies `embedBatch` correctly.
- `RetryLlm` (`packages/llm-agent-libs/src/resilience/retry-llm.ts`) — retry with
  exponential backoff and `retryOn: [429, 500, 502, 503]`.
- `IReadinessReporter` (`packages/llm-agent/src/interfaces/readiness-reporter.ts`)
  — a deliberately tiny, separate interface detected via a type guard, rather
  than a method bolted onto a larger interface.

Architecture principles satisfied: (1) build on existing components rather than
bespoke glue in the caller; (4) add a new focused interface instead of growing
`IEmbedderBatch`; (5) the batch cap is a consumer-owned variation point, so it is
configurable; (7) all changes are additive.

## Components

### 1. `IBatchSizeLimited` — provider-advertised cap

New interface in `packages/llm-agent/src/interfaces/rag.ts`, alongside the
existing `isBatchEmbedder` (line 60):

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

export function isBatchSizeLimited(
  e: IEmbedder,
): e is IEmbedder & IBatchSizeLimited;
```

`IEmbedderBatch` is not modified.

### 2. `BatchChunkingEmbedder`

New decorator in `packages/llm-agent/src/resilience/`, structured after
`circuit-breaker-embedder.ts`.

```ts
new BatchChunkingEmbedder(inner, { maxBatchSize?: number })
```

Effective chunk size, in priority order:

1. `options.maxBatchSize` (originates from YAML)
2. `inner.maxBatchSize` when `isBatchSizeLimited(inner)`
3. `DEFAULT_MAX_BATCH_SIZE` — a conservative constant

`embed()` passes through unchanged. `embedBatch()` splits the input, issues
**sequential** `inner.embedBatch(chunk)` calls, and concatenates results in input
order. Sequential rather than concurrent: parallel chunks would reintroduce the
rate-limiting that caused the `429`.

Empty input returns `[]` without calling `inner`.

### 3. `RetryEmbedder`

New decorator in the same directory, a port of `RetryLlm` onto `IEmbedder`:

```ts
new RetryEmbedder(inner, {
  maxAttempts: 3,
  backoffMs: 2000,
  retryOn: [429, 500, 502, 503],
})
```

Defaults mirror `RetryLlm`'s `DEFAULT_OPTIONS` (`retry-llm.ts:31-36`).

Difference from `RetryLlm`: `IEmbedder` throws rather than returning a `Result`,
so the retry decision is made in a `catch` block by matching the status code in
the thrown `RagError` message. Both `embed` and `embedBatch` are retried. Like
`RetryLlm` (line 63), an aborted `options.signal` short-circuits without
retrying.

### 4. Composition order

```
wrapEmbedder( BatchChunkingEmbedder( RetryEmbedder( inner ) ) )
```

Retry sits **inside** chunking on purpose: each chunk retries independently, so a
failure on chunk 20 does not re-issue chunks 1-19. `wrapEmbedder`
(usage-logging) stays outermost, so one logical `embedBatch` produces one usage
record carrying the aggregated result usage — chunking does not inflate the call
count, and failed retry attempts, which return no usage, are not counted.

### 5. Composition point

`resolveEmbedder` (`packages/llm-agent-rag/src/rag-factories.ts:138-171`) is the
single choke point through which all four RAG backends obtain their embedder
(lines 236, 262, 281, 304). This is the instance `vectorizeMcpTools` reaches via
the RAG's private field:

```ts
// vectorize-mcp-tools.ts:35
const storeEmbedder = (toolsRag as any).embedder as IEmbedder | undefined;
```

The fix must land here; wrapping only the agent-embedder chain would miss the
failing path entirely.

The early return at line 142 —
`if (options?.injectedEmbedder) return options.injectedEmbedder;` — must be
wrapped too, otherwise a consumer's DI'd embedder bypasses chunking. Wrapping is
idempotent (following the `wrapEmbedder` precedent) so repeated resolution does
not stack layers.

Idempotence is not hypothetical on the SmartServer path: `resolveAgentEmbedder`
(`packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.ts:41-42`)
calls `resolveEmbedder`, wraps the result with `wrapEmbedder`, and then passes
that instance to `makeRag` as `injectedEmbedder` — where it reaches
`resolveEmbedder`'s line 142 early return a second time. Without idempotence the
decorators would stack on every boot.

### 6. Cap declaration in `sap-aicore-embedder`

`FoundationModelsEmbedder` (`packages/sap-aicore-embedder/src/foundation-embedder.ts:42`)
implements `IBatchSizeLimited`. The value derives from `this.family`, set by
`detectFamily(config.model)` at line 54 — the same discriminator that already
selects the Vertex request shape `{ instances: [...] }` at line 100:

- `gemini` → **250**. Confirmed by the provider's own error text: "supported
  range is from 1 (inclusive) to 251 (exclusive)".
- Other families → no cap declared, so the decorator's conservative default
  applies. No documented AI Core limit for the OpenAI family was verified, so
  none is asserted.

### 7. YAML key

`SmartServerRagConfig` (`packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:134`)
gains `maxBatchSize?: number`, alongside existing tuning keys such as
`dedupThreshold`, `poolMax` and `connectTimeout`. It is threaded through
`EmbedderResolutionConfig` into `resolveEmbedder`.

Documented precedence: **YAML → provider interface → default**.

This exists as an escape hatch: AI Core limits can depend on tenant quota, not
only on the model, so a documented number may not match a given landscape.

### 8. `vectorize-mcp-tools.ts` rewrite

The three near-identical sequential loops collapse into one private helper that
returns counters. The batch branch (lines 44-100) keeps its single
`storeEmbedder.embedBatch(texts)` call over the whole catalog — now correct,
because chunking and retry are the embedder's concern and the caller need not
know about them. No batch-size constant appears in this file.

The sequential fallback is retained as a genuine last resort: it now runs only
when `embedBatch` fails after all retries. The manual 500 ms sleep every five
items is removed — pacing is `RetryEmbedder`'s job.

Signature changes additively:

```ts
export interface ToolVectorizationSummary {
  total: number;
  vectorized: number;
  failed: string[]; // tool names
}

export async function vectorizeMcpTools(
  /* unchanged params */
): Promise<ToolVectorizationSummary>;
```

Existing callers that ignore the result are unaffected.

Logging replaces up to N warnings with one summary:

```
vectorized 356/356 MCP tools
vectorized 338/356 MCP tools, 18 failed: GetObjectInfo, GetInclude, …
```

Individual failures remain, demoted to `debug`.

### 9. Tool-catalog visibility

Another small interface in `llm-agent`, same ISP pattern:

```ts
export interface IToolCatalogReporter {
  getToolCatalogStatus(): { vectorized: number; total: number } | undefined;
}

export function isToolCatalogReporter(x: unknown): x is IToolCatalogReporter;
```

State lives in a small holder (`packages/llm-agent-libs/src/mcp/tool-catalog-status.ts`)
that the builder creates, passes to `vectorizeMcpTools`, and places in the
agent's deps. `SmartAgent` delegates in three lines, exactly as `isReady()`
already does (`packages/llm-agent-libs/src/agent.ts:474-477`). `ISmartAgent` does
not grow.

`HealthComponentStatus` (`packages/llm-agent/src/interfaces/health.ts:4`) gains an
optional field:

```ts
toolCatalog?: { vectorized: number; total: number };
```

`HealthChecker.check()` (`packages/llm-agent-libs/src/health/health-checker.ts:29`)
reads it through the type guard and extends the condition at line 56:

```ts
const toolCatalogOk = !tc || tc.vectorized === tc.total;
if (!llmOk || !ragOk || !mcpAllOk || anyCircuitOpen || !toolCatalogOk)
  status = 'degraded';
```

`ready` and the HTTP status code are **not** touched: the response stays `200`
with `status: "degraded"`. This follows the doctrine already recorded in the
code — `health-checker.ts:56-60` ("a soft component signal ⇒ degraded, not
unhealthy; inability to SERVE is expressed via readiness") and
`health-route-handler.ts:14-16` ("a load balancer must not drop a working pod").

A partial catalog degrades service; it does not prevent it. Failing readiness
would also be actively harmful here: the reported recovery path was incremental
top-up across restarts (245 → 334 → 338), which a crash loop would prevent.

## Error handling

- A chunk that fails after all retries propagates, failing the whole
  `embedBatch`; `vectorizeMcpTools` then takes the sequential fallback. Partial
  results from earlier chunks are not kept — mixing "half via batch, half via
  fallback" produces states that are hard to reproduce.
- `RetryEmbedder` does not retry when `options.signal` is aborted.
- A single tool failing in the sequential path is recorded in `failed[]` and the
  loop continues. Boot never fails on vectorization.

## Testing

`node --test`, following the stubs already present in
`packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts` (`IRag`,
`IMcpClient`, `CapturingRequestLogger`).

- `BatchChunkingEmbedder`: 356 texts with cap 250 → exactly 2 inner calls of
  size 250 and 106, **vector order preserved**; empty input → 0 inner calls;
  cap ≥ N → 1 call.
- Cap resolution: YAML overrides interface; interface overrides default; an
  embedder without the interface gets the default.
- `RetryEmbedder`: `429` then success on the second attempt; exhausted attempts
  throw; a non-retryable `400` throws immediately without backoff.
- `FoundationModelsEmbedder`: `maxBatchSize === 250` for a gemini model.
- `vectorizeMcpTools`: the summary counts correctly on partial failure; exactly
  one warning is emitted instead of N.
- `HealthChecker`: `vectorized < total` → `degraded`; equal → `healthy`; no
  reporter → `healthy` (backward compatibility).
- Final gate before merge: a live run against the reporter's 356-tool catalog.

## Delivery

One PR, three commits:

1. `IBatchSizeLimited` + both decorators + `FoundationModelsEmbedder.maxBatchSize`
   + tests.
2. Composition in `resolveEmbedder` + YAML key + threading.
3. `vectorize-mcp-tools` rewrite + `IToolCatalogReporter` + health integration.

Packages touched: `llm-agent`, `llm-agent-rag`, `llm-agent-libs`,
`llm-agent-server-libs`, `sap-aicore-embedder`. Lockstep release; publishing is
the maintainer's step.
