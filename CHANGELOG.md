# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.3.0] — 2026-03-28

### Added

- **Presentation LLM** — optional secondary LLM for final response generation via new `present` pipeline stage. Configure with `.withPresentationLlm(llm)` on the builder. Falls back to mainLlm when not set. Reduces latency by 15-20s on generation-heavy responses by using a faster model (e.g., Gemini Flash) for presentation.
- **`PresentHandler`** stage handler — built-in pipeline stage registered as `present` type. Streams final response through the presentation LLM with configurable system prompt.
- **`SmartAgentBuilder.withPresentationLlm(llm)`** — fluent setter for injecting a presentation LLM.
- **`BuilderPromptsConfig.presentation`** — system prompt override for the presentation LLM.
- Hardcoded flow support — presentation LLM works in both structured pipeline and legacy hardcoded flow paths.

---

## [3.2.0] — 2026-03-24

### Added

- **`IModelProvider` interface** — new DI interface for model discovery and metadata. Exposes `getModel()` (current default model name) and `getModels()` (fetch available models from the provider). Companion type `IModelInfo` carries `id` and optional `owned_by`.
- **Per-request model override** — `CallOptions.model` optional field allows consumers to select a different model per request. Affects only the main LLM; classifier and helper models stay fixed.
- **`LlmAdapter` implements `IModelProvider`** — the default `ILlm` adapter now also provides model discovery. Options subset extraction makes the `CallOptions` → `AgentCallOptions` type boundary explicit.
- **`SmartAgentBuilder.withModelProvider()`** — fluent setter for injecting a custom `IModelProvider`. Auto-detection: if not explicitly set, the builder checks whether `mainLlm` (unwrapping `TokenCountingLlm`) implements `IModelProvider` and uses it automatically.
- **`SmartAgentHandle.modelProvider`** — optional field on the build result, available to consumers and `SmartServer`.
- **`TokenCountingLlm.wrappedLlm`** — accessor to unwrap the inner `ILlm` for auto-detection.
- **Dynamic `/v1/models` endpoint** — `SmartServer` now delegates to `IModelProvider.getModels()` instead of returning a hardcoded `"smart-agent"` entry. Falls back to `[{ id: 'smart-agent' }]` when no provider is available.
- **Model passthrough in responses** — `POST /v1/chat/completions` extracts `body.model`, passes it through `options.model` to the agent pipeline, and uses the real model name in all streaming chunks and non-streaming responses.
- **SAP AI Core model listing** — `SapCoreAIProvider.getModels()` fetches models via `ScenarioApi.scenarioQueryModels('foundation-models')` from `@sap-ai-sdk/ai-api` with a 60-second TTL cache. Falls back to `[{ id: this.model }]` if the API is unavailable.
- **`SapCoreAIProvider.setModelOverride()`** — per-request model override for SAP AI Core, cleared automatically via `try/finally` after each `chat()` / `streamChat()` call.
- **Agent subclass model propagation** — all four agent subclasses (`OpenAIAgent`, `DeepSeekAgent`, `AnthropicAgent`, `SapCoreAIAgent`) now propagate `options.model` to the provider HTTP request body.
- **Public API exports** — `IModelInfo`, `IModelProvider` exported from `@mcp-abap-adt/llm-agent`.
- **`@sap-ai-sdk/ai-api`** — added as optional peer dependency (`^2.0.0`) for SAP AI Core model listing.

### Changed

- **`LLMProvider.getModels()` return type widened** — from `Promise<string[]>` to `Promise<string[] | IModelInfo[]>`. Existing implementations returning `string[]` remain compatible.
- **`AgentCallOptions`** — added `model?: string` field for per-request model override propagation through the agent layer.
- **`/v1/models` response shape** — `context_window` field removed (was a synthetic value `2000000`). The `id` field now reflects the real provider model name.

---

## [3.1.0] — 2026-03-23

### Added

- **`IClientAdapter` interface** — pluggable per-request client detection and response wrapping. Registered adapters inspect the system prompt to auto-detect prompt-based clients (e.g. Cline) and wrap the final response in the format the client expects. No manual mode configuration needed.
- **`ClineClientAdapter`** — built-in adapter that detects Cline by `"You are Cline"` in the system prompt and wraps responses in `<attempt_completion><result>...</result></attempt_completion>` XML.
- **Plugin support for client adapters** — `PluginExports.clientAdapters` allows plugins to register custom adapters. Accumulated from all plugin sources.
- **`SmartServerConfig.clientAdapters`** — DI entry point for injecting client adapters programmatically.
- **`SmartAgentBuilder.withClientAdapter()`** — fluent setter for registering adapters via the builder.
- **Public API exports** — `IClientAdapter` (type) and `ClineClientAdapter` (class) exported from `@mcp-abap-adt/llm-agent`.

### Removed

- **`mode: 'cline'`** — removed from `SmartServerMode`, `SmartAgentConfig.mode`, and `SmartAgentBuilder.withMode()`. Cline support is now handled automatically via `IClientAdapter`.

### Fixed

- **`shouldRetrieve` gate** — RAG retrieval now triggers for any action with MCP clients or RAG stores, not only SAP-specific contexts.
- **Pass mode logging** — added `client_request` and `llm_response_pass` log steps in pass-through mode for diagnostics.

