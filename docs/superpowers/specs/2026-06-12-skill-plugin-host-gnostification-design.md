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

1. **The plugin skill-host (acquire → materialise).** It knows nothing about any
   pipeline. Its ENTIRE job is to take enabled skills FROM a source (Claude-plugin
   marketplace / git / FS dir / programmatic records) and put them INTO a skills-RAG
   **correctly** — i.e. **grouped**, not as one undifferentiated pile. Where it puts
   them is mostly RAG (other sinks — e.g. a Claude-Code-style FS folder — are
   hypothetical for now). The pipeline never sees the source, the plugin format, or the
   backend.

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

**Why grouping is mandatory, not cosmetic.** Real skill sets are grouped by domain
(the reference repo `secondsky/sap-skills` ships separate plugins for ABAP, CDS, BTP,
HANA, …). You **cannot** dump all groups into one context: different groups give
conflicting procedural guidance. So skills are ALWAYS stored grouped (group = a
collection in the skills-RAG); **implicit recall** avoids conflict by the operator
enabling only compatible groups (or configuring one group for a self-assembling
pipeline), and **explicit selection** avoids it by the planner choosing one group per
step.

## Terminology (canonical — reused verbatim in user docs)

These are the words this spec, the code, and the public documentation MUST use
consistently. Where a term mirrors Anthropic's plugin model, that is called out.

| Term | Definition |
|---|---|
| **Marketplace / registry** | A source that LISTS available plugins (a set of repos/folders offering skills). Anthropic: the marketplace you browse. In config it is a fetched `source` (`registry: <url>`). It is NOT a single skill — it is the catalogue. |
| **Plugin** | The unit you ENABLE: one folder of skills (e.g. `sap-abap`, `sap-btp-best-practices`). Anthropic: a plugin you install from a marketplace. The `enabled` list names **plugins**. |
| **Skill** | One `SKILL.md` (frontmatter + body) inside a plugin — a single procedural "how-to". A plugin contains one or more skills. |
| **Chunk** | A retrieval-sized slice of a skill (split by H2 / size). The unit actually embedded and injected — a hit is ONE chunk, not a whole skill. |
| **Group** | The **conflict-isolation unit = one collection** in the skills-RAG. **Default: one group per enabled plugin** (group id = plugin id); a deployment MAY declare a **named group** bundling several plugins. Recall via `host.rag(group)` only ever sees that group's records. |
| **Collection** | The physical namespace in the skills-RAG that backs one group. Group ↔ collection is 1:1. |
| **Source** | A pluggable acquisition strategy feeding the host: a **fetched** source (marketplace/registry/git/FS dir — needs `enabled`) or a **`records`** source (programmatic, in-memory, pre-filtered — no `enabled`). Identified by a stable `sourceId`. |
| **Skills-RAG** | The dedicated RAG holding skill chunks, separate from the controller's run-scoped results-RAG. Organised into per-group collections. |
| **Skill plugin-host** (`ISkillPluginHost`) | The component that does acquire → parse → grouped materialise (`load()`) and exposes recall (`groups()`, `rag(group)`). The "part 1" of the system. |
| **Ingest** | Building/refreshing a generation: acquire enabled plugins → chunk → embed → write into the group collections → fenced `activate`. Done at startup (self-ingest) or out-of-band by a separate job. |
| **Generation** | An atomic SNAPSHOT of a collection's full desired record set, written under a generation namespace so a new build never overwrites the serving one until `activate`. |
| **Revision** | The fence token / monotonic id of a collection's ACTIVE generation. `activate` is a compare-and-set on it; recall pins one revision per query. |
| **Manifest** (`SkillsManifest`) | The embedding-compatibility descriptor stamped onto a generation at `activate`: `{ embeddingSpaceId, dimension, retrievalSchemaVersion }`. |
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
8. **Skills are stored GROUPED (group = collection).** Never one undifferentiated pile:
   conflicting domain groups must be selectable/excludable. Each enabled group
   materialises into its own collection; `host.rag(group)` scopes recall to a group.
   The default group is one-per-plugin; a deployment MAY declare named groups bundling
   several plugins.
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
/** What an active generation carries, published atomically by activate(). Identical
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
 *  collide), NOT by threading `group` through every lifecycle call:
 *
 *    interface ISkillsStoreProvider     { forGroup(group: string): ISkillsStore; }
 *    interface ISkillsRagBackendProvider { forGroup(group: string): ISkillsRagBackend; }
 *
 *  `forGroup(g)` always returns a handle over the SAME physical collection for `g`
 *  (idempotent). The ingest-capable host is constructed with an `ISkillsStoreProvider`
 *  and iterates `host.groups()` calling `provider.forGroup(g)` to build each group; a
 *  recall-only host takes an `ISkillsRagBackendProvider`. `host.rag(group)` wraps
 *  `provider.forGroup(group)`. */

