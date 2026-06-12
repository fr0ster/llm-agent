# Skill Plugin-Host & Runtime Gnostification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, agnostic skill plugin-host that materialises consumer-supplied domain skills into a grouped skills-RAG, attach it to the RAG path each pipeline already reads (assembler pipelines + the controller), and measure WITH-vs-WITHOUT by a config toggle.

**Architecture:** Three layers. (1) Contracts in `@mcp-abap-adt/llm-agent` (pure interfaces/types). (2) Implementations in `@mcp-abap-adt/llm-agent-libs/src/skills/plugin-host/` — chunker, marketplace adapter, HTTP fetcher, in-memory store+catalog providers, compat wrapper, the host, and the `IRag` adapter. (3) Wiring + config in `@mcp-abap-adt/llm-agent-server-libs` — `skills:` config parse/validation, register the adapter as a context-assembler `IRag` source for assembler pipelines, and a controller planner recall hook; plus the toggle measurement via the plan-analysis harness.

**Tech Stack:** TypeScript strict ESM (`.js` import extensions), Node ≥ 22, Biome, `node:test` + `node:assert/strict`. Tests are colocated `*.test.ts`. Per-package test: `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`. Build a lower package before running tsx tests that import it across the workspace.

**Source of truth:** `docs/superpowers/specs/2026-06-12-skill-plugin-host-gnostification-design.md`. Read its Terminology table and the interface block before starting.

---

## Conventions for every task

- Build order: `llm-agent → llm-agent-libs → llm-agent-server-libs`. After editing a lower package, run `npm run build` before any cross-package tsx test (per `feedback_build_before_dev`).
- Lint after each task: `npm run lint` (Biome auto-fix). No `any`.
- Commit after each task (Conventional Commits). Branch is `feat/skill-plugin-host` (already created, off main).
- All interfaces start with `I` (project convention). All strings/comments in English.
- Tests run from the package directory: `cd packages/<pkg> && node --import tsx/esm --test --test-reporter=spec 'src/skills/plugin-host/<file>.test.ts'` (adjust path).

---

# Phase A — the reusable component

## Task A1: Canonical contracts

**Files:**
- Create: `packages/llm-agent/src/interfaces/skills-rag.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (add `export * from './skills-rag.js';`)
- Test: `packages/llm-agent/src/interfaces/skills-rag.test.ts`

These are pure types — the test is a compile-time/shape smoke test (no behaviour yet).

- [ ] **Step 1: Write the contracts file**

Create `skills-rag.ts` with EXACTLY these types (mirroring the spec's interface block). Import `CallOptions` from `./types.js` and `RagResult`/`RagError`/`Result` for the adapter's later use is NOT here (adapter lives in libs). Keep this file dependency-light: only `CallOptions`.

```ts
import type { CallOptions } from './types.js';

/** One ranked recall hit: a stored skill chunk + its similarity score. */
export interface SkillHit {
  record: SkillRecord;
  score: number; // cosine similarity in [0,1]
}

/** Canonical stored skill chunk — the stable RAG contract between any strategy and the host. */
export interface SkillRecord {
  /** LOGICAL stable id: "<source>:<plugin>@<version>/<skill>#<chunkIx>" (deterministic). */
  id: string;
  /** Stable, version-independent config source id (reconciliation/carry-forward key). */
  sourceId: string;
  /** Group = the skills-RAG collection this record lands in; ASSIGNED BY THE STRATEGY. */
  group: string;
  /** "<plugin>/<skill>" (+ "#<heading>" for a chunk) — human label. */
  name: string;
  /** The EMBEDDED surface — DISTINCT per chunk (description + heading + chunk content). */
  retrievalText: string;
  /** The chunk body injected verbatim into the LLM context. */
  content: string;
  /** Versioned descriptive metadata: "<plugin>@<version>/<skill>#<heading>". */
  provenance: string;
}

/** Embedding-compatibility descriptor — must agree between the embedder that WROTE a
 *  generation and the one that QUERIES it. */
export interface SkillsEmbeddingDescriptor {
  /** Stable id of the actual vector space (deployment/adapter-supplied; mandatory for persistent). */
  embeddingSpaceId: string;
  /** Vector length. */
  dimension: number;
  /** Host code constant: retrievalText composition + chunking contract version. */
  retrievalSchemaVersion: number;
}
/** What an active generation carries (same shape; published atomically by the catalog commit). */
export type SkillsManifest = SkillsEmbeddingDescriptor;

/** Atomic snapshot of one collection's serving pointer (resolved FROM the catalog). */
export interface ActiveSnapshot {
  revision: string; // = the serving generation id
  manifest: SkillsManifest;
}

/** Public, conflict-isolated group descriptor. */
export interface SkillGroupInfo {
  group: string; // stable group id the strategy assigned
  description: string; // for the explicit planner's group-selection prompt
  collection: string; // physical collection name
}

/** One catalog entry — the serving truth for a collection. */
export interface CatalogEntry {
  collection: SkillGroupInfo;
  sources: readonly string[]; // ownership: sourceIds contributing here
  generation: string; // THE serving generation pointer
  manifest: SkillsManifest;
  tombstone?: boolean; // published-but-being-reclaimed (not served)
}

/** Atomic catalog read: entries + the catalog's own fence token. */
export interface CatalogSnapshot {
  catalogRevision: string;
  entries: readonly CatalogEntry[]; // active (non-tombstone) entries are what groups() shows
}

/** Cross-collection catalog read (shared by store & backend providers). */
export interface ISkillsCatalog {
  readCatalog(options?: CallOptions): Promise<CatalogSnapshot>;
}

