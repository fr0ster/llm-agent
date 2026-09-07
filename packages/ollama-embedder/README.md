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
  model: 'bge-m3',
});

const result = await embedder.embed('Hello world');
console.log(result.vector);

// Convenience RAG wrapper
const rag = new OllamaRag({
  ollamaUrl: 'http://localhost:11434',
  model: 'bge-m3',
});

const searchResults = await rag.query('What is Ollama?', documents);
console.log(searchResults);
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
