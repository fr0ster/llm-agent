# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [8.0.5] — 2026-04-14

### Fixed
- **Streaming external tool_call deltas truncated** — the external tool delta filter only forwarded the first streaming delta (carrying the tool name); argument-only continuation deltas were silently dropped because `getStreamToolCallName()` returns `undefined` for them. Non-streaming clients received truncated or empty `tool_call` arguments. Both tool-loop paths (DefaultPipeline and hardcoded) now track external tool call indices on first sight and forward all subsequent deltas. `process()` also correlates continuation deltas by streaming index instead of requiring an `id`. Closes #92.

---

## [8.0.4] — 2026-04-13

### Fixed
- **External tools not reaching LLM in DefaultPipeline** — `DefaultPipeline.buildContext()` hardcoded `externalTools: []`, ignoring tools passed by the consumer. Normalized external tools are now propagated from `SmartAgent._runStructuredPipeline()` through `IPipeline.execute()` into the pipeline context. Closes #91.

---

## [8.0.3] — 2026-04-12

### Fixed
- **External tools excluded from availability registry blocking** — client-provided tools (e.g. `GenerateFile`) were incorrectly blocked by `ToolAvailabilityRegistry` after MCP execution errors, preventing them from reaching the LLM on subsequent requests within the same session. External tools are now exempt from both registry filtering and blocking, since they are executed client-side, not via MCP. Closes #91.

---

## [8.0.2] — 2026-04-12

### Fixed
- **Idempotent external tools normalization** — `SmartServer._handleChat` normalizes `body.tools` once, then `SmartAgent.streamProcess` normalized them again, doubling the `[client-provided]` description prefix. `normalizeExternalTool` now detects already-normalized tools and returns them unchanged. Closes #91.

### Added
- **External tools diagnostic logging** — two new `sessionLogger` steps (`external_tools_normalized`, `external_tools_merge`) trace externalTools through the hardcoded flow. Enabled when `logDir` is configured.

---

## [8.0.0] — 2026-04-12

### Added
- **`ISearchStrategy` interface** — pluggable scoring strategies for RAG: `WeightedFusionStrategy`, `RrfStrategy`, `VectorOnlyStrategy`, `Bm25OnlyStrategy`, `CompositeStrategy`.
- **`IQueryPreprocessor` / `IDocumentEnricher` interfaces** — `TranslatePreprocessor`, `ExpandPreprocessor`, `PreprocessorChain` for multilingual query preprocessing and LLM-based document enrichment.
- **`IToolIndexingStrategy`** — `OriginalStrategy`, `IntentStrategy`, `SynonymStrategy` for tool index document generation.
- **Per-store query translation** — `translateQueryStores` config for multilingual RAG search per store.

### Changed
- **Classifier disabled by default** in `DefaultPipeline`.

### Fixed
- **`ClassifyHandler`** populates `ragText` and `shouldRetrieve` from actions.

---

## [7.0.0] — 2026-04-11

### Added
- **`IEmbedder` returns `IEmbedResult`** with optional token usage tracking.
- **Embedding token usage logging** in `RagQueryHandler`.
- **`getEmbeddingModels()`** across all LLM providers, wired through `LlmAdapter` and REST endpoints.
- **`IModelFilter`** and `excludeEmbedding` filter for model listing endpoints.
- **`addRagStore()` / `removeRagStore()`** on `SmartAgent` for dynamic RAG store management.
- **Custom RAG store support** in `IPipeline` and `DefaultPipeline`.

### Fixed
- **Session-scoped default history RAG** — prevent cross-session leaks.
- **Removed dead tests** for removed RAG upsert flow.

---

## [6.0.0] — 2026-04-09

### BREAKING CHANGES
- **Removed default `facts`/`feedback`/`state` RAG stores** — llm-agent no longer creates domain-specific stores. The minimal default agent provides only MCP tool selection and conversation history.
- **Removed builder methods:** `withRag()`, `withRagUpsert()`, `withRagRetrieval()`, `withRagTranslation()`, `withPipeline(StructuredPipelineDefinition)`, `withStageHandler()`.
- **Removed `RagUpsertHandler`** — no auto-write from classifier subprompts.
- **Removed `StructuredPipelineDefinition`** from public API — consumers use `IPipeline` interface instead.
- **`SubpromptType` changed** from closed union (`'fact' | 'feedback' | 'state' | 'action' | 'chat'`) to extensible `'action' | 'chat' | (string & {})`.
- **SmartServer** no longer creates facts/feedback/state stores from YAML config.

### Added
- **`IPipeline` interface** — pipeline abstraction for request processing orchestration. Builder accepts via `setPipeline(IPipeline)`.
- **`DefaultPipeline`** — minimal, non-extensible pipeline: classify → summarize → parallel RAG query (tools + history) → rerank → skill-select → tool-select → assemble → tool-loop → history-upsert.
- **Plugin system** — `ISmartAgentPlugin`, `IRagStoreConfig`, `RagScope` types for consumer-defined stores via custom pipeline implementations.
- **Scope model** — `global` / `user` / `session` scopes with automatic metadata filtering in `RagQueryHandler`.
- **Builder DI methods** — `setToolsRag(IRag)`, `setHistoryRag(IRag)`, `setPipeline(IPipeline)` for dependency injection.
- **`IRag.clear()`** — optional method for session-scoped store cleanup. Implemented in `InMemoryRag` and `VectorRag`.
- **`userId` in `CallOptions`** — supports user-scoped RAG filtering.

