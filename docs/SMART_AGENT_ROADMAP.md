# Smart Orchestrated Agent - Implementation Roadmap

Draft roadmap based on [`SMART_AGENT_ARCHITECTURE.md`](./SMART_AGENT_ARCHITECTURE.md).

---

## Phase 1 - Contracts (`src/smart-agent/interfaces/`)

- [ ] `ILlm` - chat/completion: `chat(messages, tools?) → LLMResponse`
- [ ] `IMcpClient` - `listTools() → Tool[]`, `callTool(name, args) → ToolResult`
- [ ] `IRag` - `upsert(text, metadata)`, `query(text, k) → RagResult[]`
- [ ] `ISubpromptClassifier` - `classify(text) → Subprompt[]` (types: `fact | feedback | state | action`)
- [ ] `IContextAssembler` - `assemble(action, retrieved, toolResults) → ContextFrame`
- [ ] Shared types: `Subprompt`, `ContextFrame`, `RagResult`, `AgentConfig`

Definition of Done
- [ ] Contracts define typed success/error envelopes and timeout/cancellation semantics
- [ ] Tool call/result schemas are explicit and versioned
- [ ] All interfaces include trace/context propagation fields where needed

Validation
- [ ] Contract tests for each interface pass using deterministic test doubles
- [ ] Backward compatibility with existing adapter expectations is verified

---

## Phase 2 - Existing Code Adapters (`src/smart-agent/adapters/`)

- [ ] `LlmAdapter` - wraps existing `BaseAgent` subclasses into `ILlm`
- [ ] `McpClientAdapter` - wraps `MCPClientWrapper` into `IMcpClient`

Goal: the new architecture should not duplicate provider HTTP logic, but reuse the existing layer.

Definition of Done
- [ ] Adapters preserve existing provider behavior for success and failure paths
- [ ] Adapter output conforms to Phase 1 contracts without lossy mapping
- [ ] Adapter-level timeout and cancellation behavior is deterministic

Validation
- [ ] Integration tests cover nominal flows and edge cases (timeouts, malformed tool args, provider errors)
- [ ] Golden-path smoke runs confirm no regression in current CLI behavior

---

## Phase 3 - Reference `IRag` Implementation (`src/smart-agent/rag/`)

- [ ] In-memory vector store with cosine similarity (separate instances for fact/feedback/state/tools)
- [ ] Semantic deduplication on `upsert`: if a similar record already exists, update it instead of duplicating
- [ ] TTL field in metadata; `query` filters out expired records

Definition of Done
- [ ] Deterministic retrieval behavior for fixed embeddings in tests
- [ ] Deduplication policy and similarity thresholds are configurable
- [ ] Memory namespace model is defined (`tenant/user/session`)

Validation
- [ ] Unit tests cover deduplication, TTL expiry, and namespace isolation
- [ ] Load smoke test confirms bounded memory growth under repeated upserts

---

## Phase 4 - `ISubpromptClassifier` (`src/smart-agent/classifier/`)

- [ ] LLM-based classifier: system prompt with taxonomy, low temperature
- [ ] Input: one user message → array of `Subprompt` with type and text
- [ ] Cache the result for identical text within the request scope

Definition of Done
- [ ] Classifier output schema is strict and validated
- [ ] Confidence/ambiguity handling strategy is defined (fallback rules)
- [ ] Prompt and temperature are versioned as config

Validation
- [ ] Evaluation set exists for common and ambiguous prompts
- [ ] Misclassification regression suite runs in CI with deterministic stubs where possible

---

## Phase 5 - `IContextAssembler` (`src/smart-agent/context/`)

- [ ] Builds `ContextFrame`: `action` + retrieved `facts` + `feedback` + `state` + `tools` + `toolResults`
- [ ] Produces final `messages[]` array for `mainLlm.chat()`
- [ ] Token limit: drops least-relevant entries if the frame exceeds the limit

Definition of Done
- [ ] Context prioritization policy is explicit and configurable
- [ ] Token budgeting strategy is deterministic and observable
- [ ] Context frame includes provenance metadata for debugging

