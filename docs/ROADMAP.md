# Roadmap

## Phase 17 — Production Hardening

Focus: make the library ready for sustained multi-tenant production use.

- [ ] **17.1 Aggregate Metrics Export** — Expose OTEL-compatible counters (request count, latency histogram, tool call count, RAG hit/miss, classifier intent distribution) via `IMetrics` interface + optional Prometheus adapter.
- [ ] **17.2 Circuit Breaker** — Wrap LLM and embedder calls with a circuit breaker (open/half-open/closed states). Configurable failure threshold and recovery window. Graceful degradation: fall back to InMemoryRag when embedder circuit opens.
- [ ] **17.3 Health Endpoint** — Extend SmartServer with `GET /health` returning structured diagnostics: LLM reachable, RAG store status, MCP connections, uptime, version.
- [ ] **17.4 Config Hot-Reload** — Watch `smart-server.yaml` for changes; apply non-destructive config updates (weights, thresholds, logging level) without restart. Emit event on reload.

## Phase 18 — Advanced RAG & Retrieval

Focus: improve retrieval precision for domain-heavy workloads.

- [ ] **18.1 Reranking Stage** — Add `IReranker` interface between RAG query and context assembly. Default: no-op pass-through. Optional cross-encoder reranker (LLM-based or external API).
- [ ] **18.2 BM25 Term Index** — Replace per-query DF scan in VectorRag with a pre-built inverted index updated on upsert. O(1) term lookup instead of O(n) corpus scan.
- [ ] **18.3 Query Expansion** — Before RAG query, optionally expand the user query with synonyms/related terms via helper LLM. Controlled by config flag.
- [ ] **18.4 Persistent Vector Store Adapter** — Add `IRag` implementation backed by an external vector DB (e.g. Qdrant, ChromaDB) via HTTP. InMemoryRag remains default for dev/testing.

## Phase 19 — Extended Capabilities

Focus: smarter tool execution and output quality.

- [ ] **19.1 Tool Result Caching** — Cache tool results per session keyed by `(toolName, argsHash)`. Configurable TTL. Skip MCP call on cache hit.
- [ ] **19.2 Parallel Tool Execution** — When multiple tool calls have no dependencies, execute them concurrently via `Promise.all` instead of sequentially.
- [ ] **19.3 LLM Output Validator** — `IOutputValidator` interface called after LLM response. Default: no-op. Allows consumers to plug in hallucination detection, schema validation, or content moderation.
- [ ] **19.4 Multi-Turn Token Budget** — Track cumulative token usage across turns. When budget exceeded, auto-summarize history and reset counter. Configurable per-session limit.

## Phase 20 — Operational Tooling & Documentation

Focus: developer experience and operational readiness.

- [ ] **20.1 Deployment Guide** — Document production deployment patterns: Docker, systemd, cloud functions. Include scaling, monitoring, and backup strategies.
- [ ] **20.2 Performance Tuning Guide** — RAG indexing strategies, model selection trade-offs, token budget configuration, BM25 weight tuning.
- [ ] **20.3 Integration Guide** — How to implement custom `ILlm`, `IRag`, `IMcpClient`, `IReranker`, `IOutputValidator`. Code examples for each.
- [ ] **20.4 Intent Classification Benchmark** — Expand evaluation suite: golden corpus for classifier (action vs fact vs chat), MRR and accuracy metrics, CI-integrated.
