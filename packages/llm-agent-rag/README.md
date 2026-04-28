# @mcp-abap-adt/llm-agent-rag

RAG and embedder composition for the SmartAgent runtime.

## Exports

- `makeRag(cfg, options): Promise<IRag>` — async, dynamic-imports the configured backend (e.g. `OllamaRag`).
- `resolveEmbedder(cfg, options): IEmbedder` — synchronous, requires prior `prefetchEmbedderFactories(...)`.
- `prefetchEmbedderFactories(names): Promise<void>`, `prefetchRagFactories(names): Promise<void>` — warm-up helpers.
- `resolvePrefetchedEmbedder(name, opts)`, `resolveRag(name, opts)` — synchronous resolvers from the prefetched cache.
- `builtInEmbedderFactories` — registry record of built-in embedder factories.
- Types: `RagResolutionConfig`, `RagResolutionOptions`, `EmbedderResolutionConfig`, `EmbedderResolutionOptions`, `EmbedderFactoryOpts`.

## Two patterns

### Common case (one-shot async resolution)

```ts
import { makeRag } from '@mcp-abap-adt/llm-agent-rag';
const rag = await makeRag(
  { type: 'ollama', model: 'llama3', /* ... */ },
  { embedder: yourEmbedder, breaker: yourBreaker },
);
```

### Hot-path consumers (prefetch once, sync resolve)

```ts
import {
  prefetchEmbedderFactories,
  prefetchRagFactories,
  resolveRag,
} from '@mcp-abap-adt/llm-agent-rag';

await prefetchEmbedderFactories(['openai']);
await prefetchRagFactories(['qdrant']);

// Inside a hot loop:
const rag = resolveRag('qdrant', { embedder, breaker, /* ... */ });
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
