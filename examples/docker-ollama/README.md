# Docker Deployment Example — Ollama (Fully Local)

A fully local Docker Compose setup for `@mcp-abap-adt/llm-agent` — no external API keys required. Uses Ollama for both LLM inference and embeddings.

## Architecture

```
Client → :4004/v1/chat/completions → llm-agent → Ollama (LLM + embeddings)
                                               → MCP Server (tools, optional)
```

## Prerequisites

- Docker & Docker Compose
- [Ollama](https://ollama.ai) running locally with models pulled
- (Optional) MCP server for tool execution

## Quick Start

1. **Pull the required models:**

   ```bash
   ollama pull qwen2.5:14b         # LLM (or any model you prefer)
   ollama pull nomic-embed-text     # embeddings
   ```

2. **Start:**

   ```bash
   docker compose up -d
   ```

3. **Test:**

   ```bash
   curl http://localhost:4004/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"smart-agent","messages":[{"role":"user","content":"Hello!"}]}'
   ```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama endpoint |
| `MCP_SERVER_URL` | `http://host.docker.internal:3001/mcp/stream/http` | MCP server endpoint |
| `MCP_ENABLED` | `true` | Set `false` to run without MCP tools |
| `PORT` | `4004` | Host port mapping |

### Changing the LLM Model

Edit `smart-server.yaml` — set `llm.model` to any Ollama model:

```yaml
llm:
  model: llama3.1:8b       # lighter model
  # model: qwen2.5:14b     # default
  # model: deepseek-r1:14b # reasoning model
```

### No MCP?

Set `MCP_ENABLED=false` — the agent works in LLM-only mode without tools.

## Connecting IDE Clients

Point any OpenAI-compatible client to:

- **Base URL:** `http://localhost:4004/v1`
- **Model:** `smart-agent`
- **API Key:** any non-empty string (e.g., `sk-none`)

Works with Cline, Continue, Goose, Cursor, and any OpenAI SDK.

## Performance Notes

- Ollama inference speed depends on your GPU. CPU-only mode works but is slow for large models.
- For CPU-only machines, use smaller models like `llama3.1:8b` or `qwen2.5:7b`.
- Embedding calls (`nomic-embed-text`) are lightweight and fast even on CPU.

## Logs / Stop

```bash
docker compose logs -f
docker compose down
```
