# Smart Orchestrated Agent - Implementation Roadmap

---

## Phase 12 - Real Incremental Streaming & Stability [DONE] ✅

- [x] **True Streaming:** LLM tokens and tool-call deltas are yielded to the client in real-time.
- [x] **OpenAI SSE Compliance:** Surgical sequence of chunks (role -> content -> finish_reason -> usage).
- [x] **Fast-path intents:** 'chat' intent for instant responses to simple math/greetings.
- [x] **Hallucination Guard:** Validate tool names against MCP/Client inventory before execution.
- [x] **Resilience:** Exponential retries for embedding providers (Ollama/OpenAI) and MCP auto-reconnect.
- [x] **Helper LLM Integration:** Offloading RAG translation and history summarization to a secondary model.

---

## Phase 13 - Search Quality & Professional Hardening [DONE] ✅

- [x] **Startup Health Checks:** Immediate diagnostic probes for LLM, RAG, and MCP connectivity on server start.
- [x] **BM25 Lexical Scorer:** Proper term weighting based on IDF for precise technical tool matching.
- [x] **Metadata & Namespace Filtering:** Support for project/session isolation in RAG queries.
- [x] **Smart 2.0 Orchestration:** Unified single-turn execution with contextual persona isolation.
- [x] **Session Debug Auditing:** Structured logging of full context windows and LLM exchanges into `sessions/`.

---

## Phase 14 - Advanced Reliability & Tooling [PLANNED] 🚀

### 1. Hybrid Search Tuning
- **Goal:** Expose more control over RAG behavior.
- **Implementation:** Make `vectorWeight` and `keywordWeight` fully adjustable via CLI flags and YAML for different domains.

### 2. Multi-Action Dependency Resolver
- **Goal:** Handle complex tasks that depend on previous results more robustly.
- **Implementation:** Improve the "coupled" dependency logic in the classifier to guide the agent through multi-step workflows.

### 3. Trace Export (OTEL)
- **Goal:** Professional observability.
- **Implementation:** Export structured logs to OpenTelemetry compatible backends (Jaeger, Honeycomb).

### 4. Evaluation Suite
- **Goal:** Quality assurance.
- **Implementation:** Automated regression tests for RAG retrieval quality using a set of "golden" SAP queries.

---

## Phase 15 - Protocol Contracts & Patch Elimination [IN PROGRESS] 🚧

### 1. Document Legitimate Edge Cases [DONE] ✅
- **Goal:** Preserve robustness that reflects real protocol constraints.
- **Implementation:** Add explicit documentation for:
  - SSE parsing guarantees and chunk ordering
  - Tool-call protocol invariants
  - MCP reconnect and fallback behavior
  - Loop safety limits (max iterations, max tool calls, abort handling)

### 2. Replace Unsafe Casts in Critical Paths [DONE] ✅
- **Goal:** Remove patch-style typing shortcuts from protocol/runtime flows.
- **Implementation:** Introduce normalized DTOs for streaming tool-call deltas and remove `as unknown as ...` from:
  - smart-agent orchestration loop
  - smart-server SSE emission path
  - LLM adapter chunk bridge logic

### 3. Formalize External Tool Input Contract [DONE] ✅
- **Goal:** Stop heuristic parsing of external tool formats.
- **Implementation:** Add a strict normalizer/validator for external tools (OpenAI-compatible and internal shapes), with clear rejection behavior for invalid payloads.

### 4. Remove Protected-Access Adapter Debt [OPEN] ⏳
- **Goal:** Eliminate `(this.agent as any)` access to protected methods.
- **Implementation:** Define a public, typed execution interface between `BaseAgent` and adapter layer for chat/stream calls.

### 5. Improve Parse Observability [OPEN] ⏳
- **Goal:** Avoid silent protocol degradation.
- **Implementation:** Replace silent parse skips with structured diagnostics and counters while keeping runtime resilience.

### 6. Add Protocol Contract Tests [OPEN] ⏳
- **Goal:** Convert protocol assumptions into executable guarantees.
- **Implementation:** Add test coverage for:
  - fragmented tool arguments across chunks
  - orphaned tool messages
  - hallucinated tool calls
  - finish_reason and usage chunk sequencing
  - MCP reconnect and fallback scenarios

### 7. Session Tool Availability Registry [DONE] ✅
- **Goal:** Distinguish protocol-valid tools from runtime-unavailable tools in a given environment/session.
- **Implementation:** Add session-scoped TTL blacklist/cooldown with diagnostics:
  - block tools temporarily after context-unavailable execution failures
  - filter blocked tools from active tool context before next LLM call
  - keep behavior configurable (`strict`/`permissive` boundary handling remains in 15.3)

### Definition of Done
- No unsafe cast chains (`as unknown as ...`) in critical protocol paths.
- No protected method access via `any` in adapter code.
- Protocol edge-case behavior is documented and linked from README/docs.
- Contract tests pass for streaming/tool-call protocol scenarios.
- `npm run lint:check` and `npm run build` are green.
