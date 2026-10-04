# Collection profiles — design spec

> **Serves:** the goal document `docs/superpowers/goals/2026-10-04-collection-profiles.md`
> (user-owned, binding). Where this spec and the goal differ, the goal wins and this
> spec is wrong.
>
> **Base:** release 30.1.0 (`2cc2ba33`). Builds on #321's per-store retrieval
> (`IRetrievalStrategy`, `StrategyRag`, the rerank strategies; its spec §13 is in git
> history at `74922e28^:docs/superpowers/specs/2026-10-02-decision-model-design.md`).
>
> **Status:** draft for the user's review. Items marked **Decision for the user** carry a
> recommendation; everything else is decided here, with the reason.

## TL;DR

- A **collection profile** is one object with two halves for one **kind** of store:
  - **indexing**: one source item → several **records** (`IItemIndexer`), each carrying
    `itemId`, `recordKind` and **owner keys**;
  - **retrieval**: candidates → **collapse records back to items** → optional reranker on the
    item's full text → final cut **counted in items** (`StagedRetrieval`, an
    `IRetrievalStrategy`).
  - What joins them: the record schema (`itemId`, `recordKind`, canonical record id = item id).
- A profile is **bound** to each store of its kind (`profile.bind(store)`), so one profile serves
  several stores (e.g. reader and writer tool stores).
- The retrieval half **is** a 30.1.0 `IRetrievalStrategy`. It goes through `StrategyRag` /
  `applyRetrievalStrategy`, so every path that already honours per-store strategies (flat stages,
  tool-loop, `IToolsRagHandle`, controller, coordinator, workers) gets it with no new wiring.
- **Nothing changes by default.** No profile set → 30.1.0 behaviour, byte for byte (pinned by a
  golden test).
- Two default profiles ship:
  1. **`McpToolsProfile`** — records `full` + `operation` + `object`, derived deterministically from
     the provider's name, description and parameter names; LLM-generated intents only in a
     **separate companion collection**; collapse by best hit (max).
  2. **`ExperienceProfile`** — cases (inputs, symptoms, decision, outcome) extracted from finished
     sessions by an injected extractor, confirmed by an injected policy, stored with owner keys,
     returned whole.
- In-scope fixes: the store's embedder hidden behind `StrategyRag`; de-duplication in
  `tools-rag-handle` and `skill-select`; the orphan `IToolIndexingStrategy` is deleted and its docs
  rewritten.
- Contracts in `@mcp-abap-adt/llm-agent`; default implementations in `@mcp-abap-adt/llm-agent-libs`
  (`src/collections/`); YAML in `@mcp-abap-adt/llm-agent-server-libs`.

---

## 1. Terms

| Term | Meaning | Example |
|---|---|---|
| **Item** | One source thing a consumer wants back | one MCP tool; one experience case |
| **Record** | One row in a store: id + embedded text + metadata | `tool:GetWhereUsed#operation` |
| **Record kind** (facet) | Which view of the item a record is | `full`, `operation`, `object`, `intent`, `case`, `symptoms`, `inputs` |
| **Canonical record** | The record of kind `full` (tools) / `case` (experience) whose id **equals** the item id | `tool:GetWhereUsed` |
| **Store** | One `IRag` instance, addressed by its `ragStores` key | `tools`, `tools-writer`, `experience` |
| **Companion store** | A store bound to a primary store by a profile, queried together and collapsed together | the generated-intents collection of `tools` |
| **Collection kind** | The kind of items a store holds | MCP tools, experience, skills, user collections, history |
| **Profile** | The indexing + retrieval pair for one collection kind (`ICollectionProfile<TItem>`) | `McpToolsProfile` |
| **Binding** | A profile applied to one concrete store (+ its companions) (`IBoundCollection<TItem>`) | `mcpTools.bind({ key: 'tools-reader', rag })` |

**One profile, several stores (goal 6).** A profile instance holds what is shared by the kind
(indexer, reranker, cut, candidate count). `bind()` is called once per store and returns that
store's indexing and retrieval. The goal's example — two tool stores, one skills store, one history
store, one user-collections store served by three profiles — is: `McpToolsProfile` bound twice,
skills/history/user collections on the 30.1.0 behaviour (no profile = the default profile).

**Name map (no clashes).**

| Taken in 30.1.0 | What it is | New name in this spec |
|---|---|---|
| `ISearchStrategy` | in-store scoring (vector / BM25 / fusion) | — (untouched) |
| `IRetrievalStrategy` | wrapper around a store: candidates → rerank → top-k | reused as the retrieval half |
| `IToolSelectionStrategy` | post-filter of all stores' flattened results | — (untouched) |
| `IToolIndexingStrategy` | orphan, unexported | **deleted**, replaced by `IItemIndexer<TItem>` (§9.3) |
| `IQueryPreprocessor` / `IQueryExpander` | in-store / pipeline query rewrites | — ; clause split is `IQuerySplitter` |
| — | new | `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IndexedRecord`, `RecordOwner`, `ICollapseRule`, `IItemCut`, `IQuerySplitter`, `IRetrievalMetrics`, `StagedRetrieval` |

---

## 2. Why this shape (evidence → design)

| Measured (cloud-llm-hub, 237 tools, English, required-recall) | Design consequence |
|---|---|
| Several records per tool (full + operation + object), collapsed by **best hit**: 0.943 → 0.966 at 5 tools/collection; 0.977 at k=8 with ~13 tools vs 25 today | multi-record indexing + collapse step, k in items |
| Collapse by count or RRF is worse than max | ship **`MaxScoreCollapse` only**; the rule is an injected `ICollapseRule` |
| Dropping the full record (facets only) is clearly worse | `full` is not optional in the tools profile (typed, §6.2) |
| Deterministic facets = LLM facets on English (V1d = V3 = 0.966) | default facets need no LLM |
| Cross-encoder rerank: non-English 0.692 → 0.962; cosine stage 1 0.885 → 0.943 | reranker on **items**, with the item's full text |
| Clause split helps only with a reranker (multi-step 0.714 → 1.000); embedding-only clause split hurts | split is typed to require a reranker (§4.4) |
| LLM as reranker: no gain, 6–10k tokens/query, silent-looking fallback | fallback becomes visible: span + metric + `/health` (§8) |
| Absolute thresholds are language-biased; "top-3 then up to 8 while score ≥ t" is safe | per-store cut: top-k items (default) or `ScoreFloorCut(min, max, minScore)` |
| R3c ∪ faceted top-3 = 1.000, but chosen after seeing the data | optional knob, **off** by default (§4.6) |

