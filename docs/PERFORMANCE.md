# Performance Tuning Guide

This guide covers tuning strategies for RAG retrieval, BM25 indexing, model selection, token budget management, tool caching, query expansion, and circuit breaker configuration.

All tunable parameters can be set in `smart-server.yaml` and many support hot-reload via `ConfigWatcher` — no restart needed.

## RAG Retrieval Tuning

### vectorWeight / keywordWeight

The hybrid RAG engine (`VectorRag`) combines semantic similarity (vector cosine) and lexical matching (BM25) using configurable weights:

```yaml
rag:
  vectorWeight: 0.7    # Semantic similarity weight (0..1)
  keywordWeight: 0.3   # Lexical matching weight (0..1)
```

**Default:** 0.7 / 0.3 (favors semantic understanding).

**When to adjust:**

| Scenario | vectorWeight | keywordWeight | Rationale |
|----------|-------------|---------------|-----------|
| General-purpose queries | 0.7 | 0.3 | Semantic search handles paraphrasing well |
| Exact tool name lookups | 0.3 | 0.7 | BM25 excels at exact term matching |
| Domain-specific (SAP, technical) | 0.5 | 0.5 | Balance semantic and lexical for specialized terminology |
| Novel / creative queries | 0.8 | 0.2 | Rely on embeddings when query terms differ from corpus |

**Hot-reloadable:** Yes — modify `smart-server.yaml` and weights update within seconds via `ConfigWatcher`.

### ragQueryK

Number of results to retrieve from the RAG store per query:

```yaml
agent:
  ragQueryK: 10   # Default: 10
```

- **Lower values (3–5):** Faster, smaller context window, risk missing relevant results.
- **Higher values (15–20):** Better recall, larger context, higher latency and token cost.
- Works best with a reranker — retrieve broadly (high k), then rerank to the top few.

### dedupThreshold

Cosine similarity threshold for deduplication on upsert:

```yaml
rag:
  dedupThreshold: 0.92   # Default: 0.92
```

- **Higher (0.95+):** Keeps near-duplicates, larger index, slightly better recall.
- **Lower (0.85–0.90):** Aggressively deduplicates, smaller index, faster queries.
- Applied during `upsert()` — if a new document is >= threshold similar to an existing one, it is skipped.

## BM25 Index

### How InvertedIndex works

`InvertedIndex` (in `src/smart-agent/rag/inverted-index.ts`) maintains an in-memory inverted index with BM25 scoring:

1. **On upsert:** Tokenizes text, updates document frequency (DF) maps, stores term positions.
2. **On query:** Computes BM25 score per document using IDF × TF saturation × length normalization.

Term lookups are O(1) via `Map`, compared to the O(n) corpus scan of the older TF-IDF approach.

### BM25 parameters

The default parameters follow the standard BM25 configuration:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `k1` | 1.2 | Term frequency saturation — how quickly TF diminishes returns. Lower = faster saturation. |
| `b` | 0.75 | Length normalization — how much document length affects scoring. 0 = no normalization, 1 = full normalization. |

These are hardcoded constants. For most use cases, the defaults work well.

### When BM25 shines

- **Exact tool name lookups:** Querying `abap_get_object_source` returns the exact tool immediately.
- **Technical terms:** Domain-specific terms like "BADI", "RFC", "CDS" match precisely.
- **Short, keyword-heavy queries:** BM25 outperforms semantic search for queries like "transport release".

## Model Selection

The pipeline supports heterogeneous models for different internal tasks:

```yaml
pipeline:
  llm:
    main:
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
      temperature: 0.7
    classifier:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.1
    helper:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.1
```

An optional `onBeforeStream` hook can be configured via `.withOnBeforeStream(hook)` on the builder. When set, it receives the fully accumulated response content before it is streamed to the caller, allowing reformatting, summarization, or any other post-processing via an async generator. See the Integration guide for usage examples.

### Role selection guidelines

| Role | Requirements | Cost Optimization |
|------|-------------|-------------------|
| **Main LLM** | Tool-calling capability, high quality, coherent multi-turn | Premium model (GPT-4o, Claude) for quality-critical use |
| **Classifier LLM** | Fast + cheap, low temperature (0.1), structured JSON output | Lightweight model (DeepSeek, GPT-4o-mini) — intent classification is a simple task |
| **Helper LLM** | Summarization, RAG query translation, moderate quality | Mid-tier model — quality matters less than for main |

### Temperature guidelines

