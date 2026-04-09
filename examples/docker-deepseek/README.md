# Docker Deployment Example — DeepSeek + Ollama

A lightweight Docker Compose setup for `@mcp-abap-adt/llm-agent` using DeepSeek as LLM and Ollama for embeddings.

## Architecture

```
Client → :4004/v1/chat/completions → llm-agent → DeepSeek API (LLM)
                                               → Ollama (embeddings)
                                               → MCP Server (tools, optional)
```

## Prerequisites

- Docker & Docker Compose
- [Ollama](https://ollama.ai) running locally with `nomic-embed-text` model pulled
- DeepSeek API key
- (Optional) MCP server for tool execution

## Quick Start

1. **Pull the embedding model** (if not already):

   ```bash
   ollama pull nomic-embed-text
   ```

2. **Set environment variables** (`.env` or export):

   ```dotenv
   DEEPSEEK_API_KEY=sk-your-deepseek-key
   ```

3. **Start:**

   ```bash
   docker compose up -d
   ```

4. **Test:**

   ```bash
   curl http://localhost:4004/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"smart-agent","messages":[{"role":"user","content":"Hello!"}]}'
   ```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | (required) | DeepSeek API key |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama endpoint |
| `MCP_SERVER_URL` | `http://host.docker.internal:3001/mcp/stream/http` | MCP server endpoint |
| `MCP_ENABLED` | `true` | Set `false` to run without MCP tools |
| `PORT` | `4004` | Host port mapping |

### No Ollama?

Switch to keyword-only RAG — edit `smart-server.yaml`:

```yaml
rag:
  type: in-memory
```

This uses BM25 lexical matching instead of neural embeddings. No external dependencies required.

## Connecting IDE Clients

Point any OpenAI-compatible client to:

- **Base URL:** `http://localhost:4004/v1`
- **Model:** `smart-agent`
- **API Key:** any non-empty string (e.g., `sk-none`)

Works with Cline, Continue, Goose, Cursor, and any OpenAI SDK.

## Logs / Stop

```bash
docker compose logs -f
docker compose down
```