---

## 3. Contracts — `@mcp-abap-adt/llm-agent`

New file `packages/llm-agent/src/interfaces/collection-profile.ts` (and
`experience.ts` for §7). All additive; `IRag`, `IReranker`, `IRetrievalStrategy`, `IMetrics` are
not changed.

### 3.1 Records and owners

```ts
/** Who may see a record. Flattened by the framework into the IRag identity keys. */
export type RecordOwner =
  | { readonly scope: 'global' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'session'; readonly sessionId: string; readonly userId?: string };

/** Keys the framework writes; a profile's extras can never set them. */
export type ReservedRecordKey =
  | 'id' | 'itemId' | 'recordKind' | 'itemText' | 'profile' | 'userId' | 'sessionId';

export interface IndexedRecord {
  /** Deterministic. The canonical record's id equals itemId; others are `${itemId}#${kind}[...]`. */
  readonly id: string;
  /** The text that is embedded. */
  readonly text: string;
  readonly itemId: string;
  readonly recordKind: string;
  /** Required: no record without an owner (goal decision on #304). */
  readonly owner: RecordOwner;
  /** Non-canonical records in the primary store: the item's full text, for the reranker. */
  readonly itemText?: string;
  /** Profile extras (e.g. `name` for tools, `case` JSON for experience). */
  readonly metadata?: Readonly<Record<string, unknown>> & { readonly [K in ReservedRecordKey]?: never };
}
```

- **Why `owner` is a required typed field, not metadata:** a record without owner keys does not
  compile. The framework flattens it (`user` → `metadata.userId`; `session` → `sessionId` [+
  `userId`]; `global` → neither), so every existing store's identity filter (the `IRag.query`
  contract) keeps working unchanged.
- **Why `ReservedRecordKey` is `never` in extras:** a profile cannot overwrite the keys collapse and
  isolation depend on — a compile-time check, not a runtime guard.

### 3.2 Indexing half

```ts
export interface IItemIndexer<TItem> {
  readonly name: string;
  /** Pure mapping item → records. The owner is given, never chosen by the indexer. */
  toRecords(item: TItem, owner: RecordOwner, options?: CallOptions)
    : Promise<Result<readonly IndexedRecord[], RagError>>;
}

export interface IndexReport {
  readonly items: number;          // items given
  readonly indexedItems: number;   // items with every record written
  readonly records: number;        // records written
  readonly failedItems: readonly string[]; // itemIds
}
```

### 3.3 The profile and its binding

```ts
export interface CollectionCompanion {
  readonly rag: IRag;
  /**
   * 'variants': holds extra records of the PRIMARY store's items (e.g. generated intents);
   *             item text comes from the primary store.
   * 'peer':     holds its own items (e.g. global experience cases next to a user store);
   *             item text comes from the companion itself.
   */
  readonly role: 'variants' | 'peer';
}

export interface CollectionStore {
  readonly key: string;   // the ragStores key
  readonly rag: IRag;     // primary store
  readonly companions?: Readonly<Record<string, CollectionCompanion>>;
}

export interface IBoundCollection<TItem> {
  readonly store: CollectionStore;
  readonly profileName: string;
  /** Filling half: run the indexer and write every record (batch-embedded where possible). */
  index(items: readonly TItem[], owner: RecordOwner, options?: CallOptions)
    : Promise<Result<IndexReport, RagError>>;
  /** Delete every record of these items (ids are deterministic). */
  remove(itemIds: readonly string[], options?: CallOptions)
    : Promise<Result<number, RagError>>;
  /** Searching half. `k` counts ITEMS. */
  readonly retrieval: IRetrievalStrategy;
}

export interface ICollectionProfile<TItem> {
  readonly name: string;   // 'mcp-tools' | 'experience' | a consumer's own
  bind(store: CollectionStore): IBoundCollection<TItem>;
}
```

- **Different method names for the two halves** (`index` / `retrieve`): design pattern 1 — a role
  is a method name.
- **Why `retrieval` is an `IRetrievalStrategy`:** goal "build on #321, not beside it". It reuses
  `StrategyRag`, the brand, `applyRetrievalStrategy`'s idempotency, the `RerankHandler` precedence
  rule and every application point of §13.3–13.4 of #321.

### 3.4 Retrieval parts

```ts
export interface CollapsedItem {
  readonly itemId: string;
  readonly score: number;                  // per the rule
  readonly hits: readonly RagResult[];     // the item's records among the candidates, best first
}

/** Records → items. Output sorted by score, descending. */
export interface ICollapseRule {
  readonly name: string;
  collapse(hits: readonly RagResult[]): CollapsedItem[];
}

/** Final cut over ranked items. `requestedK` is the caller's k, in items. */
export interface IItemCut {
  readonly name: string;
  cut(items: readonly RagResult[], requestedK: number): RagResult[];
}

/** Splits a multi-step query into clauses. One clause = no split. */
export interface IQuerySplitter {
  readonly name: string;
  split(text: string): readonly string[];
}

