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
# Primary LLM (DeepSeek by default) — the LLM ref's default variable
LLM_API_KEY=sk-your-deepseek-key

# Optional — override Ollama URL (default: http://localhost:11434)
# OLLAMA_URL=http://localhost:11434
```

**Secrets go in `.env`.** The YAML names accounts with `credentialRef:` and never holds a secret; the
server reads `<REF>_API_KEY` (or `<REF>_SERVICE_KEY`) for each ref, and `LLM_API_KEY` when an `llm:`
entry names none ([mapping](../packages/llm-agent-server/README.md#credentials)). `${VAR}` still
works for non-secret settings such as URLs and model names.

---

## 2. Configure Settings — `smart-server.yaml`

Minimal working config (generated template contains all fields with comments):

```yaml
port: 3001
mode: smart       # hard | pass | smart (default: smart)

llm:
  provider: deepseek      # deepseek | openai | anthropic | sap-ai-sdk | ollama
  # credentialRef omitted: reads LLM_API_KEY
  model: deepseek-chat
  temperature: 0.7

rag:
  store:
    type: in-memory         # in-memory | qdrant | hana-vector | pg-vector
  embedder:
    provider: ollama        # ollama | openai | sap-ai-core (omit embedder for BM25 keyword-only)
    url: http://localhost:11434
    model: bge-m3

mcp:
  type: http
  url: http://localhost:3000/mcp/stream/http

agent:
  maxIterations: 10
  maxToolCalls: 30
  ragQueryK: 10

log: smart-server.log     # omit for stdout
```

> **Tool selection strategy:** By default, the agent exposes the K nearest tools by semantic distance (`top-k`, K = `agent.ragQueryK`). To make off-topic queries surface no tools at all, switch to `threshold` mode with a cosine-score cutoff: add `agent.toolSelection: { strategy: threshold, minScore: 0.4 }` to your config. See [docs/PERFORMANCE.md](PERFORMANCE.md#tool-selection-semantic-distance) for calibration guidance.

> **`llm.provider` is required.** Supported values: `deepseek`, `openai`, `anthropic`, `sap-ai-sdk`, `ollama`. The `ollama` provider needs no API key and defaults to `http://localhost:11434/v1`. To run fully locally (Ollama for both LLM and embeddings, no API keys), see `examples/docker-ollama/`.

> **`rag.model` is required when an embedder is used.** There is no default — `model` must be set explicitly. The shipped examples use `bge-m3` (multilingual, 1024 dimensions, covers English and non-English corpora). Run `ollama pull bge-m3` before first start. If you previously used `nomic-embed-text` (768 dimensions) with a persistent store (qdrant/hana-vector/pg-vector), you must **re-index** — dimensions changed.

> **No Ollama?** Omit `rag.embedder` (or remove the `rag:` block) — tool selection uses BM25 keyword matching instead of neural embeddings. Everything else works identically.

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

`mode` (default `smart`) is one of three values:

| Mode    | Behaviour                                                                 |
|---------|---------------------------------------------------------------------------|
| `smart` | (default) All requests → full SmartAgent pipeline (RAG tool selection + MCP orchestration) |
| `hard`  | MCP-only — tool/MCP orchestration without the full RAG pipeline           |
| `pass`  | Direct LLM (no agent; transparent proxy)                                  |

Cline handling is **independent of `mode`**: the `ClineClientAdapter` detects Cline's
system prompt and adapts the response format in any mode — it is not a routing mode
(there are no `hybrid`/`passthrough` modes).

---

## CLI Reference

The CLI accepts runtime and process-level flags only. Agent behavior (LLM provider, model, RAG, MCP, prompts, mode) lives in `smart-server.yaml`. The flags below are runtime/process overrides — config-file path, env loading, port/host, logging — not agent-behavior knobs.

```bash
llm-agent --port 3002 --config /path/to/my-config.yaml
```

| Flag                      | Description                                                        |
|---------------------------|--------------------------------------------------------------------|
| `--config <path>`         | YAML config file (default: `smart-server.yaml`)                   |
| `--secrets-dir <folder>`  | Directory to load `*.env` files from (default: `~/.config/mcp-abap-adt/`) |
| `--env`                   | Load `*.env` files from `--secrets-dir`                           |
| `--env-path <file>`       | Explicit `.env` file to load                                       |
| `--port <number>`         | HTTP port                                                          |
| `--host <string>`         | Bind address                                                       |
| `--plugin-dir <path>`     | Additional plugin directory                                        |
| `--log-file <path>`       | Log file path                                                      |
| `--log-stdout`            | Log to stdout instead of file                                      |
| `--help`                  | Show full help                                                      |
| `--version`               | Print version and exit                                             |

Generate a config template without starting the server:

```bash
llm-agent --config /path/to/my-config.yaml   # creates template if file is absent
```

---

## Advanced: several models

For multi-LLM setups or multiple MCP servers, `llm:` becomes a map of named entries instead of one
flat config, and `rag:` splits its store from its embedder. (The old `pipeline: { llm, rag, mcp }`
override was removed in v19 — a config using it fails loud at startup; see
[PIPELINES.md](PIPELINES.md).)

