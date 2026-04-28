# @mcp-abap-adt/openai-embedder

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

const embedder = new OpenAiEmbedder({
  apiKey: 'sk-...',
  model: 'text-embedding-3-small',
});

const result = await embedder.embed('Hello world');
console.log(result.vector);
```

Optional peer dependency of @mcp-abap-adt/llm-agent-rag.