/** A separate small interface (ISP), not a new member of IMetrics. */
export interface IRetrievalMetrics {
  /** Attributes: store, strategy, outcome (§8.2). */
  readonly retrievalOutcome: ICounter;
}
export function isRetrievalMetrics(m: unknown): m is IRetrievalMetrics;
```

### 3.5 Tool items

```ts
export interface ToolItem {
  readonly itemId: string;            // the IToolRecordKey output, e.g. `tool:GetWhereUsed`
  readonly name: string;              // exposed (namespaced) name → metadata.name
  readonly originalName: string;      // provider's name; facets derive from it
  readonly description: string;
  readonly parameterNames: readonly string[]; // top-level inputSchema.properties keys, in order
}
```

### 3.6 Store embedder capability (for fix F1)

```ts
/** Optional capability (pattern 4): a store that embeds its own documents exposes its embedder. */
export interface IRetrievalEmbedderOwner {
  readonly retrievalEmbedder: IRetrievalEmbedder;
}
/** Walks IRagDecorator.inner (≤16 levels, like hasRetrievalStrategy) to the first owner. */
export function retrievalEmbedderOf(rag: IRag): IRetrievalEmbedder | undefined;
```

### 3.7 Justification of every contract change

| Change | Why it is needed | Why here |
|---|---|---|
| `IndexedRecord`, `RecordOwner`, `IItemIndexer`, `ICollectionProfile`, `IBoundCollection`, `CollectionStore` | goals 1–2, 5–6: a profile contract consumers implement | used by libs (implementations, builder), server-libs (YAML) and consumers (the hub's own tool stores) → the contracts package |
| `ICollapseRule`, `IItemCut`, `IQuerySplitter` | goal 1's new steps, each a consumer-swappable strategy (principle 5) | same users as above |
| `ToolItem` | typed input of the builder-managed tools store (`withToolsProfile` only accepts `ICollectionProfile<ToolItem>`) | builder (libs) + profile implementations + consumers |
| `IRetrievalMetrics` | the rerank fallback must reach metrics and `/health` (goal *Evidence*) without growing `IMetrics` (principle 4) | metrics implementations live in libs; consumers plug their own backends |
| `IRetrievalEmbedderOwner` | replaces the `(toolsRag as any).embedder` read — a cast that erased a type and is the cause of F1 | implemented by `VectorRag` (llm-agent) and the qdrant / pg-vector / hana provider packages |
| `HealthComponentStatus.toolCatalog.records?`, `.profile?`, `components.experience?`, `MetricsSnapshot.retrievalOutcome?` | additive optional fields for §8 | where the health types already live |
| Experience types (§7.1) | goal 7 | libs + server-libs + consumers |

These are the llm-agent family's own contracts, used only inside this monorepo and by its
consumers, so they belong in `@mcp-abap-adt/llm-agent`, not in the cross-family
`@mcp-abap-adt/interfaces-*` packages.

---

## 4. The composable retrieval half — `StagedRetrieval` (libs)

`packages/llm-agent-libs/src/collections/staged-retrieval.ts`. Implements `IRetrievalStrategy`.

### 4.1 Why a new composable class

`RerankedRetrieval` / `RerankAllRetrieval` fetch **and** rerank in one `retrieve` call, so a
collapse cannot be put between the two steps from outside. `StagedRetrieval` exposes the steps as
injected parts. The 30.1.0 classes stay as they are (same exports, same behaviour); they are not
reimplemented in this PR, so nothing a current consumer runs is touched.

### 4.2 Options

```ts
interface StagedRetrievalOptions {
  name: string;                 // reported as `strategy`
  storeKey: string;             // reported as `store`
  candidates: number;           // records per source per query — required, never derived
  sources: CollectionStore;     // primary + companions (from bind())
  collapse: ICollapseRule;
  rerank?: {
    reranker: IReranker;
    onFailure: 'stage1' | 'error';      // 'stage1' = 30.1.0 behaviour
    split?: { splitter: IQuerySplitter; queryEmbedder: IQueryEmbedder };
    keepStage1Top?: number;             // §4.6, default 0
  };
  cut?: IItemCut;               // absent → TopItemsCut (caller's k)
  sourceFilter?: (source: string, options?: CallOptions) => CallOptions | 'skip'; // §7.6
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics };
}
```

- `candidates` is required for the same reason as `RerankAllRetrieval.maxCandidates` in 30.1.0:
  "configured, never derived from an assumed catalog size".
- `split` lives **inside** `rerank`: a split without a reranker does not compile (measured: an
  embedding-only clause split loses recall, §2).

### 4.3 One query, step by step

```
for each source (primary + companions), in parallel:
  source.query(query, candidates, options')    ← identity filter applied IN the store, before top-N
merge hits
  → collapse (ICollapseRule)                   ← records → items; runs only on filtered hits
  → resolve item text (§4.5); drop orphans
  → rerank items on their full text (optional)
  → cut (IItemCut), k = items
```

- **Owner invariant:** collapse only ever sees what the store returned under the caller's identity
  filter, so it is always *after* the owner filter. The only extra read, `getById` for item text,
  is checked with `matchesRagIdentity` against the same filter; a record that fails it is dropped.
- **Records without `itemId`** (e.g. today's `skill:*` records in the tools store) pass through as
  their own item, keyed by `metadata.id`. That is how skills keep 30.1.0 behaviour inside a store
  that has a profile (§6.6).
- **Result shape.** Each returned `RagResult` is an **item**: `text` = item text, `score` = the
  rule's score (or the reranker's), `metadata` = the canonical (else best) primary hit's metadata
  with `id = itemId` and `matchedKinds: string[]`. `toolNameFromRecord`, `ToolSelectHandler`,
  `tool-loop` and `IToolsRagHandle` therefore work unchanged.

### 4.4 Clause split

- With `rerank.split` set and `splitter.split(text)` returning ≥ 2 clauses: run §4.3 for the whole
  query **and** for each clause (each clause embedded with the injected `IQueryEmbedder`, each
  reranked against its own clause text), in parallel.
- Union in order: whole query, then clause 1, 2, …; de-duplicated by `itemId`, keeping the best
  score. Each run is cut to k items, so the union holds at most `k × (1 + clauses)` items — the
  measured R3c behaviour (9.4 tools on average at k=5, two collections).
- Built-in splitter: `ConjunctionSplitter` — English rules only (`and`, `then`, `, then`, `;`,
  `after that`). Tool search text is English by the repo's standing rule (CLAUDE.md, "MCP tool-RAG
  language constraint"), so no other language is built in; a consumer injects its own splitter.

### 4.5 Where the reranker sees the item's full text

Resolution order for each collapsed item:

1. a primary hit of the item that is canonical → its `text`;
2. a primary hit that is not canonical → its `metadata.itemText`;
3. a `peer` companion hit → the same two rules inside that companion;
4. only `variants` companion hits → `primary.getById(itemId)` (identity-checked);
5. nothing found → **orphan**: dropped and counted (`outcome=orphan`). A stale generated intent for
   a tool that no longer exists can therefore never surface.

Why `itemText` is stored on non-canonical primary records: zero extra round trips per query; the
index-size cost is small (measured: 711 records, 4.4 MB vectors for 237 tools). Companion
`variants` records do **not** carry it, so they never go stale against the provider's text.

### 4.6 Optional `keepStage1Top`

`keepStage1Top: n` adds the stage-1 (collapsed, pre-rerank) top-n items to the reranked result
(union, de-duplicated). This is the measured "R3c ∪ faceted top-3" (1.000), which was chosen after
seeing the data. Default 0. **Decision for the user** — D10.

### 4.7 Built-in parts

| Part | Class | Behaviour |
|---|---|---|
| collapse | `MaxScoreCollapse` | item score = best record score (measured winner). Count / RRF are **not** shipped. |
| cut | `TopItemsCut` | first `requestedK` items (default) |
| cut | `ScoreFloorCut({ minItems, maxItems, minScore })` | first `minItems`, then more up to `maxItems` while `score ≥ minScore` (measured "top-3 then up to 8") |
| cut | `FixedItemsCut(k)` | ignores the caller's k — for a store whose profile owns k |
| split | `ConjunctionSplitter` | §4.4 |

**k in items.** The caller's k (`ragQueryK ?? 10` in `rag-query`, 20 in `IToolsRagHandle` and the
controller's `selectTools`) arrives unchanged; under a profile it counts items. A consumer that
wants its own number uses `FixedItemsCut`. The library chooses no k of its own.

**Score scales.** After a reranker, scores are the reranker's; the global `IToolSelectionStrategy`
still runs on the flattened results of all stores, as in 30.1.0. A per-store threshold therefore
belongs in the profile's cut, not there (documented next to `ScoreFloorCut`).

---

## 5. Builder and YAML

### 5.1 Library (SmartAgentBuilder)

| Method | What |
|---|---|
| `withToolsProfile(profile: ICollectionProfile<ToolItem>)` | **new.** The builder binds the profile to its own `tools` store (set by `setToolsRag` or auto-created), fills it through `bound.index` at build (where `vectorizeMcpTools` runs today) and applies `bound.retrieval` like an explicit `withRetrievalStrategy('tools', …)`. |
| `withRetrievalStrategy(key, bound.retrieval)` | **existing.** Any other store: the consumer binds the profile itself and fills it with `bound.index(...)`. Pure DI; no new method needed. |
| `withExperience(cfg)` | **new**, §7.8. |

Rules (pattern 5, "unsupported is an error"; checked at `build()`):

- `withToolsProfile` + `withRetrievalStrategy('tools', …)` → error (two owners of one store's
  ranking).
- A store already wrapped by a binding (brand on `StrategyRag`, walked through `IRagDecorator`) is
  not bound twice — the server binds at creation, the builder reuses it (same idempotency as
  `applyRetrievalStrategy`).

Type check: `withToolsProfile(experienceProfile)` does not compile (`ICollectionProfile<ToolItem>`).

### 5.2 Server YAML (`smart-server.yaml`)

```yaml
rag:
  retrieval:              # unchanged (30.1.0). A key may not appear here AND under profiles.
    history: { strategy: embedding }
  profiles:               # new; absent → 30.1.0 behaviour
    tools:
      profile: mcp-tools
      records: { operation: true, object: true }   # `full` is always written
      candidates: 30
      rerank:                                        # optional
        reranker: decision | llm                     # same values/validation as rag.retrieval
        llm: reranker                                # for reranker: llm
        question: tool                               # default tool for mcp-tools
        onFailure: stage1                            # stage1 | error
        split: conjunctions                          # none | conjunctions
      cut: { kind: top-items }                       # top-items | fixed-items {k} | score-floor {minItems,maxItems,minScore}
      generated:                                     # optional companion collection
        store: { …same shape as rag.store… }
        fill: external                               # external | build  (D3)
        llm: intents                                 # required for fill: build
    experience:
      profile: experience
      store: { … }                                   # user-owned cases
      globalStore: { … }                             # optional peer store, global cases
      extractor: { llm: helper }
      triggers: { sessionEnd: true }                 # explicit API is always on (D5)
      confirmation: tool-evidence                    # tool-evidence | user (D6)
      ttlDays: 0                                     # 0 = no expiry (D8)
      turnBuffer: { maxTurns: 50, maxResultChars: 2000 }
      retrieval: { candidates: 15, cut: { kind: fixed-items, k: 3 } }
```

- Parsed **only** by the server (`resolve-collection-profiles.ts` in server-libs, beside
  `resolve-retrieval.ts`); components receive instances. Rerankers are resolved through the same
  code as `rag.retrieval` (one `DecisionReranker` per wording, `makeDecisionModel` seam).
- Stores are built through the existing `makeRag` seam, so they share the server's embedder (a
  companion must use the primary's embedder; this is how the server builds it).
- Profile names resolve through a registry passed in the composition deps
  (`collectionProfileFactories`, like `embedderFactories`): built-ins `mcp-tools`, `experience`; a
  consumer registers its own. Unknown name → startup error.
- Validation (raw YAML, as in #321 §13.4): unknown profile / key under both `retrieval` and
  `profiles` / `split` without `rerank` / `fill: build` without `llm` / an `llm` key not in `llm:` /
  non-positive `candidates` / `minItems > maxItems` / `profiles.tools` with a profile that is not a
  tools profile → startup error, never a silent drop.
- Server-wide like `rag.retrieval`: worker configs that declare `rag.profiles` are rejected; workers
  get the main config's bindings by key.

---

## 6. Default profile 1 — `McpToolsProfile`

### 6.1 Constructor

```ts
new McpToolsProfile({
  records: { operation: boolean; object: boolean },   // full is not an option: always written
  candidates: number,
  rerank?: StagedRetrievalOptions['rerank'],
  cut?: IItemCut,
  generated?: { indexer?: IItemIndexer<ToolItem>; fill: 'external' | 'build' },
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics },
})
```

`bind({ key, rag, companions: { generated: { rag: g, role: 'variants' } } })`.

### 6.2 Records (primary store, provider text only)

| Kind | Id | Text | Written when |
|---|---|---|---|
| `full` (canonical) | `itemId` (= the 30.1.0 id) | `Tool: <name> — <description>` + `\nParameters: <p1>, <p2>, …` when there are any | always |
| `operation` | `${itemId}#operation` | `<name words> — <first clause of description>` | `records.operation` and a non-empty first clause |
| `object` | `${itemId}#object` | `<name words after the first word>` | `records.object` and the name has ≥ 2 words |

