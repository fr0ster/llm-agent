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
  - **indexing**: one source item → several **records**, each carrying `itemId`, `recordKind`,
    **owner keys** and a **visibility**;
  - **retrieval**: candidates **counted in items** → **collapse records back to items** → optional
    reranker on the item's **provider text** → final cut **counted in items** (`StagedRetrieval`,
    an `IRetrievalStrategy`).
  - What joins them: the record schema (`itemId`, `recordKind`, owner) and one id function,
    `recordId(owner, itemId, kind, n)`, used by `index`, `get`, `remove` and retrieval alike.
- **Physical ids are owner-scoped (§3.1).** The logical `itemId` is not the store id. Two users
  writing the same `itemId` into one store never touch each other's records.
- **Every returned item is hydrated from its canonical record (§4.6)**, whichever record matched.
  No canonical record → the hit is dropped and counted.
- **Replacing an item is not atomic (§3.3).** It is several per-record writes. No generations, no
  locks: the writer or the store serializes concurrent writers of one item.
- **`k` is the overall limit of a retrieval, as in 30.1.0:** at most k items come back.
- **Query decomposition is an injected strategy slot (§4.5).** `StagedRetrieval` calls the
  consumer's `IQueryDecomposer` (query + budget k → sub-queries whose budgets sum to ≤ k). None
  injected → the query runs as is. No shipped variant uses it; no implementation ships.
- A profile is **bound** to each store of its kind (`profile.bind(...)`), so one profile serves
  several stores (e.g. reader and writer tool stores).
- The retrieval half **is** a 30.1.0 `IRetrievalStrategy`, so every path that already honours
  per-store strategies gets it with no new wiring.
- **Nothing changes by default.** No profile set → 30.1.0 behaviour, byte for byte (golden test).
- **Everything is a strategy (DI).** A profile is a **composition** of injected strategy
  instances: indexing, candidate pool, collapse, query decomposition (optional), reranker,
  final cut. No booleans where a strategy is the choice. YAML only maps names to instances, in the builder.
- Default profiles ship:
  1. **MCP tools — several named variants**, so the consumer has a real choice (§7):
     - `baseline` = 30.1.0 (one record per tool, top-k) — the default;
     - `faceted` = `full` + `operation` + `object` records, item pool, collapse by max;
     - `faceted-cohere` = faceted + Cohere on SAP AI Core;
     - `faceted-jev` = faceted + TypeSafe Jev (`DecisionReranker`).
     **Intents** are an indexing strategy any variant can add: an `intent` record per tool
     (default placement) or a companion collection.
  2. **`SharedItemsProfile`** — a generic shared base. Pipeline elements write items (record kinds
     of their choosing) through `index()` / `remove()`; the profile finds them and returns each
     item **whole**; every record carries owner keys and a visibility (`user` / `group` /
     `global`). What an item contains is the writing element's business, not this spec's.
- **Rerankers are alternatives** (goal 9): a new **`SapAiCoreReranker`** (Cohere on SAP AI Core, own
  package) and the existing **`DecisionReranker`** (TypeSafe Jev). Each gets a default profile
  configuration.
- A reranker that returns a wrong or missing score count is a **reranker error**, counted and
  traced — never silent.
- In-scope fixes: the store's embedder hidden behind `StrategyRag`; de-duplication in
  `tools-rag-handle` and `skill-select`; the orphan `IToolIndexingStrategy` is deleted.

---

## 1. Terms

| Term | Meaning | Example |
|---|---|---|
| **Item** | One source thing a consumer wants back | one MCP tool; one shared item |
| **Record** | One row in a store: physical id + embedded text + metadata | the `operation` record of `tool:GetWhereUsed` |
| **Item id** | The **logical** id a writer or provider chooses (`metadata.itemId`). Not unique in a store | `tool:GetWhereUsed` |
| **Record id** | The **physical** store id: owner scope + owner key + item id + kind + index (§3.1) | `g:/tool%3AGetWhereUsed#operation:0` |
| **Record kind** | Which view of the item a record is | tools: `full`, `operation`, `object`, `intent`; shared items: `item` + the writer's own kinds |
| **Canonical record** | The item's record of the indexer's `canonicalKind`, index 0. Its text is the item text; its metadata is the item's payload | `full` (tools), `item` (shared items) |
| **Owner-qualified item** | (owner scope, owner key, item id) — what collapse, `get` and `remove` key on | (`user`, `alice`, `case-42`) |
| **Provider text** | What the tool provider exports: name, description, parameter names | the `full` record's text |
| **Generated record** | A record whose text an LLM (or another generator) produced | an `intent` record |
| **Store** | One `IRag` instance, addressed by its `ragStores` key | `tools`, `tools-writer`, `shared` |
| **Source** | One store a retrieval queries, with its own identity filter | primary, intents companion, user partition |
| **Partition** | A store that holds the shared items of one visibility | the `user` store, the `global` store, one group's store |
| **Collection kind** | The kind of items a store holds | MCP tools, shared items, skills, user collections, history |
| **Profile** | The indexing + retrieval pair for one collection kind (`ICollectionProfile`) — a composition of strategies | `ComposedToolsProfile` |
| **Variant** | A named, shipped composition of strategy instances for one kind | `faceted-cohere` |
| **Binding** | A profile applied to one concrete store set (`IBoundCollection`) | `mcpTools.bind({ key: 'tools-reader', rag })` |

**One profile, several stores (goal 6).** A profile instance holds what the kind shares (records,
reranker, cut, candidate count). `bind()` is called once per store and returns that store's
indexing and retrieval. The goal's example (two tool stores, one skills store, one history store,
one user-collections store, three profiles) is: one tools variant bound twice; skills, history and
user collections on the 30.1.0 behaviour (no profile = the default profile).

**Name map (no clashes — each new name checked with `git grep -w` over `packages/`, 0 hits).**

| Taken in 30.1.0 | What it is | In this spec |
|---|---|---|
| `ISearchStrategy` | in-store scoring (vector / BM25 / fusion) | untouched |
| `IRetrievalStrategy` | wrapper around a store: candidates → rerank → top-k | reused as the retrieval half |
| `IToolSelectionStrategy` | post-filter of all stores' flattened results | untouched |
| `IToolIndexingStrategy` | orphan, unexported | **deleted** (§10.3) |
| `IQueryPreprocessor` / `IQueryExpander` | in-store / pipeline query rewrites, one text → one text | untouched; query decomposition (one query → budgeted sub-queries) is the new `IQueryDecomposer` (§4.5) |
| `RagCollectionOwner` | owner of a whole **collection** (catalog record) | untouched; a **record's** owner is `RecordOwner` |
| `IReranker` | `rerank(query, results, options)` | unchanged; both rerankers implement it |
| — | new | `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IndexedRecord`, `RecordDraft`, `recordId`, `RecordOwner`, `ItemRef`, `ICandidatePool`, `ICollapseRule`, `IItemCut`, `IQueryDecomposer`, `SubQuery`, `ISourceSelector`, `RetrievalSource`, `IRetrievalMetrics`, `ToolItem`, `IToolFacet`, `IToolIntentSource`, `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `StagedRetrieval`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `OperationFacet`, `ObjectFacet`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `SharedItemsProfile`, `SapAiCoreReranker` |

---

## 2. Why this shape (evidence → design)

Source: cloud-llm-hub, 237 tools, labelled queries, **required-recall** (every needed tool
returned). EN-ext = 87 rows (73 single-step + 14 multi-step); non-English = 26 rows.

**Noise:** 1 row ≈ **1.15 points** on EN-ext (n=87). Multi-step has only **14 rows** (1 row ≈ 7
points). Differences of 1–2 rows are noise.

### 2.1 Indexing

| Measured | Design consequence |
|---|---|
| Today (one record per tool, hybrid): 0.943 at k=5; 0.977 at k=15 with ~25 tools | baseline stays the default profile |
| `full` + `operation` + `object`, collapse by **best hit**: 0.966 at k=5; 0.977 at k=8 with ~13 tools | multi-record indexing + collapse step, k in items |
| Collapse by count or RRF is worse than max | ship **`MaxScoreCollapse` only**; the rule is an injected `ICollapseRule` |
| Facets without `full` are clearly worse (0.885) | `full` is not a facet, so it cannot be dropped (§7.3) |
| Deterministic facets = LLM facets on English (0.966 = 0.966) | default facets need no LLM |
| Intent layouts, stage 1 only (hybrid, k=5): intents inside `full` 0.954; own `intent` record 0.954; no intents 0.943; both 0.954. Differences 1–2 rows | intents are an **indexing strategy** the consumer adds; default placement **own record** (§7.3) |
| Intent layouts **with a reranker** (several records per tool): within noise of each other (goal *Evidence*) | the layout is chosen for stage-1 reasons only |

### 2.2 Retrieval

| Measured | Design consequence |
|---|---|
| Cross-encoder rerank: non-English 0.692 → 0.962; cosine stage 1, English 0.885 → 0.943 | reranker on **items** |
| Reranker text **without** intents is equal or better, for Cohere and for Jev (goal decision 2026-10-04) | the reranker reads the **provider text** only (§4.6) |
| Pool of **30 records** with several records per tool → only ~26–34 tools visible; non-English Cohere drops to **0.846–0.885** (one cell 0.808) | candidate pool sized in **items** (§4.4) |
| Pool of **30 items** (same layouts) → non-English **0.962** (Cohere) / **1.000** (Jev) | same |
| LLM as reranker: no gain, 6–10k tokens/query; a wrong score count fell back to stage 1, visible only as a session step | wrong/missing score count = reranker error, counted + traced (§9) |
| Absolute thresholds are language-biased; "top-3 then up to 8 while score ≥ t" is safe | per-store cut: top-k items (default) or `ScoreFloorCut` |
| Adding the stage-1 top-3 to the reranked items: measured only on top of the former built-in clause split, chosen after seeing the data — no number without the split | optional knob, **off** by default (§4.7) |

### 2.3 Rerankers compared (k=5, hybrid, today's one record per tool, pool 30 items)

Figures as in the goal's *Evidence* table; the misses below are the goal's account after the
2026-10-05 label correction.

| Queries | Cohere | Jev |
|---|---|---|
| all English (87) | 0.931, 8.3 tools | **0.977**, 8.3 tools |
| single-step (73) | 0.973 | **1.000** |
| multi-step (14) | 0.714 | **0.857** |
| non-English (26) | 0.962 | **1.000** |

- **Five multi-step labels were wrong:** they listed a step the first tool already takes as a
  parameter (`CreateClass` takes `transport_request`; `UpdateClass`, `CreateDomain`,
  `CreateBehaviorDefinition` take `activate`).
- **Remaining multi-step misses:**
  - Jev: only "where-used of a table, then show the users' source". Its second step depends on the
    first step's result — a separate step for the planner, not a retrieval problem.
  - Cohere: the same query, plus `CreateClass` / `UpdateClass` in two queries — its ranking, not
    multi-step.

### 2.4 Query decomposition — a slot, not a shipped behaviour

- With the corrected labels, **no shipped variant needs splitting.** The earlier measured gain came
  mostly from the mislabelled queries above and from Cohere's ranking.
- Cutting the split's union back to k was measured **worse than no split at all**.
- A genuinely dependent second step is a separate step for the planner anyway.
- **Design consequence (§4.5, goal decision 2026-10-05):**
  - the framework provides the component: an injected `IQueryDecomposer` that `StagedRetrieval`
    calls;
  - no shipped variant uses it and no implementation ships;
  - `k` stays the overall limit, as in 30.1.0;
  - a consumer's strategy is measured by the consumer (§14.3).

---

## 3. Contracts — `@mcp-abap-adt/llm-agent`

New file `packages/llm-agent/src/interfaces/collection-profile.ts`. All additive; `IRag`,
`IReranker`, `IRetrievalStrategy`, `IMetrics` are not changed.

### 3.1 Records, owners, visibility

```ts
/**
 * Who owns a record and who may see it. `scope` IS the visibility.
 * Flattened by the framework into metadata: `visibility` + the owner key.
 */