### Changed
- **Two-level architecture** — Builder handles global DI (LLM, embedder, MCP, tools/history RAG, pipeline). Pipeline handles request orchestration.
- **Default classifier** knows only `action` and `chat` types. Consumer classifiers can return arbitrary string types.

### Migration
1. Replace `withRag()` → `setToolsRag()` / `setHistoryRag()`
2. Replace `withRagUpsert(false)` → pipeline handles upsert
3. Replace `withPipeline(structured)` → `setPipeline(new DefaultPipeline())`
4. Custom stores → implement `IPipeline` with `ISmartAgentPlugin`

---

## [5.19.2] — 2026-04-09

### Added
- **Docker deployment examples** — three ready-to-use Docker Compose setups:
  - `examples/docker-ollama/` — fully local (Ollama LLM + embeddings, no API keys)
  - `examples/docker-deepseek/` — DeepSeek LLM + Ollama embeddings
  - `examples/docker-sap-ai-core/` — SAP AI Core with Qdrant, plugins, skills, and compat layer

### Changed
- **Docs reorganized** — moved `QUICK_START.md` to `docs/`, removed `EXAMPLES.md` stub from root. Root now contains only standard files (`README.md`, `CHANGELOG.md`, `CLAUDE.md`, `AGENTS.md`).

---

## [5.19.1] — 2026-04-09

### Fixed
- **`getActiveConfig()` classifierModel always undefined** — `SmartAgent` constructor hardcoded `_classifierLlm = undefined` instead of reading it from deps. Added `classifierLlm?: ILlm` to `SmartAgentDeps` and pass it from the builder. Closes #80.

### Changed
- **Documentation** — updated `docs/ARCHITECTURE.md`: replaced non-existent `llm/` directory with `history/` in repo structure, added `history-upsert` stage handler to the stage types table and default pipeline diagram.

---

## [5.19.0] — 2026-04-09

### Added
- **Runtime configuration HTTP endpoints** — `GET /v1/config` returns active models and whitelisted agent parameters. `PUT /v1/config` applies partial runtime reconfiguration with atomicity (all-or-nothing). Supports model changes via `IModelResolver` interface and agent parameter updates via whitelist. Closes #78.
- **`IModelResolver` interface** — pluggable model name → `ILlm` resolution for HTTP config updates. `DefaultModelResolver` wraps `makeLlm()` with provider settings.
- **`SmartAgent.getAgentConfig()`** — returns a stable DTO of whitelisted runtime-safe config fields, decoupled from internal `SmartAgentConfig`.

---

## [5.18.1] — 2026-04-08

### Fixed
- **`baseURL` passthrough** — `makeLlm()` now forwards `baseURL` to OpenAI, Anthropic, and DeepSeek providers. `LlmProviderConfig` and `PipelineLlmProviderConfig` include `baseURL?: string` for custom OpenAI-compatible endpoints (Azure OpenAI, Ollama, vLLM). Closes #73.
- **Health check timeout** — `HEALTH_TIMEOUT_MS` is no longer hardcoded to 5 000 ms. New `SmartAgentConfig.healthTimeoutMs` (default 5 000) allows higher values for slow providers like SAP AI Core Orchestration. `NonStreamingLlm` now proxies `healthCheck()` to the inner LLM so the lightweight `getModels()` path is used instead of the `chat('ping')` fallback. Closes #71.

---

## [5.18.0] — 2026-04-07

### Added
- **Context recency window** — `ContextAssembler` now respects `historyRecencyWindow` config. Only the last N non-system messages from client history are included in the LLM context. Older messages are excluded (available via RAG if needed). Prevents LLM from re-processing old context on follow-up requests. YAML: `agent.historyRecencyWindow: 4`. Backward compatible — when not set, all messages included. Closes #69.

---

## [5.17.4] — 2026-04-07

### Changed
- **Documentation** — added per-provider `streaming: false` YAML examples to INTEGRATION.md and SAP_AI_CORE.md.

---

## [5.17.3] — 2026-04-07

### Added
- **Per-provider `streaming` flag** — `streaming: false` in pipeline LLM config disables streaming for that specific provider. `makeLlm()` wraps the LLM with `NonStreamingLlm` adapter when `streaming: false`. Enables mixed configurations (e.g. SAP AI Core non-streaming + DeepSeek streaming).

### Fixed
- **`llmCallStrategy` in default flow** — default hardcoded tool-loop now delegates LLM calls through `ILlmCallStrategy` instead of hardcoding `streamChat()`. Closes #68, closes #67.

---

## [5.17.2] — 2026-04-07

### Changed
- **Documentation** — added YAML `llmCallStrategy` configuration example to INTEGRATION.md.

---

## [5.17.1] — 2026-04-07

### Added
- **YAML `llmCallStrategy` config** — `agent.llmCallStrategy` in YAML/SmartServer config selects tool-loop strategy: `streaming`, `non-streaming`, `fallback`. For SAP AI Core with unstable streaming, set `non-streaming`.

---

## [5.17.0] — 2026-04-07

