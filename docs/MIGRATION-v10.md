# Migrating from v9 to v10

v10.0.0 splits the single `@mcp-abap-adt/llm-agent` package into two:

- **`@mcp-abap-adt/llm-agent`** — interfaces, types, lightweight default implementations. Install this if you write your own agent on our interfaces.
- **`@mcp-abap-adt/llm-agent-server`** — the full default SmartAgent, LLM providers, MCP client, HTTP server, and all three CLIs (`llm-agent`, `llm-agent-check`, `claude-via-agent`). Install this for the out-of-the-box runtime. It depends on the core package transitively.

## Install changes

Before (v9.x):

```bash
npm install @mcp-abap-adt/llm-agent
```

After (v10.0):

```bash
# Typical consumer: the default runtime + CLIs
npm install @mcp-abap-adt/llm-agent-server

# Advanced consumer: only the interfaces and lightweight primitives
npm install @mcp-abap-adt/llm-agent
```

## Where each symbol lives

| Symbol | Package (v10.0) |
|---|---|
| `SmartAgent`, `SmartAgentBuilder` | `@mcp-abap-adt/llm-agent-server` |
| `DefaultPipeline` and pipeline handlers | `@mcp-abap-adt/llm-agent-server` |
| `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `SapCoreAIProvider` | `@mcp-abap-adt/llm-agent-server` |
| `FallbackRag`, `CircuitBreaker`, `RetryLlm`, `RateLimiterLlm` | `@mcp-abap-adt/llm-agent-server` |
| `MCPClientWrapper` and transports | `@mcp-abap-adt/llm-agent-server` |
| `BaseAgent`, `OpenAIAgent`, `AnthropicAgent`, `DeepSeekAgent`, `SapCoreAIAgent`, `PromptBasedAgent` | `@mcp-abap-adt/llm-agent-server` |
| `IRag`, `IRagEditor`, `IRagRegistry`, `IRagProvider`, `IRagProviderRegistry` | `@mcp-abap-adt/llm-agent` |
| `IEmbedder`, `ILlm`, `IMcpClient`, other `I*` interfaces | `@mcp-abap-adt/llm-agent` |
| `InMemoryRag`, `VectorRag`, `QdrantRag`, `OllamaRag` | `@mcp-abap-adt/llm-agent` |
| `InMemoryRagProvider`, `VectorRagProvider`, `QdrantRagProvider`, `SimpleRagProviderRegistry`, `AbstractRagProvider` | `@mcp-abap-adt/llm-agent` |
| `SimpleRagRegistry`, `OverlayRag`, `SessionScopedRag`, `ActiveFilteringRag` | `@mcp-abap-adt/llm-agent` |
| Edit strategies (`DirectEditStrategy`, `ImmutableEditStrategy`, `OverlayEditStrategy`, `SessionScopedEditStrategy`) | `@mcp-abap-adt/llm-agent` |
| Id strategies (`CallerProvidedIdStrategy`, `GlobalUniqueIdStrategy`, `SessionScopedIdStrategy`, `CanonicalKeyIdStrategy`) | `@mcp-abap-adt/llm-agent` |
| Corrections module helpers | `@mcp-abap-adt/llm-agent` |
| `RagError`, `LlmError`, `ReadOnlyError`, `ProviderNotFoundError`, other errors | `@mcp-abap-adt/llm-agent` |
| `buildRagCollectionToolEntries`, `RagToolEntry`, `RagToolContext` | `@mcp-abap-adt/llm-agent` |

## CLI changes

```bash
# Before (v9.x)
npx @mcp-abap-adt/llm-agent --config smart-server.yaml

# After (v10.0)
npx @mcp-abap-adt/llm-agent-server --config smart-server.yaml

# Globally installed bins (all three preserved)
llm-agent --config smart-server.yaml
llm-agent-check
claude-via-agent
```

## Deep imports

The `./testing`, `./smart-server`, `./otel` sub-exports now live on `@mcp-abap-adt/llm-agent-server` (previously on `@mcp-abap-adt/llm-agent`). Update the package name in your imports; the path after the slash is unchanged.

## Known deps still shipped with the core package in v10.0

`@mcp-abap-adt/llm-agent` currently carries `axios` (for `QdrantRag`) and `@sap-ai-sdk/orchestration` (for `SapAiCoreEmbedder`). Follow-up releases (10.1.0+) will extract those specific implementations into their own packages (`@mcp-abap-adt/qdrant-vector-provider`, `@mcp-abap-adt/sap-aicore-provider`, `@mcp-abap-adt/hana-vector-provider`), at which point core's dependencies shrink to the minimum needed for the interfaces. If your consumer today depends on either package and wants the lighter surface immediately, watch the 10.1 roadmap.