export type RecordOwner =
  | { readonly scope: 'global' }
  | { readonly scope: 'group'; readonly groupId: string }   // a team or a role, as the consumer defines it
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'session'; readonly sessionId: string; readonly userId?: string };

/** Keys the framework writes; a profile's or writer's extras can never set them. */
export type ReservedRecordKey =
  | 'id' | 'itemId' | 'recordKind' | 'itemText' | 'profile' | 'generated' | 'recordIds'
  | 'visibility' | 'userId' | 'groupId' | 'sessionId' | 'ttl';

/** What an indexer produces. The physical id is not the indexer's to choose. */
export type RecordDraft = Omit<IndexedRecord, 'id'>;

export interface IndexedRecord {
  /**
   * The PHYSICAL store id, assigned by the binding — never by the indexer:
   * `recordId(owner, itemId, recordKind, n)`, n = the record's position within its kind.
   */
  readonly id: string;
  /** The text that is embedded. */
  readonly text: string;
  /** The LOGICAL item id. Not unique in a store: two owners may use the same one. */
  readonly itemId: string;
  readonly recordKind: string;
  /** Required: no record without an owner (goal decision on #304). */
  readonly owner: RecordOwner;
  /** Set by the framework on records whose text was generated, never on provider records. */
  readonly generated?: true;
  /** Non-canonical records in an items store: the item text, for the reranker. */
  readonly itemText?: string;
  /** Profile extras (e.g. `name` for tools). */
  readonly metadata?: Readonly<Record<string, RagJsonValue>> & { readonly [K in ReservedRecordKey]?: never };
}

/** Addresses one item for get / remove. The owner selects the partition AND the record ids. */
export interface ItemRef {
  readonly itemId: string;
  readonly owner: RecordOwner;
}

/** The one id function. Pure and deterministic; exported so a consumer's own profile uses it too. */
export function recordId(owner: RecordOwner, itemId: string, kind: string, n: number): string;
```

**Physical record ids (owner-scoped).**

- **Why:** the logical `itemId` is the writer's choice, so two users can pick the same one. Every
  backend addresses records by id alone, with no owner in the key (verified in the repo):
  - `InMemoryRag.upsert` replaces in place when `metadata.id` matches
    (`in-memory-rag.ts:113-123`); `getById` and `writer().deleteByIdRaw` match on `metadata.id`
    only;
  - `VectorRag` replaces the slot with the same `metadata.id` (`vector-rag.ts:126`);
  - pg-vector: `id VARCHAR(255) PRIMARY KEY` with `ON CONFLICT`; HANA: `id NVARCHAR(255) PRIMARY
    KEY` with `UPSERT … WITH PRIMARY KEY`; Qdrant: the id is hashed to a point UUID
    (`deterministicUUID`).
  - So with `id = itemId`, user B's write of `case-42` would overwrite user A's `case-42`, and
    B's `remove` would delete it. The owner must be **in the id**.
- **Format:**

  ```
  readable = `${scope}:${enc(ownerKey)}/${enc(itemId)}#${enc(kind)}:${n}`
  recordId = readable.length <= 200 ? readable : `h:${sha256hex(readable)}`
  ```

  | Owner | `scope` | `ownerKey` |
  |---|---|---|
  | `global` | `g` | empty |
  | `group` | `grp` | `groupId` |
  | `user` | `u` | `userId` |
  | `session` | `s` | `sessionId` (the optional `userId` is not part of the key) |

  - `enc` = `encodeURIComponent`, so `:`, `/` and `#` inside a key or item id can never shift a
    field boundary (`u:a%2Fb/c…` ≠ `u:a/b%2Fc…`).
  - `n` = the record's 0-based position within its kind; the canonical record is
    (`canonicalKind`, 0).
  - **Length:** pg-vector and HANA cap the id at 255 characters. Ids longer than 200 become
    `h:` + 64 hex characters (66 total) — still deterministic, so `get` and `remove` recompute the
    same id. Readability is not needed: `itemId`, `recordKind` and the owner keys are in metadata.
- **Applied everywhere, one function:** `index` assigns ids with it; `get` and `remove` compute the
  canonical id from `ItemRef`; retrieval computes the canonical id from a hit's owner metadata +
  `itemId` (§4.6); collapse keys on the owner-qualified item (§3.4). No code path addresses a
  record by the bare `itemId`.
- **Consequence:** under a profile, `rag.getById(itemId)` on the raw store finds nothing; use
  `bound.get(ref)`. Returned items still carry `metadata.id = itemId` (§4.3), so name-based
  consumers see what they saw before.

- **Why `owner` is a typed field, not metadata:** a record without owner keys does not compile.
- **Flattening:** `user` → `metadata.userId`; `session` → `sessionId` [+ `userId`]; `group` →
  `groupId`; `global` → none. Always `metadata.visibility = scope`. Existing stores' identity filter
  (`IRag.query`: `userId`, `sessionId`) keeps working unchanged.
