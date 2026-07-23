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

- `wrapEmbedder` (`packages/llm-agent-libs/src/adapters/usage-logging-embedder.ts:97-103`)
  — the canonical decorator factory: brand-based idempotence, and a **class
  chosen by `isBatchEmbedder(inner)` so the wrapper preserves, rather than
  fabricates, batch capability**.
- `CircuitBreakerEmbedder` (`packages/llm-agent/src/resilience/circuit-breaker-embedder.ts`)
  — an `IEmbedder` decorator structure to follow.
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

The guard tests the **value**, not key presence: it returns `true` only for a
positive safe integer. An implementer may carry `maxBatchSize?: number` and leave
it `undefined` for models whose cap is unknown (§7), and `'maxBatchSize' in e`
would wrongly accept that.

**Contract direction: provider → composition, never decorator → decorator.** The
cap is read from the bare provider instance at the composition point (§5),
*before* any decorator is applied, and handed to the chunker as a plain number.
Decorators therefore never re-detect it.

This is deliberate. Requiring every transparent decorator to proxy every
capability is an N×M obligation — each future decorator would have to know about
each future capability, and forgetting one produces exactly the silent-default
bug this design exists to prevent. It would also force edits to
`CircuitBreakerEmbedder` and `wrapEmbedder`, which are currently correct.

### 2. `BatchChunkingEmbedder`

New decorator in `packages/llm-agent/src/resilience/`, structured after
`circuit-breaker-embedder.ts`. Applied **only over a batch-capable inner**
(see §4).

```ts
new BatchChunkingEmbedder(inner: IEmbedderBatch, maxBatchSize: number)
```

`maxBatchSize` is a required explicit number — the decorator performs no
capability detection and has no fallback of its own.

**Validation (constructor, fail-fast):** `maxBatchSize` must be a positive safe
integer. `0`, negative, fractional and `NaN` values throw a configuration error
at construction. `0` would otherwise produce an infinite loop, and a fractional
value non-deterministic chunk boundaries. Silent clamping is deliberately not
used: a mistyped config should surface at boot, not as mysterious slowness.

`embed()` passes through unchanged. `embedBatch()` splits the input, issues
**sequential** `inner.embedBatch(chunk)` calls, and concatenates results in input
order. Sequential rather than concurrent: parallel chunks would reintroduce the
rate-limiting that caused the `429`.

**Cardinality check:** every chunk must return exactly as many embeddings as it
was given. A mismatch throws a typed `RagError` naming the expected and actual
counts. Without it, a short response surfaces far away as
`embedResults[i].vector` on `undefined` (`vectorize-mcp-tools.ts:58`) — an
opaque `TypeError` followed by a full sequential replay.

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

Defaults mirror `RetryLlm`'s `DEFAULT_OPTIONS` (`retry-llm.ts:31-36`). Like
`RetryLlm` (line 63), an aborted `options.signal` short-circuits without
retrying.

Retry applies regardless of batch capability, but it must **preserve** that
capability rather than fabricate it — the same trap as §4. It therefore ships as
two classes behind a factory, exactly like `wrapEmbedder`:

```ts
function withRetry(inner: IEmbedder, opts?): IEmbedder {
  return isBatchEmbedder(inner)
    ? new RetryBatchEmbedder(inner, opts)  // retries embed + embedBatch
    : new RetryEmbedder(inner, opts);      // retries embed only
}
```

A single class exposing `embedBatch` unconditionally would make every non-batch
embedder look batch-capable to `isBatchEmbedder`, which is precisely the failure
§4 exists to prevent.

**Status extraction.** `IEmbedder` throws rather than returning a `Result`, and
the thrown value is `unknown` — adapters may throw a `RagError`, an SDK error
carrying `status`/`statusCode`, a wrapped error with a `cause`, or a `Response`.
`RagError` itself (`packages/llm-agent/src/interfaces/types.ts:154-159`) carries
only `message` and `code` — no status field. A shared extractor resolves the
status in this order:

1. a numeric `status` / `statusCode` property on the thrown value;
2. the same, walking `cause` — bounded by a depth limit and a `visited` set, so a
   self-referential or cyclic `cause` chain cannot hang the extractor;
3. only then a cautious match against the message text.

Step 3 is last on purpose. The precedent being ported, `RetryLlm.isRetryable`
(`retry-llm.ts:134-137`), does `msg.includes(String(code))` over the entire
message, so any message incidentally containing `429` or `500` — a line number,
an id, a byte count — triggers a false retry. The new extractor must not
reproduce that. `RetryLlm` itself is **not** modified here: touching the LLM path
would widen this PR's blast radius.

