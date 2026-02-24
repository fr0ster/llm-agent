# Smart Orchestrated Agent - Implementation Roadmap

Draft roadmap based on [`SMART_AGENT_ARCHITECTURE.md`](./SMART_AGENT_ARCHITECTURE.md).

---

## Phase 1 - Contracts (`src/smart-agent/interfaces/`) ✅

- [x] `ILlm` - chat/completion: `chat(messages, tools?) → LLMResponse`
- [x] `IMcpClient` - `listTools() → Tool[]`, `callTool(name, args) → ToolResult`
- [x] `IRag` - `upsert(text, metadata)`, `query(text, k) → RagResult[]`
- [x] `ISubpromptClassifier` - `classify(text) → Subprompt[]` (types: `fact | feedback | state | action`)
- [x] `IContextAssembler` - `assemble(action, retrieved, toolResults) → ContextFrame`
- [x] Shared types: `Subprompt`, `ContextFrame`, `RagResult`, `AgentConfig`

Definition of Done
- [x] Contracts define typed success/error envelopes and timeout/cancellation semantics
- [x] Tool call/result schemas are explicit and versioned
- [x] All interfaces include trace/context propagation fields where needed

Validation
- [ ] [CI]     Contract tests for each interface pass using deterministic test doubles
- [ ] [manual] Backward compatibility with existing adapter expectations is verified

---

## Phase 2 - Existing Code Adapters (`src/smart-agent/adapters/`) ✅

- [x] `LlmAdapter` - wraps existing `BaseAgent` subclasses into `ILlm`
- [x] `McpClientAdapter` - wraps `MCPClientWrapper` into `IMcpClient`

Goal: the new architecture should not duplicate provider HTTP logic, but reuse the existing layer.

Definition of Done
- [x] Adapters preserve existing provider behavior for success and failure paths
- [x] Adapter output conforms to Phase 1 contracts without lossy mapping
- [x] Adapter-level timeout and cancellation behavior is deterministic

Validation
- [x] [CI]     Integration tests cover nominal flows and edge cases (timeouts, malformed tool args, provider errors)
- [x] [manual] Golden-path smoke runs confirm no regression in current CLI behavior

---

## Phase 3 - Reference `IRag` Implementation (`src/smart-agent/rag/`) ✅

- [x] In-memory vector store with cosine similarity (separate instances for fact/feedback/state/tools)
- [x] Semantic deduplication on `upsert`: if a similar record already exists, update it instead of duplicating
- [x] TTL field in metadata; `query` filters out expired records

Definition of Done
- [x] Deterministic retrieval behavior for fixed embeddings in tests
- [x] Deduplication policy and similarity thresholds are configurable
- [x] Memory namespace model is defined (`tenant/user/session`)

Validation
- [x] [CI]     Unit tests cover deduplication, TTL expiry, and namespace isolation (12/12 pass)
- [x] [CI]     Load smoke test confirms bounded memory growth under repeated upserts

---

## Phase 4 - `ISubpromptClassifier` (`src/smart-agent/classifier/`) ✅

- [x] LLM-based classifier: system prompt with taxonomy, low temperature
- [x] Input: one user message → array of `Subprompt` with type and text
- [x] Cache the result for identical text within the request scope

Definition of Done
- [x] Classifier output schema is strict and validated
- [x] Confidence/ambiguity handling strategy is defined (fallback rules)
- [x] Prompt and temperature are versioned as config

Validation
- [x] [CI] 20/20 unit tests pass with deterministic stubs (intent types, parse errors, AbortSignal, cache)

---

## Phase 5 - `IContextAssembler` (`src/smart-agent/context/`) ✅

- [x] Builds `messages[]`: `action` + retrieved `facts` + `feedback` + `state` + `tools` + `toolResults`
- [x] Produces final `messages[]` array for `mainLlm.chat()`
- [x] Token limit: drops least-relevant entries if the frame exceeds the limit (tools → state → feedback → facts)

Definition of Done
- [x] Context prioritization policy is explicit and configurable
- [x] Token budgeting strategy is deterministic and observable
- [x] Context frame includes provenance metadata for debugging (`includeProvenance`)

Validation
- [x] [CI] 21/21 unit tests pass (over-limit frames, truncation order, snapshot, abort, provenance)

---

## Phase 6 - `SmartAgent` Orchestrator (`src/smart-agent/agent.ts`) ✅

- [x] DI constructor: `mainLlm`, `helperLlm`, `mcpClients[]`, `ragStores`, `classifier`, `assembler`, `config`
- [x] Single-request pipeline:
  - [x] Classification → subprompt array
  - [x] `fact/feedback/state` → `IRag.upsert()` into corresponding stores
  - [x] `action` → `IRag.query()` for facts/feedback/state/tools → `IContextAssembler.assemble()`
  - [x] Call `mainLlm.chat()` → tool loop (max `config.maxIterations`)
  - [x] Return final text response
- [x] Bounded tool loop: `maxIterations`, `maxToolCalls`, `timeoutMs` via merged AbortSignal

Definition of Done
- [x] Orchestrator enforces `maxIterations`, timeout, and max tool calls
- [x] Tool failures are recoverable and surfaced through a typed error path
- [x] Cancellation propagates across LLM call and MCP tool execution

Validation
- [x] [CI]     22/22 unit tests pass (multi-step tool loops, runaway-prevention, fault injection)
- [x] [CI]     Fault-injection tests cover MCP failures, empty retrieval, and classifier mistakes

---

## Phase 7 - OpenAI-Compatible HTTP Server (`src/smart-agent/server.ts`) ✅

