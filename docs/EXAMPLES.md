# Examples

This document contains usage examples aligned with the current Smart Agent implementation.
YAML config examples are in [`docs/examples/`](examples/) as standalone files you can use directly.

## How the Agent Works

Understanding the data flow helps choose the right config. See [`08-real-world-scenario.yaml`](examples/08-real-world-scenario.yaml) for a fully commented example.

```
STARTUP
  MCP server(s) connected
  → each tool's name + description + schema vectorized into facts RAG store
  → metadata: { id: "tool:TOOL_NAME" }

PER REQUEST
  User message
    ↓
  Classify → split into typed subprompts:
    action:   "read table T100"             → drives the tool loop
    fact:     "T100 stores error messages"   → saved to facts RAG
    feedback: "always use SE16N for this"    → saved to feedback RAG
    state:    "working on package Z01"       → saved to state RAG
    chat:     "thanks!"                      → just reply
    ↓
  RAG Upsert → fact/feedback/state subprompts saved to RAG (agent "memory")
    ↓
  RAG Retrieval (parallel, if relevant context needed):
    ├─ translate query to English (for non-ASCII input)
    ├─ expand query with synonyms
    ├─ query facts   → MCP tool descriptions + saved domain knowledge
    ├─ query feedback → user preferences ("use SE16N for tables")
    └─ query state   → session context ("working on package Z01")
    ↓
  Rerank → re-score RAG results by relevance
    ↓
  Tool Select → extract tool:XXX IDs from facts → select matching MCP tools
    ↓
  Assemble → build LLM context: actions + facts + feedback + state + tools + history
    ↓
  Tool Loop → streaming LLM call → execute MCP tools → loop until done
```

## YAML Config Examples

### Simple (flat) configs — hardcoded orchestration flow

| File | Description |
|---|---|
| [`01-minimal-inmemory.yaml`](examples/01-minimal-inmemory.yaml) | Minimal start — DeepSeek + in-memory RAG, no MCP |
| [`02-ollama-mcp.yaml`](examples/02-ollama-mcp.yaml) | Ollama embeddings + MCP tools |
| [`03-multi-model.yaml`](examples/03-multi-model.yaml) | Separate classifier/helper models + Qdrant RAG |

### Structured pipeline configs — YAML-defined stage tree

| File | Description |
|---|---|
| [`04-structured-default.yaml`](examples/04-structured-default.yaml) | Default flow as explicit YAML (good starting point) |
| [`05-structured-minimal.yaml`](examples/05-structured-minimal.yaml) | Minimal pipeline — no RAG, just classify + assemble + tool-loop |
| [`06-structured-multi-model.yaml`](examples/06-structured-multi-model.yaml) | Multi-model + Qdrant + higher tool limits |
| [`07-structured-sap-ai-core.yaml`](examples/07-structured-sap-ai-core.yaml) | SAP AI Core provider with structured pipeline |
| [`08-real-world-scenario.yaml`](examples/08-real-world-scenario.yaml) | **Full real-world scenario** with detailed comments explaining how tool vectorization, classification, RAG memory, and tool selection work together |
| [`09-parallel-optimized.yaml`](examples/09-parallel-optimized.yaml) | **Parallel-optimized** — maximizes concurrency (summarize ‖ rag-upsert, translate ‖ expand, 3× rag-query) |

### Running a YAML config

```bash
# Set required env variables, then:
npm run dev -- --config docs/examples/04-structured-default.yaml
```

OpenAI-compatible endpoint: `http://localhost:4004/v1/chat/completions`

## Simple vs structured pipeline — comparison

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

## Programmatic Examples

### Programmatic embedding (`SmartServer`)

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

### Custom embedder injection

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

### Structured pipeline with custom stage handler

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

Then reference in YAML (see [`04-structured-default.yaml`](examples/04-structured-default.yaml) and add):

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

### Programmatic pipeline with `getDefaultStages()`

```ts
import { SmartAgentBuilder, getDefaultStages } from '@mcp-abap-adt/llm-agent';

// Get default stages and insert a custom stage before tool-loop
const stages = getDefaultStages();
const toolLoopIndex = stages.findIndex(s => s.id === 'tool-loop');
stages.splice(toolLoopIndex, 0, {
  id: 'audit',
  type: 'audit-log',
  config: { level: 'info' },
});

builder.withPipeline({ version: '1', stages });
```

## External tools validation mode

```yaml
agent:
  externalToolsValidationMode: strict
```

`strict`: reject invalid `tools` payload with `400 invalid_request_error`.
`permissive` (default): drop invalid tools and continue.

## Test doubles for consumer integration tests

```ts
import { makeLlm, makeMcpClient, makeRag } from '@mcp-abap-adt/llm-agent/testing';

const llm = makeLlm([{ content: 'ok' }]);
const rag = makeRag();
const mcp = makeMcpClient([{ name: 'Ping', description: 'health', inputSchema: { type: 'object', properties: {} } }]);
```

## Stream test client

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
- heartbeat comments (SSE keep-alive)
- timing comments (MCP tool execution breakdown)
- stream finished when the response is complete

Set `PORT` env variable to override the default port:

```bash
PORT=5000 npm run client:test-stream
```

## Connecting OpenAI-compatible clients

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

## Current npm scripts

```bash
npm run build
npm run dev
npm run start
npm run test:server
npm run test:all
npm run release:check
```