### 4. Composition

```
wrapEmbedder(
  isBatchEmbedder(provider)
    ? new BatchChunkingEmbedder(new RetryBatchEmbedder(provider), cap)
    : new RetryEmbedder(provider)
)
```

Batch capability is thus preserved end-to-end and never invented: each layer
picks its class from `isBatchEmbedder(inner)`, so `isBatchEmbedder(composed)`
equals `isBatchEmbedder(provider)` for every input.

Two rules:

**Chunking only over a batch-capable inner.** `isBatchEmbedder`
(`rag.ts:60-65`) tests only `'embedBatch' in e`, so a decorator that exposes
`embedBatch` unconditionally would make a non-batch embedder *look* batch-capable
— `vectorize-mcp-tools.ts:39-43` would then take the batch path and fail. This is
not theoretical for a consumer's DI'd embedder, the very instance §5 requires us
to wrap. All built-in embedders are batch-capable
(`ollama.ts:78`, `openai-embedder.ts:93`, `foundation-embedder.ts:73`), so the
exposure is precisely the custom-embedder path.

`wrapEmbedder` already solves this exact problem and its shape is copied rather
than reinvented: it selects `UsageLoggingBatchEmbedder` vs `UsageLoggingEmbedder`
by `isBatchEmbedder(inner)` and documents that it "preserves `isBatchEmbedder`".

**Retry inside chunking.** Each chunk retries independently, so a failure on
chunk 20 does not re-issue chunks 1-19.

`wrapEmbedder` (usage-logging) stays outermost, so one logical `embedBatch`
produces one usage record carrying the aggregated result usage — chunking does
not inflate the call count, and failed retry attempts, which return no usage, are
not counted.

### 4a. Idempotence and configuration ownership

Idempotence uses a brand symbol as `wrapEmbedder` does, but a brand alone is not
sufficient here, and the reason is specific to this codebase.

`wrapEmbedder`'s brand is an **own property of the wrapper instance**
(`usage-logging-embedder.ts:9,39`):

```ts
const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-embedder');
class UsageLoggingEmbedder implements IEmbedder {
  readonly [BRAND] = true;
  constructor(protected readonly inner: IEmbedder) {}
```

`inner` is `protected`, so nothing outside can traverse the chain. Given
`Usage(Chunk(Retry(provider)))`, a resilience brand checked on the outer object
reads `undefined` — the brand sits on the hidden inner layer. A second pass
through `resolveEmbedder` would therefore decorate again, and the re-resolved cap
could silently drop from the provider's 250 to the default 100.

Two rules close this:

**Metadata propagation.** A boolean brand is not enough. The ownership rule below
has to compare the *existing* effective cap against a newly requested one, and a
`true` flag cannot answer that — while the chunker that knows the number is
unreachable behind `protected inner`. The brand therefore carries data:

```ts
export interface IEmbedderResilience {
  readonly resilience: { maxBatchSize?: number };
}

/** Undefined iff the embedder has no resilience layer. */
export function getResilienceMetadata(
  e: IEmbedder,
): { maxBatchSize?: number } | undefined;
```

`maxBatchSize` is optional inside the metadata because a non-batch embedder gets
retry without chunking (§4), so there is no cap to report.

`wrapEmbedder` propagates the **metadata object**, not a flag, from its inner
embedder onto the wrapper it returns. This is a narrow, explicit contract — one
property, propagated by the one decorator that composes over resilience — not the
general "every decorator proxies every capability" obligation rejected in §1.
`getResilienceMetadata` is the only supported way to ask; there is no separate
boolean helper, since `!== undefined` answers that question.

**Configuration ownership.** The cap is owned by the composition that first
builds the chain. If a later call reaches an already-resilient embedder with a
*different* `maxBatchSize`, the existing chain is returned unchanged and a
warning names both values — which is possible only because the metadata carries
the original number. Recomposition with new settings is explicitly not supported:
silently rebuilding would double the decorators, and silently honouring the newer
value would make the effective cap depend on call order. A consumer who needs a
different cap sets it on the composition root.

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

The cap is resolved here, on the bare provider instance, in this order:

1. `cfg.maxBatchSize` (from YAML)
2. `provider.maxBatchSize` when `isBatchSizeLimited(provider)`
3. `DEFAULT_MAX_BATCH_SIZE`

The early return at line 142 —
`if (options?.injectedEmbedder) return options.injectedEmbedder;` — must be
decorated too, otherwise a consumer's DI'd embedder bypasses chunking.

