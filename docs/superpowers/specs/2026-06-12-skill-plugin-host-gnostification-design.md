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
6. **Opt-in, explicit.** Only the plugins the consumer lists are pulled. Nothing
   listed → agnostic, unchanged. No auto-discovery of "everything".
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

```ts
interface ISkillPluginHost {
  /** Materialise the enabled skills into the backing RAG (acquire → parse →
   *  upsert) per the configured source + store strategy. Idempotent; callable at
   *  startup OR out-of-band. */
  load(): Promise<void>;
  /** The skills-RAG handle pipelines recall from (semantic query). */
  rag(): IKnowledgeRagHandle;
}
```

Composed from two injected strategies at construction — `<>` is generic over both:

```ts
makeSkillPluginHost({
  source,  // WHERE FROM: acquisition strategy (Anthropic-marketplace adapter over an
           //   HTTP/programmatic/FS fetcher) + the explicit enabled[] plugin list
  store,   // HOW RAG GIVES BACK: materialisation backend (in-memory | vector-DB | FS-cache)
})
```

A gnostifiable pipeline depends on **`host.rag()` only** — an `IKnowledgeRagHandle`.
It knows nothing about plugins, source, or backend; the host hides all of that.
`skillsRecall(goal, k) = host.rag().query(goal, { k })`. Swapping the source or the
store never touches the planner. `load()` is the only place acquisition/parse/ingest
live; everything downstream is RAG.

### Canonical skill record — the stable RAG contract

```
SkillRecord {
  name: string         // "<plugin>/<skill>" or "<plugin>/<skill>#<section>" (a chunk)
  description: string  // retrieval surface — embedded (the SKILL.md "Use when…" text)
  content: string      // body / section chunk — injected into the LLM context
  source: string       // provenance: plugin+version+skill+section (traceability)
}
```

Embedding on `description` (English ⇄ English with the planner's English
instructions → a normal embedder suffices, per
[[project_embedder_multilingual_mcp_english]]). Stored in a **dedicated skills
collection**, separate from run-scoped results-RAG and from tools-RAG (mixing
pollutes recall both ways).

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
plugins, produce canonical `SkillRecord[]`. Reuses the **frontmatter parser**
(pure string parsing — NOT `loadSkillFromDir`). Ignores plugin
commands/agents/hooks (skills only). **Chunks** large bodies by top-level Markdown
sections (each chunk a record, bounded to `chunk.maxChars`, over-long sections
split on paragraphs) so recall returns the relevant fragment, not a 15 KB dump.
"Anthropic/Claude-plugin marketplace" is the first adapter; another source format =
another adapter, canonical schema unchanged.

**3. Ingest (upsert) + materialisation strategy (pluginator backend).**
`SkillRecord[]` → embed `description` → upsert into the skills collection.
Idempotent by `(source, name, version, chunk)`. WHERE/WHEN the skills are
materialised is a **pluggable strategy** (analogy: Claude Code downloads plugin
files on install) — chosen per environment, all converging on the same skills-RAG:
- **FS-cache** (Claude-Code-like): download/cache plugin files to disk, then ingest
  to RAG. For environments that have a filesystem.
- **In-memory per run**: fetch → parse → ingest into an in-memory RAG at every
  startup; no persistence. Ephemeral, FS-free.
- **Direct vector-DB**: fetch → upsert straight into a persistent networked store
  (Qdrant/HANA/pg), once / out-of-band. **Serving instances — even with no
  filesystem and no source access — only recall.** The no-FS serving model.

The recall contract is invariant across all three: the planner reads the
skills-RAG, never FS, never the source. The backend is an implementation detail of
the selected pluginator strategy, not of the engine core.

**4. Recall (runtime) — RAG-only, FS-free, the one new pipeline hook.** A
`skillsRecall(query, k)` dependency (a semantic query over the skills collection):
the planning/reasoning role queries by goal/step → top-`k` over a threshold →
injects their `content` as a bounded "Relevant skills" block (own char budget).
Reads the skills collection only. Empty/no match → no block → unchanged behaviour.

### Where it plugs in

| Concern | Location | New / reused |
|---|---|---|
| Frontmatter parse (pure) | `llm-agent-libs/src/skills` | **reused** (FS-free) |
| `loadSkillFromDir`, `ClaudeSkillManager` (FS) | same | reused ONLY by the optional FS fetcher |
| `ISkillSource` strategy + fetchers (HTTP/programmatic/FS) | `llm-agent-libs/src/skills` | **new** (HTTP/programmatic) |
| `PluginMarketplaceAdapter` (in-memory → canonical + chunker) | same | **new** |
| Skills-RAG collection (upsert + query) | RAG infra (`makeRag`/knowledge index) | reused infra, new collection |
| Ingest wiring (startup AND out-of-band entrypoint) | SmartServer build / a CLI/admin entry | **new** (parallels MCP→toolsRag) |
| `skillsRecall` hook | each gnostifiable pipeline (controller planner first; default pipeline already has `SkillSelectHandler`) | **new** for controller |
| Config parse (`skills` block) + `builder.withSkills(...)` | server config + builder | **new** |

The controller planner is the first new consumer (its create-plan/replan recalls
skills). The default pipeline already consumes skills via `SkillSelectHandler` — the
same shared skills-RAG, so "all pipelines gnostifiable" is the same mechanism, one
recall hook per pipeline.

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
      enabled: [sap-abap, sap-abap-cds]       # ONLY these plugins (omit = all in source)
```

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

- Source unreachable at ingest → warn + skip (default) | fail (`strict`).
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
  `enabled`; ignores commands/agents/hooks; **no filesystem access**.
- Chunker: bounds to `maxChars`; splits by H2; over-long section splits further.
- Ingest: idempotent upsert by `(source,name,version,chunk)`; malformed item skipped.
- Recall hook: injects matched bodies within budget; empty/no-match → no block
  (output identical to agnostic).
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
