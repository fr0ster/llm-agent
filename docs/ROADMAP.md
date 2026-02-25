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