/** LOW-LEVEL collection-scoped read — the pinning primitive the compat wrapper composes over. */
export interface ISkillsRagBackend {
  /** This collection's serving { revision: generation, manifest } resolved FROM the catalog
   *  (null if not in the catalog). One read, no TOCTOU. */
  activeSnapshot(): Promise<ActiveSnapshot | null>;
  /** Vector read pinned to an EXPLICIT generation (no "whatever is active now"). */
  queryRevision(
    revision: string,
    vector: number[],
    k: number,
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
}

/** The public score-bearing handle pipelines depend on (the compat wrapper implements it). */
export interface ISkillsRagHandle {
  query(
    text: string,
    opts: { k: number; threshold?: number },
    options?: CallOptions,
  ): Promise<readonly SkillHit[]>;
  /** Eager fail-fast / dimension-probe entry; same per-revision check runs inside query. */
  activeManifest(options?: CallOptions): Promise<ActiveSnapshot | null>;
}

/** Write/reconcile side (collection-scoped) — NO activate; activation is the catalog commit. */
export interface ISkillsStore extends ISkillsRagBackend {
  /** Open a fresh INACTIVE generation namespace; returns its id. */
  beginGeneration(): Promise<{ generation: string }>;
  upsert(
    generation: string,
    records: readonly SkillRecord[],
    options?: CallOptions,
  ): Promise<void>;
  /** Copy the served generation's records for the given sourceIds into `generation` (carry-forward). */
  carryForward(generation: string, sourceIds: readonly string[]): Promise<void>;
  /** Delete a generation's records (orphan cleanup / reclaim). Idempotent; never deletes a
   *  generation the active catalog still names. */
  discardGeneration(generation: string): Promise<void>;
}

/** Per-group provider + the cross-collection catalog (write side). */
export interface ISkillsStoreProvider extends ISkillsCatalog {
  forGroup(group: string): ISkillsStore;
  /** SINGLE fenced commit: atomically swaps every collection's serving pointer + bumps the
   *  catalog revision, ONLY if the active catalogRevision still == expected. Does NOT delete. */
  publishCatalog(
    expectedCatalogRevision: string,
    entries: readonly CatalogEntry[],
    options?: CallOptions,
  ): Promise<void>;
  /** Physically reclaim a TOMBSTONED collection's generations AFTER a successful publish. */
  dropCollection(group: string, options?: CallOptions): Promise<void>;
}

/** Per-group provider (read side) + the catalog. */
export interface ISkillsRagBackendProvider extends ISkillsCatalog {
  forGroup(group: string): ISkillsRagBackend;
}

/** The injected acquisition + materialisation strategy (== a `source`). */
export interface ISkillSource {
  acquire(options?: CallOptions): Promise<SkillIngestResult>;
}
export interface SkillIngestResult {
  collections: readonly SkillGroupInfo[]; // authoritative desired catalog (+ descriptions)
  records: readonly SkillRecord[]; // each record.group ∈ collections[].group
}

/** Outcome of a load() that COMMITTED (possibly partially). Hard failures throw. */
export interface SkillLoadResult {
  committed: readonly string[];
  omitted: readonly { group: string; reason: string }[];
  tombstoned: readonly string[];
  ok: boolean;
}

/** The generic host (part 1). */
export interface ISkillPluginHost {
  load(options?: CallOptions): Promise<SkillLoadResult>;
  groups(): readonly SkillGroupInfo[]; // sync, fixed-at-load snapshot
  rag(group?: string): ISkillsRagHandle;
}
```

- [ ] **Step 2: Export from the interfaces barrel**

In `packages/llm-agent/src/interfaces/index.ts`, add `export * from './skills-rag.js';` near the other exports (keep alphabetical-ish ordering with neighbours).

- [ ] **Step 3: Write the shape test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CatalogSnapshot,
  SkillIngestResult,
  SkillLoadResult,
  SkillRecord,
} from './skills-rag.js';

test('skills-rag contract shapes compile and are constructible', () => {
  const rec: SkillRecord = {
    id: 's:p@1/skill#0', sourceId: 's', group: 'g', name: 'p/skill',
    retrievalText: 'desc\n## h\nbody', content: 'body', provenance: 'p@1/skill#h',
  };
  const ingest: SkillIngestResult = {
    collections: [{ group: 'g', description: 'd', collection: 'g' }],
    records: [rec],
  };
  const snap: CatalogSnapshot = { catalogRevision: 'r0', entries: [] };
  const result: SkillLoadResult = { committed: ['g'], omitted: [], tombstoned: [], ok: true };
  assert.equal(ingest.records[0].group, 'g');
  assert.equal(snap.entries.length, 0);
  assert.equal(result.ok, true);
});
```

- [ ] **Step 4: Build + run + lint + commit**

Run: `npm run build` (from repo root) — Expected: PASS (types compile).
Run: `cd packages/llm-agent && node --import tsx/esm --test --test-reporter=spec 'src/interfaces/skills-rag.test.ts'` — Expected: 1 test pass.
Run: `npm run lint`.

```bash
git add packages/llm-agent/src/interfaces/skills-rag.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/interfaces/skills-rag.test.ts
git commit -m "feat(skills): canonical skill plugin-host contracts"
```

---

## Task A2: Chunker + retrievalText + stable id

A pure transform: one `SKILL.md` (frontmatter parsed out → `{description, body}`) + identity coordinates → `SkillRecord[]` (chunked). FS-free.

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/chunker.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/chunker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkSkill } from './chunker.js';

const ID = { source: 's', plugin: 'p', version: '1', skill: 'sk', group: 'g' };

test('splits by H2 and produces DISTINCT retrievalText per chunk', () => {
  const body = '# Title\nintro\n## Alpha\naaa\n## Beta\nbbb';
  const recs = chunkSkill({ ...ID, description: 'D', body }, { maxChars: 1000 });
  assert.equal(recs.length, 2);
  assert.notEqual(recs[0].retrievalText, recs[1].retrievalText);
  assert.match(recs[0].retrievalText, /D/); // description present
  assert.match(recs[0].retrievalText, /Alpha/); // heading present
  assert.equal(recs[0].id, 's:p@1/sk#0');
  assert.equal(recs[1].id, 's:p@1/sk#1');
  assert.equal(recs[0].group, 'g');
  assert.equal(recs[0].sourceId, 's');
});

test('over-long section splits further; ids stay deterministic', () => {
  const body = '## Big\n' + 'x'.repeat(50) + '\n\n' + 'y'.repeat(50);
  const recs = chunkSkill({ ...ID, description: 'D', body }, { maxChars: 60 });
  assert.ok(recs.length >= 2);
  // determinism: same input → same ids
  const again = chunkSkill({ ...ID, description: 'D', body }, { maxChars: 60 });
  assert.deepEqual(recs.map((r) => r.id), again.map((r) => r.id));
});
```

Run: `cd packages/llm-agent-libs && node --import tsx/esm --test --test-reporter=spec 'src/skills/plugin-host/chunker.test.ts'` — Expected: FAIL (module not found).

- [ ] **Step 2: Implement the chunker**

```ts
import type { SkillRecord } from '@mcp-abap-adt/llm-agent';

export interface SkillIdentity {
  source: string;
  plugin: string;
  version: string;
  skill: string;
  group: string;
  description: string;
  body: string;
}

/** Split a skill body into bounded chunks by top-level H2; over-long sections split on
 *  blank lines, bounded to maxChars. Each chunk → an SkillRecord with a deterministic id
 *  and a DISTINCT retrievalText (description + heading + chunk content). */
export function chunkSkill(
  s: SkillIdentity,
  opts: { maxChars: number },
): SkillRecord[] {
  const sections = splitByH2(s.body);
  const out: SkillRecord[] = [];
  let ix = 0;
  for (const sec of sections) {
    for (const piece of boundSection(sec.content, opts.maxChars)) {
      out.push({
        id: `${s.source}:${s.plugin}@${s.version}/${s.skill}#${ix}`,
        sourceId: s.source,
        group: s.group,
        name: sec.heading ? `${s.plugin}/${s.skill}#${sec.heading}` : `${s.plugin}/${s.skill}`,
        retrievalText: `${s.description}\n## ${sec.heading ?? s.skill}\n${piece}`,
        content: piece,
        provenance: `${s.plugin}@${s.version}/${s.skill}#${sec.heading ?? ''}`,
      });
      ix++;
    }
  }
  return out;
}

function splitByH2(body: string): Array<{ heading?: string; content: string }> {
  const lines = body.split('\n');
  const out: Array<{ heading?: string; content: string }> = [];
  let cur: { heading?: string; content: string } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { heading: m[1].trim(), content: '' };
    } else if (line.startsWith('# ')) {
      // top-level title → preamble section
      if (!cur) cur = { content: '' };
    } else {
      if (!cur) cur = { content: '' };
      cur.content += (cur.content ? '\n' : '') + line;
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.content.trim().length > 0 || s.heading);
}

function boundSection(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const paras = content.split(/\n\s*\n/);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > maxChars && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  // hard-split any single paragraph still over the bound
  return out.flatMap((s) =>
    s.length <= maxChars
      ? [s]
      : (s.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) ?? [s]),
  );
}
```

Run the test — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/chunker.ts packages/llm-agent-libs/src/skills/plugin-host/chunker.test.ts
git commit -m "feat(skills): FS-free chunker with distinct retrievalText + stable ids"
```

