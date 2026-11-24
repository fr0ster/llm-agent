# @mcp-abap-adt/openai-embedder

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

OpenAI embedding provider for @mcp-abap-adt/llm-agent. Implements `IEmbedderBatch`; uses native `fetch`.

## Exports

- `OpenAiEmbedder` — implements IEmbedderBatch, calls OpenAI /v1/embeddings.
- `OpenAiEmbedderConfig` — configuration type.

## Installation

```bash
npm install @mcp-abap-adt/openai-embedder
```

## Usage

Install `@mcp-abap-adt/llm-agent-rag` as well for the `composeEmbedder` helper
used below, or use core's `composeResilientEmbedder` with no additional package.

```ts
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { composeEmbedder } from '@mcp-abap-adt/llm-agent-rag';

const embedder = composeEmbedder(new OpenAiEmbedder({
  credential: staticApiKey('sk-...'),
  model: 'text-embedding-3-small',
}));

const result = await embedder.embed('Hello world');
console.log(result.vector);
```

Optional peer dependency of @mcp-abap-adt/llm-agent-rag.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).

## Usage analytics

Provider configuration accepts `usage?: IUsageRecorder` from
`@mcp-abap-adt/llm-agent`. A call's `{ usage }` overrides the bound recorder;
without either, collection is a no-op. Library adapters forward these options.
Records describe each physical request made by the provider, with a shared
`operationId`, unique `physicalSeq`, attempt coordinates and embedding
`chunkPath`. Token totals are the exact provider values for each request,
or marked unknown when unavailable. No prompt, document, argument, result or
credential content is recorded.

Use the buffered recorder from `@mcp-abap-adt/llm-usage`, or supply your own
`IUsageRecorder`. See the [usage overview](../../docs/USAGE_ANALYTICS.md) for
injection, replaceable transports/sinks and delivery/loss semantics.

## Retry policy and HTTP errors

Each `embed` call and each non-empty `embedBatch` call makes exactly one HTTP
request. Empty batches return without I/O.
Provider-internal retry loops and the constructor `retry` option have been removed
in this major release. Network and decoding errors are rethrown unchanged.
The caller's `CallOptions.signal` governs cancellation.

For retries, wrap the raw provider with `composeEmbedder` from
`@mcp-abap-adt/llm-agent-rag` (or `composeResilientEmbedder` from core).
The composition owns retry policy and batch chunking; defaults retry transient
429/500/502/503 failures up to three times with exponential backoff.
`resolveEmbedder` and the server's resolution paths already apply this composition.

HTTP errors remain `RagError` instances and carry `status: number`,
`headers: Headers` and `retryAfterSeconds?: number`. Retry-After uses the shared
LLM parser: delay-seconds (including zero) or an HTTP-date; missing/invalid
values are undefined.

For unlimited 429 waits with every other retry disabled, compose the raw provider
with `retry: false` and
`throttle: { key, strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }) }`.
See [the composition and hub migration guide](../../docs/EMBEDDER_THROTTLING.md).

OpenAI batch chunking now belongs to composition. The provider declares
`maxBatchSize: 100`; composition uses it by default and retries only the failing
chunk. Direct `embedBatch` submits the supplied inputs in one request.
