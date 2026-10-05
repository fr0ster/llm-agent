# Goal: collection profiles — how each kind of collection is filled and searched

> **Owned by the user.** This document changes only when the user explicitly
> says so or agrees to a proposed change. The spec, the plan and the code follow
> it; they never edit it.
>
> **Status: draft for the user's review.** Decisions recorded on the user's word.

## The task

llm-agent is the framework consumers build their pipelines from. Those
pipelines search several kinds of collections: tools, predefined skills, the
user's own information, and the session history.

Since 30.1.0, **searching** is configurable per store (`IRetrievalStrategy`:
`embedding`, `rerank`, `rerank-all`, through `StrategyRag`). **Filling** is
not: every store gets one record per item (a tool is `Tool: name — description`).
Nothing joins the two halves either. Duplicates are dropped by name only after
the k cut, so k counts records, not items. A consumer that needs something else
has to work around the framework.

Measurements in a consumer showed that this one-size approach is the main source
of retrieval errors. Its tool search was measured on 237 tools with labelled
English queries (see *Evidence* below):

- One document per tool loses tools whose distinguishing signal is the
  **operation**, such as where-used, remove from transport, or run versus
  update. The **object** words dominate the document instead.
- A cross-encoder reranker (Cohere on SAP AI Core) helps on its own:
  - non-English queries: 0.692 → 0.962;
  - cosine-only stage 1, English: 0.885 → 0.943.
- Splitting the query into clauses looked necessary for multi-step queries, but
  most of that gain came from mislabelled queries (a step the tool already takes
  as a parameter, such as `transport_request` or `activate`) and from Cohere's
  ranking. Splitting is a strategy the consumer injects, not a built-in option
  (see Decisions).
- An LLM used as a reranker gives no gain.

## Goals

**Purpose:** let a consumer build any pipeline, and support any MCP server in
it. The contracts let a consumer build a profile for any MCP server; the
shipped profiles support different servers out of the box; the measurements
below come from one consumer and one server (`mcp-abap-adt`) and are evidence,
not the target platform.

1. The framework offers, for every kind of collection, **a pair** a consumer can
   build its pipeline with:
   - how the collection is **filled**: which records are made from one source
     item, from what text, with what metadata, and when;
   - how it is **searched**: query preparation, candidate search, collapsing a
     unit's repeated hits back into one item, an optional reranker, and the
     final cut.

   Already in 30.1.0: a per-store reranker, the candidate count and k (in
   records). New: indexing with several records per item, collapsing by item,
   counting both the candidate pool and k in items, and a per-store threshold.
2. The pair is one **collection profile**, because the search must undo exactly
   what the filling produced.
3. A consumer chooses a profile per collection kind in its builder. The library
   never picks one by guessing.
4. Today's behaviour, meaning 30.1.0's, stays available unchanged as the
   default profile: per-store retrieval strategies, and a store with an explicit
   strategy is skipped by the global rerank stage. A consumer that does nothing
   keeps exactly what it has.
5. The framework fixes neither the number of collection kinds nor the number of
   profiles. It defines the profile contract and ships default profiles. A
   consumer may write its own profile for any kind of collection.
6. A profile belongs to a **kind of store**, not to one store. Several stores of
   the same kind share one profile; the tool stores per role are an example.
   A consumer's example: five stores (two for tools, one for skills, one for
   session history, one for user collections) served by three profiles.
7. The default profiles in this work:
   - **MCP tools**;
   - **shared experience**: a RAG base that pipeline elements write into and
     search, so different agents can share information and experience. What a
     case holds, when it is written and by whom is decided by the pipeline
     element (or elements) that write it, not by the framework. The framework
     makes the written items findable, returns them whole, and carries their
     owner and visibility so they can be shared across agents.
8. **Skills** and **user collections** stay on today's behaviour (30.1.0) for
   now. They can get profiles later through the same contract.
9. **Profiles for different MCP servers.** The shipped MCP tools profile
   implementations support working with different servers: they are built from
   what any MCP server exports (name, description, input schema including enum
   values), not from one server's naming conventions, and they cover both
   fine-grained tool sets (one tool per operation and object, short schemas,
   hundreds of tools) and coarse ones (one tool per operation with the object in
   a parameter, large schemas, tens of tools). Since tools differ greatly in
   size, the final cut can be a token budget, not only a count. Where no shipped
   profile fits a server, the consumer builds its own profile from the contracts
   and uses it in the pipeline.