---

## Task A3: Marketplace adapter (in-memory bytes → SkillIngestResult)

Turns an in-memory marketplace manifest + per-plugin `SKILL.md` strings into `{ collections, records }`. Reuses the existing frontmatter parser. Decides collection placement (the strategy's job). For this first adapter the placement rule is **one group per plugin** (the simplest strategy), but it is encapsulated in a `placement(plugin) => group` callback so other strategies differ only there.

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/marketplace-adapter.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/marketplace-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIngestResult } from './marketplace-adapter.js';

const SKILL_MD = `---\nname: do-thing\ndescription: How to do the thing\n---\n# Do Thing\n## Step\nrun it`;

test('manifest + SKILL.md → records placed one-group-per-plugin + catalog', () => {
  const res = buildIngestResult({
    source: 'vendor',
    plugins: [
      { plugin: 'p1', version: '1', skills: [{ skill: 'do-thing', skillMd: SKILL_MD }] },
    ],
    chunk: { maxChars: 1000 },
    placement: (plugin) => ({ group: plugin, description: `plugin ${plugin}` }),
  });
  assert.deepEqual(res.collections.map((c) => c.group), ['p1']);
  assert.equal(res.collections[0].description, 'plugin p1');
  assert.ok(res.records.length >= 1);
  assert.ok(res.records.every((r) => r.group === 'p1'));
  // every record's group is in collections (host enforces this too)
  const groups = new Set(res.collections.map((c) => c.group));
  assert.ok(res.records.every((r) => groups.has(r.group)));
});