/** LOW-LEVEL store read API (collection-scoped) — the pinning primitive the compat
 *  wrapper composes over. It does NO compatibility logic and does NOT embed: it exposes
 *  the atomic active pointer and a vector read of a SPECIFIC revision, so a caller can
 *  pin one revision across check+read. (The raw store implements this; the serving
 *  embedder lives in the wrapper above, not here.) */
interface ISkillsRagBackend {
  /** Atomic snapshot of the active pointer (null if none active yet) — manifest + its
   *  revision in ONE read, so a check keyed off it cannot straddle a rotation. */
  activeSnapshot(): Promise<ActiveSnapshot | null>;
  /** Vector read pinned to an EXPLICIT revision (the one a prior `activeSnapshot`
   *  returned) — NOT "whatever is active now". This is what makes no-TOCTOU pinning
   *  compositional: the wrapper resolves the snapshot once, then reads THAT revision. */
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
  /** Open a new generation namespace AND return the active revision observed now —
   *  the FENCE token for activate(). */
  beginGeneration(): Promise<{ generation: string; baseRevision: string }>;
  upsert(
    generation: string,
    records: readonly SkillRecord[],
    options?: CallOptions,
  ): Promise<void>;
  /** Copy the ACTIVE generation's records for the given stable `sourceId`s into
   *  `generation` unchanged — carry-forward for sources that failed to refresh under
   *  strict:false (so their skills are not lost). Keyed by the config-stable
   *  `sourceId` (NOT the versioned provenance), so a failed fetch with unknown
   *  version still finds them. No-op when there is no active generation. */
  carryForward(generation: string, sourceIds: readonly string[]): Promise<void>;
  /** FENCED activate: flip the active pointer to `generation` ONLY IF the current
   *  active revision still equals `expectedRevision` (the baseRevision from
   *  beginGeneration). A concurrent load that activated in between bumps the
   *  revision, so a stale activation is REJECTED (the late loader rebuilds from the
   *  new base) — no late writer can roll the active pointer back to an older
   *  snapshot. On success the prior generation is RETIRED, not hard-deleted: it is
   *  reclaimed after a bounded retention grace period (≫ a recall round-trip) so an
   *  in-flight reader that already resolved it can finish its query — see
   *  "Retention of the retired generation". `manifest` records the
   *  embeddingSpaceId/dimension/schema this generation was built with and is published
   *  atomically with the pointer flip, so `activeSnapshot()` always reflects the
   *  serving generation. */
  activate(
    generation: string,
    expectedRevision: string,
    manifest: SkillsManifest,
  ): Promise<void>;
  /** Delete a NON-activated generation's records. `load()` MUST call this in a
   *  `finally` for every generation that does not reach a successful activate
   *  (ingest error, strict abort, fenced-out activation) so orphan embeddings never
   *  accumulate in a persistent store. Idempotent (a no-op for an already-dropped or
   *  the now-active generation). */
  discardGeneration(generation: string): Promise<void>;
}

