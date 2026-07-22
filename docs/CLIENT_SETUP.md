# Connecting AI Assistants to llm-agent

This guide explains how to connect external AI assistants (Claude CLI, Cline, Goose) to a running `llm-agent` server. The server exposes two API endpoints:

- **OpenAI-compatible** — `POST /v1/chat/completions`
- **Anthropic-compatible** — `POST /v1/messages`

Both endpoints route through the SmartAgent pipeline with semantic tool filtering, RAG, and internal MCP tools — regardless of which protocol the client uses.

## Prerequisites

Start the llm-agent server:

```bash
# Configuration comes from a YAML file, not from LLM_* environment variables:
# secrets are referenced as ${VAR} inside the YAML and read from a .env file at
# the project root. (The server itself only reads PORT from the environment.)

# Option 1: first run with no config writes a smart-server.yaml template and exits.
# Put your keys in .env, edit smart-server.yaml, then run again to start:
npx llm-agent

# Option 2 (recommended): point --config at a provider preset; secrets from .env.
npx llm-agent --config pipelines/deepseek.yaml
```

The server starts on `http://localhost:4004` by default.

## Claude CLI (Claude Code)

Claude CLI connects via `ANTHROPIC_BASE_URL`, sending requests to the Anthropic Messages API endpoint.

### Setup

```bash
# Point Claude CLI to llm-agent
export ANTHROPIC_BASE_URL=http://localhost:4004

# Do NOT set ANTHROPIC_API_KEY — it conflicts with claude.ai login.
# Claude CLI authenticates with its own token; llm-agent does not validate it.

# Launch Claude CLI
claude
```

There is also a launcher script (`claude-via-agent`, on your PATH after a global
install; `packages/llm-agent-server/tools/claude-via-agent.{sh,ps1}` in a checkout)
that starts llm-agent and points Claude CLI at it in one step.

**Caveat — config paths are resolved next to the server package.** The launcher
reads `.env` and looks for `pipelines/<LLM_PROVIDER>.yaml` relative to the
server-package directory (`packages/llm-agent-server/`) and `cd`s there before
starting the agent. The shipped presets live at the **repo root** `pipelines/` and
are **not** bundled into the published package, so from a repo checkout the
auto-select finds nothing and a relative `--config pipelines/…` does not resolve
(the CLI writes a template and exits). The launcher's auto-select only works when a
`pipelines/` directory and `.env` sit next to the server package.

The reliable path from a checkout is to start the agent yourself from the repo root
(where `pipelines/` lives) with an explicit config, then point Claude CLI at it:

```bash
# terminal 1 — from the repo root
npx llm-agent --config pipelines/sap-ai-core.yaml   # or pipelines/deepseek.yaml

# terminal 2
export ANTHROPIC_BASE_URL=http://localhost:4004
claude
```

On startup the server prints its listen address (and the log file, when `--log-file`
/ `log:` is set):

```
llm-agent listening on http://0.0.0.0:4004
logs → ./smart-server.log
```

To verify the active model and inspect live request details, tail that JSONL event
log, or read the per-request step files the session writer produces:

```bash
tail -f smart-server.log
# structured per-request artifacts:
ls sessions/<session_id>/req_<timestamp>_<uuid>/*.json
```

### How it works

```
Claude CLI  →  POST /v1/messages  →  llm-agent  →  SmartAgent pipeline
                                                     ├── semantic tool filtering
                                                     ├── internal MCP tools
                                                     ├── RAG (facts, feedback, state)
                                                     └── external tools from Claude CLI
```

Claude CLI sends its own tools (Read, Edit, Bash, etc.) in the request. llm-agent treats them as **external tools** alongside its internal MCP tools. The agent can use both in the same response — internal tool calls are executed by the agent, external tool calls are returned to Claude CLI for execution.

### Dynamic token helper (optional)

For production setups with OAuth2 authentication, use `apiKeyHelper` in Claude CLI settings:

```json
{
  "apiKeyHelper": "~/bin/get-llm-agent-token.sh"
}
```

