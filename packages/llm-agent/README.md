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
