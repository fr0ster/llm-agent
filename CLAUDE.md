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

This is a **thin LLM proxy / orchestration layer** published as an npm package. Its job is to normalize access to LLM providers and surface MCP tool catalogs — it does **not** execute tools itself; the consumer is responsible for executing tools returned in the raw response.

### Data flow

```
Consumer → agent.process(message)
         → LLM Provider (formats tools list from MCP, sends chat request)
         ← LLM response (may contain tool_call requests)
         ← AgentResponse { message, raw?, error? }
Consumer parses raw for tool calls → calls mcpClient.callTool() directly
```

### Key layers

| Layer | Files | Role |
|-------|-------|------|
| **Agents** | `src/agents/` | Template Method pattern; `BaseAgent` handles MCP connection, history, tool loading; subclasses handle provider-specific tool formatting |
| **LLM Providers** | `src/llm-providers/` | Thin HTTP wrappers per provider; each implements `LLMProvider` interface from `base.ts` |
| **MCP Client** | `src/mcp/client.ts` | `MCPClientWrapper` — multi-transport abstraction (stdio / SSE / stream-http / embedded / auto) |
| **Types** | `src/types.ts` | Shared types: `Message`, `ToolCall`, `AgentResponse`, `LLMResponse`, `LLMProviderConfig` |
| **Public API** | `src/index.ts` | All exports for npm consumers |
| **CLI** | `src/cli.ts` | Dev test launcher; reads `.env`; not part of public API |

### Agent hierarchy

```
BaseAgent (abstract)
├── OpenAIAgent        — native function calling (tools param)
├── AnthropicAgent     — native tools API (content blocks)
├── DeepSeekAgent      — OpenAI-compatible function calling
├── SapCoreAIAgent     — SAP AI SDK native function calling (@sap-ai-sdk/orchestration)
└── PromptBasedAgent   — tools described in system prompt
```

`PromptBasedAgent` is the fallback for providers that don't support native function calling.

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

- `docs/ARCHITECTURE.md` — architecture reference: thin proxy layer + SmartAgent/SmartServer/pipeline
- `src/mcp/README.md` — MCP transport configuration details
- `docs/ROADMAP.md` — upcoming phases (17–20)
