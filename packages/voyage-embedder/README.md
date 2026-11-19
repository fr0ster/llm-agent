# @mcp-abap-adt/voyage-embedder

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Voyage AI text embeddings and reranking for `@mcp-abap-adt/llm-agent` using native `fetch`.

## Exports

- `VoyageEmbedder` implements `IEmbedderBatch` for `/v1/embeddings`.
- `VoyageReranker` implements `IReranker` for `/v1/rerank`.
- `VoyageEmbedderConfig`, `VoyageInputType`, `VoyageRerankerConfig`, and `VoyageRerankOptions` describe their configuration and options.

## Installation

```bash
npm install @mcp-abap-adt/voyage-embedder
```

## Usage

```ts
import { asymmetricEmbedder, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { VoyageEmbedder, VoyageReranker } from '@mcp-abap-adt/voyage-embedder';

const apiKey = process.env.VOYAGE_API_KEY;
if (!apiKey) throw new Error('Set VOYAGE_API_KEY');

const credential = staticApiKey(apiKey);
const config = { credential, model: 'voyage-4' };
const embedder = asymmetricEmbedder({
  document: new VoyageEmbedder({ ...config, inputType: 'document' }),
  query: new VoyageEmbedder({ ...config, inputType: 'query' }),
});
const reranker = new VoyageReranker({ credential, model: 'rerank-3' });

const { vector } = await embedder.embedQuery('Example search');
const ranked = await reranker.rerank('Example search', [
  { text: 'A candidate document', score: 0.5, metadata: {} },
]);
```

Each constructor takes an explicit `model` and an `IApiKeyCredential`. The
credential supplies a fresh key for each request attempt. Both clients accept
`baseURL`, which defaults to `https://api.voyageai.com/v1`. The embedder's
`inputType` defaults to `document`. The reranker maps `relevance_score` onto
each candidate's `score`, sorts all scored candidates in descending order,
and applies `{ topK }` to the merged ranking. SmartServer also accepts a
`VoyageReranker` through its existing reranker plugin hook.

Pass `{ maxInputChars: 0 }` when applying `composeEmbedder` to a directly
constructed Voyage instance so the complete text reaches Voyage. The
configuration-driven factory already sets this option.

## Server configuration

The `llm-agent` CLI includes the provider. For a standalone `llm-agent-rag`
consumer, install the provider, prefetch `voyage` with `prefetchEmbedderFactories`,
then pass `provider: 'voyage'` to `resolveEmbedder` for each role.

```yaml
rag:
  store:
    type: in-memory
  embedder:
    provider: voyage
    model: voyage-4
    credentialRef: VOYAGE
```

With `credentialRef: VOYAGE`, the CLI reads `VOYAGE_API_KEY`. Omitting the ref
uses `RAG_EMBEDDER_API_KEY`. An optional `rag.embedder.url` overrides the base
URL. SmartServer selects document and query modes automatically.

## Requests, retries, and usage

Both endpoints receive `truncation: false`. Embedding batches are split into
requests of up to 1,000 texts and sized using a conservative UTF-8 estimate for
documented model token limits. Voyage's tokenizer determines whether a request
fits, and the adapter subdivides a batch if Voyage reports an aggregate token
violation. A single text that exceeds model context surfaces the API error.
Voyage documents context in tokens, so stores use their `fragmentSizeChars`.

Reranking batches candidates into requests of up to 1,000 documents and uses
the same UTF-8 estimate for the model's aggregate token budget, counting the
query once per document. A candidate above the estimated budget is sent alone.
The adapter subdivides multi-candidate requests that Voyage rejects for size.
If Voyage rejects a single-candidate request, the API error includes the input
index and any metadata ID. Voyage's rerankers score each query-document pair with a
cross-encoder. Scores from the same query and model are comparable across
requests and can be merged directly. See the [Voyage reranker guide](https://docs.voyageai.com/docs/reranker).

HTTP 429 waits according to `Retry-After`, which can be delay-seconds or an HTTP
date. If the header is missing or invalid, the adapter waits two seconds. The
caller can cancel the fetch and the wait with `CallOptions.signal`. Other HTTP
failures carry `status`, `headers`, and `retryAfterSeconds` on a `RagError`.
The raw provider surfaces 5xx responses immediately. `resolveEmbedder` applies
the standard transient retry policy from `llm-agent-rag`.

Both providers accept `usage?: IUsageRecorder`. Call options can override the
recorder. Each physical request records its model and the provider's
`usage.total_tokens` as input tokens. Reranking uses the `rerank` role. See
[Usage Analytics](../../docs/USAGE_ANALYTICS.md) for recorder setup.

See the [embeddings](https://docs.voyageai.com/reference/embeddings-api),
[reranking](https://docs.voyageai.com/reference/reranker-api), and
[error](https://docs.voyageai.com/docs/error-codes) API references.

## License

GNU Lesser General Public License v3.0 only (`LGPL-3.0-only`). See
[`LICENSE`](LICENSE) and [`GPL-3.0.txt`](GPL-3.0.txt).

Copyright © 2025–2026 Oleksii Kyslytsia