### Added
- **SAP AI Core streaming diagnostics** — `SapCoreAIProvider.streamChat()` now logs stream lifecycle events, compact message summaries, per-chunk progress, and enriched failure metadata (`streamOpened`, emitted chunk counts, status/response payload, cause/code) when a logger is injected. This is intended to diagnose SAP AI Core SSE failures that happen after successful tool execution.
- **Tool-loop iteration context logging** — the pipeline tool-loop now emits a compact context snapshot before each LLM iteration, including message roles, content lengths, tail previews, tool-call markers, and a heuristic flag for final post-tool-call passes. This makes it easier to correlate SAP AI Core streaming failures with the exact final context sent to the LLM.
- **YAML `llmCallStrategy` config** — `agent.llmCallStrategy` selects tool-loop LLM call strategy: `streaming` (default), `non-streaming`, or `fallback`. For SAP AI Core with unstable streaming, set `non-streaming` to use `chat()` instead of `streamChat()`.

### Changed
- **SAP AI Core operational guidance** — documentation now recommends non-streaming SAP AI Core usage for production when the final streaming response is unstable, while treating streaming as a controlled diagnostic path.

---

## [5.16.2] — 2026-04-07

### Removed
- **IToolResultCompactor** — removed entirely. Tool-loop passes full tool results between iterations without compaction. Large tool results are the MCP server's responsibility to fix at source (e.g. TSV instead of XML). Compacting/truncating tool results hides the problem and breaks LLM context.

---

## [5.16.0] — 2026-04-07

### Added
- **ILlmCallStrategy** — strategy pattern for tool-loop LLM calls. Three implementations: `StreamingLlmCallStrategy` (default, streamChat), `NonStreamingLlmCallStrategy` (chat, single chunk), `FallbackLlmCallStrategy` (streaming with auto-fallback to non-streaming on error, logs cause). Injected via `builder.withLlmCallStrategy()`. Replaces `toolLoopStreaming` config. Closes #64.
- **Rate limiter** — new `ILlmRateLimiter` interface and `TokenBucketRateLimiter` implementation (configurable requests/window). `RateLimiterLlm` decorator wraps outermost in the chain: `RateLimiterLlm → RetryLlm → CircuitBreakerLlm → LlmAdapter`. Injected via `builder.withRateLimiter()`. Closes #65.
- **LlmToolResultCompactor** — uses helper LLM to create meaningful summaries of large tool results (> threshold, default 1KB). Only large results are summarized, small pass through. Closes #66.
- **RagOnlyToolResultCompactor** — removes old tool results from context entirely. For RAG-managed history workflows where all history is retrieved at assembly time.
- **RetryLlm enabled by default** — builder now wraps mainLlm with `RetryLlm` (3 attempts, 2s backoff, retry on 429/500/502/503) even without explicit retry config.
- **Async IToolResultCompactor** — `compact()` now returns `Promise<Message[]> | Message[]` to support async LLM summarization.

### Fixed
- **MCP Accept header** — `MCPClientWrapper` now sends `Accept: application/json, text/event-stream` per MCP spec. Closes #63.

### Removed
- **`toolLoopStreaming` config** — replaced by `ILlmCallStrategy`. Use `builder.withLlmCallStrategy(new NonStreamingLlmCallStrategy())` for non-streaming mode.

---

## [5.15.0] — 2026-04-07

### Added
- **Non-streaming tool-loop mode** — `toolLoopStreaming: false` in `SmartAgentConfig` makes the tool-loop use `chat()` instead of `streamChat()`. Reliable fallback when SAP AI Core streaming fails. Closes #62.

### Fixed
- **MCP Accept header** — `MCPClientWrapper` now sends `Accept: application/json, text/event-stream` per MCP spec. Strict servers no longer return 406. Closes #63.

---

## [5.14.3] — 2026-04-07

### Fixed
- **MCP YAML headers passthrough** — `resolveSmartServerConfig()` now reads `mcp.headers` from YAML and passes it to `MCPClientWrapper`, enabling `x-sap-destination` proxy routing. Closes #60.

---

## [5.14.2] — 2026-04-07

### Changed
- **Documentation** — updated CHANGELOG (5.9.0–5.14.1), added SAP AI Core Direct Provider section to `SAP_AI_CORE.md`, updated agent hierarchy in `CLAUDE.md`.

---

## [5.14.1] — 2026-04-07

### Added
- **Tool result compaction strategy** — new `IToolResultCompactor` interface and `TruncatingToolResultCompactor` default implementation. When injected via `builder.withToolResultCompactor()`, the tool-loop compacts old tool results before each LLM iteration. Keeps last N (default 3) results full, truncates older ones. Prevents SAP AI Core HTTP 500 on large tool results. Closes #58.

### Fixed
- **SSE stream disconnect cause logging** — `SapCoreAIProvider.streamChat()` now logs the original cause error (`cause.message`, `cause.code`) from `@sap-ai-sdk/core` `ErrorWithCause`, enabling diagnosis of ECONNRESET/ETIMEDOUT issues. Refs #55.

---

## [5.14.0] — 2026-04-06