interface ISkillPluginHost {
  /** Build a FRESH generation PER GROUP: acquire → parse → upsert the reachable sources;
   *  unreachable sources are carried forward (strict:false) or abort THAT GROUP's
   *  generation (strict:true) — see "Reconciliation". Then fenced `activate` per group.
   *  ANY group exit WITHOUT a successful activate (error, strict abort, fenced-out CAS)
   *  `discardGeneration`s that group's half-built generation in a `finally` — no orphan
   *  embeddings leak. Atomicity is PER GROUP: already-activated groups are not rolled
   *  back if a later group fails; mixed revisions across groups are allowed. Idempotent;
   *  callable at startup OR out-of-band.
   *
   *  Ingest iterates the ENABLED GROUPS and builds each group's collection independently
   *  (via `storeProvider.forGroup(g)`), each with its own fenced activate + discard.
   *
   *  RECALL-ONLY hosts (constructed with a `backendProvider` and NO `source` — see below)
   *  have nothing to build: `load(options)` opens no generation and writes nothing, but
   *  it is NOT empty — for EACH served group it calls `rag(g).activeManifest(options)`,
   *  which (a) resolves that wrapper's serving `dimension` if undeclared, by ONE probe
   *  embed run through `options` (metered/cancellable — never an unmetered embed at
   *  construction), and (b) compares the serving descriptor to that group's active
   *  generation for an EAGER fail-fast. The same atomic check then runs per-revision
   *  inside `rag(g).query`. Each group's collection is materialised out-of-band by a
   *  SEPARATE ingest job. `options` threads metering into the probe and ingest. */
  load(options?: CallOptions): Promise<void>;
  /** Enabled GROUPS with their descriptions — what the explicit mode's planner picks
   *  from, and what the implicit wiring enumerates to register RAG sources. A group is
   *  one collection in the skills-RAG (default: one group per plugin; or a deployment-
   *  declared named group bundling several plugins). */
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
  group: string;        // stable group id (= plugin id by default, or a declared name)
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
  serveGroups,       // the group ids this instance exposes
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
`{ backendProvider, embedder, serveGroups, … }` (recall-only); a serving process gets
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
// skillsRagSource(host.rag(group), { k, threshold }) : IRag
//   query(embedding, k, options):
//     hits = host.rag(group).query(embedding.text, { k, threshold }, options) // re-embed
//       — uses IQueryEmbedding.text, NOT .toVector(): skills live in their OWN embedding
//         space (their own embeddingSpaceId), so the assembler's query vector is wrong here.
//     return hits.map(h => ({ text: h.record.content, score: h.score,
//                             metadata: { id: h.record.id, group, name: h.record.name,
//                                         provenance: h.record.provenance } }))
//   getById / writer: not supported (read-only source).
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
  group: string         // GROUP id = the skills-RAG collection this record lands in (one
                        //   per plugin by default, or a declared named group). Conflict-isolation
                        //   unit: recall via host.rag(group) only ever sees one group's records.
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
  acquire (fetcher)  →  parse (adapter)  →  ingest (upsert)  →  recall (runtime)
  ───────────────────   ───────────────    ───────────────     ───────────────
  HTTP→memory | prog.    in-memory bytes     SkillRecord[] →     semantic query
  | FS (optional)        → SkillRecord[]      skills-RAG          → inject body
```

**1. Fetcher (acquisition) — pluggable, FS-free by contract.**
- **HTTP→memory** (primary for self-ingesting instances): fetch the
  marketplace/registry + each `SKILL.md` over HTTP **into memory** (e.g. GitHub
  API/raw, or any registry URL). No clone, no disk.
- **Programmatic**: the embed-as-library caller hands `SkillRecord[]` (or raw
  content) in memory.
- **FS directory**: optional convenience ONLY where a filesystem happens to exist;
  never required. (This is the only path that may reuse `loadSkillFromDir`.)

**2. Adapter (parse) — pure, in-memory, FS-free.** A content-agnostic transform:
given the in-memory marketplace manifest + `SKILL.md` strings of the **enabled**
plugins, produce canonical `SkillRecord[]`. Reuses the **frontmatter parser** (pure
string parsing — NOT `loadSkillFromDir`). Ignores plugin commands/agents/hooks
(skills only). **Chunks** large bodies by top-level Markdown sections (over-long
sections split on paragraphs, bounded to `chunk.maxChars`) so recall returns the
relevant fragment, not a 15 KB dump. For each chunk it computes the **stable `id`**
(`<source>:<plugin>@<version>/<skill>#<chunkIx>`, deterministic → same input yields
the same id across generations) and the **distinct `retrievalText`** (description +
heading + chunk content). "Anthropic/Claude-plugin marketplace" is the first adapter;
another source format = another adapter, canonical schema unchanged.

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