```yaml
llm:
  main:
    provider: deepseek        # deepseek | openai | anthropic | sap-ai-sdk | ollama
    model: deepseek-chat      # credentialRef omitted: reads LLM_API_KEY
    temperature: 0.7
  classifier:                 # cheaper model for intent classification
    provider: openai
    credentialRef: OPENAI     # reads OPENAI_API_KEY
    model: gpt-4o-mini
    temperature: 0.1

rag:
  store:
    type: in-memory            # in-memory | qdrant | hana-vector | pg-vector
  embedder:
    provider: ollama           # ollama | openai | sap-ai-core (neural embeddings for tool/skill selection)

mcp:
  - type: http
    url: http://sap-server:3000/mcp/stream/http
  - type: stdio
    command: npx
    args: [github-mcp-server]
```

An `llm:` entry with no `credentialRef` uses that role's default ref (`LLM` for `main`); naming one
reads `<REF>_API_KEY` / `<REF>_SERVICE_KEY` instead.

See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for full pipeline and programmatic API reference.

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
// (scope is 'session' or 'user'; the tools never create a 'global')
// Later:
await agent.closeSession('session-id');  // deletes the session's collections (catalog record first, then data)
```

See [docs/INTEGRATION.md#iragprovider](INTEGRATION.md#iragprovider) for full provider setup,
scope semantics, and the MCP tool factory.

### Multi-step processes (pipelines)

A pipeline decomposes a request into a multi-step plan and dispatches each step to a named subagent (or back to the parent agent), aggregating results into a final response. You select a pipeline by name under `pipeline:`, and pass its settings under `pipeline.config`.

Minimal YAML to enable the `linear` pipeline:

```yaml
pipeline:
  name: linear                # flat | linear | dag | stepper | <plugin name>
  config:
    planning: one-shot        # or replan-on-error
    dispatch: hybrid          # subagent + self fallback
    plannerLlm: helper

subagents:
  - name: my-coder
    config: ./agents/coder.yaml
  - name: my-reviewer
    config: ./agents/reviewer.yaml
```

The pipeline is whatever `pipeline.name` resolves to: a built-in (`flat`, `linear`, `dag`, `stepper`) or a custom pipeline plugin. Each pipeline consumes its own `config` dialect; see [docs/PIPELINES.md](PIPELINES.md). To fall back to a plain tool-loop when there are no subagents or skill steps, set `pipeline.config.activation: auto`.

**Skill-driven (no planner LLM):**

Use `planning: skill-steps` when the active skill encodes the process as YAML `steps:` in its frontmatter — no planner LLM round-trip.

```yaml
pipeline:
  name: linear
  config:
    planning: skill-steps    # plan comes from active skill's frontmatter `steps:`
    # dispatch defaults to 'hybrid' for skill-steps — steps without `agent:`
    # fall back to self-LLM via SelfDispatch.
    activation: explicit
```

See `docs/examples/coordinator-orchestration.yaml` and `docs/examples/coordinator-orchestration-deepseek.yaml` for complete configurations, and [docs/ARCHITECTURE.md](ARCHITECTURE.md) for the full strategy and subagent infrastructure reference.

---

## Troubleshooting

### "credentialRef 'LLM' must hold a api-key credential for deepseek, got none"
Set `LLM_API_KEY` in `.env` (or `<REF>_API_KEY` for the ref the entry names, via `credentialRef:`).
`ollama` needs none.

### Ollama embed errors
Run Ollama locally and pull the model:
```bash
ollama pull bge-m3
```
Or omit `rag.embedder` (BM25 keyword-only) — or remove the `rag:` block entirely — to run without Ollama.

### Cannot connect to MCP server
Verify the endpoint is reachable and the MCP server is running.

When an `mcp:` block is configured, the server uses a **resilient connection strategy by default** — it connects, retries periodically (~10 s), and reports readiness. While MCP is not yet connected, `GET /health` shows `ready: false` and chat requests return **HTTP 503** (a pre-dispatch readiness gate); once MCP connects, requests are served normally. There is **no YAML key** to change this — an embedding consumer can inject a different `IMcpConnectionStrategy` via `SmartAgentBuilder.withMcpConnectionStrategy(...)` (e.g. a no-op strategy that starts with an empty tool catalog instead of gating).

Since v20.4.0, a mid-run MCP failure surfaces as a loud error via the `IMcpFailureClassifier` instead of silently producing `(no response)`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#mcp-server-goes-offline-mid-run-and-the-agent-returns-no-response) for details.

### Cline not using the agent
The default `smart` mode routes all clients (including Cline) through the SmartAgent. If you
set `mode: pass`, requests go straight to the LLM instead — set `mode: smart` (or omit `mode`)
to force the agent. Cline's tool-protocol formatting is handled automatically by the
`ClineClientAdapter` regardless of mode.

---

## Legacy: Thin Proxy CLI (dev / testing)

The original single-turn CLI is still available for quick LLM + MCP testing without the full server:

```bash
# LLM + MCP (single-turn, no SmartAgent)
DEEPSEEK_API_KEY=sk-xxx npm run dev

# LLM only: in smart-server.yaml, omit the `mcp:` block or set `mcp.type: none`.
# Then run: npm run dev
npm run dev
```