- **`group` has no store filter.** No `IRag` filters on `groupId` (only `userId` / `sessionId`
  exist). So group isolation is **per store**, chosen by the consumer (§8.3, #304). The key is
  still written, for audit and for a later filter.
- **Why `ReservedRecordKey` is `never` in extras:** a profile or writer cannot overwrite what
  collapse and isolation depend on — a compile-time check, not a runtime guard.
- **`RecordOwner` vs `RagCollectionOwner`:** the existing type owns a whole collection and has no
  `group`; a record needs `group` and an optional `userId` on `session`. Two shapes, two names.

### 3.2 Indexing half

```ts
/** The indexing strategy. */
export interface IItemIndexer<TItem> {
  readonly name: string;
  /** Upper bound on the records it makes per item (canonical included). Sizes the item pool (§4.4). */
  readonly maxRecordsPerItem: number;
  /** The kind of the item's canonical record (`full` for tools, `item` for shared items). */
  readonly canonicalKind: string;
  /** Pure mapping item → record drafts. An items-store indexer makes exactly one draft of
   *  `canonicalKind`; a companion (`variants`) indexer makes none — its records hydrate from the
   *  items source's canonical record (§4.6). The binding assigns ids. */
  toRecords(item: TItem, options?: CallOptions)
    : Promise<Result<readonly RecordDraft[], RagError>>;
}

export interface IndexReport {
  readonly items: number;          // items given
  readonly indexedItems: number;   // items with every record written
  readonly records: number;        // records written
  readonly failedItems: readonly { readonly itemId: string; readonly reason: string }[];
}
```

### 3.3 The profile and its binding

```ts
/** What a binding is attached to. Each profile names its own shape. */
export interface BindTarget { readonly key: string }   // the ragStores key

/** The tools profile's target: a primary store and optional companions. */
export interface CollectionStore extends BindTarget {
  readonly rag: IRag;
  readonly companions?: Readonly<Record<string, IRag>>;
}

export interface IBoundCollection<TItem> {
  readonly key: string;
  readonly profileName: string;
  /** The store to register under `key` (the retrieval below is applied to it). */
  readonly rag: IRag;
  /** Filling half. Re-indexing an item writes its new records and deletes the old ones that are
   *  not among them (`recordIds` on the canonical). Several writes — NOT atomic (below). */
  index(items: readonly TItem[], options?: CallOptions): Promise<Result<IndexReport, RagError>>;
  /** Delete the records the item's canonical record lists, then the canonical record. */
  remove(refs: readonly ItemRef[], options?: CallOptions): Promise<Result<number, RagError>>;
  /** The item whole (its canonical record, by `recordId(ref.owner, ref.itemId, canonicalKind, 0)`),
   *  or null. Identity-checked against `options`. */
  get(ref: ItemRef, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
  /** Searching half. `k` counts ITEMS. */
  readonly retrieval: IRetrievalStrategy;
}

export interface ICollectionProfile<TItem, TTarget extends BindTarget = CollectionStore> {
  readonly name: string;   // 'mcp-tools' | 'shared-items' | a consumer's own
  bind(target: TTarget): IBoundCollection<TItem>;
}
```

- **Why `retrieval` is an `IRetrievalStrategy`:** goal "build on #321, not beside it". It reuses
  `StrategyRag`, the brand, `applyRetrievalStrategy`'s idempotency, the `RerankHandler` precedence
  rule and every application point of §13.3–13.4 of #321.
- **Why the target is a type parameter:** the tools profile binds a primary + companions; the
  shared-items profile binds partitions (§3.6). One contract, each profile's own target shape,
  checked by the compiler.
- **Why `recordIds` on the canonical record:** a writer may change an item's record kinds and
  counts. Replacement and removal read the canonical record and delete what it lists — no guessing
  ids.

**Replacing an item is not atomic — and the framework does not try to make it so.**

- `index` of an existing item = several per-record writes: new non-canonical records, then the
  canonical record (with the new `recordIds`), then deletes of the old ids it no longer lists. A
  store's bulk write (`upsertManyPrecomputedRaw`) is all-or-nothing per batch, but the deletes are
  separate calls; nothing spans them.
- **Concurrent writers of the same item** must be serialized by the writing element or by the
  store. Two concurrent `index` calls for one item may interleave; there is **no** item-level
  last-write-wins guarantee.
- **An interrupted replacement can leave stale records** — non-canonical records the current
  canonical record does not list. `remove` deletes only what the canonical lists, so such records
  can outlive the item.
- **Why no generations, commit markers or locks:** the store owns concurrency (the project's
  standing rule). Collections are filled once and read-mostly; tool catalogs are written by one
  process at build. A generation protocol would add writer coordination the library must not own.
  (Decision D13.)
- **What keeps it safe for readers** is retrieval, not writing: a hit is never returned from its own
  record; it is hydrated from the item's canonical record, and a hit whose canonical record is
  missing is dropped and counted (§4.6). A stale record of a live item can at most lift that item's
  rank; it can never return stale text or data.

### 3.4 Retrieval parts

```ts
export interface CollapsedItem {
  readonly source: string;                 // the items source it belongs to
  readonly owner: RecordOwner;             // read back from the hits' metadata (visibility + keys)
  readonly itemId: string;
  readonly score: number;                  // per the rule
  readonly hits: readonly RagResult[];     // the item's records among the candidates, best first
}

/** The candidate strategy: how many items stage 1 hands on, and how deep to query for them. */
export interface ICandidatePool {
  readonly name: string;
  /** Items kept per items source after collapse. */
  readonly items: number;
  /** Records to ask one source for, given the indexer's bound on records per item. */
  recordsToFetch(maxRecordsPerItem: number): number;
}

/** Records → items. Key = (items source, owner scope, owner key, itemId) — the owner-qualified
 *  item, never the bare itemId. Output sorted by score, descending. */
export interface ICollapseRule {
  readonly name: string;
  collapse(hits: readonly SourcedHit[]): CollapsedItem[];
}

/** Final cut over the ranked, hydrated items. `requestedK` is the caller's k, in items.
 *  Applied once, to the final result. */
export interface IItemCut {
  readonly name: string;
  /** The most items `cut` returns for `requestedK` — the retrieval's budget (§4.5). */
  limit(requestedK: number): number;
  cut(items: readonly RagResult[], requestedK: number): RagResult[];
}

/** One sub-query and its share of the budget, in items. */
export interface SubQuery {
  readonly text: string;
  readonly k: number;                      // integer ≥ 1
}

/** Splits one query into budgeted sub-queries (§4.5). Injected; none → the query runs as is. */
export interface IQueryDecomposer {
  readonly name: string;
  /** `budget` = the retrieval's limit in items. The sub-queries' `k` must sum to ≤ `budget`.
   *  An empty array = run the query as is with the whole budget. */
  decompose(text: string, budget: number, options?: CallOptions)
    : Promise<Result<readonly SubQuery[], RagError>>;
}

/** One store a retrieval queries. */
export interface RetrievalSource {
  readonly name: string;                   // reported in telemetry: 'primary', 'intents', 'user', 'global', 'group:<id>'
  readonly rag: IRag;
  /** 'items': holds canonical records; 'variants': extra records of another source's items. */
  readonly role: 'items' | 'variants';
  /** For 'variants': the items source whose items these records belong to. */
  readonly itemsOf?: string;
  /** The options this source is queried with (its identity filter). */
  readonly options?: CallOptions;
}

/** Which sources a request may query. A profile supplies it; the consumer may replace it. */
export interface ISourceSelector {
  sources(options?: CallOptions): Promise<readonly RetrievalSource[]>;
}

/** A separate small interface (ISP), not a new member of IMetrics. */
export interface IRetrievalMetrics {
  /** Attributes: store, strategy, outcome (§9.1). */
  readonly retrievalOutcome: ICounter;
}
export function isRetrievalMetrics(m: unknown): m is IRetrievalMetrics;
```

`SourcedHit` = `RagResult` + the source name (internal to collapse).

### 3.5 Tool items and intents

```ts
export interface ToolItem {
  readonly itemId: string;            // the IToolRecordKey output, e.g. `tool:GetWhereUsed`
  readonly name: string;              // exposed (namespaced) name → metadata.name
  readonly originalName: string;      // provider's name; facets derive from it
  readonly description: string;
  readonly parameterNames: readonly string[]; // top-level inputSchema.properties keys, in order
}

/** One extra record view of a tool, derived from provider text only (e.g. operation, object). */
export interface IToolFacet {
  readonly kind: string;               // the record kind, e.g. 'operation'
  /** The record text, or undefined when the provider text yields nothing (no record then). */
  derive(tool: ToolItem): string | undefined;
}

/** Where a tool's intents come from: an LLM, a file generated at deploy, a consumer's own. */
export interface IToolIntentSource {
  readonly name: string;
  /** English intents for one tool. Empty → no intent record. */
  intentsFor(tool: ToolItem, options?: CallOptions)
    : Promise<Result<readonly string[], RagError>>;
}
```

### 3.6 Shared items

```ts
/** Who may see a shared item. No 'session': a shared item outlives the session. */
export type SharedItemVisibility = Exclude<RecordOwner, { scope: 'session' }>;

export interface SharedItem {
  /** Chosen by the writer. A deterministic id is the writer's tool for de-duplication. */
  readonly itemId: string;
  readonly visibility: SharedItemVisibility;
  /** The item whole, as readers get it back. Also searchable (canonical record `item`). */
  readonly text: string;
  /** Extra search records; kinds of the writer's choosing (not 'item'). */
  readonly records?: readonly { readonly kind: string; readonly text: string }[];
  /** The writer's structured payload, returned whole with the item. */
  readonly data?: RagJsonValue;
  /** Expiry, epoch seconds → metadata.ttl (honoured by the stores). The policy is the writer's. */
  readonly ttl?: number;
}

/** The consumer's group partitions (#304: group isolation is the consumer's). */
export interface ISharedItemGroups {
  /** Group stores this request may read — the consumer's authorization. */
  readable(options?: CallOptions): Promise<readonly { readonly groupId: string; readonly rag: IRag }[]>;
  /** The store for writing this group's items; undefined → the write is refused. */
  writable(groupId: string, options?: CallOptions): Promise<IRag | undefined>;
}

/** The shared-items profile's target. At least one of user / global (typed). */
export type SharedItemsStores = BindTarget & { readonly groups?: ISharedItemGroups } & (
  | { readonly user: IRag; readonly global?: IRag }
  | { readonly user?: IRag; readonly global: IRag }
);
```

### 3.7 Store embedder capability (for fix F1)

```ts
/** Optional capability (pattern 4): a store that embeds its own documents exposes its embedder. */
export interface IRetrievalEmbedderOwner {
  readonly retrievalEmbedder: IRetrievalEmbedder;
}
/** Walks IRagDecorator.inner (≤16 levels, like hasRetrievalStrategy) to the first owner. */
export function retrievalEmbedderOf(rag: IRag): IRetrievalEmbedder | undefined;
```

### 3.8 Justification of every contract change

| Change | Why it is needed | Why here |
|---|---|---|
| `IndexedRecord`, `RecordDraft`, `recordId`, `RecordOwner`, `ItemRef`, `IItemIndexer`, `ICollectionProfile`, `IBoundCollection`, `BindTarget`, `CollectionStore` | goals 1–2, 5–6: a profile contract consumers implement | used by libs (implementations, builder), server-libs (YAML) and consumers → the contracts package |
| `ICandidatePool`, `ICollapseRule`, `IItemCut`, `ISourceSelector`, `RetrievalSource` | goal 1's new steps, each a consumer-swappable strategy (principle 5) | same users as above |
| `IQueryDecomposer`, `SubQuery` | goal decision 2026-10-05: query splitting is a strategy the consumer injects and the default retrieval uses | libs (`StagedRetrieval` calls it), server-libs (YAML name → instance), consumers (implementations) |
| `ToolItem`, `IToolFacet`, `IToolIntentSource` | typed input of the tools indexers; facets and intents are indexing strategies a consumer may write | builder (libs) + indexers + consumers that bring their own facets or precomputed intents |
| `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `SharedItemsStores` | goal 7: what writing elements get; owner + visibility | libs (profile) + consumers (writing elements, group partitions) |
| `IRetrievalMetrics` | reranker errors must reach metrics and `/health` (goal *Evidence*) without growing `IMetrics` (principle 4) | metrics implementations live in libs; consumers plug their own backends |
| `IRetrievalEmbedderOwner` | replaces the `(toolsRag as any).embedder` read — a cast that erased a type and is the cause of F1 | implemented by `VectorRag` (llm-agent) and the qdrant / pg-vector / hana provider packages |
| `HealthComponentStatus.toolCatalog.records?`, `.profile?`, `MetricsSnapshot.retrievalOutcome?` | additive optional fields for §9 | where the health types already live |

These are the llm-agent family's own contracts, used only inside this monorepo and by its
consumers, so they belong in `@mcp-abap-adt/llm-agent`, not in the cross-family
`@mcp-abap-adt/interfaces-*` packages.

---

## 4. The composable retrieval half — `StagedRetrieval` (libs)

`packages/llm-agent-libs/src/collections/staged-retrieval.ts`. Implements `IRetrievalStrategy`.

### 4.1 Why a new composable class

- `RerankedRetrieval` / `RerankAllRetrieval` fetch **and** rerank in one `retrieve` call, so a
  collapse cannot be put between the two steps from outside.
- `StagedRetrieval` exposes the steps as injected parts.
- The 30.1.0 classes stay as they are (same exports, same behaviour). Nothing a current consumer
  runs is touched.

### 4.2 Options

```ts
interface StagedRetrievalOptions {
  name: string;                 // reported as `strategy`
  storeKey: string;             // reported as `store`
  pool: ICandidatePool;         // candidate strategy, counted in ITEMS — required, never derived
  maxRecordsPerItem: number;    // from the indexing strategy (§4.4), not set by the consumer
  canonicalKind: string;        // from the indexing strategy; locates the canonical record (§4.6)
  sources: ISourceSelector;     // from the profile's bind()
  collapse: ICollapseRule;
  rerank?: {
    reranker: IReranker;
    onFailure: 'stage1' | 'error';      // 'stage1' = 30.1.0 behaviour
    keepStage1Top?: number;             // §4.7, default 0; counted inside k
  };
  decompose?: {                 // §4.5; absent → the query runs as is (one run)
    decomposer: IQueryDecomposer;
    queryEmbedder: IQueryEmbedder;      // embeds each sub-query
  };
  cut?: IItemCut;               // absent → TopItemsCut (caller's k)
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics };
}
```

- `pool` is required for the same reason as `RerankAllRetrieval.maxCandidates` in 30.1.0:
  "configured, never derived from an assumed catalog size".
- **Scoring inside the store** (hybrid vs cosine) is the store's existing `ISearchStrategy`, set on
  the store, not here. The measurements used hybrid (0.7·cos + 0.3·BM25).

### 4.3 One query, step by step

```
sources = selector.sources(options)            ← identity filters chosen per source
for each source, in parallel:
  source.rag.query(query, pool.recordsToFetch(maxRecordsPerItem), source.options)
                                               ← identity filter applied IN the store, before top-N
merge hits
  → collapse (ICollapseRule)                   ← records → owner-qualified items; filtered hits only
  → keep the first pool.items items per items source
  → rerank items on their item text (optional, §4.6); check the result (§4.8)
  → hydrate in rank order from the CANONICAL record (§4.6); drop + count orphans
  → cut (IItemCut) over hydrated items, once: at most cut.limit(k) items
    (with a decomposer this runs per sub-query and the results are merged, §4.5)
