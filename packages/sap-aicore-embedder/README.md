# @mcp-abap-adt/sap-aicore-embedder

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

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

#### Batch size cap

`gemini-embedding` routes to Vertex, which rejects a batch of 251 or more
instances. `FoundationModelsEmbedder` therefore declares `maxBatchSize = 250`
for the `gemini` family (`IBatchSizeLimited`), and the embedder chain chunks to
it automatically — no configuration needed.

Other families declare no cap and fall back to the library default (100). No
documented AI Core limit for the OpenAI family has been verified, so none is
asserted. Override either with `rag.maxBatchSize` in YAML when the tenant's real
quota is stricter than the model's documented limit.

## Authentication

For the `orchestration` scenario (default), authentication is handled automatically by the SAP AI SDK orchestration client using `AICORE_SERVICE_KEY`.

For the `foundation-models` scenario, authentication uses the `AICORE_SERVICE_KEY` environment variable directly (client credentials flow). You can also pass credentials explicitly via the `credentials` option.

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
