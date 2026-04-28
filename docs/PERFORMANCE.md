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

## Search Strategies

`VectorRag` delegates scoring to a pluggable `ISearchStrategy`. The strategy receives query + candidates and returns scored results. Choose one, or combine with `CompositeStrategy`.

### Built-in strategies

| Strategy | Description | Best for |
|----------|-------------|----------|
| `WeightedFusionStrategy` | `score = vectorScore × w1 + bm25Score × w2` (default 0.7/0.3) | General-purpose, configurable weights |
| `RrfStrategy` | Reciprocal Rank Fusion — rank-based, magnitude-independent | Stable ranking when score distributions differ |
| `VectorOnlyStrategy` | Pure cosine similarity | When BM25 tokenization doesn't match the domain |
| `Bm25OnlyStrategy` | Pure BM25 keyword matching | Exact terms, no embedder available |
| `CompositeStrategy` | Weighted RRF across multiple child strategies | Combining approaches with different weights |

### Configuration

```typescript
import { VectorRag, RrfStrategy, CompositeStrategy, VectorOnlyStrategy, Bm25OnlyStrategy } from '@mcp-abap-adt/llm-agent';

// Single strategy
const rag = new VectorRag(embedder, { strategy: new RrfStrategy() });

// Composite — consumer controls weights
const rag = new VectorRag(embedder, {
  strategy: new CompositeStrategy([
    { strategy: new RrfStrategy(), weight: 1.0 },
    { strategy: new VectorOnlyStrategy(), weight: 0.7 },
    { strategy: new Bm25OnlyStrategy(), weight: 0.3 },
  ]),
});
```

### Benchmarks (159 ABAP MCP tools, Ollama nomic-embed-text)

| Strategy | MRR | Notes |
|----------|-----|-------|
| RRF | **0.865** | Best overall |
| BM25-only | 0.808 | Strong on technical terms |
| Weighted 0.7/0.3 | 0.788 | Default |
| Vector-only | 0.712 | Baseline |

## Query Preprocessors

`IQueryPreprocessor` transforms query text before embedding. Configured per RAG store — each store can have its own preprocessing chain.

### Built-in preprocessors

| Preprocessor | Description | Cost |
|-------------|-------------|------|
| `TranslatePreprocessor` | Translates non-ASCII queries to English via LLM | 1 LLM call per non-ASCII query |
| `ExpandPreprocessor` | Adds LLM-generated synonyms to query | 1 LLM call per query |
| `PreprocessorChain` | Composes multiple preprocessors in sequence | Sum of child costs |

### Configuration

```typescript
import { VectorRag, RrfStrategy, TranslatePreprocessor, PreprocessorChain, ExpandPreprocessor } from '@mcp-abap-adt/llm-agent';

// Translate only (recommended for multilingual)
const rag = new VectorRag(embedder, {
  strategy: new RrfStrategy(),
  queryPreprocessors: [new TranslatePreprocessor(helperLlm)],
});

// Chain: translate → expand
const rag = new VectorRag(embedder, {
  queryPreprocessors: [
    new TranslatePreprocessor(helperLlm),
    new ExpandPreprocessor(helperLlm),
  ],
});
```

### Benchmarks (159 ABAP MCP tools, Ukrainian + English queries)

| Approach | Hit rate (top-5) |
|----------|-----------------|
| No preprocessing | 44% (7/16) |
| **TranslatePreprocessor** | **94% (15/16)** |
| Translate + IntentEnricher (dual index) | 88% (14/16) |

`TranslatePreprocessor` alone gives the best cost/quality ratio. Dual indexing adds noise that can hurt RRF ranking.

## Tool Indexing Strategies

`IToolIndexingStrategy` generates text variants for tool descriptions at indexing time. The builder indexes tools into the RAG store — strategies control what text gets embedded.

### Built-in strategies

| Strategy | Description | Cost |
|----------|-------------|------|
| `OriginalToolIndexing` | Raw `"name: description"` (default) | Free |
| `SynonymToolIndexing` | Adds action verb synonyms (Read→Show/Display/View) | Free (deterministic) |
| `IntentToolIndexing` | LLM generates concise intent keywords | 1 LLM call per tool |

### Dual/multi indexing

Index each tool multiple times with different representations. Use distinct IDs to avoid dedup:

```typescript
import { DirectEditStrategy, GlobalUniqueIdStrategy } from '@mcp-abap-adt/llm-agent';

const original = new OriginalToolIndexing();
const synonym = new SynonymToolIndexing();

// Writes go through IRagEditor — IRag no longer exposes upsert directly
const editor = new DirectEditStrategy(rag.writer()!, new GlobalUniqueIdStrategy());

for (const tool of tools) {
  const entries = [
    ...(await original.prepare(tool)),
    ...(await synonym.prepare(tool)),
  ];
  for (const entry of entries) {
    await editor.upsert(entry.text, { id: entry.id });
  }
}
// Result: tool:ReadClass (original) + tool:ReadClass:synonym (synonyms)
```

## BM25 Index

### How InvertedIndex works

`InvertedIndex` (in `packages/llm-agent/src/rag/inverted-index.ts`) maintains an in-memory inverted index with BM25 scoring:

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

## Query Expansion (Legacy)

### queryExpansionEnabled

Pipeline-level query expansion via the helper LLM. Superseded by `ExpandPreprocessor` (configured per RAG store), but still available for backward compatibility.

```yaml
agent:
  queryExpansionEnabled: false   # Default: false
```

**Prefer `ExpandPreprocessor`** for new code — it's per-store, composable with `TranslatePreprocessor`, and configured declaratively via `VectorRagConfig.queryPreprocessors`.

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
npm run test:rag-eval    # Golden corpus (16 entries, 8 queries, all strategies)
npm run test:mcp-eval    # MCP tools benchmark (40 tools, 15+ queries, all strategies)
```

Metrics: MRR (Mean Reciprocal Rank), precision@1, recall@k.

### E2E search benchmark

Test with real LLM translation + real embeddings against live MCP server:

```bash
node --import tsx/esm scripts/e2e-rag-search.ts
```

Requires: DeepSeek API key, Ollama with `nomic-embed-text`, MCP server on localhost:3001.

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