```

- **Owner invariant:** collapse only ever sees what the stores returned under each source's
  identity filter, so it is always *after* the owner filter. The only extra read, `getById` of the
  canonical record, is checked with `matchesRagIdentity` against the same filter; a record that
  fails it is dropped as an orphan.
- **Records without `itemId`** (e.g. today's `skill:*` records in the tools store) pass through as
  their own item, keyed by `metadata.id`, and are returned as the record itself (they are not
  profile records, so there is no canonical record to hydrate from). That is how skills keep 30.1.0
  behaviour inside a store that has a profile (§7.7).
- **Result shape.** Each returned `RagResult` is an **item**, built from its **canonical record
  only**: `text` = the canonical text, `metadata` = the canonical record's metadata (full, incl.
  `data`) with `id = itemId` (the logical id), plus `matchedKinds: string[]` and `source`;
  `score` = the rule's (or the reranker's). `toolNameFromRecord`, `ToolSelectHandler`,
  `tool-loop` and `IToolsRagHandle` therefore work unchanged.

### 4.4 Candidate pool counted in items

- **Measured:** 30 records with several records per tool show only ~26–34 tools; non-English
  recall drops to 0.846–0.885. 30 **items** restore 0.962 (Cohere) / 1.000 (Jev).
- **Built-in candidate strategy `ItemPool(n)`:** `items = n`, `recordsToFetch(m) = n × m`.
  - Every item has at most `m` records, so `n × m` records always hold at least `n` distinct items
    (when the store has that many). One query, no loop.
  - After collapse, the pool is cut to `n` items per items source.
  - A `variants` source is queried with the same record count as its items source.
  - A consumer may inject another `ICandidatePool` (e.g. one that queries deeper).
- **`maxRecordsPerItem` comes from the indexing strategy** (`IItemIndexer.maxRecordsPerItem`),
  never the consumer's guess:
  - the 30.1.0 single record → 1; `FacetedToolIndexer` → 1 + its facets; `IntentRecordIndexer`
    adds 1;
  - shared items: a required constructor option of the profile; `index()` refuses an item with
    more records (`failedItems`, reason `too-many-records`).

### 4.5 Query decomposition — an injected strategy

**The slot.** The framework provides the component; the consumer provides the strategy.

- `StagedRetrieval` calls the injected `IQueryDecomposer` (§3.4) when `decompose` is set.
- **None injected → the query runs as is** (one run, today's behaviour). There is no shipped
  implementation and no shipped variant uses one (§2.4).

**The k contract.** `k` stays the overall limit of a retrieval, as in 30.1.0 — with or without a
decomposer.

| Step | What |
|---|---|
| budget | `budget = cut.limit(requestedK)` (`TopItemsCut` → k; `FixedItemsCut(n)` → n; `ScoreFloorCut` → `maxItems`) |
| decompose | `decomposer.decompose(text, budget)` → sub-queries; the strategy owns how the budget is shared |
| check | each `k` an integer ≥ 1, each `text` non-empty, `Σ k ≤ budget`; else a `RagError('…', 'DECOMPOSE_ERROR')` |
| `[]` | the query runs as is with the whole budget (same as no decomposer) |
| run | each sub-query through §4.3 up to hydration, in parallel: embedded with `queryEmbedder`, reranked against its **own** text, its first `k` items kept |
| merge | union in sub-query order, de-duplicated by owner-qualified item (best score kept) |
| cut | the `IItemCut`, **once**, over the union → **at most `budget` items** |

- A decomposer error or a failed check is **returned**, never swallowed: the retrieval fails with
  the error, counted as `outcome=decompose_error` and on the span (§9). No silent fall-back to the
  whole query.
- Since the budgets sum to ≤ k and the final cut is enforced anyway, no contract here lets a
  retrieval return more than k items.

**How it relates to the existing query steps and #323.**

| Step | Shape | Where | This spec |
|---|---|---|---|
| `IQueryPreprocessor` | one text → one text | inside `IRag.query`, per store, before embedding | untouched; it still runs inside each store query, for every sub-query too |
| `IQueryExpander` | one text → one text | pipeline, one rewrite per request (dead today, #323) | untouched; #323 stays its own pipeline fix (§12). When wired, its output is the query the decomposer receives |
| `IQueryDecomposer` | one text → budgeted sub-queries | retrieval-time, inside `StagedRetrieval`, per store | new slot |

**YAML.** Only a name mapped to an injected instance (§6.2); config holds no split knobs.

### 4.6 The canonical record — what the reranker reads and what is returned

Two separate questions, two rules:

| Question | Answer |
|---|---|
| What does the **reranker** read? | the **item text** — the canonical record's text, or a shortcut to it (below) |
| What is **returned**? | **always the canonical record itself** — text and full metadata (incl. `data`), owner-checked — no matter which record matched |

**Reranker text.** For tools the item text is the **provider text** (name, description, parameter
names) — **never intents** (measured equal or better for Cohere and Jev, §2.2). Intents serve only
the candidate search. For each collapsed item:

1. a canonical hit of the item → its `text`;
2. a non-canonical hit in an items source → its `metadata.itemText` (a **reranking shortcut only**:
   zero round trips; never returned);
3. only `variants` hits → the canonical record is fetched now (step *Hydration*), and its text is
   used.

**Hydration (every returned item).**

- The canonical record is located by id: `recordId(owner, itemId, canonicalKind, 0)` on the item's
  items source, where `owner` is read back from the hit's metadata (§3.1). A canonical hit among
  the candidates **is** that record; otherwise `getById` reads it.
- Every hydrated record is checked with `matchesRagIdentity` against the source's filter (the
  owner check).
- **Missing canonical record** (deleted item, interrupted replacement, a record outside the filter)
  → the hit is an **orphan**: dropped, never returned, and **reported** — `outcome=orphan` on the
  counter and the `orphans` span attribute (§9). A stale secondary record can therefore never
  surface its own text or data.
- Hydration runs in rank order and the cut sees only hydrated items, so orphans never use up k.
- **Cost:** at most one `getById` per returned item whose canonical record was not among the
  candidates (≤ k per sub-query; zero when the canonical record matched). `IRag` has no batch
  get; the reads run in parallel.

**Why `itemText` stays, but only for ranking.** It lets the reranker score items whose canonical
record was not among the candidates without a read per candidate (the pool is 30 items; the
returned set is k). It can be stale after an interrupted replacement (§3.3) — harmless, because it
only orders; the payload always comes from the canonical record.

- Index-size cost of `itemText` is small (measured: 711 records, 4.4 MB vectors for 237 tools; 948
  records with one intent record per tool).
- `itemText` on an `intent` record is the **provider** text, so generated text never reaches the
  reranker.
- `variants` records (companion placement) carry no `itemText`.

### 4.7 Optional `keepStage1Top`

`keepStage1Top: n` keeps the stage-1 (collapsed, pre-rerank) top-n items in the result: they go
first, the reranked items fill the rest, de-duplicated. **Counted inside k**, so k stays the
overall limit (the previous draft added n on top). It was measured only on top of the former
built-in clause split, and chosen after seeing the data: **no measured number backs it now**.
Default 0. **Decision for the user** — D7.

### 4.8 Reranker output check

`StagedRetrieval` checks every reranker result, whichever reranker it is:

- the result must hold **exactly** the candidates it was given — same count, each once;
- every `score` must be a finite number.

Anything else is a `RagError('…', 'RERANK_ERROR')` handled by `onFailure` and **counted** (§9).
This closes the evidence item "a wrong score count falls back silently" for every reranker,
including a consumer's own.

### 4.9 Built-in retrieval strategies

| Strategy | Class | Behaviour |
|---|---|---|
| candidate pool | `ItemPool(n)` | `n` items per items source (§4.4) |
| collapse | `MaxScoreCollapse` | item score = best record score (measured winner). Count / RRF are **not** shipped. |
| cut | `TopItemsCut` | first `requestedK` items (default); `limit` = `requestedK` |
| cut | `ScoreFloorCut({ minItems, maxItems, minScore })` | first `minItems`, then more up to `maxItems` while `score ≥ minScore`; `limit` = `maxItems` |
| cut | `FixedItemsCut(k)` | ignores the caller's k — for a store whose profile owns k; `limit` = its k |
| query decomposition | — | **none shipped**; the consumer injects its own `IQueryDecomposer` (§4.5) |

- **k in items.** The caller's k (`ragQueryK ?? 10` in `rag-query`, 20 in `IToolsRagHandle` and the
  controller's `selectTools`) arrives unchanged; under a profile it counts items and is the
  overall limit of the retrieval, with or without a decomposer. A consumer that wants its own
  number uses `FixedItemsCut`. The library chooses no k of its own; a named variant carries its
  measured cut in its definition, and the consumer picks the variant explicitly.
- **Score scales.** After a reranker, scores are the reranker's; the global
  `IToolSelectionStrategy` still runs on the flattened results of all stores, as in 30.1.0. A
  per-store threshold therefore belongs in the profile's cut.

---

## 5. Rerankers are alternatives (goal 9)

### 5.1 What ships

| Reranker | Class | Package | Scores from |
|---|---|---|---|
| Cross-encoder on SAP AI Core (Cohere Rerank) | `SapAiCoreReranker` | **new** `@mcp-abap-adt/sap-aicore-reranker` | `/rerank` of an AI Core deployment |
| Decision model (TypeSafe Jev) | `DecisionReranker` + `TOOL_QUESTION` / `PASSAGE_QUESTION` | existing: `llm-agent-libs` (reranker) + `typesafe-decision` (model) | `IDecisionModel.decide` |
| LLM | `LlmReranker` | existing, unchanged | not recommended (no gain, §2.2) |

All implement `IReranker` unchanged. The consumer picks one per profile at deploy.

### 5.2 `SapAiCoreReranker`

```ts
export interface SapAiCoreRerankerConfig {
  /** The AI Core deployment that serves the rerank model. */
  deploymentId: string;
  /** Sent as `model` in the body (e.g. the Cohere rerank model name). */
  model: string;
  /** Header `AI-Resource-Group`. Default 'default'. */
  resourceGroup?: string;
  /** AI Core REST inference base URL (the name `parseServiceKey` returns). */
  apiBaseUrl: string;
  /** Asked for a fresh token on every call; never cached here. Built by the composition root. */
  credential: IBearerCredential;
  /** Documents per call; larger inputs are split and merged. Default: all in one call. */
  maxDocumentsPerCall?: number;
}

