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
  scenario?: 'foundation-models' | 'orchestration';   // default: 'orchestration'
  credentials?: FoundationModelsCredentials;          // foundation-models only; falls back to AICORE_SERVICE_KEY
}
```

### Orchestration (default)

The default scenario — matches v11.0.0 behavior. Use this when the embedding model is deployed under the `orchestration` scenario. Authentication is handled automatically by the SAP AI SDK orchestration client using `AICORE_SERVICE_KEY`.

```ts
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';

const embedder = new SapAiCoreEmbedder({ model: 'text-embedding-3-small' });
```

Existing v11.0.0 consumers require no config changes.

### Foundation-models

Opt-in path for tenants where embedding models (such as `gemini-embedding` or `text-embedding-3-small`) are deployed under the `foundation-models` scenario rather than the orchestration scenario. The embedder calls the AI Core REST inference API directly.

```ts
const embedder = new SapAiCoreEmbedder({
  model: 'gemini-embedding',
  scenario: 'foundation-models',
});
// Auth: process.env.AICORE_SERVICE_KEY (client_credentials flow)
```

## Authentication

For the `orchestration` scenario (default), authentication is handled automatically by the SAP AI SDK orchestration client using `AICORE_SERVICE_KEY`.

For the `foundation-models` scenario, authentication uses the `AICORE_SERVICE_KEY` environment variable directly (client credentials flow). You can also pass credentials explicitly via the `credentials` option.

## License

MIT