Idempotence is not hypothetical on the SmartServer path: `resolveAgentEmbedder`
(`packages/llm-agent-server-libs/src/smart-agent/resolve-agent-embedder.ts:41-42`)
calls `resolveEmbedder`, wraps the result with `wrapEmbedder`, and then passes
that instance to `makeRag` as `injectedEmbedder` — where it reaches
`resolveEmbedder`'s line 142 early return a second time. Without idempotence the
decorators would stack on every boot — and because that second instance arrives
already wrapped by `wrapEmbedder`, an own-property brand check is not enough.
This is exactly what §4a's brand propagation exists for; the same section governs
what happens when the two passes disagree about the cap.

### 6. Default cap

```ts
export const DEFAULT_MAX_BATCH_SIZE = 100;
```

Chosen with margin below the only hard cap we have confirmed (Vertex 250), and
large enough that a 356-tool catalog costs 4 requests. Accepted side effect: a
provider that declares no cap — ollama, for instance — now issues 4 calls where
it previously issued one. That is the price of a default that is safe everywhere;
a consumer who knows better raises it via YAML.

### 7. Cap declaration in `sap-aicore-embedder`

One class, `FoundationModelsEmbedder`
(`packages/sap-aicore-embedder/src/foundation-embedder.ts:42`), serves every
model family — `detectFamily(config.model)` at line 54 is the discriminator that
already selects the Vertex request shape `{ instances: [...] }` at line 100.

That rules out `implements IBatchSizeLimited`: the interface's `maxBatchSize` is
required, so declaring it would give *every* instance a cap, including families
whose real limit we have not verified. "No cap declared for other families" would
be unimplementable.

Instead the property is **conditionally assigned, without `implements`**:

```ts
/** Set only for families with a confirmed provider cap (see IBatchSizeLimited). */
readonly maxBatchSize?: number;

// in the constructor:
if (this.family === 'gemini') this.maxBatchSize = 250;
```

- `gemini` → **250**. Confirmed by the provider's own error text: "supported
  range is from 1 (inclusive) to 251 (exclusive)".
- Other families → the property is `undefined`, so `DEFAULT_MAX_BATCH_SIZE`
  applies. No documented AI Core limit for the OpenAI family was verified, so
  none is asserted.

`undefined`, not absent: `tsconfig.base.json` sets `"target": "ES2022"` and does
not set `useDefineForClassFields`, which therefore defaults to `true`. A declared
field without an initializer is emitted as an own property holding `undefined`,
so a non-gemini instance still *has* `maxBatchSize`. A `declare readonly` type-only
declaration would make the absence physical, but that is unnecessary cleverness
here — the guard below makes physical absence irrelevant.

`isBatchSizeLimited` must therefore be a **value** guard, not a key-presence
guard: it accepts only a positive safe integer. `'maxBatchSize' in e` would be
true for an instance carrying `undefined`, which is exactly the shape this
produces.

### 8. YAML key

`SmartServerRagConfig` (`packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:134`)
gains `maxBatchSize?: number`, alongside existing tuning keys such as
`dedupThreshold`, `poolMax` and `connectTimeout`. It is threaded through
`EmbedderResolutionConfig` into `resolveEmbedder`.

Documented precedence: **YAML → provider interface → default**.

This exists as an escape hatch: AI Core limits can depend on tenant quota, not
only on the model, so a documented number may not match a given landscape.

### 9. `vectorize-mcp-tools.ts` rewrite

The three near-identical sequential loops collapse into one private helper that
returns counters. The batch branch (lines 44-100) keeps its single
`storeEmbedder.embedBatch(texts)` call over the whole catalog — now correct,
because chunking and retry are the embedder's concern and the caller need not
know about them. No batch-size constant appears in this file.

The sequential fallback is retained as a genuine last resort: it runs only when
`embedBatch` fails after all retries.

**Its existing 500 ms-per-5-items pacing is kept.** Retry reacts only *after* a
`429`; it does not throttle successful requests, so a non-batch embedder still
issues one request per tool. Retaining the pause is not, however, a proven
safeguard — that exact pacing was active during the reported incident and the
boot still logged 385 rate-limit failures. It is kept because removing it
strictly increases pressure, not because it is known to help. A real rate
limiter is deliberately not introduced without a measurement to size it.

**Residual risk, accepted:** for a non-batch embedder with a large catalog, the
sequential path can still hit the provider's rate limit, and exponential backoff
then slows boot noticeably. Chunking does not help this path, because there is no
batch call to chunk.

