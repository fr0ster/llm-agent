# Smart Agent & Server

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

A high-performance, RAG-orchestrated LLM agent and OpenAI-compatible server with deep MCP integration.

## Packages

| Package | What it is |
|---|---|
| [`@mcp-abap-adt/llm-agent`](packages/llm-agent/README.md) | Core interfaces, types, `MissingProviderError`, and lightweight RAG utilities. Zero provider dependencies. |
| [`@mcp-abap-adt/llm-agent-server`](packages/llm-agent-server/README.md) | `SmartAgent`, pipeline, MCP client, HTTP server, and CLIs. Depends on `@mcp-abap-adt/llm-agent`; provider packages are optional peers. |
| [`@mcp-abap-adt/openai-llm`](packages/openai-llm/README.md) | OpenAI LLM provider (`OpenAIProvider`). |
| [`@mcp-abap-adt/anthropic-llm`](packages/anthropic-llm/README.md) | Anthropic LLM provider (`AnthropicProvider`). |
| [`@mcp-abap-adt/deepseek-llm`](packages/deepseek-llm/README.md) | DeepSeek LLM provider (`DeepSeekProvider`, extends OpenAI-compatible). |
| [`@mcp-abap-adt/sap-aicore-llm`](packages/sap-aicore-llm/README.md) | SAP AI Core LLM provider via `@sap-ai-sdk/orchestration`. |
| [`@mcp-abap-adt/openai-embedder`](packages/openai-embedder/README.md) | OpenAI embeddings (`OpenAiEmbedder`). |
| [`@mcp-abap-adt/ollama-embedder`](packages/ollama-embedder/README.md) | Ollama embeddings + RAG (`OllamaEmbedder`, `OllamaRag`). |
| [`@mcp-abap-adt/sap-aicore-embedder`](packages/sap-aicore-embedder/README.md) | SAP AI Core embeddings (`SapAiCoreEmbedder`). |
| [`@mcp-abap-adt/qdrant-rag`](packages/qdrant-rag/README.md) | Qdrant vector store RAG (`QdrantRag`, `QdrantRagProvider`). |

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

### (b) Programmatic server composition

Same install as (a), but construct `SmartAgent` via `SmartAgentBuilder` in code rather than via `smart-server.yaml`. Import provider classes from their packages and pass instances to the builder's fluent setters.

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
