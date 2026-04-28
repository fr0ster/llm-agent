# Quick Start Guide

## Overview

`llm-agent` is an OpenAI-compatible HTTP server backed by **SmartAgent** — an orchestrated agent
with RAG-based tool selection, multi-turn semantic memory, and MCP tool execution. Connect any
OpenAI-compatible client (Cline, Cursor, Continue) to it and use it as a drop-in AI backend.

---

## Install

```bash
npm install -g @mcp-abap-adt/llm-agent-server
```

Or run from source:

```bash
git clone <repo> && cd llm-agent
npm install && npm run build
npx llm-agent          # uses packages/llm-agent-server/dist/smart-agent/cli.js
```

---

## First Run

Run `llm-agent` in any directory:

```bash
llm-agent
```

On the very first run (no `smart-server.yaml` in the current directory) it generates a config
template and exits:

```
No config file found. Created smart-server.yaml with defaults.
Put your API keys in .env, adjust settings in smart-server.yaml, then run llm-agent again.
```

---

## 1. Configure Secrets — `.env`

Create `.env` in the same directory as `smart-server.yaml`:

```dotenv
# Primary LLM (DeepSeek by default)
DEEPSEEK_API_KEY=sk-your-deepseek-key

# Optional — needed only if you use pipeline.llm with these providers
# OPENAI_API_KEY=sk-your-openai-key
# ANTHROPIC_API_KEY=sk-ant-your-anthropic-key

# Optional — override Ollama URL (default: http://localhost:11434)
# OLLAMA_URL=http://localhost:11434
```

**Secrets go in `.env`, settings go in `smart-server.yaml`.** The YAML resolves `${VAR}` references
from `.env` at startup.

---

## 2. Configure Settings — `smart-server.yaml`

Minimal working config (generated template contains all fields with comments):

```yaml
port: 3001
mode: hybrid      # smart | passthrough | hybrid (default)

llm:
  apiKey: ${DEEPSEEK_API_KEY}
  model: deepseek-chat
  temperature: 0.7

rag:
  type: ollama            # ollama (neural) | in-memory (keyword, no Ollama required)
  url: http://localhost:11434
  model: nomic-embed-text

mcp:
  type: http
  url: http://localhost:3000/mcp/stream/http

agent:
  maxIterations: 10
  maxToolCalls: 30
  ragQueryK: 10

log: smart-server.log     # omit for stdout
```

> **No Ollama?** Set `rag.type: in-memory` — tool selection uses keyword matching instead of
> neural embeddings. Everything else works identically.

---

## 3. Start

```bash
llm-agent
```

```
llm-agent listening on http://0.0.0.0:3001
logs → smart-server.log
```

---

## 4. Connect Your IDE

Add as an OpenAI-compatible provider in Cline / Cursor / Continue:

| Setting  | Value                         |
|----------|-------------------------------|
| Base URL | `http://localhost:3001/v1`    |
| Model    | `smart-agent` (any name)      |
| API Key  | any non-empty string          |

Endpoints exposed by the server:

| Endpoint                    | Description                           |
|-----------------------------|---------------------------------------|
| `POST /v1/chat/completions` | Main endpoint (streaming + non-streaming) |
| `GET  /v1/models`           | Returns `smart-agent` model entry; supports `?exclude_embedding=true` to omit embedding models |
| `GET  /v1/embedding-models` | List available embedding models (best-effort) |
| `GET  /v1/config`           | Active runtime configuration          |
| `PUT  /v1/config`           | Partial runtime reconfiguration       |
| `GET  /v1/usage`            | Accumulated LLM token usage stats     |

---

## Request Routing Modes

| Mode          | Behaviour                                                                 |
|---------------|---------------------------------------------------------------------------|
| `smart`       | All requests → SmartAgent (RAG tool selection + MCP orchestration)        |
| `passthrough` | All requests → LLM directly (no agent; preserves Cline XML tool protocol) |
| `hybrid`      | Auto-detect: Cline system prompt → passthrough, everything else → smart   |

---

## CLI Reference

All YAML settings can be overridden with flags:

```bash
llm-agent --port 3002 --llm-api-key sk-xxx --rag-type in-memory --mode smart
```