Signature changes additively:

```ts
export interface ToolVectorizationSummary {
  /** Tools successfully listed across all clients. */
  total: number;
  vectorized: number;
  failed: string[]; // tool names
  /** Clients whose listTools() failed — their tools are absent from `total`. */
  clientFailures: number;
  /** false when any client failed to list, or any listed tool failed to embed. */
  complete: boolean;
}

export async function vectorizeMcpTools(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<ToolVectorizationSummary>;
```

The parameter list is unchanged — no status holder is threaded in. The function
stays pure with respect to reporting: it returns the summary, and the builder
publishes it (§10). It never throws; per-client failures are caught internally as
they are today (lines 178-187), so the caller always receives a summary.

Existing callers that ignore the result are unaffected.

`complete` exists because counting alone cannot express the failure. With ten
tools vectorized from client A and `listTools()` failing on client B, the
counters read `{ vectorized: 10, total: 10 }` — indistinguishable from a healthy
boot, since B's tools were never counted. Health therefore keys off `complete`,
not off `vectorized === total`.

**Aggregation across MCP clients.** `vectorizeMcpTools` iterates every client, so
the summary is defined as follows:

- One snapshot for the whole call, aggregated over all clients. `total` is the
  sum of tools successfully listed across clients; `vectorized` and `failed`
  accumulate likewise.
- A failing `listTools()` — today silently skipped at line 30 — increments
  `clientFailures` and sets `complete: false`, so a server whose second MCP
  endpoint is down cannot report a complete catalog.
- The builder publishes the returned summary **once**, after the call. Per-client
  publication is explicitly avoided: the last client would otherwise overwrite
  its predecessors' results.

**Known limitation, out of scope:** identical tool names exported by different
MCP servers collide today — the record id is `tool:${t.name}` (line 56), so the
second write overwrites the first while both are counted. This predates the
change and is left as a separate issue rather than widening this one.

Logging replaces up to N warnings with one summary:

```
vectorized 356/356 MCP tools
vectorized 338/356 MCP tools, 18 failed: GetObjectInfo, GetInclude, … (+8 more)
```

**Per-tool failure messages are removed, not demoted.** `LogEvent`
(`packages/llm-agent/src/logger/types.ts:5-64`) is a closed union of ten
variants ending in `{ type: 'warning'; traceId; message }` — there is no `debug`
variant, so "demote to debug" would not compile. Of the three ways out —
add `debug` to the union, drop the per-tool messages, or keep them as warnings —
the union is a public type and adding a member breaks exhaustive `switch`
statements in consumer code, while keeping the warnings contradicts the whole
point of the change.

Dropping them loses nothing: the complete list of failed tool names is already
carried in `ToolVectorizationSummary.failed`, which is returned to the caller and
published to the health reporter. Only the log line truncates, to keep one
message bounded when a whole catalog fails; the full list stays in the summary.

### 10. Tool-catalog visibility

Another small interface in `llm-agent`, same ISP pattern:

```ts
export interface IToolCatalogReporter {
  getToolCatalogStatus():
    | { vectorized: number; total: number; complete: boolean }
    | undefined;
}

export function isToolCatalogReporter(x: unknown): x is IToolCatalogReporter;
```

`undefined` means "not yet known" — before vectorization completes, and for any
deployment that never runs it. `HealthChecker` treats that as healthy, which
preserves current behaviour.

State lives in a small holder (`packages/llm-agent-libs/src/mcp/tool-catalog-status.ts`)
that the builder creates and places in the agent's deps. The builder — not
`vectorizeMcpTools` — writes the returned summary into it, keeping the
vectorization function free of reporting concerns (§9). `SmartAgent` delegates in
three lines, exactly as `isReady()` already does
(`packages/llm-agent-libs/src/agent.ts:474-477`). `ISmartAgent` does not grow.

`HealthComponentStatus` (`packages/llm-agent/src/interfaces/health.ts:4`) gains an
optional field:

```ts
toolCatalog?: { vectorized: number; total: number; complete: boolean };
```

`HealthChecker.check()` (`packages/llm-agent-libs/src/health/health-checker.ts:29`)
reads it through the type guard and extends the condition at line 56:

