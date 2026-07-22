# Performance Tuning Guide

This guide covers tuning strategies for RAG retrieval, BM25 indexing, model selection, token budget management, tool caching, query expansion, and circuit breaker configuration.

All tunable parameters can be set in `smart-server.yaml` and many support hot-reload via `ConfigWatcher` — no restart needed.

## Embedder Model Selection

The embedder model must be set **explicitly** in `rag.model` — there is no default. A missing `model` is a startup error.

### Recommended: `bge-m3` (multilingual)

All shipped examples use `bge-m3` (BAAI/bge-m3 via Ollama):

```yaml
rag:
  embedder: ollama
  model: bge-m3
```

```bash
ollama pull bge-m3
```

`bge-m3` is multilingual (1024-dimensional vectors). It covers English and non-English document corpora, SAP-native German terms, and residual non-English content after the query-translation step.

### Query translation is complementary

`ragTranslateEnabled` (default: on) translates non-ASCII queries to English before vectorization and RAG search. Using a multilingual embedder (`bge-m3`) **plus** translation provides robust retrieval for both non-English queries and non-English document corpora — the two are not either/or.

### Dimension caveat — re-index persistent stores when switching models

The embedding dimensions are model-specific: `nomic-embed-text` produces 768-dimensional vectors; `bge-m3` produces 1024-dimensional vectors. Switching models requires a **full re-index** of any persistent vector store (qdrant, hana-vector, pg-vector). In-memory stores rebuild on each restart automatically.

---

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

## Tool Selection (Semantic Distance)

Tools are chosen by semantic distance over the `tools` RAG store. After retrieval, a pluggable **tool-selection strategy** filters the result set before the tools are exposed to the LLM. No domain classifier rules are needed — tool exposure is driven purely by RAG semantic distance.

### Strategies

| Strategy | YAML | Behaviour |
|----------|------|-----------|
| `top-k` (default) | `strategy: top-k` | Expose the K nearest tools; K is controlled by `agent.ragQueryK`. Unchanged from prior behavior. |
| `threshold` | `strategy: threshold` | Expose only tools whose cosine score is ≥ `minScore`. An off-topic query whose nearest tools all fall below the cutoff surfaces **no tools**, so the LLM answers as plain chat. |

### YAML configuration

```yaml
agent:
  toolSelection:
    strategy: threshold
    minScore: 0.4
```

For the default `top-k` behavior, omit the `toolSelection` block (or set `strategy: top-k`).

### Builder / DI

```typescript
import { ScoreThresholdToolSelection } from '@mcp-abap-adt/llm-agent-libs';

const { agent } = await new SmartAgentBuilder({ /* ... */ })
  .withToolSelectionStrategy(new ScoreThresholdToolSelection(0.4))
  .build();
```

DI wins over YAML: a strategy injected via `withToolSelectionStrategy()` overrides any `agent.toolSelection` block.

### Calibrating `minScore`

`minScore` is embedder-specific — the cosine score range depends on the embedding model and corpus. **Tune empirically; 0.3–0.5 is a reasonable starting band for bge-m3 cosine scores**, but the right value depends on your tool descriptions and query distribution. Collect real queries, inspect the scores logged by `ToolSelectHandler`, and adjust until off-topic queries reliably fall below the cutoff.

### Domain-neutral tool exposure

Because filtering is score-based, no SAP-specific or domain-specific classifier rules are needed to route queries to the right tools. The `threshold` strategy gates tool exposure automatically: if no tool is semantically close enough, the LLM acts as plain chat without any MCP calls.

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

### Benchmarks (159 ABAP MCP tools, Ollama bge-m3)

> **Note:** benchmarks were run with `nomic-embed-text` (768 dimensions). The shipped examples now use `bge-m3` (multilingual, 1024 dimensions). Relative strategy rankings remain valid; absolute scores may differ slightly with `bge-m3`.

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

The repository does not currently ship a packaged benchmark harness (no
`test:rag-eval` / `test:classifier-bench` npm scripts or an `e2e-rag-search`
runner). Evaluate against your own golden corpus using the metrics below; the
building blocks — configurable `IToolSelectionStrategy` / `ISearchStrategy`,
swappable embedders, and the classifier — are all injectable for offline
measurement (see [docs/INTEGRATION.md](INTEGRATION.md)).