| Flag                      | Description                                      |
|---------------------------|--------------------------------------------------|
| `--config <path>`         | YAML config file (default: `smart-server.yaml`)  |
| `--env <path>`            | `.env` file (default: `.env` in cwd)             |
| `--port <n>`              | HTTP port                                        |
| `--host <addr>`           | Bind address                                     |
| `--llm-api-key <key>`     | LLM API key                                      |
| `--llm-model <model>`     | LLM model name                                   |
| `--llm-temperature <n>`   | Temperature (0–2)                                |
| `--rag-type <type>`       | `ollama` or `in-memory`                          |
| `--rag-url <url>`         | Ollama base URL                                  |
| `--mcp-url <url>`         | MCP HTTP endpoint                                |
| `--mcp-command <cmd>`     | MCP stdio command                                |
| `--mode <mode>`           | `smart`, `passthrough`, or `hybrid`              |
| `--prompt-system <text>`  | System preamble for the agent                    |
| `--log-file <path>`       | Log file path                                    |
| `--log-stdout`            | Log to stdout instead of file                    |
| `--help`                  | Show full help                                   |

Generate a config template without starting the server:

```bash
llm-agent --config /path/to/my-config.yaml   # creates template if file is absent
```

---

## Advanced: Pipeline Configuration

For multi-LLM setups, per-store RAG, or multiple MCP servers, add a `pipeline:` section to
`smart-server.yaml`. It overrides only the components you specify; everything else falls back to the
flat config above.

```yaml
pipeline:
  llm:
    main:
      provider: deepseek        # deepseek | openai | anthropic
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.7
    classifier:                 # cheaper model for intent classification
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
      temperature: 0.1

  rag:
    tools:
      type: ollama              # neural embeddings for tool/skill selection
    history:
      type: in-memory           # semantic conversation history (optional)

  mcp:
    - type: http
      url: http://sap-server:3000/mcp/stream/http
    - type: stdio
      command: npx
      args: [github-mcp-server]
```

When `pipeline.llm.main` is set, the flat `llm:` block is used only as a fallback for
anything the pipeline does not explicitly configure.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full pipeline and programmatic API reference.

---

### Dynamic RAG collections (v9.1+)

Let the LLM create temporary collections scoped to a session:

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { InMemoryRagProvider } from '@mcp-abap-adt/llm-agent';

const { agent } = await new SmartAgentBuilder({ /* ... */ })
  .withMainLlm(myLlm)
  .addRagProvider(new InMemoryRagProvider({ name: 'scratch' }))
  .build();

// LLM can call rag_create_collection via MCP:
//   rag_create_collection({ provider: 'scratch', name: 'phase-results', scope: 'session' })
// Later:
await agent.closeSession('session-id');  // clears all session-scoped collections
```

See [docs/INTEGRATION.md#iragprovider](INTEGRATION.md#iragprovider) for full provider setup,
scope semantics, and the MCP tool factory.

---

## Troubleshooting

### "LLM API key is required"
Set `DEEPSEEK_API_KEY` in `.env`, or `llm.apiKey` in `smart-server.yaml`, or `pipeline.llm.main.apiKey`.

### Ollama embed errors
Run Ollama locally and pull the model:
```bash
ollama pull nomic-embed-text
```
Or switch to `rag.type: in-memory` to skip Ollama entirely.

### Cannot connect to MCP server
Verify the endpoint is reachable and the MCP server is running. The agent continues without tools
if an MCP connection fails (it logs the error and proceeds).

### Cline not using the agent
`hybrid` mode auto-detects Cline and routes it to `passthrough`. To force SmartAgent for all
clients set `mode: smart`.

---

## Legacy: Thin Proxy CLI (dev / testing)

The original single-turn CLI is still available for quick LLM + MCP testing without the full server:

```bash
# LLM only
DEEPSEEK_API_KEY=sk-xxx npm run dev:llm

# LLM + MCP (single-turn, no SmartAgent)
DEEPSEEK_API_KEY=sk-xxx MCP_ENDPOINT=http://localhost:4004/mcp/stream/http npm run dev
```
