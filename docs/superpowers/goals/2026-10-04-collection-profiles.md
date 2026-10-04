# Goal: collection profiles — how each kind of collection is filled and searched

> **Owned by the user.** This document changes only when the user explicitly
> says so or agrees to a proposed change. The spec, the plan and the code follow
> it; they never edit it.
>
> **Status: draft for the user's review.**

## The task

llm-agent is the framework consumers build their pipelines from. Those
pipelines search several kinds of collections: tools, predefined skills, the
user's own information, and the session history. Today the framework offers one
way to fill and search them all: one document per item, one vector, top-K by a
fixed score. A consumer that needs something else has to work around the
framework.

Measurements in a consumer showed that this one-size approach is the main source
of retrieval errors. Its tool search was measured on 237 tools with labelled
English queries (see *Evidence* below):

- One document per tool loses tools whose distinguishing signal is the
  **operation**, such as where-used, remove from transport, or run versus
  update. The **object** words dominate the document instead.
- A reranker stage helps only when the query is split into its clauses and the
  results are joined.
- An LLM used as a reranker gives no gain.

## Goals

1. The framework offers, for every kind of collection, **a pair** a consumer can
   build its pipeline with:
   - how the collection is **filled**: which records are made from one source
     item, from what text, with what metadata, and when;
   - how it is **searched**: query preparation, candidate search, collapsing a
     unit's repeated hits back into one item, an optional reranker, and the
     final cut.
2. The pair is one **collection profile**, because the search must undo exactly
   what the filling produced.
3. A consumer chooses a profile per collection kind in its builder. The library
   never picks one by guessing.
4. Today's behaviour stays available, unchanged, as the default profile. A
   consumer that does nothing keeps exactly what it has.
5. Profiles exist at least for:
   - tools;
   - predefined skills;
   - the user's information (persistent collections);
   - the session history.

## Decisions

| Date | Decision |
|---|---|
| 2026-10-04 | This is a development of the framework that pipelines are built with: new building blocks, not a replacement and not a change to any one pipeline. Today's behaviour (one document per item, top-K) stays as the default profile, and nothing changes for current consumers. New profiles are opt-in. |
| 2026-10-04 | Each collection kind gets a pair: an indexing strategy and a retrieval strategy, described together as one collection profile. |
| 2026-10-04 | At least four profiles: tools, predefined skills, user information, session history. |
| 2026-10-04 | Contracts and default implementations live in llm-agent (an existing package or a new one). The consumer picks the profiles and passes instances in through dependency injection. |
| 2026-10-04 | Tool records come from what the tool provider exports (name, description, parameter names). Nothing is hand-written over them. A weak description is fixed at its source. |

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
- **An LLM as the reranker:** no gain, 6–10k prompt tokens per query, and it
  silently falls back to the stage-1 order when the model returns the wrong
  number of scores.
- **Best combination measured:** Cohere with clause split, joined with the top-3
  tools found through the multiple records. It reaches 1.000 at top-5, but it was
  picked after seeing the results and still needs fresh queries.

## Open questions

- Package placement: which contracts go in `@mcp-abap-adt/llm-agent` and which
  default implementations in `@mcp-abap-adt/llm-agent-rag`; whether reranker
  providers become packages of their own (like the `*-embedder` packages).
- How a profile relates to the existing `IRag`, `IReranker`, query
  preprocessors and the builder.
- The search knobs per profile: candidate count, collapse rule, final cut
  (per-collection k or a threshold), and clause splitting.