test('a strategy may bundle plugins into one group', () => {
  const res = buildIngestResult({
    source: 'vendor',
    plugins: [
      { plugin: 'a', version: '1', skills: [{ skill: 's', skillMd: SKILL_MD }] },
      { plugin: 'b', version: '1', skills: [{ skill: 's', skillMd: SKILL_MD }] },
    ],
    chunk: { maxChars: 1000 },
    placement: () => ({ group: 'bundle', description: 'bundle' }),
  });
  assert.deepEqual(res.collections.map((c) => c.group), ['bundle']);
  assert.ok(res.records.every((r) => r.group === 'bundle'));
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Implement the adapter**

Find the frontmatter parser first: `grep -rn "parseFrontmatter" packages/llm-agent-libs/src/`. Import it from its module (likely `../../utils/parse-frontmatter.js`). If the export name differs, adapt.

```ts
import type { SkillGroupInfo, SkillIngestResult, SkillRecord } from '@mcp-abap-adt/llm-agent';
import { parseFrontmatter } from '../../utils/parse-frontmatter.js';
import { chunkSkill } from './chunker.js';

export interface MarketplaceInput {
  source: string; // stable sourceId
  plugins: ReadonlyArray<{
    plugin: string;
    version: string;
    skills: ReadonlyArray<{ skill: string; skillMd: string }>;
  }>;
  chunk: { maxChars: number };
  /** Strategy placement: plugin → its group + description. Default = one group per plugin. */
  placement: (plugin: string) => { group: string; description: string };
}

/** Pure, FS-free: parse SKILL.md strings, chunk, and place records into collections. */
export function buildIngestResult(input: MarketplaceInput): SkillIngestResult {
  const records: SkillRecord[] = [];
  const collections = new Map<string, SkillGroupInfo>();
  for (const p of input.plugins) {
    const place = input.placement(p.plugin);
    if (!collections.has(place.group)) {
      collections.set(place.group, {
        group: place.group,
        description: place.description,
        collection: place.group,
      });
    }
    for (const s of p.skills) {
      const fm = parseFrontmatter<Record<string, unknown>>(s.skillMd);
      const description = String(fm.data.description ?? '');
      records.push(
        ...chunkSkill(
          {
            source: input.source,
            plugin: p.plugin,
            version: p.version,
            skill: s.skill,
            group: place.group,
            description,
            body: fm.content,
          },
          input.chunk,
        ),
      );
    }
  }
  return { collections: [...collections.values()], records };
}
```

> Note: if `parseFrontmatter` returns a different shape (e.g. `{ frontmatter, body }`), adjust the `.data`/`.content` accessors. Confirm by reading `parse-frontmatter.ts`.

Run the test — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/marketplace-adapter.ts packages/llm-agent-libs/src/skills/plugin-host/marketplace-adapter.test.ts
git commit -m "feat(skills): marketplace adapter — SKILL.md → grouped SkillIngestResult"
```

---

## Task A4: In-memory store + catalog providers

The hardest task. Implements `ISkillsStoreProvider` (and a read-only `ISkillsRagBackendProvider` view) over in-memory maps, with: per-collection generation namespaces, the cross-collection catalog (`readCatalog`/`publishCatalog` CAS/`dropCollection`), `activeSnapshot` resolved FROM the catalog, cosine `queryRevision`, and retention (in-memory exact reclaim).

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/in-memory-store.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/in-memory-store.test.ts`
- Reuse: cosine from `@mcp-abap-adt/llm-agent-server-libs`? No — that's a higher package. Add a tiny local cosine here (the spec allows in-memory cosine; keep it local to avoid a dependency cycle).

- [ ] **Step 1: Write the failing tests** (covers begin/upsert/publish/read/query, CAS, drop, manifest from catalog)

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeInMemoryStoreProvider } from './in-memory-store.js';

const MANIFEST = { embeddingSpaceId: 'sp', dimension: 3, retrievalSchemaVersion: 1 };
const rec = (id: string, group: string, vec: number[]) => ({
  record: {
    id, sourceId: 's', group, name: id, retrievalText: id, content: `c-${id}`, provenance: id,
  },
  vector: vec,
});

test('build inactive → publishCatalog activates → query + activeSnapshot from catalog', async () => {
  const p = makeInMemoryStoreProvider();
  const store = p.forGroup('g1');
  const { generation } = await store.beginGeneration();
  // upsert is embedding-agnostic here: the in-memory store accepts pre-vectorised rows via a test seam
  await p._seed(generation, [rec('a', 'g1', [1, 0, 0]), rec('b', 'g1', [0, 1, 0])]);
  // nothing serves yet
  assert.equal(await store.activeSnapshot(), null);
  const before = await p.readCatalog();
  await p.publishCatalog(before.catalogRevision, [
    { collection: { group: 'g1', description: 'd', collection: 'g1' }, sources: ['s'], generation, manifest: MANIFEST },
  ]);
  const snap = await store.activeSnapshot();
  assert.equal(snap?.revision, generation);
  assert.deepEqual(snap?.manifest, MANIFEST);
  const hits = await store.queryRevision(generation, [1, 0, 0], 1);
  assert.equal(hits[0].record.id, 'a');
});

test('publishCatalog CAS rejects a stale expectedRevision', async () => {
  const p = makeInMemoryStoreProvider();
  const r0 = (await p.readCatalog()).catalogRevision;
  await p.publishCatalog(r0, []); // bumps to r1
  await assert.rejects(() => p.publishCatalog(r0, []), /catalog.*revision|CAS|stale/i);
});

test('dropCollection removes a tombstoned collection\'s generations', async () => {
  const p = makeInMemoryStoreProvider();
  const g = await p.forGroup('g1').beginGeneration();
  await p._seed(g.generation, [rec('a', 'g1', [1, 0, 0])]);
  const r0 = (await p.readCatalog()).catalogRevision;
  await p.publishCatalog(r0, [
    { collection: { group: 'g1', description: 'd', collection: 'g1' }, sources: ['s'], generation: g.generation, manifest: MANIFEST },
  ]);
  await p.dropCollection('g1');
  // after drop, the generation's rows are gone
  await assert.rejects(() => p.forGroup('g1').queryRevision(g.generation, [1, 0, 0], 1), /unknown generation|not found/i);
});
```

> The `_seed` test seam writes pre-vectorised rows so the store test needs no embedder. In production, `upsert` embeds `retrievalText` via an injected embedder (Task A5 wires that). Keep `upsert` signature per the contract but route embedding through an injected `embed` fn in the provider factory (default throws "no embedder"); `_seed` bypasses it.

Run — Expected: FAIL.

- [ ] **Step 2: Implement the in-memory provider**

```ts
import type {
  CallOptions,
  ActiveSnapshot,
  CatalogEntry,
  CatalogSnapshot,
  SkillHit,
  SkillRecord,
  ISkillsRagBackend,
  ISkillsStore,
  ISkillsStoreProvider,
} from '@mcp-abap-adt/llm-agent';

interface Row { record: SkillRecord; vector: number[]; }
type Embed = (text: string, options?: CallOptions) => Promise<number[]>;

export interface IInMemoryStoreProvider extends ISkillsStoreProvider {
  /** TEST SEAM: write pre-vectorised rows into a generation without an embedder. */
  _seed(generation: string, rows: Row[]): Promise<void>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export function makeInMemoryStoreProvider(opts: { embed?: Embed } = {}): IInMemoryStoreProvider {
  // generations: generationId -> rows
  const gens = new Map<string, Row[]>();
  // catalog
  let catalogRevision = 'c0';
  let entries: CatalogEntry[] = [];
  let genSeq = 0;
  const embed: Embed = opts.embed ?? (async () => { throw new Error('no embedder configured'); });

  const liveGenerationOf = (group: string): string | undefined =>
    entries.find((e) => e.collection.group === group && !e.tombstone)?.generation;

  function backendFor(group: string): ISkillsRagBackend {
    return {
      async activeSnapshot(): Promise<ActiveSnapshot | null> {
        const e = entries.find((x) => x.collection.group === group && !x.tombstone);
        return e ? { revision: e.generation, manifest: e.manifest } : null;
      },
      async queryRevision(revision, vector, k): Promise<readonly SkillHit[]> {
        const rows = gens.get(revision);
        if (!rows) throw new Error(`unknown generation: ${revision}`);
        return rows
          .map((r) => ({ record: r.record, score: cosine(vector, r.vector) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k);
      },
    };
  }

  function storeFor(group: string): ISkillsStore {
    const backend = backendFor(group);
    return {
      ...backend,
      async beginGeneration() {
        const generation = `${group}#g${genSeq++}`;
        gens.set(generation, []);
        return { generation };
      },
      async upsert(generation, records, options) {
        const rows = gens.get(generation) ?? [];
        for (const record of records) {
          rows.push({ record, vector: await embed(record.retrievalText, options) });
        }
        gens.set(generation, rows);
      },
      async carryForward(generation, sourceIds) {
        const live = liveGenerationOf(group);
        if (!live) return;
        const src = new Set(sourceIds);
        const carried = (gens.get(live) ?? []).filter((r) => src.has(r.record.sourceId));
        gens.set(generation, [...(gens.get(generation) ?? []), ...carried]);
      },
      async discardGeneration(generation) {
        // never delete a generation the active catalog names
        if (entries.some((e) => e.generation === generation && !e.tombstone)) return;
        gens.delete(generation);
      },
    };
  }

  return {
    forGroup: storeFor,
    async _seed(generation, rows) {
      gens.set(generation, [...(gens.get(generation) ?? []), ...rows]);
    },
    async readCatalog(): Promise<CatalogSnapshot> {
      return { catalogRevision, entries: entries.filter((e) => !e.tombstone) };
    },
    async publishCatalog(expectedCatalogRevision, next) {
      if (expectedCatalogRevision !== catalogRevision) {
        throw new Error(`stale catalog revision (CAS): expected ${expectedCatalogRevision}, active ${catalogRevision}`);
      }
      entries = [...next];
      catalogRevision = `c${Number(catalogRevision.slice(1)) + 1}`;
    },
    async dropCollection(group) {
      // drop generations not named by an ACTIVE (non-tombstone) entry of this group
      const activeGen = liveGenerationOf(group);
      for (const [gen, rows] of gens) {
        if (gen.startsWith(`${group}#`) && gen !== activeGen) {
          void rows;
          gens.delete(gen);
        }
      }
      // remove tombstoned entries of this group from the catalog records
      entries = entries.filter((e) => !(e.collection.group === group && e.tombstone));
    },
  };
}
```

> In-memory retention is "exact" by virtue of JS references: a `queryRevision` that already obtained `rows` holds the array; `dropCollection`/discard removing the map entry does not invalidate an in-flight read's captured reference. Document this in a comment.

Run the tests — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/in-memory-store.ts packages/llm-agent-libs/src/skills/plugin-host/in-memory-store.test.ts
git commit -m "feat(skills): in-memory store + catalog provider (fenced publishCatalog CAS, no per-collection activate)"
```

---

## Task A5: Compat wrapper `makeCompatibleSkillsRag`

Wraps an `ISkillsRagBackend` + the serving embedder into an `ISkillsRagHandle`: per-revision compat check (cached by revision), embed-LAST/skip-on-incompatible, lazy dimension probe, pinning.

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/compatible-skills-rag.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/compatible-skills-rag.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeCompatibleSkillsRag } from './compatible-skills-rag.js';

const MANIFEST = { embeddingSpaceId: 'sp', dimension: 3, retrievalSchemaVersion: 1 };

function stubBackend(opts: { snapshot: () => Promise<{ revision: string; manifest: typeof MANIFEST } | null>; hits?: unknown[] }) {
  let queryCalls = 0;
  return {
    backend: {
      activeSnapshot: opts.snapshot,
      async queryRevision() { queryCalls++; return (opts.hits ?? []) as never; },
    },
    queryCalls: () => queryCalls,
  };
}

test('compatible revision: embeds once, calls queryRevision', async () => {
  let embeds = 0;
  const sb = stubBackend({ snapshot: async () => ({ revision: 'g0', manifest: MANIFEST }), hits: [{ record: { content: 'x' }, score: 0.9 }] });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: { embed: async () => { embeds++; return { vector: [1, 0, 0] }; } } as never,
    embeddingSpaceId: 'sp', retrievalSchemaVersion: 1, dimension: 3,
  });
  const hits = await rag.query('q', { k: 1, threshold: 0 });
  assert.equal(hits.length, 1);
  assert.equal(embeds, 1);
  assert.equal(sb.queryCalls(), 1);
});

test('incompatible revision: ZERO embeds, empty result', async () => {
  let embeds = 0;
  const sb = stubBackend({ snapshot: async () => ({ revision: 'g0', manifest: { ...MANIFEST, embeddingSpaceId: 'OTHER' } }) });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: { embed: async () => { embeds++; return { vector: [1, 0, 0] }; } } as never,
    embeddingSpaceId: 'sp', retrievalSchemaVersion: 1, dimension: 3,
  });
  const hits = await rag.query('q', { k: 1 });
  assert.equal(hits.length, 0);
  assert.equal(embeds, 0); // embed skipped on incompatible
});