export class SapAiCoreReranker implements IReranker { /* … */ }
```

**Wire:**

- `POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank`
- headers: `Authorization: Bearer <credential token>`, `AI-Resource-Group: <resourceGroup>`,
  `Content-Type: application/json`
- body: `{ model, query, documents: results.map(r => r.text), top_n: results.length }`
- response: `{ results: [{ index, relevance_score }] }`

**Mapping:** `score = relevance_score` of `results[index]`; sorted descending, ties keep the input
order (as `DecisionReranker` does).

**Errors (all `RagError`, code `RERANK_ERROR`):**

- HTTP error or network failure (message carries the status, never the token);
- a missing, duplicated or out-of-range `index`;
- fewer or more results than documents;
- a non-finite `relevance_score`.

**Rules it follows (same as the AI Core embedder):**

- The credential is **injected** (`IBearerCredential`, `@mcp-abap-adt/interfaces-auth`); the
  library never reads env. The app's composition root builds it from the service key
  (`serviceKeyCredential`, `@mcp-abap-adt/sap-aicore-auth`), as it does for the embedder.
- No timeout of its own; `options.signal` aborts the request.
- No retries inside; a failure goes to the strategy's `onFailure`.

### 5.3 Package placement — why its own package

| Option | Verdict |
|---|---|
| Inside `llm-agent-libs` | ✗ libs is vendor-neutral; no provider HTTP client lives there |
| Inside `sap-aicore-embedder` | ✗ a reranking consumer would install an embedder and its `@sap-ai-sdk/orchestration` dependency; an embedder package would carry a second role |
| **New `@mcp-abap-adt/sap-aicore-reranker`** | ✓ same shape as `typesafe-decision` and the `*-embedder` packages: one provider, one role, `peerDependencies` on `@mcp-abap-adt/llm-agent` and `@mcp-abap-adt/interfaces-auth`, `LGPL-3.0-only`, plain `fetch`, no runtime dependency |

- `llm-agent-server` (the app) adds it as a dependency, like `typesafe-decision`.
- **Deployment id vs model name:** this PR takes `deploymentId`. Resolving a deployment by model
  name needs the deployment listing that lives privately in `sap-aicore-embedder`
  (`resolveDeploymentId`). **Decision for the user** — D10.

### 5.4 Rerankers in the shipped tools variants

- Cohere: `faceted-cohere`. Jev: `faceted-jev`. See §7.4.
- Any reranker composes with any indexing and candidate strategy (§7.5).

---

## 6. Builder and YAML

### 6.1 Library (SmartAgentBuilder)

| Method | What |
|---|---|
| `withToolsProfile(profile: ICollectionProfile<ToolItem>)` | **new.** The builder binds the profile (a shipped variant or the consumer's own composition) to its own `tools` store (set by `setToolsRag` or auto-created), fills it through `bound.index` at build (where `vectorizeMcpTools` runs today) and applies `bound.retrieval` like an explicit `withRetrievalStrategy('tools', …)`. |
| `withRetrievalStrategy(key, bound.retrieval)` | **existing.** Any other store (e.g. a shared-items binding): the consumer binds the profile itself, registers `bound.rag` under `key` and hands `bound` to its writing elements. Pure DI; no new method. |

Rules (pattern 5, "unsupported is an error"; checked at `build()`):

- `withToolsProfile` + `withRetrievalStrategy('tools', …)` → error (two owners of one store's
  ranking).
- A store already wrapped by a binding (brand on `StrategyRag`, walked through `IRagDecorator`) is
  not bound twice — the server binds at creation, the builder reuses it.

Type check: `withToolsProfile(sharedItemsProfile)` does not compile (`ICollectionProfile<ToolItem>`).

### 6.2 Server YAML (`smart-server.yaml`) — names mapped to instances

**Config is only the builder's.** YAML holds names; the server's resolver maps each name to a
strategy instance and hands instances to the builder. No component reads config.

```yaml
crossEncoder:             # new; like `decision:`. Secrets never here.
  provider: sap-aicore
  deploymentId: ${RERANK_DEPLOYMENT_ID}
  model: <rerank model name>
  resourceGroup: default
  credentialRef: AICORE                         # resolved by the composition root

rag:
  retrieval:              # unchanged (30.1.0). A key may not appear here AND under profiles.
    history: { strategy: embedding }
  profiles:               # new; absent → 30.1.0 behaviour (= variant baseline)
    tools:
      variant: faceted-cohere                    # baseline | faceted | faceted-cohere | faceted-jev | a registered name
      intents:                                   # optional indexing strategy; not with baseline
        record: { file: ./tool-intents.json }    # or: companion: { source: { llm: intents }, store: { … } }
      decomposer: my-splitter                    # optional; a NAME the consumer registered (§4.5); not with baseline

    # …or the consumer's own composition, every value a NAME of a strategy:
    tools-writer:
      compose:
        indexer: { faceted: [operation, object] }  # facet names → IToolFacet instances
        pool: { items: 30 }                        # → ItemPool(30)
        collapse: max                              # → MaxScoreCollapse
        reranker: decision                         # none | cross-encoder | decision | llm
        question: tool                             # decision / llm only
        decomposer: none                           # none | a registered name (no built-in)
        cut: { fixed-items: 5 }                    # top-items | fixed-items | score-floor {minItems,maxItems,minScore}
        onFailure: stage1                          # stage1 | error
