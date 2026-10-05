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
>   2026-10-05 (§17.11);
> - intents and companion stores removed, the corpus deploy written in full: decided by the user on
>   2026-10-05 (§17.15);
> - **`FallbackRag` is removed** (the goal's decision of 2026-10-05; D68, §10.4, §17.23): the
>   builder no longer wraps registered stores; the circuit breaker stays on the embedder and fails
>   fast with an error. Withdrawn with it: D52 (the decorator writer rule and the corpus load's
>   resolved-backend check — the load checks the writer of the store it writes) and D62 (no writer
>   without a primary writer). The layer map (§11.1) assigns every part of this design to one
>   layer; its audit lists suspected misplacements for the user's decision (§11.2);
> - the RAG implementations' home is `@mcp-abap-adt/llm-agent-rag`; the server loads a ready corpus
>   at start (no deploy step, no service record); shipped compositions carry no tuned numbers:
>   the goal's three decisions of 2026-10-05, written in as D53–D56 (§17.17);
> - **a major release without deprecated aliases and without re-exports** (the goal's newest
>   decision and the user's of 2026-10-05, D57–D60, §17.18): the RAG implementations' files move
>   into `llm-agent-rag` now (S10 closed); every renamed or moved name keeps no old name; no package
>   re-exports another package's names; the user accepts the reload window of replicas over one
>   persistent store (D60). **S11 decided by the user on 2026-10-05 (§17.18):** `OllamaRag` in
>   `ollama-embedder` extends `VectorRag`, and `llm-agent-rag` depends on `ollama-embedder` — a
>   package cycle once `VectorRag` lives in `llm-agent-rag`; this spec removes `OllamaRag`.
>   **S12 decided by the user on 2026-10-05 (§17.18):** the pre-existing re-exports go in this same
>   major — no public entry point of any package exports another package's names (§11.4, 18 more
>   migration lines, §13). **The search-strategy types move with `VectorRag`** to `llm-agent-rag`:
>   the user's decision of 2026-10-05 (§17.18). **§11.4's four questions decided by the user on
>   2026-10-05 (§17.18):** `ITextLogger` is removed (every use takes `ILogger` of
>   `@mcp-abap-adt/interfaces-utils`; migration line 70), libs' two dead internal files are deleted,
>   `SmartAgentHandle` / libs' `IStageHandler` and libs' internal shims are kept.
> - **review findings and a user decision of 2026-10-05 (§17.22, D64–D67):** an injected MCP
>   connection strategy is owned by the agent it is injected into — `handle.close()` and a failed
>   `build()` dispose it (D64); a corpus is checked against **every** tools store the server binds
>   with it, before any store is created (D65); a store is filled **before** skills are vectorized
>   into it, on every path (D66); orphans never use up the candidate pool (D67);
> - **fail loud** (the goal's decisions of 2026-10-05, D69–D74, §10.5, §17.24): no fallback or silent
>   degradation anywhere in the pipeline; pipeline errors reach the consumer (D70); `onFailure`
>   removed (D71); `/health` 503 on a configured component not working (D72). **U1–U10 decided
>   by the user on 2026-10-05** (§17.24, §10.5.12), every recommendation as written: the skill
>   plugin host defaults to `strict: true` (U2); a step naming an agent the registry lacks fails
>   (U5); `lazy`'s `fallback` is removed (U6); the tool availability blacklist is an injected
>   policy with no default (U8); U1, U3, U4, U7, U10 kept (U1, U7 counted, U10 logged); U9
>   confirmed.
> - **a failed config change** (the user's decision of 2026-10-06, D82, §17.30): a file reload or
>   `PUT /v1/config` that fails to apply is an error and leaves the server not ready until a whole
>   config applies — a file reload or a `PUT` carrying every section the route can change; a partial
>   `PUT` is refused while not ready (409, D82 (8), the user's decision of 2026-10-06); no rollback
>   (D77's restore and D81 withdrawn); changes stay serialized (D80). A file the watcher cannot
>   read, parse or resolve is such a failed reload (D82 (9), review finding of 2026-10-06, §17.35).
>
> **Amended 2026-10-05** for the goal's *Purpose* and goal 9: llm-agent builds **any** pipeline
> with **any** MCP server. `mcp-abap-adt` is one server; its names and figures appear only as
> labelled examples and as the evidence they were measured on (§2.0, §7.0).
>
> **Amended 2026-10-05 (2)** for the goal's decisions on tuning and strategy choice: the
> **consumer** makes the main behaviour choices by choosing the strategies it injects; components
> are generic; tuned numbers live only in default compositions, each citing its measurement
> (§7.1). The coarse-set (`compact`) measurement is in (§2.5.1): the coarse default is now one record
> per tool + rerank-all + 3 tools. *Tuned numbers in defaults and the coarse default are withdrawn by
> (12): nothing that ships carries a number measured in a consumer.*
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
> - old names stay as **deprecated aliases** until the next major (§13); *superseded by (13), D58:
>   no aliases;*
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
>   **`createMakeProbabilityDecision`** (§3.8, §6.2, §13). *The alias and the both-supplied error
>   are withdrawn by (13), D58: `makeDecisionModel` is gone.*
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
>   and the corpus hash; *how it writes is amended by (11), D51*). Recommended: in-memory store → `corpus`; persistent store → `prebuilt`.
>   *Amended by (12), D54: `prebuilt`, `deployToolsCorpus` and the service record are removed; the
>   `corpus` source loads the corpus at start into any store;*
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
> **Amended 2026-10-05 (11)** for the goal's decision of the same day (*intents are removed
> entirely*) and the user's approval of a full-rewrite deploy (§17.15):
> - **no intents, no companion stores** (D50): records are built only from what the provider
>   exports. Gone: the `intent` record kind, `IntentRecordIndexer`, `IntentCompanionIndexer`,
>   `IToolIntentSource`, `StaticIntentSource`, `LlmIntentSource`, the intent placements, and —
>   since they existed only for intents — companion stores: `CollectionStore.companions`,
>   `RetrievalSource.role` / `itemsOf` (`variants` sources), the reserved keys `companionRecordIds`,
>   `staleCompanionRecordIds` and `generated`, the YAML `intents` key and the corpus's companion
>   parts. Intents stay only as evidence, measured and dropped (§2.1);
> - **the corpus deploy writes the whole corpus** (D51): unchanged → no write; otherwise write
>   ahead `pending` (old ∪ new ids), delete every id the old service record lists, write the whole
>   corpus, finalize. No per-record hashes, no diff (§6.5). *Withdrawn by (12): there is no deploy
>   step any more.*
>
> **Amended 2026-10-05 (12)** for the goal's three decisions of the same day (layers, corpus flow,
> measurements) — D53–D56 (§17.17):
> - **the RAG implementations' home is `@mcp-abap-adt/llm-agent-rag`** (D53, §11.3): `VectorRag`,
>   `InMemoryRag`, `FallbackRag` and every other RAG implementation listed in §11.3 are imported
>   from `llm-agent-rag`; the old names in `@mcp-abap-adt/llm-agent` stay as deprecated aliases
>   until the next major. A physical file move in this PR would need `llm-agent` to re-export from
>   `llm-agent-rag`, which depends on `llm-agent` — a package cycle. So the **files** move in the
>   next major, together with the removal of the aliases (**S10, open for the user**, §17.17).
>   *Superseded by (13), D57: S10 is decided — the files move now, without aliases;*
> - **the server loads the ready corpus at start** (D54, §3.10, §6.5): the consumer's build step
>   makes the corpus (`buildToolsCorpus`, libs); at start the `corpus` fill source
>   (`ToolsCorpusLoader`) checks it, **clears the store and writes the corpus** with its
>   precomputed vectors, in-memory and persistent stores alike, and logs it. An interrupted load
>   repeats at the next start. **Removed:** `deployToolsCorpus`, `PrebuiltToolsStore` (the
>   `prebuilt` source), the service record, `TOOLS_CORPUS_RECORD_ID`, the `serviceRecord` reserved
>   key and its drop in `StagedRetrieval`, D48, D51 and D49's deploy half. Fill sources: `live`,
>   `corpus`, `consumer`;
> - **no tuned numbers in what ships** (D55, D56, §7.1, §7.4): a shipped composition carries no
>   number measured in a consumer; a number it needs is a required argument or a generic default
>   (the caller's k; a pool of k items). The named compositions are `baseline`, `faceted` and
>   `faceted-rerank`; `faceted-cohere`, `faceted-jev` and `small-set-jev` are withdrawn (they
>   differed only by measured numbers and a vendor). The evidence (§2) stays as motivation, with a
>   pointer to the consumer's research. `ICandidatePool` takes the caller's k (D56, §3.4).
>
>
> **Amended 2026-10-05 (13)** for the goal's decision "No deprecated aliases" and the user's
> decisions of the same day — D57–D60 (§17.18). It replaces every "deprecated alias until the next
> major" and every "re-exported for 30.1.0 imports" written above:
> - **a major release** (§13): old names are not kept; the CHANGELOG carries a **Breaking** section
>   with one migration line per removed or moved name, saying where it is imported from now;
> - **the RAG implementations' files move into `packages/llm-agent-rag/src/` in this PR** (D57,
>   §11.3): `@mcp-abap-adt/llm-agent` stops exporting them; no `rag-implementations` subpath, no
>   aliases; the search-strategy types (`ISearchStrategy`, …) move with `VectorRag`, whose option
>   types they are (the user's decision, §17.18); `IQueryExpander`, `IQueryPreprocessor`, `IDocumentEnricher` move to
>   `llm-agent/src/interfaces/`; nothing left in `llm-agent` imports a moved file. The store kit stays
>   in `llm-agent` (unchanged);
> - **no deprecated aliases** (D58): `IDecisionModel`, `DecisionReranker` / `DecisionRerankerOptions`,
>   `DECISION_RERANK_DEFAULT_*`, `wrapDecisionModel`, `BuildAgentDeps.makeDecisionModel` are gone
>   (and with it the "both supplied" startup error); every in-repo use takes the new name;
> - **no re-exports at all** (D59): every package — ours included — imports a name from the package
>   that owns it. `llm-agent-libs` re-exports nothing from `llm-agent-reranker` or `llm-agent-rag`;
>   `llm-agent-rag` exports only what lives in it. The pre-existing re-exports go too (S12, decided
>   by the user, §11.4): libs' root names of `llm-agent`, server-libs' `legacy/*` re-exports,
>   `llm-agent-server`'s dead `export *`;
> - **replicas over one persistent store** (D60): each clears and reloads it at its start and the
>   others read a partial store meanwhile — accepted by the user as the price of the simple corpus
>   flow; no marker, no coordination;
> - **S11 decided — remove** (user, 2026-10-05; §17.18): `OllamaRag` (`ollama-embedder`) extends `VectorRag`; `llm-agent-rag`
>   depends on `ollama-embedder` (optional peer, `tsconfig` reference), so `ollama-embedder` cannot
>   import `llm-agent-rag` — a cycle. This spec removes `OllamaRag` (one migration line);
> - **§11.4's questions decided** (user, 2026-10-05; §11.4, §17.18): `llm-agent`'s `ITextLogger`
>   (a second name for `ILogger` of `@mcp-abap-adt/interfaces-utils`) is removed — every in-repo use
>   imports `ILogger` from `@mcp-abap-adt/interfaces-utils` (migration line 70; **70 lines** in all);
>   libs' two dead internal files `adapters/index.ts` and `interfaces/model-resolver.ts` are deleted;
>   `SmartAgentHandle`, libs' `IStageHandler` and libs' internal shims are kept.
>
>
> **Amended 2026-10-05 (14)** for the goal's decision "`FallbackRag` is removed" — D68 (§17.23):
> - **`FallbackRag` is removed** (§10.4): its file, its tests, its export. It no longer moves to
>   `llm-agent-rag` (D53 and D57 read without it; migration line 5 says *removed*). When RAG has
>   problems they are deeper than llm-agent can solve; a fallback to an in-memory copy only hid the
>   failure behind empty or partial results. A consumer who wants a degraded mode writes its own
>   `IRag` wrapper (implementing `IRagDecorator`, so a binding, a strategy and a store embedder
>   under it stay visible);
> - **the builder wraps no store any more** (§10.4): the circuit-breaker loop over the registry,
>   `isGuardedBy`, and what existed only for them — `SimpleRagRegistry.replaceRag`,
>   `SmartAgentBuilder.withCircuitBreakers` with its `_sharedBreakers` field and the server's call
>   of it, and the embedder breaker `withCircuitBreaker(config)` built (nothing ever recorded on it:
>   the builder wraps no embedder) — are removed (migration lines 71, 72: **72 lines** in all). The
>   breakers that guard calls stay: `withCircuitBreaker(config)` still wraps the main LLM; the
>   server's embedder breaker still wraps the retrieval embedder (`withCircuitBreaker(embedder,
>   breaker)`, below the document/query role) and is listed in `/health`. With it open, a store's
>   query fails fast with `CIRCUIT_OPEN` instead of answering from an in-memory copy;
> - **withdrawn with it:** D52 (the decorator writer rule — no decorator in this design needs it:
>   `StrategyRag` returns its inner writer unchanged, the other decorators expose none), the corpus
>   load's resolved-backend check (the load checks the writer of the store it writes, §6.5 load
>   step 2), D62, and their tests;
> - **kept:** `IRagDecorator` and every walk through it (`hasRetrievalStrategy`, `ownBuiltInStore`,
>   `retrievalEmbedderOf`, `toolsBindingOf` / `boundToolsOf`, `findWeightedStore`) — `StrategyRag`
>   is a decorator, and the contract promises a consumer's own decorator the same visibility.
>
>
> **Amended 2026-10-05 (15)** for the goal's decisions "No fallbacks anywhere in the pipeline" and
> "the fail-loud sweep is part of this PR" — D69–D74 (§10.5, §17.24):
> - **the rule** (§10.5.1): a component that finds another not working returns a typed, observable
>   error; the stage's `OrchestratorError` carries the component's code; three codes no component
>   has form the new set `PIPELINE_FAILURE_CODES`; no shared set is widened;
> - **pipeline errors reach the consumer** (D70, a bug fix, first): today a stage failure ends the
>   stream normally and `process()` returns `ok: true`;
> - **`onFailure` is removed** (D71): `StagedRetrieval`, the YAML `compose.onFailure` key and
>   `facetedRerank` have no stage-1 fallback; with it go the `ScoreFloorCut` + `stage1` rejection,
>   the two-scales case of D67 and the `rerank_fallback` outcome; the 30.1.0 rerank strategies, the
>   `rerank` stage and the legacy orchestrator return `RERANK_ERROR` too (S4 superseded for the
>   failure path);
> - **health** (D72): `degraded` answers 503; every store probed; **`FallbackQueryEmbedding`** only
>   for a `TextOnlyEmbedding` (D73); **the sweep** over MCP, RAG, LLM handlers and providers,
>   coordinator, skills and server (D74); a behaviour table in §13 (B1–B11);
> - **for the user** (§17.24): ten modes a consumer can choose (U1–U10), each with a
>   recommendation, unchanged until decided — incl. U9, the confirmation of D68's removed builder
>   breaker.
>
> **Amended 2026-10-05 (16)** for the user's decisions on U1–U10 (§17.24) — every recommendation
> approved as written:
> - **kept, now countable or visible:** `FallbackLlmCallStrategy` counts each fallback — a log
>   event `llm_streaming_fallback` always, an optional injected `ICounter` for a metrics backend
>   (U1); the batch → per-tool embedding counts its failed batches, `batchFailures` in the tools
>   summary (U7); a worker on its parent's clients or tools store logs one
>   `worker_uses_shared_clients` debug line (U10); `onFinalizeExhausted: 'best-effort'` (U3) and
>   `AutoActivation` (U4) unchanged;
> - **changed (breaking behaviour, §13 B12–B15):** the skill plugin host defaults to
>   `strict: true` (U2); `HybridDispatch` fails a step that names an agent the registry lacks with
>   `COORDINATOR_STEP_FAILED` (U5); `lazy`'s `fallback` option is removed (U6, migration line 73);
>   the tool availability blacklist is the injected `IToolAvailabilityPolicy`, none by default —
>   `SmartAgentConfig.toolUnavailableTtlMs` is removed (U8, migration line 74);
> - **confirmed:** D68's removal of the builder's unused embedder breaker and `withCircuitBreakers`
>   (U9);
> - the `closeFns` cleanup bug is tracked as #330 (§15).
>
> **Amended 2026-10-05 (17)** for a review of the plan (§17.25, D75–D78) and the user's
> confirmation of four choices made while writing U5–U8 in (§17.24):
> - **errors, not warnings:** a skill whose embedding or write into the tools store fails rejects
>   `vectorizeSkills`, `build()`, `fillToolsBinding`'s `skills` and the server's start, naming the
>   skill (D75, S-5, B8); a failed bulk write fails its records and is never retried record by
>   record (D76, §3.3); a reload whose drain or invalidation fails restores the previous config and
>   rejects, handled once at the watcher's event boundary (`config_reload_failed`) (D77, V6) —
>   *the restore is withdrawn by D82 (amendment 22): nothing is restored, the server is not
>   ready;* reloads run one at a time — each snapshots only after the previous one settled (D80);
> - **the root span's `error` status** is set before the error chunk is yielded, so a consumer
>   that stops at that chunk (`process()` does) still sees it (D78, §10.5.2);
> - **confirmed by the user:** `SmartAgentConfig.toolUnavailableTtlMs` removed, `PUT /v1/config`
>   with it → 400, the YAML key as the opt-in with no default TTL (U8); `batchFailures` in
>   `/health`'s `toolCatalog` (U7); a missing named agent fails the request only under
>   `failPolicy: 'abort'`, a failed step under `'continue'` (U5); `LazyInitError` keeps the
>   factory error as `cause` (U6).
>
> **Amended 2026-10-06 (18)** for the user's rule "no fallback anywhere; all in #322" (§17.26,
> D79): the **30.1.0** tools path (`vectorizeMcpTools` on an unbound store) no longer answers a
> failed bulk write (`ok: false` or a throw) by writing tool by tool — the batch fails, the
> catalog is reported incomplete with the reason (`complete: false`,
> `ToolCatalogStatus.writeFailure`) and in the summary log line (§10.5.4 R14, §13 B16). U7's
> batch → per-tool **embedding** retry stays, counted.
>
> **Amended 2026-10-06 (19)** for a review finding (§17.27, D80): **config reloads run one at a
> time.** The watcher queues each complete reload transaction (snapshot → agent update → drain +
> invalidation → weights or restore); the next one starts only after the previous one settled,
> so a failed reload's restore can never overwrite a later reload's config (§10.5.9 V6). *The
> snapshot and restore are withdrawn by D82 (amendment 22); the queue stays.*
>
> **Amended 2026-10-06 (20)** for the user's decisions (§17.28 — D80 extended, D79 confirmed):
> - **one queue for every config change.** The server owns one `ConfigTransactionQueue` and hands
>   the same instance to the file reload (V6) and to `PUT /v1/config` (V10). A `PUT` takes its
>   snapshot only after the previous transaction settled, applies, awaits the worker drain and the
>   session invalidation, and when either fails restores the previous config and answers **500**
>   (`server_error`, naming the failure) — the update is not applied (§10.5.9 V10, §13 B17).
>   *The snapshot and restore are withdrawn by D82 (amendment 22): a failed `PUT` answers 500,
>   keeps what it applied and leaves the server not ready; the one queue stays;*
> - **`ToolCatalogStatus.writeFailure?: string`** (D79) — approved by the user (§3.8).
>
> **Amended 2026-10-06 (21)** for a review finding (§17.29, D81): **the startup agent's update is
> inside the `PUT` transaction's rollback.** `SmartAgent.reconfigure` is atomic — when the
> pipeline's `reconfigure` hook throws, the agent restores its previous LLMs and rethrows — and a
> failed startup-agent update restores the server's snapshot too and answers **500**, like a
> failed drain (§10.5.9 V10, §13 B17, B18). *Withdrawn by D82 (amendment 22): with no
> rollback there is nothing for an atomic `reconfigure` to protect; it stays as in 30.1.0.*
>
> **Amended 2026-10-06 (22)** for the user's decision (§17.30, D82 — the goal's row of
> 2026-10-06): **a config change that fails to apply is an error and leaves the server not
> ready; there is no rollback.** A file reload or `PUT /v1/config` whose transaction fails
> anywhere (the agent update, the worker drain, the session invalidation, the startup agent's
> update, any other throw in it) keeps what it applied, rejects (`config_reload_failed`) or
> answers **500**, and sets the server's *config not applied* state, held by the one config queue;
> while it is set, `/health` answers **503** naming the failure (`configNotApplied`) and the chat
> routes answer **503** with it through the gate they already have for MCP readiness. The next
> config change that applies clears it. The server starts ready from its config (a start config
> that cannot be applied fails the start). D80's one queue stays; hot reload stays. Withdrawn:
> D77's restore, the snapshot / restore of V6 and V10 (`snapshotConfig`),
> `LlmCircuitBreakers.snapshot()` and D81's atomic `SmartAgent.reconfigure` — it stays as in
> 30.1.0 (§3.8, §10.5.9 V6, V10, §10.5.10, §13 B10, B17, B18, §14.1).
>
> **Amended 2026-10-06 (23)** for the user's decision (§17.30, D82 (8)): **while the server is not
> ready, only a whole config clears the state.** A whole config is a file reload (it re-reads the
> whole file) or a `PUT /v1/config` that carries every top-level section the route can change on
> this server — `agent`, and `models` when the server has a model resolver — each a non-empty
> object. While the server is not ready, any other `PUT` is refused with **409**
> `invalid_request_error` (code `config_not_applied`, `server not ready — send the whole config:
> <missing sections>`) and changes nothing: before the queue (no model resolved or probed) and
> again when its transaction starts, since a transaction ahead of it can fail while it waits.
> While the server is ready, a partial `PUT` works as before. The consumer guidance of B17 is now
> this rule (§10.5.9 V10, §10.5.10, §13 B17, §14.1).
>
> **Amended 2026-10-06 (24)** for a review finding (§17.31, D83): **every config field a running
> server changes is validated before it applies.** One validator in server-libs checks every field
> the file reload reads and every field `PUT /v1/config` accepts — numbers finite and in their
> range, flags true or false, prompts, the log directory and model names non-empty strings — with
> no coercion. An invalid file reload fails its transaction before anything applies (the server
> not ready, `config_reload_failed`, the reason naming each invalid field); an invalid `PUT` is a
> 400 naming the field, before the queue. `ConfigWatcher` no longer coerces: its `reload` event
> carries the file's values as read (`HotReloadableInput`) (§3.8, §10.5.9 V6, V10, §13 B19, §14.1).
>
> **Amended 2026-10-06 (25)** under the user's rule (no silent degradation; everything in this
> change), D83 (5): **the start config uses the same field validator.** The server's start no
> longer coerces a field of the *Config field rules* table with `Number()` / `Boolean()`: the YAML
> it starts from (a worker file included) and the `ResolveConfigArgs` overrides
> `agent-show-reasoning` / `log-dir` are checked by the same rules before anything is built, and an invalid value fails the
> start (exit code 1) with the same `invalid config — <field> <rule>, got <value>` message
> (§10.5.9 *Config field rules*, §13 B20, §14.1, §17.32).
>
> **Amended 2026-10-06 (26)** for the user's decisions (§17.33, D83 (6), (7)): **a number may be
> written as a number literal string, a flag as `"true"` / `"false"`, and every config field that
> was coerced is validated.** One grammar for every input (start, reload, `PUT`): a numeric field
> takes a number or a string that is exactly a JSON number literal (no spaces, no `NaN` /
> `Infinity`, no hex), then the field's rule; a flag takes `true` / `false` or exactly `"true"` /
> `"false"` — so `${VAR}` substitution keeps working at start. Every other field the start coerced
> with `Number()` / `Boolean()` / `String()` (the `agent`, `llm`, `rag.store`, `rag.embedder`,
> `mcp`, `decision`, `skillPlugins` fields, the stepper's section, `port`) gets a rule in the same
> validator and fails the start when invalid; the "not covered" list is gone. `optionalNumber` is
> removed from server-libs (migration line 75) (§10.5.9 *Config field rules*, §13 B19, B20, §14.1,
> §17.33).
>
> **Amended 2026-10-06 (27)** for the user's decisions (§17.34, D83 (8), (9)): **the file reload
> substitutes `${VAR}` exactly as the start does, and every config field read by a type cast is
> validated.** `ConfigWatcher` takes an injected document resolver (`ConfigWatcherOptions.resolveDocument`,
> additive) and applies it to the whole parsed file before it reads a field; the server passes
> the start's own `resolveEnvVars` (server-libs `yaml-loader.ts` — one implementation, the same
> `${VAR}` / `${VAR:-default}` syntax, the same process environment), so a reload of a file reads
> what a start from it reads — `rag.store.type: ${STORE}` included. Every config field the start
> read by an `as` cast without a check (`agent.retry`, `agent.toolSelection`,
> `agent.externalToolsValidationMode`, `mcp.toolTimeouts`, `mcp.headers`, the single form's
> `url` / `command`, every field of an `mcp[]` entry, `llm.url` / `llm.model` and each role's,
> `host`, `mode`, `pluginDir`, `plugins`, `skills`, `pipeline.config`, the linear, DAG,
> controller and stepper sections' cast fields) gets a rule in the same validator, the same
> grammar and the same `ConfigFieldError`; the "not part of this decision" sentence is gone
> (§10.5.9 *Cast-read fields*, *The start config*, §13 B21, B22, §14.1, §17.34).
>
> **Amended 2026-10-06 (28)** for a review finding (§17.35, D82 (9)): **a config file the watcher
> cannot read, parse or resolve is a failed reload.** `ConfigWatcher` emits `error` instead of
> `reload` when the file is missing or unreadable, is not valid YAML, or the injected
> `resolveDocument` throws; the server only logged it (`config_reload_error`), so a ready server
> kept serving the previous config while its file was broken. Now the server queues the error as
> a reload transaction that fails — in the same config queue, in order with `PUT /v1/config` and
> the other reloads — so it sets the *config not applied* state (the server not ready: `/health`
> and the chat routes 503) until a whole config applies, and it is logged `config_reload_failed`
> like every other failed reload (§10.5.9 V6, §10.5.10, §13 B17, §14.1).
>
> Every path that creates or refreshes a tools store is audited in §6.4. Earlier open choices are
> settled by the recommendations applied in §17.9; the user may still overrule them.

## TL;DR

- **The consumer decides the behaviour.** A profile is a **composition of strategies the consumer
  injects**: indexing, candidate pool, collapse, reranker, final cut, query decomposition. The
  consumer makes the main behaviour choices by choosing those strategies (goal decision
  2026-10-05).
- **Shipped "variants" are named compositions, not the centre of the design.** A named composition
  only fills in what the consumer did not choose. Taking one whole is one choice among many.
- **Nothing that ships carries a tuned number** (goal decision 2026-10-05, D55). The measurements
  behind this design were made in a consumer (cloud-llm-hub, on mcp-abap-adt) and are not in this
  repository, so they justify no default. A number a strategy or a named composition needs is a
  **required argument** from the consumer or a **generic default**: the caller's k for every cut,
  a pool of k items (`ItemPool()`, D56). The evidence (§2) stays as motivation only.
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
  injected → the query runs as is. No named composition uses it; no implementation ships.
- A profile is **bound** to each store of its kind (`profile.bind(...)`), so one profile serves
  several stores (e.g. reader and writer tool stores).
- **A tools store is filled once, when its instance is created** — never refilled while running
  (D41). No refill API, no fill memo, no retry: an incomplete fill is reported (`complete: false`,
  `/health` `degraded`, the logged summary line) and stays. **A reconnect's `toolsChanged` writes
  nothing into a bound store** (D46): until it is filled the pipeline and its MCP do not work, so
  its tool list cannot change under a working pipeline; an MCP server plugged in at runtime is the
  consumer's pipeline's concern (§15). Without a profile, 30.1.0's re-vectorize is unchanged.
- **Where the records come from is a strategy the consumer injects** — `IToolsFillSource` (§3.10),
  attached to the store with its binding (D42). Three ship:
  1. **`live`** (default) — the MCP tool list, indexed through the profile at creation (30.1.0);
  2. **`corpus`** (`ToolsCorpusLoader`, any store — in-memory or persistent) — a corpus the
     consumer's **build step** made with the same profile's indexer (records + vectors). At start
     the source checks the corpus's identity against what the server is configured with, **clears
     the store**, writes the corpus with its precomputed vectors (**no embedding call**) and logs
     it (D54). An interrupted load repeats at the next start; an incompatible corpus, or a store it
     cannot clear, fails loudly before any write;
  3. **`consumer`** — the library never writes; the consumer fills through `bound.index` /
     `fillToolsBinding`.
- **The corpus flow has two layers (§6.5, D54):** the **build step** is the consumer's (with the
  libs API `buildToolsCorpus`); the **load at start** is the server's (or a builder consumer's
  composition root), through the `corpus` source in libs. There is no deploy step and no record of
  the corpus in the store. Collections that change while running (session, history, user
  collections, shared items) are not filled by these strategies (§6.6).
- The retrieval half **is** a 30.1.0 `IRetrievalStrategy`, so every path that already honours
  per-store strategies gets it with no new wiring.
- **Nothing changes by default** on the success path. No profile set → 30.1.0 behaviour, byte for
  byte (golden test). Failure paths change everywhere: they fail loud (§10.5, §13 B1–B17).
- **Everything is a strategy (DI).** A profile is a **composition** of injected strategy
  instances: indexing, candidate pool, collapse, query decomposition (optional), reranker,
  final cut. No booleans where a strategy is the choice. YAML only maps names to instances, in the builder.
- **Profiles for different MCP servers (goal 9).**
  - The **shipped** tools strategies read only what any MCP server exports: name, description,
    input schema (property names, descriptions, enum values). None parses one server's naming
    convention (§7.0).
  - Fine-grained and coarse tool sets are both served by the same strategies (records per item,
    a pool counted in items, a reranker, a count cut or a token-budget guard); which fits a set is
    the consumer's choice and measurement (§7.4, §14.3).
  - Where no shipped strategy fits a server, the **consumer builds its own** from the contracts and
    uses it in the pipeline; the contracts are sufficient for that (§7.9).
- Default profiles ship:
  1. **MCP tools — three named compositions** (§7.4), no tuned numbers:
     - `baseline` = 30.1.0 (one record per tool, top-k) — what a consumer gets by choosing nothing;
     - `faceted` = `full` + `summary` + `parameters` records (all schema-derived), an item pool of
       the caller's k (or the consumer's `poolItems`), collapse by max, the caller's k (or the
       consumer's `maxItems`);
     - `faceted-rerank` = faceted + the reranker the consumer gives (in YAML: the one `decision:`
       provider's — `ProbabilityReranker` over Jev or `RelevanceReranker` over Cohere on SAP AI
       Core) over a pool of **`poolItems`, required**: a reranker over a pool of k items could only
       reorder what stage 1 already returned.
     **Records come only from what the provider exports** — no LLM-generated intents, no companion
     stores: intents were measured and dropped (§2.1, D50).
  - **Generic strategies in no named composition, the consumer's to inject** — each documented with
    what the consumer's measurement showed:
    - `EnumValueToolIndexer` (one record per enum value): measured **worse** on one coarse set
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
  - Old names are **not kept**: this is a major release, and the CHANGELOG lists every rename and
    move with its new import (§13, D58).
  - YAML keeps **one** `decision:` section: `provider: typesafe` → probability, `provider:
    sap-aicore` → relevance; `reranker: decision` builds the matching reranker (§6.2).
- A reranker that returns a wrong or missing score count is a **reranker error**, counted and
  traced — never silent.
- In-scope fixes: the store's embedder hidden behind `StrategyRag`; de-duplication in
  `tools-rag-handle` and `skill-select`; the orphan `IToolIndexingStrategy` is deleted;
  **`FallbackRag` is removed** and the builder no longer wraps registered stores: with the
  embedder circuit breaker open, a store's query fails fast with an error instead of answering
  from an in-memory copy (§10.4, D68).
- **Fail loud (§10.5, D69–D74).** A component that finds another not working returns an error —
  never a fake success, an empty result, a skipped part, a stale cache or a substitute. Pipeline
  errors now reach the consumer at all (D70, a bug fix); the reranker's `onFailure: 'stage1'` is
  removed (D71); `/health` answers 503 when a configured component is not working (D72); the
  store embedder stands in only for a pipeline without an embedder (D73). The modes a consumer
  chooses were decided by the user (§17.24, §10.5.12, U1–U10): explicit opt-ins stay (counted or
  logged where they degrade); the skill plugin host defaults to `strict: true`; a named agent
  missing from the registry fails its step; `lazy`'s `fallback` is removed; the tool availability
  blacklist is an injected policy, none by default.
- **The RAG implementations live in `@mcp-abap-adt/llm-agent-rag`** (D53, D57, §11.3). `VectorRag`,
  `InMemoryRag` and the other RAG implementations — their files — move there in
  this PR; `@mcp-abap-adt/llm-agent` stops exporting them (no aliases, no subpath). Nothing left in
  `llm-agent` imports them, so there is no cycle. Store helpers the store packages below
  `llm-agent-rag` need (`AbstractRagProvider`, the query embeddings, the identity filter) stay in
  `llm-agent` (§11.3). `OllamaRag` is removed (S11, decided by the user, §17.18).
- **No package re-exports another package's names** (D59): every package, ours included, imports
  a name from the package that owns it — the pre-existing re-exports are removed in this major too
  (S12, decided by the user; §11.4).
- **Every part of this design lives in exactly one layer** — the consumer, the llm-agent framework
  (contracts; generic implementations), llm-agent-server, or the pipelines in llm-agent. The map
  is §11.1; the audit of suspected misplacements and how each is resolved is §11.2.

---

## 1. Terms

| Term | Meaning | Example |
|---|---|---|
| **Item** | One source thing a consumer wants back | one MCP tool; one shared item |
| **Record** | One row in a store: physical id + embedded text + metadata | the `summary` record of `tool:read_file` |
| **Item id** | The **logical** id a writer or provider chooses (`metadata.itemId`). Not unique in a store | `tool:read_file` |
| **Record id** | The **physical** store id: owner scope + owner key + item id + kind + index (§3.1) | `g:/tool%3Aread_file#summary:0` |
| **Record kind** | Which view of the item a record is | tools: `full`, `summary`, `parameters`, `value` (+ a consumer's own); shared items: `item` + the writer's own kinds |
| **Fine-grained tool set** | Many tools, one per operation **and** object, short schemas | example: mcp-abap-adt's object-oriented set — 345 tools, median ~840 chars (`GetClass`, `UpdateDomain`) |
| **Coarse tool set** | Few tools, one per operation, the object passed in a parameter, large schemas | example: mcp-abap-adt `compact` — 25 tools for the writer role (16 for the reader), `object_type` enum; the whole writer set ≈ 7.9k tokens mean / 9.9k p90 per query |
| **Discriminating parameter** | The input-schema property whose enum values name the different things a coarse tool acts on (§7.3.2) | example: `object_type` in mcp-abap-adt `compact` |
| **Definition size** | Size of the tool definition the LLM receives: name + description + input schema, as exported (§4.10) | `HandlerCreate` ≈ 5k chars (mcp-abap-adt `compact`) |
| **Canonical record** | The item's record of the indexer's `canonicalKind`, index 0. Its text is the item text; its metadata is the item's payload | `full` (tools), `item` (shared items) |
| **Owner-qualified item** | (owner scope, owner key, item id) — what collapse, `get` and `remove` key on | (`user`, `alice`, `case-42`) |
| **Provider text** | What the tool provider exports: name, description, input schema (property names, descriptions, enum values) | the `full` record's text |
| **Store** | One `IRag` instance, addressed by its `ragStores` key | `tools`, `shared`; a consumer's per-role tool stores (e.g. `tools-reader`, `tools-writer`) |
| **Source** | One store a retrieval queries, with its own identity filter; it holds whole items (their canonical records) | the tools store, the `user` partition, the `global` partition |
| **Partition** | A store that holds the shared items of one visibility | the `user` store, the `global` store, one group's store |
| **Collection kind** | The kind of items a store holds | MCP tools, shared items, skills, user collections, history |
| **Profile** | The indexing + retrieval pair for one collection kind (`ICollectionProfile`) — a composition of strategies | `ComposedToolsProfile` |
| **Variant** | A **named composition**: a shipped set of strategy instances for one kind. It fills in what the consumer did not choose and carries no tuned number — a number it needs is a required argument or the generic default (§7.1, D55) | `faceted`, `faceted-rerank` |
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
| `ISearchStrategy` (+ `ISearchCandidate`, `ISearchQuery`, `IScoredResult`, `ISearchContext`) | in-store scoring (vector / BM25 / fusion) — `VectorRag`'s option types | unchanged, **moved with `VectorRag`** to `@mcp-abap-adt/llm-agent-rag` (§11.3, D57) |
| `IRetrievalStrategy` | wrapper around a store: candidates → rerank → top-k | reused as the retrieval half |
| `IToolSelectionStrategy` | post-filter of all stores' flattened results | untouched |
| `IToolIndexingStrategy` | orphan, unexported | **deleted** (§10.3) |
| `IQueryPreprocessor` / `IQueryExpander` | in-store / pipeline query rewrites, one text → one text | unchanged, moved to `llm-agent/src/interfaces/` (same root export, §11.3); query decomposition (one query → budgeted sub-queries) is the new `IQueryDecomposer` (§4.5) |
| `RagCollectionOwner` | owner of a whole **collection** (catalog record) | untouched; a **record's** owner is `RecordOwner` |
| `IReranker` | `rerank(query, results, options)` | unchanged; `ProbabilityReranker` and `RelevanceReranker` implement it |
| `IDecisionModel` | `decide({ state, questions })` → typed answers | **renamed `IProbabilityDecision`** (same members); the old name is removed (§3.9, §13, D58) |
| `DecisionReranker`, `DecisionRerankerOptions` | reranker over `IDecisionModel` | **renamed `ProbabilityReranker`, `ProbabilityRerankerOptions`**, moved to `@mcp-abap-adt/llm-agent-reranker`; old names removed, libs re-exports nothing (§5.4, §13, D58, D59) |
| `DECISION_RERANK_DEFAULT_TASK`, `DECISION_RERANK_DEFAULT_CRITERIA` | the probability reranker's default wording | **renamed `PROBABILITY_RERANK_DEFAULT_TASK`, `PROBABILITY_RERANK_DEFAULT_CRITERIA`**, moved with it; old names removed |
| `wrapDecisionModel` | usage-logging adapter of a decision model | **renamed `wrapProbabilityDecision`**, stays in libs (§5.4); the old name is removed |
| `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` | rerankers / wording presets in libs | **moved** to `@mcp-abap-adt/llm-agent-reranker`, names unchanged; libs no longer exports them (D59) |
| `DecisionRequest`, `DecisionResult`, `DecisionQuestion`, the answer types, `DecisionEntry`, `DecisionError`, `DecisionErrorCode` | the decision vocabulary | **unchanged**: still `IProbabilityDecision`'s request and answers; `DecisionError` and its codes serve both decisions (§3.9) |
| `TypeSafeDecisionModel`, `SmartServerDecisionConfig` | Jev provider; `decision:` type | unchanged names |
| `BuildAgentDeps.makeDecisionModel` | probability seam | **renamed `BuildAgentDeps.makeProbabilityDecision`** (typed `IProbabilityDecision` — the same type); `makeDecisionModel` is removed (§3.8, §13, D58) |
| `createMakeDecisionModel` (app, `make-decision-model.ts`) | the app's probability seam | **renamed `createMakeProbabilityDecision`** in `make-probability-decision.ts` — internal to the app (not exported from `@mcp-abap-adt/llm-agent-server`), so no alias |
| — | new | `IRelevanceDecision`, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore`, `RelevanceReranker`, `RelevanceRerankerOptions`, `wrapRelevanceDecision`, `BuildAgentDeps.makeProbabilityDecision`, `BuildAgentDeps.makeRelevanceDecision`, package `@mcp-abap-adt/llm-agent-reranker`; in `sap-aicore-decision`: `SapAiCoreRelevanceDecision`, `SapAiCoreRelevanceConfig`, `FetchLike`; reserved record key `staleRecordIds` |
| — | new | `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IIndexNoteSource`, `IndexNote`, `isIndexNoteSource`, `IndexedRecord`, `RecordDraft`, `recordId`, `RecordOwner`, `ItemRef`, `ICandidatePool`, `ICollapseRule`, `IItemCut`, `ISizeBoundedCut`, `isSizeBoundedCut`, `IQueryDecomposer`, `SubQuery`, `ISourceSelector`, `RetrievalSource`, `IRetrievalMetrics`, `ToolItem`, `ToolParameter`, `ToolParameterValue`, `IToolFacet`, `IDiscriminatorSelector`, `IItemSizeEstimator`, `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `StagedRetrieval`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `CharsPerTokenEstimator`, `ToolDefinitionSizeEstimator`, `SharedItemsProfile` |
| — | new (fill sources, §3.10, §6.5) | `IToolsFillSource`, `ToolsFillContext`, `LiveToolsFill`, `ToolsCorpusLoader`, `ConsumerToolsFill`, `buildToolsCorpus`, `parseToolsCorpus`, `ToolsCorpus`, `ToolsCorpusRecord`, `ToolsCorpusManifest`, `ToolsCorpusIdentity`, `ToolsCorpusExpectation`, `SmartServerConfig.toolsFillFactories` |
| `VectorRag`, `InMemoryRag` and the other RAG implementations of §11.3 | RAG implementations in the contracts package | **moved** (files and exports) to `@mcp-abap-adt/llm-agent-rag`, names unchanged; `@mcp-abap-adt/llm-agent` no longer exports them; no subpath, no alias (§11.3, D53, D57) |
| `OllamaRag` (`ollama-embedder`) | `VectorRag` with an Ollama embedder | **removed** (S11, §17.18): `new VectorRag(symmetricEmbedder(new OllamaEmbedder(cfg)), cfg)` replaces it |
| `FallbackRag` (`llm-agent`); `SimpleRagRegistry.replaceRag`; `SmartAgentBuilder.withCircuitBreakers` | the circuit breaker's store wrapper (an in-memory copy answering while the embedder breaker is open); the registry swap and the builder option that existed only for it | **removed** (D68, §10.4; §13 lines 5, 71, 72) — no replacement in the library |

Every new name above was checked with `git grep -w` over `packages/`: 0 hits (2026-10-05; the
fill-source names re-checked the same way on the same day; `ToolsCorpusExpectation`,
`facetedRerank` / `faceted-rerank` checked on 2026-10-05 for amendment 12; the subpath
`rag-implementations` checked then too, and withdrawn by amendment 13).

---

## 2. Why this shape (evidence → design)

### 2.0 Scope of the evidence

- **Motivation only — it sets no default** (goal decision 2026-10-05, D55). The measurements were
  made in a consumer (cloud-llm-hub, on mcp-abap-adt) and are **not in this repository**: the full
  reports are in the cloud-llm-hub repository, branch `research/tool-rag-accuracy`, under
  `docs/research/2026-09-30-tool-rag-accuracy/`. They explain why the design has its parts
  (records per item, collapse, a pool in items, rerankers on provider text, a token-budget guard);
  no number below is shipped in a strategy or a named composition (§7.1). The "design
  consequence" columns name the **mechanism** a figure motivates, never a default value.
- **One consumer, one server, two tool sets.** Every figure below comes from cloud-llm-hub over
  **one** MCP server (`mcp-abap-adt`): its fine-grained set (§2.1–§2.3) and its coarse `compact`
  set (§2.5). It is evidence for the design, **not** the target platform (goal *Purpose*).
- **What carries over to any server:** the retrieval mechanics — items vs records, collapse by max,
  the pool in items, rerankers on provider text. They do not depend on what the tools are called.
- **What does not carry over:** any record whose text came from parsing **this** server's tool
  names. The measured `object` record did (§2.1, last row); it is not in any named composition.
- **Coarse tool sets are measured on one example** (`compact`, §2.5). Its results document why two
  generic strategies are in no named composition (`EnumValueToolIndexer`, `TokenBudgetCut` as the
  main cut); they set no number.
- **The schema-derived `ParametersFacet` is not measured yet** on the fine-grained set. The closest
  measured layouts are in §2.1; a consumer measures the schema-derived one on its own catalog
  (§14.3).

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
| LLM-generated intents, stage 1 only (hybrid, k=5): inside `full` 0.954; own `intent` record 0.954; none 0.943; both 0.954 — 1 row apart, **within noise** | intents **dropped** (D50): no gain to pay for |
| Intents **with a reranker** (several records per tool): every layout — inside the record, in its own record, absent — within noise; **no better** than none (goal *Evidence*) | same |
| The reranker reads the provider text **equal or better without** intents, for Cohere and for Jev (goal decision 2026-10-04) | same; the reranker reads the provider text (§4.6) |
| Intents cost an **LLM generation at build**, a regeneration on every tool change, and **audits** — one audit found poisoned intents (cloud-llm-hub: 19 defects in 258 intents, among them a `$TMP` package hint in 16 `Delete*` tools) | same: a weak description is fixed at its source (goal decision 2026-10-04) |
| Intents **restate and can mislead**: for `CreateDdl` (mcp-abap-adt example) they restate the description ("create CDS view, create classic view, new DDL source…"), and the generated "create database view" names a **different object type** than the tool creates — a misleading hint, not extra signal | same |
| The measured third record, `object`, was "the name words after the first word" — it assumes names are verb-first (`GetWhereUsed` → `where used`), a convention of one server | **not** in any default: kept only as the opt-in, convention-dependent `NameTailFacet` (§7.3). The default third record is schema-derived (`parameters`), **not yet measured**: the `faceted*` defaults cite the two closest measured layouts above (both 0.966 at k=5); the consumer check measures the schema-derived one (§14.3) |
| The measured `operation` record ("name words — first description clause") only tokenizes the name; it assumes no order or vocabulary | kept, renamed **`summary`** (same text): nothing in it is server-specific |

### 2.2 Retrieval

| Measured | Design consequence |
|---|---|
| Cross-encoder rerank: non-English 0.692 → 0.962; cosine stage 1, English 0.885 → 0.943 | reranker on **items** |
| Reranker text **without** intents is equal or better, for Cohere and for Jev (goal decision 2026-10-04) | the reranker reads the **provider text** (§4.6); intents dropped (§2.1, D50) |
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

- With the corrected labels, **no named composition needs splitting.** The earlier measured gain came
  mostly from the mislabelled queries above and from Cohere's ranking.
- Cutting the split's union back to k was measured **worse than no split at all**.
- A genuinely dependent second step is a separate step for the planner anyway.
- **Design consequence (§4.5, goal decision 2026-10-05):**
  - the framework provides the component: an injected `IQueryDecomposer` that `StagedRetrieval`
    calls;
  - no named composition uses it and no implementation ships;
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

**What it motivates** (mechanisms, not defaults — D55):

- **One record per tool is enough for a small coarse set — when a reranker reads it.** Stage 1
  alone needs k=5 (0.955) or a 4k budget (0.985). Jev with k=3 reaches 0.970 at **1.6k tokens**,
  about a fifth of sending the whole set.
- **Stage 1 adds nothing for a set this small.** Jev over the whole role set equals Jev over a
  stage-1 pool (both 0.970 at k=3). A consumer with a small set can rerank the whole set: 30.1.0's
  `rerank-all` (`maxCandidates` = its tool count), or `faceted-rerank` / `compose` with
  `poolItems` ≥ its tool count (§7.4, §7.5).
- **Per-value records hurt here.** C1 is worse on stage 1 alone, and with Jev it loses non-English
  queries (0.857 vs 1.000). → `EnumValueToolIndexer` stays a generic strategy a consumer may inject
  (another server's coarse set may differ), documented with this result, and is in **no** named
  composition (§7.3.2).
- **A token budget is worse than a count as the main cut.** At equal tokens (~1.6k) the 2k budget
  gives 0.910 and k=3 gives 0.970: the cut stops at the first tool that does not fit (§4.10). →
  `TokenBudgetCut` stays a generic **prompt-size guard** a consumer may inject, in **no** named
  composition.
- **The k=3 knee is this consumer's calibration**, not a default: no shipped composition cuts at a
  measured k (§7.4, D55). The earlier `small-set-jev` composition that shipped it is withdrawn.
- **The coarse set reaches the fine-grained set's recall** (0.970 vs 0.969) at fewer tokens
  (1.6k vs 2.1k) — on one server's example; another server measures its own (§14.3).

---

## 3. Contracts — `@mcp-abap-adt/llm-agent`

New file `packages/llm-agent/src/interfaces/collection-profile.ts`. All additive; `IRag`,
`IReranker`, `IRetrievalStrategy`, `IMetrics` are not changed. The decision contracts (§3.9) live in
`interfaces/decision-model.ts`: one rename (the old name removed, D58), one new contract.

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
 *  `staleRecordIds` (canonical only): old record ids a replacement must still delete; kept until a
 *  delete succeeds (§3.3). */
export type ReservedRecordKey =
  | 'id' | 'itemId' | 'recordKind' | 'itemText' | 'profile' | 'recordIds' | 'staleRecordIds'
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
  /** Pure mapping item → record drafts: exactly one draft of `canonicalKind`, plus the item's
   *  other records. The binding assigns ids. */
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
 * its indexer, when it has it, after `toRecords` and copies the notes into
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

/** The tools profile's target: one store. */
export interface CollectionStore extends BindTarget {
  readonly rag: IRag;
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
- **Why the target is a type parameter:** the tools profile binds one store; the shared-items
  profile binds partitions (§3.6). One contract, each profile's own target shape,
  checked by the compiler.
- **Why `recordIds` on the canonical record:** a writer may change an item's record kinds and
  counts. Replacement and removal read the canonical record and delete what it lists — no guessing
  ids.
- **Why `staleRecordIds` (approved review finding):** a stale-record
  delete can fail. Without a list, the id is forgotten and the record outlives the item. With it,
  the next `index` or `remove` of the item retries the delete (below).

**Replacing an item is not atomic — and the framework does not try to make it so.**

- `index` of an existing item = several per-record writes: new non-canonical records, then the
  canonical record (with the new `recordIds`), then deletes of the old ids it no longer lists. A
  store's bulk write (`upsertManyPrecomputedRaw`) is all-or-nothing per batch, but the deletes are
  separate calls; nothing spans them.
- **A failed write is reported, never retried another way** (D76). When the records were written
  with the store's bulk write and that call fails (`ok: false` or a throw), every record of the
  batch is failed with the bulk write's error, and every item with a record in it is reported in
  `failedItems` with the reason `write-failed: bulk write failed: <error>`. The writer does **not**
  retry the batch record by record: a store that refused the batch is not asked again through
  another write path (a silent substitution). The per-record write is used only where the bulk one
  is not available (no `upsertManyPrecomputedRaw`, or no precomputed vectors — the store embeds);
  there a record's failure fails that record, with its own error in the reason. The one retry
  that stays is U7's, on the **embedding** (a failed batch embedding → per-record embedding by the
  store, counted in `batchFailures`) — never on a write. The settle write of step 4 below is a
  write too: when it fails the item is reported (`cleanup-failed: …`), never counted indexed.
  The 30.1.0 tools path (an unbound store) follows the same rule (D79, §10.5.4 R14).

**Cleanup failures are kept, never reported as success** (approved review finding — failure
handling, not a concurrency protocol: no generations, no locks, D13 stands).

| Step | What |
|---|---|
| 1. stale set | (old `recordIds` ∪ old `staleRecordIds`) − the new ids |
| 2. write ahead | the new canonical record carries the stale set in `staleRecordIds` (absent when empty) |
| 3. delete | every stale id, each `deleteByIdRaw` **`Result` checked**; `ok` (deleted, or already absent → `false`) counts as done; `ok: false` or a throw keeps the id |
| 4. settle | if the stale list changed, the canonical is rewritten with exactly the ids still pending (key absent when none) |
| 5. report | any id still pending → the item is **not** indexed: `failedItems` reason `cleanup-failed: <n> stale record(s) kept for retry`; `indexedItems` excludes it. A failed settle write (step 4) → the same, reason `cleanup-failed: the settled stale list was not written: <error>` (the written-ahead superset stays; the retry's delete of an already-deleted id is a no-op) (D76) |

- **Retry:** the next `index` of the item folds the pending ids into its stale set (step 1);
  `remove` deletes listed **and** pending ids. A retry of an already-deleted id is a no-op
  (`deleteByIdRaw` → `ok: true, false`).
- **`remove` with a failed delete:** it tries every listed and pending id, keeps the canonical
  record (so a retry still finds the list) and returns a `RagError` naming how many deletes failed.
  The item stays whole and readable until a retry succeeds.
- **Step 4 fails** (the settling rewrite): the written-ahead list stays — a superset of what is
  pending; retries of the deleted ones are no-ops. The item's report follows step 5.
- **Tested:** replacement → a failed stale delete → not indexed, id listed → retry `index` → the
  record is gone, list cleared; then `remove` leaves nothing in the store (§14.1).
- **Duplicate item ids in one batch are rejected** (D61): an `index` batch holding the same owner-qualified item id more than once (two versions of one item) returns `ok: false` with a `RagError` naming each duplicate (`user:A/case-42 (2×)`), checked over the whole batch before any store read or write — nothing is written, in any partition (no partial writes). Unchecked, both versions read the same old canonical and the losing version's records end up listed nowhere.
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
  readonly source: string;                 // the source it came from
  readonly owner: RecordOwner;             // read back from the hits' metadata (visibility + keys)
  readonly itemId: string;
  readonly score: number;                  // per the rule
  readonly hits: readonly RagResult[];     // the item's records among the candidates, best first
}

/** The candidate strategy: how many items stage 1 hands on, and how deep to query for them.
 *  Both take the caller's k of the (sub-)query, so a pool can default to it (D56). */
export interface ICandidatePool {
  readonly name: string;
  /** Items kept per source after collapse, for a (sub-)query whose k is `requestedK`. */
  items(requestedK: number): number;
  /** Records to ask one source for, given that k and the indexer's bound on records per item. */
  recordsToFetch(requestedK: number, maxRecordsPerItem: number): number;
}

/** Records → items. Key = (source, owner scope, owner key, itemId) — the owner-qualified
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

/** One store a retrieval queries. It holds whole items — their canonical records and their other
 *  records — so a hit belongs to the source it came from. */
export interface RetrievalSource {
  readonly name: string;                   // reported in telemetry: 'primary', 'user', 'global', 'group:<id>'
  readonly rag: IRag;
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

### 3.5 Tool items

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
```

No contract for generated text: every tool record is built from `ToolItem`, i.e. from what the
provider exports (D50).

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
| `ToolItem`, `ToolParameter`, `ToolParameterValue`, `IToolFacet` | typed input of the tools indexers; facets are indexing strategies a consumer may write. `parameters` replaces the earlier `parameterNames`: goal 9 requires records from the whole input schema (descriptions, enum values), and names alone cannot carry them. The raw `inputSchema` is there so a consumer can build a profile for **any** server from the contracts (goal 9, §7.9). `definitionChars` is what a token budget measures (§4.10) | builder (libs) + indexers + consumers that bring their own facets |
| `IToolTextComposer` | review finding 4 (schema text in the provider record), measured within noise (§7.3.1): how much of the schema the provider text carries is a choice the consumer may inject, not a rule fixed inside `FacetedToolIndexer`. The default text is unchanged (C0, 30.1.0's text plus parameter names) | libs (`FacetedToolIndexer` and the three shipped composers), server-libs (YAML name → instance), consumers |
| `IDiscriminatorSelector` | goal 9, coarse tool sets: which parameter's values become records is a choice the consumer may inject, not a rule fixed inside the indexer (§7.3.2). Serves `EnumValueToolIndexer`, a generic strategy in no default | libs (`EnumValueToolIndexer`), server-libs (YAML), consumers |
| `IItemSizeEstimator` | goal 9, token-budget cut (a prompt-size guard in no default): how an item's size is counted is injected, so a consumer can bring its model's tokenizer (§4.10) | libs (`TokenBudgetCut`), consumers |
| `ISizeBoundedCut` + `isSizeBoundedCut` (S6) | "never silent" for a size guard: `over_budget` and `cut.tokens` / `cut.budgetTokens` (§4.10, §9.1) need the cut's budget and estimator, which `IItemCut` does not carry. An optional capability, so count cuts stay as they are | libs (`TokenBudgetCut` implements it, `StagedRetrieval` reads it), consumers' own size cuts |
| `IIndexNoteSource` + `isIndexNoteSource`, `IndexNote` (S1) | goal 3 + "never silent": an indexing strategy that declines to guess (an ambiguous discriminator, §7.3.2) needs a channel into `IndexReport.notes`; `toRecords` returns only drafts. An optional capability, so other indexers stay as they are | libs (`RequiredEnumDiscriminator`, `EnumValueToolIndexer` forwards; bindings collect), consumers' own indexers |
| `IItemCut.limit()` — doc only: an **upper bound** in items | already the meaning ("the most items `cut` returns"); stated explicitly so a cut that stops earlier (score floor, token budget) is honest under the same signature. No signature change | — |
| `SharedItem`, `SharedItemVisibility`, `ISharedItemGroups`, `SharedItemsStores` | goal 7: what writing elements get; owner + visibility | libs (profile) + consumers (writing elements, group partitions) |
| `IndexReport.notes?` | goal 9 + "never silent": an indexer that declines to guess (ambiguous discriminator) must say so without failing the item | libs (indexers), consumers reading the report |
| `IRetrievalMetrics` | reranker errors must reach metrics and `/health` (goal *Evidence*) without growing `IMetrics` (principle 4) | metrics implementations live in libs; consumers plug their own backends |
| `IRetrievalEmbedderOwner` | replaces the `(toolsRag as any).embedder` read — a cast that erased a type and is the cause of F1 | implemented by `VectorRag` (`llm-agent-rag`) and the qdrant / pg-vector / hana provider packages |
| `HealthComponentStatus.toolCatalog.records?`, `.profile?`, `MetricsSnapshot.retrievalOutcome?` | additive optional fields for §9 | where the health types already live |
| `IDecisionModel` → **`IProbabilityDecision`** (rename; `IDecisionModel` removed — D58) | goal decision 2026-10-05: a probability and a relevance are different decisions, named by what the decision is based on. Same members, so an implementation changes only the name it implements (`TypeSafeDecisionModel` in this PR; a consumer's per the migration line, §13) | `@mcp-abap-adt/llm-agent` (`decision-model.ts`), where it lives |
| **`IRelevanceDecision`**, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore` (§3.9) | goal decision 2026-10-05: a cross-encoder scores passages against a query and gives no probability, so it cannot honestly implement `IProbabilityDecision` (whose `NoulAnswer.probability` must be P(yes) in [0, 1]). Each type is the minimum: a request (query + passages), a result (one score per passage + the model id), one score entry (index + score) | `@mcp-abap-adt/llm-agent`: implemented by a provider package (`sap-aicore-decision`), consumed by `llm-agent-reranker` and server-libs |
| `DecisionError` / `DecisionErrorCode` reused by `IRelevanceDecision` — **no new code** | every failure of a relevance call already has a code (`DECISION_INVALID_REQUEST`, `_AUTH`, `_RATE_LIMITED`, `_UNAVAILABLE`, `_ABORTED`, `_ERROR`); `DECISION_UNSUPPORTED_QUESTION` is simply never returned (a relevance request has no questions). Nothing widens the shared set | — |
| `BuildAgentDeps.makeRelevanceDecision?` (new optional seam) | the provider decides the kind of decision (§6.2), and a relevance provider returns `IRelevanceDecision`, which the probability seam (typed `IProbabilityDecision`) cannot return. A second optional seam keeps both typed and leaves every existing probability seam compiling; a union return type would break code that calls the seam. Approved by the user (D29, §17.7) | `@mcp-abap-adt/llm-agent-server-libs` (`smart-server.ts`, `resolve-retrieval.ts`), beside `makeProbabilityDecision` |
| `BuildAgentDeps.makeDecisionModel?` → **`makeProbabilityDecision?`** (rename; `makeDecisionModel` removed — D58) | the user's decision 2026-10-05 (D30, §17.7): the seam is named symmetric to its contract (`IProbabilityDecision`) and to `makeRelevanceDecision`. Same signature, so a consumer's function moves by renaming the key (migration line, §13). With no alias there is no "both supplied" case and no check for it. The seam-missing message names `makeProbabilityDecision` | `@mcp-abap-adt/llm-agent-server-libs` (`smart-server.ts` — `BuildAgentDeps`) |
| `SmartServerDecisionConfig`: `provider` gains `'sap-aicore'`; optional `deploymentId`, `resourceGroup` | goal 10 + the goal decision 2026-10-05 (one `decision:` section; the provider decides the kind): Cohere needs a provider name and its deployment (§6.2). Kept one interface with optional fields — additive, so a consumer's own probability seam still compiles (§17.5) | `@mcp-abap-adt/llm-agent-server-libs` (`decision-config.ts`), where the section's type already lives |
| `ReservedRecordKey` gains `staleRecordIds` | approved review finding 3: a failed stale-record delete must be retried by the next `index` / `remove`, so its id is kept on the canonical; reserved so no extra can overwrite it. `ReservedRecordKey` is new in this spec | libs (record writer, tools binding) |
| `IItemCut.limit()` — doc only: never above `requestedK` | approved review finding 1: the caller's k caps every cut (§4.5, §4.9). No signature change | — |
| `fillToolsBinding(clients, binding, opts)` — new export of `llm-agent-libs` (D31, amended by D42) | the server fills a bound tools store at its creation (§6.3) and lives in another package; `vectorizeMcpTools` is internal to libs and also carries the 30.1.0 record path. A thin wrapper that requires a binding: it runs the **fill source** the store carries (§3.10) at instance creation — for `live`, the listing and `bound.index` of `vectorizeMcpTools`' profile path, reused, nothing duplicated. It refuses a binding its store does not carry (D34): such a store would carry no fill source either, and a later reconnect's `toolsChanged` would take it for unbound and write 30.1.0 records into it | `llm-agent-libs` (`src/mcp/fill-tools-binding.ts`), beside `vectorizeMcpTools`; used by server-libs and builder consumers |
| `HealthCheckerDeps.toolCatalog?: IToolCatalogReporter` (D31) | `/health` must reflect the server's own fill (§6.3); the builder's status holder is private to `build()`, so the server cannot publish into it. An optional reporter the checker reads instead of the agent's; absent → 30.1.0 | `llm-agent-libs` (`health/health-checker.ts`), where `HealthCheckerDeps` lives |
| Worker builders receive the shared clients **with** their descriptors and the server's `IToolNamespace` (D32, §6.3) — **no contract change** | a worker's store must hold the names its agent dispatches by; the existing `withMcpServers` (+ `IMcpServer.descriptor`) already carries descriptors to the pipeline, and `withToolNamespace` already exists. An optional `descriptors` parameter on `withMcpClients` was the alternative — a public builder change this does not need | `llm-agent-server-libs` (`smart-server.ts` `buildSubAgent`, `workers/worker-registry.ts`), internal |
| **`IToolsFillSource`**, **`ToolsFillContext`** (D42, §3.10) | the goal decision 2026-10-05: *where the records come from is a strategy the consumer injects*. One source per bound store answers the one moment a bound tools store is written — its creation (`fill`); a reconnect never writes a bound store (D46) — so `corpus` can promise that creation makes no embedding call. The context hands a source the binding, the raw store it was made over (a corpus is written into it with precomputed vectors through its writer) and the live path as a function (`indexLiveTools`), so a source never needs MCP clients, namespaces or record keys. The minimum: one name, one method, a four-field context. No existing contract changes | `@mcp-abap-adt/llm-agent` (`interfaces/tools-fill-source.ts`): implemented in libs (the three shipped sources) and by consumers; resolved by name in server-libs; called by libs (`vectorizeMcpTools`) |
| `bindToolsProfile(profile, target, source?)` — third parameter (libs, new in this spec) | the fill source travels with the store like its binding (D34, D42): whatever fills the store — the builder, `fillToolsBinding` — reads both from the store, never from an option; a reconnect reads the binding only to leave the store unwritten (D46). Absent → `LiveToolsFill` (30.1.0's behaviour) | `llm-agent-libs` (`collections/tools-binding.ts`) |
| `buildToolsCorpus`, `parseToolsCorpus`, `ToolsCorpus*` types (incl. `ToolsCorpusExpectation`), `ToolsCorpusLoader`, `LiveToolsFill`, `ConsumerToolsFill` (D42, D54) — new exports of `llm-agent-libs` | the two halves of the corpus flow: the consumer's build step runs the profile's indexer outside the runtime to produce the corpus (`buildToolsCorpus`); the server reads the file (`parseToolsCorpus`) and its `corpus` source loads it at start without embedding (`ToolsCorpusLoader`). Types used only where the functions are (libs, the server, the consumer's build script) — not contracts, so not in `@mcp-abap-adt/llm-agent` | `llm-agent-libs` (`collections/tools/`) |
| `ICandidatePool.items(requestedK)` / `recordsToFetch(requestedK, maxRecordsPerItem)` — the pool takes the caller's k (D56) | goal decision 2026-10-05 (no tuned numbers): the generic default pool is **k items** of the (sub-)query, which a pool can only compute when it is given k. `ICandidatePool` is new in this spec, so nothing released changes | libs (`ItemPool`, `StagedRetrieval`), consumers' own pools |
| **The RAG implementations move to `@mcp-abap-adt/llm-agent-rag`** — their files, their tests, their exports (D53, D57, §11.3); `@mcp-abap-adt/llm-agent` stops exporting them; no subpath, no alias — **breaking** | goal decisions 2026-10-05 (layers; no deprecated aliases, a major release): the contracts package holds contracts, the implementations live in `llm-agent-rag`. No cycle: nothing left in `llm-agent` imports a moved file once the three contract types below move to `interfaces/` (verified 2026-10-05 with `git grep` over `packages/llm-agent/src`: the only imports from a moved file by a file that stays were `interfaces/index.ts` and `interfaces/plugin.ts` → `rag/query-expander.ts`, plus the barrels `index.ts`, `rag/index.ts`, `rag/providers/index.ts`, `rag/corrections/index.ts`; `resilience/index.ts` exported one RAG implementation, `FallbackRag`, removed by D68). Every name a moved file needs from a file that stays is already a root export of `llm-agent` | `@mcp-abap-adt/llm-agent-rag` (`src/`), `@mcp-abap-adt/llm-agent` (exports removed) |
| The contract types defined inside implementation files move into `interfaces/` — `IQueryExpander` (`rag/query-expander.ts`), `IQueryPreprocessor`, `IDocumentEnricher` (`rag/preprocessor.ts`) — same names, same root exports, **no contract change** | the contracts must not live in files that leave the package: `interfaces/plugin.ts` and `interfaces/index.ts` import `IQueryExpander` from `rag/query-expander.ts` today, and the implementations in `llm-agent-rag` implement these contracts (D53, D57) | `@mcp-abap-adt/llm-agent` (`interfaces/query-expander.ts`, `interfaces/query-preprocessor.ts`) |
| The search-strategy types (`ISearchStrategy`, `ISearchCandidate`, `ISearchQuery`, `IScoredResult`, `ISearchContext`) move **with `VectorRag`** to `llm-agent-rag` (`src/search-strategy.ts`) — **breaking** (import path) | they are `VectorRag`'s option types (`VectorRagConfig.strategy`), used by nothing else in the repo but `VectorRag`, the five strategies and `llm-agent-rag`'s `rag-factories.ts`; `ISearchContext.index` names the `InvertedIndex` class, which moves too. Moving them to `interfaces/` would need a new interface for `InvertedIndex` — a contract nobody asked for (§17.18, **decided by the user** on 2026-10-05) | `@mcp-abap-adt/llm-agent-rag` |
| `OllamaRag` removed from `@mcp-abap-adt/ollama-embedder` — **breaking** (S11, §17.18) | it extends `VectorRag`, which now lives in `llm-agent-rag`; `llm-agent-rag` depends on `ollama-embedder` (optional peer, `tsconfig` reference, dev dependency), so `ollama-embedder` importing `llm-agent-rag` is a package and `tsc -b` reference cycle. `OllamaRag` is a 6-line convenience (`VectorRag` + `symmetricEmbedder(new OllamaEmbedder(cfg))`) with no user in the repo | `@mcp-abap-adt/ollama-embedder` |
| No re-exports across packages (D59) — `llm-agent-libs` exports no reranker and no RAG implementation; `llm-agent-rag` exports only its own files — **breaking** for libs-root imports of rerankers | goal decision 2026-10-05 and the user's: a re-export makes a second home for a name; every package imports a name from its owner, so a name has one import path. Libs keeps its own dependency on `llm-agent-reranker` for internal use (`NoopReranker` as the default reranker) | `@mcp-abap-adt/llm-agent-libs` (`src/index.ts`) |
| The pre-existing re-exports removed (S12, §11.4) — libs' root stops exporting 15 names of `@mcp-abap-adt/llm-agent`; server-libs' `./legacy/flat` subpath is removed and `./legacy/linear`, `./legacy/dag` stop exporting libs' classes; `llm-agent-server`'s unreachable `src/index.ts` is deleted — **breaking** (import path; migration lines 52–69) | the user's decision of 2026-10-05 (S12): the rule of D59 holds for every public entry point, not only for the names this PR moves. Same types and classes, imported from their owner | `@mcp-abap-adt/llm-agent-libs` (`src/index.ts`), `@mcp-abap-adt/llm-agent-server-libs` (`src/legacy/`, `package.json` `exports`), `@mcp-abap-adt/llm-agent-server` (`src/index.ts`) |
| `ITextLogger` removed from `@mcp-abap-adt/llm-agent` (§11.4) — **breaking** (name and import path; migration line 70) | the user's decision of 2026-10-05 (§17.18): it is `@mcp-abap-adt/interfaces-utils`' `ILogger` under a second name, kept until a major by its own comment; this is the major. Same type: `AnyLogger`, `isTextLogger`, `normaliseLogger` keep their names, signatures (structurally) and behaviour | `@mcp-abap-adt/llm-agent` (`src/logger/text-logger.ts` deleted, `src/index.ts`, `src/logger/normalise-logger.ts`) |
| `SmartServerConfig.toolsFillFactories?` (D42) | YAML `rag.profiles.tools.fill` names a source (§6.2); a consumer's own source is registered by name, like `toolsVariantFactories` | `llm-agent-server-libs` (`smart-server.ts` config type, `resolve-collection-profiles.ts`) |
| `ToolCatalogStatus.records?`, `.profile?` (S3) | `/health` copies `toolCatalog` from the status `IToolCatalogReporter` returns (`vectorizeMcpTools`' summary), so the two fields must be carried there first (§7.6, §9.1). Additive, optional | `interfaces/tool-catalog.ts`, where `ToolCatalogStatus` lives |
| **`FallbackRag` removed; `SimpleRagRegistry.replaceRag` and `SmartAgentBuilder.withCircuitBreakers` removed; the builder wraps no store** (D68, §10.4) — **breaking** (migration lines 5, 71, 72) | the goal's decision of 2026-10-05: a fallback to an in-memory copy hides a deeper RAG failure behind empty or partial results, which llm-agent cannot solve. `replaceRag` had one caller (the builder's wrapping loop) and `withCircuitBreakers` one purpose (putting that wrap on a shared breaker); the embedder breaker `withCircuitBreaker(config)` built guarded nothing else (the builder wraps no embedder). Nothing is added: `IRag`, `IRagDecorator`, `IRagBackendWriter` and the breaker classes are unchanged. *Replaces the row on `FallbackRag.writer()` (D52, D62), withdrawn* | `@mcp-abap-adt/llm-agent` (`resilience/fallback-rag.ts` deleted; `rag/registry/simple-rag-registry.ts`), `@mcp-abap-adt/llm-agent-libs` (`builder.ts`), `@mcp-abap-adt/llm-agent-server-libs` (`smart-server.ts`) |
| **`PIPELINE_FAILURE_CODES`** (`interfaces/pipeline-failure-codes.ts`: `RAG_STORE_MISSING`, `STATE_CORRUPT`, `TOOL_ARGUMENTS_JSON_PARSE_FAILED`) — new, additive | the goal's fail-loud decision (D69): three failures no component has a code for; a consumer matches on them. A set of their own, so no shared set (`MCP_UNAVAILABLE_CODES`, `DecisionErrorCode`) is widened; `TOOL_ARGUMENTS_JSON_PARSE_FAILED` is the string the OpenAI adapter already emits | `@mcp-abap-adt/llm-agent` — libs, server-libs and consumers read it |
| **`SkillLoadResult.carried?: { sourceId, reason }[]`** — new optional field | D74 S-9: a source whose `acquire` failed and whose prior data was carried forward (`strict: false`) is reported with its reason instead of discarded | `@mcp-abap-adt/llm-agent` (`interfaces/skills-rag.ts`, beside `SkillLoadResult`) |
| `FallbackLlmCallStrategy` constructor gains an optional second argument `{ fallbackCount?: ICounter }` — additive (U1, §10.5.12) | the user's decision of 2026-10-05: the opt-in fallback stays, and each fallback must be countable. The log event is always there; a counter needs a metrics backend the strategy cannot build itself, so the consumer injects one (`ICounter` is the existing metrics contract — no new interface). The first argument (the logger) is unchanged, so every existing call compiles | `@mcp-abap-adt/llm-agent` (`policy/fallback-llm-call-strategy.ts`, where the class lives) |
| `ToolCatalogStatus.batchFailures?: number`, `IndexReport.batchFailures?: number`, `HealthComponentStatus.toolCatalog.batchFailures?: number` — additive (U7, §10.5.12) | the user's decision of 2026-10-05: the batch → per-tool embedding retry stays, and a failed batch is counted instead of named only in a log line. `ToolCatalogStatus` carries it to the health checker, which copies it into `HealthComponentStatus.toolCatalog` beside `records` / `profile`; `IndexReport` carries it from a binding's `index` to the tools summary (the profile path writes through `storeItems`, whose `batchFailure` no caller could see). Absent = no batch failed | `@mcp-abap-adt/llm-agent` (`interfaces/tool-catalog.ts`, `interfaces/health.ts`; the collection-profile contracts beside `IndexReport`) |
| `ToolCatalogStatus.writeFailure?: string` — additive (D79, §10.5.4 R14) — **decided by the user** on 2026-10-06 (§17.28) | the user's rule of 2026-10-06 ("no fallback anywhere"): the 30.1.0 tools path no longer retries a failed bulk write tool by tool, so its catalog can now be incomplete because the store refused the batch. `failed` names the tools but not why, and a reporter's consumer (`IToolCatalogReporter`) sees only the status, not the log; the field carries the store's error (`bulk write failed: <error>`). `/health` is not widened: `complete: false` already answers 503 (D72). Absent = the bulk write did not fail (or none was made) | `@mcp-abap-adt/llm-agent` (`interfaces/tool-catalog.ts`, where `ToolCatalogStatus` lives) |
| `writeNotReady(res, message?)` — an optional second parameter on server-libs' exported helper (default: today's `MCP unavailable — server not ready`); `/health`'s body gains `configNotApplied?: { reason, source, at }` (the server's HTTP response; `HealthStatus` unchanged) — additive (D82, §10.5.10) | the user's decision of 2026-10-06: a failed config change leaves the server not ready, and the consumer must see why — the chat routes' existing 503 gate needs the reason in its message, and `/health` must name the failure | `@mcp-abap-adt/llm-agent-server-libs` (`http/response-helpers.ts`, `http/health-route-handler.ts`), where both already live |
| **`HotReloadableInput`** (new type: the keys of `HotReloadableConfig`, each value `unknown`); `ConfigWatcher`'s `reload` event carries it — the file's values as read, no longer coerced with `Number()` / `Boolean()` / `String()` (D83). `HotReloadableConfig` is unchanged; it is now the validated shape the server produces | review finding of 2026-10-06: the coercion turned an invalid value into one that applies (`agent.maxIterations: oops` → `NaN`, and `iteration >= NaN` never stops the loop; `showReasoning: "false"` → `true`), and the event's type claimed numbers the watcher could not guarantee. The watcher reads the file; the server, which owns both inputs (the file and `PUT /v1/config`), validates every value before it applies (§10.5.9 *Config field rules*) | `@mcp-abap-adt/llm-agent-libs` (`config/config-watcher.ts`), where `ConfigWatcher` and `HotReloadableConfig` live |
| **`ConfigWatcherOptions.resolveDocument?: (document: unknown) => unknown`** — a new optional option, additive (D83 (8), decided by the user on 2026-10-06, §17.34). When given, `ConfigWatcher` applies it to the whole parsed file before it reads a hot-reloadable field (a throw is emitted as `error`, like a parse failure — the server queues it as a failed reload, D82 (9)); absent, the values are the file's as written (today's behaviour). The `reload` event's values are then the resolved document's | the user's decision of 2026-10-06: a reload substitutes `${VAR}` exactly as the start does. The start substitutes in server-libs (`loadYamlConfig` → `resolveEnvVars`) over the whole document before any field is read, and `ConfigWatcher` decides on that document which fields exist (`rag.store.type === 'in-memory'` gates the weights) — so substituting after the watcher (over the event's values) would read `type: ${STORE}` unsubstituted and drop the weights a start from the same file applies. The substitution is the consumer's policy, not the watcher's (libs knows no `${VAR}` syntax and must not import server-libs, which depends on it), so it is injected: one implementation, no cycle | `@mcp-abap-adt/llm-agent-libs` (`config/config-watcher.ts`), beside `ConfigWatcherOptions.debounceMs` |
| **`IToolAvailabilityPolicy`** + **`HeuristicToolAvailabilityPolicy`**, `SmartAgentDeps.toolAvailabilityPolicy?`, `SmartAgentBuilder.withToolAvailabilityPolicy(policy)`, `PipelineContext.toolAvailabilityPolicy?` — new; **`SmartAgentConfig.toolUnavailableTtlMs` removed** — **breaking** (U8, migration line 74) | the user's decision of 2026-10-05: blocking a tool on a text heuristic silently shrinks the tool set, so it is a strategy the consumer injects, and with none injected nothing is blocked. One method (`onToolError(toolName, errorText)` → a TTL or nothing) is the minimum: the per-session block state stays in the existing internal `ToolAvailabilityRegistry`. The 30.1.0 heuristic ships as `HeuristicToolAvailabilityPolicy({ ttlMs })` (ttl required — no tuned number, D55). The TTL lived in `SmartAgentConfig` only for this; config is the builder's, the TTL is the policy's | `@mcp-abap-adt/llm-agent-libs` — the only package that calls it (contract placement: where used); the server injects it from YAML |
| `LazyOptions.fallback` removed — **breaking** (U6, migration line 73) | the user's decision of 2026-10-05: an init failure answered by a substitute instance is the pattern the goal removes; unused in the repo | `@mcp-abap-adt/llm-agent-libs` (`utils/lazy.ts`) |

### 3.9 Decision contracts — probability and relevance

File `packages/llm-agent/src/interfaces/decision-model.ts` (the existing file, its style and its
`Result` / `DecisionError` conventions).

```ts
/**
 * A model that answers typed questions about a state with probabilities, not text
 * (30.1.0's `IDecisionModel`, renamed — same members, same rules; the old name is removed).
 */
export interface IProbabilityDecision {
  readonly model?: string;
  decide(request: DecisionRequest, options?: CallOptions)
    : Promise<Result<DecisionResult, DecisionError>>;
}

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

### 3.10 Where a tools store's records come from — `IToolsFillSource` (D41, D42, D54)

**TL;DR.** A tools store is filled **once, when its instance is created**, and never refilled while
it runs (goal decision 2026-10-05). *Where the records come from* is a strategy the consumer
injects. The source travels with the store, attached with its binding. It has one method, `fill`:
a reconnect's `toolsChanged` writes nothing into a bound store, whatever its source (D46).

```ts
/** Where a bound tools store's records come from. Attached with the binding
 *  (`bindToolsProfile(profile, target, source)`); read from the store by whatever fills it. */
export interface IToolsFillSource {
  /** 'live' | 'corpus' | 'consumer' | a consumer's own — named in the fill's log line. */
  readonly name: string;
  /** Once, when the store's instance is created. `undefined` = nothing attempted (status unknown).
   *  Throws on an incompatible corpus or store — never a silent empty store. */
  fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
}

export interface ToolsFillContext {
  readonly binding: IBoundCollection<ToolItem>;
  /** The raw store the binding was made over. A corpus is written into `target.rag`. */
  readonly target: CollectionStore;
  /** The live path: list the MCP clients' tools (namespaced and keyed exactly as tool selection reads
   *  them), index them through `binding.index`, return the catalog status (§7.6). */
  indexLiveTools(options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
  readonly logger?: ILogger;
}
```

**The three shipped sources** (`llm-agent-libs`):

| Source | `fill` — at instance creation | Embedding calls in the process | Writes by the process |
|---|---|---|---|
| **`LiveToolsFill`** (`live`, the default) | `ctx.indexLiveTools()` — 30.1.0's listing, indexed through the profile | yes | at creation only |
| **`ToolsCorpusLoader({ corpus, expect })`** (`corpus`, any store — in-memory or persistent) | checks the corpus against `expect` and the binding (below) and the store's capabilities (a precomputed write **and** `clearAll` on the writer of `ctx.target.rag`, the store it writes), then **clears the store**, writes every record with its precomputed vector into `ctx.target.rag` in batches, logs one summary line (source, identity, items, records, `corpusHash`) and reports the status. Every check runs **before** the clear: an incompatible corpus or store throws with the store untouched. Nothing else: no record of the load in the store, no diff, no refill, no memo, no retry, no watching | **none** | at creation only |
| **`ConsumerToolsFill`** (`consumer`) | nothing (`undefined`): the consumer fills through `bound.index` or `fillToolsBinding` | — | **never** (the consumer writes) |

A reconnect that reports `toolsChanged` calls no source: a bound store is not written after its
creation (D46, below).

- **Compatibility is checked at instance creation, against what the server is configured with, and
  fails loudly** (`corpus`): a throw names what differs, before the store is cleared. Checked:
  - `identity.profile` and `identity.embedder` in the corpus file against `expect`
    (`ToolsCorpusExpectation`, §6.5) — the consumer's own names for the profile composition and
    the document embedder, the same strings in its build step and in the server's configuration;
  - the binding's `profileName` against the manifest's;
  - the vector dimension against `expect.dimensions` when the server declares one (a store config's
    `dimension`, §6.2); otherwise a backend that fixes its vector length refuses a mismatching write,
    and the load throws (the store is then empty or partial until the next start — loud, D54).
    **Every store the source is bound to is checked** (D65): the server binds one `corpus` source to
    the main store and to each worker store it builds, each from its own store config, so it checks
    the corpus against **each** declared `dimension` — the main one and every worker's — when it
    resolves `fill`, before any store is created (§6.2). The other checks are the same for every
    store (one `fill`, one profile) and run at each store's creation, before its clear;
  - the corpus format, and one vector dimension for every record (`parseToolsCorpus`).
- **Why clear, and why a store without `clearAll` is refused.** The corpus is the store's whole
  content, so the load replaces it: clearing first means no record of an earlier corpus, an earlier
  profile or an earlier embedder survives, and a write never merges into an old slot (`InMemoryRag`
  and `VectorRag` merge metadata on an in-place upsert, §6.5). Deleting only the corpus's own ids
  instead is not an option: the store may hold records the corpus does not list (an earlier
  corpus's, a removed tool's), and the library cannot know them without a record of its own in the
  store, which D54 removes. So `IRagBackendWriter.clearAll` is required; a store whose writer lacks
  it is refused at creation, naming the store. Every shipped store has it (`InMemoryRag`,
  `VectorRag`, qdrant, pg-vector, HANA).
- **An interrupted load repeats at the next start** (D54): there is no state to resume; the next
  instance clears and writes again. A process that fails its load does not start (main store) or
  fails that worker's construction (§6.3).
- **An empty corpus is valid** (D49, its build half): the load clears the store and writes nothing;
  the status is a complete catalog of 0 tools.
- **Why the fingerprint is the consumer's string.** No contract carries a fingerprint of an injected
  strategy (a consumer's own indexer or facet) or of an embedder (`IEmbedder` has no
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
- **A persistent store loaded by every instance** (D54, the goal's decision — a consequence stated
  for the operator, not a protocol): each server instance that starts clears the shared collection
  and writes the corpus again. While one instance loads, the others read an empty or partial
  store. Concurrent loads from several instances are the backend's concern (§3.3, D13); the library
  coordinates nothing across processes. **Accepted by the user (D60, 2026-10-05)** as the price of
  the simple corpus flow: no marker, no coordination is added. A consumer who runs replicas over
  one persistent store starts them so that this window is acceptable to it, or uses one collection
  per instance.

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
  pool?: ICandidatePool;        // candidate strategy, counted in ITEMS; absent → ItemPool() = the caller's k (D56)
  maxRecordsPerItem: number;    // from the indexing strategy (§4.4), not set by the consumer
  canonicalKind: string;        // from the indexing strategy; locates the canonical record (§4.6)
  sources: ISourceSelector;     // from the profile's bind()
  collapse: ICollapseRule;
  rerank?: {
    reranker: IReranker;
    keepStage1Top?: number;             // §4.7, default 0; counted inside k; never with ScoreFloorCut
    // no onFailure: a failed rerank returns RERANK_ERROR (D71, §9.3)
  };
  decompose?: {                 // §4.5; absent → the query runs as is (one run); never with ScoreFloorCut (D63)
    decomposer: IQueryDecomposer;
    queryEmbedder: IQueryEmbedder;      // embeds each sub-query
  };
  cut?: IItemCut;               // absent → TopItemsCut (caller's k)
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics };
}
```

- `pool` absent → **`ItemPool()`: k items of the (sub-)query** (D56). That is the generic default
  the goal names: it guesses no catalog size and no depth, and without a reranker it returns what
  30.1.0 returns for k (k items instead of k records). A deeper pool is the consumer's number — it
  matters only under a reranker, which can then bring in items stage 1 ranked below k (§7.4).
- **Scoring inside the store** (hybrid vs cosine) is the store's existing `ISearchStrategy`, set on
  the store, not here. The measurements used hybrid (0.7·cos + 0.3·BM25).

### 4.3 One query, step by step

```
sources = selector.sources(options)            ← identity filters chosen per source
for each source, in parallel:
  source.rag.query(query, pool.recordsToFetch(k, maxRecordsPerItem), source.options)
                                               ← identity filter applied IN the store, before top-N
merge hits
  → collapse (ICollapseRule)                   ← records → owner-qualified items; filtered hits only
  → the first pool.items(k) items per source are the pool; the rest of what was
    fetched is kept, in stage-1 order (the overflow)
  → rerank items on their item text (optional, §4.6); check the result (§4.8)
  → hydrate in rank order from the CANONICAL record (§4.6); drop + count orphans;
    each orphan is replaced by the next overflow item (ranked like the pool, then
    hydrated) until k items or the overflow is spent — orphans never use up the pool (D67);
    the replacements merge with the pool's items by DESCENDING score (same query → one
    scale; `keepStage1Top` pins keep their head places)
  → cut (IItemCut) over hydrated items, once: at most min(k, cut.limit(k)) items
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

- **Why items, not records** (evidence, §2.2): with several records per tool, a pool of 30 records
  showed only ~26–34 tools in the consumer's measurement, and non-English recall dropped; a pool of
  30 items did not. The number is the consumer's; the unit is the design.
- **Built-in candidate strategy `ItemPool(n?)`:** with `n`, `items(k) = n`; without, `items(k) = k`
  (the generic default, D56). `recordsToFetch(k, m) = items(k) × m`.
  - Every item has at most `m` records, so `items × m` records always hold at least `items`
    distinct items (when the store has that many). One query, no loop.
  - After collapse, the pool is cut to `items(k)` items per source. What was fetched beyond it is
    kept, in stage-1 order: it replaces the pool's orphans (§4.6, D67), so with the default
    `ItemPool()` (pool = k) an orphan does not shrink the result.
  - A consumer may inject another `ICandidatePool` (e.g. one that queries deeper).
- **`maxRecordsPerItem` comes from the indexing strategy** (`IItemIndexer.maxRecordsPerItem`),
  never the consumer's guess:
  - the 30.1.0 single record → 1; `FacetedToolIndexer` → 1 + its facets; `EnumValueToolIndexer`
    adds its required `maxValues` (§7.3.2);
  - shared items: a required constructor option of the profile; `index()` refuses an item with
    more records (`failedItems`, reason `too-many-records`).

### 4.5 Query decomposition — an injected strategy

**The slot.** The framework provides the component; the consumer provides the strategy.

- `StagedRetrieval` calls the injected `IQueryDecomposer` (§3.4) when `decompose` is set.
- **None injected → the query runs as is** (one run, today's behaviour). There is no shipped
  implementation and no named composition uses one (§2.4).

**The k contract.** `k` stays the overall limit of a retrieval, as in 30.1.0 — with or without a
decomposer.

| Step | What |
|---|---|
| budget | `budget = min(requestedK, cut.limit(requestedK))` — the caller's k caps every cut (`TopItemsCut` → k; `FixedItemsCut(n)` → min(k, n); `ScoreFloorCut` → min(k, `maxItems`); `TokenBudgetCut` → min(k, `maxItems ?? k`), §4.10). `StagedRetrieval` applies the `min` itself, so a consumer's cut whose `limit` exceeds k is still capped |
| decompose | `decomposer.decompose(text, budget)` → sub-queries; the strategy owns how the budget is shared |
| check | each `k` an integer ≥ 1, each `text` non-empty, `Σ k ≤ budget`; else a `RagError('…', 'DECOMPOSE_ERROR')` |
| `[]` | the query runs as is with the whole budget (same as no decomposer) |
| run | each sub-query through §4.3 up to hydration, in parallel: embedded with `queryEmbedder`, reranked against its **own** text, its first `k` items kept |
| merge | **union in sub-query order**: each sub-query's own ranked list (its own `k` items), one after the other; an item already in the union (same owner-qualified item) **stays at its first occurrence, with that occurrence's score** — a later occurrence is dropped, whatever its score (D63) |
| cut | the `IItemCut`, **once**, over the union by **position**, then the result is truncated to `budget` → **at most `budget` ≤ k items** |

**No score is compared across sub-queries** (D63). A score is comparable only for the same query
(and model) — the relevance contract says so (§3.9, D28), and a stage-1 search score is no more
comparable between two query texts. Each sub-query is reranked against its own text, so two
sub-queries' scores are on unrelated scales. Hence:

- the merge never picks the best score of a duplicate and never re-sorts the union by score — the
  order is sub-query order, then each sub-query's own rank;
- **a decomposer with `ScoreFloorCut` is rejected** when `StagedRetrieval` is constructed:
  `StagedRetrieval: a decomposer cannot be combined with ScoreFloorCut — scores of different
  sub-queries are not comparable (§4.5, D63); a threshold over the merged union would compare
  them`. The YAML validator refuses the same combination first (§6.2). The cuts allowed with a
  decomposer read only position (`TopItemsCut`, `FixedItemsCut`) or position and size
  (`TokenBudgetCut`). A consumer's own `IItemCut` behind a decomposer receives the union in this
  order; the scores it sees are not comparable across sub-queries, and nothing here re-sorts them.

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
names) — measured equal or better than text with generated intents, for Cohere and Jev (§2.2), and
no record carries generated text any more (D50). For each collapsed item:

1. a canonical hit of the item → its `text`;
2. a non-canonical hit → its `metadata.itemText` (a **reranking shortcut only**: zero round trips;
   never returned);
3. neither (a consumer's indexer that wrote no `itemText`) → the canonical record is fetched now
   (step *Hydration*), and its text is used.

**Hydration (every returned item).**

- The canonical record is located by id: `recordId(owner, itemId, canonicalKind, 0)` on the item's
  source, where `owner` is read back from the hit's metadata (§3.1). A canonical hit among
  the candidates **is** that record; otherwise `getById` reads it.
- Every hydrated record is checked with `matchesRagIdentity` against the source's filter (the
  owner check).
- **Missing canonical record** (deleted item, interrupted replacement, a record outside the filter)
  → the hit is an **orphan**: dropped, never returned, and **reported** — `outcome=orphan` on the
  counter and the `orphans` span attribute (§9). A stale secondary record can therefore never
  surface its own text or data.
- Hydration runs in rank order and the cut sees only hydrated items, so orphans never use up k.
- **Orphans never use up the pool either (D67).** The pool is cut to `items(k)` per source before
  any canonical record is read, so an orphan can sit in it — with the default `ItemPool()` (pool =
  k), a top orphan at k=1 would leave an empty result although a valid item was fetched below it.
  So `StagedRetrieval` keeps what it fetched beyond the pool (the overflow, stage-1 order). When the
  ranked pool hydrates to fewer than k items, the next overflow items — as many as are missing —
  are ranked like the pool (the reranker scores them against the **same** query, so one scale
  holds, D28; no `keepStage1Top` pins, which are the pool's stage-1 places) and hydrated; this
  repeats until k items or the overflow is spent. No new query; the run's rerank outcome is the
  most severe of its reranker calls.
- **Replacements merge by score, never appended (D67).** A replacement can outscore a surviving
  pool item (the reranker scores it higher, or, without a reranker, a per-source pool left a
  higher stage-1 item of one source in the overflow). Appended after the pool's items, the list
  would not be descending, and `ScoreFloorCut` — which stops at the first score below its floor —
  would drop the higher-scored replacement. So, before the one cut, the surviving pool items and
  the replacements are merged into one list by **descending score**:
  - with a reranker: the reranked scores — every call scored against the **same** query, so they
    are comparable (§3.9, D28); without one: the stage-1 scores — the same query, comparable too;
  - `keepStage1Top` pins (when configured) keep their pinned head places, in stage-1 order; the
    merge orders only the rest (pins + `ScoreFloorCut` is rejected anyway, §4.7);
  - the merged scores are always one scale: a reranker call either succeeds or fails the whole
    retrieval with `RERANK_ERROR` (D71) — there is no stage-1 fallback that could mix scales;
  - ties keep their order (a stable sort: the pool's item first). Then the one cut.
  - Why not validate the pool before reranking: that reads the canonical record of every pooled
    item whose canonical was not among the candidates — the reads the `itemText` shortcut exists
    to avoid (below). The replacement reads and reranks only when orphans leave the result short.
- **Cost:** at most one `getById` per hydrated item whose canonical record was not among the
  candidates (≤ k + the orphans met, per sub-query; zero when the canonical record matched), and
  one more reranker call per replacement round (only when orphans left the result short). `IRag`
  has no batch get; the reads run in parallel.

**Why `itemText` stays, but only for ranking.** It lets the reranker score items whose canonical
record was not among the candidates without a read per candidate (the pool is 30 items; the
returned set is k). It can be stale after an interrupted replacement (§3.3) — harmless, because it
only orders; the payload always comes from the canonical record.

- Index-size cost of `itemText` is small (measured: 711 records, 4.4 MB vectors for 237 tools).

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

**When the reranker fails** (§9.3): the retrieval returns `RagError('…', 'RERANK_ERROR')` (D71).
No stage-1 result is returned, so a threshold calibrated on reranked scores never sees stage-1
scores, and `ScoreFloorCut` under a reranker needs no extra condition. *(Until D71 a `'stage1'`
fallback existed, and `ScoreFloorCut` with a reranker was refused unless `onFailure: 'error'`; both
are gone.)* Without a reranker, `ScoreFloorCut` cuts stage-1 scores, calibrated on them — allowed.

### 4.8 Reranker output check

`StagedRetrieval` checks every reranker result, whichever reranker it is:

- the result must hold **exactly** the candidates it was given — same count, each once;
- every `score` must be a finite number.

Anything else is a `RagError('…', 'RERANK_ERROR')`, **returned** (D71) and **counted** (§9).
This closes the evidence item "a wrong score count falls back silently" for every reranker,
including a consumer's own.

### 4.9 Built-in retrieval strategies

| Strategy | Class | Behaviour |
|---|---|---|
| candidate pool | `ItemPool(n?)` | `n` items per source; no `n` → the caller's k (§4.4, D56) |
| collapse | `MaxScoreCollapse` | item score = best record score (measured winner). Count / RRF are **not** shipped. |
| cut | `TopItemsCut` | first `requestedK` items (default); `limit` = `requestedK` |
| cut | `ScoreFloorCut({ minItems, maxItems, minScore })` | first `min(minItems, limit)`, then more up to `limit` while `score ≥ minScore`; `limit` = `min(requestedK, maxItems)`. Never with `keepStage1Top` > 0 (§4.7); never with a decomposer (§4.5, D63) — both rejected at construction |
| cut | `FixedItemsCut(n)` | a **ceiling**: first `min(requestedK, n)` items — for a consumer that wants fewer than the caller's k (its own calibration); it never raises the caller's k; `limit` = `min(requestedK, n)` |
| cut | `TokenBudgetCut({ budgetTokens, maxItems?, estimator? })` | rank-order prefix of whole items while their summed size ≤ `budgetTokens`, at most `limit` items; `limit` = `min(requestedK, maxItems ?? requestedK)`; implements `ISizeBoundedCut` (§4.10) |
| query decomposition | — | **none shipped**; the consumer injects its own `IQueryDecomposer` (§4.5) |

- **k in items.** The caller's k (`ragQueryK ?? 10` in `rag-query`, 20 in `IToolsRagHandle` and the
  controller's `selectTools`) arrives unchanged; under a profile it counts items and is the
  overall limit of the retrieval, with or without a decomposer. **Every cut is capped by it**
  (approved review finding 1): the effective limit is `min(requestedK, the cut's own limit)`. A
  consumer that wants fewer than the caller's k uses `FixedItemsCut(n)`; nothing returns more than
  the caller asked for. The cut classes carry no number of their own, and neither does a named
  composition (§7.1, D55): its default cut is the caller's k, and a lower one (`maxItems` →
  `FixedItemsCut`) is the consumer's argument.
- **Score scales.** After a reranker, scores are the reranker's; the global
  `IToolSelectionStrategy` still runs on the flattened results of all stores, as in 30.1.0. A
  per-store threshold therefore belongs in the profile's cut.

### 4.10 Token-budget cut — `TokenBudgetCut`

**What it is:** a generic **prompt-size guard** the consumer may inject. It is in **no** default
composition.

**Why it exists:** tools differ in size by an order of magnitude (§2.5). A count bounds the prompt
only when tools are alike; a budget bounds it always (goal 9).

**Measured as the main cut — worse than a count** (evidence from the consumer, mcp-abap-adt `compact`, §2.5.1):

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
  them, is the **consumer's calibration** for its provider; **no named composition uses one**.
- `StagedRetrieval` checks the result again (§4.8), whichever reranker it is.

**Batches — by default, as the probability reranker** (decided by the user, D28, §17.7).

- Same defaults and validation as `ProbabilityReranker`: `maxBatchTokens` 48000, `concurrency` 4,
  each a positive integer (a non-positive or non-integer value throws in the constructor). These
  are 30.1.0's `DecisionReranker` defaults — request-size and fan-out limits, not tuned to a
  catalog or measured in a consumer (D55 concerns retrieval numbers).
- A batch closes when the next passage's estimate (`ceil(text.length / 4)`) would take it past
  the budget; the query's estimate counts once per batch; a single passage larger than the budget
  is a batch of its own (never dropped).
- **Merging is sound by contract:** relevance scores are comparable for the same query and model,
  also across calls (§3.9), and every batch of one `rerank` has the same query and decision.
- There is no single-call mode: a consumer that wants one call per rerank sets a budget large
  enough for its candidates.
- How many candidates one rerank reads is the consumer's `poolItems` (§7.4); a pool that fits the
  default budget is one call.

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
  exception) for its own use only: `NoopReranker` is the default reranker of `SmartAgent`,
  `DefaultPipeline` and libs' `testing` helpers. It **re-exports nothing** from it (D59): a
  consumer imports every reranker from `@mcp-abap-adt/llm-agent-reranker`. The 30.1.0 libs-root
  names are gone (§13).
- Server-libs imports the rerankers from `llm-agent-reranker` (new peer); the app adds it as a
  dependency.
- Rejected placements for `SapAiCoreRelevanceDecision`: inside `llm-agent-reranker` (a vendor HTTP
  client in a vendor-neutral package); inside `sap-aicore-embedder` / `sap-aicore-llm` (one package
  would carry a second role and its `@sap-ai-sdk/*` dependencies); inside `typesafe-decision`
  (another vendor).
- **Deployment id vs model name:** this PR takes `deploymentId`. Resolving a deployment by model
  name needs the deployment listing that lives privately in `sap-aicore-embedder`
  (`resolveDeploymentId`). Decided — D10 (§17).

### 5.5 Rerankers in the named tools compositions

- `faceted-rerank` takes **an `IReranker`** (D55): the consumer builds the one it chose —
  `RelevanceReranker(IRelevanceDecision)` over Cohere, or `ProbabilityReranker(IProbabilityDecision)`
  with the `TOOL_QUESTION` wording over Jev, or its own. The composition names no vendor.
- In YAML, `variant: faceted-rerank` takes the reranker of the one `decision:` section, by its kind
  (§6.2): `typesafe` → `ProbabilityReranker` with `TOOL_QUESTION`, `sap-aicore` →
  `RelevanceReranker`. There is no variant-to-kind check any more: the variant accepts either.
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
- With a `corpus` source the snippet's listing is not needed: `await fillToolsBinding([], bound)`
  runs the store's source at creation (it clears the store and loads the corpus; no client is
  read). For a builder consumer, its composition root's start is that moment (§11.2 item 4).
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
      variant: faceted-rerank                    # baseline | faceted | faceted-rerank | a registered name
      poolItems: <n>                             # faceted-rerank: required — items the reranker reads per query (the consumer's number); faceted: optional (absent → the caller's k)
      # maxItems: <n>                            # optional, faceted / faceted-rerank: a ceiling below the caller's k (→ FixedItemsCut)
      decomposer: my-splitter                    # optional; a NAME the consumer registered (§4.5); not with baseline
      fill: live                                 # optional (§3.10): live (default) | consumer | a registered name | { corpus: … }
```

No number in this section has a default the library chose: `poolItems` and `maxItems` are the
consumer's (D55); absent where optional → the caller's k (D56).

Where the tools store's records come from (§3.10, D42):

```yaml
rag:
  profiles:
    tools:
      variant: faceted
      # any store (in-memory or persistent): at start, clear it and load the corpus the build step made
      # (no embedding call at start)
      fill: { corpus: { file: ./tools-corpus.json, profile: faceted@1, embedder: aicore-te3-small } }
```

`profile` and `embedder` are the consumer's names for the composition and the document embedder,
the same strings its build step passed to `buildToolsCorpus` (§6.5). The expected vector dimension
is the tools store's own `dimension` when its config declares one (pg-vector, HANA); there is no
separate key.

A small tool set reranked as a whole (the consumer's choice; `poolItems` ≥ its tool count):

```yaml
decision: { provider: typesafe }
rag:
  profiles:
    tools:
      compose:
        indexer: { faceted: [] }                 # one `full` record per tool
        pool: { items: <tool count> }
        collapse: max
        reranker: decision
```

(30.1.0's `rag.retrieval.tools: { strategy: rerank-all, reranker: decision, maxCandidates: <tool
count> }` reranks the whole set too, without a profile.)

The consumer's own composition, every value a NAME of a strategy:

```yaml
rag:
  profiles:
    tools:
      compose:
        indexer: { faceted: [summary, parameters] }  # facet names → IToolFacet instances; name-tail is opt-in
        # text: parameter-names                    # provider text composer (§7.3.1): parameter-names (default, C0) | enum-values | schema | a registered name
        # or (generic, in no named composition; measured worse on `compact` in the consumer, §7.3.2):
        #   indexer: { enum-values: { inner: { faceted: [] }, discriminator: required-enum, maxValues: <n> } }
        # discriminator: required-enum | { named: <parameter> } | a registered name
        pool: { items: <n> }                       # → ItemPool(n); absent → ItemPool() = the caller's k (D56)
        collapse: max                              # → MaxScoreCollapse
        reranker: decision                         # none | decision | llm — decision = ProbabilityReranker (typesafe) or RelevanceReranker (sap-aicore)
        question: tool                             # probability decision (typesafe) / llm only — refused for a relevance decision
        decomposer: none                           # none | a registered name (no built-in)
        cut: { fixed-items: <n> }                  # top-items (default: the caller's k) | fixed-items | score-floor {minItems,maxItems,minScore} | token-budget {budgetTokens,maxItems?}
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
| built by | the app's `createMakeProbabilityDecision` (seam `BuildAgentDeps.makeProbabilityDecision`, renamed from `makeDecisionModel`, which is removed; returns `IProbabilityDecision`) | the app's new `createMakeRelevanceDecision` (new optional seam `BuildAgentDeps.makeRelevanceDecision`, returns `IRelevanceDecision`, §3.8) |

- **The kind table is server-libs' one place** that maps a provider name to a kind
  (`typesafe` → probability, `sap-aicore` → relevance); the resolver calls the seam of that kind.
  A kind's seam missing while the config asks for it → startup error naming the seam
  (`BuildAgentDeps.makeProbabilityDecision is required: …` / `BuildAgentDeps.makeRelevanceDecision
  is required: …`).
- **No alias for the probability seam** (D58): SmartServer reads `makeProbabilityDecision` only.
  `makeDecisionModel` is not a member of `BuildAgentDeps` any more, so a consumer that still passes
  it fails to compile (TypeScript's excess-property check on an object literal) — the migration
  line of §13 says to rename the key. The "both supplied" error of D30 is withdrawn with the alias.

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
  named composition uses it. A failed rerank is an error (D71), so the threshold only ever cuts
  reranked scores.

**Resolution.**

- Parsed **only** by the server (`resolve-collection-profiles.ts` in server-libs, beside
  `resolve-retrieval.ts`).
- Names resolve through registries in the composition deps (like `embedderFactories`):
  `toolsVariantFactories` (built-ins: the three named compositions of §7.4) and
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
- Stores are built through the existing `makeRag` seam; a profile adds no store of its own (D50).
- `variant: faceted-rerank`: the reranker is the `decision` reranker above, by the provider's kind
  (`ProbabilityReranker` with `TOOL_QUESTION`, or `RelevanceReranker`); `poolItems` → `ItemPool(n)`;
  `maxItems` → `FixedItemsCut(n)` (absent → `TopItemsCut`, the caller's k).
- `fill` resolves to ONE `IToolsFillSource` instance, server-wide (§3.10): `live` →
  `LiveToolsFill`, `consumer` → `ConsumerToolsFill`, `{ corpus: { file, profile, embedder } }` →
  the file read once at startup, `parseToolsCorpus`, `ToolsCorpusLoader` with `expect = { profile,
  embedder, dimensions: <the tools store config's dimension, when declared> }`; any other name →
  `SmartServerConfig.toolsFillFactories`. Absent → `live`. The server binds the main store and
  every worker store it builds with it. **So a corpus is checked against every one of those stores
  at resolution** (D65): the main tools store config's declared `dimension` and each worker's own
  (`subagents` with a `rag` whose store declares one) must equal the corpus's vector dimension, or
  startup fails naming each differing store and both dimensions — before any store is created,
  so no store is cleared or written. (An empty corpus has no dimension: nothing to compare.)

**Validation** (raw YAML, as in #321 §13.4) → startup error, never a silent drop:

- a `rag.profiles` key other than `tools` (S8);
- unknown variant or strategy name; `variant` and `compose` together; a key under both
  `retrieval` and `profiles`;
- `decomposer` with `baseline`;
- an `llm` key not in `llm:`; non-positive `pool.items`; `minItems > maxItems`;
- an `onFailure` key under `compose` (D71 — there is no stage-1 fallback; refused with a message
  naming D71, never silently ignored);
- `compose.cut: { score-floor: … }` with a decomposer — `rag.profiles.tools.decomposer`, or
  `compose.decomposer` other than `none` (§4.5, D63);
- `faceted-rerank` without `poolItems`; a non-positive `poolItems` or `maxItems`; `poolItems` or
  `maxItems` with `baseline` or with `compose` (there they are `compose.pool` / `compose.cut`); an
  `enum-values` indexer without `maxValues`; non-positive `budgetTokens`;
- a decision reranker without a `decision:` section: `faceted-rerank`, or
  `compose.reranker: decision`;
- a leftover key of a withdrawn composition (D55): `variant: faceted-cohere | faceted-jev |
  small-set-jev`, or `smallSet` — refused with a message naming `faceted-rerank` / `compose`, never
  silently mapped;
- `decision:`: `provider` not `typesafe` | `sap-aicore`; with `sap-aicore`, a missing `deploymentId`
  or `model`, or a typesafe-only field (`baseUrl`, `timeoutMs`, `maxRetries`); with `typesafe`, a
  sap-aicore-only field (`deploymentId`, `resourceGroup`); a secret (`apiKey`) as today;
- an explicit `question` (`rag.profiles` `compose`, `rag.retrieval`) or `task` (`rag.retrieval`)
  for a decision reranker when the provider's kind is relevance — a relevance decision reads no wording (§3.9);
- an unknown `text` composer name;
- a tools key whose variant is not a tools profile;
- `fill`: an unknown name; `corpus` without `file`, `profile` or `embedder`; a leftover
  `prebuilt` (removed, D54 — refused with a message naming `corpus`); `corpus` while a worker
  declares its own `rag` **and** its own `mcpClients` or `mcp:` (the corpus describes the shared
  catalog; bind that worker's store in the composition root). Checked by the server at start too,
  for a config built in code. `corpus` whose vector dimension differs from a declared `dimension`
  of the main tools store or of any worker's own tools store — refused when `fill` is resolved,
  naming the store (D65). A store whose writer has no `clearAll` or no precomputed write is
  refused by `ToolsCorpusLoader` at the store's creation (§3.10), naming the store.
- a leftover `intents` key under `rag.profiles.tools`: refused with a message that intents were
  removed (D50) — never silently ignored.

- Server-wide like `rag.retrieval`: worker configs that declare `rag.profiles` are rejected;
  workers' tools stores get the main config's profile (each its own binding).
- Shared items have **no YAML** in this PR (library API only). Decided — D6 (§17).

### 6.3 The server fills a bound tools store once, when the store is created (D31, D34, D35, D41)

**TL;DR.** Three rules, on every path that creates or refreshes a tools store (all listed in §6.4):

1. **The binding and its fill source travel with the store (D34, D42).** Every tools write reads
   them from the store it writes — never from an option: the builder's fill at `build()` and
   `fillToolsBinding`. A bound store → its fill source (§3.10); an unbound store → exactly 30.1.0.
   A reconnect that reports `toolsChanged` (`McpToolRegistry.revectorizeTools`) reads the binding
   too: a bound store → **no write** (D46); an unbound store → 30.1.0's re-vectorize.
2. **Whoever creates a bound store fills it, once (D35, D41).** The server creates the main store in
   `_buildInfra` and fills it there, before it reports ready — and before the startup build
   vectorizes the skills into it (D66, below). It creates a worker's own store in
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
| no MCP | none of the above | — | **the server**: zero clients → `live` gives an empty, complete catalog (`total: 0`); `corpus` needs no client |

On the first two paths the server hands the clients to the builder through `withMcpClients`
(main and workers), which skips vectorization (§6.1), so in 30.1.0 the tools store stays empty
there. Under a profile that would leave a bound store empty: the server fills it instead.

**How it fills — the shipped path, not a second one.**

- `fillToolsBinding(clients, binding, opts)` (new export of `llm-agent-libs`) is a thin call of
  `vectorizeMcpTools(clients, binding.rag, …)`, which reads the binding **and its fill source** from
  `binding.rag` (rule 1) and runs the source's `fill`. For `live` that is exactly the profile path
  of §7.6 (listing, namespacing, `IToolRecordKey` ids, `toolItemFromTool`, `bound.index`); for
  `corpus` no client is read. Nothing is duplicated. Its type requires a binding, so it
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
- **When (main store).** In `_buildInfra`, right after the shared clients are resolved
  (`buildSharedPipelineInfra`) and **before** the workers' startup builds and the startup
  `builder.build()` — so before that build vectorizes the server's skills into the store (D66),
  before `HealthChecker` is created, before `start()` listens and before the embeddable
  `buildAgent(cfg)` returns. Once.

**A store is filled before skills are vectorized into it — on every path (D66).** Skills coexist
in the tools store as pass-through records (D4, goal 8, §7.7), and the builder writes them during
`build()` (`vectorizeSkills`, `builder.ts` ~L1356). The `corpus` source clears the store (§3.10),
so a fill that ran after them would erase them. The order is fixed where each store is created —
the least invasive place, with no new builder behaviour:

| Path | The fill | The skills |
|---|---|---|
| main store, ready clients / plugin clients / injected seam / no MCP | the server, right after the clients are resolved, **before** the startup `build()` | that `build()` (`withSkillManager(…, { vectorize: true })` on the startup builder) |
| main store, `yamlBuilderConnect` | the startup builder's own `build()` — `vectorizeMcpTools` runs the store's source first | the same `build()`, after it (`builder.ts` order: tools ~L1220, skills ~L1356) |
| a worker's own store, its construction | `buildSubAgent`, **before** `subBuilder.build()` (rule 2); a worker on its own `mcp:`: its builder's auto-connect, as the row above | `subBuilder.build()`, after it |
| a worker on the shared clients, `yamlBuilderConnect`, at startup — the one store filled **after** its build (the shared clients exist only after the harvest, D38) | the pass right after the harvest | **deferred:** that construction's builder gets `withSkillManager(m, { vectorize: false })`, and the pass vectorizes the worker's skills right after the fill (`fillToolsBinding(…, { skills })`) |

A `live` fill never clears, so for it the order changes nothing; it is one rule for every source
because a consumer's own source may clear too. An unbound store is untouched by this (30.1.0: no
server fill, the build vectorizes the skills as before).

**Rule 1 in detail — the binding and its fill source are read from the store (D34, D42).**

- `vectorizeMcpTools` takes **no `binding` option**. It reads the store's binding and fill source
  (walking `IRagDecorator.inner`: a `StrategyRag`, or a consumer's own decorator) and
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
  write (`toolsBindingOf`, through decorators, so a consumer's decorator over the bound store counts). A
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
| own `rag`, own `mcpClients` | its own, bound at creation (`withToolsStore`) | its construction (`buildSubAgent`, no `injected`) | its own clients, array order (plain `IMcpClient[]`: no descriptors exist) | the startup primary build, or the lazy rebuild after a drain |
| own `rag`, no own clients, no own `mcp:` | its own, bound at creation | its construction; on `yamlBuilderConnect` at startup, the pass right after the harvest (D38) | the server's shared clients with `_sharedMcpClientDescriptors` / `_configuredSlotCount` — what every re-wire hands it | at startup on every path; after a drain, its lazy rebuild |
| own `rag`, own `mcp:` | its own, bound at creation | its own builder's auto-connect on the construction's build (§6.1) | its own connection | the construction only: a re-wire hands the builder the backfilled clients through `withMcpClients`, which does not vectorize |

- `buildSubAgent` fills on the **construction** (no `injected`) **right before `subBuilder.build()`**,
  from the clients it would hand a re-wire, so the records carry the names the worker's agent
  dispatches by — by construction (D32). It runs the store's fill source: `corpus` reads no
  client.
- **A per-session re-wire never fills** (D41): it receives the cached store by reference.
- **When the shared clients are known — always at startup (D38).** On every path except
  `yamlBuilderConnect`, they are resolved before the startup primary builds of the workers, so the
  construction fills a worker on the shared clients at startup, before the server listens. On
  `yamlBuilderConnect` the shared clients are taken from the main builder after the workers'
  startup build, so `_buildInfra` makes **one fill pass right after the harvest**: every worker
  with its own bound store, no own `mcpClients` and no own `mcp:` is filled from the harvested
  clients with `_sharedMcpClientDescriptors` / `_configuredSlotCount` — before `/health` and
  listen — and then the worker's skills are vectorized into that store (their build skipped them,
  D66). That pass completes those workers' creation at startup; it is not a refill.
  A lazy rebuild later finds the shared clients known and fills in the construction.
- **`PUT /v1/config` and hot reload** drain the worker cache (`WorkerRegistry.drain`). The next
  session's `WorkerRegistry.build` misses the cache and constructs the worker (`buildSubAgent`
  without `injected`): `resolveWorkerLlmSet` creates a new store, `withToolsStore` binds it with its fill
  source, and that construction fills it. In the earlier design
  (`fillWorkerToolsStores`, startup only) these rebuilds left the new bound stores empty.
- **A construction that fails anywhere leaves no cached worker.** `resolveWorkerLlmSet` caches the
  worker's set before the build; the cleanup covers the **whole** construction — the server's fill,
  `subBuilder.build()` (where a worker on its own `mcp:` is filled by its builder through the
  store's fill source) and the backfill of the entry from the built handle. When any of them throws
  (an incompatible corpus, a store the corpus source refuses, an invalid `IToolRecordKey`, a binding
  its store does not carry, a failing build), `buildSubAgent` removes that entry and closes the
  handle it built before rethrowing; a `build()` that fails has no handle and disposes its own
  connection itself — the connection strategy it resolved through, the YAML `mcp:` one it created
  **or an injected one** (`withMcpConnectionStrategy`): an injected strategy is owned by the agent /
  pipeline it is injected into, so `handle.close()` disposes it and a failed `build()` does too, and
  the consumer must not reuse it after either (the user's decision, D64). So no later session re-wires a worker whose store was never filled — an empty
  or partial store, possibly with the parent's clients — and the next session constructs it again
  (a new store, filled again). A configuration error stays loud: that construction throws again.
- A worker's own **persistent** store (its `rag` on qdrant, …) is bound again on every construction
  and its source runs again: `live` replaces each record in place; `corpus` clears the store and
  loads the corpus again (D54). Several server processes writing one persistent
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
  what `/health` reports as `components.toolCatalog`.
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
  descriptors, a binding its store does not carry, an incompatible corpus or a store the `corpus`
  source refuses (no `clearAll`, no precomputed write, §3.10) **throws**:
  - main store → startup fails, as on the builder's path;
  - a worker's startup build → startup fails;
  - a worker's lazy rebuild → that session's worker build fails, like any worker build error; its
    cache entry is removed (rule 2) — whether the server's fill, the builder-driven fill inside
    `subBuilder.build()` or the backfill threw — so the next session constructs it again.
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

| # | Path | Code | Store | Under a profile | `live` | `corpus` | `consumer` |
|---|---|---|---|---|---|---|---|
| 1 | Builder `build()`, auto-connect branch (YAML `mcp:` / `withMcpConnectionStrategy`) | `builder.ts`, `vectorizeMcpTools(…, toolsRag, …)` | `setToolsRag` or the auto-created `InMemoryRag`; bound by `withToolsProfile`, or already bound by the server | creation: `vectorizeMcpTools` runs the store's source (rule 1) | lists + indexes | clears the store, loads the corpus (precomputed) | nothing |
| 2 | Builder `build()` with `withMcpClients` / `withMcpServers` | `builder.ts`, "skip auto-connect and vectorization" | the same | not the builder (§6.1 limit): the consumer (`fillToolsBinding`, `bound.index`), or the server (rows 4, 5) | — | — | — |
| 3 | Reconnect: `McpToolRegistry.resolveActiveClients` → `toolsChanged` → `revectorizeTools` (any agent with a connection strategy) | `mcp/tool-registry.ts` | `ragStores.tools` — the projection: the bound store itself (no store is wrapped, D68), or a consumer's decorator over it | **never written** (D46): `revectorizeTools` finds the binding and stops, one `mcp` debug line; no source is called — **finding (a)**. An unbound store: 30.1.0 re-vectorize, unchanged; a tool no longer listed keeps its records (D40) | **no write** | **no write** | **no write** |
| 4 | Server main store | `_buildInfra`: `makeRag` → `withToolsStore` (bound with the YAML `fill` source) | the main store | creation, once: the server (`fillBoundToolsStore` → `fillToolsBinding`) on ready clients, an injected seam, plugin clients or no MCP — before the startup build writes the skills (D66); on `yamlBuilderConnect` the builder (row 1) | lists + indexes | clears, loads | nothing |
| 5 | Server worker store, created by the worker's **construction**: the startup primary build, or the lazy rebuild after a drain (`PUT /v1/config`, hot reload) | `WorkerRegistry.build` (cache miss) / the startup loop → `buildSubAgent` (no `injected`) → `resolveWorkerLlmSet` → `makeToolsRag` → `withToolsStore` | the worker's own | creation, once: `buildSubAgent` before `subBuilder.build()` (rule 2) — **finding (b)**; on `yamlBuilderConnect`, a worker on the shared clients by the pass right after the harvest (D38); own `mcp:` → row 1; a throwing fill removes the cache entry | lists + indexes | clears, loads | nothing |
| 5a | Per-session re-wire of a worker | `WorkerRegistry.build` (cache hit) → `buildSubAgent` with `injected` | the cached store, by reference | **never written** (D41) | — | — | — |
| 6 | Worker without its own `rag` | `buildSubAgent`: `setToolsRag(injected.toolsRag)` | the main store, by reference | row 4; never filled again | — | — | — |
| 7 | Per-session agents (`buildSessionAgent` → the pipeline builder) | `smart-server.ts` | the main store by reference (`parts.toolsRag`); clients through `withMcpClients` | row 4; their registries reach it only through row 3 | — | — | — |
| 8 | Builder skills into the tools store | `vectorizeSkills` (`builder.ts`; for the one store filled after its build, `fillToolsBinding`'s `skills`) | the tools store | skill records, 30.1.0 pass-through (§7.7) — not tool items, not a fill source's; always written **after** the store's fill (D66, §6.3), so a `corpus` clear never erases them (a writerless store is skipped, as today) | — | — | — |
| 9 | A consumer of the builder | §6.1 snippet; `fillToolsBinding`; `bound.index` | the consumer's | the consumer; the binding and its source attached by `bindToolsProfile` | as row 1 | as row 1 | the consumer's `bound.index` |
| 10 | `scripts/rag-eval` profile arms | `runProfileArm` (§14.3) | the eval store | `vectorizeMcpTools` on a store bound by `bindToolsProfile` (rule 1) with the default `live` source | lists + indexes | — | — |
| 11 | The consumer's build step | `buildToolsCorpus` (§6.5) | an in-process capture store, never a served one | the profile's own `bind` + `index` over capture stores; nothing is served from it | — | — | — |
| 12 | `SmartAgent.addRagStore('tools', …)` | `agent.ts` | — | refused (a built-in store), as in 30.1.0 | — | — | — |
| 13 | RAG editing tools (`rag_add`, …) | registry editors | — | the `tools` entry is registered without an editor: not reachable | — | — | — |
| 14 | Hot reload of weights | `config-reload-watcher.ts` | any store | not a fill — weights only | — | — | — |

### 6.5 The tools corpus — made by the consumer's build step, loaded by the server at start (D43, D54)

**TL;DR.** The profile's indexer runs outside the server to produce a corpus. Two steps, two layers
(goal decision 2026-10-05, D54):

| Step | Layer | When | Function | Embedding calls | Result |
|---|---|---|---|---|---|
| **build** | the consumer (its build script, with the libs API) | the consumer's build (CI) | `buildToolsCorpus` | yes — the document embedder, once | a `ToolsCorpus` (records + vectors), serialized as JSON |
| **load** | the server (its start; or a builder consumer's composition root) | the store's instance creation — part of the deploy, since a deploy starts the server | `parseToolsCorpus` → `ToolsCorpusLoader` (the `corpus` fill source, libs) | **none** — precomputed vectors | the store cleared and holding exactly the corpus; one log line |

There is **no deploy step and nothing about the corpus is kept in the store**: no service record, no
pending / final state, no id list, no hash. In-memory and persistent stores are loaded the same
way. An interrupted load repeats at the next start.

```ts
export interface ToolsCorpusIdentity {
  /** The consumer's name for the profile composition, e.g. 'faceted@1'. */
  readonly profile: string;
  /** The consumer's name for the document embedder, e.g. 'aicore-te3-small'. */
  readonly embedder: string;
}
/** What the server is configured with — checked against the corpus file before the store is touched. */
export interface ToolsCorpusExpectation extends ToolsCorpusIdentity {
  /** The vector length the store is configured for, when declared (e.g. a pg-vector / HANA store's
   *  `dimension`). Absent → not checked by the library (a backend that fixes it refuses the write). */
  readonly dimensions?: number;
}
export interface ToolsCorpusManifest {
  readonly format: 1;
  readonly identity: ToolsCorpusIdentity;
  readonly profileName: string;              // the binding's profileName at build
  readonly dimensions?: number;              // every vector's length; absent exactly when there are no records
  readonly items: number;                    // tools
  readonly records: number;
  readonly corpusHash: string;               // sha256 over the identity and every record — the file's integrity check and the log's label
}
export interface ToolsCorpusRecord {
  readonly id: string;                       // the physical id the profile assigned (§3.1)
  readonly text: string;
  readonly vector: readonly number[];
  readonly metadata: RagMetadata;
}
export interface ToolsCorpus { readonly manifest: ToolsCorpusManifest; readonly records: readonly ToolsCorpusRecord[] }

/** Build step: provider tool definitions → records + vectors, with the profile's own indexer. */
export function buildToolsCorpus(input: {
  readonly profile: ICollectionProfile<ToolItem>;
  readonly embedder: IRetrievalEmbedder;      // the store's embedder at run time (its document side)
  readonly identity: ToolsCorpusIdentity;
  readonly items: readonly ToolItem[];        // toolItemFromTool over the provider's definitions
}, options?: CallOptions): Promise<ToolsCorpus>;
/** The serialized corpus back: shape, format, one dimension (none when empty), the hash recomputed. Throws on any mismatch. */
export function parseToolsCorpus(json: string): ToolsCorpus;
/** The `corpus` fill source (§3.10): at instance creation, check, clear the store, write, log. */
export class ToolsCorpusLoader implements IToolsFillSource {
  constructor(options: { readonly corpus: ToolsCorpus; readonly expect: ToolsCorpusExpectation });
}
```

**Build (`buildToolsCorpus`) — the consumer's layer.**

- Binds the profile to a **capture store** (an internal in-memory `IRag`, private to libs — not a
  shipped store, not in any `testing` entry point — that owns the given embedder through
  `IRetrievalEmbedderOwner` and keeps every precomputed write) and calls `bound.index(items)`. So
  the records are exactly what the same profile's indexer and record writer produce at run time:
  same ids (§3.1), texts, metadata; only the store differs.
- Any `failedItems` → throws naming them: a corpus is complete or not built.
- **An empty corpus is valid** (D49). No items → a corpus with zero records and a manifest with
  `items: 0`, `records: 0` and **no `dimensions`** (nothing to infer it from). `parseToolsCorpus`
  accepts it: `dimensions` must be absent when there are no records and a positive integer when
  there are, and the per-record dimension check runs over the records there are. A consumer that
  removes every tool ships this corpus, and the next start empties the store (below).
- Item ids must be what tool selection reads at run time: `toolItemFromTool(tool, { itemId:
  toolRecordKey.key(…), originalName })` with the same `IToolRecordKey`, client order and namespace
  as the server (§6.1 snippet). The consumer's build reads the tool definitions from its provider
  (an MCP server it starts in CI, or the definitions the provider exports).
- Serialization is `JSON.stringify(corpus)`; `parseToolsCorpus` is its checked inverse.

**Load (`ToolsCorpusLoader.fill`) — the server's layer, at the store's instance creation.**

| Step | What |
|---|---|
| 1. identity | `identity.profile` / `identity.embedder` equal `expect`'s; the manifest's `profileName` equals the binding's; `manifest.dimensions` equals `expect.dimensions` when both are present. Any difference → throw naming it |
| 2. capability | every capability the load uses — a precomputed write (`writer().upsertManyPrecomputedRaw` or `upsertPrecomputedRaw`) **and** `clearAll` — is checked on the writer of the store it writes (`ctx.target.rag`). Any one missing → throw naming the store and what is missing, before any mutation. The check reads the writer the load then calls; a `StrategyRag` returns its inner writer unchanged. *Until D68 it ran twice — also on the resolved backend behind the store's decorators — because `FallbackRag` claimed both capabilities over a backend without them (D52); `FallbackRag` is removed, and the second check with it (§10.4)* |
| 3. clear | `writer().clearAll()`; a failure throws |
| 4. write | every record with its precomputed vector, in batches (`upsertManyPrecomputedRaw` when present, else one `upsertPrecomputedRaw` per record); a failed write throws |
| 5. log | one summary line through `ctx.logger`: the source (`corpus`), the identity, `items`, `records`, `corpusHash` — on the same channel as the live fill's summary line (`LogEvent` `type: 'warning'`, `traceId: 'builder'`: the only free-text event `ILogger` has; no contract change) |
| 6. status | `{ total: items, vectorized: items, records, profile: profileName, complete: true }` |

- **Steps 1–2 run before the store is touched**, so an incompatible corpus or store leaves it as it
  was. A failure in steps 3–4 leaves the store empty or partial; the throw fails the start (main
  store) or that worker's construction (§6.3) — loud, never a silent empty store — and the next
  start repeats the load from step 1.
- **Why clear and not a per-record replacement:** the corpus is the store's whole content.
  Clearing first means no record of an earlier corpus, profile or embedder survives (the store
  holds no list of what an earlier load wrote, D54), and every write lands in an empty slot, so no
  old metadata key merges in (`InMemoryRag.upsert` and `VectorRag`'s `upsertKnownVector` set
  `metadata = { ...old, ...new }` on an in-place write).
- **A store without `clearAll` is refused** (step 2) — checked on the writer of the store it writes —
  rather than loaded by deleting the corpus's own ids: the store may hold records the corpus does
  not list, and only a clear removes them (§3.10).
- **An empty corpus** (D49): step 3 clears the store, step 4 writes nothing; the status is a
  complete catalog of 0 tools (`total: 0`, `vectorized: 0`, `records: 0`, `complete: true`).
- **Several instances over one persistent store** each clear and load it at their start; the
  window in which others read a partial store is the consumer's to accept (§3.10, D13).

**How a consumer uses it** (a sketch; the names are the consumer's):

```ts
// build step (CI) — the consumer's scripts/build-tools-corpus.ts
const profile = mcpToolsVariants.faceted();
const tools = await listProviderTools();                 // the consumer's: McpTool[] from its server
const items = tools.map((t) => toolItemFromTool(t, {
  itemId: defaultToolRecordKey.key({ toolName: t.name, clientIndex: 0, clientCount: 1 }),
  originalName: t.name,
}));
const corpus = await buildToolsCorpus({ profile, embedder, identity: { profile: 'faceted@1', embedder: 'aicore-te3-small' }, items });
writeFileSync('dist/tools-corpus.json', JSON.stringify(corpus));

// at start — the SmartServer: YAML `fill: { corpus: { file, profile, embedder } }` (§6.2) does this.
// A builder consumer's composition root does the same itself:
const loaded = parseToolsCorpus(readFileSync('dist/tools-corpus.json', 'utf8'));
bindToolsProfile(profile, { key: 'tools', rag: qdrantRag /* or new VectorRag(embedder) */ },
  new ToolsCorpusLoader({ corpus: loaded, expect: { profile: 'faceted@1', embedder: 'aicore-te3-small' } }));
// the store's creation (the builder's build(), or fillToolsBinding([], bound)) clears it and loads the corpus
```

- This mirrors cloud-llm-hub's flow (a bundle built at build time and loaded into the store at
  start), generalised to any `IRag` with precomputed writes and `clearAll`.

### 6.6 What is filled at instance creation — the tools store only

- Filling at instance creation (§3.10, §6.3) and the fill sources (`live`, `corpus`, `consumer`)
  concern **only the `tools` store**: profiles exist only for `tools` in this PR (S8),
  and a tools store's content is fixed by its provider.
- Collections that change while the server runs are **not** filled at creation and get no fill
  source:
  - **session collections** and **session history** — written during work by pipeline elements;
  - **user collections** — written during work, by pipeline elements or the consumer's actions;
  - **shared items** — written and removed by the pipeline elements that own them, through
    `SharedItemsProfile` `index` / `remove` (§8.4).
  Without a profile for their key they stay on 30.1.0 behaviour (goal 8).

---

## 7. MCP tools — strategies the consumer chooses, and named compositions

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
  named composition: `NameTailFacet` (§7.3.1) is the one.
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
| only fine-grained tool sets considered | one tool per operation **and** object | coarse sets are covered by the same strategies (one record per tool, a pool up to the whole set, a reranker, a token-budget guard) — which fits is the consumer's measurement (§2.5.1, §7.4); `EnumValueToolIndexer` and `TokenBudgetCut` stay generic strategies in no named composition |

### 7.1 Principle — the consumer chooses the strategies

(Goal decisions 2026-10-05: where tuning lives; the main behaviour choices are the consumer's;
measurements made in a consumer justify no framework default.)

**1. The consumer decides the behaviour.**

- A profile is a **composition of strategies the consumer injects** (§7.2): indexing, candidate
  pool, collapse, reranker, final cut, query decomposition.
- The main behaviour choices — which records, which reranker, how many tools come back, whether
  to guard the prompt size — are made by **choosing those strategies**. No flag inside a component
  makes them.

**2. A named composition only fills in what the consumer did not choose.**

- llm-agent ships the **contracts** and **generic strategies**, plus a few **named compositions**
  ("variants", §7.4) to start from.
- A named composition is not the centre of the design: it is a ready-made answer for the choices
  the consumer leaves open. Taking it whole is one choice; replacing any part of it is another
  (§7.5).
- No named composition relies on one server's conventions (§7.0). Where none fits a server, the
  consumer composes its own from the contracts (§7.9).

**3. Nothing that ships carries a tuned number (D55).**

- The measurements behind this design were made in a consumer (cloud-llm-hub, on mcp-abap-adt) and
  are **not in this repository** (§2.0). So they justify no number in a strategy class or a named
  composition.
- A number a strategy or a named composition needs is either:
  - a **required argument** from the consumer, where no generic value can be right — a reranker's
    pool depth (`poolItems` of `faceted-rerank`), a token budget (`budgetTokens`), a value-record
    bound (`maxValues`), a score floor (`minScore`); or
  - a **generic default** that guesses nothing about a catalog or a model (D56):

    | Number | Generic default | Why it guesses nothing |
    |---|---|---|
    | the final cut | the caller's k (`TopItemsCut`) | the caller already chose it; 30.1.0 returns k too |
    | the candidate pool | k items of the (sub-)query (`ItemPool()`), i.e. `k × maxRecordsPerItem` records | the fewest items that can fill the cut; without a reranker it is exactly what the cut keeps |
    | a size estimate | ~4 characters per token (`ToolDefinitionSizeEstimator`, `CharsPerTokenEstimator`) | the unit convention the probability reranker already uses (§4.10), not tuned to a catalog |
    | rerank batching | `maxBatchTokens` 48000, `concurrency` 4 | 30.1.0's `DecisionReranker` request limits (§5.2), not a retrieval number |

- A lower cut (`maxItems` → `FixedItemsCut`) or a deeper pool is the consumer's argument, from its
  own measurement (§14.3).
- Nothing is guessed (goal 3): the consumer picks a named composition explicitly, or its own
  strategies.

### 7.2 The strategies

| Step | Contract | Shipped instances |
|---|---|---|
| indexing | `IItemIndexer<ToolItem>` | 30.1.0 single record (no profile); `FacetedToolIndexer(facets, { text? })`; `EnumValueToolIndexer(inner, { discriminator, maxValues })` |
| provider text (inside faceted indexing) | `IToolTextComposer` | `ParameterNamesToolText` (default, C0); `EnumValuesToolText` (C0e), `SchemaToolText` (C0s) — measured within noise, in no default (§7.3.1) |
| facet (inside faceted indexing) | `IToolFacet` | `SummaryFacet`, `ParametersFacet`; opt-in, convention-dependent: `NameTailFacet` |
| discriminator (inside per-value indexing) | `IDiscriminatorSelector` | `RequiredEnumDiscriminator`, `NamedDiscriminator(parameter)` |
| in-store scoring | `ISearchStrategy` (existing, on the store) | the store's own (hybrid or cosine) |
| candidate pool | `ICandidatePool` | `ItemPool(n?)` (no `n` → the caller's k) |
| collapse | `ICollapseRule` | `MaxScoreCollapse` |
| reranker | `IReranker` (existing) | none; `ProbabilityReranker` + `TOOL_QUESTION` over an `IProbabilityDecision`; `RelevanceReranker` over an `IRelevanceDecision`; `LlmReranker` (all in `llm-agent-reranker`) |
| decision (inside a reranker) | `IProbabilityDecision` / `IRelevanceDecision` (§3.9) | `TypeSafeDecisionModel` (Jev, probability, existing); `SapAiCoreRelevanceDecision` (Cohere on SAP AI Core, relevance, new) |
| query decomposition | `IQueryDecomposer` (optional, §4.5) | **none** — the consumer's own |
| final cut | `IItemCut` | `TopItemsCut` (the caller's k), `FixedItemsCut(n)`, `ScoreFloorCut(...)`, `TokenBudgetCut(...)` |
| size estimate (inside a token cut) | `IItemSizeEstimator` | `ToolDefinitionSizeEstimator` (default), `CharsPerTokenEstimator(n)` |

The composing class is `ComposedToolsProfile` (an `ICollectionProfile<ToolItem>`):

```ts
new ComposedToolsProfile({
  indexer: IItemIndexer<ToolItem>,
  pool?: ICandidatePool,          // absent → ItemPool() (the caller's k)
  collapse: ICollapseRule,
  rerank?: StagedRetrievalOptions['rerank'],
  decompose?: StagedRetrievalOptions['decompose'],
  cut?: IItemCut,
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics },
})
```

- `bind({ key, rag })` — one store; every record of a tool goes there (D50: no companion stores).

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
  | `ParameterNamesToolText` (**C0**) | `Tool: <name> — <description>` + `\nParameters: <names>` | **yes** — the least schema text: 30.1.0's record text plus the parameter names |
  | `EnumValuesToolText` (**C0e**) | C0 + per parameter with string values: `<name>: <values>` | no |
  | `SchemaToolText` (**C0s**) | C0 + per parameter: its description's first clause and its string values | no |

  **Measured in the consumer** (evidence, §2.0 — mcp-abap-adt `compact`, Jev over the whole role
  set, required-recall; EN 67 rows, non-ASCII 21 rows; ~1.6k tokens at k=3 for all three):

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
  - **So the default stays C0** — not because of a figure (D55) but because it adds the least
    schema text to 30.1.0's record and no measurement showed a winner; C0e / C0s are strategies a
    consumer may inject and measure on its own server (§14.3).
- **Why `parameters` replaces the measured `object` record in the default:** it carries the same
  kind of signal — what the tool acts on — from the **schema** (e.g. a `path` or `class_name`
  parameter) instead of from a naming convention. **Not measured yet**; a consumer measures it on
  its own catalog (§14.3).
- **`NameTailFacet` — convention-dependent, documented as such.** It assumes verb-first names
  (`GetClass`, `create_issue`): the tail is then the object. On object-first names (`class_get`)
  it yields the operation; on single-word names, nothing. It reproduces the measured `object`
  record exactly, so a consumer on a verb-first server may add it (§7.5). It is in no named
  composition.
- The goal's rule holds: nothing is written over provider text. A weak description is fixed at its
  source.

#### 7.3.2 Per-value records — a generic strategy in no named composition (`EnumValueToolIndexer`)

**Status: a strategy the consumer may inject; in no named composition.** Measured **worse** in the
consumer on its one coarse example (mcp-abap-adt `compact`, §2.5.1, evidence):

| Layout | Stage 1 only, k=3 / k=5 / budget 2k | With Jev |
|---|---|---|
| one record per tool (C0) | 0.896 / 0.955 / 0.896 | English 0.970 (k=3); non-English 1.000 |
| C0 + one `value` record per enum value (C1) | 0.776 / 0.896 / 0.761 | English equal to C0; non-English **0.857** |

- **Why it stays:** the hypothesis below is generic and may hold for another server's coarse set
  (more tools, no reranker, values with descriptions). A consumer that wants it injects it and
  measures it on its own set (§14.3).
- **Why no named composition uses it:** it needs `maxValues`, a number only the consumer knows, and
  the only evidence (a consumer's) showed it lowering recall with and without a reranker.

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
  text. Every word is the provider's.
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
| the binding (`ComposedToolsProfile`) | asks its indexer, when it has the capability, after `toRecords`; copies each note with the item's id into `IndexReport.notes` |

- The server path logs every note as a warning when it fills the tools store (§7.6), so a note is
  never lost between the report and the operator.

#### 7.3.3 No generated records (D50)

Every tool record is built from what the provider exports. LLM-generated intents — once an
indexing strategy here, in their own `intent` record or in a companion store — were measured and
dropped (§2.1, goal decision 2026-10-05):

- **no gain:** within noise without a reranker, no better with one; the reranker reads the
  provider text equal or better without them (§2.2);
- **a running cost:** an LLM generation at build, a regeneration on every tool change, and audits
  (one audit found poisoned intents);
- **misleading hints:** they restate the description, and can name the wrong thing — for
  `CreateDdl` (mcp-abap-adt example) the generated "create database view" is a different object
  type than the tool creates.

A weak description is fixed at its source (goal decision 2026-10-04). With intents went
everything that existed only for them: companion stores, `variants` sources, the reserved keys
`companionRecordIds` / `staleCompanionRecordIds` / `generated`, and the YAML `intents` key. A
consumer that still wants extra records writes its own `IToolFacet` or `IItemIndexer` (§7.9);
they go into the same store, under the same item id.

### 7.4 Named compositions (`mcpToolsVariants`)

**What they are:** ready-made compositions that fill in what the consumer did not choose (§7.1).
Each is a factory that takes only what cannot be shipped and returns a `ComposedToolsProfile` — or,
for `baseline`, nothing to bind. **None carries a tuned number** (D55): a number it needs is a
required argument or the generic default of §7.1. None relies on one server's conventions (§7.0).

| Variant | Composition | Required from the consumer | Generic defaults |
|---|---|---|---|
| **`baseline`** — no choice made | 30.1.0 single record per tool + `EmbeddingRetrieval` (top-k records = tools). Selected by binding **no** profile. | — | 30.1.0 |
| **`faceted`** | `FacetedToolIndexer([SummaryFacet, ParametersFacet])` (`full` + `summary` + `parameters`, all from provider text) + `ItemPool` + `MaxScoreCollapse` + no reranker + cut | — | pool = the caller's k items; cut = the caller's k (`TopItemsCut`). Optional `poolItems`, `maxItems` (→ `FixedItemsCut`) |
| **`faceted-rerank`** | faceted indexing + `ItemPool(poolItems)` + `MaxScoreCollapse` + **the consumer's `IReranker`** (e.g. `RelevanceReranker` over Cohere, `ProbabilityReranker` with `TOOL_QUESTION` over Jev) + cut | `reranker`, `poolItems` | cut = the caller's k. Optional `maxItems` (→ `FixedItemsCut`). A failed rerank is `RERANK_ERROR` (D71) |

```ts
mcpToolsVariants.faceted();                                         // pool and cut: the caller's k
mcpToolsVariants.faceted({ poolItems, maxItems });                   // the consumer's numbers
mcpToolsVariants.facetedRerank({ reranker: new RelevanceReranker(new SapAiCoreRelevanceDecision({ … })), poolItems });
mcpToolsVariants.facetedRerank({ reranker: new ProbabilityReranker(new TypeSafeDecisionModel({ … }), { task: TOOL_QUESTION.task, criteria: TOOL_QUESTION.criteria }), poolItems, maxItems });
// the consumer's own decomposer on top of any variant except baseline (none shipped):
mcpToolsVariants.facetedRerank({ …, decompose: { decomposer: myDecomposer, queryEmbedder } });
```

- **Why `poolItems` is required for `faceted-rerank`:** with the generic pool (k items) and the
  generic cut (k), the reranker could only reorder what stage 1 already returned — it could never
  bring in an item stage 1 ranked below k, which is what a reranker is for (§2.2, evidence). How
  deep to look is the consumer's calibration (its catalog, its model, its cost), so it has no
  default. `poolItems` ≥ the tool count reranks the whole set — the small-coarse-set case of
  §2.5.1.
- **Why these three** (D55):
  - `baseline`: no change (goal 4);
  - `faceted`: several records per item and collapse — the mechanism the evidence motivates
    (§2.1), not expressible in 30.1.0;
  - `faceted-rerank`: the same with a reranker on provider text (goal 10). It takes **an
    `IReranker`**, so it names no vendor; Cohere and Jev are the consumer's choice of reranker
    (§5.5).
- **Withdrawn** (D55), each because without its measured numbers nothing distinguishes it:
  - `faceted-cohere` and `faceted-jev`: they differed from each other only in the reranker's vendor
    and from `faceted-rerank` only in their measured pool (30) and cut (5);
  - `small-set-jev`: without its measured cut (3) it is one record per tool + a pool of the whole
    set + Jev — exactly 30.1.0's `rerank-all` (`maxCandidates` = the tool count) or a `compose`
    with `FacetedToolIndexer([])` and `poolItems` ≥ the tool count. With it go its startup check
    (`assertSmallSetPool`, D23) and the YAML `smallSet` key;
  - the variant-to-decision-kind check of YAML (D27's part): `faceted-rerank` takes either kind.
- **Every cut here is the caller's k or a ceiling under it** (§4.9): a caller asking for 2 gets at
  most 2.
- **What the consumer's evidence says about these compositions** (§2, motivation only): the
  schema-derived `parameters` record of `faceted` is not measured yet; the closest measured
  layouts (name-derived facets) reached 0.966 at k=5 in the consumer, and a reranker over a pool
  of 30 items restored non-English recall (§2.2, §2.3). A consumer measures its own composition
  with the harness (§14.3) and sets `poolItems` / `maxItems` from that.
- **Not in any named composition:** `EnumValueToolIndexer` (§7.3.2), `TokenBudgetCut` (§4.10),
  `NameTailFacet` (§7.3.1). All remain strategies the consumer may inject.

### 7.5 Composing your own

This is the main path (§7.1): the consumer chooses each strategy; a named composition fills only the rest.

- Any shipped strategy combines with any other; a consumer's own strategy implements the same
  contract (e.g. its own `IToolFacet`, `IDiscriminatorSelector`, `ICandidatePool`,
  `IItemSizeEstimator`, `IReranker`, `IProbabilityDecision` or `IRelevanceDecision`).
- Typed rule: `full` cannot be dropped (it is not a facet).
- Examples:
  - the **measured** name-derived fine-grained layout, for a verb-first server:
    `FacetedToolIndexer([new SummaryFacet(), new NameTailFacet()])` — convention-dependent, the
    consumer's choice;
  - a prompt-size guard on top of a count: `TokenBudgetCut({ budgetTokens, maxItems })` in
    place of `FixedItemsCut(maxItems)` — the count stays the main cut, the budget only caps it
    (§4.10);
  - a small set reranked as a whole: a `ComposedToolsProfile` with `FacetedToolIndexer([])` (one
    `full` record per tool), `ItemPool(<tool count>)`, `MaxScoreCollapse` and the consumer's
    reranker in code, or `compose` with `reranker: decision` in YAML (§6.2) — or, without a
    profile, 30.1.0's `rerank-all`;
  - schema-enriched provider text: `FacetedToolIndexer([...], { text: new EnumValuesToolText() })`
    (C0e) or `SchemaToolText` (C0s) — within noise on `compact` (§7.3.1);
  - per-value records for a coarse set where the consumer expects them to help:
    `EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator, maxValues })` (measured
    worse on `compact`, §7.3.2).
- What one consumer's measurements showed (evidence, §2 — calibrate on your own catalog, §14.3):
  - with several records per item, count the pool in **items**, not records (§2.2);
  - under a reranker, a pool deeper than k is what lets it bring in better items (§2.2, §2.3);
  - on a small coarse set, a reranker over the whole set did as well as stage-1 tuning; a count
    was the better main cut and a token budget only a guard (§2.5.1).

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

### 7.7 Tools and builder skills in one store

- **Skills stay on today's behaviour for now.** Their own default variants come later through the
  same contracts (goal 8).
- Today `vectorizeSkills` writes `skill:<name>` records into the tools store
  (`builder.ts:1356-1358`). Decided: **coexist by pass-through**.
  - Skill records are written exactly as today (no `itemId`), so `StagedRetrieval` passes each one
    through as its own item (§4.3). They compete for k as they do today; a reranker on the tools
    store scores them with the tools question, as `rerank` on `tools` already does in 30.1.0.
  - `skill-select` finds them by id as today (with fix F3).
  - **Written after the store's fill** (D66, §6.3): the `corpus` source clears the store, so every
    path fills a bound store before skills are vectorized into it.
- Moving skills to their own store would change their k, ranking and stage layout — a behaviour
  change goal 8 excludes. Decided — D4 (§17).

### 7.8 Store migration

- A store is filled by one composition.
- Turning a variant on adds records next to the 30.1.0 ones (profile ids are owner-scoped, §3.1,
  so they never overwrite the 30.1.0 records); turning it off leaves profile records behind that
  the 30.1.0 path would rank as records.
- So switching variants on a persistent store filled by `live` = a fresh collection
  (redeploy), like an embedder change. Every record carries `profile` in metadata for diagnosis.
- A store loaded by the `corpus` source (§6.5) needs no migration: every start clears it and loads
  the corpus, so a new corpus — of the same or another profile or embedder — replaces its whole
  content (D54). A change of vector length on a backend that fixes it per collection (qdrant,
  pg-vector, HANA) still needs a fresh collection; when the store config declares its `dimension`,
  the load refuses a mismatching corpus before clearing (§3.10).
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
- Cut: the consumer's `IItemCut`; absent → the caller's k (`TopItemsCut`). No number is recommended (D55).
- Each returned `RagResult` is the item **whole**, hydrated from its canonical record whichever
  record matched (§4.6): `text`, `metadata.data`, `metadata.visibility`, owner keys,
  `matchedKinds`, `source`. A hit whose canonical record is missing is dropped and counted.
- Paths: registered under its key, it is projected and queried as `rag-<key>` each request,
  through its strategy; a writing or reading element may also call `bound.retrieval` directly.

### 8.6 Constructor

```ts
new SharedItemsProfile({
  maxRecordsPerItem: number,      // required (§4.4)
  pool?: ICandidatePool,          // absent → ItemPool() (the caller's k, D56); deeper only with a reranker
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
| span `retrieval` (child of the request trace, via injected `ITracer`) | tracer: yes | attrs `store`, `strategy`, `sources`, `candidates.records`, `items.collapsed`, `items.returned`, `decomposer`, `subqueries`, `rerank.outcome` (`none\|ok\|error`), `rerank.error` (message), `orphans`, `hydration.reads` (canonical records read by `getById`, §4.6), `cut.name`, `cut.tokens` / `cut.budgetTokens` (cuts with `ISizeBoundedCut`, §4.10) |
| `IRetrievalMetrics.retrievalOutcome` counter | new small interface on the same metrics backend | attrs `store`, `strategy`, `outcome` ∈ `ok`, `rerank_error`, `decompose_error`, `orphan`, `over_budget` (§4.10; replaces `empty` when the top item alone is over the budget), `empty` |
| session step `retrieval_rerank_error` | yes (30.1.0 name kept) | unchanged; also emitted for a failed output check (§4.8) |
| `/health` | yes | `metrics.retrievalOutcome` when the metrics implement `IRetrievalMetrics`; `components.toolCatalog.records` / `.profile` |
| request logger | yes | reranker LLM / decision calls, as today (`component: 'rerank'`) |

- **A reranker error is always observable under a profile.** A wrong or missing score count from
  any reranker (`ProbabilityReranker`, `RelevanceReranker`, LLM, or a consumer's) → `RERANK_ERROR`
  → returned and counted (`rerank_error`), on the span, as a session step. Never silent (D71).
- With Cohere, a bad `/rerank` answer is caught twice: `SapAiCoreRelevanceDecision` returns a
  `DecisionError` (§5.3), and `RelevanceReranker`'s output check (§5.2) turns any error into
  `RERANK_ERROR`.

### 9.2 The 30.1.0 rerank strategies too

- `RerankedRetrieval` and `RerankAllRetrieval` accept the same optional `telemetry` (additive
  constructor option).
- This closes the goal's evidence item ("a fallback is only a session step") for consumers that do
  not adopt profiles.
- **No output check (S4); a failure is an error (D71).** The §4.8 output check is **not** applied to
  the 30.1.0 strategies: there a short reranker answer is accepted as in 30.1.0 (goal 4). A failed
  rerank (`ok: false` or a throw) returns `RERANK_ERROR` — S4's "no behaviour change" is superseded
  for the failure path by the goal's fail-loud decision (§10.5.5 K2) — counted `rerank_error`; a
  success `ok`. The output check stays in `StagedRetrieval`.
- `InMemoryMetrics` and `NoopMetrics` implement `IRetrievalMetrics`. No new log sink, no new logger.

### 9.3 Failure policy

- **One behaviour (D71):** a failed rerank — `ok: false`, a throw, or a failed output check (§4.8) —
  makes the retrieval return `RagError('…', 'RERANK_ERROR')`, counted `rerank_error`, on the span
  and as the session step `retrieval_rerank_error`; the stage reports it (§10.5). There is no
  `onFailure` option and no stage-1 fallback: a consumer who wants unranked results while its
  reranker is down injects an `IReranker` that answers them itself.

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
  - `IntentToolIndexing` is **not** ported — generated intents were measured and dropped (§2.1,
    §7.3.3, D50);
  - `SynonymToolIndexing` is **not** ported — its hard-coded verb synonyms are words the provider
    did not write.
- Docs that describe it as usable are rewritten to describe collection profiles:
  `docs/INTEGRATION.md:1516-1550`, `docs/PERFORMANCE.md:335-355`,
  `docs/ARCHITECTURE.md:584, 608-611`.

### 10.4 `FallbackRag` removed; the builder wraps no store (D68)

*Replaces the earlier §10.4 — `FallbackRag`'s optional writer capabilities only over a primary that
has them (D52) and no writer without a primary writer (D62). Both fixed a class that is now
removed and are withdrawn (§17.23); their text is in git history (`ae805d3a`).*

**TL;DR.** `FallbackRag` is gone, and so is the builder's loop that wrapped every registered store
in it. The circuit breaker stays on the embedder: with it open, a store's query fails fast with
`CIRCUIT_OPEN` instead of answering from an in-memory copy. A consumer that wants a degraded mode
writes its own `IRag` wrapper.

- **The decision** (the goal's, 2026-10-05): when RAG has problems they are deeper, and llm-agent
  cannot solve them; a fallback to an in-memory copy only hides the failure behind empty or partial
  results.
- **What `FallbackRag` was** (`packages/llm-agent/src/resilience/fallback-rag.ts` in 30.1.0): an
  `IRag` decorator over a primary and a fallback store on an embedder `CircuitBreaker` — `query`
  went to the fallback while the breaker was open, `getById` fell back on a miss, writes fanned out
  to both. Its one construction in the repository is the builder's circuit-breaker loop
  (`builder.ts` ~L1044-1085): with `withCircuitBreaker(config)` or `withCircuitBreakers({ embedder })`
  set, **every** registry store became `new FallbackRag(store, new InMemoryRag(), embedderBreaker)`.
- **Removed, with everything that existed only for it** (each checked with `git grep` over
  `packages/`, 2026-10-05):

  | Removed | Why it existed only for `FallbackRag` |
  |---|---|
  | `FallbackRag` — file, unit test, the root and `resilience/index.ts` exports | — |
  | the builder's wrapping loop over `ragRegistry.list()` and `isGuardedBy` (`builder.ts`) | the loop built `FallbackRag`; `isGuardedBy` found one on a shared breaker so it was not built twice |
  | `SimpleRagRegistry.replaceRag(name, scope, rag)` | its one caller is the loop (its doc names "the builder's circuit-breaker FallbackRag"); no test calls it |
  | `SmartAgentBuilder.withCircuitBreakers({ embedder })` and the `_sharedBreakers` field | its doc: "registry stores are wrapped in a `FallbackRag` on it". Its one caller, `SmartServer` (`smart-server.ts` ~L2956-2962: "the ONE embedder breaker guards the stores of every agent"), passed it for nothing else: the server lists its breakers in `/health` itself (`breakerList()`), and it never calls `withCircuitBreaker(config)`, so suppressing the builder's LLM breaker did nothing there. A pre-wrapped `CircuitBreakerLlm` gets the builder's retry under it without the option (`retryInsideBreakers` runs unconditionally) |
  | the embedder breaker `withCircuitBreaker(config)` built, with its `'embedder'` metric target | it guarded only the `FallbackRag` routing: the builder wraps no embedder with it (no `CircuitBreakerEmbedder` in `builder.ts`) and `FallbackRag` records nothing, so it never left `closed` while it sat in `handle.circuitBreakers` and `/health`. `withCircuitBreaker(config)` now builds the main-LLM breaker only |

- **Kept:**
  - **the breakers that guard calls** — `CircuitBreaker`, `CircuitBreakerLlm`,
    `CircuitBreakerEmbedder` / `withCircuitBreaker(embedder, breaker)`; the builder's main-LLM
    breaker (`withCircuitBreaker(config)`); the server's embedder breaker (`_embedderBreaker`), which
    wraps the retrieval embedder below the document/query role (`embedderBreakerWrap` →
    `resolveRetrievalEmbedder`) and is listed in `/health` (`breakerList()`);
  - **`IRagDecorator` and every walk through `inner`** — `hasRetrievalStrategy`,
    `applyRetrievalStrategy` and `ownBuiltInStore`'s `decorates` (libs), `retrievalEmbedderOf` (F1,
    §3.7), `toolsBindingOf` / `boundToolsOf` (§6.3 rule 1), `findWeightedStore` (server-libs).
    `StrategyRag` is a decorator, and the contract tells a consumer's own wrapper — a cache, a
    tracer, the degraded mode this decision leaves to the consumer — to expose `inner` so a binding,
    a strategy and a store embedder under it stay visible. `ownBuiltInStore` keeps its rule (a
    projection over another agent's store never wins); its "keeps layers such as the circuit-breaker
    fallback" reason is now "keeps a decorator the projection carries".
- **Behaviour with the embedder breaker open** (the server's, or a consumer's own
  `withCircuitBreaker(embedder, breaker)`): `CircuitBreakerEmbedder` throws
  `RagError('Embedder circuit breaker is open', 'CIRCUIT_OPEN')` without calling the provider, and
  the store's `query` returns that error (`VectorRag`: `{ ok: false, error }` from its catch) —
  before, `FallbackRag` answered from its in-memory copy. D68 does not change what a stage does
  with a failed query: the 30.1.0 `rag-query` stage records no results for that store
  (`ragQueryCount` with `hit: false`, `logRagQuery` with `resultCount: 0`) and the request
  continues. That silent continuation is itself a fallback, which the goal's newer decision removes
  ("No fallbacks anywhere in the pipeline", 2026-10-05): the stage now fails with the store's code
  (§10.5.4 R5, D74). Writes reach only the store they are written to; nothing is mirrored
  into a copy.
- **Effect on what the wrap touched** (each read, 2026-10-05):
  - a registry entry stays the store that was registered; `handle.ragStores.<key>` is that store,
    or a `StrategyRag` over it for an explicit strategy — never a `FallbackRag`;
  - the `relevant-skills:<group>` collections (`skillsRagSource`, no writer) have no writer, as
    registered — the case D62 fixed inside `FallbackRag` does not arise;
  - the corpus load (§6.5) checks and writes the writer of the store it was given; nothing the
    library puts between can claim a capability its backend lacks. A consumer's own decorator is
    checked through its own writer — the one the load writes through;
  - the session-isolation concern of a session's wrap mutating another registry (B26) has nothing
    left to mutate: no build changes a registry entry.
- **Tests** (§14.1): `FallbackRag`'s unit test is deleted; every test that built or expected one is
  rewritten — the builder asserts that `withCircuitBreaker()` leaves every registry entry and
  projected store as registered and holds one breaker; a projected strategy is `StrategyRag(store)`;
  a pre-wrapped store stays itself; the decorator walks run over a plain test decorator; a new test
  pins the behaviour (an open breaker → `CIRCUIT_OPEN`, no embedder call); the removed names are
  absent; the server's embedder-breaker test keeps its assertions.

### 10.5 Fail loud — no fallback, no silent degradation (D69–D74)

**TL;DR.** The goal's decision of 2026-10-05 ("No fallbacks anywhere in the pipeline", and "the
fail-loud sweep is part of this PR"): a pipeline or component that finds another component not
working **returns an error**. It never returns a fake success, an empty result, a skipped part, a
stale cache or a substitute component. A degraded mode is the consumer's own injected strategy.
`FallbackRag` went first (D68, §10.4); this section removes every other such path in llm-agent.
Every item below was re-read against the code on 2026-10-05 (`493fcf17`; lines may move).

#### 10.5.1 The rule and its carriers (D69)

- **What counts as a failure.** A component that was configured or injected and does not do its
  job: a call returns `ok: false`, throws, or answers in a shape its contract does not allow.
- **What is not a failure** (kept, unchanged):
  - **an optional capability absent by design** — no pipeline embedder (`TextOnlyEmbedding`, the
    store embeds the text itself), a strategy that reports no readiness, a worker that declares no
    clients of its own and so uses the shared ones (D38), a skill directory on a default search path
    that does not exist (`ENOENT`), a directory without `SKILL.md`, the implicit `.env` missing;
  - **an honest empty answer** — a store query that succeeds with no hits, smart tool selection
    whose store answered and matched no tool;
  - **best-effort cleanup on shutdown or after a request** (the close / logoff / dispose catches in
    `stop-all.ts`, `session-graph-factory.ts`, `worker-registry.ts`,
    `smart-server.ts`, `pg-pool.ts`, `http-mcp-server.ts`, `stdio-mcp-server.ts`,
    `build-session-mcp-clients.ts`): the work they guard is already done or abandoned; a failed close
    has nobody left to answer, and blocking a shutdown on it would turn one failure into two.
    `config-route-handler.ts`'s session-invalidation catch is **not** one of them: the drain and
    the invalidation are the `PUT /v1/config` transaction's verdict (V10, D80, D82);
  - **diagnostics-only catches** — `llm-reranker.ts` usage metering, the throttle observer
    (`llm/throttle.ts`): a broken diagnostic is not a broken request (the request's own result is
    untouched);
  - **a mode the consumer chose** — decided by the user in §17.24 (U1–U10); what stays and what
    changes is §10.5.12.
- **Where the error surfaces.**
  - a **pipeline stage** that cannot do its part sets `ctx.error` and returns `false`; the consumer
    receives `{ ok: false, error: OrchestratorError }` as the stream's last item (`streamProcess`)
    and as the result of `process()` — D70 makes that path work at all;
  - a **component** (store, embedder, preprocessor, reranker, MCP client, provider) returns its
    `Result` error or throws its typed error — whichever its contract already does;
  - a **server** start that cannot build what its config asks for fails the start
    (`ConfigValidationError` / a thrown error, exit code ≠ 0); an HTTP route whose backend failed
    answers an error status with `jsonError` (never a 200 with a placeholder);
  - **health**: a configured component that is not working makes `/health` not OK (D72).
- **Which code.** The stage's `OrchestratorError` **carries the failing component's code
  unchanged** (`CIRCUIT_OPEN`, `EMBED_ERROR`, `QUERY_ERROR`, `RERANK_ERROR`, `QUERY_EXPAND_ERROR`,
  `SKILL_ERROR`, `LLM_ERROR`, `MCP_NOT_CONNECTED`, …) and names the stage and the component
  (store key, client index, stage id) in its message. Existing stage codes are reused where they fit:
  `PIPELINE_ERROR` (a handler threw), `MCP_UNAVAILABLE` (a client cannot list tools),
  `COORDINATOR_PLAN_FAILED` / `COORDINATOR_PLAN_INVALID` / `COORDINATOR_STEP_FAILED`. **No shared set
  is widened** (`MCP_UNAVAILABLE_CODES` and `DecisionErrorCode` are untouched). Where no component
  code exists, the code comes from **one new set of its own**, `PIPELINE_FAILURE_CODES`
  (`@mcp-abap-adt/llm-agent`, `interfaces/pipeline-failure-codes.ts`):

  | Code | When |
  |---|---|
  | `RAG_STORE_MISSING` | a stage names a store the registry does not hold |
  | `STATE_CORRUPT` | persisted state cannot be read back (a tool-loop context of another version, a session bundle, a run-scope terminal entry) |
  | `TOOL_ARGUMENTS_JSON_PARSE_FAILED` | the LLM's tool-call arguments are not valid JSON — the string the OpenAI adapter already emits as a diagnostic, now a member of a set |

- **Observability stays where it is:** every error is also on the stage span (`setStatus('error')`)
  and in the session log (`stage_error_<id>` / the stage's existing step name). No new logger.

#### 10.5.2 Pipeline core — pipeline errors reach the consumer (D70, a bug fix, highest priority)

**The bug (N1).** Today a pipeline error never reaches the consumer:

- `PipelineExecutor.executeStages` catches a throwing handler, marks the span and logs
  `stage_error_<id>`, and returns `false` — `ctx.error` stays unset;
- `DefaultPipeline.execute` catches again and returns `{ timing, error: ctx.error }`;
- `pipelineToStream` ignores the returned `PipelineResult` (`.then(() => { done = true })`), so
  even a `ctx.error` set by `classify`, `assemble`, `subagent`, `coordinator` or `dag-coordinator`
  is dropped; its `.catch` (the only path that yields an error) is unreachable;
- `SmartAgent.streamProcess` sets the root span `ok`.

The consumer gets an empty (or truncated) stream that ends normally, and `process()` returns
`ok: true` with empty content. Only handlers that `ctx.yield({ ok: false, … })` themselves
(`tool-loop` ABORTED / LLM_ERROR, `tool-loop-core` MCP_UNAVAILABLE) get an error through.

**The fix.**

- the executor's catch sets `ctx.error` to an `OrchestratorError` with code `PIPELINE_ERROR` and
  the message `stage "<id>" failed: <err>` (unless a handler already set one; a thrown
  `OrchestratorError` is kept as it is, with its own code) before it returns `false`; an unknown
  stage type is the same error;
- `DefaultPipeline.execute`'s catch does the same for anything the executor let through;
- `pipelineToStream` reads the `PipelineResult`: when `result.error` is set **and no `ok: false`
  chunk was yielded already** (a handler that yielded its own error is not reported twice), it
  yields `{ ok: false, error: result.error }` as the last item;
- `streamProcess` sets the root span `error` (with the code) when the stream carried an error, `ok`
  only otherwise. The `error` status is set **before** the unsuccessful chunk is yielded (D78):
  `process()` returns on that chunk, which closes the generator, so nothing after the `yield` runs
  — a status set after it would never be written. Any consumer that stops reading at the error
  chunk is the same case. The span is still ended in `streamProcess`'s `finally`;
- `process()` already returns the first `ok: false` chunk — unchanged, it now receives one.

Layer: pipelines in llm-agent (libs `pipeline/`, `agent.ts`). Behaviour: a consumer that saw an
empty answer now sees an error (§13, behaviour table row B1).

**Other pipeline-core items.**

| # | Where (libs unless named) | Today | Now | Layer |
|---|---|---|---|---|
| N2 | `pipeline/handlers/tool-loop.ts` (~600), `agent.ts` (~1141), `adapters/llm-provider-bridge.ts` (~150), server-libs `controller/controller-coordinator-handler.ts` (~1554) | tool-call arguments that are not valid JSON become `{}`, and the tool **runs** with them | the tool does **not** run; the tool result given back to the LLM is an error naming the tool and the parse error (code `TOOL_ARGUMENTS_JSON_PARSE_FAILED`, in the tool message and as session step `tool_arguments_invalid`); the LLM may retry as with any tool error | pipelines |
| N3 | `adapters/llm-adapter.ts` (~88) | the same, `onDiagnostic` only | the same as N2; the diagnostic stays | pipelines |
| N13 | `policy/pending-tool-results-registry.ts` (~49) | pending tool results that reject → `results: []` | the rejection is returned: the waiting stage fails with `PIPELINE_ERROR` naming the tool calls | pipelines |
| — | `pipeline/context/tool-loop-context/window-context-strategy.ts` (~51), `legacy-accumulate-context-strategy.ts` (~31) | a saved state of another version, or malformed, is silently replaced by `[]` | `restore` throws `OrchestratorError(…, 'STATE_CORRUPT')`, the stage fails with it | pipelines |

#### 10.5.3 MCP — client, adapter, registry, tool selection (D74)

| # | Where | Today | Now | Layer |
|---|---|---|---|---|
| M1 | `llm-agent-mcp/src/client.ts` (~426) | `listTools` fails, one reconnect fails → the cached tools (stale, or `[]`) | throws `toMcpError(err)`; the adapter's catch turns it into `{ ok: false, error: McpError }` with its existing code | framework (mcp) |
| M2 | `llm-agent-mcp/src/adapter.ts` (~32) | a tools cache answers `ok: true` after the server went down | the cache answers only while the last health result was good; after a failed probe or call, `listTools` asks the server (and fails with `MCP_NOT_CONNECTED` when it is down) | framework (mcp) |
| M3 | `llm-agent-mcp/src/strategies/lazy-connection-strategy.ts` (~135) | a slot that failed to connect is left out of `resolve()` (a warning only); the caller gets fewer clients | unchanged in the strategy (it already returns `configuredSlotCount`, so the gap is visible — no contract change); `McpToolRegistry.resolve` (M4) treats fewer resolved clients than `configuredSlotCount` as `MCP_UNAVAILABLE` naming the missing slots | framework (mcp) + pipelines |
| M3b | same (~160) | `healthCheck` `{ ok: true, value: false }` counted healthy | `result.ok && result.value` | framework (mcp) |
| M4 | libs `mcp/tool-registry.ts` (~117) | one client's `listTools` fails or throws → dropped, no log | `resolve` rejects with `OrchestratorError(…, 'MCP_UNAVAILABLE')` naming the client and carrying the `McpError` code in its message (a throw, so its signature does not change; the stage's executor keeps a thrown `OrchestratorError` as it is, D70) | pipelines |
| M5 | libs `pipeline/handlers/tool-select.ts` (~40) | same as M4 | stage fails with `MCP_UNAVAILABLE` | pipelines |
| M6 | libs `pipeline/handlers/tool-loop.ts` (~229, N10) | a per-iteration re-list failure → that client's tools vanish mid-run | stage fails with `MCP_UNAVAILABLE` (the tool set is never shrunk by a failure) | pipelines |
| M7 | libs `pipeline/handlers/tool-select.ts` (~91) | a discovery store query fails → dropped; smart mode then selects zero tools and answers LLM-only | stage fails with the store's code (e.g. `CIRCUIT_OPEN`); zero tools stays possible only after a **successful** query with no match (an honest empty answer) | pipelines |
| M8 | libs `pipeline/handlers/tool-loop.ts` (~352), `agent.ts` (~966) | a tools re-select query fails → the previous set kept, unlogged | stage fails with the store's code | pipelines |
| M9 | server-libs `smart-agent/tools-rag-handle.ts` (~40, ~64) | a client failing `listTools` left out of the catalog, which is then cached for ever; a failed query **or zero hits** → the first N catalog tools | a client failure → `query` returns `McpError` (nothing cached); a failed query → its `RagError`; zero hits → `[]` (an honest empty answer, never an unranked prefix) | server (handle stays in server-libs, §11.2 item 2) |
| M10 | server-libs `smart-server.ts` bridge (~740) | a `listTools` error the classifier calls a tool error → silently the next client | any `listTools` failure throws its `McpError` (a `callTool` tool error stays a tool result, as today) | server |
| M11 | server-libs `smart-server.ts` `resolveAuthoritativeSnapshot` (~2573) | failing clients dropped (logged), the partial snapshot memoized | a failing client fails the snapshot with its `McpError`; nothing is memoized | server |
| M12 | libs `builder.ts` (~1182) / `mcp/vectorize-mcp-tools.ts` (~198) | a client failing `listTools` at startup → counted, build continues | unchanged by decision: a store is filled once at creation and an incomplete fill is reported and stays (goal, D41); what changes is that it is **reported loudly** — `complete: false` makes `/health` answer 503 (D72), and every request whose tool selection needs that client fails with `MCP_UNAVAILABLE` (M4–M6) | framework (libs) |

#### 10.5.4 RAG and embedder — incl. `FallbackQueryEmbedding` (D73, D74)

| # | Where | Today | Now | Layer |
|---|---|---|---|---|
| R1 | `llm-agent/src/rag/query-embedding.ts` (~62) `FallbackQueryEmbedding`, used by `VectorRag`, `QdrantRag`, `PgVectorRag`, `HanaVectorRag` | **any** failure of the caller's query embedding (a broken pipeline embedder, an open breaker) → re-embedded with the store's embedder, the error discarded | **D73:** the store's embedder is used **only** when the caller's embedding carries no vector by design (`TextOnlyEmbedding` — no pipeline embedder configured, an absent capability); any other failure propagates (the store returns it as `QUERY_ERROR` / its own code). Recognised by type (`instanceof TextOnlyEmbedding`), never by message. The class keeps its name and constructor | framework (store kit in `llm-agent`) |
| R2 | `llm-agent-rag/src/vector-rag.ts` (~181, ~220), `in-memory-rag.ts` (~103, ~180) | an enricher / preprocessor `ok: false` ignored, raw text used | the store returns that `RagError` (upsert / query fails) | framework (rag) |
| R3 | `llm-agent-rag/src/preprocessor.ts` `TranslatePreprocessor`, `ExpandPreprocessor`, `IntentEnricher` (~96, ~153, ~227) | an LLM failure, empty content or a throw → `ok: true` with the original text | `ok: false`, `RagError(message, 'QUERY_EXPAND_ERROR')` — the code `QueryExpander` already uses for the same failure (the `TranslatePreprocessor` early `ok: true` for text needing no translation stays: not a failure) | framework (rag) |
| R4 | libs `pipeline/handlers/rag-query.ts` (~35) | a stage names a store the registry does not hold → `return true // non-fatal, skip` | stage fails with `RAG_STORE_MISSING` naming the store | pipelines |
| R5 | `rag-query.ts` (~115) | a store's query `ok: false` → no entry, request continues (the D68 continuation, §10.4) | stage fails with the store's code (`CIRCUIT_OPEN`, `QUERY_ERROR`, …) naming the store | pipelines |
| R6 | libs `agent/rag-orchestrator.ts` (~150) (the non-pipeline path) | `r.ok ? r.value : []` | `orchestrate` returns the error (`OrchestratorError` with the store's code) — it already returns a `Result` | pipelines |
| R7 | libs `builder.ts` (~830) sub-agent retrieval source | a failed query → `[]` | the source throws the `RagError`; the sub-agent context build fails with it | pipelines |
| R8 | libs `subagent/default-context-builder.ts` (~69, ~88) | project / tool source throws → silently left out | the context build fails with that error (`COORDINATOR_STEP_FAILED` at the caller) | pipelines |
| R9 | libs `rag/knowledge-rag.ts` (~248) | the semantic index upsert fails → the entry stays unindexed for the life of the process, debug log only | `put` rejects with `RagError(…, 'UPSERT_ERROR')` after the entry is written (the caller sees that the write is not searchable) | framework (libs) |
| R10 | server-libs `jsonl-knowledge-backend.ts` (~72, ~108) | an embedding failure skips the entry (log only under `DEBUG_CONTROLLER`) | `build()` / `put()` reject with `UPSERT_ERROR`; nothing is marked built | server |
| R11 | `qdrant-rag/src/qdrant-rag.ts` (~141) | reading the collection info fails → the dimension check is skipped and the collection is marked ensured for good | the read error is returned (`UPSERT_ERROR`); `collectionEnsured` is set only after a successful check; a missing / non-numeric `vectors.size` is an error too | framework (provider) |
| R12 | `sap-aicore-embedder/src/foundation-embedder.ts` (~81, ~125, ~146) | a short batch returned short; a prediction without values → `[]` vector; missing `data` → `[]`; HTTP errors with the generic code | `RagError(…, 'EMBED_ERROR')` for a batch whose count differs from the texts, an empty vector, a missing `data`, and the HTTP failures (the code `openai-embedder` and `ollama-embedder` already use) | framework (provider) |
| R13 | the `TextOnlyEmbedding` sites (`rag-query`, `tool-select`, `skill-select`, `tool-loop`, `agent.ts`, `rag-orchestrator`) | — | **kept**: no pipeline embedder is an absent capability; the store embeds (R1). Not a failure | — |
| R14 | libs `mcp/vectorize-mcp-tools.ts` (~310–336), the **30.1.0** path (an unbound tools store) — added by D79 | a failed `upsertManyPrecomputedRaw` (`ok: false` or a throw) → the same records written again tool by tool; a store that refused the batch is asked again through another write path, and the bulk failure leaves no trace when the per-tool writes succeed | the batch fails: **no per-tool write**; every tool of the batch is in `failed`, `vectorized` excludes them, `complete: false` with `writeFailure: 'bulk write failed: <error>'` (§3.8), and the summary log line names the reason — `/health` answers 503 (D72). The per-tool write stays only where no bulk write is made (no `upsertManyPrecomputedRaw`, or no precomputed vectors — the store embeds). U7's batch → per-tool **embedding** retry is unchanged (counted, `batchFailures`). The rule of D76 (§3.3), on the path D76 did not cover | framework (libs) |

#### 10.5.5 Reranker — incl. `onFailure` (D71)

| # | Where | Today | Now | Layer |
|---|---|---|---|---|
| K1 | **this spec's** `StagedRetrieval` `rerank.onFailure: 'stage1'` (default), the YAML `onFailure` key, `mcpToolsVariants.facetedRerank`'s `onFailure` | a failed rerank returns the stage-1 order and scores, counted `rerank_fallback` | **removed.** `rerank` has no `onFailure`: a failed rerank (an `ok: false`, a throw, a failed output check, §4.8) returns `RagError(…, 'RERANK_ERROR')`, counted `rerank_error`, on the span, as the session step `retrieval_rerank_error`. There is one behaviour, so the `ScoreFloorCut` + `stage1` rejection and the "two scales in one run" rule (§4.6, D67) disappear: a run's scores are always one scale | framework (libs) |
| K2 | libs `retrieval/reranked-retrieval.ts` `RerankedRetrieval`, `RerankAllRetrieval` (30.1.0) | a failed rerank → logged, `ok: true` in embedding order | returns the `RERANK_ERROR` (the session step stays). **Supersedes S4's "no behaviour change" for the failure path** — the goal's decision names the reranker explicitly; S4's other half (no §4.8 output check on these strategies) is unchanged | framework (libs) |
| K3 | libs `pipeline/handlers/rerank.ts` (~39) | a failed rerank → original order (logged) | stage fails with `RERANK_ERROR` | pipelines |
| K4 | libs `agent/rag-orchestrator.ts` (~171) | `rr.ok ? rr.value : results`, unlogged | `orchestrate` returns the error | pipelines |

#### 10.5.6 LLM handlers and providers (D74)

| # | Where | Today | Now | Layer |
|---|---|---|---|---|
| L1 | libs `pipeline/handlers/translate.ts` (~54) | the LLM fails → untranslated text, unlogged | stage fails with `LLM_ERROR` (the `LlmError`'s code) | pipelines |
| L2 | `pipeline/handlers/expand.ts` (~26), `agent/rag-orchestrator.ts` (~115) | the expander fails → the original query | stage / `orchestrate` fails with the expander's code (`QUERY_EXPAND_ERROR`) | pipelines |
| L3 | `pipeline/handlers/summarize.ts` (~65), `agent/rag-orchestrator.ts` (~69, ~447) | the summarizer fails → full history | stage / `orchestrate` fails with `LLM_ERROR` | pipelines |
| L4 | `pipeline/handlers/history-upsert.ts` (~39, ~48, ~120) | the summarizer fails → a raw `user → assistant` line stored; an upsert failure → logged, `return true` | stage fails with the summarizer's / the store's code; nothing raw is stored as if summarized | pipelines |
| L5 | `sap-aicore-llm/src/sap-core-ai-provider.ts` (~529) | the model catalog unreachable → `[{ id: <configured model> }]` | `getModels` returns `LlmError(…, 'LLM_ERROR')` | framework (provider) |
| L6 | `openai-llm/src/openai-provider.ts` (~307), `anthropic-llm/src/anthropic-provider.ts` (~333) | a whole `data:` line that is not JSON is dropped; the stream ends "successfully", truncated | the stream yields `LlmError(…, 'LLM_ERROR')` naming the line's first 200 characters (lines are already split on `\n`, so a partial chunk never reaches the parser) | framework (provider) |
| L7 | server-libs `http/models-route-handler.ts` (~17, ~48) | `getModels` / `getEmbeddingModels` `ok: false` → 200 with a placeholder / `[]` | 502 `jsonError(message, 'api_error', <code>)` | server |

#### 10.5.7 Coordinator and stepper (D74)

All carry the existing coordinator codes through the handlers that already wrap planner and step
failures (`coordinator.ts`, `dag-coordinator.ts`).

| # | Where (libs `coordinator/`) | Today | Now |
|---|---|---|---|
| C1 | `stepper/stepper-interpreter.ts` (~194) | `knowledgeRag.list` throws → the dependency's context skipped; the dependent step runs without its prerequisites | the step fails, `COORDINATOR_STEP_FAILED` |
| C2 | `stepper/llm-stepper-planner.ts` (~77, ~96) | `toolsRag.query` / `listArtifacts` throws → that prompt section omitted | the plan fails, `COORDINATOR_PLAN_FAILED` |
| C3 | `stepper/llm-evaluator.ts` (~63) | `toolsRag.query` throws → omitted | the step fails, `COORDINATOR_STEP_FAILED` |
| C4 | `stepper/cyclic-react-executor.ts` (~131) | `knowledgeRag.query` throws → no facts prefix | the step fails, `COORDINATOR_STEP_FAILED` |
| C5 | `stepper/cyclic-react-executor.ts` (~342) | the artifact store throws → a live re-fetch instead | the step fails, `COORDINATOR_STEP_FAILED` — a configured store that does not work is a failure, and a re-fetch hides it (it also repeats a call the dedup exists to avoid) |
| C6 | `stepper/need-resolver.ts` (~43, ~49) | the classifier LLM fails, or answers malformed JSON → "no need" | the step fails, `COORDINATOR_STEP_FAILED`, with the `LlmError` / `ClassifierError` in its message |
| C7 | `stepper/llm-task-formalizer.ts` (~37) | an LLM error, a throw or unparseable output → a raw-prompt spec | the plan fails, `COORDINATOR_PLAN_FAILED` |
| C8 | `dag/llm-dag-planner.ts` (~108, ~242; #171) | no nodes → a one-node plan from the raw prompt (the throw branch is unreachable: the prompt is always passed as the fallback goal) | no fallback goal: no nodes → `COORDINATOR_PLAN_INVALID` |

Layer: framework (libs), coordinator.

#### 10.5.8 Skills (D74)

| # | Where (libs unless named) | Today | Now |
|---|---|---|---|
| S-1 | `pipeline/handlers/skill-select.ts` (~51, ~70; N11) | a store query fails → dropped; `listSkills` fails → `skill_select_error`, continue without skills | stage fails with the store's code / `SKILL_ERROR` |
| S-2 | `agent/rag-orchestrator.ts` (~262, ~297) | the skill query and `listSkills` failures dropped; a failing `getContent` skipped | `orchestrate` returns the error |
| S-3 | `skills/skill-utils.ts` (~27) | **any** `readdir` error skips the directory | only `ENOENT` skips (a default search path that does not exist is absent by design); any other error → `SkillError` naming the directory |
| S-4 | `skills/filesystem-skill.ts` (~98) | a `SKILL.md` that cannot be read or parsed → the skill silently left out | no `SKILL.md` → not a skill (unchanged); a read or frontmatter error → `listSkills` returns `SkillError` naming the file |
| S-5 | `mcp/vectorize-mcp-tools.ts` `vectorizeSkills` (~443; N20) | `listSkills` fails → silent return; a skill whose embedding or write fails (`ok: false` or a throw) → a warning, the skill left out of the store, `vectorizeSkills` resolves | `listSkills` failing → the error is thrown; a skill whose embedding or write fails → `vectorizeSkills` rejects with a `SkillError` naming the skill (`skill:<name>`) and carrying the underlying error (its message in the text, the error as `cause`) — at the first failing skill, no skill after it is attempted (D75). It propagates unchanged: `build()` rejects with it; the server's fill paths reject with it — the startup build of the main store, a worker's construction, and the deferred shared-worker pass through `fillToolsBinding`'s `skills` (D66) — so `start()` (or the worker's construction, which then drops its cache entry, D47) fails. A writerless store stays skipped, as today: absent by design |
| S-6 | `builder.ts` (~1335; N21) | the plugin loader's `errors` never checked | `build()` fails listing every `{ file, error }` (the server's own `plugin_errors` log stays) |
| S-7 | `skills/plugin-host/compatible-skills-rag.ts` (~89, ~110) | an incompatible generation, or an abort / timeout → `[]` | an incompatible generation throws `SkillsIncompatibleError` (as the eager path already does); an abort rethrows (the caller's cancellation, not an empty answer) |
| S-8 | `skills/plugin-host/skill-plugin-host.ts` (~339; N17) | a group's build fails → the prior generation kept, `ok: true` when a prior exists | `ok: false`, the group in `omitted` with its reason; whether the prior generation keeps serving is the consumer's `strict` choice — `strict: true` by default (U2, §10.5.12) |
| S-9 | `skill-plugin-host.ts` (~236; N16) | a failed `acquire` carries the source's prior data forward under `strict: false` (the default), the reason discarded | the reason is kept and reported (`SkillLoadResult.carried: { sourceId, reason }[]`, additive); carrying forward at all is the consumer's opt-in — the default becomes `strict: true` (U2, §10.5.12) |
| S-10 | server-libs `smart-server.ts` (~496) + `config.ts` (~280) | an unknown `skills.type` → no skill manager | `ConfigValidationError` at start (`skills.type: must be claude \| codex \| filesystem`) |

Layer: framework (libs) for S-1–S-9, server for S-10.

#### 10.5.9 Server (D74)

| # | Where (server-libs `smart-agent/` unless named) | Today | Now |
|---|---|---|---|
| V1 | `session-lifecycle/session-rag-registry.ts` (~90; N22) | a persisted collection that fails to describe / open / adopt → the session starts without it | the session's creation fails with the `RagError` (`CollectionNotFoundError`, `ProviderNotFoundError`, …) naming the collection |
| V2 | `controller/session-bundle.ts` (~57; N23) | a malformed bundle → an older or empty bundle | `STATE_CORRUPT` naming the session |
| V3 | `controller/run-scope.ts` (~79; N24) | a malformed terminal entry skipped | `STATE_CORRUPT`; (`gcTerminal`'s catch at ~101 is cleanup — kept) |
| V4 | `controller/artifacts.ts` (~261) | a claim without a numeric `writeOrdinal` silently dropped | `STATE_CORRUPT` naming the claim |
| V5 | `smart-server.ts` (~3112; N25) | session metadata `recordSessionStart` / `recordSessionEnd` throws → swallowed | `recordSessionStart` failing fails the request (500 `jsonError`); `recordSessionEnd` is end-of-request cleanup — kept, but logged (`session_meta_end_failed`) |
| V6 | `config-reload-watcher.ts` (~132; N26) | a drain / invalidate rejection logged, the reload counted applied; every value coerced by `ConfigWatcher` (`Number()`, `Boolean()`), so an invalid one applies (`agent.maxIterations: oops` → `NaN`, the iteration limit gone); a file the watcher cannot read or parse (`ConfigWatcher`'s `error`) only logged as `config_reload_error` — the server stays ready on the previous config | **the reload reports failure and the server is not ready until a whole config applies; nothing is restored (D82 — D77's rejection and event boundary kept, its restore withdrawn).** The reload entry point (`_onReload`) runs one transaction in the server's config queue (D80): the agent update and the server's mirror (`cfg.agent`, `cfg.prompts`) as today, then the worker drain and the session invalidation (both run and settle, one verdict), then — only when both succeeded — the RAG weights and `config_reload_applied`. When anything in it fails (the drain, the invalidation, or any other throw in the transaction) it **rejects** with an error naming each failure (`config reload failed, the server is not ready until a whole config applies — worker drain: …; session invalidation: …`). What the transaction applied stays applied (the agent config, the mirror); the RAG weights are not applied; the queue records the server's *config not applied* state with that message (§10.5.10). The file watcher's `reload` listener (an event emitter cannot await) is the one boundary that handles the rejection: it logs `config_reload_failed` with the error through the server's log sink; `config_reload_applied` is logged only on success; no later code path catches the rejection and resolves. **Reloads are serialized (D80):** each transaction starts only after the previous one (a reload or a `PUT`) settled; a failed one rejects its own caller, is reported on its own (`config_reload_failed`, one per failed reload) and never blocks the reloads queued after it. `ConfigWatcher` debounces file events but cannot await its listeners, so the emitter cannot order them. The queue is the **server's** (`ConfigTransactionQueue`, injected as `ConfigReloadDeps.transactions`, D80 extended by the user): `PUT /v1/config` runs its transactions in the same queue (V10), so a reload and a `PUT` never overlap. `ConfigWatcher` emits every hot-reloadable field of the file, so the next reload that applies brings the whole file's config back. **The file is read as the start reads it (D83 (8)):** `ConfigReloadWatcher` builds its `ConfigWatcher` with `resolveDocument: (doc) => resolveEnvVars(doc, env)` — the start's own substitution (server-libs `yaml-loader.ts`, the function `loadYamlConfig` applies) over the whole parsed file, before the watcher reads a field, with the process environment the start read (`ConfigReloadDeps.env`, default `process.env`, as `loadYamlConfig`'s); so `${VAR}` and `${VAR:-default}` resolve on a reload exactly as at start (*The start config* below). **Every value is validated before anything applies (D83):** the transaction's first step runs the server's config field validator (*Config field rules* below) over the values as the resolved file holds them (`HotReloadableInput`, not coerced); an invalid one fails the transaction before the agent update — nothing is applied (no agent update, no mirror, no drain, no weights), it rejects with `config reload failed, the server is not ready until a whole config applies — invalid config — <every invalid field, its rule and the value>`, the queue sets the *config not applied* state with that reason (or keeps it set, with this reason, when the server was already not ready) and the event boundary logs `config_reload_failed` **A file the watcher cannot read, parse or resolve is a failed reload (D82 (9)):** `ConfigWatcher` emits `error` instead of `reload` (the file missing or unreadable, not valid YAML, or `resolveDocument` throwing); `ConfigReloadWatcher`'s `error` listener queues it in the same queue as a reload transaction — `run('reload', 'full', …)`, a whole config's scope like any reload — whose body rejects with `config reload failed, the server is not ready until a whole config applies — cannot read the config file: <the error>`. Nothing is applied (no agent update, no mirror, no drain, no weights); the queue sets the *config not applied* state with that reason (or keeps it set, with this reason) **in queue order** — after a `PUT` or reload already queued, before one queued after it, so a partial `PUT` queued behind it is refused (409, D82 (8)); the listener is the same event boundary and logs `config_reload_failed` (`config_reload_error` is gone). The next whole config that applies clears it: the repaired file saved (a reload) or a whole `PUT` — the way back after the file was deleted, since a recreated file is not watched again (the watcher watches the file it started on, as in 30.1.0) |
| V7 | `tools-rag-handle.ts` (~90; N28) | the eager catalog load fails → logged, startup continues | the start fails with the `McpError` |
| V8 | `llm-agent-server/src/smart-agent/cli.ts` (~146; N30) | an explicit `--env` file or `--secrets-dir` that cannot be read → a warning, startup continues | exit code 1 with the path and the reason (a missing implicit `.env` stays ignored: absent by design) |
| V9 | `build-stepper-root.ts` (~97, ~234; N31) | a role with no resolvable LLM config → a stub OpenAI model | `ConfigValidationError` naming the role |
| V10 | `http/config-route-handler.ts` (`handleConfigUpdate`; D80 extended and D82, decided by the user on 2026-10-06) | `PUT /v1/config`: field values not checked — any JSON value of a whitelisted field applies (`"maxIterations": "oops"` disables the limit, a model name `""` is skipped); a failed session invalidation swallowed (200 with the new config); a failed worker drain (or a throwing `reconfigure`) escapes to the server's catch-all 500 with the new config left applied and the server reported ready; a `PUT` and a file reload (or two `PUT`s) overlap | **a failed `PUT` answers 500 and leaves the server not ready until a whole config applies; no rollback (D82).** Validation stays before the queue (JSON, the whitelist, **the field values — the same validator and rules as the file reload (D83): every `agent` field and every `models` name, checked after the whitelist and before any model is resolved; an invalid one → 400 `invalid_request_error` naming every invalid field (`invalid config — agent.maxIterations must be a finite number, got "oops"`), nothing resolved, applied or queued, the state unchanged; the validated values are what the transaction applies**, model resolution and the model probe apply nothing, so a slow probe never holds a reload; a 400 changes no state). **While the server is not ready, only a whole config is accepted (D82 (8), decided by the user on 2026-10-06):** a whole config carries every top-level section the route can change on this server — `agent` always, `models` when the server has a model resolver (without one the route answers 400 to `models`, so `agent` alone is whole) — each a non-empty object; a section that is absent or `{}` is missing. Right after the body is read as a JSON object, a `PUT` that misses a section while the queue holds the *config not applied* state is refused: **409** `jsonError('server not ready — send the whole config: <missing sections, comma-separated>', 'invalid_request_error', 'config_not_applied')` — the request conflicts with the server's state, it is not malformed — with nothing resolved, probed, applied or queued and the state unchanged. The queue checks the same again when the transaction starts (`ConfigTransactionQueue.run` takes the change's scope — `'full'` for a reload and a whole `PUT`, `'partial'` otherwise — and refuses a `'partial'` one while the state is set, without running it): a `PUT` that passed the first check while the server was ready can find the state set by a transaction ahead of it; it is then refused the same way (409, `tx` never runs, the state unchanged). While the server is ready, a partial `PUT` works as before. A `PUT` that names neither `models` nor `agent` on a ready server changes nothing: it answers 200 with the live config, outside the queue. Otherwise the `PUT` is one transaction in the server's config queue (`IConfigUpdateTarget.transactions` — the same `ConfigTransactionQueue` the reload watcher uses, V6), in 30.1.0's order: the new role LLMs held through the setters, the startup agent updated (`reconfigure` with the held instances — unchanged from 30.1.0, D81 withdrawn — then `applyConfigUpdate`), the server's mirror (`mirrorAgentCfg`), then the worker drain and then the session invalidation (both run, one verdict). When any step fails — the apply (a setter, `reconfigure`, `applyConfigUpdate` or `mirrorAgentCfg` throws: `apply: <error>`; the drain and the invalidation are then not run), the drain (`worker drain: …`) or the invalidation (`session invalidation: …`) — the transaction **rejects**, the queue records the *config not applied* state with the error (§10.5.10), and the route answers **500** `jsonError('config update failed, the server is not ready until a whole config applies — <failures>', 'server_error')` — the status and type of the route's own server-side failure (a model resolver error) and of the server's catch-all. Nothing is restored: what the transaction applied stays (the held LLMs and their breakers, the startup agent, `cfg.agent`). On success it answers 200 with the config read inside the transaction, and the state is cleared |

**Config field rules (D83).** One validator — server-libs `smart-agent/config-fields.ts`
(internal) — checks every field a running server changes, for all three inputs: the start config
(D83 (5), below), the file reload (V6, every field `ConfigWatcher` reads) and `PUT /v1/config`
(V10, its whitelist) — and, at start, every other field the start reads (*Start-only fields*
below, D83 (7); *Cast-read fields* below, D83 (9)). No value is coerced; one grammar holds for every input (D83 (6), decided by the
user on 2026-10-06):

- **A number** is a JSON / YAML number, or a string that is exactly a **number literal** —
  JSON's number grammar over the whole string,
  `^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$` (`NUMBER_LITERAL`): an optional `-`, an
  integer part without leading zeros, an optional fraction, an optional exponent. `"25"`, `"-1"`,
  `"0.5"`, `"1e3"` are numbers; `" 25"`, `"25 "`, `"25abc"`, `""`, `"+5"`, `"025"`, `".5"`,
  `"5."`, `"0x19"`, `"1_000"`, `"NaN"`, `"Infinity"` are not. The `-` is part of the grammar for
  every field and the field's range refuses a negative where it has no room for one (`"-1"` for
  `agent.maxToolCalls` → `must be >= 0, got "-1"`). A literal whose value is not finite
  (`"1e999"`) fails `must be a finite number`. The parsed number then goes through the field's
  rule (integer, range); the validated value is the number, never the string. Why this grammar:
  it is what `JSON.parse` accepts and how a YAML 1.2 plain scalar writes a number; no leading
  zeros (YAML 1.1 reads `025` as octal 21), no `+`, no `.5` — forms nobody needs in an
  environment variable and that read differently in different parsers.
- **A flag** is `true` / `false`, or exactly the string `"true"` / `"false"` (lowercase);
  `"yes"`, `"True"`, `"1"`, `1`, `null` are not.
- **A string** field takes a string only (a YAML number is not a string — quote it); a *non-empty
  string* is one with a non-blank character; a *one of* field takes exactly one of the listed
  names.
- **A shape** (D83 (9)): a *mapping* is a YAML mapping / JSON object (not a list, not `null`); a
  *list of X* is a YAML sequence each of whose items is an X, named by its index
  (`agent.retry.retryOn[1]`); a *map of K → V* is a mapping each of whose keys is a K and each
  of whose values a V, named by its key (`mcp.headers.Authorization`,
  `mcp.toolTimeouts.GetTable`). A mapping marked *closed* refuses a key it does not list
  (`<field>.<key> is not a known key, got <value>`): those are the mappings the consumer reads
  key by key, where a misspelled key (`retryon`, `toolTimeout`) would be read by nobody while
  the default applies in silence.

Every invalid field is
named in one error, `<field> <rule>, got <value>`, with the field as the input spells it
(`agent.maxIterations`, `rag.store.vectorWeight`, `models.mainModel`) and the value as the input
holds it (`got "oops"`, `got " 25"`). Each range is what the
code that reads the field can work with:

| Field | Rule | Why |
|---|---|---|
| `agent.maxIterations` (reload, `PUT`) | integer ≥ 1 | the loop ends when `iteration >= maxIterations`; 0 answers nothing, `NaN` never ends it |
| `agent.maxToolCalls` (reload, `PUT`) | integer ≥ 0 | a budget of tool calls (`remaining = maxToolCalls - toolCallCount`); 0 = no tool call |
| `agent.ragQueryK` (reload, `PUT`) | integer ≥ 1 | how many results a retrieval asks for |
| `agent.toolUnavailableTtlMs` (start; reload and `PUT` until U8 removes it from both — it is then read at start only) | finite number ≥ 0 | a duration in ms |
| `agent.historyAutoSummarizeLimit` (reload, `PUT`) | integer ≥ 0 | a history longer than this is summarized; 0 = always |
| `agent.toolResultCacheTtlMs` (reload) | finite number ≥ 0 | a duration in ms; 0 disables |
| `agent.sessionTokenBudget` (reload) | integer ≥ 0 | a token count; 0 disables |
| `agent.showReasoning`, `agent.classificationEnabled` (reload, `PUT`), `agent.queryExpansionEnabled` (reload) | boolean | a switch |
| `rag.store.vectorWeight`, `rag.store.keywordWeight` (reload, in-memory store only) | finite number in [0, 1] | `WeightedFusionStrategy` adds `cosine · vectorWeight` and the normalized BM25 · `keywordWeight`, both parts in [0, 1] |
| `prompts` (reload) | a mapping; each of `system`, `classifier`, `reasoning`, `ragTranslate`, `historySummary` present → non-empty string | a prompt is text the model gets; other keys are not read |
| `circuitBreaker` (reload) | a mapping; `failureThreshold` integer ≥ 1, `recoveryWindowMs` finite number ≥ 0 | a count of failures; a duration in ms |
| `logDir` (reload) | non-empty string | a directory path |
| `models.mainModel`, `models.classifierModel`, `models.helperModel` (`PUT`) | non-empty string | a model name for the resolver |

A field the reload reads but does not apply (`queryExpansionEnabled`, `toolResultCacheTtlMs`,
`sessionTokenBudget`, `circuitBreaker`, `logDir`, three of the prompts) is validated too: the file
is the whole config, and an invalid value in it is an error wherever it is. A `prompts:` or
`circuitBreaker:` key with no value has no entries and is absent, as in 30.1.0; a field with no
value (`maxIterations:`) is `null` and fails its rule. The rules live with the
server because both inputs are the server's (its YAML file and its HTTP body) and only the server
composes all these fields (the agent's loop, the store's weights, its own prompts, breaker, log
directory and model resolver); `SmartAgent` receives typed values from its composition root and
parses no config. Every caller is a server-libs module and the validator imports only libs'
types, so no cycle is possible.

**Start-only fields (D83 (7), decided by the user on 2026-10-06).** Every other config field the
start reads with `Number()` / `Boolean()` / `String()` (30.1.0) is checked by the same validator
(the same grammar, `FieldCheck` and error) where its section is read; nothing reloads or `PUT`s
them. A field with no value (`timeout:`) is `null` and fails its rule, as above; an absent field
keeps its 30.1.0 default.

| Field | Rule | Why |
|---|---|---|
| `port` (`args.port`, else the YAML's `port`, else `env.PORT` — the one used is checked and named so: `args.port`, `port`, `env.PORT`) | integer in [0, 65535] | a TCP port; 0 lets the OS pick one |
| `agent.contextBudgetTokens` | integer ≥ 0 | a token budget for the RAG context; 0 = no limit |
| `agent.historyRecencyWindow` | integer ≥ 1 | the last N client messages kept; 0 would `slice(-0)` — keep every message |
| `agent.heartbeatIntervalMs` | integer in [0, 2147483647] | a timer delay in ms; 0 disables the keep-alive (documented); Node clamps a delay above 2³¹−1 to 1 ms. An invalid value disabled it with a console warning — it now fails |
| `agent.healthTimeoutMs` | integer in [1, 2147483647] | a probe's timer delay in ms |
| `agent.semanticHistoryEnabled`, `agent.toolReselectPerIteration`, `agent.ragTranslateEnabled`, `agent.refreshToolsPerIteration`, `agent.mcpSharedClient` | flag | a switch |
| `agent.historyTurnSummaryPrompt` | non-empty string | a prompt |
| `agent.streamMode` | one of `full`, `final` | the names the tool loop knows |
| `agent.llmCallStrategy` | one of `streaming`, `non-streaming`, `fallback` | the names the server maps to a strategy |
| `llm.temperature`, `llm.classifierTemperature`, and each `llm.<role>.temperature` / `.classifierTemperature` of the map | finite number ≥ 0 | a sampling temperature; the upper bound is the provider's |
| `llm.maxTokens`, `llm.<role>.maxTokens` | integer ≥ 1 | a token cap |
| `llm.whenThrottled.maxAttempts`, `llm.<role>.whenThrottled.maxAttempts` | integer ≥ 1 | attempts include the first |
| `llm.resourceGroup`, `llm.<role>.resourceGroup` | non-empty string | an SAP AI Core resource group |
| `rag.store.collectionName`, `.connectionString`, `.host`, `.schema`, `.database`, `.url` | non-empty string | a name or an address |
| `rag.store.port` | integer in [1, 65535] | a TCP port |
| `rag.store.poolMax` | integer ≥ 1 | a pool size |
| `rag.store.connectTimeout` | integer ≥ 0 | ms; 0 = the driver's "no timeout" (pg `connectionTimeoutMillis`, HANA `communicationTimeout`) |
| `rag.store.dimension` | integer ≥ 1 | a vector size |
| `rag.store.autoCreateSchema` | flag | a switch (30.1.0: anything but `true` / `"true"` read as `false`) |
| `rag.store.timeoutMs` (qdrant) | integer in [1, 2147483647] | a request timeout in ms |
| `rag.store.dedupThreshold` (in-memory) | finite number in [0, 1] | a cosine-similarity threshold |
| `rag.embedder.provider`, `.factory`, `.model`, `.url`, `.resourceGroup` | non-empty string | a name or an address (`checkRag` still checks which names exist) |
| `rag.embedder.scenario` | one of `orchestration`, `foundation-models` | SAP AI Core's two scenarios |
| `rag.embedder.maxBatchSize` | integer ≥ 1 | a batch size |
| `rag.embedder.asymmetric` | flag | a switch (`checkRag` keeps its provider rule) |
| `mcp.timeout` and each `mcp[i].timeout` | integer in [1, 2147483647] | a request timeout in ms |
| `mcp.args` (single server; `args.mcp-args` when set) | non-empty string | split on spaces into the command's arguments (30.1.0: a YAML list became `"a,b"`) |
| `decision.model`, `decision.baseUrl` | non-empty string | as `checkDecision` already required |
| `decision.deploymentId`, `decision.resourceGroup` (`provider: sap-aicore`, §6.2) | non-empty string | names (`String()` in the first draft of this change) |
| `decision.timeoutMs`; `rag.retrieval.<store>.overfetch`, `.maxCandidates` | integer ≥ 1 | unchanged rules; the string form now follows `NUMBER_LITERAL` (30.1.0's `parseIntegerField` also took surrounding spaces) |
| `decision.maxRetries` | integer ≥ 0 | unchanged rule, the same grammar |
| `skillPlugins.k`, `.maxInjectChars`, `.catalogCasMaxAttempts`, `.orphanGraceMs`, `.recallTimeoutMs`, `.dimension`, `.chunk.maxChars` | integer ≥ 1 | counts, sizes and durations (their 30.1.0 rules; `Number()` let `" 4"` and `"0x4"` through) |
| `skillPlugins.retiredGraceMs` | integer ≥ 1000 | its 30.1.0 rule |
| `skillPlugins.threshold` | finite number in [0, 1] | a similarity threshold |
| `skillPlugins.loadOnStartup`, `skillPlugins.strict` | flag | a switch (30.1.0: `Boolean("false")` is `true`) |
| `skillPlugins.embedder.provider`, `.model` | non-empty string | a name |
| `stepper.maxParallelSteps` (the stepper / controller pipeline's `pipeline.config`) | integer ≥ 1 | a pool size |
| `stepper.maxDepth` | integer ≥ 0 | a recursion depth; 0 = no recursion |
| `stepper.tokenBudget` | integer ≥ 1 | a token ledger's budget |
| `rag.profiles.<key>` integers (`poolItems`, `maxItems`, `items`, `maxValues`, `fixed-items`, `minItems`, `budgetTokens`) and `score-floor.minScore` (§6.2) | their §6.2 rules | the same grammar: an integer field through `parseIntegerField`, `minScore` a finite number, normalized to a number before the resolver reads it |

Where a section has its own parser, that parser applies the rules with its own `FieldCheck` and
throws its own `ConfigFieldError`: `skillPlugins` (`parseSkillPluginsConfig`, named
`skillPlugins.<field>`) and the stepper's section (`parseStepperCoordinatorConfig`, public,
named `stepper.<field>` — the key inside the pipeline's `config`; it runs when the server builds
the pipeline at start). The integer fields `config-validator.ts` checks (`decision`,
`rag.retrieval`, `rag.profiles`) keep their `ConfigValidationError` and messages; their string
form goes through the same `NUMBER_LITERAL` (`parseIntegerField` uses it). The fields read by a
cast are validated too — *Cast-read fields* below (D83 (9)).

**Cast-read fields (D83 (9), decided by the user on 2026-10-06).** Every config field the start
read by an `as` cast with no check — so a value of the wrong type or shape reached its consumer
as if it were right — is checked by the same validator (the same grammar, `FieldCheck` and
error) where its section is read; the validated value (numbers parsed from a number literal) is
what the consumer gets. Found by reading every `as` cast on a config value in the resolvers
(`config.ts`, `resolve-config-sections.ts`, `pipeline-settings.ts`, `stepper-config.ts`); each
rule is what the consumer named in *Why* can work with. An absent field keeps its 30.1.0
default; a field with no value (`null`) fails its rule, as above. The pipeline sections' fields
are named as the key inside the pipeline's `config`, as the stepper's (D83 (7)).

| Field | Rule | Why (the consumer) |
|---|---|---|
| `agent.retry` | a closed mapping of `maxAttempts`, `backoffMs`, `retryOn`, `retryOnMidStream` | `SmartAgentBuilder` hands it to `RetryLlm`, which merges it over its defaults key by key |
| `agent.retry.maxAttempts` | integer ≥ 0 | retries after the first call (`attempt >= maxAttempts` stops; 0 = no retry); `maxAttempts: three` compares as `NaN`, and `attempt >= NaN` never stops |
| `agent.retry.backoffMs` | integer in [0, 2147483647] | the first backoff's timer delay in ms (doubled per attempt) |
| `agent.retry.retryOn` | a list of integers in [100, 599] | HTTP status codes `isRetryableStatus` compares with `===` — `"429"` never matched (now a number literal, parsed) |
| `agent.retry.retryOnMidStream` | a list of non-empty strings | substrings of an error message; `""` is in every message and would retry every mid-stream error |
| `agent.toolSelection` | a closed mapping of `strategy`, `minScore` | `resolveToolSelectionStrategy(strategy, { minScore })` |
| `agent.toolSelection.strategy` | required; one of `top-k`, `threshold` | the names the resolver knows; 30.1.0: absent or `""` → no strategy, silently |
| `agent.toolSelection.minScore` | finite number; required for `threshold`, refused for `top-k` (`only applies to strategy threshold`) | `ScoreThresholdToolSelection` keeps `score >= minScore`; no range — the score scale is the store's (as `score-floor.minScore`, §6.2); `"0.5"` from `${VAR}` was refused as "not numeric" |
| `agent.externalToolsValidationMode` | one of `permissive`, `strict` | the chat route compares with `'strict'`; any other value behaved as `permissive` |
| `mcp` (single form) | a closed mapping of `type`, `url`, `command`, `args`, `headers`, `timeout`, `toolTimeouts` | `resolveMcpSection` reads these keys; an `mcp[]` entry's `name` is not read here |
| `mcp.type` | one of `http`, `stdio`, `none` | the transport (`none` = no MCP); the name check moves here from `validateResolvedConfig` — one rule per field; its cross-field rules (`url` for `http`, `command` for `stdio`) stay there |
| `mcp.url`, `mcp.command` | non-empty string | an address / a command; 30.1.0's `\|\| undefined` read `""` as absent — `url: ${MCP_ENDPOINT}` unset started a server **without MCP** when `type` was not written |
| `mcp.headers` (and `mcp[i].headers`) | a map of non-empty string → non-empty string | HTTP headers the client sends on every request; a YAML number must be quoted; an empty value (`Authorization: ${TOKEN}` unset) would be sent as is |
| `mcp.toolTimeouts` (and `mcp[i].toolTimeouts`) | a map of non-empty string → integer in [1, 2147483647] | `resolveToolTimeout` reads `toolTimeouts[name]` as a request timer delay in ms, like `mcp.timeout` |
| `mcp[i]` | a closed mapping of `type`, `url`, `command`, `args`, `headers`, `timeout`, `toolTimeouts`, `name` | `connectMcpClientsWithDescriptorsFromConfig` reads these keys (`SmartServerMcpConfig`) |
| `mcp[i].type` | one of `http`, `stdio`; absent = `http` | the consumer connects every entry that is not `stdio` as `http` — an entry's `none` (accepted by 30.1.0's check) connected as `http` |
| `mcp[i].url`, `mcp[i].command` | non-empty string | an address / a command |
| `mcp[i].args` | a list of strings | the stdio command's arguments, passed as `argv` (an empty argument is a valid argument) |
| `llm.url`, `llm.model`, and each `llm.<role>.url` / `.model` of the map | non-empty string | the provider's base URL and the model name; the map's entry was spread by a cast, so a YAML number model reached the provider as a number |
| `host` (`args.host`, else the YAML's `host`; named so) | non-empty string | the address the server listens on |
| `mode` | one of `hard`, `pass`, `smart` | `SmartAgentBuilder.withMode` |
| `pluginDir` (`args.plugin-dir`, else the YAML's; named so) | non-empty string | a directory path |
| `plugins` | a list of non-empty strings | plugin specifiers; 30.1.0 dropped a non-list and every non-string item silently |
| `skills` | a mapping | `resolveSkillManager` |
| `skills.type` | one of `claude`, `codex`, `filesystem` | 30.1.0: another name → no skill manager, silently |
| `skills.dirs` | a list of non-empty strings | directories `FileSystemSkillManager` reads |
| `skills.projectRoot` | non-empty string | the root the claude / codex managers resolve from |
| `pipeline.config` | a mapping | the selected pipeline's section; 30.1.0 dropped a scalar silently (a list reached `asSection`, which refuses it) |
| linear: `maxSteps` | integer ≥ 1 | the step budget of the linear coordinator |
| linear: `maxRetriesPerStep` | integer ≥ 0 | retries per step |
| linear: `failPolicy` | one of `abort`, `continue` | the coordinator's two policies |
| DAG: `planner`, `reviewer`, `errorStrategy` | a mapping (open — the examples carry `type: llm` the parser does not read) | 30.1.0's `block()` read a non-mapping as `{}` |
| DAG: `errorStrategy.type` | required; one of `replan`, `abort` | 30.1.0: another value → no error strategy, silently |
| DAG: `errorStrategy.maxReplans` | integer ≥ 0; only with `replan` | `ReplanErrorStrategy`'s budget; 30.1.0 dropped a string silently |
| DAG: `maxRoundTrips` | integer ≥ 1 | the coordinator's round-trip budget; 30.1.0 dropped a string silently |
| DAG: `stateOracle` | non-empty string | an agent name; 30.1.0 dropped a non-string silently |
| DAG: `finalizer` | a mapping | `resolveFinalizer` |
| DAG: `finalizer.type` | one of `passthrough`, `llm`, `template` | the finalizers `resolveFinalizer` builds (an unknown name built an `LlmFinalizer`) |
| DAG: `finalizer.systemPrompt` | non-empty string | a prompt |
| controller: `targetState`, `sessionMemory`, `budgets` | closed mappings of the keys of `ControllerConfig`'s `targetState` (`strategy`, `distanceThreshold`), `sessionMemory` (`collection`), `budgets` (below) | spread over the defaults by a cast: a misspelled key was merged and read by nobody |
| controller: `targetState.strategy` | one of `consumer-confirm`, `semantic-distance`, `auto` | the target-state strategies |
| controller: `targetState.distanceThreshold` | finite number in [0, 2] | compared with a cosine distance (`1 − cosine`, in [0, 2]) |
| controller: `sessionMemory.collection` | non-empty string | a collection name |
| controller: `budgets.maxSteps`, `.maxStepAttempts`, `.maxDigestChars`, `.maxIntentChars`, `.maxActiveSteps`, `.maxBoardChars` | integer ≥ 1 | `stepsUsed < maxSteps`, `attempt >= maxStepAttempts`, character and step caps — 0 runs nothing or renders nothing |
| controller: `budgets.maxRetries`, `.maxRewinds`, `.maxToolCalls`, `.maxStepResumes`, `.maxPlannerResumes`, `.maxEvalResumes`, `.maxFinalizeRetries`, `.maxReviewRetries`, `.keepRecentDigests` | integer ≥ 0 | counts compared with `>` / `<=`; 0 = none |
| controller: `budgets.perStepTimeoutMs` | integer in [0, 2147483647] | a timer delay; 0 = no step timeout (`> 0` is checked) |
| controller: `budgets.maxWaitMs` / `.maxTotalWaitMs` | integer in [1, 2147483647] / integer ≥ 0 | unchanged rules (30.1.0 `requireInt`), now the shared grammar and error — `"600000"` passes |
| stepper: `stepper`, `stepper.reviewer`, `flow`, `flow.planner`, `flow.executor`, `flow.finalizer`, `flow.evaluator`, and a node's `flow` | a mapping | 30.1.0 read a non-mapping as absent (the defaults applied) |
| stepper: `stepper.reviewer.atDepths`, `flow.evaluator.atDepths` | `all`, or a list of integers ≥ 0 | depths a `Set` is asked with numbers — `"1"` never matched, so the reviewer / evaluator was silently off at that depth |
| stepper: `flow.evaluator.enabled`, `formalizeTask` | flag | 30.1.0 compared with `!== false` / `=== true`: `"false"` kept the evaluator on, `"true"` left `formalizeTask` off |
| stepper: `knowledgeSeed` | a list of mappings: `content` non-empty string, `artifactType` non-empty string when present | 30.1.0 dropped a non-list, an entry without text and an empty `artifactType` silently |
| stepper: `flow.plan`, `flow.nodes` (and a node's `flow.nodes`, recursively) | a list of mappings: `goal` non-empty string; `id`, `agent` (plan) non-empty string when present; `dependsOn` a list of non-empty strings | 30.1.0 dropped a node without a goal and every non-string `dependsOn` item silently |

Already checked and not changed: the cast fields `validateResolvedConfig` checks before anything
reads them (`llm.provider`, `llm.credentialRef` and each role's, `rag.store.type`,
`rag.embedder.provider`, `rag.retrieval.*`, `decision.provider`, `decision.credentialRef`,
`pipeline.name`, `subagents[].description`) and the stepper's and DAG's checked names
(`mode`, `flow.planner.type`, `.granularity`, `flow.executor.type`, `flow.finalizer.type`, the
system prompts, the controller's `subagents`, the DAG's `*Llm` keys, `skillPlugins`' sources).
`parseLinearSettings`, `parseDagSettings`, `parseControllerSettings` (exported) and
`parseStepperCoordinatorConfig` keep their signatures; each builds its own `FieldCheck` and
throws one `ConfigFieldError` for its section, before its cross-field rules.

**The start config (D83 (5), the user's rule of 2026-10-06: no silent degradation).** Every field
of the table except the three `models.*` names (a `PUT` input only) is checked at start too, with
the same rules and the same error, before anything is built (and every start-only field above,
D83 (7)) — also `circuitBreaker`, which the
start does not take from the YAML (as the reload checks the fields it does not apply: the file is
the whole config):

- `resolveSmartServerConfig` (server-libs `config.ts`), right after its legacy-shape guards,
  validates the YAML's values at the paths the file reload reads (`ConfigWatcher`: `agent.*`,
  `rag.store.vectorWeight` / `keywordWeight` for an in-memory store, `prompts`, `circuitBreaker`,
  `logDir`) — exactly the input a reload of the same file would validate — plus the two
  `ResolveConfigArgs` overrides that replace two of them, checked in place
  (`args.agent-show-reasoning` a flag, `args.log-dir` a non-empty string, named so; a programmatic
  caller passes them — the CLI sets neither). The section readers apply the start-only rules
  and the cast-read rules (D83 (9)) with the same `FieldCheck` (`resolveSmartServerConfig` makes one per start and passes it), and
  it throws once every section of the main file was read — before `skillPlugins` and the workers
  are parsed. Every invalid field of the main file is named in one error,
  `invalid config — <field> <rule>, got <value>`.
- The section readers take the validated values instead of coercing: `resolveAgentSection` for
  the `agent.*` fields of the table, `resolveRagSection` for the in-memory weights,
  `resolvePromptsSection` for the prompts, and `logDir`. An absent field keeps its default as in
  30.1.0 (`maxIterations` 10, `maxToolCalls` 30, `ragQueryK` 10, `historyAutoSummarizeLimit` 10,
  `toolResultCacheTtlMs` 300000, `sessionTokenBudget` 0, the flags false, the weights 0.7 / 0.3;
  `toolUnavailableTtlMs` 600000 until U8, then absent). A prompt is applied as written (an empty
  one is no longer read as absent — it fails its rule).
- A worker file (`subagents[].config`) resolves through the same function, so its fields are
  checked the same way; the error names the worker and its file before the field
  (`invalid config — subagent 'w' (<path>): agent.maxIterations must be a finite number, got
  "oops"`).
- **An invalid start config fails the start** — the way an unusable start config already does:
  the CLI (`llm-agent-server` `cli.ts`) catches the error of `resolveSmartServerConfig`, writes
  `Error: <message>` to stderr and exits with code 1, before a logger, a store or a server is
  made. A start config is therefore always valid, which is what D82 (5) assumes (the server starts
  ready).
- **A value substituted from `${VAR}` is a string** (the start resolves `${VAR}` before it reads
  the file), and that is allowed (D83 (6)): `maxIterations: ${MAX_ITERATIONS}` with
  `MAX_ITERATIONS=25` is 25, `showReasoning: ${SHOW}` with `SHOW=true` is `true` — docker compose
  keeps working. A variable that holds anything else fails its field (`MAX_ITERATIONS=" 25"`,
  `25abc`, an unset variable with no default → `""`). `logDir: ${LOG_DIR:-./sessions}` is a
  string and passes; a `${VAR}` that resolves to an empty string fails `logDir`'s rule.
- **The file reload substitutes `${VAR}` exactly as the start does (D83 (8), decided by the user
  on 2026-10-06, §17.34).** One function, `resolveEnvVars` (server-libs `yaml-loader.ts`, the
  one `loadYamlConfig` applies at start), one syntax — `${VAR}` and `${VAR:-default}` — and the
  same environment (the server process's; the CLI loads `--env` / `--env-path` / `.env` into it
  before the start). `ConfigWatcher` applies it, injected as `resolveDocument` (§3.8), to the whole
  parsed file **before** it reads a field — where the start applies it too — so the fields the
  watcher picks are the start's (`rag.store.type: ${STORE:-in-memory}` gates the weights on both);
  substituting after the watcher, over the event's values, would not. `resolveEnvVars` stays where
  it is: libs imports nothing from server-libs, and `config-reload-watcher.ts` imports it from
  `./yaml-loader.js`, which imports only `node:fs` and `yaml` — no cycle, no second
  implementation. A reload of a file with `maxIterations: ${MAX_ITER}` and `MAX_ITER=25` applies
  25. **An unset variable with no default** resolves to `""` on a reload as at start
  (`resolveEnvVars` reads `env[name] || fallback || ''` — a variable set to `""` takes the default
  too) and that `""` fails its field: at start the start fails (exit code 1), on a reload the
  transaction fails before anything applies and the server is not ready until a whole config
  applies (V6) — `agent.maxIterations must be a finite number, got ""`. `${VAR:-}` is `""` the same
  way and fails every non-empty-string field (`prompts.system`, `logDir`, …). 30.1.0 read the
  reload's `${VAR}` as text: `Number("${X}")` applied `NaN`, a prompt applied the literal
  `${VAR}` (B21).
- A `SmartServerConfig` a consumer constructs in code is typed by its own composition root and is
  not re-validated; the server reads its numbers as numbers (no `optionalNumber`, D83 (7)).

Plus M9–M11 (§10.5.3), R10 (§10.5.4), L7 (§10.5.6), S-10 (§10.5.8). Layer: server.

#### 10.5.10 Health (D72)

**The rule.** `/health` answers **HTTP 200 only when every configured component works**; a
required component that is not working ⇒ **503** (not ready). Every component the consumer
configured is required — it would not be configured otherwise; an optional capability that is
absent is not probed and not reported.

- `HealthStatus.status`: `healthy` → 200; `degraded` (a configured component not fully working: an
  LLM / store / MCP probe failed, a circuit open, `toolCatalog.complete: false`) → **503**;
  `unhealthy` (unchanged, unused) → 503. The word `degraded` keeps the goal's wording for an
  incomplete fill (D41); what changes is the HTTP code. The body is unchanged (`{ …status, ready }`).
- `ready` (the agent's `IReadinessReporter`) still gates the chat routes (`writeNotReady`), as
  today; `/health` answers 503 when `!ready` **or** `status !== 'healthy'`. The chat routes are not
  gated on the full health probe (it is per `/health` call, too expensive per request): a request
  that needs a broken component fails on its own (§10.5.2–§10.5.9).
- **Config not applied (D82).** The server's `ready` is the agent's MCP readiness **and** its
  config state. A config transaction that failed (a reload, V6 — a file the watcher cannot read,
  parse or resolve included, D82 (9) — or a `PUT`, V10) sets the server's
  *config not applied* state — `{ reason, source: 'reload' | 'put', at }`, held by the server's
  `ConfigTransactionQueue`, since every config change settles there — and the next transaction
  that applies **with the whole config** clears it: a file reload, or a `PUT` carrying every
  section the route can change (D82 (8)); while it is set, a partial `PUT` is refused (409, V10)
  and changes nothing; a transaction in flight changes nothing until it settles. While it is
  set, `ready` is `false`: `/health` answers **503** with the body
  `{ …status, ready: false, configNotApplied: { reason, source, at } }`, and both chat routes
  (`POST /v1/chat/completions`, `POST /v1/messages`) answer **503** through the same pre-dispatch
  gate as MCP readiness, before any session is acquired or stream opened — `writeNotReady` with a
  message: `{ error: { type: 'service_unavailable', message: 'config not applied — <reason>' } }`
  (the MCP message stays `MCP unavailable — server not ready`; with both, the config failure is
  named). Not gated: `GET` / `PUT /v1/config` (the consumer must see and send a config),
  `/health`, `/v1/models`, `/v1/embedding-models`, `/v1/usage` and the session routes. **At start
  the state is empty — the server starts ready from its config:** a start whose config cannot be
  applied fails the start itself (V7, V9, S-10, … — exit 1), so a running server never holds an
  unapplied start config; only a later change can set the state.

| # | Where | Today | Now |
|---|---|---|---|
| H1 | server-libs `http/health-route-handler.ts` (~17) | `degraded` → 200 | `degraded` → 503 (the rule) |
| H2 | libs `health/agent-health.ts` (~57) | only the first RAG store probed; none → `rag: true` | every registered store probed; `rag: true` only when all answer; no store → `rag: true` (absent by design) |
| H3 | `agent-health.ts` (~70) | an MCP `healthCheck` `{ ok: true, value: false }` → ok | `ok && value` (as the LLM probe already does) |
| H4 | `agent-health.ts` (~105) | the MCP probes throw (timeout) → `mcp: []` → all OK | every client probe that did not answer is reported `ok: false` with the error |
| H5 | `agent.ts` (~488) `isReady` true for a strategy without readiness | **kept**: absent by design; such a pipeline's MCP health comes from the probes (H3, H4) | — |

Layer: framework (libs) for H2–H4, server for H1.

#### 10.5.11 Already removed, or no longer present

- `FallbackRag` and the builder's store wrapping — removed by D68 (§10.4).
- `IntentToolIndexing` (`rag/tool-indexing-strategy.ts`, failure → `[]`) — the file is deleted with
  the orphan `IToolIndexingStrategy` (§10.3); nothing to change.
- Every other inventory item was found present on 2026-10-05.

#### 10.5.12 The modes a consumer chooses — decided by the user (U1–U10)

**TL;DR.** The user approved every recommendation of §17.24 on 2026-10-05. A degraded mode the
consumer **explicitly chose** stays, and becomes countable or visible; a default that silently
degraded is turned around; a fallback nobody uses is removed.

| # | Mode | Decision | Now | Layer |
|---|---|---|---|---|
| U1 | `FallbackLlmCallStrategy` (`agent.llmCallStrategy: fallback`, opt-in) | keep; count each fallback | each fallback (a streaming `ok: false` chunk or a throw, never the caller's cancellation) is counted **two ways**: (1) **log** — the existing warning carries a stable event name and a running count, `llm_streaming_fallback` with `cause` (`error` \| `throw`), `fallbacks` (n for this instance) and the message — always, so the server's file logger counts it; (2) **metric** — an optional `ICounter` injected through the new second constructor argument `{ fallbackCount?: ICounter }` (§3.8) is incremented with the attribute `cause`. **No span**: the strategy has no tracer, and the request's span already carries the LLM call. The server passes its file logger, as today (it has no metrics backend to inject) | framework (`llm-agent` `policy/`) |
| U2 | skill plugin host `strict` | default `strict: true`; `strict: false` only when the consumer sets it | `SkillPluginHost` reads `deps.strict ?? true`; the server's `skillPlugins.strict` defaults to `true` (`skill-plugins-config.ts`); a failed source fails its group (the group in `omitted`, S-8). `strict: false` keeps the carry-forward, reported in `carried` (S-9) | framework (libs) + server |
| U3 | controller `onFinalizeExhausted: 'best-effort'` | keep | unchanged | — |
| U4 | `AutoActivation` | keep | unchanged | — |
| U5 | `HybridDispatch` | keep for a step that names no agent; a named agent missing → error | `!step.agent` → the fallback dispatcher (unchanged); `step.agent` set and not in `ctx.registry` → `StepResult { ok: false, error: "HybridDispatch: agent '<name>' not in registry (registered: …)" }`, a failed step like any other: under `failPolicy: 'abort'` the handler fails the request with `COORDINATOR_STEP_FAILED`, under `'continue'` the answer reports the failed step (`[Coordinator: n step(s) failed …]`) — never a silent run by another dispatcher | framework (libs `coordinator/dispatch/`) |
| U6 | `lazy(…, { fallback })` | remove | `LazyOptions.fallback` is deleted with its delegation branch; an init failure always propagates (after the existing retry gate). Migration line 73 | framework (libs `utils/`) |
| U7 | batch → per-tool embedding | keep; count batch failures | the retry is unchanged; each failed batch call is counted: `ToolCatalogStatus.batchFailures` (30.1.0 path, `vectorizeMcpTools`) and `IndexReport.batchFailures` → `ToolCatalogStatus.batchFailures` (profile path, `storeItems` → the binding's `index` → `indexToolsThroughProfile`); present only when > 0; the summary log line names the count; `/health`'s `toolCatalog` carries it (`HealthComponentStatus.toolCatalog.batchFailures?`, copied by the health checker as `records` / `profile` are) | framework (libs) + contracts (`llm-agent`, §3.8) |
| U8 | tool availability blacklist | an injected policy, no default | `IToolAvailabilityPolicy { onToolError(toolName, errorText): { ttlMs } \| undefined }` (libs). `tool-loop-core` asks the policy **only when one is injected**; with none, a failed tool is never blocked and the tool set is never filtered by it (the error still reaches the LLM as the tool result). `HeuristicToolAvailabilityPolicy({ ttlMs })` ships the 30.1.0 heuristic (`isToolContextUnavailableError`) for a consumer who wants it. Injected with `SmartAgentBuilder.withToolAvailabilityPolicy` / `SmartAgentDeps.toolAvailabilityPolicy`; `SmartAgentConfig.toolUnavailableTtlMs` is removed (migration line 74). Server: YAML `agent.toolUnavailableTtlMs` **set** → the server injects `HeuristicToolAvailabilityPolicy({ ttlMs })`; **unset** → none (its 600000 default is removed); it leaves the `PUT /v1/config` whitelist (the TTL is the policy's, fixed at construction — it never changed a live agent's registry) | framework (libs) + server |
| U9 | D68's removed builder embedder breaker and `withCircuitBreakers` | confirmed | done by Task 0A; nothing more | — |
| U10 | a worker without its own clients / tools store uses the parent's | keep; log one line | each wire of such a worker logs one debug line `worker_uses_shared_clients` with `worker` and `shared` (`mcpClients`, `toolsRag`, or both) through the server's logger; no behaviour change | server |

---

## 11. Package placement

| What | Package | Why |
|---|---|---|
| All contracts of §3 (incl. `IProbabilityDecision`, `IRelevanceDecision`, §3.9) | `@mcp-abap-adt/llm-agent` | shared by libs, the reranker package, server-libs, provider packages and consumers |
| `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `PROBABILITY_RERANK_DEFAULT_*` | **new** `@mcp-abap-adt/llm-agent-reranker` | §5.4 — rerankers carry no vendor specifics; one vendor-neutral package (goal decision 2026-10-05) |
| `wrapProbabilityDecision`, `wrapRelevanceDecision` (no reranker re-exports, no `wrapDecisionModel`) | `@mcp-abap-adt/llm-agent-libs` | §5.4, §13, D58, D59 |
| `StagedRetrieval`, `ItemPool`, cuts (incl. `TokenBudgetCut`), size estimators, `MaxScoreCollapse`, `ComposedToolsProfile`, `mcpToolsVariants`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `SharedItemsProfile`, the fill sources and the corpus API | `@mcp-abap-adt/llm-agent-libs`, `src/collections/` (small modules) | D1: the retrieval built-ins and the builder that uses them already live here; they compose rerankers (`llm-agent-reranker`) and stores (`llm-agent-rag`), both below libs |
| **The RAG implementations of §11.3** (`VectorRag`, `InMemoryRag`, …) with their option types, the search-strategy types and their tests | **`@mcp-abap-adt/llm-agent-rag`** — files moved in this PR (`packages/llm-agent-rag/src/`) | D53, D57 — the goal's layering: the contracts package holds contracts; RAG implementations live in `llm-agent-rag` |
| `SapAiCoreRelevanceDecision`, `SapAiCoreRelevanceConfig`, `FetchLike` | **new** `@mcp-abap-adt/sap-aicore-decision` | §5.4 — one package per vendor and role, like `typesafe-decision` |
| YAML resolver + validation (`rag.profiles`; `decision.provider: sap-aicore`; the provider → kind table); the `makeRelevanceDecision` seam type; `makeProbabilityDecision` (renamed seam; no alias) | `@mcp-abap-adt/llm-agent-server-libs` | beside `resolve-retrieval.ts`, `decision-config.ts` and the probability seam type |
| `createMakeProbabilityDecision` (renamed from `createMakeDecisionModel`; `make-decision-model.ts` → `make-probability-decision.ts`), `createMakeRelevanceDecision` with the `sap-aicore` arm (builds `SapAiCoreRelevanceDecision`, resolves `credentialRef`) | `@mcp-abap-adt/llm-agent-server` (the app's composition root) | `make-relevance-decision.ts`, beside `make-probability-decision.ts` |
| `IRetrievalEmbedderOwner` implementations | `VectorRag` (`llm-agent-rag`), `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | where the stores are |
| `FallbackRag` removed, the builder's store wrapping removed (D68, §10.4) | — (nothing placed) | `llm-agent` loses the file and export; libs' `builder.ts` and server-libs' `smart-server.ts` lose the wrap and `withCircuitBreakers` |

- Decided — D1 (libs, not a new `llm-agent-collections` package), D2 (own provider package
  `sap-aicore-decision`), D24 (one reranker package), D53 and D57 (RAG implementations' home and
  the move of their files), D59 (no re-exports) (§17).
- **Build and publish order — no new edge:** `llm-agent` → `llm-agent-reranker` →
  `typesafe-decision`, `sap-aicore-decision` (each depends only on `llm-agent` and the
  `interfaces-auth` peer) → the store and embedder packages (they import only `llm-agent`; with
  `OllamaRag` removed, `ollama-embedder` needs nothing from `llm-agent-rag`, S11) → `llm-agent-rag`
  (already depends on `llm-agent` and, as optional peers, on the store and embedder packages; now
  holds the moved files) → `llm-agent-libs` (depends on `llm-agent-reranker` and `llm-agent-rag`) →
  `llm-agent-server-libs` → `llm-agent-server`; all at the same version. `tsc -b` and `--clean`
  keep the root list's order. **No cycle:** nothing in `llm-agent` imports `llm-agent-rag` (a repo
  test pins it), and nothing `llm-agent-rag` depends on imports it (§11.3).
- New files carry no per-file licence header (the repo has none); every package, the new one
  included, is `LGPL-3.0-only` in `package.json`.

### 11.1 Layer map — every part of this design in exactly one layer

**TL;DR.** Four layers. The **consumer** chooses and calibrates; the **framework** defines
contracts and ships generic implementations; **llm-agent-server** reads YAML and runs the server's
lifecycle; the **pipelines in llm-agent** use the stores per request. The store backends own
concurrency (D13) and belong to no layer of this design.

**1. Consumer** — what the consumer decides and does (never shipped by llm-agent):

| What | Where in this spec |
|---|---|
| Strategy choice: a named composition or its own `compose` (indexer, facets, provider text, pool, collapse, reranker, cut), the fill source (`live` / `corpus` / `consumer` / its own `IToolsFillSource`) | §3.10, §6.1, §6.2, §7.1, §7.5 |
| Its own strategies: an `IQueryDecomposer` (none ships), facets, composers, discriminators, size estimators, a whole profile for another MCP server; registered by name (`toolsVariantFactories`, `toolsStrategyFactories`, `toolsFillFactories`) | §4.5, §7.9, §6.2 |
| **All calibration** (D55): `poolItems`, `maxItems`, `budgetTokens`, `maxValues`, any threshold on relevance scores (`score-floor`) — measured on its own catalog with the harness | §4.10, §6.2, §7.1, §7.4, §14.3 |
| The **build step**: lists its provider's tools, `toolItemFromTool`, `buildToolsCorpus` (the libs API), serializes the corpus, ships the file with its deployment; the names in `ToolsCorpusIdentity` | §6.5 |
| Filling with the `consumer` source, and filling on the builder's `withMcpClients` / `withMcpServers` branches (`bound.index`, `fillToolsBinding`) | §3.10, §6.1 |
| Its own pipelines' checks: an MCP server plugged in at runtime, a tool list that changes while running (`bound.index` with the new tools) | §6.3, §15 (D46) |
| Its own composition root: the decision seams (`makeProbabilityDecision`, `makeRelevanceDecision`), credentials, binding stores beyond `tools` (`profile.bind` + `withRetrievalStrategy`); for a builder consumer, the start at which its stores are created and filled | §6.1, §6.2, §13 |
| Replicas over one persistent tools store: whether the reload window at each start is acceptable (§3.10) | §3.10, §6.5 |
| Shared items: group partitions (`ISharedItemGroups`), retention and redaction policy | §8.3, §8.4, §15 |
| Any **degraded mode** — answering while a component is down: its own injected strategy (an `IRag` wrapper, an `IReranker`, an LLM call strategy), and the modes it opts into (§17.24 U1–U8) | §10.4, §10.5 |

**2. llm-agent framework** — contracts and generic implementations:

| Package | What |
|---|---|
| **Contracts** — `@mcp-abap-adt/llm-agent` | every contract of §3: records and owners (`IndexedRecord`, `RecordDraft`, `recordId`, `RecordOwner`, `ItemRef`, `ReservedRecordKey`), the profile (`IItemIndexer`, `ICollectionProfile`, `IBoundCollection`, `BindTarget`, `CollectionStore`), retrieval parts (`ICandidatePool`, `ICollapseRule`, `IItemCut`, `ISizeBoundedCut`, `ISourceSelector`, `RetrievalSource`, `IQueryDecomposer`), tool items (`ToolItem`, `IToolFacet`, `IToolTextComposer`, `IDiscriminatorSelector`, `IItemSizeEstimator`, `IIndexNoteSource`), shared items (`SharedItem`, `ISharedItemGroups`, `SharedItemsStores`), `IRetrievalEmbedderOwner` + `retrievalEmbedderOf`, the decision contracts (`IProbabilityDecision`, `IRelevanceDecision`), `IToolsFillSource` + `ToolsFillContext`, `IRetrievalMetrics`, the optional health / catalog fields, `skillNameFromRecord`, the contract types moved out of implementation files (`IQueryExpander`, `IQueryPreprocessor`, `IDocumentEnricher`), the conformance kit (`testing/collection-profile-conformance` — test code over the contracts only, beside `rag-filter-conformance`; it imports no implementation: the consumer's harness hands it its own stores); plus the store kit of §11.3 that the store packages below `llm-agent-rag` need. It exports **no RAG implementation** any more (D57) |
| **RAG implementations** — `@mcp-abap-adt/llm-agent-rag` | every RAG implementation of §11.3, files and tests (`VectorRag` with `IRetrievalEmbedderOwner`, `InMemoryRag`, the overlays, the registry, the providers, the search strategies and their types, the preprocessors and query expanders, the RAG collection tools, the private `InvertedIndex` and tokenizer), beside its existing backend / embedder factories; it exports only what lives in it (D59) |
| **Generic implementations** — `@mcp-abap-adt/llm-agent-libs` | `StagedRetrieval`, `ItemPool`, `MaxScoreCollapse`, the cuts and size estimators, the record writer, `ComposedToolsProfile`, `bindToolsProfile` / `toolsBindingOf`, `mcpToolsVariants` (named compositions, no tuned numbers), the tools indexers, facets, composers and discriminators, `toolItemFromTool`, `SharedItemsProfile`, the three fill sources, the corpus API (`buildToolsCorpus` for the consumer's build step, `parseToolsCorpus`, `ToolsCorpusLoader` for the load at start, the private capture store), `vectorizeMcpTools` (fill dispatch, the live path), `fillToolsBinding`, `McpToolRegistry.revectorizeTools` (no write into a bound store, D46), `SmartAgentBuilder.withToolsProfile`, `HealthCheckerDeps.toolCatalog`, `IRetrievalMetrics` in `InMemoryMetrics` / `NoopMetrics`, telemetry on the 30.1.0 rerank strategies, the usage-logging wrappers, `evaluateRetrieval` (a measurement harness in `libs/testing`, not a store) |
| **Generic implementations** — `@mcp-abap-adt/llm-agent-reranker` | `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `PROBABILITY_RERANK_DEFAULT_*` |
| **Provider packages** | `typesafe-decision` (`TypeSafeDecisionModel`, unchanged), `sap-aicore-decision` (`SapAiCoreRelevanceDecision`); the stores `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` (`IRetrievalEmbedderOwner`, F1) |

**3. llm-agent-server** — the server's composition and lifecycle:

| Package | What |
|---|---|
| `@mcp-abap-adt/llm-agent-server-libs` | YAML types and validation (`rag.profiles.tools`, `fill`, `decision.provider: sap-aicore`), names → instances (`resolve-collection-profiles.ts`), the provider → kind table and `decision-seams.ts`, the seams `makeProbabilityDecision` and `makeRelevanceDecision`, `toolsFillFactories`, **the corpus load at start**: reading the corpus file once and building the `corpus` source with what the server is configured with (`expect`, incl. the store config's `dimension`), binding at store creation (`withToolsStore`), the main store's fill in `_buildInfra`, a worker's fill by its construction and the cache entry dropped on a throwing fill, the pass after the harvest (D38), descriptors and namespace to workers (`connectedMcpServer`), the awaitable reload, the one config field validator for the reload and `PUT /v1/config` (D83), the one config queue and its *config not applied* readiness — set by a failed reload or `PUT`, cleared by the next whole config that applies (a partial `PUT` refused while it is set), read by `/health` and the chat routes' gate (D80, D82), publishing the main catalog to `/health`, the refusal of `corpus` for a worker with its own `rag` and clients |
| `@mcp-abap-adt/llm-agent-server` (the app's composition root) | `createMakeProbabilityDecision`, `createMakeRelevanceDecision` with the `sap-aicore` arm, the AI Core service-key credential (`DECISION_SERVICE_KEY`) |

**4. Pipelines in llm-agent** — the elements that use the stores per request:

| Element | What changes |
|---|---|
| `tool-select` (libs `pipeline/handlers/tool-select.ts`) | nothing: a profile reaches it as the tools store's `IRetrievalStrategy`; it keeps only names in the agent's catalog |
| `tools-rag-handle` (`makeToolsRagHandle`) | F2 de-duplication (§10.2); its file stays in server-libs (goal decision 2026-10-05, §11.2 item 2) |
| `skill-select` (libs `pipeline/handlers/skill-select.ts`) | F3 (§10.2) |
| Shared-items writers | write and remove items through `SharedItemsProfile` `index` / `remove`; what an item holds is theirs (§8.4, §15) |
| Rerank stage, query preparation (`translate`, #323) | unchanged: `RerankHandler` precedence, `retrieval_rerank_error`; query preparation stays a pipeline stage (§12) |

**Fail loud (§10.5)** — every item's layer is in its table:
- framework — `llm-agent-mcp`: M1–M3b; the store kit, `llm-agent-rag` and the store / embedder
  packages: R1–R3, R11, R12; libs: R9, K1, K2, C1–C8, S-3–S-9, H2–H4, M12; LLM providers: L5, L6;
  contracts: `PIPELINE_FAILURE_CODES`, `SkillLoadResult.carried`;
- llm-agent-server: M9–M11, R10, L7, S-10, V1–V10 (V6 and V10 share the server's one
  config-transaction queue, D80, and its *config not applied* readiness, D82), H1;
- pipelines in llm-agent: D70 (executor, `DefaultPipeline`, `pipelineToStream`, `SmartAgent`), N2,
  N3, N13, the tool-loop context strategies, M4–M8, R4–R8, K3, K4, L1–L4, S-1, S-2;
- the consumer: its degraded modes (above).

**Outside the four layers:** the store backends (concurrency, D13); `scripts/rag-eval`, the repo's
measurement harness (§14.3).

### 11.2 Layer audit — suspected misplacements and how each is resolved

Each item says what sits where, and how the goal's decisions of 2026-10-05 settle it.

1. **Generic implementations in the contracts package — resolved by D53 and D57.** The RAG
   implementations (`VectorRag`, `InMemoryRag`, … — §11.3; `FallbackRag` is removed, D68) move to `llm-agent-rag`
   in this PR, files and exports; `llm-agent` keeps no alias (a major release). **Still in the
   contracts package after this PR, by necessity** (reported, not resolved here): the store kit the store packages below `llm-agent-rag` import —
   `AbstractRagProvider` with its edit / id strategies and catalog helpers, `QueryEmbedding` /
   `FallbackQueryEmbedding` / `TextOnlyEmbedding`, `symmetricEmbedder` / `asymmetricEmbedder`
   (§11.3, "stays"). `llm-agent-rag` depends on those packages (optional peers), so they cannot
   depend on it; moving the kit needs a package below both, a decision for later. And the
   embedder / LLM resilience decorators (`CircuitBreaker*`, `RetryEmbedder`, …) are not RAG
   implementations, so the goal's move does not cover them. The conformance kit stays with the
   contracts (it is test code **over** contracts and imports no implementation); `recordId` and
   `skillNameFromRecord` are id conventions shared by both halves, and stay.
2. **A pipeline element in the server package — stays, decided by the goal** (2026-10-05, layers):
   `tools-rag-handle.ts` stays in `llm-agent-server-libs`; F2 is fixed there.
3. **Server lifecycle in libs — stays, decided by the goal:** `HealthChecker` and
   `HealthCheckerDeps.toolCatalog` stay in libs.
4. **"Fill at creation" owned by two layers — resolved by D54.** The *mechanism* is one, in libs:
   the store's fill source (`LiveToolsFill`, `ToolsCorpusLoader`, …) run by `vectorizeMcpTools` /
   `fillToolsBinding`. The *moment* belongs to whoever creates the store, i.e. the composition
   root's start: the server's start for its stores — on `yamlBuilderConnect` the server's own
   `_buildInfra` calls the builder's `build()`, so that fill is still the server's start (load at
   start → server, via the corpus source in libs); a builder consumer's own start for its stores.
   The build step (making the corpus) is the consumer's. No fill logic is duplicated between the
   layers.
5. **Consumer calibration in framework defaults — resolved by D55.** No strategy and no named
   composition carries a measured number; `mcpToolsVariants` is three named compositions whose
   numbers are the consumer's arguments or the generic defaults of §7.1.
6. **A fill-source artifact known to generic retrieval — resolved by D54.** There is no service
   record any more; `StagedRetrieval` knows nothing about how a store was filled, and the
   reserved key `serviceRecord` is gone.

### 11.3 The RAG implementations — contract or implementation, one by one (D53, D57)

**Rule:** a contract (an interface, a type, a function that defines a contract's semantics) stays
in `@mcp-abap-adt/llm-agent`; a RAG implementation — its file, its tests, its option types — moves
to `@mcp-abap-adt/llm-agent-rag`. One constraint decides the rest: `llm-agent-rag` depends on
`llm-agent` and on the store and embedder packages (`qdrant-rag`, `pg-vector-rag`,
`hana-vector-rag`, `ollama-embedder`, `openai-embedder`, `sap-aicore-embedder` — optional peers,
`tsconfig` references), so **nothing in `llm-agent` and nothing in those packages may import
`llm-agent-rag`** — a cycle.

**Moves** (files, tests and exports, in this PR; `@mcp-abap-adt/llm-agent` stops exporting them):

| Export(s) | File today → in `llm-agent-rag/src/` | Why an implementation | Users below `llm-agent-rag` |
|---|---|---|---|
| `VectorRag`, `VectorRagConfig` | `rag/vector-rag.ts` → `vector-rag.ts` | an `IRag` store | `ollama-embedder` (`OllamaRag extends VectorRag`) — removed, S11 |
| `InMemoryRag`, `InMemoryRagConfig` | `rag/in-memory-rag.ts` → `in-memory-rag.ts` | an `IRag` store | none |
| `OverlayRag`, `SessionScopedRag` | `rag/overlays/` → `overlays/` | `IRag` decorators | none |
| `ActiveFilteringRag` | `rag/corrections/active-filtering-rag.ts` → `active-filtering-rag.ts` | an `IRag` decorator | none |
| `SimpleRagRegistry`, `ragStoreKey` | `rag/registry/` → `registry/` | the `IRagRegistry` implementation and its key helper | none |
| `InMemoryRagProvider`, `InMemoryRagProviderConfig`, `VectorRagProvider`, `VectorRagProviderConfig`, `SimpleRagProviderRegistry` | `rag/providers/{in-memory-rag-provider,vector-rag-provider,simple-provider-registry}.ts` → `providers/` | `IRagProvider` implementations over the stores above, and a registry | none |
| `WeightedFusionStrategy`, `RrfStrategy`, `VectorOnlyStrategy`, `Bm25OnlyStrategy`, `CompositeStrategy`, `CompositeStrategyEntry` **and** `ISearchStrategy`, `ISearchCandidate`, `ISearchQuery`, `IScoredResult`, `ISearchContext` | `rag/search-strategy.ts` → `search-strategy.ts` | `ISearchStrategy` implementations; the types are `VectorRag`'s option types (`VectorRagConfig.strategy`) and name `InvertedIndex` | none |
| `NoopQueryPreprocessor`, `NoopDocumentEnricher`, `TranslatePreprocessor`, `ExpandPreprocessor`, `IntentEnricher`, `PreprocessorChain` | `rag/preprocessor.ts` → `preprocessor.ts` | `IQueryPreprocessor` / `IDocumentEnricher` implementations | none |
| `LlmQueryExpander`, `NoopQueryExpander` | `rag/query-expander.ts` → `query-expander.ts` | `IQueryExpander` implementations | none |
| `buildRagCollectionToolEntries`, `RagCallerIdentity`, `RagCollectionToolOptions`, `RagToolContext`, `RagToolEntry` | `rag/mcp-tools/` → `mcp-tools/` | the RAG-collection MCP tools and their options | none |
| — (not exported) `InvertedIndex`, `tokenizeSearchText` | `rag/inverted-index.ts`, `rag/tokenizer.ts` → `inverted-index.ts`, `tokenizer.ts` | private to `VectorRag` / `InMemoryRag` | none |

`FallbackRag` (`resilience/fallback-rag.ts`) is not in this table: it is removed, not moved (D68,
§10.4).

The tests of `packages/llm-agent/src/rag/__tests__/` and `resilience/__tests__/` (the open-breaker
query test D68 adds) that import a moved file move with it to `packages/llm-agent-rag/src/__tests__/` (two typecheck
files to `__typechecks__/`), their imports of files that stay rewritten to the
`@mcp-abap-adt/llm-agent` root (every such name is already a root export) and to its public
`./testing/rag-filter-conformance` subpath; the fake they took from `llm-agent`'s unexported
`testing/index.ts` (`makeLlm`; `makeRag` was used only by the removed `FallbackRag` test) is copied
into a test-only helper of `llm-agent-rag`.

**Contract types inside implementation files — extracted to `interfaces/` in this PR** (same names,
same root exports): `IQueryExpander` (from `rag/query-expander.ts`; `interfaces/plugin.ts` and
`interfaces/index.ts` import it today), `IQueryPreprocessor`, `IDocumentEnricher` (from
`rag/preprocessor.ts`).

**Stays in `@mcp-abap-adt/llm-agent`:**

| Export(s) | Why |
|---|---|
| everything under `interfaces/`, `RagError` and the other contract types | contracts |
| `matchesRagIdentity`, `ragIdentityFilter`, `RagIdentityFilter` | they define the identity semantics of `IRag.query` that every backend applies (the conformance kit checks them); `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` import them |
| the error classes of `rag/corrections/errors.ts`; the correction-metadata convention of `rag/corrections/metadata.ts` (`CorrectionMetadata`, `validateCorrectionMetadata`, `buildCorrectionMetadata`, `deprecateMetadata`, `filterActive`) | the contracts' error vocabulary and a metadata convention (types + pure validators) shared by implementations in several packages; the store packages import the errors |
| **store kit** — `AbstractRagProvider`; the catalog helpers (`describeRagCatalogRows`, `encodeRagAttributes`, `parseRagCollectionRecord`, `ragOwnerKeys`, `validateRagAttributes`, `validateRagOwner`, `RagCatalogRow`, `RagCatalogRowParse`); the edit strategies (`DirectEditStrategy`, `ImmutableEditStrategy`, `OverlayEditStrategy`, `SessionScopedEditStrategy`) and id strategies (`CallerProvidedIdStrategy`, `CanonicalKeyIdStrategy`, `GlobalUniqueIdStrategy`, `SessionScopedIdStrategy`) it builds on | implementations, but `qdrant-rag`, `pg-vector-rag` and `hana-vector-rag` extend `AbstractRagProvider` and use the helpers; they sit below `llm-agent-rag`, so the kit cannot move there (§11.2 item 1) |
| `QueryEmbedding`, `FallbackQueryEmbedding`, `TextOnlyEmbedding`; `symmetricEmbedder`, `asymmetricEmbedder` | implementations of the query-embedding contract and adapters that build an `IRetrievalEmbedder`; the store and embedder packages below `llm-agent-rag` import them (same reason) |
| the resilience decorators (`CircuitBreaker` — referenced by `interfaces/builder.ts` and `interfaces/health.ts` —, `CircuitBreakerEmbedder`, `CircuitBreakerLlm`, `RetryEmbedder`, `RetryBatchEmbedder`, `BatchChunkingEmbedder`, `composeResilientEmbedder`, …) and `isCallerCancellation` | embedder / LLM implementations, not RAG implementations: outside the goal's move (§11.2 item 1) |
| `rag/tool-indexing-strategy.ts` | deleted (§10.3) |

**Why there is no cycle (verified 2026-10-05 with `git grep` over `packages/llm-agent/src`):**

- The files that stay import a moved file only in the barrels (`index.ts`, `rag/index.ts`,
  `rag/providers/index.ts`, `rag/corrections/index.ts` — their export lines of moved names are
  deleted; `resilience/index.ts`'s one, `FallbackRag`, goes with D68) and in `interfaces/index.ts` / `interfaces/plugin.ts`
  (`IQueryExpander`, which moves to `interfaces/`). Nothing else.
- Every name a moved file takes from a file that stays (`matchesRagIdentity`,
  `QueryEmbedding`, `AbstractRagProvider`, `ImmutableEditStrategy`, the catalog helpers, the
  correction errors and metadata, the contracts) is already exported from the
  `@mcp-abap-adt/llm-agent` root, so a moved file imports it from there; `llm-agent` gains no
  export.
- **The one cycle found — `OllamaRag` (S11):** `ollama-embedder`'s `OllamaRag extends VectorRag`.
  With `VectorRag` in `llm-agent-rag`, `ollama-embedder` would import `llm-agent-rag`, which peers
  on `ollama-embedder` and lists it as a `tsconfig` reference — a package cycle and a `tsc -b`
  reference cycle. **This spec removes `OllamaRag`** (a 6-line convenience, no user in the repo;
  migration: `new VectorRag(symmetricEmbedder(new OllamaEmbedder(cfg)), cfg)`). The alternatives
  are in §17.18.
- A repo test pins it: nothing under `packages/llm-agent/src` and nothing under the store and
  embedder packages' `src/` imports `@mcp-abap-adt/llm-agent-rag`; `packages/llm-agent/package.json`
  does not name it.

**Importers switch** (in this PR): every file under `packages/llm-agent-libs`,
`packages/llm-agent-server-libs`, `packages/llm-agent-server`, `packages/llm-agent-rag` and
`scripts/` that imports a moved name from `@mcp-abap-adt/llm-agent` (35 files on 2026-10-05, plus
`llm-agent-rag`'s own `rag-factories.ts`, which now imports its siblings by relative path) imports
it from `@mcp-abap-adt/llm-agent-rag`. `llm-agent-libs`, `llm-agent-server-libs` and
`llm-agent-server` already declare `llm-agent-rag`.

### 11.4 Re-exports across packages (D59)

**Rule:** a package exports only the names it owns. A consumer — and every package of this repo —
imports a name from its owner. This PR adds no re-export, removes the ones its design had, and
removes the pre-existing ones (S12, below):

- `llm-agent-libs` exports no reranker (`ProbabilityReranker`, `LlmReranker`, `NoopReranker`,
  `TOOL_QUESTION`, `PASSAGE_QUESTION`, …): they are imported from `@mcp-abap-adt/llm-agent-reranker`.
  The 30.1.0 libs-root reranker exports are removed (§13).
- `llm-agent-libs` exports no RAG implementation; `llm-agent-rag` exports only its own files (no
  module re-exporting `@mcp-abap-adt/llm-agent`).
- `@mcp-abap-adt/llm-agent` exports no RAG implementation (D57).

**The pre-existing re-exports are removed too — S12, decided by the user on 2026-10-05 (§17.18).**
Found on 2026-10-05 by scanning every `export … from '<package>'` under `packages/*/src` **and**
every `import { X } from '<package>'` followed by `export { X }` / `export type { X }` (the second
form is how most of libs' root re-exports are written), then following each to the public entry
points (`package.json` `exports`). No package re-exports a third-party package.

**Rule for deciding:** a name is a re-export when a **public entry point** (a path in a package's
`exports`) exports it and its declaration lives in **another package**. Removed are the re-exports
on a public path. Kept are (a) libs' **internal** modules that re-export `llm-agent` contracts for
libs' own files (`health/types.ts`, `metrics/types.ts`, `tracer/types.ts`, `validator/types.ts`,
`session/types.ts`, `interfaces/mcp-connection-strategy.ts`, `logger/index.ts`, and the internal
barrels `pipeline/types.ts`, `plugins/types.ts`, `agent.ts`, `adapters/llm-adapter.ts`,
`metrics/in-memory-metrics.ts`), which no `exports` path reaches once the root lines go — they are
an import convenience inside one package, not a second public home (kept — decided by the user on
2026-10-05, below); and (b) names **declared** in
the exporting package, even when they are built from another package's type: libs'
`SmartAgentHandle = SmartAgentHandle<SmartAgent>` and `IStageHandler = IStageHandler<PipelineContext>`
(specialisations to libs' own classes — different types; kept — decided by the user on
2026-10-05, below). `llm-agent`'s `ITextLogger = ILogger` of `@mcp-abap-adt/interfaces-utils`
passes rule (b) too, but it is not a specialisation — it is the same type under a second name: the
user decided to **remove** it (below, migration line 70).

| Where | What it re-exports | Reaches | In this PR |
|---|---|---|---|
| `llm-agent-libs/src/index.ts` ← `agent.ts` | `OrchestratorError`, `SmartAgentResponse`, `StopReason` (`llm-agent`) | libs root | removed from the root (lines 54–56) |
| `llm-agent-libs/src/index.ts` ← `adapters/llm-adapter.ts` | `AgentCallOptions`, `BaseAgentLlmBridge` (`llm-agent`) | libs root | removed from the root (lines 52–53) |
| `llm-agent-libs/src/index.ts` ← `metrics/in-memory-metrics.ts` | `CounterSnapshot`, `HistogramSnapshot`, `MetricsSnapshot` (`llm-agent`) | libs root | removed from the root (lines 57–59) |
| `llm-agent-libs/src/index.ts` ← `pipeline/index.ts` ← `pipeline/types.ts` | `BuiltInStageType`, `ControlFlowType`, `StageDefinition`, `StageType` (`llm-agent`) | libs root | removed from the root (lines 60–63) |
| `llm-agent-libs/src/index.ts` ← `plugins/index.ts` ← `plugins/types.ts` | `IPluginLoader`, `LoadedPlugins`, `PluginExports` (`llm-agent`) | libs root | removed from the root (lines 64–66) |
| `llm-agent-server-libs/src/legacy/flat.ts` | `SmartAgentBuilder` (libs) — its only export | `./legacy/flat` | file deleted, the subpath removed from `exports` (line 67) |
| `llm-agent-server-libs/src/legacy/linear.ts` | `CoordinatorHandler` (libs) | `./legacy/linear` | the line removed; `LinearFactory` (own) stays (line 68) |
| `llm-agent-server-libs/src/legacy/dag.ts` | `DagCoordinatorHandler` (libs) | `./legacy/dag` | the line removed; `DagFactory`, `buildDagCoordinatorDeps` (own) stay (line 69) |
| `llm-agent-server/src/index.ts` | `export * from '@mcp-abap-adt/llm-agent-server-libs'` | nothing: the package's `exports` lists only `./package.json` (binary-only since 12.0.1), and no file imports `src/index.ts` | file deleted; no migration line (nothing could import it) |
| `llm-agent-libs/src/{health,metrics,tracer,validator,session}/types.ts`, `interfaces/mcp-connection-strategy.ts`, `logger/index.ts` | `llm-agent` contracts for libs' own files | internal modules only | kept (rule (a)) |
| `llm-agent-libs/src/adapters/index.ts` (`McpClientAdapter` of `llm-agent-mcp`), `interfaces/model-resolver.ts` (`IModelResolver`) | — | internal, and imported by no file | **deleted** (decided by the user on 2026-10-05): dead files — no file of any package (sources, tests, typechecks, `scripts/`, `test/`) imports them and no `exports` path reaches them; no migration line |
| `llm-agent/src/logger/text-logger.ts` | `ITextLogger = ILogger` of `@mcp-abap-adt/interfaces-utils` — declared in `llm-agent`, so not a re-export by the rule, but a second name for an ecosystem type | `llm-agent` root | **removed** (decided by the user on 2026-10-05): the file deleted, the root line removed; every use imports `ILogger` from `@mcp-abap-adt/interfaces-utils` (line 70) |
| `llm-agent-libs/src/reranker/types.ts` | `IReranker` (`llm-agent`) | internal | deleted with `src/reranker/` (Task 4B) |

`llm-agent-libs/src/index.ts`'s internal sources keep their local `export type { … }` lines (rule
(a)): only the root's lines change, so libs' own files compile unchanged. Every in-repo importer
of a removed root name switches to its owner (2026-10-05: `llm-agent-server-libs`
`smart-agent/http/chat-route-handler.ts`, `smart-agent/http/response-helpers.ts`,
`smart-agent/smart-server.ts`; `llm-agent-server` `smart-agent/server.ts`,
`smart-agent/__tests__/server.test.ts`; no importer of a `legacy/*` subpath in code). Docs that
show the old paths: `docs/INTEGRATION.md` (custom plugin loader), `docs/PIPELINES.md` ("Embedding
in code", `legacy/dag`), `packages/llm-agent-libs/README.md` ("type re-exports of the core
contracts").

**The guard** (§14.1): a repo test reads every package's public entry points (the `types` of each
`exports` path, after the build) with the TypeScript checker and fails when an exported name's
declaration lies outside the exporting package — so no package can re-export another's names
again, written either way.

**Decided by the user on 2026-10-05 — the four questions this section left open (§17.18):**

1. **`ITextLogger` is removed** from `@mcp-abap-adt/llm-agent` — it is `@mcp-abap-adt/interfaces-utils`'
   `ILogger` under a second name ("until a major", by its own comment; this is the major). Every
   in-repo use imports `ILogger` directly from `@mcp-abap-adt/interfaces-utils`; nothing re-exports
   it. Found on 2026-10-05 (19 occurrences in 11 files outside the CHANGELOGs, `docs/MIGRATION-v27.md`
   and `docs/superpowers/`): `llm-agent/src/logger/text-logger.ts` (the alias — deleted) and the root
   line of `llm-agent/src/index.ts` (removed); switched — 17 occurrences in 9 files:
   - `llm-agent/src/logger/normalise-logger.ts` (`AnyLogger`, `isTextLogger`, a doc comment): the
     file also uses `llm-agent`'s own event `ILogger`, so it imports the text one under a
     file-local import name (`import type { ILogger as InterfacesUtilsLogger } from
     '@mcp-abap-adt/interfaces-utils'`) — a binding inside one file, not an exported name;
   - tests `llm-agent/src/logger/normalise-logger.test.ts`,
     `llm-agent/src/resilience/embedder-resilience-text-logger.test.ts`,
     `llm-agent-mcp/src/strategies/lazy-connection-strategy-text-logger.test.ts`,
     `llm-agent-libs/src/__tests__/text-logger-di.test.ts` (all four are in
     `tsconfig.typecheck.json`, so `npm run typecheck` proves the switch);
   - doc comments in `llm-agent/src/interfaces/mcp-connection-strategy.ts`,
     `llm-agent-libs/src/builder.ts`, `llm-agent-libs/src/session/session-graph-factory.ts`;
   - `docs/INTEGRATION.md` (the text-logger example).

   `AnyLogger`, `isTextLogger` and `normaliseLogger` keep their names and behaviour (`AnyLogger` is
   still `ILogger | ILogger of interfaces-utils` — the same type). **Dependencies:** `llm-agent`
   already peers on `@mcp-abap-adt/interfaces-utils` `^1.1.0` (and its `.d.ts` already named it
   through the alias), and the root declares it as a dev dependency; `llm-agent-libs` and
   `llm-agent-mcp` use it only in tests, so each gets a `devDependencies` entry `^1.1.0` (from the
   registry, not a workspace package — no `tsconfig` reference). Migration line 70.
2. **libs' two dead internal files are deleted** — `src/adapters/index.ts` and
   `src/interfaces/model-resolver.ts`. Verified again on 2026-10-05: no file under `packages/`,
   `scripts/` or `test/` imports them (relative or by path, tests and typechecks included), and
   libs' `exports` (`.`, `./testing`, `./otel`) reaches neither. No migration line.
3. **`SmartAgentHandle` and libs' `IStageHandler` are kept** — specialisations declared in libs
   (rule (b)).
4. **libs' internal shims are kept** — internal, non-public modules for libs' own files (rule (a)).

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

- **No profile configured → no change on the success path.** Same records (golden test), same
  stages, same k semantics, same `RerankHandler` precedence, same YAML. A **failure** no longer
  passes for a success anywhere (fail loud, the behaviour table B1–B17 below).
- **This is a major release — breaking** (D57–D59, the goal's decision "No deprecated aliases").
  Old names are not kept; no package re-exports another package's names — neither the names
  this PR moves nor the pre-existing re-exports (S12, §11.4: lines 52–69); `ITextLogger`, a
  second name for an ecosystem type, is removed too (§11.4: line 70). Removed besides the
  table below: only the unexported `IToolIndexingStrategy` file, the unexported
  `createMakeDecisionModel` of the server binary (renamed `createMakeProbabilityDecision`),
  `llm-agent-server`'s `src/index.ts` (`export *` of server-libs), which no import could reach —
  the package's `exports` lists only `./package.json` —, and libs' two dead internal files
  `src/adapters/index.ts` and `src/interfaces/model-resolver.ts` (no `exports` path, no importer).
- **Migration table — one line per removed or moved name** (the CHANGELOG's **Breaking** section
  carries it as is; **75 lines**). Every name keeps its members and behaviour; only the name or the
  import path changes, except `FallbackRag` (line 5), `OllamaRag` (line 51) and the members of
  lines 71–75, which are removed:

  | # | Old name | Old import | New name | Import it from |
  |---|---|---|---|---|
  | 1 | `VectorRag` | `@mcp-abap-adt/llm-agent` | `VectorRag` | `@mcp-abap-adt/llm-agent-rag` |
  | 2 | `VectorRagConfig` | `@mcp-abap-adt/llm-agent` | `VectorRagConfig` | `@mcp-abap-adt/llm-agent-rag` |
  | 3 | `InMemoryRag` | `@mcp-abap-adt/llm-agent` | `InMemoryRag` | `@mcp-abap-adt/llm-agent-rag` |
  | 4 | `InMemoryRagConfig` | `@mcp-abap-adt/llm-agent` | `InMemoryRagConfig` | `@mcp-abap-adt/llm-agent-rag` |
  | 5 | `FallbackRag` | `@mcp-abap-adt/llm-agent` | — (removed, D68) | — no replacement in the library; a consumer that wants a degraded mode writes its own `IRag` wrapper |
  | 6 | `OverlayRag` | `@mcp-abap-adt/llm-agent` | `OverlayRag` | `@mcp-abap-adt/llm-agent-rag` |
  | 7 | `SessionScopedRag` | `@mcp-abap-adt/llm-agent` | `SessionScopedRag` | `@mcp-abap-adt/llm-agent-rag` |
  | 8 | `ActiveFilteringRag` | `@mcp-abap-adt/llm-agent` | `ActiveFilteringRag` | `@mcp-abap-adt/llm-agent-rag` |
  | 9 | `SimpleRagRegistry` | `@mcp-abap-adt/llm-agent` | `SimpleRagRegistry` | `@mcp-abap-adt/llm-agent-rag` |
  | 10 | `ragStoreKey` | `@mcp-abap-adt/llm-agent` | `ragStoreKey` | `@mcp-abap-adt/llm-agent-rag` |
  | 11 | `InMemoryRagProvider` | `@mcp-abap-adt/llm-agent` | `InMemoryRagProvider` | `@mcp-abap-adt/llm-agent-rag` |
  | 12 | `InMemoryRagProviderConfig` | `@mcp-abap-adt/llm-agent` | `InMemoryRagProviderConfig` | `@mcp-abap-adt/llm-agent-rag` |
  | 13 | `VectorRagProvider` | `@mcp-abap-adt/llm-agent` | `VectorRagProvider` | `@mcp-abap-adt/llm-agent-rag` |
  | 14 | `VectorRagProviderConfig` | `@mcp-abap-adt/llm-agent` | `VectorRagProviderConfig` | `@mcp-abap-adt/llm-agent-rag` |
  | 15 | `SimpleRagProviderRegistry` | `@mcp-abap-adt/llm-agent` | `SimpleRagProviderRegistry` | `@mcp-abap-adt/llm-agent-rag` |
  | 16 | `WeightedFusionStrategy` | `@mcp-abap-adt/llm-agent` | `WeightedFusionStrategy` | `@mcp-abap-adt/llm-agent-rag` |
  | 17 | `RrfStrategy` | `@mcp-abap-adt/llm-agent` | `RrfStrategy` | `@mcp-abap-adt/llm-agent-rag` |
  | 18 | `VectorOnlyStrategy` | `@mcp-abap-adt/llm-agent` | `VectorOnlyStrategy` | `@mcp-abap-adt/llm-agent-rag` |
  | 19 | `Bm25OnlyStrategy` | `@mcp-abap-adt/llm-agent` | `Bm25OnlyStrategy` | `@mcp-abap-adt/llm-agent-rag` |
  | 20 | `CompositeStrategy` | `@mcp-abap-adt/llm-agent` | `CompositeStrategy` | `@mcp-abap-adt/llm-agent-rag` |
  | 21 | `CompositeStrategyEntry` | `@mcp-abap-adt/llm-agent` | `CompositeStrategyEntry` | `@mcp-abap-adt/llm-agent-rag` |
  | 22 | `ISearchStrategy` | `@mcp-abap-adt/llm-agent` | `ISearchStrategy` | `@mcp-abap-adt/llm-agent-rag` |
  | 23 | `ISearchCandidate` | `@mcp-abap-adt/llm-agent` | `ISearchCandidate` | `@mcp-abap-adt/llm-agent-rag` |
  | 24 | `ISearchQuery` | `@mcp-abap-adt/llm-agent` | `ISearchQuery` | `@mcp-abap-adt/llm-agent-rag` |
  | 25 | `IScoredResult` | `@mcp-abap-adt/llm-agent` | `IScoredResult` | `@mcp-abap-adt/llm-agent-rag` |
  | 26 | `ISearchContext` | `@mcp-abap-adt/llm-agent` | `ISearchContext` | `@mcp-abap-adt/llm-agent-rag` |
  | 27 | `NoopQueryPreprocessor` | `@mcp-abap-adt/llm-agent` | `NoopQueryPreprocessor` | `@mcp-abap-adt/llm-agent-rag` |
  | 28 | `NoopDocumentEnricher` | `@mcp-abap-adt/llm-agent` | `NoopDocumentEnricher` | `@mcp-abap-adt/llm-agent-rag` |
  | 29 | `TranslatePreprocessor` | `@mcp-abap-adt/llm-agent` | `TranslatePreprocessor` | `@mcp-abap-adt/llm-agent-rag` |
  | 30 | `ExpandPreprocessor` | `@mcp-abap-adt/llm-agent` | `ExpandPreprocessor` | `@mcp-abap-adt/llm-agent-rag` |
  | 31 | `IntentEnricher` | `@mcp-abap-adt/llm-agent` | `IntentEnricher` | `@mcp-abap-adt/llm-agent-rag` |
  | 32 | `PreprocessorChain` | `@mcp-abap-adt/llm-agent` | `PreprocessorChain` | `@mcp-abap-adt/llm-agent-rag` |
  | 33 | `LlmQueryExpander` | `@mcp-abap-adt/llm-agent` | `LlmQueryExpander` | `@mcp-abap-adt/llm-agent-rag` |
  | 34 | `NoopQueryExpander` | `@mcp-abap-adt/llm-agent` | `NoopQueryExpander` | `@mcp-abap-adt/llm-agent-rag` |
  | 35 | `buildRagCollectionToolEntries` | `@mcp-abap-adt/llm-agent` | `buildRagCollectionToolEntries` | `@mcp-abap-adt/llm-agent-rag` |
  | 36 | `RagCallerIdentity` | `@mcp-abap-adt/llm-agent` | `RagCallerIdentity` | `@mcp-abap-adt/llm-agent-rag` |
  | 37 | `RagCollectionToolOptions` | `@mcp-abap-adt/llm-agent` | `RagCollectionToolOptions` | `@mcp-abap-adt/llm-agent-rag` |
  | 38 | `RagToolContext` | `@mcp-abap-adt/llm-agent` | `RagToolContext` | `@mcp-abap-adt/llm-agent-rag` |
  | 39 | `RagToolEntry` | `@mcp-abap-adt/llm-agent` | `RagToolEntry` | `@mcp-abap-adt/llm-agent-rag` |
  | 40 | `IDecisionModel` | `@mcp-abap-adt/llm-agent` | `IProbabilityDecision` | `@mcp-abap-adt/llm-agent` |
  | 41 | `DecisionReranker` | `@mcp-abap-adt/llm-agent-libs` | `ProbabilityReranker` | `@mcp-abap-adt/llm-agent-reranker` |
  | 42 | `DecisionRerankerOptions` | `@mcp-abap-adt/llm-agent-libs` | `ProbabilityRerankerOptions` | `@mcp-abap-adt/llm-agent-reranker` |
  | 43 | `DECISION_RERANK_DEFAULT_TASK` | `@mcp-abap-adt/llm-agent-libs` | `PROBABILITY_RERANK_DEFAULT_TASK` | `@mcp-abap-adt/llm-agent-reranker` |
  | 44 | `DECISION_RERANK_DEFAULT_CRITERIA` | `@mcp-abap-adt/llm-agent-libs` | `PROBABILITY_RERANK_DEFAULT_CRITERIA` | `@mcp-abap-adt/llm-agent-reranker` |
  | 45 | `LlmReranker` | `@mcp-abap-adt/llm-agent-libs` | `LlmReranker` | `@mcp-abap-adt/llm-agent-reranker` |
  | 46 | `NoopReranker` | `@mcp-abap-adt/llm-agent-libs` | `NoopReranker` | `@mcp-abap-adt/llm-agent-reranker` |
  | 47 | `TOOL_QUESTION` | `@mcp-abap-adt/llm-agent-libs` | `TOOL_QUESTION` | `@mcp-abap-adt/llm-agent-reranker` |
  | 48 | `PASSAGE_QUESTION` | `@mcp-abap-adt/llm-agent-libs` | `PASSAGE_QUESTION` | `@mcp-abap-adt/llm-agent-reranker` |
  | 49 | `wrapDecisionModel` | `@mcp-abap-adt/llm-agent-libs` | `wrapProbabilityDecision` | `@mcp-abap-adt/llm-agent-libs` |
  | 50 | `BuildAgentDeps.makeDecisionModel` | `@mcp-abap-adt/llm-agent-server-libs` (the key in your `BuildAgentDeps`) | `BuildAgentDeps.makeProbabilityDecision` | `@mcp-abap-adt/llm-agent-server-libs` (same function, same signature — rename the key) |
  | 51 | `OllamaRag` | `@mcp-abap-adt/ollama-embedder` | removed — `new VectorRag(symmetricEmbedder(new OllamaEmbedder(cfg)), cfg)` | `VectorRag` from `@mcp-abap-adt/llm-agent-rag`, `symmetricEmbedder` from `@mcp-abap-adt/llm-agent`, `OllamaEmbedder` from `@mcp-abap-adt/ollama-embedder` (S11) |
  | 52 | `AgentCallOptions` | `@mcp-abap-adt/llm-agent-libs` | `AgentCallOptions` | `@mcp-abap-adt/llm-agent` |
  | 53 | `BaseAgentLlmBridge` | `@mcp-abap-adt/llm-agent-libs` | `BaseAgentLlmBridge` | `@mcp-abap-adt/llm-agent` |
  | 54 | `OrchestratorError` | `@mcp-abap-adt/llm-agent-libs` | `OrchestratorError` | `@mcp-abap-adt/llm-agent` |
  | 55 | `SmartAgentResponse` | `@mcp-abap-adt/llm-agent-libs` | `SmartAgentResponse` | `@mcp-abap-adt/llm-agent` |
  | 56 | `StopReason` | `@mcp-abap-adt/llm-agent-libs` | `StopReason` | `@mcp-abap-adt/llm-agent` |
  | 57 | `CounterSnapshot` | `@mcp-abap-adt/llm-agent-libs` | `CounterSnapshot` | `@mcp-abap-adt/llm-agent` |
  | 58 | `HistogramSnapshot` | `@mcp-abap-adt/llm-agent-libs` | `HistogramSnapshot` | `@mcp-abap-adt/llm-agent` |
  | 59 | `MetricsSnapshot` | `@mcp-abap-adt/llm-agent-libs` | `MetricsSnapshot` | `@mcp-abap-adt/llm-agent` |
  | 60 | `BuiltInStageType` | `@mcp-abap-adt/llm-agent-libs` | `BuiltInStageType` | `@mcp-abap-adt/llm-agent` |
  | 61 | `ControlFlowType` | `@mcp-abap-adt/llm-agent-libs` | `ControlFlowType` | `@mcp-abap-adt/llm-agent` |
  | 62 | `StageDefinition` | `@mcp-abap-adt/llm-agent-libs` | `StageDefinition` | `@mcp-abap-adt/llm-agent` |
  | 63 | `StageType` | `@mcp-abap-adt/llm-agent-libs` | `StageType` | `@mcp-abap-adt/llm-agent` |
  | 64 | `IPluginLoader` | `@mcp-abap-adt/llm-agent-libs` | `IPluginLoader` | `@mcp-abap-adt/llm-agent` |
  | 65 | `LoadedPlugins` | `@mcp-abap-adt/llm-agent-libs` | `LoadedPlugins` | `@mcp-abap-adt/llm-agent` |
  | 66 | `PluginExports` | `@mcp-abap-adt/llm-agent-libs` | `PluginExports` | `@mcp-abap-adt/llm-agent` |
  | 67 | `SmartAgentBuilder` | `@mcp-abap-adt/llm-agent-server-libs/legacy/flat` (subpath removed) | `SmartAgentBuilder` | `@mcp-abap-adt/llm-agent-libs` |
  | 68 | `CoordinatorHandler` | `@mcp-abap-adt/llm-agent-server-libs/legacy/linear` | `CoordinatorHandler` | `@mcp-abap-adt/llm-agent-libs` |
  | 69 | `DagCoordinatorHandler` | `@mcp-abap-adt/llm-agent-server-libs/legacy/dag` | `DagCoordinatorHandler` | `@mcp-abap-adt/llm-agent-libs` |
  | 70 | `ITextLogger` | `@mcp-abap-adt/llm-agent` | `ILogger` | `@mcp-abap-adt/interfaces-utils` |
  | 71 | `SimpleRagRegistry.replaceRag` (method) | `@mcp-abap-adt/llm-agent` | — (removed, D68) | — register the store as it should be served |
  | 72 | `SmartAgentBuilder.withCircuitBreakers` (method) | `@mcp-abap-adt/llm-agent-libs` | — (removed, D68) | — wrap the embedder with `withCircuitBreaker(embedder, breaker)` (`@mcp-abap-adt/llm-agent`) and list the breaker in `HealthCheckerDeps.circuitBreakers` |
  | 73 | `LazyOptions.fallback` (option of `lazy`) | `@mcp-abap-adt/llm-agent-libs` | — (removed, U6) | — an init failure propagates; a consumer that wants a substitute wraps the proxy itself |
  | 74 | `SmartAgentConfig.toolUnavailableTtlMs` (field) | `@mcp-abap-adt/llm-agent-libs` | `SmartAgentBuilder.withToolAvailabilityPolicy(new HeuristicToolAvailabilityPolicy({ ttlMs }))` (U8) | `HeuristicToolAvailabilityPolicy` from `@mcp-abap-adt/llm-agent-libs`; inject nothing for no blacklist (the new default) |
  | 75 | `optionalNumber` (function) | `@mcp-abap-adt/llm-agent-server-libs` | — (removed, D83 (7)) | — the resolved config's `temperature` / `classifierTemperature` are numbers (validated at start); read them as they are |

  - Line 5, lines 71–72 (D68): `FallbackRag` is removed with the two members that existed only for
    it; the builder wraps no store, and `withCircuitBreaker(config)` builds the main-LLM breaker
    only (behaviour note below).
  - Line 73 (U6): `lazy(factory, { fallback })` no longer compiles (excess property); a JavaScript
    caller's `fallback` is ignored and the init error reaches the call (behaviour row B14).
  - Line 74 (U8): a consumer that set `toolUnavailableTtlMs` and wants 30.1.0's blacklist injects
    `HeuristicToolAvailabilityPolicy({ ttlMs })`; one that set nothing had the blacklist on by
    default and now has none (behaviour row B15). The server's YAML key `agent.toolUnavailableTtlMs`
    stays and now means "inject the heuristic policy with this TTL"; unset → no blacklist.
  - Line 75 (D83 (7)): `optionalNumber(value)` coerced any value with `Number()` (`"warm"` →
    `NaN`); the start now validates the temperatures, so a `SmartServerConfig` from
    `resolveSmartServerConfig` holds numbers. A consumer that called it reads the field directly
    (a value of its own it validates itself).
  - Lines 1–4 and 6–39: add `@mcp-abap-adt/llm-agent-rag` as a dependency. A package that
    `llm-agent-rag` itself depends on (a store or embedder package) cannot import them (§11.3).
  - Lines 41–48: add `@mcp-abap-adt/llm-agent-reranker` as a dependency.
  - Line 40: a class implementing `IDecisionModel` changes only the name it implements (same
    members).
  - Lines 52–66: the same names were always declared in `@mcp-abap-adt/llm-agent`, which
    `llm-agent-libs` peers on — import them from there (add it as a dependency if you have not).
  - Lines 67–69: the classes were always `llm-agent-libs`' — import them from its root. The
    subpath `@mcp-abap-adt/llm-agent-server-libs/legacy/flat` is gone (it held only
    `SmartAgentBuilder`); `./legacy/linear` keeps `LinearFactory`, `./legacy/dag` keeps
    `DagFactory` and `buildDagCoordinatorDeps`, `./legacy/stepper` is unchanged.
  - Line 70: the same type under its owner's name. `@mcp-abap-adt/interfaces-utils` is already a
    peer of `@mcp-abap-adt/llm-agent`, so it is installed. A file that also imports
    `@mcp-abap-adt/llm-agent`'s own `ILogger` (the event logger — a different type) imports one of
    the two under a local import name (`import type { ILogger as TextLogger } from
    '@mcp-abap-adt/interfaces-utils'`).
  - Line 50: a consumer that still passes `makeDecisionModel` gets a compile error (excess property
    on the `BuildAgentDeps` literal); a JavaScript consumer that passes it is not called — the
    config that asks for a probability decision then fails at startup with `BuildAgentDeps.makeProbabilityDecision is required: …`.
- **Contract types moved out of implementation files** (`IQueryExpander`, `IQueryPreprocessor`,
  `IDocumentEnricher` → `interfaces/`): same names, same root exports — no migration.
- **A bound tools store is filled once, at its creation; where its records come from is the
  consumer's fill source** (§3.10, §6.3, §6.5). Without a profile nothing changes. With one and no
  source chosen, `live` is 30.1.0's behaviour through the profile. **Migration note** (CHANGELOG):
  a consumer that ships a tools corpus builds it in its build step with `buildToolsCorpus` and
  ships the file; the server loads it at every start with the `corpus` source
  (`fill: { corpus: … }`, or `ToolsCorpusLoader` in a builder consumer's composition root) — the
  store, in-memory or persistent, is **cleared** and the corpus written; the `profile` /
  `embedder` names must be the same in the build step and in the server's configuration. There is
  no deploy step.
- **Behaviour note — a bound profile is not re-indexed on `toolsChanged`** (D46). With a profile
  bound, a reconnect that reports `toolsChanged` writes nothing into the tools store, whatever its
  fill source (one `mcp` debug line). A consumer who plugs an MCP server in at runtime fills the
  new tools in its own pipeline (`bound.index`). Without a profile, 30.1.0's re-vectorize on
  `toolsChanged` is unchanged. **Migration note** (CHANGELOG): none for a 30.1.0 consumer —
  profiles and fill sources are new in this release.
- **Behaviour note — no store falls back to an in-memory copy** (D68, §10.4). Before, with
  `withCircuitBreaker(config)` or `withCircuitBreakers({ embedder })` set, the builder wrapped every
  registered store in `FallbackRag`, which answered from an in-memory copy while the embedder
  breaker was open. Now, with the circuit breaker on, an embedder outage makes retrieval fail with
  an error instead: the open breaker throws `CIRCUIT_OPEN` without calling the provider, and the
  store's query returns that error. D68 does not change what a stage does with a failed query
  (in 30.1.0 the `rag-query` stage records no results for that store and the request continues;
  the fail-loud sweep makes that an error too — §10.5.4 R5, behaviour row B2).
  Registry entries
  and `handle.ragStores` are the stores as registered; `withCircuitBreaker(config)`'s
  `handle.circuitBreakers` holds the main-LLM breaker only (the embedder breaker it added was never
  fed, the builder wraps no embedder). **Changelog** ("Breaking", "Removed"). **Migration note:**
  to fail fast on an embedder outage, wrap the embedder with `withCircuitBreaker(embedder, breaker)`
  below its document/query role (the server does) and list the breaker in
  `HealthCheckerDeps.circuitBreakers`; to keep a degraded mode, write your own `IRag` wrapper
  (implement `IRagDecorator`). *Replaces the two behaviour notes on `FallbackRag`'s writer (D52,
  D62), withdrawn.*
- **Behaviour table — fail loud** (D69–D74, §10.5). **Breaking behaviour, not names**: no import
  changes, but a failure that a 30.1.0 consumer saw as a success (an empty, partial, stale or
  substituted answer) is now an error. The success paths are unchanged (the golden test holds). The
  CHANGELOG's **Breaking** section carries this table as is, after the migration table:

  | # | What fails | 30.1.0 | Now | What a consumer does |
  |---|---|---|---|---|
  | B1 | any pipeline stage (a handler throws, or sets `ctx.error`) | an empty / truncated stream ending normally; `process()` `ok: true` | the stream's last item is `{ ok: false, error }`; `process()` returns it; root span `error` (D70) | handle `ok: false` from `streamProcess` / `process` (already in the contract — it now happens) |
  | B2 | a RAG store's query in `rag-query`, `tool-select`, `skill-select`, a re-select, the legacy orchestrator, a sub-agent source; a store a stage names but the registry lacks | the store is skipped, the request continues | the request fails with the store's code (`CIRCUIT_OPEN`, `QUERY_ERROR`, …) or `RAG_STORE_MISSING` | for a degraded mode, inject your own `IRag` wrapper that answers what you want while the store is down (D68) |
  | B3 | the pipeline's query embedder (a real one) | the store re-embedded the text with its own embedder | the store returns the error (`FallbackQueryEmbedding` covers only `TextOnlyEmbedding`, D73) | configure a working embedder, or none (the store then embeds) |
  | B4 | a reranker — `RerankedRetrieval`, `RerankAllRetrieval`, the `rerank` stage, the legacy orchestrator (and `StagedRetrieval`, new in this release) | stage-1 / original order, `ok: true` | `RERANK_ERROR` (D71). `onFailure` existed only in this spec's drafts and was never released, so no config carries it | for unranked results on failure, inject a reranker (`IReranker`) that answers them itself |
  | B5 | an MCP client's `listTools` (client, adapter cache, registry, `tool-select`, `tool-loop`, `tools-rag-handle`, the server's bridge and snapshot); a slot that failed to connect | the client's tools left out (or stale), the request continues | `MCP_UNAVAILABLE` / the client's `McpError` code | make the server reachable; a consumer that wants to run on fewer servers builds that pipeline with those clients only |
  | B6 | an LLM step: `translate`, `expand`, `summarize`, `history-upsert`, the query preprocessors and enricher, the stepper's need-resolver / formalizer / planner sections, the DAG planner's empty plan | the original text / full history / a raw-prompt plan | the step's error (`LLM_ERROR`, `QUERY_EXPAND_ERROR`, `COORDINATOR_*`) | — (a consumer that wants untranslated text on failure injects its own handler / preprocessor) |
  | B7 | invalid tool-call JSON from the LLM | the tool ran with `{}` | the tool does not run; the LLM gets an error tool result (`TOOL_ARGUMENTS_JSON_PARSE_FAILED`) | — |
  | B8 | skills: a store / `listSkills` / a `SKILL.md` that cannot be read, a plugin loader error, an incompatible generation, an unknown `skills.type`; a skill whose embedding or write into the tools store fails (`vectorizeSkills`, D75) | the skill (or all skills) left out — for a failed skill write, a warning and `build()` / start succeeded | `SKILL_ERROR` / `SkillsIncompatibleError` / `build()` or start fails; a failed skill write rejects `build()`, the server's start (or a worker's construction) and `fillToolsBinding` with a `SkillError` naming the skill, the store's error as `cause` | fix the skill source, or the tools store / its embedder the error names; `strict: false` keeps its carry-forward, now an explicit opt-in (B12) |
  | B9 | `/health` with a configured component not working (`degraded`) | HTTP 200 | HTTP **503**; body unchanged; every RAG store probed; an MCP `value: false` or unanswered probe is not OK (D72) | a load balancer that treated `degraded` as up now takes the instance out — intended |
  | B10 | server: persisted collections at session start, a corrupt session bundle / run-scope entry / artifact claim, the session-meta start record, a config reload's drain, the eager tool catalog, an explicit `--env` / `--secrets-dir`, a stepper role without an LLM config, `GET /v1/models` | the part skipped, an older state, a stub model, a 200 placeholder | an error: the session / request fails, `STATE_CORRUPT`, the reload reports failure (`config_reload_failed`; no rollback — the server is not ready until a whole config applies, D82), the start fails (exit 1, `ConfigValidationError`), 502 | fix the configuration or the state the error names |
  | B11 | providers: `sap-aicore-llm` `getModels`, a malformed SSE line (OpenAI, Anthropic), a short or empty SAP AI Core embedding batch, a Qdrant collection whose info cannot be read | the configured model / a silently truncated stream / short or empty vectors / the dimension check skipped for good | `LLM_ERROR` / `EMBED_ERROR` / `UPSERT_ERROR` | — |
  | B12 | a skill plugin source whose `acquire` fails (U2) | carried forward by default (`strict: false` was the default) | the default is `strict: true`: the source's group fails and is reported in `omitted`; nothing old is served for it | set `strict: false` (`skillPlugins.strict: false` in YAML) to keep the carry-forward, reported in `carried` |
  | B13 | a coordinator step naming an agent the registry lacks, under `HybridDispatch` (U5) | silently run by the fallback dispatcher | a failed step naming the agent and the registered ones — `COORDINATOR_STEP_FAILED` under `failPolicy: 'abort'`, a reported failed step under `'continue'`; a step naming no agent still goes to the fallback | register the agent, or plan the step without an agent |
  | B14 | `lazy`'s factory fails while a `fallback` was given (U6) | calls went to the fallback instance | the init error reaches every call (the option is removed, migration line 73) | wrap the proxy in your own substitute if you want one |
  | B15 | a tool error whose text matches "not found", "permission", … (U8) | the tool blocked for the session for 10 min by default ("temporarily unavailable") | nothing blocked unless a policy is injected; the error reaches the LLM as the tool result, as every tool error does | inject `HeuristicToolAvailabilityPolicy({ ttlMs })` (or set `agent.toolUnavailableTtlMs` in the server YAML) for 30.1.0's blacklist; `PUT /v1/config` with `toolUnavailableTtlMs` now answers 400 (the key never changed a live agent) |
  | B16 | a bulk write of the startup tool catalog into an unbound tools store (`upsertManyPrecomputedRaw` answers `ok: false` or throws, D79) | the tools written again one by one; the catalog complete when those writes succeeded | no per-tool write: the catalog is incomplete (`complete: false`, every tool of the batch in `failed`, `writeFailure: 'bulk write failed: <error>'`), the summary log line names it, `/health` answers 503 | fix the store the error names; a store that cannot take a bulk write does not implement `upsertManyPrecomputedRaw` (the per-record path is then the only one) |
  | B17 | a config change that fails to apply — `PUT /v1/config` whose apply (a setter, the startup agent's `reconfigure` / `applyConfigUpdate`, the mirror), worker drain or session invalidation fails; a file reload whose drain or invalidation fails, or whose file cannot be read, parsed or resolved (D80, D82, D82 (9), V6, V10) | `PUT`: a failed invalidation swallowed (200 with the new config); a failed drain or a throwing `reconfigure`: 500 from the server's catch-all with the new config left applied, the server still ready. Reload: the failure logged, the reload counted applied; a file that cannot be read or parsed logged as `config_reload_error`, the server ready on the previous config | `PUT`: **500** `server_error` naming the failure (`config update failed, the server is not ready until a whole config applies — …`); reload: `config_reload_failed` — for a file that cannot be read or parsed too (`… — cannot read the config file: <the error>`), in queue order with the `PUT`s. **No rollback:** what the change applied stays. The server is **not ready** until a whole config applies: `/health` 503 with `configNotApplied: { reason, source, at }`, the chat routes 503 `service_unavailable` (`config not applied — …`). Config changes run one at a time (a `PUT` waits for a reload or another `PUT` in flight). **While not ready, only a whole config is accepted** (D82 (8)): a `PUT` missing a section the route can change (`agent`; `models` when the server has a model resolver) answers **409** `invalid_request_error`, code `config_not_applied` (`server not ready — send the whole config: <missing sections>`) and changes nothing | fix what the error names, then send the whole config — a `PUT /v1/config` carrying every section (`models` and `agent`; `agent` alone when the server has no model resolver), or save the YAML file (a reload re-reads all of it); a partial `PUT` is refused until then; the first whole config that applies makes the server ready. `GET /v1/config` shows the live config |
  | B18 | *Withdrawn by D82 (§17.30).* `SmartAgent.reconfigure` is unchanged from 30.1.0: a pipeline `reconfigure` hook that throws leaves the swap half-applied, as before; on the server that is a failed `PUT` (B17) — 500, and not ready until a whole config applies | — | — | — |
  | B19 | a config field with an invalid value — a file reload or a `PUT /v1/config` carrying a value that is neither a number nor a number literal string, a non-integer, an out-of-range number, a flag other than `true` / `false` / `"true"` / `"false"`, or an empty string (§10.5.9 *Config field rules*, D83, D83 (6)) | reload: the value coerced (`Number()`, `Boolean()`) and applied — `agent.maxIterations: oops` → `NaN` (no iteration limit), `showReasoning: "false"` → `true`; `PUT`: any JSON value of a whitelisted field applied as is. `ConfigWatcher`'s `reload` event carried the coerced values | reload: the transaction fails before anything applies — `config_reload_failed` naming each invalid field, the server not ready (B17); `PUT`: **400** `invalid_request_error` naming each invalid field, nothing applied or queued. `ConfigWatcher`'s `reload` event carries the file's values as read (`HotReloadableInput`). A number literal string (`"25"`) and `"true"` / `"false"` are accepted and applied as the number / flag (D83 (6)) | fix the value the error names, then save the file or send the `PUT` again; a direct consumer of `ConfigWatcher` validates the event's values before it applies them |
  | B20 | a config field read at start with an invalid value — a field of the *Config field rules* table or of the *Start-only fields* table, in the server's YAML, a worker file, `skillPlugins`, the stepper's pipeline section, the `ResolveConfigArgs` overrides `agent-show-reasoning` / `log-dir` / `port` / `mcp-args`, or `PORT` (§10.5.9, D83 (5), (7)) | coerced at start with `Number()` / `Boolean()` / `String()` and applied: `agent.maxIterations: oops` → `NaN` (no iteration limit), `showReasoning: "false"` → `true`, `agent.historyRecencyWindow: oops` → `NaN`, `rag.store.autoCreateSchema: "yes"` → `false`, `skillPlugins.strict: "false"` → `true`, `llm.temperature: warm` → `NaN`, `llm.maxTokens: " 25"` → 25, `mcp.args: [a, b]` → `"a,b"`, `agent.heartbeatIntervalMs: oops` → the keep-alive disabled with a console warning, an empty prompt read as absent | **the start fails, exit code 1**: `Error: invalid config — <field> <rule>, got <value>` on stderr (every invalid field of the main file in one line, the reload's and the `PUT`'s message; a worker file's error names the worker and its path; `skillPlugins` and the stepper's section in their own error); nothing is built. A number literal string (`"25"`, e.g. from `${VAR}`) and `"true"` / `"false"` pass (D83 (6)) | write the value as the rule says — a number or a number literal, `true` / `false` (or `"true"` / `"false"`), a non-empty string, one of the listed names; a `${VAR}` must hold such a value |
  | B21 | a hot reload of a file whose reloadable field is written as `${VAR}` / `${VAR:-default}` (§10.5.9 *The start config*, D83 (8)) | not substituted: a number field applied `NaN` (`Number("${MAX}")`), a flag `true`, a prompt the literal text `${VAR}`; `rag.store.type: ${STORE}` was not `in-memory`, so the weights were not reloaded | substituted as at start — the same function, syntax and environment, over the whole file before a field is read; the value then goes through its rule (an unset variable with no default is `""` and fails its field: the reload fails, the server not ready, B17). `ConfigWatcher` gains the optional `resolveDocument`; without it (a direct consumer) the event's values are the file's as written, as before | none for a variable that holds a valid value; a variable the reload cannot resolve to a valid value fails the reload as it fails the start — set it in the server's environment (a reload does not re-read `--env` files) |
  | B22 | a config field read by a cast with no check — the *Cast-read fields* table of §10.5.9 (D83 (9)): `agent.retry`, `agent.toolSelection`, `agent.externalToolsValidationMode`, `mcp` and `mcp[]` entry fields, `llm.url` / `llm.model` (and each role's), `host`, `mode`, `pluginDir`, `plugins`, `skills`, `pipeline.config`, the linear / DAG / controller / stepper sections' cast fields | the value reached its consumer as it was: `retry.retryOn: ["429"]` never matched, `toolSelection.strategy: ""` meant none, `mcp.url: ${MCP_ENDPOINT}` unset started a server without MCP, `budgets.maxSteps: "20"` was a string, a stepper plan node without a goal or a `knowledgeSeed` entry without text was dropped, `flow.evaluator.enabled: "false"` kept the evaluator on, an unknown key of `agent.retry` / `agent.toolSelection` / `mcp` / the controller's blocks was read by nobody, an `mcp[]` entry's `type: none` connected as `http` | **the start fails** with the same `invalid config — <field> <rule>, got <value>`: the main file's fields in one error from `resolveSmartServerConfig` (the CLI exits 1); a pipeline section's in one error when the server builds the pipeline at start (`parseLinearSettings`, `parseDagSettings`, `parseControllerSettings`, `parseStepperCoordinatorConfig` throw one `ConfigFieldError` for their section, same signatures). A number literal string (`"20"`, `"429"`) and `"true"` / `"false"` pass and are applied as the number / flag. `budgets.maxWaitMs: "600000"` now passes (it was refused) | write the value as its rule says; drop or fix the key the error names; quote a header value or a model name YAML reads as a number; set `mcp.url` (an empty one is no longer "no MCP" — write `type: none` for that) |
- **Named compositions carry no tuned numbers** (D55): `mcpToolsVariants` has `baseline`,
  `faceted` and `faceted-rerank`; pools and cuts default to the caller's k; `faceted-rerank`
  requires `poolItems`. New in this release, so nothing released changes.
- **Single-flight worker construction is not in this release** (D45): the 30.1.0 race of two
  sessions constructing one worker together after a drain is unchanged here and tracked as a
  separate issue (§15).
- **The caller's k caps every cut** (approved review finding 1). 30.1.0 has no item cuts, so
  nothing released changes; `FixedItemsCut` is new in this spec and is a ceiling from the start.
- Added, all optional: the contracts of §3 (incl. `IToolsFillSource`, §3.10), one builder method,
  the corpus API (`buildToolsCorpus`, `parseToolsCorpus`, `ToolsCorpusLoader`) and the three fill
  sources (libs, §6.5), the YAML section `rag.profiles`
  (key `tools` only, S8; its `fill` key), the value `sap-aicore` for the existing `decision.provider` (with
  `deploymentId`, `model`, `resourceGroup`), optional health fields, the embedder capability,
  telemetry options on the 30.1.0 rerank strategies, the optional seam
  `BuildAgentDeps.makeRelevanceDecision`, `BuildAgentDeps.makeProbabilityDecision` (the renamed
  probability seam; `makeDecisionModel` removed — table line 50), two new packages (`@mcp-abap-adt/llm-agent-reranker`,
  `@mcp-abap-adt/sap-aicore-decision`);
  from the user's U1–U10 decisions (§10.5.12): `IToolAvailabilityPolicy`,
  `HeuristicToolAvailabilityPolicy`, `SmartAgentBuilder.withToolAvailabilityPolicy`,
  `SmartAgentDeps.toolAvailabilityPolicy`, `PipelineContext.toolAvailabilityPolicy` (U8),
  `FallbackLlmCallStrategy`'s `{ fallbackCount }` option (U1),
  `ToolCatalogStatus.batchFailures` / `IndexReport.batchFailures` /
  `HealthComponentStatus.toolCatalog.batchFailures` (U7); from D79: `ToolCatalogStatus.writeFailure`;
  from D82: `/health`'s `configNotApplied` body field and `writeNotReady`'s optional `message`;
  from D83: `HotReloadableInput` (libs; `ConfigWatcher`'s `reload` event now carries it, B19);
  from D83 (8): `ConfigWatcherOptions.resolveDocument` (libs; B21).
- **A consumer with its own composition root** that wants Cohere supplies `makeRelevanceDecision`
  (build `SapAiCoreRelevanceDecision` with a bearer credential and `apiBaseUrl`); its existing
  probability seam function compiles unchanged under the key `makeProbabilityDecision` (table line
  50), since `SmartServerDecisionConfig` only gains a provider value and optional fields (§17.5).
- Release: a **major** version (D57–D59: names removed and moved without aliases). The plan does
  no version bump and no publish (the user does); its docs task says the release is a major. The
  new packages are published at the same version, in the order of §11.
- Opting in on a persistent tools store filled by `live` = a fresh collection; the `corpus` source
  clears the store at every start (§7.8).
- **k is unchanged:** the overall limit of a retrieval, now counted in items under a profile, with
  or without a decomposer. `docs/INTEGRATION.md` documents the `IQueryDecomposer` slot and its
  budget contract (§4.5).
- **Tool-set shapes:** `EnumValueToolIndexer` and `TokenBudgetCut` are opt-in like every profile
  and strategy; nothing about the default changes.
- **Profile records are addressed by owner-scoped ids** (§3.1): `rag.getById(itemId)` on a profiled
  store finds nothing; use `bound.get(ref)`. Documented in `docs/INTEGRATION.md`.
- Docs updated in the same PR: `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`,
  `docs/PERFORMANCE.md`, `docs/EXAMPLES.md` (YAML, both decision providers),
  `docs/TROUBLESHOOTING.md` (rerank error metric; switching profiles needs a fresh collection),
  `docs/DEPLOYMENT.md` (`DECISION_SERVICE_KEY`; the tools corpus build step and the load at start,
  §6.5 — incl. the reload window of replicas over one persistent store), `docs/SECURITY_THREAT_MODEL.md` (Cohere receives
  the query and the candidate texts), `CLAUDE.md` key API notes, both new packages' `README.md`,
  the `typesafe-decision` README (`IProbabilityDecision`; one of two decision kinds), the
  `ollama-embedder` README (`OllamaRag` removed, its replacement), the `llm-agent`,
  `llm-agent-rag` and `llm-agent-libs` READMEs (renames, reranker package, the RAG
  implementations in `llm-agent-rag`, no re-exports — the libs README drops its "type re-exports of
  the core contracts"), `docs/PIPELINES.md` ("Embedding in code": `DagCoordinatorHandler` from
  `llm-agent-libs`, no `legacy/dag` re-export), `docs/INTEGRATION.md`'s custom plugin loader
  (`IPluginLoader`, `LoadedPlugins` from `@mcp-abap-adt/llm-agent`), `scripts/rag-eval/README.md`;
  every page that names a renamed or moved symbol uses the new name and import; the old name
  appears only in the CHANGELOG's migration table. The U1–U10 decisions (§10.5.12) are documented
  where each mode is: `docs/INTEGRATION.md` (the tool availability policy, `lazy` without
  `fallback`, `HybridDispatch`, the LLM call strategy's fallback count), `docs/EXAMPLES.md` and
  `docs/DEPLOYMENT.md` (`agent.toolUnavailableTtlMs` now opts in; `skillPlugins.strict` defaults to
  `true`; every config field validated at start, on a reload and on `PUT` — an environment
  variable's value is allowed for a number or flag field when it is a number literal or
  `true` / `false`, and a reload substitutes `${VAR}` exactly as the start does — an unset
  variable fails the reload as it fails the start, D83 (6), (7), (8); the cast-read fields'
  rules — `agent.retry`, `agent.toolSelection`, `mcp` headers / timeouts / entries, `llm.url`,
  `skills`, `plugins`, the pipeline sections — and that an empty `mcp.url` is an error, not "no
  MCP", D83 (9); in the hot-reload paragraph, `ConfigWatcherOptions.resolveDocument` for a direct
  consumer of `ConfigWatcher`), `docs/ARCHITECTURE.md` (`agent.heartbeatIntervalMs`: 0 disables,
  an invalid value fails the start), the five `docs/examples/stepper/` files (their
  `url: ${EMBEDDER_URL:-}` and `url: ${LLM_URL:-}` are `""` when unset and fail
  `rag.embedder.url` / `llm.<role>.url` — the lines become comments) and their `README.md`
  (`LLM_URL`), `docs/TROUBLESHOOTING.md` (`llm_streaming_fallback`, `worker_uses_shared_clients`,
  `batchFailures`).

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
  than 2 values. `EnumValueToolIndexer` forwards notes; the binding collects them from its
  indexer; no notes → no `notes` key.
- `TokenBudgetCut`: rank-order prefix; stops at the first item that does not fit (no skip-ahead);
  `min(requestedK, maxItems ?? requestedK)` ceiling; `limit()` = that ceiling; top item over budget → empty,
  `over_budget` counted (through `ISizeBoundedCut`, S6), with `cut.tokens` / `cut.budgetTokens`
  on the span; items never truncated; `ToolDefinitionSizeEstimator` uses `definitionChars`, falls
  back to text length; `isSizeBoundedCut` true for `TokenBudgetCut`, false for the count cuts.
- `recordId`: table — every scope; `:` `/` `#` inside owner key / item id do not collide
  (`u` + `a/b` + `c` ≠ `u` + `a` + `b/c`); ids over 200 characters become `h:` + 64 hex, stable
  across calls; every id ≤ 255 characters.
- Tools indexing: deterministic ids; canonical id = `recordId(global, itemId, 'full', 0)`;
  `itemText` only on non-canonical records; every record's text from provider words only; each
  indexer's `maxRecordsPerItem` bounds what it writes.
- Variants: each `mcpToolsVariants` factory returns exactly the strategy instances of §7.4 (pool,
  collapse, reranker, cut), with no decomposer unless the consumer passes one; `baseline` binds
  nothing; a decomposer refused on `baseline`; **no variant contains `NameTailFacet`,
  `EnumValueToolIndexer` or `TokenBudgetCut`**; `faceted()` = `ItemPool()` (the caller's k) +
  `TopItemsCut`; `faceted({ poolItems, maxItems })` = `ItemPool(poolItems)` +
  `FixedItemsCut(maxItems)`; `facetedRerank` uses exactly the `IReranker` it is given, requires
  `reranker` and `poolItems` (type-level), and refuses a non-positive `poolItems` / `maxItems`;
  `MCP_TOOLS_VARIANT_NAMES` is `baseline`, `faceted`, `faceted-rerank` (no `faceted-cohere`,
  `faceted-jev`, `small-set-jev`).
- Generic strategies and named compositions carry no tuned number (D55): the counts and sizes of
  `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut` (`budgetTokens`) and `EnumValueToolIndexer`
  (`maxValues`) are required constructor arguments (type-level); `ItemPool()` and
  `TokenBudgetCut.maxItems` fall back to the caller's k, never to a library number (D56): with k=4
  and `maxRecordsPerItem` 3, `ItemPool()` keeps 4 items per source and asks each source for 12
  records; with a decomposer, each sub-query's own k. A `grep` over `src/collections/` finds no
  numeric literal used as a pool or cut size outside tests.
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
  `orphans`; orphans do not use up k — **nor the pool** (D67): with the default pool (omitted),
  k=1, a top orphan and a valid second fetched item → the valid item is returned; **the replacements
  merge by descending score** (D67): k=2, an orphan and a surviving item scored 0.1 in the pool, an
  overflow replacement scored 0.9, `ScoreFloorCut({ minItems: 0, maxItems: 2, minScore: 0.5 })` →
  the 0.9 item is returned (with a reranker and with stage-1 scores); with `keepStage1Top: 1` the
  pinned item stays at the head and the replacement is merged into the rest by score; **the reranker reads the item text, never a non-canonical
  record's own text**; a non-canonical hit without `itemText` → the canonical record is read for
  its text; `getById`
  result outside the identity filter dropped; user partition skipped without `userId`; a failed
  rerank returns `RERANK_ERROR` (D71); reranker output check (wrong count, duplicate, non-finite → `RERANK_ERROR`); the cut
  applied once, at most `min(k, cut.limit(k))` items returned; **decomposer:** none → one run; `[]` →
  one run with the whole budget; each sub-query reranked against its own text and kept to its
  `k`; union in sub-query order, de-duplicated by owner-qualified item — **two sub-queries
  returning the same item with different scores → it is kept once, at its first position with its
  first score** (no best-score selection, no re-sort), and at most `budget` ≤ k items; **a
  decomposer with `ScoreFloorCut` throws at construction** with its message (also with a reranker); budgets summing to > k, `k < 1`, empty text or
  a decomposer error → `DECOMPOSE_ERROR`, counted, never a silent fall-back; at most `budget`
  items with any decomposer; `keepStage1Top` counted inside k; collapse keys on the owner-qualified item;
  `keepStage1Top`: pinned items first in stage-1 order, each carrying its **reranked** score (never
  the embedding score) — under a `ProbabilityReranker` and under a `RelevanceReranker` (scores
  outside [0, 1]); the rest by reranked score; `keepStage1Top` > 0 with `ScoreFloorCut` throws at
  construction with its message; `ScoreFloorCut` with a reranker is allowed (D71); a failed rerank —
  `ok: false`, a throw, a failed output check, with or without `keepStage1Top` — returns
  `RERANK_ERROR` (D71); every cut; telemetry (span attributes, counter, session step).
- Config validator: an `onFailure` key under `compose` refused (D71); `compose` with `cut: { score-floor: … }` and a decomposer (profile-level
  `decomposer`, or `compose.decomposer` other than `none`) refused (D63).
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
- The RAG implementations in `llm-agent-rag` (D53, D57, §11.3): every name of the "moves" table
  is exported by `@mcp-abap-adt/llm-agent-rag` and **not** by `@mcp-abap-adt/llm-agent` (runtime
  check over the module namespaces; a typecheck file with `@ts-expect-error` on importing a moved
  type from the `llm-agent` root); `IQueryExpander`, `IQueryPreprocessor`, `IDocumentEnricher`
  still export from the `llm-agent` root; the moved tests pass in `llm-agent-rag` unchanged in
  outcome. Repo tests (like `scoped-dependencies.test.ts`): nothing under `packages/llm-agent/src`
  or under the store and embedder packages' `src/` imports `@mcp-abap-adt/llm-agent-rag`, and
  `packages/llm-agent/package.json` does not name it (no cycle); no file under `packages/*/src`,
  `scripts/` or `test/` imports a moved name from `@mcp-abap-adt/llm-agent`; `OllamaRag` is gone.
- No aliases, no re-exports (D58, D59): the removed names of §13's table are exported by no
  package (a repo test over the built module namespaces of `llm-agent`, `llm-agent-libs`,
  `llm-agent-server-libs`, `ollama-embedder`); `llm-agent-libs` exports none of
  `llm-agent-reranker`'s names; no `export … from '@mcp-abap-adt/…'` statement appears in a file
  this PR adds or edits (`llm-agent-libs/src/index.ts`, `llm-agent-rag/src/**`,
  `llm-agent-reranker/src/**`, `sap-aicore-decision/src/**`); `IProbabilityDecision` is
  implemented by `TypeSafeDecisionModel`.
- No public entry point re-exports another package's names (D59, S12): a repo test reads the built
  `types` file of every `exports` path of every package with the TypeScript checker and fails when
  an exported name's declaration lies outside the exporting package (so both `export { X } from
  '<pkg>'` and `import { X } from '<pkg>'; export { X }` are caught, and a new re-export in any
  package fails it); `OrchestratorError` is not in libs' runtime namespace,
  `CoordinatorHandler` / `DagCoordinatorHandler` not in `./legacy/linear` / `./legacy/dag`'s, and
  importing `@mcp-abap-adt/llm-agent-server-libs/legacy/flat` fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- `ITextLogger` removed (§11.4, line 70): a typecheck file with `@ts-expect-error` on importing
  `ITextLogger` from the `llm-agent` root; the four text-logger tests in `tsconfig.typecheck.json`
  type-check against `ILogger` of `@mcp-abap-adt/interfaces-utils`; no file under `packages/`,
  `scripts/`, `test/` names `ITextLogger` except that typecheck line.
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
  canonical lists the id in `staleRecordIds`; a retry `index` deletes it and clears the list;
  `remove` after that leaves nothing in the store; a
  `remove` whose delete fails keeps the canonical and returns an error, and a second `remove`
  completes.
- `vectorizeMcpTools`: golden test of the default path; item accounting with a profile; one batch
  for all records; a binding whose `rag` has no writer is still filled through its own `index`
  (catalog complete, items retrievable), while a writerless store without a binding is skipped as
  in 30.1.0; F1 regression through `StrategyRag` and a plain decorator (`IRagDecorator`).
- F2 / F3.
- `FallbackRag` removed (D68, §10.4): an open embedder breaker → a `VectorRag` query returns
  `CIRCUIT_OPEN` and calls no embedder; `FallbackRag` is not exported by the `llm-agent` root;
  `replaceRag` and `withCircuitBreakers` are gone; `withCircuitBreaker()` leaves every registry entry
  and projected store as registered (scope, owner, provider, editor) and `handle.circuitBreakers`
  holds the main-LLM breaker only; a projected strategy is `StrategyRag(store)` and a pre-wrapped
  store stays itself, one rerank per query; the decorator walks (`isRagDecorator`,
  `hasRetrievalStrategy`, `ownBuiltInStore`, `findWeightedStore`) are tested over a plain test
  decorator; a session build changes no registry entry; the server's embedder-breaker test keeps
  its assertions (status 200, no embedding call while open). *Replaces the `FallbackRag` writer
  tests of D52 / D62, withdrawn.*
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
- Filling follows the store and happens once, at creation (D34, D35, D41), one test per lifecycle
  path:
  - **startup** — the server fill tests above (main, workers on own and shared clients); on
    `yamlBuilderConnect` (the in-process MCP stub) a worker with its own store and no own clients
    holds the stub's tools right after `start()`, before any session (D38);
  - **`toolsChanged`** (`McpToolRegistry`, libs), D46:
    - a store bound by `bindToolsProfile` is **not written** on `tools-changed`: a reconnect with an
      updated description and a newly added tool → no `bound.index` call, no raw write, no listing,
      the fill source's `fill` not called, the store exactly as created, no warning logged;
    - a bound store behind a decorator (a consumer's `IRagDecorator`): the initial fill
      (`vectorizeMcpTools` on the decorator) still finds the binding and fills through the profile,
      and the reconnect still finds it and writes nothing;
    - an unbound store keeps 30.1.0 behaviour: the reconnect re-vectorizes with the 30.1.0 records
      (the existing reconnect tests, unchanged);
  - **`PUT /v1/config`** and **hot reload** → the drained workers are constructed again by the next
    session. The hot reload is driven through the server's reload entry point (the
    `ConfigReloadWatcher` the server holds, `_onReload`, awaited) — no `fs.watch`, no debounce
    polling (D39). One thin test pins that the file watcher's `reload` event calls that entry point.
    Covered:
    - a worker with its own in-memory store on the shared clients (labelled slots, a collision);
    - a worker with DI clients.

    Each rebuilt store is a new instance carrying its binding. It is filled once by the
    construction and retrievable by its records, under the
    names its agent dispatches by (`<label>__<tool>`, ids `tool:<slotIndex>:<name>`; array order
    for the DI clients); the following re-wire fills nothing.
  - **Never refilled (D41):** a worker's client whose `listTools()` fails at startup → nothing
    indexed, the summary line logged; after the client recovers, re-wires still index nothing —
    the store stays as created.
  - **A construction that fails anywhere leaves no cached worker:** a lazy rebuild whose fill
    throws — the server's, or the builder-driven fill of a worker on its own `mcp:` — or whose
    backfill throws → that session's worker build fails and the cache holds no entry for the
    worker; the next session constructs a fresh store, fills it again and never re-wires the
    parent's clients into it. A `build()` that fails after resolving its connection strategy —
    an injected one (`withMcpConnectionStrategy`) included — disposes it and rethrows the original
    error (D47, D64).
  - **Fill before skills** (D66): `fillToolsBinding` with a `corpus` source and `skills` → the
    skill records are there after the load; server: `fill: corpus` + a skill manager on the
    ready-client path → the skill records survive the corpus clear and are searchable, and the
    corpus is loaded; on `yamlBuilderConnect` a worker on the shared clients with `fill: corpus`
    and its own skill manager (the deferred fill) → the same in the worker's store; a `live` fill +
    a skill manager → tools and skills both there, the fill run once.
  - `fillToolsBinding` refuses a binding its store does not carry; `vectorizeMcpTools` has no
    `binding` option (the libs tests bind through `bindToolsProfile`).
- Fill sources (§3.10, libs):
  - no source → `live`: the existing profile fill tests, unchanged;
  - `ConsumerToolsFill`: the builder's auto-connect writes nothing and reports no status;
  - a consumer's own source receives the binding, the target and `indexLiveTools`, and its status
    is the catalog status;
  - `bindToolsProfile` on a store already bound with a different explicit source → throws.
- The corpus (§6.5, libs), with an embedder that counts its calls:
  - `buildToolsCorpus` → one record per profile record (ids, texts, metadata equal to what
    `bound.index` writes into a live store), every vector of one dimension; a failing item →
    throws naming it; no items → a valid empty corpus (zero records, `items: 0`, no
    `dimensions`) that `parseToolsCorpus` round-trips;
  - `parseToolsCorpus(JSON.stringify(corpus))` round-trips; a changed record (hash mismatch), a
    wrong format, a mixed dimension, `dimensions` missing with records or present without → throws;
  - `ToolsCorpusLoader` into a `VectorRag` holding records of an earlier load **and** a record
    the corpus does not list: **zero embedding calls**; afterwards the store holds exactly the
    corpus (the foreign record is gone — cleared); retrieval through the binding finds the tools;
    the catalog status is complete with `records`; one summary log line naming `corpus`, the identity,
    the counts and `corpusHash`;
  - **replacement leaves no merged metadata** (`VectorRag`, `InMemoryRag`): a store loaded with A
    whose record X carries extra metadata `ttl` and `data` → a new instance loads B whose X carries
    neither → X has no `ttl` and no `data`;
  - **checks before the store is touched:** a mismatching `profile` / `embedder` / `profileName` /
    `dimensions` → throws naming it, and a writer spy sees no `clearAll` and no write; a store
    whose writer has no `clearAll` → throws naming the store, nothing cleared or written; a store
    without precomputed writes → the same, and the embedder is never called;
  - *the cases through `FallbackRag` and the resolved-backend check (D52) are withdrawn with D68:
    the load checks the writer of the store it writes, which the two cases above cover;*
  - **an interrupted load repeats at the next start** (D54): a writer that throws after n record
    writes → `fill` throws (the store partial); a new `ToolsCorpusLoader` fill on the same store
    (the next start) → the store holds exactly the corpus;
  - **empty corpus** (D49): a store holding records → the load clears it and writes nothing; the
    status is complete, `total: 0`, `records: 0`.
- Server `fill` (§6.2): `{ corpus: … }` on an in-memory store with ready clients → the store holds
  the corpus and the embedder saw no call at startup; the same on a store that already holds other
  records (a persistent store's second start, simulated) → only the corpus remains; a store config
  with a declared `dimension` and a corpus of another length → startup fails naming both, the
  store untouched; **a worker's own store declaring another dimension than the corpus (main 2,
  worker 3, corpus 2) → startup fails naming the worker's store and both dimensions, before any
  store is created — zero clears and zero writes in every store** (D65); every `fill` validation rule (unknown name, missing fields, a leftover
  `prebuilt` refused naming `corpus`, `corpus` with a worker that has its own `rag` and own
  clients).
- YAML: every validation rule of §6.2 through the real `resolveSmartServerConfig` (incl. a
  `rag.profiles` key other than `tools` refused, S8; `faceted-rerank` without `poolItems`; a
  leftover `faceted-cohere` / `faceted-jev` / `small-set-jev` / `smallSet` refused naming
  `faceted-rerank`; `faceted-rerank` builds `ProbabilityReranker` (with `TOOL_QUESTION`) under
  `typesafe` and `RelevanceReranker` under `sap-aicore`;
  `question` / `task` refused for a relevance provider; `decision.provider: sap-aicore` fields; an
  unknown `text` composer); `reranker: decision` builds `ProbabilityReranker` under `typesafe` and
  `RelevanceReranker` under `sap-aicore`, in `rag.profiles` and `rag.retrieval`; a missing seam of
  the needed kind → startup error naming it (`makeProbabilityDecision` / `makeRelevanceDecision`);
  the renamed probability seam: `makeProbabilityDecision` builds the probability decision;
  `makeDecisionModel` is not a member of `BuildAgentDeps` (a typecheck with `@ts-expect-error`);
  the app supplies `makeProbabilityDecision` (built by `createMakeProbabilityDecision`); the app's
  `makeRelevanceDecision` builds
  `SapAiCoreRelevanceDecision` from `decision:` (default ref `DECISION` → bearer + `apiBaseUrl` from
  `DECISION_SERVICE_KEY`; a named ref; `credentialRef` and `provider` never reach the provider).
- The user's U1–U10 decisions (§10.5.12): `FallbackLlmCallStrategy` — a streaming failure logs
  `llm_streaming_fallback` with a running count and increments an injected `fallbackCount` with
  `cause`; a caller's cancellation counts nothing (U1); the skill plugin host without `strict` fails
  the group of a failed source (default `true`), and `strict: false` still carries forward with
  `carried` (U2, libs and the server's `skillPlugins` default); `HybridDispatch` — no agent → the
  fallback dispatcher, a named agent missing → `ok: false` naming it, and through a coordinator
  handler `COORDINATOR_STEP_FAILED` (U5); `lazy`'s factory failing → the error reaches the call,
  and `fallback` is not a member of `LazyOptions` (a typecheck with `@ts-expect-error`) (U6); a
  failing batch embedding → `batchFailures: 1` on both the 30.1.0 and the profile path, absent on
  success (U7); no policy injected → a "not found" tool error blocks nothing and filters nothing;
  `HeuristicToolAvailabilityPolicy({ ttlMs })` → 30.1.0's blacklist; the server injects it only
  when `agent.toolUnavailableTtlMs` is set, and `PUT /v1/config` refuses the key (U8); a worker
  without its own clients logs `worker_uses_shared_clients` once per wire, naming what it shares
  (U10).
- The review findings of 2026-10-05 (D75–D78): `vectorizeSkills` with a writer whose write
  answers `ok: false`, and one whose write throws → rejects with a `SkillError` naming the skill,
  `cause` the store's error; through `build()` → `build()` rejects with it; through
  `fillToolsBinding`'s `skills` → it rejects with it; the server's start with a skill manager whose
  skill write fails (the main store, and the deferred shared-worker pass) → `start()` rejects
  naming the skill (D75). The record writer with a bulk write that answers `ok: false`, and one
  that throws, while every individual write would succeed → every item of the batch in
  `failedItems` with `write-failed: bulk write failed: <error>`, the store empty, and the
  individual writes **never called**; a failed settle write → the item reported `cleanup-failed`
  (D76). A reload whose drain rejects, and one whose invalidation rejects → `_onReload` rejects
  naming it; nothing is restored (the agent config and the server's mirror keep the reload's
  values), the RAG weights are not applied, and through the watcher's `reload` event
  `config_reload_failed` is logged and `config_reload_applied` is not (D77, D82). Two reloads A
  then B where A's drain is still pending when B is queued → B's update and drain start only
  after A settled; A's drain rejecting → A rejects (`config_reload_failed` for A), then B runs →
  the live config, the server's mirror and the RAG weights are B's; a failed reload followed by
  a successful one → the first reported failed, the second applied (`config_reload_applied`
  once) (D80). The queue's readiness (D82): empty at construction; a rejected transaction sets
  `notApplied` (`reason` the error's message, `source`); a later resolved one clears it; the
  state is the last settled transaction's, in queue order; a `'partial'` one that starts while
  it is set rejects with `ConfigChangeRefusedError`, never runs and leaves the state untouched —
  also when it was queued while the server was ready and a transaction ahead of it failed; while
  ready a `'partial'` one runs (D82 (8)). `PUT /v1/config` and a reload on one
  `ConfigTransactionQueue` (`handleConfigUpdate` over a recording target, the watcher over the
  same server state): a reload whose drain is pending, then a partial `PUT` and a whole one →
  neither starts before the reload settled; the reload's drain rejecting → the reload reported,
  the partial `PUT` refused at its transaction's start (409 `config_not_applied`, nothing
  applied, no drain, the state still the reload's), then the whole `PUT` applied (200, its
  config live, the state cleared) (D82 (8)); the reverse — a `PUT` whose
  drain is pending, then a reload; the `PUT`'s drain rejecting → 500, then the reload applied (its
  config live, the state cleared); a `PUT` whose drain rejects, one whose invalidation rejects and
  one whose startup-agent `reconfigure` throws → 500 `server_error` naming it (`worker drain` /
  `session invalidation` / `apply`), the state not applied with that reason (`source: 'put'`),
  nothing restored; the next whole `PUT` → 200 with its config live and the state cleared.
  While not ready (D82 (8)): `{}`, `{ agent }` and `{ models, agent: {} }` → 409
  `config_not_applied` naming the missing sections (`models, agent` / `models` / `agent`),
  nothing applied, no drain, the state the same object; a whole `PUT` with an unknown agent
  field → 400, the state the same. While ready, a partial `PUT` → 200 (as before), and `{}` →
  200 outside the queue. A real server
  (D82): a hot reload whose drain fails → `/health` 503 with `ready: false` and
  `configNotApplied.reason` naming the drain, `POST /v1/chat/completions` and `POST /v1/messages`
  → 503 `service_unavailable` with `config not applied — …`, `GET /v1/config` still answers; then
  a partial `PUT` → 409 and still not ready (D82 (8)), then a reload that applies → `/health`
  without `configNotApplied`; a `PUT` whose drain fails → 500 and the same not-ready answers
  (`source: 'put'`), a partial `PUT` → 409 and still not ready, then a whole `PUT` that applies
  → 200, `/health` without `configNotApplied` and `ready: true`, a chat request past the gate
  (not 503). A real server with a `configFile` → a `PUT` sent while a reload's
  drain is held answers only after the reload settled (D80, V10). A file the watcher cannot read,
  parse or resolve (D82 (9)): a real server with a `configFile` whose file is rewritten as
  malformed YAML → `/health` 503 with `configNotApplied` (`source: 'reload'`, the reason
  `… — cannot read the config file: …`) and both chat routes 503, still so until the repaired
  file is saved, then ready; the same for a file made unreadable (permissions; skipped as root)
  and for a deleted file (ready again after a whole `PUT`); the queue order — a watcher error
  queued behind a `PUT` in flight waits for it, sets the state after it, and a partial `PUT`
  queued behind the error is refused (409) at its start; the error runs no drain and applies
  nothing; `config_reload_failed` logged, `config_reload_error` never. Config field validation (D83):
  the validator over each rule of §10.5.9 *Config field rules* — the boundary values pass, one
  below / above, a non-integer where an integer is required, a string, `null`, `NaN` and
  `Infinity` fail, each naming the field; two invalid fields → one error naming both.
  `ConfigWatcher` over a file with `maxIterations: oops` and `showReasoning: "no"` → the event
  carries `'oops'` and `'no'` (not coerced). The real watcher (`ConfigReloadWatcher.start()` over
  a temp file) with `agent.maxIterations: oops` → `config_reload_failed` naming
  `agent.maxIterations`, `notApplied` set (`source: 'reload'`), the agent update never called, the
  limit unchanged; then `maxIterations: 0` while not ready → failed again, still not ready, the
  reason the new one; then `maxIterations: 25` → applied, ready, the limit 25. `PUT /v1/config`
  with `"oops"`, `null`, `1e999` (`Infinity`), `0`, `2.5`, `" 25"` for `maxIterations`, `"yes"`
  for `showReasoning`, `""` for `models.mainModel` → 400 naming the field, nothing applied, no model
  resolved, no transaction (the state unchanged); while not ready a whole `PUT` with an invalid
  value → 400 (not 409), the state the same object. The start config (D83 (5)):
  `resolveSmartServerConfig` over a YAML with `agent.maxIterations: oops` → `ConfigFieldError`,
  `invalid config — agent.maxIterations must be a finite number, got "oops"`; every row of the
  table at its YAML path fails the same way; two invalid fields → one error naming both;
  `args.agent-show-reasoning` / `args.log-dir` invalid → named so; a worker file with an
  invalid field → the error names the worker and its path; the start input equals the event the
  real `ConfigWatcher` emits for the same file (the same paths); a valid YAML → the values as
  written (`maxIterations: 5` is 5, `showReasoning: true`, the in-memory weights, the prompts),
  an absent field its default, and a real `SmartServer` starts from it; the CLI with
  `maxIterations: oops` exits 1 with that message on stderr. The grammar (D83 (6)): `"25"`,
  `"-1"` (where the range allows it), `"0.5"`, `"1e3"` pass as numbers; `" 25"`, `"25 "`,
  `"25abc"`, `""`, `"NaN"`, `"Infinity"`, `"0x19"`, `"025"`, `"+5"`, `".5"` fail as `must be a
  finite number`, `"1e999"` too; `"-1"` for a field with min 0 fails its range; `"true"` /
  `"false"` pass as flags, `"yes"`, `"True"`, `1` fail; the same on a reload and a `PUT`
  (`{"maxIterations":"25"}` → 200, the limit 25); a start from a YAML with `${MAX}` and
  `MAX=25` → 25. Every start-only field (D83 (7)) — one valid and one invalid value each, named
  at its path; `parseIntegerField(" 5")` is `'invalid'`, `parseIntegerField("5")` 5;
  `parseSkillPluginsConfig` with `strict: "false"` → `false`, `k: " 4"` → `ConfigFieldError`
  naming `skillPlugins.k`; `parseStepperCoordinatorConfig` with `stepper: { maxDepth: "x" }` →
  `ConfigFieldError` naming `stepper.maxDepth`. The reload's substitution (D83 (8)): the real
  watcher over a file with `maxIterations: ${MAX_ITER}` and `MAX_ITER=25` in the injected
  environment → applied, the limit 25, ready; `MAX_ITER` unset (no default) → failed, naming
  `agent.maxIterations` with `got ""`, not ready — the start from the same file fails with the same
  issue; `prompts.system: ${SYS:-}` → failed, `prompts.system must be a non-empty string, got ""`;
  `startConfigInput(loadYamlConfig(file, env))` equals the event of a `ConfigWatcher` with
  `resolveDocument: (d) => resolveEnvVars(d, env)` over a file with `${VAR}` fields and
  `rag.store.type: ${STORE:-in-memory}` (the weights in both); without `resolveDocument` the
  event carries the text `"${MAX_ITER}"`. Every cast-read field (D83 (9)) — one valid and one
  invalid value each (wrong type, out of range, an unknown key of a closed mapping, a bad list
  item), named at its path, through `resolveSmartServerConfig` or the section's own parser; a
  number literal string in `retry.retryOn`, `budgets.maxSteps`, `stepper.reviewer.atDepths` is
  the number. `process()` on a pipeline that fails → the root span's
  status is `error`; a consumer that reads the stream only to the error chunk and closes it
  (`return()` on the iterator) → the root span is `error` and ended (D78).
- The 30.1.0 tools path's bulk write (D79): `vectorizeMcpTools` on an unbound store whose
  `upsertManyPrecomputedRaw` answers `ok: false`, and one whose bulk write throws, while every
  per-tool write would succeed → the bulk write called once, **no per-tool write** (neither
  `upsertPrecomputedRaw` nor `upsertRaw`), `vectorized: 0`, every tool in `failed`,
  `complete: false`, `writeFailure` `bulk write failed: <error>`, the summary log line naming it;
  the 30.1.0 test that pinned the per-tool retry is replaced by these. A successful bulk write →
  `writeFailure` absent. A failed batch **embedding** still takes the per-tool path (U7, counted).

### 14.2 Conformance kit

`@mcp-abap-adt/llm-agent/testing/collection-profile-conformance` (beside
`rag-filter-conformance`): for any `ICollectionProfile` — owner keys and visibility on every
record; deterministic, owner-scoped ids (`recordId`; the same `itemId` under two owners → disjoint
ids); every returned item hydrated from its canonical record; **at most `min(k, cut.limit(k))` ≤
k distinct items returned, with or without a decomposer** (S9 as amended by review finding 1: the
§4.5 budget — `k` for `TopItemsCut`, `min(k, n)` for `FixedItemsCut(n)`; the kit also runs an
adversarial decomposer whose budgets overrun the budget and expects `DECOMPOSE_ERROR`); **a
profile whose cut has a ceiling of its own is called with a k smaller than that ceiling** (e.g.
k=2 against a consumer's `maxItems` 5 on `faceted` / `faceted-rerank`) and returns ≤ k; a stale delete that fails is reported as `cleanup-failed` and
retried by the next `index`;
no record outside the caller's identity filter returned;
**with a size-bounded cut, the summed size of the returned items ≤ the budget** (by the cut's own
estimator) and no item is truncated. A consumer runs it against its own profile.

- **Where it lives, and why there:** with the contracts (`@mcp-abap-adt/llm-agent/testing`), not
  with the implementations. It is test code **over the contracts** — it imports only
  `interfaces/` types and `node:assert`; the stores, the profile and the query embedding come from
  the consumer's harness. It ships no RAG implementation and none is added to any `testing` entry
  point by this design (the corpus build's capture store is private to libs, §6.5).

### 14.3 Measurement harness

- `scripts/rag-eval` gains `--variant baseline|faceted|faceted-rerank` (with `--pool-items`,
  `--max-items`), or a
  composition by strategy name (`--indexer`, `--facets`, `--discriminator`, `--pool-items`, `--reranker none|decision`, `--cut`,
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
- **Measurements stay in the consumer** (D55). The harness is the framework's; the labelled
  queries, the catalog and the figures are the consumer's, and none of them is committed here or
  turned into a default. The PR's consumer check (cloud-llm-hub, env-gated, not part of `npm
  test`) uses the harness to:
  - reproduce, within ±1 row, `baseline`'s figures of §2.1 on its own catalog (the harness counts
    what the consumer counted);
  - measure `faceted` with the **schema-derived** `ParametersFacet` (not yet measured, §2.0) and
    `faceted-rerank` with its own rerankers and `poolItems` — results reported in the PR and kept in
    the consumer's research branch, not in §7.4.

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
| **Single-flight worker construction and drain ordering** — a pre-existing 30.1.0 race in `WorkerRegistry` (`packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts`), unrelated to profiles: (1) `WorkerRegistry.build` checks `cache.has(name)` and on a miss awaits a primary `buildSubAgent`; nothing is recorded between the check and `resolveWorkerLlmSet`'s `cache.set`, so two sessions that miss together (the first two after `PUT /v1/config` or a hot reload drained the cache) both construct the worker — two sets of worker stores, two builder handles, two MCP connections for an own `mcp:`; the later `cache.set` wins and the other handle leaks, or `backfillWorkerCacheFromHandle`'s defensive `close` closes a handle a running agent still uses; (2) `resolveWorkerLlmSet` publishes the entry before the primary build's `backfillWorkerCacheFromHandle`, so a concurrent session can re-wire with the parent's MCP clients instead of the worker's own; (3) `drain()` clears the cache while a construction is in flight, and that construction then publishes into the drained cache — built before the reload, served after it, closed by nobody until the next drain. With a tools profile each duplicate construction also fills its own new store (one more listing and indexing) | **a separate issue: fr0ster/llm-agent#331** (D45), filed from this row — it also covered a worker rebuilt between a drain and a failed reload's restore (D77/D80) — no restore exists since D82: a failed change leaves the server not ready and the next change that applies drains again (§17.30); it needs one construction per worker name and config generation and a drain that waits for, and discards, the constructions it overtook. Not a RAG concurrency protocol: concurrent store writes stay the backend's (D13) |
| A refill API, a fill memo or a retry of an incomplete fill | not built: a store is filled once at creation (goal decision 2026-10-05, D41) |
| Shared items in the server YAML | D6 |
| A query-decomposition **implementation** (splitting multi-step queries) | the consumer: it injects its own `IQueryDecomposer` into the slot `StagedRetrieval` provides (§4.5); the framework ships none and no variant uses one (goal decision 2026-10-05) |
| BM25 identifier tokenization (`ZDEMO_D_TEST` → `test`) | separate change to the in-store scoring (`ISearchStrategy` / tokenizer) |
| A package for the store kit (`AbstractRagProvider`, the query embeddings, …) below both `llm-agent-rag` and the store packages | a later decision (§11.2 item 1); the kit stays in `llm-agent` |
| A deploy-time corpus step, a record of the load in the store, resuming an interrupted load | not built (D54): the server loads the corpus at every start, from the start |
| Tuned numbers for any shipped strategy or composition | the consumer's calibration (D55); measured with the harness in the consumer (§14.3) |
| A degraded RAG mode — answering from a copy while the embedder is down | the consumer's own `IRag` wrapper (D68): the library ships none; `FallbackRag` is removed |
| `SmartServer`'s `closeFns` loop (`smart-server.ts` ~1943) stops at the first throwing closer, so later closers never run | a cleanup bug found while verifying the fail-loud inventory, not a fallback: tracked in its own issue, fr0ster/llm-agent#330 (§17.24) |

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
5. **Strategies:** collapse, cut, query decomposition, reranker, source selector, group
   partitions, indexing, provider text, facets, candidate pool, the tools fill source — all
   injected. A variant is a
   named set of instances, never flags; the library picks no k, no pool and no reranker by guessing.
   The consumer makes the main behaviour choices by choosing strategies; a named composition
   fills only what it left open and carries no tuned number — the consumer's arguments or the
   generic defaults (the caller's k) fill its numbers (§7.1, D55, D56).
6. **File size:** new logic in `src/collections/*` and the new packages; `builder.ts` and
   `smart-server.ts` get one call site each per binding.
7. **Breaking, by decision:** a major release (D57–D59). The removals are the names of §13's
   migration table (one line each) plus two unexported files; the RAG implementations move to
   `llm-agent-rag` with no new package edge and no cycle (§11.3) once `OllamaRag` is removed (S11).
8. **Any MCP server (goal 9):** shipped strategies read only what every server exports; the one
   convention-dependent facet is opt-in and in no variant; a consumer builds a profile for any
   other server from the contracts (§7.9), with the raw `inputSchema` available to its strategies.

---

## 17. Decisions

### 17.1 Settled by the goal

No longer asked:

- experience as a schema in the framework → shared items (§8);
- ~~intents' home → an indexing strategy of the tools profiles, default placement `record`~~ —
  superseded by the goal's later decision: intents are removed entirely (D50, §7.3.3);
- one profile with flags → strategies the consumer injects, plus named compositions (§7);
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
  behaviour choices by choosing the strategies it injects; components are generic; ~~tuned numbers
  live only in default compositions, each citing its measurement~~ — refined by the goal's later
  decision of the same day: nothing that ships carries a tuned number (D55, §7.1);
- the layers, the corpus flow and the measurements (goal decisions 2026-10-05): D53–D56 (§17.17).

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
| D3 | *Superseded by D50 (§17.15): intents and companion stores are removed.* Companion intents: **one record per tool**, as in `record` placement. | §7.3.3 |
| D4 | Builder skills **coexist** in the tools store (pass-through). | §7.7 |
| D5 | Shared-item visibility: `user` / `group` / `global` as **partitions**; group stores supplied by the consumer (`ISharedItemGroups`). | §8.3 |
| D6 | Shared items: **library API only** in this PR, no server YAML. | §6.2 |
| D7 | Ship `keepStage1Top`, **default 0, counted inside k**, documented as unmeasured without the former split. | §4.7 |
| D8 | Replace the private embedder read with **`IRetrievalEmbedderOwner`** (3 provider packages) in this PR. | §10.1 |
| D9 | Query preparation stays **outside** profiles; #323 is a pipeline fix. | §12 |
| D10 | `SapAiCoreRelevanceDecision` takes **`deploymentId`** in this PR; resolving by model name is a follow-up. | §5.3, §5.4 |
| D11 | *Withdrawn by D55 (§17.17): `faceted-jev` is withdrawn.* Ship `faceted-jev`, marked **"to be measured as one composition on fresh consumer queries before promotion"**. | §7.4 |
| `limit()` | `IItemCut.limit(requestedK)` — the most items a cut returns; the retrieval's budget for a decomposer. Stated as an **upper bound** in items, so `ScoreFloorCut` and `TokenBudgetCut` fit with no signature change (§4.10). | §3.4, §4.5 |

### 17.3 Raised by the server-agnostic amendment

The `compact` measurement (§2.5.1) settles four of them; the user decided the other four (D16, D18, D22, D23) on 2026-10-05.

**Settled by the `compact` measurement** (the user reviews them with the spec):

| # | Question | Resolution | Why |
|---|---|---|---|
| D17 | `TokenBudgetCut` when the top item alone exceeds the budget: empty, or keep the first item? | **Empty + counted** (`over_budget`), as recommended (§4.10). | `TokenBudgetCut` is in no default: it is a guard the consumer injects and sizes (≥ its largest tool). A guard that breaks its own bound is no guard; the conformance kit checks the bound. |
| D19 | `TokenBudgetCut`: stop at the first item that does not fit, or skip ahead to smaller ones? | **Stop**, as recommended; documented as the reason it is not a main cut (§4.10). | Measured: as the main cut a 2k budget gives 0.910 vs 0.970 for k=3 at the same ~1.6k tokens, because it stops early. As a guard it must not reorder the consumer's ranking. Skip-ahead = the consumer's own `IItemCut`. |
| D20 | `coarse` ships with no numbers until the `compact` measurement lands? | *Superseded again by D55 (§17.17): `small-set-jev` is withdrawn; nothing ships a measured cut.* **Superseded.** The `coarse` variant (per-value records + token budget) is **withdrawn**; the coarse default is `small-set-jev` with measured numbers: one record per tool + rerank-all + `FixedItemsCut(3)` (§7.4). | Per-value records measured worse (§7.3.2); the token budget measured worse than k (§4.10); one record + Jev over the whole set: 0.970 at ~1.6k tokens. The only required argument left, `poolItems`, is the consumer's tool count, not a tuned number. |
| D21 | Return which enum values matched with a coarse tool (`metadata.matchedValues`)? | **No** — not in this PR. | No default writes per-value records any more, so no default has values to report. A consumer that injects `EnumValueToolIndexer` and wants the hint justifies a new output contract with its own measurement. |

**Decided by the user on 2026-10-05** (each with the recommended option):

| # | Question | Decision |
|---|---|---|
| D16 | *Read with D55 (§17.17): the schema-derived records stay; no figure is cited as their justification — the consumer measures them.* The `faceted*` defaults use schema-derived records (`summary` + `parameters`); `ParametersFacet` is **not yet measured** on the fine-grained set. Accept shipping them on the closest measured layouts' figures (LLM-generated `operation` / `object` facets and name-derived facets, both 0.966 at k=5 hybrid, hub spike `spike-facets`) until the consumer check runs? | **Yes** — the name-derived `object` record depends on one server's naming; a default may not. The measured layout stays one line away for a verb-first server (`NameTailFacet`, §7.5). If the check shows `parameters` worse, the fix is a better schema-derived facet, not the convention. Not settled by `compact`: that set has no fine-grained facets. |
| D18 | `RequiredEnumDiscriminator` with several qualifying parameters: no fan-out + `IndexReport.notes`, or fan out over all of them? | **No fan-out + note** — goal 3, never guess; `NamedDiscriminator` or the consumer's selector resolves it. Lower stakes now: it only serves `EnumValueToolIndexer`, which is in no default. |
| D22 | `ToolItem` carries the raw `inputSchema` (for consumer strategies) and `parameters` replaces `parameterNames`. | **Yes** — without the raw schema a consumer cannot build a profile for a server whose signal sits elsewhere in the schema (goal 9); `ToolItem` is new in this spec, so nothing breaks. |
| D23 | *Withdrawn by D55 (§17.17), with `small-set-jev` and `assertSmallSetPool`; `faceted-rerank` takes a required `poolItems`, unchecked against the tool count (any depth is a valid choice).* `small-set-jev` takes `poolItems` (≥ the tool count) as a required argument and the composition root checks it at startup. Alternative: a new `ICandidatePool` that always takes the whole store (no number at all). | **Required `poolItems` + startup check** — no new strategy class, same shape as 30.1.0's `RerankAllRetrieval.maxCandidates` ("configured, never derived"). A whole-store pool can be added later if consumers ask. |

### 17.4 Decided by the user on 2026-10-05 — S1–S9

*(The Cohere-through-`IDecisionModel` decision recorded here first is replaced by §17.6.)* Still
removed: the `sap-aicore-reranker` package, `SapAiCoreReranker`, the `crossEncoder:` YAML section
and its seam (and with it S5). The new cross-encoder contract is `IRelevanceDecision` (§3.9), a
decision contract — not a reranker contract.

The plan's spec issues:

| # | Issue | Decision | Where |
|---|---|---|---|
| S1 | No channel from an indexer to `IndexReport.notes` | Optional capability **`IIndexNoteSource`** (`notesFor(item)`); the binding collects the notes | §3.2, §7.3.2, §7.6 |
| S2 | "Fill once" intents needed the store inside a pure indexer | *Superseded by D50 (§17.15): intents and companion stores are removed.* **Dropped from this PR**: intents are generated at indexing; caching them is the consumer's concern. `generatedFrom` stays as provenance | §7.3.3 |
| S3 | `ToolCatalogStatus` was missing from §3.8 | Optional **`records`** / **`profile`** on `ToolCatalogStatus`, listed in §3.8 | §3.8, §7.6 |
| S4 | Output check on the 30.1.0 rerank strategies? | **No**: telemetry only, no 30.1.0 behaviour change | §9.2 |
| S5 | Default `credentialRef` of `crossEncoder:` | **Dropped** — there is no `crossEncoder:` any more; `decision:` keeps its `DECISION` default | §6.2 |
| S6 | `StagedRetrieval` could not learn a size cut's tokens | Optional capability **`ISizeBoundedCut`** (`budgetTokens`, `estimator`): `over_budget`, `cut.tokens`, `cut.budgetTokens` | §3.4, §4.10, §9.1 |
| S7 | `remove` left companion records behind | *Superseded by D50 (§17.15): intents and companion stores are removed.* Reserved key **`companionRecordIds`** on the canonical record; `remove` and replacement clear companion records | §3.1, §3.3, §7.3.3 |
| S8 | YAML keys other than `tools` had no store or filling path | **Only `rag.profiles.tools`** in this PR; any other key refused loudly at config resolution | §6.2 |
| S9 | "At most k" contradicted `FixedItemsCut` | The kit checks **at most `cut.limit(k)`** items — amended by review finding 1 (§17.6): `cut.limit(k)` ≤ k for every cut, so "at most k" holds again | §14.2 |

### 17.5 Choices made while writing §17.4 and §17.6 in — for the user's review

Each follows from a decision above or an existing rule. Listed so the user can overrule any of
them.

| Choice | Why | Where |
|---|---|---|
| `SmartServerDecisionConfig` stays **one interface**: `provider: 'typesafe' \| 'sap-aicore'` + optional `deploymentId`, `resourceGroup`; the validator enforces which fields each provider takes | additive for a minor release: a consumer's own probability seam that reads `cfg.baseUrl` still compiles (a discriminated union would break it). *The release is now a major (D57–D59); the choice stands — no reason to break a seam body that the migration table does not name* | §3.8, §6.2 |
| **A second optional seam `makeRelevanceDecision`**, beside the probability seam — **approved by the user (D29, §17.7)** | the provider decides the kind, and the two kinds are different types. One seam returning a union would break code that calls the seam and uses the result as a probability decision; a tagged result would break every implementer. Two typed seams keep both compiling | §3.8, §6.2 |
| `IRelevanceDecision.score` returns `{ index, score }` entries (not a parallel array) | the shape every rerank API returns; the provider maps without reordering, and the reranker's output check (wrong count / duplicate / non-finite) has something to check | §3.9, §5.2 |
| `IRelevanceDecision` reuses `DecisionError` and its codes; no new code set | every relevance failure already has a fitting code; nothing widens a shared set | §3.8, §5.3 |
| ~~`RelevanceReranker` sends every candidate in ONE call by default; batching only when the consumer sets `maxBatchTokens`~~ — **decided otherwise by the user (D28, §17.7):** relevance scores are comparable for the same query and model (pairwise by contract), and `RelevanceReranker` batches by default like `ProbabilityReranker` (same `maxBatchTokens` / `concurrency` defaults and validation); no single-call mode | a cross-encoder scores each (query, passage) pair independently, so merging batches is sound by contract | §3.9, §5.2 |
| The probability reranker's wording constants are renamed too (`PROBABILITY_RERANK_DEFAULT_*`; *aliases withdrawn by D58*); the decision vocabulary (`DecisionRequest`, answers, `DecisionError`) is **not** renamed | the constants belong to the renamed reranker; the vocabulary is shared by both decisions (`DecisionError`) or still exactly the probability decision's request/answers — renaming it would churn every implementer for nothing | §1, §13 |
| `wrapDecisionModel` → `wrapProbabilityDecision` stays in libs; new `wrapRelevanceDecision` beside it | decided by its imports: only `llm-agent`; it wraps a decision, not an `IReranker`; its caller is server-libs. It is a usage-logging adapter like `usage-logging-embedder`, not a reranker | §5.4 |
| `assertPositiveInteger` copied into `llm-agent-reranker` | no cycle (libs depends on the reranker package) and no non-contract export in `llm-agent` | §5.4 |
| *Withdrawn by D55 (§17.17): `faceted-rerank` takes either kind.* A named variant is checked against the provider's **kind**: `faceted-cohere` ↔ relevance; `faceted-jev`, `small-set-jev` ↔ probability. `compose` with `reranker: decision` takes either | a name that cites one model's measurement must not silently run the other; the factories' argument types say the same in code | §6.2, §7.4, §7.5 |
| An explicit `question` / `task` is refused when the provider's kind is relevance | a relevance decision reads no wording; accepting it would be a silent no-op | §6.2 |
| `RelevanceReranker` / `SapAiCoreRelevanceDecision` do **no** [0, 1] check | the score is not a probability (§3.9); only finiteness is checked | §5.2, §5.3 |
| Cleanup failures: the stale ids are written **ahead** on the canonical, then settled | a crash between delete and list-update cannot lose an id; retrying a deleted id is a no-op. The cost is one extra canonical write when an item had stale records | §3.3 |
| Three provider text composers ship (`ParameterNamesToolText` default, `EnumValuesToolText`, `SchemaToolText`) as classes, not one class with flags | "no booleans where a strategy is the choice"; each is a measured layout (C0, C0e, C0s) | §7.3.1 |
| No peer on `sap-aicore-auth`; the token exchange is reused through the composition root | verified: the embedder and LLM receive an injected `IBearerCredential` built by `credential-for.ts` with `serviceKeyCredential` | §5.3 |

### 17.6 Decided by the user on 2026-10-05 — decisions split, reranker package, review findings

| # | Decision | Where |
|---|---|---|
| D24 | **A decision and a reranker are different; a probability and a relevance are different decisions** (goal decision 2026-10-05). `IDecisionModel` → `IProbabilityDecision`; new `IRelevanceDecision`; `DecisionReranker` → `ProbabilityReranker`; new `RelevanceReranker`. Old names are deprecated aliases until the next major, with a migration note. *Aliases superseded by D58: old names removed; the migration note stays.* | §3.9, §5, §13 |
| D25 | **Packages by role:** `typesafe-decision` unchanged (`IProbabilityDecision`); new `@mcp-abap-adt/sap-aicore-decision` implements `IRelevanceDecision` through AI Core `/v2/inference/deployments/<deploymentId>/rerank`. `SapAiCoreDecisionModel` is withdrawn. | §5.3, §5.4 |
| D26 | **All rerankers in ONE new package `@mcp-abap-adt/llm-agent-reranker`** (goal decision 2026-10-05) — they carry no vendor specifics: `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`. libs re-exports the old names and paths as deprecated aliases; retrieval strategies stay in libs and use rerankers only through `IReranker`. *The re-exports and aliases are superseded by D58, D59: libs exports no reranker.* | §5.4, §11, §13 |
| D27 | **One `decision:` section;** the provider decides the kind (`typesafe` → probability, `sap-aicore` → relevance); `reranker: decision` builds the matching reranker. Wording options apply only to probability and are refused for relevance at startup. *(The variant-to-kind part is withdrawn by D55, §17.17.)* A threshold on relevance scores is the consumer's calibration; no default uses one. | §6.2, §7.4 |
| F1 (review) | **The caller's k caps every cut:** effective limit `min(requestedK, the cut's own limit)`, also after decomposition; `FixedItemsCut(n)` is a ceiling. The kit calls each shipped profile with k below its default and asserts ≤ k. | §3.4, §4.5, §4.9, §14.2 |
| F3 (review) | *Companion parts superseded by D50 (§17.15): one store, `staleRecordIds` only.* **Cleanup failures are kept:** every stale delete's `Result` is checked (primary and companion); an item with a failed cleanup is never reported indexed; the ids not yet deleted stay on the canonical (`staleRecordIds`, `staleCompanionRecordIds`) and the next `index` / `remove` retries them. Failure handling, not a concurrency protocol (D13 stands). | §3.1, §3.3, §14 |
| F4 (review, measured) | The default provider text stays **C0** (measured). How the provider text is composed becomes an injected strategy (`IToolTextComposer`); the schema-enriched C0e / C0s ship as strategies in no default, documented with the `compact` numbers (within noise, no winner). | §3.5, §7.3.1 |

### 17.7 Decided by the user on 2026-10-05 — relevance comparability, the second seam, the seam rename

| # | Decision | Where |
|---|---|---|
| D28 | **Relevance scores are comparable for the same query and model** — a cross-encoder scores each (query, passage) pair independently. `IRelevanceDecision` says so (replacing "comparable only within one call"); `RelevanceReranker` **batches by default** like `ProbabilityReranker` (`maxBatchTokens` 48000, `concurrency` 4, the same validation) and merges the batches' scores into one order; no single-call default. Closes §17.5's open choice. | §3.9, §5.2, §7.4, §14.1 |
| D29 | **The second optional seam `makeRelevanceDecision` is approved** (was a §17.5 choice). | §3.8, §6.2 |
| F5 (review) | **Pinned items carry reranked scores; `keepStage1Top` + `ScoreFloorCut` rejected.** A `keepStage1Top` item keeps its stage-1 place and carries the score the reranker gave it, never the embedding score; order stays pinned first, then the rest by reranked score. `keepStage1Top` > 0 with `ScoreFloorCut` is rejected at construction (keepStage1Top is unmeasured, D7). The `onFailure: 'stage1'` fallback returns stage-1 scores, so `ScoreFloorCut` with a reranker needs `onFailure: 'error'` — the same rejection, in the constructor and the YAML validator. *The `onFailure` half is withdrawn by D71 (§17.24): there is no stage-1 fallback, so no rejection is needed; the pinned-score half stands.* | §4.2, §4.7, §4.9, §6.2, §9.3, §14.1 |
| D30 | **The released probability seam is renamed symmetric to its contract:** `BuildAgentDeps.makeDecisionModel` → **`makeProbabilityDecision`**; the app's `createMakeDecisionModel` → **`createMakeProbabilityDecision`** (`createMakeRelevanceDecision` stays). `makeDecisionModel` stays a deprecated alias until the next major; **both supplied → startup fails with an explicit error naming both** (never silently pick one); the seam-missing message names `makeProbabilityDecision`. Migration note in §13. *The alias and the both-supplied error are superseded by D58: `makeDecisionModel` is removed; the rename and the seam-missing message stand.* | §1, §3.8, §6.2, §11, §13, §14.1 |

### 17.8 Decided by the user on 2026-10-05 — the server fills a bound profile

| # | Decision | Where |
|---|---|---|
| D31 | **The server fills a bound tools profile from the MCP clients it uses, at startup.** Replaces the stated limit "the server inherits the builder's limit". On every path that hands clients to the builder through `withMcpClients` — ready clients (`BuildAgentDeps.mcpClients`, `cfg.mcpClients`, plugin clients) or an injected `connectMcp` / `connectMcpWithDescriptors` seam — the server lists the clients' tools and fills the bound store through the shipped profile path (`fillToolsBinding` → `vectorizeMcpTools`, binding read from the store (D34) → `toolItemFromTool` + `IToolRecordKey` → `bound.index`), once per store, before it reports ready; `/health` reads that status (the small-set check went with D55); failures follow the 30.1.0 tool-catalog policy (counted, logged, `degraded` — never a silent empty store). Workers reading the main store are not filled again. Without a bound profile nothing changes. The builder keeps its limit for `withMcpClients` / `withMcpServers` (no startup phase). *When a worker's store is filled is amended by D35 (§17.9).* | §6.1, §6.3, §3.8, §14.1 |
| D32 | **A worker's fill keeps the identity its agent dispatches by** (review finding on D31). Filled from the shared clients → the same `_sharedMcpClientDescriptors`, `_configuredSlotCount` and `IToolNamespace` as the main fill, and the worker's builder receives those clients with the same descriptors (existing `withMcpServers`, one already-connected `IMcpServer` per client) and the server's namespace (`withToolNamespace`), so the stored names are the names it can call. Own `mcpClients` → no descriptors exist: array order on both sides. Own `mcp:` → its own builder fills and dispatches from one connection. No contract change. Also fixes 30.1.0 workers on the shared clients exposing `s<i>__<tool>` where the main catalog has `<label>__<tool>`. *For the user's review:* the `withMcpServers` adapter over an optional `descriptors` parameter on `withMcpClients` (a public builder change) — recommendation applied, §17.9 | §6.3, §3.8, §14.1 |
| D33 | *Superseded by D50 (§17.15): intents and companion stores are removed.* **Companion storage per primary binding** (review finding on Tasks 22–23). The profile instance may be shared; each primary binding (main, each worker with its own `rag`) gets companion stores of its own, built by the server through `makeRag` with that primary's embedder; a binding that reads another's primary shares its companions. Separate stores, not a binding segment in `recordId`: they isolate reads as well as writes, with no contract change. *For the user's review:* a persistent (non-in-memory) companion store with a worker that has its own `rag` is refused at start, rather than deriving a second collection name — recommendation applied, §17.9 | §6.2, §7.3.3, §3.8, §14.1 |

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
| A persistent companion store with a worker that has its own `rag` (D33's open choice) | *Superseded by D50 (§17.15): no companion stores.* **refused at startup**, naming the worker — no derived second collection name | §6.2, §7.3.3 |
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
| D42 | *Amended by D46 (§17.12): `IToolsFillSource` has `fill` only. Amended by D54 (§17.17): `prebuilt` is removed; three sources.* **The fill source is a strategy the consumer injects**: `IToolsFillSource` (`fill` at creation, `toolsChanged` on a reconnect) with `ToolsFillContext` (binding, target, `indexLiveTools`, logger), attached with the binding (`bindToolsProfile(profile, target, source?)`, default `LiveToolsFill`) and read from the store like it (D34). Shipped: `live`, `corpus` (`ToolsCorpusLoader`), `prebuilt` (`PrebuiltToolsStore`), `consumer` (`ConsumerToolsFill`). YAML `rag.profiles.tools.fill`; a consumer's own through `toolsFillFactories`. Compatibility (`corpus`, `prebuilt`) is checked at creation and fails loudly; the profile and embedder fingerprints are the consumer's names (`ToolsCorpusIdentity`), because no contract carries one | §3.8, §3.10, §6.1, §6.2, §6.3 |
| D43 | *Amended by D54 (§17.17): `deployToolsCorpus`, the service record and `serviceRecord` are removed; `buildToolsCorpus` and `parseToolsCorpus` stay; the server loads the corpus at start.* *Amended by D48 (§17.13): a deploy after an unfinished one rewrites the whole corpus; `prebuilt` refuses an unfinished store. Amended by D51 (§17.15): every deploy that is not unchanged deletes and rewrites in full; the service record lists ids, no record hashes; no companion stores (D50).* **Offline corpus API**: `buildToolsCorpus` (build step: provider tool definitions → records + vectors with the profile's own indexer and record writer over capture stores, and an embedder), `parseToolsCorpus`, `deployToolsCorpus` (deploy step: any store with precomputed writes, in place, one current state, idempotent, write-ahead, a service record with the fingerprint, the corpus hash and record hashes). Reserved record key `serviceRecord`; `StagedRetrieval` drops a hit that carries it. Recommended: in-memory → `corpus`; persistent → `prebuilt` | §3.1, §4.3, §6.5, §7.8, §13 |
| D44 | *Superseded by D46 (§17.12): no source answers `toolsChanged`; a bound store is not written on a reconnect.* **`toolsChanged` is the source's answer**: `live` and `consumer` re-index what is listed through the profile, as 30.1.0; `corpus` and `prebuilt` write nothing and log a warning (the user's decision: `ToolsCorpusLoader` fills the in-memory store at creation and does nothing else; the process never writes a prebuilt store). D40 stands: a tool no longer listed keeps its records | §3.10, §6.3, §6.4 |
| D45 | **Single-flight worker construction and the drain ordering move out of this PR** — a pre-existing 30.1.0 race unrelated to profiles, described in §15 for a separate issue. D37 and its plan task are withdrawn here; no remaining task depends on them | §6.3, §13, §15 |

### 17.12 Decided by the user on 2026-10-05 — fill sources fill once; no `toolsChanged` reaction for bound profiles

From the goal's updated decision of 2026-10-05 (*with a profile bound, the library does not react
to `toolsChanged`*).

| # | Decision | Where |
|---|---|---|
| D46 | **No reaction to `toolsChanged` for a bound store.** Until its collections are filled the pipeline and its MCP do not work, so the tool list cannot change under a working pipeline; the only case is an MCP server plugged in at runtime, and a consumer who builds such a pipeline does its own checks and filling in it. So: `IToolsFillSource` loses `toolsChanged` — the contract is `fill`, once at instance creation; `McpToolRegistry.revectorizeTools` with a bound store (found through decorators) writes nothing, calls no source, lists nothing, and logs one line under the `mcp` debug area (no warning); `vectorizeMcpTools` is reached for a bound store only from creation paths. `corpus` never writes on `toolsChanged` by construction (`prebuilt` removed by D54); `ConsumerToolsFill`: the library never writes. **Without a profile, 30.1.0 behaviour is unchanged** (the legacy re-vectorize stays). Supersedes D44; amends D34, D40, D42 | §3.8, §3.10, §6.1, §6.3, §6.4, §7.6, §13, §14.1, §15 |
| D47 | *(1) amended by D50 (§17.15): no companion set to check. (1), (3) amended by D54 (§17.17): `prebuilt` is removed; `corpus` also checks `dimensions` against the store's declared one.* **Approved as proposed:** (1) the corpus / prebuilt fingerprint is the consumer-named `ToolsCorpusIdentity { profile, embedder }` plus the library's own checks (the binding's `profileName`, the companion set, the corpus format and one vector dimension); (2) a worker construction whose fill throws drops that worker's cache entry before rethrowing; (3) a worker with its own `rag` and its own clients is refused when the fill source is `corpus` or `prebuilt` | §3.10, §6.2, §6.3, §14.1 |

### 17.13 Review finding on 2026-10-05 — an unfinished corpus deploy is rewritten in full

| # | Decision | Where |
|---|---|---|
| D48 | *Withdrawn by D54 (§17.17): no deploy step, no service record.* *Generalized by D51 (§17.15): every deploy that is not unchanged rewrites in full; the hash-skip for a `final` record is withdrawn.* **A deploy after an unfinished one rewrites the whole corpus.** The service record carries `state: 'pending' \| 'final'`; the write-ahead record (`pending`) is written before the first record write, so any interruption leaves it set. When the record read at the start is not `final` (or absent), `deployToolsCorpus` does not trust its per-record hashes — the unfinished run may have overwritten or deleted any record they describe — and writes every record of the requested corpus, deletes the listed and pending ids the corpus does not hold, then finalizes. When it is `final`, the hash-skip optimisation stays (and a matching `corpusHash` answers `unchanged`). `PrebuiltToolsStore` refuses a store whose record is not `final`, loudly at instance creation. One current state: no journals, no generations (the user's principle). Amends D43 | §3.10, §6.5, §14.1 |

### 17.14 Review finding on 2026-10-05 — an empty corpus is valid

| # | Decision | Where |
|---|---|---|
| D49 | *Amended by D54 (§17.17): the build half stands; the deploy half is withdrawn — at start an empty corpus clears the store and writes nothing.* **An empty tools corpus is valid.** `buildToolsCorpus` with no items builds a corpus of zero records whose manifest has `items: 0`, `records: 0` and no `dimensions`; `parseToolsCorpus` accepts it and checks dimensions only when there are records. `deployToolsCorpus` of an empty corpus runs the same pending → final protocol: deletes every listed and pending record and finalizes a zero-item manifest (the service record's vector keeps the store's previous service-record dimension; an empty corpus into a store with no service record throws before any write). `ToolsCorpusLoader` and `PrebuiltToolsStore` with an empty corpus report a complete catalog of 0 tools. So a consumer that removes every tool can deploy the replacement corpus instead of keeping the old one. Amends D43, D48 | §6.5, §14.1 |

### 17.15 Decided by the user on 2026-10-05 — intents and companion stores removed; the corpus deploy written in full

| # | Decision | Where |
|---|---|---|
| D50 | **Intents are removed entirely** (goal decision 2026-10-05, which replaces the earlier rows on intents and generated variants). They did not justify themselves: within noise without a reranker, no better with one; the reranker reads the provider text better without them; they cost LLM generation at build, regeneration and audits (one audit found poisoned intents); and they mislead (`CreateDdl`: the generated "create database view" is a different object type). Records are built only from what the provider exports (`FacetedToolIndexer` with `SummaryFacet` / `ParametersFacet`, `NameTailFacet` opt-in, `EnumValueToolIndexer` opt-in, `IToolTextComposer`). Removed with them, since they existed only for intents: the `intent` record kind, `IntentRecordIndexer`, `IntentCompanionIndexer`, `IToolIntentSource`, `StaticIntentSource`, `LlmIntentSource`, the intent placements; **companion stores** — `CollectionStore.companions`, `ComposedToolsProfileOptions.companions`, `RetrievalSource.role` / `itemsOf` (`variants` sources), per-binding companion storage (D33) and its persistent-companion refusal, companion handling in the record writer, `remove` and replacement; the reserved keys `companionRecordIds`, `staleCompanionRecordIds` and `generated` (`IndexedRecord.generated`); the YAML `intents` key (a leftover one is refused at startup); the corpus's companion parts (`ToolsCorpusManifest.companions`, `ToolsCorpusRecord.store`, `buildToolsCorpus`'s `companions`). Supersedes D3, S2, S7, D33, the §17.1 line on intents' home, the §17.9 persistent-companion choice; amends F3 and D47(1) | §1, §2.1, §3.1–§3.5, §3.8, §3.10, §4.4, §4.6, §6.2–§6.5, §7.2–§7.4, §7.6, §7.8, §10.3, §11, §14 |
| D51 | *Withdrawn by D54 (§17.17): no deploy step; the load at start clears the store and writes the corpus.* **The corpus deploy writes the whole corpus — no per-record diffing** (approved by the user). Final record with the same corpus hash and identity → unchanged, no write. Otherwise: write ahead `pending` listing every id the store holds or may hold (old ∪ new); delete every id the old service record lists (pending ones included); write the whole corpus; finalize with the corpus's ids. The service record drops its per-record `hashes`; `ToolsCorpusDeployReport.upserted` → `written`. Deleting first is what makes the replacement whole on a merging store (`InMemoryRag`, `VectorRag` merge metadata on an in-place upsert); verified that `VectorRag.deleteByIdRaw` and `InMemoryRag`'s delete remove the whole slot (§6.5). Empty corpus (D49) unchanged in rule: deletes everything, keeps the store's service-record dimension. Generalizes D48; amends D43 | §6.5, §7.8, §14.1 |

### 17.16 Review findings on 2026-10-05 — `FallbackRag` optional writer capabilities (dispatched by the user) — *withdrawn by D68 (§17.23)*

| # | Decision | Where |
|---|---|---|
| D52 | ***Withdrawn by D68 (§17.23):** `FallbackRag` is removed; no decorator in this design needs the rule (`StrategyRag` returns its inner writer unchanged, the others expose none), and the corpus load checks the writer of the store it writes — no resolved-backend check. Kept for the record:* *Read with D54 (§17.17): the corpus step is `ToolsCorpusLoader` only. Completed by D62 (§17.20): no writer at all over a primary without one.* Generalized by the second review finding of 2026-10-05 (dispatched by the user): the rule, not one member.* **The rule: a decorator's writer exposes an optional member of `IRagBackendWriter` (`upsertPrecomputedRaw`, `upsertManyPrecomputedRaw`, `clearAll`) only when its backend's writer has it** — it may leave one out, never emulate one. **`FallbackRag` exposes `upsertPrecomputedRaw` and `clearAll` each only when its primary (authoritative) writer has it.** Before, it always exposed both: over a raw-only primary, the precomputed write called the primary's `upsertRaw` — the vector dropped, the text re-embedded silently; over a primary without `clearAll`, `clearAll` returned success without clearing it — so the corpus load's capability checks passed and it then embedded, or appended the corpus to the old records and reported complete. The fallback mirror is unchanged; `upsertManyPrecomputedRaw` is not added. The other decorators follow the rule already (`StrategyRag` passes its inner writer through; `ActiveFilteringRag`, `OverlayRag`, `SessionScopedRag` expose no writer). **The corpus load checks every capability it uses on the resolved backend too:** `ToolsCorpusLoader` requires a precomputed write **and** `clearAll` on the given store's writer **and** on the innermost store's writer (through `IRagDecorator.inner`, ≤ 16 levels), and throws before any mutation or embedding call otherwise. No contract change; a behaviour change of one implementation (§13 note, changelog "Fixed"). Tests: the loader through `FallbackRag` over a raw-only writer → rejected, nothing written, no embedder call; over a precomputed-capable writer → works with no embedding call; over a precomputed-capable writer without `clearAll` → rejected, nothing written, no embedder call; a decorator claiming the precomputed write over a raw-only store, or `clearAll` over a store without it → rejected; `FallbackRag` writer shape for each primary (with / without each member, no writer) | §3.8, §3.10, §6.5, §10.4, §11, §13, §14.1 |

### 17.17 Decided by the goal on 2026-10-05 — layers, corpus flow, no tuned numbers (D53–D56); S10 decided in §17.18

From the goal's three newest decisions of 2026-10-05 (layers; corpus flow; measurements).

| # | Decision | Where |
|---|---|---|
| D53 | *`FallbackRag` is removed by D68 (§17.23), not moved.* **The RAG implementations' home is `@mcp-abap-adt/llm-agent-rag`.** Every RAG implementation in `@mcp-abap-adt/llm-agent` (`rag/`, `resilience/fallback-rag.ts`) is classified contract vs implementation (§11.3): the implementations — `VectorRag`, `InMemoryRag`, `FallbackRag`, `OverlayRag`, `SessionScopedRag`, `ActiveFilteringRag`, `SimpleRagRegistry` + `ragStoreKey`, the `InMemoryRag` / `VectorRag` providers and `SimpleRagProviderRegistry`, the five search strategies, the six preprocessors / enrichers, the two query expanders, the RAG collection tools — are exported from `llm-agent-rag`; the `llm-agent` root keeps them as `@deprecated` aliases until the next major; `llm-agent-rag` re-exports them from the new subpath `@mcp-abap-adt/llm-agent/rag-implementations`; every in-repo importer above `llm-agent-rag` switches. The contract types inside implementation files (`IQueryExpander`, `IQueryPreprocessor`, `IDocumentEnricher`) move to `interfaces/`. Stays, with the reason in §11.3: the identity filter, the error classes and correction-metadata convention, the store kit the store packages below `llm-agent-rag` need (`AbstractRagProvider` + its edit / id strategies and catalog helpers, the query embeddings, the retrieval-embedder adapters), the non-RAG resilience decorators. `tools-rag-handle` stays in server-libs, `HealthChecker` in libs (the goal). The conformance kit stays with the contracts (§14.2). *The aliases, the subpath and "files in the next major" are superseded by D57: the files move in this PR, without aliases* | §3.8, §10.4, §11, §11.2, §11.3, §13, §14.1, §15 |
| D54 | **The server loads the ready corpus at start.** The consumer's build step makes the corpus (`buildToolsCorpus`, libs); the server's `corpus` source (`ToolsCorpusLoader`, libs) checks it against the server's configured identity (profile, embedder, the store's declared `dimension`) and the store's capabilities (a precomputed write and `clearAll` on the writer of the store it writes — D68 withdrew D52's resolved-backend check), then clears the store, writes the corpus with its precomputed vectors and logs one line — in-memory and persistent stores alike. A store without `clearAll` is refused, not loaded by deleting the corpus's ids (the store may hold others). An interrupted load repeats at the next start. **Removed:** `deployToolsCorpus`, `ToolsCorpusDeployReport`, `PrebuiltToolsStore` and the `prebuilt` source / YAML key (a leftover is refused), the service record (pending / final, ids, hashes), `TOOLS_CORPUS_RECORD_ID`, the reserved key `serviceRecord` and `StagedRetrieval`'s drop of it, the `prebuilt`-over-`in-memory` refusal; D48 and D51 withdrawn; D49 keeps its build half (an empty corpus clears the store at start). Fill sources: `live`, `corpus`, `consumer`. Layers: build step → the consumer (+ the libs API); load at start → the server, through the corpus source in libs (§11.2 item 4). Supersedes D43's deploy and service-record parts; amends D42, D46, D47, D52 | §3.1, §3.8, §3.10, §4.3, §6.2–§6.6, §7.8, §10.4, §11, §13, §14.1, §15 |
| D55 | **Nothing that ships carries a tuned number.** The measurements were made in a consumer and are not in this repository, so they justify no default: no strategy class and no named composition carries a measured number; a number it needs is a required argument from the consumer or a generic default (§7.1). The evidence (§2) stays as motivation, pointing to cloud-llm-hub's `research/tool-rag-accuracy` branch. Named compositions: `baseline`, `faceted` (pool and cut: the caller's k, or the consumer's `poolItems` / `maxItems`), `faceted-rerank` (the consumer's `IReranker`, a required `poolItems`, cut: the caller's k or `maxItems`). **Withdrawn**, because without their measured numbers nothing distinguished them: `faceted-cohere`, `faceted-jev` (vendor names over `faceted-rerank`), `small-set-jev` (= 30.1.0's `rerank-all`, or `compose` with `poolItems` ≥ the tool count) with `assertSmallSetPool` and the YAML `smallSet` key, and the variant-to-decision-kind check. Leftover YAML names are refused, naming the replacement. Supersedes D11, D20's composition, D23, the variant part of D27 and §17.5's variant-kind choice; D16 read with it | §2, §4.9, §5.2, §5.5, §6.2, §7.1, §7.4, §7.5, §8.5, §8.6, §11.2, §13, §14 |
| D56 | **Generic defaults: the caller's k.** The final cut defaults to the caller's k (`TopItemsCut`, as before); the candidate pool defaults to **k items** of the (sub-)query (`ItemPool()`, i.e. `k × maxRecordsPerItem` records) — the fewest that can fill the cut, guessing no catalog size. So `ICandidatePool` takes k: `items(requestedK)`, `recordsToFetch(requestedK, maxRecordsPerItem)` (new in this spec — no released contract changes); `pool` is optional in `StagedRetrieval`, `ComposedToolsProfile` and `SharedItemsProfile`. Kept as they were, not retrieval tuning: the ~4 chars/token size estimate, `RelevanceReranker`'s 30.1.0 batching limits | §3.4, §3.8, §4.2, §4.4, §4.9, §7.1, §7.2, §8.6, §14.1 |

**S10 — decided by the user on 2026-10-05 (§17.18, D57): the alternative below — the files move
now, without aliases, in a major release.** Kept as written for the record:

- **The conflict.** `@mcp-abap-adt/llm-agent-rag` depends on `@mcp-abap-adt/llm-agent` (it
  imports the contracts). For `llm-agent` to keep exporting a class whose file is in
  `llm-agent-rag`, it would have to import `llm-agent-rag` — a package cycle: `tsc -b` cannot
  order the two, a clean build fails, and at run time each package's module graph would load the
  other. The store and embedder packages are in the same position: `llm-agent-rag` depends on them
  (optional peers), so they cannot import it either.
- **What this spec does (recommended, D53):** the **public home** moves now — `llm-agent-rag`
  exports every implementation, every in-repo importer above it uses that path, the old path is a
  deprecated alias, and the contract types leave the implementation files; the **files** move in
  the next major, when the aliases are removed anyway. Every goal statement holds except the
  physical location of the source in this release: nothing breaks for a 30.1.0 consumer (goal:
  "nothing changes for current consumers"), the release stays minor, no cycle. The code edits of
  this PR to `VectorRag` (F1) and `FallbackRag` (D52) therefore land in `packages/llm-agent/src/`.
- **The alternative:** move the files now and remove the names from `@mcp-abap-adt/llm-agent`
  without aliases — a breaking change (a major release; every consumer importing `VectorRag`,
  `InMemoryRag`, `FallbackRag` from `llm-agent` changes its imports; `OllamaRag` in
  `ollama-embedder` is removed or moved in the same release, since it extends `VectorRag` from
  below `llm-agent-rag`).
- **Also reported, not resolved here:** the store kit (`AbstractRagProvider` and what it builds on,
  the query embeddings, the retrieval-embedder adapters) stays in `llm-agent` in either option —
  moving it needs a package below both `llm-agent-rag` and the store packages (§11.2 item 1).

### 17.18 Decided by the user on 2026-10-05 — a major release without aliases or re-exports (D57–D60); S11, S12 and the search-strategy types decided

From the goal's newest decision ("No deprecated aliases", 2026-10-05) and the user's instructions of
the same day.

| # | Decision | Where |
|---|---|---|
| D57 | *`FallbackRag` is removed by D68 (§17.23), not moved.* **The RAG implementations really move now** (S10 decided: the alternative). The files of every class of §11.3's "moves" table — `VectorRag`, `InMemoryRag`, `FallbackRag`, `OverlayRag`, `SessionScopedRag`, `ActiveFilteringRag`, `SimpleRagRegistry` / `ragStoreKey`, the providers, the search strategies (with their types), the preprocessors / enrichers, the query expanders, `buildRagCollectionToolEntries`, their config / option types, the private `InvertedIndex` and tokenizer — and their tests move to `packages/llm-agent-rag/src/`. `@mcp-abap-adt/llm-agent` stops exporting them; no `rag-implementations` subpath; no aliases. `IQueryExpander`, `IQueryPreprocessor`, `IDocumentEnricher` move to `llm-agent/src/interfaces/`. Nothing left in `llm-agent` imports a moved file (verified, §11.3); a repo test pins that `llm-agent` does not depend on `llm-agent-rag`. Every importer switches to `llm-agent-rag`. The store kit stays in `llm-agent` (unchanged). Supersedes the "public home now, files in the next major" of D53 and amendment (12) | §1, §3.8, §10.4, §11, §11.3, §13, §14.1, §15, §16 |
| D58 | **No deprecated aliases anywhere** — a major release. Removed without an old name: `IDecisionModel`, `DecisionReranker` / `DecisionRerankerOptions`, `DECISION_RERANK_DEFAULT_TASK` / `_CRITERIA`, `wrapDecisionModel`, `BuildAgentDeps.makeDecisionModel` (and with it the "both supplied" startup error and its tests), the libs-root reranker exports, the RAG implementations' `llm-agent` exports. Every in-repo use takes the new name. The CHANGELOG has a **Breaking** section with one migration line per removed or moved name (§13: 51 lines, 69 with S12, 70 with `ITextLogger`, 72 with D68). The plan does no version bump or publish; its docs task says the release is a major. Supersedes the alias parts of D24, D26, D30, D53, §17.5 and amendments (4), (5), (12) | §1, §3.8, §3.9, §5.4, §6.2, §11, §13, §14.1 |
| D59 | **No re-exports at all.** Every consumer — our own packages included — imports a name from the package that owns it. `llm-agent-libs` re-exports nothing from `llm-agent-reranker` or `llm-agent-rag`; `llm-agent-rag` exports only what lives in it; `@mcp-abap-adt/llm-agent` exports no implementation it moved. The migration table says where each name is imported from now. The pre-existing re-exports are removed in this major too (S12, decided below; §11.4) | §3.8, §5.4, §11, §11.4, §13, §14.1 |
| D60 | **Replicas over one persistent tools store: accepted as is.** Each replica clears and reloads the store at its start, and the others read a partial store meanwhile — the price of the simple corpus flow (D54). No marker or coordination is added | §3.10, §6.5, §11.1 |

**The search-strategy types — decided by the user on 2026-10-05** (written in as a choice for
review while writing D57 in; the user chose it): `ISearchStrategy`, `ISearchCandidate`,
`ISearchQuery`, `IScoredResult`, `ISearchContext` move **with `VectorRag`** to `llm-agent-rag`
rather than to `interfaces/`. They are `VectorRag`'s option types, used by
nothing outside `VectorRag`, the strategies and `llm-agent-rag`'s factories, and `ISearchContext`
names the `InvertedIndex` class, which moves; putting them in `interfaces/` would need a new
interface for `InvertedIndex`. One migration line each (§13, lines 22–26).

**S11 — decided by the user on 2026-10-05: remove `OllamaRag` (package cycle).** Moving it into `llm-agent-rag` was considered and rejected: it would make `ollama-embedder` a hard dependency of `llm-agent-rag` (today an optional, dynamically imported peer), put vendor code in a vendor-free package, and duplicate what the factory already builds. `@mcp-abap-adt/ollama-embedder`
exports `OllamaRag extends VectorRag`. `@mcp-abap-adt/llm-agent-rag` depends on `ollama-embedder`
(optional peer, dev dependency, `tsconfig` reference — it loads the Ollama embedder by name), so
once `VectorRag` lives in `llm-agent-rag`, `ollama-embedder` cannot import it: a package cycle and
a `tsc -b` reference cycle. Options:

- **(recommended, written into this spec and the plan) remove `OllamaRag`.** A 6-line convenience
  with no user in the repo; the major release already breaks imports; migration line 51:
  `new VectorRag(symmetricEmbedder(new OllamaEmbedder(cfg)), cfg)`.
- Move `OllamaRag` into `llm-agent-rag`: it would import `OllamaEmbedder` statically, turning an
  optional peer into a required one for every `llm-agent-rag` consumer.
- Drop `ollama-embedder` from `llm-agent-rag`'s peers and references and load it only at run time:
  `llm-agent-rag` loses its compile-time view of the Ollama factory's types (`typeof
  import('@mcp-abap-adt/ollama-embedder')`), and the build order would no longer guarantee it.

Only Task 1A's `OllamaRag` step depends on the choice.

**S12 — decided by the user on 2026-10-05: remove the pre-existing re-exports in this same
major** (§11.4). Every public entry point exports only the names its package declares:

- libs' root stops exporting `AgentCallOptions`, `BaseAgentLlmBridge`, `OrchestratorError`,
  `SmartAgentResponse`, `StopReason`, `CounterSnapshot`, `HistogramSnapshot`, `MetricsSnapshot`,
  `BuiltInStageType`, `ControlFlowType`, `StageDefinition`, `StageType`, `IPluginLoader`,
  `LoadedPlugins`, `PluginExports` — all declared in `@mcp-abap-adt/llm-agent` (lines 52–66);
- server-libs' `./legacy/flat` held only the re-export of `SmartAgentBuilder`: the file and the
  subpath go (line 67); `./legacy/linear` and `./legacy/dag` hold own code too (`LinearFactory`;
  `DagFactory`, `buildDagCoordinatorDeps`), so only their `CoordinatorHandler` /
  `DagCoordinatorHandler` lines go (lines 68–69); `./legacy/stepper` re-exports nothing;
- `llm-agent-server`'s `src/index.ts` (`export * from '@mcp-abap-adt/llm-agent-server-libs'`) is
  deleted; no migration line — the package's `exports` lists only `./package.json`, so nothing
  could import it;
- libs' internal type-only shims stay: no `exports` path reaches them, and libs' own files import
  through them (§11.4 rule (a));
- names a package declares itself stay even when built from another package's type
  (`SmartAgentHandle`, libs' `IStageHandler`) — §11.4 rule (b); `llm-agent`'s `ITextLogger`, the
  same type as `interfaces-utils`' `ILogger` under a second name, is removed (below);
- every in-repo importer switches to the owner in the same commit; a repo test over the built
  entry points (§14.1) keeps any package from re-exporting another's names again.

Migration: 18 more lines (§13, lines 52–69; 69 with S12).

**§11.4's four questions — decided by the user on 2026-10-05:**

| # | Question (§11.4) | Decision | Where |
|---|---|---|---|
| 1 | `llm-agent`'s `ITextLogger` — a second name for `@mcp-abap-adt/interfaces-utils`' `ILogger` | **removed.** Every in-repo use (17 occurrences in 9 files) imports `ILogger` from `@mcp-abap-adt/interfaces-utils`; `text-logger.ts` and its root line go; no re-export. `llm-agent` already peers on it; libs and mcp (tests only) get a dev dependency. Migration line 70 — **70 lines in total** (72 with D68, §17.23) | §11.4, §13 |
| 2 | libs' dead internal files `adapters/index.ts`, `interfaces/model-resolver.ts` | **deleted** (no importer, no `exports` path — verified again); no migration line | §11.4, §13 |
| 3 | `SmartAgentHandle`, libs' `IStageHandler` (specialisations declared in libs) | **kept** (rule (b)) | §11.4 |
| 4 | libs' internal, non-public shims | **kept** (rule (a)) | §11.4 |

### 17.19 Review finding on 2026-10-05 — duplicate item ids in one batch

| # | Decision | Where |
|---|---|---|
| D61 | **An `index` batch with a duplicate owner-qualified item id is rejected whole.** Same owner + item id = same canonical record id. Two versions of one item in one batch both read the same old canonical (step 1 of §3.3), and the version whose canonical is written last lists only its own records: the other version's extra records (e.g. a `note` the replacement no longer has) are listed nowhere, so no later `index` or `remove` deletes them. The binding checks the whole batch after preparing the items and **before any store read or write**; duplicates → `ok: false` with a `RagError` naming each duplicate and its count — nothing is written in any partition (the shared-items binding writes several, so the check is over the batch, not per store). The record writer runs the same check first and reads or writes nothing on a duplicate. Same item id under another owner is a different item. Tested: two versions of one item → rejected, store untouched (no read, no write); the note-record + replacement scenario leaves no untracked record; a duplicate after an item of another partition → that partition is not written either. Failure handling, not a concurrency protocol (D13 stands) | §3.3 |

### 17.20 Decided by the user on 2026-10-05 — `FallbackRag` without a primary writer — *withdrawn by D68 (§17.23)*

| # | Decision | Where |
|---|---|---|
| D62 | ***Withdrawn by D68 (§17.23):** `FallbackRag` is removed; the `relevant-skills:<group>` collections are no longer wrapped, so they have no writer as registered. Kept for the record:* **`FallbackRag.writer()` returns `undefined` when its primary has no writer** (`if (!pw) return undefined;`), **even when the fallback has one** — no reported success for writes the primary never receives. Decides the item §10.4 left "reported, not decided" after D52 (whose rule covers the optional members only). Before, over a writerless primary it returned a writer whose `upsertRaw` / `deleteByIdRaw` / `clearAll` / `upsertPrecomputedRaw` returned `ok: true` for the primary and wrote only the fallback. Concrete case: the builder's circuit-breaker loop wraps every registered store in `FallbackRag(store, new InMemoryRag(), breaker)`, so the `relevant-skills:<group>` collections (`skillsRagSource`, no writer) got a writer from the wrap. Every `writer()` caller in `packages/` checked (§10.4): registry delete and the edit strategies unchanged (provider-only path; editors built from the unwrapped store); the 30.1.0 tools / skills vectorization skips a writerless tools store (status unknown) instead of reporting it complete; the history upsert logs `history_upsert_failed` instead of a silent fallback-only write; `StrategyRag` passes `undefined` through; the corpus load refuses the store. No contract change (`IRag.writer` is optional and may return `undefined`); a behaviour change of one implementation (§13 note, changelog "Fixed"). Test: primary without a writer + fallback with one → `writer()` is `undefined` | §1, §3.8, §10.4, §13, §14.1 |

### 17.21 Review finding on 2026-10-05 — decomposed results merge without cross-query scores

| # | Decision | Where |
|---|---|---|
| D63 | **The merge of sub-query results never compares scores across sub-queries; a decomposer never goes with `ScoreFloorCut`.** Scores are comparable only for the same query (§3.9, D28), and each sub-query is reranked against its own text. The previous merge kept a duplicate item's **best** score across sub-queries — a comparison the contract does not allow — and a `ScoreFloorCut` over the merged union would apply one threshold to scores of different queries. Now: (a) the union is built in sub-query order, each sub-query's own ranked list (its own `k`); a duplicate item stays at its **first** occurrence with that occurrence's score; then the one cut runs over the union by position and the result is truncated to `budget` ≤ k. (b) `StagedRetrieval` with a `decompose` and a `ScoreFloorCut` throws at construction (`StagedRetrieval: a decomposer cannot be combined with ScoreFloorCut — …`), like `keepStage1Top` + `ScoreFloorCut` (§4.7); the YAML validator refuses `compose.cut: { score-floor }` with a profile-level `decomposer` or a `compose.decomposer` other than `none`. Tests: two sub-queries with a floor → rejected at construction; the same item in both sub-queries with different scores → kept once at its first position and score; at most `budget` ≤ k items | §4.2, §4.5, §4.9, §6.2, §14.1 |

### 17.22 Review findings and a user decision on 2026-10-05 — per-store corpus checks, fill before skills, orphans and the pool, injected strategy ownership

| # | Decision | Where |
|---|---|---|
| D64 | **An injected MCP connection strategy is owned by the agent / pipeline it is injected into** (decided by the user). `handle.close()` disposes it, and so does a `build()` that fails (it has no handle to close it then, §6.3, D47); the consumer must not reuse it after either — it injects a new one into the next builder. Stated in `docs/INTEGRATION.md` (`IMcpConnectionStrategy` → *Builder usage*) and in the `withMcpConnectionStrategy` doc comment. Before, a failed build left an injected strategy alive; no contract changes (`IMcpConnectionStrategy.dispose` is already optional and called by `close()`) | §6.3, §14.1 |
| D65 | **A corpus is checked against every tools store it is bound to, before any store is created.** One `corpus` source binds the main store and every worker store the server builds, each from its own store config (`_workerRagInput`), but its expectation carried only the main store's `dimension`. Now the server checks the corpus's vector dimension against the main tools store's declared `dimension` **and each worker's own** when it resolves `fill` — before any store exists — and fails startup naming each differing store and both dimensions. Chosen over a per-store check at each store's creation: that keeps each store untouched until its own checks pass, but would clear and load the main store before a worker's mismatch failed the start; at resolution nothing is touched anywhere. The other identity checks (`profile`, `embedder`, the binding's `profileName`) are server-wide — one `fill`, one profile — and still run at each store's creation, before its clear. Test: main dimension 2, a worker store 3, corpus 2 → startup fails naming the worker; zero clears and writes in every store | §3.10, §6.2, §14.1 |
| D66 | **A store is filled before skills are vectorized into it, on every path.** Skills coexist in the tools store (D4, goal 8, §7.7) and the builder writes them during `build()`; the server's fill ran after the startup `build()` on the ready-client / plugin / injected-seam paths, and the `corpus` source clears the store — erasing them. Least invasive order, no new builder behaviour: the server fills the main store right after the clients are resolved, before the startup build; the builder's own auto-connect already fills before skills; a worker's construction already fills before `subBuilder.build()`; the one store filled after its build (a worker on the shared clients under `yamlBuilderConnect`, D38) is built with `withSkillManager(m, { vectorize: false })` and its skills are vectorized right after the deferred fill (`FillToolsBindingOptions.skills`, libs, new in this PR). Rejected: running the fill inside `build()` on the `withMcpClients` path (changes §6.1's "no vectorization there" for every consumer). Tests: corpus fill + a skill manager on the ready-client path and on the deferred shared-worker path → skill records searchable after start; a live fill unaffected | §6.3, §6.4, §7.7, §14.1 |
| D67 | **Orphans never use up the candidate pool.** `runOne` cut the collapsed units to `pool.items(k)` before any canonical record was read, so with the default `ItemPool()` (pool = k) a top orphan at k=1 dropped a valid item fetched below it. Now what was fetched beyond the pool is kept (the overflow, stage-1 order); when the ranked pool hydrates to fewer than k items, the next overflow items are ranked like the pool (the reranker on the same query, D28; no `keepStage1Top` pins) and hydrated, until k items or the overflow is spent — before the cut; no new query; the run's rerank outcome is the most severe of its calls. The replacements are **merged with the surviving pool items by descending score** (reranked, or stage-1 without a reranker — the same query, so comparable), never appended: appended, a replacement outscoring a surviving item would sit below it and `ScoreFloorCut` (it stops at the first below-floor score) would drop it; `keepStage1Top` pins keep their head places and the merge orders the rest; scores of different scales (one call fell back to stage 1) are never compared — then the replacements stay after the pool's items. Rejected: validating every pooled item before reranking — a canonical read per pooled candidate, which the `itemText` shortcut exists to avoid. Tests: default pool (omitted), k=1, a top orphan + a valid second item → the valid item; k=2, an orphan + a surviving item at 0.1 in the pool, an overflow replacement at 0.9, `ScoreFloorCut({ minItems: 0, maxItems: 2, minScore: 0.5 })` → the 0.9 item (reranked and stage-1); a pin stays at the head *D71 (§17.24): no reranker call falls back any more, so the two-scales case is gone — a run's merged scores are always one scale.* | §4.3, §4.4, §4.6, §14.1 |

### 17.23 Decided by the goal on 2026-10-05 — `FallbackRag` removed (D68)

From the goal's newest decision ("`FallbackRag` is removed", 2026-10-05).

| # | Decision | Where |
|---|---|---|
| D68 | **`FallbackRag` is removed, and the builder wraps no store.** When RAG has problems they are deeper, and llm-agent cannot solve them; a fallback to an in-memory copy only hides the failure behind empty or partial results. Removed with it, because each existed only for it (checked with `git grep` over `packages/`): the builder's circuit-breaker loop over the registry and `isGuardedBy`; `SimpleRagRegistry.replaceRag`; `SmartAgentBuilder.withCircuitBreakers` with `_sharedBreakers`, and the server's call of it; the embedder breaker `withCircuitBreaker(config)` built (fed by nothing). Kept: the breakers that guard calls — `withCircuitBreaker(config)` wraps the main LLM; the server's embedder breaker wraps the retrieval embedder and is listed in `/health`; with it open, a store's query fails fast with `CIRCUIT_OPEN`. Kept: `IRagDecorator` and every walk through it (`StrategyRag` and a consumer's own wrapper). A consumer that wants a degraded mode writes its own `IRag` wrapper. **Withdrawn:** D52 (the decorator writer rule — no decorator in this design needs it — and the corpus load's resolved-backend check: the load checks the writer of the store it writes), D62, their tests, and the "behind `FallbackRag`" cases of the binding-discovery, F1 and corpus tests (a plain decorator stands in where the walk is tested). Migration lines 5 (`FallbackRag` removed), 71 (`replaceRag`), 72 (`withCircuitBreakers`): **72 lines**. Amends D53, D54, D57 (`FallbackRag` is not moved) | header, amendment (14), TL;DR, §1, §3.8, §3.10, §6.3–§6.5, §10.4, §11, §11.1–§11.3, §13, §14.1, §15 |

### 17.24 Decided by the goal on 2026-10-05 — fail loud (D69–D74); U1–U10 decided by the user on 2026-10-05

From the goal's decisions "No fallbacks anywhere in the pipeline" and "the fail-loud sweep is part
of this PR" (2026-10-05). The inventory was two read-only audits of `main`, re-verified item by item
against `493fcf17`.

| # | Decision | Where |
|---|---|---|
| D69 | **The rule and its carriers.** A component that finds another not working returns an error — never a fake success, an empty result, a skipped part, a stale cache or a substitute. A stage's `OrchestratorError` carries the failing component's code unchanged; existing codes are reused; no shared code set is widened; the three codes no component has (`RAG_STORE_MISSING`, `STATE_CORRUPT`, `TOOL_ARGUMENTS_JSON_PARSE_FAILED`) form one new set of their own, `PIPELINE_FAILURE_CODES`. Kept: absent-by-design capabilities, honest empty answers, best-effort cleanup, diagnostics-only catches, the consumer's chosen modes (U1–U10, as the user decided them — §10.5.12) | §10.5.1, §3.8 |
| D70 | **Pipeline errors reach the consumer (N1) — a bug fix, first in the plan.** The executor and `DefaultPipeline` set `ctx.error`; `pipelineToStream` yields `result.error` once (not when a handler already yielded its own); the root span is `error` | §10.5.2, §13 B1 |
| D71 | **`onFailure` is removed from `StagedRetrieval`, its YAML and `facetedRerank`; the 30.1.0 rerank strategies, the `rerank` stage and the legacy orchestrator return the `RERANK_ERROR`.** The goal names the spec's own `onFailure: 'stage1'`. With one behaviour, the `ScoreFloorCut` + `stage1` rejection (F5's second half, §4.7), the "two scales in one run" case of D67 and the `rerank_fallback` outcome are gone; D63 is unchanged (it never depended on the fallback: sub-query scores are incomparable either way). **Supersedes S4 for the failure path only** — the goal's decision names the reranker; S4's "no output check on the 30.1.0 strategies" stays | §4.2, §4.6–§4.9, §6.2, §7.4, §9, §10.5.5, §13 B4, §14.1 |
| D72 | **Health: a configured component not working ⇒ `/health` 503.** `degraded` → 503 (the word kept from D41); every RAG store probed; an MCP `value: false` or an unanswered probe is not OK. The chat routes stay gated on `ready` only | §10.5.10, §13 B9 |
| D73 | **`FallbackQueryEmbedding` falls back only for a `TextOnlyEmbedding`** (no pipeline embedder — an absent capability), never on a failure of a real embedder | §10.5.4 R1, §13 B3 |
| D74 | **The sweep** — every item of §10.5.3–§10.5.9 as written there | §10.5, §13 |

**Decided by the user on 2026-10-05 — every recommendation approved as written** (each removes or
changes a mode a consumer can choose; what each decision changes is §10.5.12, the behaviour rows
are §13 B12–B15, the migration lines 73–74, the contract changes §3.8):

| # | Mode | Today | Recommendation | Decision (user, 2026-10-05) |
|---|---|---|---|---|
| U1 | `FallbackLlmCallStrategy` (`agent.llmCallStrategy: fallback`) | opt-in (default `streaming`): a failed stream is retried non-streaming and streaming is disabled for the instance's life, logged | **keep** — an explicitly chosen consumer strategy, which is exactly where the goal puts degraded modes. Add a session step / metric per fallback so it is countable | **decided — keep; count each fallback**: the log event `llm_streaming_fallback` (always, with a running count) and an optional injected `ICounter` (`fallbackCount`, attribute `cause`); no span (§10.5.12) |
| U2 | skill plugin host `strict: false` (carry-forward) | the **default**: a failed source's prior data is carried forward; with this spec the reason is reported (`carried`, S-9) and a failed group build reports `ok: false` (S-8) | **keep `strict: false` as an explicit opt-in, change the default to `strict: true`** (a failed source fails its group) — a default that silently serves old data is the pattern the goal removes | **decided — default `strict: true`**; `strict: false` only when the consumer sets it (libs and the server's `skillPlugins.strict`; B12) |
| U3 | controller `onFinalizeExhausted: 'best-effort'` | opt-in, code only (default `'error'`); the answer is marked `[incomplete: …]` | **keep** — default is the error; the consumer chose it and the answer says it is incomplete | **decided — keep**, unchanged |
| U4 | `AutoActivation` coordinator (`builder.ts` ~668) | opt-in (default `ExplicitActivation`); without sub-agents or a structured skill the pipeline uses tool-loop | **keep** — routing by configuration, not a reaction to a failure | **decided — keep**, unchanged |
| U5 | `HybridDispatch` (`coordinator/dispatch/hybrid.ts`) | a step that names no agent, **or names an agent the registry lacks**, goes to the fallback dispatcher | **keep for a step that names no agent; make a named agent missing from the registry `COORDINATOR_STEP_FAILED`** (that half is a failure, silently routed) | **decided — keep for no agent named; a named agent missing → `COORDINATOR_STEP_FAILED`** (B13) |
| U6 | `lazy(…, { fallback })` (`utils/lazy.ts`, public, unused in the repo) | an init failure answers with the given fallback value | **remove** (a major release; unused; a consumer that wants it wraps its own) | **decided — remove** `LazyOptions.fallback` (migration line 73, B14) |
| U7 | `vectorizeMcpTools` batch → per-tool embedding | a failed batch embedding retries tool by tool, noted in the summary line | **keep** — the same data is embedded, the result is complete or reported incomplete; count the batch failure in the summary (`batchFailures`) | **decided — keep; count batch failures** (`batchFailures` on `ToolCatalogStatus` and `IndexReport`) |
| U8 | tool availability blacklist (`tool-loop-core.ts` ~383, `policy/tool-availability-registry.ts`) | on by default, no switch (legacy: TTL only): a tool error whose text matches "not found", "permission", … blocks the tool for 10 min; later calls get "temporarily unavailable" | **make it an injected policy, default none** — the first tool error already reaches the LLM; blocking the tool by a text heuristic silently shrinks the tool set. Until decided: unchanged | **decided — an injected `IToolAvailabilityPolicy`, none by default**; the heuristic ships as `HeuristicToolAvailabilityPolicy({ ttlMs })`; `SmartAgentConfig.toolUnavailableTtlMs` removed (migration line 74, B15) |
| U9 | D68's removal of the builder's never-fed embedder breaker and `withCircuitBreakers` (§10.4) | removed by the previous amendment (Task 0A) | **confirm** — it guarded nothing (the builder wraps no embedder); the server's embedder breaker and the main-LLM breaker stay | **decided — confirmed** (Task 0A, D68) |
| U10 | a worker that declares no clients / tools store uses the parent's (`smart-server.ts` ~2240, ~2259) | by configuration (D38), unlogged | **keep** — not a failure (the worker declared none); a worker that declares its own and fails to build them already fails its construction (§6.3). Log one `worker_uses_shared_clients` debug line | **decided — keep; log one `worker_uses_shared_clients` debug line** per wire |

Also noted, out of scope (not a fallback, found while verifying): `smart-server.ts`'s `closeFns`
loop (~1943) stops at the first throwing closer, so later closers never run — a cleanup bug
tracked in its own issue, fr0ster/llm-agent#330 (§15).

**Decided by the user on 2026-10-05 — the four choices made while writing U5–U8 in.** Writing the
decisions into §10.5.12 took four choices the U-table did not spell out; the user confirmed each
as written there:

| # | Choice | Where |
|---|---|---|
| U8 | `SmartAgentConfig.toolUnavailableTtlMs` is **removed** (not kept beside the policy): the TTL is the policy's, fixed at construction. `PUT /v1/config` with the key answers **400** (it leaves the whitelist; it never changed a live agent's registry). The server YAML's `agent.toolUnavailableTtlMs` is the **opt-in** for `HeuristicToolAvailabilityPolicy({ ttlMs })`; unset → no policy — the 600000 default TTL is gone | §10.5.12 U8, §3.8, §13 B15, migration line 74 |
| U7 | `/health`'s `toolCatalog` carries `batchFailures` (`HealthComponentStatus.toolCatalog.batchFailures?`, copied by the health checker as `records` / `profile` are), not only the summary log line | §10.5.12 U7, §3.8 |
| U5 | a named agent missing from the registry is a **failed step**, not a failed request by itself: under `failPolicy: 'abort'` the coordinator handler fails the request with `COORDINATOR_STEP_FAILED`; under `'continue'` the answer reports the failed step (`[Coordinator: n step(s) failed …]`) | §10.5.12 U5, §13 B13 |
| U6 | `lazy`'s init failure rejects the call with `LazyInitError`, whose `cause` is the factory's error (the message names the property and the error) | §10.5.12 U6, §13 B14, migration line 73 |

### 17.25 Review findings on 2026-10-05 — skill writes, bulk writes, reload failures, root span status (D75–D78)

A review of the plan found three later tasks that undid an earlier fail-loud rule, and one
fail-loud fix that could not take effect. Each is decided by the goal's rule (D69: no fallback, no
silent degradation); none changes a consumer-chosen mode.

| # | Decision | Where |
|---|---|---|
| D75 | **A skill that cannot be written into the tools store is an error.** `vectorizeSkills` caught a skill's embedding / write failure, warned and resolved, so `build()` and the server's start succeeded with the skill missing from tool retrieval. Now it rejects at the first failing skill with a `SkillError` naming it (`skill:<name>`), the store's error as `cause`; `build()`, the server's fill paths (incl. `fillToolsBinding`'s `skills`, D66) and `start()` propagate it unchanged. Extends S-5 | §10.5.8 S-5, §13 B8, §14.1 |
| D76 | **A failed bulk write fails its records; no per-record retry.** The record writer answered a failed `upsertManyPrecomputedRaw` by writing the same records one by one — a second write path the store was never asked to accept, hiding the bulk failure. Now every record of the failed batch is failed with the bulk error (`write-failed: bulk write failed: <error>`); the per-record write stays only where no bulk write is available. A failed settle write is reported (`cleanup-failed: …`), not counted indexed. U7's embedding retry is unchanged | §3.3, §14.1 |
| D77 | *The restore is withdrawn by D82 (§17.30): a failed reload keeps what it applied and leaves the server not ready; the rejection, the event boundary and `config_reload_applied` only on success stand.* **A failed reload keeps the previous config — and stays failed.** The plan's reload entry point (D39) caught the drain / invalidation rejection, logged it and resolved, undoing V6. Now `_onReload` restores the pre-reload agent config and the server's mirror, skips the RAG weights, and rejects; the watcher's `reload` listener is the one boundary that handles the rejection (`config_reload_failed`); `config_reload_applied` only on success. D39 stands: the entry point is still awaitable | §10.5.9 V6, §13 B10, §14.1 |
| D78 | **The root span's `error` status is set before the error chunk is yielded.** Set after the stream ended, it never ran: `process()` returns on the first `ok: false` chunk, which closes `streamProcess`'s generator at that `yield`. The span is still ended in `finally` | §10.5.2, §13 B1, §14.1 |

### 17.26 Decided by the user on 2026-10-06 — the 30.1.0 tool write path (D79)

The plan's scan for D76's class (§17.25) found the same substitution on the 30.1.0 tools path,
outside §10.5's inventory, and left it to the user. The user's rule: no fallback anywhere, all in
this PR.

| # | Decision | Where |
|---|---|---|
| D79 | **The 30.1.0 tools path does not retry a failed bulk write tool by tool.** `vectorizeMcpTools` on an unbound store answered a failed `upsertManyPrecomputedRaw` (`ok: false` or a throw) by writing the same tools one by one — D76's substitution, on the path D76 did not cover. Now the batch fails: no per-tool write, every tool of it in `failed`, `complete: false` with the reason in the new optional `ToolCatalogStatus.writeFailure` (`bulk write failed: <error>`) and in the summary log line; `/health` answers 503 (D72). The per-tool write stays only where no bulk write is made. U7's batch → per-tool embedding retry is unchanged (counted). Extends D76 | §3.3, §3.8, §10.5.4 R14, §13 B16, §14.1 |

### 17.27 Review finding on 2026-10-06 — reload transactions serialized (D80)

D77 made a reload a transaction (snapshot → apply → drain + invalidation → weights or restore), but
nothing ordered two of them: `ConfigWatcher` debounces file events, yet emits `reload` without
awaiting the listener, and the listener started each `_onReload` at once. Reload A waiting on a slow
drain, reload B snapshotted A's provisional config, applied B, succeeded and set B's RAG weights;
A then failed and its restore wrote A's pre-reload config over B's while B's weights stayed — a
config that no file ever held.

| # | Decision | Where |
|---|---|---|
| D80 | *Extended by the user's decision of 2026-10-06 (§17.28): the queue is the server's and `PUT /v1/config` joins it (V10). The snapshot and the restore are withdrawn by D82 (§17.30); the ordering stands, and the queue holds the not-ready state.* **Config reloads run one at a time.** The watcher keeps one queue (a promise chain) of complete reload transactions; the entry point (`_onReload`, D39) appends the transaction and returns its own promise. A transaction takes its snapshot only after the previous one settled, so every restore returns to the config the previous transaction left. A failed transaction rejects its own promise and is reported on its own (`config_reload_failed`); the queue continues past it — a failure never blocks later reloads. `PUT /v1/config` is a separate path (`handleConfigUpdate`) and does not join this queue. Extends D77 | §10.5.9 V6, §14.1 |

### 17.28 Decided by the user on 2026-10-06 — one queue for every config change (D80 extended); `writeFailure` approved

D80 ordered file reloads in the watcher and left `PUT /v1/config` outside: a `PUT` could snapshot a
reload's provisional config, and a failed reload's restore could overwrite a `PUT` applied in
between (or the reverse). The `PUT` itself swallowed a failed invalidation (200) and, on a failed
drain, left the update applied behind the catch-all's 500.

| # | Decision | Where |
|---|---|---|
| D80 (extended) | *The snapshot → restore of a failed transaction is replaced by D82 (§17.30): a failed `PUT` answers 500, keeps what it applied and leaves the server not ready; the one queue stands.* **One queue for every config change.** The server owns one `ConfigTransactionQueue` (server-libs `smart-agent/config-transaction-queue.ts`, internal, not exported) and injects the same instance into the reload watcher (`ConfigReloadDeps.transactions`) and the `PUT` route (`IConfigUpdateTarget.transactions`). It lives in the server because the server is the one object both reach and the owner of every piece of state a transaction changes (the held LLMs, `cfg.agent` / `cfg.prompts`, the worker cache, the sessions): the watcher exists only with a `configFile` and is built inside `start()`; the route handler is a stateless function handed `IConfigUpdateTarget` per request; a module-level queue would be shared by every `SmartServer` in a process. `PUT /v1/config` validates outside the queue, then runs one transaction: snapshot → the server's state applied → drain + invalidation → on success the startup agent and 200; on a failure the snapshot restored and **500** `server_error` naming it. A failed transaction (a reload or a `PUT`) rejects or answers only its own caller and never blocks the next one | §10.5.1, §10.5.9 V6, V10, §11.1, §13 B17, §14.1 |
| D79 (confirmed) | `ToolCatalogStatus.writeFailure?: string` — the framework contract in `@mcp-abap-adt/llm-agent`, set by libs' `vectorizeMcpTools` — **approved by the user** | §3.8, §10.5.4 R14 |

### 17.29 Review finding on 2026-10-06 — the startup agent's update inside the rollback (D81) — *withdrawn by D82 (§17.30)*

V10 applied the update to the startup agent after the drain and the invalidation succeeded, but
outside the transaction's failure handling. `SmartAgent.reconfigure` assigns its LLM fields (and
rebuilds the classifier) **before** it calls the pipeline's optional `reconfigure` hook; a hook
that throws left the agent half-updated (its fields swapped, its pipeline not), the error escaped
to the server's catch-all 500 while the server kept the new held models, breakers and `cfg.agent`,
and the next transaction snapshotted that state as "the previous config".

| # | Decision | Where |
|---|---|---|
| D81 | *Withdrawn by D82 (§17.30): with no rollback there is nothing for an atomic `reconfigure` to protect. `SmartAgent.reconfigure` stays as in 30.1.0 (B18 withdrawn); a throw in the `PUT` transaction is a failed `PUT` — 500, not ready.* **The startup agent's update is part of the `PUT` transaction.** (1) `SmartAgent.reconfigure` is atomic, signature unchanged: it captures its previous LLM fields and classifier, builds the new classifier before assigning anything, applies, calls the pipeline hook, and when the hook throws restores exactly the captured fields, calls nothing else and rethrows (B18). (2) In `PUT /v1/config`'s transaction the startup-agent update (`reconfigure`, then `applyConfigUpdate`) runs inside the failure handling: when it throws, the server's snapshot is restored (the held LLMs, their breakers, `cfg.agent`) and the route answers **500** `server_error` (`… — startup agent: <error>`), as for a failed drain. The file reload never calls `reconfigure`, so V6 is unchanged | §10.5.9 V10, §13 B17, B18, §14.1 |

### 17.30 Decided by the user on 2026-10-06 — a failed config change is an error and leaves the server not ready; no rollback (D82)

The goal's row of 2026-10-06: a config change that fails to apply (file reload or
`PUT /v1/config`) is an error and leaves the server not ready; there is no rollback. The consumer
sends another config, and the next config change that applies makes the server ready again.
Config changes still run one at a time; hot reload stays in the default server.

*Amended by the user on 2026-10-06 (amendment 23, D82 (8)):* the change that makes the server
ready again must be a whole config — a file reload, or a `PUT /v1/config` carrying every section
the route can change; a partial `PUT` is refused (409) while the server is not ready.

| # | Decision | Where |
|---|---|---|
| D82 | **A failed config transaction is an error and leaves the server not ready; nothing is rolled back.** (1) **The error.** A reload rejects (`config_reload_failed` at the watcher's event boundary, D77's boundary kept); a `PUT` answers **500** `server_error`. Each names every failed step: the apply (`apply: …`, `PUT` only — the setters, `reconfigure`, `applyConfigUpdate`, the mirror), `worker drain: …`, `session invalidation: …`; any other throw in a transaction fails it the same way. (2) **No rollback.** What the transaction applied stays applied; a reload's RAG weights are applied only on success. (3) **Not ready.** The server's `ConfigTransactionQueue` — every config change settles there (D80) — holds the *config not applied* state `{ reason, source: 'reload' \| 'put', at }`: set when a transaction rejects, cleared when a later whole one resolves (see (8)), in queue order; a transaction in flight changes nothing until it settles; validation failures (400), a refused partial `PUT` (409, (8)) and, on a ready server, a `PUT` naming neither `models` nor `agent` never run a transaction and leave it as it is. (4) **Gating.** The server's `ready` = the agent's MCP readiness **and** no *config not applied*; computed once per request (as today) and used by `/health` (503, the body's `configNotApplied`) and the pre-dispatch gate of both chat routes (503 `service_unavailable`, `config not applied — <reason>`) — the gate MCP readiness already uses (`writeNotReady`, now with an optional message). The config routes, `/health`, the model and usage routes and the session routes are not gated, so the consumer can always see and send a config. (5) **Start.** The state is empty at start: the server starts ready from its config, because a start config that cannot be applied fails the start (exit 1) — there is no "running with an unapplied start config". (6) **Session and worker caches — the provisional-session finding (review 24) is resolved without a barrier.** A session or worker built while a transaction is in flight may capture its provisional config. Under a rollback that capture could outlive the restore, and only a barrier around the transaction would have stopped it. Now: when the transaction applies, its config is the applied one and the capture is current; when it fails, the server is not ready and no chat request reaches a session or a worker; the next transaction that applies drains the workers and invalidates the sessions again before it clears the state, so nothing built on a failed config ever serves. A worker construction that started before a drain and publishes after it is the pre-existing 30.1.0 race of #331 (§15), unchanged by this decision. (7) **Withdrawn**: D77's restore; V6's and V10's snapshot and restore (`snapshotConfig` on `ConfigReloadDeps` and `IConfigUpdateTarget`); `LlmCircuitBreakers.snapshot()` (it existed only for the restore); D81 — `SmartAgent.reconfigure` stays as in 30.1.0 (a throwing pipeline hook leaves the agent half-updated, as before: a failed `PUT`, after which the server is not ready; the next `PUT` that names those roles sets them again). None of the withdrawn names exists in the code or is used by another part of this spec. (8) **Only a whole config clears it — a rule, decided by the user on 2026-10-06 (amendment 23).** A failed `PUT` may have applied part of itself (e.g. the held models, not the agent fields), so a partial change cannot vouch for the server's config. While the state is set, only a whole config clears it: a file reload (it re-reads the whole file) or a `PUT` carrying every top-level section the route can change on this server — `agent`, and `models` when the server has a model resolver (the route's whitelist has no other section) — each a non-empty object. Any other `PUT` is refused with **409** `invalid_request_error`, code `config_not_applied`, `server not ready — send the whole config: <missing sections>`, and changes nothing: refused before the queue (nothing resolved or probed), and refused again by the queue when its transaction starts (`ConfigTransactionQueue.run`'s scope `'partial'`; the reload's is `'full'`), because a transaction ahead of it can set the state while it waits — the refusal neither runs the transaction nor touches the state. A section is whole at the top level: the fields inside it are what the consumer wants (a field it leaves out keeps its live value). While the server is ready, a partial `PUT` works as before (9) **A file the watcher cannot read, parse or resolve is a failed reload** (review finding of 2026-10-06, §17.35, amendment 28). `ConfigWatcher`'s `error` (the file missing or unreadable, not valid YAML, `resolveDocument` throwing) is queued by the server's watcher in the config queue as a reload transaction (scope `'full'`) that rejects with `config reload failed, the server is not ready until a whole config applies — cannot read the config file: <the error>`: it applies nothing, sets the state in queue order with the `PUT`s and reloads around it, and is logged `config_reload_failed` at the same boundary as (1). A ready server never keeps serving a config whose file it could not read | §3.8, §10.5.1, §10.5.9 V6, V10, §10.5.10, §11.1, §13 B10, B17, B18, §14.1 |

### 17.31 Review finding on 2026-10-06 — reloaded and updated config fields are validated before they apply (D83)

A file reload is always a whole config, so a reload that applies clears the *config not applied*
state (D82 (8)). `ConfigWatcher._extractReloadable` coerced every numeric field with `Number()`
and every flag with `Boolean()`, without a check, and `SmartAgent.applyConfigUpdate` merges what
it gets: `agent.maxIterations: oops` became `NaN`, the reload applied, the server became ready —
and the loop's `iteration >= NaN` never fires, so the iteration limit was silently gone.
`PUT /v1/config` checked only the field names, so `"maxIterations": "oops"` applied the same way.

| # | Decision | Where |
|---|---|---|
| D83 | **Every config field a running server changes is validated before it applies — one validator, both inputs, no coercion.** (1) One semantic validator, server-libs `smart-agent/config-fields.ts` (internal), holds the rule of every field the file reload reads and every field `PUT /v1/config` accepts (§10.5.9 *Config field rules*): numbers finite and in the range the reading code can work with, flags booleans, prompts, the log directory and model names non-empty strings. Nothing is coerced; every invalid field is named in one error. (2) **Reload:** `ConfigWatcher` passes the file's values as read (`HotReloadableInput`, §3.8); the validator is the first step of the reload transaction, so an invalid file is a failed transaction that applied nothing — it rejects naming the fields, the queue sets (or keeps) the *config not applied* state with that reason, `config_reload_failed` is logged; a valid one applies the validated values; a file that cannot be read or parsed has no values to validate and is a failed reload too (D82 (9)). (3) **`PUT`:** the same validator after the whitelist and before any model is resolved; an invalid value → 400 `invalid_request_error` naming the field, before the queue — nothing resolved, applied or queued, the state unchanged (D82 (3)); the transaction applies the validated values. (4) **Layer: server.** Both inputs are the server's and only the server composes these fields (the agent's loop, the in-memory store's weights, its prompts, breaker, log directory, model resolver); `SmartAgent` gets typed values from its composition root and parses no config. Both callers live in server-libs and the validator imports only libs' types — no cycle. (5) **The start config — the same validator** (amended by the user's rule of 2026-10-06, §17.32; it replaced "not part of this finding"). `resolveSmartServerConfig` validates the YAML it starts from — at the reload's paths — and the `ResolveConfigArgs` overrides `agent-show-reasoning` / `log-dir` with the same rules before any section is read; `resolveAgentSection`, `resolveRagSection` (the in-memory weights), `resolvePromptsSection` and `logDir` take the validated values and coerce nothing (an absent field keeps its 30.1.0 default). An invalid value fails the start: the same `ConfigFieldError` (`invalid config — <field> <rule>, got <value>`, a worker file's prefixed with the worker and its path), which the CLI writes to stderr and exits 1 with, as for any unusable start config (a programmatic caller gets it thrown). After U8 `agent.toolUnavailableTtlMs` keeps its rule as a start-only field. (6) **Number literal strings and string flags** (decided by the user on 2026-10-06, §17.33): one grammar for the start, the reload and `PUT` — a numeric field takes a number or a string that is exactly a `NUMBER_LITERAL` (JSON's number grammar, the whole string), parsed and then checked by the field's rule (finite, integer, range); a flag takes `true` / `false` or exactly `"true"` / `"false"`; anything else is the same `ConfigFieldError`. (7) **Every coerced field** (decided by the user on 2026-10-06, §17.33): every config field the start read with `Number()` / `Boolean()` / `String()` has a rule in `config-fields.ts` (*Start-only fields*) and is checked by the start's `FieldCheck` where its section is read (`skillPlugins` and the stepper's section by their own parsers with the same check); `parseIntegerField` takes the same grammar; `optionalNumber` is removed (migration line 75) — the server and the shipped composition root read the validated temperatures. (8) **The reload substitutes `${VAR}` as the start does** (decided by the user on 2026-10-06, §17.34): `ConfigWatcher` takes an injected `resolveDocument` (§3.8) applied to the whole parsed file before a field is read; the server passes the start's `resolveEnvVars` (server-libs `yaml-loader.ts`, one implementation) with the process environment — the same syntax, the same values, the same field selection (`rag.store.type: ${…}`); an unset variable with no default is `""` and fails its field on a reload as at start. (9) **Every cast-read field is validated** (decided by the user on 2026-10-06, §17.34): every config field the resolvers read by an `as` cast with no check has a rule in `config-fields.ts` (*Cast-read fields*), applied by the start's `FieldCheck` or the section's own parser; shapes are checked (mappings, lists, maps, closed mappings refuse unknown keys) and the validated values are what the consumers get | §3.8, §10.5.9 V6, V10, *Config field rules*, *Start-only fields*, *Cast-read fields*, *The start config*, §13 B19, B20, B21, B22, §14.1, §17.32, §17.33, §17.34 |

### 17.32 Decided by the user on 2026-10-06 — the start config uses the same field validator (D83 (5) amended)

D83 left the start out: `resolveAgentSection` still read `agent.maxIterations: oops` as `NaN`,
`resolveRagStore` the weights with `Number()`, `resolvePromptsSection` an empty prompt as absent.
A server could start from a value that every later reload of the same file refuses, and run with
no iteration limit. Under the user's rule — no silent degradation, and everything in this change —
the start config is checked by the same validator, with the same rules and the same error; an
invalid value fails the start (exit code 1), as an unusable start config already does. D83 (5) is
rewritten accordingly (§10.5.9 *Config field rules*, *The start config*; §13 B20; §14.1). No new
public name: `config-fields.ts` stays internal; `resolveAgentSection`, `resolveRagSection` and
`resolvePromptsSection` are internal to server-libs (not exported from the package), so their
new parameter changes no contract.

### 17.33 Decided by the user on 2026-10-06 — number literal strings, string flags, every coerced field validated (D83 (6), (7))

D83 required a JSON / YAML number for every numeric field and a boolean for every flag. A
`${VAR}` substituted at start is a string, so `maxIterations: ${MAX_ITERATIONS}` in a docker
compose deployment would have failed the start. And D83 (5) left every field outside the reload
table to its 30.1.0 coercion (`historyRecencyWindow: oops` → `NaN`, `skillPlugins.strict:
"false"` → `true`, `mcp.args` as a YAML list → `"a,b"`). The user decided:

1. **Strict string parsing for numbers and flags** — the start, the reload and `PUT` alike, one
   validator: a numeric field accepts a number, or a string that is exactly a number literal
   (`NUMBER_LITERAL`, §10.5.9 — JSON's grammar: optional `-`, no leading zeros, optional fraction
   and exponent; no spaces, `+`, hex, `NaN`, `Infinity`); the parsed value then goes through the
   field's rule. A flag accepts `true` / `false` or exactly `"true"` / `"false"`. Anything else
   is the same `ConfigFieldError`. D83 (6).
2. **Every config field coerced with `Number()` / `Boolean()` / `String()` goes through the
   validator** — the *Start-only fields* table of §10.5.9 replaces the "not covered" list; each
   rule is what the code that reads the field can work with. D83 (7).

Consequences: `ConfigFieldError` now also comes from `parseSkillPluginsConfig` and the public
`parseStepperCoordinatorConfig` (same signatures; a value they turned into `NaN` or a wrong flag
now throws); `parseIntegerField` (internal) refuses surrounding spaces; the server-libs export
`optionalNumber` is removed (migration line 75, §13); `agent.heartbeatIntervalMs` keeps 0 as the
documented "disable" and refuses anything else outside its range (the console warning goes). A
`${VAR}` in a field of the reload table passes at start and fails every reload, because the
reload does not substitute (§10.5.9 *The start config*) — unchanged by this decision, now stated.
*Superseded by D83 (8) (§17.34): the reload substitutes `${VAR}` as the start does.*

### 17.34 Decided by the user on 2026-10-06 — the reload substitutes variables; cast-read fields validated (D83 (8), (9))

D83 (6) let a `${VAR}` holding a number literal or `true` / `false` pass at start, but the reload
read the file as written, so the same field passed at start and failed every reload. And D83 (7)
covered only the fields the start coerced: the fields read by an `as` cast (`agent.retry`,
`agent.toolSelection`, `mcp.toolTimeouts`, `mcp.headers`, the `mcp[]` entries, `llm.url`, …) still
reached their consumers unchecked. The user decided:

1. **The file reload substitutes `${VAR}` exactly as the start does** — the same function, the
   same syntax (`${VAR:-default}` included), no second implementation. Where it runs: inside
   `ConfigWatcher`, injected (`ConfigWatcherOptions.resolveDocument`, §3.8), over the whole
   parsed file before a field is read — not in the server's `_applyReload` over the event's
   values, which was considered: the watcher already decided which fields exist on the
   unsubstituted file (`rag.store.type: ${STORE}` is not `in-memory`, so the weights would be
   left out), and the start substitutes the whole document before it reads a field. The watcher
   stays free of any `${VAR}` policy (the option is the consumer's; absent, the values are as
   written); the server passes server-libs' `resolveEnvVars`, which stays in `yaml-loader.ts` —
   libs never imports server-libs, and `yaml-loader.ts` imports nothing of the server, so no
   cycle. An unset variable with no default is `""` on both paths and fails its field (the start
   exits 1; a reload fails, the server not ready); `${VAR:-}` is `""` and fails every
   non-empty-string field. D83 (8).
2. **Fields read by a type cast without validation are validated too** — `agent.retry`,
   `agent.toolSelection`, `mcp.toolTimeouts`, `mcp.headers`, the other `mcp[]` entry fields,
   `llm.url`, and every other cast-read config field found in the resolvers (§10.5.9
   *Cast-read fields*, each rule from its consumer), with the same `ConfigFieldError` naming the
   field path. The "not part of this decision" sentence of §10.5.9 is removed. D83 (9).

Consequences: `ConfigWatcherOptions` gains one optional member (additive, §13); a reload of a
file with `${VAR}` fields now applies them (B21); a start with an invalid cast-read value fails
(B22) — including the exported `parseLinearSettings`, `parseDagSettings`,
`parseControllerSettings` and the public `parseStepperCoordinatorConfig` (same signatures); the
`url: ${LLM_URL:-}` lines of the five stepper examples resolve to `""` when unset and are removed
(as `${EMBEDDER_URL:-}` by D83 (7)).

### 17.35 Review finding on 2026-10-06 — a config file the watcher cannot read or parse is a failed reload (D82 (9))

D82 made a failed config change an error that leaves the server not ready, and D83 (2) made an
invalid value a failed reload transaction. But a file the watcher cannot turn into values at all
never reached the queue: `ConfigWatcher` emits `error` (not `reload`) when `readFileSync` throws
(the file deleted, its permissions changed), when the YAML does not parse, or when the injected
`resolveDocument` throws (D83 (8)), and `ConfigReloadWatcher`'s `error` listener only logged
`config_reload_error`. A ready server kept serving the previous config while its file was
broken — the silent degradation D82 removed for every other failure, and a worse one than an
invalid value, since nothing of the file is known.

| # | Decision | Where |
|---|---|---|
| D82 (9) | **A file the watcher cannot read, parse or resolve is a failed reload.** The server's watcher queues `ConfigWatcher`'s `error` in the server's config queue as a reload transaction — `run('reload', 'full', …)`, the scope of every reload (the file is the whole config) — whose body rejects with `config reload failed, the server is not ready until a whole config applies — cannot read the config file: <the error's message>`. (1) **Nothing applied**: no agent update, mirror, drain, invalidation or weights. (2) **Queue order**: it starts after the changes queued before it and settles before those queued after it, so it sets (or replaces) the *config not applied* state in that order — a partial `PUT` queued behind it is refused at its start (409, D82 (8)); a whole config queued behind it applies and clears the state. (3) **One boundary, one event**: the `error` listener is the watcher's event boundary, as the `reload` listener is (D77): it logs `config_reload_failed` with the rejection; `config_reload_error` is removed. (4) **Recovery** is D82's: the repaired file saved (a reload re-reads all of it) or a whole `PUT`; a file deleted and then recreated is not watched again (the watcher watches the file it started on, unchanged from 30.1.0), so a whole `PUT` or a restart recovers it. (5) No contract changes: `ConfigWatcher` (libs) is unchanged — it already emits `error`; the change is the server's listener (server-libs, internal) | §10.5.9 V6, §10.5.10, §13 B17, §14.1, §17.30 |