## Cline (VS Code extension)

Cline connects via the OpenAI-compatible endpoint.

### Setup

1. Open Cline settings in VS Code
2. Set **API Provider** to `OpenAI Compatible`
3. Configure:
   - **Base URL:** `http://localhost:4004/v1`
   - **API Key:** `placeholder` (any non-empty string)
   - **Model:** `smart-agent` (or any string — llm-agent uses its own configured model)

### How it works

```
Cline  →  POST /v1/chat/completions  →  llm-agent  →  SmartAgent pipeline
```

Cline sends tools via the OpenAI `tools` field. llm-agent processes them as external tools.

## Goose (CLI agent)

Goose supports OpenAI-compatible providers.

### Setup

Configure `~/.config/goose/profiles.yaml`:

```yaml
default:
  provider: openai
  model: smart-agent
  openai:
    api_key: placeholder
    base_url: http://localhost:4004/v1
```

Then run:

```bash
goose session
```

## Switching Pipeline Configs

When you change the llm-agent pipeline config (e.g. switching from `deepseek.yaml` to `sap-ai-core.yaml`), you may need to reconfigure the client as well. The server-side model change is transparent to most clients, but parameters like `context_limit` and `max_tokens` are often set on the client side.

**What to check after switching pipelines:**

| Parameter | Why it matters | Where to update |
|-----------|---------------|-----------------|
| `context_limit` / `max_tokens` | Different models have different limits (DeepSeek: 8K output, Claude: 32K, GPT-4o: 16K). Client may send a value the new model rejects with HTTP 400. | Client config (Goose `profiles.yaml`, Cline settings, Claude CLI env) |
| `model` name | Some clients send the model name in requests. llm-agent ignores it (uses pipeline config), but clients may validate it locally. | Client config |

**Goose example** — update `~/.config/goose/profiles.yaml` context limit when switching to a model with different limits.

**Symptom of misconfiguration:** HTTP 400 errors from the LLM provider, often with no visible details in the client. Check llm-agent session logs (`sessions/`) for the full error.

## Architecture

All clients connect to the same llm-agent server and benefit from:

- **Semantic tool filtering** — only relevant tools from internal MCP servers are included in context
- **RAG** — facts, feedback, and state stores enrich every request
- **Multi-model pipeline** — classification, tool execution, and presentation can use different LLMs
- **Plugin system** — extend with custom adapters, stage handlers, and tools

```
┌─────────────┐  ┌───────┐  ┌───────────┐
│  Claude CLI  │  │ Cline │  │   Goose   │
└──────┬───────┘  └───┬───┘  └─────┬─────┘
       │ Anthropic    │ OpenAI     │ OpenAI
       │ /v1/messages │ /v1/chat/  │ /v1/chat/
       │              │ completions│ completions
       └──────────────┼────────────┘
                      │
              ┌───────▼────────┐
              │   llm-agent    │
              │   SmartServer  │
              ├────────────────┤
              │ ILlmApiAdapter │ ← protocol translation
              ├────────────────┤
              │  SmartAgent    │ ← pipeline orchestration
              │  ├─ classify   │
              │  ├─ RAG query  │
              │  ├─ tool-select│
              │  ├─ tool-loop  │
              │  └─ present    │
              ├────────────────┤
              │  Internal MCP  │ ← ABAP, JIRA, etc.
              └────────────────┘
```

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `LLM_PROVIDER` | LLM provider | `openai`, `anthropic`, `deepseek`, `sap-ai-sdk` |
| `LLM_API_KEY` | Provider API key | `sk-...` |
| `LLM_MODEL` | Model name | `gpt-4o`, `claude-sonnet-4-20250514`, `deepseek-chat` |
| `MCP_ENDPOINT` | MCP server URL | `http://localhost:3001/mcp/stream/http` |
| `PORT` | Server port | `4004` (default) |

For SAP AI Core, use `AICORE_SERVICE_KEY` instead of `LLM_API_KEY`. See [SAP_AI_CORE.md](SAP_AI_CORE.md).
