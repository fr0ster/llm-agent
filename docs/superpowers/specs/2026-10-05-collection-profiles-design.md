# Collection profiles — design spec

> **Serves:** the goal document `docs/superpowers/goals/2026-10-04-collection-profiles.md`
> (user-owned, binding). Where this spec and the goal differ, the goal wins and this
> spec is wrong.
>
> **Base:** release 30.1.0 (`2cc2ba33`). Builds on #321's per-store retrieval
> (`IRetrievalStrategy`, `StrategyRag`, the rerank strategies; its spec §13 is in git
> history at `74922e28^:docs/superpowers/specs/2026-10-02-decision-model-design.md`).
>
> **Status:** draft for the user's review. D1–D11 and `IItemCut.limit()` were approved by the user
> on 2026-10-05 (§17.2). The server-agnostic amendment raised D16–D22; the `compact` measurement
> settles D17, D19, D20 and D21 (§17.3); D16, D18, D22 and the new D23 stay open, each with a
> recommendation.
>
> **Amended 2026-10-05** for the goal's *Purpose* and goal 9: llm-agent builds **any** pipeline
> with **any** MCP server. `mcp-abap-adt` is one server; its names and figures appear only as
> labelled examples and as the evidence they were measured on (§2.0, §7.0).
>
> **Amended 2026-10-05 (2)** for the goal's decisions on tuning and strategy choice: the
> **consumer** makes the main behaviour choices by choosing the strategies it injects; components
> are generic; tuned numbers live only in default compositions, each citing its measurement
> (§7.1). The coarse-set (`compact`) measurement is in (§2.5.1): the coarse default is now one record
> per tool + rerank-all + 3 tools.

## TL;DR

- **The consumer decides the behaviour.** A profile is a **composition of strategies the consumer
  injects**: indexing, candidate pool, collapse, reranker, final cut, query decomposition. The
  consumer makes the main behaviour choices by choosing those strategies (goal decision
  2026-10-05).
- **Shipped "variants" are default compositions, not the centre of the design.** A default only
  fills in what the consumer did not choose. Taking one whole is one choice among many.
- **Components are generic.** A strategy class carries no number tuned to a server or a consumer.
  Tuned numbers (pool size, k) appear **only inside default compositions**, each with the
  measurement that justifies it (§7.1).
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
- **Profiles for different MCP servers (goal 9).**
  - The **shipped** tools strategies read only what any MCP server exports: name, description,
    input schema (property names, descriptions, enum values). None parses one server's naming
    convention (§7.0).
  - Where no shipped profile fits a server, the **consumer builds its own** from the contracts and
    uses it in the pipeline; the contracts are sufficient for that (§7.9).
- Default profiles ship:
  1. **MCP tools — several default compositions ("variants")** to start from (§7):
     - `baseline` = 30.1.0 (one record per tool, top-k) — what a consumer gets by choosing nothing;
     - `faceted` = `full` + `summary` + `parameters` records (all schema-derived), item pool,
       collapse by max — for **fine-grained** tool sets;
     - `faceted-cohere` = faceted + Cohere on SAP AI Core;
     - `faceted-jev` = faceted + TypeSafe Jev (`DecisionReranker`);
     - `small-set-jev` = one record per tool + Jev over the **whole** set (rerank-all) + **3
       tools** — for **coarse / small** tool sets. Measured on mcp-abap-adt `compact`: 0.970
       required-recall at ~1.6k tokens, against ~7.9k for the whole set (§2.5).
     **Intents** are an indexing strategy the consumer can add to any of them: an `intent` record
     per tool (default placement) or a companion collection.
  - **Generic strategies in no default, the consumer's to inject** — each documented with what was
    measured:
    - `EnumValueToolIndexer` (one record per enum value): measured **worse** on `compact`
      (§7.3.2);
    - `TokenBudgetCut` (whole items while they fit a token budget): a **prompt-size guard**;
      measured worse than a count as the main cut (§4.10).
  2. **`SharedItemsProfile`** — a generic shared base. Pipeline elements write items (record kinds
     of their choosing) through `index()` / `remove()`; the profile finds them and returns each
     item **whole**; every record carries owner keys and a visibility (`user` / `group` /
     `global`). What an item contains is the writing element's business, not this spec's.
