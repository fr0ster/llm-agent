# Embedding throttling and tool-search migration

Tool-search query embeddings can fail immediately on every non-429 error while
waiting indefinitely on HTTP 429. The existing `RetryEmbedder` delegates quota
handling to `runWithThrottleRetry`; no separate embedding retry loop is needed.

```ts
import {
  asymmetricEmbedder,
  CircuitBreaker,
  staticApiKey,
  WaitAsTold,
  withCircuitBreaker,
} from '@mcp-abap-adt/llm-agent';
import { composeEmbedder } from '@mcp-abap-adt/llm-agent-rag';
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import { OllamaEmbedder } from '@mcp-abap-adt/ollama-embedder';

const breaker = new CircuitBreaker({
  failureThreshold: 30,
  recoveryWindowMs: 60_000,
});
const credential = staticApiKey('your-key');
const rawToolSearch = new OpenAiEmbedder({
  model: 'text-embedding-3-small',
  credential,
  retry: false,
  // usage: recorder,
});
// For Ollama, use this instead:
// const rawToolSearch = new OllamaEmbedder({
//   model: 'bge-m3', ollamaUrl: 'http://localhost:11434', retry: false,
// });

const toolSearchEmbedder = withCircuitBreaker(
  composeEmbedder(rawToolSearch, {
    retry: false,
    throttle: {
      key: 'tool-search-embedding:account-endpoint-model-fingerprint',
      strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
    },
    // maxInputChars: 24000, // default; 0 disables the single-input cap
  }),
  breaker,
);

const controller = new AbortController();
const result = await toolSearchEmbedder.embed('find a tool', {
  signal: controller.signal,
});
// controller.abort(reason) cancels provider I/O and quota waits.
```

Use a quota key stable across instances spending the same account/endpoint/model
quota. Do not put credentials in it. The shared gate coordinates concurrent
callers, including waits that another caller extends. Retry-After is a minimum
wait; the existing gate may add wake-up jitter. Without Retry-After, the configured
2000ms base doubles per 429. There is no attempt cap or elapsed-time budget;
long waits use timer slices to avoid Node timer overflow, without shortening the
quota hold. Explicit Retry-After: 0 retries without fallback backoff. The default
`WaitAsTold()` still reports a missing/zero interval, as before.

Both retry settings matter: provider `retry: false` removes the OpenAI/Ollama
internal retries; composition `retry: false` removes ordinary resilience retries.
HTTP 400/5xx, network errors and decoding failures then surface on the first
attempt. All defaults retain their earlier behavior when these options are absent.

The composition keeps the existing single-input character cap (batch inputs are
unchanged), chunking and batch capability. Each retried batch chunk is independent;
completed chunks are not repeated. Usage records retain one operation ID, increasing
outerAttempt and separate providerAttempt coordinates for actual HTTP requests.
`retryAfterSecondsOf`, `parseRetryAfter` and `httpStatusOf` expose the shared transport
readers, including fetch headers and SDK response/cause shapes.

## cloud-llm-hub migration

In `srv/lib/providers.ts`, keep the existing document/general embedder path and its
breaker settings. Change the local provider factory to accept a retry flag and
pass it to the OpenAI/Ollama constructor. Build the tool-search path with a **fresh
raw instance** created with `retry: false`. Do not pass the already composed general
embedder: composition is idempotent and will preserve its original retry policy.

Replace the existing `composeResilientEmbedder(withToolSearchRateLimit(...))` block
with the following (the existing `breaker` is shared with the general path):

```ts
const toolSearch = composeEmbedder(createEmbedder(false), {
  retry: false,
  throttle: {
    key: `tool-search-embedding:${JSON.stringify(embedderFingerprint(cfg))}`,
    strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
  },
});
const toolSearchEmbedder = withCircuitBreaker(toolSearch, breaker);
```

Here `createEmbedder(retry = true)` must pass `retry` into both provider configs;
keep the same model, endpoint, rotating credential and usage recorder settings.
Existing general construction `createEmbedder()` retains provider retries. Keep
`toolSearchRetrieval: asymmetricEmbedder({ document: embedder, query: toolSearchEmbedder })`.

Remove both imports and delete `srv/lib/tool-search-embedder.ts` and
`srv/lib/tool-search-http-embedder.ts`. The core now supplies their quota loop,
header parsing and usage tracking, and the official providers supply their HTTP
requests. The outer breaker sees only the final non-429 failure or success;
waiting 429s and caller cancellation do not increase its failure count.

The inspected hub SAP adapter currently omits signal and middleware options at
both SDK calls (`sap-ai-core-embedder.ts:53` and `:75`). To extend the guarantee
to SAP, replace it with the existing package orchestration backend (below), or
update those calls to forward the signal and set `middleware: []`.

The hub's separate SAP adapter must itself make a single SDK attempt, forward
`CallOptions.signal`, disable SDK retry middleware, and preserve SDK HTTP errors.
The package `sap-aicore-embedder` orchestration backend already does this with
`middleware: []`; its foundation backend currently discards HTTP metadata and is
not covered by this OpenAI/Ollama migration. Neither a composition option nor
throttling can undo retries hidden inside a custom provider.


For the SAP branch of the factory, use the existing published provider with the
same service-key source the hub already uses:

```ts
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

const serviceKey = process.env.AICORE_SERVICE_KEY;
if (!serviceKey) throw new Error('AICORE_SERVICE_KEY is required');
const { credential, apiBaseUrl } = serviceKeyCredential(serviceKey);
const rawSapToolSearch = new SapAiCoreEmbedder({
  model: cfg.model,
  resourceGroup: cfg.resourceGroup,
  credential,
  apiBaseUrl,
  scenario: 'orchestration',
  // usage: recorder,
});
// Pass rawSapToolSearch through the same composition and outer shared breaker.
```