**Atomicity is PER GROUP, not whole-load.** Each group is an independent collection with
its OWN generations and revisions; `beginGeneration`/`upsert`/`carryForward`/`activate`/
`discardGeneration` all act on ONE collection (via `storeProvider.forGroup(g)`). `load()`
reconciles each enabled group's collection **independently** — there is NO global
all-groups-or-nothing transaction, and **mixed revisions across groups are allowed and
expected** (group A may activate while group B's CAS fails or its source is unreachable).
This is sound because recall is always scoped to ONE group (`host.rag(group)`), so a
cross-group atomic pointer would buy nothing. `load()` returns success only if EVERY
enabled group activated; a per-group failure is surfaced per group (and, under
`strict:true`, fails `load()`), but it can NOT roll back groups that already activated —
those keep their fresh generation, the failed group keeps its prior one. (If a future
need demands all-or-nothing across groups, add a single global manifest pointer that
flips once after every group's generation is built — explicitly NOT in this design.)

A naive "idempotent upsert" leaks stale records: when a skill is updated, the
chunking changes, or a plugin is **removed** from `enabled`, the old chunk records
survive and keep matching recall. `load()` therefore reconciles the store to EXACTLY
the desired set via an atomic **generation snapshot**. Records are written under a
**generation namespace** — physical key `${generation}:${record.id}` — so a new
generation NEVER overwrites the active one (the active generation keeps serving until
`activate`):

1. `beginGeneration()` → a fresh namespace **and** `baseRevision` (the active revision
   observed now — the fence token).
2. For each ENABLED source: if it fetched/parsed OK, `upsert(generation, itsRecords)`;
   if it FAILED, apply the failure policy (below) — `carryForward(generation,
   [its sourceId])` or abort. (carry-forward is keyed by the stable `sourceId`, so a
   failed fetch whose version is unknown still finds the prior records.)
3. `upsert(generation, records)` writes the full desired set into the new namespace
   (embedding each `retrievalText`).
4. `activate(generation, baseRevision)` — **FENCED atomic flip**: succeeds only if the
   active revision is still `baseRevision`; queries opened AFTER the flip read the new
   namespace. The prior generation is **NOT hard-deleted at flip time** — it is retired
   under a **retention grace period** (see below) so an in-flight recall that already
   resolved the old active generation can finish its vector query without its rows
   vanishing mid-read. A **partially-failed build that never reaches activate** leaves
   the prior snapshot fully intact.

The whole build runs inside `try { … activate } finally { if (!activated)
discardGeneration(generation) }` — so an ingest error, a `strict` abort, OR a
fenced-out activation **deletes the half-built generation's embeddings**, never
leaking orphan vectors into a persistent store.

**Concurrent loads (out-of-band / multi-instance) — fenced activation.** Two `load()`s
can each `beginGeneration()` (A and B) concurrently. The fence prevents a late writer
from rolling the active pointer back: each `activate` is a compare-and-set against the
`baseRevision` it opened with. If B activates first (bumping the active revision), A's
later `activate(genA, baseRevisionA)` **fails the CAS** and is rejected — A discards
genA (or retries `load()` from the new base) rather than reverting recall to the older
snapshot. For in-memory single-process the revision is a monotonic counter; for a
vector-DB it is an etag / fencing token on the active-pointer row (or a lease around
the whole load). No global lock is required — only the activate CAS.

**Source-failure policy (resolves `strict` vs snapshot atomicity) — applied PER GROUP.**
A group's generation is all-or-nothing for THAT group: its collection must contain every
record of every source feeding the group before activate, or that group's generation is
discarded. So, per group:
- **`strict: false` (default) — per-source carry-forward.** An unreachable/failed
  source does NOT drop its skills: `carryForward(generation, [its sourceId])` copies
  that source's records from the group's active generation into the new one unchanged;
  only the reachable sources are refreshed. The new generation is complete → activate is
  safe, last-known-good is retained. (On the very first load with no active
  generation, a failed source simply contributes nothing — it was never loaded.)
- **`strict: true` — all-or-nothing PER GROUP.** A source failure aborts THAT GROUP's
  generation: no `activate` for it, that group's prior generation fully retained, the
  error surfaces. Other groups are unaffected (independent collections). `load()` as a
  whole then reports failure, but already-activated groups are NOT rolled back — see the
  per-group atomicity note above.

**Retention of the retired generation (no read-under-delete).** A recall is two steps:
resolve the active generation, then run the vector query against it. If `activate`
hard-deleted the prior generation between those two steps, an in-flight reader that
resolved the old generation would query rows that no longer exist (empty/garbage
recall). Two retention disciplines, by backend capability — a strict one that
GUARANTEES reader completion, and a best-effort one that does not:
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
`discardGeneration` of a NON-activated build (immediate — no reader ever saw it).

For the **in-memory** store the namespace is a fresh map swapped on activate. For a
**vector-DB** it is a generation label filtered on query and a cheap pointer flip on
activate, with the grace-delayed sweep above (or a collection-alias swap where
supported). The **ephemeral in-memory-per-run** strategy has no prior generation to
carry forward (each startup builds from scratch) but uses the same build→activate swap
within a run for atomicity.

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
| `ISkillSource` strategy + fetchers (HTTP/programmatic/FS) | `llm-agent-libs/src/skills` | **new** (HTTP/programmatic) |
| `PluginMarketplaceAdapter` (in-memory → canonical + chunker) | same | **new** |
| `ISkillsStore`/`ISkillsRagBackend` impls (in-memory; vector-DB) + per-group PROVIDERS | `llm-agent-libs` (+ a vector-DB adapter) | **new** (cosine + score + per-collection generations; not `IKnowledgeRagHandle`) |
| `makeCompatibleSkillsRag` (compat wrapper → `ISkillsRagHandle`) | `llm-agent-libs` | **new** |
| Ingest wiring (startup AND out-of-band entrypoint) | SmartServer build / a CLI/admin entry | **new** (parallels MCP→toolsRag) |
| Grouping (plugin→group→collection map, named groups) | host config | **new** |
| **Skills adapter** — `skillsRagSource(host.rag(group))` : `IRag` (SkillHit→RagResult; re-embeds `IQueryEmbedding.text` in skills' space) | `llm-agent-libs` | **new** (the seamless bridge) |
| **Implicit wiring — assembler** — register the adapter as an `IRag` source in the context-assembler | SmartServer build / SmartAgent retrieval composition | **new** (flat/default + linear) |
| **Implicit wiring — controller** — planner recalls a configured group, injects a bounded block into its own context | controller planner | **new** (measurement target, in scope) |
| Implicit wiring — dag / stepper (same self-assembling pattern) | dag / stepper handlers | deferred |
| **Explicit hook** — planner picks `host.groups()` group per step | controller planner | **new**, deferred |
| Config parse (`skills` block) + `builder.withSkills(...)` | server config + builder | **new** |

**Only the ASSEMBLER pipelines get implicit recall for free.** The context-assembler
consumes `IRag` sources; the adapter registers each enabled group there, so the
**assembler-based pipelines — flat/default and linear** — are gnostified with no consumer
code. The **controller, dag, and stepper do NOT use the assembler** (they read
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
folder of skills, e.g. `sap-abap`, `sap-btp-best-practices`); a **plugin** contains one
or more **skills** (`SKILL.md`). The **`enabled` list names PLUGINS.** A **group** =
the conflict-isolation/collection unit; **by default one group per enabled plugin**, or
a deployment-declared named group bundling several plugins.

**YAML (server):**
```yaml
skills:
  mode: implicit                     # implicit = ONLY accepted value this phase; `explicit`
                                     #   (planner picks group) is REJECTED until its phase ships
  store: { type: qdrant, url: ... }  # optional: a persistent networked store
                                     #   (omit → in-memory, self-ingest at startup)
  embeddingSpaceId: sap-skills-emb-2026-06   # MANDATORY for a PERSISTENT store (here Qdrant):
                                             #   stamped onto every generation at activate, so a
                                             #   later recall-only instance can verify it. Bump
                                             #   when the embedding space changes. (Omittable ONLY
                                             #   for the in-memory self-ingest case — one process,
                                             #   no cross-process reader to mismatch.)
  k: 4                               # max records recalled per query
  threshold: 0.3                     # min cosine similarity [0..1]; below → dropped. Default 0.3
  maxInjectChars: 4000               # SELF-ASSEMBLING pipelines (controller) ONLY — the dedicated
                                     #   "Relevant skills" block's char budget. IGNORED by the
                                     #   assembler path (it applies its OWN shared budget).
  controllerSkillGroup: sap-abap     # which single group the controller planner recalls (implicit)
  chunk: { maxChars: 1500 }
  strict: false                      # true → any source failure aborts load; false → carry-forward
  sources:
    - id: sap                                 # STABLE sourceId — reconciliation/carry-forward key
      registry: https://<host>/<skills>       # FETCHED source (marketplace/registry → memory)
      enabled: [sap-abap, sap-abap-cds]       # PLUGINS to enable; REQUIRED non-empty for fetched
                                              #   sources; "*" = every plugin the registry offers
  # groups: OPTIONAL. Omitted → one group per enabled plugin (collection = plugin id).
  # Declare named groups to bundle plugins into one conflict-isolation collection:
  groups:
    - name: abap                              # group id == collection
      plugins: [sap-abap, sap-abap-cds]       # bundled plugins (must be enabled above)
    # an enabled plugin not listed in any group → its own one-plugin group (default)
```

- **`mode`** — `implicit` (default, the ONLY value this phase accepts): enabled groups
  are attached to the RAG path each pipeline already reads (assembler adapter for
  flat/default+linear; the planner-context recall for the controller). Operator enables
  only **compatible** groups (no cross-group conflict in one context). `explicit`
  (planner-driven per-step selection) is **deferred — the parser REJECTS `mode: explicit`
  with a clear "not yet implemented" error** so a config is never accepted without a
  working consumption path.
- **`groups`** — optional grouping of enabled plugins into named collections. A plugin
  enabled but unlisted forms its own default group. A group named in `groups` whose
  `plugins` are not all `enabled` → config error.

A **recall-only serving** instance — the canonical no-FS deployment, where a
persistent store was materialised out-of-band by a separate ingest job — omits
`sources` entirely and declares a persistent `store` plus the serving `embedder`:
```yaml
skills:
  mode: implicit
  store: { type: qdrant, url: ... }  # REQUIRED here — recall reads what ingest wrote
  embedder: { provider: openai, model: text-embedding-3-small }  # MUST match ingest's
  embeddingSpaceId: sap-skills-emb-2026-06   # MANDATORY (persistent): stable vector-space id,
                                             #   bump when the space changes; NOT alias-derived
  dimension: 1536                            # optional: declare to skip the probe embed
  loadOnStartup: false               # recall-only: no source access, no ingest, load() is a no-op
  serveGroups: [sap-abap, sap-abap-cds]  # group ids (= collection names) this instance serves; the
                                         #   ingest job wrote them. (Distinct from ingest's `groups`,
                                         #   which DEFINES plugin→group bundles; recall-only only NAMES
                                         #   existing collections to expose via host.groups()/rag(group).)
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
- A declared **group** whose `plugins` are not all in some source's `enabled` list →
  config error (a group can only bundle enabled plugins). `mode: implicit` with
  mutually-conflicting groups enabled is the operator's responsibility (the engine
  cannot detect semantic conflict) — documented, not validated.
- A rejected (fenced-out) `activate` from a concurrent/stale load, an ingest error, or
  a `strict` abort → the half-built generation is `discardGeneration`d in a `finally`
  (no orphan embeddings linger in a persistent store); recall is never reverted.
- Source unreachable at ingest → `strict:false` **carries the failed source forward**
  from the group's active generation (warn; its skills are NOT lost) and refreshes only
  the reachable sources; `strict:true` **aborts THAT GROUP's generation** (no activate,
  the group's prior generation fully retained; other groups unaffected). A group's
  collection is never partially updated. `load()` reports failure if any enabled group
  failed, but already-activated groups are not rolled back (per-group atomicity).
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
  semantically-meaningless recall). At RUNTIME, an out-of-band
  ingest can activate a new, incompatible generation while the server runs: `query`
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
- Reconciliation (generation snapshot): updating a skill / changing chunking /
  removing a plugin from `enabled` leaves NO stale record recall-able after
  `activate`; namespace isolation — upserting a NEW generation does NOT change what
  recall returns until `activate` (the active generation's rows are untouched).
- Source-failure policy: `strict:false` with one source unreachable **carries that
  source's prior records forward by `sourceId`** (its skills still recall after
  `activate`, even though its version is unknown) while a reachable source refreshes;
  `strict:true` with any source unreachable does NOT activate.
- Fenced activation (concurrency): two loads open generations A and B against the same
  `baseRevision`; B activates first; A's `activate(genA, baseRevisionA)` is REJECTED by
  the CAS → recall keeps B's snapshot, never reverts to A's older one.
- Retired-generation retention (no read-under-delete): EXACT discipline — a reader pins
  generation N (captured reference / refcount lease), `activate` flips to N+1, the
  reader's subsequent query against N still returns N's rows, and N is reclaimed only
  after the reader releases. Plain time-grace is asserted as BEST-EFFORT (a query whose
  duration would exceed `retiredGraceMs` is cancelled by its `CallOptions` timeout,
  reducing but not closing the window) — the hard guarantee is asserted only for the
  exact disciplines.
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
  `ISkillsRagBackend`) via `makeCompatibleSkillsRag`; the wrapped descriptor matches what
  `activate` stamped (compatible by construction).
- Per-group provider isolation: `storeProvider.forGroup('a')` and `forGroup('b')` are
  independent collections — a `beginGeneration`/`activate` on `a` does NOT change `b`'s
  `activeSnapshot()`; `forGroup('a')` called twice addresses the SAME collection.
- Embedder/store compatibility — startup: a recall-only `load(options)` over a backend
  whose `activeSnapshot()` reports a different `embeddingSpaceId`/`dimension`/
  `retrievalSchemaVersion` than the serving descriptor ABORTS with a clear error;
  matching → serves; null snapshot → empty recall (no block). A self-ingesting
  `activate` stamps the manifest from its own descriptor (round-trips through
  `activeSnapshot()`).
- Embedder/store compatibility — RUNTIME ROTATION: a running recall-only `rag()` serves
  hits against compatible generation N; an out-of-band `activate` flips to an
  INCOMPATIBLE N+1; the next `query` re-checks, returns EMPTY (no crash) and signals the
  error; the per-revision verdict is cached (a second query at N+1 does not re-run the
  check); a later compatible N+2 resumes serving.
- Source typing: a `records` source ingests without `enabled`; a fetched source with
  missing/empty `enabled` is a config error; reconciliation keys on the config `id`
  (`sourceId`), so a registry/version change does not orphan carry-forward.
- sourceId validation/stamping: two sources sharing an `id` → **config error** at
  startup; a `records` source's records all come out with `sourceId === ` the
  configured `id` (host-stamped), regardless of any `sourceId` the caller put on them.
- Generation cleanup: an ingest error mid-build, a `strict:true` abort, AND a
  fenced-out `activate` each leave NO records of the failed generation in the store —
  `discardGeneration` ran (assert store has only the prior active generation's rows).
- Recall hook: returns scored hits; below-`threshold` hits dropped; **threshold
  defaults to `0.3` when omitted** (a hit at `0.25` is dropped under the default);
  injects hit `content` within budget; empty/no-match → no block (output identical to
  agnostic).
- HTTP fetcher: builds records purely from fetched bytes (mock transport), zero FS.
- Grouping + collection isolation: enabled plugins `sap-abap`, `sap-btp` with NO declared
  groups → two default groups (one collection each); `host.rag('sap-abap')` returns ONLY
  abap records, never btp (conflict isolation). A declared named group `abap`:[sap-abap,
  sap-abap-cds] → one collection holding both plugins' records; a group naming a
  non-enabled plugin → config error. Each group's collection has independent
  generations (rotating one group does not touch another's active pointer).
- Per-group atomicity: in a two-group load where group A activates and group B's
  `activate` fails the CAS (or B's source is unreachable under `strict:true`), A KEEPS
  its fresh generation (NOT rolled back) and B keeps its prior one — mixed revisions
  across groups; `load()` reports failure but A's recall already serves the new content.
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
