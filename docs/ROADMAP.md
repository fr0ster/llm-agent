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

## Phase 13 - Search Quality & Professional Hardening [PLANNED] 🚀

### 1. BM25 Lexical Scorer
- **Goal:** Improve SAP tool selection accuracy.
- **Implementation:** Replace simple keyword overlap with BM25 algorithm to properly weigh unique technical terms (like `T100` or `MARA`).
- **Benefit:** Massive precision boost when dealing with hundreds of specialized SAP tools.

### 2. Startup Health Checks
- **Goal:** Fail fast and provide clear diagnostics.
- **Implementation:** Validate connectivity to Ollama, MCP servers, and LLM providers during `llm-agent` startup.
- **Benefit:** Instant feedback if a dependency (like your SAP ADT server on 3001) is down.

### 3. Metadata & Context Filtering
- **Goal:** Advanced long-term memory management.
- **Implementation:** Add support for RAG filtering based on `namespace` (project isolation) and `ttl` (temporal relevance) directly in the query pipeline.
- **Benefit:** Prevents "context pollution" from unrelated projects or obsolete information.

### 4. Hybrid Search Tuning
- **Goal:** Expose more control over RAG behavior.
- **Implementation:** Make `vectorWeight` and `keywordWeight` fully adjustable via CLI flags and YAML for different domains.

---

## Phase 14 - Observability & Tooling [FUTURE] 🛠️

- [ ] **Reasoning UI:** Improve how reasoning blocks are rendered in different clients.
- [ ] **Trace Export:** Export structured logs to OpenTelemetry compatible backends.
- [ ] **Evaluation Suite:** Automated regression tests for RAG retrieval quality using a set of "golden" SAP queries.
