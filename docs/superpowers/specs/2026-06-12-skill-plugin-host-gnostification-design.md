# Skill Plugin-Host & Runtime Gnostification — Design

**Status:** draft (brainstormed 2026-06-12)
**Branch:** `feat/skill-plugin-host` (off `design/controller-execution-result-control` / PR #183).
**Relation to PR #183:** PR #183 (merged) delivered the controller but explicitly
DEFERRED any skills channel. This is a SEPARATE, cross-cutting feature whose primary
integration is the **base SmartAgent multi-source RAG retrieval (the context-assembler)**
— gnostifying assembler-based pipelines seamlessly, with the controller gnostified via
its own planner recall hook (it bypasses the assembler). Built on a branch off main.

## Goal

Let a deployment **gnostify** the agnostic engine by feeding it consumer-supplied
**domain skills** (procedural "how-to" knowledge) **through RAG**, keeping the engine
code domain-agnostic. This is the same posture as Claude Code's plugin system: a
non-GPL host that loads user-enabled (possibly GPL) skills and runs them without
becoming GPL.

**The system has TWO independent parts, agnostic to each other:**

1. **The plugin skill-host (acquire → materialise), driven by INJECTED strategies.** It
   knows nothing about any pipeline AND nothing about the semantics of any particular
   plugin source. Acquisition, parsing, AND **collection placement** (which skill lands
   in which collection/group) are decided by the **injected acquisition/materialisation
   strategy** for that source — NOT by universal host logic. The host cannot know whether
   two arbitrary external plugins are compatible or should share a collection, so it does
   NOT compute groups; it orchestrates GENERIC mechanics (per-collection generations,
   fenced activation, retention) over whatever collections the strategy produced, and
   exposes them as `groups()`/`rag(group)`. Where records are put is mostly RAG (other
   sinks — e.g. a Claude-Code-style FS folder — are hypothetical for now). The pipeline
   never sees the source, the plugin format, or the backend.

2. **Consumption (how a pipeline uses the skills).** The pipeline knows nothing about
   plugins — it just reads skills from RAG like ANY other context. There are TWO modes:
   - **Implicit recall (default, in scope).** Attach the enabled group collections to
     **whatever RAG path that pipeline already consumes** — with a fixed/configured group
     and NO planner involvement. The PLUMBING differs by pipeline family (that is the
     only per-family work), but the concept is uniform: skills are just another RAG
     source on the path the pipeline already reads:
     - **Assembler-based pipelines** (flat/default, linear) read an `IRag` multi-source
       **context-assembler** → attach via a small `IRag` adapter; skills share the
       assembler's uniform formatting + budget, **zero consumer code**.
     - **Pipelines that build their own context** (controller; and dag/stepper, which
       like the controller read the raw `ctx.inputText`, not assembled messages) have
       NO shared assembler to hook → implicit recall is wired into THAT pipeline's own
       context assembly (e.g. the controller planner recalls a configured group and
       injects a bounded block). Same concept, pipeline-specific plumbing.
   - **Explicit group selection (deferred, separate spec).** The planner, per step,
     CHOOSES which group among several to pull via `host.groups()` →
     `host.rag(selectedGroup)`. This is the ONLY mode that needs a genuine
     planner-driven hook and that exploits multiple potentially-**conflicting** groups at
     once; a larger integration, not built here.

   **Reality check (do not over-claim):** implicit recall is "free" only where a pipeline
   already has a RAG path to attach to. Assembler pipelines (flat/default, linear) get
   the adapter with no per-pipeline code. The controller, dag, and stepper build context
   themselves (raw `ctx.inputText`), so each needs its implicit recall plumbed into its
   own context assembly — this phase wires the **controller** (the measurement target);
   dag/stepper use the same pattern, wired as needed. A pipeline with no wiring is simply
   not gnostified yet.

**Why grouping is mandatory, not cosmetic — and who decides it.** Real skill sets carry
mutually-conflicting procedural guidance, so you **cannot** dump everything into one
context. Skills are therefore ALWAYS stored grouped (a group = a collection in the
skills-RAG). **The grouping is decided by the injected strategy, not the host** — the
strategy that fetches/parses a given source assigns each record a collection (it is the
only thing that understands that source's semantics). The host just sees the resulting
collections. **Implicit recall** avoids conflict by reading only the configured
collections, and **explicit selection** by the planner choosing one collection per step.
No "one plugin = one group" rule and no host-side bundling is baked into the contracts —
a strategy MAY map 1:1, MAY bundle, MAY split; that is its decision.

## Terminology (canonical — reused verbatim in user docs)

These are the words this spec, the code, and the public documentation MUST use
consistently. Where a term mirrors Anthropic's plugin model, that is called out.

| Term | Definition |
|---|---|
| **Marketplace / registry** | A source that LISTS available plugins (a set of repos/folders offering skills). Anthropic: the marketplace you browse. In config it is a fetched `source` (`registry: <url>`). It is NOT a single skill — it is the catalogue. |
| **Plugin** | The unit you ENABLE: one folder of skills (e.g. `sap-abap`, `sap-btp-best-practices`). Anthropic: a plugin you install from a marketplace. The `enabled` list names **plugins**. |
| **Skill** | One `SKILL.md` (frontmatter + body) inside a plugin — a single procedural "how-to". A plugin contains one or more skills. |
| **Chunk** | A retrieval-sized slice of a skill (split by H2 / size). The unit actually embedded and injected — a hit is ONE chunk, not a whole skill. |
| **Group** | The **conflict-isolation unit = one collection** in the skills-RAG. The mapping of skills→group is decided ENTIRELY by the injected strategy (it may map 1:1 to a plugin, bundle, or split — the host imposes no rule). Recall via `host.rag(group)` only ever sees that group's records. |
| **Collection** | The physical namespace in the skills-RAG that backs one group. Group ↔ collection is 1:1. The strategy stamps each record's collection. |
| **Collection placement** | The strategy's decision of which collection a fetched skill record belongs to. A strategy output, NOT host config. |
| **Catalog** | The authoritative set of collections + their descriptions. The strategy emits the DESIRED catalog (`SkillIngestResult.collections`); the store persists the ACTIVE catalog (`readCatalog()`). `load()` reconciles store→desired (dropping collections no longer desired); recall-only reads it for `groups()`. |
| **Source / strategy** | A pluggable acquisition+materialisation strategy feeding the host — it fetches, parses, AND assigns collection placement: a **fetched** source (marketplace/registry/git/FS dir — needs `enabled`) or a **`records`** source (programmatic, in-memory, pre-placed). Identified by a stable `sourceId`. |
| **Skills-RAG** | The dedicated RAG holding skill chunks, separate from the controller's run-scoped results-RAG. Organised into collections the strategy produced. |
| **Skill plugin-host** (`ISkillPluginHost`) | The GENERIC component that runs the strategy's `load()` (acquire→parse→place→materialise) and exposes recall (`groups()`, `rag(group)`) over the resulting collections. Holds no source/grouping semantics. The "part 1" of the system. |
| **Ingest** | Building/refreshing collections: the strategy acquires+parses+places records; the host chunks/embeds/writes each collection's new generation INACTIVE, then makes them serve with ONE fenced **catalog commit** (`publishCatalog`). Startup (self-ingest) or out-of-band. |
| **Generation** | An immutable SNAPSHOT of a collection's full record set under a generation namespace. Built inactive; it serves only once the **catalog** names it. |
| **Catalog commit** (`publishCatalog`) | The SINGLE fenced operation that makes generations serve: it atomically swaps every collection's serving generation pointer and bumps the catalog revision (CAS). There is no per-collection activate. |
| **Catalog revision** | The catalog's own fence token. `publishCatalog` is a compare-and-set on it; recall pins one collection-generation per query, resolved from the committed catalog. |
| **Manifest** (`SkillsManifest`) | The embedding-compat descriptor of a generation `{ embeddingSpaceId, dimension, retrievalSchemaVersion }`, carried in the collection's catalog entry (published atomically with the commit). |
| **Serving descriptor** (`SkillsEmbeddingDescriptor`) | The same shape, derived by the serving side; recall compares it to the active manifest and refuses on mismatch. |
| **embeddingSpaceId** | A STABLE id of the actual vector space (deployment/adapter-supplied; mandatory for any persistent store). Never alias-derived — a provider can re-train under the same `provider:model` alias. |
| **retrievalText** | The text actually EMBEDDED for a chunk (`description + heading + content`) — distinct per chunk so sections are individually selectable. NOT the injected text. |
| **content** | The chunk body injected verbatim into the LLM context on a hit. |
| **Recall-only host** | A serving instance with NO source/write store: it only reads (`host.rag(group)`) collections an out-of-band ingest wrote. Least privilege. |
| **Implicit recall** | Default consumption: attach enabled group collections to whatever RAG path a pipeline already reads, with a fixed/configured group and NO planner choice. Plumbing varies by pipeline family (assembler adapter vs self-assembling planner-context recall); the concept is uniform. In scope. |
| **Implicit — assembler pipelines** | flat/default + linear read an `IRag` context-assembler → the adapter registers each group's `host.rag(group)` as a source; uniform formatting + shared budget; zero per-pipeline code. |
| **Implicit — self-assembling pipelines** | controller (in scope), dag, stepper read raw `ctx.inputText` and build context themselves → implicit recall is plumbed into that pipeline's own context assembly (controller injects a bounded block of a configured group). |
| **Explicit mode** | Planner picks a group per step (`host.groups()` → `host.rag(group)`) — the only mode needing a genuine planner hook. Deferred, separate spec. |
| **Skills adapter** | `skillsRagSource(host.rag(group)) : IRag` — bridges the text-taking `ISkillsRagHandle` to the embedding-taking `IRag` the assembler expects, mapping `SkillHit → RagResult`. Re-embeds `IQueryEmbedding.text` in the skills' own space. |
| **Gnostify / gnostic / agnostic** | To "gnostify" = to give the agnostic (domain-blind) engine domain knowledge via skills. "Gnostic" skills/knowledge = domain-specific (the consumer's); "agnostic" = the engine + our shipped code, which carry no domain. |

## Core principles (locked)

1. **Agnostic engine + MIT.** No domain names, no bundled domain skills, in
   code/repo/published packages. The engine ships only the generic mechanism.
2. **Gnostic skills are the consumer's**, enabled explicitly (YAML or code). The
   reference set `secondsky/sap-skills` (GPL-3.0) is **never** vendored/copied/
   redistributed by us. Runtime load of consumer-enabled data ≠ relicensing — the
   Claude Code precedent (it hosts user-installed GPL plugins and stays non-GPL).
3. **NO filesystem assumption — anywhere.** Not at serving time, not even at ingest.
   The product contract is FS-free; an FS path is only an optional convenience.
4. **Strategy, not a hardcoded format.** The skill SOURCE is a pluggable strategy;
   "Anthropic/Claude-plugin marketplace" is ONE implementation.
5. **Implicit recall attaches to each pipeline's existing RAG path; explicit selection
   is deferred.** Implicit recall (fixed/configured group, no planner choice) is wired
   onto whatever RAG path a pipeline already reads: an `IRag` adapter into the
   context-assembler for assembler pipelines (flat/default, linear — zero per-pipeline
   code); per-pipeline plumbing for self-assembling pipelines (controller, dag, stepper
   — which read raw `ctx.inputText`). This phase wires the controller (measurement
   target). The **explicit** planner-driven per-step group selection is the only mode
   needing a genuine hook, and is deferred. Do NOT equate implicit with the assembler —
   it is "skills on the path the pipeline already reads", whatever that path is.
8. **Skills are stored GROUPED (group = collection) — grouping owned by the STRATEGY.**
   Never one undifferentiated pile: conflicting guidance must be selectable/excludable.
   But WHICH collection a record lands in is the injected strategy's decision (it alone
   understands the source's semantics); the host imposes NO rule (no "one plugin = one
   group", no host-side bundling). The host materialises whatever collections the
   strategy emits and scopes recall per collection via `host.rag(group)`.
6. **Opt-in, explicit.** Only what the consumer lists is pulled. For a **fetched
   source** (marketplace/registry/git/FS dir — many plugins available), `enabled` is a
   **REQUIRED, non-empty** plugin list; omitting it is a config error, NOT "load all"
   (silently pulling every plugin would violate the security/licensing model) — "load
   all" only via the explicit sentinel `enabled: "*"`. A **`records` source**
   (programmatic, in-memory) is ALREADY the consumer's exact pre-filtered record set,
   so it carries NO `enabled` (and still declares a stable `sourceId`). No `skills`
   block at all → agnostic, unchanged. No auto-discovery.
7. **Graceful degradation.** No skills / none matched / source unreachable → the
   pipeline runs exactly as today.

## Why

The plan-analysis harness (agnostic planner, no skills) showed the controller
planner correctly sequenced a simple dependency chain but left the `requires`
manifest empty, failed a CDS-composition on the incremental planner, and split
compound creates inconsistently. Those are **domain-knowledge gaps** — what
consumer skills are meant to close, without hardcoding any domain. No delivery
channel for skills existed at all (deferred in PR #183); this feature adds it as a
seamless RAG source so the gap is closed for any pipeline, and the controller is
simply the first place we MEASURE the effect.

## Architecture

### Public interface — the central contract

The skills-RAG is its OWN abstraction — NOT the controller's `IKnowledgeRagHandle`
(whose `write()` demands session/run metadata `traceId/turnId/stepperId/task/
artifactType/createdAt`, and whose `query()` returns no similarity score, which the
recall threshold needs). A dedicated read handle returns scored hits:

```ts
interface SkillHit {
  record: SkillRecord;
  score: number; // cosine similarity — recall applies the configured threshold to it
}

/** Embedding compatibility descriptor — the three coordinates that must agree between
 *  the embedder that WROTE a generation and the embedder that QUERIES it, or similarity
 *  scores are dimension-mismatched (hard error) or meaningless (silent garbage). The
 *  ingest stamps it onto the generation (SkillsManifest); the serving host derives its
 *  OWN (SkillsEmbeddingDescriptor) and compares. The three fields come from THREE
 *  different places — none is available from `IEmbedder.embed()` alone:
 *   - embeddingSpaceId: a STABLE identifier of the actual vector space. For a
 *     persistent / out-of-band store this is MANDATORY and supplied by the DEPLOYMENT
 *     or the provider adapter — NOT auto-built from a `provider:model@version` alias,
 *     because a provider can silently re-train a model behind the same alias (same
 *     string, different space → meaningless similarity, no error). The operator/adapter
 *     MUST bump this id whenever the embedding space changes. (`provider:model@version`
 *     is an acceptable AUTO value ONLY for self-ingest in ONE process, where the same
 *     embedder instance writes and reads — there is no cross-process drift to miss.)
 *   - dimension: the vector length — declared in config, OR discovered by ONE probe
 *     embed performed INSIDE `load(options)` (so it is metered/cancellable like any
 *     embed); NEVER an unmetered embed at construction.
 *   - retrievalSchemaVersion: a HOST CODE CONSTANT (the retrievalText composition +
 *     chunking contract version), NOT a property of the embedder. */
interface SkillsEmbeddingDescriptor {
  embeddingSpaceId: string;
  dimension: number;
  retrievalSchemaVersion: number;
}
/** What an active generation carries, published atomically by the catalog commit. Identical
 *  shape to the serving descriptor; compatibility = field-by-field equality. */
type SkillsManifest = SkillsEmbeddingDescriptor;

/** An atomic snapshot of the active pointer: the manifest AND the revision it belongs
 *  to, read in ONE operation so a check + query keyed off it cannot straddle a rotation
 *  (no TOCTOU). */
interface ActiveSnapshot {
  revision: string;
  manifest: SkillsManifest;
}

/** EACH GROUP IS ONE COLLECTION WITH ITS OWN GENERATIONS/REVISIONS. The store/backend
 *  interfaces below are **collection-scoped** — they operate on ONE group's collection,
 *  so no method carries a `group` parameter. A multi-group deployment is handled by a
 *  PROVIDER that vends one handle per group (so different groups' generations never
 *  collide) AND owns the cross-collection CATALOG (which collections exist + their
 *  descriptions), persisted alongside the data so a recall-only host can read it:
 *
 *    interface CatalogEntry {
 *      collection: SkillGroupInfo;        // group id + description + physical collection
 *      sources: readonly string[];        // OWNERSHIP: sourceIds that contribute records here
 *      generation: string;                // THE serving generation pointer for this collection.
 *      manifest: SkillsManifest;          // that generation's embedding-compat descriptor.
 *      tombstone?: boolean;               // published-but-being-reclaimed (not served)
 *    }
 *    interface CatalogSnapshot {
 *      catalogRevision: string;           // the CATALOG's own fence token — the SINGLE fence for
 *                                         //   ALL serving pointers (there is no separate per-
 *                                         //   collection active pointer; the catalog IS it).
 *      entries: readonly CatalogEntry[];  // ACTIVE (non-tombstone) entries are what groups() shows
 *    }
 *    interface ISkillsCatalog {
 *      // Atomic read of the active catalog AND its revision. This is the SOLE source of truth
 *      // for what each collection serves (its `generation` + `manifest`). Recall resolves a
 *      // collection's active generation from HERE, not from a per-collection pointer.
 *      readCatalog(options?: CallOptions): Promise<CatalogSnapshot>;
 *    }
 *    interface ISkillsStoreProvider extends ISkillsCatalog {
 *      forGroup(group: string): ISkillsStore;       // read+write handle for one collection
 *      // THE SINGLE FENCED COMMIT. Builds happen INACTIVE (beginGeneration/upsert never make a
 *      // generation serve); this call atomically flips EVERY collection's serving pointer to the
 *      // `generation` named in `entries` AND bumps catalogRevision — but ONLY if the active
 *      // catalogRevision still == expected. A stale loader overtaken by a newer one is REJECTED,
 *      // so its freshly-built (but unpublished) generations NEVER serve. No partial activation
 *      // can leak: nothing serves a new generation until it is named in a committed catalog.
 *      publishCatalog(expectedCatalogRevision: string,
 *                     entries: readonly CatalogEntry[], options?: CallOptions): Promise<void>;
 *      // Physically reclaim a TOMBSTONED collection's generations — called AFTER a successful
 *      // publishCatalog, under the retention grace. Idempotent + resumable (a crash before it
 *      // finishes leaves a tombstoned-but-not-served collection a later load/GC reclaims).
 *      dropCollection(group: string, options?: CallOptions): Promise<void>;
 *    }
 *    interface ISkillsRagBackendProvider extends ISkillsCatalog {
 *      forGroup(group: string): ISkillsRagBackend;  // read-only handle for one collection
 *    }
 *
 *  `forGroup(g)` always returns a handle over the SAME physical collection for `g`
 *  (idempotent). The ingest-capable host is constructed with an `ISkillsStoreProvider`;
 *  a recall-only host takes an `ISkillsRagBackendProvider`. `host.rag(group)` wraps
 *  `provider.forGroup(group)`; `host.groups()` returns a snapshot of `readCatalog().entries`
 *  FIXED at load() (the serving collection SET is immutable for the agent's lifetime —
 *  readCatalog is async, groups() is sync; generation rotation within a collection is
 *  dynamic, a SET change needs restart).
 *  NOTE: there is NO per-collection `activate` — a generation only ever begins serving by
 *  being named in a committed catalog. `forGroup(g).activeSnapshot()` resolves g's serving
 *  `{ revision: generation, manifest }` FROM `readCatalog()` (single source of truth). */

/** LOW-LEVEL store read API (collection-scoped) — the pinning primitive the compat
 *  wrapper composes over. It does NO compatibility logic and does NOT embed: it exposes
 *  the atomic active pointer and a vector read of a SPECIFIC revision, so a caller can
 *  pin one revision across check+read. (The raw store implements this; the serving
 *  embedder lives in the wrapper above, not here.) */
interface ISkillsRagBackend {
  /** Atomic snapshot of THIS collection's serving pointer (null if not in the catalog) —
   *  its `{ revision: generation, manifest }` resolved FROM `readCatalog()` (the single
   *  source of truth), in ONE read so a check keyed off it cannot straddle a catalog swap. */
  activeSnapshot(): Promise<ActiveSnapshot | null>;
  /** Vector read pinned to an EXPLICIT generation (the one a prior `activeSnapshot`
   *  returned) — NOT "whatever the catalog names now". This is what makes no-TOCTOU pinning
   *  compositional: the wrapper resolves the snapshot once, then reads THAT generation. */
  queryRevision(
    revision: string,
    vector: number[],
    k: number,
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
}

/** Read side — what gnostifiable pipelines depend on. Score-bearing; no session
 *  metadata; the compat wrapper (makeCompatibleSkillsRag) implements it OVER an
 *  ISkillsRagBackend + the serving embedder. `options` threads cancellation/telemetry/
 *  token-metering: the query embedding is logged via `options.requestLogger`, exactly
 *  like the controller's RAG (so skills recall embeds reach /v1/usage). */
interface ISkillsRagHandle {
  /** Recall. The store can be ROTATED out-of-band (a separate ingest activates a new
   *  generation while this server runs). Order matters — the embed is the only PAID
   *  step, so it comes LAST: (1) read the backend's `activeSnapshot()` ONCE; (2) if null
   *  (no active generation) or INCOMPATIBLE for that `revision` (verdict CACHED by
   *  revision, one check per rotation), return EMPTY immediately + a loud error/metric —
   *  WITHOUT embedding `text`; (3) only on a compatible revision embed `text` (serving
   *  embedder, metered via `options`); (4) `queryRevision(snapshot.revision, vector, k)`.
   *  The snapshot's `revision` is used for BOTH the check and the read, so recall is
   *  pinned to one revision (no check↔read window). A still-running server never issues
   *  dimension-mismatched queries — nor a wasted embed — after a bad/empty rotation. */
  query(
    text: string,
    opts: { k: number; threshold?: number },
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
  /** Atomic snapshot of the active pointer (null if none active yet). Used for the EAGER
   *  startup fail-fast; the SAME atomic read + per-`revision` comparison runs inside
   *  `query` thereafter (the startup check is just the first, eager instance of it).
   *  Resolving the wrapper's own serving `dimension` (if undeclared) by a probe embed
   *  happens here too — metered via `options` — so a `load(options)` that calls this
   *  completes the descriptor before the first real query. */
  activeManifest(options?: CallOptions): Promise<ActiveSnapshot | null>;
}

/** Write/reconcile side — used ONLY by the host's load(). Extends the LOW-LEVEL backend
 *  (so the host can read its own snapshots), NOT the compat handle. Records live under a
 *  GENERATION namespace: the PHYSICAL key is `${generation}:${record.id}`, so writing
 *  generation B never overwrites generation A's rows (snapshot isolation). `record.id`
 *  is the LOGICAL id (deterministic, dedup-friendly); the generation scopes the
 *  physical key. `options` threads metering into ingest embeds. */
interface ISkillsStore extends ISkillsRagBackend {
  /** Open a new, INACTIVE generation namespace and return its id. It does NOT serve and
   *  has NO per-collection fence — a generation only begins serving when the host names it
   *  in a committed catalog (`provider.publishCatalog`). Concurrent loads open DISTINCT
   *  namespaces, so their writes never collide; the only contention is the catalog CAS. */
  beginGeneration(): Promise<{ generation: string }>;
  upsert(
    generation: string,
    records: readonly SkillRecord[],
    options?: CallOptions,
  ): Promise<void>;
  /** Copy the currently-served generation's records (the one the catalog names for this
   *  collection) for the given stable `sourceId`s into `generation` unchanged —
   *  carry-forward for sources that failed to refresh under strict:false. Keyed by the
   *  config-stable `sourceId`. No-op when the collection has no served generation yet. */
  carryForward(generation: string, sourceIds: readonly string[]): Promise<void>;
  /** Delete a generation's records — used (a) in `load()`'s `finally` for EVERY generation
   *  this load built but did not get named in a committed catalog (ingest error, strict
   *  abort, OR a LOST catalog CAS — see "orphan cleanup"), and (b) by `dropCollection`/
   *  retired-generation reclaim. Idempotent (no-op for an already-dropped generation; never
   *  deletes a generation the active catalog still names). There is NO per-collection
   *  `activate`: building a generation never makes it serve, so a generation that never
   *  reaches a committed catalog has zero serving effect and is simply discarded. */
  discardGeneration(generation: string): Promise<void>;
}

/** Outcome of a `load()` that COMMITTED (possibly partially). Hard failures —
 *  `strict:true` source failure, exhausted catalog-CAS retries, config errors — THROW
 *  instead (nothing committed). */
interface SkillLoadResult {
  committed: readonly string[];                      // collections now serving (new or prior gen)
  omitted: readonly { group: string; reason: string }[]; // failed to build, NO prior → not serving
  tombstoned: readonly string[];                     // collections removed from the desired set
  ok: boolean;                                       // true iff `omitted` is empty
}

interface ISkillPluginHost {
  /** SINGLE fenced commit. Ingest runs EVERY source's `acquire()` → `{ collections,
   *  records }`, MERGES into one desired catalog (union of collections + per-collection
   *  source ownership), and BUILDS each desired collection's NEW generation INACTIVE
   *  (`beginGeneration` + `upsert` for refreshed sources + `carryForward` for a failed
   *  source's records under strict:false — copied INTO the new generation, so the NEW
   *  generation is what's published; carry-forward is NOT a build failure). It then commits
   *  ONCE: `publishCatalog(prior.catalogRevision, entries)` where each entry names its
   *  serving `generation` — the newly-built one normally; the PRIOR one if that
   *  collection's whole new generation could not be built BUT a prior exists; and a
   *  collection that failed to build with NO prior (first load / brand-new) is OMITTED
   *  from `entries` (it does not serve, the failure is reported, other collections still
   *  commit). Plus manifest + tombstones for removed collections. The catalog CAS is the
   *  ONLY thing that makes any generation serve, so a stale loader that loses the CAS
   *  NEVER changes serving data. `load()` returns a partial-failure result when any
   *  collection could not be built.
   *
   *  Orphan cleanup keyed on the COMMITTED catalog: `try { … publishCatalog } finally {
   *  for each generation I built: if the committed catalog does NOT name it →
   *  discardGeneration(g) }`. This deletes (a) everything on a lost CAS / error / strict
   *  abort (nothing committed), AND (b) the built-but-unused generations of collections
   *  that fell back to a prior pointer OR were omitted (no prior) after a SUCCESSFUL
   *  commit — all would otherwise orphan. Only AFTER a successful publish does it
   *  background-reclaim tombstoned collections (`dropCollection`) and superseded prior
   *  generations under the retention grace. See "Collection-set reconciliation".
   *  Per-collection failure semantics survive (a collection that could not build keeps its
   *  prior pointer, or is omitted when none; mixed generations across collections are
   *  fine). Idempotent; startup OR out-of-band.
   *
   *  RECALL-ONLY hosts (constructed with a `backendProvider` and NO `source` — see below)
   *  have nothing to build: `load(options)` opens no generation and writes nothing, but
   *  it is NOT empty — it first reads `backendProvider.readCatalog()` (the catalog
   *  the ingest job persisted) to (a) resolve the served collections' descriptions for
   *  `groups()` and (b) VALIDATE that every `serveCollections` id actually exists in the
   *  catalog (config error otherwise). Then for EACH served collection it calls
   *  `rag(g).activeManifest(options)`, which resolves that wrapper's serving `dimension`
   *  if undeclared (ONE probe embed through `options` — metered/cancellable, never an
   *  unmetered embed at construction) and compares the serving descriptor to that
   *  collection's active generation for an EAGER fail-fast. The same atomic check runs
   *  per-revision inside `rag(g).query`. Collections are materialised out-of-band by a
   *  SEPARATE ingest job. `options` threads metering into the probe and ingest.
   *
   *  CATALOG-CAS RETRY: if `publishCatalog` loses the CAS (a concurrent loader committed
   *  first), the load DISCARDS the failed attempt's built generations (orphan cleanup) and
   *  RETRIES the WHOLE reconciliation FRESH from the new snapshot — re-read `readCatalog()`,
   *  re-merge `acquire()` results, re-decide carry-forward/prior-pointer against the NEW
   *  catalog, REBUILD generations, then `publishCatalog(newRev, …)`. There is NO reuse of
   *  the prior attempt's generations (their carry-forward/prior-pointer basis is now stale).
   *  Bounded by `catalogCasMaxAttempts` (default 3) with a small bounded backoff. On
   *  exhaustion → THROW (all built generations across all attempts discarded).
   *
   *  RETURN/THROW: resolves a `SkillLoadResult` when a commit happened (even with
   *  per-collection omissions under strict:false — `result.ok === false`, `result.omitted`
   *  lists them). THROWS on a hard failure — a `strict:true` source failure, catalog-CAS
   *  retries exhausted, or a config error — having committed NOTHING. (A recall-only
   *  load returns `{ committed: servedCollections, omitted: [], tombstoned: [], ok: true }`
   *  or throws on incompatibility / missing serveCollections.)
   *
   *  RELOAD (load() is re-callable) — two roles:
   *  - An **ingest job/host** (NOT wired into a running agent's RAG sources) MAY reload and
   *    publish a CHANGED collection set — that is how the set evolves out-of-band.
   *  - A **serving host** (whose `groups()` set was registered into a live agent) fixes its
   *    served set at the FIRST `load()`. On a reload — and again on each CAS retry — it
   *    asserts BOTH `current active catalog set == registered set` (catches an OUT-OF-BAND
   *    catalog change; without it a commit would tombstone an externally-added collection)
   *    AND `resolved desired set == registered set` (catches a LOCAL change), BEFORE
   *    building any generation or calling `publishCatalog`. EITHER mismatch THROWS a clear
   *    "served collection set changed; rebuild the host" error HAVING BUILT NOTHING and
   *    committed nothing — the persistent catalog is untouched. A same-set reload (new
   *    generations only) proceeds and rotates.
   *  So changing the served set = re-ingest via an ingest job + rebuild/restart the serving
   *  agent; a serving host never silently re-registers sources NOR mutates the catalog when
   *  the set would change. */
  load(options?: CallOptions): Promise<SkillLoadResult>;
  /** The collections this host serves, with descriptions — what the explicit mode's
   *  planner picks from, and what the implicit wiring enumerates to register RAG sources.
   *  SYNCHRONOUS, returning a snapshot fixed at `load()`. **The SERVING COLLECTION SET is
   *  IMMUTABLE for the agent's lifetime:** it is enumerated once at `load()` (from
   *  `provider.readCatalog()`), and the implicit wiring registers one RAG source per
   *  collection THEN. Generation ROTATION within a known collection is fully dynamic
   *  (`rag(g).query` re-checks the catalog per query — refreshed skills are picked up with
   *  no restart). But ADDING or REMOVING a collection out-of-band does NOT change what this
   *  agent serves — a new collection has no registered source and a removed one's source
   *  lingers — so a collection-SET change requires a host **rebuild/restart**. A removed
   *  (tombstoned) collection degrades gracefully: its source's `activeSnapshot()` finds no
   *  active catalog entry → empty recall, never an error. The host does NOT compute the
   *  entries; the snapshot holds the strategy-emitted catalog, filtered to
   *  `serveCollections` on a recall-only host. */
  groups(): readonly SkillGroupInfo[];
  /** The score-bearing skills-RAG handle for ONE group's collection — pipelines recall
   *  from it. `group` omitted → the sole/default group (error if several are enabled).
   *  Always available — including on a recall-only host that never ingested, because it
   *  reads the already-active generation an out-of-band ingest wrote. Each group's
   *  collection has its OWN generations/revisions; rotation/compat is per-collection. */
  rag(group?: string): ISkillsRagHandle;
}

/** A group is a named, conflict-isolated set of skills = one skills-RAG collection. */
interface SkillGroupInfo {
  group: string;        // stable group id the STRATEGY assigned (NOT a host-derived rule)
  description: string;  // for the explicit planner's group-selection prompt
  collection: string;   // physical collection name in the skills-RAG
}
```

Composed from injected strategies at construction. The `source` is **OPTIONAL** and the
backend is typed by capability — an ingest-capable host needs the write/reconcile API,
a recall-only host needs ONLY the read handle (**least privilege** — no write
credentials, no reconciliation surface in a serving process):

BOTH host shapes serve via the SAME compat wrapper over a backend; they differ only in
who WRITES the backend (the host itself, or a separate ingest job):

```ts
// Ingest-capable host (startup self-ingest, or an out-of-band ingest job). It both
// writes AND serves, per GROUP, so it takes a STORE PROVIDER + the serving descriptor
// fields, and wraps each group's store as that group's read path:
makeSkillPluginHost({
  source,            // acquisition strategy + the explicit enabled[] PLUGIN list + grouping
  storeProvider,     // ISkillsStoreProvider — forGroup(g) → that group's ISkillsStore
  embedder,          // SERVING embedder — text query embed + lazy dimension probe
  embeddingSpaceId,  // mandatory for a persistent store (auto for in-memory self-ingest)
  retrievalSchemaVersion,
  dimension,         // optional — declared skips the probe
})
// → internally, per enabled group g: store_g = storeProvider.forGroup(g); ingest writes
//   g's records into store_g; rag_g = makeCompatibleSkillsRag({ backend: store_g, embedder,
//   embeddingSpaceId, retrievalSchemaVersion, dimension }). host.rag(g) returns rag_g.
//   (ISkillsStore extends ISkillsRagBackend, so each group's store IS its own backend.)

// Recall-only serving host (no-FS serving model — no source, no write API). The CALLER
// supplies a backend PROVIDER (least privilege — read-only handles, no write store):
makeSkillPluginHost({
  backendProvider,   // ISkillsRagBackendProvider — forGroup(g) → that group's read backend
  embedder, embeddingSpaceId, retrievalSchemaVersion, dimension /* optional */,
  serveCollections,  // the collection ids (groups) this instance exposes
})
// → host.rag(g) = makeCompatibleSkillsRag({ backend: backendProvider.forGroup(g), embedder, … }).
```

`makeCompatibleSkillsRag` returns an `ISkillsRagHandle`: `query` reads
`backend.activeSnapshot()` once, runs the per-`revision` compatibility check (caching the
verdict by revision) BEFORE any embed, and only on a match embeds the text and issues
`backend.queryRevision(snapshot.revision, vector, k)` — pinning is implementable because
the backend exposes a revision-explicit read, not a "query whatever is active" method;
the embed (the only paid step) is skipped on a null/incompatible generation. The
descriptor reaches `query` by closure (resolving "where does the serving descriptor come
from"). The host requires `{ source, storeProvider, embedder, … }` (ingest) OR
`{ backendProvider, embedder, serveCollections, … }` (recall-only); a serving process gets
read-only handles — exactly the over-privilege the recall-only shape removes.

A gnostifiable pipeline depends on **`host.rag(group)` only** — an `ISkillsRagHandle`.
It knows nothing about plugins, source, or backend; the host hides all of that.
`skillsRecall(goal, k, threshold, ctx.options) = host.rag(group).query(goal, { k,
threshold }, ctx.options)` — the request `CallOptions` flow through so the recall
embedding is metered/cancellable. Swapping the source or the store never touches the
consumer. `load()` is the only place acquisition/parse/ingest/reconciliation live;
everything downstream is RAG.

**Implicit recall — attach to the pipeline's existing RAG path.** The recall call is
always `host.rag(group).query(goal, { k, threshold }, options)`; only HOW the hits reach
the LLM differs by what RAG path the pipeline already reads.

*Assembler pipelines (flat/default, linear).* Their **context-assembler** consumes
`IRag` sources: it embeds the query once into an `IQueryEmbedding`, calls each source's
`query(embedding, k, options)` → `RagResult[]`, and formats ALL sources uniformly into
`## <header>\n- <text> [score]` under a SHARED budget. `ISkillsRagHandle` is NOT an
`IRag` (it takes text, embeds in its OWN space), so a small **adapter** bridges it:

```ts
// skillsRagSource(host.rag(group), { k, threshold }) : IRag   // FULL IRag contract:
//
//   query(embedding, k, options): Promise<Result<RagResult[], RagError>>
//     try {
//       hits = await host.rag(group).query(embedding.text, { k, threshold }, options) // re-embed
//         // uses IQueryEmbedding.text, NOT .toVector(): skills live in their OWN embedding space
//         // (their embeddingSpaceId), so the assembler's query vector is wrong here.
//       return ok(hits.map(h => ({ text: h.record.content, score: h.score,
//                  metadata: { id: h.record.id, group, name: h.record.name,
//                              provenance: h.record.provenance } })))
//     } catch (e) { return err(ragError(e)) }   // incompatible/empty rotation → ok([]) (handle
//                                               //   returns [] there); only a real fault → err.
//
//   healthCheck(options): Promise<Result<void, RagError>>
//     → ok() if host.rag(group).activeManifest(options) resolves AND is compatible;
//       err(RagError) if the backend is unreachable or the descriptor mismatches.
//
//   getById(id, options): Promise<Result<RagResult | null, RagError>>
//     → BEST-EFFORT: if the backend offers a by-id read, return ok(mappedRecord)/ok(null);
//       if it does not (the base ISkillsRagBackend has no by-id method), return ok(null).
//       The assembler tolerates null; skills recall is by similarity, not id.
//
//   writer(): undefined   // read-only source — no writes.
```

Registered as a normal source with a section header (e.g. "Relevant Skills"); skills
share the assembler's uniform formatting + shared budget — **no consumer code, no
skills-specific block, no separate `maxInjectChars`**. The deliberate second embed is
intentional (skills' own space); cost metered via `options`.

*Self-assembling pipelines (controller — in scope; dag/stepper — same pattern).* They
read the raw `ctx.inputText` and build subagent prompts themselves; there is NO shared
assembler to register a source on. So implicit recall is plumbed into that pipeline's
own context assembly: the controller planner calls `host.rag(configuredGroup).query(
goal, { k, threshold }, options)` and injects a bounded "Relevant skills" block (its OWN
`maxInjectChars`). Still implicit — a fixed configured group, no planner choice; just
attached to the controller's path instead of an assembler. dag/stepper would attach the
same way, wired as needed.

**Explicit group selection (deferred, separate spec).** The planner is handed
`host.groups()` and, per step, SELECTS the group, then recalls `host.rag(selectedGroup)`
— the only mode that needs a genuine planner-driven hook and exploits several
conflicting groups at once. Built on the same host.

### Canonical skill record — the stable RAG contract

```
SkillRecord {
  id: string            // LOGICAL stable id: "<sourceId>/<plugin>@<version>/<skill>#<chunkIx>"
                        //   deterministic (dedup); the store's PHYSICAL key is
                        //   `${generation}:${id}` so generations never collide — see "Reconciliation"
  sourceId: string      // STABLE config-declared source id, version-INDEPENDENT — the
                        //   reconciliation/carryForward key (survives a registry/version change,
                        //   and is known even when a failed fetch's version is not)
  group: string         // GROUP id = the skills-RAG collection this record lands in, ASSIGNED
                        //   BY THE STRATEGY (collection placement — host imposes no rule).
                        //   Conflict-isolation unit: recall via host.rag(group) sees only this group.
  name: string          // "<plugin>/<skill>" (+ "#<heading>" for a chunk) — human label
  retrievalText: string // the EMBEDDED surface — DISTINCT per chunk (see below)
  content: string       // the chunk body — injected verbatim into the LLM context
  provenance: string    // VERSIONED descriptive metadata: "<plugin>@<version>/<skill>#<heading>"
}
```

**The embedded surface is `retrievalText`, NOT the shared `description`.** If every
chunk of a skill embedded the same skill-level `description`, all chunks would map to
an identical vector — recall could not pick the relevant SECTION and top-k would
return arbitrary chunks. So each chunk's `retrievalText` is **distinct**: the skill
`description` (for topical context) + the section heading + the chunk content, e.g.
`"${description}\n## ${heading}\n${content}"`. (For an unchunked skill, retrievalText
= description + body.) English ⇄ English with the planner's English instructions → a
normal embedder suffices ([[project_embedder_multilingual_mcp_english]]). Stored in a
**dedicated skills collection/store**, separate from run-scoped results-RAG and from
tools-RAG (mixing pollutes recall both ways).

### Pipeline of concerns (each FS-free at the contract level)

```
  acquire (fetcher)  →  parse + PLACE (strategy)  →  ingest (upsert)  →  recall (runtime)
  ───────────────────   ───────────────────────     ───────────────     ───────────────
  HTTP→memory | prog.    in-memory bytes →           SkillRecord[]       semantic query
  | FS (optional)        SkillRecord[] w/ collection  per collection →   → inject body
                         (placement = strategy)       skills-RAG
```

**Acquisition + placement are ONE injected strategy, returning a STRUCTURED result.**
The strategy fetches, parses, AND assigns each record's collection (it alone knows the
source's semantics). It does NOT return a bare `SkillRecord[]` — the host could derive
collection IDs from records but NOT their `description`s (which `groups()` must expose).
So the strategy returns an authoritative catalog alongside the records:

```ts
interface SkillIngestResult {
  collections: readonly SkillGroupInfo[]; // AUTHORITATIVE desired catalog: every collection
                                          //   this strategy produces, with its description.
  records: readonly SkillRecord[];        // each record.group ∈ collections[].group (validated).
}
/** The injected acquisition + materialisation strategy (== a `source`). */
interface ISkillSource {
  /** Fetch + parse + place. `options` meters/cancels any network/embedding work. */
  acquire(options?: CallOptions): Promise<SkillIngestResult>;
}
```

The host takes each strategy's `collections` as ITS contribution to the desired catalog
and never computes placement or descriptions itself. A record whose `group` is absent
from its source's `collections` → ingest error (strategy contract violation).

**Multiple sources — merge into one aggregate catalog.** `config.sources` is an array;
several sources MAY contribute to the SAME collection (e.g. a base set + an overlay). The
host runs every source's `acquire()` and MERGES:
- **Desired catalog** = the UNION of all sources' `collections`, keyed by `group`. The
  per-collection **ownership** (`CatalogEntry.sources`) = the set of sourceIds that
  declared/placed into it. Same `group` from two sources with **different `description`s
  → ingest error** (ambiguous catalog; the operator must reconcile the strategies).
- **A collection's record set** = the union of every contributing source's records for
  that `group`. No cross-source `id` collisions: `SkillRecord.id` is prefixed by
  `<source>`, so two sources' records are always distinct keys.
The per-collection generation for `g` is built from that merged record set, so a
collection fed by N sources is one consistent snapshot.

**1. Fetcher (acquisition) — pluggable, FS-free by contract.**
- **HTTP→memory** (primary for self-ingesting instances): fetch the
  marketplace/registry + each `SKILL.md` over HTTP **into memory** (e.g. GitHub
  API/raw, or any registry URL). No clone, no disk.
- **Programmatic**: the embed-as-library caller hands `SkillRecord[]` (or raw
  content) in memory.
- **FS directory**: optional convenience ONLY where a filesystem happens to exist;
  never required. (This is the only path that may reuse `loadSkillFromDir`.)

**2. Adapter (parse + place) — pure, in-memory, FS-free.** A content-agnostic transform:
given the in-memory marketplace manifest + `SKILL.md` strings of the **enabled**
plugins, produce canonical `SkillRecord[]` **with each record's `group`/collection
assigned** (placement is the strategy's call — it MAY map a plugin 1:1, bundle, or
split). Reuses the **frontmatter parser** (pure string parsing — NOT `loadSkillFromDir`).
Ignores plugin commands/agents/hooks (skills only). **Chunks** large bodies by top-level
Markdown sections (over-long sections split on paragraphs, bounded to `chunk.maxChars`)
so recall returns the relevant fragment, not a 15 KB dump. For each chunk it computes the
**stable `id`** (`<source>:<plugin>@<version>/<skill>#<chunkIx>`, deterministic) and the
**distinct `retrievalText`** (description + heading + chunk content). A given source
format = one adapter/strategy; the canonical schema (incl. the `group` field) is the
fixed contract between any strategy and the host.

**3. Ingest + materialisation strategy (pluginator backend).** `SkillRecord[]` →
embed each record's `retrievalText` → write into the store. WHERE/WHEN the skills
are materialised is a **pluggable strategy** (analogy: Claude Code downloads plugin
files on install) — chosen per environment, all converging on the same skills-RAG:
- **FS-cache** (Claude-Code-like): download/cache plugin files to disk, then ingest
  to RAG. For environments that have a filesystem.
- **In-memory per run**: fetch → parse → ingest into an in-memory store at every
  startup; no persistence. Ephemeral, FS-free.
- **Direct vector-DB**: fetch → upsert into a persistent networked store
  (Qdrant/HANA/pg), once / out-of-band. **Serving instances — even with no
  filesystem and no source access — only recall.** The no-FS serving model.

The recall contract is invariant across all three: the planner reads the
skills-RAG, never FS, never the source. The backend is an implementation detail of
the selected pluginator strategy, not of the engine core.

### Reconciliation — generation snapshots (persistent stores)

**Per-collection record snapshots, ONE catalog commit.** Each collection has its OWN
generation namespaces; `beginGeneration`/`upsert`/`carryForward`/`discardGeneration` act
on ONE collection (via `storeProvider.forGroup(g)`). But there is NO per-collection
activate: ALL collections begin serving together via the SINGLE fenced catalog commit
(`publishCatalog`), which carries a possibly-DIFFERENT generation pointer per collection.
So **mixed generations across collections are allowed and expected** (collection A's new
generation + collection B's carried-forward prior generation commit together), while the
commit itself is atomic and fenced — there is no independent per-collection pointer a
stale loader could leak. A per-collection BUILD failure (under strict:false) just means
that collection's catalog entry keeps its prior generation pointer — or, if it has NO
prior (first load), is OMITTED from the commit and reported (the other collections still
commit); under `strict:true` the whole `load()` aborts (nothing committed, prior catalog
fully retained).

**Collection-set reconciliation (TWO levels, multi-source, fenced, publish-before-drop).**
Per-collection generation snapshots (below) reconcile RECORDS within a collection. A
SECOND level reconciles the SET of collections, because the aggregate catalog can shrink
(a plugin dropped, a re-grouping) — a removed collection's active generation would
otherwise serve stale skills forever. `load()`:
1. `prior = await storeProvider.readCatalog()` — `{ catalogRevision, entries }` (the CAS
   fence + the per-collection source OWNERSHIP).
2. Run EVERY source's `acquire()`. **Merge** into `desired` (union of `collections`,
   ownership = contributing sourceIds, conflicting descriptions → error) and the merged
   per-collection record sets.
3. **Carry-forward for a failed source (`strict:false`):** a source that failed to fetch
   contributes nothing to `desired` this round — but its collections must NOT vanish. From
   `prior.entries` (ownership), re-add every collection the failed source owned to
   `desired`, carrying its records forward (`carryForward(generation, [failedSourceId])`).
   If the failed source was the SOLE owner of a collection, that collection is retained
   intact, not dropped. (`strict:true`: a source failure aborts that source's collections'
   generations — their prior generations stay — and fails `load()`.)
   - **Serving-host set guard (BEFORE any build, RE-CHECKED on each CAS retry).** A serving
     host asserts BOTH equalities against its registered set:
       (a) `current active catalog set (from this attempt's readCatalog) == registered set`
       (b) `resolved desired set == registered set`.
     (a) catches an OUT-OF-BAND change to the persistent catalog (e.g. another ingest added
     `c2`) — without it, the serving host's commit would tombstone `c2` and silently roll
     back the external change; (b) catches a LOCAL change (its own sources now resolve a
     different set). EITHER mismatch → THROW immediately, BEFORE step 4 builds any
     generation and before any `publishCatalog`, so the persistent catalog is never mutated
     and no generations are created. Because a CAS retry re-reads the catalog (which may
     have changed between attempts), BOTH checks run again on every attempt. (An ingest-only
     host skips this guard — changing the set is its purpose.)
4. Build each `desired` collection's NEW generation INACTIVE: `beginGeneration()` +
   `upsert` (refreshed sources) + `carryForward` (a failed source's records under
   strict:false, copied INTO this new generation). **No `activate`** — nothing serves yet.
   Track every generation built (for orphan cleanup). A carried-forward source is NOT a
   build failure: the new generation contains refreshed + carried-forward records and IS
   what gets published. If a collection's WHOLE new generation cannot be built (e.g. a
   store/embed error), resolve its entry by whether a PRIOR generation exists:
   - **prior exists** → keep the prior `generation` pointer (last-known-good retained);
     any built-partial generation is an orphan (cleaned in step 6). Not tombstoned.
   - **NO prior** (first load, or a brand-new collection that failed on its first build)
     → there is nothing to fall back to: the collection is **OMITTED from the committed
     catalog** (it simply does not serve), and the failure is reported (warn + `load()`
     returns a partial-failure result). It is NOT tombstoned (there was nothing to retire)
     and does NOT abort the other collections.
5. **The SINGLE fenced COMMIT.** Compose `entries`: for each desired collection that
   resolved to a serving generation (newly-built — the normal case, INCLUDING carried-
   forward sources — or a prior pointer when its whole new generation failed but a prior
   exists), a `CatalogEntry` naming that `generation` + manifest + ownership. A collection
   that failed to build with NO prior is left OUT of `entries` entirely. Add a `tombstone`
   for each `g ∈ prior.active \ desired`. Call `publishCatalog(prior.catalogRevision,
   entries)`. This is the ONLY operation that makes
   any generation serve — it atomically swaps EVERY collection's serving pointer and bumps
   the catalog revision, succeeding ONLY if `prior.catalogRevision` is still active. A
   concurrent loader that committed first makes this CAS FAIL → this load aborts having
   activated NOTHING (its built generations never served).
6. **Orphan cleanup (finally), keyed on the COMMITTED catalog — not just `!committed`.**
   The whole build runs inside `try { … publishCatalog } finally { for each generation I
   built across all collections: if the committed catalog does NOT name it →
   discardGeneration(g) }`. This covers BOTH cases uniformly: on a lost CAS / ingest error
   / strict abort nothing was committed, so ALL built generations are discarded; on a
   SUCCESSFUL commit, the built generations of collections that fell back to a prior
   pointer (their new generation was NOT named) are ALSO discarded — they would otherwise
   leak as orphans. Only generations the committed catalog actually names survive.
7. **AFTER a successful publish**, background-reclaim (under the retention grace) the
   tombstoned collections (`dropCollection(g)`) AND each collection's now-superseded prior
   generation. Physical deletion NEVER precedes the commit, so the active catalog never
   references an already-deleted collection/generation.

A recall-only host does NO collection-set reconciliation — it only `readCatalog()`s.
Per-group failure semantics survive (a collection that failed to build keeps its prior
generation pointer in the committed catalog; mixed generations across collections are
fine), but there is NO independent per-collection activation that a stale loader could
leak — the catalog commit is the sole activation.

**Within a collection — generation namespaces (no per-collection activate).** A naive
"idempotent upsert" leaks stale records (updated skill, re-chunk, removed plugin). So a
collection's records are written under a **generation namespace** — physical key
`${generation}:${record.id}` — and the generation is built INACTIVE; it only begins
serving when the catalog commit (step 5) names it. `beginGeneration()` → a fresh
namespace; `upsert`/`carryForward` fill it; the catalog commit is the atomic flip for the
whole set. The prior generation a commit supersedes is **NOT hard-deleted at commit time**
— it is retired under a **retention grace period** (below) so an in-flight recall that
resolved it (from the prior catalog snapshot) can finish its read.

**Concurrent loads (out-of-band / multi-instance) — ONE fence, the catalog CAS.** Two
`load()`s build distinct generation namespaces concurrently (no write collision). The
SOLE fence is the catalog: each commits with `publishCatalog(expectedCatalogRevision,…)`.
If B commits first (bumping the catalog revision), A's `publishCatalog(priorRev,…)` fails
the CAS → A activated nothing and discards its built generations (step 6), then RETRIES
the whole reconciliation from B's fresh snapshot (re-read catalog, re-merge, re-decide
carry-forward/prior-pointer against the new catalog, rebuild, re-publish). Bounded by
`catalogCasMaxAttempts` (default 3) with a small bounded backoff; on exhaustion `load()`
THROWS. No generation ever serves except via a won catalog commit, so a late loser cannot
change serving data. For in-memory the catalog revision is a monotonic counter; for a
vector-DB it is an etag/fencing token on the catalog row (or a lease around the load).

**Source-failure policy (resolves `strict` vs snapshot atomicity) — applied PER GROUP.**
A group's new generation is all-or-nothing for THAT group: its collection must contain
every record of every source feeding the group before it can be named in the commit, or
the group's catalog entry keeps the prior generation. So, per group:
- **`strict: false` (default) — per-source carry-forward, at BOTH levels.** *Within a
  collection:* `carryForward(generation, [its sourceId])` copies the failed source's
  records from the group's served generation into the NEW one unchanged; reachable
  sources refresh; the NEW generation (refreshed + carried) is what the commit names.
  *At the collection-set level:* if the failed source SOLELY owned a collection (per
  `readCatalog()` ownership), that collection is re-added to `desired` and carried forward
  — it is NOT tombstoned just because its only source was down this round. When a
  collection has NO refreshed records this round (all its sources down), keeping its prior
  generation pointer is equivalent to re-building a carry-only generation, so the host MAY
  just keep the prior pointer there — that is the ONLY case prior-pointer reuse is correct.
  So a transient source outage never drops its collections. (First load with no prior
  generation/ownership → a failed source simply contributes nothing.)
- **`strict: true` — all-or-nothing for the LOAD.** A source failure means the whole
  `load()` does not commit: `publishCatalog` is not called, the prior catalog is fully
  retained, all built generations are discarded (orphan cleanup), and the error surfaces.
  (Because activation is the single catalog commit, strict:true is naturally
  all-or-nothing — there are no partially-activated collections to undo.)

**Retention of the retired generation (no read-under-delete).** A recall is two steps:
resolve the active generation (from the catalog snapshot), then run the vector query
against it. If the catalog commit hard-deleted the superseded generation between those
two steps, an in-flight reader that resolved the old generation would query rows that no
longer exist (empty/garbage recall). Two retention disciplines, by backend capability —
a strict one that GUARANTEES reader completion, and a best-effort one that does not:
- **In-memory — exact (refcount/captured reference).** The swapped-out map is reclaimed
  only once the last reader that captured it returns: a reader holds a reference (or a
  refcount lease) for the whole query, so GC/discard cannot run mid-read. This is an
  exact guarantee — no time bound.
- **Vector-DB with snapshot/lease semantics — exact.** Where the backend supports a
  read snapshot, a collection alias, or a generation lease, the reader pins generation
  N (alias/lease held across resolve+query); the sweeper drops N only after every lease
  on it is released. Exact, latency-independent — the preferred persistent config.
- **Vector-DB, plain time-grace — BEST-EFFORT.** Where the backend offers no
  lease/snapshot, a background sweeper deletes generation N's rows after `retiredGraceMs`
  (default e.g. 30 s). This is **best-effort, NOT a guarantee**: a pathologically slow
  query (network retry, GC pause) exceeding the grace window can still read-under-delete.
  The mitigation only REDUCES the window: recall is a single fast round-trip with a
  `CallOptions` timeout `< retiredGraceMs`, so a query that would outlive the grace
  window is cancelled — but cancellation does not prove the backend read physically
  finished before the sweep, so a race remains possible. Operators needing a hard
  guarantee use a lease/snapshot-capable backend (above).

So a reader that pins generation N keeps its rows under the exact disciplines; under
plain time-grace the timeout-`< retiredGraceMs` invariant makes a race practically
unreachable but not impossible. The grace/refcount reclaim is distinct from
`discardGeneration` of a NEVER-committed build (immediate — no reader ever saw it).

For the **in-memory** store a generation is a map; the catalog commit swaps which map
each collection serves. For a **vector-DB** a generation is a label filtered on query and
the catalog commit flips the pointer, with the grace-delayed sweep above (or a
collection-alias swap where supported). The **ephemeral in-memory-per-run** strategy has
no prior generation to carry forward (each startup builds from scratch) but uses the same
build→commit swap within a run for atomicity.

**4. Recall (runtime) — RAG-only, FS-free.** Recall is always `host.rag(group).query(
text, { k, threshold }, options)` → `SkillHit[]` (top-`k`, score ≥ `threshold`), each
hit's `record.content` already in the store (NO re-load from FS or source), chunk-level
(a hit IS one section, not a whole skill). HOW it reaches the LLM differs by path:
- **Assembler pipelines (flat/default, linear):** the adapter exposes those hits as
  `RagResult[]` to the context-assembler, which formats them with all other sources and
  applies its SHARED budget — there is NO separate "Relevant skills" block or
  `maxInjectChars`.
- **Self-assembling pipelines (controller):** the planner injects the hits as a dedicated,
  bounded "Relevant skills" block governed by its OWN `maxInjectChars` (no shared
  assembler to use).
Empty/no match → no block/section → unchanged behaviour. Group: fixed per registered
source (assembler), configured (controller), planner-selected (explicit, deferred).

### Where it plugs in

| Concern | Location | New / reused |
|---|---|---|
| Frontmatter parse (pure) | `llm-agent-libs/src/skills` | **reused** (FS-free) |
| `loadSkillFromDir`, `ClaudeSkillManager` (FS) | same | reused ONLY by the optional FS fetcher |
| `ISkillSource` strategy (`acquire() → { collections, records }`) + fetchers (HTTP/prog./FS) | `llm-agent-libs/src/skills` | **new** (HTTP/programmatic) |
| `PluginMarketplaceAdapter` (in-memory → canonical records + collection catalog + chunker) | same | **new** |
| `ISkillsStore`/`ISkillsRagBackend` impls (in-memory; vector-DB) + per-group PROVIDERS w/ CATALOG (`readCatalog`+revision/`publishCatalog` CAS/`dropCollection`) | `llm-agent-libs` (+ a vector-DB adapter) | **new** (cosine + score + per-collection generations + collection catalog; not `IKnowledgeRagHandle`) |
| `makeCompatibleSkillsRag` (compat wrapper → `ISkillsRagHandle`) | `llm-agent-libs` | **new** |
| Ingest wiring + **collection-set reconciliation** (drop collections absent from the strategy's desired catalog) | SmartServer build / a CLI/admin entry | **new** (parallels MCP→toolsRag) |
| Strategy-driven collection placement (each strategy assigns records to collections) | injected acquisition/materialisation strategy | **new** (NOT host logic) |
| **Skills adapter** — `skillsRagSource(host.rag(group))` : `IRag` (SkillHit→RagResult; re-embeds `IQueryEmbedding.text` in skills' space) | `llm-agent-libs` | **new** (the seamless bridge) |
| **Implicit wiring — assembler** — register the adapter as an `IRag` source in the context-assembler | SmartServer build / SmartAgent retrieval composition | **new** (flat/default + linear) |
| **Implicit wiring — controller** — planner recalls a configured group, injects a bounded block into its own context | controller planner | **new** (measurement target, in scope) |
| Implicit wiring — dag / stepper (same self-assembling pattern) | dag / stepper handlers | deferred |
| **Explicit hook** — planner picks `host.groups()` group per step | controller planner | **new**, deferred |
| Config parse (`skills` block) + `builder.withSkills(...)` | server config + builder | **new** |

**Only the ASSEMBLER pipelines get implicit recall for free.** The context-assembler
consumes `IRag` sources; the adapter registers each enabled group there, so the
**assembler-based pipelines — flat/default and linear** — are gnostified with no consumer
code. **The registered source set is FIXED at wiring time (= `load()`/agent build):** one
adapter per collection in `host.groups()` then. Generation rotation WITHIN a collection is
picked up dynamically (the adapter re-checks the catalog per query — refreshed skills need
no restart), but the COLLECTION SET is immutable for the agent's lifetime: a collection
added out-of-band gets no adapter (not served) and a removed one's adapter lingers but
degrades to empty recall (its `activeSnapshot()` finds no active catalog entry). Changing
the served collection SET therefore requires a host **rebuild/restart** — dynamic
re-registration of assembler sources is explicitly out of scope. The **controller, dag,
and stepper do NOT use the assembler** (they read
`extractPrompt(ctx.textOrMessages)` / raw `ctx.inputText` and build prompts themselves),
so each must have implicit recall plumbed into its own context assembly; this phase wires
the **controller** only (dag/stepper deferred, same pattern). The existing
default-pipeline `SkillSelectHandler` (RAG-selects `skill:<name>` then re-loads the full
body via `ISkillManager`/filesystem — violating no-FS, injecting a whole skill) is
**superseded** by the RAG-source approach; reworking/retiring it is follow-on cleanup.
The **explicit** planner-driven group selection is the separate later phase.

## Configuration

Explicit, opt-in. **Terminology (matches Anthropic's model):** a **marketplace /
registry** is a list of repos offering skills; from it you enable **plugins** (each a
folder of skills); a **plugin** contains one or more **skills** (`SKILL.md`). The
**`enabled` list names PLUGINS.** A **group/collection** = the conflict-isolation unit;
**which collection a skill lands in is decided by the injected `strategy`, not by host
config** — there is no `plugins → group` mapping here.

**YAML (server):**
```yaml
skills:
  mode: implicit                     # implicit = ONLY accepted value this phase; `explicit`
                                     #   (planner picks group) is REJECTED until its phase ships
  store: { type: qdrant, url: ... }  # optional: a persistent networked store
                                     #   (omit → in-memory, self-ingest at startup)
  embeddingSpaceId: sap-skills-emb-2026-06   # MANDATORY for a PERSISTENT store (here Qdrant):
                                             #   published in each collection's catalog entry, so a
                                             #   later recall-only instance can verify it. Bump
                                             #   when the embedding space changes. (Omittable ONLY
                                             #   for the in-memory self-ingest case — one process,
                                             #   no cross-process reader to mismatch.)
  k: 4                               # max records recalled per query
  threshold: 0.3                     # min cosine similarity [0..1]; below → dropped. Default 0.3
  maxInjectChars: 4000               # SELF-ASSEMBLING pipelines (controller) ONLY — the dedicated
                                     #   "Relevant skills" block's char budget. IGNORED by the
                                     #   assembler path (it applies its OWN shared budget).
  controllerSkillGroup: domain-core  # which single collection the controller planner recalls
  serveCollections: [domain-core]    # which collections assembler pipelines read (implicit). Omit
                                     #   → all collections the strategy produced.
  chunk: { maxChars: 1500 }
  strict: false                      # true → a source failure aborts THAT group; false → carry-forward
  catalogCasMaxAttempts: 3           # publishCatalog CAS retries on a concurrent-loader conflict;
                                     #   each retry re-reads the catalog + rebuilds. Exhausted → throw.
  sources:
    - id: vendor-skills                       # STABLE sourceId — reconciliation/carry-forward key
      registry: https://<host>/<skills>       # FETCHED source (marketplace/registry → memory)
      enabled: ["*"]                          # PLUGINS to enable; REQUIRED non-empty for fetched
                                              #   sources; "*" = every plugin the registry offers
      strategy: vendor-marketplace            # the injected acquisition/materialisation strategy:
                                              #   it parses these plugins AND assigns each record's
                                              #   collection. The collections it emits are whatever
                                              #   THAT strategy decides — the host does not bundle.
      strategyConfig: { ... }                 # opaque, strategy-specific (incl. any placement rules)
```

- **`mode`** — `implicit` (default, the ONLY value this phase accepts): the collections
  the strategy produced are attached to the RAG path each pipeline already reads
  (assembler adapter for flat/default+linear; planner-context recall for the controller).
  `explicit` (planner-driven per-step selection) is **deferred — the parser REJECTS
  `mode: explicit` with a clear "not yet implemented" error** so a config is never
  accepted without a working consumption path.
- **Collection placement is NOT host config.** There is no `groups:` block mapping
  plugins to groups: which collection a record lands in is decided by the named
  `strategy` (and its opaque `strategyConfig`). The host only knows the resulting
  collection ids — selected for reading via `controllerSkillGroup` / `serveCollections`.
- **`serveCollections`** — which of the strategy-produced collections this deployment
  actually reads. The operator picks **compatible** collections; the engine cannot judge
  semantic conflict.

A **recall-only serving** instance — the canonical no-FS deployment, where a
persistent store was materialised out-of-band by a separate ingest job — omits
`sources` entirely and declares a persistent `store` plus the serving `embedder`:
```yaml
skills:
  mode: implicit
  store: { type: qdrant, url: ... }  # REQUIRED here — recall reads what ingest wrote
  embedder: { provider: openai, model: text-embedding-3-small }  # MUST match ingest's
  embeddingSpaceId: vendor-skills-emb-2026-06  # MANDATORY (persistent): stable vector-space id,
                                               #   bump when the space changes; NOT alias-derived
  dimension: 1536                            # optional: declare to skip the probe embed
  loadOnStartup: false               # recall-only: no source access, no ingest, load() is a no-op
  serveCollections: [domain-core, domain-ext]  # collection ids the ingest job wrote, exposed via
                                               #   host.groups()/rag(group). Recall-only only NAMES
                                               #   existing collections — it does NOT place/group.
  k: 4
  threshold: 0.3
  # NO `sources`, NO `enabled`, NO `strict` — there is nothing to build.
```

- **`loadOnStartup`** (default `true`) — when `false`, OR when `sources` is omitted, the
  host is **recall-only**: constructed from a read handle only (no `source`, no write
  `store` — least privilege). `load(options)` writes nothing but resolves the serving
  `dimension` (probe) + runs the eager manifest check below; `host.rag()` serves the
  already-active generation. A persistent `store` is then REQUIRED (an in-memory store
  with nothing to ingest would always be empty). It is a config error to give `sources`
  together with `loadOnStartup: false`, or to omit both `sources` and a persistent
  `store`.
- **Embedder compatibility (startup AND per-revision).** The host derives its serving
  `SkillsEmbeddingDescriptor` from THREE sources: `embeddingSpaceId` — for a persistent
  store, a MANDATORY stable id from config (`embeddingSpaceId: ...`) or the provider
  adapter, NOT auto-derived from a `provider:model` alias (a provider can re-train under
  the same alias → silent space drift); `dimension` either declared as `dimension:` in
  config OR resolved by ONE probe embed run INSIDE `load(options)` (metered/cancellable —
  never an unmetered embed at construction); and `retrievalSchemaVersion` from a host
  code constant. It checks this against the active `ActiveSnapshot` (`{ revision,
  manifest }`) EAGERLY at startup (fail fast), and again per-`revision` inside `query`
  whenever the store rotates — a dimension mismatch is a hard error, an
  embeddingSpaceId/schema mismatch is meaningless similarity, and either makes that
  revision serve NO recall. A self-ingesting single-process host MAY auto-use
  `provider:model@version` as the id (the same embedder writes and reads), so it is
  compatible by construction.
- **`retiredGraceMs`** (vector-DB, plain time-grace only; default e.g. `30000`) — how
  long a retired generation's rows linger before the background sweep. Setting recall's
  `CallOptions` timeout `< retiredGraceMs` REDUCES (does not eliminate) the read-under-
  delete window — plain time-grace is best-effort. Ignored by lease/snapshot-capable
  backends and the in-memory store (those retire exactly — see "Retention").
- **`threshold`** — minimum cosine similarity in `[0, 1]`; a `SkillHit` with `score <
  threshold` is dropped (all dropped → no skills block). ONE engine-wide **default
  `0.3`** (not per-adapter), so behaviour is uniform; the recall hook applies it.
- **`id` (sourceId)** — every source declares a **stable, version-independent** id
  (it must NOT encode the registry version): the reconciliation/carry-forward key.
  **`sourceId`s must be GLOBALLY UNIQUE** across all sources — a duplicate is a startup
  config error (two sources sharing an id would collide on the logical `SkillRecord.id`
  and share carry-forward). For a **fetched** source `enabled` is mandatory.

**Programmatic (embed-as-library):**
```ts
builder.withSkills({
  mode: 'implicit',
  k: 4,
  threshold: 0.3,
  // a `records` source is the consumer's pre-filtered set → a stable `id`, NO `enabled`.
  // each record carries its `group`; records of the same group share a collection.
  sources: [{ id: 'my-skills', records: mySkillRecords }], // in-memory; no FS, no fetch
});
```

For a `records` source the host **STAMPS** the configured `id` onto every record's
`sourceId` (so the consumer cannot create a mismatched/duplicate key); the supplied
records need not set `sourceId` themselves, but each MUST carry a `group` (its
collection). `skills` absent → no gnostification. The engine ships no default
`sources`.

## Error handling

- Missing/empty `enabled` on a **fetched** source → **startup config error** (not
  "load all"); a `records` source carries no `enabled`. Missing `id` on any source, or
  a **duplicate `sourceId`** across sources → config error.
- `serveCollections` / `controllerSkillGroup` naming a collection the strategy did NOT
  produce → config error (you can only read collections that exist). Collection placement
  itself is the strategy's job — the host validates only that referenced collections
  exist, never how plugins map to them. Reading mutually-conflicting collections together
  is the operator's responsibility (the engine cannot detect semantic conflict).
- A LOST catalog CAS (a concurrent loader committed first) → `load()` RETRIES from the
  fresh snapshot up to `catalogCasMaxAttempts` (default 3, bounded backoff); on exhaustion
  it THROWS. An ingest error or a `strict` abort → throws too. In every case EVERY
  generation this load built is `discardGeneration`d in a `finally` (no orphans); the prior
  catalog is never reverted (a stale loser activated nothing).
- A **serving host** reload where EITHER the current active catalog set OR the resolved
  desired set differs from the set registered at its first `load()` → THROWS ("served
  collection set changed; rebuild the host"), BEFORE any build/`publishCatalog`, catalog
  untouched. The active-set check prevents silently rolling back an OUT-OF-BAND catalog
  change (tombstoning an externally-added collection). A same-set reload (new generations
  only) is allowed. Changing the set = re-ingest via an ingest job + restart the agent.
- Source unreachable at ingest → `strict:false` **carries the failed source forward**
  from the collection's served generation (warn; its skills are NOT lost), and a
  sole-source collection is carried forward whole (not tombstoned); `strict:true` →
  the whole `load()` does not commit (`publishCatalog` skipped, prior catalog fully
  retained, all built generations discarded). The store is never partially updated.
- **`mode: explicit` in this phase → config error** ("explicit group selection is not
  yet implemented"). Planner-driven selection is deferred; accepting `explicit` would
  yield a config with no working consumption path. Parser rejects it loudly until the
  explicit-mode phase ships.
- **Missing `embeddingSpaceId` on a PERSISTENT store** (ingest OR recall-only) → config
  error. Never silently derive a vector-space id from a `provider:model` alias — alias
  drift would pass undetected. Only the in-memory single-process self-ingest case may
  omit it (the same embedder writes and reads in one run).
- **Recall-only misconfig** → config error: `sources` given together with
  `loadOnStartup: false`; or BOTH `sources` and a persistent `store` omitted (a
  recall-only host over an empty in-memory store would never serve anything).
- **Embedder/store incompatibility — startup AND runtime rotation.** At startup the
  serving descriptor (`embeddingSpaceId`/`dimension`/`retrievalSchemaVersion`)
  disagreeing with `activeManifest()` → abort (do NOT serve dimension-mismatched or
  semantically-meaningless recall). At RUNTIME, an out-of-band ingest can commit a catalog
  naming a new, incompatible generation while the server runs: `query`
  re-checks per revision (verdict cached by revision) and, on an incompatible one,
  serves NO recall (empty → agnostic) and raises a loud error/metric — it does NOT crash
  the running pipeline. No active generation yet (manifest null) → recall empty (no
  block) until an ingest activates one.
- **Retired-generation read race (vector-DB plain time-grace) — best-effort, NOT a
  guarantee.** Setting recall's `CallOptions` timeout `< retiredGraceMs` REDUCES the
  window but does not close it: cancellation does not prove the backend query physically
  finished before the sweep. A hard no-read-under-delete guarantee exists ONLY for
  lease/snapshot (vector-DB) and refcount/captured-reference (in-memory) retention; the
  plain time-grace path is explicitly best-effort. Operators needing the guarantee pick
  a lease/snapshot-capable backend.
- Malformed manifest / `SKILL.md` → skip that item + warn; valid ones still load.
- No embedder → skills ingestion skipped + warn (the controller already requires an
  embedder; same failure surface).
- Runtime query error → no skills block; the pipeline proceeds agnostic (serving
  never blocks on optional gnostic knowledge).

## Testing

**Measurement comes AFTER the mechanism, by TOGGLE — there is NO throwaway pre-build
PoC.** WITH-vs-WITHOUT is measured with the REAL, reusable component once it is built
and wired into the base RAG path: enable the `sap-abap` + `sap-abap-cds` plugins (in MY
eval env I may use a local clone — acquisition is not the product contract), then run
the 5 prompts × {incremental, adaptive} with the skills source toggled ON vs OFF (a
config flag — same component, no stand-in harness). Compare to the agnostic baseline:
does `requires` populate, does incremental produce a valid CDS plan, does the
compound-create split stabilise? This quantifies how much of the earlier negatives were
knowledge gaps (closed by skills) vs engine concerns. The plan-analysis harness is
repointed at the real `host.rag(group)`; it is the measurement instrument, not the
mechanism under test.

**Unit tests.**
- Adapter (in-memory): manifest+`SKILL.md` strings → `SkillRecord[]`; honours
  `enabled` (and rejects a missing/empty `enabled`); ignores commands/agents/hooks;
  **no filesystem access**. Stable `id` is deterministic (same input → same id).
- Chunker + retrievalText: bounds to `maxChars`; splits by H2; over-long section
  splits further; **two chunks of one skill produce DISTINCT `retrievalText`** (so a
  stub embedder maps them to different vectors — the relevant section is selectable).
- Reconciliation (generation snapshot): updating a skill / changing chunking / removing
  a plugin leaves NO stale record recall-able after the catalog commit; namespace
  isolation — building a NEW generation does NOT change what recall returns until
  `publishCatalog` names it (the served generation's rows are untouched).
- Source-failure policy: `strict:false` with one source unreachable **carries that
  source's prior records forward by `sourceId`** (its skills still recall after the
  commit) while a reachable source refreshes; `strict:true` with any source unreachable
  → NO `publishCatalog` (prior catalog fully retained), all built generations discarded.
- Single fenced commit — no leaked activation: loader X BUILDS a new generation for
  collection `c` then LOSES the catalog CAS to loader Y; assert `c` still serves Y's
  generation (NOT X's), X's built generation never served, and X discarded it (orphan
  cleanup) — a stale loser cannot change serving data.
- Catalog commit fence: X and Y both read catalogRevision R; Y `publishCatalog(R,…)` →
  R'; X `publishCatalog(R,…)` REJECTED → recall reflects Y's catalog, never X's.
- Catalog-CAS retry policy: a stub provider that fails the first N-1 `publishCatalog`
  CAS attempts (bumping the revision each time) and succeeds on attempt N ≤
  `catalogCasMaxAttempts` → `load()` re-reads the catalog and FULLY REBUILDS each attempt
  (asserts `beginGeneration` is called afresh per attempt — NO reuse of a prior attempt's
  generation) and finally commits; a provider that fails MORE than `catalogCasMaxAttempts`
  → `load()` THROWS, and every generation built across all attempts is discarded (no
  orphans).
- Retired-generation retention (no read-under-delete): EXACT discipline — a reader pins
  generation N (captured reference / refcount lease), the catalog commit moves the
  collection to N+1, the reader's subsequent query against N still returns N's rows, and N
  is reclaimed only after the reader releases. Plain time-grace is asserted as BEST-EFFORT
  (a query exceeding `retiredGraceMs` is cancelled by its `CallOptions` timeout, reducing
  but not closing the window) — the hard guarantee is asserted only for the exact
  disciplines.
- Recall-only host: constructed from a `rag` handle ONLY (no `source`, no write `store`)
  over a pre-populated backend → `load()` opens no generation and performs no write, and
  `rag().query` returns the backend's active rows. Config validation rejects `sources` +
  `loadOnStartup:false`, rejects omitting both `sources` and a persistent `store`, and
  rejects a persistent store (ingest OR recall-only) with NO explicit `embeddingSpaceId`.
- Backend split + pinning: `makeCompatibleSkillsRag` consumes an `ISkillsRagBackend`
  (`activeSnapshot()` + `queryRevision(revision, vector, k)`) — a backend that exposes
  only "query active now" CANNOT be wrapped (pinning needs revision-explicit reads). The
  wrapper reads `activeSnapshot()` once and issues `queryRevision(snapshot.revision, …)`;
  a stub backend that flips its active pointer between the snapshot and the read still
  gets read at the SNAPSHOT's revision (no TOCTOU).
- Lazy dimension (no construction-time embed): a wrapper built WITHOUT a declared
  `dimension` performs NO embed at construction; the first `activeManifest(options)` /
  `query` runs ONE probe embed through `options` (asserted metered/cancellable) to
  complete the descriptor, then caches it. A wrapper built WITH `dimension` never probes.
  This is what lets the `makeCompatibleSkillsRag → makeSkillPluginHost → load()` order
  work: only `embeddingSpaceId` + schema are needed up front.
- Query order (no wasted embed): with a stub embedder that counts calls — `query`
  against a NULL snapshot and against an INCOMPATIBLE revision performs ZERO text-embeds
  (only the one-time dimension probe, if undeclared, may run); a COMPATIBLE revision
  embeds exactly once and calls `queryRevision`. Asserts the snapshot+check precede the
  embed.
- Ingest host serving path: a `{ source, storeProvider, embedder, embeddingSpaceId, … }`
  host after `load()` (self-ingest) exposes a WORKING `rag(group).query` per enabled
  group — the host wrapped each group's `storeProvider.forGroup(g)` (an
  `ISkillsRagBackend`) via `makeCompatibleSkillsRag`; the wrapped descriptor matches the
  manifest the catalog commit published (compatible by construction).
- Per-group provider isolation: `storeProvider.forGroup('a')` and `forGroup('b')` are
  independent collections — building/committing a new generation for `a` does NOT change
  `b`'s `activeSnapshot()`; `forGroup('a')` called twice addresses the SAME collection.
- Strategy structured result: `source.acquire()` returns `{ collections, records }`;
  `host.groups()` descriptions come from `collections` (NOT derivable from records); a
  record whose `group` is absent from `collections` → ingest error.
- Multi-source merge: two sources both contributing to collection `c1` → its generation
  holds the UNION of both sources' records, ownership `c1.sources = {s1, s2}`; the same
  `group` declared by two sources with DIFFERENT descriptions → ingest error.
- Sole-owner carry-forward: collection `c2` owned ONLY by source `s2`; on a load where
  `s2` is unreachable under `strict:false`, `c2` is re-added to `desired` from catalog
  ownership and carried forward — it is NOT tombstoned/dropped, and `host.rag('c2')`
  still serves the prior content.
- Collection-set reconciliation: load A emits `{c1, c2}`; later load B emits only `{c1}`
  (and c2 has no other owner) → after B, `readCatalog()`/`host.groups()` = `{c1}`, `c2`
  tombstoned at publish then `dropCollection`'d under grace, `host.rag('c2')` no longer
  serves. A desired collection that FAILS to build is NOT dropped (kept from prior). (The
  catalog-CAS rejection + no-leaked-activation cases are covered by the "Single fenced
  commit" / "Catalog commit fence" tests above.)
- Publish-before-drop: a stub provider that throws inside `dropCollection` AFTER a
  successful `publishCatalog` → the active catalog already excludes the tombstoned
  collection (not served), and a re-run finishes the physical reclaim (idempotent). No
  state where the active catalog references an already-deleted collection.
- Recall-only catalog + validation: a recall-only host reads `readCatalog()` for
  `groups()` descriptions; `serveCollections` naming a collection ABSENT from the catalog
  → config error; omitted `serveCollections` → serves all cataloged collections.
- Adapter full IRag: `query` returns `ok(RagResult[])` on success and `err(RagError)` on a
  backend fault (incompatible/empty rotation → `ok([])`); `healthCheck()` → `ok` when the
  group's `activeManifest` resolves+compatible, else `err`; `getById` → `ok(null)` when the
  backend has no by-id read; `writer()` → `undefined`.
- Embedder/store compatibility — startup: a recall-only `load(options)` over a backend
  whose `activeSnapshot()` reports a different `embeddingSpaceId`/`dimension`/
  `retrievalSchemaVersion` than the serving descriptor ABORTS with a clear error;
  matching → serves; null snapshot → empty recall (no block). A self-ingesting catalog
  commit publishes the manifest from its own descriptor (round-trips through
  `activeSnapshot()`/`readCatalog()`).
- Embedder/store compatibility — RUNTIME ROTATION: a running recall-only `rag()` serves
  hits against compatible generation N; an out-of-band catalog commit moves the collection
  to an INCOMPATIBLE N+1; the next `query` re-checks, returns EMPTY (no crash) and signals the
  error; the per-revision verdict is cached (a second query at N+1 does not re-run the
  check); a later compatible N+2 resumes serving.
- Source typing: a `records` source ingests without `enabled`; a fetched source with
  missing/empty `enabled` is a config error; reconciliation keys on the config `id`
  (`sourceId`), so a registry/version change does not orphan carry-forward.
- sourceId validation/stamping: two sources sharing an `id` → **config error** at
  startup; a `records` source's records all come out with `sourceId === ` the
  configured `id` (host-stamped), regardless of any `sourceId` the caller put on them.
- Generation cleanup (keyed on committed catalog): (a) an ingest error mid-build, a
  `strict:true` abort, AND a lost catalog CAS each leave NO records of this load's built
  generations (nothing committed → all discarded); (b) on a SUCCESSFUL commit where
  collection B fell back to its prior pointer (its whole new generation could not be
  built), B's built-partial generation is ALSO discarded — assert the store keeps ONLY the
  generations the committed catalog names.
- First-load build failure with NO prior: a two-collection load where `c2` fails to build
  and has NO prior generation (first load) → `c2` is OMITTED from the committed catalog
  (`host.groups()` = `{c1}`, `host.rag('c2')` serves nothing), `c1` STILL commits and
  serves, and `c2`'s built-partial generation (if any) is discarded. `c2` is NOT
  tombstoned (nothing existed to retire).
- `load()` result type: a partial-failure load resolves a `SkillLoadResult` with
  `committed=['c1']`, `omitted=[{group:'c2',…}]`, `ok===false`; a clean load → `ok===true`,
  `omitted=[]`; a `strict:true` source failure / exhausted CAS / config error THROWS (the
  call rejects) having committed nothing.
- Serving-host reload semantics (BOTH equalities): a SERVING host registered `{c1}`.
  (i) Same-set reload — desired `{c1}` AND active catalog `{c1}` → succeeds, rotates `c1`.
  (ii) LOCAL change — its sources now resolve `{c1, c2}` (desired ≠ registered) → THROWS.
  (iii) OUT-OF-BAND change — an external ingest made the active catalog `{c1, c2}` while
  the host's desired is still `{c1}` (active ≠ registered) → THROWS, and critically `c2` is
  NOT tombstoned (the external change is not rolled back). In every throwing case, assert a
  spy on `beginGeneration`/`publishCatalog` is NEVER called and the persistent catalog is
  UNCHANGED. The check re-runs on each CAS retry. An ingest-only host (no registered set)
  may reload with a changed set freely.
- Recall hook: returns scored hits; below-`threshold` hits dropped; **threshold
  defaults to `0.3` when omitted** (a hit at `0.25` is dropped under the default);
  injects hit `content` within budget; empty/no-match → no block (output identical to
  agnostic).
- HTTP fetcher: builds records purely from fetched bytes (mock transport), zero FS.
- Strategy-driven placement + collection isolation: a stub strategy that places fetched
  records into collections `c1` and `c2` → `host.groups()` reports exactly `{c1, c2}`
  (whatever the strategy emitted — the host derives nothing); `host.rag('c1')` returns
  ONLY c1 records, never c2 (conflict isolation). A different stub strategy that places
  everything into ONE collection → `host.groups()` reports one. The host applies NO
  "one plugin = one group" rule. `serveCollections`/`controllerSkillGroup` naming a
  collection the strategy did not emit → config error. Each collection has independent
  generations (committing one does not touch another's served generation).
- Carry-forward publishes a NEW generation: collection B has sources `{s1, s2}`; on a load
  where `s1` refreshed and `s2` was unreachable (`strict:false`), B's NEW generation =
  refreshed `s1` records + carried-forward `s2` records, and `publishCatalog` names THAT
  new generation (NOT B's prior pointer). The prior-pointer fallback is exercised
  separately by a collection whose WHOLE generation could not be built.
- Mixed generations in one commit: a load where collection A built a fully-new generation
  and collection C could not build at all (prior-pointer fallback) → the SINGLE
  `publishCatalog` names A's new generation AND C's prior generation together; both serve
  after the one commit (mixed generations across collections, atomic commit).
- Adapter (assembler bridge): `skillsRagSource(host.rag('g'))` implements
  `IRag.query(embedding, k, options)` by calling `host.rag('g').query(embedding.text, …)`
  (asserts it uses `.text`, NOT `.toVector()` — skills embed in their own space) and maps
  each `SkillHit` → `RagResult { text: content, score, metadata: { id, group, name,
  provenance } }`; `getById`/`writer` unsupported; metering flows via `options`.
- Implicit recall — assembler pipelines (flat/default, linear): the adapter registered as
  a context-assembler `IRag` source → the run injects a matching skill chunk through the
  SHARED-budget uniform formatting with NO pipeline-specific code; toggling OFF reproduces
  the exact agnostic output (measurement toggle).
- Implicit recall — controller (self-assembling, in scope): a controller whose planner is
  given `host.rag(configuredGroup)` injects a bounded "Relevant skills" block (own
  `maxInjectChars`) into create-plan; with skills OFF the create-plan prompt is
  byte-identical to agnostic (the controller measurement toggle). dag/stepper are NOT
  covered here (same self-assembling pattern, wired as needed — explicitly out of this
  phase).
- `mode: explicit` config → REJECTED with a clear "not yet implemented" error (parser
  test); `mode: implicit` (or omitted) accepted.
- `host.groups()`: lists enabled groups with descriptions + collection names;
  `host.rag(group)` for an unknown group errors; `host.rag()` with one group returns it,
  with several enabled errors (must name the group).
- `host.groups()` is SYNC + fixed-at-load: after `load()` it returns the snapshot WITHOUT
  awaiting; the SERVING COLLECTION SET is immutable — a stub provider that adds collection
  `c3` out-of-band does NOT make `groups()` include `c3` nor does any registered adapter
  serve it (a SET change needs restart), while generation ROTATION within an existing
  collection IS picked up: `rag('c1').query` after an out-of-band catalog bump for `c1`
  serves the new generation. A tombstoned-out-of-band collection's `rag(g)` returns empty
  (its `activeSnapshot()` finds no active entry), never an error.

## Licensing posture (settled)

MIT, content-agnostic host; the adapter transforms whatever the consumer enables.
Gnostic skills (e.g. GPL-3.0 sap-skills) are enabled by the consumer and loaded into
the consumer's RAG at runtime — never bundled, copied, or redistributed by us. Same
position as Claude Code hosting user-installed GPL plugins. Internal evaluation
fetches the reference set only for local testing and commits nothing.

## Phasing & out of scope

**In scope (this spec):** the plugin skill-host (acquire → grouped materialise),
grouping, the in-memory + vector-DB stores, the compat wrapper + per-group providers,
the host (ingest + recall-only), the sources (records + HTTP fetcher), config +
validation, and **implicit recall** for (a) assembler pipelines via the `IRag` adapter
(flat/default, linear) and (b) the **controller** via its planner-context recall — plus
the toggle-based WITH/WITHOUT measurement on the controller.

**Later phase / out of this spec (same host, no contract change):**
- **Dynamic collection-SET rotation while serving** — re-registering/unregistering
  assembler RAG sources when an out-of-band ingest adds/removes a collection. This phase
  fixes the serving collection set at `load()` (generation rotation WITHIN a collection IS
  dynamic; a set change needs a rebuild/restart). Live re-registration is deferred.
- **dag / stepper implicit recall** — same self-assembling pattern as the controller
  (attach `host.rag(group)` to their own context assembly); wired when needed, not here.
- **Explicit planner-driven group selection** — handing `host.groups()` to the planner
  and recalling the CHOSEN group per step (and per-step executor skill injection). The
  only mode needing a genuine planner hook; a larger integration, separate spec/plan.

**Out of scope (separate specs):**
- **Controller planner control-flow redesign** (reviewer-routed `next/need-info/
  error`, replan from an annotated plan, terminal "infeasible" answer, RAG-freshness
  / write-invalidates-related-reads) — a distinct subsystem.
- **`requires`-manifest hardening** as a planner prompt-invariant — likely informed
  by the measurement; not bundled here.
- **LLM-distillation** of skills at ingest (current ingest is a deterministic
  transform).
- **Plugin commands/agents/hooks** (only `SKILL.md` skills are ingested).
- **Incremental planner per-step parse fragility** (engine concern, not knowledge).
