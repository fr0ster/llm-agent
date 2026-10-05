# Collection profiles — design spec

> **Serves:** the goal document `docs/superpowers/goals/2026-10-04-collection-profiles.md`
> (user-owned, binding). Where this spec and the goal differ, the goal wins and this
> spec is wrong.
>
> **Base:** release 30.1.0 (`2cc2ba33`). Builds on #321's per-store retrieval
> (`IRetrievalStrategy`, `StrategyRag`, the rerank strategies; its spec §13 is in git
> history at `74922e28^:docs/superpowers/specs/2026-10-02-decision-model-design.md`).
>
> **Status:** draft for the user's review. Every decision is taken:
> - D1–D11 and `IItemCut.limit()`: approved by the user on 2026-10-05 (§17.2);
> - D17, D19, D20, D21: settled by the `compact` measurement (§17.3);
> - D16, D18, D22, D23: decided by the user on 2026-10-05 (§17.3);
> - S1–S9 (raised by the plan): decided by the user on 2026-10-05 (§17.4);
> - probability vs relevance decisions, packages by role, one `decision:` section, the reranker
>   package, the caller's k capping every cut, kept cleanup failures: decided by the user on
>   2026-10-05 (§17.6). Choices made while writing them in are listed for review (§17.5);
> - relevance scores comparable for the same query and model (batching by default), the second
>   seam `makeRelevanceDecision`, the seam rename `makeDecisionModel` → `makeProbabilityDecision`:
>   decided by the user on 2026-10-05 (§17.7);
> - a tools store filled once at instance creation, the fill source as an injected strategy, the
>   offline corpus API, refill and single-flight construction out: decided by the user on
>   2026-10-05 (§17.11).
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
>
> **Amended 2026-10-05 (3)** — *replaced by (4).* It had made Cohere one more `IDecisionModel`
> behind the existing `DecisionReranker`. The plan's spec issues S1–S9 written in then still hold
> (§17.4).
>
> **Amended 2026-10-05 (4)** for the goal's decisions on probability and relevance decisions, and
> the user's decisions of the same day (§17.6):
> - **two decision contracts:** `IProbabilityDecision` (today's `IDecisionModel`, renamed; Jev) and
>   the new `IRelevanceDecision` (one relevance score per passage; a cross-encoder such as Cohere —
>   **not** a probability) (§3.9, §5);
> - **two rerankers:** `ProbabilityReranker` (today's `DecisionReranker`, renamed) and the new
>   `RelevanceReranker`; every reranker moves to the new vendor-neutral package
>   **`@mcp-abap-adt/llm-agent-reranker`** (§5.4, §11);
> - **packages by role:** `typesafe-decision` (unchanged, `IProbabilityDecision`) and the new
>   `sap-aicore-decision` (`SapAiCoreRelevanceDecision`, `IRelevanceDecision`);
>   `SapAiCoreDecisionModel` is withdrawn;
> - **one `decision:` section:** the provider decides the kind; `reranker: decision` builds the
>   matching reranker (§6.2);
> - old names stay as **deprecated aliases** until the next major (§13);
> - **the caller's k caps every cut** (§3.4, §4.5, §4.9) and **cleanup failures are kept for retry**
>   (§3.3) — two approved review findings.
>
> **Amended 2026-10-05 (5)** for the user's decisions of the same day (§17.7):
> - **relevance scores are comparable for the same query and model** — a cross-encoder scores each
>   (query, passage) pair independently (§3.9); so `RelevanceReranker` **batches by default**, like
>   `ProbabilityReranker` (§5.2);
> - the second optional seam **`makeRelevanceDecision` is approved** (§3.8, §6.2);
> - the released probability seam is **renamed symmetric to its contract:**
>   `BuildAgentDeps.makeDecisionModel` → **`makeProbabilityDecision`** (the old name a deprecated
>   alias; both supplied → startup error naming both); the app's `createMakeDecisionModel` →
>   **`createMakeProbabilityDecision`** (§3.8, §6.2, §13).
>
> **Amended 2026-10-05 (6)** — a design fix approved by the user from the plan review: a bound
> tools profile is filled through `bound.index` even when `bound.rag` has no `writer()`; the
> "no writer → skip" guard of `vectorizeMcpTools` is the 30.1.0 path's only (§7.6).
>
> **Amended 2026-10-05 (7)** — two review findings fixed by their principle (§17.9):
> - **the binding travels with the store** (D34): every tools vectorization — startup, a reconnect's
>   `toolsChanged`, `fillToolsBinding` — reads it with `toolsBindingOf`; `vectorizeMcpTools` has no
>   `binding` option any more;
> - **whoever creates a bound store fills it** (D35): a worker's own store is filled when the worker is
>   built (`buildSubAgent`), so startup, lazy rebuilds, `PUT /v1/config` and hot reload all fill it.
>
> **Amended 2026-10-05 (8)** for the user's decisions of the same day (§17.10) — *partly superseded
> by (9): the fill memo (D36) is withdrawn and single-flight construction (D37) moved out of this
> PR; D38–D40 stand:*
> - **only a complete fill is memoized** (D36): a fill that resolves incomplete or rejects is
>   evicted, so the next build or re-wire of that worker retries it — no timers, no retry loops;
> - **worker construction is single-flight** (D37): one in-flight primary construction per worker
>   name and config generation; a construction started before a drain never publishes into the
>   new generation. This fixes a **pre-existing 30.1.0 race in our own process** (duplicate worker
>   instances, leaked resources) — it is **not** a RAG concurrency protocol: concurrent writes to
>   a persistent store stay the backend's responsibility (§3.3);
> - **workers on the shared clients are filled at startup on every path** (D38), on
>   `yamlBuilderConnect` too — one pass right after the harvest; startup filling concerns only the
>   `tools` store (§6.6);
> - the hot-reload test drives the server's reload entry point directly (D39, §14.1);
> - **tools a server removes at runtime stay in the store**, as in 30.1.0; removal is out of scope
>   (D40, §6.3, §15).
>
> **Amended 2026-10-05 (9)** for the goal's decision of the same day (*a tools store is filled once,
> when its instance is created*) and the user's decisions D41–D45 (§17.11):
> - **filled once, at instance creation; never refilled while running** (D41). No refill API, no
>   fill memo, no retry: an incomplete fill is reported (`complete: false`, `/health` `degraded`
>   for the main store, the logged summary line for a worker) and stays. A per-session re-wire of a
>   worker never fills; only the construction that creates the store does;
> - **where the records come from is a strategy the consumer injects** (D42): `IToolsFillSource`
>   (§3.10), attached to the store with its binding. Four ship: `live` (the default — the MCP tool
>   list indexed through the profile, 30.1.0's behaviour), `corpus` (a corpus built at build time by
>   the same profile's indexer, loaded at instance creation with no embedding call), `prebuilt` (a
>   persistent store filled by the consumer's build/deploy step — the process binds it for
>   retrieval and never writes) and `consumer` (the library does not fill);
> - **an offline corpus API** (D43, §6.5): `buildToolsCorpus` (build step: provider tool definitions
>   → records + vectors with the profile's indexer and an embedder), `parseToolsCorpus`, and
>   `deployToolsCorpus` (deploy step: a built corpus written into any store through its writer,
>   with precomputed vectors, in place, idempotent, with a service record carrying the fingerprint
>   and the corpus hash). Recommended: in-memory store → `corpus`; persistent store → `prebuilt`;
> - *(superseded by (10), D46)* **`toolsChanged` by source** (D44): `live` and `consumer` re-index
>   what is listed through the profile, as 30.1.0 does; `corpus` and `prebuilt` write nothing (a
>   store built ahead is not refilled while running; the next build / deploy brings the new list);
> - **single-flight worker construction and the drain ordering move out** (D45): a pre-existing
>   30.1.0 race unrelated to profiles, a separate issue (§15).
>
> **Amended 2026-10-05 (10)** for the goal's updated decision of the same day and the user's
> decisions D46–D47 (§17.12):
> - **no reaction to `toolsChanged` for a bound store** (D46): until its collections are filled the
>   pipeline and its MCP do not work, so the tool list cannot change under a working pipeline. A
>   reconnect that reports `toolsChanged` writes **nothing** into a store that carries a binding,
>   whatever its fill source (one debug line under the `mcp` debug area, no warning). The only
>   case is an MCP server plugged in at runtime; a consumer who builds such a pipeline does its own
>   checks and filling in it (§15). **Without a profile, 30.1.0 behaviour is unchanged** (the
>   legacy re-vectorize stays);
> - **`IToolsFillSource` is `fill` only** — one method, called once at the store's creation; its
>   `toolsChanged` member is removed (§3.10). `ConsumerToolsFill`: the library never writes;
> - **approved as proposed** (D47): the fingerprint is the consumer-named `ToolsCorpusIdentity
>   { profile, embedder }` plus the library's own checks; a worker construction whose fill throws
>   drops that cache entry; a worker with its own `rag` and its own clients is refused when its
>   fill source is `corpus` or `prebuilt`.
>
> Every path that creates or refreshes a tools store is audited in §6.4. Earlier open choices are
> settled by the recommendations applied in §17.9; the user may still overrule them.

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
  locks in the library: concurrent writes to one store — from one process or several — are the
  store backend's responsibility (Qdrant, HANA, pg-vector, …); the library promises no order
  between concurrent replacements of one item.
- **A failed cleanup is never reported as indexed (§3.3).** Every stale-record delete is checked;
  ids not yet deleted stay listed on the canonical record, and the next `index` or `remove`
  retries them. Failure handling, not a concurrency protocol.
- **`k` is the overall limit of a retrieval, as in 30.1.0:** at most k items come back. Every cut
  is capped by the caller's k: the limit is `min(requestedK, the cut's own limit)`, with or without
  decomposition. `FixedItemsCut(n)` is a ceiling, not an override.
- **Query decomposition is an injected strategy slot (§4.5).** `StagedRetrieval` calls the
  consumer's `IQueryDecomposer` (query + budget k → sub-queries whose budgets sum to ≤ k). None
  injected → the query runs as is. No shipped variant uses it; no implementation ships.
- A profile is **bound** to each store of its kind (`profile.bind(...)`), so one profile serves
  several stores (e.g. reader and writer tool stores).
- **A tools store is filled once, when its instance is created** — never refilled while running
  (D41). No refill API, no fill memo, no retry: an incomplete fill is reported (`complete: false`,
  `/health` `degraded`, the logged summary line) and stays. **A reconnect's `toolsChanged` writes
  nothing into a bound store** (D46): until it is filled the pipeline and its MCP do not work, so
  its tool list cannot change under a working pipeline; an MCP server plugged in at runtime is the
  consumer's pipeline's concern (§15). Without a profile, 30.1.0's re-vectorize is unchanged.
- **Where the records come from is a strategy the consumer injects** — `IToolsFillSource` (§3.10),
  attached to the store with its binding (D42):
  1. **`live`** (default) — the MCP tool list, indexed through the profile at creation (30.1.0);
  2. **`corpus`** (`ToolsCorpusLoader`, for in-memory stores) — a corpus built **at build time** by
     the same profile's indexer (records + vectors); at instance creation one small class checks
     its fingerprint, writes the records with their precomputed vectors (**no embedding call**) and
     reports the status — nothing else; an incompatible corpus fails loudly at creation;
  3. **`prebuilt`** — a persistent store filled by the consumer's build/deploy step; the process
     binds it for retrieval only, checks the fingerprint at creation and **never writes**;
  4. **`consumer`** — the library never writes; the consumer fills through `bound.index` /
     `fillToolsBinding`.
  - Recommended: in-memory store → `corpus`; persistent store (Qdrant, HANA, pg-vector) →
    `prebuilt`. Both work for any store; the consumer chooses.
- **Offline corpus API (§6.5):** `buildToolsCorpus` (build step) → `parseToolsCorpus` →
  `deployToolsCorpus` (deploy step: in place, one current state, idempotent, a service record with
  the fingerprint and the corpus hash). Collections that change while running (session, history,
  user collections, shared items) are not filled by these strategies (§6.6).
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
     - `faceted-cohere` = faceted + `RelevanceReranker` over Cohere on SAP AI Core
       (`SapAiCoreRelevanceDecision`, an `IRelevanceDecision`);
     - `faceted-jev` = faceted + `ProbabilityReranker` over TypeSafe Jev (`TypeSafeDecisionModel`,
       an `IProbabilityDecision`);
     - `small-set-jev` = one record per tool + `ProbabilityReranker` (Jev) over the **whole** set
       (rerank-all) + at most **3 tools** — for **coarse / small** tool sets. Measured on mcp-abap-adt `compact`: 0.970
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
- **Rerankers are alternatives** (goal 10). **A decision and a reranker are different things, and a
  probability and a relevance are different decisions** (goal decision 2026-10-05):

  | Decision contract (`llm-agent`) | What it answers | Provider (package) | Reranker (`llm-agent-reranker`) |
  |---|---|---|---|
  | **`IProbabilityDecision`** (today's `IDecisionModel`, renamed) | typed yes/no, choice and score questions, with probabilities | TypeSafe Jev — `TypeSafeDecisionModel` (`typesafe-decision`, unchanged) | **`ProbabilityReranker`** (today's `DecisionReranker`, renamed) |
  | **`IRelevanceDecision`** (new) | one relevance score per passage for a query — **not** a probability; comparable for the same query and model | Cohere Rerank on SAP AI Core — `SapAiCoreRelevanceDecision` (new `sap-aicore-decision`) | **`RelevanceReranker`** (new) |

  - Every reranker lives in the new vendor-neutral package **`@mcp-abap-adt/llm-agent-reranker`**;
    the retrieval strategies stay in libs and use rerankers only through `IReranker`.
  - Old names stay exported as **deprecated aliases** until the next major (§13).
  - YAML keeps **one** `decision:` section: `provider: typesafe` → probability, `provider:
    sap-aicore` → relevance; `reranker: decision` builds the matching reranker (§6.2).
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
| **Probability decision** | A model's answer to a typed question, as a probability (yes/no, choice, score) — `IProbabilityDecision` | TypeSafe Jev: P(this tool helps) = 0.93 |
| **Relevance decision** | A model's relevance score for each passage against one query — `IRelevanceDecision`. **Not a probability**: comparable among passages scored against the same query by the same model — also across calls (a cross-encoder scores each (query, passage) pair independently); never across queries, across models or with a probability | Cohere Rerank on SAP AI Core: `relevance_score` per document |
| **Reranker** | An `IReranker`: reorders candidates. It **adapts** a decision; it is not one | `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker` |

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
| `IReranker` | `rerank(query, results, options)` | unchanged; `ProbabilityReranker` and `RelevanceReranker` implement it |
| `IDecisionModel` | `decide({ state, questions })` → typed answers | **renamed `IProbabilityDecision`** (same members); the old name stays a deprecated alias (§3.9, §13) |
| `DecisionReranker`, `DecisionRerankerOptions` | reranker over `IDecisionModel` | **renamed `ProbabilityReranker`, `ProbabilityRerankerOptions`**, moved to `@mcp-abap-adt/llm-agent-reranker`; old names re-exported from libs as deprecated aliases (§5.4, §13) |
| `DECISION_RERANK_DEFAULT_TASK`, `DECISION_RERANK_DEFAULT_CRITERIA` | the probability reranker's default wording | **renamed `PROBABILITY_RERANK_DEFAULT_TASK`, `PROBABILITY_RERANK_DEFAULT_CRITERIA`**, moved with it; old names are deprecated aliases |
| `wrapDecisionModel` | usage-logging adapter of a decision model | **renamed `wrapProbabilityDecision`**, stays in libs (§5.4); the old name is a deprecated alias |
| `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` | rerankers / wording presets in libs | **moved** to `@mcp-abap-adt/llm-agent-reranker`, names unchanged; libs re-exports them (deprecated path) |
| `DecisionRequest`, `DecisionResult`, `DecisionQuestion`, the answer types, `DecisionEntry`, `DecisionError`, `DecisionErrorCode` | the decision vocabulary | **unchanged**: still `IProbabilityDecision`'s request and answers; `DecisionError` and its codes serve both decisions (§3.9) |
| `TypeSafeDecisionModel`, `SmartServerDecisionConfig` | Jev provider; `decision:` type | unchanged names |
| `BuildAgentDeps.makeDecisionModel` | probability seam | **renamed `BuildAgentDeps.makeProbabilityDecision`** (typed `IProbabilityDecision` — the same type); `makeDecisionModel` stays a deprecated alias until the next major; both supplied → startup error naming both (§3.8, §13) |
| `createMakeDecisionModel` (app, `make-decision-model.ts`) | the app's probability seam | **renamed `createMakeProbabilityDecision`** in `make-probability-decision.ts` — internal to the app (not exported from `@mcp-abap-adt/llm-agent-server`), so no alias |
| — | new | `IRelevanceDecision`, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore`, `RelevanceReranker`, `RelevanceRerankerOptions`, `wrapRelevanceDecision`, `BuildAgentDeps.makeProbabilityDecision`, `BuildAgentDeps.makeRelevanceDecision`, package `@mcp-abap-adt/llm-agent-reranker`; in `sap-aicore-decision`: `SapAiCoreRelevanceDecision`, `SapAiCoreRelevanceConfig`, `FetchLike`; reserved record keys `staleRecordIds`, `staleCompanionRecordIds` |
| — | new | `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IIndexNoteSource`, `IndexNote`, `isIndexNoteSource`, `IndexedRecord`, `RecordDraft`, `recordId`, `RecordOwner`, `ItemRef`, `ICandidatePool`, `ICollapseRule`, `IItemCut`, `ISizeBoundedCut`, `isSizeBoundedCut`, `IQueryDecomposer`, `SubQuery`, `ISourceSelector`, `RetrievalSource`, `IRetrievalMetrics`, `ToolItem`, `ToolParameter`, `ToolParameterValue`, `IToolFacet`, `IToolIntentSource`, `IDiscriminatorSelector`, `IItemSizeEstimator`, `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `StagedRetrieval`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `CharsPerTokenEstimator`, `ToolDefinitionSizeEstimator`, `SharedItemsProfile`; reserved record key `companionRecordIds` |
| — | new (fill sources, §3.10, §6.5) | `IToolsFillSource`, `ToolsFillContext`, `LiveToolsFill`, `ToolsCorpusLoader`, `PrebuiltToolsStore`, `ConsumerToolsFill`, `buildToolsCorpus`, `parseToolsCorpus`, `deployToolsCorpus`, `ToolsCorpus`, `ToolsCorpusRecord`, `ToolsCorpusManifest`, `ToolsCorpusIdentity`, `ToolsCorpusDeployReport`, `TOOLS_CORPUS_RECORD_ID`, `SmartServerConfig.toolsFillFactories`; reserved record key `serviceRecord` |

Every new name above was checked with `git grep -w` over `packages/`: 0 hits (2026-10-05; the
fill-source names of the last row re-checked the same way on the same day).

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
`IReranker`, `IRetrievalStrategy`, `IMetrics` are not changed. The decision contracts (§3.9) live in
`interfaces/decision-model.ts`: one rename with a deprecated alias, one new contract.

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

/** Keys the framework writes; a profile's or writer's extras can never set them.
 *  `companionRecordIds` (canonical only): `{ <companion name>: string[] }` — the item's records in
 *  each companion store, so `remove` and replacement reach them too (§3.3, S7).
 *  `staleRecordIds` / `staleCompanionRecordIds` (canonical only): old record ids a replacement must
 *  still delete — in this store / per companion; kept until a delete succeeds (§3.3). */
export type ReservedRecordKey =
  | 'id' | 'itemId' | 'recordKind' | 'itemText' | 'profile' | 'generated' | 'recordIds'
  | 'companionRecordIds' | 'staleRecordIds' | 'staleCompanionRecordIds'
  | 'visibility' | 'userId' | 'groupId' | 'sessionId' | 'ttl'
  | 'serviceRecord';   // a store's service record (§6.5): never an item, dropped by retrieval (§4.3)

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
  /** Not failures, but they changed what was written (e.g. `ambiguous-discriminator`, §7.3.2).
   *  Absent when there are none. */
  readonly notes?: readonly ({ readonly itemId: string } & IndexNote)[];
}

/** Something an indexing strategy declined to guess, about one item. */
export interface IndexNote {
  readonly note: string;           // e.g. 'ambiguous-discriminator'
  readonly detail?: string;        // e.g. the candidate parameter names
}

/**
 * Optional capability (pattern 4, S1): a strategy that has notes about an item. The binding asks
 * every indexer that has it (primary and companions) after `toRecords` and copies the notes into
 * `IndexReport.notes` with the item's id. A decorating indexer forwards to what it wraps.
 */
export interface IIndexNoteSource<TItem> {
  /** Pure: the same item always gets the same notes. Empty → nothing to report. */
  notesFor(item: TItem): readonly IndexNote[];
}
export function isIndexNoteSource<TItem>(x: unknown): x is IIndexNoteSource<TItem>;
```

- **Why a capability, not a wider `toRecords` result:** only the indexers that can decline to guess
  have notes; every other indexer stays as it is (ISP). The binding detects it with the guard.

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
   *  not among them (`recordIds`, and `companionRecordIds` per companion, on the canonical).
   *  Several writes — NOT atomic (below). */
  index(items: readonly TItem[], options?: CallOptions): Promise<Result<IndexReport, RagError>>;
  /** Delete the records the item's canonical record lists — in the primary store and in every
   *  companion store the binding has — then the canonical record. */
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
- **Why `companionRecordIds` too (S7):** companion records (e.g. intents in their own store, §7.3.3)
  live in another store, so `recordIds` cannot reach them. The canonical lists them per companion
  name; `remove` and replacement delete them from that companion store. A listed companion the
  binding no longer has (the consumer unbound it) is left as is: dropping a companion means
  clearing its store (§7.3.3).
- **Why `staleRecordIds` / `staleCompanionRecordIds` (approved review finding):** a stale-record
  delete can fail. Without a list, the id is forgotten and the record outlives the item. With it,
  the next `index` or `remove` of the item retries the delete (below).

**Replacing an item is not atomic — and the framework does not try to make it so.**

- `index` of an existing item = several per-record writes: new companion records, then new
  non-canonical records, then the canonical record (with the new `recordIds` and
  `companionRecordIds`), then deletes of the old ids it no longer lists (in each store). A
  store's bulk write (`upsertManyPrecomputedRaw`) is all-or-nothing per batch, but the deletes are
  separate calls; nothing spans them.

**Cleanup failures are kept, never reported as success** (approved review finding — failure
handling, not a concurrency protocol: no generations, no locks, D13 stands).

| Step | What |
|---|---|
| 1. stale set | per store: (old `recordIds` ∪ old `staleRecordIds`) − the new ids; per bound companion: (old `companionRecordIds[c]` ∪ old `staleCompanionRecordIds[c]`) − the new ids |
| 2. write ahead | the new canonical record carries the stale sets in `staleRecordIds` / `staleCompanionRecordIds` (absent when empty) |
| 3. delete | every stale id, each `deleteByIdRaw` **`Result` checked** (primary and companion); `ok` (deleted, or already absent → `false`) counts as done; `ok: false` or a throw keeps the id |
| 4. settle | if the stale lists changed, the canonical is rewritten with exactly the ids still pending (keys absent when none) |
| 5. report | any id still pending → the item is **not** indexed: `failedItems` reason `cleanup-failed: <n> stale record(s) kept for retry`; `indexedItems` excludes it |

- **Retry:** the next `index` of the item folds the pending ids into its stale set (step 1);
  `remove` deletes listed **and** pending ids. A retry of an already-deleted id is a no-op
  (`deleteByIdRaw` → `ok: true, false`).
- **`remove` with a failed delete:** it tries every listed and pending id, keeps the canonical
  record (so a retry still finds the list) and returns a `RagError` naming how many deletes failed.
  The item stays whole and readable until a retry succeeds.
- **Step 4 fails** (the settling rewrite): the written-ahead lists stay — a superset of what is
  pending; retries of the deleted ones are no-ops. The item's report follows step 5.
- **A companion the binding no longer has:** its ids are not carried (S7 rule: dropping a
  companion means clearing its store).
- **Tested:** replacement → a failed stale delete → not indexed, id listed → retry `index` → the
  record is gone, list cleared; then `remove` leaves nothing in any store (§14.1).
- **Concurrent writers of the same item** — in one process or in several (replicas sharing a
  persistent store) — are the store backend's responsibility, not the library's. Two concurrent
  `index` calls for one item may interleave; the library adds no lock and gives **no** item-level
  last-write-wins guarantee, within a process or across processes.
- **An interrupted replacement can leave stale records** — non-canonical records the current
  canonical record does not list. `remove` deletes only what the canonical lists, so such records
  can outlive the item.
- **Why no generations, commit markers or locks:** the store owns concurrency (the project's
  standing rule): concurrent writes to a persistent store (Qdrant, HANA, pg-vector) are the
  backend's responsibility. Collections are filled once and read-mostly. A generation protocol
  would add writer coordination the library must not own. (Decision D13.)
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
  /** An UPPER BOUND, in items, on what `cut` returns for `requestedK` — never above `requestedK`
   *  (the caller's k caps every cut: `min(requestedK, the cut's own limit)`). The retrieval's
   *  budget (§4.5). Not a promise to return that many: a cut may stop earlier (score floor, token
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

/**
 * Optional capability (pattern 4, S6): a cut bounded by a size budget. `StagedRetrieval` detects it
 * with the guard and reports `cut.tokens` / `cut.budgetTokens` and `outcome=over_budget` (§4.10,
 * §9.1). A count cut does not carry it (ISP).
 */
export interface ISizeBoundedCut {
  readonly budgetTokens: number;
  /** The estimator the cut sizes items with — the same one the telemetry sums. */
  readonly estimator: IItemSizeEstimator;
}
export function isSizeBoundedCut(cut: IItemCut): cut is IItemCut & ISizeBoundedCut;

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

/** Composes the provider text of a tool — the canonical `full` record's text, which is also the
 *  reranker's item text (§4.6) and every non-canonical record's `itemText`. Provider words only. */
export interface IToolTextComposer {
  readonly name: string;
  /** Non-empty; pure: the same tool always gets the same text. */
  compose(tool: ToolItem): string;
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
| `IToolTextComposer` | review finding 4 (schema text in the provider record), measured within noise (§7.3.1): how much of the schema the provider text carries is a choice the consumer may inject, not a rule fixed inside `FacetedToolIndexer`. The default composition is unchanged (C0, measured) | libs (`FacetedToolIndexer` and the three shipped composers), server-libs (YAML name → instance), consumers |
| `IDiscriminatorSelector` | goal 9, coarse tool sets: which parameter's values become records is a choice the consumer may inject, not a rule fixed inside the indexer (§7.3.2). Serves `EnumValueToolIndexer`, a generic strategy in no default | libs (`EnumValueToolIndexer`), server-libs (YAML), consumers |
| `IItemSizeEstimator` | goal 9, token-budget cut (a prompt-size guard in no default): how an item's size is counted is injected, so a consumer can bring its model's tokenizer (§4.10) | libs (`TokenBudgetCut`), consumers |
| `ISizeBoundedCut` + `isSizeBoundedCut` (S6) | "never silent" for a size guard: `over_budget` and `cut.tokens` / `cut.budgetTokens` (§4.10, §9.1) need the cut's budget and estimator, which `IItemCut` does not carry. An optional capability, so count cuts stay as they are | libs (`TokenBudgetCut` implements it, `StagedRetrieval` reads it), consumers' own size cuts |
| `IIndexNoteSource` + `isIndexNoteSource`, `IndexNote` (S1) | goal 3 + "never silent": an indexing strategy that declines to guess (an ambiguous discriminator, §7.3.2) needs a channel into `IndexReport.notes`; `toRecords` returns only drafts. An optional capability, so other indexers stay as they are | libs (`RequiredEnumDiscriminator`, `EnumValueToolIndexer`, `IntentRecordIndexer` forward; bindings collect), consumers' own indexers |
| `ReservedRecordKey` gains `companionRecordIds` (S7) | `remove` and replacement must reach an item's records in companion stores (§3.3); a reserved key so no extra can overwrite it. `ReservedRecordKey` is new in this spec, so nothing breaks | libs (record writer, tools binding) |
| `IItemCut.limit()` — doc only: an **upper bound** in items | already the meaning ("the most items `cut` returns"); stated explicitly so a cut that stops earlier (score floor, token budget) is honest under the same signature. No signature change | — |
| `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `SharedItemsStores` | goal 7: what writing elements get; owner + visibility | libs (profile) + consumers (writing elements, group partitions) |
| `IndexReport.notes?` | goal 9 + "never silent": an indexer that declines to guess (ambiguous discriminator) must say so without failing the item | libs (indexers), consumers reading the report |
| `IRetrievalMetrics` | reranker errors must reach metrics and `/health` (goal *Evidence*) without growing `IMetrics` (principle 4) | metrics implementations live in libs; consumers plug their own backends |
| `IRetrievalEmbedderOwner` | replaces the `(toolsRag as any).embedder` read — a cast that erased a type and is the cause of F1 | implemented by `VectorRag` (llm-agent) and the qdrant / pg-vector / hana provider packages |
| `HealthComponentStatus.toolCatalog.records?`, `.profile?`, `MetricsSnapshot.retrievalOutcome?` | additive optional fields for §9 | where the health types already live |
| `IDecisionModel` → **`IProbabilityDecision`** (rename; `IDecisionModel` stays a deprecated alias of the same type) | goal decision 2026-10-05: a probability and a relevance are different decisions, named by what the decision is based on. Same members, so every implementation (`TypeSafeDecisionModel`, a consumer's) still compiles | `@mcp-abap-adt/llm-agent` (`decision-model.ts`), where it lives |
| **`IRelevanceDecision`**, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore` (§3.9) | goal decision 2026-10-05: a cross-encoder scores passages against a query and gives no probability, so it cannot honestly implement `IProbabilityDecision` (whose `NoulAnswer.probability` must be P(yes) in [0, 1]). Each type is the minimum: a request (query + passages), a result (one score per passage + the model id), one score entry (index + score) | `@mcp-abap-adt/llm-agent`: implemented by a provider package (`sap-aicore-decision`), consumed by `llm-agent-reranker` and server-libs |
| `DecisionError` / `DecisionErrorCode` reused by `IRelevanceDecision` — **no new code** | every failure of a relevance call already has a code (`DECISION_INVALID_REQUEST`, `_AUTH`, `_RATE_LIMITED`, `_UNAVAILABLE`, `_ABORTED`, `_ERROR`); `DECISION_UNSUPPORTED_QUESTION` is simply never returned (a relevance request has no questions). Nothing widens the shared set | — |
| `BuildAgentDeps.makeRelevanceDecision?` (new optional seam) | the provider decides the kind of decision (§6.2), and a relevance provider returns `IRelevanceDecision`, which the probability seam (typed `IProbabilityDecision`) cannot return. A second optional seam keeps both typed and leaves every existing probability seam compiling; a union return type would break code that calls the seam. Approved by the user (D29, §17.7) | `@mcp-abap-adt/llm-agent-server-libs` (`smart-server.ts`, `resolve-retrieval.ts`), beside `makeProbabilityDecision` |
| `BuildAgentDeps.makeDecisionModel?` → **`makeProbabilityDecision?`** (rename; `makeDecisionModel` stays a `@deprecated` alias of the same type until the next major) | the user's decision 2026-10-05 (D30, §17.7): the seam is named symmetric to its contract (`IProbabilityDecision`) and to `makeRelevanceDecision`. Same signature, so a consumer's function moves by renaming the key. **Both supplied → startup error naming both** — never silently pick one (two functions for one seam is a consumer bug: which one was meant is unknowable). The seam-missing message names `makeProbabilityDecision` | `@mcp-abap-adt/llm-agent-server-libs` (`smart-server.ts` — `BuildAgentDeps`, and the constructor's `probabilityDecisionSeam` check beside `assertConstructionSeams`) |
| `SmartServerDecisionConfig`: `provider` gains `'sap-aicore'`; optional `deploymentId`, `resourceGroup` | goal 10 + the goal decision 2026-10-05 (one `decision:` section; the provider decides the kind): Cohere needs a provider name and its deployment (§6.2). Kept one interface with optional fields — additive, so a consumer's own probability seam still compiles (§17.5) | `@mcp-abap-adt/llm-agent-server-libs` (`decision-config.ts`), where the section's type already lives |
| `ReservedRecordKey` gains `staleRecordIds`, `staleCompanionRecordIds` | approved review finding 3: a failed stale-record delete must be retried by the next `index` / `remove`, so its id is kept on the canonical; reserved so no extra can overwrite it. `ReservedRecordKey` is new in this spec | libs (record writer, tools binding) |
| `IItemCut.limit()` — doc only: never above `requestedK` | approved review finding 1: the caller's k caps every cut (§4.5, §4.9). No signature change | — |
| `fillToolsBinding(clients, binding, opts)` — new export of `llm-agent-libs` (D31, amended by D42) | the server fills a bound tools store at its creation (§6.3) and lives in another package; `vectorizeMcpTools` is internal to libs and also carries the 30.1.0 record path. A thin wrapper that requires a binding: it runs the **fill source** the store carries (§3.10) at instance creation — for `live`, the listing and `bound.index` of `vectorizeMcpTools`' profile path, reused, nothing duplicated. It refuses a binding its store does not carry (D34): such a store would carry no fill source either, and a later reconnect's `toolsChanged` would take it for unbound and write 30.1.0 records into it | `llm-agent-libs` (`src/mcp/fill-tools-binding.ts`), beside `vectorizeMcpTools`; used by server-libs and builder consumers |
| `HealthCheckerDeps.toolCatalog?: IToolCatalogReporter` (D31) | `/health` must reflect the server's own fill (§6.3); the builder's status holder is private to `build()`, so the server cannot publish into it. An optional reporter the checker reads instead of the agent's; absent → 30.1.0 | `llm-agent-libs` (`health/health-checker.ts`), where `HealthCheckerDeps` lives |
| Worker builders receive the shared clients **with** their descriptors and the server's `IToolNamespace` (D32, §6.3) — **no contract change** | a worker's store must hold the names its agent dispatches by; the existing `withMcpServers` (+ `IMcpServer.descriptor`) already carries descriptors to the pipeline, and `withToolNamespace` already exists. An optional `descriptors` parameter on `withMcpClients` was the alternative — a public builder change this does not need | `llm-agent-server-libs` (`smart-server.ts` `buildSubAgent`, `workers/worker-registry.ts`), internal |
| Companion storage per primary binding (D33, §7.3.3) — **no contract change** | two catalogs must not share companion records; separate stores isolate writes AND reads, a binding segment in `recordId` would isolate writes only. `recordId`, `CollectionStore`, `ReservedRecordKey` unchanged. Server-libs' new (unreleased) `ResolvedToolsProfile` carries the companion store **sections** (`companionStores`) instead of built stores | `llm-agent-server-libs` (`resolve-collection-profiles.ts`, `smart-server.ts`) |
| **`IToolsFillSource`**, **`ToolsFillContext`** (D42, §3.10) | the goal decision 2026-10-05: *where the records come from is a strategy the consumer injects*. One source per bound store answers the one moment a bound tools store is written — its creation (`fill`); a reconnect never writes a bound store (D46) — so `prebuilt` can promise that the process never writes, and `corpus` that creation makes no embedding call. The context hands a source the binding, the stores it was made over (a corpus is written into the companions too, which `IBoundCollection` does not expose) and the live path as a function (`indexLiveTools`), so a source never needs MCP clients, namespaces or record keys. The minimum: one name, one method, a four-field context. No existing contract changes | `@mcp-abap-adt/llm-agent` (`interfaces/tools-fill-source.ts`): implemented in libs (the four shipped sources) and by consumers; resolved by name in server-libs; called by libs (`vectorizeMcpTools`) |
| `bindToolsProfile(profile, target, source?)` — third parameter (libs, new in this spec) | the fill source travels with the store like its binding (D34, D42): whatever fills the store — the builder, `fillToolsBinding` — reads both from the store, never from an option; a reconnect reads the binding only to leave the store unwritten (D46). Absent → `LiveToolsFill` (30.1.0's behaviour) | `llm-agent-libs` (`collections/tools-binding.ts`) |
| `ReservedRecordKey` gains `serviceRecord` (D43) | `deployToolsCorpus` keeps one service record in the store (fingerprint, corpus hash, record hashes, §6.5); `StagedRetrieval` drops a hit that carries the key (§4.3), so the record is never an item; reserved so no extra can set it on an item record. `ReservedRecordKey` is new in this spec | libs (record writer clears it; `StagedRetrieval` drops it; `deployToolsCorpus` writes it) |
| `buildToolsCorpus`, `parseToolsCorpus`, `deployToolsCorpus`, `ToolsCorpus*` types, `TOOLS_CORPUS_RECORD_ID`, `ToolsCorpusLoader`, `PrebuiltToolsStore`, `LiveToolsFill`, `ConsumerToolsFill` (D42, D43) — new exports of `llm-agent-libs` | the offline side of the fill sources: the profile's indexer must be usable outside the runtime to produce the corpus, and a deploy step must write it into a persistent store without embedding. Types used only where the functions are (libs + the consumer's scripts) — not contracts, so not in `@mcp-abap-adt/llm-agent` | `llm-agent-libs` (`collections/tools/`) |
| `SmartServerConfig.toolsFillFactories?` (D42) | YAML `rag.profiles.tools.fill` names a source (§6.2); a consumer's own source is registered by name, like `toolsVariantFactories` | `llm-agent-server-libs` (`smart-server.ts` config type, `resolve-collection-profiles.ts`) |
| `ToolCatalogStatus.records?`, `.profile?` (S3) | `/health` copies `toolCatalog` from the status `IToolCatalogReporter` returns (`vectorizeMcpTools`' summary), so the two fields must be carried there first (§7.6, §9.1). Additive, optional | `interfaces/tool-catalog.ts`, where `ToolCatalogStatus` lives |

### 3.9 Decision contracts — probability and relevance

File `packages/llm-agent/src/interfaces/decision-model.ts` (the existing file, its style and its
`Result` / `DecisionError` conventions).

```ts
/**
 * A model that answers typed questions about a state with probabilities, not text
 * (today's `IDecisionModel`, renamed — same members, same rules).
 */
export interface IProbabilityDecision {
  readonly model?: string;
  decide(request: DecisionRequest, options?: CallOptions)
    : Promise<Result<DecisionResult, DecisionError>>;
}

/** @deprecated Use `IProbabilityDecision`. Kept as an alias until the next major. */
export type IDecisionModel = IProbabilityDecision;

export interface RelevanceRequest {
  /** The query every passage is judged against. Non-empty. */
  query: string;
  /** Non-empty; each a non-empty string. `RelevanceScore.index` points into this array. */
  passages: readonly string[];
}

export interface RelevanceScore {
  /** Index into `RelevanceRequest.passages`. */
  index: number;
  /** Finite. NOT a probability: higher = more relevant. Comparable for the same query and
   *  model — also across calls; never across queries or models. */
  score: number;
}

export interface RelevanceResult {
  /** Exactly one entry per passage, each index once; any order. */
  scores: readonly RelevanceScore[];
  /** The model that actually answered. */
  model: string;
  usage?: { inputTokens: number; outputTokens?: number };
}

/**
 * A model that scores how relevant each passage is to a query (a cross-encoder).
 *
 * - Returns `Result`; never throws for provider failures. Errors are `DecisionError`, with the
 *   existing codes; `DECISION_UNSUPPORTED_QUESTION` is never returned.
 * - The score is not a probability. It depends on the (query, passage) pair alone — a
 *   cross-encoder scores each pair independently — so scores for the SAME query from the SAME
 *   model are comparable, also across calls (a reranker may batch and merge). Never compare
 *   across queries, across models, or with a probability. A threshold on it is the consumer's
 *   calibration.
 * - Cancellation through `options.signal` yields `DECISION_ABORTED`.
 */
export interface IRelevanceDecision {
  readonly model?: string;
  score(request: RelevanceRequest, options?: CallOptions)
    : Promise<Result<RelevanceResult, DecisionError>>;
}
```

| Type | Why it exists | Why this shape |
|---|---|---|
| `IRelevanceDecision` | the decision a cross-encoder makes (goal decision 2026-10-05) | one method, like `IProbabilityDecision`; a different method name (`score`, not `decide`) so one class can never satisfy both by accident |
| `RelevanceRequest` | the input a cross-encoder takes | a query and passages — no questions, task or criteria: a cross-encoder reads no wording |
| `RelevanceScore` | one answer | `index` + `score`, the shape every rerank API returns (Cohere: `results[{index, relevance_score}]`), so a provider maps it without reordering; the reranker checks it (§5.2) |
| `RelevanceResult` | the answer of one call | scores + `model`, as `DecisionResult`; `usage` optional — `outputTokens` optional because a rerank call produces none |

- **Not a probability, by contract.** That is why it is a separate contract: a
  `NoulAnswer.probability` is P(yes) in [0, 1] and consumers may rely on it unchecked; a relevance
  score may not be read that way.
- **Comparable for the same query and model** (decided by the user, D28, §17.7): a cross-encoder
  scores each (query, passage) pair independently, so a score does not depend on which other
  passages share the call. This is what lets `RelevanceReranker` batch by default and merge the
  batches' scores into one order (§5.2). An implementation whose scores depend on the other
  passages of a call (e.g. a listwise model that normalizes within a call) does **not** satisfy
  `IRelevanceDecision`.

These are the llm-agent family's own contracts, used only inside this monorepo and by its
consumers, so they belong in `@mcp-abap-adt/llm-agent` (the YAML config type stays in
server-libs, where the server's config types live), not in the cross-family
`@mcp-abap-adt/interfaces-*` packages.

### 3.10 Where a tools store's records come from — `IToolsFillSource` (D41, D42)

**TL;DR.** A tools store is filled **once, when its instance is created**, and never refilled while
it runs (goal decision 2026-10-05). *Where the records come from* is a strategy the consumer
injects. The source travels with the store, attached with its binding. It has one method, `fill`:
a reconnect's `toolsChanged` writes nothing into a bound store, whatever its source (D46).

```ts
/** Where a bound tools store's records come from. Attached with the binding
 *  (`bindToolsProfile(profile, target, source)`); read from the store by whatever fills it. */
export interface IToolsFillSource {
  /** 'live' | 'corpus' | 'prebuilt' | 'consumer' | a consumer's own — named in the fill's log line. */
  readonly name: string;
  /** Once, when the store's instance is created. `undefined` = nothing attempted (status unknown).
   *  Throws on an incompatible corpus or store — never a silent empty store. */
  fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
}

export interface ToolsFillContext {
  readonly binding: IBoundCollection<ToolItem>;
  /** The stores the binding was made over (primary + companions). A corpus is written into these. */
  readonly target: CollectionStore;
  /** The live path: list the MCP clients' tools (namespaced and keyed exactly as tool selection reads
   *  them), index them through `binding.index`, return the catalog status (§7.6). */
  indexLiveTools(options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
  readonly logger?: ILogger;
}
```

**The four shipped sources** (`llm-agent-libs`):

| Source | `fill` — at instance creation | Embedding calls in the process | Writes by the process |
|---|---|---|---|
| **`LiveToolsFill`** (`live`, the default) | `ctx.indexLiveTools()` — 30.1.0's listing, indexed through the profile | yes | at creation only |
| **`ToolsCorpusLoader({ corpus, expect })`** (`corpus`, the in-memory source) | its only job: checks the corpus's fingerprint against `expect` and the binding (below), writes every record with its precomputed vector into `ctx.target` (primary + companions), reports the status. Nothing else: no service record, no diff, no refill, no memo, no retry, no watching | **none** | at creation only |
| **`PrebuiltToolsStore({ expect })`** (`prebuilt`) | reads the store's service record (§6.5) and checks it as `corpus` does; writes nothing; the status comes from the record | none | **never** |
| **`ConsumerToolsFill`** (`consumer`) | nothing (`undefined`): the consumer fills through `bound.index` or `fillToolsBinding` | — | **never** (the consumer writes) |

A reconnect that reports `toolsChanged` calls no source: a bound store is not written after its
creation (D46, below).

- **Compatibility is checked at instance creation and fails loudly** (`corpus`, `prebuilt`): a
  throw names what differs. Checked:
  - `identity.profile` and `identity.embedder` against `expect` (`ToolsCorpusIdentity`, §6.5) —
    the consumer's own names for the profile composition and the document embedder, the same
    strings at build time and at instance creation;
  - the binding's `profileName`, and the companion store names against `ctx.target.companions`;
  - the corpus format, and one vector dimension for every record (`parseToolsCorpus`).
- **Why the fingerprint is the consumer's string.** No contract carries a fingerprint of an injected
  strategy (a consumer's own indexer, an LLM intent source) or of an embedder (`IEmbedder` has no
  identity), and the library cannot derive one without calling them. The consumer chose both, so
  it names them; the library records and compares the names and checks what it can see itself.
- **An incomplete live fill stays** (D41): `complete: false`, `/health` `degraded` for the main
  store, the summary line logged for a worker. Nothing retries it — a reconnect's `toolsChanged`
  included (D46); a new instance (a restart, a worker rebuilt after a drain) fills again because it
  is a new store.
- **Why no source answers `toolsChanged`** (D46, the user's decision): until a bound store is
  filled, the pipeline and its MCP do not work, so the tool list cannot change under a working
  pipeline. The only case is an MCP server plugged in at runtime; a consumer who builds such a
  pipeline does its own checks and filling in that pipeline (through `bound.index` or its own
  source on a new store). So `McpToolRegistry.revectorizeTools` finds the binding on the store
  (`toolsBindingOf`, through decorators) and writes nothing — one debug line under the `mcp` debug
  area, no warning — for every source alike. An unbound store keeps 30.1.0's re-vectorize.
- **Recommended mapping** (both work for any store; the consumer chooses):
  - an **in-memory** store is empty at every start → `corpus` (or `live`);
  - a **persistent** store (Qdrant, HANA vector, pg-vector) is shared by every instance → `prebuilt`
    with the consumer's deploy step (§6.5); writing a shared persistent collection from every
    instance at startup is redundant.

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
    keepStage1Top?: number;             // §4.7, default 0; counted inside k; never with ScoreFloorCut
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
  → cut (IItemCut) over hydrated items, once: at most min(k, cut.limit(k)) items
    (with a decomposer this runs per sub-query and the results are merged, §4.5)
```

- **Owner invariant:** collapse only ever sees what the stores returned under each source's
  identity filter, so it is always *after* the owner filter. The only extra read, `getById` of the
  canonical record, is checked with `matchesRagIdentity` against the same filter; a record that
  fails it is dropped as an orphan.
- **A store's service record is never an item.** A hit whose metadata carries `serviceRecord` (the
  record `deployToolsCorpus` keeps, §6.5) is dropped before collapse — not passed through, not
  counted as an orphan, not reranked.
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
| budget | `budget = min(requestedK, cut.limit(requestedK))` — the caller's k caps every cut (`TopItemsCut` → k; `FixedItemsCut(n)` → min(k, n); `ScoreFloorCut` → min(k, `maxItems`); `TokenBudgetCut` → min(k, `maxItems ?? k`), §4.10). `StagedRetrieval` applies the `min` itself, so a consumer's cut whose `limit` exceeds k is still capped |
| decompose | `decomposer.decompose(text, budget)` → sub-queries; the strategy owns how the budget is shared |
| check | each `k` an integer ≥ 1, each `text` non-empty, `Σ k ≤ budget`; else a `RagError('…', 'DECOMPOSE_ERROR')` |
| `[]` | the query runs as is with the whole budget (same as no decomposer) |
| run | each sub-query through §4.3 up to hydration, in parallel: embedded with `queryEmbedder`, reranked against its **own** text, its first `k` items kept |
| merge | union in sub-query order, de-duplicated by owner-qualified item (best score kept) |
| cut | the `IItemCut`, **once**, over the union, then the result is truncated to `budget` → **at most `budget` ≤ k items** |

- A decomposer error or a failed check is **returned**, never swallowed: the retrieval fails with
  the error, counted as `outcome=decompose_error` and on the span (§9). No silent fall-back to the
  whole query.
- Since the budget is ≤ k, the sub-query budgets sum to ≤ it, and the final result is truncated to
  it, no contract here lets a retrieval return more than k items — with or without decomposition.

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

**Scores of pinned items — one scale** (review finding, F5, §17.7):

- A pinned item keeps its stage-1 **place** but carries its **reranked score** — the score the
  reranker gave that identity. It never carries its embedding / collapse score: a result never
  mixes the store's scale with the reranker's.
- The returned order stays **pinned first (in stage-1 order), then the rest by reranked score**.
  So a result with pinned items is not sorted by score; the cuts that read only rank order
  (`TopItemsCut`, `FixedItemsCut`, `TokenBudgetCut`) are unaffected.
- **`keepStage1Top` > 0 with `ScoreFloorCut` is rejected** when `StagedRetrieval` is constructed:
  `StagedRetrieval: keepStage1Top cannot be combined with ScoreFloorCut — keepStage1Top is
  unmeasured (D7); a threshold over a pinned head would let an unmeasured order decide what a
  calibrated threshold keeps`. `keepStage1Top` has no YAML key (§6.2), so only code reaches it; the
  constructor is the one check.

**When the reranker failed and `onFailure: 'stage1'` applies** (§9.3):

- The result is the stage-1 result: stage-1 order **and stage-1 scores** (the collapse rule's item
  score over the store's search scores — hybrid or cosine, §4.2). No reranked score exists, so
  none is returned; `keepStage1Top` changes nothing (the order is stage-1 already).
- **No threshold cut is combined with that fallback — the same rejection.** A `ScoreFloorCut`'s
  `minScore` is calibrated on the reranker's scale; a fallback would apply it to stage-1 scores.
  `ScoreFloorCut` with a `rerank` whose `onFailure` is `'stage1'` is therefore rejected at
  construction: `StagedRetrieval: ScoreFloorCut with a reranker needs rerank.onFailure 'error' — a
  'stage1' fallback returns stage-1 scores, which a threshold calibrated on reranker scores must
  not cut`. With `onFailure: 'error'` a failed rerank returns the error, so the cut only ever sees
  reranked scores. Without a reranker, `ScoreFloorCut` cuts stage-1 scores, calibrated on them —
  allowed.
- In YAML (`rag.profiles.<key>.compose`), the validator refuses `cut: { score-floor: … }` with a
  reranker unless `onFailure: error` (§6.2), so the config fails at resolution with its own label,
  before the constructor would.

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
| cut | `ScoreFloorCut({ minItems, maxItems, minScore })` | first `min(minItems, limit)`, then more up to `limit` while `score ≥ minScore`; `limit` = `min(requestedK, maxItems)`. Under a reranker only with `onFailure: 'error'`; never with `keepStage1Top` > 0 — both rejected at construction (§4.7) |
| cut | `FixedItemsCut(n)` | a **ceiling**: first `min(requestedK, n)` items — for a store whose profile measured its own k; it never raises the caller's k; `limit` = `min(requestedK, n)` |
| cut | `TokenBudgetCut({ budgetTokens, maxItems?, estimator? })` | rank-order prefix of whole items while their summed size ≤ `budgetTokens`, at most `limit` items; `limit` = `min(requestedK, maxItems ?? requestedK)`; implements `ISizeBoundedCut` (§4.10) |
| query decomposition | — | **none shipped**; the consumer injects its own `IQueryDecomposer` (§4.5) |

- **k in items.** The caller's k (`ragQueryK ?? 10` in `rag-query`, 20 in `IToolsRagHandle` and the
  controller's `selectTools`) arrives unchanged; under a profile it counts items and is the
  overall limit of the retrieval, with or without a decomposer. **Every cut is capped by it**
  (approved review finding 1): the effective limit is `min(requestedK, the cut's own limit)`. A
  consumer that wants fewer than the caller's k uses `FixedItemsCut(n)`; nothing returns more than
  the caller asked for. The cut classes carry no number of their own; a default
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
  maxItems?: number,               // optional count ceiling, capped by the caller's k; absent → the caller's k
  estimator?: IItemSizeEstimator,  // absent → ToolDefinitionSizeEstimator (below)
})
```

**Behaviour.**

1. Walk the ranked, hydrated items in rank order.
2. Keep an item while `Σ estimate(kept) + estimate(item) ≤ budgetTokens` **and** fewer than
   `limit(requestedK)` are kept.
3. **Stop at the first item that does not fit.** No skipping ahead to smaller items: a lower-ranked
   small tool must never displace a higher-ranked large one.
4. **Never truncates an item.** A tool is returned whole or not at all.

**`limit()` — honest under the existing contract.**

| Question | Answer |
|---|---|
| What does `limit(requestedK)` return? | `min(requestedK, maxItems ?? requestedK)` — a count, as for every cut, capped by the caller's k |
| Is it the number returned? | No. It is an **upper bound** in items (the contract's meaning, §3.4). The budget may stop the cut earlier |
| Where is the token bound? | In the cut itself, enforced once over the final result (§4.3) |
| With a decomposer? | Sub-query `k`s share `limit(k)` items (§4.5); the token budget applies once, to the merged union |

- **Why no contract change:** `limit()` already promised only "the most items `cut` returns";
  `ScoreFloorCut` also returns fewer. Adding a token figure to `IItemCut` would make every count
  cut carry a meaningless member (ISP). The budget lives in the one cut that has it.
- **`k` stays the overall limit** (goal decision 2026-10-05): a token cut never returns more than
  k items; `maxItems` can only lower it (approved review finding 1).

**Top item alone over budget.** The result is **empty**; counted as `outcome=over_budget` and on
the span (§9). Never silent, never truncated.

**How `StagedRetrieval` sees it (S6).** `TokenBudgetCut` implements the optional `ISizeBoundedCut`
(§3.4): its `budgetTokens` and `estimator`. When the cut has it, `StagedRetrieval`:

- puts `cut.budgetTokens` and `cut.tokens` (Σ `estimator.estimate` over the returned items) on the
  span;
- counts `outcome=over_budget` when the result is empty although at least one item was ranked,
  and the first ranked item alone is larger than `budgetTokens`.

A consumer's own size-bounded cut implements the same capability to get the same telemetry. The consumer that injects the guard sizes the budget
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

- **Why 4 chars per token:** the unit convention the probability reranker (today's
  `DecisionReranker`) already uses for its batch budget (`decision-reranker.ts`:
  `Math.ceil(s.length / 4)`). It is a generic chars-to-tokens
  estimate, not tuned to any server; a consumer that needs precision injects its own estimator
  (e.g. its model's tokenizer).
- **Why `definitionChars` is written at index time:** the canonical record's text is the RAG text,
  shorter than the definition; the cut must count what the prompt will carry.

---

## 5. Rerankers are alternatives (goal 10)

**TL;DR.**

- **A decision and a reranker are different things; a probability and a relevance are different
  decisions** (goal decision 2026-10-05).
- Two decision contracts in `llm-agent` (§3.9): `IProbabilityDecision` (Jev) and
  `IRelevanceDecision` (Cohere on SAP AI Core).
- Two rerankers adapt them: `ProbabilityReranker` and `RelevanceReranker`. Every reranker lives in
  the new vendor-neutral package `@mcp-abap-adt/llm-agent-reranker` (§5.4).
- Vendor providers stay in packages of their own, named by role: `typesafe-decision`,
  `sap-aicore-decision`.

### 5.1 What ships

| Reranker (`llm-agent-reranker`) | Adapts | Provider (package) | `score` it writes |
|---|---|---|---|
| **`ProbabilityReranker`** (today's `DecisionReranker`, renamed; behaviour unchanged) + `TOOL_QUESTION` / `PASSAGE_QUESTION` | `IProbabilityDecision` | `TypeSafeDecisionModel` (`typesafe-decision`, unchanged) | P(relevant), in [0, 1] |
| **`RelevanceReranker`** (new) | `IRelevanceDecision` | **new** `SapAiCoreRelevanceDecision` (`sap-aicore-decision`) — Cohere Rerank on SAP AI Core | the relevance score — **not a probability** |
| `LlmReranker` (moved, unchanged) | `ILlm` | any LLM | not recommended (no gain, §2.2) |
| `NoopReranker` (moved, unchanged) | — | — | unchanged |

- `IReranker` is unchanged. The retrieval strategies (`RerankedRetrieval`, `RerankAllRetrieval`,
  `StagedRetrieval`) stay in libs and see rerankers only through `IReranker`.
- The consumer picks the provider per deployment (`decision.provider`, §6.2) or injects its own
  instance (builder). Any reranker composes with any indexing and candidate strategy (§7.5).

### 5.2 `RelevanceReranker`

```ts
export interface RelevanceRerankerOptions {
  /** Estimated-token budget per `score()` call (~4 chars/token, query + passages); a positive
   *  integer. Default 48000 (as `ProbabilityReranker`). */
  maxBatchTokens?: number;
  /** Max `score()` calls in flight; a positive integer. Default 4 (as `ProbabilityReranker`). */
  concurrency?: number;
}

export class RelevanceReranker implements IReranker {
  /** @throws Error when `maxBatchTokens` or `concurrency` is not a positive integer. */
  constructor(decision: IRelevanceDecision, options?: RelevanceRerankerOptions);
  rerank(query: string, results: RagResult[], options?: CallOptions)
    : Promise<Result<RagResult[], RagError>>;
}
```

**Behaviour.**

1. No candidates → returned as is, no call.
2. Candidates are split into batches under `maxBatchTokens` (below); `score({ query, passages })`
   once per batch, up to `concurrency` in flight.
3. **Output check** on every call's result — anything else is `RagError('…', 'RERANK_ERROR')`:
   - exactly one entry per passage of that call (wrong count → error);
   - every `index` an integer in range, each once (duplicate or missing → error);
   - every `score` finite (non-finite → error).
4. A `DecisionError` from the provider → `RagError('decision rerank failed: <code>: <message>',
   'RERANK_ERROR')`, as the probability reranker does.
5. Each result's `score` is set to its relevance score; the scores of all batches are merged and
   sorted descending, ties in input order.
6. Any failed call fails the whole `rerank`.

- **Not a probability — documented on the class and in the docs.** Scores are the provider's
  scale. A `ScoreFloorCut` threshold on them, or a global `IToolSelectionStrategy` threshold after
  them, is the **consumer's calibration** for its provider; **no default composition uses one**.
- `StagedRetrieval` checks the result again (§4.8), whichever reranker it is.

**Batches — by default, as the probability reranker** (decided by the user, D28, §17.7).

- Same defaults and validation as `ProbabilityReranker`: `maxBatchTokens` 48000, `concurrency` 4,
  each a positive integer (a non-positive or non-integer value throws in the constructor).
- A batch closes when the next passage's estimate (`ceil(text.length / 4)`) would take it past
  the budget; the query's estimate counts once per batch; a single passage larger than the budget
  is a batch of its own (never dropped).
- **Merging is sound by contract:** relevance scores are comparable for the same query and model,
  also across calls (§3.9), and every batch of one `rerank` has the same query and decision.
- There is no single-call mode: a consumer that wants one call per rerank sets a budget large
  enough for its candidates.
- The default compositions rerank ≤ 30 tools (`faceted-cohere`, §7.4): one call under the default
  budget.

### 5.3 `SapAiCoreRelevanceDecision` (`@mcp-abap-adt/sap-aicore-decision`)

```ts
export interface SapAiCoreRelevanceConfig {
  /** The AI Core deployment that serves the rerank model (D10: an id, not a model name). */
  deploymentId: string;
  /** Sent as `model` in the body (e.g. the Cohere rerank model name). */
  model: string;
  /** Header `AI-Resource-Group`. Default 'default' (as the AI Core embedder and LLM). */
  resourceGroup?: string;
  /** AI Core REST API base URL (the name `parseServiceKey` returns). */
  apiBaseUrl: string;
  /** Asked for a fresh token on every call; never cached here. Built by the composition root. */
  credential: IBearerCredential;
  /** Test seam; unset → global fetch (as `TypeSafeDecisionConfig.fetch`). */
  fetch?: FetchLike;
}

/** The one fetch shape the provider uses. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SapAiCoreRelevanceDecision implements IRelevanceDecision {
  readonly model: string;                      // = config.model
  score(request: RelevanceRequest, options?: CallOptions)
    : Promise<Result<RelevanceResult, DecisionError>>;
}
```

**Wire — ONE call per `score`:**

- `POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank`
- headers: `Authorization: Bearer <credential token>`, `AI-Resource-Group: <resourceGroup>`,
  `Content-Type: application/json`
- body: `{ model, query, documents: passages, top_n: passages.length }`
- response: `{ results: [{ index, relevance_score }] }` → `scores: [{ index, score: relevance_score }]`
  (order as returned); `model` = the configured `model`; no `usage` (the response carries no token
  counts).

**Errors — always a `DecisionError` with an existing code, never a zero-filled or dropped score:**

| Failure | Code |
|---|---|
| empty `query`, empty `passages`, or an empty passage | `DECISION_INVALID_REQUEST` (no call) |
| the credential cannot give a token | `DECISION_AUTH` |
| HTTP 401 / 403 | `DECISION_AUTH` |
| HTTP 429 | `DECISION_RATE_LIMITED` |
| HTTP 400 / 404 / 422 | `DECISION_INVALID_REQUEST` |
| HTTP 5xx, network failure | `DECISION_UNAVAILABLE` |
| `options.signal` aborted | `DECISION_ABORTED` |
| no `results` array; fewer or more results than passages; a missing, duplicated, non-integer or out-of-range `index`; a non-finite `relevance_score` | `DECISION_ERROR` |
| any other HTTP status | `DECISION_ERROR` |

- No [0, 1] check: the score is not a probability (§3.9). `DECISION_UNSUPPORTED_QUESTION` is never
  returned.
- Messages carry the HTTP status, never the token or the response body (as `typesafe-decision`'s
  `mapError`).
- A bad answer is caught twice: here (`DECISION_ERROR`) and by `RelevanceReranker`'s output check.

**Rules it follows (same as `typesafe-decision` and the AI Core embedder):**

- The credential is **injected** (`IBearerCredential`, `@mcp-abap-adt/interfaces-auth`); the
  package never reads env.
- The AI Core token exchange is reused, not rewritten: the composition root builds the credential
  from the service key with `serviceKeyCredential` (`@mcp-abap-adt/sap-aicore-auth`: client
  credentials → `TokenProvider`), exactly as for the AI Core embedder and LLM. Verified in the repo:
  `credential-for.ts` (`envCredentialEntries`, `<REF>_SERVICE_KEY` → bearer + `apiBaseUrl`) builds
  the `IBearerCredential` the AI Core embedder receives; `sap-aicore-llm` and `sap-aicore-embedder`
  only consume the injected credential. So `sap-aicore-decision` needs no dependency on
  `sap-aicore-auth`.
- No timeout of its own; `options.signal` aborts the request. No retries inside.

**Withdrawn:** `SapAiCoreDecisionModel` / `SapAiCoreDecisionConfig` and the "Cohere behind
`IDecisionModel`" design (amendment 3). It mapped `relevance_score` into `NoulAnswer.probability` —
exactly the confusion the goal decision separates — and needed the `instructions.passage` and
`DECISION_UNSUPPORTED_QUESTION` rules that no longer apply. It was never released, so it gets no
alias.

### 5.4 Package placement

| What | Package | Why |
|---|---|---|
| `IProbabilityDecision`, `IRelevanceDecision` and their types | `@mcp-abap-adt/llm-agent` | contracts shared by providers, rerankers, server-libs and consumers |
| `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, the `PROBABILITY_RERANK_DEFAULT_*` wording | **new `@mcp-abap-adt/llm-agent-reranker`** | rerankers carry no vendor specifics (goal decision 2026-10-05): one vendor-neutral package. Peer: `@mcp-abap-adt/llm-agent` only — nothing in them imports `interfaces-auth` |
| `wrapProbabilityDecision` (ex-`wrapDecisionModel`), `wrapRelevanceDecision` | `@mcp-abap-adt/llm-agent-libs` (`adapters/`) | they are usage-logging **decision** adapters beside `usage-logging-embedder`, not rerankers: they import only `llm-agent`, wrap a decision (not an `IReranker`), and their caller is server-libs' resolver, which wraps the decision before handing it to a reranker. No reranker imports them |
| `SapAiCoreRelevanceDecision` | **new `@mcp-abap-adt/sap-aicore-decision`** | one package per vendor and role, shaped like `typesafe-decision`: peers `@mcp-abap-adt/llm-agent` and `@mcp-abap-adt/interfaces-auth`, `LGPL-3.0-only`, plain `fetch`, no runtime dependency |
| `TypeSafeDecisionModel` | `typesafe-decision` (unchanged) | implements `IProbabilityDecision` (the same type as before) |

- **`assertPositiveInteger` is copied** into `llm-agent-reranker` (a private 6-line util). Moving it
  into `llm-agent` would add a public export to the contracts package that is not a contract;
  libs keeps its own copy for `RerankedRetrieval`. The reranker package cannot import libs (libs
  depends on it — a cycle).
- **libs depends on `llm-agent-reranker`** (a peer, workspace sibling — the repo's standing
  exception) and re-exports every moved name from its root, plus the old names as deprecated
  aliases, until the next major (§13). libs has no subpath for rerankers, so its root is the only
  old path.
- Server-libs imports the rerankers from `llm-agent-reranker` (new peer); the app adds it as a
  dependency.
- Rejected placements for `SapAiCoreRelevanceDecision`: inside `llm-agent-reranker` (a vendor HTTP
  client in a vendor-neutral package); inside `sap-aicore-embedder` / `sap-aicore-llm` (one package
  would carry a second role and its `@sap-ai-sdk/*` dependencies); inside `typesafe-decision`
  (another vendor).
- **Deployment id vs model name:** this PR takes `deploymentId`. Resolving a deployment by model
  name needs the deployment listing that lives privately in `sap-aicore-embedder`
  (`resolveDeploymentId`). Decided — D10 (§17).

### 5.5 Rerankers in the default tools compositions

- Cohere: `faceted-cohere` = `RelevanceReranker(IRelevanceDecision)`.
- Jev: `faceted-jev`, `small-set-jev` = `ProbabilityReranker(IProbabilityDecision, TOOL_QUESTION)`.
- The type says which: a `faceted-cohere` factory takes an `IRelevanceDecision`, the Jev ones an
  `IProbabilityDecision`. In YAML the variant is checked against the kind `decision.provider`
  gives (§6.2).
- Which reranker runs is the consumer's choice: any reranker composes with any indexing and
  candidate strategy (§7.5).

---

## 6. Builder and YAML

### 6.1 Library (SmartAgentBuilder)

| Method | What |
|---|---|
| `withToolsProfile(profile: ICollectionProfile<ToolItem>, source?: IToolsFillSource)` | **new.** The builder binds the profile (a shipped variant or the consumer's own composition) to its own `tools` store (set by `setToolsRag` or auto-created) with the fill source (absent → `LiveToolsFill`, §3.10), runs that source's `fill` at build (where `vectorizeMcpTools` runs today — the store's creation) and applies `bound.retrieval` like an explicit `withRetrievalStrategy('tools', …)`. |
| `withRetrievalStrategy(key, bound.retrieval)` | **existing.** Any other store (e.g. a shared-items binding): the consumer binds the profile itself, registers `bound.rag` under `key` and hands `bound` to its writing elements. Pure DI; no new method. |

Rules (pattern 5, "unsupported is an error"; checked at `build()`):

- `withToolsProfile` + `withRetrievalStrategy('tools', …)` → error (two owners of one store's
  ranking).
- A store already wrapped by a binding (brand on `StrategyRag`, walked through `IRagDecorator`) is
  not bound twice — the server binds at creation, the builder reuses it.

Type check: `withToolsProfile(sharedItemsProfile)` does not compile (`ICollectionProfile<ToolItem>`).

**Limit — the builder fills a profile only where it vectorizes today.** The builder writes tool
records only on its auto-connect branch (YAML `mcp:` / `withMcpConnectionStrategy`). On the
`withMcpClients` and `withMcpServers` branches it skips vectorization — as in 30.1.0
(`builder.ts`, "Caller-provided clients: skip auto-connect and vectorization"; the servers branch
says the same). This spec does not change that: there the profile is **bound** and its retrieval
applied, but the store is **not filled**. The consumer fills it, with the shipped API:

```ts
// 1. bind first (the builder reuses a bound store, never binds it twice); the fill source is
//    the third argument (absent → live)
const bound = bindToolsProfile(profile, { key: 'tools', rag: toolsRag });
// 2. fill: one ToolItem per tool, itemId = the tool's record key (`tool:` prefix)
const listed = await client.listTools();                       // per client; Result
const items = listed.ok
  ? listed.value.map((t) =>
      toolItemFromTool(t, {
        itemId: defaultToolRecordKey.key({ toolName: t.name, clientIndex: 0, clientCount: 1 }),
        originalName: t.name,
      }))
  : [];
const report = await bound.index(items);                       // Result<IndexReport>; check failedItems
// 3. build on the bound store
builder.withMcpClients([client]).setToolsRag(bound.rag).withToolsProfile(profile);
```

- With several clients, `clientIndex` / `clientCount` follow the client order (or the consumer's
  own `IToolRecordKey`, the same one given to `withToolRecordKey`), so the ids match what tool
  selection reads.
- Filling after `build()` works too: `toolsBindingOf(handle.ragStores.tools)?.index(items)`.
- Whatever fills the store — `fillToolsBinding`, the builder — reads the binding and its fill
  source from the store (D34, D42, §6.3); a reconnect that reports `toolsChanged` reads the
  binding to leave the store unwritten (D46). Bind with `bindToolsProfile`, never with
  `profile.bind()` alone: a binding the store does not carry is invisible to those paths (a
  reconnect would take the store for unbound and write 30.1.0 records), and `fillToolsBinding`
  refuses it.
- With a `corpus` or `prebuilt` source the snippet's listing is not needed:
  `await fillToolsBinding([], bound)` runs the store's source at creation (it loads or checks; no
  client is read).
- Not filled → the tools store stays empty, as on these branches in 30.1.0; nothing errors, and
  what tool selection does with an empty tools store is unchanged by this spec.
- **The limit is the builder's only.** The builder has no startup phase of its own: `build()`
  cannot know whether the caller fills the store before, after, or never. The server has one, so
  it does **not** inherit the limit: a bound `rag.profiles.tools` store is filled by the server
  from whatever clients it uses (§6.3), on every provisioning path. A consumer of the builder can
  call the same function instead of the snippet (`fillToolsBinding`, §6.3): it lists, namespaces
  and keys several clients the way the builder does.

### 6.2 Server YAML (`smart-server.yaml`) — names mapped to instances

**Config is only the builder's.** YAML holds names; the server's resolver maps each name to a
strategy instance and hands instances to the builder. No component reads config.

**One store key in this PR: `tools` (S8).** The server builds and fills only its own `tools` store
(main and every worker's), so `rag.profiles` accepts only the key `tools`. Any other key is
refused at config resolution, with a message pointing to the library API. A consumer with more
tools stores (e.g. per role, or a second MCP server's) binds them in its composition root:
`profile.bind({ key, rag })` + `builder.withRetrievalStrategy(key, bound.retrieval)` (§6.1, §7.5).

```yaml
decision:                 # existing section — ONE decision per server; the provider decides its kind. Secrets never here.
  provider: sap-aicore                           # typesafe (Jev → probability) | sap-aicore (Cohere on SAP AI Core → relevance) — new value
  deploymentId: ${RERANK_DEPLOYMENT_ID}          # sap-aicore: required (D10: an id, not a model name)
  model: <rerank model name>                     # sap-aicore: required, sent as `model`
  resourceGroup: default                         # sap-aicore: optional, header AI-Resource-Group
  # credentialRef: AICORE                        # optional; default DECISION (below)

rag:
  retrieval:              # unchanged (30.1.0). A key may not appear here AND under profiles.
    history: { strategy: embedding }
  profiles:               # new; absent → 30.1.0 behaviour (= variant baseline). Only `tools` (S8).
    tools:
      variant: faceted-cohere                    # baseline | faceted | faceted-cohere | faceted-jev | small-set-jev | a registered name
      intents:                                   # optional indexing strategy; not with baseline
        record: { file: ./tool-intents.json }    # or: companion: { source: { llm: intents }, store: { … } }
      decomposer: my-splitter                    # optional; a NAME the consumer registered (§4.5); not with baseline
      fill: live                                 # optional (§3.10): live (default) | consumer | a registered name | { corpus: … } | { prebuilt: … }
```

Where the tools store's records come from (§3.10, D42):

```yaml
rag:
  profiles:
    tools:
      variant: faceted
      # an in-memory store: load a corpus built at build time (no embedding call at start)
      fill: { corpus: { file: ./tools-corpus.json, profile: faceted@1, embedder: aicore-te3-small } }
      # a persistent store filled by the deploy step (deployToolsCorpus): bind, check, never write
      # fill: { prebuilt: { profile: faceted@1, embedder: aicore-te3-small } }
```

`profile` and `embedder` are the consumer's names for the composition and the document embedder,
the same strings its build step passed to `buildToolsCorpus` (§6.5).

A coarse / small tool set (Jev over the whole set):

```yaml
decision: { provider: typesafe }
rag:
  profiles:
    tools:
      variant: small-set-jev
      smallSet: { poolItems: <n> }               # required: ≥ the store's tool count (§7.4)
```

The consumer's own composition, every value a NAME of a strategy:

```yaml
rag:
  profiles:
    tools:
      compose:
        indexer: { faceted: [summary, parameters] }  # facet names → IToolFacet instances; name-tail is opt-in
        # text: parameter-names                    # provider text composer (§7.3.1): parameter-names (default, C0) | enum-values | schema | a registered name
        # or (generic, in no default; measured worse on `compact`, §7.3.2):
        #   indexer: { enum-values: { inner: { faceted: [] }, discriminator: required-enum, maxValues: <n> } }
        # discriminator: required-enum | { named: <parameter> } | a registered name
        pool: { items: 30 }                        # → ItemPool(30)
        collapse: max                              # → MaxScoreCollapse
        reranker: decision                         # none | decision | llm — decision = ProbabilityReranker (typesafe) or RelevanceReranker (sap-aicore)
        question: tool                             # probability decision (typesafe) / llm only — refused for a relevance decision
        decomposer: none                           # none | a registered name (no built-in)
        cut: { fixed-items: 5 }                    # top-items | fixed-items | score-floor {minItems,maxItems,minScore} | token-budget {budgetTokens,maxItems?}
        onFailure: stage1                          # stage1 | error — score-floor with a reranker needs error (§4.7)
```

**One `decision:` section; the provider decides the kind** (goal decision 2026-10-05):

| | `typesafe` (existing) | `sap-aicore` (new) |
|---|---|---|
| kind of decision | **probability** (`IProbabilityDecision`) | **relevance** (`IRelevanceDecision`) |
| `reranker: decision` builds | `ProbabilityReranker` (+ the `question` / `task` wording) | `RelevanceReranker` (no wording) |
| fields | `model?`, `baseUrl?`, `timeoutMs?`, `maxRetries?` | `deploymentId`, `model`, `resourceGroup?` |
| credential kind | api key | bearer + `apiBaseUrl` (a SAP AI Core service key) |
| default `credentialRef` | `DECISION` → env `DECISION_API_KEY` | `DECISION` → env `DECISION_SERVICE_KEY` |
| a named ref, e.g. `credentialRef: AICORE` | `AICORE_API_KEY` | `AICORE_SERVICE_KEY` (e.g. the same AI Core account as the LLM) |
| built by | the app's `createMakeProbabilityDecision` (seam `BuildAgentDeps.makeProbabilityDecision`, renamed from `makeDecisionModel`, which stays a deprecated alias; returns `IProbabilityDecision`) | the app's new `createMakeRelevanceDecision` (new optional seam `BuildAgentDeps.makeRelevanceDecision`, returns `IRelevanceDecision`, §3.8) |

- **The kind table is server-libs' one place** that maps a provider name to a kind
  (`typesafe` → probability, `sap-aicore` → relevance); the resolver calls the seam of that kind.
  A kind's seam missing while the config asks for it → startup error naming the seam
  (`BuildAgentDeps.makeProbabilityDecision is required: …` / `BuildAgentDeps.makeRelevanceDecision
  is required: …`).
- **The probability seam's alias:** SmartServer reads the probability seam as
  `makeProbabilityDecision ?? makeDecisionModel`. Both supplied → the constructor throws
  `BuildAgentDeps.makeDecisionModel and BuildAgentDeps.makeProbabilityDecision are both supplied:
  makeDecisionModel is the deprecated alias of makeProbabilityDecision — supply only
  makeProbabilityDecision.` (D30, §17.7).

- **Where the AI Core service key comes from:** the shipped app reads the service key JSON of the
  SAP AI Core instance (`clientid`, `clientsecret`, `url`, `serviceurls.AI_API_URL`) from
  `<REF>_SERVICE_KEY` (`envCredentialEntries`); `serviceKeyCredential` turns it into the bearer
  credential (client-credentials token, refreshed by `TokenProvider`) and `apiBaseUrl`. Same rule as
  the AI Core LLM and embedder. A consumer with its own composition root builds the credential its
  own way.
- **One decision per server:** `decision:` is one section. `rag.retrieval` entries with
  `reranker: decision` and `rag.profiles.tools` share it. With `provider: sap-aicore`,
  `rag.retrieval`'s `reranker: decision` builds a `RelevanceReranker` (Cohere) too — no new key
  needed there.
- **Wording is the probability decision's only.** `question` / `task` select the
  `ProbabilityReranker`'s wording; a relevance decision reads none, so they are **refused at
  startup** when the provider is relevance (accepting them would be a silent no-op).
- **A threshold on relevance scores is the consumer's calibration.** `cut: { score-floor: … }`
  over a `RelevanceReranker` is allowed and documented as provider-specific calibration; no
  default composition uses it. With a reranker it needs `onFailure: error` — a `stage1` fallback
  would cut stage-1 scores with a threshold calibrated on reranked ones (§4.7, F5).

**Resolution.**

- Parsed **only** by the server (`resolve-collection-profiles.ts` in server-libs, beside
  `resolve-retrieval.ts`).
- Names resolve through registries in the composition deps (like `embedderFactories`):
  `toolsVariantFactories` (built-ins: the five default compositions of §7.4) and
  `toolsStrategyFactories` (built-in facets, discriminators, pools, collapse, cuts, size
  estimators). A consumer registers its own, including its decomposers (none is built in). Unknown
  name → startup error.
- A decomposer factory gets the store's query embedder from the resolver (the same one `makeRag`
  gives the store); YAML carries no decomposer parameters — they belong to the registered factory.
- Rerankers resolve through the same code as `rag.retrieval`:
  - `decision`: by the provider's kind — `ProbabilityReranker` over the ONE
    `IProbabilityDecision` the `makeProbabilityDecision` seam builds, or `RelevanceReranker` over the ONE
    `IRelevanceDecision` the `makeRelevanceDecision` seam builds, each wrapped once for usage
    logging (`wrapProbabilityDecision` / `wrapRelevanceDecision`); the library constructs none
    from configuration;
  - `llm`: `LlmReranker` over a key of the `llm:` map (existing).
- Provider text composers resolve through `toolsStrategyFactories` like facets: built-ins
  `parameter-names` (default), `enum-values`, `schema` (§7.3.1).
- Stores are built through the existing `makeRag` seam. Resolution builds **no** companion store:
  it keeps the companion's store section, and the server builds one companion store **per primary
  binding** (main, and each worker with its own `rag`), with that primary's embedder (§7.3.3, D33).
- `record: { file }` / `companion: { source: { file } }` is a JSON object
  `{ "<originalName>": ["intent", …] }` read at startup into a `StaticIntentSource`.
- `fill` resolves to ONE `IToolsFillSource` instance, server-wide (§3.10): `live` →
  `LiveToolsFill`, `consumer` → `ConsumerToolsFill`, `{ corpus: { file, profile, embedder } }` →
  the file read once at startup, `parseToolsCorpus`, `ToolsCorpusLoader`; `{ prebuilt: { profile,
  embedder } }` → `PrebuiltToolsStore`; any other name → `SmartServerConfig.toolsFillFactories`.
  Absent → `live`. The server binds the main store and every worker store it builds with it.

**Validation** (raw YAML, as in #321 §13.4) → startup error, never a silent drop:

- a `rag.profiles` key other than `tools` (S8);
- unknown variant or strategy name; `variant` and `compose` together; a key under both
  `retrieval` and `profiles`;
- `intents` or `decomposer` with `baseline`; `companion` without `store`;
- an `llm` key not in `llm:`; non-positive `pool.items`; `minItems > maxItems`;
- `compose.cut: { score-floor: … }` with a reranker and `onFailure` not `error` (absent = `stage1`)
  (§4.7, F5);
- `small-set-jev` without `smallSet.poolItems`, or a non-positive one; an `enum-values` indexer
  without `maxValues`; non-positive `budgetTokens`;
- a decision reranker without a `decision:` section: `faceted-cohere`, `faceted-jev`,
  `small-set-jev`, or `compose.reranker: decision`;
- a named variant whose decision is of the other kind: `faceted-cohere` needs a relevance provider
  (`sap-aicore`); `faceted-jev` and `small-set-jev` need a probability provider (`typesafe`);
- `decision:`: `provider` not `typesafe` | `sap-aicore`; with `sap-aicore`, a missing `deploymentId`
  or `model`, or a typesafe-only field (`baseUrl`, `timeoutMs`, `maxRetries`); with `typesafe`, a
  sap-aicore-only field (`deploymentId`, `resourceGroup`); a secret (`apiKey`) as today;
- an explicit `question` (`rag.profiles` `compose`, `rag.retrieval`) or `task` (`rag.retrieval`)
  for a decision reranker when the provider's kind is relevance — a relevance decision reads no wording (§3.9);
- an unknown `text` composer name;
- a tools key whose variant is not a tools profile;
- `fill`: an unknown name; `corpus` without `file`, `profile` or `embedder`; `prebuilt` without
  `profile` or `embedder`; `prebuilt` over an `in-memory` tools store (empty at every start — use
  `corpus`); `corpus` or `prebuilt` while a worker declares its own `rag` **and** its own
  `mcpClients` or `mcp:` (the corpus describes the shared catalog; bind that worker's store in the
  composition root). Checked by the server at start too, for a config built in code;
- an `intents.companion.store` that is not `in-memory` while a worker declares its own `rag`
  (D33): the section names ONE physical collection, and the worker's binding would need a second
  one the config does not name (§7.3.3). Checked by the server at start, so a config built in code
  is refused too.

- Server-wide like `rag.retrieval`: worker configs that declare `rag.profiles` are rejected;
  workers' tools stores get the main config's profile (each its own binding and companion
  storage, §7.3.3).
- Shared items have **no YAML** in this PR (library API only). Decided — D6 (§17).

### 6.3 The server fills a bound tools store once, when the store is created (D31, D34, D35, D41)

**TL;DR.** Three rules, on every path that creates or refreshes a tools store (all listed in §6.4):

1. **The binding and its fill source travel with the store (D34, D42).** Every tools write reads
   them from the store it writes — never from an option: the builder's fill at `build()` and
   `fillToolsBinding`. A bound store → its fill source (§3.10); an unbound store → exactly 30.1.0.
   A reconnect that reports `toolsChanged` (`McpToolRegistry.revectorizeTools`) reads the binding
   too: a bound store → **no write** (D46); an unbound store → 30.1.0's re-vectorize.
2. **Whoever creates a bound store fills it, once (D35, D41).** The server creates the main store in
   `_buildInfra` and fills it there, before it reports ready. It creates a worker's own store in
   the worker's **construction** (`buildSubAgent` without `injected`: the startup primary build, or
   the lazy rebuild after a drain), so that construction fills it. A per-session re-wire reuses the
   cached store and **never fills**. On `yamlBuilderConnect` the shared clients are known only after
   the workers' startup build, so one pass right after the harvest completes those workers' fill at
   startup (D38).
3. **Never refilled while running (D41).** No refill API, no fill memo, no retry. An incomplete fill
   (`complete: false`, or aborted) is reported and stays: `/health` `degraded` for the main store,
   the logged summary line for a worker. A reconnect that reports `toolsChanged` writes nothing
   into a bound store (D46); a new instance — a restart, a worker rebuilt after a drain — is a new
   store and is filled at its creation.

Without a bound profile nothing changes: 30.1.0 behaviour on every path.

**Where the server gets the main store's clients (`smart-server.ts`, `_buildInfra`):**

| Path | Condition | Who connects | Who fills a bound main store |
|---|---|---|---|
| ready clients | `BuildAgentDeps.mcpClients` ?? `cfg.mcpClients` ?? plugin `mcpClients` (when the plugins brought any) — presence wins, even `[]` | nobody (handed over) | **the server** (new) |
| injected seam | YAML `mcp:` + `connectMcpWithDescriptors` or a bare `connectMcp` injected, no ready clients | the seam (`_resolveMcpWithDescriptors`) | **the server** (new) |
| YAML builder connect (`yamlBuilderConnect`) | YAML `mcp:`, no ready clients, no injected seam | the startup builder | the builder (§6.1, auto-connect branch) — its `build()` creates the store's agent and runs the store's fill source; the server does not fill again |
| no MCP | none of the above | — | **the server**: zero clients → `live` gives an empty, complete catalog (`total: 0`); `corpus` / `prebuilt` need no client |

On the first two paths the server hands the clients to the builder through `withMcpClients`
(main and workers), which skips vectorization (§6.1), so in 30.1.0 the tools store stays empty
there. Under a profile that would leave a bound store empty: the server fills it instead.

**How it fills — the shipped path, not a second one.**

- `fillToolsBinding(clients, binding, opts)` (new export of `llm-agent-libs`) is a thin call of
  `vectorizeMcpTools(clients, binding.rag, …)`, which reads the binding **and its fill source** from
  `binding.rag` (rule 1) and runs the source's `fill`. For `live` that is exactly the profile path
  of §7.6 (listing, namespacing, `IToolRecordKey` ids, `toolItemFromTool`, `bound.index`); for
  `corpus` / `prebuilt` no client is read. Nothing is duplicated. Its type requires a binding, so it
  never starts the 30.1.0 record path. It **throws** when the store does not carry that binding
  (`toolsBindingOf(binding.rag) !== binding`, i.e. a binding made by calling `profile.bind()`
  directly instead of `bindToolsProfile`): such a store carries no fill source, and the next
  reconnect's `toolsChanged` would take it for unbound and write 30.1.0 records into it. So the
  mistake is refused at the first fill.
- The server passes the clients it resolved (`_sharedMcpClients`), their descriptors and
  configured slot count when the seam produced them (`_sharedMcpClientDescriptors`,
  `_configuredSlotCount`; array order otherwise), its `IToolNamespace` and its file logger — the
  same inputs its authoritative tool snapshot is built from, so the record ids match the names
  tool selection reads. It is one more `listTools()` pass at startup on these paths (`live`).
- **When (main store).** In `_buildInfra`, after the startup agent is built and the shared clients
  are resolved, before the small-set check (D23) and before `HealthChecker` is created — so before
  `start()` listens and before the embeddable `buildAgent(cfg)` returns. Once.

**Rule 1 in detail — the binding and its fill source are read from the store (D34, D42).**

- `vectorizeMcpTools` takes **no `binding` option**. It reads the store's binding and fill source
  (walking `IRagDecorator.inner`: a `StrategyRag`, the circuit breaker's `FallbackRag`) and
  branches: a binding → the source's `fill` (the store's creation; the `live` path needs no raw
  writer); none → the 30.1.0 records and the 30.1.0 writer guard. Its callers for a bound store
  are creation paths only: the reconnect path stops before it (below).
- **Why no option.** An option was a second source of truth, and only the startup caller passed
  it. The reconnect path (`McpToolRegistry`) receives `ragStores`, not a binding, so it did not.
  A profiled store then got 30.1.0 records on reconnect, and a writerless binding was skipped
  silently. Every binding in this spec is attached to its store by `bindToolsProfile`:
  - the server's `withToolsStore` (§6.2);
  - the builder's `withToolsProfile` (§6.1);
  - the consumer snippet (§6.1);
  - `rag-eval`'s profile arms (§14.3).

  So no caller holds a binding its store does not carry. The option is removed, not kept beside
  the store's.
- **`toolsChanged` with a binding — no write (D46).** `revectorizeTools` asks the store it would
  write (`toolsBindingOf`, through decorators, so a `FallbackRag` over the bound store counts). A
  binding → it writes nothing, calls no fill source and lists nothing; it logs one line under the
  `mcp` debug area (`isDebugArea('mcp')`, the file's existing convention) — no warning, so a
  flapping connection does not spam the log. No binding → `vectorizeMcpTools`, exactly 30.1.0.
  - Why: until a bound store is filled, the pipeline and its MCP do not work, so the tool list
    cannot change under a working pipeline. A slot that was down at creation and connects later is
    an incomplete fill: reported and kept (D41), not refilled.
  - **An MCP server plugged in at runtime** (or one that changes its tool list while running,
    `notifications/tools/list_changed`) is the only case. A consumer who builds such a pipeline
    does its own checks and filling in that pipeline (§15) — e.g. `bound.index` with the new
    tools. The library does not.
  - Records of a tool a server no longer lists stay, in a bound store and (as in 30.1.0) in an
    unbound one (D40): tool selection keeps only names in the agent's current catalog, so such a
    record is never offered as a tool.
- The catalog status `/health` reads stays the startup one, as in 30.1.0.

**Rule 2 in detail — a worker's store is filled by the construction that creates it (D35, D41).**

| Worker | Its tools store | Filled by | From (`live`) | When |
|---|---|---|---|---|
| no own `rag` | the main store, by reference (the parent's `toolsRag` on every re-wire) | the main fill | — | never again |
| own `rag`, own `mcpClients` | its own, bound at creation (`withToolsStore`, own companion stores, D33) | its construction (`buildSubAgent`, no `injected`) | its own clients, array order (plain `IMcpClient[]`: no descriptors exist) | the startup primary build, or the lazy rebuild after a drain |
| own `rag`, no own clients, no own `mcp:` | its own, bound at creation | its construction; on `yamlBuilderConnect` at startup, the pass right after the harvest (D38) | the server's shared clients with `_sharedMcpClientDescriptors` / `_configuredSlotCount` — what every re-wire hands it | at startup on every path; after a drain, its lazy rebuild |
| own `rag`, own `mcp:` | its own, bound at creation | its own builder's auto-connect on the construction's build (§6.1) | its own connection | the construction only: a re-wire hands the builder the backfilled clients through `withMcpClients`, which does not vectorize |

- `buildSubAgent` fills on the **construction** (no `injected`) **right before `subBuilder.build()`**,
  from the clients it would hand a re-wire, so the records carry the names the worker's agent
  dispatches by — by construction (D32). It runs the store's fill source: `corpus` / `prebuilt`
  read no client.
- **A per-session re-wire never fills** (D41): it receives the cached store by reference.
- **When the shared clients are known — always at startup (D38).** On every path except
  `yamlBuilderConnect`, they are resolved before the startup primary builds of the workers, so the
  construction fills a worker on the shared clients at startup, before the server listens. On
  `yamlBuilderConnect` the shared clients are taken from the main builder after the workers'
  startup build, so `_buildInfra` makes **one fill pass right after the harvest**: every worker
  with its own bound store, no own `mcpClients` and no own `mcp:` is filled from the harvested
  clients with `_sharedMcpClientDescriptors` / `_configuredSlotCount` — before the small-set check,
  `/health` and listen. That pass completes those workers' creation at startup; it is not a refill.
  A lazy rebuild later finds the shared clients known and fills in the construction.
- **`PUT /v1/config` and hot reload** drain the worker cache (`WorkerRegistry.drain`). The next
  session's `WorkerRegistry.build` misses the cache and constructs the worker (`buildSubAgent`
  without `injected`): `resolveWorkerLlmSet` creates a new store, `withToolsStore` binds it with new
  companion stores and its fill source, and that construction fills it. In the earlier design
  (`fillWorkerToolsStores`, startup only) these rebuilds left the new bound stores empty.
- **A construction whose fill throws leaves no cached worker.** `resolveWorkerLlmSet` caches the
  worker's set before the build; when the fill throws (an incompatible corpus, a store not deployed,
  an invalid `IToolRecordKey`, a binding its store does not carry), `buildSubAgent` removes that
  entry before rethrowing, so no later session re-wires a worker whose store was never filled. A
  configuration error stays loud: the next session's construction throws again.
- A worker's own **persistent** store (its `rag` on qdrant, …) is bound again on every construction
  and its source runs again: `live` replaces each record in place; `prebuilt` (the recommended
  source for a persistent store) only checks it. (A persistent *companion* store with a worker that
  has its own `rag` is refused at start, D33.) Several server processes writing one persistent
  store at the same time is the backend's concern (§3.3, D13); the library coordinates nothing
  across processes.
- **Two sessions arriving together after a drain** can both construct the same worker in 30.1.0,
  and with a profile each construction fills its own new store. That race exists without profiles
  and is out of scope here (§15, D45).

**A worker's records carry the identity its agent dispatches by (D32).** A tool's exposed name
(the namespace prefix on a collision: the slot's `label`, else `s<slotIndex>`) and its record id
(`IToolRecordKey` over the stable `slotIndex` and the configured slot count) depend on the slot
descriptors and the `IToolNamespace`. A store filled with one identity and searched by an agent
whose catalog uses another drops the hits silently: tool selection keeps only retrieved names that
are in the agent's catalog.

| Worker's clients | Filled with | The worker's agent dispatches by |
|---|---|---|
| the server's shared clients (fallback) | `_sharedMcpClientDescriptors`, `_configuredSlotCount`, the server's `IToolNamespace` — exactly what the main fill passes; on a re-wire, the session's descriptors and slot count (the same slots and labels) | the same: the per-session re-wire hands the worker the session's clients **with** their descriptors (`SessionAgentParts.mcpClientDescriptors`) and its slot count, and the worker's builder gets the server's `IToolNamespace` |
| its own `mcpClients` | no descriptors — the worker config takes plain `IMcpClient[]`, so none exist: array order is the identity (`slotIndex` = position, no labels, slot count = the number of clients); the server's `IToolNamespace` | the same array order (the builder gets the clients without descriptors) and the server's `IToolNamespace` |
| its own `mcp:` | its own builder's auto-connect: the descriptors its connection reports, the server's `IToolNamespace` | the same: the worker cache keeps those descriptors beside the clients it backfills from the worker's handle, and every per-session re-wire hands both to the worker's builder (in 30.1.0 the re-wire dropped them) |

- How the descriptors reach a worker's builder — **no contract change:** `withMcpClients` takes no
  descriptors, so the server hands the shared clients through the existing `withMcpServers`, one
  already-connected `IMcpServer` per client (`descriptor` = the client's descriptor, `start()`
  returns the client, `stop()` does nothing — the server owns those clients). The builder's
  `withMcpServers` branch already forwards descriptors to the pipeline
  (`PipelineDeps.mcpClientDescriptors`) and skips vectorization, exactly like `withMcpClients`.
  Without descriptors (none were reported) the server keeps `withMcpClients`. Kept internal (the
  `connectedMcpServer` adapter in server-libs) — `withMcpClients` is not changed (§17.9).
- `withToolNamespace(server's IToolNamespace)` on every worker builder — as on the startup builder.
- **This also changes workers without a profile** (a fix, a CHANGELOG "Fixed" entry, §17.9): in
  30.1.0 a worker on the shared clients built its catalog by array position with no labels and
  the default namespace. On a collision, or with a slot missing, it exposed `s<i>__<tool>`, while
  the main store holds `<label>__<tool>` / `s<slotIndex>__<tool>`. A worker without its own `rag`
  searches that main store, so those hits were dropped. A worker on its own `mcp:` lost its
  connection's descriptors on every per-session re-wire the same way. Now the worker exposes what
  the store it searches holds. With no collision and no custom `IToolNamespace`, exposed names
  are unchanged.
- **Limit:** a session whose own connection set differs from startup's (a slot down at session
  time) can change which names collide in that worker's catalog; the store keeps the names of the
  fill. The main pipeline avoids this by rebinding the startup provenance; workers build their
  catalog per session. Not changed here.

**Status and failures — the existing tool-catalog policy.**

- The main store's fill returns a `ToolCatalogStatus` (with `records` and `profile`, S3). It is
  what `/health` reports as `components.toolCatalog` and what the small-set check (D23) reads.
  On the builder-connect path the startup agent's status is used, as in 30.1.0.
- `HealthCheckerDeps.toolCatalog?: IToolCatalogReporter` (new, optional) carries it: the builder's
  status holder is private to `build()`, and the server fills outside it. Absent → the agent's
  own status, as in 30.1.0.
- **`/health` reports the main catalog only — decided here.** A worker's fill logs the same
  summary line through the server's logger, and its status is not published. Reasons:
  - `components.toolCatalog` is one component: the catalog the server's own agent selects from.
  - A worker's store can be rebuilt (a lazy rebuild after a drain) long after startup, so a
    startup snapshot of it would go stale.
  - Per-worker catalog components would be a `/health` contract change that no goal asks for.
- A client whose `listTools()` fails or throws is counted in `clientFailures` and its tools never
  reach `total`. The status is `complete: false`, and the summary line is logged as a warning
  ("… N client(s) failed to list tools"). For the main store, `/health` is `degraded` with
  `toolCatalog` present. Startup goes on: a partial catalog degrades service, it does not
  prevent it (30.1.0 policy). Never a silent empty store.
- `bound.index` failing → every item in `failed`, the error message in the logged line, the same
  `degraded` status (main). A tool that fails to index → named in `failed`.
- An invalid `IToolRecordKey` (an id without `tool:`), a client set that does not match its
  descriptors, a binding its store does not carry, an incompatible corpus or a prebuilt store that
  was not deployed (or differs, §3.10) **throws**:
  - main store → startup fails, as on the builder's path;
  - a worker's startup build → startup fails;
  - a worker's lazy rebuild → that session's worker build fails, like any worker build error; its
    cache entry is removed (rule 2), so the next session constructs it again.
- An incomplete fill (`complete: false`, or aborted) does not fail anything and is **not retried**
  (D41): it is reported as above and stays until a new instance is created; a reconnect's
  `toolsChanged` does not write a bound store (D46).

**Without a bound profile** the server calls nothing new on any path: no listing, no writes, no
status (`/health` exactly as in 30.1.0).

### 6.4 Audit — every path that creates or refreshes a tools store

Found with `git grep -- packages scripts` for `vectorizeMcpTools`, `vectorizeSkills`,
`McpToolRegistry`, `revectorizeTools`, `makeToolsRag`, `setToolsRag`, `addRagStore`,
`drainWorkers` / `_workers.drain`, and every `writer()` / `upsertRaw` call outside the stores
themselves. Each path is listed with what writes it under a profile and what each fill source does
there, so a reviewer can check that none is missed. "Creation" = the source's `fill` (§3.10); a
reconnect calls no source (D46).

| # | Path | Code | Store | Under a profile | `live` | `corpus` | `prebuilt` | `consumer` |
|---|---|---|---|---|---|---|---|---|
| 1 | Builder `build()`, auto-connect branch (YAML `mcp:` / `withMcpConnectionStrategy`) | `builder.ts`, `vectorizeMcpTools(…, toolsRag, …)` | `setToolsRag` or the auto-created `InMemoryRag`; bound by `withToolsProfile`, or already bound by the server | creation: `vectorizeMcpTools` runs the store's source (rule 1) | lists + indexes | loads the corpus (precomputed) | checks; no write | nothing |
| 2 | Builder `build()` with `withMcpClients` / `withMcpServers` | `builder.ts`, "skip auto-connect and vectorization" | the same | not the builder (§6.1 limit): the consumer (`fillToolsBinding`, `bound.index`), or the server (rows 4, 5) | — | — | — | — |
| 3 | Reconnect: `McpToolRegistry.resolveActiveClients` → `toolsChanged` → `revectorizeTools` (any agent with a connection strategy) | `mcp/tool-registry.ts` | `ragStores.tools` — the projection, possibly a `FallbackRag` over the bound store | **never written** (D46): `revectorizeTools` finds the binding and stops, one `mcp` debug line; no source is called — **finding (a)**. An unbound store: 30.1.0 re-vectorize, unchanged; a tool no longer listed keeps its records (D40) | **no write** | **no write** | **no write** | **no write** |
| 4 | Server main store | `_buildInfra`: `makeRag` → `withToolsStore` (bound with the YAML `fill` source) | the main store | creation, once: the server (`fillBoundToolsStore` → `fillToolsBinding`) on ready clients, an injected seam, plugin clients or no MCP; on `yamlBuilderConnect` the builder (row 1) | lists + indexes | loads | checks | nothing |
| 5 | Server worker store, created by the worker's **construction**: the startup primary build, or the lazy rebuild after a drain (`PUT /v1/config`, hot reload) | `WorkerRegistry.build` (cache miss) / the startup loop → `buildSubAgent` (no `injected`) → `resolveWorkerLlmSet` → `makeToolsRag` → `withToolsStore` | the worker's own | creation, once: `buildSubAgent` before `subBuilder.build()` (rule 2) — **finding (b)**; on `yamlBuilderConnect`, a worker on the shared clients by the pass right after the harvest (D38); own `mcp:` → row 1; a throwing fill removes the cache entry | lists + indexes | loads | checks | nothing |
| 5a | Per-session re-wire of a worker | `WorkerRegistry.build` (cache hit) → `buildSubAgent` with `injected` | the cached store, by reference | **never written** (D41) | — | — | — | — |
| 6 | Worker without its own `rag` | `buildSubAgent`: `setToolsRag(injected.toolsRag)` | the main store, by reference | row 4; never filled again | — | — | — | — |
| 7 | Per-session agents (`buildSessionAgent` → the pipeline builder) | `smart-server.ts` | the main store by reference (`parts.toolsRag`); clients through `withMcpClients` | row 4; their registries reach it only through row 3 | — | — | — | — |
| 8 | Builder skills into the tools store | `vectorizeSkills` (`builder.ts`) | the tools store | skill records, 30.1.0 pass-through (§7.7) — not tool items, not a fill source's; unchanged (a writerless store is skipped, as today) | — | — | — | — |
| 9 | A consumer of the builder | §6.1 snippet; `fillToolsBinding`; `bound.index` | the consumer's | the consumer; the binding and its source attached by `bindToolsProfile` | as row 1 | as row 1 | as row 1 | the consumer's `bound.index` |
| 10 | `scripts/rag-eval` profile arms | `runProfileArm` (§14.3) | the eval store | `vectorizeMcpTools` on a store bound by `bindToolsProfile` (rule 1) with the default `live` source | lists + indexes | — | — | — |
| 11 | The consumer's build step | `buildToolsCorpus` (§6.5) | an in-process capture store, never a served one | the profile's own `bind` + `index` over capture stores; nothing is served from it | — | — | — | — |
| 12 | The consumer's deploy step | `deployToolsCorpus` (§6.5) | the persistent store (+ companions) a `prebuilt` source will bind | precomputed vectors through the store's writer, in place, idempotent | — | — | writes it | — |
| 13 | `SmartAgent.addRagStore('tools', …)` | `agent.ts` | — | refused (a built-in store), as in 30.1.0 | — | — | — | — |
| 14 | RAG editing tools (`rag_add`, …) | registry editors | — | the `tools` entry is registered without an editor: not reachable | — | — | — | — |
| 15 | Hot reload of weights | `config-reload-watcher.ts` | any store | not a fill — weights only | — | — | — | — |

### 6.5 Offline corpus — built at build time, deployed by the consumer's deploy step (D43)

**TL;DR.** The profile's indexer runs outside the server to produce a corpus. Two steps, both the
consumer's scripts:

| Step | When | Function | Embedding calls | Result |
|---|---|---|---|---|
| **build** | the consumer's build (CI) | `buildToolsCorpus` | yes — the document embedder, once | a `ToolsCorpus` (records + vectors), serialized as JSON |
| **deploy** (persistent store) | the consumer's deploy | `parseToolsCorpus` → `deployToolsCorpus` | **none** — precomputed vectors | the store holds the corpus in place, plus one service record |
| instance creation, in-memory store | the process starts | `ToolsCorpusLoader` (fingerprint check, precomputed writes into the fresh store) | **none** | the store holds the corpus |
| instance creation, persistent store | the process starts | `PrebuiltToolsStore` | **none** | bound, fingerprint checked, **never written** |

```ts
export interface ToolsCorpusIdentity {
  /** The consumer's name for the profile composition, e.g. 'faceted@1'. */
  readonly profile: string;
  /** The consumer's name for the document embedder, e.g. 'aicore-te3-small'. */
  readonly embedder: string;
}
export interface ToolsCorpusManifest {
  readonly format: 1;
  readonly identity: ToolsCorpusIdentity;
  readonly profileName: string;              // the binding's profileName at build
  readonly companions: readonly string[];    // companion store names the profile wrote
  readonly dimensions: number;               // every vector's length
  readonly items: number;                    // tools
  readonly records: number;
  readonly corpusHash: string;               // sha256 over the identity and every record's hash
}
export interface ToolsCorpusRecord {
  readonly store: string;                    // '' = the primary store; else the companion's name
  readonly id: string;                       // the physical id the profile assigned (§3.1)
  readonly text: string;
  readonly vector: readonly number[];
  readonly metadata: RagMetadata;
}
export interface ToolsCorpus { readonly manifest: ToolsCorpusManifest; readonly records: readonly ToolsCorpusRecord[] }
export interface ToolsCorpusDeployReport { readonly unchanged: boolean; readonly upserted: number; readonly deleted: number }

/** Build step: provider tool definitions → records + vectors, with the profile's own indexer. */
export function buildToolsCorpus(input: {
  readonly profile: ICollectionProfile<ToolItem>;
  readonly embedder: IRetrievalEmbedder;      // the store's embedder at run time (its document side)
  readonly identity: ToolsCorpusIdentity;
  readonly items: readonly ToolItem[];        // toolItemFromTool over the provider's definitions
  readonly companions?: readonly string[];    // the companion store names the profile binds
}, options?: CallOptions): Promise<ToolsCorpus>;
/** The serialized corpus back: shape, format, one dimension, the hash recomputed. Throws on any mismatch. */
export function parseToolsCorpus(json: string): ToolsCorpus;
/** Deploy step: write a built corpus into a store (and its companions), in place, idempotent. */
export function deployToolsCorpus(corpus: ToolsCorpus, target: CollectionStore, options?: CallOptions): Promise<ToolsCorpusDeployReport>;
export const TOOLS_CORPUS_RECORD_ID = 'tools-corpus';   // the service record's id (no `recordId` output has this form)
```

**Build (`buildToolsCorpus`).**

- Binds the profile to **capture stores** (an internal in-memory `IRag` that owns the given embedder
  through `IRetrievalEmbedderOwner` and keeps every precomputed write) — the primary and one per
  companion name — and calls `bound.index(items)`. So the records are exactly what the same
  profile's indexer and record writer produce at run time: same ids (§3.1), texts, metadata,
  companion records; only the store differs.
- Any `failedItems` → throws naming them: a corpus is complete or not built. No items → throws.
- Item ids must be what tool selection reads at run time: `toolItemFromTool(tool, { itemId:
  toolRecordKey.key(…), originalName })` with the same `IToolRecordKey`, client order and namespace
  as the server (§6.1 snippet). The consumer's build reads the tool definitions from its provider
  (an MCP server it starts in CI, or the definitions the provider exports).
- Serialization is `JSON.stringify(corpus)`; `parseToolsCorpus` is its checked inverse.

**Deploy (`deployToolsCorpus`) — one current state, in place, idempotent.**

1. Read the store's service record (`TOOLS_CORPUS_RECORD_ID`). Its `corpusHash` and identity equal
   the corpus's → `{ unchanged: true }`, nothing written.
2. Every target store (primary + each companion the corpus names; a corpus companion the target
   lacks, or a target companion the corpus lacks → throw) must accept precomputed vectors
   (`writer().upsertManyPrecomputedRaw` or `upsertPrecomputedRaw`) — else throw: the step makes no
   embedding call.
3. **Write ahead:** the service record is rewritten first with the old hashes plus `pending` = the
   ids this run may write. An interrupted run's records are therefore always listed, and the next
   run deletes what its corpus does not hold (the same write-ahead rule as §3.3's stale lists).
4. Upsert every record whose hash is new or differs from the service record's, in batches.
5. Delete every id the old service record lists (or lists as `pending`) that the corpus no longer
   holds, per store; every `deleteByIdRaw` Result checked — a failure throws (the service record
   still lists it, so a rerun deletes it).
6. Write the final service record: `{ serviceRecord: { kind: 'tools-corpus', manifest, hashes: {
   <store>: { <id>: <hash> } } } }`, text `tools corpus <corpusHash>`, vector = a unit vector of the
   corpus dimension. Retrieval drops it (§4.3); `ReservedRecordKey` keeps extras from setting it.

- A failed write throws; nothing is reported as deployed that is not. A rerun is safe.
- The service record holds one hash per record (~80 bytes each): a few hundred tools with several
  records each fit a Qdrant payload, a pg-vector `jsonb` and a HANA `NCLOB`.
- Concurrent deploy steps against one store are the backend's concern (§3.3, D13); a deploy runs
  once per release.

**How a consumer's scripts use it** (a sketch; the names are the consumer's):

```ts
// build step (CI) — scripts/build-tools-corpus.ts
const profile = mcpToolsVariants.faceted();
const tools = await listProviderTools();                 // the consumer's: McpTool[] from its server
const items = tools.map((t) => toolItemFromTool(t, {
  itemId: defaultToolRecordKey.key({ toolName: t.name, clientIndex: 0, clientCount: 1 }),
  originalName: t.name,
}));
const corpus = await buildToolsCorpus({ profile, embedder, identity: { profile: 'faceted@1', embedder: 'aicore-te3-small' }, items });
writeFileSync('dist/tools-corpus.json', JSON.stringify(corpus));

// deploy step — scripts/deploy-tools-corpus.ts (persistent store)
const corpus = parseToolsCorpus(readFileSync('dist/tools-corpus.json', 'utf8'));
const report = await deployToolsCorpus(corpus, { key: 'tools', rag: new QdrantRag(/* … */) });
console.log(report.unchanged ? 'tools corpus up to date' : `upserted ${report.upserted}, deleted ${report.deleted}`);

// run time — in-memory store: load the built corpus
bindToolsProfile(profile, { key: 'tools', rag: new VectorRag(embedder) },
  new ToolsCorpusLoader({ corpus, expect: { profile: 'faceted@1', embedder: 'aicore-te3-small' } }));
// run time — persistent store: bind for retrieval, check, never write
bindToolsProfile(profile, { key: 'tools', rag: qdrantRag },
  new PrebuiltToolsStore({ expect: { profile: 'faceted@1', embedder: 'aicore-te3-small' } }));
```

- The SmartServer reads the same through YAML `fill` (§6.2). This mirrors cloud-llm-hub's flow (a
  bundle for an in-process vector store; Qdrant role stores replaced in place with a fingerprint
  and corpus-hash record), generalised to any `IRag` with precomputed writes.

### 6.6 What is filled at instance creation — the tools store only

- Filling at instance creation (§3.10, §6.3) and the fill sources (`live`, `corpus`, `prebuilt`,
  `consumer`) concern **only the `tools` store**: profiles exist only for `tools` in this PR (S8),
  and a tools store's content is fixed by its provider.
- Collections that change while the server runs are **not** filled at creation and get no fill
  source:
  - **session collections** and **session history** — written during work by pipeline elements;
  - **user collections** — written during work, by pipeline elements or the consumer's actions;
  - **shared items** — written and removed by the pipeline elements that own them, through
    `SharedItemsProfile` `index` / `remove` (§8.4).
  Without a profile for their key they stay on 30.1.0 behaviour (goal 8).

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
| indexing | `IItemIndexer<ToolItem>` | 30.1.0 single record (no profile); `FacetedToolIndexer(facets, { text? })`; `EnumValueToolIndexer(inner, { discriminator, maxValues })`; `IntentRecordIndexer(inner, source)`; `IntentCompanionIndexer(source)` |
| provider text (inside faceted indexing) | `IToolTextComposer` | `ParameterNamesToolText` (default, C0); `EnumValuesToolText` (C0e), `SchemaToolText` (C0s) — measured within noise, in no default (§7.3.1) |
| facet (inside faceted indexing) | `IToolFacet` | `SummaryFacet`, `ParametersFacet`; opt-in, convention-dependent: `NameTailFacet` |
| discriminator (inside per-value indexing) | `IDiscriminatorSelector` | `RequiredEnumDiscriminator`, `NamedDiscriminator(parameter)` |
| intent source | `IToolIntentSource` | `StaticIntentSource(map)`, `LlmIntentSource(llm, { prompt? })` |
| in-store scoring | `ISearchStrategy` (existing, on the store) | the store's own (hybrid or cosine) |
| candidate pool | `ICandidatePool` | `ItemPool(n)` |
| collapse | `ICollapseRule` | `MaxScoreCollapse` |
| reranker | `IReranker` (existing) | none; `ProbabilityReranker` + `TOOL_QUESTION` over an `IProbabilityDecision`; `RelevanceReranker` over an `IRelevanceDecision`; `LlmReranker` (all in `llm-agent-reranker`) |
| decision (inside a reranker) | `IProbabilityDecision` / `IRelevanceDecision` (§3.9) | `TypeSafeDecisionModel` (Jev, probability, existing); `SapAiCoreRelevanceDecision` (Cohere on SAP AI Core, relevance, new) |
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

`FacetedToolIndexer([new SummaryFacet(), new ParametersFacet()], { text? })` — `text` is the
provider text composer (below); absent → `ParameterNamesToolText` (C0):

| Kind | Id | Text | Written when |
|---|---|---|---|
| `full` (canonical) | `recordId(global, itemId, 'full', 0)` — `itemId` is the 30.1.0 id | the composer's text; default (`ParameterNamesToolText`, C0): `Tool: <name> — <description>` + `\nParameters: <p1>, <p2>, …` when there are any | always — not a facet, so it cannot be left out |
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
- **Provider text composition is a strategy (`IToolTextComposer`, review finding 4).** The `full`
  text is also the reranker's item text (§4.6) and every non-canonical record's `itemText`, so the
  composer shapes both stage 1 and the reranker. Shipped composers — provider words only:

  | Composer | `full` text | Default? |
  |---|---|---|
  | `ParameterNamesToolText` (**C0**) | `Tool: <name> — <description>` + `\nParameters: <names>` | **yes** — measured |
  | `EnumValuesToolText` (**C0e**) | C0 + per parameter with string values: `<name>: <values>` | no |
  | `SchemaToolText` (**C0s**) | C0 + per parameter: its description's first clause and its string values | no |

  **Measured** (mcp-abap-adt `compact`, Jev over the whole role set, required-recall; EN 67 rows,
  non-ASCII 21 rows; ~1.6k tokens at k=3 for all three):

  | Text | EN k=3 | EN k=5 | non-ASCII k=3 |
  |---|---|---|---|
  | C0 | 0.970 | 0.970 | 1.000 |
  | C0s | 0.970 | 0.985 | 1.000 |
  | C0e | 1.000 | 1.000 | 0.905 |

  - Without a reranker, schema text helps non-ASCII at k=5 (0.667 → 0.857) but hurts English at
    k=2–3.
  - **Net: within noise, no winner** (1 row ≈ 1.5 points EN, ≈ 4.8 points non-ASCII). `compact`
    already lists its object types in the descriptions, so the case the review raised — objects
    named **only** in an enum — is neither confirmed nor refuted here.
  - **So the default stays C0** (measured, no change), and C0e / C0s are strategies a consumer may
    inject and measure on its own server (§14.3), documented with these numbers as the caveat.
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

**How the note gets there (S1)** — through the optional `IIndexNoteSource` capability (§3.2):

| Who | `notesFor(tool)` |
|---|---|
| `RequiredEnumDiscriminator` | several qualifying parameters → `[{ note: 'ambiguous-discriminator', detail: '<names, comma-separated>' }]`; otherwise `[]` |
| `EnumValueToolIndexer` | its discriminator's notes and its inner indexer's notes, when they have the capability |
| `IntentRecordIndexer` (a decorator, §7.3.3) | its inner indexer's notes |
| the binding (`ComposedToolsProfile`) | asks the primary and every companion indexer that has the capability, after `toRecords`; copies each note with the item's id into `IndexReport.notes` |

- The server path logs every note as a warning when it fills the tools store (§7.6), so a note is
  never lost between the report and the operator.

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
- **Generated at indexing (S2).** Every `index` asks the intent source for every tool. The
  framework does not cache generated intents: that is the consumer's concern — e.g. a
  `StaticIntentSource` over an intents file generated at deploy (costs nothing at index time), or
  its own caching `IToolIntentSource`.
- **Provenance.** The intent record stores `generatedFrom` = a hash of the tool's provider text the
  intents came from — for diagnosis and for a consumer's own cache; the framework does not read it.
- **Off / rebuild:** drop the strategy (record placement: re-index, §7.8; companion: unbind it and
  clear its store — the provider records are untouched). Rebuild = clear the companion (or the
  `intent` records) and re-index. While a companion is bound, `remove` and replacement delete its
  records through `companionRecordIds` (§3.3).

**Companion storage belongs to one primary binding (D33).** A profile instance may be shared by
several bindings; its companion **stores** may not.

- **Why:** a companion record's id is `recordId(owner, itemId, 'intent', 0)` — no binding in it —
  and every backend addresses records by id alone (§3.1). Two independent catalogs (the main store
  and a worker's own store, each filled from its own clients) that share one companion store and
  hold a tool of the same name write the SAME id: the later fill overwrites the other's intents,
  and one catalog's `remove` or replacement deletes the other's record. Retrieval then hydrates
  the other catalog's intent hit from its own canonical record — wrong intents lift an item,
  missing ones drop it.
- **Rule:** every **primary** binding gets companion stores of its own. The server builds them
  when it binds the primary (§6.2, Task 23): one per companion name, through `makeRag`, with that
  primary's embedder. A binding that **reads** another binding's primary (a worker without its own
  `rag` reads the main store by reference) uses that binding's companions — it is the same
  binding.
- **Why separate stores, not a binding segment in the id:** a binding-scoped id would isolate
  writes, but not reads — `IRag.query` filters only on `userId` / `sessionId`, so a shared
  companion store would still return the other catalog's intent hits, and `StagedRetrieval`
  would need a new filter on top. Separate stores isolate both with **no contract change**:
  `recordId`, `CollectionStore` and the record keys stay as they are, and it is the isolation
  model §3.1 already states (isolation is per store).
- **Persistent companion stores:** an `intents.companion.store` section names one physical
  collection (`collectionName`). With a worker that has its own `rag`, the server would need a
  second collection the config does not name, so it refuses to start (§6.2) — no derived
  collection names. In-memory companion stores are separate per instance and need nothing. A
  deployment that needs persistent companions per worker binds the worker's store in its
  composition root.

### 7.4 Default compositions (`mcpToolsVariants`)

**What they are:** ready-made compositions that fill in what the consumer did not choose (§7.1).
Each is a factory that takes only what cannot be shipped (the decision model, which holds the
credential; the pool size of a whole-set rerank) and returns a `ComposedToolsProfile` — or, for `baseline`,
nothing to bind. None relies on one server's conventions (§7.0). Every tuned number in a row cites
its measurement.

| Variant | Tool-set shape | Composition | Measured (required-recall, hybrid in-store scoring, mcp-abap-adt examples) |
|---|---|---|---|
| **`baseline`** — no choice made | any | 30.1.0 single record per tool + `EmbeddingRetrieval` (top-k records = tools). Selected by binding **no** profile. | Fine-grained read-only set: EN-ext 0.943 at k=5 (8.3 tools); 0.977 at k=15 (~25 tools). Multi-step 0.714, non-English 0.692 (k=5). |
| **`faceted`** | fine-grained | `FacetedToolIndexer([SummaryFacet, ParametersFacet])` + `ItemPool(15)` + `MaxScoreCollapse` + no reranker + `FixedItemsCut(8)` | **Schema-derived layout not yet measured.** Closest measured layouts, both 0.966 at k=5 (hub spike `spike-facets`): LLM-generated `operation` / `object` facets, and name-derived facets (`full` + `operation`=`summary` + `object`=`NameTailFacet`); the latter 0.977 at k=8 with ~13 tools. Pool 15 and cut 8 are that layout's (without a reranker `ItemPool(15)` = 30, §7.5). |
| **`faceted-cohere`** | fine-grained | faceted indexing + `ItemPool(30)` + `MaxScoreCollapse` + `RelevanceReranker(IRelevanceDecision)` (Cohere: `SapAiCoreRelevanceDecision`) + `FixedItemsCut(5)` | **Not measured as one composition.** Closest: one record per tool + Cohere, pool 30 items, k=5 (§2.3): EN-ext 0.931 with 8.3 tools; single 0.973, multi 0.714, non-English 0.962. At most 5 tools. |
| **`faceted-jev`** | fine-grained | faceted indexing + `ItemPool(30)` + `MaxScoreCollapse` + `ProbabilityReranker(IProbabilityDecision, TOOL_QUESTION)` (Jev: `TypeSafeDecisionModel`) + `FixedItemsCut(5)` | **To be measured as one composition on fresh consumer queries before promotion** (D11). Closest: one record per tool + Jev, pool 30 items, k=5 (§2.3): EN-ext 0.977 with 8.3 tools; single 1.000, multi 0.857, non-English 1.000. At most 5 tools. |
| **`small-set-jev`** | coarse / small (the whole set fits one rerank) | `FacetedToolIndexer([])` (one `full` record per tool) + `ItemPool(poolItems)` with `poolItems` ≥ the tool count (= rerank-all) + `MaxScoreCollapse` + `ProbabilityReranker(IProbabilityDecision, TOOL_QUESTION)` (Jev) + `FixedItemsCut(3)` | `compact`, writer set (25 tools), §2.5.1: **0.970 at ~1.6k tokens** (whole set ≈ 7.9k); multi-step 1.000, non-English 1.000. k=3 is the measured knee (C0 + Jev: k=2 0.925, k=3 0.970, k=5 0.970). Rerank-all = Jev over a stage-1 pool (0.970 both): stage 1 adds nothing at this size. |

```ts
mcpToolsVariants.faceted();
mcpToolsVariants.facetedCohere({ relevanceDecision: new SapAiCoreRelevanceDecision({ … }) });
mcpToolsVariants.facetedJev({ probabilityDecision: new TypeSafeDecisionModel({ … }) });
mcpToolsVariants.smallSetJev({ probabilityDecision, poolItems });   // Jev; poolItems ≥ the store's tool count
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
- **`faceted-cohere` and `faceted-jev` share indexing, pool, collapse and cut**; they differ in the
  reranker and the kind of decision (§5.5). Each cites the measurement of its own model. The
  factory's argument type says which decision it takes; YAML checks the variant against the
  provider's kind (§6.2).
- **Cohere's rerank calls:** ≤ 30 tools per query → one `/rerank` call (they fit in
  `RelevanceReranker`'s default 48000-token batch, §5.2).
- **Every `FixedItemsCut` here is a ceiling** under the caller's k (§4.9): a caller asking for 2
  gets at most 2.
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
    maxCandidates: <tool count> }` with the caller's k = 3. The variant caps at 3 inside the
    profile, so a larger caller's k (20 in `IToolsRagHandle`) does not undo the measured cut; a
    smaller one still wins (`min(k, 3)`, §4.9).
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
  `IItemSizeEstimator`, `IReranker`, `IProbabilityDecision` or `IRelevanceDecision`).
- Typed rule: `full` cannot be dropped (it is not a facet).
- Examples:
  - the **measured** name-derived fine-grained layout, for a verb-first server:
    `FacetedToolIndexer([new SummaryFacet(), new NameTailFacet()])` — convention-dependent, the
    consumer's choice;
  - a prompt-size guard on top of a count: `TokenBudgetCut({ budgetTokens, maxItems: 5 })` in
    place of `FixedItemsCut(5)` — the count stays the main cut, the budget only caps it (§4.10);
  - the `small-set-jev` composition with Cohere instead of Jev: a `ComposedToolsProfile` with
    `FacetedToolIndexer([])`, `ItemPool(poolItems)`, `MaxScoreCollapse`,
    `RelevanceReranker(new SapAiCoreRelevanceDecision({ … }))` and `FixedItemsCut(3)` in code, or
    `compose` with `reranker: decision` under `decision.provider: sap-aicore` in YAML (not measured
    on `compact`; the consumer measures it, §14.3). `smallSetJev` itself takes only an
    `IProbabilityDecision`;
  - schema-enriched provider text: `FacetedToolIndexer([...], { text: new EnumValuesToolText() })`
    (C0e) or `SchemaToolText` (C0s) — within noise on `compact` (§7.3.1);
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
- **Which path — read from the store (D34, D42).** `vectorizeMcpTools` takes no `binding` option:
  it reads the store's binding and fill source (through `IRagDecorator.inner`). A bound store →
  the source's `fill`, the store's creation (§3.10); an unbound store → the 30.1.0 path. So every
  creation caller — the builder's fill, `fillToolsBinding`, `rag-eval` — writes a store the way its
  binding and source say, and none can forget to pass them (§6.3, §6.4). A reconnect's
  `toolsChanged` calls `vectorizeMcpTools` only for an unbound store (30.1.0): `revectorizeTools`
  writes nothing into a bound one (D46). The live path below is what
  `ToolsFillContext.indexLiveTools` runs.
- **With a profile (the live path):** `vectorizeMcpTools` builds `ToolItem`s (exposed name, provenance's original
  name, record key, description, `parameters` read from the tool's `inputSchema`, and
  `definitionChars` of the exported definition) and calls `bound.index(items)`. It reads the
  schema generically (top-level `properties`, `required`, string `enum` / `const`); no server is
  special-cased.
- **A profile needs no raw writer on the bound store.** 30.1.0 returns early (no fill, status
  unknown) when the tools store has no `writer()`. That guard belongs to the 30.1.0 path only:
  `IRag.writer` is optional, `StrategyRag` preserves its absence, and a binding may expose a
  query facade while its `index` writes through the profile's own backend. With a binding,
  listing, `ToolItem` building and `bound.index` run whether or not `bound.rag.writer()` exists,
  and the catalog status is published from the `IndexReport`. Without a binding, a store without a
  writer is still skipped before any listing, as in 30.1.0.
- Accounting counts **items** (`vectorized` = items with every record written; `failed` = item
  names). The `toolCatalog` health counters keep their meaning (tools), plus `records` and
  `profile` (carried by `ToolCatalogStatus`, S3).
- Every `IndexReport.notes` entry is logged as a warning naming the tool (S1, §7.3.2).
- The server reaches this path from outside libs through `fillToolsBinding` (§6.3) — the same
  function; the binding it is given must be the one its store carries (else it throws). No
  second filling path exists.
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
- A store filled by the deploy step (`prebuilt`, §6.5) is kept current by that step: a new corpus of
  the **same** profile and embedder replaces changed records and removes dropped ones in place; a
  different profile or embedder still needs a fresh collection (the deploy step does not remove
  records it never listed, and a running process refuses a mismatching store at creation).
- In-memory tool stores (rebuilt every boot) need nothing.

### 7.9 A profile for any other MCP server — built by the consumer (goal 9)

The shipped strategies cover the two common shapes (§2.5) with no server's conventions. Where none
fits a server, the consumer **builds its own profile from the contracts** and uses it in the
pipeline. The contracts are enough for that; nothing in the library has to change.

**What a consumer may replace, piece by piece:**

| To change | Implement | Example reason |
|---|---|---|
| a record view | `IToolFacet` | the server puts the object in a URI template, a tag or an `x-` schema annotation |
| the provider text (the `full` record, the reranker's text) | `IToolTextComposer` | the objects are named only in an enum (try `EnumValuesToolText` first) |
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
  last-write-wins guarantee: concurrent writers of the same item — in one process or across
  processes — are the store backend's responsibility. An interrupted replacement can leave stale records; readers never see
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
- Optional reranker, e.g. `ProbabilityReranker` with `PASSAGE_QUESTION` over Jev, or
  `RelevanceReranker` over `SapAiCoreRelevanceDecision` (Cohere); it reads the item's `text`.
- Cut: the consumer's `IItemCut`; `FixedItemsCut(3)` recommended (a ceiling under the caller's k).
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
| span `retrieval` (child of the request trace, via injected `ITracer`) | tracer: yes | attrs `store`, `strategy`, `sources`, `candidates.records`, `items.collapsed`, `items.returned`, `decomposer`, `subqueries`, `rerank.outcome` (`none\|ok\|fallback\|error`), `rerank.error` (message), `orphans`, `hydration.reads` (canonical records read by `getById`, §4.6), `cut.name`, `cut.tokens` / `cut.budgetTokens` (cuts with `ISizeBoundedCut`, §4.10) |
| `IRetrievalMetrics.retrievalOutcome` counter | new small interface on the same metrics backend | attrs `store`, `strategy`, `outcome` ∈ `ok`, `rerank_fallback`, `rerank_error`, `decompose_error`, `orphan`, `over_budget` (§4.10; replaces `empty` when the top item alone is over the budget), `empty` |
| session step `retrieval_rerank_error` | yes (30.1.0 name kept) | unchanged; also emitted for a failed output check (§4.8) |
| `/health` | yes | `metrics.retrievalOutcome` when the metrics implement `IRetrievalMetrics`; `components.toolCatalog.records` / `.profile` |
| request logger | yes | reranker LLM / decision calls, as today (`component: 'rerank'`) |

- **A reranker error is always observable under a profile.** A wrong or missing score count from
  any reranker (`ProbabilityReranker`, `RelevanceReranker`, LLM, or a consumer's) → `RERANK_ERROR`
  → counted (`rerank_fallback` or `rerank_error`), on the span, as a session step. Never silent.
- With Cohere, a bad `/rerank` answer is caught twice: `SapAiCoreRelevanceDecision` returns a
  `DecisionError` (§5.3), and `RelevanceReranker`'s output check (§5.2) turns any error into
  `RERANK_ERROR`.

### 9.2 The 30.1.0 rerank strategies too

- `RerankedRetrieval` and `RerankAllRetrieval` accept the same optional `telemetry` (additive
  constructor option).
- This closes the goal's evidence item ("a fallback is only a session step") for consumers that do
  not adopt profiles.
- **Telemetry only — no behaviour change (S4).** The §4.8 output check is **not** applied to the
  30.1.0 strategies: there a short reranker answer is accepted as in 30.1.0 (goal 4). A failed
  rerank is counted `rerank_fallback`, a success `ok`. The output check stays in `StagedRetrieval`.
- `InMemoryMetrics` and `NoopMetrics` implement `IRetrievalMetrics`. No new log sink, no new logger.

### 9.3 Failure policy

- `onFailure: 'stage1'` (default) = 30.1.0: stage-1 order, counted as `rerank_fallback`. The
  returned scores are the stage-1 scores (never a mix with reranked ones); a `ScoreFloorCut` is
  never combined with this fallback — rejected at construction and by the YAML validator (§4.7).
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
| All contracts of §3 (incl. `IProbabilityDecision`, `IRelevanceDecision`, §3.9) | `@mcp-abap-adt/llm-agent` | shared by libs, the reranker package, server-libs, provider packages and consumers |
| `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `PROBABILITY_RERANK_DEFAULT_*` | **new** `@mcp-abap-adt/llm-agent-reranker` | §5.4 — rerankers carry no vendor specifics; one vendor-neutral package (goal decision 2026-10-05) |
| deprecated re-exports of every moved / renamed reranker name; `wrapProbabilityDecision`, `wrapRelevanceDecision` (+ `wrapDecisionModel` alias) | `@mcp-abap-adt/llm-agent-libs` | §5.4, §13 |
| `StagedRetrieval`, `ItemPool`, cuts (incl. `TokenBudgetCut`), size estimators, `MaxScoreCollapse`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `SharedItemsProfile` | `@mcp-abap-adt/llm-agent-libs`, `src/collections/` (small modules) | the retrieval built-ins, rerankers and the builder that uses them already live here; `llm-agent-rag` is the backend/embedder factory layer **below** libs and has no rerankers or LLM steps |
| `SapAiCoreRelevanceDecision`, `SapAiCoreRelevanceConfig`, `FetchLike` | **new** `@mcp-abap-adt/sap-aicore-decision` | §5.4 — one package per vendor and role, like `typesafe-decision` |
| YAML resolver + validation (`rag.profiles`; `decision.provider: sap-aicore`; the provider → kind table); the `makeRelevanceDecision` seam type; `makeProbabilityDecision` (renamed seam) + its deprecated alias `makeDecisionModel` | `@mcp-abap-adt/llm-agent-server-libs` | beside `resolve-retrieval.ts`, `decision-config.ts` and the probability seam type |
| `createMakeProbabilityDecision` (renamed from `createMakeDecisionModel`; `make-decision-model.ts` → `make-probability-decision.ts`), `createMakeRelevanceDecision` with the `sap-aicore` arm (builds `SapAiCoreRelevanceDecision`, resolves `credentialRef`) | `@mcp-abap-adt/llm-agent-server` (the app's composition root) | `make-relevance-decision.ts`, beside `make-probability-decision.ts` |
| `IRetrievalEmbedderOwner` implementations | `llm-agent` (`VectorRag`), `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | where the stores are |

- Decided — D1 (libs, not a new `llm-agent-collections` package), D2 (own provider package
  `sap-aicore-decision`) and D24 (one reranker package) (§17).
- **Build and publish order:** `llm-agent` → `llm-agent-reranker` → `typesafe-decision`,
  `sap-aicore-decision` (each depends only on `llm-agent` and the `interfaces-auth` peer) → … →
  `llm-agent-libs` (depends on `llm-agent-reranker`) → `llm-agent-server-libs` →
  `llm-agent-server`; all at the same version.
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
- **Renamed, old names kept as deprecated aliases until the next major** (goal decision
  2026-10-05) — nothing a 30.1.0 consumer imports stops compiling:

  | Old (30.1.0) | New | Where the old name stays |
  |---|---|---|
  | `IDecisionModel` | `IProbabilityDecision` | `@mcp-abap-adt/llm-agent` (`type` alias) |
  | `DecisionReranker` | `ProbabilityReranker` (in `@mcp-abap-adt/llm-agent-reranker`) | `@mcp-abap-adt/llm-agent-libs` root (`const` + `type` alias) |
  | `DecisionRerankerOptions` | `ProbabilityRerankerOptions` | libs root (`type` alias) |
  | `DECISION_RERANK_DEFAULT_TASK`, `DECISION_RERANK_DEFAULT_CRITERIA` | `PROBABILITY_RERANK_DEFAULT_TASK`, `PROBABILITY_RERANK_DEFAULT_CRITERIA` | libs root |
  | `wrapDecisionModel` | `wrapProbabilityDecision` | libs root |
  | `BuildAgentDeps.makeDecisionModel` | `BuildAgentDeps.makeProbabilityDecision` | `@mcp-abap-adt/llm-agent-server-libs` (`BuildAgentDeps` keeps the optional `@deprecated` member, same type; both supplied → startup error naming both) |
  | `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` from libs | the same names from `@mcp-abap-adt/llm-agent-reranker` | libs root (re-export, deprecated path) |

  Every alias carries `@deprecated` naming its replacement. **Migration note** (CHANGELOG): import
  rerankers from `@mcp-abap-adt/llm-agent-reranker`, use the new names; a consumer's own
  `IDecisionModel` implementation needs no change (same type). **A consumer with its own
  composition root** renames the key `makeDecisionModel` → `makeProbabilityDecision` in its
  `BuildAgentDeps` (same function, same signature); until it does, `makeDecisionModel` keeps
  working (deprecated). Supplying **both** keys is refused at startup with an error naming both —
  remove `makeDecisionModel`. A behaviour change: none for a consumer supplying one of them.
- **A bound tools store is filled once, at its creation; where its records come from is the
  consumer's fill source** (§3.10, §6.3, §6.5). Without a profile nothing changes. With one and no
  source chosen, `live` is 30.1.0's behaviour through the profile. **Migration note** (CHANGELOG):
  a consumer that ships a tools corpus builds it in its build step with `buildToolsCorpus` and
  either loads it at start (`ToolsCorpusLoader`, in-memory store) or writes it in its deploy step
  with `deployToolsCorpus` and binds the store with `PrebuiltToolsStore` (persistent store); the
  `profile` / `embedder` names must be the same in the build step and at run time.
- **Behaviour note — a bound profile is not re-indexed on `toolsChanged`** (D46). With a profile
  bound, a reconnect that reports `toolsChanged` writes nothing into the tools store, whatever its
  fill source (one `mcp` debug line). A consumer who plugs an MCP server in at runtime fills the
  new tools in its own pipeline (`bound.index`). Without a profile, 30.1.0's re-vectorize on
  `toolsChanged` is unchanged. **Migration note** (CHANGELOG): none for a 30.1.0 consumer —
  profiles and fill sources are new in this release.
- **Single-flight worker construction is not in this release** (D45): the 30.1.0 race of two
  sessions constructing one worker together after a drain is unchanged here and tracked as a
  separate issue (§15).
- **The caller's k caps every cut** (approved review finding 1). 30.1.0 has no item cuts, so
  nothing released changes; `FixedItemsCut` is new in this spec and is a ceiling from the start.
- Added, all optional: the contracts of §3 (incl. `IToolsFillSource`, §3.10), one builder method,
  the offline corpus API and the four fill sources (libs, §6.5), the YAML section `rag.profiles`
  (key `tools` only, S8; its `fill` key), the value `sap-aicore` for the existing `decision.provider` (with
  `deploymentId`, `model`, `resourceGroup`), optional health fields, the embedder capability,
  telemetry options on the 30.1.0 rerank strategies, the optional seam
  `BuildAgentDeps.makeRelevanceDecision`, `BuildAgentDeps.makeProbabilityDecision` (the renamed
  probability seam; `makeDecisionModel` stays its deprecated alias), two new packages (`@mcp-abap-adt/llm-agent-reranker`,
  `@mcp-abap-adt/sap-aicore-decision`).
- **A consumer with its own composition root** that wants Cohere supplies `makeRelevanceDecision`
  (build `SapAiCoreRelevanceDecision` with a bearer credential and `apiBaseUrl`); its existing
  probability seam (`makeDecisionModel`, or `makeProbabilityDecision` after the rename) compiles
  unchanged, since `SmartServerDecisionConfig` only gains a provider value and optional fields
  (§17.5).
- Release: a **minor** version. The new packages are published at the same version, in the order
  of §11.
- Opting in on a persistent tools store = a fresh collection (§7.8).
- **k is unchanged:** the overall limit of a retrieval, now counted in items under a profile, with
  or without a decomposer. `docs/INTEGRATION.md` documents the `IQueryDecomposer` slot and its
  budget contract (§4.5).
- **Tool-set shapes:** `small-set-jev`, `EnumValueToolIndexer` and `TokenBudgetCut` are opt-in
  like every profile and strategy; nothing about the default changes.
- **Profile records are addressed by owner-scoped ids** (§3.1): `rag.getById(itemId)` on a profiled
  store finds nothing; use `bound.get(ref)`. Documented in `docs/INTEGRATION.md`.
- Docs updated in the same PR: `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`,
  `docs/PERFORMANCE.md`, `docs/EXAMPLES.md` (YAML, both decision providers),
  `docs/TROUBLESHOOTING.md` (rerank error metric; switching profiles needs a fresh collection),
  `docs/DEPLOYMENT.md` (`DECISION_SERVICE_KEY`; the tools corpus build and deploy steps, §6.5), `docs/SECURITY_THREAT_MODEL.md` (Cohere receives
  the query and the candidate texts), `CLAUDE.md` key API notes, both new packages' `README.md`,
  the `typesafe-decision` README (`IProbabilityDecision`; one of two decision kinds), the
  `llm-agent` and `llm-agent-libs` READMEs (renames, reranker package), `scripts/rag-eval/README.md`;
  every page that names a renamed or moved symbol uses the new name and says the old one is a
  deprecated alias.

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
  (several → none + `IndexReport.notes` `ambiguous-discriminator` with the candidates, through
  `IIndexNoteSource` — S1); optional enums ignored; `NamedDiscriminator` — present, absent, fewer
  than 2 values. `EnumValueToolIndexer` and `IntentRecordIndexer` forward notes; the binding
  collects them from the primary and companion indexers; no notes → no `notes` key.
- `TokenBudgetCut`: rank-order prefix; stops at the first item that does not fit (no skip-ahead);
  `min(requestedK, maxItems ?? requestedK)` ceiling; `limit()` = that ceiling; top item over budget → empty,
  `over_budget` counted (through `ISizeBoundedCut`, S6), with `cut.tokens` / `cut.budgetTokens`
  on the span; items never truncated; `ToolDefinitionSizeEstimator` uses `definitionChars`, falls
  back to text length; `isSizeBoundedCut` true for `TokenBudgetCut`, false for the count cuts.
- `recordId`: table — every scope; `:` `/` `#` inside owner key / item id do not collide
  (`u` + `a/b` + `c` ≠ `u` + `a` + `b/c`); ids over 200 characters become `h:` + 64 hex, stable
  across calls; every id ≤ 255 characters.
- Tools indexing: deterministic ids; canonical id = `recordId(global, itemId, 'full', 0)`;
  `itemText` only on non-canonical
  records; one `intent` record per tool, `generated: true`, in the tool store (`record`) or only in
  the companion (`companion`); no intent text in any provider record; `generatedFrom` written as
  provenance; every `index` asks the intent source again (no skip, S2); each indexer's
  `maxRecordsPerItem` bounds what it writes.
- Companion records (S7): the canonical lists them in `companionRecordIds`; `remove` deletes them
  from the companion store; re-indexing with fewer intents deletes the unlisted old companion
  records; a listed companion the binding does not have is left as is.
- Variants: each `mcpToolsVariants` factory returns exactly the strategy instances of §7.4 (pool,
  collapse, reranker, cut), with no decomposer unless the consumer passes one; `baseline` binds
  nothing; intents and a decomposer refused on `baseline`; **no variant contains `NameTailFacet`**;
  `small-set-jev` = `FacetedToolIndexer([])` + `ItemPool(poolItems)` + `MaxScoreCollapse` +
  `ProbabilityReranker` + `FixedItemsCut(3)`, and refuses a missing `poolItems` /
  `probabilityDecision` (type-level); `facetedCohere` builds a `RelevanceReranker` and does not
  accept an `IProbabilityDecision` (type-level); **no variant contains `EnumValueToolIndexer` or `TokenBudgetCut`**.
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
  applied once, at most `min(k, cut.limit(k))` items returned; **decomposer:** none → one run; `[]` →
  one run with the whole budget; each sub-query reranked against its own text and kept to its
  `k`; union de-duplicated by owner-qualified item; budgets summing to > k, `k < 1`, empty text or
  a decomposer error → `DECOMPOSE_ERROR`, counted, never a silent fall-back; at most `budget`
  items with any decomposer; `keepStage1Top` counted inside k; collapse keys on the owner-qualified item;
  `keepStage1Top`: pinned items first in stage-1 order, each carrying its **reranked** score (never
  the embedding score) — under a `ProbabilityReranker` and under a `RelevanceReranker` (scores
  outside [0, 1]); the rest by reranked score; `keepStage1Top` > 0 with `ScoreFloorCut` throws at
  construction with its message; `ScoreFloorCut` with `onFailure: 'stage1'` throws with its message
  (allowed with `'error'` and without a reranker); a failed rerank under `'stage1'` with
  `keepStage1Top` returns the stage-1 result, ids and scores; every cut; telemetry (span
  attributes, counter, session step).
- Config validator: `compose` with `cut: { score-floor: … }` and a reranker refused unless
  `onFailure: error`.
- `SapAiCoreRelevanceDecision` (injected `fetch`): URL, `AI-Resource-Group` header (default
  `default`), bearer asked per call, ONE call per `score`, body `{model, query, documents, top_n}`
  with documents in passage order; `results[{index, relevance_score}]` → `scores[{index, score}]`;
  empty query / passages / passage → `DECISION_INVALID_REQUEST` with no call; missing / duplicate /
  non-integer / out-of-range index, wrong count, non-finite score, no `results` → `DECISION_ERROR`
  (never zero-filled); a score outside [0, 1] is accepted (not a probability); HTTP 401/403 →
  `DECISION_AUTH`, 429 → `DECISION_RATE_LIMITED`, 400/404/422 → `DECISION_INVALID_REQUEST`, 5xx /
  network → `DECISION_UNAVAILABLE`; `signal` → `DECISION_ABORTED`; the token never appears in an
  error message.
- `RelevanceReranker`: batches by default (defaults 48000 / 4, as `ProbabilityReranker`); a
  small candidate set under the default budget → one `score()` call; candidates over the budget →
  several calls (up to `concurrency` in flight), each call's scores mapped by its own indices, and
  the scores of all calls **merged into one order by score** (a passage scored highest in a later
  batch comes first); `score` = the relevance score, sorted descending, ties in input order; a
  passage larger than the budget is a batch of its own; wrong count, duplicate index,
  out-of-range index, non-finite score (checked per call) → `RERANK_ERROR`; a `DecisionError` →
  `RERANK_ERROR`; any failed call fails the whole rerank; a non-positive or non-integer
  `maxBatchTokens` / `concurrency` throws. Over `SapAiCoreRelevanceDecision` + fake fetch: one
  `/rerank` call per batch.
- `ProbabilityReranker`: the 30.1.0 `DecisionReranker` tests, moved unchanged with the class.
- Renames and aliases: `IDecisionModel` is assignable both ways with `IProbabilityDecision`
  (type check); libs' `DecisionReranker === ProbabilityReranker`, `DECISION_RERANK_DEFAULT_TASK ===
  PROBABILITY_RERANK_DEFAULT_TASK`, `wrapDecisionModel === wrapProbabilityDecision`, and libs'
  `LlmReranker` / `NoopReranker` / `TOOL_QUESTION` / `PASSAGE_QUESTION` are the reranker package's
  objects; a 30.1.0-style import file compiles unchanged.
- `wrapRelevanceDecision`: logs `component: 'decision'` per successful call (estimated tokens when
  no `usage`); no logger → no-op; idempotent.
- Text composers: `ParameterNamesToolText` reproduces the former `full` text byte for byte;
  `EnumValuesToolText` / `SchemaToolText` add only provider words (values; description first
  clauses); `FacetedToolIndexer` without `text` = C0; the composer's text is the non-canonical
  records' `itemText`.
- Caller's k caps every cut: `FixedItemsCut(5)` with k=2 → 2 items, `limit(2) = 2`;
  `ScoreFloorCut({ minItems: 3, maxItems: 8 })` with k=2 → at most 2; `TokenBudgetCut({ maxItems:
  5 })` with k=2 → at most 2; a consumer cut whose `limit` returns more than k → `StagedRetrieval`
  still returns ≤ k; with a decomposer, the budget is `min(k, cut.limit(k))`.
- Cleanup failures: a replacement whose stale delete fails (a writer that fails `deleteByIdRaw`
  for one id) → the item is in `failedItems` (`cleanup-failed: …`), not in `indexedItems`; the
  canonical lists the id in `staleRecordIds` (or `staleCompanionRecordIds` for a companion); a
  retry `index` deletes it and clears the list; `remove` after that leaves nothing in any store; a
  `remove` whose delete fails keeps the canonical and returns an error, and a second `remove`
  completes.
- `vectorizeMcpTools`: golden test of the default path; item accounting with a profile; one batch
  for all records; a binding whose `rag` has no writer is still filled through its own `index`
  (catalog complete, items retrievable), while a writerless store without a binding is skipped as
  in 30.1.0; F1 regression through `StrategyRag` and `FallbackRag`.
- F2 / F3.
- Precedence: a profiled store is skipped by `RerankHandler`; binding is idempotent (server +
  builder).
- Server fill (§6.3, D31), through `SmartServer.start()`: ready clients (`cfg.mcpClients`) + a YAML
  profile → store filled, items retrievable, `/health` `toolCatalog` complete with `records` and
  `profile`; an injected `connectMcp` seam → the same; plugin clients → included; no profile +
  ready clients → no profile record, no 30.1.0 record, no `toolCatalog` on `/health` (30.1.0
  unchanged); a client whose `listTools()` fails → `clientFailures: 1`, `complete: false`,
  `/health` `degraded`, the good client's tools filled; main + a worker reading the main store +
  a worker with its own store and clients → each store's records written exactly once.
  `fillToolsBinding` and `HealthCheckerDeps.toolCatalog` unit-tested in libs.
- Worker identity (D32): an injected `connectMcpWithDescriptors` seam with labelled servers, one
  configured slot missing and a tool name on two servers + a worker with its own store and no
  own clients → the worker's store holds the main catalog's names and slot-based ids
  (`tool:<slotIndex>:<name>` over the configured count), and a worker run offers its LLM exactly
  the colliding names the store retrieves (`<label>__<tool>`) — none dropped, no `s<i>__` name.
- Companion isolation (D33): main + a worker with its own store → two companion stores, a reader
  worker → none; main + a worker with their own stores and clients, the same tool name with
  different descriptions and intents → each retrieves its own item by its own intents and not by
  the other's; re-indexing and then removing the main's item leaves the worker's companion record
  and retrieval intact; a non-in-memory companion store with a worker that has its own `rag` →
  startup error naming the worker.
- Filling follows the store and happens once, at creation (D34, D35, D41), one test per lifecycle
  path:
  - **startup** — the server fill tests above (main, workers on own and shared clients); on
    `yamlBuilderConnect` (the in-process MCP stub) a worker with its own store and no own clients
    holds the stub's tools right after `start()`, before any session (D38);
  - **`toolsChanged`** (`McpToolRegistry`, libs), D46:
    - a store bound by `bindToolsProfile` is **not written** on `tools-changed`: a reconnect with an
      updated description and a newly added tool → no `bound.index` call, no raw write, no listing,
      the fill source's `fill` not called, the store exactly as created, no warning logged;
    - a bound store behind a `FallbackRag`: the initial fill (`vectorizeMcpTools` on the
      `FallbackRag`) still finds the binding and fills through the profile, and the reconnect
      still finds it and writes nothing;
    - an unbound store keeps 30.1.0 behaviour: the reconnect re-vectorizes with the 30.1.0 records
      (the existing reconnect tests, unchanged);
  - **`PUT /v1/config`** and **hot reload** → the drained workers are constructed again by the next
    session. The hot reload is driven through the server's reload entry point (the
    `ConfigReloadWatcher` the server holds, `_onReload`, awaited) — no `fs.watch`, no debounce
    polling (D39). One thin test pins that the file watcher's `reload` event calls that entry point.
    Covered:
    - a worker with its own in-memory primary + companion store on the shared clients (labelled
      slots, a collision);
    - a worker with DI clients.

    Each rebuilt store is a new instance carrying its binding. It is filled once by the
    construction and retrievable by its primary records and by its companion intents, under the
    names its agent dispatches by (`<label>__<tool>`, ids `tool:<slotIndex>:<name>`; array order
    for the DI clients); the following re-wire fills nothing.
  - **Never refilled (D41):** a worker's client whose `listTools()` fails at startup → nothing
    indexed, the summary line logged; after the client recovers, re-wires still index nothing —
    the store stays as created.
  - **A construction whose fill throws leaves no cached worker:** a lazy rebuild whose fill throws
    → that session's worker build fails and the cache holds no entry for the worker.
  - `fillToolsBinding` refuses a binding its store does not carry; `vectorizeMcpTools` has no
    `binding` option (the libs tests bind through `bindToolsProfile`).
- Fill sources (§3.10, libs):
  - no source → `live`: the existing profile fill tests, unchanged;
  - `ConsumerToolsFill`: the builder's auto-connect writes nothing and reports no status;
  - a consumer's own source receives the binding, the target and `indexLiveTools`, and its status
    is the catalog status;
  - `bindToolsProfile` on a store already bound with a different explicit source → throws.
- Offline corpus (§6.5, libs), with an embedder that counts its calls:
  - `buildToolsCorpus` → one record per profile record (ids, texts, metadata equal to what
    `bound.index` writes into a live store), every vector of one dimension, companion records under
    their store name; a failing item → throws naming it; no items → throws;
  - `parseToolsCorpus(JSON.stringify(corpus))` round-trips; a changed record (hash mismatch), a
    wrong format or a mixed dimension → throws;
  - `deployToolsCorpus` into a `VectorRag` (+ companion): **zero embedding calls**; retrieval through
    the binding finds the tools and never returns the service record; a second deploy of the same
    corpus → `unchanged: true`, no write; a corpus with one changed and one dropped tool → only the
    changed records upserted, the dropped tool's records deleted (primary and companion); a
    store without precomputed writes → throws; a failed delete → throws, and a rerun deletes it;
  - `ToolsCorpusLoader`: loads with zero embedding calls, the catalog status complete with `records`;
    a mismatching `profile` / `embedder` / `profileName` / companion set → throws naming it;
  - `PrebuiltToolsStore`: a deployed store → status from the service record, **no write** (a writer
    spy sees none); a store never deployed → throws "not deployed"; a mismatching identity →
    throws.
- `StagedRetrieval`: a hit carrying `serviceRecord` is dropped — not an item, not an orphan.
- Server `fill` (§6.2): `{ corpus: … }` on an in-memory store with ready clients → the store holds
  the corpus and the embedder saw no call at startup; `{ prebuilt: … }` over a store the test
  deployed → `/health` complete, no write; every `fill` validation rule (unknown name, missing
  fields, `prebuilt` over `in-memory`, `corpus` with a worker that has its own `rag` and own clients).
- YAML: every validation rule of §6.2 through the real `resolveSmartServerConfig` (incl. a
  `rag.profiles` key other than `tools` refused, S8; a variant against the wrong kind of decision;
  `question` / `task` refused for a relevance provider; `decision.provider: sap-aicore` fields; an
  unknown `text` composer); `reranker: decision` builds `ProbabilityReranker` under `typesafe` and
  `RelevanceReranker` under `sap-aicore`, in `rag.profiles` and `rag.retrieval`; a missing seam of
  the needed kind → startup error naming it (`makeProbabilityDecision` / `makeRelevanceDecision`);
  the probability seam's alias: `makeDecisionModel` alone builds the probability decision as
  `makeProbabilityDecision` does, `makeProbabilityDecision` alone likewise, **both** → the
  SmartServer constructor throws naming both; the app supplies `makeProbabilityDecision` (built by
  `createMakeProbabilityDecision`) and not `makeDecisionModel`; the app's `makeRelevanceDecision` builds
  `SapAiCoreRelevanceDecision` from `decision:` (default ref `DECISION` → bearer + `apiBaseUrl` from
  `DECISION_SERVICE_KEY`; a named ref; `credentialRef` and `provider` never reach the provider).

### 14.2 Conformance kit

`@mcp-abap-adt/llm-agent/testing/collection-profile-conformance` (beside
`rag-filter-conformance`): for any `ICollectionProfile` — owner keys and visibility on every
record; deterministic, owner-scoped ids (`recordId`; the same `itemId` under two owners → disjoint
ids); every returned item hydrated from its canonical record; **at most `min(k, cut.limit(k))` ≤
k distinct items returned, with or without a decomposer** (S9 as amended by review finding 1: the
§4.5 budget — `k` for `TopItemsCut`, `min(k, n)` for `FixedItemsCut(n)`; the kit also runs an
adversarial decomposer whose budgets overrun the budget and expects `DECOMPOSE_ERROR`); **every
shipped profile is called with a k smaller than its default cut** (e.g. k=2 for `faceted*` and
`small-set-jev`) and returns ≤ k; a stale delete that fails is reported as `cleanup-failed` and
retried by the next `index`;
no record outside the caller's identity filter returned; generated records never canonical;
**with a size-bounded cut, the summed size of the returned items ≤ the budget** (by the cut's own
estimator) and no item is truncated. A consumer runs it against its own profile.

### 14.3 Measurement harness

- `scripts/rag-eval` gains `--variant baseline|faceted|faceted-cohere|faceted-jev|small-set-jev`, or a
  composition by strategy name (`--indexer`, `--facets`, `--discriminator`, `--intents
  off|record|companion`, `--pool-items`, `--reranker none|decision`, `--cut`,
  `--budget-tokens`, `--text parameter-names|enum-values|schema`; `--decision-provider
  typesafe|sap-aicore` with `--rerank-deployment` / `--rerank-model` / `--rerank-credential-ref`
  picks the decision and with it the reranker kind, as `decision:` does),
  any tools snapshot file (not tied to one server), and
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
| Removing the records of a tool a server no longer lists (`notifications/tools/list_changed` → `toolsChanged`) | not changed: the records stay, as in 30.1.0 (§6.3, D40); a bound store is not written on `toolsChanged` at all (D46) |
| An MCP server plugged in at runtime, or one whose tool list changes while the pipeline runs, under a bound profile | **the consumer's pipeline** (D46): a consumer who builds such a pipeline does its own checks and filling in it (e.g. `bound.index` with the new tools). The library writes nothing into a bound store on `toolsChanged` |
| Coordinating concurrent writes to a persistent store across processes | the store backend's responsibility (§3.3, D13) |
| **Single-flight worker construction and drain ordering** — a pre-existing 30.1.0 race in `WorkerRegistry` (`packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts`), unrelated to profiles: (1) `WorkerRegistry.build` checks `cache.has(name)` and on a miss awaits a primary `buildSubAgent`; nothing is recorded between the check and `resolveWorkerLlmSet`'s `cache.set`, so two sessions that miss together (the first two after `PUT /v1/config` or a hot reload drained the cache) both construct the worker — two sets of worker stores, two builder handles, two MCP connections for an own `mcp:`; the later `cache.set` wins and the other handle leaks, or `backfillWorkerCacheFromHandle`'s defensive `close` closes a handle a running agent still uses; (2) `resolveWorkerLlmSet` publishes the entry before the primary build's `backfillWorkerCacheFromHandle`, so a concurrent session can re-wire with the parent's MCP clients instead of the worker's own; (3) `drain()` clears the cache while a construction is in flight, and that construction then publishes into the drained cache — built before the reload, served after it, closed by nobody until the next drain. With a tools profile each duplicate construction also fills its own new store (one more listing and indexing) | **a separate issue** (D45), filed from this row; it needs one construction per worker name and config generation and a drain that waits for, and discards, the constructions it overtook. Not a RAG concurrency protocol: concurrent store writes stay the backend's (D13) |
| A refill API, a fill memo or a retry of an incomplete fill | not built: a store is filled once at creation (goal decision 2026-10-05, D41) |
| Shared items in the server YAML | D6 |
| A query-decomposition **implementation** (splitting multi-step queries) | the consumer: it injects its own `IQueryDecomposer` into the slot `StagedRetrieval` provides (§4.5); the framework ships none and no variant uses one (goal decision 2026-10-05) |
| BM25 identifier tokenization (`ZDEMO_D_TEST` → `test`) | separate change to the in-store scoring (`ISearchStrategy` / tokenizer) |

---

## 16. Architecture-principle check

1. **Built on existing components:** `IRag`, `IRetrievalStrategy`, `StrategyRag`,
   `applyRetrievalStrategy`, `IReranker`, `ProbabilityReranker` (ex-`DecisionReranker`), `TOOL_QUESTION`,
   `vectorizeMcpTools`'s batch path, the `makeRag` / `makeProbabilityDecision` (ex-`makeDecisionModel`) seams, the decision
   contract (renamed `IProbabilityDecision`; relevance is its own contract because it is a
   different decision, §3.9), `DecisionError` and its codes, `IRagDecorator`,
   `matchesRagIdentity`, `IBearerCredential`, metadata `ttl`.
2. **The app is the example:** SmartServer selects profiles and rerankers from YAML through the
   same builder API.
3. **Interfaces:** consumers depend on `ICollectionProfile` / `IRetrievalStrategy` / `IReranker`.
4. **ISP:** new small interfaces; `IRag`, `IReranker`, `IProbabilityDecision`, `IMetrics`,
   `IRetrievalStrategy`, `IItemIndexer`, `IItemCut` not grown — notes and size budgets are optional
   capabilities (`IIndexNoteSource`, `ISizeBoundedCut`).
5. **Strategies:** collapse, cut, query decomposition, reranker, intent source, source selector, group
   partitions, indexing, provider text, facets, intent sources, candidate pool, the tools fill
   source — all injected. A variant is a
   named set of instances, never flags; the library picks no k, no pool and no reranker by guessing.
   The consumer makes the main behaviour choices by choosing strategies; a default composition
   fills only what it left open, and is the only place a tuned number lives, next to its
   measurement (§7.1).
6. **File size:** new logic in `src/collections/*` and the new packages; `builder.ts` and
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
- the Cohere reranker in this PR (§5) — as an `IRelevanceDecision` (`SapAiCoreRelevanceDecision`)
  in its own package `sap-aicore-decision`, adapted by the new `RelevanceReranker`; Jev stays the
  `IProbabilityDecision` adapted by `ProbabilityReranker` (goal decision 2026-10-05, the row that
  replaced "Cohere as one more `IDecisionModel`");
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
| D13 | **Replacing an item is not atomic; no generations, commit markers, incarnations or locks.** Concurrent writes — in one process or across processes — are the store backend's responsibility; the library serializes nothing; interrupted replacements may leave stale records (§3.3). *Wording amended 2026-10-05 (§17.10): it no longer says the writer serializes.* | The store owns concurrency (standing rule); collections are filled once, read-mostly. Readers stay safe through D15, not through write coordination. |
| D14 | **Physical record ids are owner-scoped:** `recordId(owner, itemId, kind, n)`, one function for `index`, `get`, `remove`, hydration and collapse (§3.1). | Every backend keys records by id alone (`InMemoryRag.upsert`, `VectorRag`, pg/HANA primary key, Qdrant UUID of the id); with `id = itemId`, two users' `case-42` would overwrite each other. |
| D15 | **Every returned item is hydrated from its canonical record**, owner-checked; `itemText` is a reranking shortcut only; a hit without a canonical record is dropped and counted (§4.6). | Makes D13 safe for readers and returns the item whole (incl. `data`) even when only a secondary record matched. |

Recommendations approved by the user on 2026-10-05:

| # | Decision | Where |
|---|---|---|
| D1 | Default implementations live in **`llm-agent-libs`** (`src/collections/`), not a new `llm-agent-collections` package. | §11 |
| D2 | Cohere on SAP AI Core in its **own package** — amended twice by the goal on 2026-10-05: `@mcp-abap-adt/sap-aicore-decision` with `SapAiCoreRelevanceDecision` (an `IRelevanceDecision`); the earlier `sap-aicore-reranker` / `SapAiCoreReranker` and `SapAiCoreDecisionModel` are withdrawn. | §5.3, §5.4 |
| D3 | Companion intents: **one record per tool**, as in `record` placement. | §7.3.3 |
| D4 | Builder skills **coexist** in the tools store (pass-through). | §7.7 |
| D5 | Shared-item visibility: `user` / `group` / `global` as **partitions**; group stores supplied by the consumer (`ISharedItemGroups`). | §8.3 |
| D6 | Shared items: **library API only** in this PR, no server YAML. | §6.2 |
| D7 | Ship `keepStage1Top`, **default 0, counted inside k**, documented as unmeasured without the former split. | §4.7 |
| D8 | Replace the private embedder read with **`IRetrievalEmbedderOwner`** (3 provider packages) in this PR. | §10.1 |
| D9 | Query preparation stays **outside** profiles; #323 is a pipeline fix. | §12 |
| D10 | `SapAiCoreRelevanceDecision` takes **`deploymentId`** in this PR; resolving by model name is a follow-up. | §5.3, §5.4 |
| D11 | Ship `faceted-jev`, marked **"to be measured as one composition on fresh consumer queries before promotion"**. | §7.4 |
| `limit()` | `IItemCut.limit(requestedK)` — the most items a cut returns; the retrieval's budget for a decomposer. Stated as an **upper bound** in items, so `ScoreFloorCut` and `TokenBudgetCut` fit with no signature change (§4.10). | §3.4, §4.5 |

### 17.3 Raised by the server-agnostic amendment

The `compact` measurement (§2.5.1) settles four of them; the user decided the other four (D16, D18, D22, D23) on 2026-10-05.

**Settled by the `compact` measurement** (the user reviews them with the spec):

| # | Question | Resolution | Why |
|---|---|---|---|
| D17 | `TokenBudgetCut` when the top item alone exceeds the budget: empty, or keep the first item? | **Empty + counted** (`over_budget`), as recommended (§4.10). | `TokenBudgetCut` is in no default: it is a guard the consumer injects and sizes (≥ its largest tool). A guard that breaks its own bound is no guard; the conformance kit checks the bound. |
| D19 | `TokenBudgetCut`: stop at the first item that does not fit, or skip ahead to smaller ones? | **Stop**, as recommended; documented as the reason it is not a main cut (§4.10). | Measured: as the main cut a 2k budget gives 0.910 vs 0.970 for k=3 at the same ~1.6k tokens, because it stops early. As a guard it must not reorder the consumer's ranking. Skip-ahead = the consumer's own `IItemCut`. |
| D20 | `coarse` ships with no numbers until the `compact` measurement lands? | **Superseded.** The `coarse` variant (per-value records + token budget) is **withdrawn**; the coarse default is `small-set-jev` with measured numbers: one record per tool + rerank-all + `FixedItemsCut(3)` (§7.4). | Per-value records measured worse (§7.3.2); the token budget measured worse than k (§4.10); one record + Jev over the whole set: 0.970 at ~1.6k tokens. The only required argument left, `poolItems`, is the consumer's tool count, not a tuned number. |
| D21 | Return which enum values matched with a coarse tool (`metadata.matchedValues`)? | **No** — not in this PR. | No default writes per-value records any more, so no default has values to report. A consumer that injects `EnumValueToolIndexer` and wants the hint justifies a new output contract with its own measurement. |

**Decided by the user on 2026-10-05** (each with the recommended option):

| # | Question | Decision |
|---|---|---|
| D16 | The `faceted*` defaults use schema-derived records (`summary` + `parameters`); `ParametersFacet` is **not yet measured** on the fine-grained set. Accept shipping them on the closest measured layouts' figures (LLM-generated `operation` / `object` facets and name-derived facets, both 0.966 at k=5 hybrid, hub spike `spike-facets`) until the consumer check runs? | **Yes** — the name-derived `object` record depends on one server's naming; a default may not. The measured layout stays one line away for a verb-first server (`NameTailFacet`, §7.5). If the check shows `parameters` worse, the fix is a better schema-derived facet, not the convention. Not settled by `compact`: that set has no fine-grained facets. |
| D18 | `RequiredEnumDiscriminator` with several qualifying parameters: no fan-out + `IndexReport.notes`, or fan out over all of them? | **No fan-out + note** — goal 3, never guess; `NamedDiscriminator` or the consumer's selector resolves it. Lower stakes now: it only serves `EnumValueToolIndexer`, which is in no default. |
| D22 | `ToolItem` carries the raw `inputSchema` (for consumer strategies) and `parameters` replaces `parameterNames`. | **Yes** — without the raw schema a consumer cannot build a profile for a server whose signal sits elsewhere in the schema (goal 9); `ToolItem` is new in this spec, so nothing breaks. |
| D23 | `small-set-jev` takes `poolItems` (≥ the tool count) as a required argument and the composition root checks it at startup. Alternative: a new `ICandidatePool` that always takes the whole store (no number at all). | **Required `poolItems` + startup check** — no new strategy class, same shape as 30.1.0's `RerankAllRetrieval.maxCandidates` ("configured, never derived"). A whole-store pool can be added later if consumers ask. |

### 17.4 Decided by the user on 2026-10-05 — S1–S9

*(The Cohere-through-`IDecisionModel` decision recorded here first is replaced by §17.6.)* Still
removed: the `sap-aicore-reranker` package, `SapAiCoreReranker`, the `crossEncoder:` YAML section
and its seam (and with it S5). The new cross-encoder contract is `IRelevanceDecision` (§3.9), a
decision contract — not a reranker contract.

The plan's spec issues:

| # | Issue | Decision | Where |
|---|---|---|---|
| S1 | No channel from an indexer to `IndexReport.notes` | Optional capability **`IIndexNoteSource`** (`notesFor(item)`); the binding collects the notes | §3.2, §7.3.2, §7.6 |
| S2 | "Fill once" intents needed the store inside a pure indexer | **Dropped from this PR**: intents are generated at indexing; caching them is the consumer's concern. `generatedFrom` stays as provenance | §7.3.3 |
| S3 | `ToolCatalogStatus` was missing from §3.8 | Optional **`records`** / **`profile`** on `ToolCatalogStatus`, listed in §3.8 | §3.8, §7.6 |
| S4 | Output check on the 30.1.0 rerank strategies? | **No**: telemetry only, no 30.1.0 behaviour change | §9.2 |
| S5 | Default `credentialRef` of `crossEncoder:` | **Dropped** — there is no `crossEncoder:` any more; `decision:` keeps its `DECISION` default | §6.2 |
| S6 | `StagedRetrieval` could not learn a size cut's tokens | Optional capability **`ISizeBoundedCut`** (`budgetTokens`, `estimator`): `over_budget`, `cut.tokens`, `cut.budgetTokens` | §3.4, §4.10, §9.1 |
| S7 | `remove` left companion records behind | Reserved key **`companionRecordIds`** on the canonical record; `remove` and replacement clear companion records | §3.1, §3.3, §7.3.3 |
| S8 | YAML keys other than `tools` had no store or filling path | **Only `rag.profiles.tools`** in this PR; any other key refused loudly at config resolution | §6.2 |
| S9 | "At most k" contradicted `FixedItemsCut` | The kit checks **at most `cut.limit(k)`** items — amended by review finding 1 (§17.6): `cut.limit(k)` ≤ k for every cut, so "at most k" holds again | §14.2 |

### 17.5 Choices made while writing §17.4 and §17.6 in — for the user's review

Each follows from a decision above or an existing rule. Listed so the user can overrule any of
them.

| Choice | Why | Where |
|---|---|---|
| `SmartServerDecisionConfig` stays **one interface**: `provider: 'typesafe' \| 'sap-aicore'` + optional `deploymentId`, `resourceGroup`; the validator enforces which fields each provider takes | additive for a minor release: a consumer's own probability seam that reads `cfg.baseUrl` still compiles (a discriminated union would break it) | §3.8, §6.2 |
| **A second optional seam `makeRelevanceDecision`**, beside the probability seam — **approved by the user (D29, §17.7)** | the provider decides the kind, and the two kinds are different types. One seam returning a union would break code that calls the seam and uses the result as a probability decision; a tagged result would break every implementer. Two typed seams keep both compiling | §3.8, §6.2 |
| `IRelevanceDecision.score` returns `{ index, score }` entries (not a parallel array) | the shape every rerank API returns; the provider maps without reordering, and the reranker's output check (wrong count / duplicate / non-finite) has something to check | §3.9, §5.2 |
| `IRelevanceDecision` reuses `DecisionError` and its codes; no new code set | every relevance failure already has a fitting code; nothing widens a shared set | §3.8, §5.3 |
| ~~`RelevanceReranker` sends every candidate in ONE call by default; batching only when the consumer sets `maxBatchTokens`~~ — **decided otherwise by the user (D28, §17.7):** relevance scores are comparable for the same query and model (pairwise by contract), and `RelevanceReranker` batches by default like `ProbabilityReranker` (same `maxBatchTokens` / `concurrency` defaults and validation); no single-call mode | a cross-encoder scores each (query, passage) pair independently, so merging batches is sound by contract | §3.9, §5.2 |
| The probability reranker's wording constants are renamed too (`PROBABILITY_RERANK_DEFAULT_*`, aliases kept); the decision vocabulary (`DecisionRequest`, answers, `DecisionError`) is **not** renamed | the constants belong to the renamed reranker; the vocabulary is shared by both decisions (`DecisionError`) or still exactly the probability decision's request/answers — renaming it would churn every implementer for nothing | §1, §13 |
| `wrapDecisionModel` → `wrapProbabilityDecision` stays in libs; new `wrapRelevanceDecision` beside it | decided by its imports: only `llm-agent`; it wraps a decision, not an `IReranker`; its caller is server-libs. It is a usage-logging adapter like `usage-logging-embedder`, not a reranker | §5.4 |
| `assertPositiveInteger` copied into `llm-agent-reranker` | no cycle (libs depends on the reranker package) and no non-contract export in `llm-agent` | §5.4 |
| A named variant is checked against the provider's **kind**: `faceted-cohere` ↔ relevance; `faceted-jev`, `small-set-jev` ↔ probability. `compose` with `reranker: decision` takes either | a name that cites one model's measurement must not silently run the other; the factories' argument types say the same in code | §6.2, §7.4, §7.5 |
| An explicit `question` / `task` is refused when the provider's kind is relevance | a relevance decision reads no wording; accepting it would be a silent no-op | §6.2 |
| `RelevanceReranker` / `SapAiCoreRelevanceDecision` do **no** [0, 1] check | the score is not a probability (§3.9); only finiteness is checked | §5.2, §5.3 |
| Cleanup failures: the stale ids are written **ahead** on the canonical, then settled | a crash between delete and list-update cannot lose an id; retrying a deleted id is a no-op. The cost is one extra canonical write when an item had stale records | §3.3 |
| Three provider text composers ship (`ParameterNamesToolText` default, `EnumValuesToolText`, `SchemaToolText`) as classes, not one class with flags | "no booleans where a strategy is the choice"; each is a measured layout (C0, C0e, C0s) | §7.3.1 |
| No peer on `sap-aicore-auth`; the token exchange is reused through the composition root | verified: the embedder and LLM receive an injected `IBearerCredential` built by `credential-for.ts` with `serviceKeyCredential` | §5.3 |

### 17.6 Decided by the user on 2026-10-05 — decisions split, reranker package, review findings

| # | Decision | Where |
|---|---|---|
| D24 | **A decision and a reranker are different; a probability and a relevance are different decisions** (goal decision 2026-10-05). `IDecisionModel` → `IProbabilityDecision`; new `IRelevanceDecision`; `DecisionReranker` → `ProbabilityReranker`; new `RelevanceReranker`. Old names are deprecated aliases until the next major, with a migration note. | §3.9, §5, §13 |
| D25 | **Packages by role:** `typesafe-decision` unchanged (`IProbabilityDecision`); new `@mcp-abap-adt/sap-aicore-decision` implements `IRelevanceDecision` through AI Core `/v2/inference/deployments/<deploymentId>/rerank`. `SapAiCoreDecisionModel` is withdrawn. | §5.3, §5.4 |
| D26 | **All rerankers in ONE new package `@mcp-abap-adt/llm-agent-reranker`** (goal decision 2026-10-05) — they carry no vendor specifics: `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`. libs re-exports the old names and paths as deprecated aliases; retrieval strategies stay in libs and use rerankers only through `IReranker`. | §5.4, §11, §13 |
| D27 | **One `decision:` section;** the provider decides the kind (`typesafe` → probability, `sap-aicore` → relevance); `reranker: decision` builds the matching reranker. Wording options apply only to probability and are refused for relevance at startup. `faceted-cohere` = relevance; `faceted-jev`, `small-set-jev` = probability. A threshold on relevance scores is the consumer's calibration; no default uses one. | §6.2, §7.4 |
| F1 (review) | **The caller's k caps every cut:** effective limit `min(requestedK, the cut's own limit)`, also after decomposition; `FixedItemsCut(n)` is a ceiling. The kit calls each shipped profile with k below its default and asserts ≤ k. | §3.4, §4.5, §4.9, §14.2 |
| F3 (review) | **Cleanup failures are kept:** every stale delete's `Result` is checked (primary and companion); an item with a failed cleanup is never reported indexed; the ids not yet deleted stay on the canonical (`staleRecordIds`, `staleCompanionRecordIds`) and the next `index` / `remove` retries them. Failure handling, not a concurrency protocol (D13 stands). | §3.1, §3.3, §14 |
| F4 (review, measured) | The default provider text stays **C0** (measured). How the provider text is composed becomes an injected strategy (`IToolTextComposer`); the schema-enriched C0e / C0s ship as strategies in no default, documented with the `compact` numbers (within noise, no winner). | §3.5, §7.3.1 |

### 17.7 Decided by the user on 2026-10-05 — relevance comparability, the second seam, the seam rename

| # | Decision | Where |
|---|---|---|
| D28 | **Relevance scores are comparable for the same query and model** — a cross-encoder scores each (query, passage) pair independently. `IRelevanceDecision` says so (replacing "comparable only within one call"); `RelevanceReranker` **batches by default** like `ProbabilityReranker` (`maxBatchTokens` 48000, `concurrency` 4, the same validation) and merges the batches' scores into one order; no single-call default. Closes §17.5's open choice. | §3.9, §5.2, §7.4, §14.1 |
| D29 | **The second optional seam `makeRelevanceDecision` is approved** (was a §17.5 choice). | §3.8, §6.2 |
| F5 (review) | **Pinned items carry reranked scores; `keepStage1Top` + `ScoreFloorCut` rejected.** A `keepStage1Top` item keeps its stage-1 place and carries the score the reranker gave it, never the embedding score; order stays pinned first, then the rest by reranked score. `keepStage1Top` > 0 with `ScoreFloorCut` is rejected at construction (keepStage1Top is unmeasured, D7). The `onFailure: 'stage1'` fallback returns stage-1 scores, so `ScoreFloorCut` with a reranker needs `onFailure: 'error'` — the same rejection, in the constructor and the YAML validator. | §4.2, §4.7, §4.9, §6.2, §9.3, §14.1 |
| D30 | **The released probability seam is renamed symmetric to its contract:** `BuildAgentDeps.makeDecisionModel` → **`makeProbabilityDecision`**; the app's `createMakeDecisionModel` → **`createMakeProbabilityDecision`** (`createMakeRelevanceDecision` stays). `makeDecisionModel` stays a deprecated alias until the next major; **both supplied → startup fails with an explicit error naming both** (never silently pick one); the seam-missing message names `makeProbabilityDecision`. Migration note in §13. | §1, §3.8, §6.2, §11, §13, §14.1 |

### 17.8 Decided by the user on 2026-10-05 — the server fills a bound profile

| # | Decision | Where |
|---|---|---|
| D31 | **The server fills a bound tools profile from the MCP clients it uses, at startup.** Replaces the stated limit "the server inherits the builder's limit". On every path that hands clients to the builder through `withMcpClients` — ready clients (`BuildAgentDeps.mcpClients`, `cfg.mcpClients`, plugin clients) or an injected `connectMcp` / `connectMcpWithDescriptors` seam — the server lists the clients' tools and fills the bound store through the shipped profile path (`fillToolsBinding` → `vectorizeMcpTools`, binding read from the store (D34) → `toolItemFromTool` + `IToolRecordKey` → `bound.index`), once per store, before it reports ready; `/health` and the small-set check read that status; failures follow the 30.1.0 tool-catalog policy (counted, logged, `degraded` — never a silent empty store). Workers reading the main store are not filled again. Without a bound profile nothing changes. The builder keeps its limit for `withMcpClients` / `withMcpServers` (no startup phase). *When a worker's store is filled is amended by D35 (§17.9).* | §6.1, §6.3, §3.8, §14.1 |
| D32 | **A worker's fill keeps the identity its agent dispatches by** (review finding on D31). Filled from the shared clients → the same `_sharedMcpClientDescriptors`, `_configuredSlotCount` and `IToolNamespace` as the main fill, and the worker's builder receives those clients with the same descriptors (existing `withMcpServers`, one already-connected `IMcpServer` per client) and the server's namespace (`withToolNamespace`), so the stored names are the names it can call. Own `mcpClients` → no descriptors exist: array order on both sides. Own `mcp:` → its own builder fills and dispatches from one connection. No contract change. Also fixes 30.1.0 workers on the shared clients exposing `s<i>__<tool>` where the main catalog has `<label>__<tool>`. *For the user's review:* the `withMcpServers` adapter over an optional `descriptors` parameter on `withMcpClients` (a public builder change) — recommendation applied, §17.9 | §6.3, §3.8, §14.1 |
| D33 | **Companion storage per primary binding** (review finding on Tasks 22–23). The profile instance may be shared; each primary binding (main, each worker with its own `rag`) gets companion stores of its own, built by the server through `makeRag` with that primary's embedder; a binding that reads another's primary shares its companions. Separate stores, not a binding segment in `recordId`: they isolate reads as well as writes, with no contract change. *For the user's review:* a persistent (non-in-memory) companion store with a worker that has its own `rag` is refused at start, rather than deriving a second collection name — recommendation applied, §17.9 | §6.2, §7.3.3, §3.8, §14.1 |

### 17.9 Review findings on 2026-10-05 — filling follows the store's lifecycle

Two review findings on the draft PR. Neither is fixed only where it was found: each is fixed by
the rule it broke, and §6.4 lists every path so a reviewer can check that none is missed.

- **(a)** `McpToolRegistry.revectorizeTools` (`toolsChanged` on a reconnect) called
  `vectorizeMcpTools` without the `binding` option. A profiled store therefore got 30.1.0
  records on reconnect, and a writerless binding was skipped silently.
- **(b)** Workers were filled only in `_buildInfra`. `PUT /v1/config` and hot reload drain the
  worker cache; `WorkerRegistry.build` → `buildSubAgent` then rebuilt the workers with new bound
  stores that nothing filled.

| # | Decision | Where |
|---|---|---|
| D34 | **The binding travels with the store.** Every tools vectorization resolves the binding from the store it fills (`toolsBindingOf`, through decorators): the builder's fill, `revectorizeTools` on `toolsChanged`, `fillToolsBinding`, `rag-eval`. With a binding → the profile path (no writer required); without → exactly 30.1.0. `vectorizeMcpTools`' explicit `binding` option is **removed**: no caller holds a binding its store does not carry (all bind through `bindToolsProfile`), so the option could only disagree with the store. `fillToolsBinding` keeps its typed `binding` parameter (it guarantees the profile path) and throws when the store does not carry that binding. *Amended by D46 (§17.12): `revectorizeTools` reads the binding only to write nothing into a bound store* | §6.1, §6.3, §6.4, §7.6, §3.8, §14.1 |
| D35 | *Amended by D41 (§17.11): only the worker's construction fills; a per-session re-wire never does.* **Whoever creates a bound store fills it.** The main store: `_buildInfra`, as D31. A worker's own store: `buildSubAgent`, right before `subBuilder.build()`, from the clients and descriptors that builder is handed (or, on the primary build, the shared clients with their descriptors once known). This covers startup, a lazy rebuild, `PUT /v1/config` and hot reload. `fillWorkerToolsStores` in `_buildInfra` is dropped. Kept: reader workers are never filled; one fill per binding (memoized, so concurrent rebuilds await one fill; a fill that throws is not kept); the D31 failure policy. `/health` reports the main catalog only; a worker's fill is logged (§6.3). On `yamlBuilderConnect` a worker on the shared clients is filled at its first per-session re-wire, because those clients are known only after the workers' startup build. *Amended by D36 (only complete fills are kept; an incomplete one is evicted too) and D38 (on `yamlBuilderConnect` one fill pass right after the harvest, at startup), §17.10* | §6.3, §6.4, §14.1 |

**Recommendations applied to the earlier open choices.** The user may still overrule any of
them.

| Choice | Applied | Where |
|---|---|---|
| A persistent companion store with a worker that has its own `rag` (D33's open choice) | **refused at startup**, naming the worker — no derived second collection name | §6.2, §7.3.3 |
| How a worker's builder gets clients with descriptors (D32's open choice) | **the internal `connectedMcpServer` adapter** over the existing `withMcpServers`; `withMcpClients` is not changed (no public builder change) | §6.3 |
| Workers on the shared clients named colliding tools by array position (30.1.0) | accepted as a fix: a CHANGELOG **"Fixed"** entry | §6.3, §13 |

### 17.10 Decided by the user on 2026-10-05 — fill memo, single-flight construction, startup fill

| # | Decision | Where |
|---|---|---|
| D36 | *Superseded by D41 (§17.11): withdrawn — no memo, no retry.* **Only complete fills are memoized.** A fill in flight stays shared per binding. One that resolves with `complete: false` (a `bound.index` Result failure, `listTools()` client failures) or aborted (`undefined`), or that rejects, is evicted when it settles, so the next build or re-wire of that worker retries it. No timers, no retry loops (standing rule: no timeouts) — a retry happens only when the worker is built again. The same rule for builder-filled bindings: marked filled only when the builder's catalog status is complete. The main store has no later build: an incomplete main fill stays reported (`degraded`) until a `toolsChanged` refill or a restart | §6.3, §6.4, §14.1 |
| D37 | *Moved out of this PR by D45 (§17.11): a separate issue (§15).* **Single-flight worker construction** in `WorkerRegistry` (with `resolveWorkerLlmSet` and the backfill working on the construction's own entry): one in-flight primary construction per worker name and config generation, recorded before any async factory runs; a construction started before a drain never publishes into the new generation — it closes what it built, and `drain()` awaits it. Framed as a fix of a **pre-existing 30.1.0 race in our own process** (duplicate worker instances, leaked resources), **not** a RAG concurrency protocol: concurrent writes to persistent stores (Qdrant, HANA, pg-vector) stay the backend's responsibility; the library adds no locks or generations for RAG, and no wording promises serialized item replacement across processes (§3.3, D13 wording amended) | §3.3, §6.3, §6.5, §8.4, §13, §14.1, §15 |
| D38 | *Stands, read with D41: the pass completes those workers' creation at startup; it is not a refill.* **Worker stores on the shared clients are filled at startup**, on `yamlBuilderConnect` too: one fill pass right after the harvest in `_buildInfra`, not at the first session. Startup filling concerns only the `tools` store (S8); collections that change while running — session collections, session history, user collections — are not filled at startup: pipeline elements write them during work (`SharedItemsProfile` `index` / `remove` for shared items), or they stay on 30.1.0 behaviour (goal 8) | §6.3, §6.4, §6.6, §14.1 |
| D39 | **The hot-reload test drives the server's reload entry point directly** — the `ConfigReloadWatcher` the server now holds, `_onReload(update)`, which returns the drain + invalidation as one awaitable promise (the file watcher's `reload` listener still fires and forgets) — instead of `fs.watch` + debounce polling. One thin test pins that the watcher's `reload` event calls that entry point (the seam exists: the `ConfigWatcher` event emitter inside `ConfigReloadWatcher`) | §14.1 |
| D40 | **Tools a server removes at runtime stay in the store**, as in 30.1.0. It happens when a generic MCP server changes its tool list while running (`notifications/tools/list_changed` → `toolsChanged` → `revectorizeTools`); a consumer that builds its corpus at build time does not hit it. Removal is out of scope. *Read with D46 (§17.12): a bound store is not written on `toolsChanged` at all; D40 now concerns unbound stores, as 30.1.0* | §6.3, §6.4, §15 |

### 17.11 Decided by the user on 2026-10-05 — fill once at creation; the fill source is a strategy; refill and single-flight out

From the goal's decision of 2026-10-05 (*a tools store is filled once, when its instance is
created*) and the user's clarifications of the same day (the corpus is built at build time; a
persistent store is written by the consumer's deploy step).

| # | Decision | Where |
|---|---|---|
| D41 | **A tools store is filled once, when its instance is created, and never refilled while running.** The main store: `_buildInfra`, once. A worker's own store: its construction (`buildSubAgent` without `injected`: the startup primary build or the lazy rebuild after a drain); a per-session re-wire never fills. No refill API, no fill memo, no retry: an incomplete fill is reported (`complete: false`; `/health` `degraded` for the main store; the summary line logged for a worker) and stays. A construction whose fill throws leaves no cached worker. Supersedes D36; amends D35 | §3.10, §6.3, §6.4, §14.1 |
| D42 | *Amended by D46 (§17.12): `IToolsFillSource` has `fill` only.* **The fill source is a strategy the consumer injects**: `IToolsFillSource` (`fill` at creation, `toolsChanged` on a reconnect) with `ToolsFillContext` (binding, target, `indexLiveTools`, logger), attached with the binding (`bindToolsProfile(profile, target, source?)`, default `LiveToolsFill`) and read from the store like it (D34). Shipped: `live`, `corpus` (`ToolsCorpusLoader`), `prebuilt` (`PrebuiltToolsStore`), `consumer` (`ConsumerToolsFill`). YAML `rag.profiles.tools.fill`; a consumer's own through `toolsFillFactories`. Compatibility (`corpus`, `prebuilt`) is checked at creation and fails loudly; the profile and embedder fingerprints are the consumer's names (`ToolsCorpusIdentity`), because no contract carries one | §3.8, §3.10, §6.1, §6.2, §6.3 |
| D43 | **Offline corpus API**: `buildToolsCorpus` (build step: provider tool definitions → records + vectors with the profile's own indexer and record writer over capture stores, and an embedder), `parseToolsCorpus`, `deployToolsCorpus` (deploy step: any store with precomputed writes, in place, one current state, idempotent, write-ahead, a service record with the fingerprint, the corpus hash and record hashes). Reserved record key `serviceRecord`; `StagedRetrieval` drops a hit that carries it. Recommended: in-memory → `corpus`; persistent → `prebuilt` | §3.1, §4.3, §6.5, §7.8, §13 |
| D44 | *Superseded by D46 (§17.12): no source answers `toolsChanged`; a bound store is not written on a reconnect.* **`toolsChanged` is the source's answer**: `live` and `consumer` re-index what is listed through the profile, as 30.1.0; `corpus` and `prebuilt` write nothing and log a warning (the user's decision: `ToolsCorpusLoader` fills the in-memory store at creation and does nothing else; the process never writes a prebuilt store). D40 stands: a tool no longer listed keeps its records | §3.10, §6.3, §6.4 |
| D45 | **Single-flight worker construction and the drain ordering move out of this PR** — a pre-existing 30.1.0 race unrelated to profiles, described in §15 for a separate issue. D37 and its plan task are withdrawn here; no remaining task depends on them | §6.3, §13, §15 |

### 17.12 Decided by the user on 2026-10-05 — fill sources fill once; no `toolsChanged` reaction for bound profiles

From the goal's updated decision of 2026-10-05 (*with a profile bound, the library does not react
to `toolsChanged`*).

| # | Decision | Where |
|---|---|---|
| D46 | **No reaction to `toolsChanged` for a bound store.** Until its collections are filled the pipeline and its MCP do not work, so the tool list cannot change under a working pipeline; the only case is an MCP server plugged in at runtime, and a consumer who builds such a pipeline does its own checks and filling in it. So: `IToolsFillSource` loses `toolsChanged` — the contract is `fill`, once at instance creation; `McpToolRegistry.revectorizeTools` with a bound store (found through decorators) writes nothing, calls no source, lists nothing, and logs one line under the `mcp` debug area (no warning); `vectorizeMcpTools` is reached for a bound store only from creation paths. `corpus` / `prebuilt` never write on `toolsChanged` by construction; `ConsumerToolsFill`: the library never writes. **Without a profile, 30.1.0 behaviour is unchanged** (the legacy re-vectorize stays). Supersedes D44; amends D34, D40, D42 | §3.8, §3.10, §6.1, §6.3, §6.4, §7.6, §13, §14.1, §15 |
| D47 | **Approved as proposed:** (1) the corpus / prebuilt fingerprint is the consumer-named `ToolsCorpusIdentity { profile, embedder }` plus the library's own checks (the binding's `profileName`, the companion set, the corpus format and one vector dimension); (2) a worker construction whose fill throws drops that worker's cache entry before rethrowing; (3) a worker with its own `rag` and its own clients is refused when the fill source is `corpus` or `prebuilt` | §3.10, §6.2, §6.3, §14.1 |
