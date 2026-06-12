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

/** Read side — what gnostifiable pipelines depend on. Score-bearing; no session
 *  metadata. `options` threads cancellation/telemetry/token-metering: the query
 *  embedding is logged via `options.requestLogger`, exactly like the controller's
 *  RAG (so skills recall embeds reach /v1/usage). */
interface ISkillsRagHandle {
  query(
    text: string,
    opts: { k: number; threshold?: number },
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
}

/** Write/reconcile side — used ONLY by the host's load(). Records live under a
 *  GENERATION namespace: the PHYSICAL key is `${generation}:${record.id}`, so writing
 *  generation B never overwrites generation A's rows (snapshot isolation). `record.id`
 *  is the LOGICAL id (deterministic, dedup-friendly); the generation scopes the
 *  physical key. `options` threads metering into ingest embeds. */
interface ISkillsStore extends ISkillsRagHandle {
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
   *  snapshot. Drops the prior generation on success. */
  activate(generation: string, expectedRevision: string): Promise<void>;
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
   *  callable at startup OR out-of-band. `options` threads metering into ingest. */
  load(options?: CallOptions): Promise<void>;
  /** The score-bearing skills-RAG handle pipelines recall from. */
  rag(): ISkillsRagHandle;
}
```

Composed from two injected strategies at construction — `<>` is generic over both:

```ts
makeSkillPluginHost({
  source,  // WHERE FROM: acquisition strategy (Anthropic-marketplace adapter over an
           //   HTTP/programmatic/FS fetcher) + the explicit enabled[] plugin list
  store,   // HOW RAG GIVES BACK: an ISkillsStore impl (in-memory | vector-DB | FS-cache)
})
```

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
   active revision is still `baseRevision`; queries then read the new namespace and the
   prior generation is dropped (background delete). A **partially-failed build that
   never reaches activate** leaves the prior snapshot fully intact.

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

For the **in-memory** store the namespace is a fresh map swapped on activate. For a
**vector-DB** it is a generation label filtered on query, a cheap pointer flip on
activate, and a background delete of the prior generation (or a collection-alias swap
where supported). The **ephemeral in-memory-per-run** strategy has no prior
generation to carry forward (each startup builds from scratch) but uses the same
build→activate swap within a run for atomicity.

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
