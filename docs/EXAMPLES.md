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

## 5. Structured pipeline — default stages (YAML)

The structured pipeline replaces the hardcoded agent flow with a YAML-defined stage tree.
When `pipeline.version` and `pipeline.stages` are present, the `PipelineExecutor` walks the tree instead of running the hardcoded sequence.

This example reproduces the default hardcoded flow as explicit YAML — a good starting point for customization:

```yaml
port: 4004
mode: smart

llm:
  apiKey: ${DEEPSEEK_API_KEY}
  model: deepseek-chat

rag:
  type: ollama
  url: http://localhost:11434
  model: nomic-embed-text

mcp:
  type: http
  url: http://localhost:3001/mcp/stream/http

pipeline:
  version: "1"
  stages:
    - id: classify
      type: classify
    - id: summarize
      type: summarize
    - id: rag-upsert
      type: rag-upsert
    - id: rag-retrieval
      type: parallel
      when: "shouldRetrieve"
      stages:
        - { id: translate, type: translate }
        - { id: expand, type: expand }
      after:
        - id: rag-queries
          type: parallel
          stages:
            - { id: facts, type: rag-query, config: { store: facts, k: 10 } }
            - { id: feedback, type: rag-query, config: { store: feedback, k: 5 } }
            - { id: state, type: rag-query, config: { store: state, k: 5 } }
        - { id: rerank, type: rerank }
        - { id: tool-select, type: tool-select }
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
```

## 6. Structured pipeline — minimal (skip RAG)

For simple LLM + tools setups where RAG is not needed:

```yaml
port: 4004
mode: smart

llm:
  apiKey: ${OPENAI_API_KEY}
  model: gpt-4o

mcp:
  type: http
  url: http://localhost:3001/mcp/stream/http

pipeline:
  version: "1"
  stages:
    - id: classify
      type: classify
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
```

## 7. Structured pipeline — multi-model with custom stage

Combine separate LLM models with a custom pipeline stage:

```yaml
port: 4004
mode: smart

pipeline:
  llm:
    main:
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
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
      embedder: openai
      model: text-embedding-3-small
      apiKey: ${OPENAI_API_KEY}
    feedback:
      type: in-memory
    state:
      type: in-memory

  mcp:
    - type: http
      url: http://localhost:3001/mcp/stream/http

  version: "1"
  stages:
    - id: classify
      type: classify
    - id: summarize
      type: summarize
    - id: rag-retrieval
      type: parallel
      when: "shouldRetrieve"
      stages:
        - { id: translate, type: translate }
        - { id: expand, type: expand }
      after:
        - id: rag-queries
          type: parallel
          stages:
            - { id: facts, type: rag-query, config: { store: facts, k: 15 } }
            - { id: feedback, type: rag-query, config: { store: feedback, k: 5 } }
        - { id: rerank, type: rerank }
        - { id: tool-select, type: tool-select }
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
      config: { maxIterations: 15, maxToolCalls: 50 }
```

### Registering a custom stage handler (programmatic)

```ts
import { SmartServer } from '@mcp-abap-adt/llm-agent/smart-server';
import type { IStageHandler, PipelineContext, ISpan } from '@mcp-abap-adt/llm-agent';

class AuditLogHandler implements IStageHandler {
  async execute(ctx: PipelineContext, config: Record<string, unknown>, span: ISpan): Promise<boolean> {
    const level = (config.level as string) ?? 'info';
    console.log(`[${level}] Processing: ${ctx.inputText.slice(0, 100)}`);
    return true;
  }
}

const server = new SmartServer({
  configPath: 'smart-server.yaml',
  stageHandlers: { 'audit-log': new AuditLogHandler() },
});
```

Then in YAML, insert the custom stage anywhere in the tree:

```yaml
pipeline:
  version: "1"
  stages:
    - id: audit
      type: audit-log
      config: { level: info }
    - id: classify
      type: classify
    # ... rest of stages
```

## 8. Simple vs structured pipeline — comparison

| Feature | Simple (flat YAML) | Structured pipeline |
|---|---|---|
| Config location | `llm:`, `rag:`, `mcp:`, `agent:` top-level keys | `pipeline:` section with `version` + `stages` |
| Orchestration flow | Hardcoded in `SmartAgent.streamProcess()` | YAML-defined stage tree |
| Stage ordering | Fixed | Fully customizable |
| Parallel stages | Fixed internal parallelism | Explicit `parallel` type with `after` |
| Custom stages | Not possible | `withStageHandler()` + YAML reference |
| Conditional stages | `agent.ragRetrievalMode`, `agent.classificationEnabled` | `when` expressions on any stage |
| Loops | Fixed tool loop | `repeat` type with `until` + `maxIterations` |
| Best for | Simple setups, quick start | Complex orchestration, custom pipelines |

**Without `pipeline.stages`** — the hardcoded flow runs unchanged. No migration needed.

**With `pipeline.stages`** — the executor replaces the hardcoded flow entirely.

## 9. External tools validation mode

```yaml
agent:
  externalToolsValidationMode: strict
```

`strict`: reject invalid `tools` payload with `400 invalid_request_error`.
`permissive` (default): drop invalid tools and continue.

## 10. Test doubles for consumer integration tests

```ts
import { makeLlm, makeMcpClient, makeRag } from '@mcp-abap-adt/llm-agent/testing';

const llm = makeLlm([{ content: 'ok' }]);
const rag = makeRag();
const mcp = makeMcpClient([{ name: 'Ping', description: 'health', inputSchema: { type: 'object', properties: {} } }]);
```

## 11. Stream test client

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

## 12. Connecting OpenAI-compatible clients

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

## 13. Current npm scripts

```bash
npm run build
npm run dev
npm run start
npm run test:server
npm run test:all
npm run release:check
```
