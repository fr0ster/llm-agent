# @mcp-abap-adt/llm-agent

Core interfaces, types, and lightweight default implementations for LLM agent orchestration.

This package is the abstraction layer consumed by `@mcp-abap-adt/llm-agent-server` and by downstream applications that want to build their own agent on our interfaces. It ships:

- All `I*` interfaces (IRag, IRagEditor, IRagProvider, IRagRegistry, ILlm, IMcpClient, IPipeline, IClientAdapter, ILlmApiAdapter, IToolCache, ILogger, etc.)
- Shared types (Message, ToolCall, RagMetadata, CallOptions, Result, errors)
- Lightweight RAG implementations (InMemoryRag, VectorRag, QdrantRag, InMemoryRagProvider, VectorRagProvider, QdrantRagProvider, SimpleRagRegistry, SimpleRagProviderRegistry, edit strategies, id strategies, corrections module, overlay rags, MCP tool factory)
- Library helpers usable when embedding SmartAgent in your own server:
  - **Resilience**: `CircuitBreaker`, `CircuitBreakerLlm`, `CircuitBreakerEmbedder`, `FallbackRag`
  - **LLM call policies**: `NonStreamingLlmCallStrategy`, `StreamingLlmCallStrategy`, `FallbackLlmCallStrategy`
  - **Tool cache**: `ToolCache`, `NoopToolCache`
  - **API adapters** (Anthropic Messages / OpenAI Chat Completions ↔ SmartAgent): `AnthropicApiAdapter`, `OpenAiApiAdapter`, with `NormalizedRequest` / `ApiRequestContext` / `ApiSseEvent` / `AdapterValidationError`
  - **Client adapters**: `ClineClientAdapter`
  - **Tool utilities**: `normalizeAndValidateExternalTools`, `normalizeExternalTools`, `getStreamToolCallName`, `toToolCallDelta`

For the full default agent runtime (SmartAgent assembly, providers wiring, HTTP server, CLI), install `@mcp-abap-adt/llm-agent-server` — but if you only need the helpers above and you ship your own server, depending on `@mcp-abap-adt/llm-agent` is sufficient.

See the repo root for design specs, migration notes, and architectural docs.

## Migration from 12.0.0

Symbols that briefly appeared only in `@mcp-abap-adt/llm-agent-server@12.0.0` are now in their dedicated packages:

| Symbol(s) | Was (12.0.0) | Now (12.0.1) |
|---|---|---|
| `MCPClientWrapper`, `McpClientAdapter`, `LazyConnectionStrategy`, `PeriodicConnectionStrategy`, `NoopConnectionStrategy`, `createDefaultMcpClient` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-mcp` |
| `makeRag`, `resolveEmbedder`, `prefetchEmbedderFactories`, `prefetchRagFactories`, `resolvePrefetchedEmbedder`, `resolveRag`, `builtInEmbedderFactories`, related types | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-rag` |
| `SmartAgentBuilder`, `SessionManager`, `HistoryMemory`, `HistorySummarizer`, `DefaultPipeline`, `PipelineExecutor`, `HealthChecker`, `ConfigWatcher`, `FileSystemPluginLoader`, skill managers, `RetryLlm`, `RateLimiterLlm`, `TokenBucketRateLimiter`, `LlmReranker`/`NoopReranker`, `InMemoryMetrics`/`NoopMetrics`, `NoopTracer`, `NoopValidator`, `LlmAdapter`, `LlmProviderBridge`, `makeLlm`, `makeDefaultLlm`, `DefaultModelResolver` | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent-libs` |
| Interfaces: `IMetrics`, `ITracer`, `ISessionManager`, `IPluginLoader`, `IReranker`, `IOutputValidator`, `IModelResolver`, `IMcpConnectionStrategy`, `IPipeline`, pipeline DSL types, health DTOs | `@mcp-abap-adt/llm-agent-server` | `@mcp-abap-adt/llm-agent` |

`makeLlm`, `makeDefaultLlm`, and `makeRag` are now **async** (`Promise<ILlm>` / `Promise<IRag>`). Direct callers add one `await`. `resolveEmbedder(cfg, options)` remains synchronous and uses the existing prefetch contract — call `prefetchEmbedderFactories([...])` once at startup before sync resolves. Consumers that build SmartAgent only via `SmartAgentBuilder` are unaffected (the builder's `build()` is already async).
