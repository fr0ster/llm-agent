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

```ts
interface SapAiCoreEmbedderConfig {
  model: string;
  resourceGroup?: string;                             // default: 'default'
  scenario?: 'foundation-models' | 'orchestration';   // default: 'foundation-models'
  credentials?: FoundationModelsCredentials;          // foundation-models only; falls back to AICORE_SERVICE_KEY
}
```

### Foundation-models (default)

For tenants where embedding models are deployed under the `foundation-models` scenario:

```ts
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';

const embedder = new SapAiCoreEmbedder({ model: 'gemini-embedding' });
// Auth: process.env.AICORE_SERVICE_KEY (client_credentials flow)
```

### Orchestration

For tenants where the embedding model is deployed under the `orchestration` scenario:

```ts
const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-3-small',
  scenario: 'orchestration',
});
```

## Authentication

For the `foundation-models` scenario (default), authentication uses the `AICORE_SERVICE_KEY` environment variable directly (client credentials flow). You can also pass credentials explicitly via the `credentials` option.

For the `orchestration` scenario, authentication is handled automatically by the SAP AI SDK orchestration client using `AICORE_SERVICE_KEY`.

## License

MIT