---

## [3.0.0] — 2026-03-22

### Breaking Changes

- **`SmartAgentRagStores` is now a generic type alias** — replaced the fixed `{ facts: IRag; feedback: IRag; state: IRag }` interface with `Record<K, IRag>`. The library no longer dictates store names — consumers define their own key union type for type safety (e.g. `SmartAgentRagStores<'facts' | 'tools' | 'feedback'>`). Existing code that passes `{ facts, feedback, state }` continues to compile.

- **`IContextAssembler.assemble()` signature changed** — the `retrieved` parameter changed from `{ facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }` to `{ ragResults: Record<string, RagResult[]>; tools: McpTool[] }`. Custom `IContextAssembler` implementations must be updated.

- **`IContextAssembler.assemble()` history parameter widened** — `history` now accepts `HistoryEntry[]` (union of `Message | ToolCallRecord`) instead of `Message[]`. The built-in `ContextAssembler` automatically converts `ToolCallRecord` items to `role: 'tool'` messages.

- **`PipelineContext.ragResults` type changed** — from fixed `{ facts; feedback; state }` to `Record<string, RagResult[]>`. Pipeline handlers that destructure specific store names should use bracket access with fallback (e.g. `ctx.ragResults['facts'] ?? []`).

- **`PipelineConfig.rag` type changed** — from `{ facts?; feedback?; state? }` to `Record<string, PipelineRagStoreConfig>`. Existing YAML configs with `facts`/`feedback`/`state` keys still work.

- **`SmartAgentBuilder` no longer creates default RAG stores** — if no stores are passed via `withRag()`, no RAG stores are created. Previously, three `InMemoryRag` instances were created automatically.

### Added

- **`HistoryEntry` type** — exported from `interfaces/assembler.ts`, union of `Message | ToolCallRecord`.
- **`SmartAgentRagStores` type export** — now exported from the public API (`src/index.ts`).
- **`ContextAssemblerConfig.sectionHeaders`** — optional `Record<string, string>` mapping store keys to display headers (defaults: `facts` → "Known Facts", `feedback` → "Feedback", `state` → "Current State"). Unknown keys are title-cased automatically.
- **`ToolCallRecord` handling in `ContextAssembler`** — tool call records in history are converted to `{ role: 'tool', content: '<name>: <result>' }` messages, with object results JSON-stringified.

### Fixed

- **`LlmClassifier` now propagates LLM error codes** — previously hardcoded `'LLM_ERROR'` for all LLM failures, now preserves the original error code (e.g. `'ABORTED'`).
- **RAG upsert store resolution** — subprompt type `'fact'` now resolves to store key `'facts'` via fallback (`type` → `type + 's'`), maintaining backward compatibility with the classifier's subprompt types.

### Migration guide

```typescript
// Before (2.x)
const assembler: IContextAssembler = {
  assemble(action, retrieved, history) {
    const { facts, feedback, state, tools } = retrieved;
    // ...
  }
};

// After (3.x)
const assembler: IContextAssembler = {
  assemble(action, retrieved, history) {
    const { ragResults, tools } = retrieved;
    const facts = ragResults['facts'] ?? [];
    const feedback = ragResults['feedback'] ?? [];
    // ...
  }
};
```

---

## [2.14.1] — 2026-03-20

### Changed