- Metadata on every record: `name` (exposed), `itemId`, `recordKind`, `profile: 'mcp-tools'`,
  owner `global` (tool catalogs are global; no identity keys, as today). Non-canonical records
  carry `itemText` = the `full` text.
- **Deterministic derivation** (`deriveToolFacets`, pure, unit-tested on a table):
  - name words: split `originalName` on camelCase, acronym, `_`, `-` and digit boundaries;
    lowercase; drop a namespace prefix (`server__`). `GetATCFindings` → `get atc findings`.
  - first clause: description up to the first `.`, `;`, `:` or newline; leading bracket tags such
    as `[read-only]` removed; at most 200 characters.
  - No lexicon, no synonyms, no LLM: every word comes from the provider. A rule that would produce
    nothing produces no record — never a made-up word.
- **Why these three:** measured V1d (full + deterministic op + object) = 0.966 at k=5, best MRR
  (0.924); no LLM step. The full record is never optional (facets-only lost: 0.885).
- The goal's rule holds: nothing is written over provider text. A weak description is fixed at its
  source.

### 6.3 Generated intents — a separate collection (goal decision)

- `LlmIntentIndexer(llm, { prompt? })` writes `intent` records `${itemId}#intent:<n>` to the
  **companion** store only. Owner `global`. No `itemText` (§4.5). Prompt: English, domain-neutral,
  overridable.
