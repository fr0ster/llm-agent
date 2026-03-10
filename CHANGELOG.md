# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
