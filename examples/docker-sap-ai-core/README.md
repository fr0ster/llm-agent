# Docker Deployment Example — SAP AI Core

A production-ready Docker Compose setup for `@mcp-abap-adt/llm-agent` using SAP AI Core as the LLM and embedding provider.

## Architecture

Two services:

| Service | Port | Description |
|---------|------|-------------|
| `llm-agent-core` | 8010 (internal) | OpenAI-compatible API (`/v1/chat/completions`) powered by SmartAgent |
| `llm-agent-compat` | 20011 (exposed) | Compatibility layer — translates `POST /chat` requests to OpenAI protocol |

```
Client → :20011/chat → llm-agent-compat → llm-agent-core:8010 → SAP AI Core LLM
                                                              → Qdrant (RAG)
                                                              → MCP Server (tools)
```

## Stack

- **LLM:** SAP AI Core Orchestration (`anthropic--claude-4.6-sonnet` via `sap-ai-sdk` provider)
- **Embeddings:** SAP AI Core Vertex AI (`gemini-embedding`, 768-dim) via plugin
- **RAG:** Qdrant vector DB (external, `host.docker.internal:6333`)
- **MCP:** Stream HTTP transport to an external MCP server
- **Skills:** File-system skill discovery (`SKILL.md` per subdirectory)

## Prerequisites

- Docker & Docker Compose
- Running Qdrant instance (default: `host.docker.internal:6333`)
- Running MCP server (default: `host.docker.internal:3001/mcp/stream/http`)
- SAP AI Core credentials

## Quick Start

1. **Set environment variables** (`.env` or export):

   ```dotenv
   AICORE_AUTH_URL=https://your-tenant.authentication.sap.hana.ondemand.com
   AICORE_CLIENT_ID=your-client-id
   AICORE_CLIENT_SECRET=your-client-secret
   AICORE_BASE_URL=https://api.ai.your-region.aws.ml.hana.ondemand.com
   ```

2. **Start:**

   ```bash
   docker compose up -d
   ```

3. **Test:**

   ```bash
   curl http://localhost:20011/chat \
     -H "Content-Type: application/json" \
     -d '{"message": "List available MCP tools"}'
   ```

   Or use the OpenAI-compatible endpoint directly (internal network only by default):

   ```bash
   curl http://localhost:8010/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"smart-agent","messages":[{"role":"user","content":"Hello"}]}'
   ```

## Configuration

### Environment Variables

All configurable via `docker-compose.yml` environment section:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `sap-ai-sdk` | LLM provider |
| `LLM_MODEL_NAME` | `anthropic--claude-4.6-sonnet` | Main LLM model |
| `LLM_MAX_TOKENS` | `32768` | Max output tokens |
| `RAG_EMBEDDER` | `sap-aicore` | Embedder type (uses plugin) |
| `EMBEDDING_MODEL` | `gemini-embedding` | Embedding model name |
| `QDRANT_URL` | `http://host.docker.internal:6333` | Qdrant endpoint |
| `MCP_SERVER_URL` | `http://host.docker.internal:3001/mcp/stream/http` | MCP server endpoint |
| `EMBED_THROTTLE_MS` | `350` | Throttle between embedding calls (rate limit protection) |

### smart-server.yaml

The main agent configuration. Key sections:

- `pipeline.llm` — multi-model setup (main, classifier, helper)
- `pipeline.rag` — per-store Qdrant configuration with dedup thresholds
- `mcp` — MCP server connection
- `agent` — tool loop limits, RAG retrieval mode, retry policy
- `prompts` — custom classifier and system prompts
- `skills` — file-system skill discovery

### Plugins

ES module plugins in `plugins/`:

| Plugin | Description |
|--------|-------------|
| `sap-aicore-embedder.mjs` | SAP AI Core embedder factory — replaces Ollama with Vertex AI embeddings |
| `prepare-rag-text.mjs` | Stage handler — prepares RAG query text from classified subprompts |

### Skills

Domain-specific instruction packages in `skills/`:

| Skill | Description |
|-------|-------------|
| `sap-abap-development` | ABAP Cloud coding standards and MCP tool usage |
| `sap-troubleshooting` | SAP module troubleshooting workflow |
| `rag-knowledge-management` | Dual RAG learning loop rules |
| `file-generation` | File creation via `create_file` tool |

## Logs

```bash
docker compose logs -f llm-agent-core
docker compose logs -f llm-agent-compat
```

## Stop

```bash
docker compose down
```

## Adapting This Example

- **Different LLM provider:** Change `LLM_PROVIDER` to `openai` or `deepseek`, remove SAP AI Core env vars, and either remove the embedder plugin or switch `RAG_EMBEDDER` to `ollama`.
- **No Qdrant:** Switch all `pipeline.rag.*.type` to `in-memory` in `smart-server.yaml`.
- **No MCP:** Set `MCP_ENABLED=false` — the agent works in LLM-only mode.
- **Expose core directly:** Change `expose` to `ports` in `docker-compose.yml` for the `llm-agent-core` service.
