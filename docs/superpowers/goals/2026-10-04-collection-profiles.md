# Goal: collection profiles — how each kind of collection is filled and searched

> **Owned by the user.** This document changes only when the user explicitly
> says so or agrees to a proposed change. The spec, the plan and the code follow
> it; they never edit it.
>
> **Status: draft for the user's review.**

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
- Splitting the query into its clauses and joining the results is needed only for
  multi-step queries on top of hybrid scoring (0.714 → 1.000). It is a separate
  option, not a requirement of every reranker.
- An LLM used as a reranker gives no gain.

## Goals

1. The framework offers, for every kind of collection, **a pair** a consumer can
   build its pipeline with:
   - how the collection is **filled**: which records are made from one source
     item, from what text, with what metadata, and when;
   - how it is **searched**: query preparation, candidate search, collapsing a
     unit's repeated hits back into one item, an optional reranker, and the
     final cut.

   Already in 30.1.0: a per-store reranker, the candidate count and k (in
   records). New: indexing with several records per item, collapsing by item,
   counting k in items, the optional clause split, and a per-store threshold.
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
   - **experience from sessions**: what a solved task teaches, so it is not lost.
     A record is a case with:
     - the inputs (task, context, system);
     - the symptoms seen (messages, error texts, codes);
     - the decision taken and what was done;
     - the outcome: what helped and what did not.

     The case is extracted from a finished session, or on demand. It is found
     again by a new situation's symptoms and inputs, and returned whole,
     including what failed.
8. **Skills** and **user collections** stay on today's behaviour (30.1.0) for
   now. They can get profiles later through the same contract.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-04 | This is a development of the framework that pipelines are built with: new building blocks, not a replacement and not a change to any one pipeline. Today's behaviour (one document per item, top-K) stays as the default profile, and nothing changes for current consumers. New profiles are opt-in. |
| 2026-10-04 | Each collection kind gets a pair: an indexing strategy and a retrieval strategy, described together as one collection profile. |
| 2026-10-04 | The default profiles in this work cover MCP tools and experience from sessions. Skills and user collections stay on today's behaviour for now. Experience means cases (inputs, symptoms, decision, outcome: what helped, what did not) extracted from finished sessions, so solved tasks are not lost. |
| 2026-10-04 | The framework is open-ended: any number of collection kinds and profiles. A profile belongs to a kind of store, and several stores can share it. Default profiles ship in llm-agent-rag or another package; consumers may write their own. The known kinds (tools, skills, session history, user collections) are what the defaults must cover, not a closed list. |
| 2026-10-04 | Contracts and default implementations live in llm-agent (an existing package or a new one). The consumer picks the profiles and passes instances in through dependency injection. |
| 2026-10-04 | Tool records come from what the tool provider exports (name, description, parameter names). Nothing is hand-written over them. A weak description is fixed at its source. |
| 2026-10-04 | In this PR, besides the profiles: the bug where `vectorizeMcpTools` does not find the store's embedder behind `StrategyRag` and falls back to one tool at a time; de-duplication in `tools-rag-handle` (none today) and `skill-select` (fixed prefix); and a decision on the unused `IToolIndexingStrategy` and the docs that describe it as usable. |
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
- **Cohere Rerank** (SAP AI Core) over 30 candidates, with the query split into
  clauses: 0.977 at top-5 with about 9 tools.
  - multi-step queries: 1.000 (0.714 without it);
  - non-English queries: 0.962 (0.692 without it).
- **An LLM as the reranker:** no gain, and 6–10k prompt tokens per query. When
  the model returns the wrong number of scores, it falls back to the stage-1
  order. Since 30.1.0 that is a reranker error, but the strategy still falls back
  and records it only as a session step: no span, no metric, nothing in
  /health.
- **Best combination measured:** Cohere with clause split, joined with the top-3
  tools found through the multiple records. It reaches 1.000 at top-5, but it was
  picked after seeing the results and still needs fresh queries.

## Open questions

- Experience profile:
  - when a case is extracted (end of session, an explicit call, a background
    pass);
  - who extracts it (an LLM step, with what prompt and schema);
  - how outcomes are confirmed, so a case does not record a guess as a fix;
  - the owner and visibility of cases (user, team, global — see #304);
  - duplicates and merging of similar cases;
  - retention.

- Which default profiles ship, and how they group the known kinds. For example:
  - a catalog profile for tools and skills, a session profile and a documents
    profile;
  - or one profile each for tools, skills and documents (history plus user).

  Tools and the builder's skills share one store today, so a separate skills
  store comes with this.
- Do LLM-generated variants (intent enrichment, `IntentToolIndexing`) count as
  "written over" the provider's text? The best measured tool document included
  LLM-generated intents.
- A Cohere / cross-encoder reranker provider is new work: 30.1.0 ships
  `decision` and `llm` rerankers only.
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
  indexing half and what joins the two halves: collapsing a unit's records and
  the optional clause split.
- The search knobs per profile: candidate count, collapse rule, final cut
  (per-collection k or a threshold), and clause splitting.