- **Rerankers are alternatives** (goal 10): a new **`SapAiCoreReranker`** (Cohere on SAP AI Core, own
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
| **Record** | One row in a store: physical id + embedded text + metadata | the `summary` record of `tool:read_file` |
| **Item id** | The **logical** id a writer or provider chooses (`metadata.itemId`). Not unique in a store | `tool:read_file` |
| **Record id** | The **physical** store id: owner scope + owner key + item id + kind + index (§3.1) | `g:/tool%3Aread_file#summary:0` |
| **Record kind** | Which view of the item a record is | tools: `full`, `summary`, `parameters`, `value`, `intent` (+ a consumer's own); shared items: `item` + the writer's own kinds |
| **Fine-grained tool set** | Many tools, one per operation **and** object, short schemas | example: mcp-abap-adt's object-oriented set — 345 tools, median ~840 chars (`GetClass`, `UpdateDomain`) |
| **Coarse tool set** | Few tools, one per operation, the object passed in a parameter, large schemas | example: mcp-abap-adt `compact` — 25 tools for the writer role (16 for the reader), `object_type` enum; the whole writer set ≈ 7.9k tokens mean / 9.9k p90 per query |
| **Discriminating parameter** | The input-schema property whose enum values name the different things a coarse tool acts on (§7.3.2) | example: `object_type` in mcp-abap-adt `compact` |
| **Definition size** | Size of the tool definition the LLM receives: name + description + input schema, as exported (§4.10) | `HandlerCreate` ≈ 5k chars (mcp-abap-adt `compact`) |
| **Canonical record** | The item's record of the indexer's `canonicalKind`, index 0. Its text is the item text; its metadata is the item's payload | `full` (tools), `item` (shared items) |
| **Owner-qualified item** | (owner scope, owner key, item id) — what collapse, `get` and `remove` key on | (`user`, `alice`, `case-42`) |
| **Provider text** | What the tool provider exports: name, description, input schema (property names, descriptions, enum values) | the `full` record's text |
| **Generated record** | A record whose text an LLM (or another generator) produced | an `intent` record |
| **Store** | One `IRag` instance, addressed by its `ragStores` key | `tools`, `shared`; a consumer's per-role tool stores (e.g. `tools-reader`, `tools-writer`) |
| **Source** | One store a retrieval queries, with its own identity filter | primary, intents companion, user partition |
| **Partition** | A store that holds the shared items of one visibility | the `user` store, the `global` store, one group's store |
| **Collection kind** | The kind of items a store holds | MCP tools, shared items, skills, user collections, history |
| **Profile** | The indexing + retrieval pair for one collection kind (`ICollectionProfile`) — a composition of strategies | `ComposedToolsProfile` |
| **Variant** | A **default composition**: a named, shipped set of strategy instances for one kind. It fills in what the consumer did not choose; its tuned numbers cite a measurement (§7.1) | `faceted-cohere`, `small-set-jev` |
| **Binding** | A profile applied to one concrete store set (`IBoundCollection`) | `mcpTools.bind({ key: 'tools', rag })` |

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
| — | new | `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IndexedRecord`, `RecordDraft`, `recordId`, `RecordOwner`, `ItemRef`, `ICandidatePool`, `ICollapseRule`, `IItemCut`, `IQueryDecomposer`, `SubQuery`, `ISourceSelector`, `RetrievalSource`, `IRetrievalMetrics`, `ToolItem`, `ToolParameter`, `ToolParameterValue`, `IToolFacet`, `IToolIntentSource`, `IDiscriminatorSelector`, `IItemSizeEstimator`, `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `StagedRetrieval`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `CharsPerTokenEstimator`, `ToolDefinitionSizeEstimator`, `SharedItemsProfile`, `SapAiCoreReranker` |

---

## 2. Why this shape (evidence → design)

### 2.0 Scope of the evidence

- **One consumer, one server, two tool sets.** Every figure below comes from cloud-llm-hub over
  **one** MCP server (`mcp-abap-adt`): its fine-grained set (§2.1–§2.3) and its coarse `compact`
  set (§2.5). It is evidence for the design, **not** the target platform (goal *Purpose*).
- **What carries over to any server:** the retrieval mechanics — items vs records, collapse by max,
  the pool in items, rerankers on provider text. They do not depend on what the tools are called.
- **What does not carry over:** any record whose text came from parsing **this** server's tool
  names. The measured `object` record did (§2.1, last row); it is not in any shipped default.
- **Coarse tool sets are measured on one example** (`compact`, §2.5). Its results set the coarse
  default composition (`small-set-jev`, §7.4) and document the two strategies it rejected
  (`EnumValueToolIndexer`, `TokenBudgetCut` as the main cut).
- **The schema-derived `ParametersFacet` is not measured yet** on the fine-grained set. The
  `faceted*` defaults cite the closest measured layouts (§2.1); the consumer check measures the
  schema-derived one (§14.3).

Source: cloud-llm-hub, 237 tools, labelled queries, **required-recall** (every needed tool
returned). EN-ext = 87 rows (73 single-step + 14 multi-step); non-English = 26 rows.

**Noise:** 1 row ≈ **1.15 points** on EN-ext (n=87). Multi-step has only **14 rows** (1 row ≈ 7
points). Differences of 1–2 rows are noise.

### 2.1 Indexing

| Measured | Design consequence |
|---|---|
| Today (one record per tool, hybrid): 0.943 at k=5; 0.977 at k=15 with ~25 tools | baseline stays the default profile |
| `full` + `operation` + `object` (the measured layout; `object` parses names, see the last rows), collapse by **best hit**: 0.966 at k=5; 0.977 at k=8 with ~13 tools | multi-record indexing + collapse step, k in items |
| Collapse by count or RRF is worse than max | ship **`MaxScoreCollapse` only**; the rule is an injected `ICollapseRule` |
| Facets without `full` are clearly worse (0.885) | `full` is not a facet, so it cannot be dropped (§7.3) |
| Deterministic facets = LLM facets on English: LLM-generated `operation` / `object` facets and name-derived facets both 0.966 at k=5, hybrid (hub spike `spike-facets`) | default facets need no LLM |
| Intent layouts, stage 1 only (hybrid, k=5): intents inside `full` 0.954; own `intent` record 0.954; no intents 0.943; both 0.954. Differences 1–2 rows | intents are an **indexing strategy** the consumer adds; default placement **own record** (§7.3) |
| Intent layouts **with a reranker** (several records per tool): within noise of each other (goal *Evidence*) | the layout is chosen for stage-1 reasons only |
| The measured third record, `object`, was "the name words after the first word" — it assumes names are verb-first (`GetWhereUsed` → `where used`), a convention of one server | **not** in any default: kept only as the opt-in, convention-dependent `NameTailFacet` (§7.3). The default third record is schema-derived (`parameters`), **not yet measured**: the `faceted*` defaults cite the two closest measured layouts above (both 0.966 at k=5); the consumer check measures the schema-derived one (§14.3) |
| The measured `operation` record ("name words — first description clause") only tokenizes the name; it assumes no order or vocabulary | kept, renamed **`summary`** (same text): nothing in it is server-specific |

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

### 2.5 Two shapes of tool sets (goal 9)

Sizes of one server's two sets (mcp-abap-adt, exported definitions — **examples**, not targets):

| Shape | Example | Tools | Definition size |
|---|---|---|---|
| fine-grained | object-oriented set | 345 | median ~840 chars per tool |
| coarse | `compact` | 25 for the writer role, 16 for the reader role (one per operation, object in `object_type`) | whole writer set ≈ **7.9k tokens mean / 9.9k p90 per query**; `HandlerCreate` / `HandlerUpdate` ~5k chars each |

- **Role sizes:** 25 / 16 are what the code and its tests say. The goal's "22" (and "13") come from
  outdated code comments.

#### 2.5.1 The `compact` measurement

- **Set-up:** the coarse example `compact`; **61 of the 85 labelled queries** have a `compact`
  equivalent and are used. EN-ext = 67 (query, role) rows; hybrid in-store scoring,
  **required-recall**; tokens = mean summed definition tokens of the returned tools per query.
  C0 record text = name + description + parameter names (the provider text, no intents, i.e. the
  `full` record). A budget cut applies to the ranking named in its row (stage 1, or after Jev).
- **Noise:** one row ≈ 1.5 points on 67 rows; differences of 1–2 rows are noise.

| Layout | Retrieval | Required-recall (tokens) |
|---|---|---|
| **C0** one record per tool | stage 1 only, k=3 | 0.896 (1.6k) |
| C0 | stage 1 only, k=5 | 0.955 (2.5k) |
| C0 | stage 1 only, token budget 2k | 0.896 |
| C0 | stage 1 only, token budget 4k | 0.985 (3.7k) |
| **C1** = C0 + one record per enum value (`EnumValueToolIndexer`) | stage 1 only, k=3 / k=5 / budget 2k | 0.776 / 0.896 / 0.761 — **worse than C0** |
| C1 | + Jev | English: equal to C0 + Jev. Non-English: **0.857** vs **1.000** for C0 + Jev |
| C0 | + Jev (stage-1 pool, then rerank), k=1 / 2 / 3 / 5 | 0.776 / 0.925 / **0.970 (1.6k)** / 0.970 |
| C0 | **Jev over the whole role set, no stage-1 cut** (30.1.0 `RerankAllRetrieval`, `rerank-all`), k=3 | **0.970 (1.6k)**; multi-step 1.000; non-English 1.000 |
| C0 | + Jev, token budget 2k (at the same ~1.6k tokens as k=3) | 0.910 — vs **0.970** for k=3 |
| *for comparison:* fine-grained set, one record per tool (V0) | + Jev, k=5 per collection | 0.969 (2.1k) |

**Design consequences:**

- **One record per tool is enough for a small coarse set — when a reranker reads it.** Stage 1
  alone needs k=5 (0.955) or a 4k budget (0.985). Jev with k=3 reaches 0.970 at **1.6k tokens**,
  about a fifth of sending the whole set.
- **Stage 1 adds nothing for a set this small.** Jev over the whole role set equals Jev over a
  stage-1 pool (both 0.970 at k=3). The default reranks the whole set: no pool depth to tune
  below the set size.
- **Per-value records hurt here.** C1 is worse on stage 1 alone, and with Jev it loses non-English
  queries (0.857 vs 1.000). → `EnumValueToolIndexer` stays a generic strategy a consumer may inject
  (another server's coarse set may differ), documented with this result, and is in **no** default
  (§7.3.2).
- **A token budget is worse than a count as the main cut.** At equal tokens (~1.6k) the 2k budget
  gives 0.910 and k=3 gives 0.970: the cut stops at the first tool that does not fit (§4.10). →
  `TokenBudgetCut` stays a generic **prompt-size guard** a consumer may inject, in **no** default.
- **The coarse default ships with measured numbers** (`small-set-jev`, §7.4): k=3 from the table;
  the pool = the whole set, as measured.
- **The coarse set reaches the fine-grained set's recall** (0.970 vs 0.969) at fewer tokens
  (1.6k vs 2.1k) — on one server's example; another server measures its own (§14.3).

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
  /** Not failures, but they changed what was written (e.g. `ambiguous-discriminator`, §7.3.2). */
  readonly notes?: readonly { readonly itemId: string; readonly note: string; readonly detail?: string }[];
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
 *  Applied once, to the final result. Returns a rank-order PREFIX of whole items. */
export interface IItemCut {
  readonly name: string;
  /** An UPPER BOUND, in items, on what `cut` returns for `requestedK` — the retrieval's budget
   *  (§4.5). Not a promise to return that many: a cut may stop earlier (score floor, token
   *  budget, §4.10). `cut(...)` never returns more items than this. */
  limit(requestedK: number): number;
  cut(items: readonly RagResult[], requestedK: number): RagResult[];
}

/** How big an item is for the prompt, in (estimated) tokens. Injected into a size-bounded cut. */
export interface IItemSizeEstimator {
  readonly name: string;
  /** A non-negative integer. Pure: the same item always gets the same size. */
  estimate(item: RagResult): number;
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
/** Everything here is read from what ANY MCP server exports (`tools/list`): name, description,
 *  inputSchema. Nothing depends on one server's naming convention (goal 9). */
export interface ToolItem {
  readonly itemId: string;            // the IToolRecordKey output, e.g. `tool:read_file`
  readonly name: string;              // exposed (namespaced) name → metadata.name
  readonly originalName: string;      // provider's name (pre-namespace); facets derive from it
  readonly description: string;
  /** Top-level `inputSchema.properties`, in schema order — what the shipped strategies read. */
  readonly parameters: readonly ToolParameter[];
  /** The input schema exactly as exported. Shipped strategies do not read it beyond
   *  `parameters`; it is here so a consumer's own strategy can read anything a server puts in its
   *  schema (annotations, nested objects) — §7.9. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Characters of the definition the LLM receives: JSON of { name, description, inputSchema }
   *  as exported. → canonical `metadata.definitionChars`; read by `ToolDefinitionSizeEstimator`. */
  readonly definitionChars: number;
}

export interface ToolParameter {
  readonly name: string;
  readonly description?: string;
  /** Listed in `inputSchema.required`. */
  readonly required: boolean;
  /** String values from `enum`, or from `oneOf` / `anyOf` entries with a string `const`
   *  (each with that entry's `description` / `title`). Empty when the property has none. */
  readonly values: readonly ToolParameterValue[];
}

export interface ToolParameterValue {
  readonly value: string;
  readonly description?: string;
}

/** One extra record view of a tool, derived from provider text only (e.g. summary, parameters). */
export interface IToolFacet {
  readonly kind: string;               // the record kind, e.g. 'summary'
  /** The record text, or undefined when the provider text yields nothing (no record then). */
  derive(tool: ToolItem): string | undefined;
}

/** Picks a coarse tool's discriminating parameter (§7.3.2). Undefined → no per-value records. */
export interface IDiscriminatorSelector {
  readonly name: string;
  select(tool: ToolItem): ToolParameter | undefined;
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
| `ToolItem`, `ToolParameter`, `ToolParameterValue`, `IToolFacet`, `IToolIntentSource` | typed input of the tools indexers; facets and intents are indexing strategies a consumer may write. `parameters` replaces the earlier `parameterNames`: goal 9 requires records from the whole input schema (descriptions, enum values), and names alone cannot carry them. The raw `inputSchema` is there so a consumer can build a profile for **any** server from the contracts (goal 9, §7.9). `definitionChars` is what a token budget measures (§4.10) | builder (libs) + indexers + consumers that bring their own facets or precomputed intents |
| `IDiscriminatorSelector` | goal 9, coarse tool sets: which parameter's values become records is a choice the consumer may inject, not a rule fixed inside the indexer (§7.3.2). Serves `EnumValueToolIndexer`, a generic strategy in no default | libs (`EnumValueToolIndexer`), server-libs (YAML), consumers |
| `IItemSizeEstimator` | goal 9, token-budget cut (a prompt-size guard in no default): how an item's size is counted is injected, so a consumer can bring its model's tokenizer (§4.10) | libs (`TokenBudgetCut`), consumers |
| `IItemCut.limit()` — doc only: an **upper bound** in items | already the meaning ("the most items `cut` returns"); stated explicitly so a cut that stops earlier (score floor, token budget) is honest under the same signature. No signature change | — |
| `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `SharedItemsStores` | goal 7: what writing elements get; owner + visibility | libs (profile) + consumers (writing elements, group partitions) |
| `IndexReport.notes?` | goal 9 + "never silent": an indexer that declines to guess (ambiguous discriminator) must say so without failing the item | libs (indexers), consumers reading the report |
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
    adds 1; `EnumValueToolIndexer` adds its required `maxValues` (§7.3.2);
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
| budget | `budget = cut.limit(requestedK)` (`TopItemsCut` → k; `FixedItemsCut(n)` → n; `ScoreFloorCut` → `maxItems`; `TokenBudgetCut` → `maxItems ?? k`, §4.10) |
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
Default 0. Decided — D7 (§17).

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
| cut | `TokenBudgetCut({ budgetTokens, maxItems?, estimator? })` | rank-order prefix of whole items while their summed size ≤ `budgetTokens`, at most `maxItems ?? requestedK` items; `limit` = `maxItems ?? requestedK` (§4.10) |
| query decomposition | — | **none shipped**; the consumer injects its own `IQueryDecomposer` (§4.5) |

- **k in items.** The caller's k (`ragQueryK ?? 10` in `rag-query`, 20 in `IToolsRagHandle` and the
  controller's `selectTools`) arrives unchanged; under a profile it counts items and is the
  overall limit of the retrieval, with or without a decomposer. A consumer that wants its own
  number uses `FixedItemsCut`. The cut classes carry no number of their own; a default
  composition carries its measured cut in its definition (§7.1), and the consumer chooses it or
  another cut.
- **Score scales.** After a reranker, scores are the reranker's; the global
  `IToolSelectionStrategy` still runs on the flattened results of all stores, as in 30.1.0. A
  per-store threshold therefore belongs in the profile's cut.

### 4.10 Token-budget cut — `TokenBudgetCut`

**What it is:** a generic **prompt-size guard** the consumer may inject. It is in **no** default
composition.

**Why it exists:** tools differ in size by an order of magnitude (§2.5). A count bounds the prompt
only when tools are alike; a budget bounds it always (goal 9).

**Measured as the main cut — worse than a count** (mcp-abap-adt `compact`, §2.5.1):

| Cut | Required-recall | Tokens |
|---|---|---|
| one record per tool + Jev, **k=3** | **0.970** | ~1.6k |
| one record per tool + Jev, **budget 2k** | 0.910 | ~1.6k |

- **Why it loses:** it stops at the first tool that does not fit (rule 3 below), so one large tool
  in the ranking ends the result early. A count does not.
- **Use it** as a ceiling on top of the consumer's main choice — e.g. a guard against a server
  whose tools grow — not as the way to pick how many tools come back.

```ts
new TokenBudgetCut({
  budgetTokens: number,            // required, a positive integer — the library picks no number
  maxItems?: number,               // optional count ceiling; absent → the caller's k
  estimator?: IItemSizeEstimator,  // absent → ToolDefinitionSizeEstimator (below)
})
```

**Behaviour.**

1. Walk the ranked, hydrated items in rank order.
2. Keep an item while `Σ estimate(kept) + estimate(item) ≤ budgetTokens` **and** fewer than
   `maxItems ?? requestedK` are kept.
3. **Stop at the first item that does not fit.** No skipping ahead to smaller items: a lower-ranked
   small tool must never displace a higher-ranked large one.
4. **Never truncates an item.** A tool is returned whole or not at all.

**`limit()` — honest under the existing contract.**

| Question | Answer |
|---|---|
| What does `limit(requestedK)` return? | `maxItems ?? requestedK` — a count, as for every cut |
| Is it the number returned? | No. It is an **upper bound** in items (the contract's meaning, §3.4). The budget may stop the cut earlier |
| Where is the token bound? | In the cut itself, enforced once over the final result (§4.3) |
| With a decomposer? | Sub-query `k`s share `limit(k)` items (§4.5); the token budget applies once, to the merged union |

- **Why no contract change:** `limit()` already promised only "the most items `cut` returns";
  `ScoreFloorCut` also returns fewer. Adding a token figure to `IItemCut` would make every count
  cut carry a meaningless member (ISP). The budget lives in the one cut that has it.
- **`k` stays the overall limit** (goal decision 2026-10-05): a token cut never returns more than
  k items unless the consumer set `maxItems` explicitly (like `FixedItemsCut`).

**Top item alone over budget.** The result is **empty**; counted as `outcome=over_budget` and on
the span (§9). Never silent, never truncated. The consumer that injects the guard sizes the budget
at least as large as its largest tool (every tool's `definitionChars` is known at index time, so
its composition root can check it at startup). Settled — D17 (§17.3).

**Stop, not skip-ahead.** Rule 3 keeps the result a rank-order prefix: a guard must not reorder
what the consumer's ranking chose. The measured cost of stopping (above) is why it is not a main
cut. A consumer wanting skip-ahead injects its own `IItemCut`. Settled — D19 (§17.3).

**Size estimators (injected; shipped defaults documented).**

| Estimator | Size of an item | When |
|---|---|---|
| `ToolDefinitionSizeEstimator` (default) | `ceil(metadata.definitionChars / 4)`; no `definitionChars` → `ceil(text.length / 4)` | tools: measures the definition the LLM receives (name + description + input schema), not the RAG text |
| `CharsPerTokenEstimator(charsPerToken)` | `ceil(text.length / charsPerToken)` | shared items and other kinds: the returned text is what reaches the prompt |
| a consumer's own | e.g. the model's real tokenizer | when ~4 chars/token is not close enough |

- **Why 4 chars per token:** the unit convention `DecisionReranker` already uses for its batch
  budget (`decision-reranker.ts`: `Math.ceil(s.length / 4)`). It is a generic chars-to-tokens
  estimate, not tuned to any server; a consumer that needs precision injects its own estimator
  (e.g. its model's tokenizer).
- **Why `definitionChars` is written at index time:** the canonical record's text is the RAG text,
  shorter than the definition; the cut must count what the prompt will carry.

---

## 5. Rerankers are alternatives (goal 10)

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
  (`resolveDeploymentId`). Decided — D10 (§17).

### 5.4 Rerankers in the default tools compositions

- Cohere: `faceted-cohere`. Jev: `faceted-jev`, `small-set-jev`. See §7.4.
- Which reranker runs is the consumer's choice: any reranker composes with any indexing and
  candidate strategy (§7.5). A default only names the reranker it was measured with.

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
      variant: faceted-cohere                    # baseline | faceted | faceted-cohere | faceted-jev | small-set-jev | a registered name
      intents:                                   # optional indexing strategy; not with baseline
        record: { file: ./tool-intents.json }    # or: companion: { source: { llm: intents }, store: { … } }
      decomposer: my-splitter                    # optional; a NAME the consumer registered (§4.5); not with baseline

    # a coarse / small tool set (e.g. a second MCP server's store):
    tools-coarse:
      variant: small-set-jev
      smallSet: { poolItems: <n> }               # required: ≥ the store's tool count (§7.4)

    # …or the consumer's own composition, every value a NAME of a strategy:
    tools-writer:                                # example key: a consumer's per-role store
      compose:
        indexer: { faceted: [summary, parameters] }  # facet names → IToolFacet instances; name-tail is opt-in
        # or (generic, in no default; measured worse on `compact`, §7.3.2):
        #   indexer: { enum-values: { inner: { faceted: [] }, discriminator: required-enum, maxValues: <n> } }
        # discriminator: required-enum | { named: <parameter> } | a registered name
        pool: { items: 30 }                        # → ItemPool(30)
        collapse: max                              # → MaxScoreCollapse
        reranker: decision                         # none | cross-encoder | decision | llm
        question: tool                             # decision / llm only
        decomposer: none                           # none | a registered name (no built-in)
        cut: { fixed-items: 5 }                    # top-items | fixed-items | score-floor {minItems,maxItems,minScore} | token-budget {budgetTokens,maxItems?}
        onFailure: stage1                          # stage1 | error
```

- Parsed **only** by the server (`resolve-collection-profiles.ts` in server-libs, beside
  `resolve-retrieval.ts`).
- Names resolve through registries in the composition deps (like `embedderFactories`):
  `toolsVariantFactories` (built-ins: the five default compositions of §7.4) and `toolsStrategyFactories` (built-in
  facets, discriminators, pools, collapse, cuts, size estimators). A consumer registers its own, including its decomposers (none
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
  - `small-set-jev` without `smallSet.poolItems`, or a non-positive one; `small-set-jev` without a
    `decision:` model; an `enum-values` indexer without `maxValues`; non-positive `budgetTokens`;
  - a tools key whose variant is not a tools profile.
- Server-wide like `rag.retrieval`: worker configs that declare `rag.profiles` are rejected;
  workers get the main config's bindings by key.
- Shared items have **no YAML** in this PR (library API only). Decided — D6 (§17).

---

## 7. MCP tools — strategies the consumer chooses, and default compositions

### 7.0 Shipped strategies carry no one server's conventions (goal 9)

**Rule.** A shipped tools strategy reads only what **every** MCP server exports in `tools/list`:

| Source | Used by |
|---|---|
| `name` (tokenized, no assumed order or vocabulary) | `full`, `summary`, `value` records |
| `description` (whole, or its first clause) | `full`, `summary`, `value` records |
| `inputSchema` — property names, descriptions, `required`, string `enum` / `const` values | `full`, `parameters`, `value` records; the discriminator (§7.3.2) |
| size of the exported definition | `definitionChars` → `TokenBudgetCut` (§4.10) |

- **Never in a shipped default:** parsing a name by verbs (`Get` / `Read` / `Create` …), a list of
  one domain's object words, a server's exposition groups (e.g. mcp-abap-adt's `readonly` / `high`
  sets) or role names. Those belong to a consumer's own strategy.
- **Convention-dependent strategies may ship only as opt-ins**, documented as such, and in **no**
  named variant: `NameTailFacet` (§7.3.1) is the one.
- **mcp-abap-adt names in this section are examples**, marked as such.
- **Not a promise that a shipped variant fits every server.** It is a promise that the shipped
  ones assume nothing server-specific, and that the contracts let a consumer build the rest (§7.9).

**Server-specific assumptions found in the previous draft, and their fix:**

| Previous draft | Assumption | Now |
|---|---|---|
| `ObjectFacet` = "name words after the first word", in every `faceted*` variant | names are verb-first and the rest names the object (`GetWhereUsed`) | renamed **`NameTailFacet`**, opt-in, convention-dependent, in no variant; the default third record is the schema-derived **`parameters`** |
| `OperationFacet` / record kind `operation` | the name encodes an operation | same text, renamed **`SummaryFacet`** / kind **`summary`**: it only tokenizes the name and takes the description's first clause |
| `ToolItem.parameterNames` only | — (too little, not wrong) | `ToolItem.parameters`: names, descriptions, `required`, enum values (goal 9: input schema incl. enum values) |
| first-clause rule drops "tags such as `[read-only]`" | one server's description tags | generic: any leading `[...]` tag; `[read-only]` is the labelled example |
| name rule "drop a namespace prefix (`server__`)" | — | removed: facets read `originalName`, which is already pre-namespace |
| examples `GetWhereUsed`, `GetATCFindings` as the design | ABAP tools as the reference | generic examples first; ABAP ones labelled (§14.1) |
| only fine-grained tool sets considered | one tool per operation **and** object | coarse sets are measured (§2.5.1) and get the `small-set-jev` default; `EnumValueToolIndexer` and `TokenBudgetCut` stay generic strategies in no default |

### 7.1 Principle — the consumer chooses the strategies

(Goal decisions 2026-10-05: where tuning lives; the main behaviour choices are the consumer's.)

**1. The consumer decides the behaviour.**

- A profile is a **composition of strategies the consumer injects** (§7.2): indexing, candidate
  pool, collapse, reranker, final cut, query decomposition.
- The main behaviour choices — which records, which reranker, how many tools come back, whether
  to guard the prompt size — are made by **choosing those strategies**. No flag inside a component
  makes them.

**2. A default composition only fills in what the consumer did not choose.**

- llm-agent ships the **contracts** and **generic strategies**, plus a few **default
  compositions** ("variants", §7.4) to start from.
- A default is not the centre of the design: it is a ready-made answer for the choices the
  consumer leaves open. Taking it whole is one choice; replacing any part of it is another (§7.5).
- No default relies on one server's conventions (§7.0). Each names the **shape** of tool set it
  was measured on (fine-grained or coarse / small, §2.5). Where none fits a server, the consumer
  composes its own from the contracts (§7.9).

**3. Components are generic; tuning lives only in default compositions.**

- A strategy class (`ItemPool`, `FixedItemsCut`, `TokenBudgetCut`, `EnumValueToolIndexer`, …)
  carries **no number tuned to a server or a consumer**. Every such number is a required
  constructor argument.
- Tuned numbers (pool size, k) appear **only inside a default composition**, each next to the
  measurement that justifies it (the table in §7.4). A number without a measurement is not
  shipped.
- Nothing is guessed (goal 3): the consumer picks a default explicitly, or its own strategies.

### 7.2 The strategies

| Step | Contract | Shipped instances |
|---|---|---|
| indexing | `IItemIndexer<ToolItem>` | 30.1.0 single record (no profile); `FacetedToolIndexer(facets)`; `EnumValueToolIndexer(inner, { discriminator, maxValues })`; `IntentRecordIndexer(inner, source)`; `IntentCompanionIndexer(source)` |
| facet (inside faceted indexing) | `IToolFacet` | `SummaryFacet`, `ParametersFacet`; opt-in, convention-dependent: `NameTailFacet` |
| discriminator (inside per-value indexing) | `IDiscriminatorSelector` | `RequiredEnumDiscriminator`, `NamedDiscriminator(parameter)` |
| intent source | `IToolIntentSource` | `StaticIntentSource(map)`, `LlmIntentSource(llm, { prompt? })` |
| in-store scoring | `ISearchStrategy` (existing, on the store) | the store's own (hybrid or cosine) |
| candidate pool | `ICandidatePool` | `ItemPool(n)` |
| collapse | `ICollapseRule` | `MaxScoreCollapse` |
| reranker | `IReranker` (existing) | none; `SapAiCoreReranker`; `DecisionReranker` + `TOOL_QUESTION`; `LlmReranker` |
| query decomposition | `IQueryDecomposer` (optional, §4.5) | **none** — the consumer's own |
| final cut | `IItemCut` | `TopItemsCut`, `FixedItemsCut(k)`, `ScoreFloorCut(...)`, `TokenBudgetCut(...)` |
| size estimate (inside a token cut) | `IItemSizeEstimator` | `ToolDefinitionSizeEstimator` (default), `CharsPerTokenEstimator(n)` |

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

#### 7.3.1 Provider records — fine-grained sets (`FacetedToolIndexer`)

`FacetedToolIndexer([new SummaryFacet(), new ParametersFacet()])`:

| Kind | Id | Text | Written when |
|---|---|---|---|
| `full` (canonical) | `recordId(global, itemId, 'full', 0)` — `itemId` is the 30.1.0 id | `Tool: <name> — <description>` + `\nParameters: <p1>, <p2>, …` when there are any | always — not a facet, so it cannot be left out |
| `summary` (`SummaryFacet`) | `recordId(global, itemId, 'summary', 0)` | `<name words> — <first clause of description>` | the first clause is non-empty |
| `parameters` (`ParametersFacet`) | `recordId(global, itemId, 'parameters', 0)` | `<name words> — ` + per parameter, in schema order, `; `-joined: `<parameter words>` + ` (<first clause of its description>)` when it has one + `: <value words>, …` when it has string values | the tool has ≥ 1 parameter |
| `name-tail` (`NameTailFacet`, **opt-in only**) | `recordId(global, itemId, 'name-tail', 0)` | `<name words after the first word>` | the name has ≥ 2 words |

- Metadata on every record: `name` (exposed), `itemId`, `recordKind`, `profile`, owner `global`
  (tool catalogs are global; no identity keys, as today). The canonical `full` record also carries
  `definitionChars` (§4.10). Non-canonical records carry `itemText` = the `full` text.
- **Deterministic derivation** (`deriveToolFacets` helpers, pure, unit-tested on a table):
  - **name words:** split `originalName` on camelCase, acronym, `_`, `-`, `.` and digit
    boundaries; lowercase. `read_file` → `read file`; `listPullRequests` → `list pull requests`;
    (mcp-abap-adt example) `GetATCFindings` → `get atc findings`. No word is assumed to be a verb
    or an object.
  - **value words:** the same split applied to an enum value: `BEHAVIOR_DEFINITION` →
    `behavior definition`.
  - **first clause:** description up to the first `.`, `;`, `:` or newline; a leading bracketed
    tag (`[...]`) removed (example: mcp-abap-adt's `[read-only]`); at most 200 characters.
  - No lexicon, no synonyms, no LLM: every word comes from the provider. A rule that would produce
    nothing produces no record — never a made-up word.
- **Why `parameters` replaces the measured `object` record in the default:** it carries the same
  kind of signal — what the tool acts on — from the **schema** (e.g. a `path` or `class_name`
  parameter) instead of from a naming convention. **Not measured yet**; the faceted variants' rows
  in §7.4 say so and cite the closest measured layouts.
- **`NameTailFacet` — convention-dependent, documented as such.** It assumes verb-first names
  (`GetClass`, `create_issue`): the tail is then the object. On object-first names (`class_get`)
  it yields the operation; on single-word names, nothing. It reproduces the measured `object`
  record exactly, so a consumer on a verb-first server may add it (§7.5). It is in no variant.
- The goal's rule holds: nothing is written over provider text. A weak description is fixed at its
  source.

#### 7.3.2 Per-value records — a generic strategy in no default (`EnumValueToolIndexer`)

**Status: a strategy the consumer may inject; in no default composition.** Measured **worse** on
the one coarse example (mcp-abap-adt `compact`, §2.5.1):

| Layout | Stage 1 only, k=3 / k=5 / budget 2k | With Jev |
|---|---|---|
| one record per tool (C0) | 0.896 / 0.955 / 0.896 | English 0.970 (k=3); non-English 1.000 |
| C0 + one `value` record per enum value (C1) | 0.776 / 0.896 / 0.761 | English equal to C0; non-English **0.857** |

- **Why it stays:** the hypothesis below is generic and may hold for another server's coarse set
  (more tools, no reranker, values with descriptions). A consumer that wants it injects it and
  measures it on its own set (§14.3).
- **Why no default uses it:** on the only measured set it lowered recall with and without a
  reranker.

**The hypothesis it serves.** A coarse tool takes the object in a parameter (§2.5). Its one record
must stand for every object at once, so a query about one object might not match it well.

**Strategy.** `EnumValueToolIndexer(inner, { discriminator, maxValues })` decorates a provider
indexer (usually `FacetedToolIndexer([])`, i.e. `full` only) and adds **one `value` record per
string value** of the tool's discriminating parameter:

| Kind | Id | Text |
|---|---|---|
| `value` | `recordId(global, itemId, 'value', n)`, `n` = the value's position in the schema | `<name words> — <first clause of description> — <parameter words>: <value words>` + ` — <value description>` when the schema gives one (`oneOf` / `anyOf` entry with `const` + `description` / `title`) |

- Example (mcp-abap-adt `compact`, `HandlerCreate`, `object_type: CLASS`):
  `handler create — Create operation — object type: class`.
- Metadata: as §7.3.1, plus `parameter` and `value` (the raw enum value); `itemText` = the `full`
  text. Not `generated`: every word is the provider's.
- **Records collapse back to the tool:** every `value` record carries the tool's `itemId`, so
  `MaxScoreCollapse` returns the tool once, scored by its best-matching value; hydration returns
  the canonical `full` record (§4.6). Nothing new in retrieval.
- **`maxRecordsPerItem` = inner's + `maxValues`.** `maxValues` is a required constructor option (the
  library picks no number). A tool with more values → `failedItems`, reason `too-many-records`;
  values are **never** silently dropped. The consumer sets it ≥ its largest enum.
- A tool where the selector picks nothing gets no `value` records — it is indexed by `inner` alone.
  So the strategy is safe on a mixed set.

**Which parameter — server-agnostic selection.**

| Selector | Picks | When |
|---|---|---|
| `RequiredEnumDiscriminator` (default) | the **one** top-level property that is `required` **and** has ≥ 2 string values | no property qualifies → none. **Several** qualify → none, reported as `IndexReport.notes` (`ambiguous-discriminator`, with the candidates) — never a guess |
| `NamedDiscriminator(parameter)` | the property with that name, if it has ≥ 2 string values | the consumer knows its server (e.g. `NamedDiscriminator('object_type')` for mcp-abap-adt `compact`) |

- **Why "required + enum":** an optional enum is usually a modifier (a format, a version), not
  what the tool acts on. A required one must be chosen on every call, so it splits the tool's uses.
  It is read from the schema, with no naming convention.
- **Why refuse on ambiguity:** goal 3 — the library never picks by guessing. The consumer
  resolves it with `NamedDiscriminator` or its own selector.
- **Why an injected selector, not a parameter-name option:** a consumer may need a rule (e.g. by
  `x-` schema annotation, or per tool); the selector covers the name case and the rule case.
- For mcp-abap-adt `compact`, a consumer that still injects this strategy can name the parameter
  with `NamedDiscriminator('object_type')` rather than rely on it being a required enum in every
  tool.

**`IndexReport.notes`** (additive, optional): `readonly { itemId; note; detail? }[]` — things that
were not failures but changed what was written (here: an ambiguous discriminator). Never silent.

#### 7.3.3 Intent records

Generated text; an indexing strategy any variant except `baseline` can add. They help only the
candidate search (§2.1) and never reach the reranker (§4.6).

| Placement | Strategy | Record |
|---|---|---|
| **in the tool collection** (default placement) | `IntentRecordIndexer(inner, source)` — decorates the provider indexer | ONE record per tool: kind `intent`, id `recordId(global, itemId, 'intent', 0)`, text = the tool's intents, one per line; `generated: true`; `itemText` = the `full` text |
| **companion collection** | `IntentCompanionIndexer(source)` under `companions.intents` (a `variants` source) | the same ONE record per tool, `generated: true`, **no** `itemText` (§4.6) |

- **Generated text never mixes into provider records**: its own record kind, and for the companion
  its own store.
- **One record per tool in both placements** — the layout measured (own record 0.954 at k=5, equal
  to intents inside `full`). Switching placement moves records, it does not reshape them (D3,
  decided).
- **Sources:** `StaticIntentSource(map)` — intents generated at deploy (e.g. a consumer's intents
  file), keyed by `originalName`; `LlmIntentSource(llm, { prompt? })` — English, domain-neutral
  prompt (no server or domain words), overridable.
- **Fill once, refresh on change.** The intent record stores `generatedFrom` = a hash of the tool's
  provider text. At index time the source is asked only when the record is missing or the hash
  differs. (An in-memory store is rebuilt every boot; prefer `StaticIntentSource` there.)
- **Off / rebuild:** drop the strategy (record placement: re-index, §7.8; companion: unbind it —
  the provider records are untouched). Rebuild = clear the companion (or the `intent` records) and
  re-index.

### 7.4 Default compositions (`mcpToolsVariants`)

**What they are:** ready-made compositions that fill in what the consumer did not choose (§7.1).
Each is a factory that takes only what cannot be shipped (a reranker's model or credential; the
pool size of a whole-set rerank) and returns a `ComposedToolsProfile` — or, for `baseline`,
nothing to bind. None relies on one server's conventions (§7.0). Every tuned number in a row cites
its measurement.

| Variant | Tool-set shape | Composition | Measured (required-recall, hybrid in-store scoring, mcp-abap-adt examples) |
|---|---|---|---|
| **`baseline`** — no choice made | any | 30.1.0 single record per tool + `EmbeddingRetrieval` (top-k records = tools). Selected by binding **no** profile. | Fine-grained read-only set: EN-ext 0.943 at k=5 (8.3 tools); 0.977 at k=15 (~25 tools). Multi-step 0.714, non-English 0.692 (k=5). |
| **`faceted`** | fine-grained | `FacetedToolIndexer([SummaryFacet, ParametersFacet])` + `ItemPool(15)` + `MaxScoreCollapse` + no reranker + `FixedItemsCut(8)` | **Schema-derived layout not yet measured.** Closest measured layouts, both 0.966 at k=5 (hub spike `spike-facets`): LLM-generated `operation` / `object` facets, and name-derived facets (`full` + `operation`=`summary` + `object`=`NameTailFacet`); the latter 0.977 at k=8 with ~13 tools. Pool 15 and cut 8 are that layout's (without a reranker `ItemPool(15)` = 30, §7.5). |
| **`faceted-cohere`** | fine-grained | faceted indexing + `ItemPool(30)` + `MaxScoreCollapse` + `SapAiCoreReranker` + `FixedItemsCut(5)` | **Not measured as one composition.** Closest: one record per tool + Cohere, pool 30 items, k=5 (§2.3): EN-ext 0.931 with 8.3 tools; single 0.973, multi 0.714, non-English 0.962. At most 5 tools. |
| **`faceted-jev`** | fine-grained | faceted indexing + `ItemPool(30)` + `MaxScoreCollapse` + `DecisionReranker(model, TOOL_QUESTION)` + `FixedItemsCut(5)` | **To be measured as one composition on fresh consumer queries before promotion** (D11). Closest: one record per tool + Jev, pool 30 items, k=5 (§2.3): EN-ext 0.977 with 8.3 tools; single 1.000, multi 0.857, non-English 1.000. At most 5 tools. |
| **`small-set-jev`** | coarse / small (the whole set fits one rerank) | `FacetedToolIndexer([])` (one `full` record per tool) + `ItemPool(poolItems)` with `poolItems` ≥ the tool count (= rerank-all) + `MaxScoreCollapse` + `DecisionReranker(model, TOOL_QUESTION)` + `FixedItemsCut(3)` | `compact`, writer set (25 tools), §2.5.1: **0.970 at ~1.6k tokens** (whole set ≈ 7.9k); multi-step 1.000, non-English 1.000. k=3 is the measured knee (C0 + Jev: k=2 0.925, k=3 0.970, k=5 0.970). Rerank-all = Jev over a stage-1 pool (0.970 both): stage 1 adds nothing at this size. |

```ts
mcpToolsVariants.faceted();
mcpToolsVariants.facetedCohere({ reranker: new SapAiCoreReranker({ … }) });
mcpToolsVariants.facetedJev({ decisionModel });
mcpToolsVariants.smallSetJev({ decisionModel, poolItems });   // poolItems ≥ the store's tool count
// intents on top of any variant except baseline:
mcpToolsVariants.facetedCohere({ …, intents: { record: staticIntents } });
// the consumer's own decomposer on top of any variant except baseline (none shipped):
mcpToolsVariants.facetedJev({ …, decompose: { decomposer: myDecomposer, queryEmbedder } });
```

- **Why these five:** baseline (no change); faceted (fewer tools for the same recall, no external
  service); one per reranker the goal names (goal 10); `small-set-jev` (the second tool-set shape
  of goal 9, with measured numbers).
- **`faceted*` numbers are a proxy, honestly marked:** the schema-derived `ParametersFacet` is not
  yet measured on the fine-grained set. The rows cite the closest measured layouts; the
  name-derived one used `NameTailFacet`'s record, which no default may use (§7.0). The consumer
  check (§14.3) measures the schema-derived layout; a consumer on a verb-first server may compose
  the measured name-derived layout itself (§7.5).
- **`faceted-cohere`:** V0 + Cohere (one record per tool), not the faceted composition.
- **`faceted-jev` caveat:** faceted + Jev was never run as one composition on an item pool. It ships
  marked **"to be measured as one composition on fresh consumer queries before promotion"** and is
  not recommended over the others until the consumer check (§14.3) runs it (D11, decided).
- **`small-set-jev` — what is tuned and what is not:**
  - **tuned, measured:** `FixedItemsCut(3)` (the table above);
  - **not a tuned number:** `poolItems` is the consumer's tool count (rerank-all means the pool
    holds the whole set). It is a required argument because only the composition root knows the
    count (after `tools/list`). A pool below the count makes it stage-1 + rerank, which is not
    the composition this row names, so the composition root checks `poolItems` ≥ the count at
    startup;
  - **record text:** the measured C0 was one record per tool; the default uses the `full` record
    (§7.3.1). The consumer check confirms the figure on it (§14.3);
  - **when it fits:** the reranker reads every tool on every query, so its cost grows with the
    set. It is the default for **small** sets; a large coarse set is the consumer's own
    composition (e.g. `ItemPool(n)` below the count, or no reranker).
  - Equivalent in 30.1.0 terms: `rag.retrieval.tools: { strategy: rerank-all, reranker: decision,
    maxCandidates: <tool count> }` with the caller's k = 3. The variant fixes k=3 inside the
    profile, so the caller's k (20 in `IToolsRagHandle`) does not undo the measured cut.
- **On a fine-grained set** `small-set-jev` is the wrong default: hundreds of tools in every rerank.
  Use `faceted-jev` or the 30.1.0 `rerank` strategy there.
- One record + Jev on a stage-1 pool (the best measured fine-grained Jev composition) is already
  30.1.0's `rag.retrieval.tools: { strategy: rerank, reranker: decision }`; it is not repeated as a
  variant.
- **Intents with a reranker:** the layouts are within noise of each other (goal *Evidence*), so
  intents are an add-on for stage 1, not part of any default.
- **Not in any default, by measurement:** `EnumValueToolIndexer` (§7.3.2) and `TokenBudgetCut`
  (§4.10). Both remain generic strategies the consumer may inject.

### 7.5 Composing your own

This is the main path (§7.1): the consumer chooses each strategy; a default fills only the rest.

- Any shipped strategy combines with any other; a consumer's own strategy implements the same
  contract (e.g. its own `IToolFacet`, `IDiscriminatorSelector`, `ICandidatePool`,
  `IItemSizeEstimator` or `IReranker`).
- Typed rule: `full` cannot be dropped (it is not a facet).
- Examples:
  - the **measured** name-derived fine-grained layout, for a verb-first server:
    `FacetedToolIndexer([new SummaryFacet(), new NameTailFacet()])` — convention-dependent, the
    consumer's choice;
  - a prompt-size guard on top of a count: `TokenBudgetCut({ budgetTokens, maxItems: 5 })` in
    place of `FixedItemsCut(5)` — the count stays the main cut, the budget only caps it (§4.10);
  - `small-set-jev` with Cohere instead of Jev: the same composition with `SapAiCoreReranker`
    (not measured on `compact`; the consumer measures it, §14.3);
  - per-value records for a coarse set where the consumer expects them to help:
    `EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator, maxValues })` (measured
    worse on `compact`, §7.3.2).
- Measured guidance for one's own compositions:
  - fine-grained, with any reranker: size the pool in **items** (30 items: non-English 0.962 /
    1.000; 30 records: 0.846–0.885);
  - fine-grained, without a reranker: `ItemPool(15)` gives the same recall as 30;
  - small coarse set (`compact`): a reranker over the whole set beats stage-1 tuning; k is the
    main cut, a token budget only a guard (§2.5.1).

### 7.6 Filling — `vectorizeMcpTools`

- **Without a profile (`baseline`):** the 30.1.0 record code is untouched
  (`Tool: ${name} — ${description}`, id from `IToolRecordKey`, metadata `{ name }`). A golden test
  pins id, text and metadata byte for byte on the committed snapshot.
- **With a profile:** `vectorizeMcpTools` builds `ToolItem`s (exposed name, provenance's original
  name, record key, description, `parameters` read from the tool's `inputSchema`, and
  `definitionChars` of the exported definition) and calls `bound.index(items)`. It reads the
  schema generically (top-level `properties`, `required`, string `enum` / `const`); no server is
  special-cased.
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
  change goal 8 excludes. Decided — D4 (§17).

### 7.8 Store migration

- A store is filled by one composition.
- Turning a variant on adds records next to the 30.1.0 ones (profile ids are owner-scoped, §3.1,
  so they never overwrite the 30.1.0 records); turning it off leaves profile records behind that
  the 30.1.0 path would rank as records.
- So switching variants (or the intent placement) on a persistent store = a fresh collection
  (redeploy), like an embedder change. Every record carries `profile` in metadata for diagnosis.
- In-memory tool stores (rebuilt every boot) need nothing.

### 7.9 A profile for any other MCP server — built by the consumer (goal 9)

The shipped strategies cover the two common shapes (§2.5) with no server's conventions. Where none
fits a server, the consumer **builds its own profile from the contracts** and uses it in the
pipeline. The contracts are enough for that; nothing in the library has to change.

**What a consumer may replace, piece by piece:**

| To change | Implement | Example reason |
|---|---|---|
| a record view | `IToolFacet` | the server puts the object in a URI template, a tag or an `x-` schema annotation |
| which parameter splits a coarse tool | `IDiscriminatorSelector` | the split is by two parameters, or per tool |
| the whole record layout | `IItemIndexer<ToolItem>` | records from a server-side catalog document |
| candidate depth, collapse, cut, size | `ICandidatePool`, `ICollapseRule`, `IItemCut`, `IItemSizeEstimator` | the model's own tokenizer for the budget |
| the whole profile | `ICollectionProfile<ToolItem>` | its own retrieval, still an `IRetrievalStrategy` |

**Example — a server whose tools name the target in an `x-resource` schema annotation**
(hypothetical server; the convention is the consumer's knowledge, so it lives in the consumer's
code):

```ts
import type { IToolFacet, ToolItem } from '@mcp-abap-adt/llm-agent';
import {
  ComposedToolsProfile, FacetedToolIndexer, SummaryFacet,
  ItemPool, MaxScoreCollapse, TokenBudgetCut,
} from '@mcp-abap-adt/llm-agent-libs';

/** The consumer's facet: reads its server's annotation from the schema it kept. */
class ResourceFacet implements IToolFacet {
  readonly kind = 'resource';
  derive(tool: ToolItem): string | undefined {
    const r = tool.inputSchema['x-resource'];               // this server's convention
    return typeof r === 'string' ? `${tool.originalName} — ${r}` : undefined;  // nothing → no record
  }
}

const myServerTools = new ComposedToolsProfile({
  indexer: new FacetedToolIndexer([new SummaryFacet(), new ResourceFacet()]),
  pool: new ItemPool(20),                                  // the consumer's numbers, its measurement
  collapse: new MaxScoreCollapse(),
  cut: new TokenBudgetCut({ budgetTokens: myPromptBudget, maxItems: 5 }),  // count 5, budget as a guard
});

builder.withToolsProfile(myServerTools);                   // or register a name for YAML (§6.2)
```

- `ToolItem.inputSchema` carries the schema as exported, so a consumer's strategy reaches whatever
  its server puts there. The library's own strategies never read `x-` annotations.
- The consumer's profile is checked by the same conformance kit (§14.2) and measured with the same
  harness (§14.3) as the shipped ones.

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
- **Visibility model** (user / group / global, groups consumer-supplied): decided — D5 (§17).

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
| span `retrieval` (child of the request trace, via injected `ITracer`) | tracer: yes | attrs `store`, `strategy`, `sources`, `candidates.records`, `items.collapsed`, `items.returned`, `decomposer`, `subqueries`, `rerank.outcome` (`none\|ok\|fallback\|error`), `rerank.error` (message), `orphans`, `hydration.reads` (canonical records read by `getById`, §4.6), `cut.name`, `cut.tokens` / `cut.budgetTokens` (size-bounded cuts, §4.10) |
| `IRetrievalMetrics.retrievalOutcome` counter | new small interface on the same metrics backend | attrs `store`, `strategy`, `outcome` ∈ `ok`, `rerank_fallback`, `rerank_error`, `decompose_error`, `orphan`, `over_budget` (§4.10), `empty` |
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
  today. The `any` cast is removed. Decided — D8 (§17) (touches three provider
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
| `StagedRetrieval`, `ItemPool`, cuts (incl. `TokenBudgetCut`), size estimators, `MaxScoreCollapse`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `SharedItemsProfile` | `@mcp-abap-adt/llm-agent-libs`, `src/collections/` (small modules) | the retrieval built-ins, rerankers and the builder that uses them already live here; `llm-agent-rag` is the backend/embedder factory layer **below** libs and has no rerankers or LLM steps |
| `SapAiCoreReranker` | **new** `@mcp-abap-adt/sap-aicore-reranker` | §5.3 |
| YAML resolver + validation, `makeCrossEncoder` seam type | `@mcp-abap-adt/llm-agent-server-libs` | beside `resolve-retrieval.ts` and `makeDecisionModel` |
| `createMakeCrossEncoder` (builds `SapAiCoreReranker`, resolves `credentialRef`) | `@mcp-abap-adt/llm-agent-server` (the app's composition root) | beside `make-decision-model.ts` |
| `IRetrievalEmbedderOwner` implementations | `llm-agent` (`VectorRag`), `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | where the stores are |

- Decided — D1 (libs, not a new `llm-agent-collections` package) and D2 (own reranker
  package) (§17).
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
- So #323 stays a pipeline fix (emit `expand`) in its own PR. Decided — D9 (§17).

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
- **Tool-set shapes:** `small-set-jev`, `EnumValueToolIndexer` and `TokenBudgetCut` are opt-in
  like every profile and strategy; nothing about the default changes.
- **Profile records are addressed by owner-scoped ids** (§3.1): `rag.getById(itemId)` on a profiled
  store finds nothing; use `bound.get(ref)`. Documented in `docs/INTEGRATION.md`.
- Docs updated in the same PR: `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`,
  `docs/PERFORMANCE.md`, `docs/EXAMPLES.md` (YAML, both reranker configurations),
  `docs/TROUBLESHOOTING.md` (rerank error metric; switching profiles needs a fresh collection),
  `CLAUDE.md` key API notes, the new package's `README.md`.

---

## 14. Tests

### 14.1 Unit (`npm test`)

- `deriveToolFacets`: table over **several naming styles**, none privileged — generic:
  `read_file`, `listPullRequests`, `search-issues`, `db.query`, `v2Fetch`, single-word `fetch`;
  labelled mcp-abap-adt examples: `GetWhereUsed`, `GetATCFindings`, `RuntimeListFeeds`; empty /
  tag-only description; value words (`BEHAVIOR_DEFINITION`).
- `ParametersFacet`: no parameters → no record; descriptions reduced to their first clause; enum
  and `oneOf` / `anyOf` `const` values listed; schema order kept.
- `NameTailFacet`: verb-first, object-first and single-word names (documents the convention it
  depends on); not part of any variant's composition.
- `EnumValueToolIndexer`: one `value` record per string value; ids `recordId(global, itemId,
  'value', n)`; all collapse to one item; value descriptions from `oneOf` / `anyOf`; more values
  than `maxValues` → `too-many-records`, nothing silently dropped; no qualifying parameter → `inner`
  records only. Fixtures: a synthetic coarse server (generic) and an mcp-abap-adt `compact`-shaped
  tool (labelled example).
- Discriminators: `RequiredEnumDiscriminator` — none / exactly one / several qualifying
  (several → none + `IndexReport.notes` `ambiguous-discriminator`); optional enums ignored;
  `NamedDiscriminator` — present, absent, fewer than 2 values.
- `TokenBudgetCut`: rank-order prefix; stops at the first item that does not fit (no skip-ahead);
  `maxItems ?? requestedK` ceiling; `limit()` = that ceiling; top item over budget → empty,
  `over_budget` counted; items never truncated; `ToolDefinitionSizeEstimator` uses
  `definitionChars`, falls back to text length.
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
  nothing; intents and a decomposer refused on `baseline`; **no variant contains `NameTailFacet`**;
  `small-set-jev` = `FacetedToolIndexer([])` + `ItemPool(poolItems)` + `MaxScoreCollapse` +
  `DecisionReranker` + `FixedItemsCut(3)`, and refuses a missing `poolItems` / `decisionModel`
  (type-level); **no variant contains `EnumValueToolIndexer` or `TokenBudgetCut`**.
- Generic strategies carry no tuned number: the counts and sizes of `ItemPool`, `FixedItemsCut`,
  `ScoreFloorCut`, `TokenBudgetCut` (`budgetTokens`) and `EnumValueToolIndexer` (`maxValues`) are
  required constructor arguments (type-level); an optional one (`TokenBudgetCut.maxItems`) falls
  back to the caller's k, never to a library number. Tuned numbers appear only in
  `mcpToolsVariants` (§7.1).
- Consumer-built profile: the §7.9 example compiles against the public exports only and passes the
  conformance kit.
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
no record outside the caller's identity filter returned; generated records never canonical;
**with a size-bounded cut, the summed size of the returned items ≤ the budget** (by the cut's own
estimator) and no item is truncated. A consumer runs it against its own profile.

### 14.3 Measurement harness

- `scripts/rag-eval` gains `--variant baseline|faceted|faceted-cohere|faceted-jev|small-set-jev`, or a
  composition by strategy name (`--indexer`, `--facets`, `--discriminator`, `--intents
  off|record|companion`, `--pool-items`, `--reranker none|cross-encoder|decision`, `--cut`,
  `--budget-tokens`), any tools snapshot file (not tied to one server), and
  **prompt size** (summed definition tokens of the returned tools) next to the item count, and
  **required-recall** (AND of OR-groups; an optional `required` field in the queries file),
  average items returned and MRR — the hub's metrics.
- The core is exported as `evaluateRetrieval({ store, strategy, cases, ks })` from
  `@mcp-abap-adt/llm-agent-libs/testing`, so a consumer runs its own catalog and labels against a
  build of this branch (the PR's "consumer check" stage). A consumer measures its own
  `IQueryDecomposer` the same way, as part of its strategy (§2.4).
- Acceptance (env-gated, not part of `npm test`):
  - on the committed mcp-abap-adt 16.0.0 snapshot (an example server's fine-grained set),
    `faceted` with the **schema-derived** `ParametersFacet` (not yet measured, §2.0) is not worse
    than `baseline` at equal items — its §7.4 row is replaced by that run, and compared with the
    two closest measured layouts (LLM-generated facets and name-derived facets, both 0.966 at k=5);
  - on a `compact` snapshot, `small-set-jev` (with the `full` record) reproduces, within ±1 row,
    the measured 0.970 at k=3 and ~1.6k tokens (§2.5.1);
  - the hub's consumer check reproduces, within ±1 row, `baseline`'s numbers in §7.4;
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
   The consumer makes the main behaviour choices by choosing strategies; a default composition
   fills only what it left open, and is the only place a tuned number lives, next to its
   measurement (§7.1).
6. **File size:** new logic in `src/collections/*` and the new package; `builder.ts` and
   `smart-server.ts` get one call site each per binding.
7. **Additive:** the only removal is an unexported, unwired file.
8. **Any MCP server (goal 9):** shipped strategies read only what every server exports; the one
   convention-dependent facet is opt-in and in no variant; a consumer builds a profile for any
   other server from the contracts (§7.9), with the raw `inputSchema` available to its strategies.

---

## 17. Decisions

### 17.1 Settled by the goal

No longer asked:

- experience as a schema in the framework → shared items (§8);
- intents' home → an indexing strategy of the tools profiles, default placement `record` (§7.3.3);
- one profile with flags → strategies the consumer injects, plus default compositions (§7);
- the reranker text → provider text (§4.6); the pool unit → items (§4.4);
- the Cohere reranker in this PR (§5);
- query splitting → an injected `IQueryDecomposer` slot, no shipped implementation, `k` stays the
  overall limit (§4.5; goal decision 2026-10-05 — the former D12, "k per clause run", is withdrawn);
- profiles for different MCP servers (goal 9, goal decision 2026-10-05): shipped strategies read
  only what any server exports; coarse tool sets and a token-budget cut are in scope; a consumer
  builds its own profile for any other server from the contracts (§7.0, §7.9);
- where tuning lives and who chooses (goal decisions 2026-10-05): the consumer makes the main
  behaviour choices by choosing the strategies it injects; components are generic; tuned numbers
  live only in default compositions, each citing its measurement (§7.1).

### 17.2 Decided by the user

Adversarial review (user-approved 2026-10-05):

| # | Decision | Reason |
|---|---|---|
| D13 | **Replacing an item is not atomic; no generations, commit markers, incarnations or locks.** Concurrent writers of one item are serialized by the writer or the store; interrupted replacements may leave stale records (§3.3). | The store owns concurrency (standing rule); collections are filled once, read-mostly. Readers stay safe through D15, not through write coordination. |
| D14 | **Physical record ids are owner-scoped:** `recordId(owner, itemId, kind, n)`, one function for `index`, `get`, `remove`, hydration and collapse (§3.1). | Every backend keys records by id alone (`InMemoryRag.upsert`, `VectorRag`, pg/HANA primary key, Qdrant UUID of the id); with `id = itemId`, two users' `case-42` would overwrite each other. |
| D15 | **Every returned item is hydrated from its canonical record**, owner-checked; `itemText` is a reranking shortcut only; a hit without a canonical record is dropped and counted (§4.6). | Makes D13 safe for readers and returns the item whole (incl. `data`) even when only a secondary record matched. |

Recommendations approved by the user on 2026-10-05:

| # | Decision | Where |
|---|---|---|
| D1 | Default implementations live in **`llm-agent-libs`** (`src/collections/`), not a new `llm-agent-collections` package. | §11 |
| D2 | `SapAiCoreReranker` in its **own package** `@mcp-abap-adt/sap-aicore-reranker`. | §5.3 |
| D3 | Companion intents: **one record per tool**, as in `record` placement. | §7.3.3 |
| D4 | Builder skills **coexist** in the tools store (pass-through). | §7.7 |
| D5 | Shared-item visibility: `user` / `group` / `global` as **partitions**; group stores supplied by the consumer (`ISharedItemGroups`). | §8.3 |
| D6 | Shared items: **library API only** in this PR, no server YAML. | §6.2 |
| D7 | Ship `keepStage1Top`, **default 0, counted inside k**, documented as unmeasured without the former split. | §4.7 |
| D8 | Replace the private embedder read with **`IRetrievalEmbedderOwner`** (3 provider packages) in this PR. | §10.1 |
| D9 | Query preparation stays **outside** profiles; #323 is a pipeline fix. | §12 |
| D10 | `SapAiCoreReranker` takes **`deploymentId`** in this PR; resolving by model name is a follow-up. | §5.3 |
| D11 | Ship `faceted-jev`, marked **"to be measured as one composition on fresh consumer queries before promotion"**. | §7.4 |
| `limit()` | `IItemCut.limit(requestedK)` — the most items a cut returns; the retrieval's budget for a decomposer. Stated as an **upper bound** in items, so `ScoreFloorCut` and `TokenBudgetCut` fit with no signature change (§4.10). | §3.4, §4.5 |

### 17.3 Raised by the server-agnostic amendment

The `compact` measurement (§2.5.1) settles four of them; three stay open for the user.

**Settled by the `compact` measurement** (the user reviews them with the spec):

| # | Question | Resolution | Why |
|---|---|---|---|
| D17 | `TokenBudgetCut` when the top item alone exceeds the budget: empty, or keep the first item? | **Empty + counted** (`over_budget`), as recommended (§4.10). | `TokenBudgetCut` is in no default: it is a guard the consumer injects and sizes (≥ its largest tool). A guard that breaks its own bound is no guard; the conformance kit checks the bound. |
| D19 | `TokenBudgetCut`: stop at the first item that does not fit, or skip ahead to smaller ones? | **Stop**, as recommended; documented as the reason it is not a main cut (§4.10). | Measured: as the main cut a 2k budget gives 0.910 vs 0.970 for k=3 at the same ~1.6k tokens, because it stops early. As a guard it must not reorder the consumer's ranking. Skip-ahead = the consumer's own `IItemCut`. |
| D20 | `coarse` ships with no numbers until the `compact` measurement lands? | **Superseded.** The `coarse` variant (per-value records + token budget) is **withdrawn**; the coarse default is `small-set-jev` with measured numbers: one record per tool + rerank-all + `FixedItemsCut(3)` (§7.4). | Per-value records measured worse (§7.3.2); the token budget measured worse than k (§4.10); one record + Jev over the whole set: 0.970 at ~1.6k tokens. The only required argument left, `poolItems`, is the consumer's tool count, not a tuned number. |
| D21 | Return which enum values matched with a coarse tool (`metadata.matchedValues`)? | **No** — not in this PR. | No default writes per-value records any more, so no default has values to report. A consumer that injects `EnumValueToolIndexer` and wants the hint justifies a new output contract with its own measurement. |

**Still open:**

| # | Question | Recommendation |
|---|---|---|
| D16 | The `faceted*` defaults use schema-derived records (`summary` + `parameters`); `ParametersFacet` is **not yet measured** on the fine-grained set. Accept shipping them on the closest measured layouts' figures (LLM-generated `operation` / `object` facets and name-derived facets, both 0.966 at k=5 hybrid, hub spike `spike-facets`) until the consumer check runs? | **Yes** — the name-derived `object` record depends on one server's naming; a default may not. The measured layout stays one line away for a verb-first server (`NameTailFacet`, §7.5). If the check shows `parameters` worse, the fix is a better schema-derived facet, not the convention. Not settled by `compact`: that set has no fine-grained facets. |
| D18 | `RequiredEnumDiscriminator` with several qualifying parameters: no fan-out + `IndexReport.notes`, or fan out over all of them? | **No fan-out + note** — goal 3, never guess; `NamedDiscriminator` or the consumer's selector resolves it. Lower stakes now: it only serves `EnumValueToolIndexer`, which is in no default. |
| D22 | `ToolItem` carries the raw `inputSchema` (for consumer strategies) and `parameters` replaces `parameterNames`. | **Yes** — without the raw schema a consumer cannot build a profile for a server whose signal sits elsewhere in the schema (goal 9); `ToolItem` is new in this spec, so nothing breaks. |

**New, raised by `small-set-jev`:**

| # | Question | Recommendation |
|---|---|---|
| D23 | `small-set-jev` takes `poolItems` (≥ the tool count) as a required argument and the composition root checks it at startup. Alternative: a new `ICandidatePool` that always takes the whole store (no number at all). | **Required `poolItems` + startup check** — no new strategy class, same shape as 30.1.0's `RerankAllRetrieval.maxCandidates` ("configured, never derived"). A whole-store pool can be added later if consumers ask. |
