# @mcp-abap-adt/ollama-embedder

Ollama embedding provider for @mcp-abap-adt/llm-agent. Implements `IEmbedderBatch`; uses native `fetch`.

## Exports

- `OllamaEmbedder` — implements IEmbedderBatch, calls Ollama /api/embeddings and /api/embed (batch).
- `OllamaRag` — convenience wrapper combining OllamaEmbedder with VectorRag.
- `OllamaEmbedderConfig` — configuration type.

## Installation

```bash
npm install @mcp-abap-adt/ollama-embedder
```

## Usage

```ts
import { OllamaEmbedder, OllamaRag } from '@mcp-abap-adt/ollama-embedder';

// Direct embedder usage
const embedder = new OllamaEmbedder({
  ollamaUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});

const result = await embedder.embed('Hello world');
console.log(result.vector);

// Convenience RAG wrapper
const rag = new OllamaRag({
  ollamaUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});

const searchResults = await rag.query('What is Ollama?', documents);
console.log(searchResults);
```

Optional peer dependency of @mcp-abap-adt/llm-agent-rag.