```

- Parsed **only** by the server (`resolve-collection-profiles.ts` in server-libs, beside
  `resolve-retrieval.ts`).
- Names resolve through registries in the composition deps (like `embedderFactories`):
  `toolsVariantFactories` (built-ins: the four of §7.4) and `toolsStrategyFactories` (built-in
  facets, pools, collapse, cuts). A consumer registers its own, including its decomposers (none
  is built in). Unknown name → startup error.
- A decomposer factory gets the store's query embedder from the resolver (the same one `makeRag`
  gives the store); YAML carries no decomposer parameters — they belong to the registered factory.
- Rerankers resolve through the same code as `rag.retrieval`:
  - `decision`: one `DecisionReranker` per wording, `makeDecisionModel` seam (existing);
  - `cross-encoder`: new `BuildAgentDeps.makeCrossEncoder(cfg) => Promise<IReranker>` seam; the
    app's composition root builds `SapAiCoreReranker` and resolves `credentialRef`. The library
    constructs none from configuration (the existing rule for decision models).
- Stores are built through the existing `makeRag` seam, so a companion shares the primary's
  embedder.
- `record: { file }` / `companion: { source: { file } }` is a JSON object
  `{ "<originalName>": ["intent", …] }` read at startup into a `StaticIntentSource`.
- Validation (raw YAML, as in #321 §13.4) → startup error, never a silent drop:
  - unknown variant or strategy name; `variant` and `compose` together; a key under both
    `retrieval` and `profiles`;
  - `question` with `cross-encoder`;
  - `cross-encoder` without a `crossEncoder:` section, or without the seam;
  - `intents` or `decomposer` with `baseline`; `companion` without `store`;
  - an `llm` key not in `llm:`; non-positive `pool.items`; `minItems > maxItems`;
  - a tools key whose variant is not a tools profile.
- Server-wide like `rag.retrieval`: worker configs that declare `rag.profiles` are rejected;
  workers get the main config's bindings by key.
- Shared items have **no YAML** in this PR (library API only). **Decision for the user** — D6.

---

## 7. Default profiles for MCP tools — strategies and named variants

### 7.1 Principle

- llm-agent ships the **contracts** of the pipeline elements and **some default
  implementations**.
- For MCP tools it ships **several** variants, so the consumer has a real choice.
- A variant is a **named composition of injected strategy instances** — not one class with flags.
  The consumer may take a variant as is or compose its own from the same strategies (or its own).
- The numbers inside a variant (pool size, cut) are part of its definition and listed with the
  measurement behind them. The consumer picks the variant explicitly; nothing is guessed (goal 3).

### 7.2 The strategies

| Step | Contract | Shipped instances |
|---|---|---|
| indexing | `IItemIndexer<ToolItem>` | 30.1.0 single record (no profile); `FacetedToolIndexer(facets)`; `IntentRecordIndexer(inner, source)`; `IntentCompanionIndexer(source)` |
| facet (inside faceted indexing) | `IToolFacet` | `OperationFacet`, `ObjectFacet` |
| intent source | `IToolIntentSource` | `StaticIntentSource(map)`, `LlmIntentSource(llm, { prompt? })` |
| in-store scoring | `ISearchStrategy` (existing, on the store) | the store's own (hybrid or cosine) |
| candidate pool | `ICandidatePool` | `ItemPool(n)` |
| collapse | `ICollapseRule` | `MaxScoreCollapse` |
| reranker | `IReranker` (existing) | none; `SapAiCoreReranker`; `DecisionReranker` + `TOOL_QUESTION`; `LlmReranker` |
| query decomposition | `IQueryDecomposer` (optional, §4.5) | **none** — the consumer's own |
| final cut | `IItemCut` | `TopItemsCut`, `FixedItemsCut(k)`, `ScoreFloorCut(...)` |

The composing class is `ComposedToolsProfile` (an `ICollectionProfile<ToolItem>`):

```ts
new ComposedToolsProfile({
  indexer: IItemIndexer<ToolItem>,                          // primary store
  companions?: Readonly<Record<string, IItemIndexer<ToolItem>>>, // each fills bind()'s companion of that name
  pool: ICandidatePool,
  collapse: ICollapseRule,
  rerank?: StagedRetrievalOptions['rerank'],
  decompose?: StagedRetrievalOptions['decompose'],
  cut?: IItemCut,
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics },
})
```

- `bind({ key, rag })`, or with companions `bind({ key, rag, companions: { intents: g } })`.
- A `companions` indexer without the same-named store at `bind()` → error.

### 7.3 Indexing strategies — records

**Provider records** (`FacetedToolIndexer([new OperationFacet(), new ObjectFacet()])`):

| Kind | Id | Text | Written when |
|---|---|---|---|
| `full` (canonical) | `recordId(global, itemId, 'full', 0)` — `itemId` is the 30.1.0 id | `Tool: <name> — <description>` + `\nParameters: <p1>, <p2>, …` when there are any | always — not a facet, so it cannot be left out |
| `operation` (`OperationFacet`) | `recordId(global, itemId, 'operation', 0)` | `<name words> — <first clause of description>` | the first clause is non-empty |
| `object` (`ObjectFacet`) | `recordId(global, itemId, 'object', 0)` | `<name words after the first word>` | the name has ≥ 2 words |

- Metadata on every record: `name` (exposed), `itemId`, `recordKind`, `profile`, owner `global`
  (tool catalogs are global; no identity keys, as today). Non-canonical records carry `itemText` =
  the `full` text.
- **Deterministic derivation** (`deriveToolFacets` helpers, pure, unit-tested on a table):
  - name words: split `originalName` on camelCase, acronym, `_`, `-` and digit boundaries;
    lowercase; drop a namespace prefix (`server__`). `GetATCFindings` → `get atc findings`.
  - first clause: description up to the first `.`, `;`, `:` or newline; leading bracket tags such
    as `[read-only]` removed; at most 200 characters.
  - No lexicon, no synonyms, no LLM: every word comes from the provider. A rule that would produce
    nothing produces no record — never a made-up word.
- The goal's rule holds: nothing is written over provider text. A weak description is fixed at its
  source.

**Intent records** — generated text; an indexing strategy any variant except `baseline` can add.
They help only the candidate search (§2.1) and never reach the reranker (§4.6).

| Placement | Strategy | Record |
|---|---|---|
| **in the tool collection** (default placement) | `IntentRecordIndexer(inner, source)` — decorates the provider indexer | ONE record per tool: kind `intent`, id `recordId(global, itemId, 'intent', 0)`, text = the tool's intents, one per line; `generated: true`; `itemText` = the `full` text |
| **companion collection** | `IntentCompanionIndexer(source)` under `companions.intents` (a `variants` source) | the same ONE record per tool, `generated: true`, **no** `itemText` (§4.6) |

- **Generated text never mixes into provider records**: its own record kind, and for the companion
  its own store.
- **One record per tool in both placements** — the layout measured (own record 0.954 at k=5, equal
  to intents inside `full`). Switching placement moves records, it does not reshape them.
  **Decision for the user** — D3 (the previous draft had one companion record per intent).
- **Sources:** `StaticIntentSource(map)` — intents generated at deploy (e.g. the hub's intents
  file), keyed by `originalName`; `LlmIntentSource(llm, { prompt? })` — English, domain-neutral
  prompt, overridable.
- **Fill once, refresh on change.** The intent record stores `generatedFrom` = a hash of the tool's
  provider text. At index time the source is asked only when the record is missing or the hash
  differs. (An in-memory store is rebuilt every boot; prefer `StaticIntentSource` there.)
- **Off / rebuild:** drop the strategy (record placement: re-index, §7.8; companion: unbind it —
  the provider records are untouched). Rebuild = clear the companion (or the `intent` records) and
  re-index.

### 7.4 Shipped variants (`mcpToolsVariants`)

Each variant is a factory that takes only what cannot be shipped (a reranker's model or
credential) and returns a `ComposedToolsProfile` — or, for `baseline`, nothing to bind.

| Variant | Composition | Measured (required-recall, hybrid in-store scoring) |
|---|---|---|
| **`baseline`** — the default | 30.1.0 single record per tool + `EmbeddingRetrieval` (top-k records = tools). Selected by binding **no** profile. | EN-ext 0.943 at k=5 (8.3 tools); 0.977 at k=15 (~25 tools). Multi-step 0.714, non-English 0.692 (k=5). |
| **`faceted`** | `FacetedToolIndexer([OperationFacet, ObjectFacet])` + `ItemPool(15)` + `MaxScoreCollapse` + no reranker + `FixedItemsCut(8)` | 0.966 at k=5; **0.977 at k=8 with ~13 tools** (= baseline's k=15 with half the tools). |
| **`faceted-cohere`** | faceted indexing + `ItemPool(30)` + `MaxScoreCollapse` + `SapAiCoreReranker` + `FixedItemsCut(5)` | **Not measured as one composition.** Closest: one record per tool + Cohere, pool 30 items, k=5 (§2.3): EN-ext 0.931 with 8.3 tools; single 0.973, multi 0.714, non-English 0.962. At most 5 tools. |
| **`faceted-jev`** | faceted indexing + `ItemPool(30)` + `MaxScoreCollapse` + `DecisionReranker(model, TOOL_QUESTION)` + `FixedItemsCut(5)` | **To be measured as one composition on fresh consumer queries before promotion** (D11). Closest: one record per tool + Jev, pool 30 items, k=5 (§2.3): EN-ext 0.977 with 8.3 tools; single 1.000, multi 0.857, non-English 1.000. At most 5 tools. |

```ts
mcpToolsVariants.faceted();
mcpToolsVariants.facetedCohere({ reranker: new SapAiCoreReranker({ … }) });
mcpToolsVariants.facetedJev({ decisionModel });
// intents on top of any variant except baseline:
mcpToolsVariants.facetedCohere({ …, intents: { record: staticIntents } });
// the consumer's own decomposer on top of any variant except baseline (none shipped):
mcpToolsVariants.facetedJev({ …, decompose: { decomposer: myDecomposer, queryEmbedder } });
```

- **Why these four:** each one is a measured step — baseline (no change), faceted (fewer tools for
  the same recall, no external service), and one per reranker the goal names (goal 9).
- **`faceted-cohere` numbers are a proxy, honestly marked:** they are V0 + Cohere (one record per
  tool), not the faceted composition. Faceted indexing and Cohere were not measured together as
  this variant; the consumer check (§14.3) measures it.
- **`faceted-jev` caveat:** faceted + Jev was never run as one composition on an item pool. It ships
  marked **"to be measured as one composition on fresh consumer queries before promotion"**: the
  numbers in its row are the closest measured setup, not its own, and it is not recommended over
  the others until the consumer check (§14.3) runs it. **Decision for the user** — D11.
- One record + Jev (the best measured Jev composition) is already 30.1.0's
  `rag.retrieval.tools: { strategy: rerank, reranker: decision }`; it is not repeated as a variant.
- **Intents with a reranker:** the layouts are within noise of each other (goal *Evidence*), so
  intents are an add-on for stage 1, not part of any default variant.

### 7.5 Composing your own

- Any shipped strategy combines with any other; a consumer's own strategy implements the same
  contract (e.g. its own `IToolFacet`, `ICandidatePool` or `IReranker`).
- Typed rule: `full` cannot be dropped (it is not a facet).
- Measured guidance for one's own compositions:
  - with any reranker, size the pool in **items** (30 items: non-English 0.962 / 1.000; 30
    records: 0.846–0.885);
  - without a reranker, `ItemPool(15)` gives the same recall as 30.

### 7.6 Filling — `vectorizeMcpTools`

- **Without a profile (`baseline`):** the 30.1.0 record code is untouched
  (`Tool: ${name} — ${description}`, id from `IToolRecordKey`, metadata `{ name }`). A golden test
  pins id, text and metadata byte for byte on the committed snapshot.
- **With a profile:** `vectorizeMcpTools` builds `ToolItem`s (exposed name, provenance's original
  name, record key, description, parameter names) and calls `bound.index(items)`.
- Accounting counts **items** (`vectorized` = items with every record written; `failed` = item
  names). The `toolCatalog` health counters keep their meaning (tools), plus `records`.
- All records of all items are embedded in **one** batch pass (`embedDocuments`, respecting
  `IBatchSizeLimited`) and written with `upsertManyPrecomputedRaw` where available — the existing
  batch path, now fed records instead of tools. Sequential fallback and pacing are unchanged.
- Companion records are batch-embedded the same way, into the companion.

### 7.7 Tools and builder skills in one store

- **Skills stay on today's behaviour for now.** Their own default variants come later through the
  same contracts (goal 8).
- Today `vectorizeSkills` writes `skill:<name>` records into the tools store
  (`builder.ts:1356-1358`). Decided: **coexist by pass-through**.
  - Skill records are written exactly as today (no `itemId`), so `StagedRetrieval` passes each one
    through as its own item (§4.3). They compete for k as they do today; a reranker on the tools
    store scores them with the tools question, as `rerank` on `tools` already does in 30.1.0.
  - `skill-select` finds them by id as today (with fix F3).
- Moving skills to their own store would change their k, ranking and stage layout — a behaviour
  change goal 8 excludes. **Decision for the user** — D4.

### 7.8 Store migration

- A store is filled by one composition.
- Turning a variant on adds records next to the 30.1.0 ones (profile ids are owner-scoped, §3.1,
  so they never overwrite the 30.1.0 records); turning it off leaves profile records behind that
  the 30.1.0 path would rank as records.
- So switching variants (or the intent placement) on a persistent store = a fresh collection
  (redeploy), like an embedder change. Every record carries `profile` in metadata for diagnosis.
- In-memory tool stores (rebuilt every boot) need nothing.

---

## 8. Default profile for shared items — `SharedItemsProfile`

### 8.1 What it is — and is not

- **Is:** a RAG base that pipeline elements write into and search, so different agents can share
  information and experience (goal 7). The framework makes written items findable, returns them
  whole, and carries their owner and visibility.
- **Is not:** a case schema, an extractor, a trigger, an outcome check, a merge or retention rule.
  What an item holds, when it is written, by whom and how it is confirmed is decided by the
  **writing element(s)** — separate pipeline elements, out of this spec.
- **Why the name:** neutral about content (goal decision: no fixed case schema). "Shared" is its
  purpose (goal 7); "items" is this spec's term for what a profile returns. Rejected:
  `ExperienceProfile` (implies case semantics), `KnowledgeProfile` (collides in meaning with the
  existing knowledge backends in server-libs), `…Memory…` (taken by `HistoryMemory`).

### 8.2 Records per item

| Kind | Id | Text | Metadata |
|---|---|---|---|
| `item` (canonical) | `recordId(owner, itemId, 'item', 0)` | `SharedItem.text` | `data`, `recordIds`, `ttl`, owner keys, `visibility` |
| the writer's kinds | `recordId(owner, itemId, kind, n)` (n = position within that kind) | the writer's text | `itemText`, `ttl`, owner keys, `visibility` |

- Every record: `itemId`, `recordKind`, `profile: 'shared-items'`.
- `kind` is any non-empty string except `item`; anything else is refused (`failedItems`, reason
  `reserved-kind`).
- Records per item (canonical included) ≤ `maxRecordsPerItem` (§4.4).
- `owner` = the item's visibility (a `user` item's `userId`, a `group` item's `groupId`), so two
  users who both write `case-42` into the `user` store get two separate items (§3.1).
- Re-indexing an item writes its new records and deletes the old ones its canonical no longer
  lists (`recordIds`, §3.3) — several writes, **not atomic**.

### 8.3 Owner and visibility → partitions

| Visibility | Written to | Read with | Who provides the store |
|---|---|---|---|
| `user` | the `user` store; `metadata.userId` | `ragFilter.userId = options.userId`; **skipped** when there is no `userId` (fail closed) | the consumer, at `bind()` |
| `group` | `groups.writable(groupId)`; `metadata.groupId` | each store from `groups.readable(options)` | the consumer (`ISharedItemGroups`) |
| `global` | the `global` store | no identity filter | the consumer, at `bind()` |

- **Why partitions, not one mixed store:** `IRag` filters only on `userId` / `sessionId`, and a
  filtered query excludes records without the key. One store cannot answer "mine OR my group's OR
  global" without a new filter contract. Separate stores need none, and the `global` store is
  queried unfiltered without leaking anyone's user items.
- **Why group partitions are the consumer's:** #304 was narrowed — user, role and global isolation
  and the authorization behind it belong to the consumer. The library ships no group store; it
  types the visibility and asks the consumer's `ISharedItemGroups`.
- **Writes are checked:**
  - a `user` item whose `userId` ≠ `options.userId` → refused (a writer acting for one request
    cannot write into another user's partition);
  - a visibility with no store (no `global`, or `groups.writable` → `undefined`) → refused.
  - Refusals land in `IndexReport.failedItems`; nothing is written for that item.
- **Visibility model** (user / group / global, groups consumer-supplied): **Decision for the
  user** — D5.

### 8.4 What writing elements get

| Operation | Contract |
|---|---|
| write / replace | `bound.index(items, options)` → `IndexReport` |
| remove | `bound.remove([{ itemId, owner }], options)` → records deleted |
| read one back | `bound.get({ itemId, owner }, options)` → the canonical record (text + `data`), identity-checked |
| search | `bound.retrieval` (an `IRetrievalStrategy`), or the store registered under `key` |

- Concurrency: the store owns it; the framework adds no locks, generations or writer election
  (D13). Replacing an item is several writes, **not atomic** and with **no** item-level
  last-write-wins guarantee: concurrent writers of the same item must be serialized by the writing
  element (or the store). An interrupted replacement can leave stale records; readers never see
  them as payload, because every result is hydrated from the canonical record and a hit without one
  is dropped (§3.3, §4.6).
- Expiry: `SharedItem.ttl` → `metadata.ttl`, honoured by `VectorRag`, `InMemoryRag`, qdrant,
  pg-vector and hana. When to expire is the writer's policy.
- Sensitive data: whatever the writer puts in `text` / `data` is stored as given. Redaction is the
  writer's job.

### 8.5 Retrieval

- `StagedRetrieval` with the profile's `ISourceSelector`: `user` (filtered, or skipped), `global`,
  and every readable group store — all `items` sources.
- Collapse by the owner-qualified item (source, scope, owner key, `itemId`) with
  `MaxScoreCollapse`; the same `itemId` in two partitions, or from two owners, is two items.
- Optional reranker, e.g. `DecisionReranker` with `PASSAGE_QUESTION` or `SapAiCoreReranker`; it
  reads the item's `text`.
- Cut: the consumer's `IItemCut`; `FixedItemsCut(3)` recommended.
- Each returned `RagResult` is the item **whole**, hydrated from its canonical record whichever
  record matched (§4.6): `text`, `metadata.data`, `metadata.visibility`, owner keys,
  `matchedKinds`, `source`. A hit whose canonical record is missing is dropped and counted.
- Paths: registered under its key, it is projected and queried as `rag-<key>` each request,
  through its strategy; a writing or reading element may also call `bound.retrieval` directly.

### 8.6 Constructor

```ts
new SharedItemsProfile({
  maxRecordsPerItem: number,      // required (§4.4)
  pool: ICandidatePool,           // required, e.g. new ItemPool(30)
  collapse: ICollapseRule,        // e.g. new MaxScoreCollapse()
  rerank?: StagedRetrievalOptions['rerank'],
  decompose?: StagedRetrievalOptions['decompose'],
  cut?: IItemCut,
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics },
}).bind({ key: 'shared', user: userStore, global: globalStore, groups: myGroups });
```

---

## 9. Observability — through the existing channels

### 9.1 What a binding reports

| Channel | Existing? | What |
|---|---|---|
| span `retrieval` (child of the request trace, via injected `ITracer`) | tracer: yes | attrs `store`, `strategy`, `sources`, `candidates.records`, `items.collapsed`, `items.returned`, `decomposer`, `subqueries`, `rerank.outcome` (`none\|ok\|fallback\|error`), `rerank.error` (message), `orphans`, `hydration.reads` (canonical records read by `getById`, §4.6) |
| `IRetrievalMetrics.retrievalOutcome` counter | new small interface on the same metrics backend | attrs `store`, `strategy`, `outcome` ∈ `ok`, `rerank_fallback`, `rerank_error`, `decompose_error`, `orphan`, `empty` |
| session step `retrieval_rerank_error` | yes (30.1.0 name kept) | unchanged; also emitted for a failed output check (§4.8) |
| `/health` | yes | `metrics.retrievalOutcome` when the metrics implement `IRetrievalMetrics`; `components.toolCatalog.records` / `.profile` |
| request logger | yes | reranker LLM / decision calls, as today (`component: 'rerank'`) |

- **A reranker error is always observable.** A wrong or missing score count from any reranker
  (Cohere, Jev, LLM or a consumer's) → `RERANK_ERROR` → counted (`rerank_fallback` or
  `rerank_error`), on the span, as a session step. Never silent.

### 9.2 The 30.1.0 rerank strategies too

- `RerankedRetrieval` and `RerankAllRetrieval` accept the same optional `telemetry` (additive
  constructor option).
- This closes the goal's evidence item ("a fallback is only a session step") for consumers that do
  not adopt profiles.
- `InMemoryMetrics` and `NoopMetrics` implement `IRetrievalMetrics`. No new log sink, no new logger.

### 9.3 Failure policy

- `onFailure: 'stage1'` (default) = 30.1.0: stage-1 order, counted as `rerank_fallback`.
- `onFailure: 'error'` = the strategy returns the `RagError` (counted as `rerank_error`), so the
  stage reports it — for consumers that prefer no answer to an unranked one.

---

## 10. In-scope fixes

### 10.1 F1 — the store's embedder behind `StrategyRag`

- **Bug:** `vectorizeMcpTools` reads `(toolsRag as any).embedder`
  (`vectorize-mcp-tools.ts:168-171`). With `rag.retrieval.tools` set, SmartServer passes a
  `StrategyRag` (`smart-server.ts:1550`), which has no such field, so vectorization silently drops
  to one tool at a time — slower, and the 429-prone path of #236.
- **Fix:** `retrievalEmbedderOf(rag)` walks `IRagDecorator.inner`; stores declare
  `IRetrievalEmbedderOwner` (`VectorRag`, `QdrantRag`, `PgVectorRag`, `HanaVectorRag`; their
  existing private field becomes the capability). `InMemoryRag` has none → sequential path, as
  today. The `any` cast is removed. **Decision for the user** — D8 (touches three provider
  packages).
- **Test:** SmartServer with `rag.retrieval.tools: { strategy: rerank }` → `embedDocuments` is
  called in batches; no per-tool writes.

### 10.2 F2, F3 — de-duplication

- **F2** `tools-rag-handle.ts:66-73`: no de-duplication; a tool with two hits is pushed twice. Fix:
  keep the first occurrence per name (order preserved).
- **F3** `skill-select.ts:33-38`: `id.slice(6)` turns `skill:<name>:<suffix>` into the name
  `<name>:<suffix>`. Fix: `skillNameFromRecord(meta)` — `metadata.name` first (written by
  `vectorizeSkills`), else the id without `skill:` and without a `:…` / `#…` suffix; a `Set`
  de-duplicates. Lives beside `toolNameFromRecord` in `tool-record-key.ts`.