- **Classifier:** 0.1 — deterministic intent classification.
- **Main LLM:** 0.7 — balanced creativity for tool use and response generation.
- **Helper LLM:** 0.1–0.3 — factual summarization and translation.

### onBeforeStream latency impact

When a pipeline turn involves presenting large tool results (e.g., full source listings, multi-record queries), the final generation step is the dominant cost. Delegating reformatting to a fast flash/mini model inside the `onBeforeStream` hook can reduce time-to-completion significantly. The improvement is most visible for long, structured responses; for short answers the overhead of the extra call (~0.5–1 s) may outweigh the gain.

## Token Budget

### sessionTokenBudget

Track cumulative token usage across turns. When the budget is exceeded, the pipeline auto-summarizes conversation history:

```yaml
agent:
  sessionTokenBudget: 0       # 0 = disabled (default)
  # sessionTokenBudget: 100000  # 100k tokens before summarization
```

**Trade-offs:**

| Budget | Behavior |
|--------|----------|
| 0 (disabled) | Unlimited history growth — coherent but expensive for long sessions |
| 50,000 | Aggressive summarization — fast and cheap, may lose detail |
| 100,000 | Balanced — good coherence for medium-length sessions |
| 200,000+ | Permissive — only summarizes very long conversations |

### historyAutoSummarizeLimit

Triggers history compression when message count exceeds this limit:

```yaml
agent:
  historyAutoSummarizeLimit: 10   # Default: 10 messages
```

When triggered, the helper LLM summarizes older messages into a single summary message, reducing context window size.

## Tool Caching

### toolResultCacheTtlMs

Cache MCP tool results per session, keyed by `(toolName, argsHash)`:

```yaml
agent:
  toolResultCacheTtlMs: 300000   # Default: 300s (5 minutes)
```

**Tuning guidelines:**

| Data Type | Recommended TTL | Rationale |
|-----------|----------------|-----------|
| Metadata lookups (schema, class info) | 300,000+ ms | Stable data, safe to cache |
| Status queries (transport status, locks) | 0–30,000 ms | Volatile data, needs fresh results |
| Search results | 60,000–120,000 ms | Moderate volatility |

Set to `0` to disable caching entirely. The cache uses SHA-256 hashing of `(toolName, JSON.stringify(args))` for keys.

## Query Expansion

### queryExpansionEnabled

Before RAG query, optionally expand the user query with synonyms and related terms via the helper LLM:

```yaml
agent:
  queryExpansionEnabled: false   # Default: false
```

**When to enable:**

- Users phrase queries differently from how tools/facts are described.
- Domain-specific terminology has multiple synonyms.
- Recall is more important than latency.

**Trade-off:** Adds ~1 extra LLM call per pipeline invocation. Skip for latency-sensitive use cases where queries closely match indexed content.

## Circuit Breaker

The circuit breaker wraps LLM and embedder calls with automatic failure detection and recovery:

```ts
const handle = await new SmartAgentBuilder({ llm: { apiKey } })
  .withCircuitBreaker({
    failureThreshold: 5,       // Open after 5 consecutive failures
    recoveryWindowMs: 30_000,  // Try half-open after 30s
  })
  .build();
```

### State machine

```
CLOSED (normal) ──[failures >= threshold]──► OPEN (fast-fail)
       ▲                                         │
       │                                    [recoveryWindowMs]
       │                                         │
       └──────[probe succeeds]──── HALF_OPEN ◄───┘
```

### Impact on latency

- **Closed:** No overhead — calls pass through.
- **Open:** Immediate failure — no LLM/embedder calls, no latency.
- **Half-open:** Single probe call — if it succeeds, circuit closes.

### FallbackRag behavior

When the embedder circuit opens, RAG stores automatically fall back to `InMemoryRag` (TF-based, no external embedder needed). This ensures tool discovery continues even when the embedding service is down.

## Benchmarking

### RAG evaluation

Run the golden corpus evaluation to measure retrieval quality:

```bash
npm run test:rag-eval
```

Metrics: MRR (Mean Reciprocal Rank), precision@1, recall@k across 16 corpus entries and 8 golden queries.

### Classifier benchmark

Run the intent classification benchmark:

```bash
npm run test:classifier-bench
```

Metrics: type accuracy, count accuracy, per-type precision/recall across 20+ golden corpus entries covering all 5 intent types (action, fact, chat, state, feedback).

### Full suite

```bash
npm run test:all   # Runs all tests including RAG eval and classifier bench
```
