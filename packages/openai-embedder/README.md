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

```ts
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';

const embedder = new OpenAiEmbedder({
  credential: staticApiKey('sk-...'),
  model: 'text-embedding-3-small',
});

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
Records describe physical requests inside retry/chunk loops, with a shared
`operationId`, unique `physicalSeq`, attempt coordinates and embedding
`chunkPath`. Token totals are the exact provider values for each request,
or marked unknown when unavailable. No prompt, document, argument, result or
credential content is recorded.

Use the buffered recorder from `@mcp-abap-adt/llm-usage`, or supply your own
`IUsageRecorder`. See the [usage overview](../../docs/USAGE_ANALYTICS.md) for
injection, replaceable transports/sinks and delivery/loss semantics.

## Retry policy and HTTP errors

`retry?: boolean` defaults to `true`, retaining three provider attempts with the
existing backoff. Set `retry: false` for a single provider attempt in both
`embed` and `embedBatch`, including network, HTTP and response decoding failures.
No provider timeout is installed; the caller's `CallOptions.signal` governs cancellation.

HTTP errors remain `RagError` instances and now carry `status: number`,
`headers: Headers` and `retryAfterSeconds?: number`. Retry-After is parsed by the
same helper as LLM throttling: delay-seconds (including zero) or an HTTP-date;
missing/invalid values are undefined. Network errors are rethrown unchanged
when retry is disabled.

For unlimited 429 waits with every other retry disabled, construct this provider
with `retry: false`, then use `composeResilientEmbedder` with `retry: false` and
`throttle: { key, strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }) }`.
See [the composition and hub migration guide](../../docs/EMBEDDER_THROTTLING.md).