test('null snapshot: ZERO embeds, empty', async () => {
  let embeds = 0;
  const sb = stubBackend({ snapshot: async () => null });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: { embed: async () => { embeds++; return { vector: [1, 0, 0] }; } } as never,
    embeddingSpaceId: 'sp', retrievalSchemaVersion: 1, dimension: 3,
  });
  assert.equal((await rag.query('q', { k: 1 })).length, 0);
  assert.equal(embeds, 0);
});

test('lazy dimension probe: no embed at construction; first activeManifest probes once', async () => {
  let embeds = 0;
  const sb = stubBackend({ snapshot: async () => ({ revision: 'g0', manifest: MANIFEST }) });
  const rag = makeCompatibleSkillsRag({
    backend: sb.backend as never,
    embedder: { embed: async () => { embeds++; return { vector: [1, 0, 0] }; } } as never,
    embeddingSpaceId: 'sp', retrievalSchemaVersion: 1, // dimension undeclared
  });
  assert.equal(embeds, 0); // construction did not embed
  await rag.activeManifest();
  assert.equal(embeds, 1); // one probe
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Implement the wrapper**

```ts
import type {
  CallOptions, ActiveSnapshot, IEmbedder, SkillHit, SkillsEmbeddingDescriptor,
  ISkillsRagBackend, ISkillsRagHandle,
} from '@mcp-abap-adt/llm-agent';

export interface CompatibleSkillsRagDeps {
  backend: ISkillsRagBackend;
  embedder: IEmbedder;
  embeddingSpaceId: string;
  retrievalSchemaVersion: number;
  dimension?: number; // declared → skip probe; else resolved lazily
}

export function makeCompatibleSkillsRag(deps: CompatibleSkillsRagDeps): ISkillsRagHandle {
  let dimension = deps.dimension;
  const verdictByRevision = new Map<string, boolean>();

  const descriptor = (): SkillsEmbeddingDescriptor => ({
    embeddingSpaceId: deps.embeddingSpaceId,
    dimension: dimension as number,
    retrievalSchemaVersion: deps.retrievalSchemaVersion,
  });

  async function ensureDimension(options?: CallOptions): Promise<void> {
    if (dimension === undefined) {
      const probe = await deps.embedder.embed('dimension probe', options);
      dimension = probe.vector.length;
    }
  }

  function compatible(snap: ActiveSnapshot): boolean {
    const cached = verdictByRevision.get(snap.revision);
    if (cached !== undefined) return cached;
    const d = descriptor();
    const ok =
      snap.manifest.embeddingSpaceId === d.embeddingSpaceId &&
      snap.manifest.dimension === d.dimension &&
      snap.manifest.retrievalSchemaVersion === d.retrievalSchemaVersion;
    verdictByRevision.set(snap.revision, ok);
    if (!ok) {
      // loud signal; serving never blocks on this — recall just degrades to empty.
      console.error(`[skills] incompatible generation ${snap.revision}: serving descriptor ${JSON.stringify(d)} != manifest ${JSON.stringify(snap.manifest)}`);
    }
    return ok;
  }

  return {
    async activeManifest(options?: CallOptions): Promise<ActiveSnapshot | null> {
      await ensureDimension(options);
      const snap = await deps.backend.activeSnapshot();
      if (snap) compatible(snap); // eager check (caches verdict)
      return snap;
    },
    async query(text, opts, options?: CallOptions): Promise<readonly SkillHit[]> {
      await ensureDimension(options);
      const snap = await deps.backend.activeSnapshot(); // ONCE
      if (!snap || !compatible(snap)) return []; // no embed on null/incompatible
      const { vector } = await deps.embedder.embed(text, options); // PAID step, last
      const hits = await deps.backend.queryRevision(snap.revision, vector, opts.k, options);
      const threshold = opts.threshold ?? 0.3;
      return hits.filter((h) => h.score >= threshold);
    },
  };
}
```

> Confirm `IEmbedder.embed` returns `{ vector }` (it does per the contract). If `console.error` is undesirable, route through an injected logger — but a plain stderr line is acceptable per the spec ("loud error/metric").

Run — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/compatible-skills-rag.ts packages/llm-agent-libs/src/skills/plugin-host/compatible-skills-rag.test.ts
git commit -m "feat(skills): compat wrapper — per-revision check, embed-last, lazy dimension probe"
```

---

## Task A6: The host `makeSkillPluginHost` — ingest path (load + reconciliation + commit + cleanup + retry)

The orchestrator. This task implements the **ingest-capable** host (sources + store provider). Recall-only is Task A7.

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.ingest.test.ts`

- [ ] **Step 1: Write the failing tests** (build-inactive→single commit, multi-source merge, carry-forward publishes new gen, no-prior omit, tombstone+drop, orphan cleanup on lost CAS, CAS retry, mixed generations)

Write at least these named tests (full bodies — use the in-memory provider + stub sources):

1. `commits all desired collections in ONE publishCatalog` — two sources into `c1`,`c2`; after `load()`, `host.groups()` = `{c1,c2}`, `host.rag('c1').query(...)` returns c1 records; the provider observed exactly ONE `publishCatalog`.
2. `multi-source merge: union records + ownership; conflicting descriptions throw` — two sources both placing into `c1` with the SAME description → merged; with DIFFERENT descriptions → `load()` rejects.
3. `carry-forward publishes a NEW generation` — collection `c1` fed by `s1`(ok)+`s2`(throws on acquire) under strict:false → committed generation contains s1 refreshed + s2 carried; NOT the prior pointer.
4. `first-load build failure with NO prior → omit + partial result` — `c2` build throws and no prior → result.committed=['c1'], result.omitted=[{group:'c2'}], result.ok=false; `host.rag('c2')` serves nothing; c1 commits.
5. `collection-set reconciliation: drop removed collection` — load A `{c1,c2}`, load B `{c1}` → after B groups=`{c1}`, c2 tombstoned + dropped.
6. `lost CAS → discard built gens + retry from fresh snapshot, then commit` — a provider whose first `publishCatalog` throws a CAS error then succeeds → `load()` rebuilds (assert `beginGeneration` called twice) and commits.
7. `exhausted CAS → throw, no orphans` — provider always throws CAS → `load()` rejects; gens map has only pre-existing committed generations.
8. `strict:true source failure → throw, nothing committed`.

Use a `makeStubSource(result | () => throw)` helper and an embed fn `async (t) => ({ vector: hash3(t) })` (a deterministic 3-dim vector from the text) so the in-memory store can embed without a real embedder. Add `hash3` in the test file.

Run — Expected: FAIL.

- [ ] **Step 2: Implement the ingest host**

Implement `makeSkillPluginHost(deps)` where `deps` is the ingest shape:
```ts
export interface IngestHostDeps {
  sources: ReadonlyArray<{ id: string; source: ISkillSource }>;
  storeProvider: ISkillsStoreProvider;
  embedder: IEmbedder; // serving embedder (also used to vectorise upserts via the provider)
  embeddingSpaceId: string;
  retrievalSchemaVersion: number;
  dimension?: number;
  strict?: boolean;
  catalogCasMaxAttempts?: number; // default 3
}
```

Core `load()` algorithm (encode EXACTLY the spec's flow):

```
async load(options):
  registeredSet = this._registeredSet   // set at first successful/attempted load (serving guard); undefined on first
  for attempt in 1..max:
    prior = await storeProvider.readCatalog()
    results = await Promise.allSettled(sources.map(s => s.source.acquire(options)))
    // merge:
    desired = Map<group, {info, sources:Set, records:[]}>
    failedSources = sources where acquire rejected
    for each fulfilled result r (sourceId):
       for c in r.collections: mergeCollection(desired, c, sourceId)  // conflicting description -> throw
       for rec in r.records:
          assert rec.group in r.collections else throw
          desired[rec.group].records.push(rec); desired[rec.group].sources.add(sourceId)
    if strict and failedSources.length: throw   // strict:true → no commit
    // carry-forward (strict:false): for each prior entry owned (partly) by a failed source,
    //   re-add its collection to desired and mark its sourceIds for carryForward
    carryForwardSources = ...
    // SERVING-HOST guard (before any build), and re-checked here on each attempt:
    desiredSet = new Set(desired.keys() ∪ carried-only collections)
    if registeredSet:
       if !setEq(new Set(prior.entries.map(e=>e.collection.group)), registeredSet)
          or !setEq(desiredSet, registeredSet): throw "served collection set changed"
    built = []   // {group, generation}
    try:
      entries = []
      for group in desiredSet:
        store = storeProvider.forGroup(group)
        try:
          {generation} = await store.beginGeneration(); built.push({group,generation})
          await store.upsert(generation, desired[group].records, options)   // embeds retrievalText
          await store.carryForward(generation, [failed sourceIds owning this group])
          entries.push({collection: desired[group].info, sources:[...desired[group].sources], generation, manifest})
        catch buildErr:
          priorGen = prior.entries.find(e=>e.collection.group===group && !e.tombstone)
          if priorGen: entries.push({...priorGen})        // keep prior pointer
          else: omitted.push({group, reason:String(buildErr)})  // OMIT, no prior
      // tombstones for prior active collections not in desiredSet:
      for e in prior.entries: if !desiredSet.has(e.collection.group): entries.push({...e, tombstone:true})
      await storeProvider.publishCatalog(prior.catalogRevision, entries)   // CAS commit
      committed = true
      // AFTER publish: cache the fixed groups() snapshot; register set on first load
      this._snapshot = entries.filter(e=>!e.tombstone).map(e=>e.collection)
      this._registeredSet ??= new Set(this._snapshot.map(c=>c.group))
      // background reclaim (await for determinism in tests): drop tombstoned + superseded gens
      for e in entries.filter(e=>e.tombstone): await storeProvider.dropCollection(e.collection.group)
      return { committed: [...], omitted, tombstoned: [...], ok: omitted.length===0 }
    finally:
      if !committed: for b in built: if !entries-names(b.generation): await storeProvider.forGroup(b.group).discardGeneration(b.generation)
    // if we reach here via a caught CAS error inside publishCatalog: discard all built, loop to retry
  throw "catalog CAS retries exhausted"
```

Translate the pseudocode into real TS. Notes:
- Distinguish a CAS error (retry) from other errors (throw immediately) — match on the provider's CAS error. Define a sentinel: the in-memory provider throws `Error` whose message matches `/CAS|catalog revision/i`; detect with that regex (or, better, a `CatalogCasError` class exported from the contracts — add `export class CatalogCasError extends Error {}` to `skills-rag.ts` and have the in-memory provider throw it; detect with `instanceof`). Prefer the typed class.
- `groups()` returns `this._snapshot` (fixed at load).
- `rag(group?)` returns `makeCompatibleSkillsRag({ backend: storeProvider.forGroup(resolved), embedder, embeddingSpaceId, retrievalSchemaVersion, dimension })`. Resolve `group` default: if `_snapshot` has one entry use it, else throw "must name the group". Unknown group → throw.
- Manifest stamped into entries = the serving descriptor `{ embeddingSpaceId, dimension (resolved), retrievalSchemaVersion }`. Resolve `dimension` once before building (probe via embedder if undeclared) so the manifest is complete.

> Add `CatalogCasError` to `skills-rag.ts` (Task A1) — if you already committed A1, append it in this task and note it in the commit. Update the in-memory provider (Task A4) to `throw new CatalogCasError(...)` instead of a plain Error, and adjust A4's CAS test regex/instanceof accordingly.

Run the tests — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.ts packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.ingest.test.ts packages/llm-agent/src/interfaces/skills-rag.ts packages/llm-agent-libs/src/skills/plugin-host/in-memory-store.ts
git commit -m "feat(skills): ingest host — single fenced commit, merge, carry-forward, omit, CAS retry, orphan cleanup"
```

---

## Task A7: Recall-only host + serving-host reload guard

Adds the recall-only construction shape (`{ backendProvider, serveCollections }`) and the **serving-host reload guard** (both-equality check) on the ingest host.

**Files:**
- Modify: `packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.recall-and-reload.test.ts`

- [ ] **Step 1: Write the failing tests**

1. `recall-only: load() validates serveCollections exist + eager compat; groups() from catalog` — pre-populate an in-memory provider (seed + publishCatalog) then construct a recall-only host over its read view with `serveCollections:['g1']`; `load()` resolves `{committed:['g1'],...,ok:true}`, `host.groups()` = `[{group:'g1',...}]`, `host.rag('g1').query` returns rows.
2. `recall-only: serveCollections naming an absent collection → load() throws`.
3. `recall-only: incompatible serving embeddingSpaceId → load() throws (eager)`.
4. `serving reload same set, new generations → succeeds and rotates`.
5. `serving reload local change (sources resolve a new collection) → throws, no build/publish`.
6. `serving reload OUT-OF-BAND change (active catalog grew) → throws; the externally-added collection is NOT tombstoned` (assert it still serves after the throw).

Run — Expected: FAIL.

- [ ] **Step 2: Implement**

- Add the recall-only deps shape and a `makeSkillPluginHost` overload/union that detects `{ backendProvider }` vs `{ storeProvider, sources }`. Recall-only `load()`:
  - `cat = await backendProvider.readCatalog()`; for each `g in serveCollections`: assert `cat.entries.some(e=>e.collection.group===g)` else throw config error; build `_snapshot`/`_registeredSet` from those entries; for each served group call `rag(g).activeManifest(options)` (eager probe + compat); throw on incompatibility. Return `{committed: serveCollections, omitted:[], tombstoned:[], ok:true}`.
  - `rag(g)` wraps `backendProvider.forGroup(g)`.
- Add the serving guard to the INGEST `load()` (per the pseudocode): once `_registeredSet` is set, on each attempt assert BOTH `setEq(activeSet(prior), registeredSet)` AND `setEq(desiredSet, registeredSet)` BEFORE building; throw a clear error on mismatch. (The guard only applies when `_registeredSet` is defined — i.e. a reload.) Add a host option `servingMode?: boolean` (default true) so an explicit ingest-only job can opt out; when `servingMode===false` the guard is skipped.

Run — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.ts packages/llm-agent-libs/src/skills/plugin-host/skill-plugin-host.recall-and-reload.test.ts
git commit -m "feat(skills): recall-only host + dual-equality serving-host reload guard"
```

---

## Task A8: The `IRag` adapter `skillsRagSource`

Bridges `host.rag(group)` (text) to the context-assembler's `IRag` (IQueryEmbedding). Read-only.

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/skills-rag-source.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/skills-rag-source.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillsRagSource } from './skills-rag-source.js';

test('query uses IQueryEmbedding.text (NOT toVector) and maps SkillHit→RagResult', async () => {
  let usedToVector = false;
  const handle = {
    async query(text: string) {
      assert.equal(text, 'goal-text');
      return [{ record: { id: 'i', name: 'n', content: 'BODY', provenance: 'pv', group: 'g' }, score: 0.91 }];
    },
    async activeManifest() { return { revision: 'g0', manifest: { embeddingSpaceId: 'sp', dimension: 3, retrievalSchemaVersion: 1 } }; },
  };
  const src = skillsRagSource(handle as never, { group: 'g', k: 4, threshold: 0.3 });
  const embedding = { text: 'goal-text', async toVector() { usedToVector = true; return [0, 0, 0]; } };
  const res = await src.query(embedding as never, 4);
  assert.equal(res.ok, true);
  assert.equal(res.value[0].text, 'BODY');
  assert.equal(res.value[0].score, 0.91);
  assert.equal(res.value[0].metadata.id, 'i');
  assert.equal(usedToVector, false); // re-embeds via the skills handle, not the assembler vector
});

test('healthCheck ok when activeManifest resolves; writer undefined; getById ok(null)', async () => {
  const handle = { async query() { return []; }, async activeManifest() { return { revision: 'g', manifest: {} as never }; } };
  const src = skillsRagSource(handle as never, { group: 'g', k: 4 });
  assert.equal((await src.healthCheck()).ok, true);
  assert.equal(src.writer?.(), undefined);
  const byId = await src.getById('x');
  assert.equal(byId.ok, true);
  assert.equal(byId.value, null);
});
```

Run — Expected: FAIL. (Confirm `IRag`, `Result`, `ok`/`err` helpers, `RagResult`, `RagError` import paths from `@mcp-abap-adt/llm-agent` first — `grep -n "export.*ok\b\|export.*err\b\|interface IRag" packages/llm-agent/src/interfaces/*.ts`.)

- [ ] **Step 2: Implement**

```ts
import type {
  CallOptions, IQueryEmbedding, IRag, ISkillsRagHandle, RagError, RagResult, Result,
} from '@mcp-abap-adt/llm-agent';
import { err, ok } from '@mcp-abap-adt/llm-agent'; // adjust to the real Result helpers

export function skillsRagSource(
  handle: ISkillsRagHandle,
  cfg: { group: string; k: number; threshold?: number },
): IRag {
  return {
    async query(embedding: IQueryEmbedding, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>> {
      try {
        const hits = await handle.query(embedding.text, { k: k ?? cfg.k, threshold: cfg.threshold }, options);
        return ok(hits.map((h) => ({
          text: h.record.content,
          score: h.score,
          metadata: { id: h.record.id, group: cfg.group, name: h.record.name, provenance: h.record.provenance },
        })));
      } catch (e) {
        return err({ message: `skills source error: ${String(e)}` } as RagError);
      }
    },
    async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
      try { await handle.activeManifest(options); return ok(undefined); }
      catch (e) { return err({ message: String(e) } as RagError); }
    },
    async getById(): Promise<Result<RagResult | null, RagError>> {
      return ok(null); // best-effort: backend has no by-id read
    },
    writer() { return undefined; },
  };
}
```

> Adjust `ok`/`err`/`RagError` to match the real exports (the codebase uses a `Result` type — find its constructors). If `RagError` is a class/union, construct it correctly.

Run — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/skills-rag-source.ts packages/llm-agent-libs/src/skills/plugin-host/skills-rag-source.test.ts
git commit -m "feat(skills): skillsRagSource IRag adapter (SkillHit→RagResult, re-embeds in skills' space)"
```

---

## Task A9: HTTP fetcher + factory helpers + barrel export

A fetched-source strategy (`ISkillSource`) that pulls a marketplace manifest + `SKILL.md` files over HTTP into memory and runs `buildIngestResult`. Plus a `makeMarketplaceSource` factory and the package barrel export.

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/http-marketplace-source.ts`
- Create: `packages/llm-agent-libs/src/skills/plugin-host/index.ts` (barrel)
- Modify: `packages/llm-agent-libs/src/index.ts` (re-export the plugin-host barrel)
- Test: `packages/llm-agent-libs/src/skills/plugin-host/http-marketplace-source.test.ts`

- [ ] **Step 1: Write the failing test** (mock transport — inject a `fetchJson`/`fetchText` fn; ZERO real network/FS)

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeHttpMarketplaceSource } from './http-marketplace-source.js';

const SKILL_MD = `---\nname: s\ndescription: d\n---\n## H\nbody`;

test('fetches manifest + SKILL.md via injected transport, builds ingest result, zero FS', async () => {
  const src = makeHttpMarketplaceSource({
    source: 'vendor',
    enabled: ['p1'],
    transport: {
      async listPlugins() { return [{ plugin: 'p1', version: '1', skills: ['s'] }]; },
      async fetchSkillMd(plugin, skill) { assert.equal(plugin, 'p1'); assert.equal(skill, 's'); return SKILL_MD; },
    },
    chunk: { maxChars: 1000 },
  });
  const res = await src.acquire();
  assert.deepEqual(res.collections.map((c) => c.group), ['p1']);
  assert.ok(res.records.length >= 1);
});

test('enabled "*" loads every offered plugin; empty enabled is a caller error', async () => {
  const transport = { async listPlugins() { return [{ plugin: 'a', version: '1', skills: ['s'] }, { plugin: 'b', version: '1', skills: ['s'] }]; }, async fetchSkillMd() { return SKILL_MD; } };
  const all = makeHttpMarketplaceSource({ source: 'v', enabled: ['*'], transport, chunk: { maxChars: 1000 } });
  assert.equal((await all.acquire()).collections.length, 2);
  assert.throws(() => makeHttpMarketplaceSource({ source: 'v', enabled: [], transport, chunk: { maxChars: 1000 } }), /enabled/);
});
```

Run — Expected: FAIL.

- [ ] **Step 2: Implement**

`makeHttpMarketplaceSource` validates `enabled` (non-empty; `['*']` = all), filters the transport's `listPlugins()` to enabled, fetches each `SKILL.md`, and calls `buildIngestResult` with placement default = one-group-per-plugin. The `transport` interface (`listPlugins`, `fetchSkillMd`) is injected so the real HTTP impl (using `fetch`) is a thin separate concern; provide a `makeHttpTransport({ registry })` using global `fetch` (no test needed for the thin transport — it is exercised live in Phase C). Export `ISkillSource`-shaped object.

Barrel `index.ts` re-exports: `chunkSkill`, `buildIngestResult`, `makeInMemoryStoreProvider`, `makeCompatibleSkillsRag`, `makeSkillPluginHost`, `skillsRagSource`, `makeHttpMarketplaceSource`, `makeHttpTransport`, and the relevant types.

Run — Expected: PASS.

- [ ] **Step 3: Lint + commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/skills/plugin-host/http-marketplace-source.ts packages/llm-agent-libs/src/skills/plugin-host/index.ts packages/llm-agent-libs/src/index.ts packages/llm-agent-libs/src/skills/plugin-host/http-marketplace-source.test.ts
git commit -m "feat(skills): HTTP marketplace source (mockable transport) + plugin-host barrel"
```

---

# Phase B — wiring (config + integration)

## Task B1: `skills:` config parse + validation

Parse the `skills:` YAML/programmatic block into a normalized config and validate it per the spec's error-handling rules.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/skills-config.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/skills-config.test.ts`

Read `packages/llm-agent-server-libs/src/smart-agent/config.ts` first to match the existing config-parsing style.

- [ ] **Step 1: Write the failing tests** — assert each validation:
  - `mode: explicit` → throws "not yet implemented".
  - persistent store (`store.type: qdrant`) without `embeddingSpaceId` → throws.
  - fetched source with empty/missing `enabled` → throws; `["*"]` ok.
  - duplicate `sourceId` across sources → throws.
  - recall-only (`loadOnStartup:false`) with `serveCollections` naming nothing buildable is deferred to host load() (not a parse error) — but `sources` + `loadOnStartup:false` together → throws; both `sources` and persistent `store` omitted → throws.
  - a clean implicit config parses to a normalized object.

- [ ] **Step 2: Implement `parseSkillsConfig(raw): NormalizedSkillsConfig`** with the validations above. Default `threshold:0.3`, `k:4`, `catalogCasMaxAttempts:3`, `retiredGraceMs:30000`, `chunk.maxChars:1500`, `mode:'implicit'`.

- [ ] **Step 3: Build + test + lint + commit** (`feat(skills): skills config parse + validation`).

---

## Task B2: Assemble a host from config (`buildSkillHostFromConfig`)

Wire normalized config → a concrete `ISkillPluginHost`: resolve the embedder (via `resolveEmbedder`/`prefetchEmbedderFactories` from `llm-agent-rag`), build the store provider (in-memory for this phase; a vector-DB provider is a separate later task), construct sources from config, and return the host (ingest or recall-only).

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/skills-host-factory.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/skills-host-factory.test.ts`

- [ ] **Step 1: Test** — a programmatic `records`-source config (no HTTP) builds a host; `load()` then `host.rag(group).query` returns injected records. Use a stub embedder.
- [ ] **Step 2: Implement** — map config sources to `ISkillSource` (a `records` source wraps pre-supplied records into an `acquire()` that returns them with a derived single-collection catalog and STAMPS the configured `id` onto each record's `sourceId`; a fetched source → `makeHttpMarketplaceSource`). Build `makeInMemoryStoreProvider({ embed })`. Return `makeSkillPluginHost(...)`.
- [ ] **Step 3: Build + test + lint + commit** (`feat(skills): build skill plugin-host from config`).

---

## Task B3: Implicit wiring — register the adapter as a context-assembler IRag source

For assembler pipelines (flat/default, linear), register `skillsRagSource(host.rag(group))` as a source in the SmartAgent's multi-source RAG retrieval, **once at build time** (fixed serving set). Toggle: only when `skills:` is configured.

**Files:**
- Modify: the SmartServer/SmartAgent build composition where RAG sources are assembled (find via `grep -rn "ragResults\|sources\b\|context-assembler\|buildSystemContent" packages/llm-agent-server-libs/src packages/llm-agent-libs/src/context`). Likely `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` or a builder step.
- Test: a focused test that, given a host with one group and a stub assembler that collects `IRag` sources, the skills adapter appears as a registered source and contributes a `RagResult` for a matching query.

- [ ] **Step 1: Test** (stub the assembler's source registry; assert the adapter is added once per enabled group, with the section header e.g. "Relevant Skills").
- [ ] **Step 2: Implement** — at build time, after `host.load()`, for each `host.groups()` register `skillsRagSource(host.rag(g.group), { group: g.group, k, threshold })` into the assembler's source set with a section header. Guard: only for assembler pipelines; skip for the controller (Task B4). Wrap registration so absent `skills:` config = no-op.
- [ ] **Step 3: Build + test + lint + commit** (`feat(skills): implicit wiring — skills adapter as a context-assembler RAG source`).

---

## Task B4: Controller recall hook (the measurement target)

The controller bypasses the assembler, so its planner recalls a configured group and injects a bounded "Relevant skills" block into create-plan/replan. **This is the measurement target.**

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts` (the `callPlan` path — inject a skills block into the system/user prompt before the planner LLM call).
- Modify: the controller factory `packages/llm-agent-server-libs/src/factories/controller-factory.ts` (accept an optional `skillsRecall?: (goal, options) => Promise<string>` dep; build it from the host + `controllerSkillGroup` + `maxInjectChars`).
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.skills.test.ts`

- [ ] **Step 1: Test** — with a stub `skillsRecall` returning a "Relevant skills" block, `callPlan` includes it in the prompt; with skills OFF (no dep) the prompt is byte-identical to the agnostic prompt (the measurement toggle).
- [ ] **Step 2: Implement** — thread an optional `skillsRecall(goal, options): Promise<string>` into the planner. Before the planner LLM call, `const block = skillsRecall ? await skillsRecall(goal, options) : ''` and append it (bounded by `maxInjectChars`, empty → nothing). Build `skillsRecall` in the factory from `host.rag(controllerSkillGroup).query(goal, {k, threshold}, options)` → format hits' `content` into a bounded block. Keep `requires`/instructions English (existing invariant).
- [ ] **Step 3: Build + test + lint + commit** (`feat(skills): controller planner recall hook (configured group, bounded block)`).

---

# Phase C — measurement

## Task C1: Repoint the plan-analysis harness for WITH/WITHOUT

Restore the plan-analysis harness (currently at `/tmp/plan-analysis.ts.bak`) into the controller package and extend it to run the 5 prompts × {incremental, adaptive} with the skills source toggled ON vs OFF, using the REAL host (in-memory store, `sap-abap`+`sap-abap-cds` plugins acquired from a local clone for eval only — never committed).

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/plan-analysis.ts` (from the `.bak`, extended). This is a harness, NOT shipped — exclude it from the package build (`tsconfig` `exclude` or a `// @internal` + ensure it's not imported by `index.ts`). Confirm it does not get bundled.

- [ ] **Step 1:** Restore the harness; add a `withSkills: boolean` flag that, when true, builds an in-memory host from a `records` source (records produced by running the marketplace adapter over a local `sap-skills` clone fetched to `/tmp`), and wires `skillsRecall` into the planner; when false, runs agnostic.
- [ ] **Step 2:** Run both passes for the 5 prompts × {incremental, adaptive}; print a comparison table: does `requires` populate, does incremental produce a valid CDS plan, does the compound-create split stabilise.
- [ ] **Step 3:** This is an eval, not a unit test — no commit of results. Commit only the harness: `chore(skills): plan-analysis harness with WITH/WITHOUT skills toggle`.

- [ ] **Step 4 (REPORT):** Summarise the measured WITH-vs-WITHOUT deltas to the user. This is the decision point for whether to invest in the explicit-mode phase, the vector-DB store, and dag/stepper wiring.

---

## Final verification (after all tasks)

- [ ] Full build: `npm run build` — 0 errors.
- [ ] Lint: `npm run lint:check` — 0 errors.
- [ ] All suites: `npm test` (workspaces) — 0 failures; specifically the new `src/skills/plugin-host/*.test.ts` and `src/smart-agent/skills-*.test.ts`.
- [ ] CHANGELOG entry under `[Unreleased]`: "Skill plugin-host & runtime gnostification (implicit recall for assembler pipelines + controller hook)".
- [ ] Dispatch a final code-reviewer over the whole branch.
- [ ] Use superpowers:finishing-a-development-branch.

---

## Out of scope (this plan) — per the spec's Phasing section

- Vector-DB store provider (Qdrant/HANA/pg) — same `ISkillsStoreProvider` contract, a separate impl.
- dag / stepper implicit recall (same self-assembling pattern as the controller).
- Explicit planner-driven per-step group selection.
- Dynamic collection-SET rotation while serving (set is fixed at load; set change → restart).
- Reworking/retiring the default-pipeline `SkillSelectHandler`.