- **RAG / tool retrieval quality** — score retrieval over a labelled query→tool
  (or query→document) set with **MRR** (Mean Reciprocal Rank), **precision@1**,
  and **recall@k**. Compare embedders and search strategies on the same corpus.
- **E2E search** — for a realistic measurement, run the full path (LLM query
  translation + real embeddings against a live MCP catalog) and score the ranked
  tool list against the expected tool per query.
- **Intent classifier** — score the classifier over a labelled corpus with type
  accuracy, count accuracy, and per-type precision/recall across the intent types
  (action, fact, chat, state, feedback).

## Coordinator orchestration: when it pays off

### Token cost model

Each Coordinator request with N steps costs roughly `(1 + N) × T` tokens, where `T` is the baseline cost of a single pipeline pass (classify + rag + tool-select + one tool-loop iteration). On top of that, the planner LLM call adds ~500–1 500 tokens depending on how many subagents are registered and how much skill content each has.

The break-even point is lower than it looks: each subagent has a **narrower tool selection** (only the tools relevant to its task), so individual subagent LLM calls have shorter prompts than a monolithic tool-loop that retrieved all tools.

### When Coordinator is cheaper than a single tool-loop

- **Multi-step workflows hitting per-call tool limits** — e.g. SAP AI Core enforces a 128-tool ceiling per request. A single tool-loop iteration touching 184 indexed tools requires truncation; a Coordinator dispatching focused steps with 5–10 tools each stays well under the limit.
- **Tasks where different steps need disjoint tool subsets** — a "code + review + document" workflow benefits from each subagent only seeing its own tools.
- **Long sequential chains** where the parent tool-loop would otherwise run 4–6 iterations (each paying full context cost).

### Heterogeneous LLM routing

Route each stage to the cheapest model that meets its quality bar:

| Stage | Example model | Rationale |
|---|---|---|
| Parent classify | Claude Haiku | Fast, cheap; only classifies intent |
| Coordinator planner | DeepSeek | Structured JSON output; inexpensive |
| abap-coder subagent | SAP AI Core gpt-4o | ABAP generation quality matters |
| reviewer subagent | DeepSeek | Structured JSON evaluation; fast |
| doc-writer subagent | Ollama (local) | Free; markdown formatting is forgiving |

Use `pipeline.config.plannerLlm: helper` in YAML to assign a cheap model for planning while the parent and subagents use stronger ones.

### Tuning knobs

| YAML key | Default | Effect |
|---|---|---|
| `pipeline.config.maxSteps` | unlimited | Hard cap on generated step count |
| `pipeline.config.maxRetriesPerStep` | 1 | How many times to retry a failed step |
| `pipeline.config.failPolicy` | `abort` | `abort` stops the plan; `continue` skips the failed step |
| `pipeline.config.plannerLlm` | `main` | `main` / `helper` / `planner` — which LLM the planner uses |

(These knobs belong to the `linear` pipeline dialect — `pipeline: { name: linear, config: { ... } }`.)

`OneShotPlanning` (default) issues a single planner call per request. `ReplanOnErrorPlanning` issues one additional call per step failure. For deterministic, well-defined flows `OneShotPlanning` is sufficient.

- **`planning: skill-steps` eliminates the planner LLM call.** When the active skill encodes the process as structured `steps:` in its frontmatter, the plan is built directly from that list — zero planner-LLM tokens. Pair with `dispatch: hybrid` (the default when planning is `skill-steps`) so steps without an explicit `agent:` fall back to a self-LLM call.

### When NOT worth activating

The coordinator-bearing pipelines (`linear`, `dag`, `stepper`) pay the planner overhead on every request. For simple single-shot traffic prefer the default `flat` pipeline (single-shot tool-loop, no coordinator). When you do select a coordinator-bearing pipeline but want it to gate itself — keeping `tool-loop` when there are no subagents and no skill steps — set `pipeline.config.activation: auto` in YAML (linear) or pass `new AutoActivation()` in the builder. Without that override the default `ExplicitActivation` always engages once `withCoordinator()` is wired (which the coordinator-bearing pipelines do internally per their `config`).

Cross-reference: see `docs/ARCHITECTURE.md` section `## Coordinator orchestration` for the strategy interfaces.