- Both are correct with or without a profile.

### 10.3 `IToolIndexingStrategy` — deleted

- `packages/llm-agent/src/rag/tool-indexing-strategy.ts` is not exported (not in `rag/index.ts`,
  not in the package `exports` map) and not wired anywhere — deleting it breaks no consumer.
- What replaces each of its implementations:
  - `OriginalToolIndexing` → the `full` record of `FacetedToolIndexer` (and, without a profile,
    the untouched 30.1.0 record code);
  - `IntentToolIndexing` → `IntentRecordIndexer` / `IntentCompanionIndexer` with an
    `IToolIntentSource` (`LlmIntentSource`, neutral prompt, or `StaticIntentSource`);
  - `SynonymToolIndexing` is **not** ported — its hard-coded verb synonyms are words the provider
    did not write.
- Docs that describe it as usable are rewritten to describe collection profiles:
  `docs/INTEGRATION.md:1516-1550`, `docs/PERFORMANCE.md:335-355`,
  `docs/ARCHITECTURE.md:584, 608-611`.

---

## 11. Package placement

| What | Package | Why |
|---|---|---|
| All contracts of §3 | `@mcp-abap-adt/llm-agent` | shared by libs, server-libs, provider packages and consumers |
| `StagedRetrieval`, `ItemPool`, cuts, `MaxScoreCollapse`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `OperationFacet`, `ObjectFacet`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `SharedItemsProfile` | `@mcp-abap-adt/llm-agent-libs`, `src/collections/` (small modules) | the retrieval built-ins, rerankers and the builder that uses them already live here; `llm-agent-rag` is the backend/embedder factory layer **below** libs and has no rerankers or LLM steps |
| `SapAiCoreReranker` | **new** `@mcp-abap-adt/sap-aicore-reranker` | §5.3 |
| YAML resolver + validation, `makeCrossEncoder` seam type | `@mcp-abap-adt/llm-agent-server-libs` | beside `resolve-retrieval.ts` and `makeDecisionModel` |
| `createMakeCrossEncoder` (builds `SapAiCoreReranker`, resolves `credentialRef`) | `@mcp-abap-adt/llm-agent-server` (the app's composition root) | beside `make-decision-model.ts` |
| `IRetrievalEmbedderOwner` implementations | `llm-agent` (`VectorRag`), `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | where the stores are |

- **Decision for the user** — D1 (libs vs a new `llm-agent-collections` package), D2 (the reranker
  package).
- New files carry no per-file licence header (the repo has none); every package, the new one
  included, is `LGPL-3.0-only` in `package.json`.

---

## 12. Query preparation and #323

- Decided: **query preparation is not part of a profile in this PR.**
  - The `translate` stage, the in-store `IQueryPreprocessor` and the (dead) `IQueryExpander` stay
    where they are.
  - Query decomposition is a retrieval-time slot of `StagedRetrieval`, filled only by the
    consumer (§4.5); it is not query preparation and ships no implementation.
- Reasons:
  - one rewrite per request is shared by all stores (a per-profile rewrite would multiply LLM calls
    by the number of stores);
  - rerankers already see the text the stores see.
- So #323 stays a pipeline fix (emit `expand`) in its own PR. **Decision for the user** — D9.

---

## 13. Compatibility and migration

- **No profile configured → no change.** Same records (golden test), same stages, same k
  semantics, same `RerankHandler` precedence, same YAML.
- Removed: only the unexported `IToolIndexingStrategy` file.
- Added, all optional: the contracts of §3, one builder method, the YAML sections
  `rag.profiles` and `crossEncoder`, one composition seam, optional health fields, the embedder
  capability, telemetry options on the 30.1.0 rerank strategies, one new package.
- Release: a **minor** version. The new package is published at the same version, before the app.
- Opting in on a persistent tools store = a fresh collection (§7.8).
- **k is unchanged:** the overall limit of a retrieval, now counted in items under a profile, with
  or without a decomposer. `docs/INTEGRATION.md` documents the `IQueryDecomposer` slot and its
  budget contract (§4.5).
- **Profile records are addressed by owner-scoped ids** (§3.1): `rag.getById(itemId)` on a profiled
  store finds nothing; use `bound.get(ref)`. Documented in `docs/INTEGRATION.md`.
- Docs updated in the same PR: `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`,
  `docs/PERFORMANCE.md`, `docs/EXAMPLES.md` (YAML, both reranker configurations),
  `docs/TROUBLESHOOTING.md` (rerank error metric; switching profiles needs a fresh collection),
  `CLAUDE.md` key API notes, the new package's `README.md`.

---

## 14. Tests

### 14.1 Unit (`npm test`)

- `deriveToolFacets`: table — `GetWhereUsed`, `GetATCFindings`, `RuntimeListFeeds`,
  `server__ReadClass`, `snake_case_tool`, single-word name, empty / tag-only description.
- `recordId`: table — every scope; `:` `/` `#` inside owner key / item id do not collide
  (`u` + `a/b` + `c` ≠ `u` + `a` + `b/c`); ids over 200 characters become `h:` + 64 hex, stable
  across calls; every id ≤ 255 characters.
- Tools indexing: deterministic ids; canonical id = `recordId(global, itemId, 'full', 0)`;
  `itemText` only on non-canonical
  records; one `intent` record per tool, `generated: true`, in the tool store (`record`) or only in
  the companion (`companion`); no intent text in any provider record; `generatedFrom` skips an
  unchanged tool; each indexer's `maxRecordsPerItem` bounds what it writes.
- Variants: each `mcpToolsVariants` factory returns exactly the strategy instances of §7.4 (pool,
  collapse, reranker, cut), with no decomposer unless the consumer passes one; `baseline` binds
  nothing; intents and a decomposer refused on `baseline`.
- Shared items: owner flattening for user / group / global; `reserved-kind`;
  `too-many-records`; `user` item with a foreign `userId` refused; missing partition refused;
  re-index writes the new records and deletes the unlisted old ones (`recordIds`); `remove`;
  `get` identity-checked; `ttl` written.
- **Identical item ids across users stay separate:** users A and B index `itemId: 'case-42'` into
  the same `user` store (an `InMemoryRag`) → two canonical records with different ids; A's `get`
  returns A's text and `data`; B's re-index leaves A's records untouched; B's `remove` leaves A's
  item; A's retrieval returns only A's item.
- **Interrupted replacement:** a stale non-canonical record of a live item hydrates to the current
  canonical record (never its own text); a non-canonical record whose canonical is gone is dropped
  and counted `orphan`.
- Type checks (`__typechecks__`): a record without `owner` fails; extras setting `itemId` /
  `visibility` fail; `withToolsProfile(sharedItemsProfile)` fails;
  `SharedItemsStores` with neither `user` nor `global` fails; a shared item with `session`
  visibility fails.
- `StagedRetrieval`: max collapse; k counts items; **candidate pool in items** (a store where every
  item has `maxRecordsPerItem` records still yields `ItemPool(n)`'s `n` items); skill records pass
  through; reranker-text order; **hydration: only a secondary record matches → the full payload
  (canonical text + `data`) is returned**; a missing canonical record → dropped, counted, span
  `orphans`; orphans do not use up k; **the reranker never receives intent text**; `getById`
  result outside the identity filter dropped; user partition skipped without `userId`; both failure
  policies; reranker output check (wrong count, duplicate, non-finite → `RERANK_ERROR`); the cut
  applied once, at most `cut.limit(k)` items returned; **decomposer:** none → one run; `[]` →
  one run with the whole budget; each sub-query reranked against its own text and kept to its
  `k`; union de-duplicated by owner-qualified item; budgets summing to > k, `k < 1`, empty text or
  a decomposer error → `DECOMPOSE_ERROR`, counted, never a silent fall-back; at most `budget`
  items with any decomposer; `keepStage1Top` counted inside k; collapse keys on the owner-qualified item;
  `keepStage1Top`; every cut; telemetry (span attributes, counter, session
  step).
- `SapAiCoreReranker` (mock `fetch`): URL, `AI-Resource-Group` header, bearer asked per call, body
  `{model, query, documents, top_n}`; mapping by `index`; ties keep input order; missing /
  duplicate / out-of-range index, wrong count, non-finite score, HTTP error → `RERANK_ERROR`;
  `signal` aborts; the token never appears in an error message.
- `vectorizeMcpTools`: golden test of the default path; item accounting with a profile; one batch
  for all records; F1 regression through `StrategyRag` and `FallbackRag`.
- F2 / F3.
- Precedence: a profiled store is skipped by `RerankHandler`; binding is idempotent (server +
  builder).
- YAML: every validation rule of §6.2 through the real `resolveSmartServerConfig`; the
  `makeCrossEncoder` seam is required only when a profile asks for `cross-encoder`.

### 14.2 Conformance kit

`@mcp-abap-adt/llm-agent/testing/collection-profile-conformance` (beside
`rag-filter-conformance`): for any `ICollectionProfile` — owner keys and visibility on every
record; deterministic, owner-scoped ids (`recordId`; the same `itemId` under two owners → disjoint
ids); every returned item hydrated from its canonical record; **at most k distinct items returned,
with or without a decomposer** (the kit also runs an adversarial decomposer whose budgets overrun
k and expects `DECOMPOSE_ERROR`);
no record outside the caller's identity filter returned; generated records never canonical. A
consumer runs it against its own profile.

### 14.3 Measurement harness

- `scripts/rag-eval` gains `--variant baseline|faceted|faceted-cohere|faceted-jev`, or a
  composition by strategy name (`--indexer`, `--intents off|record|companion`, `--pool-items`,
  `--reranker none|cross-encoder|decision`, `--cut`), and
  **required-recall** (AND of OR-groups; an optional `required` field in the queries file),
  average items returned and MRR — the hub's metrics.
- The core is exported as `evaluateRetrieval({ store, strategy, cases, ks })` from
  `@mcp-abap-adt/llm-agent-libs/testing`, so a consumer runs its own catalog and labels against a
  build of this branch (the PR's "consumer check" stage). A consumer measures its own
  `IQueryDecomposer` the same way, as part of its strategy (§2.4).
- Acceptance (env-gated, not part of `npm test`):
  - on the committed 16.0.0 snapshot, `faceted` is not worse than `baseline` at equal items;
  - the hub's consumer check reproduces, within ±1 row, `baseline`'s and `faceted`'s numbers in
    §7.4;
  - `faceted-cohere` and `faceted-jev` are measured there for the first time as one composition;
    their rows in §7.4 are replaced by that run, and only then is `faceted-jev` promoted (D11).

---

## 15. Out of scope

| Item | Where |
|---|---|
| What a shared item (e.g. an experience case) contains, when it is written, by whom, how its outcome is confirmed, merging, retention policy | the writing pipeline element(s), not the framework (goal decision 2026-10-04) |
| #323 query expander never applied | own PR, after this spec (§12) |
| #304 isolation | own PR; this spec requires owner keys + visibility on every record and collapse after the owner filter; group partitions come from the consumer |
| #326, #327 embedder breaker / signal | own PRs; profiles embed through the existing `IRetrievalEmbedder` seam and add no breaker logic |
| #324, #314, #291, #290, #247 | own PRs (unrelated) |
| Profiles for skills, user collections, session history | later, through the same contract (goal 8) |
| Shared items in the server YAML | D6 |
| A query-decomposition **implementation** (splitting multi-step queries) | the consumer: it injects its own `IQueryDecomposer` into the slot `StagedRetrieval` provides (§4.5); the framework ships none and no variant uses one (goal decision 2026-10-05) |
| BM25 identifier tokenization (`ZDEMO_D_TEST` → `test`) | separate change to the in-store scoring (`ISearchStrategy` / tokenizer) |

---

## 16. Architecture-principle check

1. **Built on existing components:** `IRag`, `IRetrievalStrategy`, `StrategyRag`,
   `applyRetrievalStrategy`, `IReranker`, `DecisionReranker`, `TOOL_QUESTION`,
   `vectorizeMcpTools`'s batch path, the `makeRag` / `makeDecisionModel` seams, `IRagDecorator`,
   `matchesRagIdentity`, `IBearerCredential`, metadata `ttl`.
2. **The app is the example:** SmartServer selects profiles and rerankers from YAML through the
   same builder API.
3. **Interfaces:** consumers depend on `ICollectionProfile` / `IRetrievalStrategy` / `IReranker`.
4. **ISP:** new small interfaces; `IRag`, `IReranker`, `IMetrics`, `IRetrievalStrategy` not grown.
5. **Strategies:** collapse, cut, query decomposition, reranker, intent source, source selector, group
   partitions, indexing, facets, intent sources, candidate pool — all injected. A variant is a
   named set of instances, never flags; the library picks no k, no pool and no reranker by guessing.
6. **File size:** new logic in `src/collections/*` and the new package; `builder.ts` and
   `smart-server.ts` get one call site each per binding.
7. **Additive:** the only removal is an unexported, unwired file.

---

## 17. Decisions for the user

Settled by the goal (no longer asked): experience as a schema in the framework (→ shared items,
§8); intents' home (→ an indexing strategy of the tools profiles, default placement `record`, §7.3); one profile with flags (→ strategies and named variants, §7); the reranker text
(→ provider text, §4.6); the pool unit (→ items, §4.4); the Cohere reranker in this PR (→ §5);
query splitting (→ an injected `IQueryDecomposer` slot, no shipped implementation, `k` stays the
overall limit, §4.5; goal decision 2026-10-05 — the former D12, "k per clause run", is withdrawn).

Settled by the adversarial review (user-approved 2026-10-05):

| # | Decision | Reason |
|---|---|---|
| D13 | **Replacing an item is not atomic; no generations, commit markers, incarnations or locks.** Concurrent writers of one item are serialized by the writer or the store; interrupted replacements may leave stale records (§3.3). | The store owns concurrency (standing rule); collections are filled once, read-mostly. Readers stay safe through D15, not through write coordination. |
| D14 | **Physical record ids are owner-scoped:** `recordId(owner, itemId, kind, n)`, one function for `index`, `get`, `remove`, hydration and collapse (§3.1). | Every backend keys records by id alone (`InMemoryRag.upsert`, `VectorRag`, pg/HANA primary key, Qdrant UUID of the id); with `id = itemId`, two users' `case-42` would overwrite each other. |
| D15 | **Every returned item is hydrated from its canonical record**, owner-checked; `itemText` is a reranking shortcut only; a hit without a canonical record is dropped and counted (§4.6). | Makes D13 safe for readers and returns the item whole (incl. `data`) even when only a secondary record matched. |

| # | Question | Recommendation |
|---|---|---|
| D1 | Default implementations: `llm-agent-libs` or a new `llm-agent-collections` package? | **libs** — the retrieval built-ins and the builder are there; a new package would depend on libs and add a release step for no isolation gain. |
| D2 | `SapAiCoreReranker` in its own package `@mcp-abap-adt/sap-aicore-reranker`? | **Yes** — one provider, one role, like `typesafe-decision` and the `*-embedder` packages; no vendor client in libs, no embedder dependency for rerank-only consumers (§5.3). |
| D3 | Companion intents: one record per tool (as in `record` placement) or one per intent? | **One per tool** — the measured layout; switching placement then moves records without reshaping them. |
| D4 | Builder skills: coexist in the tools store or move to their own store now? | **Coexist** (pass-through) — moving changes their k and ranking, which goal 8 excludes. |
| D5 | Shared-item visibility: `user` / `group` / `global` as partitions, group stores supplied by the consumer (`ISharedItemGroups`)? | **Yes** — works with today's `IRag` filter (no new filter contract) and leaves group/role isolation with the consumer, as #304 was narrowed. |
| D6 | Shared items in the server YAML in this PR? | **No, library API only** — the writing elements are the consumer's; an empty shared store in SmartServer has no writer. YAML when the first shipped writer exists. |
| D7 | Ship `keepStage1Top`? Its only measurement (a post-hoc 1.000) was on top of the former built-in clause split. | **Ship, default 0, counted inside k** (§4.7), documented as unmeasured without the split and not validated on fresh queries. |
| D8 | Replace the private embedder read with `IRetrievalEmbedderOwner` (3 provider packages) in this PR? | **Yes** — the cast is the root cause of F1 and batch indexing of records needs the same embedder. |
| D9 | Query preparation outside profiles; #323 as a pipeline fix | **Yes** (§12). |
| D10 | `SapAiCoreReranker`: `deploymentId` only, or also resolve by model name? | **`deploymentId` in this PR**; resolving by model needs `resolveDeploymentId`, today private to `sap-aicore-embedder`. Sharing it (e.g. moved into `sap-aicore-auth`) is a follow-up. |
| D11 | Ship `faceted-jev` as a named variant before it is measured as one composition? | **Ship it, marked "to be measured as one composition on fresh consumer queries before promotion"** — only the closest measured setup's numbers quoted, not recommended over the others until the consumer check runs it (§7.4, §14.3); one record + Jev, the best measured Jev setup, stays available through 30.1.0's `rerank` strategy. |