10. **Rerankers are alternatives the consumer chooses at deploy.** The framework
   ships at least two:
   - a cross-encoder on **SAP AI Core** (Cohere Rerank) — new work, since on a
     deployment SAP AI Core is usually the only provider available;
   - the **decision model** (TypeSafe Jev), already in 30.1.0, a separate
     provider.

   A profile can be configured for either.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-04 | This is a development of the framework that pipelines are built with: new building blocks, not a replacement and not a change to any one pipeline. Today's behaviour (one document per item, top-K) stays as the default profile, and nothing changes for current consumers. New profiles are opt-in. |
| 2026-10-04 | Each collection kind gets a pair: an indexing strategy and a retrieval strategy, described together as one collection profile. |
| 2026-10-04 | *(Experience part replaced by the shared-experience decision below.)* The default profiles in this work cover MCP tools and experience from sessions. Skills and user collections stay on today's behaviour for now. Experience means cases (inputs, symptoms, decision, outcome: what helped, what did not) extracted from finished sessions, so solved tasks are not lost. |
| 2026-10-04 | The framework is open-ended: any number of collection kinds and profiles. A profile belongs to a kind of store, and several stores can share it. Default profiles ship in llm-agent-rag or another package; consumers may write their own. The known kinds (tools, skills, session history, user collections) are what the defaults must cover, not a closed list. |
| 2026-10-04 | Contracts and default implementations live in llm-agent (an existing package or a new one). The consumer picks the profiles and passes instances in through dependency injection. |
| 2026-10-04 | Tool records come from what the tool provider exports (name, description, parameter names). Nothing is hand-written over them. A weak description is fixed at its source. |
| 2026-10-04 | *(Placement refined by the intents decision below: own record kind by default, a separate collection when the consumer chooses.)* LLM-generated variants of a provider's text (for example intents generated from a tool description) are allowed, but only in a **separate collection** of their own, never mixed with the records taken from the provider. The profile searches both and collapses the hits by item id, so what came from the provider stays distinguishable and the generated part can be rebuilt or turned off on its own. |
| 2026-10-04 | In this PR, besides the profiles: the bug where `vectorizeMcpTools` does not find the store's embedder behind `StrategyRag` and falls back to one tool at a time; de-duplication in `tools-rag-handle` (none today) and `skill-select` (fixed prefix); and a decision on the unused `IToolIndexingStrategy` and the docs that describe it as usable. |
| 2026-10-04 | Experience is not a fixed case schema inside a profile. A case is written by a separate pipeline element (or several), whose implementation decides what goes into it. The framework provides the RAG base for it: findable, returned whole, with owner and visibility so agents share information and experience. This replaces the case schema in the decision above. |
| 2026-10-04 | Intents are part of the MCP tools profile, not a framework-wide concept. Where they live is the consumer's choice. The default is a record kind of their own (`intent`) in the tool collection: measured equal to intents inside the tool's record, within noise. This refines the "separate collection" decision above: generated text stays apart from the provider's records, in its own record kind by default or in its own collection when the consumer chooses. |
| 2026-10-04 | The reranker reads the provider's text of the item, without generated intents: measured equal or better for both Cohere and Jev. Intents serve only the candidate search. |
| 2026-10-04 | The candidate pool is sized in items, not records: with several records per item, 30 records give only ~26–34 tools (reader and writer together, against 50 with one record per tool), and non-English recall drops. |
| 2026-10-04 | Rerankers are alternatives: Cohere on SAP AI Core and TypeSafe Jev both get a profile configuration; the consumer picks at deploy. The Cohere (SAP AI Core) reranker provider is in this PR. |
| 2026-10-04 | llm-agent ships the contracts of the pipeline elements and some default implementations. For MCP tools it ships several default variants, so a consumer has a real choice; skills stay on today's behaviour and get default variants of their own later. Everything is configured through strategies injected by the consumer, not through flags inside one implementation. |
| 2026-10-05 | Query splitting is a strategy the consumer injects, not a behaviour the framework ships. The framework provides the component: the default retrieval calls the injected splitting strategy; with none injected it runs the query as is. `k` stays the overall limit of a retrieval, as in 30.1.0: the strategy distributes the budget among its sub-queries and the default retrieval never returns more than k items. No shipped variant uses splitting: its measured gain came mostly from mislabelled multi-step queries and Cohere's ranking, and a genuinely dependent second step is a separate step for the planner. This replaces the clause split as a built-in profile option. |
| 2026-10-05 | The purpose is to let a consumer build any pipeline and support any MCP server in it. The shipped MCP tools profiles support different servers, and a consumer builds its own profile for any server they do not fit (goal 9); `mcp-abap-adt` is one server among many. Its two tool sets — fine-grained object-oriented tools and the coarse `compact` set (22 tools, one per operation, object in `object_type`, ~10k tokens in all) — are both measured as examples of the two shapes. |
| 2026-10-05 | Where tuning lives: the llm-agent components (contracts and strategies) are generic and carry no tuning for a server or a consumer. The default profile implementations are the exception: they may carry tuned defaults, justified by measurements. The main behaviour choices are always the consumer's: it makes them by choosing the strategies it injects into a profile. A default profile only fills in what the consumer did not choose. |
| 2026-10-05 | *(Replaced by the row below.)* Cohere on SAP AI Core reuses what exists: it is one more `IDecisionModel` implementation, used by the existing `DecisionReranker`, in a new provider package `@mcp-abap-adt/sap-aicore-decision`. |
| 2026-10-05 | A decision and a reranker are different things, and a probability and a relevance are different decisions. Two model contracts, named by what the decision is based on: `IProbabilityDecision` (today's `IDecisionModel`: answers yes/no questions with a probability; TypeSafe Jev) and `IRelevanceDecision` (new: scores how relevant each passage is to a query; a cross-encoder such as Cohere on SAP AI Core — its score is not a probability). Two rerankers adapt them: `ProbabilityReranker` (today's `DecisionReranker`) and `RelevanceReranker` (new). The renames break 30.1.0 names, so the old names stay as deprecated aliases until the next major, with a migration note. Packages are named by role, so both providers are decision packages: `typesafe-decision` (unchanged, `IProbabilityDecision`) and the new `@mcp-abap-adt/sap-aicore-decision` (`IRelevanceDecision`, Cohere on SAP AI Core). The server YAML keeps one `decision:` section; the provider determines the kind of decision, and `reranker: decision` builds the matching reranker. |
| 2026-10-05 | All rerankers live in one new package, `@mcp-abap-adt/llm-agent-reranker`: they are generic adapters over the model contracts and carry no vendor specifics (`ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, the question presets). Vendor providers stay in their own decision packages. `llm-agent-libs` re-exports the moved names as deprecated aliases until the next major. |
| 2026-10-05 | A tools store is filled once, when its instance is created, and is not refilled while running (collections are filled once and read-mostly). Where the records come from is a strategy the consumer injects: (1) live — the MCP tool list, indexed through the profile at creation (30.1.0 behaviour); (2) a corpus prepared in advance — records built at build or deploy time by the same profile's indexer, loaded into the store at instance creation with no embedding calls; (3) a store already filled at deploy — bound for retrieval only, never written by the process; (4) the consumer fills it itself. No refill API, no fill memo or retry: an incomplete fill is reported (`complete: false`, degraded). With a profile bound, the library does not react to `toolsChanged`: until the collections are filled the pipeline and its MCP do not work, so the tool list cannot change under a working pipeline. The only case is an MCP server plugged in at runtime; a consumer who builds such a pipeline does its own checks and filling in that pipeline. Without a profile, 30.1.0 behaviour is unchanged. Collections that change while running (session, session history, user collections) are written by pipeline elements or consumer actions, not by these strategies. The single-flight worker construction and drain ordering fix a pre-existing 30.1.0 race unrelated to profiles and move to a separate issue. |
| 2026-10-05 | Intents are removed entirely: they did not justify themselves. LLM-generated intents restate the provider's description (e.g. `CreateDdl`: "create CDS view, create classic view, new DDL source…"), measured within noise without a reranker and no better with one (the reranker reads provider text better without them), and they need LLM generation at build, regeneration and audits (one audit found poisoned intents). A weak description is fixed at its source. This removes intent records, intent sources and companion stores from this work; records are built only from what the provider exports. This replaces the earlier rows on intents and generated variants. |
| 2026-10-05 | Layers. The RAG implementations (`VectorRag`, `InMemoryRag`, `FallbackRag`, …) move from the contracts package `@mcp-abap-adt/llm-agent` to `@mcp-abap-adt/llm-agent-rag`, in this PR, with deprecated re-exports from the old place. `tools-rag-handle` stays in the server package; `HealthChecker` stays in libs. |
| 2026-10-05 | Corpus flow: the consumer's build step makes the corpus (the profile's indexer, from libs); the server, at start (part of deploy), loads the ready corpus into the store — in-memory and persistent alike: clear the store, write the corpus, log it. No separate deploy step, no prebuilt-store source, no service record (no pending/final state, id list or hash in the store); an interrupted load repeats at the next start. Compatibility is checked against the identity carried in the corpus file. Fill sources: live, corpus, consumer. |
| 2026-10-05 | Measurements were made in a consumer (cloud-llm-hub, on mcp-abap-adt) and are not in this repository, so they do not justify framework defaults: shipped variants carry no tuned numbers; where a number is needed the consumer gives it, or a generic default applies (e.g. the caller's k). The evidence stays in the spec as motivation only, with a pointer to the consumer. This refines the earlier row on tuned defaults. |
| 2026-10-05 | No deprecated aliases: this is a major release and old names are not kept. The RAG implementations move to `@mcp-abap-adt/llm-agent-rag` and `@mcp-abap-adt/llm-agent` stops exporting them; the renames (`IDecisionModel` → `IProbabilityDecision`, `DecisionReranker` → `ProbabilityReranker`, `makeDecisionModel` → `makeProbabilityDecision`, …) and the rerankers' move to `llm-agent-reranker` keep no old names either. The CHANGELOG carries a migration note for each. This replaces every earlier "deprecated alias until the next major" in the rows above. |
| 2026-10-05 | No re-exports: every package, our own included, imports a name directly from the package that owns it; no package re-exports another package's names. |
| 2026-10-05 | Replicas over one persistent store each clear and reload it at their start, and the others read a partial store meanwhile — accepted as the price of the simple corpus flow; no marker or coordination. |
| 2026-10-04 | Other open issues go in separate PRs: #323 (query expander never applied) after this spec decides whether query preparation belongs to a profile; #304 (isolation); #326, #327 (embedders); #324, #314, #291, #290, #247. This spec requires owner keys on every record and collapsing after the store's owner filter. |

## Evidence (measured in cloud-llm-hub, 2026-09-30 … 2026-10-04)

The full reports are in the cloud-llm-hub repository, branch
`research/tool-rag-accuracy`, under `docs/research/2026-09-30-tool-rag-accuracy/`.

The figures are required-recall, i.e. every needed tool returned, on English
queries with production embeddings:

- **Today**, hybrid scoring, top-5 per collection: 0.943. At top-15: 0.977, but
  with about 25 tools in the prompt.
- **Several records per tool** (full + operation + object), collapsed by the best
  hit: 0.966 at top-5, and 0.977 at top-8 with about 13 tools. Collapsing by count
  or reciprocal rank is worse.
- **Cohere Rerank** (SAP AI Core) over 30 candidates: non-English queries
  0.962 (0.692 without the reranker).
- **An LLM as the reranker:** no gain, and 6–10k prompt tokens per query. When
  the model returns the wrong number of scores, it falls back to the stage-1
  order. Since 30.1.0 that is a reranker error, but the strategy still falls back
  and records it only as a session step: no span, no metric, nothing in
  /health.
- **Rerankers compared** (k5, hybrid, today's one record per tool, so the pool is
  the same):

  | queries | Cohere | Jev |
  |---|---|---|
  | all English (87) | 0.931, 8.3 tools | 0.977, 8.3 tools |
  | single-step (73) | 0.973 | 1.000 |
  | multi-step (14) | 0.714 | 0.857 |
  | non-English (26) | 0.962 | 1.000 |

  Multi-step labels corrected on 2026-10-05: five queries listed a step the
  first tool already takes as a parameter (`CreateClass` takes
  `transport_request`; `UpdateClass`, `CreateDomain`, `CreateBehaviorDefinition`
  take `activate`). After the correction, Jev's only miss is "where-used of a
  table, then show the users' source", whose second step depends on the first
  step's result and is a separate step for the planner anyway. Cohere also
  misses `CreateClass` and `UpdateClass` in two queries: its ranking, not
  multi-step. With several records per tool and a reranker, the
  record layout (intents inside the record, in their own record, or absent) is
  within noise; intents in the reranker's text do not help either reranker.

## Open questions

- Shared experience base: the owner and visibility of items (user, team,
  global — see #304), and what the framework must offer the writing elements
  (record kinds, owner keys, removal). What a case holds, when it is extracted
  and how its outcome is confirmed belong to the writing element, not to this
  work.
- Names: several are taken (`ISearchStrategy`, `IRetrievalStrategy`,
  `IToolSelectionStrategy`, the unused `IToolIndexingStrategy`,
  `IQueryPreprocessor`, `IQueryExpander`).

- Package placement: which contracts go in `@mcp-abap-adt/llm-agent` and which
  default implementations in `@mcp-abap-adt/llm-agent-rag`; whether reranker
  providers become packages of their own (like the `*-embedder` packages).
- How a profile relates to the existing `IRag`, `IReranker`, query
  preprocessors and the builder.
- The boundary with the per-store retrieval strategies of #321
  (`IRetrievalStrategy`, `StrategyRag`, `DecisionReranker`). The retrieval half
  of a profile should build on them, not beside them. The profile adds the
  indexing half and what joins the two halves: collapsing a unit's records.
- The search knobs per profile: candidate count, collapse rule, final cut
  (per-collection k or a threshold).
