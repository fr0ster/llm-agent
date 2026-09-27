# @mcp-abap-adt/llm-agent-rag

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

RAG and embedder composition for the SmartAgent runtime.

## Exports

- `makeRag(cfg: RagResolution, options?: RagResolutionOptions): Promise<IRag>` — async,
  dynamic-imports the configured backend, typed per target (`type` discriminates the union).
- `resolveEmbedder(cfg: EmbedderResolution, options?: EmbedderResolutionOptions): IEmbedder` —
  synchronous, requires prior `prefetchEmbedderFactories(...)`; discriminated by `provider`.
- `composeEmbedder(embedder, options?)` — wraps an embedder a consumer already holds with the same
  chunking/retry/resilience `resolveEmbedder` composes for a built-in one.
- `prefetchEmbedderFactories(names): Promise<void>`, `prefetchRagFactories(names): Promise<void>` —
  warm-up helpers; each caches the named backends' dynamic imports for later synchronous use.
- `ragBackendNames` — the list of store type names `makeRag` recognises.
- Types: `RagResolution`, `RagResolutionOptions`, `EmbedderResolution`, `EmbedderResolutionOptions`.

A leftover `apiKey`/`user`/`password` from an untyped source (a loaded YAML object) is refused at
resolution, naming the target — these functions carry no secret of their own.

## Two patterns

### Common case (one-shot async resolution)

```ts
import { makeRag } from '@mcp-abap-adt/llm-agent-rag';
const rag = await makeRag(
  { type: 'in-memory', embedder: yourEmbedder },
  { breaker: yourBreaker },
);
```

### Hot-path consumers (prefetch once, then resolve)

```ts
import { prefetchRagFactories, makeRag } from '@mcp-abap-adt/llm-agent-rag';

// At startup:
await prefetchRagFactories(['qdrant']);

// Inside a hot loop — the ES loader caches, so this call costs nothing further:
const rag = await makeRag({ type: 'qdrant', embedder, collectionName, url }, { breaker });
```

## Optional peer dependencies

Install only the backends you use:

| Backend | Package |
|---|---|
| OpenAI embeddings | `@mcp-abap-adt/openai-embedder` |
| Ollama embeddings | `@mcp-abap-adt/ollama-embedder` |
| SAP AI Core embeddings | `@mcp-abap-adt/sap-aicore-embedder` |
| Qdrant vector store | `@mcp-abap-adt/qdrant-rag` |
| HANA vector store | `@mcp-abap-adt/hana-vector-rag` |
| Postgres+pgvector | `@mcp-abap-adt/pg-vector-rag` |

Missing backends throw `MissingProviderError` (from `@mcp-abap-adt/llm-agent`) at first use.

See `docs/ARCHITECTURE.md` for the full SmartAgent package layout.

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
