# Smart Agent & Server

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A high-performance, RAG-orchestrated LLM agent and OpenAI-compatible server with deep MCP integration.

## Packages

| Package | What it is |
|---|---|
| [`@mcp-abap-adt/llm-agent`](packages/llm-agent/README.md) | Core interfaces, types, `MissingProviderError`, lightweight helpers (`CircuitBreaker`, `FallbackRag`, LLM call strategies, `ToolCache`, adapters, normalizers). Zero provider dependencies. |
| [`@mcp-abap-adt/llm-agent-mcp`](packages/llm-agent-mcp/README.md) | `MCPClientWrapper`, `McpClientAdapter`, `createDefaultMcpClient`, and MCP connection strategies. |
| [`@mcp-abap-adt/llm-agent-rag`](packages/llm-agent-rag/README.md) | RAG/embedder composition — `makeRag` (async), `resolveEmbedder` (sync), prefetch helpers, backend factories. |
| [`@mcp-abap-adt/llm-agent-libs`](packages/llm-agent-libs/README.md) | Core composition runtime: `SmartAgentBuilder`, `SmartAgent`, pipeline, sessions, history, resilience, observability, plugins, skills, `makeLlm`/`makeDefaultLlm`. |
| [`@mcp-abap-adt/llm-agent-server`](packages/llm-agent-server/README.md) | **Binary only** — CLI (`llm-agent`, `llm-agent-check`, `claude-via-agent`) + HTTP `SmartServer`. Not importable as a library. |
| [`@mcp-abap-adt/openai-llm`](packages/openai-llm/README.md) | OpenAI LLM provider (`OpenAIProvider`). |
| [`@mcp-abap-adt/anthropic-llm`](packages/anthropic-llm/README.md) | Anthropic LLM provider (`AnthropicProvider`). |
| [`@mcp-abap-adt/deepseek-llm`](packages/deepseek-llm/README.md) | DeepSeek LLM provider (`DeepSeekProvider`, extends OpenAI-compatible). |
| [`@mcp-abap-adt/sap-aicore-llm`](packages/sap-aicore-llm/README.md) | SAP AI Core LLM provider via `@sap-ai-sdk/orchestration`. |
| [`@mcp-abap-adt/openai-embedder`](packages/openai-embedder/README.md) | OpenAI embeddings (`OpenAiEmbedder`). |
| [`@mcp-abap-adt/ollama-embedder`](packages/ollama-embedder/README.md) | Ollama embeddings + RAG (`OllamaEmbedder`, `OllamaRag`). |
| [`@mcp-abap-adt/sap-aicore-embedder`](packages/sap-aicore-embedder/README.md) | SAP AI Core embeddings (`SapAiCoreEmbedder`). |
| [`@mcp-abap-adt/qdrant-rag`](packages/qdrant-rag/README.md) | Qdrant vector store RAG (`QdrantRag`, `QdrantRagProvider`). |
| [`@mcp-abap-adt/hana-vector-rag`](packages/hana-vector-rag/README.md) | SAP HANA Cloud Vector Engine RAG (`HanaVectorRag`, `HanaVectorRagProvider`). Optional peer. |
| [`@mcp-abap-adt/pg-vector-rag`](packages/pg-vector-rag/README.md) | PostgreSQL + pgvector RAG (`PgVectorRag`, `PgVectorRagProvider`). Optional peer. |

## Quick install

### (a) Server-managed declarative (most common)

Install server + exactly the peers your `smart-server.yaml` references:

```bash
# Fully local — Ollama LLM + Ollama embeddings
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/ollama-embedder

# DeepSeek LLM + Ollama embeddings
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/deepseek-llm \
            @mcp-abap-adt/ollama-embedder

# SAP AI Core LLM + SAP AI Core embeddings + Qdrant RAG
npm install @mcp-abap-adt/llm-agent-server \
            @mcp-abap-adt/sap-aicore-llm \
            @mcp-abap-adt/sap-aicore-embedder \
            @mcp-abap-adt/qdrant-rag
```

A missing peer throws `MissingProviderError` at startup with an install hint.

### (b) Programmatic composition (no YAML)

Install `llm-agent-libs` + the peers you need. Construct `SmartAgent` via `SmartAgentBuilder` in code. Import provider classes from their packages and pass instances to the builder's fluent setters.

```bash
npm install @mcp-abap-adt/llm-agent-libs \
            @mcp-abap-adt/llm-agent-mcp \
            @mcp-abap-adt/llm-agent-rag \
            @mcp-abap-adt/deepseek-llm \
            @mcp-abap-adt/ollama-embedder
```

### (c) Core-only (no SmartAgent, no server)

```bash
npm install @mcp-abap-adt/llm-agent
```

Build your own agent against the interfaces exported by core. Supply your own `ILlm` and `IEmbedder` implementations.

See [docs/MIGRATION-v11.md](docs/MIGRATION-v11.md) if you are upgrading from v10.

## Documentation

- [QUICK_START.md](docs/QUICK_START.md) — end-to-end guide: install, config, connect IDE
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture reference: thin proxy layer + SmartAgent/SmartServer/pipeline
- [INTEGRATION.md](docs/INTEGRATION.md) — custom interface implementation guide with code examples
- [PERFORMANCE.md](docs/PERFORMANCE.md) — RAG, BM25, model selection, token budget tuning
- [CLIENT_SETUP.md](docs/CLIENT_SETUP.md) — connection instructions for Claude CLI, Cline, and Goose
- [SAP_AI_CORE.md](docs/SAP_AI_CORE.md) — SAP AI Core operational guidance and troubleshooting
- [DEPLOYMENT.md](docs/DEPLOYMENT.md) — production deployment patterns (Docker, systemd, serverless)

## Development

```bash
# Build project
npm run build

# Run tests
npm run test:all

# Development with hot-reload
npm run dev

# Smart server production entrypoint
npm run start

# Legacy compatibility aliases
npm run start:smart
npm run dev:llm
npm run start:llm
npm run test
npm run test:llm
```

## License

MIT
