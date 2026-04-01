# Connecting AI Assistants to llm-agent

This guide explains how to connect external AI assistants (Claude CLI, Cline, Goose) to a running `llm-agent` server. The server exposes two API endpoints:

- **OpenAI-compatible** — `POST /v1/chat/completions`
- **Anthropic-compatible** — `POST /v1/messages`

Both endpoints route through the SmartAgent pipeline with semantic tool filtering, RAG, and internal MCP tools — regardless of which protocol the client uses.

## Prerequisites

Start the llm-agent server:

```bash
# Configure environment
export LLM_PROVIDER=openai          # or: anthropic, deepseek, sap-ai-sdk
export LLM_API_KEY=sk-...           # API key for the provider
export LLM_MODEL=gpt-4o             # model name as the provider expects
export MCP_ENDPOINT=http://localhost:3001/mcp/stream/http  # optional MCP server

# Start the server
npx llm-agent
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

Or use the launcher script:

```bash
./tools/claude-via-agent.sh
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