Validation
- [ ] Tests cover over-limit frames and relevance-based truncation behavior
- [ ] Snapshot tests verify stable `messages[]` assembly for fixed inputs

---

## Phase 6 - `SmartAgent` Orchestrator (`src/smart-agent/agent.ts`)

- [ ] DI constructor: `mainLlm`, `helperLlm`, `mcpClients[]`, `ragStores`, `classifier`, `assembler`, `config`
- [ ] Single-request pipeline:
  - [ ] Classification → subprompt array
  - [ ] `fact/feedback/state` → `IRag.upsert()` into corresponding stores
  - [ ] `action` → `IRag.query()` for facts/feedback/state/tools → `IContextAssembler.assemble()`
  - [ ] Call `mainLlm.chat()` → tool loop (max `config.maxIterations`)
  - [ ] Return final text response
- [ ] Bounded tool loop: `maxIterations`, timeout - completes the request even if LLM keeps asking for tools

Definition of Done
- [ ] Orchestrator enforces `maxIterations`, timeout, and max tool calls
- [ ] Tool failures are recoverable and surfaced through a typed error path
- [ ] Cancellation propagates across LLM call and MCP tool execution

Validation
- [ ] End-to-end tests cover multi-step tool loops and runaway-prevention scenarios
- [ ] Fault-injection tests cover MCP failures, empty retrieval, and classifier mistakes

---

## Phase 7 - OpenAI-Compatible HTTP Server (`src/smart-agent/server.ts`)

- [ ] `POST /v1/chat/completions` - accepts standard OpenAI format, returns `SmartAgent.process()`
- [ ] Support `stream: false` (MVP); streaming comes separately after stabilization

Definition of Done
- [ ] Endpoint compatibility with OpenAI request/response schema is documented and tested
- [ ] Error codes and payloads are stable and contract-tested
- [ ] Request-level timeout and idempotency behavior are defined

Validation
- [ ] API integration tests cover valid/invalid payloads and tool loop outputs
- [ ] Smoke test with real client SDK confirms wire compatibility

---

## Phase 8 - Observability

- [ ] Structured log at each step: classification, RAG hits/misses, tool calls, summary
- [ ] `DEBUG_SMART_AGENT=true` in `.env` enables detailed output
- [ ] Should not block release - minimal implementation is enough for debugging

Definition of Done
- [ ] Trace correlation id is propagated across classifier, RAG, LLM, and MCP calls
- [ ] Logs are structured, searchable, and redact sensitive fields
- [ ] Baseline dashboards exist for latency, errors, tool usage, and retrieval quality

Validation
- [ ] Observability smoke checks confirm trace continuity across full request lifecycle
- [ ] Redaction tests confirm secrets and sensitive payload fragments are not logged

---

## Phase 9 - Production Readiness

- [ ] Security guardrails for tool execution (allowlist/denylist, policy checks)
- [ ] Prompt-injection mitigation policy for tool-using actions
- [ ] Feature-flagged rollout (`smartAgentV2`) with canary/dual-run support
- [ ] Rollback procedure is documented and tested
- [ ] Data governance policy: retention, purge, and session isolation
- [ ] SLOs defined: p95 latency, error rate budget, max cost/request

Definition of Done
- [ ] Security review passed for tool execution surfaces
- [ ] Rollout and rollback rehearsed in pre-production
- [ ] SLO dashboards and alerts configured

Validation
- [ ] Chaos/failure drills executed for MCP outages and model degradation
- [ ] Canary metrics show no regression against baseline

---

## Phase 10 - Tests and Hardening

- [ ] Test doubles for each interface (deterministic responses)
- [ ] Component isolation test: replace only one real implementation, keep the rest as test doubles
- [ ] End-to-end pipeline smoke test via embedded MCP + stub LLM
- [ ] Regression suite for classifier, retrieval, and tool loop behavior
- [ ] Release gate: lint/build/test all green