- **Cache `tools/list` in `McpClientAdapter` (#12)** — `listTools()` now returns a cached result after the first call instead of hitting the MCP server on every `process()` request. Cache is automatically invalidated on reconnect detection (unhealthy → healthy health-check transition).

### Deprecated

- **`refreshToolsPerIteration`** — this config option is now a no-op since tool lists are cached in the adapter.

---

## [2.14.0] — 2026-03-20

### Changed

- **`healthCheck()` no longer calls `listTools()` on MCP clients (#12)** — `SmartAgent.healthCheck()` now uses a lightweight MCP ping instead of a full `tools/list` JSON-RPC request. This eliminates unnecessary MCP server load when health is polled frequently (e.g. from a UI every few seconds).

  - **`IMcpClient`** gains an optional `healthCheck?(options?: CallOptions): Promise<Result<boolean, McpError>>` method. Existing plugin implementations are not affected (the method is optional).
  - **`MCPClientWrapper`** gains a `ping()` method that uses the MCP SDK's native ping for HTTP/stdio transports and is a no-op for embedded mode.
  - **`McpClientAdapter`** implements `healthCheck()` via `wrapper.ping()`.
  - **`SmartAgent.healthCheck()`** prefers `client.healthCheck()` when available, falling back to `client.listTools()` for `IMcpClient` implementations without the new method.

---

## [2.13.0] — 2026-03-19

### Added

- **DI support for `mcpClients` in SmartServer (#11)** — `SmartServer` and the plugin system now support injecting pre-built `IMcpClient[]` instances, matching the existing `skillManager` DI pattern. Three injection points:
  - **`SmartServerConfig.mcpClients`** — programmatic DI via config (highest priority).
  - **`PluginExports.mcpClients`** — plugin-based injection (accumulated from all plugins).
  - **YAML `mcp:` config** — existing fallback via builder auto-connect (unchanged).

  Resolution precedence: `config > plugin > YAML fallback`.

  This enables lazy MCP clients (via `lazy()` from v2.12.0) that connect on first use — the agent starts immediately and picks up MCP tools when the server becomes available.

  ```ts
  // Plugin example: lazy MCP client
  import { lazy, MCPClientWrapper, McpClientAdapter } from '@mcp-abap-adt/llm-agent';

  export const mcpClients = [lazy(() => {
    const w = new MCPClientWrapper({ transport: 'auto', url: process.env.MCP_URL });
    return w.connect().then(() => new McpClientAdapter(w));
  }, { retryIntervalMs: 15_000 })];
  ```

- **Plugin types updated** — `PluginExports`, `LoadedPlugins`, `emptyLoadedPlugins()`, and `mergePluginExports()` now support `mcpClients: IMcpClient[]`.
- **Plugin + builder tests** — 13 new tests covering `mergePluginExports` accumulation, `SmartAgentBuilder.withMcpClients()` integration, and SmartServer config precedence logic.

---

## [2.12.0] — 2026-03-19

### Added

- **Generic `lazy<T>` initialization utility (#10)** — opt-in proxy wrapper that defers construction of any async-method interface (`IMcpClient`, `IRag`, `IEmbedder`, `ISkillManager`, `ILlm`, etc.) to the first method call. Supports sync/async factories, mutex for concurrent callers, retry gating (`retryIntervalMs`), `onError` callback, and optional `fallback` delegation. Exported from main entry point: `lazy`, `LazyInitError`, `LazyOptions`.

---

## [2.11.3] — 2026-03-19

### Added

- **Re-exported external tool utilities from main entry point (#9)** — `normalizeAndValidateExternalTools`, `normalizeExternalTools`, `toToolCallDelta`, `getStreamToolCallName` and related types (`ExternalToolValidationCode`, `ExternalToolValidationError`) are now available directly from `@mcp-abap-adt/llm-agent`.

---

## [2.11.2] — 2026-03-19

### Fixed

- **CJS compatibility (#8)** — added `"default"` condition to all `package.json` exports so CJS consumers (e.g. SAP CAP projects with `"module": "commonjs"`) can resolve the package via `require()`.

### Added

- **Re-exported builder & adapter APIs from main entry point (#8)** — `SmartAgentBuilder`, `McpClientAdapter`, `LlmAdapter`, `makeLlm`, `makeDefaultLlm`, `makeRag`, `resolveEmbedder`, `ILlm`, `IMcpClient` are now available directly from `@mcp-abap-adt/llm-agent` without deep imports.

---

## [2.11.1] — 2026-03-18

### Added

- **Stand With Ukraine badge** in README.

---

## [2.10.4] — 2026-03-17

### Fixed

- **SapCoreAIProvider: move `tool_choice` to `model.params` (#7)** — `tool_choice: 'auto'` was incorrectly placed inside `prompt` object, causing SAP AI Core to return 400. Moved to `model.params` where it's forwarded to the underlying LLM as a model parameter.

---

## [2.10.3] — 2026-03-17

### Fixed

- **SapCoreAIProvider: missing `tool_choice` (#7)** — added `tool_choice: 'auto'` to the orchestration config when tools are present. Without it, Claude models via SAP AI Core would see tool definitions but never generate `tool_calls`, outputting text reasoning instead.

---

## [2.10.2] — 2026-03-17

### Fixed

- **MCP tool list refresh per iteration (#5)** — tool list is now re-fetched from all MCP servers on each tool-loop iteration (after the first). This ensures multi-step tasks have access to all available tools at every stage, not just the initial RAG-selected subset. Controlled via `refreshToolsPerIteration` config option (default: `true`). Both the default hardcoded flow and the structured pipeline `tool-loop` handler are updated.

---

## [2.10.1] — 2026-03-16

### Fixed

- **Health check timeout** — added 5s `AbortSignal.timeout()` so health probes no longer hang when endpoints are unresponsive. Each probe (LLM, RAG, MCP) is wrapped in independent try-catch so one failure doesn't block the others.
- **Pipeline YAML number coercion (#4)** — `${ENV_VAR}` substitution produces strings for numeric fields (`maxTokens`, `temperature`). All values are now coerced with `Number()` in `makeLlm()` and `SmartServer` composition root, preventing provider 400 errors.

---

## [2.10.0] — 2026-03-16

### Added

#### Plugin System

- **`IPluginLoader` interface** — abstracts plugin discovery. Consumers can replace the default filesystem scanner with custom loaders (npm packages, remote registries, databases, etc.).
- **`FileSystemPluginLoader`** — default implementation. Scans directories for `.js`, `.mjs`, `.ts` files and dynamically imports them. Default directories: `~/.config/llm-agent/plugins/` (user-level), `./plugins/` (project-level).
- **`builder.withPluginLoader(loader)`** — injects a plugin loader into the builder. During `build()`, the loader's `load()` is called and all discovered registrations are applied. Explicit `withXxx()` calls take precedence over plugin-loaded registrations.
- **`SmartServerConfig.pluginLoader`** — accepts a custom `IPluginLoader` for server-level plugin injection.
- **`pluginDir` in YAML config** and **`--plugin-dir` CLI flag** — additional directory for the default filesystem loader.
- **`emptyLoadedPlugins()`** and **`mergePluginExports()`** — helper utilities for custom loader authors. A custom loader can be written in ~10 lines.
- **`PluginExports` interface** — defines what a plugin module can export: `stageHandlers`, `embedderFactories`, `reranker`, `queryExpander`, `outputValidator`.

#### Shared Type Exports

- **`CallOptions`, `LlmTool`, `RagError`, `RagResult`, `Result`** — exported from the package for plugin authors who need these types in handler signatures.

#### Plugin Examples

- 6 reference plugin implementations in `docs/examples/plugins/`:
  - `01-audit-log.ts` — request logging stage handler
  - `02-content-filter.ts` — output validator blocking sensitive content
  - `03-score-reranker.ts` — reranker with prefix boost and recency decay
  - `04-rate-limiter.ts` — sliding-window rate limiter per session
  - `05-custom-embedder.ts` — Cohere embedder factory for YAML selection
  - `06-multi-export.ts` — multiple export types in one plugin file

### Fixed

- **Tool discovery independent of classifier** — `tool-select` stage now always runs regardless of `shouldRetrieve` flag. When RAG retrieval was skipped (e.g. classifier detected non-SAP context), `ToolSelectHandler` performs its own facts RAG query to ensure tools are always discoverable.

---

## [2.9.2] — 2026-03-15

### Fixed

- **`maxTokens` not passed from YAML pipeline config to LLM providers** — `makeLlmFromProvider()` now reads `maxTokens` from `PipelineLlmProviderConfig` and forwards it to all provider constructors (OpenAI, Anthropic, DeepSeek, SAP AI Core). Previously the value was silently ignored, making it impossible to control output token limits via `smart-server.yaml`. (#2)

---

## [2.9.1] — 2026-03-15

### Changed

- **Default `maxTokens` raised from 2000 to 4096** for OpenAI, Anthropic, and DeepSeek providers (both agent and LLM provider layers). SAP AI Core already used 16384 and was not changed.

---

## [2.9.0] — 2026-03-15

### Fixed

- **SapCoreAIProvider: `prompt.template` missing** — `createClient()` now always includes `prompt: { template: [] }` in orchestration config. Previously the Orchestration Service returned 400 ("Either a prompt template or messages must be defined").
- **SapCoreAIProvider: `messagesHistory` → `messages`** — `chat()` and `streamChat()` now use `messages` instead of `messagesHistory` in SDK calls. `messages` participates in prompt templating; `messagesHistory` does not, which caused 400 ("Unused parameters") errors.
- **SapCoreAIProvider: `max_tokens` default raised to 16384** — Previous default of 2000 was insufficient for tool-calling models (e.g. Claude) that generate reasoning before emitting `tool_calls`, causing truncated responses with `finish_reason: "length"`.

### Changed

- **`package.json` repository URL** — Corrected from `cloud-llm-hub` to `llm-agent`.

---

## [2.8.1] — 2026-03-15

### Added

- **Stream test client docs** — Documented `npm run client:test-stream` usage in `docs/EXAMPLES.md`: default and custom prompts, heartbeat/timing display, port override.
- **OpenAI-compatible client docs** — Added examples for connecting external clients (Goose, Continue, curl, Python openai SDK) to SmartServer's OpenAI-compatible endpoint. Includes available endpoints table and session management via `X-Session-Id`.

---

## [2.8.0] — 2026-03-11

### Changed

- **Stream test client** — Updated `scripts/test-stream-client.ts` to display SSE heartbeat (`💓`) and timing (`⏱️`) comments. Accepts custom message as CLI argument.

---

## [2.7.0] — 2026-03-11

### Added

- **SSE heartbeat during MCP tool execution** — While slow MCP tools (e.g. ABAP) are running, the streaming endpoint now emits periodic SSE comment lines (`: heartbeat tool=<name> elapsed=<ms>`). This keeps HTTP connections alive and prevents client/proxy timeouts without breaking OpenAI SSE protocol compliance — standard clients (Goose, Cline, etc.) silently ignore SSE comments per spec.
- **Timing breakdown** — Every streaming response now includes a detailed timing breakdown as an SSE comment (`: timing llm_call_1=1200ms tool_get_order=48500ms llm_call_2=2100ms total=52300ms`). Provides per-phase duration for LLM calls and MCP tool executions.
- **`heartbeatIntervalMs` config** — New `SmartAgentConfig` option (default: 5000ms) to control heartbeat frequency during tool execution.
- **`ToolHeartbeat` / `TimingEntry` types** — New fields on `LlmStreamChunk` for heartbeat and timing data, exported from `interfaces/types.ts`.
- **Heartbeat & timing tests** — 8 new tests covering heartbeat emission for slow/fast/concurrent tools, elapsed monotonicity, timing breakdown structure, and duration correctness.

---

## [2.6.0] — 2026-03-10

### Added

- **Provider unit tests** — 68 tests covering all 4 LLM providers (OpenAI, Anthropic, DeepSeek, SAP AI Core) and SAP Core AI Agent. Tests cover constructor validation, message formatting, tool conversion, credentials handling, and error paths.
- **SAP AI Core documentation** — `docs/SAP_AI_CORE.md` with architecture diagram, authentication methods (env var vs programmatic credentials), configuration reference, usage examples, tool format conversion, and troubleshooting guide.
- **Test scripts** — `test:providers`, `test:agents` npm scripts; updated `test:all` to include them.

### Fixed

- **Double tool conversion** — Removed redundant `convertToOrchestrationTools()` from `SapCoreAIProvider`. Tools are now converted once in the agent layer and passed through to `OrchestrationClient` directly.

---

## [2.5.0] — 2026-03-10

### Added

- **SAP AI Core programmatic credentials** — New `SapAICoreCredentials` interface allows passing `clientId`, `clientSecret`, `tokenServiceUrl`, and `servicUrl` directly to `SapCoreAIProvider`, bypassing the `AICORE_SERVICE_KEY` environment variable. Useful for multi-tenant scenarios and dynamic credential management.
- **Pipeline credential support** — `PipelineLlmProviderConfig` now accepts optional `credentials` for SAP AI Core provider.

### Changed

- **`apiKey` now optional in `LLMProviderConfig`** — Providers with custom auth flows (e.g. SAP AI Core OAuth2) no longer need a dummy API key. Existing providers (OpenAI, Anthropic, DeepSeek) still validate `apiKey` via `validateConfig()`.
- **Removed fake `'sap-ai-sdk-managed'` key** — CLI and pipeline no longer pass a placeholder API key when creating `SapCoreAIProvider`.

---

## [2.4.1] — 2026-03-02

### Fixed

- **Architecture docs** — Added request processing sequence diagram (Mermaid) showing full pipeline flow. Removed stale technical debt note about metrics (already implemented).

### Removed

- `docs/ROADMAP.md` — All planned phases complete; roadmap file removed.

---

## [2.4.0] — 2026-03-02

### Summary

Production hardening, advanced RAG retrieval, extended capabilities, and comprehensive documentation.
Adds circuit breakers, health endpoints, config hot-reload, hybrid BM25+vector search, reranking,
query expansion, Qdrant adapter, tool caching, parallel tool execution, output validation,
multi-turn token budget, and three new developer guides.

### Added

#### Production Hardening

- **Aggregate metrics** — `IMetrics` interface with `InMemoryMetrics` and `NoopMetrics` implementations. Counters: request, tool call, RAG query, classifier intent, LLM call, circuit breaker transition, cache hit. Histograms: request latency, LLM call latency.
- **Circuit breaker** — `CircuitBreaker` (closed → open → half-open) wrapping LLM and embedder calls. `CircuitBreakerLlm`, `CircuitBreakerEmbedder` decorators. `FallbackRag` auto-degrades to `InMemoryRag` when embedder circuit opens.
- **Health endpoint** — `GET /health` on SmartServer returning structured component diagnostics (LLM, RAG, MCP status, uptime).
- **Config hot-reload** — `ConfigWatcher` watches `smart-server.yaml` with `fs.watch` + debounce. Hot-reloadable: RAG weights, query K, summarize limit, query expansion flag.

#### Advanced RAG & Retrieval

- **Reranking** — `IReranker` interface between RAG query and context assembly. `LlmReranker` (LLM-based relevance scoring) and `NoopReranker` (pass-through).
- **BM25 inverted index** — `InvertedIndex` with O(1) term lookup replacing O(n) corpus scan. BM25 scoring with k1=1.2, b=0.75.
- **Query expansion** — `IQueryExpander` interface. `LlmQueryExpander` (LLM-generated synonyms) and `NoopQueryExpander`. Controlled by `queryExpansionEnabled` config.
- **Qdrant adapter** — `QdrantRag` persistent vector store adapter with TTL, namespace filtering, and collection auto-creation.

#### Extended Capabilities

- **Tool result caching** — `IToolCache` interface. `ToolCache` with configurable TTL and SHA-256 key hashing. `NoopToolCache` for opt-out. Keyed by `(toolName, argsHash)`.
- **Parallel tool execution** — Independent tool calls executed concurrently via `Promise.all`.
- **Output validation** — `IOutputValidator` interface called after LLM response. `NoopValidator` default. `ValidationResult` supports corrected content.
- **Multi-turn token budget** — `ISessionManager` interface. `SessionManager` tracks cumulative tokens, triggers auto-summarization when budget exceeded. `NoopSessionManager` for opt-out.

#### Documentation

- **Deployment guide** (`docs/DEPLOYMENT.md`) — Docker multi-stage builds, docker-compose (llm-agent + Qdrant + Ollama), systemd unit files, serverless patterns, horizontal scaling, monitoring, backup, security checklist.
- **Performance tuning guide** (`docs/PERFORMANCE.md`) — RAG weight tuning, BM25 internals, model selection guidelines, token budget trade-offs, tool cache TTL, query expansion, circuit breaker behavior.
- **Integration guide** (`docs/INTEGRATION.md`) — Code examples for all pluggable interfaces: `ILlm`, `IRag`, `IMcpClient`, `IReranker`, `IOutputValidator`, `IQueryExpander`, `ISubpromptClassifier`, `IContextAssembler`, `IMetrics`, `ITracer`, `ISessionManager`, `IToolCache`. Builder wiring and test doubles.

#### Testing

- **Intent classification benchmark** — 22-entry golden corpus across 5 intent types (action, fact, chat, state, feedback). Metrics: type accuracy, count accuracy, per-type precision/recall, multi-intent decomposition. CI-integrated via `npm run test:classifier-bench`.

### Changed

- `SmartAgentBuilder` — new fluent methods: `.withMetrics()`, `.withCircuitBreaker()`, `.withReranker()`, `.withQueryExpander()`, `.withToolCache()`, `.withOutputValidator()`, `.withSessionManager()`.
- `test:all` script now includes classifier benchmark.

---

## [2.2.0] — 2026-02-27

### Summary

Token usage reporting now works for all LLM providers (DeepSeek, OpenAI, Anthropic, SAP AI Core).
Previously streaming responses always returned `{prompt_tokens: 0, completion_tokens: 0}`.

### Fixed

- **Streaming token usage** — `streamOpenAICompatible()` now extracts `usage` from any SSE chunk,
  not only from empty-choices chunks.  Covers DeepSeek (which may include usage alongside the
  last choice) and OpenAI (separate usage-only chunk).
- **TokenCountingLlm.streamChat()** — now accumulates `prompt_tokens`, `completion_tokens` and
  `total_tokens` from streaming chunks (was a no-op TODO).
- **AnthropicAgent streaming** — `streamLLMWithTools()` no longer throws
  `"Streaming is not implemented"`.  Falls back to a non-streaming `callLLMWithTools()` call and
  yields `text → usage → tool_calls → done` chunks so Anthropic works with the SmartAgent pipeline.

---

## [2.1.1] — 2026-02-26

### Summary

SAP AI Core integration rewritten using the official `@sap-ai-sdk/orchestration` SDK.
Replaces the raw HTTP stub with a production-ready provider that supports native tool calling
and streaming.

### Added

- `@sap-ai-sdk/orchestration` dependency for SAP AI Core access.
- `'sap-ai-sdk'` / `'sap'` provider option in CLI and pipeline config.
- Native function calling support in `SapCoreAIAgent` (extends `BaseAgent` directly).
- Streaming support in `SapCoreAIProvider` via `OrchestrationClient.stream()`.
- `SapCoreAIAgent` export from `src/agents/index.ts`.
- Environment variables: `AICORE_SERVICE_KEY`, `SAP_AI_MODEL`, `SAP_AI_RESOURCE_GROUP`.

### Changed

- `SapCoreAIProvider` — rewritten from raw axios/httpClient to `OrchestrationClient`.
  Authentication handled automatically via `AICORE_SERVICE_KEY` env var.
- `SapCoreAIAgent` — changed from `extends PromptBasedAgent` to `extends BaseAgent`
  with native tool calling (OpenAI function format).
- `SapCoreAIConfig` — dropped `destinationName` (was required) and `httpClient`;
  added `resourceGroup`.

### Fixed

- `SapCoreAIProvider.streamChat()` now works (previously threw "not implemented").
- Removed `"private": false` from `package.json` (npm treated it as private).

---

## [2.0.0] — 2026-02-26

### Summary

Major stable release that unifies the Smart Agent implementations, strengthens protocol boundaries,
and formalizes the embeddable component architecture.

### Added

- OpenAI-compatible SmartServer boundary hardening for request validation and streaming behavior.
- External tools validation modes at API boundary:
  - `permissive` (drop invalid tool payloads with diagnostics),
  - `strict` (reject invalid payloads with `400 invalid_request_error`).
- Session-scoped tool availability registry with TTL-based temporary blocking for context-invalid tools.
- Public embedding and testing surfaces documented and stabilized:
  - `@mcp-abap-adt/llm-agent/smart-server`
  - `@mcp-abap-adt/llm-agent/testing`
- Architecture documentation updates with explicit internal interfaces, default implementations,
  and dependency graph.

### Changed

- Unified branch implementation merged into `main` as the release baseline.
- Runtime profile and examples aligned to DeepSeek-first configuration.
- Documentation set reorganized:
  - examples and assistant guidance moved under `docs/`,
  - implemented plans/comparisons moved to `docs/archive/`.
- Tool-call/message normalization improved for compatibility with strict upstream providers
  (including preservation of required `tool_call_id` links).

### Fixed

- Streaming failure path where malformed or incompatible tool-call history could trigger upstream
  `invalid_request_error` in strict OpenAI-compatible backends.
- Multiple protocol-edge behaviors around external tools and context filtering now produce
  deterministic diagnostics instead of silent degradation.

### Notes

- Version bump is **major** due to significant architecture/runtime behavior changes and
  expanded protocol contracts.
- Legacy pre-unification test suites (`agent`, `integration`, `e2e`, old logger-event checks)
  were marked as deprecated/skipped and require replacement with contract-aligned scenarios.

---

## [1.1.0-beta.3] — 2026-02-25

### Summary
Configuration and developer experience refinement. Exposes the full power of the multi-model 
pipeline and advanced routing modes in the YAML template.

### Added
- **Multi-Model Pipeline Documentation:** YAML generator now produces a template that 
  explicitly demonstrates how to configure separate LLMs for `main`, `classifier`, 
  and `helper` roles.
- **Routing Mode Documentation:** Clear descriptions for `hard`, `pass`, and `smart` 
  modes added to the YAML template.
- **Improved YAML Defaults:** Updated template with hybrid RAG weights and session 
  logging placeholders.

---

## [1.1.0-beta.2] — 2026-02-25

### Summary
Advanced architectural iteration focusing on semantic task decomposition, agent neutrality, 
and comprehensive session auditing. Introduces "Smart 2.0" orchestration logic.

### Added
- **Smart 2.0 Orchestration:** Single-turn unified orchestration that handles multiple intents 
  in one LLM cycle while maintaining strict context isolation.
- **Semantic Intent Analysis:** Upgraded classifier that identifies task context (math, sap-abap, general) 
  and dependencies to apply appropriate personas and tools.
- **Session Debug Logging:** Comprehensive audit system that logs every step of the agent pipeline 
  into a structured directory hierarchy (`sessions/session_id/req_id/`).
- **Contextual Tool Filtering:** Intelligent tool selection that hides specialized SAP tools 
  during general tasks (like simple math) to prevent model hallucinations and bias.
- **Radical Neutrality:** Improved translation and system prompts to ensure the agent remains 
  a neutral assistant unless explicitly performing technical SAP/ABAP work.

### Fixed
- **Streaming Protocol Errors:** Fixed a critical issue where tool call arguments were 
  passed as objects instead of strings in SSE chunks.
- **Agent Initiative Loops:** Resolved cases where the agent would take unnecessary initiative 
  on simple tasks due to technical context "poisoning".
- **Message History Duplication:** Eliminated redundant user messages in the history during 
  multi-step processing.
- **TypeScript Type Safety:** Resolved several structural and role-typing issues in `SmartAgent` 
  and `SmartServer`.

---

## [1.1.0-beta.1] — 2026-02-24

### Summary
Major architectural upgrade focused on production-grade streaming, hybrid search quality, 
stability, and multi-intent orchestration. Prepares the agent for complex SAP/ABAP workflows.

### Added
- **Command Postfix:** Renamed the global CLI command to `llm-agent-beta` for this release.
- **Real Incremental Streaming:** Implemented true per-token streaming for both text and 
  tool-call deltas, fully compliant with OpenAI SSE protocol.
- **Hybrid RAG Search:** Combined semantic vector similarity with BM25 lexical scoring for 
  precise technical term matching (e.g., SAP table names like T100, MARA).
- **Flexible Embedding Layer:** Introduced `IEmbedder` interface with support for Ollama 
  and OpenAI-compatible embedding providers.
- **Hybrid Tool Orchestration:** Agent now seamlessly merges internal MCP tools with 
  external client tools (Cline/Goose), handling execution or delegation automatically.
- **Multi-Intent Fast-path:** New `chat` intent for instant responses to simple math/greetings, 
  bypassing the heavy RAG/Tool pipeline.
- **Reasoning Mode:** Optional transparent thought process via `<reasoning>` blocks 
  (enabled via `--agent-show-reasoning` or YAML).
- **Startup Health Checks:** Immediate diagnostic probes for LLM, RAG, and MCP connectivity on server start.
- **Helper LLM Integration:** Dedicated secondary model support for background tasks like 
  RAG query translation and conversation history summarization.
- **Externalized Prompts:** All internal system prompts (classifier, translation, summary, 
  reasoning) are now configurable via `smart-server.yaml`.
- **Hallucination Guard:** Automatic validation of tool calls against known inventory to 
  prevent agent hangs on impossible tasks.
- **RAG Namespace Filtering:** Added support for project/session isolation via metadata filters.

### Fixed
- **DeepSeek/OpenAI Protocol Compliance:** Fixed 400 Bad Request errors by implementing surgical 
  message formatting (strict `content: null` for tool calls, no `null` for user/system roles).
- **Agent Cycle Conflicts:** Resolved issues where client agents (Goose) would try to 
  re-execute tools already handled by SmartAgent.
- **Connection Resilience:** Added exponential backoff retries for embedding providers 
  and auto-reconnect logic for MCP servers.
- **URL Handling:** Robust matching for `/v1/chat/completions` ignoring trailing slashes 
  and query parameters.

### Changed
- Refactored `OllamaRag` into a modular `VectorRag` + `OllamaEmbedder` architecture.
- Promoted `SmartAgent` to be the primary router for all server requests.

---

## [1.0.1] — 2026-02-24

### Summary

Maintenance release focused on package identity alignment and release documentation.

### Changed

- npm package renamed to `@mcp-abap-adt/llm-agent` across docs, import examples, CLI help text,
  and MCP client metadata.
- Package metadata updated to reflect component-first positioning (Smart LLM-agent building blocks
  first, default server implementation second).
- Documentation set reorganized and expanded:
  - added beta testing plan and incremental streaming plan,
  - archived legacy architecture analysis/roadmap documents under `docs/archive/`.

---

## [1.0.0] — 2026-02-24

### Summary

First stable release. Introduces **SmartAgent** — a full multi-turn, RAG-driven, MCP-orchestrated
agent — and **SmartServer** — an OpenAI-compatible HTTP server that wraps it. The existing thin-proxy
CLI is retained unchanged as a dev/testing convenience.

### Added

#### SmartAgent core (phases 1–8)

- **Phase 1 — Contracts** (`ILlm`, `IRag`, `IMcpClient`, `ILogger`, `SmartAgentDeps`)
  — all interfaces fully typed; `Result<T>` used throughout for explicit error handling.
- **Phase 2 — Adapters** (`LlmAdapter`, `McpClientAdapter`)
  — bridges existing `BaseAgent` / `MCPClientWrapper` into the new contract interfaces.
- **Phase 3 — RAG implementations**
  — `InMemoryRag` (TF-IDF keyword similarity, zero deps) and `OllamaRag` (neural embeddings via
  Ollama `/api/embed`); configurable dedup threshold.
- **Phase 4 — Classifier** (`SubpromptClassifier`)
  — LLM-based intent classification; routes messages to the correct retrieval path.
- **Phase 5 — Context assembler** — token-budget-aware message window assembly.
- **Phase 6 — Orchestrator** (`SmartAgent`)
  — multi-turn tool loop with RAG-based tool preselection, cross-lingual query translation,
  configurable `maxIterations` / `maxToolCalls` guards.
- **Phase 7 — SmartServer** (`SmartServer`)
  — OpenAI-compatible HTTP server; exposes `/v1/chat/completions`, `/v1/models`, `/v1/usage`;
  supports streaming (`stream: true`) and non-streaming modes.
  Routing modes: `smart` | `passthrough` | `hybrid`.
- **Phase 8 — Observability** (`ConsoleLogger`, structured JSON log events)
  — `pipeline_start`, `classify`, `rag_query`, `rag_translate`, `tool_preselect`, `tool_call`,
  `pipeline_done`, `pipeline_error` event types; `DEBUG_SMART_AGENT=true` env var.

#### Security (phase 9)

- `ToolPolicyGuard` — allowlist/denylist policy enforcement per tool call.
- `HeuristicInjectionDetector` — prompt-injection heuristic guard on tool results.
- Both guards wired into `SmartAgent` and configurable via `SmartAgentDeps`.

#### SmartAgentBuilder

- Fluent builder API (`SmartAgentBuilder`) for programmatic wiring of all SmartAgent components.
- Sensible defaults: DeepSeek LLM, InMemoryRag for all stores, no MCP.
- Override methods: `.withMainLlm()`, `.withClassifierLlm()`, `.withRag()`, `.withMcpClients()`,
  `.withLogger()`, `.withPolicy()`.
- Multi-MCP support: `mcp` accepts a single config or an array; all servers are connected and
  tool-vectorized during `build()`.

#### YAML pipeline configuration

- `pipeline:` section in `smart-server.yaml` for advanced multi-component setups:
  - `pipeline.llm.main` / `pipeline.llm.classifier` — independent LLM providers per role
    (supports `deepseek`, `openai`, `anthropic`).
  - `pipeline.rag.facts` / `pipeline.rag.feedback` / `pipeline.rag.state` — per-store RAG backends.
  - `pipeline.mcp` — array of MCP server configs (HTTP or stdio).
- Backwards compatible: existing flat `llm:` / `rag:` / `mcp:` config works unchanged.
- When `pipeline.llm.main` is set, flat `llm.apiKey` is not required.

#### CLI (`llm-agent`)

- `llm-agent` binary (entry point: `dist/smart-agent/cli.js`).
- Auto-generates `smart-server.yaml` template and exits on first run (no config file found).
- All YAML settings overridable via CLI flags (`--port`, `--llm-api-key`, `--rag-type`, etc.).
- `--config`, `--env` flags for non-default file locations.

#### Developer experience

- `SmartAgentBuilder` exported for programmatic embedding (see `EXAMPLES.md` S7).
- `SmartServer` exported for programmatic embedding (see `EXAMPLES.md` S6).
- `testing` sub-path export for test utilities.
- `smart-server` sub-path export for direct SmartServer import.
- `release:check` npm script: lint + build + full test suite.

#### Documentation

- `QUICK_START.md` — end-to-end guide: install → config → connect IDE.
- `docs/ARCHITECTURE.md` — full architecture reference including SmartAgent internals, pipeline
  config, and programmatic API.
- `docs/BETA_TESTING_PLAN.md` — 11 manual verification scenarios (T1–T11).
- `docs/SECURITY_THREAT_MODEL.md` — threat model for the agent layer.
- `EXAMPLES.md` — 7 SmartServer usage examples (S1–S7).
- `docs/INCREMENTAL_STREAMING_PLAN.md` — open research questions and design sketch for true
  incremental streaming (next iteration).

### Changed

- `ragQueryK` default: 5 → 10.
- `SmartAgentBuilderConfig.mcp` now accepts `BuilderMcpConfig | BuilderMcpConfig[]`.

### Deprecated

- Thin-proxy CLI (`npm run dev`, `npm run dev:llm`) — retained for dev/testing; no planned removal.

---

## [0.0.1] — initial

Initial scaffolding: thin LLM proxy, BaseAgent template, OpenAI / Anthropic / DeepSeek provider
adapters, MCPClientWrapper multi-transport abstraction.