### Added
- **Token categorization** — `RequestSummary` now includes `byCategory` field with `initialization`, `auxiliary`, and `request` token breakdowns. `LlmCallEntry` extended with `estimated`, `scope`, and `detail` fields. `DefaultRequestLogger` splits storage into init (never reset) and request (reset per request) arrays. Estimated embedding tokens logged during tool/skill vectorization. Closes #53.
- **Batch embedding** — new `IEmbedderBatch` interface with `embedBatch()` implemented for OpenAI (chunked at 100), Ollama (`/api/embed`), and SAP AI Core. `IPrecomputedVectorRag` with `upsertPrecomputed()` for VectorRag/QdrantRag (shared `upsertKnownVector` write path). Builder uses batch path when available, falls back to sequential with throttling. Closes #52.
- **SAP AI Core Direct provider** — new `SapAiCoreDirectProvider` using `resolveDeploymentUrl()` + raw OpenAI-compatible HTTP, bypassing OrchestrationClient overhead (~14K phantom tokens). Registered as `sap-ai-core-direct` provider. Closes #54.
- **`skipModelValidation` option** — new option in `SmartAgentBuilderConfig` and `SmartServerConfig` to skip startup model validation (useful for testing).
- **New exports** — `IEmbedderBatch`, `IPrecomputedVectorRag`, `isBatchEmbedder`, `supportsPrecomputed`, `TokenBucket`, `TokenCategory`, `SapAiCoreDirectProvider`.

---

## [5.13.0] — 2026-04-06

### Added
- **Per-component token breakdown** — `byComponent` and `byModel` fields in `final_response` session log and usage chunk.
- **Pipeline variants** — configurable pipeline stage compositions.
- **DeepSeek streaming token usage** — streaming responses now include token usage.

---

## [5.12.1] — 2026-04-06

### Added
- **MCP headers support** — `MCPClientConfig.headers` for reverse proxy authentication (e.g. `x-sap-destination`).

---

## [5.12.0] — 2026-04-06

### Added
- **`llm-agent-check` CLI** — model health verification tool with `--config` mode for YAML pipeline verification.
- **Startup model validation** — builder validates configured models respond before starting the server. Aborts on failure.

### Fixed
- **Client model override** — prevent client-provided model name from overriding the LLM provider's configured model.
- **SSE cross-talk** — isolate HTTP agent per streaming request to prevent SSE chunk routing to wrong connections. Closes #46.
- **Tool re-selection** — restore selected tools when re-selection is skipped for read-only calls.

---

## [5.11.0] — 2026-04-06

### Added
- **Semantic history via RAG** — `IHistoryMemory` ring buffer + `IHistorySummarizer` for LLM-based turn summarization. `history-upsert` pipeline stage stores summaries. `ContextAssembler` injects Recent Actions and Relevant History. Closes #49.

---

## [5.9.1] — 2026-04-06

### Fixed
- **Pipeline stream reset** — `ToolLoopHandler` now handles mid-stream reset chunks (discards accumulated state and restarts accumulation).

---

## [5.9.0] — 2026-04-06

### Added
- **Mid-stream retry** — `RetryLlm` supports retrying on mid-stream errors. Stream emits a `reset` chunk before re-sending content.
- **HTTPS keepAlive agent** — SAP AI SDK streaming uses dedicated `https.Agent` for connection management.

### Fixed
- **SAP AI SDK streaming** — handle stream reset chunk in SmartAgent tool-loop.

---

## [5.8.1] — 2026-04-06

### Fixed
- **Health endpoint version** — `/v1/health` now returns the actual package version instead of hardcoded `0.0.0`. A prebuild script generates `src/generated/version.ts` from `package.json`, which `SmartServer` uses as the default when `config.version` is not provided. Closes #44.

---

## [5.8.0] — 2026-04-06

### Changed
- **Dynamic SAP AI Core model catalog** — `getModels()` now queries the `ScenarioApi.scenarioQueryModels()` endpoint at runtime instead of returning a hardcoded list. Returns only `text-generation` capable models with rich metadata: `displayName`, `provider`, `capabilities`, `contextLength`, `streamingSupported`, `deprecated`. Cached for 5 minutes with fallback to configured model on API failure.
- **Extended `IModelInfo` interface** — added optional fields: `displayName`, `provider`, `capabilities`, `contextLength`, `streamingSupported`, `deprecated`.
- **`/v1/models` endpoint** — now exposes the new model metadata fields (`display_name`, `provider`, `capabilities`, `context_length`, `streaming_supported`, `deprecated`).

---

## [5.7.1] — 2026-04-05

### Fixed
- **SAP AI Core model listing** — `getModels()` now returns the full catalog of chat models available through SAP AI Core orchestration service (~35 models across Azure OpenAI, GCP Vertex AI, AWS Bedrock, Perplexity, and AI Core Open Source) instead of only actively deployed models (typically 3). Aligns with what clients like Cline see when querying the provider directly.

---

## [5.7.0] — 2026-04-05

### Added
- **Per-model token usage breakdown** — `usage` in `SmartAgentResponse` and OpenAI-compatible HTTP responses now includes an optional `models` field with per-model `prompt_tokens`, `completion_tokens`, `total_tokens`, and `requests` counts. Enables cost attribution when the pipeline uses multiple models (classifier, helper, main). Closes #40.
- **Skill injection in default flow** — skills (SKILL.md files) matched via RAG are now injected into the system prompt in the default hardcoded flow, not only in the structured pipeline. Controlled by `skillInjectionEnabled` config flag (default `true` when `skillManager` is configured). Includes dedicated RAG fallback and `hard`-mode fallback for full parity with `SkillSelectHandler`. Closes #41.
- **`skill-select` in default pipeline** — the default pipeline definition now includes the `skill-select` stage between `rag-retrieval` and `tool-select`.

---

## [5.6.4] — 2026-04-05

### Fixed
- **SSE streaming usage** — streaming `/v1/chat/completions` now includes `usage` in the final SSE chunk when `reportUsage: true` (server config, default) **or** when the client sends `stream_options: { include_usage: true }`. Previously both conditions were required simultaneously, so clients like Goose and Cline always showed 0 tokens. Closes #39.

