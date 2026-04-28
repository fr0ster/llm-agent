# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Run CLI with MCP via tsx (hot reload)
npm run dev:llm        # Run CLI in LLM-only mode (no MCP)
npm run lint           # Lint & auto-fix with Biome
npm run lint:check     # Check lint without fixing
npm run format         # Format with Biome
npm run clean          # Remove dist/
```

There is no unit test framework. `npm run test` is just `build + start` (smoke test).

## Architecture

This monorepo publishes five npm packages forming the SmartAgent runtime:

```
@mcp-abap-adt/llm-agent          contracts: interfaces, public types, lightweight helpers
@mcp-abap-adt/llm-agent-mcp      MCP client wrapper + adapter + connection strategies
@mcp-abap-adt/llm-agent-rag      RAG/embedder composition (makeRag, resolveEmbedder, factories)
@mcp-abap-adt/llm-agent-libs     core composition: builder, agent, pipeline, sessions, ...
@mcp-abap-adt/llm-agent-server   binary only (CLI + HTTP server, no library exports)
```

Dependency order: `llm-agent-server → llm-agent-libs → {llm-agent-mcp, llm-agent-rag} → llm-agent`.

LLM provider packages (`@mcp-abap-adt/openai-llm`, etc.) are optional peers of `llm-agent-libs`.
Embedder/RAG backend packages (`@mcp-abap-adt/qdrant-rag`, etc.) are optional peers of `llm-agent-rag`.

### Key API notes

- `makeLlm` / `makeDefaultLlm` (in `llm-agent-libs`) → **async** `Promise<ILlm>`
- `makeRag` (in `llm-agent-rag`) → **async** `Promise<IRag>`
- `resolveEmbedder` (in `llm-agent-rag`) → sync (call `prefetchEmbedderFactories` once at startup)
- `SmartAgentBuilder.build()` → async (unchanged externally)

### Key layers

| Layer | Package | Role |
|-------|---------|------|
| **Interfaces & types** | `@mcp-abap-adt/llm-agent` | All `I*` interfaces, shared types, lightweight helpers (CircuitBreaker, FallbackRag, LLM call strategies, ToolCache, adapters, normalizers) |
| **MCP client** | `@mcp-abap-adt/llm-agent-mcp` | `MCPClientWrapper`, `McpClientAdapter`, connection strategies |
| **RAG/embedder** | `@mcp-abap-adt/llm-agent-rag` | `makeRag`, `resolveEmbedder`, prefetch helpers, backend factories |
| **Composition runtime** | `@mcp-abap-adt/llm-agent-libs` | `SmartAgentBuilder`, `SmartAgent`, pipeline, sessions, history, metrics, skills, plugins, `makeLlm` |
| **Binary** | `@mcp-abap-adt/llm-agent-server` | CLI (`llm-agent`, `llm-agent-check`, `claude-via-agent`) + `SmartServer` HTTP server |

### MCP transports

`MCPClientConfig.transport` values: `stdio` | `sse` | `stream-http` | `embedded` | `auto`
`auto` detects transport from URL patterns. `embedded` injects an in-process server (used for testing).

## Language

- All artifacts (code, comments, docs, commit messages) must be written in **English**.
- Communicate with the user in the **language they used** in their message.

## Conventions

- **ESM only** — `"type": "module"` in package.json; use `.js` extensions in imports
- **Biome** for lint/format (not ESLint/Prettier): 2 spaces, single quotes, always semicolons
- **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`
- TypeScript strict mode; avoid `any` (Biome warns)
- Node ≥ 18 required

## Environment

Copy `.env.template` to `.env`. Key variables:

| Variable | Purpose |
|----------|---------|
| `LLM_PROVIDER` | `openai` / `anthropic` / `deepseek` / `sap-ai-sdk` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` | Provider credentials |
| `AICORE_SERVICE_KEY` | SAP AI Core service key JSON (for `sap-ai-sdk` provider) |
| `SAP_AI_MODEL`, `SAP_AI_RESOURCE_GROUP` | SAP AI SDK model name and resource group |
| `MCP_ENDPOINT` | MCP server URL (default: `http://localhost:4004/mcp/stream/http`) |
| `MCP_DISABLED` | `true` to skip MCP (LLM-only mode) |
| `DEBUG_LLM_REASON` | `true` to log LLM reasoning |

## Docs

- `docs/QUICK_START.md` — end-to-end guide: install, config, connect IDE
- `docs/ARCHITECTURE.md` — architecture reference: thin proxy layer + SmartAgent/SmartServer/pipeline
- `docs/EXAMPLES.md` — YAML config examples and programmatic usage snippets
- `src/mcp/README.md` — MCP transport configuration details
- `docs/DEPLOYMENT.md` — production deployment patterns (Docker, systemd, serverless)
- `docs/PERFORMANCE.md` — RAG, BM25, model selection, token budget tuning
- `docs/INTEGRATION.md` — custom interface implementation guide with code examples
- `docs/TROUBLESHOOTING.md` — symptom→cause→fix index for SAP AI Core / Qdrant / pipeline-mode issues
- `examples/docker-ollama/` — Docker Compose, fully local (Ollama LLM + embeddings, no API keys)
- `examples/docker-deepseek/` — Docker Compose, DeepSeek LLM + Ollama embeddings
- `examples/docker-sap-ai-core/` — Docker Compose, SAP AI Core (LLM + embeddings + Qdrant + compat layer)

## Plans and Specs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once a plan/spec has been fully implemented OR cancelled, delete the file. History lives in git; these directories hold only work in progress.
