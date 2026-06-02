# Tool-search analysis (isolated, bag-of-words = live in-memory), 2026-06-02

`search-experiment.ts` over the real 183-tool mcp-abap-adt corpus, using `InMemoryRag`
(the SAME bag-of-words/TF matcher the live `rag.type: in-memory` uses — it ignores the
configured SAP embedder). Seconds to run, deterministic, no LLM/API.

## Rank of the read tools by QUERY variant (plain `Tool: name — description` corpus)

| query | GetInclude | GetIncludesList | GetProgram |
|---|---|---|---|
| bare "review ABAP program …" | #73 (OUT) | #32 (OUT) | #8 (top-10) |
| +needs "read include bodies" (mixed in) | #0 | #3 | #18 (OUT) |
| +intent "[read get] … includes" | #2 | #1 | #39 (OUT) |
| main+includes | #0 | #3 | #21 (OUT) |
| main-only "read source code … shell" | #4 | #13 | #28 (OUT) |
| needs-only "read include bodies" | #0 | #1 | #68 (OUT) |

## Findings

1. **in-memory tool-search is LEXICAL (bag-of-words), not semantic** — token overlap. The
   `rag.embedder` is ignored for the in-memory store.
2. **The token "program" is shared by ~20 tools** (Update/Create/Activate/Delete*Program), so
   `GetProgram` (the single read-main tool) can't rank reliably: #8 for the exact "review program"
   phrasing (lexical luck), #28 for "read source code", #21/#18 otherwise. NO single query phrasing
   gets BOTH GetProgram and GetInclude into one top-10 — they live in different lexical neighbourhoods.
3. **Mixing the needs into ONE query DEMOTES the prompt tool** (GetProgram #8 → #18). Wrong: GetProgram
   is NEEDED for the main program.
4. **The fix is TWO ADDITIVE single-intent searches, UNIONed** (not bans, not a global re-embed):
   - PROMPT search → GetProgram (#8, main program).
   - NEEDS search ("read include bodies") → GetInclude (#0) AND GetIncludesList (#1).
   - **UNION = GetProgram + GetInclude + GetIncludesList** — all three, no lexical collision (each
     single-intent query matches its tool cleanly).
5. **GetIncludesList surfaces with the same need** ("read all includes") at #1 — not a separate
   trigger problem; the model then lists (incl. nested) before reading.

## Implemented

Executor now does the two additive searches and unions (commit forthcoming): the prompt seed keeps
GetProgram; a SEPARATE `toolsRag.query(needs)` adds GetInclude/GetIncludesList. The Evaluator's
`needs` (pre-hoc) and the need-classifier's re-query (post-hoc) both drive the additive need-search.

## Open (decisive next experiment)

Swap `InMemoryRag` for a real semantic vector store (qdrant + SAP/OpenAI embedder) on the SAME corpus
+ queries → does semantic ranking surface GetProgram reliably for "read main program source" (where
bag-of-words fails at #28)? That decides whether in-memory's lexical limit warrants a default vector
store for tool-search.