---

## [5.6.3] — 2026-04-05

### Fixed
- **SAP AI Core model listing** — `getModels()` now uses `DeploymentApi.deploymentQuery(status=RUNNING)` instead of `ScenarioApi.scenarioQueryModels()`. Returns only actively deployed models (deduplicated) instead of all registered models — eliminates non-working entries from the model list.

---

## [5.6.2] — 2026-04-05

### Fixed
- **Token usage in streaming** — `SapCoreAIProvider.streamChat()` now extracts `chunk.getTokenUsage()` from SAP AI SDK streaming chunks. Previously usage was always 0 in streaming mode, causing clients to show undercounted tokens.

---

## [5.6.1] — 2026-04-05

### Added
- **CLI: `--version` / `-v` flag** — prints `@mcp-abap-adt/llm-agent@<version>`.

### Fixed
- **SAP AI SDK error details** — error responses from SAP AI Core now include `error.response.data` body instead of just the HTTP status code. Makes 400/500 errors actionable.

### Added
- **Pipeline switching guide** — `docs/CLIENT_SETUP.md` documents that clients (Goose, Cline, Claude CLI) may need `context_limit` / `max_tokens` reconfiguration when switching llm-agent pipeline configs.

---

## [5.6.0] — 2026-04-05

### Added
- **`SapAiCoreEmbedder`** — `IEmbedder` implementation using `@sap-ai-sdk/orchestration` `OrchestrationEmbeddingClient`. Registered as `sap-ai-core` embedder factory. Enables semantic tool selection via SAP AI Core embedding models (e.g. `text-embedding-3-small`). Closes #38.
- **`in-memory` RAG type with embedder** — when `embedder` is specified in YAML for `type: in-memory`, automatically upgrades to `VectorRag` with hybrid scoring (vector 0.7 + BM25 0.3) instead of plain `InMemoryRag`.
- **CLI: `--version` / `-v` flag** — prints package name and version.

### Fixed
- **SAP AI SDK error details** — error responses from SAP AI Core now include the response body (`error.response.data`) instead of just the HTTP status code. Makes 400/500 errors actionable.

### Changed
- **`sap-ai-core.yaml`** — all RAG stores now use `sap-ai-core` embedder with `text-embedding-3-small`, replacing plain `in-memory` (which had no semantic matching). Tool selection scores improve from 0.11–0.16 (random) to proper semantic ranking.

---

## [5.5.2] — 2026-04-05

### Fixed
- **SAP AI SDK error details** — error responses from SAP AI Core now include the response body (`error.response.data`) instead of just the HTTP status code. Makes 400/500 errors actionable.

### Added
- **Pipeline switching guide** — `docs/CLIENT_SETUP.md` documents that clients (Goose, Cline, Claude CLI) may need reconfiguration (`context_limit`, `max_tokens`) when switching llm-agent pipeline configs.

---

## [5.5.1] — 2026-04-05

### Fixed
- **Pipeline configs: disable full tool refresh, enable RAG re-selection** — iterations 2+ were sending the entire MCP tool catalog (155 tools / 115KB) instead of the RAG-filtered subset (~26 tools). Set `refreshToolsPerIteration: false` and `toolReselectPerIteration: true` in both `deepseek.yaml` and `sap-ai-core.yaml`. Reduces per-iteration LLM input from ~45K tokens to ~8K tokens.

---

## [5.5.0] — 2026-04-05

### Added
- **`IRequestLogger` interface** — per-model, per-component token usage tracking. Replaces the mixed-token `TokenCountingLlm` approach with detailed analytics: `logLlmCall()`, `logRagQuery()`, `logToolCall()`, `getSummary()` with `byModel` and `byComponent` aggregations. Closes #37.
- **`DefaultRequestLogger`** — stores raw entries, aggregates on demand. Auto-resets state on `startRequest()` to prevent unbounded accumulation.
- **`NoopRequestLogger`** — empty implementation for consumers who don't need usage tracking.
- **`ILlm.model` property** — optional `readonly model?: string` on the LLM interface. All adapters (`LlmAdapter`, `RetryLlm`, `CircuitBreakerLlm`) expose the model name.
- **Builder: `.withRequestLogger(logger)`** — inject a custom `IRequestLogger`. Defaults to `DefaultRequestLogger` when not set.
- **`SmartAgentHandle.requestLogger`** — direct access to the request logger for per-model usage breakdown.
- **Pipeline integration** — `logLlmCall` in tool-loop, classifier, translate, summarize, query-expander; `logToolCall` in tool-loop (with cache hit tracking); `logRagQuery` in rag-query handler and tool reselect.
- **Exported types:** `IRequestLogger`, `LlmCallEntry`, `RagQueryEntry`, `ToolCallEntry`, `RequestSummary`, `LlmComponent`, `DefaultRequestLogger`, `NoopRequestLogger`.

### Fixed
- **YAML agent config fields silently dropped** — `toolReselectPerIteration`, `refreshToolsPerIteration`, `streamMode`, `heartbeatIntervalMs`, and `retry` were missing from the `resolveSmartServerConfig()` whitelist. These fields are now parsed and passed to the builder. Closes #36.

### Removed
- **`TokenCountingLlm`** — replaced by `IRequestLogger`. No longer exported.
- **`SmartAgentHandle.getUsage()`** — replaced by `handle.requestLogger.getSummary()`.
- **`SmartServerHandle.getUsage()`** — replaced by `handle.requestLogger.getSummary()`.
- **Builder: `.withUsageProvider()`** — replaced by `.withRequestLogger()`.