- `fill: 'build'`: at build, for each tool whose `${itemId}#intent:0` is missing in the companion
  (`getById`), generate and write (fill-once). `fill: 'external'`: the framework never writes it; a
  consumer fills it (e.g. at deploy). **Decision for the user** — D3.
- Turning the generated part off = unbind the companion; the provider records are untouched.
  Rebuilding it = clear the companion store and refill.

### 6.4 Retrieval defaults (from the measurements)

| Knob | Without reranker | With a cross-encoder reranker |
|---|---|---|
| `candidates` | 15 records | 30 records |
| cut | `TopItemsCut`; recommended `FixedItemsCut(8)` per store | `FixedItemsCut(5)` per store |
| split | not allowed (typed) | `ConjunctionSplitter` |
| question | — | `TOOL_QUESTION` |

These are documented recommendations; `candidates` has no library default (required).

### 6.5 Filling — `vectorizeMcpTools`

- The record maker becomes an `IItemIndexer<ToolItem>`. Default: `SingleRecordToolIndexer` — the
  exact 30.1.0 record (`Tool: ${name} — ${description}`, id from `IToolRecordKey`, metadata
  `{ name }`). A golden test pins id, text and metadata byte for byte on the committed snapshot.
- With a profile: `vectorizeMcpTools` builds `ToolItem`s (exposed name, provenance's original name,
  record key, description, parameter names) and calls `bound.index(items, { scope: 'global' })`.
- Accounting counts **items** (`vectorized` = items with every record written; `failed` = item
  names). The `toolCatalog` health counters keep their meaning (tools), plus `records`.
- All records of all items are embedded in **one** batch pass (`embedDocuments`, respecting
  `IBatchSizeLimited`) and written with `upsertManyPrecomputedRaw` where available — the existing
  batch path, now fed records instead of tools. Sequential fallback and pacing are unchanged.

### 6.6 Tools and builder skills in one store

Today `vectorizeSkills` writes `skill:<name>` records into the tools store
(`builder.ts:1356-1358`), and goal 8 keeps skills on 30.1.0 behaviour. Decided: **coexist by
pass-through**.

- Skill records are written exactly as today (no `itemId`), so `StagedRetrieval` passes each one
  through as its own item (§4.3). They compete for k as they do today; a reranker on the tools store
  scores them with the tools question, as `rerank` on `tools` already does in 30.1.0.
- `skill-select` finds them by id as today (with fix F3).
- Moving skills to their own store would change their k, ranking and stage layout — a behaviour
  change goal 8 excludes. **Decision for the user** — D4 (recommendation: coexist now; a skills
  profile later through the same contract).

### 6.7 Store migration

A store is filled by one profile. Turning a profile on adds records next to the 30.1.0 ones (the
canonical id is the 30.1.0 id); turning it off leaves facet records behind that the 30.1.0 path
would rank as records. So switching profiles on a persistent store = a fresh collection
(redeploy), like an embedder change. Every record carries `profile` in metadata for diagnosis.
In-memory tool stores (rebuilt every boot) need nothing.

---

## 7. Default profile 2 — `ExperienceProfile`

### 7.1 The case

```ts
export interface ExperienceCase {
  readonly caseId: string;                 // `exp:<hash(owner, signature)>` — deterministic
  readonly owner: RecordOwner;             // from the session identity, never from the LLM
  readonly inputs: { task: string; context?: string; system?: string };
  readonly symptoms: ReadonlyArray<{ kind: 'message' | 'error' | 'code'; text: string }>;
  readonly decision: string;               // what was decided
  readonly actions: readonly string[];     // what was done
  readonly outcome: {
    readonly helped: readonly OutcomeItem[];
    readonly didNotHelp: readonly OutcomeItem[];
    readonly status: 'resolved' | 'partial' | 'unresolved';
  };
  readonly occurrences: number;
  readonly source: { sessionId: string; turns: readonly number[] };
  readonly createdAt: string; readonly updatedAt: string;
  readonly schemaVersion: 1;
}
export interface OutcomeItem {
  readonly what: string;
  readonly evidence: ReadonlyArray<{ turn: number; toolCall: number }>;
  readonly confirmedBy: 'tool-result' | 'user';
}
```

### 7.2 Records per case

| Kind | Id | Text |
|---|---|---|
| `case` (canonical) | `caseId` | the whole case rendered as English text: inputs, symptoms, decision, actions, what helped, what did not |
| `symptoms` | `${caseId}#symptoms` | symptom texts and codes, one per line |
| `inputs` | `${caseId}#inputs` | task + context + system |

