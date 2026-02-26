# Examples

This document contains usage examples aligned with the current Smart Agent implementation.

## 1. Minimal local start (DeepSeek + in-memory RAG)

```yaml
# smart-server.yaml
port: 4004
host: 0.0.0.0
mode: smart

llm:
  apiKey: ${DEEPSEEK_API_KEY}
  model: deepseek-chat
  temperature: 0.7

rag:
  type: in-memory
```

```bash
DEEPSEEK_API_KEY=sk-xxx npm run dev
```

OpenAI-compatible endpoint: `http://localhost:4004/v1/chat/completions`

## 2. Smart mode with Ollama embeddings and MCP

```yaml
port: 4004
host: 0.0.0.0
mode: smart

llm:
  apiKey: ${DEEPSEEK_API_KEY}
  model: deepseek-chat

rag:
  type: ollama
  url: http://localhost:11434
  model: nomic-embed-text
  dedupThreshold: 0.92

mcp:
  type: http
  url: http://localhost:3001/mcp/stream/http

agent:
  maxIterations: 10
  maxToolCalls: 30
  ragQueryK: 10
```

```bash
npm run dev -- --config smart-server.yaml
```

## 3. Programmatic embedding (`SmartServer`)

```ts
import { SmartServer } from '@mcp-abap-adt/llm-agent/smart-server';

const server = new SmartServer({
  port: 4004,
  mode: 'smart',
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: 'deepseek-chat',
    temperature: 0.7,
  },
  rag: { type: 'in-memory' },
});

const handle = await server.start();
console.log(`Listening on ${handle.port}`);

process.on('SIGTERM', async () => {
  await handle.close();
});
```

## 4. Pipeline with separate classifier/helper models

```yaml
port: 4004
host: 0.0.0.0
mode: smart

pipeline:
  llm:
    main:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.7
    classifier:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.1
    helper:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.1

  rag:
    facts:
      type: ollama
      url: http://localhost:11434
      model: nomic-embed-text
    feedback:
      type: in-memory
    state:
      type: in-memory

  mcp:
    - type: http
      url: http://localhost:3001/mcp/stream/http
```

## 5. External tools validation mode

```yaml
agent:
  externalToolsValidationMode: strict
```

`strict`: reject invalid `tools` payload with `400 invalid_request_error`.
`permissive` (default): drop invalid tools and continue.

## 6. Test doubles for consumer integration tests

```ts
import { makeLlm, makeMcpClient, makeRag } from '@mcp-abap-adt/llm-agent/testing';

const llm = makeLlm([{ content: 'ok' }]);
const rag = makeRag();
const mcp = makeMcpClient([{ name: 'Ping', description: 'health', inputSchema: { type: 'object', properties: {} } }]);
```

## 7. Current npm scripts

```bash
npm run build
npm run dev
npm run start
npm run test:server
npm run test:all
npm run release:check
```