### Changed
- **`/v1/usage` endpoint** — now returns `RequestSummary` (`{ byModel, byComponent, ragQueries, toolCalls, totalDurationMs }`) instead of the old `TokenUsage` shape.
- **`makeLlm()` / `makeDefaultLlm()`** — return `ILlm` instead of `TokenCountingLlm`.

### Migration
```ts
// Before (5.4.0)
const usage = handle.getUsage();
// usage: { prompt_tokens, completion_tokens, total_tokens, requests }

// After (5.5.0)
const summary = handle.requestLogger.getSummary();
// summary.byModel['gpt-4o'] → { promptTokens, completionTokens, totalTokens, requests }
// summary.byComponent['tool-loop'] → { promptTokens, completionTokens, totalTokens, requests }
```

---

## [5.4.0] — 2026-04-05

### Added
- **`IMcpConnectionStrategy` interface** — injectable strategy for MCP client reconnection. Agent calls `strategy.resolve()` before listing tools, allowing recovery from MCP servers that were unavailable at startup. Closes #35.
- **Three built-in strategies:**
  - `NoopConnectionStrategy` — pass-through (default, backwards compatible)
  - `LazyConnectionStrategy` — on-demand slot-based reconnection with cooldown and concurrent-call dedup
  - `PeriodicConnectionStrategy` — background interval health probe with cached results
- **`createDefaultMcpClient` factory** — encapsulates `MCPClientWrapper` + `McpClientAdapter` creation for strategy implementations.
- **`McpConnectionConfig`, `McpClientFactory`, `ConnectionStrategyOptions`** — supporting types for custom strategy implementations.
- **Builder: `.withMcpConnectionStrategy(strategy)`** — fluent setter for injecting a connection strategy.

---

## [5.3.0] — 2026-04-04

### Added
- **`onBeforeStream` consumer hook** — optional `SmartAgentConfig.onBeforeStream` callback lets consumers transform or re-format the final response before streaming. Replaces the built-in presentation LLM stage with a flexible, consumer-controlled hook. Builder: `.withOnBeforeStream(hook)`. Closes #34.
- **`StreamHookContext` type** — exported context passed to the hook, containing the full `messages` array.

### Removed
- **`PresentHandler` pipeline stage** — the built-in presentation LLM re-generation stage has been removed. Consumers who need response re-formatting should use the `onBeforeStream` hook instead.
- **`withPresentationLlm()` builder method** — replaced by `withOnBeforeStream()`.
- **`presentationSystemPrompt` config field** — no longer needed; the hook gives full control to the consumer.

---

## [5.2.2] — 2026-04-04

### Added
- **`12-deepseek-mcp.yaml` example** — full agent options reference with commented advanced sections (multi-model pipeline, structured stages, custom prompts)
- Root-level `/*.yaml` in `.gitignore` for local test configs

### Changed
- **ARCHITECTURE.md** — expanded repository structure from 9 to 24 directories with descriptions
- **EXAMPLES.md** — added example 12 to the config table

---

## [5.2.2] — 2026-04-05

### Fixed
- **Token usage in streaming** — `SapCoreAIProvider.streamChat()` now extracts `chunk.getTokenUsage()` from SAP AI SDK streaming chunks. Previously usage was always 0 in streaming mode.

---

## [5.2.1] — 2026-04-03

### Changed
- Documentation: added `withToolReselection(true)` to INTEGRATION.md builder example

---

## [5.2.0] — 2026-04-03

### Added
- **Per-iteration RAG tool re-selection** — when `toolReselectPerIteration: true`, tool loop re-queries tools RAG store on each iteration > 0 using context-aware queries (error messages, Create→Update hints). Skip re-selection for read-only tools (Search/Read/Get/List). Builder: `.withToolReselection(true)`. Closes #32.

---

## [5.1.2] — 2026-04-02

### Added
- **`claude-via-agent` global binary** — installed alongside `llm-agent` via `npm install -g`, launches Claude CLI through the SmartAgent server.

---

## [5.1.1] — 2026-04-02

### Fixed
- **Request model no longer overrides pipeline LLM model** — adapters no longer pass the client-supplied `model` field into agent options, preventing unintended LLM model substitution.
- **`SapCoreAIProvider` SDK 2.9.0 compatibility** — messages are now passed in `prompt.template` as required by SAP AI Core SDK 2.9.0.
- **DeepSeek pipeline `maxTokens` capped at 8192** — aligns with the DeepSeek API limit; previously uncapped values caused API errors.
- **Launcher script cleanup on INT/TERM signals** — the agent process is now properly terminated on SIGINT/SIGTERM, preventing orphaned processes.

### Added
- **Separate pipeline configs per provider** — `pipelines/deepseek.yaml` and `pipelines/sap-ai-core.yaml` replace the single shared config, allowing per-provider tuning without mutual interference.
- **`claude-via-agent.ps1` PowerShell launcher** — Windows equivalent of `claude-via-agent.sh` for running Claude CLI through the agent on Windows.

### Changed
- **Single `.env` for all credentials** — all provider credentials are consolidated into one `.env` file; the launcher script auto-selects the pipeline based on `LLM_PROVIDER`.

---

## [5.1.0] — 2026-04-01

