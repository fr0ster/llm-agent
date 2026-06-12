# Skill Plugin-Host & Runtime Gnostification — Design

**Status:** draft (brainstormed 2026-06-12)
**Branch:** `feat/skill-plugin-host` (off `design/controller-execution-result-control` / PR #183).
**Relation to PR #183:** depends on the controller PR #183 delivers (it adds a skills
recall hook to the planner), but is a SEPARATE, cross-cutting feature — not part of
#183's scope. Built as a linear stack on top of #183 to avoid merge conflicts.

## Goal

Let a deployment **gnostify** the agnostic engine by feeding it consumer-supplied
**domain skills** (procedural "how-to" knowledge) **through RAG**, keeping the engine
code domain-agnostic. Enabled skills are materialised into a **skills-RAG
collection**; a pipeline's planning/reasoning role **recalls the relevant skill chunk
by semantic match and injects it into that LLM call's context** — gnostifying that
call. The skills-RAG + host are a cross-cutting **mechanism**; **this spec wires and
tests exactly ONE consumer — the `controller` planner.** Other pipelines
(default/linear/dag/stepper) can consume the same `host.rag()` later, but their hooks
are explicit follow-on work, not in this scope. This is the same posture as Claude
Code's plugin system: a non-GPL host that loads user-enabled (possibly GPL) skills
and runs them without becoming GPL.

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
5. **Extensible mechanism, controller-first.** The skills-RAG + host are a
   cross-cutting mechanism any pipeline COULD consume via `host.rag()`, but this spec
   delivers and tests ONE consumer — the `controller` planner. Wiring
   default/linear/dag/stepper is explicit future work, not in scope here.
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
consumer skills are meant to close, without hardcoding any domain. The delivery
channel to the **planner** did not exist (deferred in PR #183).

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

/** LOW-LEVEL store read API — the pinning primitive the compat wrapper composes over.
 *  It does NO compatibility logic and does NOT embed: it exposes the atomic active
 *  pointer and a vector read of a SPECIFIC revision, so a caller can pin one revision
 *  across check+read. (The raw store implements this; the serving embedder lives in the
 *  wrapper above, not here.) */
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
  /** Build a FRESH generation: acquire → parse → upsert the reachable sources;
   *  unreachable sources are carried forward (strict:false) or abort the whole load
   *  (strict:true) — see "Reconciliation". Then fenced `activate`. ANY exit WITHOUT a
   *  successful activate (error, strict abort, fenced-out CAS) `discardGeneration`s the
   *  half-built generation in a `finally` — no orphan embeddings leak. Idempotent;
   *  callable at startup OR out-of-band.
   *
   *  RECALL-ONLY hosts (constructed with a `rag` handle and NO `source` — see below)
   *  have nothing to build: `load(options)` opens no generation and writes nothing, but
   *  it is NOT empty — it calls `rag().activeManifest(options)`, which (a) resolves the
   *  wrapper's serving `dimension` if undeclared, by ONE probe embed run through
   *  `options` (metered/cancellable — never an unmetered embed at construction), and
   *  (b) compares the now-complete serving descriptor to the active generation for an
   *  EAGER fail-fast. The same atomic check then runs per-revision inside `rag().query`
   *  (the store can rotate out-of-band after startup), so this eager check is an early
   *  warning, not the only guard. The store is materialised out-of-band by a SEPARATE
   *  ingest instance/job. `options` threads metering into the probe and ingest. */
  load(options?: CallOptions): Promise<void>;
  /** The score-bearing skills-RAG handle pipelines recall from. Always available —
   *  including on a recall-only host that never ingested, because it reads the
   *  already-active generation that an out-of-band ingest wrote. */
  rag(): ISkillsRagHandle;
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
// writes (via `store`) AND serves, so it ALSO needs the serving embedder + descriptor
// fields and wraps its OWN store as the read path:
makeSkillPluginHost({
  source,            // acquisition strategy + the explicit enabled[] list
  store,             // ISkillsStore (in-memory | vector-DB | FS-cache) — WRITE/reconcile
  embedder,          // SERVING embedder — text query embed + lazy dimension probe
  embeddingSpaceId,  // mandatory for a persistent store (auto for in-memory self-ingest)
  retrievalSchemaVersion,
  dimension,         // optional — declared skips the probe
})
// → internally: rag = makeCompatibleSkillsRag({ backend: store, embedder,
//      embeddingSpaceId, retrievalSchemaVersion, dimension }); store also gets the
//      embedder for ingest-side upsert embedding. After self-ingest the controller has
//      a working text-query path (store extends ISkillsRagBackend, so it IS a backend).

// Recall-only serving host (no-FS serving model — no source, no write API). The CALLER
// builds the wrapper from a bare backend (least privilege — no write store):
const rag = makeCompatibleSkillsRag({
  backend, embedder, embeddingSpaceId, retrievalSchemaVersion, dimension /* optional */,
});
makeSkillPluginHost({ rag });
```

`makeCompatibleSkillsRag` returns an `ISkillsRagHandle`: `query` reads
`backend.activeSnapshot()` once, runs the per-`revision` compatibility check (caching the
verdict by revision) BEFORE any embed, and only on a match embeds the text and issues
`backend.queryRevision(snapshot.revision, vector, k)` — pinning is implementable because
the backend exposes a revision-explicit read, not a "query whatever is active" method;
the embed (the only paid step) is skipped on a null/incompatible generation. The
descriptor reaches `query` by closure (resolving "where does the serving descriptor come
from"). The host requires `{ source, store, embedder, … }` (ingest) OR `{ rag }`
(recall-only); supplying a write `store` to a serving process is exactly the
over-privilege the recall-only shape removes.

A gnostifiable pipeline depends on **`host.rag()` only** — an `ISkillsRagHandle`. It
knows nothing about plugins, source, or backend; the host hides all of that.
`skillsRecall(goal, k, threshold, ctx.options) = host.rag().query(goal, { k,
threshold }, ctx.options)` — the request `CallOptions` flow through so the recall
embedding is metered/cancellable. Swapping the source or the store never touches the
planner. `load()` is the only place acquisition/parse/ingest/reconciliation live;
everything downstream is RAG.

### Canonical skill record — the stable RAG contract

```
SkillRecord {
  id: string            // LOGICAL stable id: "<sourceId>/<plugin>@<version>/<skill>#<chunkIx>"
                        //   deterministic (dedup); the store's PHYSICAL key is
                        //   `${generation}:${id}` so generations never collide — see "Reconciliation"
  sourceId: string      // STABLE config-declared source id, version-INDEPENDENT — the
                        //   reconciliation/carryForward key (survives a registry/version change,
                        //   and is known even when a failed fetch's version is not)
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

**Source-failure policy (resolves `strict` vs snapshot atomicity).** A generation is
all-or-nothing: it must contain EVERY enabled source's records before activate, or it
is discarded. So:
- **`strict: false` (default) — per-source carry-forward.** An unreachable/failed
  source does NOT drop its skills: `carryForward(generation, [its sourceId])` copies
  that source's records from the active generation into the new one unchanged; only
  the reachable sources are refreshed. The new generation is complete → activate is
  safe, last-known-good is retained. (On the very first load with no active
  generation, a failed source simply contributes nothing — it was never loaded.)
- **`strict: true` — all-or-nothing.** ANY source failure aborts the whole `load`: no
  `activate`, the prior generation is fully retained, the error surfaces.

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

**4. Recall (runtime) — RAG-only, FS-free, the one new pipeline hook.** A
`skillsRecall(query, k, threshold, options)` dependency over `ISkillsRagHandle`: the
planning/reasoning role queries by goal/step (passing the request `CallOptions` so
the recall embedding is metered/cancellable) → `SkillHit[]` (top-`k`, score ≥
`threshold`) → injects each hit's `record.content` **directly** (it is already in the
store — there is NO re-load from FS or source) as a bounded "Relevant skills" block
(own char budget). Empty/no match → no block → unchanged behaviour. This is
chunk-level injection: a hit IS one section, so the planner gets the relevant
fragment, not a whole skill.

### Where it plugs in

| Concern | Location | New / reused |
|---|---|---|
| Frontmatter parse (pure) | `llm-agent-libs/src/skills` | **reused** (FS-free) |
| `loadSkillFromDir`, `ClaudeSkillManager` (FS) | same | reused ONLY by the optional FS fetcher |
| `ISkillSource` strategy + fetchers (HTTP/programmatic/FS) | `llm-agent-libs/src/skills` | **new** (HTTP/programmatic) |
| `PluginMarketplaceAdapter` (in-memory → canonical + chunker) | same | **new** |
| `ISkillsStore` impls (in-memory; vector-DB) + `ISkillsRagHandle` | `llm-agent-libs` (+ a vector-DB adapter) | **new** (cosine + score + generations; not `IKnowledgeRagHandle`) |
| Ingest wiring (startup AND out-of-band entrypoint) | SmartServer build / a CLI/admin entry | **new** (parallels MCP→toolsRag) |
| `skillsRecall` hook | each gnostifiable pipeline (controller planner first) | **new** for controller |
| Config parse (`skills` block) + `builder.withSkills(...)` | server config + builder | **new** |

The controller planner is the first consumer (its create-plan/replan recalls
skills). **The default pipeline does NOT already do this**: its `SkillSelectHandler`
RAG-selects a `skill:<name>` and then **re-loads the full body via `ISkillManager`
(filesystem)** — which fails the no-FS contract and injects a whole skill, not a
relevant chunk. Extending gnostification to the default pipeline is therefore
explicit follow-on work: either rework `SkillSelectHandler` to inject `SkillHit`
content from `host.rag()` directly, or provide a RAG-backed `ISkillManager` whose
`getContent` reads the store — Phase 2, not assumed.

## Configuration

Explicit, opt-in, per-plugin. Two surfaces:

**YAML (server):**
```yaml
skills:
  collection: skills                 # separate RAG collection
  store: { type: qdrant, url: ... }  # optional: a persistent networked store
                                     #   (omit → in-memory, self-ingest at startup)
  embeddingSpaceId: sap-skills-emb-2026-06   # MANDATORY for a PERSISTENT store (here Qdrant):
                                             #   stamped onto every generation at activate, so a
                                             #   later recall-only instance can verify it. Bump
                                             #   when the embedding space changes. (Omittable ONLY
                                             #   for the in-memory self-ingest case — one process,
                                             #   no cross-process reader to mismatch.)
  k: 4                               # max records injected per planning call
  threshold: 0.3                     # min cosine similarity [0..1]; below → dropped. Default 0.3
  maxInjectChars: 4000
  chunk: { maxChars: 1500 }
  strict: false                      # true → any source failure aborts load; false → carry-forward
  sources:
    - id: sap                                 # STABLE sourceId — reconciliation/carry-forward key
      registry: https://<host>/<skills>       # FETCHED source (HTTP → memory)
      enabled: [sap-abap, sap-abap-cds]       # REQUIRED non-empty for fetched sources; "*" = all
```

A **recall-only serving** instance — the canonical no-FS deployment, where a
persistent store was materialised out-of-band by a separate ingest job — omits
`sources` entirely and declares a persistent `store` plus the serving `embedder`:
```yaml
skills:
  collection: skills
  store: { type: qdrant, url: ... }  # REQUIRED here — recall reads what ingest wrote
  embedder: { provider: openai, model: text-embedding-3-small }  # MUST match ingest's
  embeddingSpaceId: sap-skills-emb-2026-06   # MANDATORY (persistent): stable vector-space id,
                                             #   bump when the space changes; NOT alias-derived
  dimension: 1536                            # optional: declare to skip the probe embed
  loadOnStartup: false               # recall-only: no source access, no ingest, load() is a no-op
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
  collection: 'skills',
  k: 4,
  threshold: 0.3,
  // a `records` source is the consumer's pre-filtered set → a stable `id`, NO `enabled`.
  sources: [{ id: 'my-skills', records: mySkillRecords }], // in-memory; no FS, no fetch
});
```

For a `records` source the host **STAMPS** the configured `id` onto every record's
`sourceId` (so the consumer cannot create a mismatched/duplicate key); the supplied
records need not set `sourceId` themselves. `skills` absent → no gnostification. The
engine ships no default `sources`.

## Error handling

- Missing/empty `enabled` on a **fetched** source → **startup config error** (not
  "load all"); a `records` source carries no `enabled`. Missing `id` on any source, or
  a **duplicate `sourceId`** across sources → config error.
- A rejected (fenced-out) `activate` from a concurrent/stale load, an ingest error, or
  a `strict` abort → the half-built generation is `discardGeneration`d in a `finally`
  (no orphan embeddings linger in a persistent store); recall is never reverted.
- Source unreachable at ingest → `strict:false` **carries the failed source forward**
  from the active generation (warn; its skills are NOT lost) and refreshes only the
  reachable sources; `strict:true` **aborts the whole load** (no activate, prior
  generation fully retained). Either way the store is never partially updated.
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

**PoC (first task) — WITH vs WITHOUT, validate the hypothesis.** Extend the
plan-analysis harness: acquire `sap-abap` + `sap-abap-cds` (in MY eval env I may use
a local clone — acquisition is not the product contract), run the in-memory adapter
→ in-memory skills-RAG, inject goal-level recall into the planner, re-run the 5
prompts × {incremental, adaptive}. Compare to the agnostic baseline: does `requires`
populate, does incremental produce a valid CDS plan, does the compound-create split
stabilise? This quantifies how much of the earlier negatives were knowledge gaps
(closed by skills) vs engine concerns.

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
- Ingest host serving path: a `{ source, store, embedder, embeddingSpaceId, … }` host
  after `load()` (self-ingest) exposes a WORKING `rag().query` — the host wrapped its own
  `store` (an `ISkillsRagBackend`) via `makeCompatibleSkillsRag`, so text query works
  without a separately supplied read handle; the wrapped descriptor matches what
  `activate` stamped (compatible by construction).
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

## Licensing posture (settled)

MIT, content-agnostic host; the adapter transforms whatever the consumer enables.
Gnostic skills (e.g. GPL-3.0 sap-skills) are enabled by the consumer and loaded into
the consumer's RAG at runtime — never bundled, copied, or redistributed by us. Same
position as Claude Code hosting user-installed GPL plugins. Internal evaluation
fetches the reference set only for local testing and commits nothing.

## Out of scope (separate specs / pending PoC)

- **Controller planner control-flow redesign** (reviewer-routed `next/need-info/
  error`, replan from an annotated plan, terminal "infeasible" answer, RAG-freshness
  / write-invalidates-related-reads) — deferred until the PoC shows how much
  gnostification alone closes; a distinct subsystem.
- **`requires`-manifest hardening** as a planner prompt-invariant — likely informed
  by the PoC; not bundled here.
- **LLM-distillation** of skills at ingest (current ingest is a deterministic
  transform).
- **Plugin commands/agents/hooks**, **per-step executor skill injection** (Phase 2).
- **Incremental planner per-step parse fragility** (engine concern, not knowledge).
