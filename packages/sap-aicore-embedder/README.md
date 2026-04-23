# @mcp-abap-adt/sap-aicore-embedder

SAP AI Core embedding provider (IEmbedderBatch) for @mcp-abap-adt/llm-agent.

Generates text embeddings via SAP AI Core embedding model deployments using the @sap-ai-sdk/orchestration client.

## Installation

```bash
npm install @mcp-abap-adt/sap-aicore-embedder
```

## Usage

```typescript
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';

const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-3-small',
  resourceGroup: 'default', // optional
});

// Embed a single text
const result = await embedder.embed('Hello, world!');
console.log(result.vector);

// Batch embed multiple texts
const results = await embedder.embedBatch(['Text 1', 'Text 2', 'Text 3']);
console.log(results.map(r => r.vector));
```

## Configuration

### SapAiCoreEmbedderConfig

- `model` (required): Embedding model name (e.g., 'text-embedding-3-small')
- `resourceGroup` (optional): SAP AI Core resource group

## Authentication

Authentication uses the `AICORE_SERVICE_KEY` environment variable, which is read automatically by the SAP AI SDK orchestration client.

## License

MIT