### Added
- **`ILlmApiAdapter` interface** — stateless singleton contract for protocol translation. Methods: `normalizeRequest()`, `transformStream()`, `formatResult()`, `formatError()` (optional). Throw `AdapterValidationError` for malformed requests.
- **`AnthropicApiAdapter`** — built-in adapter implementing the full Anthropic Messages API (`POST /v1/messages`). Implements the correct SSE event sequence: `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`.
- **`OpenAiApiAdapter`** — built-in adapter for OpenAI Chat Completions (`POST /v1/chat/completions`), extracted from the previous inline implementation.
- **`AgentCallOptions`** — unified options type for `process()` and `streamProcess()`, replacing the previous ad-hoc options shape.
- **Plugin system: `apiAdapters`** — plugins can now export `apiAdapters: ILlmApiAdapter[]` to register additional inbound protocol adapters.
- **`SmartServer` config: `apiAdapters` / `disableBuiltInAdapters`** — `apiAdapters` registers custom adapters alongside built-ins; `disableBuiltInAdapters: true` suppresses the built-in OpenAI and Anthropic adapters entirely.
- **Builder: `.withApiAdapter(adapter)`** — registers a custom `ILlmApiAdapter` instance.
- **`docs/CLIENT_SETUP.md`** — connection guide for Claude CLI, Cline, and Goose.
- **Provider-agnostic env vars in `smart-server.yaml`** — `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` replace provider-specific variable names.

### Changed
- **Binary renamed** from `llm-agent-beta` to `llm-agent`.

---

## [5.0.0] — 2026-03-31 ⭐ Stable baseline

Verified end-to-end with Cline and Goose via SAP AI Core (Claude Sonnet) + MCP ABAP tools. External tool propagation, mixed tool call handling, and streaming all work correctly.

### Fixed
- **Streaming `request_done` not logged** — SmartServer now logs `request_done` with `stream: true` and `durationMs` when SSE stream completes, matching the non-streaming path.

---

## [4.0.9] — 2026-03-31

