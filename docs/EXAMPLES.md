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
      type: qdrant
      url: http://qdrant:6333
      embedder: openai             # ollama | openai | <custom registered name>
      model: text-embedding-3-small
      apiKey: ${OPENAI_API_KEY}
    feedback:
      type: in-memory
    state:
      type: in-memory

  mcp:
    - type: http
      url: http://localhost:3001/mcp/stream/http
```

## 4a. Custom embedder injection (programmatic)

```ts
import { SmartServer } from '@mcp-abap-adt/llm-agent/smart-server';

const server = new SmartServer({
  llm: { apiKey: process.env.DEEPSEEK_API_KEY! },
  rag: { type: 'qdrant', url: 'http://qdrant:6333', embedder: 'sap-ai-sdk' },
  mode: 'smart',
  // Register custom embedder factory — referenced in rag.embedder
  embedderFactories: {
    'sap-ai-sdk': (cfg) => new SapAiCoreEmbedder({ model: cfg.model }),
  },
});
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

## 7. Stream test client

A lightweight SSE client for testing the SmartServer streaming endpoint. Displays heartbeat pings and timing breakdowns alongside the streamed response.

**Start the server first** (in a separate terminal):

```bash
npm run dev
```

**Run the test client** with the default prompt:

```bash
npm run client:test-stream
```

**Or pass a custom message:**

```bash
npm run client:test-stream -- "Which MCP tools are available?"
```

The client connects to `http://127.0.0.1:4004/v1/chat/completions` and prints:
- streamed content tokens as they arrive
- `💓 heartbeat` comments (SSE keep-alive)
- `⏱️ timing` comments (MCP tool execution breakdown)
- `✅ Stream finished [DONE]` when the response is complete

Set `PORT` env variable to override the default port:

```bash
PORT=5000 npm run client:test-stream
```

## 8. Connecting OpenAI-compatible clients

SmartServer exposes an OpenAI-compatible API at `http://localhost:4004/v1/chat/completions`, so any client that supports the OpenAI protocol can connect to it as a custom provider.

**Start the server:**

```bash
npm run dev
```

### Goose (Block)

In Goose settings, add a custom provider:

- **Provider**: `OpenAI API Compatible`
- **API Base URL**: `http://localhost:4004/v1`
- **API Key**: any non-empty string (SmartServer has no auth by default)
- **Model**: `smart-agent`

### Continue (VS Code / JetBrains)

In `~/.continue/config.yaml`:

```yaml
models:
  - name: SmartAgent
    provider: openai
    model: smart-agent
    apiBase: http://localhost:4004/v1
    apiKey: dummy
```

### curl

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "smart-agent",
    "stream": true,
    "messages": [{"role": "user", "content": "List available MCP tools"}]
  }'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4004/v1", api_key="dummy")
response = client.chat.completions.create(
    model="smart-agent",
    messages=[{"role": "user", "content": "List available MCP tools"}],
)
print(response.choices[0].message.content)
```

### Available endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completion (JSON or SSE streaming) |
| `/v1/models` | GET | List available models |
| `/v1/health` | GET | Health check |
| `/v1/usage` | GET | Token usage statistics |

### Session management

Pass `X-Session-Id` header to maintain conversation context across requests:

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: my-session" \
  -d '{"model":"smart-agent","messages":[{"role":"user","content":"Hello"}]}'
```

## 9. Current npm scripts

```bash
npm run build
npm run dev
npm run start
npm run test:server
npm run test:all
npm run release:check
```