- [x] `POST /v1/chat/completions` - accepts standard OpenAI format, returns `SmartAgent.process()`
- [x] Support `stream: false` (MVP); streaming comes separately after stabilization

Definition of Done
- [x] Endpoint compatibility with OpenAI request/response schema is documented and tested
- [x] Error codes and payloads are stable and contract-tested
- [x] Request-level timeout and idempotency behavior are defined

Validation
- [x] [CI]     15/15 API integration tests cover valid/invalid payloads, routing, agent errors, timeout, port
- [ ] [manual] Smoke test with real client SDK confirms wire compatibility

---

## Phase 8 - Observability ✅

- [x] Structured log at each step: classification, RAG hits/misses, tool calls, summary
- [x] `DEBUG_SMART_AGENT=true` in `.env` enables detailed output
- [x] Should not block release - minimal implementation is enough for debugging

Definition of Done
- [x] Trace correlation id is propagated across classifier, RAG, LLM, and MCP calls
- [x] Logs are structured, searchable, and redact sensitive fields
- [x] Structured log format is documented and compatible with standard observability tooling (e.g. OpenTelemetry-compatible JSON)

Validation
- [x] [manual] Observability smoke checks confirm trace continuity across full request lifecycle
- [x] [CI]     Redaction tests confirm secrets and sensitive payload fragments are not logged

---

## Phase 9 - Production Readiness ✅

- [x] Security guardrails for tool execution (allowlist/denylist, policy checks)
- [x] Prompt-injection mitigation policy for tool-using actions
- [x] Library exposes a `smartAgentEnabled` boolean config flag to allow consumer-side rollout control
- [x] Data governance policy: retention, purge, and session isolation

Definition of Done
- [x] Security threat model for tool execution surfaces is documented (attack surfaces, mitigations, known limitations)
- [x] `smartAgentEnabled` flag is respected at all entry points with no partial activation

Validation
- [x] [CI]     Unit tests cover allowlist/denylist enforcement and policy-check edge cases
- [x] [CI]     Prompt-injection test fixtures cover known injection patterns (role confusion, tool-call forgery)

> Note: Operational concerns (rollout strategy, SLO definition, monitoring dashboards, chaos testing)
> are the responsibility of the consumer. See DEPLOYMENT.md for guidance.

---

## Phase 10 - Tests and Hardening ✅

- [x] Shared test-double package (or export path) is available for consumers testing their own integrations
- [x] Component isolation test: replace only one real implementation, keep the rest as test doubles
- [x] End-to-end pipeline smoke test via embedded MCP + stub LLM
- [x] Regression suite for classifier, retrieval, and tool loop behavior
- [x] Release gate: lint/build/test all green

Validation
- [x] [CI]     12/12 regression tests pass (classifier routing, RAG config, tool loop, policy, session)
- [x] [CI]     12/12 integration tests pass (real ToolPolicyGuard, HeuristicInjectionDetector, InMemoryRag, ConsoleLogger)
- [x] [CI]     5/5 E2E tests pass (embedded MCP, tool errors, policy guard, HTTP round-trip)

---

## Phase 11 - SmartAgentBuilder + SmartServer + Pipeline Configuration ✅

- [x] `SmartAgentBuilder` fluent DI builder — wires all components with sensible defaults; each component overridable independently via `.with*()` methods
- [x] `SmartAgentBuilder.mcp` accepts single config or array — multiple MCP servers connected and tool-vectorized in a single `build()` call
- [x] `SmartServer` — embeddable OpenAI-compatible HTTP server backed by SmartAgent
- [x] Request routing modes: `smart`, `passthrough`, `hybrid` (auto-detects Cline)
- [x] `SmartServerConfig` — typed config with flat fields for all components
- [x] YAML-based configuration: `smart-server.yaml` with `${ENV_VAR}` substitution
- [x] `resolveSmartServerConfig` — merges CLI args > YAML > env vars > defaults
- [x] `llm-agent` CLI binary — auto-generates `smart-server.yaml` on first run, supports `--config`, `--env`, and all override flags
- [x] `pipeline:` YAML section — per-component overrides: main/classifier LLM providers, per-store RAG (facts/feedback/state), multi-MCP array
- [x] `makeLlmFromProvider()` — exhaustive switch over `deepseek | openai | anthropic`; returns `TokenCountingLlm`
- [x] `makeRagFromStoreConfig()` — creates `OllamaRag` or `InMemoryRag` from store config
- [x] LLM API key optional when `pipeline.llm.main.apiKey` is present (no flat `llm:` block required)
- [x] Classifier auto-reuses main LLM at 0.1 temp when `pipeline.llm.classifier` is absent

Definition of Done
- [x] Single `llm-agent` binary is sufficient to run the full stack from install
- [x] YAML config is self-documenting (fully commented template generated on first run)
- [x] Pipeline section is backwards compatible — existing YAML without `pipeline:` works unchanged
- [x] Type safety: `PipelineLlmProviderConfig.provider` is a union literal with exhaustive switch

Validation
- [ ] [manual] Beta smoke: fresh install → `llm-agent` → auto-generates config → edit `.env` → restart → server starts
- [ ] [manual] Connect Cline/Cursor to `http://localhost:3001/v1` and issue a tool-using request
- [ ] [manual] Multi-MCP array: two servers configured, tools from both appear in RAG query logs
- [ ] [manual] `pipeline.llm` with different providers for main and classifier — verify via `rag_translate` log entries
- [ ] [manual] `pipeline.llm.main` only (no flat `llm:`) — server starts, correct provider used
