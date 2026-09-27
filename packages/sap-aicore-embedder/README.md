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
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY!);

const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-3-small',
  resourceGroup: 'default', // optional
  credential,
  apiBaseUrl,
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
  credential: IBearerCredential;                       // required, both scenarios — resolved fresh per call
  apiBaseUrl: string;                                  // required, both scenarios
}
```

`credential` and `apiBaseUrl` are required for both scenarios and are never
read from the environment inside this package. Build them from a raw SAP AI
Core service key with `serviceKeyCredential` from `@mcp-abap-adt/sap-aicore-auth`
— see [Authentication](#authentication) below. `IBearerCredential` comes from
`@mcp-abap-adt/interfaces-auth`.

### Orchestration (default)

The default scenario — matches v11.0.0 behavior. Use this when the embedding model is deployed under the `orchestration` scenario.

```ts
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-3-small',
  ...serviceKeyCredential(process.env.AICORE_SERVICE_KEY!),
});
```

### Foundation-models

Opt-in path for tenants where embedding models (such as `gemini-embedding` or `text-embedding-3-small`) are deployed under the `foundation-models` scenario rather than the orchestration scenario. The embedder calls the AI Core REST inference API directly.

```ts
const embedder = new SapAiCoreEmbedder({
  model: 'gemini-embedding',
  scenario: 'foundation-models',
  ...serviceKeyCredential(process.env.AICORE_SERVICE_KEY!),
});
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

Neither scenario reads an environment variable inside this package — the
caller resolves the credential and passes it in. `serviceKeyCredential(raw)`
(`@mcp-abap-adt/sap-aicore-auth`) turns a raw SAP AI Core service-key JSON
string into the `{ credential, apiBaseUrl }` pair both scenarios need:

```ts
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY!);
```

`credential.token()` is asked fresh on every `embed()`/`embedBatch()` call —
never cached on the embedder instance — so a rotating token keeps rotating.
Reading `AICORE_SERVICE_KEY` (or any other environment variable) is the
composition root's job, not this package's.

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
