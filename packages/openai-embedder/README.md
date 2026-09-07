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

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`COPYING`](COPYING) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Importing this package, or running it behind an HTTP endpoint, does not place
your program under the LGPL — the licence asks that modifications *to this
library* stay free and that your users can substitute their own build.
Versions up to and including v20.9.5 were MIT and stay MIT; the change is not
retroactive. Full detail, including what to do if you redistribute:
[docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
