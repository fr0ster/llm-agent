# Skill Plugin-Host & Runtime Gnostification — Design

**Status:** draft (brainstormed 2026-06-12)
**Branch:** `feat/skill-plugin-host` (off `design/controller-execution-result-control` / PR #183).
**Relation to PR #183:** depends on the controller PR #183 delivers (it adds a skills
recall hook to the planner), but is a SEPARATE, cross-cutting feature — not part of
#183's scope. Built as a linear stack on top of #183 to avoid merge conflicts.

## Goal

Let a deployment **gnostify** any agnostic pipeline by feeding it consumer-supplied
**domain skills** (procedural "how-to" knowledge) **through RAG**, keeping the engine
code domain-agnostic. Enabled skills are materialised into a **skills-RAG
collection**; a pipeline's planning/reasoning role **recalls the relevant skill by
semantic match and injects its body into that LLM call's context** — gnostifying
that call. This is the same posture as Claude Code's plugin system: a non-GPL host
that loads user-enabled (possibly GPL) skills and runs them without becoming GPL.

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
5. **Cross-cutting.** ANY pipeline (flat/linear/dag/stepper/controller) can be
   gnostified from the shared skills-RAG — not controller-only.
6. **Opt-in, explicit.** Only the plugins the consumer lists are pulled. `enabled`
   is a **REQUIRED, non-empty** list per source — omitting it is a config error, NOT
   "load all" (silently pulling every plugin would violate the security/licensing
   model). Loading all of a source is possible only by the explicit sentinel
   `enabled: "*"`. No `skills` block at all → agnostic, unchanged. No auto-discovery.
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
 *  metadata. */
interface ISkillsRagHandle {
  query(text: string, opts: { k: number; threshold?: number }): Promise<readonly SkillHit[]>;
}

/** Write/reconcile side — used ONLY by the host's load() (see "Reconciliation"). */
interface ISkillsStore extends ISkillsRagHandle {
  beginGeneration(): Promise<string>;                              // new generation id
  upsert(generation: string, records: readonly SkillRecord[]): Promise<void>;
  activate(generation: string): Promise<void>;                     // atomic snapshot switch
}

interface ISkillPluginHost {
  /** Materialise the enabled skills into the backing store (acquire → parse →
   *  upsert into a fresh generation → atomic activate) per the configured source +
   *  store strategy. Idempotent; callable at startup OR out-of-band. */
  load(): Promise<void>;
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
`skillsRecall(goal, k, threshold) = host.rag().query(goal, { k, threshold })`.
Swapping the source or the store never touches the planner. `load()` is the only
place acquisition/parse/ingest/reconciliation live; everything downstream is RAG.

### Canonical skill record — the stable RAG contract

```
SkillRecord {
  id: string            // STABLE deterministic id: "<source>:<plugin>@<version>/<skill>#<chunkIx>"
                        //   (drives reconciliation/dedup — see "Reconciliation")
  name: string          // "<plugin>/<skill>" (+ "#<heading>" for a chunk) — human label
  retrievalText: string // the EMBEDDED surface — DISTINCT per chunk (see below)
  content: string       // the chunk body — injected verbatim into the LLM context
  source: string        // provenance: source + plugin + version (traceability/reconcile scope)
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
the desired set via an atomic **generation snapshot**, keyed by the stable
`SkillRecord.id`:

1. `beginGeneration()` → a fresh generation id.
2. `upsert(generation, records)` — write the full desired record set into the new
   generation (embedding each `retrievalText`).
3. `activate(generation)` — **atomic switch**: queries now read the new generation;
   the previous generation's records are dropped. Until activate, recall keeps
   serving the OLD generation — so a **partially-failed ingest never switches**, and
   the store is never in a half-updated state.

For the **in-memory** store this is trivial (build a new map, swap the reference).
For a **vector-DB** it is a generation/tenant label filtered on query, with a cheap
metadata flip on activate and a background delete of the prior generation (or a
collection-alias swap where the backend supports it). `id` stability means an
unchanged chunk re-embeds to the same id across generations (dedup-friendly); a
removed plugin/skill/chunk simply has no record in the new generation → gone after
activate. The **ephemeral in-memory-per-run** strategy needs no cross-run
reconciliation (each startup builds from scratch), but uses the same generation
build/swap within a run for atomicity.

**4. Recall (runtime) — RAG-only, FS-free, the one new pipeline hook.** A
`skillsRecall(query, k, threshold)` dependency over `ISkillsRagHandle`: the
planning/reasoning role queries by goal/step → `SkillHit[]` (top-`k`, score ≥
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
  k: 4                               # records injected per planning call
  maxInjectChars: 4000
  chunk: { maxChars: 1500 }
  strict: false                      # true → fail startup if a configured source is unreachable
  sources:
    - registry: https://<host>/<skills>      # fetched over HTTP into memory
      enabled: [sap-abap, sap-abap-cds]       # REQUIRED non-empty list; "*" = all (explicit)
```

`enabled` is mandatory per source (a missing/empty `enabled` is a startup config
error, not "load all" — see principle 6).

**Programmatic (embed-as-library):**
```ts
builder.withSkills({
  collection: 'skills',
  k: 4,
  sources: [{ records: mySkillRecords }],     // in-memory; no FS, no fetch
});
```

`skills` absent → no gnostification. The engine ships no default `sources`.

## Error handling

- Missing/empty `enabled` on a source → **startup config error** (not "load all").
- Source unreachable at ingest → warn + skip (default) | fail (`strict`). A failed
  ingest never `activate`s a generation, so recall keeps the prior consistent set.
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
  `activate`; a mid-ingest failure does NOT activate (recall still serves the prior
  generation — atomicity).
- Recall hook: returns scored hits; below-`threshold` hits dropped; injects hit
  `content` within budget; empty/no-match → no block (output identical to agnostic).
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