All carry the owner keys, `metadata.case` (the JSON) and, on non-canonical records, `itemText`.
Retrieval by a new situation's symptoms or inputs hits `symptoms` / `inputs`; collapse by
`caseId`; the case comes back **whole** (rendered text + JSON), including what failed.

### 7.3 Extraction — when and who

| Trigger | How | Default |
|---|---|---|
| explicit | `IExperienceRecorder.record(source, options)` — library API | always available |
| end of session | session close → the recorder detaches the session's turn buffer and enqueues extraction | on when the profile is configured, behind the gate (D5) |
| background pass | not a framework scheduler; a consumer calls `record` from its own job | — |

- **Turn capture:** a new optional `IHistoryTurnSink.onTurn(turn, options)`; the pipeline emits a
  `turn-capture` step after the tool-loop **only when a sink is registered** (the default stage
  list is unchanged). `SessionTurnBuffer` keeps `HistoryTurn`s per session, bounded by
  `maxTurns` / `maxResultChars` (required constructor options; the server's YAML supplies values).
- **Session end:** new optional `ISessionEndListener.onSessionEnd(sessionId, options)`, called by
  `SmartAgent.closeSession` and by the session graph's dispose **before** `closeSession` deletes
  session collections. It only detaches the buffer and enqueues; it never blocks dispose and is
  never cut by a timeout. A failure is logged; the session still closes.
- **Gate** (`IExtractionGate`, injected): default `SymptomThenSuccessGate` — extract only when the
  session has an error symptom followed by a later successful tool result. Deterministic; no LLM
  call for sessions with nothing to learn.
- **Extractor** (`IExperienceExtractor`, injected): default `LlmExperienceExtractor(llm, { prompt? })`.
  English prompt; output must parse as the draft schema (whole reply JSON, one fence allowed —
  the `LlmReranker` contract). Invalid output → error, nothing stored, never partially filled.
  Every `helped` / `didNotHelp` item must cite `{ turn, toolCall }`.

### 7.4 Confirming outcomes — a guess is never stored as a fix

`IOutcomeConfirmation.confirm(draft, turns)` (injected) returns the confirmed case or a rejection.

| Policy | Rule |
|---|---|
| `ToolEvidenceConfirmation` (default, D6) | a `helped` item stands only if a cited tool result exists and is not an error, and the same symptom does not recur later in the session; a `didNotHelp` item needs a cited error result. Items that fail are dropped. A case with no confirmed item is not stored. |
| `UserConfirmation` | only `record(..., { confirmedBy: 'user' })` calls store cases; their items are `confirmedBy: 'user'`. |

The ground truth is the **tool results**, not the model's prose — the same rule the hub's honesty
reviewer applies.

### 7.5 Owner, visibility, isolation

- The recorder takes the owner from the session identity (`options.userId`); the extractor's output
  has no owner field, so the LLM cannot choose who sees a case.
- Default visibility: **user** (`metadata.userId`, no `sessionId`, so the case outlives the
  session). **Global** cases live in an optional `peer` companion store and are written only by an
  explicit `promote(caseId)` call. **Team / role** waits for #304 (no such scope exists today).
  **Decision for the user** — D7.

### 7.6 Retrieval

- `StagedRetrieval` over the user store (+ the global peer). `sourceFilter` sets
  `ragFilter.userId = options.userId` for the user store and **skips** it when there is no
  `userId` (fail closed); the global store is queried without an identity filter.
- Collapse by `caseId` (`MaxScoreCollapse`), optional reranker with `PASSAGE_QUESTION`, cut
  `FixedItemsCut(3)` recommended.
- Paths: the store is registered as a collection, so it is projected and queried as
  `rag-experience` each request, through its strategy. A symptom-driven lookup mid-loop
  (`IExperienceLookup.find({ inputs?, symptoms? })`) is a library API; exposing it as an auxiliary
  tool `experience_lookup` is **Decision for the user** — D9.

### 7.7 Duplicates, merging, retention

- **Duplicates by construction:** `caseId = exp:` + hash(owner, normalized symptom codes/texts,
  decision). The same problem solved the same way again → same id → merge: read the existing case
  (`getById`), union `helped` / `didNotHelp`, `occurrences + 1`, newest `updatedAt`, re-index.
  Concurrent merges: last write wins; the store owns concurrency (no locks in the framework).
- **Fuzzy merging** of similar but not identical cases: an injected `IExperienceMerger`; none by
  default (an absolute similarity threshold is language-biased, §2).
- **Retention:** default none. `ttlDays > 0` sets `metadata.ttl` (honoured by `VectorRag`,
  `InMemoryRag`, qdrant, pg-vector and hana — verified in source). `forget(caseId)` removes all of
  a case's records (`bound.remove`). **Decision for the user** — D8.
- **Sensitive data:** cases may quote tool results. An optional injected `ICaseRedactor` runs before
  indexing; none by default. Documented in the profile's docs.

### 7.8 Wiring

`builder.withExperience({ profile, recorder: { extractor, confirmation, gate, buffer }, store })`
registers the turn sink, the session-end listener, the collection, and its retrieval strategy. The
server builds the same from `rag.profiles.experience`.

---

## 8. Observability — through the existing channels

### 8.1 What a binding reports

| Channel | Existing? | What |
|---|---|---|
| span `retrieval` (child of the request trace, via injected `ITracer`) | tracer: yes | attrs `store`, `strategy`, `candidates.records`, `items.collapsed`, `items.returned`, `clauses`, `rerank.outcome` (`none\|ok\|fallback\|error`), `orphans` |
| `IRetrievalMetrics.retrievalOutcome` counter | new small interface on the same metrics backend | attrs `store`, `strategy`, `outcome` ∈ `ok`, `rerank_fallback`, `rerank_error`, `orphan`, `empty` |
| session step `retrieval_rerank_error` | yes (30.1.0 name kept) | unchanged |
| `/health` | yes | `metrics.retrievalOutcome` when the metrics implement `IRetrievalMetrics`; `components.toolCatalog.records` / `.profile`; `components.experience { recorded, rejected, failed, pending }` |
| request logger | yes | reranker / extractor LLM calls, as today (`component: 'rerank' \| 'experience'`) |

### 8.2 The 30.1.0 rerank strategies too

`RerankedRetrieval` and `RerankAllRetrieval` accept the same optional `telemetry` (additive
constructor option). This closes the goal's evidence item ("a fallback is only a session step")
for consumers that do not adopt profiles. `InMemoryMetrics` and `NoopMetrics` implement
`IRetrievalMetrics`. No new log sink, no new logger.

### 8.3 Failure policy

`onFailure: 'stage1'` (default) = 30.1.0: stage-1 order, counted as `rerank_fallback`.
`onFailure: 'error'` = the strategy returns the `RagError` (counted as `rerank_error`), so the
stage reports it — for consumers that prefer no answer to an unranked one.

---

## 9. In-scope fixes

### 9.1 F1 — the store's embedder behind `StrategyRag`

- **Bug:** `vectorizeMcpTools` reads `(toolsRag as any).embedder`
  (`vectorize-mcp-tools.ts:168-171`). With `rag.retrieval.tools` set, SmartServer passes a
  `StrategyRag` (`smart-server.ts:1550`), which has no such field, so vectorization silently drops
  to one tool at a time — slower, and the 429-prone path of #236.
- **Fix:** `retrievalEmbedderOf(rag)` walks `IRagDecorator.inner`; stores declare
  `IRetrievalEmbedderOwner` (`VectorRag`, `QdrantRag`, `PgVectorRag`, `HanaVectorRag`; their
  existing private field becomes the capability). `InMemoryRag` has none → sequential path, as
  today. The `any` cast is removed. **Decision for the user** — D11 (touches three provider
  packages).
- **Test:** SmartServer with `rag.retrieval.tools: { strategy: rerank }` → `embedDocuments` is
  called in batches; no per-tool writes.

### 9.2 F2, F3 — de-duplication

- **F2** `tools-rag-handle.ts:66-73`: no de-duplication; a tool with two hits is pushed twice. Fix:
  keep the first occurrence per name (order preserved).
- **F3** `skill-select.ts:33-38`: `id.slice(6)` turns `skill:<name>:<suffix>` into the name
  `<name>:<suffix>`. Fix: `skillNameFromRecord(meta)` — `metadata.name` first (written by
  `vectorizeSkills`), else the id without `skill:` and without a `:…` / `#…` suffix; a `Set`
  de-duplicates. Lives beside `toolNameFromRecord` in `tool-record-key.ts`.
- Both are correct with or without a profile.

### 9.3 `IToolIndexingStrategy` — deleted

- `packages/llm-agent/src/rag/tool-indexing-strategy.ts` is not exported (not in `rag/index.ts`,
  not in the package `exports` map) and not wired anywhere — deleting it breaks no consumer.
- Replaced by `IItemIndexer<ToolItem>`: `OriginalToolIndexing` → `SingleRecordToolIndexer`;
  `IntentToolIndexing` → `LlmIntentIndexer` (companion only, neutral prompt);
  `SynonymToolIndexing` is **not** ported — its hard-coded verb synonyms are words the provider did
  not write, which the goal forbids in the primary store.
- Docs that describe it as usable are rewritten to describe collection profiles:
  `docs/INTEGRATION.md:1516-1550`, `docs/PERFORMANCE.md:335-355`,
  `docs/ARCHITECTURE.md:584, 608-611`.

---

## 10. Package placement

| What | Package | Why |
|---|---|---|
| All contracts of §3, §7.1 and the experience interfaces | `@mcp-abap-adt/llm-agent` | shared by libs, server-libs and consumers |
| `StagedRetrieval`, cuts, `MaxScoreCollapse`, `ConjunctionSplitter`, `McpToolsProfile`, indexers, `ExperienceProfile`, recorder, buffer, extractor, confirmations | `@mcp-abap-adt/llm-agent-libs`, `src/collections/` (small modules) | the retrieval built-ins, rerankers and the builder that uses them already live here; `llm-agent-rag` is the backend/embedder factory layer **below** libs and has no rerankers or LLM steps |
| YAML resolver + validation | `@mcp-abap-adt/llm-agent-server-libs` | beside `resolve-retrieval.ts` |
| `IRetrievalEmbedderOwner` implementations | `llm-agent` (`VectorRag`), `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | where the stores are |
| Cohere / cross-encoder reranker | a separate provider package, follow-up PR | D2 |

**Decision for the user** — D1 (libs vs a new `llm-agent-collections` package).

New files carry no per-file licence header (the repo has none); every package stays
`LGPL-3.0-only` in `package.json`.

---

## 11. Query preparation and #323

Decided: **query preparation is not part of a profile in this PR.** The `translate` stage, the
in-store `IQueryPreprocessor` and the (dead) `IQueryExpander` stay where they are; the profile owns
only the clause split, which is retrieval-time and per store. Reasons: one rewrite per request is
shared by all stores (a per-profile rewrite would multiply LLM calls by the number of stores), and
rerankers already see the text the stores see. So #323 stays a pipeline fix (emit `expand`) in its
own PR. **Decision for the user** — D12.

---

## 12. Compatibility and migration

- **No profile configured → no change.** Same records (golden test), same stages, same k
  semantics, same `RerankHandler` precedence, same YAML.
- Removed: only the unexported `IToolIndexingStrategy` file.
- Added, all optional: the contracts of §3, two builder methods, one YAML section, optional health
  fields, the embedder capability, telemetry options on the 30.1.0 rerank strategies.
- Release: a **minor** version.
- Opting in on a persistent tools store = a fresh collection (§6.7).
- Docs updated in the same PR: `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`,
  `docs/PERFORMANCE.md`, `docs/EXAMPLES.md` (YAML), `docs/TROUBLESHOOTING.md` (rerank fallback
  metric; switching profiles needs a fresh collection), `CLAUDE.md` key API notes.

---

## 13. Tests

### 13.1 Unit (`npm test`)

- `deriveToolFacets`: table — `GetWhereUsed`, `GetATCFindings`, `RuntimeListFeeds`,
  `server__ReadClass`, `snake_case_tool`, single-word name, empty / tag-only description.
- Indexers: deterministic ids; canonical id = item id; owner flattening for all three scopes;
  `itemText` only on non-canonical primary records; generated records only in the companion.
- Type checks (`__typechecks__`): a record without `owner` fails; extras setting `itemId` fail;
  `split` without `rerank` fails; `withToolsProfile(experienceProfile)` fails.
- `StagedRetrieval`: max collapse; k counts items; skill records pass through; item-text order and
  orphan drop; `getById` result outside the identity filter dropped; both failure policies; clause
  union and its bound; `keepStage1Top`; every cut; telemetry (span attributes, counter, session step).
- `vectorizeMcpTools`: golden test of the default path; item accounting with a profile; one batch
  for all records; F1 regression through `StrategyRag` and `FallbackRag`.
- F2 / F3.
- Precedence: a profiled store is skipped by `RerankHandler`; binding is idempotent (server +
  builder).
- Experience: strict extractor parse; both confirmation policies; owner from the session only;
  fail-closed user filter; global peer; same signature → one case, merged; `ttlDays`; `forget`;
  session end detaches the buffer before `closeSession`; gate skips trivial sessions.
- YAML: every validation rule of §5.2 through the real `resolveSmartServerConfig`.

### 13.2 Conformance kit

`@mcp-abap-adt/llm-agent/testing/collection-profile-conformance` (beside
`rag-filter-conformance`): for any `ICollectionProfile` — owner keys on every record, deterministic
ids, canonical id = item id, at most k distinct items returned, no record outside the caller's
identity filter returned. A consumer runs it against its own profile.

### 13.3 Measurement harness

- `scripts/rag-eval` gains `--profile baseline|mcp-tools`, `--records`, `--candidates`, `--split`,
  `--cut`, and **required-recall** (AND of OR-groups; an optional `required` field in the queries
  file), average items returned and MRR — the hub's metrics.
- The core is exported as `evaluateRetrieval({ store, strategy, cases, ks })` from
  `@mcp-abap-adt/llm-agent-libs/testing`, so a consumer runs its own catalog and labels against a
  build of this branch (the PR's "consumer check" stage).
- Acceptance: on the committed 16.0.0 snapshot, `mcp-tools` without a reranker is not worse than
  baseline at equal items; the hub's consumer check reproduces its V1d numbers within ±1 row.
  Env-gated, not part of `npm test`.

---

## 14. Out of scope

| Item | Where |
|---|---|
| #323 query expander never applied | own PR, after this spec (§11) |
| #304 isolation (role/team scope) | own PR; this spec only requires owner keys on every record and collapse after the owner filter |
| #326, #327 embedder breaker / signal | own PRs; profiles embed through the existing `IRetrievalEmbedder` seam and add no breaker logic |
| #324, #314, #291, #290, #247 | own PRs (unrelated) |
| Cohere / cross-encoder reranker provider | follow-up package (D2) |
| Profiles for skills, user collections, session history | later, through the same contract (goal 8) |
| BM25 identifier tokenization (`ZDEMO_D_TEST` → `test`) | separate change to the in-store scoring (`ISearchStrategy` / tokenizer) |

---

## 15. Architecture-principle check

1. **Built on existing components:** `IRag`, `IRetrievalStrategy`, `StrategyRag`,
   `applyRetrievalStrategy`, `IReranker`, `DecisionReranker`, `vectorizeMcpTools`'s batch path,
   the `makeRag` seam, `IRagDecorator`, `matchesRagIdentity`, metadata `ttl`.
2. **The app is the example:** SmartServer selects profiles from YAML through the same builder API.
3. **Interfaces:** consumers depend on `ICollectionProfile` / `IRetrievalStrategy`.
4. **ISP:** new small interfaces; `IRag`, `IReranker`, `IMetrics`, `IRetrievalStrategy` not grown.
5. **Strategies:** indexer, collapse, cut, splitter, reranker, extractor, confirmation, gate,
   merger, redactor — all injected; the library picks no k and no candidate count.
6. **File size:** new logic in `src/collections/*`; `builder.ts` and `smart-server.ts` get one call
   site each per binding.
7. **Additive:** the only removal is an unexported, unwired file.

---

## 16. Decisions for the user

| # | Question | Recommendation |
|---|---|---|
| D1 | Default implementations: `llm-agent-libs` or a new `llm-agent-collections` package? | **libs** — the retrieval built-ins and the builder are there; a new package would depend on libs and add a release step for no isolation gain. |
| D2 | Cohere / cross-encoder reranker in this PR? | **Follow-up**: a provider package (e.g. `@mcp-abap-adt/sap-aicore-reranker`, like the embedder packages) plus a `makeReranker` composition seam; `IReranker` needs no change, so this PR does not wait for it. |
| D3 | Generated intents: `fill: external` or `build` by default? | **external** — LLM calls at boot are slow and non-deterministic; the hub already generates at deploy. `build` stays available. |
| D4 | Builder skills: coexist in the tools store or move to their own store now? | **Coexist** (pass-through) — moving changes their k and ranking, which goal 8 excludes. |
| D5 | Experience extraction triggers by default | **Explicit + session end, behind the deterministic gate** — cases are captured without an LLM call per trivial session. |
| D6 | Confirmation policy by default | **`ToolEvidenceConfirmation`** — an outcome stands only on a cited tool result; `UserConfirmation` for consumers that want a human in the loop. |
| D7 | Visibility of cases | **User** by default; global only via `promote`; team after #304. |
| D8 | Retention | **No expiry** by default; `ttlDays` and `forget(caseId)` available. |
| D9 | Expose `experience_lookup` as an auxiliary tool in this PR? | **Yes, opt-in** — without it a symptom seen mid-loop never reaches the experience store. |
| D10 | Ship `keepStage1Top` (the post-hoc 1.000 union)? | **Ship, default 0**, documented as not yet validated on fresh queries. |
| D11 | Replace the private embedder read with `IRetrievalEmbedderOwner` (3 provider packages) in this PR? | **Yes** — the cast is the root cause of F1 and the new batch indexing needs the same embedder. |
| D12 | Query preparation outside profiles; #323 as a pipeline fix | **Yes** (§11). |