```ts
const toolCatalogOk = !tc || tc.complete;
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
- A chunk returning the wrong number of embeddings throws a typed `RagError`
  (§2) rather than corrupting downstream indexing.
- An invalid `maxBatchSize` fails fast at construction (§2).
- `RetryEmbedder` does not retry when `options.signal` is aborted.
- A single tool failing in the sequential path is recorded in `failed[]` and the
  loop continues. Boot never fails on vectorization.

## Out of scope

- **Upsert batching.** Chunking bounds the *embedding* calls, not the writes: the
  batch branch still issues one `upsertPrecomputedRaw` per tool (lines 52-67),
  which against Qdrant means 356 HTTP round-trips. This does not cause the
  reported failure, but after this fix it dominates vectorization time. Noted
  here so its absence reads as a decision rather than an oversight.
- **`RetryLlm`'s substring status matching** (§3) — same defect class, LLM path,
  separate change.
- **Duplicate tool names across MCP servers** (§9).

## Testing

`node --test`, following the stubs already present in
`packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts` (`IRag`,
`IMcpClient`, `CapturingRequestLogger`).

`BatchChunkingEmbedder`:

- 356 texts, cap 250 → exactly 2 inner calls of size 250 and 106, **vector order
  preserved**; empty input → 0 inner calls; cap ≥ N → 1 call.
- `maxBatchSize` of `0`, `-1`, `1.5` → constructor throws.
- A chunk returning fewer embeddings than texts → typed `RagError`.

Composition:

- **Over the full decorator chain, not a bare provider**: a provider declaring
  `maxBatchSize = 250`, composed exactly as §4 does, still chunks at 250 — the
  regression test for the capability-through-decorators defect.
- Cap resolution: YAML overrides the provider interface; the interface overrides
  the default; a provider with neither gets `DEFAULT_MAX_BATCH_SIZE`.
- **An injected embedder implementing only `embed()`** stays non-batch after
  composition: `isBatchEmbedder(composed) === false`, and `vectorizeMcpTools`
  takes the sequential path instead of throwing. Asserted for the retry layer in
  isolation as well, not only for the full chain — a batch-capable
  `RetryEmbedder` would reintroduce the defect silently.
- Composing twice yields the same instance (idempotence) — **including through
  `wrapEmbedder`**: `resolveEmbedder(wrapEmbedder(composed))` returns it
  unchanged, the regression test for brand propagation (§4a). Asserted by
  counting inner calls, not by identity alone, so a stacked chunker is caught.
- Re-composing an already-resilient embedder with a different `maxBatchSize`
  keeps the original cap and logs a warning naming both values — which requires
  `getResilienceMetadata` to survive `wrapEmbedder` and to carry the number, not
  a flag (§4a).

`RetryEmbedder`:

- `429` then success on the second attempt; exhausted attempts throw; a
  non-retryable `400` throws immediately without backoff.
- Status extraction: an error carrying `status: 429`, one carrying it on `cause`,
  and one carrying it only in the message — all retried; a message containing
  `429` incidentally with a non-retryable status property is **not** retried.
- A cyclic `cause` chain terminates instead of hanging.
- An aborted signal stops retrying.

`FoundationModelsEmbedder`:

- `maxBatchSize === 250` for a gemini model, and `isBatchSizeLimited` accepts it.
- For a non-gemini model `maxBatchSize === undefined` — asserted as `undefined`,
  not as an absent key, since ES2022 class fields define it (§7) — and
  `isBatchSizeLimited` returns `false`, so the default applies.
- `isBatchSizeLimited` rejects an object whose `maxBatchSize` is `undefined`,
  `0` or fractional — the value-guard requirement from §1.

`vectorizeMcpTools`:

- The summary aggregates across **two** clients rather than reporting the last
  one.
- Client A lists 10 tools and all embed, client B's `listTools()` fails →
  `{ vectorized: 10, total: 10, clientFailures: 1, complete: false }`. This is
  the case that counters alone report as healthy.
- The summary counts correctly on partial embed failure, and exactly one warning
  is emitted instead of N — with the failed names truncated in the message but
  complete in `summary.failed`.

`HealthChecker`: `complete: false` → `degraded` (including the
`vectorized === total` case above); `complete: true` → `healthy`; reporter absent
or returning `undefined` → `healthy` (backward compatibility).

Final gate before merge: a live run against the reporter's 356-tool catalog.

## Delivery

One PR, three commits:

1. `IBatchSizeLimited` + both decorators + `FoundationModelsEmbedder.maxBatchSize`
   + tests.
2. Composition in `resolveEmbedder` + YAML key + threading.
3. `vectorize-mcp-tools` rewrite + `IToolCatalogReporter` + health integration.

Packages touched: `llm-agent`, `llm-agent-rag`, `llm-agent-libs`,
`llm-agent-server-libs`, `sap-aicore-embedder`. Lockstep release; publishing is
the maintainer's step.