### Fixed
- **LLM hallucinates tool calls when no suitable tool exists** — default system prompt now includes guidance: "When an action is impossible with available tools — say so clearly and do not attempt it." This gives the LLM explicit permission to refuse, preventing hallucinated tool calls. (#31)

---

## [4.0.8] — 2026-03-30

### Fixed
- **LLM chooses external tools over internal MCP tools** — external tool descriptions now prefixed with `[client-provided]` during normalization. Both tool loops inject a system prompt instruction: "Always prefer internal tools; use client-provided tools only when no internal tool can do the job." (#30)

---

## [4.0.7] — 2026-03-30

### Changed
- **`docs/superpowers/` removed from repo** — generated plans and specs are session-local, now gitignored.

---

## [4.0.6] — 2026-03-30

### Fixed
- **PresentHandler overwrites external tool call responses** — when the tool-loop ended with `finishReason: 'tool_calls'` for external tools, PresentHandler still executed with empty context, producing garbage output after the tool call SSE chunks. Now detects the external-call path and returns immediately. (#29)

---

## [4.0.5] — 2026-03-30

### Fixed
- **Mixed internal+external tool calls loop until maxIterations** — when LLM returned both internal MCP tool calls and external tool calls in one response, core ignored internal calls and only returned external to the client. The LLM kept re-requesting the unexecuted internal tools, causing a loop. Core now fires internal tools asynchronously while immediately returning external calls to the client. On the next request, pending internal results are awaited and injected into context. (#28)

### Added
- **`PendingToolResultsRegistry`** — per-session storage for in-flight internal tool call promises. TTL-based cleanup, consume-once semantics.
- **`fireInternalToolsAsync`** — shared helper for mixed-call handling, used by both default and pipeline tool loops.

---

## [4.0.4] — 2026-03-30

### Fixed
- **External MCP tool calls not propagated to client** — `mapStopReason()` in both `SmartAgentServer` and `SmartServer` mapped `tool_calls` to `length`/`stop`, so clients never received `finish_reason: "tool_calls"`. Non-streaming responses omitted `tool_calls` from the assistant message. `process()` ignored tool call deltas from the stream. All three paths now correctly propagate tool calls and finish reason.
- **`SmartAgentServer` did not forward `body.tools` to SmartAgent** — external tools from the HTTP request were silently dropped. The server now passes them as `externalTools`.
- **`SmartAgentServer` streaming SSE dropped tool_calls from first chunk** — the first SSE delta only included `role` and `content`, ignoring any tool call deltas. Fixed to include `tool_calls` in the first chunk delta.

### Changed
- **`StopReason` type** now includes `'tool_calls'` alongside `'stop'`, `'iteration_limit'`, and `'tool_call_limit'`.
- **`SmartAgentResponse`** gained optional `toolCalls` field (OpenAI wire format) for external tool call details.

---

## [4.0.3] — 2026-03-30

### Fixed
- **Qdrant/Vector RAG queries return 0 results** — `SmartServer` created per-store embedders for upsert but never wired a shared embedder for query time. Vector-based stores (`QdrantRag`, `VectorRag`) received `TextOnlyEmbedding` which rejects on `toVector()`, silently returning empty results. Added `FallbackQueryEmbedding` decorator — each vector store now falls back to its own embedder when the shared query embedder is absent. (#27)

### Added
- **`FallbackQueryEmbedding` class** — decorator that wraps any `IQueryEmbedding` with a store-level `IEmbedder` fallback. Memoized, same contract as `QueryEmbedding`. Exported in public API.

---

## [4.0.2] — 2026-03-30

### Fixed
- **YAML agent config fields not applied at startup** — `ragTranslationEnabled`, `ragRetrievalMode`, `ragUpsertEnabled`, `classificationEnabled`, `toolResultCacheTtlMs`, and `sessionTokenBudget` were only wired in the hot-reload path (`ConfigWatcher`) but missing from `resolveSmartServerConfig()`. Non-English RAG queries could be corrupted by the translation stage even when explicitly disabled in YAML. (#26)
- **Biome lint warnings** — replaced manual nullish checks with optional chaining in `deepseek.ts` and `openai.ts` SSE stream parsers.

---

## [4.0.1] — 2026-03-29

### Added
- **Husky pre-commit hook** — runs `biome check` before every commit to prevent lint failures from being committed.

### Fixed
- **`package-lock.json` now tracked in commits** — previously omitted during version bumps.

---

## [4.0.0] — 2026-03-29

### Breaking Changes

- **`IRag.query()` signature changed** — first parameter changed from `text: string` to `embedding: IQueryEmbedding`. All `IRag` implementations must accept `IQueryEmbedding` instead of a raw string. Callers must wrap query text in `QueryEmbedding` (with an `IEmbedder`) or `TextOnlyEmbedding` (for keyword-only stores). (#25)

### Added

- **`IQueryEmbedding` interface** — lazy, memoized query embedding that computes the vector on first `toVector()` call. Concurrent callers receive the same promise — only one actual API call regardless of store count.
- **`QueryEmbedding` class** — wraps `IEmbedder` + query text; memoizes the vector promise via `??=` operator.
- **`TextOnlyEmbedding` class** — fallback for stores that don't need vectors (e.g. `InMemoryRag`). Exposes `.text` for BM25/keyword search; rejects on `toVector()`.
- **`SmartAgentDeps.embedder`** — optional shared embedder field. When set, `SmartAgent` creates a single `QueryEmbedding` per request and passes it to all RAG stores.
- **`SmartAgentBuilder.withEmbedder()`** — fluent setter for injecting a shared embedder.
- **`PipelineContext.embedder`** and **`PipelineContext.queryEmbedding`** — pipeline support for shared embedding. `RagQueryHandler` lazily creates and caches the embedding; all parallel rag-query stages share the same memoized vector.
- **Public API exports** — `IQueryEmbedding` (type), `QueryEmbedding`, `TextOnlyEmbedding` exported from `@mcp-abap-adt/llm-agent`.

### Performance

- **N→1 embedding API calls** — with 7 Qdrant collections and SAP AI Core embeddings, RAG query stage drops from ~194s (7 redundant embed calls) to ~7s (single memoized call). (#25)

### Migration guide

```typescript
// Before (3.x)
const result = await ragStore.query('search text', 10, options);

// After (4.x) — with embedder (vector stores)
import { QueryEmbedding } from '@mcp-abap-adt/llm-agent';
const embedding = new QueryEmbedding('search text', embedder, options);
const result = await ragStore.query(embedding, 10, options);

// After (4.x) — without embedder (keyword-only stores)
import { TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
const embedding = new TextOnlyEmbedding('search text');
const result = await ragStore.query(embedding, 10, options);
```

---

## [3.4.0] — 2026-03-28

### Added

- **`RetryLlm` decorator** — `ILlm` decorator with exponential backoff for transient failures (HTTP 429, 500, 502, 503). Configurable via `SmartAgentConfig.retry`. For streaming, retries only when zero chunks have been yielded. Composition: `RetryLlm → CircuitBreakerLlm → LlmAdapter`. (#20)
- **`streamMode: 'final'`** — new `SmartAgentConfig.streamMode` option. Buffers intermediate tool loop iterations and streams only the final response. External tool calls and heartbeats always stream. Reduces context inflation for clients like Cline and Goose. (#21)
- **`reportUsage` config** — `SmartServerConfig.reportUsage` option (default `true`). When `false`, suppresses usage stats in SSE stream to prevent clients from misinterpreting internal token counts. (#23)
- **`warning` log event** — new `LogEvent` variant `{ type: 'warning', traceId, message }` for structured warnings from the builder.

### Fixed

- **Builder key-based RAG store lookup** — tool/skill vectorization now targets `ragStores.tools` explicitly instead of relying on `Object.values(ragStores)[0]` insertion order. Falls back to first store with a warning log when `tools` key is missing. (#17)
- **Idempotent RAG upsert** — `IRag.upsert()` contract now requires implementations to treat `metadata.id` as an idempotent key. `QdrantRag` uses deterministic UUID (SHA-256), `InMemoryRag` and `VectorRag` match by `metadata.id` before cosine dedup. Prevents duplicate vectors on server restart. (#18)
- **Per-item error handling in vectorization** — individual tool/skill embedding failures are now logged and skipped instead of aborting the entire MCP connection setup. (#19)
- **SSE error format** — errors during SSE streaming are now emitted as valid `chat.completion.chunk` objects instead of raw `{"error":{...}}`, making them parseable by OpenAI-compatible clients (Cline, Goose, Continue). Added `finishReason` safety net to guarantee every stream ends with a `finish_reason` chunk. (#22)

### Changed

- **TypeScript config** — `module` updated to `Node16`, `moduleResolution` to `node16` (required by TypeScript 6.x, replaces deprecated `ES2022`/`node`).

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
