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

## Phase 8 - Observability

- [ ] Structured log at each step: classification, RAG hits/misses, tool calls, summary
- [ ] `DEBUG_SMART_AGENT=true` in `.env` enables detailed output
- [ ] Should not block release - minimal implementation is enough for debugging

Definition of Done
- [ ] Trace correlation id is propagated across classifier, RAG, LLM, and MCP calls
- [ ] Logs are structured, searchable, and redact sensitive fields
- [ ] Structured log format is documented and compatible with standard observability tooling (e.g. OpenTelemetry-compatible JSON)

Validation
- [ ] [manual] Observability smoke checks confirm trace continuity across full request lifecycle
- [ ] [CI]     Redaction tests confirm secrets and sensitive payload fragments are not logged

---

## Phase 9 - Production Readiness

- [ ] Security guardrails for tool execution (allowlist/denylist, policy checks)
- [ ] Prompt-injection mitigation policy for tool-using actions
- [ ] Library exposes a `smartAgentEnabled` boolean config flag to allow consumer-side rollout control
- [ ] Data governance policy: retention, purge, and session isolation

Definition of Done
- [ ] Security threat model for tool execution surfaces is documented (attack surfaces, mitigations, known limitations)
- [ ] `smartAgentEnabled` flag is respected at all entry points with no partial activation

Validation
- [ ] [CI]     Unit tests cover allowlist/denylist enforcement and policy-check edge cases
- [ ] [CI]     Prompt-injection test fixtures cover known injection patterns (role confusion, tool-call forgery)

> Note: Operational concerns (rollout strategy, SLO definition, monitoring dashboards, chaos testing)
> are the responsibility of the consumer. See DEPLOYMENT.md for guidance.

---

## Phase 10 - Tests and Hardening

- [ ] Shared test-double package (or export path) is available for consumers testing their own integrations
- [ ] Component isolation test: replace only one real implementation, keep the rest as test doubles
- [ ] End-to-end pipeline smoke test via embedded MCP + stub LLM
- [ ] Regression suite for classifier, retrieval, and tool loop behavior
- [ ] Release gate: lint/build/test all green
