# Collection Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every kind of RAG collection an injected indexing + retrieval pair (a *collection profile*): several owner-scoped records per item, collapse back to items, an optional reranker on provider text, a final cut counted in items — with 30.1.0 behaviour unchanged when no profile is set.

**Architecture:** Contracts land in `@mcp-abap-adt/llm-agent` (`src/interfaces/collection-profile.ts`); generic strategies, `StagedRetrieval` (an `IRetrievalStrategy`), `ComposedToolsProfile`, the default compositions (`mcpToolsVariants`) and `SharedItemsProfile` land in `@mcp-abap-adt/llm-agent-libs` (`src/collections/`); a new provider package `@mcp-abap-adt/sap-aicore-decision` ships `SapAiCoreDecisionModel` (Cohere Rerank on SAP AI Core as one more `IDecisionModel`, used by the existing `DecisionReranker`); `SmartAgentBuilder.withToolsProfile` and the server's `rag.profiles` YAML plus `decision.provider: sap-aicore` (server-libs) wire them; the binary's existing `createMakeDecisionModel` gains the `sap-aicore` arm.

**Tech Stack:** TypeScript 6 (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome, npm workspaces monorepo.

**Spec:** `docs/superpowers/specs/2026-10-05-collection-profiles-design.md` (approved 2026-10-05, frozen; amended 2026-10-05 with the user's decisions on Cohere and S1–S9, spec §17.4). **Goal:** `docs/superpowers/goals/2026-10-04-collection-profiles.md` (user-owned; never edited). Executors read the spec section each task cites.

## Global Constraints

- **Nothing changes by default.** No profile set → 30.1.0 behaviour byte for byte: same records (golden test, Task 1), same stages, same k, same `RerankHandler` precedence, same YAML (spec §13).
- **All contract changes additive.** `IRag`, `IReranker`, `IRetrievalStrategy`, `IMetrics` are not changed (spec §3). The only removal is the unexported `packages/llm-agent/src/rag/tool-indexing-strategy.ts` (spec §10.3).
- **Owner in every physical id.** Every profile record id is `recordId(owner, itemId, kind, n)`; no code path addresses a record by the bare `itemId` (spec §3.1).
- **Components carry no tuned number.** Pool sizes, k, `budgetTokens`, `maxValues` are required constructor arguments; tuned numbers live only in `mcpToolsVariants`, each next to its measurement (spec §7.1).
- **`k` is the overall limit, in items.** A retrieval never returns more than `cut.limit(k)` items, with or without a decomposer (spec §4.5).
- **Never silent.** Reranker output errors, decomposer errors, orphans and over-budget cuts are returned or counted (spec §4.8, §4.5, §4.6, §4.10, §9).
- **Shipped tools strategies read only what every MCP server exports** (name, description, input schema); `NameTailFacet` is opt-in and in no variant; `EnumValueToolIndexer` and `TokenBudgetCut` are in no variant (spec §7.0, §7.4).
- **ESM only**, `.js` extensions in relative imports; Biome style (2 spaces, single quotes, semicolons); no `any` (Biome warns); no per-file licence header; every package `LGPL-3.0-only` (spec §11).
- **Library packages declare `@mcp-abap-adt/*` as peers** (`test/repo/scoped-dependencies.test.ts`); only `@mcp-abap-adt/llm-agent-server` takes regular deps.
- **Workspace siblings only.** The new package is linked as a workspace sibling during development; no `file:` / `link:` to anything outside this repo. After any `npm install`, `grep -n '"link": true' package-lock.json` must list only `packages/*` siblings.
- **No version bumps, no `npm publish`, no tag** in this plan — the user publishes; release is a separate step. The new package's `version` is the current lockstep `30.1.0` (not a bump) so the workspace resolves.
- **Imports between packages resolve to `dist/`.** After editing a package another package imports, rebuild it before running the dependent's tests: `npx tsc -b packages/<pkg>` (or `npm run build`).
- **Spec issues S1–S9 are decided** (spec §17.4) and written into the tasks below; no step waits on the user. A NEW gap found while executing goes to the user first — the rule is *fix the spec before the plan*.
- Commits: Conventional Commits, each ending with
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd
  ```

## Review Focus

The five inputs the spec implies, most likely to bite a user, each pinned by a test in its owning task:

1. **Identical `itemId`s across owners** (users A and B both write `case-42` into one `user` store) — two separate items: A's `get` returns A's text and `data`, B's re-index and `remove` leave A untouched, A's retrieval returns only A's item. → Task 17 (`identical item ids across users stay separate`), Task 12 (`collapse keys on the owner-qualified item`).
2. **Canonical record missing** (deleted item, interrupted replacement) — the hit is dropped, never returned with its own text, does not use up k, and is counted. → Task 12 (`a hit without its canonical record is an orphan`), Task 28 (`orphan counted`).
3. **Decomposer overrunning the budget** (Σk > budget, a `k < 1`, empty text, a thrown error) — `DECOMPOSE_ERROR` returned, never a silent fall-back, never more than `budget` items. → Task 14 (`budgets summing above the budget are a DECOMPOSE_ERROR`).
4. **Reranker returning the wrong score count** (fewer/more results, a duplicate, a non-finite score) — `RERANK_ERROR`; `stage1` keeps the stage-1 order, `error` returns the error. → Task 13 (`a reranker that drops a candidate is a RERANK_ERROR`), Task 18 (`SapAiCoreDecisionModel`: a wrong `/rerank` result count is a `DecisionError`, never zero-filled; `DecisionReranker` turns it into `RERANK_ERROR`).
5. **A tool definition larger than the token budget** (top item alone over budget) — empty result, never truncated, never replaced by a smaller lower-ranked tool. → Task 6 (`the top item alone over budget gives an empty result`).

## File Structure

**`packages/llm-agent/src/`** (contracts)
- `interfaces/collection-profile.ts` — NEW: every contract of spec §3.1–§3.6 + `recordId`, `isRetrievalMetrics`.
- `interfaces/retrieval-embedder-owner.ts` — NEW: `IRetrievalEmbedderOwner`, `retrievalEmbedderOf` (spec §3.7).
- `interfaces/index.ts` — export the above.
- `interfaces/health.ts`, `interfaces/metrics.ts`, `interfaces/tool-catalog.ts` — additive optional fields (spec §3.8; `ToolCatalogStatus.records` / `.profile` per S3).
- `interfaces/tool-record-key.ts` — `skillNameFromRecord` (F3).
- `rag/vector-rag.ts` — implements `IRetrievalEmbedderOwner`.
- `rag/tool-indexing-strategy.ts` — DELETED.
- `testing/collection-profile-conformance.ts` — NEW conformance kit; `package.json` `exports` entry.

**`packages/llm-agent-libs/src/collections/`** (NEW directory, small modules)
- `owner.ts` — owner ↔ metadata flattening, item keys.
- `item-pool.ts`, `max-score-collapse.ts`, `cuts.ts`, `token-budget-cut.ts`, `size-estimators.ts` — generic strategies.
- `tools/derive-tool-facets.ts`, `tools/tool-item.ts`, `tools/facets.ts`, `tools/faceted-tool-indexer.ts`, `tools/discriminators.ts`, `tools/enum-value-tool-indexer.ts`, `tools/intent-sources.ts`, `tools/intent-indexers.ts` — tools indexing.
- `record-writer.ts` — id assignment, batch embed + write, replacement, `get`, `remove`.
- `rerank-check.ts`, `staged-retrieval.ts` — the retrieval half.
- `composed-tools-profile.ts`, `tools-binding.ts`, `mcp-tools-variants.ts` — tools profile.
- `shared-items-profile.ts` — shared items profile.
- `index.ts` — exports; re-exported from `src/index.ts`.
- `__tests__/*.test.ts`, `__tests__/collection-profile.typecheck.ts`.

**Other libs files:** `mcp/vectorize-mcp-tools.ts` (profile path, F1), `builder.ts` (`withToolsProfile`), `metrics/in-memory-metrics.ts`, `metrics/noop-metrics.ts`, `retrieval/reranked-retrieval.ts` (telemetry), `health/health-checker.ts`, `pipeline/handlers/skill-select.ts` (F3), `testing/evaluate-retrieval.ts` + `testing/index.ts`.

**`packages/sap-aicore-decision/`** — NEW package (`package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `GPL-3.0.txt`, `src/index.ts`, `src/sap-aicore-decision-model.ts`, `src/map-rerank.ts`, `src/__tests__/fake-fetch.ts`, `src/__tests__/sap-aicore-decision-model.test.ts`, `src/__tests__/decision-reranker-batches.test.ts`).

**`packages/llm-agent-server-libs/src/smart-agent/`** — `profiles-config.ts` (NEW: YAML types), `profiles-config-validator.ts` (NEW), `decision-config.ts` (`provider: 'sap-aicore'`), `resolve-config-sections.ts`, `config.ts`, `config-validator.ts`, `resolve-collection-profiles.ts` (NEW), `smart-server.ts`, `tools-rag-handle.ts` (F2).

**`packages/llm-agent-server/src/composition/`** — `make-decision-model.ts` (the `sap-aicore` arm), `__tests__/make-decision-model-sap-aicore.test.ts` (NEW).

**Provider stores:** `packages/{qdrant-rag,pg-vector-rag,hana-vector-rag}/src/*-rag.ts` — implement `IRetrievalEmbedderOwner` (F1).

**Repo:** root `package.json` (build/clean lists), `scripts/publish-all.sh` (package list — not a publish), `tsconfig.typecheck.json`, `scripts/rag-eval/*`, docs.

---

## Task 0: Worktree setup (no commit)

The worktree has no `node_modules`.

- [ ] **Step 1: Install and build**

Run (from `~/prj/llm-agent/.worktrees/collection-profiles`):
```bash
git pull --ff-only
npm ci
npm run build
```
Expected: exit 0.

- [ ] **Step 2: Baseline is green**

Run: `npm run lint:check && npm run typecheck && npm test`
Expected: all pass. If anything fails on the untouched branch, stop and report it — do not start on a red baseline.

---

## Task 1: Pin the 30.1.0 tool records byte for byte (golden test)

Must land **before** `vectorizeMcpTools` is touched (spec §7.6, §13).

**Files:**
- Create: `packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts`
- Create: `packages/llm-agent-libs/src/__tests__/fixtures/baseline-tool-records.golden.json` (generated in Step 2)

**Interfaces:**
- Consumes: `vectorizeMcpTools(clients, toolsRag, requestLogger, logger)` (existing, `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts`); snapshot `scripts/rag-eval/tools.mcp-abap-adt-16.0.0-readonly-high.json` (`{ source, capturedAt, tools: McpTool[] }`, 218 tools).
- Produces: a golden file every later task must keep green.

- [ ] **Step 1: Write the test**

```ts
// packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts
/**
 * 30.1.0 tool records, byte for byte: id, text and metadata of every record
 * `vectorizeMcpTools` writes WITHOUT a profile (spec §7.6, §13). Regenerate only
 * on a deliberate change: GOLDEN_UPDATE=1 node --import tsx/esm --test <this file>.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  IMcpClient,
  IRag,
  McpTool,
  RagMetadata,
} from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../mcp/vectorize-mcp-tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(
  HERE,
  '../../../../scripts/rag-eval/tools.mcp-abap-adt-16.0.0-readonly-high.json',
);
const GOLDEN = join(HERE, 'fixtures/baseline-tool-records.golden.json');

interface Written {
  id: string;
  text: string;
  metadata: RagMetadata;
}

function recordingStore(written: Written[]): IRag {
  return {
    query: async () => ({ ok: true, value: [] }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
    writer: () => ({
      upsertRaw: async (id, text, metadata) => {
        written.push({ id, text, metadata });
        return { ok: true, value: undefined };
      },
      deleteByIdRaw: async () => ({ ok: true, value: false }),
    }),
  };
}

describe('30.1.0 tool records (golden)', () => {
  it('vectorizeMcpTools without a profile writes exactly the golden records', async () => {
    const { tools } = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
      tools: McpTool[];
    };
    const client: IMcpClient = {
      listTools: async () => ({ ok: true, value: tools }),
      callTool: async () => {
        throw new Error('not called');
      },
    } as unknown as IMcpClient;
    const written: Written[] = [];
    const summary = await vectorizeMcpTools(
      [client],
      recordingStore(written),
      new NoopRequestLogger(),
      undefined,
    );
    assert.equal(summary?.vectorized, tools.length);
    if (process.env.GOLDEN_UPDATE === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(written, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Written[];
    assert.deepEqual(written, golden);
  });
});
```

- [ ] **Step 2: Generate the golden file on the untouched code and check it**

Run:
```bash
mkdir -p packages/llm-agent-libs/src/__tests__/fixtures
GOLDEN_UPDATE=1 node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts
head -12 packages/llm-agent-libs/src/__tests__/fixtures/baseline-tool-records.golden.json
```
Expected: PASS; the first record reads `"id": "tool:GetTableContents"`, `"text": "Tool: GetTableContents — [read-only] Retrieve contents …"`, `"metadata": { "name": "GetTableContents" }`.

- [ ] **Step 3: Run without the update flag**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts packages/llm-agent-libs/src/__tests__/fixtures/baseline-tool-records.golden.json
git commit -m "test(libs): pin the 30.1.0 tool records byte for byte

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 2: Record contracts and `recordId` (llm-agent)

Spec §3.1.

**Files:**
- Create: `packages/llm-agent/src/interfaces/collection-profile.ts`
- Create: `packages/llm-agent/src/interfaces/__tests__/record-id.test.ts`
- Create: `packages/llm-agent/src/interfaces/__tests__/collection-profile.typecheck.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (export block)
- Modify: `tsconfig.typecheck.json` (`include`)

**Interfaces:**
- Consumes: `RagJsonValue` (`interfaces/rag.ts`).
- Produces:
  ```ts
  export type RecordOwner =
    | { readonly scope: 'global' }
    | { readonly scope: 'group'; readonly groupId: string }
    | { readonly scope: 'user'; readonly userId: string }
    | { readonly scope: 'session'; readonly sessionId: string; readonly userId?: string };
  export type ReservedRecordKey = 'id' | 'itemId' | 'recordKind' | 'itemText' | 'profile' | 'generated' | 'recordIds' | 'companionRecordIds' | 'visibility' | 'userId' | 'groupId' | 'sessionId' | 'ttl';
  export interface IndexedRecord { readonly id: string; readonly text: string; readonly itemId: string; readonly recordKind: string; readonly owner: RecordOwner; readonly generated?: true; readonly itemText?: string; readonly metadata?: Readonly<Record<string, RagJsonValue>> & { readonly [K in ReservedRecordKey]?: never } }
  export type RecordDraft = Omit<IndexedRecord, 'id'>;
  export interface ItemRef { readonly itemId: string; readonly owner: RecordOwner }
  export function ownerKeyOf(owner: RecordOwner): string;
  export function recordId(owner: RecordOwner, itemId: string, kind: string, n: number): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent/src/interfaces/__tests__/record-id.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RecordOwner, recordId } from '../collection-profile.js';

const G: RecordOwner = { scope: 'global' };

describe('recordId', () => {
  it('formats every scope (spec §3.1)', () => {
    assert.equal(recordId(G, 'tool:read_file', 'summary', 0), 'g:/tool%3Aread_file#summary:0');
    assert.equal(recordId({ scope: 'group', groupId: 'team-a' }, 'x', 'item', 0), 'grp:team-a/x#item:0');
    assert.equal(recordId({ scope: 'user', userId: 'alice' }, 'case-42', 'item', 0), 'u:alice/case-42#item:0');
    assert.equal(
      recordId({ scope: 'session', sessionId: 's1', userId: 'alice' }, 'x', 'note', 2),
      's:s1/x#note:2',
    );
  });

  it('separators inside the owner key or item id never shift a field', () => {
    const a = recordId({ scope: 'user', userId: 'a/b' }, 'c', 'k', 0);
    const b = recordId({ scope: 'user', userId: 'a' }, 'b/c', 'k', 0);
    assert.notEqual(a, b);
    assert.notEqual(
      recordId(G, 'x#k', 'y', 0),
      recordId(G, 'x', 'k#y', 0),
    );
    assert.notEqual(recordId(G, 'a:1', 'k', 0), recordId(G, 'a', '1:k', 0));
  });

  it('the same itemId under two owners gives disjoint ids', () => {
    assert.notEqual(
      recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0),
      recordId({ scope: 'user', userId: 'B' }, 'case-42', 'item', 0),
    );
  });

  it('ids over 200 characters become h: + 64 hex, stable, at most 255', () => {
    const long = 'x'.repeat(400);
    const id = recordId(G, long, 'full', 0);
    assert.match(id, /^h:[0-9a-f]{64}$/);
    assert.equal(id, recordId(G, long, 'full', 0));
    for (const n of [0, 1, 199, 200, 201, 254, 255, 1000]) {
      assert.ok(recordId(G, 'y'.repeat(n), 'full', 0).length <= 255);
    }
  });

  it('refuses a position that is not a non-negative integer', () => {
    assert.throws(() => recordId(G, 'x', 'k', -1), RangeError);
    assert.throws(() => recordId(G, 'x', 'k', 1.5), RangeError);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/record-id.test.ts`
Expected: FAIL — `Cannot find module '../collection-profile.js'`.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent/src/interfaces/collection-profile.ts
/**
 * Collection profiles — how one kind of collection is filled and searched
 * (spec docs/superpowers/specs/2026-10-05-collection-profiles-design.md §3).
 * Additive contracts; IRag, IReranker, IRetrievalStrategy, IMetrics unchanged.
 */
import { createHash } from 'node:crypto';
import type { RagJsonValue } from './rag.js';

/**
 * Who owns a record and who may see it. `scope` IS the visibility.
 * Flattened by the framework into metadata: `visibility` + the owner key.
 */
export type RecordOwner =
  | { readonly scope: 'global' }
  /** A team or a role, as the consumer defines it. */
  | { readonly scope: 'group'; readonly groupId: string }
  | { readonly scope: 'user'; readonly userId: string }
  | {
      readonly scope: 'session';
      readonly sessionId: string;
      readonly userId?: string;
    };

/**
 * Keys the framework writes; a profile's or writer's extras can never set them.
 * `companionRecordIds` (canonical only): `{ <companion name>: string[] }` — the
 * item's records in each companion store, so remove and replacement reach them (S7).
 */
export type ReservedRecordKey =
  | 'id'
  | 'itemId'
  | 'recordKind'
  | 'itemText'
  | 'profile'
  | 'generated'
  | 'recordIds'
  | 'companionRecordIds'
  | 'visibility'
  | 'userId'
  | 'groupId'
  | 'sessionId'
  | 'ttl';

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
  /** Required: no record without an owner. */
  readonly owner: RecordOwner;
  /** Set on records whose text was generated, never on provider records. */
  readonly generated?: true;
  /** Non-canonical records in an items store: the item text, for the reranker. */
  readonly itemText?: string;
  /** Profile extras (e.g. `name` for tools). Reserved keys cannot be set here. */
  readonly metadata?: Readonly<Record<string, RagJsonValue>> & {
    readonly [K in ReservedRecordKey]?: never;
  };
}

/** What an indexer produces. The physical id is not the indexer's to choose. */
export type RecordDraft = Omit<IndexedRecord, 'id'>;

/** Addresses one item for get / remove. The owner selects the partition AND the record ids. */
export interface ItemRef {
  readonly itemId: string;
  readonly owner: RecordOwner;
}

const SCOPE_CODE: Readonly<Record<RecordOwner['scope'], string>> = {
  global: 'g',
  group: 'grp',
  user: 'u',
  session: 's',
};

/** The owner key that goes into a record id (`session`'s optional userId is not part of it). */
export function ownerKeyOf(owner: RecordOwner): string {
  switch (owner.scope) {
    case 'global':
      return '';
    case 'group':
      return owner.groupId;
    case 'user':
      return owner.userId;
    case 'session':
      return owner.sessionId;
  }
}

const MAX_READABLE_ID = 200;

/**
 * The one id function (spec §3.1). Pure and deterministic; exported so a
 * consumer's own profile uses it too. Ids longer than 200 characters become
 * `h:` + sha256 hex (66 characters) — pg-vector and HANA cap ids at 255.
 */
export function recordId(
  owner: RecordOwner,
  itemId: string,
  kind: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `recordId: n must be a non-negative integer (got ${n})`,
    );
  }
  const readable = `${SCOPE_CODE[owner.scope]}:${encodeURIComponent(
    ownerKeyOf(owner),
  )}/${encodeURIComponent(itemId)}#${encodeURIComponent(kind)}:${n}`;
  return readable.length <= MAX_READABLE_ID
    ? readable
    : `h:${createHash('sha256').update(readable).digest('hex')}`;
}
```

Add to `packages/llm-agent/src/interfaces/index.ts` (after the `retrieval-strategy.js` block):
```ts
export {
  type IndexedRecord,
  type ItemRef,
  ownerKeyOf,
  type RecordDraft,
  type RecordOwner,
  recordId,
  type ReservedRecordKey,
} from './collection-profile.js';
```

- [ ] **Step 4: Write the compile-time checks**

```ts
// packages/llm-agent/src/interfaces/__tests__/collection-profile.typecheck.ts
// Compile-time assertions only: listed in tsconfig.typecheck.json, run by `npm run typecheck`.
// Each @ts-expect-error covers only the line below it; every binding is exported (TS6133).
import type { RecordDraft } from '../collection-profile.js';

export const _ok: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { name: 'n' } };
// @ts-expect-error a record without an owner does not compile
export const _noOwner: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full' };
// @ts-expect-error extras cannot set itemId
export const _itemIdExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { itemId: 'x' } };
// @ts-expect-error extras cannot set visibility
export const _visibilityExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { visibility: 'global' } };
// @ts-expect-error a user owner needs its userId
export const _userNoId: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'user' } };
// @ts-expect-error extras cannot set companionRecordIds (S7)
export const _companionExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { companionRecordIds: {} } };
```

Add `"packages/llm-agent/src/interfaces/__tests__/collection-profile.typecheck.ts"` to `include` in `tsconfig.typecheck.json`. (Biome may reflow the one-line statements: run `npx biome check --write` on the file, then confirm each `@ts-expect-error` still sits directly above a single-line statement; if Biome splits one, add `// biome-ignore format: one statement per @ts-expect-error line` above that statement.)

- [ ] **Step 5: Run tests and the typecheck**

Run:
```bash
node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/record-id.test.ts
npm run typecheck
```
Expected: PASS; typecheck exit 0 (an unused `@ts-expect-error` would fail with TS2578).

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent/src/interfaces
git add packages/llm-agent/src/interfaces tsconfig.typecheck.json
git commit -m "feat(llm-agent): record contracts and the owner-scoped recordId

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 3: Profile, retrieval, tools and shared-item contracts (llm-agent)

Spec §3.2–§3.6, §3.8.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/collection-profile.ts` (append)
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Modify: `packages/llm-agent/src/interfaces/health.ts`, `packages/llm-agent/src/interfaces/metrics.ts`, `packages/llm-agent/src/interfaces/tool-catalog.ts` (additive optional fields)
- Modify: `packages/llm-agent/src/interfaces/__tests__/collection-profile.typecheck.ts` (append)
- Create: `packages/llm-agent/src/interfaces/__tests__/retrieval-metrics.test.ts`
- Create: `packages/llm-agent/src/interfaces/__tests__/capabilities.test.ts` (S1, S6)

**Interfaces:**
- Consumes: `IRag`, `IRetrievalEmbedder`, `IQueryEmbedder`, `RagJsonValue` (`rag.ts`); `IRetrievalStrategy` (`retrieval-strategy.ts`); `IReranker` (`reranker.ts`); `ICounter` (`metrics.ts`); `ITracer` (`tracer.ts`); `CallOptions`, `RagError`, `RagResult`, `Result` (`types.ts`).
- Produces (exact, used by every later task):
  ```ts
  export interface IItemIndexer<TItem> { readonly name: string; readonly maxRecordsPerItem: number; readonly canonicalKind: string; toRecords(item: TItem, options?: CallOptions): Promise<Result<readonly RecordDraft[], RagError>> }
  export interface IndexReport { readonly items: number; readonly indexedItems: number; readonly records: number; readonly failedItems: readonly { readonly itemId: string; readonly reason: string }[]; readonly notes?: readonly ({ readonly itemId: string } & IndexNote)[] }
  export interface IndexNote { readonly note: string; readonly detail?: string }
  export interface IIndexNoteSource<TItem> { notesFor(item: TItem): readonly IndexNote[] }        // S1, optional capability
  export function isIndexNoteSource<TItem>(x: unknown): x is IIndexNoteSource<TItem>;
  export interface BindTarget { readonly key: string }
  export interface CollectionStore extends BindTarget { readonly rag: IRag; readonly companions?: Readonly<Record<string, IRag>> }
  export interface IBoundCollection<TItem> { readonly key: string; readonly profileName: string; readonly rag: IRag; index(items: readonly TItem[], options?: CallOptions): Promise<Result<IndexReport, RagError>>; remove(refs: readonly ItemRef[], options?: CallOptions): Promise<Result<number, RagError>>; get(ref: ItemRef, options?: CallOptions): Promise<Result<RagResult | null, RagError>>; readonly retrieval: IRetrievalStrategy }
  export interface ICollectionProfile<TItem, TTarget extends BindTarget = CollectionStore> { readonly name: string; bind(target: TTarget): IBoundCollection<TItem> }
  export type SourcedHit = RagResult & { readonly source: string };
  export interface CollapsedItem { readonly source: string; readonly owner: RecordOwner; readonly itemId: string; readonly score: number; readonly hits: readonly RagResult[] }
  export interface ICandidatePool { readonly name: string; readonly items: number; recordsToFetch(maxRecordsPerItem: number): number }
  export interface ICollapseRule { readonly name: string; collapse(hits: readonly SourcedHit[]): CollapsedItem[] }
  export interface IItemCut { readonly name: string; limit(requestedK: number): number; cut(items: readonly RagResult[], requestedK: number): RagResult[] }
  export interface IItemSizeEstimator { readonly name: string; estimate(item: RagResult): number }
  export interface ISizeBoundedCut { readonly budgetTokens: number; readonly estimator: IItemSizeEstimator } // S6, optional capability
  export function isSizeBoundedCut(cut: IItemCut): cut is IItemCut & ISizeBoundedCut;
  export interface SubQuery { readonly text: string; readonly k: number }
  export interface IQueryDecomposer { readonly name: string; decompose(text: string, budget: number, options?: CallOptions): Promise<Result<readonly SubQuery[], RagError>> }
  export interface RetrievalSource { readonly name: string; readonly rag: IRag; readonly role: 'items' | 'variants'; readonly itemsOf?: string; readonly options?: CallOptions }
  export interface ISourceSelector { sources(options?: CallOptions): Promise<readonly RetrievalSource[]> }
  export interface IRetrievalMetrics { readonly retrievalOutcome: ICounter }
  export function isRetrievalMetrics(m: unknown): m is IRetrievalMetrics;
  export interface ToolItem { readonly itemId: string; readonly name: string; readonly originalName: string; readonly description: string; readonly parameters: readonly ToolParameter[]; readonly inputSchema: Readonly<Record<string, unknown>>; readonly definitionChars: number }
  export interface ToolParameter { readonly name: string; readonly description?: string; readonly required: boolean; readonly values: readonly ToolParameterValue[] }
  export interface ToolParameterValue { readonly value: string; readonly description?: string }
  export interface IToolFacet { readonly kind: string; derive(tool: ToolItem): string | undefined }
  export interface IDiscriminatorSelector { readonly name: string; select(tool: ToolItem): ToolParameter | undefined }
  export interface IToolIntentSource { readonly name: string; intentsFor(tool: ToolItem, options?: CallOptions): Promise<Result<readonly string[], RagError>> }
  export type SharedItemVisibility = Exclude<RecordOwner, { scope: 'session' }>;
  export interface SharedItem { readonly itemId: string; readonly visibility: SharedItemVisibility; readonly text: string; readonly records?: readonly { readonly kind: string; readonly text: string }[]; readonly data?: RagJsonValue; readonly ttl?: number }
  export interface ISharedItemGroups { readable(options?: CallOptions): Promise<readonly { readonly groupId: string; readonly rag: IRag }[]>; writable(groupId: string, options?: CallOptions): Promise<IRag | undefined> }
  export type SharedItemsStores = BindTarget & { readonly groups?: ISharedItemGroups } & ({ readonly user: IRag; readonly global?: IRag } | { readonly user?: IRag; readonly global: IRag });
  // health / metrics / catalog (additive, optional):
  // HealthComponentStatus.toolCatalog.records?: number; .profile?: string
  // MetricsSnapshot.retrievalOutcome?: CounterSnapshot
  // ToolCatalogStatus.records?: number; .profile?: string   (S3, decided)
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent/src/interfaces/__tests__/retrieval-metrics.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRetrievalMetrics } from '../collection-profile.js';

describe('isRetrievalMetrics', () => {
  it('accepts an object whose retrievalOutcome is a counter', () => {
    assert.equal(isRetrievalMetrics({ retrievalOutcome: { add() {} } }), true);
  });
  it('refuses anything else', () => {
    for (const v of [undefined, null, 1, {}, { retrievalOutcome: {} }, { retrievalOutcome: { add: 1 } }]) {
      assert.equal(isRetrievalMetrics(v), false);
    }
  });
});
```

```ts
// packages/llm-agent/src/interfaces/__tests__/capabilities.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isIndexNoteSource, isSizeBoundedCut } from '../collection-profile.js';

const estimator = { name: 'e', estimate: () => 1 };
const countCut = { name: 'top', limit: (k: number) => k, cut: () => [] };

describe('optional capabilities (S1, S6)', () => {
  it('isIndexNoteSource: an object with a notesFor function', () => {
    assert.equal(isIndexNoteSource({ notesFor: () => [] }), true);
    for (const v of [undefined, null, {}, { notesFor: 1 }]) assert.equal(isIndexNoteSource(v), false);
  });
  it('isSizeBoundedCut: a positive integer budget and an estimator', () => {
    assert.equal(isSizeBoundedCut({ ...countCut, budgetTokens: 100, estimator }), true);
    assert.equal(isSizeBoundedCut(countCut), false);
    assert.equal(isSizeBoundedCut({ ...countCut, budgetTokens: 0, estimator }), false);
    assert.equal(isSizeBoundedCut({ ...countCut, budgetTokens: 100 }), false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/retrieval-metrics.test.ts packages/llm-agent/src/interfaces/__tests__/capabilities.test.ts`
Expected: FAIL — `isRetrievalMetrics`, `isIndexNoteSource`, `isSizeBoundedCut` are not exported.

- [ ] **Step 3: Implement — append to `collection-profile.ts`**

Add these imports at the top of the file (next to the existing ones):
```ts
import type { ICounter } from './metrics.js';
import type { IRag } from './rag.js';
import type { IRetrievalStrategy } from './retrieval-strategy.js';
import type { CallOptions, RagError, RagResult, Result } from './types.js';
```
Append:
```ts
// ---------------------------------------------------------------------------
// §3.2 Indexing half
// ---------------------------------------------------------------------------

/** The indexing strategy. */
export interface IItemIndexer<TItem> {
  readonly name: string;
  /** Upper bound on the records it makes per item (canonical included). Sizes the item pool. */
  readonly maxRecordsPerItem: number;
  /** The kind of the item's canonical record (`full` for tools, `item` for shared items). */
  readonly canonicalKind: string;
  /** Pure mapping item → record drafts. An items-store indexer makes exactly one draft of
   *  `canonicalKind`; a companion (`variants`) indexer makes none. The binding assigns ids. */
  toRecords(
    item: TItem,
    options?: CallOptions,
  ): Promise<Result<readonly RecordDraft[], RagError>>;
}

export interface IndexReport {
  /** Items given. */
  readonly items: number;
  /** Items with every record written. */
  readonly indexedItems: number;
  /** Records written. */
  readonly records: number;
  readonly failedItems: readonly {
    readonly itemId: string;
    readonly reason: string;
  }[];
  /** Not failures, but they changed what was written (e.g. `ambiguous-discriminator`).
   *  Absent when there are none. */
  readonly notes?: readonly ({ readonly itemId: string } & IndexNote)[];
}

/** Something an indexing strategy declined to guess, about one item. */
export interface IndexNote {
  /** e.g. 'ambiguous-discriminator'. */
  readonly note: string;
  /** e.g. the candidate parameter names. */
  readonly detail?: string;
}

/**
 * Optional capability (S1): a strategy with notes about an item. The binding asks
 * every indexer that has it after `toRecords` and copies the notes, with the
 * item's id, into IndexReport.notes. A decorating indexer forwards to what it wraps.
 */
export interface IIndexNoteSource<TItem> {
  /** Pure: the same item always gets the same notes. Empty → nothing to report. */
  notesFor(item: TItem): readonly IndexNote[];
}

export function isIndexNoteSource<TItem>(
  x: unknown,
): x is IIndexNoteSource<TItem> {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { notesFor?: unknown }).notesFor === 'function'
  );
}

// ---------------------------------------------------------------------------
// §3.3 The profile and its binding
// ---------------------------------------------------------------------------

/** What a binding is attached to. Each profile names its own shape. */
export interface BindTarget {
  /** The ragStores key. */
  readonly key: string;
}

/** The tools profile's target: a primary store and optional companions. */
export interface CollectionStore extends BindTarget {
  readonly rag: IRag;
  readonly companions?: Readonly<Record<string, IRag>>;
}

export interface IBoundCollection<TItem> {
  readonly key: string;
  readonly profileName: string;
  /** The store to register under `key` (the retrieval below is applied to it). */
  readonly rag: IRag;
  /** Filling half. Re-indexing writes the new records and deletes the old ones the
   *  canonical no longer lists (`recordIds`). Several writes — NOT atomic. */
  index(
    items: readonly TItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>>;
  /** Delete the records the item's canonical record lists, then the canonical record. */
  remove(
    refs: readonly ItemRef[],
    options?: CallOptions,
  ): Promise<Result<number, RagError>>;
  /** The item whole (its canonical record), or null. Identity-checked against `options`. */
  get(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>>;
  /** Searching half. `k` counts ITEMS. */
  readonly retrieval: IRetrievalStrategy;
}

export interface ICollectionProfile<
  TItem,
  TTarget extends BindTarget = CollectionStore,
> {
  /** 'mcp-tools' | 'shared-items' | a consumer's own. */
  readonly name: string;
  bind(target: TTarget): IBoundCollection<TItem>;
}

// ---------------------------------------------------------------------------
// §3.4 Retrieval parts
// ---------------------------------------------------------------------------

/** A candidate record and the items source it belongs to. */
export type SourcedHit = RagResult & { readonly source: string };

export interface CollapsedItem {
  /** The items source it belongs to. */
  readonly source: string;
  /** Read back from the hits' metadata (visibility + keys). */
  readonly owner: RecordOwner;
  readonly itemId: string;
  /** Per the rule. */
  readonly score: number;
  /** The item's records among the candidates, best first. */
  readonly hits: readonly RagResult[];
}

/** The candidate strategy: how many items stage 1 hands on, and how deep to query for them. */
export interface ICandidatePool {
  readonly name: string;
  /** Items kept per items source after collapse. */
  readonly items: number;
  /** Records to ask one source for, given the indexer's bound on records per item. */
  recordsToFetch(maxRecordsPerItem: number): number;
}

/** Records → items. Key = (items source, owner scope, owner key, itemId) — never the bare
 *  itemId. Output sorted by score, descending. */
export interface ICollapseRule {
  readonly name: string;
  collapse(hits: readonly SourcedHit[]): CollapsedItem[];
}

/** Final cut over the ranked, hydrated items. Applied once; returns a rank-order PREFIX. */
export interface IItemCut {
  readonly name: string;
  /** An UPPER BOUND, in items, on what `cut` returns for `requestedK` — the retrieval's
   *  budget. A cut may stop earlier; it never returns more than this. */
  limit(requestedK: number): number;
  cut(items: readonly RagResult[], requestedK: number): RagResult[];
}

/** How big an item is for the prompt, in (estimated) tokens. */
export interface IItemSizeEstimator {
  readonly name: string;
  /** A non-negative integer. Pure: the same item always gets the same size. */
  estimate(item: RagResult): number;
}

/**
 * Optional capability (S6): a cut bounded by a size budget. StagedRetrieval reads
 * it for `cut.tokens` / `cut.budgetTokens` and `outcome=over_budget`.
 */
export interface ISizeBoundedCut {
  readonly budgetTokens: number;
  /** The estimator the cut sizes items with — the one the telemetry sums. */
  readonly estimator: IItemSizeEstimator;
}

export function isSizeBoundedCut(
  cut: IItemCut,
): cut is IItemCut & ISizeBoundedCut {
  const c = cut as Partial<ISizeBoundedCut>;
  return (
    typeof c.budgetTokens === 'number' &&
    Number.isInteger(c.budgetTokens) &&
    c.budgetTokens > 0 &&
    typeof c.estimator === 'object' &&
    c.estimator !== null &&
    typeof c.estimator.estimate === 'function'
  );
}

/** One sub-query and its share of the budget, in items. */
export interface SubQuery {
  readonly text: string;
  /** Integer ≥ 1. */
  readonly k: number;
}

/** Splits one query into budgeted sub-queries. Injected; none → the query runs as is. */
export interface IQueryDecomposer {
  readonly name: string;
  /** `budget` = the retrieval's limit in items. The sub-queries' `k` must sum to ≤ `budget`.
   *  An empty array = run the query as is with the whole budget. */
  decompose(
    text: string,
    budget: number,
    options?: CallOptions,
  ): Promise<Result<readonly SubQuery[], RagError>>;
}

/** One store a retrieval queries. */
export interface RetrievalSource {
  /** Reported in telemetry: 'primary', 'intents', 'user', 'global', 'group:<id>'. */
  readonly name: string;
  readonly rag: IRag;
  /** 'items': holds canonical records; 'variants': extra records of another source's items. */
  readonly role: 'items' | 'variants';
  /** For 'variants': the items source whose items these records belong to. */
  readonly itemsOf?: string;
  /** The options this source is queried with (its identity filter). */
  readonly options?: CallOptions;
}

/** Which sources a request may query. A profile supplies it; the consumer may replace it. */
export interface ISourceSelector {
  sources(options?: CallOptions): Promise<readonly RetrievalSource[]>;
}

/** A separate small interface (ISP), not a new member of IMetrics. */
export interface IRetrievalMetrics {
  /** Attributes: store, strategy, outcome. */
  readonly retrievalOutcome: ICounter;
}

export function isRetrievalMetrics(m: unknown): m is IRetrievalMetrics {
  if (typeof m !== 'object' || m === null) return false;
  const c = (m as { retrievalOutcome?: unknown }).retrievalOutcome;
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof (c as { add?: unknown }).add === 'function'
  );
}

// ---------------------------------------------------------------------------
// §3.5 Tool items and intents
// ---------------------------------------------------------------------------

/** Read from what ANY MCP server exports (`tools/list`): name, description, inputSchema. */
export interface ToolItem {
  /** The IToolRecordKey output, e.g. `tool:read_file`. */
  readonly itemId: string;
  /** Exposed (namespaced) name → metadata.name. */
  readonly name: string;
  /** Provider's name (pre-namespace); facets derive from it. */
  readonly originalName: string;
  readonly description: string;
  /** Top-level `inputSchema.properties`, in schema order. */
  readonly parameters: readonly ToolParameter[];
  /** The input schema exactly as exported — for a consumer's own strategies. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Characters of JSON { name, description, inputSchema } as exported. */
  readonly definitionChars: number;
}

export interface ToolParameter {
  readonly name: string;
  readonly description?: string;
  /** Listed in `inputSchema.required`. */
  readonly required: boolean;
  /** String values from `enum`, or from `oneOf` / `anyOf` entries with a string `const`. */
  readonly values: readonly ToolParameterValue[];
}

export interface ToolParameterValue {
  readonly value: string;
  readonly description?: string;
}

/** One extra record view of a tool, derived from provider text only. */
export interface IToolFacet {
  /** The record kind, e.g. 'summary'. */
  readonly kind: string;
  /** The record text, or undefined when the provider text yields nothing (no record then). */
  derive(tool: ToolItem): string | undefined;
}

/** Picks a coarse tool's discriminating parameter. Undefined → no per-value records. */
export interface IDiscriminatorSelector {
  readonly name: string;
  select(tool: ToolItem): ToolParameter | undefined;
}

/** Where a tool's intents come from: an LLM, a file generated at deploy, a consumer's own. */
export interface IToolIntentSource {
  readonly name: string;
  /** English intents for one tool. Empty → no intent record. */
  intentsFor(
    tool: ToolItem,
    options?: CallOptions,
  ): Promise<Result<readonly string[], RagError>>;
}

// ---------------------------------------------------------------------------
// §3.6 Shared items
// ---------------------------------------------------------------------------

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
  /** Expiry, epoch seconds → metadata.ttl. The policy is the writer's. */
  readonly ttl?: number;
}

/** The consumer's group partitions (group isolation is the consumer's). */
export interface ISharedItemGroups {
  /** Group stores this request may read — the consumer's authorization. */
  readable(
    options?: CallOptions,
  ): Promise<readonly { readonly groupId: string; readonly rag: IRag }[]>;
  /** The store for writing this group's items; undefined → the write is refused. */
  writable(groupId: string, options?: CallOptions): Promise<IRag | undefined>;
}

/** The shared-items profile's target. At least one of user / global (typed). */
export type SharedItemsStores = BindTarget & {
  readonly groups?: ISharedItemGroups;
} & (
    | { readonly user: IRag; readonly global?: IRag }
    | { readonly user?: IRag; readonly global: IRag }
  );
```

Replace the Task 2 export block in `interfaces/index.ts` with:
```ts
export {
  type BindTarget,
  type CollapsedItem,
  type CollectionStore,
  type IBoundCollection,
  type ICandidatePool,
  type ICollapseRule,
  type ICollectionProfile,
  type IDiscriminatorSelector,
  type IItemCut,
  type IItemIndexer,
  type IItemSizeEstimator,
  type IIndexNoteSource,
  type IndexedRecord,
  type IndexNote,
  type IndexReport,
  type IQueryDecomposer,
  type ISizeBoundedCut,
  isIndexNoteSource,
  isSizeBoundedCut,
  type IRetrievalMetrics,
  type ISharedItemGroups,
  type ISourceSelector,
  type IToolFacet,
  type IToolIntentSource,
  type ItemRef,
  isRetrievalMetrics,
  ownerKeyOf,
  type RecordDraft,
  type RecordOwner,
  recordId,
  type ReservedRecordKey,
  type RetrievalSource,
  type SharedItem,
  type SharedItemsStores,
  type SharedItemVisibility,
  type SourcedHit,
  type SubQuery,
  type ToolItem,
  type ToolParameter,
  type ToolParameterValue,
} from './collection-profile.js';
```

Additive optional fields:
- `interfaces/health.ts`, inside `toolCatalog?: { … }` after `clientFailures: number;`:
  ```ts
      /** Records written (a profile writes several per tool). Absent without a profile. */
      records?: number;
      /** The tools profile's name. Absent without a profile. */
      profile?: string;
  ```
- `interfaces/metrics.ts`, in `MetricsSnapshot` after `toolCacheHitCount: CounterSnapshot;`:
  ```ts
    /** Present when the metrics implement IRetrievalMetrics. Attributes: store, strategy, outcome. */
    retrievalOutcome?: CounterSnapshot;
  ```
- `interfaces/tool-catalog.ts`, in `ToolCatalogStatus` after `complete: boolean;` (**S3**, decided — spec §3.8: required to carry the health fields; additive):
  ```ts
    /** Records written under a tools profile (several per tool). Absent without a profile. */
    records?: number;
    /** The tools profile's name. Absent without a profile. */
    profile?: string;
  ```

- [ ] **Step 4: Append compile-time checks**

Append to `collection-profile.typecheck.ts`:
```ts
import type { IRag } from '../rag.js';
import type { SharedItem, SharedItemsStores } from '../collection-profile.js';

declare const rag: IRag;
export const _userOnly: SharedItemsStores = { key: 'shared', user: rag };
export const _globalOnly: SharedItemsStores = { key: 'shared', global: rag };
// @ts-expect-error neither user nor global
export const _neither: SharedItemsStores = { key: 'shared' };
// @ts-expect-error a shared item cannot have session visibility
export const _sessionItem: SharedItem = { itemId: 'i', text: 't', visibility: { scope: 'session', sessionId: 's' } };
```
(Move the new `import type` lines to the top of the file with the others.)

- [ ] **Step 5: Run**

Run:
```bash
node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/retrieval-metrics.test.ts packages/llm-agent/src/interfaces/__tests__/capabilities.test.ts
npm run typecheck
npx tsc -b packages/llm-agent
```
Expected: PASS; exit 0; build ok.

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent/src/interfaces
git add packages/llm-agent/src/interfaces
git commit -m "feat(llm-agent): collection-profile contracts — binding, retrieval parts, tool items, shared items, note and size-budget capabilities

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 4: `IRetrievalEmbedderOwner` and `retrievalEmbedderOf` (llm-agent)

Spec §3.7, §10.1. The provider packages follow in Task 25.

**Files:**
- Create: `packages/llm-agent/src/interfaces/retrieval-embedder-owner.ts`
- Create: `packages/llm-agent/src/interfaces/__tests__/retrieval-embedder-owner.test.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Modify: `packages/llm-agent/src/rag/vector-rag.ts:51-70`

**Interfaces:**
- Consumes: `IRag`, `IRetrievalEmbedder` (`rag.ts`); `isRagDecorator` (`retrieval-strategy.ts`).
- Produces:
  ```ts
  export interface IRetrievalEmbedderOwner { readonly retrievalEmbedder: IRetrievalEmbedder }
  export function isRetrievalEmbedderOwner(rag: IRag): rag is IRag & IRetrievalEmbedderOwner;
  export function retrievalEmbedderOf(rag: IRag): IRetrievalEmbedder | undefined; // walks IRagDecorator.inner ≤ 16 levels
  // VectorRag: get retrievalEmbedder(): IRetrievalEmbedder
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent/src/interfaces/__tests__/retrieval-embedder-owner.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryRag } from '../../rag/in-memory-rag.js';
import { symmetricEmbedder } from '../../rag/retrieval-embedder.js';
import { VectorRag } from '../../rag/vector-rag.js';
import type { IRag } from '../rag.js';
import { retrievalEmbedderOf } from '../retrieval-embedder-owner.js';

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) });
const decorate = (inner: IRag): IRag => ({
  inner,
  query: (q, k, o) => inner.query(q, k, o),
  healthCheck: (o) => inner.healthCheck(o),
  getById: (id, o) => inner.getById(id, o),
}) as IRag;

describe('retrievalEmbedderOf', () => {
  it('VectorRag exposes its embedder', () => {
    assert.equal(retrievalEmbedderOf(new VectorRag(embedder)), embedder);
  });
  it('walks decorators to the owner', () => {
    assert.equal(retrievalEmbedderOf(decorate(decorate(new VectorRag(embedder)))), embedder);
  });
  it('a store without one → undefined', () => {
    assert.equal(retrievalEmbedderOf(new InMemoryRag()), undefined);
    assert.equal(retrievalEmbedderOf(decorate(new InMemoryRag())), undefined);
  });
  it('stops after 16 levels', () => {
    let rag: IRag = new VectorRag(embedder);
    for (let i = 0; i < 16; i++) rag = decorate(rag);
    assert.equal(retrievalEmbedderOf(rag), undefined);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/retrieval-embedder-owner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent/src/interfaces/retrieval-embedder-owner.ts
import type { IRag, IRetrievalEmbedder } from './rag.js';
import { isRagDecorator } from './retrieval-strategy.js';

/** Optional capability: a store that embeds its own documents exposes its embedder. */
export interface IRetrievalEmbedderOwner {
  readonly retrievalEmbedder: IRetrievalEmbedder;
}

export function isRetrievalEmbedderOwner(
  rag: IRag,
): rag is IRag & IRetrievalEmbedderOwner {
  const e = (rag as Partial<IRetrievalEmbedderOwner>).retrievalEmbedder;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.embedDocument === 'function' &&
    typeof e.embedQuery === 'function'
  );
}

/** The embedder of `rag` or of the first store it decorates (≤ 16 levels, like hasRetrievalStrategy). */
export function retrievalEmbedderOf(rag: IRag): IRetrievalEmbedder | undefined {
  let cur: IRag | undefined = rag;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (isRetrievalEmbedderOwner(cur)) return cur.retrievalEmbedder;
    cur = isRagDecorator(cur) ? cur.inner : undefined;
  }
  return undefined;
}
```

In `vector-rag.ts`: change the import to also bring `IRetrievalEmbedderOwner`:
```ts
import type { IRetrievalEmbedderOwner } from '../interfaces/retrieval-embedder-owner.js';
```
change the class line to `export class VectorRag implements IRag, IRetrievalEmbedderOwner {`, and add after the constructor:
```ts
  /** IRetrievalEmbedderOwner: the embedder this store writes and searches with. */
  get retrievalEmbedder(): IRetrievalEmbedder {
    return this.embedder;
  }
```

Export from `interfaces/index.ts`:
```ts
export {
  type IRetrievalEmbedderOwner,
  isRetrievalEmbedderOwner,
  retrievalEmbedderOf,
} from './retrieval-embedder-owner.js';
```

- [ ] **Step 4: Run**

Run:
```bash
node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/retrieval-embedder-owner.test.ts
npm test --workspace @mcp-abap-adt/llm-agent
npx tsc -b packages/llm-agent
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent/src
git add packages/llm-agent/src
git commit -m "feat(llm-agent): IRetrievalEmbedderOwner capability and retrievalEmbedderOf

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 5: Owner flattening, `ItemPool`, `MaxScoreCollapse` (libs)

Spec §3.1 (flattening), §3.4, §4.4, §4.9.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/owner.ts`
- Create: `packages/llm-agent-libs/src/collections/item-pool.ts`
- Create: `packages/llm-agent-libs/src/collections/max-score-collapse.ts`
- Create: `packages/llm-agent-libs/src/collections/index.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/pool-and-collapse.test.ts`
- Modify: `packages/llm-agent-libs/src/index.ts` (re-export, after the `retrieval/index.js` block)

**Interfaces:**
- Consumes: `RecordOwner`, `ownerKeyOf`, `ICandidatePool`, `ICollapseRule`, `SourcedHit`, `CollapsedItem`, `RagMetadata`, `RagResult` (`@mcp-abap-adt/llm-agent`, Tasks 2–3); `assertPositiveInteger(cls, field, v)` (`src/util/assert-positive-integer.ts`).
- Produces:
  ```ts
  export function ownerMetadata(owner: RecordOwner): Record<string, string>; // visibility + owner keys
  export function ownerFromMetadata(meta: RagMetadata): RecordOwner | undefined; // undefined = malformed
  export function itemKey(source: string, owner: RecordOwner, itemId: string): string;
  export class ItemPool implements ICandidatePool { constructor(items: number); readonly name: 'item-pool'; readonly items: number; recordsToFetch(m: number): number }
  export class MaxScoreCollapse implements ICollapseRule { readonly name: 'max' }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/pool-and-collapse.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RagMetadata, SourcedHit } from '@mcp-abap-adt/llm-agent';
import {
  ItemPool,
  MaxScoreCollapse,
  ownerFromMetadata,
  ownerMetadata,
} from '../index.js';

const hit = (
  source: string,
  itemId: string,
  score: number,
  meta: RagMetadata = { visibility: 'global' },
): SourcedHit => ({
  text: `${itemId}@${score}`,
  metadata: { ...meta, itemId, recordKind: 'x' },
  score,
  source,
});

describe('owner flattening', () => {
  it('round-trips every scope', () => {
    for (const o of [
      { scope: 'global' },
      { scope: 'group', groupId: 'g1' },
      { scope: 'user', userId: 'alice' },
      { scope: 'session', sessionId: 's1' },
      { scope: 'session', sessionId: 's1', userId: 'alice' },
    ] as const) {
      assert.deepEqual(ownerFromMetadata(ownerMetadata(o)), o);
    }
  });
  it('a user record without userId is malformed, not global', () => {
    assert.equal(ownerFromMetadata({ visibility: 'user' }), undefined);
    assert.equal(ownerFromMetadata({}), undefined);
  });
});

describe('ItemPool', () => {
  it('fetches n × maxRecordsPerItem records', () => {
    assert.equal(new ItemPool(30).recordsToFetch(3), 90);
    assert.equal(new ItemPool(30).items, 30);
  });
  it('carries no default: n is required and positive', () => {
    assert.throws(() => new ItemPool(0));
    assert.throws(() => new ItemPool(1.5));
  });
});

describe('MaxScoreCollapse', () => {
  it('one item per (source, owner, itemId), scored by its best record, sorted', () => {
    const out = new MaxScoreCollapse().collapse([
      hit('primary', 'a', 0.4),
      hit('primary', 'b', 0.9),
      hit('primary', 'a', 0.7),
    ]);
    assert.deepEqual(
      out.map((c) => [c.itemId, c.score, c.hits.map((h) => h.score)]),
      [
        ['b', 0.9, [0.9]],
        ['a', 0.7, [0.7, 0.4]],
      ],
    );
  });
  it('collapse keys on the owner-qualified item, never the bare itemId', () => {
    const out = new MaxScoreCollapse().collapse([
      hit('user', 'case-42', 0.8, { visibility: 'user', userId: 'A' }),
      hit('user', 'case-42', 0.7, { visibility: 'user', userId: 'B' }),
      hit('global', 'case-42', 0.6),
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((c) => c.owner),
      [
        { scope: 'user', userId: 'A' },
        { scope: 'user', userId: 'B' },
        { scope: 'global' },
      ],
    );
  });
  it('ties keep first-seen order', () => {
    const out = new MaxScoreCollapse().collapse([
      hit('p', 'x', 0.5),
      hit('p', 'y', 0.5),
    ]);
    assert.deepEqual(
      out.map((c) => c.itemId),
      ['x', 'y'],
    );
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/pool-and-collapse.test.ts`
Expected: FAIL — `Cannot find module '../index.js'`.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/owner.ts
import {
  ownerKeyOf,
  type RagMetadata,
  type RecordOwner,
} from '@mcp-abap-adt/llm-agent';

/** `visibility` + the owner key, as written on every profile record (spec §3.1). */
export function ownerMetadata(owner: RecordOwner): Record<string, string> {
  switch (owner.scope) {
    case 'global':
      return { visibility: 'global' };
    case 'group':
      return { visibility: 'group', groupId: owner.groupId };
    case 'user':
      return { visibility: 'user', userId: owner.userId };
    case 'session':
      return {
        visibility: 'session',
        sessionId: owner.sessionId,
        ...(owner.userId !== undefined ? { userId: owner.userId } : {}),
      };
  }
}

const key = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** The owner a record's metadata names; undefined when malformed (never guessed). */
export function ownerFromMetadata(meta: RagMetadata): RecordOwner | undefined {
  switch (meta.visibility) {
    case 'global':
      return { scope: 'global' };
    case 'group': {
      const groupId = key(meta.groupId);
      return groupId ? { scope: 'group', groupId } : undefined;
    }
    case 'user': {
      const userId = key(meta.userId);
      return userId ? { scope: 'user', userId } : undefined;
    }
    case 'session': {
      const sessionId = key(meta.sessionId);
      if (!sessionId) return undefined;
      const userId = key(meta.userId);
      return userId
        ? { scope: 'session', sessionId, userId }
        : { scope: 'session', sessionId };
    }
    default:
      return undefined;
  }
}

/** The owner-qualified item key within one items source (JSON, so no separator can collide). */
export function itemKey(
  source: string,
  owner: RecordOwner,
  itemId: string,
): string {
  return JSON.stringify([source, owner.scope, ownerKeyOf(owner), itemId]);
}
```

```ts
// packages/llm-agent-libs/src/collections/item-pool.ts
import type { ICandidatePool } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';

/**
 * `n` items per items source (spec §4.4): every item has at most `m` records, so
 * `n × m` records always hold at least `n` distinct items. `n` is required — the
 * library picks no pool size (spec §7.1).
 */
export class ItemPool implements ICandidatePool {
  readonly name = 'item-pool';
  constructor(readonly items: number) {
    assertPositiveInteger('ItemPool', 'items', items);
  }
  recordsToFetch(maxRecordsPerItem: number): number {
    assertPositiveInteger('ItemPool', 'maxRecordsPerItem', maxRecordsPerItem);
    return this.items * maxRecordsPerItem;
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/max-score-collapse.ts
import type {
  CollapsedItem,
  ICollapseRule,
  RagResult,
  RecordOwner,
  SourcedHit,
} from '@mcp-abap-adt/llm-agent';
import { itemKey, ownerFromMetadata } from './owner.js';

interface Group {
  source: string;
  owner: RecordOwner;
  itemId: string;
  hits: RagResult[];
  first: number;
}

/**
 * Item score = its best record's score — the measured winner (spec §2.1);
 * count and RRF are not shipped. Hits without an `itemId` or with a malformed
 * owner are not items: the retrieval handles them before collapse.
 */
export class MaxScoreCollapse implements ICollapseRule {
  readonly name = 'max';
  collapse(hits: readonly SourcedHit[]): CollapsedItem[] {
    const groups = new Map<string, Group>();
    hits.forEach((h, i) => {
      const itemId = h.metadata.itemId;
      const owner = ownerFromMetadata(h.metadata);
      if (typeof itemId !== 'string' || !owner) return;
      const k = itemKey(h.source, owner, itemId);
      let g = groups.get(k);
      if (!g) {
        g = { source: h.source, owner, itemId, hits: [], first: i };
        groups.set(k, g);
      }
      g.hits.push(h);
    });
    return [...groups.values()]
      .map((g) => {
        const sorted = [...g.hits].sort((a, b) => b.score - a.score);
        return { ...g, hits: sorted, score: sorted[0]?.score ?? 0 };
      })
      .sort((a, b) => b.score - a.score || a.first - b.first)
      .map(({ source, owner, itemId, score, hits }) => ({
        source,
        owner,
        itemId,
        score,
        hits,
      }));
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/index.ts
export { ItemPool } from './item-pool.js';
export { MaxScoreCollapse } from './max-score-collapse.js';
export { itemKey, ownerFromMetadata, ownerMetadata } from './owner.js';
```

In `packages/llm-agent-libs/src/index.ts`, after `export * from './retrieval/index.js';`:
```ts
// ---------------------------------------------------------------------------
// Collection profiles
// ---------------------------------------------------------------------------
export * from './collections/index.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/pool-and-collapse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): owner flattening, ItemPool and MaxScoreCollapse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 6: Item cuts and size estimators (libs)

Spec §4.9, §4.10 (incl. `ISizeBoundedCut`, S6); D17, D19.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/cuts.ts`
- Create: `packages/llm-agent-libs/src/collections/size-estimators.ts`
- Create: `packages/llm-agent-libs/src/collections/token-budget-cut.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/cuts.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `IItemCut`, `IItemSizeEstimator`, `ISizeBoundedCut`, `isSizeBoundedCut`, `RagResult`.
- Produces:
  ```ts
  export class TopItemsCut implements IItemCut { readonly name: 'top-items' }            // limit(k) = k
  export class FixedItemsCut implements IItemCut { constructor(k: number); readonly name: 'fixed-items' } // limit = its k
  export class ScoreFloorCut implements IItemCut { constructor(o: { minItems: number; maxItems: number; minScore: number }); readonly name: 'score-floor' } // limit = maxItems
  export class TokenBudgetCut implements IItemCut, ISizeBoundedCut { constructor(o: { budgetTokens: number; maxItems?: number; estimator?: IItemSizeEstimator }); readonly name: 'token-budget'; readonly budgetTokens: number; readonly estimator: IItemSizeEstimator } // limit = maxItems ?? k
  export class ToolDefinitionSizeEstimator implements IItemSizeEstimator { readonly name: 'tool-definition' } // ceil(definitionChars/4), else ceil(text.length/4)
  export class CharsPerTokenEstimator implements IItemSizeEstimator { constructor(charsPerToken: number); readonly name: 'chars-per-token' }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/cuts.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSizeBoundedCut, type RagResult } from '@mcp-abap-adt/llm-agent';
import {
  CharsPerTokenEstimator,
  FixedItemsCut,
  ScoreFloorCut,
  TokenBudgetCut,
  ToolDefinitionSizeEstimator,
  TopItemsCut,
} from '../index.js';

const item = (id: string, score: number, definitionChars?: number): RagResult => ({
  text: id.repeat(4),
  metadata: { id, ...(definitionChars !== undefined ? { definitionChars } : {}) },
  score,
});
const ids = (r: RagResult[]) => r.map((x) => x.metadata.id);
const ranked = [item('a', 0.9), item('b', 0.8), item('c', 0.4), item('d', 0.3)];

describe('count cuts', () => {
  it('TopItemsCut: the caller k', () => {
    const c = new TopItemsCut();
    assert.equal(c.limit(3), 3);
    assert.deepEqual(ids(c.cut(ranked, 2)), ['a', 'b']);
  });
  it('FixedItemsCut ignores the caller k', () => {
    const c = new FixedItemsCut(3);
    assert.equal(c.limit(20), 3);
    assert.deepEqual(ids(c.cut(ranked, 20)), ['a', 'b', 'c']);
    assert.throws(() => new FixedItemsCut(0));
  });
  it('ScoreFloorCut: minItems, then up to maxItems while score ≥ minScore', () => {
    const c = new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0.5 });
    assert.equal(c.limit(20), 3);
    assert.deepEqual(ids(c.cut(ranked, 20)), ['a', 'b']);
    assert.deepEqual(
      ids(new ScoreFloorCut({ minItems: 3, maxItems: 3, minScore: 0.95 }).cut(ranked, 20)),
      ['a', 'b', 'c'],
    );
    assert.throws(() => new ScoreFloorCut({ minItems: 4, maxItems: 3, minScore: 0 }));
  });
});

describe('TokenBudgetCut', () => {
  const tools = [item('a', 0.9, 400), item('b', 0.8, 400), item('c', 0.7, 40)]; // 100, 100, 10 tokens
  it('a rank-order prefix while the summed size fits', () => {
    const c = new TokenBudgetCut({ budgetTokens: 200 });
    assert.deepEqual(ids(c.cut(tools, 20)), ['a', 'b']);
  });
  it('stops at the first item that does not fit — no skip-ahead (D19)', () => {
    const c = new TokenBudgetCut({ budgetTokens: 150 });
    assert.deepEqual(ids(c.cut(tools, 20)), ['a']);
  });
  it('the top item alone over budget gives an empty result (D17), never truncated', () => {
    const c = new TokenBudgetCut({ budgetTokens: 50 });
    assert.deepEqual(c.cut(tools, 20), []);
  });
  it('maxItems ?? requestedK is the ceiling and the limit', () => {
    assert.equal(new TokenBudgetCut({ budgetTokens: 999 }).limit(2), 2);
    assert.deepEqual(ids(new TokenBudgetCut({ budgetTokens: 999 }).cut(tools, 2)), ['a', 'b']);
    const c = new TokenBudgetCut({ budgetTokens: 999, maxItems: 1 });
    assert.equal(c.limit(20), 1);
    assert.deepEqual(ids(c.cut(tools, 20)), ['a']);
  });
  it('returns items unchanged (never truncated)', () => {
    const out = new TokenBudgetCut({ budgetTokens: 999 }).cut(tools, 20);
    assert.equal(out[0], tools[0]);
  });
  it('carries no default budget', () => {
    assert.throws(() => new TokenBudgetCut({ budgetTokens: 0 }));
    assert.throws(() => new TokenBudgetCut({ budgetTokens: 10, maxItems: 0 }));
  });
  it('is an ISizeBoundedCut (S6); the count cuts are not', () => {
    const estimator = new CharsPerTokenEstimator(3);
    const c = new TokenBudgetCut({ budgetTokens: 200, estimator });
    assert.equal(isSizeBoundedCut(c), true);
    assert.equal(c.budgetTokens, 200);
    assert.equal(c.estimator, estimator);
    for (const count of [new TopItemsCut(), new FixedItemsCut(3), new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0 })]) {
      assert.equal(isSizeBoundedCut(count), false);
    }
  });
});

describe('size estimators', () => {
  it('ToolDefinitionSizeEstimator reads definitionChars, else text length', () => {
    const e = new ToolDefinitionSizeEstimator();
    assert.equal(e.estimate(item('a', 1, 401)), 101);
    assert.equal(e.estimate({ text: 'x'.repeat(9), metadata: {}, score: 1 }), 3);
  });
  it('CharsPerTokenEstimator', () => {
    assert.equal(new CharsPerTokenEstimator(3).estimate({ text: 'x'.repeat(10), metadata: {}, score: 1 }), 4);
    assert.throws(() => new CharsPerTokenEstimator(0));
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/cuts.test.ts`
Expected: FAIL — `TopItemsCut` not exported.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/cuts.ts
import type { IItemCut, RagResult } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';

/** The caller's k, in items (the default cut). */
export class TopItemsCut implements IItemCut {
  readonly name = 'top-items';
  limit(requestedK: number): number {
    return requestedK;
  }
  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    return items.slice(0, requestedK);
  }
}

/** Ignores the caller's k — for a store whose profile owns k. */
export class FixedItemsCut implements IItemCut {
  readonly name = 'fixed-items';
  constructor(readonly k: number) {
    assertPositiveInteger('FixedItemsCut', 'k', k);
  }
  limit(): number {
    return this.k;
  }
  cut(items: readonly RagResult[]): RagResult[] {
    return items.slice(0, this.k);
  }
}

/** First `minItems`, then more up to `maxItems` while `score ≥ minScore`. */
export class ScoreFloorCut implements IItemCut {
  readonly name = 'score-floor';
  constructor(
    readonly opts: { minItems: number; maxItems: number; minScore: number },
  ) {
    if (!Number.isInteger(opts.minItems) || opts.minItems < 0) {
      throw new Error(
        `ScoreFloorCut: minItems must be a non-negative integer (got ${opts.minItems})`,
      );
    }
    assertPositiveInteger('ScoreFloorCut', 'maxItems', opts.maxItems);
    if (opts.minItems > opts.maxItems) {
      throw new Error('ScoreFloorCut: minItems must not exceed maxItems');
    }
    if (!Number.isFinite(opts.minScore)) {
      throw new Error('ScoreFloorCut: minScore must be a finite number');
    }
  }
  limit(): number {
    return this.opts.maxItems;
  }
  cut(items: readonly RagResult[]): RagResult[] {
    const out: RagResult[] = [];
    for (const it of items) {
      if (out.length >= this.opts.maxItems) break;
      if (out.length >= this.opts.minItems && it.score < this.opts.minScore) {
        break;
      }
      out.push(it);
    }
    return out;
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/size-estimators.ts
import type { IItemSizeEstimator, RagResult } from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';

/** ~4 chars per token — the unit DecisionReranker already budgets in. */
const CHARS_PER_TOKEN = 4;

/** Tools: the definition the LLM receives (`metadata.definitionChars`), else the text. */
export class ToolDefinitionSizeEstimator implements IItemSizeEstimator {
  readonly name = 'tool-definition';
  estimate(item: RagResult): number {
    const dc = item.metadata.definitionChars;
    const chars =
      typeof dc === 'number' && Number.isFinite(dc) && dc >= 0
        ? dc
        : item.text.length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
}

/** Shared items and other kinds: the returned text is what reaches the prompt. */
export class CharsPerTokenEstimator implements IItemSizeEstimator {
  readonly name = 'chars-per-token';
  constructor(readonly charsPerToken: number) {
    assertPositiveInteger(
      'CharsPerTokenEstimator',
      'charsPerToken',
      charsPerToken,
    );
  }
  estimate(item: RagResult): number {
    return Math.ceil(item.text.length / this.charsPerToken);
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/token-budget-cut.ts
import type {
  IItemCut,
  IItemSizeEstimator,
  ISizeBoundedCut,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { ToolDefinitionSizeEstimator } from './size-estimators.js';

/**
 * A prompt-size GUARD (spec §4.10), in no default composition: whole items in
 * rank order while their summed size ≤ `budgetTokens`, at most
 * `maxItems ?? requestedK`. Stops at the first item that does not fit (D19);
 * never truncates; the top item alone over budget → empty (D17). Implements
 * ISizeBoundedCut (S6), so StagedRetrieval reports its tokens and over_budget.
 */
export class TokenBudgetCut implements IItemCut, ISizeBoundedCut {
  readonly name = 'token-budget';
  readonly budgetTokens: number;
  readonly maxItems: number | undefined;
  readonly estimator: IItemSizeEstimator;

  constructor(opts: {
    budgetTokens: number;
    maxItems?: number;
    estimator?: IItemSizeEstimator;
  }) {
    assertPositiveInteger('TokenBudgetCut', 'budgetTokens', opts.budgetTokens);
    if (opts.maxItems !== undefined) {
      assertPositiveInteger('TokenBudgetCut', 'maxItems', opts.maxItems);
    }
    this.budgetTokens = opts.budgetTokens;
    this.maxItems = opts.maxItems;
    this.estimator = opts.estimator ?? new ToolDefinitionSizeEstimator();
  }

  limit(requestedK: number): number {
    return this.maxItems ?? requestedK;
  }

  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    const max = this.limit(requestedK);
    const out: RagResult[] = [];
    let used = 0;
    for (const it of items) {
      if (out.length >= max) break;
      const size = this.estimator.estimate(it);
      if (used + size > this.budgetTokens) break;
      used += size;
      out.push(it);
    }
    return out;
  }
}
```

Append to `collections/index.ts`:
```ts
export { FixedItemsCut, ScoreFloorCut, TopItemsCut } from './cuts.js';
export {
  CharsPerTokenEstimator,
  ToolDefinitionSizeEstimator,
} from './size-estimators.js';
export { TokenBudgetCut } from './token-budget-cut.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/cuts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): item cuts (top, fixed, score-floor, token-budget) and size estimators

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 7: Tool facet derivation and `ToolItem` from an exported tool (libs)

Spec §3.5, §7.0, §7.3.1 (deterministic derivation), §7.6 (reading the schema generically), §14.1.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/tools/derive-tool-facets.ts`
- Create: `packages/llm-agent-libs/src/collections/tools/tool-item.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/derive-tool-facets.test.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/tool-item.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `ToolItem`, `ToolParameter`, `ToolParameterValue`.
- Produces:
  ```ts
  export function nameWords(name: string): string;   // camelCase / acronym / _ - . / digit split, lowercased
  export function valueWords(value: string): string; // = nameWords
  export function firstClause(description: string): string; // leading [..] tag dropped; up to . ; : \n; ≤ 200 chars
  export function toolItemFromTool(tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }, ids: { itemId: string; originalName: string }): ToolItem;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/llm-agent-libs/src/collections/__tests__/derive-tool-facets.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstClause, nameWords, valueWords } from '../index.js';

describe('nameWords — several naming styles, none privileged', () => {
  const table: Array<[string, string]> = [
    ['read_file', 'read file'],
    ['listPullRequests', 'list pull requests'],
    ['search-issues', 'search issues'],
    ['db.query', 'db query'],
    ['v2Fetch', 'v 2 fetch'],
    ['fetch', 'fetch'],
    // labelled mcp-abap-adt examples
    ['GetWhereUsed', 'get where used'],
    ['GetATCFindings', 'get atc findings'],
    ['RuntimeListFeeds', 'runtime list feeds'],
  ];
  for (const [input, want] of table) {
    it(`${input} → ${want}`, () => assert.equal(nameWords(input), want));
  }
  it('value words use the same split', () => {
    assert.equal(valueWords('BEHAVIOR_DEFINITION'), 'behavior definition');
  });
});

describe('firstClause', () => {
  it('up to the first . ; : or newline', () => {
    assert.equal(firstClause('Read a file. Returns its text'), 'Read a file');
    assert.equal(firstClause('List items; paged'), 'List items');
    assert.equal(firstClause('Search: by text'), 'Search');
    assert.equal(firstClause('Line one\nLine two'), 'Line one');
  });
  it('drops a leading bracketed tag (example: mcp-abap-adt [read-only])', () => {
    assert.equal(
      firstClause('[read-only] Retrieve contents of a table. Returns rows'),
      'Retrieve contents of a table',
    );
  });
  it('empty or tag-only description → empty', () => {
    assert.equal(firstClause(''), '');
    assert.equal(firstClause('[read-only]'), '');
  });
  it('at most 200 characters', () => {
    assert.equal(firstClause('x'.repeat(300)).length, 200);
  });
});
```

```ts
// packages/llm-agent-libs/src/collections/__tests__/tool-item.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolItemFromTool } from '../index.js';

describe('toolItemFromTool — any server, generic schema read', () => {
  const tool = {
    name: 'files__read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file. Absolute' },
        encoding: { type: 'string', enum: ['utf8', 'latin1', 3] },
        mode: {
          oneOf: [
            { const: 'text', description: 'As text' },
            { const: 'binary', title: 'Raw bytes' },
            { type: 'number' },
          ],
        },
      },
      required: ['path'],
    },
  };
  const item = toolItemFromTool(tool, { itemId: 'tool:read_file', originalName: 'read_file' });

  it('names, ids and description', () => {
    assert.equal(item.itemId, 'tool:read_file');
    assert.equal(item.name, 'files__read_file');
    assert.equal(item.originalName, 'read_file');
    assert.equal(item.description, 'Read a file');
  });
  it('parameters in schema order with required, descriptions and string values', () => {
    assert.deepEqual(item.parameters, [
      { name: 'path', description: 'Path of the file. Absolute', required: true, values: [] },
      { name: 'encoding', required: false, values: [{ value: 'utf8' }, { value: 'latin1' }] },
      {
        name: 'mode',
        required: false,
        values: [
          { value: 'text', description: 'As text' },
          { value: 'binary', description: 'Raw bytes' },
        ],
      },
    ]);
  });
  it('keeps the raw schema and the definition size', () => {
    assert.equal(item.inputSchema, tool.inputSchema);
    assert.equal(
      item.definitionChars,
      JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }).length,
    );
  });
  it('a tool without a schema has no parameters', () => {
    const bare = toolItemFromTool({ name: 'ping' }, { itemId: 'tool:ping', originalName: 'ping' });
    assert.deepEqual(bare.parameters, []);
    assert.equal(bare.description, '');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/derive-tool-facets.test.ts packages/llm-agent-libs/src/collections/__tests__/tool-item.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/tools/derive-tool-facets.ts
/**
 * Deterministic, server-agnostic word derivation (spec §7.3.1). Every word comes
 * from the provider: no lexicon, no synonyms, no LLM, no assumed word order.
 */

/** Split a name on camelCase, acronym, `_`, `-`, `.` and digit boundaries; lowercase. */
export function nameWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
    .join(' ');
}

/** An enum value's words — the same split as a name. */
export function valueWords(value: string): string {
  return nameWords(value);
}

const MAX_CLAUSE = 200;

/** The description up to the first `.`, `;`, `:` or newline, without a leading `[...]` tag. */
export function firstClause(description: string): string {
  const untagged = description.replace(/^\s*\[[^\]]*\]\s*/, '');
  const end = untagged.search(/[.;:\n]/);
  const clause = (end === -1 ? untagged : untagged.slice(0, end)).trim();
  return clause.slice(0, MAX_CLAUSE);
}
```

```ts
// packages/llm-agent-libs/src/collections/tools/tool-item.ts
import type {
  ToolItem,
  ToolParameter,
  ToolParameterValue,
} from '@mcp-abap-adt/llm-agent';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function readValues(p: Obj): ToolParameterValue[] {
  if (Array.isArray(p.enum)) {
    return p.enum
      .filter((v): v is string => typeof v === 'string')
      .map((value) => ({ value }));
  }
  const alts = Array.isArray(p.oneOf)
    ? p.oneOf
    : Array.isArray(p.anyOf)
      ? p.anyOf
      : [];
  const out: ToolParameterValue[] = [];
  for (const a of alts) {
    if (!isObj(a) || typeof a.const !== 'string') continue;
    const description = str(a.description) ?? str(a.title);
    out.push({ value: a.const, ...(description ? { description } : {}) });
  }
  return out;
}

function readParameters(schema: Obj): ToolParameter[] {
  const props = isObj(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === 'string')
      : [],
  );
  return Object.entries(props).map(([name, raw]) => {
    const p = isObj(raw) ? raw : {};
    const description = str(p.description);
    return {
      name,
      ...(description ? { description } : {}),
      required: required.has(name),
      values: readValues(p),
    };
  });
}

/**
 * A ToolItem from what ANY MCP server exports (spec §3.5, §7.6): top-level
 * `properties`, `required`, string `enum` / `const` values. No server is special-cased.
 */
export function toolItemFromTool(
  tool: { name: string; description?: string; inputSchema?: Obj },
  ids: { itemId: string; originalName: string },
): ToolItem {
  const description = tool.description ?? '';
  const inputSchema = tool.inputSchema ?? {};
  return {
    itemId: ids.itemId,
    name: tool.name,
    originalName: ids.originalName,
    description,
    parameters: readParameters(inputSchema),
    inputSchema,
    definitionChars: JSON.stringify({
      name: tool.name,
      description,
      inputSchema,
    }).length,
  };
}
```

Append to `collections/index.ts`:
```ts
export {
  firstClause,
  nameWords,
  valueWords,
} from './tools/derive-tool-facets.js';
export { toolItemFromTool } from './tools/tool-item.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/derive-tool-facets.test.ts packages/llm-agent-libs/src/collections/__tests__/tool-item.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): server-agnostic tool word derivation and ToolItem from tools/list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 8: Facets and `FacetedToolIndexer` (libs)

Spec §7.3.1, §7.0.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/tools/facets.ts`
- Create: `packages/llm-agent-libs/src/collections/tools/faceted-tool-indexer.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `nameWords`, `firstClause`, `valueWords`, `toolItemFromTool` (Task 7); `IItemIndexer`, `IToolFacet`, `RecordDraft`, `ToolItem`.
- Produces:
  ```ts
  export class SummaryFacet implements IToolFacet { readonly kind: 'summary' }
  export class ParametersFacet implements IToolFacet { readonly kind: 'parameters' }
  export class NameTailFacet implements IToolFacet { readonly kind: 'name-tail' } // opt-in, convention-dependent
  export function fullToolText(tool: ToolItem): string; // `Tool: <name> — <description>` + `\nParameters: a, b`
  export class FacetedToolIndexer implements IItemIndexer<ToolItem> { constructor(facets: readonly IToolFacet[]); readonly name: 'faceted'; readonly canonicalKind: 'full'; readonly maxRecordsPerItem: number /* 1 + facets */; readonly facets: readonly IToolFacet[] }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FacetedToolIndexer,
  NameTailFacet,
  ParametersFacet,
  SummaryFacet,
  toolItemFromTool,
} from '../index.js';

const tool = toolItemFromTool(
  {
    name: 'gh__listPullRequests',
    description: '[beta] List pull requests of a repo. Paged',
    inputSchema: {
      properties: {
        repo_name: { type: 'string', description: 'Repository; owner/name' },
        state: { type: 'string', enum: ['OPEN', 'MERGED_ALL'] },
      },
      required: ['repo_name'],
    },
  },
  { itemId: 'tool:listPullRequests', originalName: 'listPullRequests' },
);

describe('facets — provider text only', () => {
  it('SummaryFacet: name words — first clause', () => {
    assert.equal(new SummaryFacet().derive(tool), 'list pull requests — List pull requests of a repo');
  });
  it('SummaryFacet: no first clause → no record', () => {
    assert.equal(new SummaryFacet().derive({ ...tool, description: '[tag]' }), undefined);
  });
  it('ParametersFacet: schema order, first clause of each description, value words', () => {
    assert.equal(
      new ParametersFacet().derive(tool),
      'list pull requests — repo name (Repository); state: open, merged all',
    );
  });
  it('ParametersFacet: no parameters → no record', () => {
    assert.equal(new ParametersFacet().derive({ ...tool, parameters: [] }), undefined);
  });
  it('NameTailFacet: verb-first, object-first, single-word (documents its convention)', () => {
    const f = new NameTailFacet();
    assert.equal(f.derive({ ...tool, originalName: 'GetClass' }), 'class');
    assert.equal(f.derive({ ...tool, originalName: 'class_get' }), 'get');
    assert.equal(f.derive({ ...tool, originalName: 'fetch' }), undefined);
  });
});

describe('FacetedToolIndexer', () => {
  const indexer = new FacetedToolIndexer([new SummaryFacet(), new ParametersFacet()]);

  it('full is canonical and always written; facets carry itemText', async () => {
    const r = await indexer.toRecords(tool);
    assert.ok(r.ok);
    const [full, ...rest] = r.value;
    assert.equal(full.recordKind, 'full');
    assert.equal(
      full.text,
      'Tool: gh__listPullRequests — [beta] List pull requests of a repo. Paged\nParameters: repo_name, state',
    );
    assert.deepEqual(full.owner, { scope: 'global' });
    assert.deepEqual(full.metadata, { name: 'gh__listPullRequests', definitionChars: tool.definitionChars });
    assert.equal(full.itemText, undefined);
    assert.deepEqual(rest.map((d) => d.recordKind), ['summary', 'parameters']);
    for (const d of rest) {
      assert.equal(d.itemText, full.text);
      assert.equal(d.itemId, 'tool:listPullRequests');
      assert.equal(d.generated, undefined);
    }
  });
  it('maxRecordsPerItem = 1 + facets, and bounds what it writes', async () => {
    assert.equal(indexer.maxRecordsPerItem, 3);
    const r = await indexer.toRecords(tool);
    assert.ok(r.ok && r.value.length <= indexer.maxRecordsPerItem);
  });
  it('full only: FacetedToolIndexer([])', async () => {
    const r = await new FacetedToolIndexer([]).toRecords(tool);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((d) => d.recordKind), ['full']);
  });
  it('a tool without parameters has no Parameters line', async () => {
    const r = await new FacetedToolIndexer([]).toRecords({ ...tool, parameters: [] });
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'Tool: gh__listPullRequests — [beta] List pull requests of a repo. Paged');
  });
  it('refuses a facet named full or two facets of one kind', () => {
    assert.throws(() => new FacetedToolIndexer([{ kind: 'full', derive: () => 'x' }]));
    assert.throws(() => new FacetedToolIndexer([new SummaryFacet(), new SummaryFacet()]));
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/tools/facets.ts
import type { IToolFacet, ToolItem } from '@mcp-abap-adt/llm-agent';
import { firstClause, nameWords, valueWords } from './derive-tool-facets.js';

/** `<name words> — <first clause of description>` (the measured `operation` record, renamed). */
export class SummaryFacet implements IToolFacet {
  readonly kind = 'summary';
  derive(tool: ToolItem): string | undefined {
    const clause = firstClause(tool.description);
    return clause ? `${nameWords(tool.originalName)} — ${clause}` : undefined;
  }
}

/** What the tool acts on, from the input SCHEMA (spec §7.3.1). Not yet measured (D16). */
export class ParametersFacet implements IToolFacet {
  readonly kind = 'parameters';
  derive(tool: ToolItem): string | undefined {
    if (tool.parameters.length === 0) return undefined;
    const parts = tool.parameters.map((p) => {
      const clause = p.description ? firstClause(p.description) : '';
      const values = p.values.map((v) => valueWords(v.value)).join(', ');
      return (
        nameWords(p.name) +
        (clause ? ` (${clause})` : '') +
        (values ? `: ${values}` : '')
      );
    });
    return `${nameWords(tool.originalName)} — ${parts.join('; ')}`;
  }
}

/**
 * OPT-IN, convention-dependent (spec §7.3.1): the name words after the first
 * one. On verb-first names (`GetClass`) that is the object; on object-first
 * names it is the operation; on single-word names nothing. In no variant.
 */
export class NameTailFacet implements IToolFacet {
  readonly kind = 'name-tail';
  derive(tool: ToolItem): string | undefined {
    const words = nameWords(tool.originalName).split(' ');
    return words.length >= 2 ? words.slice(1).join(' ') : undefined;
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/tools/faceted-tool-indexer.ts
import type {
  IItemIndexer,
  IToolFacet,
  RagError,
  RecordDraft,
  Result,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';

const GLOBAL = { scope: 'global' } as const;

/** The canonical `full` text: the provider text (spec §7.3.1). */
export function fullToolText(tool: ToolItem): string {
  const head = `Tool: ${tool.name} — ${tool.description}`;
  return tool.parameters.length > 0
    ? `${head}\nParameters: ${tool.parameters.map((p) => p.name).join(', ')}`
    : head;
}

/**
 * `full` (canonical, not a facet — it cannot be left out) + one record per
 * facet that yields text. Tool catalogs are global.
 */
export class FacetedToolIndexer implements IItemIndexer<ToolItem> {
  readonly name = 'faceted';
  readonly canonicalKind = 'full';
  readonly maxRecordsPerItem: number;

  constructor(readonly facets: readonly IToolFacet[]) {
    const kinds = new Set<string>();
    for (const f of facets) {
      if (f.kind === 'full' || kinds.has(f.kind)) {
        throw new Error(
          `FacetedToolIndexer: facet kind "${f.kind}" is reserved or repeated`,
        );
      }
      kinds.add(f.kind);
    }
    this.maxRecordsPerItem = 1 + facets.length;
  }

  async toRecords(
    tool: ToolItem,
  ): Promise<Result<readonly RecordDraft[], RagError>> {
    const full = fullToolText(tool);
    const drafts: RecordDraft[] = [
      {
        text: full,
        itemId: tool.itemId,
        recordKind: 'full',
        owner: GLOBAL,
        metadata: { name: tool.name, definitionChars: tool.definitionChars },
      },
    ];
    for (const facet of this.facets) {
      const text = facet.derive(tool);
      if (!text) continue;
      drafts.push({
        text,
        itemId: tool.itemId,
        recordKind: facet.kind,
        owner: GLOBAL,
        itemText: full,
        metadata: { name: tool.name },
      });
    }
    return { ok: true, value: drafts };
  }
}
```

Append to `collections/index.ts`:
```ts
export {
  FacetedToolIndexer,
  fullToolText,
} from './tools/faceted-tool-indexer.js';
export { NameTailFacet, ParametersFacet, SummaryFacet } from './tools/facets.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): schema-derived tool facets and FacetedToolIndexer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 9: Discriminators and `EnumValueToolIndexer` (libs)

Spec §7.3.2, D18 (no fan-out), S1 (`IIndexNoteSource`). Generic strategy in no default.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/tools/discriminators.ts`
- Create: `packages/llm-agent-libs/src/collections/tools/enum-value-tool-indexer.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/enum-value-tool-indexer.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `FacetedToolIndexer`, `fullToolText`, `nameWords`, `firstClause`, `valueWords`, `toolItemFromTool`; `IDiscriminatorSelector`, `IItemIndexer`, `IIndexNoteSource`, `isIndexNoteSource`, `IndexNote`, `RagError`.
- Produces:
  ```ts
  export class RequiredEnumDiscriminator implements IDiscriminatorSelector, IIndexNoteSource<ToolItem> { readonly name: 'required-enum'; static candidates(tool: ToolItem): readonly ToolParameter[]; notesFor(tool): readonly IndexNote[] } // several → [{ note: 'ambiguous-discriminator', detail: 'a, b' }]
  export class NamedDiscriminator implements IDiscriminatorSelector { constructor(parameter: string); readonly name: 'named' }
  export class EnumValueToolIndexer implements IItemIndexer<ToolItem>, IIndexNoteSource<ToolItem> { constructor(inner: IItemIndexer<ToolItem>, opts: { discriminator: IDiscriminatorSelector; maxValues: number }); readonly name: 'enum-values'; notesFor(tool): readonly IndexNote[] } // forwards discriminator + inner notes
  // too many values → Result error RagError(…, 'TOO_MANY_RECORDS'); the binding reports reason 'too-many-records' (Task 11/15)
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/enum-value-tool-indexer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EnumValueToolIndexer,
  FacetedToolIndexer,
  NamedDiscriminator,
  RequiredEnumDiscriminator,
  toolItemFromTool,
} from '../index.js';

// generic synthetic coarse server
const coarse = toolItemFromTool(
  {
    name: 'resource_create',
    description: 'Create a resource. Any kind',
    inputSchema: {
      properties: {
        kind: { oneOf: [{ const: 'BUCKET', description: 'A storage bucket' }, { const: 'QUEUE' }] },
        format: { enum: ['json', 'yaml'] },
      },
      required: ['kind'],
    },
  },
  { itemId: 'tool:resource_create', originalName: 'resource_create' },
);
// labelled example: an mcp-abap-adt `compact`-shaped tool
const compactShaped = toolItemFromTool(
  {
    name: 'HandlerCreate',
    description: 'Create operation. Creates an object',
    inputSchema: {
      properties: { object_type: { enum: ['CLASS', 'BEHAVIOR_DEFINITION'] } },
      required: ['object_type'],
    },
  },
  { itemId: 'tool:HandlerCreate', originalName: 'HandlerCreate' },
);

describe('discriminators', () => {
  it('RequiredEnumDiscriminator: exactly one required property with ≥ 2 string values', () => {
    assert.equal(new RequiredEnumDiscriminator().select(coarse)?.name, 'kind');
  });
  it('optional enums are ignored; none qualifying → none', () => {
    const t = { ...coarse, parameters: coarse.parameters.filter((p) => p.name === 'format') };
    assert.equal(new RequiredEnumDiscriminator().select(t), undefined);
  });
  it('several qualifying → none (D18: no fan-out, never a guess)', () => {
    const t = {
      ...coarse,
      parameters: [
        ...coarse.parameters,
        { name: 'region', required: true, values: [{ value: 'EU' }, { value: 'US' }] },
      ],
    };
    assert.equal(new RequiredEnumDiscriminator().select(t), undefined);
    assert.deepEqual(RequiredEnumDiscriminator.candidates(t).map((p) => p.name), ['kind', 'region']);
  });
  it('NamedDiscriminator: present, absent, fewer than 2 values', () => {
    assert.equal(new NamedDiscriminator('object_type').select(compactShaped)?.name, 'object_type');
    assert.equal(new NamedDiscriminator('missing').select(compactShaped), undefined);
    const one = { ...compactShaped, parameters: [{ name: 'object_type', required: true, values: [{ value: 'CLASS' }] }] };
    assert.equal(new NamedDiscriminator('object_type').select(one), undefined);
  });
});

describe('EnumValueToolIndexer', () => {
  const indexer = new EnumValueToolIndexer(new FacetedToolIndexer([]), {
    discriminator: new RequiredEnumDiscriminator(),
    maxValues: 5,
  });

  it('one value record per string value, collapsing to the tool', async () => {
    const r = await indexer.toRecords(coarse);
    assert.ok(r.ok);
    const values = r.value.filter((d) => d.recordKind === 'value');
    assert.deepEqual(values.map((d) => d.text), [
      'resource create — Create a resource — kind: bucket — A storage bucket',
      'resource create — Create a resource — kind: queue',
    ]);
    for (const d of values) {
      assert.equal(d.itemId, 'tool:resource_create');
      assert.equal(d.generated, undefined);
      assert.equal(d.itemText, r.value[0].text);
    }
    assert.deepEqual(values.map((d) => d.metadata?.value), ['BUCKET', 'QUEUE']);
    assert.deepEqual(values.map((d) => d.metadata?.parameter), ['kind', 'kind']);
  });
  it('labelled example: compact-shaped tool with NamedDiscriminator', async () => {
    const r = await new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: new NamedDiscriminator('object_type'),
      maxValues: 2,
    }).toRecords(compactShaped);
    assert.ok(r.ok);
    assert.equal(r.value[1].text, 'handler create — Create operation — object type: class');
  });
  it('maxRecordsPerItem = inner + maxValues', () => {
    assert.equal(indexer.maxRecordsPerItem, 6);
  });
  it('more values than maxValues → TOO_MANY_RECORDS, nothing silently dropped', async () => {
    const r = await new EnumValueToolIndexer(new FacetedToolIndexer([]), {
      discriminator: new RequiredEnumDiscriminator(),
      maxValues: 1,
    }).toRecords(coarse);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.code === 'TOO_MANY_RECORDS');
  });
  it('no qualifying parameter → the inner records only', async () => {
    const r = await indexer.toRecords({ ...coarse, parameters: [] });
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((d) => d.recordKind), ['full']);
  });
  it('maxValues is required and positive (no library number)', () => {
    assert.throws(
      () => new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 0 }),
    );
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/enum-value-tool-indexer.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/tools/discriminators.ts
import type {
  IDiscriminatorSelector,
  ToolItem,
  ToolParameter,
} from '@mcp-abap-adt/llm-agent';

/**
 * The ONE top-level property that is `required` and has ≥ 2 string values.
 * None or several → none (D18: no fan-out; the consumer resolves an ambiguity
 * with NamedDiscriminator or its own selector).
 */
export class RequiredEnumDiscriminator implements IDiscriminatorSelector {
  readonly name = 'required-enum';
  static candidates(tool: ToolItem): readonly ToolParameter[] {
    return tool.parameters.filter((p) => p.required && p.values.length >= 2);
  }
  select(tool: ToolItem): ToolParameter | undefined {
    const c = RequiredEnumDiscriminator.candidates(tool);
    return c.length === 1 ? c[0] : undefined;
  }
}

/** The property with this name, when it has ≥ 2 string values. */
export class NamedDiscriminator implements IDiscriminatorSelector {
  readonly name = 'named';
  constructor(readonly parameter: string) {}
  select(tool: ToolItem): ToolParameter | undefined {
    const p = tool.parameters.find((x) => x.name === this.parameter);
    return p && p.values.length >= 2 ? p : undefined;
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/tools/enum-value-tool-indexer.ts
import {
  type IDiscriminatorSelector,
  type IItemIndexer,
  RagError,
  type RecordDraft,
  type Result,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../../util/assert-positive-integer.js';
import { firstClause, nameWords, valueWords } from './derive-tool-facets.js';

/**
 * Generic strategy in NO default composition (spec §7.3.2): measured worse on
 * mcp-abap-adt `compact`. Adds one `value` record per string value of the
 * tool's discriminating parameter. A tool with more values than `maxValues`
 * fails (`TOO_MANY_RECORDS`); values are never silently dropped.
 */
export class EnumValueToolIndexer implements IItemIndexer<ToolItem> {
  readonly name = 'enum-values';
  readonly canonicalKind: string;
  readonly maxRecordsPerItem: number;

  constructor(
    readonly inner: IItemIndexer<ToolItem>,
    readonly opts: { discriminator: IDiscriminatorSelector; maxValues: number },
  ) {
    assertPositiveInteger('EnumValueToolIndexer', 'maxValues', opts.maxValues);
    this.canonicalKind = inner.canonicalKind;
    this.maxRecordsPerItem = inner.maxRecordsPerItem + opts.maxValues;
  }

  async toRecords(
    tool: ToolItem,
  ): Promise<Result<readonly RecordDraft[], RagError>> {
    const base = await this.inner.toRecords(tool);
    if (!base.ok) return base;
    const p = this.opts.discriminator.select(tool);
    if (!p) return base;
    if (p.values.length > this.opts.maxValues) {
      return {
        ok: false,
        error: new RagError(
          `tool ${tool.name}: ${p.values.length} values of "${p.name}" exceed maxValues ${this.opts.maxValues}`,
          'TOO_MANY_RECORDS',
        ),
      };
    }
    const canonical = base.value.find(
      (d) => d.recordKind === this.canonicalKind,
    );
    const head = [nameWords(tool.originalName), firstClause(tool.description)]
      .filter((s) => s.length > 0)
      .join(' — ');
    const values: RecordDraft[] = p.values.map((v) => ({
      text:
        `${head} — ${nameWords(p.name)}: ${valueWords(v.value)}` +
        (v.description ? ` — ${v.description}` : ''),
      itemId: tool.itemId,
      recordKind: 'value',
      owner: { scope: 'global' },
      ...(canonical ? { itemText: canonical.text } : {}),
      metadata: { name: tool.name, parameter: p.name, value: v.value },
    }));
    return { ok: true, value: [...base.value, ...values] };
  }
}
```

Append to `collections/index.ts`:
```ts
export {
  NamedDiscriminator,
  RequiredEnumDiscriminator,
} from './tools/discriminators.js';
export { EnumValueToolIndexer } from './tools/enum-value-tool-indexer.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/enum-value-tool-indexer.test.ts`
Expected: PASS.

- [ ] **Step 5: `ambiguous-discriminator` notes through `IIndexNoteSource` (S1, spec §3.2, §7.3.2)**

The binding side (collecting notes into `IndexReport.notes`) is Task 15 Step 5. Append to the test file (add `isIndexNoteSource` to an `import { isIndexNoteSource } from '@mcp-abap-adt/llm-agent';` line):

```ts
describe('ambiguous-discriminator notes (S1)', () => {
  const ambiguous = {
    ...coarse,
    parameters: [...coarse.parameters, { name: 'region', required: true, values: [{ value: 'EU' }, { value: 'US' }] }],
  };
  it('RequiredEnumDiscriminator: several qualifying → one note with the candidates; otherwise none', () => {
    const d = new RequiredEnumDiscriminator();
    assert.deepEqual(d.notesFor(ambiguous), [{ note: 'ambiguous-discriminator', detail: 'kind, region' }]);
    assert.deepEqual(d.notesFor(coarse), []);
  });
  it("EnumValueToolIndexer forwards its discriminator's notes; NamedDiscriminator has none", () => {
    const viaRequired = new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 5 });
    assert.equal(isIndexNoteSource(viaRequired), true);
    assert.deepEqual(viaRequired.notesFor(ambiguous), [{ note: 'ambiguous-discriminator', detail: 'kind, region' }]);
    const viaNamed = new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new NamedDiscriminator('kind'), maxValues: 5 });
    assert.deepEqual(viaNamed.notesFor(ambiguous), []);
  });
});
```

Run it: FAIL — `notesFor` is not a function.

In `discriminators.ts`: add `IIndexNoteSource`, `IndexNote` to the type import; `export class RequiredEnumDiscriminator implements IDiscriminatorSelector, IIndexNoteSource<ToolItem> {`; add after `select`:
```ts
  /** S1: never a guess — several candidates are reported, not picked (D18). */
  notesFor(tool: ToolItem): readonly IndexNote[] {
    const c = RequiredEnumDiscriminator.candidates(tool);
    return c.length > 1
      ? [{ note: 'ambiguous-discriminator', detail: c.map((p) => p.name).join(', ') }]
      : [];
  }
```

In `enum-value-tool-indexer.ts`: add `type IIndexNoteSource`, `type IndexNote`, `isIndexNoteSource` to the `@mcp-abap-adt/llm-agent` import; `export class EnumValueToolIndexer implements IItemIndexer<ToolItem>, IIndexNoteSource<ToolItem> {`; add after `toRecords`:
```ts
  /** S1: the notes of its discriminator and of the indexer it wraps. */
  notesFor(tool: ToolItem): readonly IndexNote[] {
    return [this.opts.discriminator, this.inner].flatMap((x) =>
      isIndexNoteSource<ToolItem>(x) ? x.notesFor(tool) : [],
    );
  }
```

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/enum-value-tool-indexer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): discriminators and EnumValueToolIndexer (generic, in no default)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 10: Intent sources and intent indexers (libs)

Spec §7.3.3, §3.5; D3; S2 (generated at indexing, no skip), S1 (notes forwarded).

**Files:**
- Create: `packages/llm-agent-libs/src/collections/tools/intent-sources.ts`
- Create: `packages/llm-agent-libs/src/collections/tools/intent-indexers.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/intents.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `fullToolText`, `FacetedToolIndexer`, `toolItemFromTool`; `IToolIntentSource`, `ILlm` (`chat(messages, tools?, options?)`), `Message`, `shortHash` (`@mcp-abap-adt/llm-agent`).
- Produces:
  ```ts
  export class StaticIntentSource implements IToolIntentSource { constructor(map: Readonly<Record<string, readonly string[]>>); readonly name: 'static' } // keyed by originalName
  export const DEFAULT_INTENT_PROMPT: string;
  export class LlmIntentSource implements IToolIntentSource { constructor(llm: ILlm, opts?: { prompt?: string }); readonly name: 'llm' }
  export class IntentRecordIndexer implements IItemIndexer<ToolItem>, IIndexNoteSource<ToolItem> { constructor(inner: IItemIndexer<ToolItem>, source: IToolIntentSource); readonly name: 'intent-record'; notesFor(tool): readonly IndexNote[] } // maxRecordsPerItem = inner + 1; notes = inner's
  export class IntentCompanionIndexer implements IItemIndexer<ToolItem> { constructor(source: IToolIntentSource); readonly name: 'intent-companion'; readonly maxRecordsPerItem: 1; readonly canonicalKind: 'full' }
  // intent record: kind 'intent', text = intents one per line, generated: true, metadata { name, generatedFrom: shortHash(fullToolText(tool)) } — generatedFrom is provenance only (S2)
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/intents.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ILlm, shortHash } from '@mcp-abap-adt/llm-agent';
import {
  FacetedToolIndexer,
  fullToolText,
  IntentCompanionIndexer,
  IntentRecordIndexer,
  LlmIntentSource,
  StaticIntentSource,
  toolItemFromTool,
} from '../index.js';

const tool = toolItemFromTool(
  { name: 'read_file', description: 'Read a file' },
  { itemId: 'tool:read_file', originalName: 'read_file' },
);
const intents = new StaticIntentSource({ read_file: ['open my notes', 'show a file'] });

describe('intent sources', () => {
  it('StaticIntentSource is keyed by originalName; unknown → empty', async () => {
    const r = await intents.intentsFor(tool);
    assert.ok(r.ok);
    assert.deepEqual(r.value, ['open my notes', 'show a file']);
    const none = await intents.intentsFor({ ...tool, originalName: 'other' });
    assert.ok(none.ok && none.value.length === 0);
  });
  it('LlmIntentSource: one intent per line, bullets stripped; a domain-neutral English prompt', async () => {
    const seen: string[] = [];
    const llm = {
      chat: async (messages: Array<{ content: string | null }>) => {
        seen.push(messages.map((m) => m.content ?? '').join('\n'));
        return { ok: true, value: { content: '- open my notes\n\n2. show a file\n', finishReason: 'stop' } };
      },
      streamChat: async function* () {},
    } as unknown as ILlm;
    const r = await new LlmIntentSource(llm).intentsFor(tool);
    assert.ok(r.ok);
    assert.deepEqual(r.value, ['open my notes', 'show a file']);
    assert.match(seen[0], /read_file/);
    assert.doesNotMatch(seen[0], /ABAP|SAP/);
  });
  it('LlmIntentSource: an LLM error is returned', async () => {
    const llm = {
      chat: async () => ({ ok: false, error: new Error('down') }),
      streamChat: async function* () {},
    } as unknown as ILlm;
    const r = await new LlmIntentSource(llm).intentsFor(tool);
    assert.equal(r.ok, false);
  });
});

describe('IntentRecordIndexer — record placement (default)', () => {
  const indexer = new IntentRecordIndexer(new FacetedToolIndexer([]), intents);
  it('ONE intent record per tool, generated, itemText = provider text', async () => {
    const r = await indexer.toRecords(tool);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((d) => d.recordKind), ['full', 'intent']);
    const intent = r.value[1];
    assert.equal(intent.text, 'open my notes\nshow a file');
    assert.equal(intent.generated, true);
    assert.equal(intent.itemText, fullToolText(tool));
    assert.equal(intent.metadata?.generatedFrom, shortHash(fullToolText(tool)));
  });
  it('no intent text in any provider record', async () => {
    const r = await indexer.toRecords(tool);
    assert.ok(r.ok);
    for (const d of r.value.filter((x) => x.recordKind !== 'intent')) {
      assert.doesNotMatch(d.text, /open my notes/);
      assert.equal(d.generated, undefined);
    }
  });
  it('no intents → no intent record; bound = inner + 1', async () => {
    const r = await new IntentRecordIndexer(new FacetedToolIndexer([]), new StaticIntentSource({})).toRecords(tool);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((d) => d.recordKind), ['full']);
    assert.equal(indexer.maxRecordsPerItem, 2);
  });
});

describe('IntentCompanionIndexer — companion placement', () => {
  it('the same ONE record, generated, without itemText, no canonical', async () => {
    const c = new IntentCompanionIndexer(intents);
    const r = await c.toRecords(tool);
    assert.ok(r.ok);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].recordKind, 'intent');
    assert.equal(r.value[0].generated, true);
    assert.equal(r.value[0].itemText, undefined);
    assert.equal(c.maxRecordsPerItem, 1);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/intents.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/tools/intent-sources.ts
import {
  type CallOptions,
  type ILlm,
  type IToolIntentSource,
  RagError,
  type Result,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';

/** Intents generated at deploy (e.g. an intents file), keyed by the provider's tool name. */
export class StaticIntentSource implements IToolIntentSource {
  readonly name = 'static';
  constructor(
    private readonly byOriginalName: Readonly<Record<string, readonly string[]>>,
  ) {}
  async intentsFor(tool: ToolItem): Promise<Result<readonly string[], RagError>> {
    return { ok: true, value: this.byOriginalName[tool.originalName] ?? [] };
  }
}

/** English, domain-neutral: no server or domain words (spec §7.3.3). Overridable. */
export const DEFAULT_INTENT_PROMPT =
  'You write search phrases for a software tool. Given the tool below, list up to 8 short, ' +
  'distinct English requests a user might type when they need this tool. Use only what the ' +
  'name, description and parameters say; add no facts. One request per line, no numbering.';

export class LlmIntentSource implements IToolIntentSource {
  readonly name = 'llm';
  private readonly prompt: string;
  constructor(
    private readonly llm: ILlm,
    opts: { prompt?: string } = {},
  ) {
    this.prompt = opts.prompt ?? DEFAULT_INTENT_PROMPT;
  }

  async intentsFor(
    tool: ToolItem,
    options?: CallOptions,
  ): Promise<Result<readonly string[], RagError>> {
    const params = tool.parameters.map((p) => p.name).join(', ');
    const r = await this.llm.chat(
      [
        { role: 'system', content: this.prompt },
        {
          role: 'user',
          content: `Tool: ${tool.originalName}\nDescription: ${tool.description}\nParameters: ${params}`,
        },
      ],
      undefined,
      options,
    );
    if (!r.ok) {
      return {
        ok: false,
        error: new RagError(`intent generation failed: ${r.error.message}`, 'INTENT_ERROR'),
      };
    }
    const lines = r.value.content
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((l) => l.length > 0);
    return { ok: true, value: lines };
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/tools/intent-indexers.ts
import {
  type CallOptions,
  type IItemIndexer,
  type IToolIntentSource,
  type RagError,
  type RecordDraft,
  type Result,
  shortHash,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { fullToolText } from './faceted-tool-indexer.js';

async function intentDraft(
  source: IToolIntentSource,
  tool: ToolItem,
  withItemText: boolean,
  options?: CallOptions,
): Promise<Result<RecordDraft | undefined, RagError>> {
  const r = await source.intentsFor(tool, options);
  if (!r.ok) return r;
  if (r.value.length === 0) return { ok: true, value: undefined };
  const provider = fullToolText(tool);
  return {
    ok: true,
    value: {
      text: r.value.join('\n'),
      itemId: tool.itemId,
      recordKind: 'intent',
      owner: { scope: 'global' },
      generated: true,
      // The reranker reads provider text, never intents (spec §4.6).
      ...(withItemText ? { itemText: provider } : {}),
      // Provenance: a hash of the provider text the intents came from (spec §7.3.3).
      // The framework never reads it (S2: no skip; caching is the consumer's).
      metadata: { name: tool.name, generatedFrom: shortHash(provider) },
    },
  };
}

/** Record placement (default): ONE `intent` record in the tool collection. */
export class IntentRecordIndexer implements IItemIndexer<ToolItem> {
  readonly name = 'intent-record';
  readonly canonicalKind: string;
  readonly maxRecordsPerItem: number;
  constructor(
    readonly inner: IItemIndexer<ToolItem>,
    readonly source: IToolIntentSource,
  ) {
    this.canonicalKind = inner.canonicalKind;
    this.maxRecordsPerItem = inner.maxRecordsPerItem + 1;
  }
  async toRecords(
    tool: ToolItem,
    options?: CallOptions,
  ): Promise<Result<readonly RecordDraft[], RagError>> {
    const base = await this.inner.toRecords(tool, options);
    if (!base.ok) return base;
    const intent = await intentDraft(this.source, tool, true, options);
    if (!intent.ok) return intent;
    return {
      ok: true,
      value: intent.value ? [...base.value, intent.value] : base.value,
    };
  }
}

/**
 * Companion placement: the same ONE record per tool, in its own store (a
 * `variants` source). Makes no canonical record — its hits hydrate from the
 * items source; `canonicalKind` names the items source's kind and is unused here.
 */
export class IntentCompanionIndexer implements IItemIndexer<ToolItem> {
  readonly name = 'intent-companion';
  readonly canonicalKind = 'full';
  readonly maxRecordsPerItem = 1;
  constructor(readonly source: IToolIntentSource) {}
  async toRecords(
    tool: ToolItem,
    options?: CallOptions,
  ): Promise<Result<readonly RecordDraft[], RagError>> {
    const intent = await intentDraft(this.source, tool, false, options);
    if (!intent.ok) return intent;
    return { ok: true, value: intent.value ? [intent.value] : [] };
  }
}
```

Append to `collections/index.ts`:
```ts
export {
  IntentCompanionIndexer,
  IntentRecordIndexer,
} from './tools/intent-indexers.js';
export {
  DEFAULT_INTENT_PROMPT,
  LlmIntentSource,
  StaticIntentSource,
} from './tools/intent-sources.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/intents.test.ts`
Expected: PASS.

- [ ] **Step 5: Generated at indexing, no skip (S2); `IntentRecordIndexer` forwards notes (S1)**

Spec §7.3.3 (amended): every `index` asks the source; caching generated intents is the consumer's concern (e.g. `StaticIntentSource` over a file generated at deploy). Append to `intents.test.ts`:

```ts
describe('generated at indexing (S2); notes forwarded (S1)', () => {
  it("every toRecords asks the source again — caching is the consumer's", async () => {
    let asked = 0;
    const counting = {
      name: 'counting',
      intentsFor: async () => {
        asked++;
        return { ok: true as const, value: ['open my notes'] };
      },
    };
    const ix = new IntentRecordIndexer(new FacetedToolIndexer([]), counting);
    await ix.toRecords(tool);
    await ix.toRecords(tool);
    assert.equal(asked, 2);
  });
  it("IntentRecordIndexer forwards the inner indexer's notes", () => {
    const inner = Object.assign(new FacetedToolIndexer([]), { notesFor: () => [{ note: 'n' }] });
    assert.deepEqual(new IntentRecordIndexer(inner, intents).notesFor(tool), [{ note: 'n' }]);
    assert.deepEqual(new IntentRecordIndexer(new FacetedToolIndexer([]), intents).notesFor(tool), []);
  });
});
```

Run it: FAIL — `notesFor` is not a function (the S2 case already passes: there is no skip to remove).

In `intent-indexers.ts`: add `type IIndexNoteSource`, `type IndexNote`, `isIndexNoteSource` to the `@mcp-abap-adt/llm-agent` import; `export class IntentRecordIndexer implements IItemIndexer<ToolItem>, IIndexNoteSource<ToolItem> {`; add after `toRecords`:
```ts
  /** S1: a decorator forwards the notes of the indexer it wraps. */
  notesFor(tool: ToolItem): readonly IndexNote[] {
    return isIndexNoteSource<ToolItem>(this.inner) ? this.inner.notesFor(tool) : [];
  }
```

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/intents.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): intent sources and intent indexers (record and companion placement)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 11: Record writer — ids, batch write, replacement, `get`, `remove` (libs)

Spec §3.1, §3.3 (incl. `companionRecordIds`, S7), §4.4 (refusal), §7.6 (one batch pass), §8.2.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/record-writer.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts` (export `asItem` only; the rest is internal)

**Interfaces:**
- Consumes: `recordId`, `ownerKeyOf`, `retrievalEmbedderOf`, `matchesRagIdentity`, `ragIdentityFilter`, `RagError`, `IRag`, `RagMetadata`, `RecordDraft`, `RecordOwner`; `ownerMetadata` (Task 5).
- Produces (internal to `collections/`, used by Tasks 15 and 17):
  ```ts
  export interface ItemWrite { readonly itemId: string; readonly drafts: readonly RecordDraft[]; readonly ttl?: number }
  export interface PreparedRecord { readonly id: string; readonly text: string; readonly metadata: RagMetadata }
  export interface PreparedItem { readonly itemId: string; readonly owner: RecordOwner; readonly canonical?: PreparedRecord; readonly others: readonly PreparedRecord[] }
  export type CompanionIds = Readonly<Record<string, readonly string[]>>;              // S7: companion name → record ids
  export function prepareItem(w: ItemWrite, o: { canonicalKind: string | undefined; profile: string; maxRecordsPerItem: number; companionRecordIds?: CompanionIds }): { ok: true; item: PreparedItem } | { ok: false; reason: string };
  export function storeItems(rag: IRag, items: readonly PreparedItem[], options?: CallOptions): Promise<{ indexed: boolean[]; records: number; failures: (string | undefined)[]; oldCompanions: CompanionIds[]; batchFailure?: string }>;
  export function getItem(rag: IRag, canonicalId: string, filter: CallOptions | undefined, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
  export function removeItem(rag: IRag, canonicalId: string, options?: CallOptions, companions?: Readonly<Record<string, IRag>>): Promise<Result<number, RagError>>; // S7: also the listed companion records
  export function listedCompanions(meta: RagMetadata | undefined): CompanionIds;
  export function asItem(canonical: RagResult, score: number, extra?: { matchedKinds?: string[]; source?: string }): RagResult; // metadata.id = itemId
  export function isExpired(meta: RagMetadata, nowSecs?: number): boolean;
  ```
  Failure reasons: `'too-many-records'`, `'missing-canonical'`, `'owner-mismatch'`, `'item-id-mismatch'`, `'no-records'`, `'write-failed'`, `'read-failed: <message>'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IEmbedder,
  InMemoryRag,
  type RecordDraft,
  type RecordOwner,
  recordId,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { getItem, prepareItem, removeItem, storeItems } from '../record-writer.js';

const U_A: RecordOwner = { scope: 'user', userId: 'A' };
const draft = (kind: string, text: string, owner: RecordOwner = U_A): RecordDraft => ({
  text,
  itemId: 'case-42',
  recordKind: kind,
  owner,
  ...(kind === 'item' ? { metadata: { data: { n: 1 } } } : { itemText: 'canon' }),
});
const prep = (drafts: RecordDraft[], max = 5, ttl?: number) =>
  prepareItem({ itemId: 'case-42', drafts, ...(ttl !== undefined ? { ttl } : {}) }, {
    canonicalKind: 'item',
    profile: 'shared-items',
    maxRecordsPerItem: max,
  });

describe('prepareItem', () => {
  it('owner-scoped ids; positions per kind; framework metadata; recordIds on the canonical', () => {
    const p = prep([draft('item', 'canon'), draft('note', 'n0'), draft('note', 'n1')], 5, 99);
    assert.ok(p.ok);
    const { canonical, others } = p.item;
    assert.equal(canonical?.id, recordId(U_A, 'case-42', 'item', 0));
    assert.deepEqual(others.map((r) => r.id), [
      recordId(U_A, 'case-42', 'note', 0),
      recordId(U_A, 'case-42', 'note', 1),
    ]);
    assert.deepEqual(canonical?.metadata, {
      data: { n: 1 },
      itemId: 'case-42',
      recordKind: 'item',
      profile: 'shared-items',
      visibility: 'user',
      userId: 'A',
      ttl: 99,
      recordIds: others.map((r) => r.id),
    });
    assert.equal(others[0].metadata.itemText, 'canon');
  });
  it('refusals: too many records, missing canonical, mixed owners', () => {
    assert.deepEqual(prep([draft('item', 'c'), draft('n', 'x')], 1), { ok: false, reason: 'too-many-records' });
    assert.deepEqual(prep([draft('note', 'x')]), { ok: false, reason: 'missing-canonical' });
    assert.deepEqual(prep([draft('item', 'c'), draft('n', 'x', { scope: 'global' })]), {
      ok: false,
      reason: 'owner-mismatch',
    });
  });
});

describe('storeItems / getItem / removeItem', () => {
  it('re-indexing writes the new records and deletes the unlisted old ones', async () => {
    const rag = new InMemoryRag();
    const first = prep([draft('item', 'v1'), draft('note', 'old-a'), draft('note', 'old-b')]);
    assert.ok(first.ok);
    await storeItems(rag, [first.item]);
    const second = prep([draft('item', 'v2'), draft('note', 'new-a')]);
    assert.ok(second.ok);
    const r = await storeItems(rag, [second.item]);
    assert.deepEqual(r.indexed, [true]);
    const gone = await rag.getById(recordId(U_A, 'case-42', 'note', 1));
    assert.ok(gone.ok && gone.value === null);
    const canon = await rag.getById(recordId(U_A, 'case-42', 'item', 0));
    assert.ok(canon.ok && canon.value?.text === 'v2');
  });

  it('one batch embedding pass for every record when the store embedder batches', async () => {
    const calls: number[] = [];
    const embedder: IEmbedder & { embedBatch(t: string[]): Promise<{ vector: number[] }[]> } = {
      embed: async () => ({ vector: [1, 0] }),
      embedBatch: async (texts: string[]) => {
        calls.push(texts.length);
        return texts.map(() => ({ vector: [1, 0] }));
      },
    };
    const rag = new VectorRag(symmetricEmbedder(embedder));
    const a = prep([draft('item', 'c'), draft('note', 'x')]);
    const b = prepareItem(
      { itemId: 'case-43', drafts: [{ ...draft('item', 'd'), itemId: 'case-43' }] },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
    );
    assert.ok(a.ok && b.ok);
    const r = await storeItems(rag, [a.item, b.item]);
    assert.deepEqual(calls, [3]);
    assert.deepEqual(r.indexed, [true, true]);
    assert.equal(r.records, 3);
  });

  it('getItem: the canonical record as an item, identity-checked', async () => {
    const rag = new InMemoryRag();
    const p = prep([draft('item', 'canon')]);
    assert.ok(p.ok);
    await storeItems(rag, [p.item]);
    const id = recordId(U_A, 'case-42', 'item', 0);
    const mine = await getItem(rag, id, { ragFilter: { userId: 'A' } });
    assert.ok(mine.ok);
    assert.equal(mine.value?.text, 'canon');
    assert.equal(mine.value?.metadata.id, 'case-42');
    assert.deepEqual(mine.value?.metadata.data, { n: 1 });
    const foreign = await getItem(rag, id, { ragFilter: { userId: 'B' } });
    assert.ok(foreign.ok && foreign.value === null);
  });

  it('removeItem deletes what the canonical lists, then the canonical', async () => {
    const rag = new InMemoryRag();
    const p = prep([draft('item', 'c'), draft('note', 'x')]);
    assert.ok(p.ok);
    await storeItems(rag, [p.item]);
    const n = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0));
    assert.ok(n.ok);
    assert.equal(n.value, 2);
    const none = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0));
    assert.ok(none.ok && none.value === 0);
  });

  it('S7: the canonical lists companion ids; storeItems reports the old lists; removeItem clears them', async () => {
    const rag = new InMemoryRag();
    const intents = new InMemoryRag();
    const cid = recordId(U_A, 'case-42', 'intent', 0);
    await intents.writer().upsertRaw(cid, 'open my notes', { visibility: 'user', userId: 'A' });
    const p = prepareItem(
      { itemId: 'case-42', drafts: [draft('item', 'c')] },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5, companionRecordIds: { intents: [cid] } },
    );
    assert.ok(p.ok);
    assert.deepEqual(p.item.canonical?.metadata.companionRecordIds, { intents: [cid] });
    const first = await storeItems(rag, [p.item]);
    assert.deepEqual(first.oldCompanions, [{}]);
    const again = await storeItems(rag, [p.item]);
    assert.deepEqual(again.oldCompanions, [{ intents: [cid] }]);
    const n = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0), undefined, { intents });
    assert.ok(n.ok && n.value === 2);
    const gone = await intents.getById(cid);
    assert.ok(gone.ok && gone.value === null);
  });

  it('S7: a listed companion the caller has no store for is left as is (unbound = cleared by the consumer)', async () => {
    const rag = new InMemoryRag();
    const p = prepareItem(
      { itemId: 'case-42', drafts: [draft('item', 'c')] },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5, companionRecordIds: { intents: ['x'] } },
    );
    assert.ok(p.ok);
    await storeItems(rag, [p.item]);
    const n = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0));
    assert.ok(n.ok && n.value === 1);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/record-writer.ts
/**
 * The binding's write path (spec §3.1, §3.3, §7.6). Ids come from recordId only;
 * an item is written as: new non-canonical records → the canonical (with the
 * new `recordIds`) → deletes of the old ids it no longer lists. NOT atomic, no
 * locks, no generations (D13): readers stay safe through hydration (§4.6).
 */
import {
  type CallOptions,
  type IRag,
  matchesRagIdentity,
  ownerKeyOf,
  RagError,
  type RagMetadata,
  type RagResult,
  type RecordDraft,
  type RecordOwner,
  type Result,
  ragIdentityFilter,
  recordId,
  retrievalEmbedderOf,
} from '@mcp-abap-adt/llm-agent';
import { ownerMetadata } from './owner.js';

export interface ItemWrite {
  readonly itemId: string;
  readonly drafts: readonly RecordDraft[];
  /** Framework-written expiry (shared items), on every record of the item. */
  readonly ttl?: number;
}

export interface PreparedRecord {
  readonly id: string;
  readonly text: string;
  readonly metadata: RagMetadata;
}

export interface PreparedItem {
  readonly itemId: string;
  readonly owner: RecordOwner;
  /** Absent for a companion write (no canonical in that store). */
  readonly canonical?: PreparedRecord;
  readonly others: readonly PreparedRecord[];
}

/** S7: companion name → the item's record ids in that companion store. */
export type CompanionIds = Readonly<Record<string, readonly string[]>>;

const sameOwner = (a: RecordOwner, b: RecordOwner): boolean =>
  a.scope === b.scope && ownerKeyOf(a) === ownerKeyOf(b);

export function prepareItem(
  w: ItemWrite,
  o: {
    canonicalKind: string | undefined;
    profile: string;
    maxRecordsPerItem: number;
    /** S7: written on the canonical so remove/replacement reach companion records. */
    companionRecordIds?: CompanionIds;
  },
): { ok: true; item: PreparedItem } | { ok: false; reason: string } {
  if (w.drafts.length > o.maxRecordsPerItem) {
    return { ok: false, reason: 'too-many-records' };
  }
  const owner = w.drafts[0]?.owner;
  if (!owner) return { ok: false, reason: 'no-records' };
  for (const d of w.drafts) {
    if (d.itemId !== w.itemId) return { ok: false, reason: 'item-id-mismatch' };
    if (!sameOwner(d.owner, owner)) return { ok: false, reason: 'owner-mismatch' };
  }
  const canonicalDrafts =
    o.canonicalKind === undefined
      ? []
      : w.drafts.filter((d) => d.recordKind === o.canonicalKind);
  if (o.canonicalKind !== undefined && canonicalDrafts.length !== 1) {
    return { ok: false, reason: 'missing-canonical' };
  }
  const positions = new Map<string, number>();
  const build = (d: RecordDraft): PreparedRecord => {
    const n = positions.get(d.recordKind) ?? 0;
    positions.set(d.recordKind, n + 1);
    return {
      id: recordId(owner, w.itemId, d.recordKind, n),
      text: d.text,
      metadata: {
        ...(d.metadata ?? {}),
        itemId: w.itemId,
        recordKind: d.recordKind,
        profile: o.profile,
        ...ownerMetadata(owner),
        ...(d.generated ? { generated: true } : {}),
        ...(d.itemText !== undefined ? { itemText: d.itemText } : {}),
        ...(w.ttl !== undefined ? { ttl: w.ttl } : {}),
      },
    };
  };
  const canonicalDraft = canonicalDrafts[0];
  const canonicalBase = canonicalDraft ? build(canonicalDraft) : undefined;
  const others = w.drafts.filter((d) => d !== canonicalDraft).map(build);
  const companions = o.companionRecordIds;
  const canonical = canonicalBase
    ? {
        ...canonicalBase,
        metadata: {
          ...canonicalBase.metadata,
          recordIds: others.map((r) => r.id),
          ...(companions && Object.keys(companions).length > 0
            ? { companionRecordIds: companions }
            : {}),
        },
      }
    : undefined;
  return {
    ok: true,
    item: { itemId: w.itemId, owner, ...(canonical ? { canonical } : {}), others },
  };
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** One embedding call for all records when the store's embedder batches; undefined → per-record path. */
async function embedAll(
  rag: IRag,
  records: readonly PreparedRecord[],
  options?: CallOptions,
): Promise<{ vectors?: Map<string, number[]>; failure?: string }> {
  const embedder = retrievalEmbedderOf(rag);
  const writer = rag.writer?.();
  if (
    !embedder?.embedDocuments ||
    !(writer?.upsertManyPrecomputedRaw || writer?.upsertPrecomputedRaw) ||
    records.length === 0
  ) {
    return {};
  }
  try {
    const res = await embedder.embedDocuments(
      records.map((r) => r.text),
      options,
    );
    return { vectors: new Map(records.map((r, i) => [r.id, res[i].vector])) };
  } catch (err) {
    return { failure: message(err) };
  }
}

async function writeAll(
  rag: IRag,
  records: readonly PreparedRecord[],
  vectors: Map<string, number[]> | undefined,
  written: Set<string>,
  options?: CallOptions,
): Promise<void> {
  const writer = rag.writer?.();
  if (!writer || records.length === 0) return;
  if (vectors && writer.upsertManyPrecomputedRaw) {
    const batch = records.flatMap((r) => {
      const vector = vectors.get(r.id);
      return vector ? [{ ...r, vector }] : [];
    });
    if (batch.length === records.length) {
      const bulk = await writer
        .upsertManyPrecomputedRaw(batch, options)
        .catch((err: unknown) => ({
          ok: false as const,
          error: new RagError(message(err)),
        }));
      if (bulk.ok) {
        for (const r of records) written.add(r.id);
        return;
      }
    }
  }
  for (const r of records) {
    if (options?.signal?.aborted) return;
    const vector = vectors?.get(r.id);
    try {
      const res =
        vector && writer.upsertPrecomputedRaw
          ? await writer.upsertPrecomputedRaw(r.id, r.text, vector, r.metadata, options)
          : await writer.upsertRaw(r.id, r.text, r.metadata, options);
      if (res.ok) written.add(r.id);
    } catch {
      // not written: the item lands in failedItems
    }
  }
}

const listed = (meta: RagMetadata | undefined): string[] =>
  Array.isArray(meta?.recordIds)
    ? meta.recordIds.filter((x): x is string => typeof x === 'string')
    : [];

/** S7: the companion ids a canonical record lists (malformed entries ignored). */
export function listedCompanions(meta: RagMetadata | undefined): CompanionIds {
  const raw = meta?.companionRecordIds;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(raw)) {
    if (Array.isArray(ids)) out[name] = ids.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

/** Write prepared items into ONE store (spec §3.3 order). `indexed[i]` = every record of item i written. */
export async function storeItems(
  rag: IRag,
  items: readonly PreparedItem[],
  options?: CallOptions,
): Promise<{
  indexed: boolean[];
  records: number;
  failures: (string | undefined)[];
  /** S7: what each item's previous canonical listed per companion ({} when new). */
  oldCompanions: CompanionIds[];
  batchFailure?: string;
}> {
  const failures: (string | undefined)[] = items.map(() => undefined);
  const old: string[][] = items.map(() => []);
  const oldCompanions: CompanionIds[] = items.map(() => ({}));
  await Promise.all(
    items.map(async (it, i) => {
      if (!it.canonical) return;
      const r = await rag.getById(it.canonical.id, options);
      if (!r.ok) failures[i] = `read-failed: ${r.error.message}`;
      else {
        old[i] = listed(r.value?.metadata);
        oldCompanions[i] = listedCompanions(r.value?.metadata);
      }
    }),
  );
  const live = items.filter((_, i) => failures[i] === undefined);
  const all = live.flatMap((it) => [
    ...it.others,
    ...(it.canonical ? [it.canonical] : []),
  ]);
  const { vectors, failure } = await embedAll(rag, all, options);
  const written = new Set<string>();
  await writeAll(rag, live.flatMap((it) => it.others), vectors, written, options);
  await writeAll(
    rag,
    live.flatMap((it) => (it.canonical ? [it.canonical] : [])),
    vectors,
    written,
    options,
  );
  const writer = rag.writer?.();
  const indexed = await Promise.all(
    items.map(async (it, i) => {
      if (failures[i] !== undefined) return false;
      const ids = [...it.others, ...(it.canonical ? [it.canonical] : [])].map((r) => r.id);
      if (!ids.every((id) => written.has(id))) {
        failures[i] = 'write-failed';
        return false;
      }
      const keep = new Set(ids);
      for (const stale of old[i].filter((id) => !keep.has(id))) {
        await writer?.deleteByIdRaw(stale, options);
      }
      return true;
    }),
  );
  return {
    indexed,
    records: written.size,
    failures,
    oldCompanions,
    ...(failure !== undefined ? { batchFailure: failure } : {}),
  };
}

export function isExpired(meta: RagMetadata, nowSecs = Date.now() / 1000): boolean {
  return typeof meta.ttl === 'number' && meta.ttl < nowSecs;
}

/** An item as returned to readers: the canonical record, `metadata.id` = the logical itemId. */
export function asItem(
  canonical: RagResult,
  score: number,
  extra: { matchedKinds?: string[]; source?: string } = {},
): RagResult {
  return {
    text: canonical.text,
    metadata: {
      ...canonical.metadata,
      id: canonical.metadata.itemId,
      ...extra,
    },
    score,
  };
}

/** The item whole by its canonical id, or null — identity-checked against `filter` (spec §3.3). */
export async function getItem(
  rag: IRag,
  canonicalId: string,
  filter: CallOptions | undefined,
  options?: CallOptions,
): Promise<Result<RagResult | null, RagError>> {
  const r = await rag.getById(canonicalId, options);
  if (!r.ok) return r;
  const rec = r.value;
  if (
    !rec ||
    isExpired(rec.metadata) ||
    !matchesRagIdentity(rec.metadata, ragIdentityFilter(filter))
  ) {
    return { ok: true, value: null };
  }
  return { ok: true, value: asItem(rec, 1) };
}

/**
 * Delete what the canonical lists — the listed companion records in the given
 * companion stores (S7), then its own store's records — then the canonical.
 * A listed companion with no store here is left as is. Returns records deleted.
 */
export async function removeItem(
  rag: IRag,
  canonicalId: string,
  options?: CallOptions,
  companions?: Readonly<Record<string, IRag>>,
): Promise<Result<number, RagError>> {
  const writer = rag.writer?.();
  if (!writer) {
    return { ok: false, error: new RagError('store has no writer', 'RAG_READ_ONLY') };
  }
  const r = await rag.getById(canonicalId, options);
  if (!r.ok) return r;
  if (!r.value) return { ok: true, value: 0 };
  let n = 0;
  for (const [name, ids] of Object.entries(listedCompanions(r.value.metadata))) {
    const cw = companions?.[name]?.writer?.();
    if (!cw) continue;
    for (const id of ids) {
      const d = await cw.deleteByIdRaw(id, options);
      if (!d.ok) return d;
      if (d.value) n++;
    }
  }
  for (const id of [...listed(r.value.metadata), canonicalId]) {
    const d = await writer.deleteByIdRaw(id, options);
    if (!d.ok) return d;
    if (d.value) n++;
  }
  return { ok: true, value: n };
}
```

Append to `collections/index.ts`:
```ts
export { asItem } from './record-writer.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts`
Expected: PASS. (If `VectorRag` writes ids into `metadata.id` differently from `InMemoryRag`, `getById(recordId(...))` must still find the record — VectorRag replaces "the slot with the same `metadata.id`", spec §3.1.)

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): record writer — owner-scoped ids, one batch pass, replacement, get, remove

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 12: `StagedRetrieval` — sources, item pool, collapse, hydration, orphans (libs)

Spec §4.1–§4.4, §4.6 (hydration), §4.9; D14, D15. The reranker (Task 13), decomposer (Task 14) and telemetry (Task 28) build on this file.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/staged-retrieval.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-helpers.ts` (not a `*.test.ts`)
- Create: `packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `ItemPool`, `MaxScoreCollapse`, `itemKey`, `ownerFromMetadata` (Task 5); `TopItemsCut`, `FixedItemsCut` (Task 6); `asItem`, `isExpired`, `prepareItem`, `storeItems` (Task 11); contracts of Task 3.
- Produces:
  ```ts
  export interface StagedRetrievalOptions {
    name: string; storeKey: string; pool: ICandidatePool; maxRecordsPerItem: number; canonicalKind: string;
    sources: ISourceSelector; collapse: ICollapseRule;
    rerank?: { reranker: IReranker; onFailure: 'stage1' | 'error'; keepStage1Top?: number };
    decompose?: { decomposer: IQueryDecomposer; queryEmbedder: IQueryEmbedder };
    cut?: IItemCut;
    telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics };
  }
  export class StagedRetrieval implements IRetrievalStrategy { constructor(o: StagedRetrievalOptions); readonly name: string; readonly options: StagedRetrievalOptions }
  export interface RunStats { sources: string[]; candidateRecords: number; collapsedItems: number; orphans: number; hydrationReads: number; rerankOutcome: 'none' | 'ok' | 'fallback' | 'error'; rerankError?: string }
  // Returned item: text = canonical text; metadata = canonical metadata + { id: itemId, matchedKinds: string[], source: string }; score = rule's or reranker's.
  // A record without itemId passes through as itself.
  ```

- [ ] **Step 1: Write the test helpers**

```ts
// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-helpers.ts
// Shared fixtures for the StagedRetrieval tests; not a *.test.ts file, so the runner skips it.
import {
  type IRag,
  type RagJsonValue,
  type RagResult,
  type RecordDraft,
  type RecordOwner,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { prepareItem, storeItems } from '../record-writer.js';

export const G: RecordOwner = { scope: 'global' };

/** Write one item through the real write path; the first record is the canonical one. */
export async function put(
  rag: IRag,
  itemId: string,
  records: Array<[kind: string, text: string]>,
  opts: { owner?: RecordOwner; data?: RagJsonValue; canonicalKind?: string } = {},
): Promise<void> {
  const owner = opts.owner ?? G;
  const [canonical] = records;
  const drafts: RecordDraft[] = records.map(([kind, text], i) => ({
    text,
    itemId,
    recordKind: kind,
    owner,
    ...(i === 0
      ? opts.data !== undefined
        ? { metadata: { data: opts.data } }
        : {}
      : { itemText: canonical[1] }),
  }));
  const p = prepareItem(
    { itemId, drafts },
    { canonicalKind: opts.canonicalKind ?? canonical[0], profile: 'test', maxRecordsPerItem: 10 },
  );
  if (!p.ok) throw new Error(p.reason);
  await storeItems(rag, [p.item]);
}

/** InMemoryRag returns zero-score records too; tests want only real matches. */
export function matchesOnly(rag: IRag, seenK: number[] = []): IRag {
  return {
    query: async (q, k, o) => {
      seenK.push(k);
      const r = await rag.query(q, k, o);
      return r.ok ? { ok: true, value: r.value.filter((x) => x.score > 0) } : r;
    },
    healthCheck: (o) => rag.healthCheck(o),
    getById: (id, o) => rag.getById(id, o),
    writer: () => rag.writer?.(),
  };
}

export const q = (text: string) => new TextOnlyEmbedding(text);
export const ids = (r: { ok: boolean; value?: RagResult[] }) =>
  r.ok ? (r.value ?? []).map((x) => x.metadata.id) : r;
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IRag,
  InMemoryRag,
  RagError,
  type RetrievalSource,
  recordId,
} from '@mcp-abap-adt/llm-agent';
import {
  FixedItemsCut,
  ItemPool,
  MaxScoreCollapse,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from '../index.js';
import { G, ids, matchesOnly, put, q } from './staged-retrieval-helpers.js';

function staged(
  sources: (options?: CallOptions) => RetrievalSource[],
  o: Partial<StagedRetrievalOptions> = {},
) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 3,
    canonicalKind: 'full',
    sources: { sources: async (options) => sources(options) },
    collapse: new MaxScoreCollapse(),
    ...o,
  });
}
const primary = (rag: IRag) => (options?: CallOptions): RetrievalSource[] => [
  { name: 'primary', rag, role: 'items', options },
];

describe('StagedRetrieval — stage 1, collapse, hydration', () => {
  it('k counts items, not records (max collapse)', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'A', [['full', 'alpha tool'], ['summary', 'alpha alpha'], ['parameters', 'alpha beta']]);
    await put(raw, 'B', [['full', 'alpha gamma']]);
    await put(raw, 'C', [['full', 'delta']]);
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('alpha'), 2);
    assert.deepEqual(ids(r), ['A', 'B']);
    assert.ok(r.ok);
    assert.deepEqual([...(r.value[0].metadata.matchedKinds as string[])].sort(), ['full', 'parameters', 'summary']);
    assert.equal(r.value[0].metadata.source, 'primary');
  });

  it('the candidate pool is counted in items: every item with maxRecordsPerItem records still yields n items', async () => {
    const raw = new InMemoryRag();
    for (let i = 0; i < 5; i++) {
      await put(raw, `T${i}`, [['full', `zeta i${i}`], ['summary', `zeta zeta s${i}`], ['parameters', `zeta p${i}`]]);
    }
    const seenK: number[] = [];
    const rag = matchesOnly(raw, seenK);
    const r = await staged(primary(rag), { pool: new ItemPool(4) }).retrieve(rag, q('zeta'), 4);
    assert.deepEqual(seenK, [12]);
    assert.ok(r.ok);
    assert.equal(new Set(r.value.map((x) => x.metadata.id)).size, 4);
  });

  it('only a secondary record matches → the full payload (canonical text + data) is returned', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'X', [['full', 'canonical words here'], ['summary', 'needle']], { data: { n: 1 } });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'canonical words here');
    assert.deepEqual(r.value[0].metadata.data, { n: 1 });
    assert.equal(r.value[0].metadata.id, 'X');
    assert.deepEqual(r.value[0].metadata.matchedKinds, ['summary']);
  });

  it('a hit without its canonical record is an orphan: dropped, never its own text, does not use up k', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'Y', [['full', 'yankee'], ['summary', 'needle']]);
    await raw.writer().deleteByIdRaw(recordId(G, 'Y', 'full', 0));
    await put(raw, 'Z', [['full', 'needle zulu']]);
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.deepEqual(ids(r), ['Z']);
  });

  it('a stale secondary record of a live item hydrates to the CURRENT canonical record', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'L', [['full', 'current text']]);
    await raw.writer().upsertRaw(recordId(G, 'L', 'summary', 0), 'needle', {
      itemId: 'L',
      recordKind: 'summary',
      visibility: 'global',
      itemText: 'stale text',
    });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 1);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'current text');
  });

  it('a canonical record outside the source identity filter is dropped', async () => {
    const raw = new InMemoryRag();
    const alice = { scope: 'user', userId: 'alice' } as const;
    await raw.writer().upsertRaw(recordId(alice, 'I', 'summary', 0), 'needle', {
      itemId: 'I', recordKind: 'summary', visibility: 'user', userId: 'alice', itemText: 'x',
    });
    await raw.writer().upsertRaw(recordId(alice, 'I', 'full', 0), 'secret', {
      itemId: 'I', recordKind: 'full', visibility: 'user', userId: 'bob',
    });
    const rag = matchesOnly(raw);
    const r = await staged(() => [
      { name: 'user', rag, role: 'items', options: { ragFilter: { userId: 'alice' } } },
    ]).retrieve(rag, q('needle'), 3);
    assert.deepEqual(ids(r), []);
  });

  it('records without itemId (skills) pass through as themselves', async () => {
    const raw = new InMemoryRag();
    await raw.writer().upsertRaw('skill:deploy', 'Skill: deploy needle', { name: 'deploy' });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 3);
    assert.ok(r.ok);
    assert.equal(r.value[0].metadata.id, 'skill:deploy');
    assert.equal(r.value[0].text, 'Skill: deploy needle');
  });

  it('collapse keys on the owner-qualified item: two owners, one itemId, two items', async () => {
    const raw = new InMemoryRag();
    await put(raw, 'case-42', [['item', 'needle a']], { owner: { scope: 'user', userId: 'A' } });
    await put(raw, 'case-42', [['item', 'needle b']], { owner: { scope: 'user', userId: 'B' } });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag), { canonicalKind: 'item' }).retrieve(rag, q('needle'), 5);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => x.metadata.userId).sort(), ['A', 'B']);
  });

  it('the cut is applied once: at most cut.limit(k) items', async () => {
    const raw = new InMemoryRag();
    for (const id of ['a', 'b', 'c', 'd']) await put(raw, id, [['full', `needle ${id}x`]]);
    const rag = matchesOnly(raw);
    const fixed = await staged(primary(rag), { cut: new FixedItemsCut(2) }).retrieve(rag, q('needle'), 10);
    assert.ok(fixed.ok && fixed.value.length === 2);
    const top = await staged(primary(rag)).retrieve(rag, q('needle'), 3);
    assert.ok(top.ok && top.value.length === 3);
  });

  it('a variants source: its hits hydrate from the items source; skipped when the items source is not selected', async () => {
    const items = new InMemoryRag();
    await put(items, 'T', [['full', 'tango']]);
    const intents = new InMemoryRag();
    await intents.writer().upsertRaw(recordId(G, 'T', 'intent', 0), 'needle', {
      itemId: 'T', recordKind: 'intent', visibility: 'global', generated: true,
    });
    const both = (options?: CallOptions): RetrievalSource[] => [
      { name: 'primary', rag: matchesOnly(items), role: 'items', options },
      { name: 'intents', rag: matchesOnly(intents), role: 'variants', itemsOf: 'primary', options },
    ];
    const r = await staged(both).retrieve(items, q('needle'), 3);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'tango');
    assert.equal(r.value[0].metadata.source, 'primary');
    assert.deepEqual(r.value[0].metadata.matchedKinds, ['intent']);
    const onlyVariants = await staged((o) => both(o).slice(1)).retrieve(items, q('needle'), 3);
    assert.deepEqual(ids(onlyVariants), []);
  });

  it('a store error is returned', async () => {
    const failing: IRag = {
      query: async () => ({ ok: false, error: new RagError('down') }),
      healthCheck: async () => ({ ok: true, value: undefined }),
      getById: async () => ({ ok: true, value: null }),
    };
    const r = await staged(primary(failing)).retrieve(failing, q('x'), 3);
    assert.equal(r.ok, false);
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts`
Expected: FAIL — `StagedRetrieval` not exported.

- [ ] **Step 4: Implement**

```ts
// packages/llm-agent-libs/src/collections/staged-retrieval.ts
/**
 * The composable retrieval half of a collection profile (spec §4): candidates
 * counted in ITEMS → collapse records back to owner-qualified items → optional
 * reranker on the item's provider text → hydrate every returned item from its
 * CANONICAL record (owner-checked; no canonical → orphan, dropped) → one cut.
 *
 * It queries the sources its profile bound (`ISourceSelector`), not the `store`
 * argument of `retrieve` — that is the inner store `StrategyRag` passes.
 */
import {
  type CallOptions,
  type ICandidatePool,
  type ICollapseRule,
  type IItemCut,
  type IQueryDecomposer,
  type IQueryEmbedder,
  type IQueryEmbedding,
  type IRag,
  type IReranker,
  type IRetrievalMetrics,
  type IRetrievalStrategy,
  type ISourceSelector,
  type ITracer,
  matchesRagIdentity,
  type RagError,
  type RagResult,
  type Result,
  type RetrievalSource,
  ragIdentityFilter,
  recordId,
  type SourcedHit,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { TopItemsCut } from './cuts.js';
import { itemKey, ownerFromMetadata } from './owner.js';
import { asItem, isExpired } from './record-writer.js';

export interface StagedRetrievalOptions {
  /** Reported as `strategy`. */
  name: string;
  /** Reported as `store`. */
  storeKey: string;
  /** Candidate strategy, counted in ITEMS — required, never derived. */
  pool: ICandidatePool;
  /** From the indexing strategy, not set by the consumer. */
  maxRecordsPerItem: number;
  /** From the indexing strategy; locates the canonical record. */
  canonicalKind: string;
  /** From the profile's bind(). */
  sources: ISourceSelector;
  collapse: ICollapseRule;
  rerank?: {
    reranker: IReranker;
    /** 'stage1' = 30.1.0 behaviour. */
    onFailure: 'stage1' | 'error';
    /** Default 0; counted inside k (spec §4.7). */
    keepStage1Top?: number;
  };
  /** Absent → the query runs as is (one run). */
  decompose?: { decomposer: IQueryDecomposer; queryEmbedder: IQueryEmbedder };
  /** Absent → TopItemsCut (caller's k). */
  cut?: IItemCut;
  telemetry?: { tracer?: ITracer; metrics?: IRetrievalMetrics };
}

/** One unit stage 1 hands on: a collapsed item, or a record without itemId passed through. */
export interface Unit {
  readonly key: string;
  readonly score: number;
  /** The items source the unit belongs to. */
  readonly source: RetrievalSource;
  readonly hits: readonly RagResult[];
  /** Set for a collapsed item; absent for a pass-through record. */
  readonly item?: { readonly itemId: string; readonly canonicalId: string };
}

/** What one run observed; emitted as telemetry (Task 28). */
export interface RunStats {
  sources: string[];
  candidateRecords: number;
  collapsedItems: number;
  orphans: number;
  hydrationReads: number;
  rerankOutcome: 'none' | 'ok' | 'fallback' | 'error';
  rerankError?: string;
}

export interface RunContext {
  readonly stats: RunStats;
  /** Canonical record per unit key; null = orphan. */
  readonly canonicals: Map<string, RagResult | null>;
  readonly options?: CallOptions;
}

export function newRunContext(options?: CallOptions): RunContext {
  return {
    stats: {
      sources: [],
      candidateRecords: 0,
      collapsedItems: 0,
      orphans: 0,
      hydrationReads: 0,
      rerankOutcome: 'none',
    },
    canonicals: new Map(),
    ...(options ? { options } : {}),
  };
}

function keepPerSource(units: readonly Unit[], n: number): Unit[] {
  const count = new Map<string, number>();
  return units.filter((u) => {
    const c = count.get(u.source.name) ?? 0;
    if (c >= n) return false;
    count.set(u.source.name, c + 1);
    return true;
  });
}

const matchedKinds = (hits: readonly RagResult[]): string[] => [
  ...new Set(hits.map((h) => String(h.metadata.recordKind))),
];

export class StagedRetrieval implements IRetrievalStrategy {
  readonly name: string;
  protected readonly cut: IItemCut;

  constructor(readonly options: StagedRetrievalOptions) {
    assertPositiveInteger(
      'StagedRetrieval',
      'maxRecordsPerItem',
      options.maxRecordsPerItem,
    );
    const keep = options.rerank?.keepStage1Top;
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 0)) {
      throw new Error(
        `StagedRetrieval: keepStage1Top must be a non-negative integer (got ${keep})`,
      );
    }
    this.name = options.name;
    this.cut = options.cut ?? new TopItemsCut();
  }

  async retrieve(
    _store: IRag,
    query: IQueryEmbedding,
    k: number,
    callOptions?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const budget = this.cut.limit(k);
    const ctx = newRunContext(callOptions);
    const run = await this.runOne(query, budget, ctx);
    if (!run.ok) return run;
    return { ok: true, value: this.cut.cut(run.value, k).slice(0, budget) };
  }

  /** §4.3 up to hydration: at most `keep` hydrated items, in rank order. */
  protected async runOne(
    query: IQueryEmbedding,
    keep: number,
    ctx: RunContext,
  ): Promise<Result<RagResult[], RagError>> {
    const o = this.options;
    const sources = await o.sources.sources(ctx.options);
    const byName = new Map(sources.map((s) => [s.name, s] as const));
    ctx.stats.sources = sources.map((s) => s.name);
    const fetch = o.pool.recordsToFetch(o.maxRecordsPerItem);
    const answers = await Promise.all(
      sources.map((s) => s.rag.query(query, fetch, s.options)),
    );
    const hits: SourcedHit[] = [];
    const units: Unit[] = [];
    for (const [i, answer] of answers.entries()) {
      if (!answer.ok) return answer;
      const s = sources[i];
      const items =
        s.role === 'items'
          ? s
          : s.itemsOf !== undefined
            ? byName.get(s.itemsOf)
            : undefined;
      // A variants source whose items source this request may not read.
      if (items?.role !== 'items') continue;
      ctx.stats.candidateRecords += answer.value.length;
      for (const h of answer.value) {
        if (typeof h.metadata.itemId !== 'string') {
          if (s.role === 'items') {
            units.push({
              key: JSON.stringify(['record', s.name, String(h.metadata.id)]),
              score: h.score,
              source: s,
              hits: [h],
            });
          }
          continue;
        }
        if (!ownerFromMetadata(h.metadata)) {
          ctx.stats.orphans++;
          continue;
        }
        hits.push({ ...h, source: items.name });
      }
    }
    const collapsed = o.collapse.collapse(hits);
    ctx.stats.collapsedItems = collapsed.length;
    for (const c of collapsed) {
      const source = byName.get(c.source);
      if (!source) continue;
      units.push({
        key: itemKey(c.source, c.owner, c.itemId),
        score: c.score,
        source,
        hits: c.hits,
        item: {
          itemId: c.itemId,
          canonicalId: recordId(c.owner, c.itemId, o.canonicalKind, 0),
        },
      });
    }
    units.sort((a, b) => b.score - a.score);
    const pooled = keepPerSource(units, o.pool.items);
    const ranked = await this.rank(pooled, query.text, ctx);
    if (!ranked.ok) return ranked;
    return this.hydrate(ranked.value, keep, ctx);
  }

  /** Stage-1 order; the reranker is added in Task 13. */
  protected async rank(
    pooled: Unit[],
    _text: string,
    _ctx: RunContext,
  ): Promise<Result<Unit[], RagError>> {
    return { ok: true, value: pooled };
  }

  /** Hydrate in rank order, in parallel waves, until `keep` items: orphans never use up k. */
  protected async hydrate(
    units: readonly Unit[],
    keep: number,
    ctx: RunContext,
  ): Promise<Result<RagResult[], RagError>> {
    const out: RagResult[] = [];
    let next = 0;
    while (out.length < keep && next < units.length) {
      const wave = units.slice(next, next + keep - out.length);
      next += wave.length;
      const got = await Promise.all(wave.map((u) => this.hydrateOne(u, ctx)));
      for (const g of got) {
        if (!g.ok) return g;
        if (g.value) out.push(g.value);
      }
    }
    return { ok: true, value: out };
  }

  private async hydrateOne(
    u: Unit,
    ctx: RunContext,
  ): Promise<Result<RagResult | null, RagError>> {
    if (!u.item) {
      const rec = u.hits[0];
      return { ok: true, value: rec ? { ...rec, score: u.score } : null };
    }
    const c = await this.canonicalOf(u, ctx);
    if (!c.ok || !c.value) return c;
    return {
      ok: true,
      value: asItem(c.value, u.score, {
        matchedKinds: matchedKinds(u.hits),
        source: u.source.name,
      }),
    };
  }

  /**
   * The canonical record: a canonical hit among the candidates, else one
   * getById on the items source — owner-checked against the source's filter.
   * Null = orphan, counted once per unit.
   */
  protected async canonicalOf(
    u: Unit,
    ctx: RunContext,
  ): Promise<Result<RagResult | null, RagError>> {
    const item = u.item;
    if (!item) return { ok: true, value: null };
    const cached = ctx.canonicals.get(u.key);
    if (cached !== undefined) return { ok: true, value: cached };
    let rec =
      u.hits.find((h) => h.metadata.recordKind === this.options.canonicalKind) ??
      null;
    if (!rec) {
      ctx.stats.hydrationReads++;
      const r = await u.source.rag.getById(item.canonicalId, u.source.options);
      if (!r.ok) return r;
      rec = r.value;
    }
    const valid =
      rec !== null &&
      rec.metadata.itemId === item.itemId &&
      !isExpired(rec.metadata) &&
      matchesRagIdentity(rec.metadata, ragIdentityFilter(u.source.options));
    if (!valid) ctx.stats.orphans++;
    const value = valid ? rec : null;
    ctx.canonicals.set(u.key, value);
    return { ok: true, value };
  }
}
```

Append to `collections/index.ts`:
```ts
export {
  type RunStats,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from './staged-retrieval.js';
```

- [ ] **Step 5: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): StagedRetrieval — item pool, owner-qualified collapse, canonical hydration, orphans

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 13: `StagedRetrieval` — reranker on provider text, output check, failure policy (libs)

Spec §4.6 (reranker text), §4.7, §4.8, §9.1 (session step), §9.3.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/rerank-check.ts`
- Modify: `packages/llm-agent-libs/src/collections/staged-retrieval.ts` (replace `rank`, add `itemText`)
- Create: `packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: Task 12 (`Unit`, `RunContext`, `canonicalOf`).
- Produces:
  ```ts
  export function checkRerankOutput(candidates: readonly RagResult[], out: readonly RagResult[]): string | undefined; // undefined = valid
  // StagedRetrieval: reranker failure → session step 'retrieval_rerank_error' { store, strategy, code, message };
  //   onFailure 'stage1' → stage-1 order (stats.rerankOutcome 'fallback'); 'error' → RagError code 'RERANK_ERROR' (stats 'error').
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  InMemoryRag,
  type IRag,
  type IReranker,
  RagError,
  type RagResult,
  type RetrievalSource,
  recordId,
} from '@mcp-abap-adt/llm-agent';
import {
  checkRerankOutput,
  ItemPool,
  MaxScoreCollapse,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from '../index.js';
import { G, ids, matchesOnly, put, q } from './staged-retrieval-helpers.js';

function staged(rag: IRag, rerank: StagedRetrievalOptions['rerank'], extra: (o?: CallOptions) => RetrievalSource[] = () => []) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 3,
    canonicalKind: 'full',
    sources: { sources: async (options) => [{ name: 'primary', rag, role: 'items', options }, ...extra(options)] },
    collapse: new MaxScoreCollapse(),
    rerank,
  });
}

/** Records what it was asked and answers via `answer`. */
function spy(answer: (c: RagResult[]) => RagResult[] | Error | 'throw') {
  const seen: Array<{ query: string; texts: string[] }> = [];
  const reranker: IReranker = {
    rerank: async (query, results) => {
      seen.push({ query, texts: results.map((r) => r.text) });
      const a = answer(results);
      if (a === 'throw') throw new Error('boom');
      if (a instanceof Error) return { ok: false, error: new RagError(a.message, 'RERANK_ERROR') };
      return { ok: true, value: a };
    },
  };
  return { reranker, seen };
}
const reversed = (c: RagResult[]) => [...c].reverse().map((r, i) => ({ ...r, score: 1 - i / 10 }));

async function fixture() {
  const raw = new InMemoryRag();
  await put(raw, 'A', [['full', 'alpha provider text'], ['summary', 'needle needle']]);
  await put(raw, 'B', [['full', 'bravo needle provider']]);
  await put(raw, 'C', [['full', 'charlie provider'], ['intent', 'needle generated words']]);
  return matchesOnly(raw);
}

describe('StagedRetrieval — reranker', () => {
  it('reranks items on their provider text — never intent text', async () => {
    const rag = await fixture();
    const { reranker, seen } = spy(reversed);
    const r = await staged(rag, { reranker, onFailure: 'stage1' }).retrieve(rag, q('needle'), 3);
    assert.equal(seen[0].query, 'needle');
    assert.deepEqual(new Set(seen[0].texts), new Set(['alpha provider text', 'bravo needle provider', 'charlie provider']));
    for (const t of seen[0].texts) assert.doesNotMatch(t, /generated/);
    assert.ok(r.ok);
    assert.equal(r.value[0].score, 1);
  });

  it('a variants-only item: the canonical record is read for its text', async () => {
    const items = new InMemoryRag();
    await put(items, 'T', [['full', 'tango provider']]);
    const intents = new InMemoryRag();
    await intents.writer().upsertRaw(recordId(G, 'T', 'intent', 0), 'needle', {
      itemId: 'T', recordKind: 'intent', visibility: 'global', generated: true,
    });
    const { reranker, seen } = spy((c) => c);
    await staged(matchesOnly(items), { reranker, onFailure: 'stage1' }, (o) => [
      { name: 'intents', rag: matchesOnly(intents), role: 'variants', itemsOf: 'primary', options: o },
    ]).retrieve(items, q('needle'), 3);
    assert.deepEqual(seen[0].texts, ['tango provider']);
  });

  it('a reranker that drops a candidate is a RERANK_ERROR: stage1 keeps the stage-1 order and logs the step', async () => {
    const rag = await fixture();
    const { reranker } = spy((c) => c.slice(1));
    const steps: Array<[string, unknown]> = [];
    const opts: CallOptions = { sessionLogger: { logStep: (n, d) => steps.push([n, d]) } };
    const stage1 = await staged(rag, undefined).retrieve(rag, q('needle'), 3, opts);
    const r = await staged(rag, { reranker, onFailure: 'stage1' }).retrieve(rag, q('needle'), 3, opts);
    assert.deepEqual(ids(r), ids(stage1));
    assert.equal(steps[0][0], 'retrieval_rerank_error');
    assert.deepEqual(Object.keys(steps[0][1] as object).sort(), ['code', 'message', 'store', 'strategy']);
    assert.equal((steps[0][1] as { code: string }).code, 'RERANK_ERROR');
  });

  it("onFailure 'error' returns the RERANK_ERROR", async () => {
    const rag = await fixture();
    const { reranker } = spy(() => new Error('bad'));
    const r = await staged(rag, { reranker, onFailure: 'error' }).retrieve(rag, q('needle'), 3);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });

  it('a thrown reranker falls back under stage1', async () => {
    const rag = await fixture();
    const { reranker } = spy(() => 'throw');
    const r = await staged(rag, { reranker, onFailure: 'stage1' }).retrieve(rag, q('needle'), 3);
    assert.ok(r.ok && r.value.length === 3);
  });

  it('keepStage1Top: the stage-1 top-n first, reranked items fill the rest, counted inside k', async () => {
    const rag = await fixture();
    const stage1 = await staged(rag, undefined).retrieve(rag, q('needle'), 3);
    const { reranker } = spy(reversed);
    const r = await staged(rag, { reranker, onFailure: 'stage1', keepStage1Top: 1 }).retrieve(rag, q('needle'), 2);
    assert.ok(stage1.ok && r.ok);
    assert.equal(r.value.length, 2);
    assert.equal(r.value[0].metadata.id, stage1.value[0].metadata.id);
  });
});

describe('checkRerankOutput', () => {
  const c = (id: string): RagResult => ({ text: id, metadata: { id }, score: 0 });
  const cands = [c('a'), c('b')];
  it('valid: same candidates, each once, finite scores', () => {
    assert.equal(checkRerankOutput(cands, [{ ...c('b'), score: 0.9 }, { ...c('a'), score: 0.1 }]), undefined);
  });
  it('wrong count, duplicate, unknown, non-finite', () => {
    assert.match(String(checkRerankOutput(cands, [c('a')])), /1 results for 2/);
    assert.match(String(checkRerankOutput(cands, [c('a'), c('a')])), /twice/);
    assert.match(String(checkRerankOutput(cands, [c('a'), c('z')])), /not a candidate/);
    assert.match(String(checkRerankOutput(cands, [c('a'), { ...c('b'), score: Number.NaN }])), /non-finite/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts`
Expected: FAIL — `checkRerankOutput` not exported.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/rerank-check.ts
import type { RagResult } from '@mcp-abap-adt/llm-agent';

/**
 * Every reranker result is checked (spec §4.8), whichever reranker it is: it
 * must hold exactly the candidates it was given — same count, each once — with
 * finite scores. Returns the reason it is not, or undefined.
 */
export function checkRerankOutput(
  candidates: readonly RagResult[],
  out: readonly RagResult[],
): string | undefined {
  if (out.length !== candidates.length) {
    return `reranker returned ${out.length} results for ${candidates.length} candidates`;
  }
  const want = new Set(candidates.map((c) => c.metadata.id));
  const seen = new Set<unknown>();
  for (const r of out) {
    const id = r.metadata.id;
    if (!want.has(id)) return `reranker returned a result that was not a candidate (${String(id)})`;
    if (seen.has(id)) return `reranker returned candidate ${String(id)} twice`;
    seen.add(id);
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
      return `reranker returned a non-finite score for ${String(id)}`;
    }
  }
  return undefined;
}
```

In `staged-retrieval.ts`: add `RagError` as a value import (change `type RagError` to `RagError` in the import list), import `checkRerankOutput` from `./rerank-check.js`, add `const MAX_THROWN_MESSAGE = 500;` at module level, and replace the `rank` method with:

```ts
  /**
   * The reranker reads the ITEM text (spec §4.6): a canonical hit's text, else a
   * non-canonical hit's `itemText` shortcut, else the canonical record (read
   * now). Undefined = orphan (dropped before reranking).
   */
  private async itemText(
    u: Unit,
    ctx: RunContext,
  ): Promise<Result<string | undefined, RagError>> {
    if (!u.item) return { ok: true, value: u.hits[0]?.text };
    const canonicalHit = u.hits.find(
      (h) => h.metadata.recordKind === this.options.canonicalKind,
    );
    if (canonicalHit) return { ok: true, value: canonicalHit.text };
    const shortcut = u.hits.find((h) => typeof h.metadata.itemText === 'string');
    if (shortcut) return { ok: true, value: String(shortcut.metadata.itemText) };
    const c = await this.canonicalOf(u, ctx);
    if (!c.ok) return c;
    return { ok: true, value: c.value?.text };
  }

  protected async rank(
    pooled: Unit[],
    text: string,
    ctx: RunContext,
  ): Promise<Result<Unit[], RagError>> {
    const rr = this.options.rerank;
    if (!rr || pooled.length === 0) return { ok: true, value: pooled };
    const live: Unit[] = [];
    const candidates: RagResult[] = [];
    for (const u of pooled) {
      const t = await this.itemText(u, ctx);
      if (!t.ok) return t;
      if (t.value === undefined) continue;
      live.push(u);
      candidates.push({
        text: t.value,
        metadata: { ...(u.hits[0]?.metadata ?? {}), id: u.key },
        score: u.score,
      });
    }
    let failure: { code: string; message: string } | undefined;
    let out: RagResult[] = [];
    try {
      const r = await rr.reranker.rerank(text, candidates, ctx.options);
      if (!r.ok) failure = { code: r.error.code, message: r.error.message };
      else {
        const bad = checkRerankOutput(candidates, r.value);
        if (bad) failure = { code: 'RERANK_ERROR', message: bad };
        else out = r.value;
      }
    } catch (err) {
      failure = {
        code: 'RERANK_THROWN',
        message: String(err).slice(0, MAX_THROWN_MESSAGE),
      };
    }
    if (failure) {
      ctx.options?.sessionLogger?.logStep('retrieval_rerank_error', {
        store: this.options.storeKey,
        strategy: this.name,
        code: failure.code,
        message: failure.message,
      });
      ctx.stats.rerankError = `${failure.code}: ${failure.message}`;
      if (rr.onFailure === 'error') {
        ctx.stats.rerankOutcome = 'error';
        return {
          ok: false,
          error: new RagError(`rerank failed: ${failure.message}`, 'RERANK_ERROR'),
        };
      }
      ctx.stats.rerankOutcome = 'fallback';
      return { ok: true, value: live };
    }
    ctx.stats.rerankOutcome = 'ok';
    const byKey = new Map(live.map((u) => [u.key, u] as const));
    const reranked: Unit[] = [];
    for (const r of out) {
      const u = byKey.get(String(r.metadata.id));
      if (u) reranked.push({ ...u, score: r.score });
    }
    const keepTop = rr.keepStage1Top ?? 0;
    if (keepTop === 0) return { ok: true, value: reranked };
    const head = live.slice(0, keepTop);
    const headKeys = new Set(head.map((u) => u.key));
    return {
      ok: true,
      value: [...head, ...reranked.filter((u) => !headKeys.has(u.key))],
    };
  }
```

Append to `collections/index.ts`:
```ts
export { checkRerankOutput } from './rerank-check.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): StagedRetrieval reranks items on provider text and checks every reranker result

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 14: `StagedRetrieval` — the `IQueryDecomposer` slot (libs)

Spec §4.5, §2.4; goal decision 2026-10-05. No decomposer implementation ships.

**Files:**
- Modify: `packages/llm-agent-libs/src/collections/staged-retrieval.ts` (replace `retrieve`, add `decomposeQuery`, `resultKey`)
- Create: `packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-decompose.test.ts`

**Interfaces:**
- Consumes: Tasks 12–13; `QueryEmbedding` (`@mcp-abap-adt/llm-agent`, `new QueryEmbedding(text, embedder, options)`); `IQueryDecomposer`, `SubQuery`.
- Produces: decomposer errors and failed checks → `RagError(…, 'DECOMPOSE_ERROR')`; at most `cut.limit(k)` items in every case. Exported helper `resultKey(r: RagResult): string` (owner-qualified item key of a returned result) — used by Task 30's kit test.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-decompose.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InMemoryRag,
  type IQueryDecomposer,
  type IQueryEmbedder,
  type IRag,
  type IReranker,
  RagError,
  type SubQuery,
} from '@mcp-abap-adt/llm-agent';
import {
  FixedItemsCut,
  ItemPool,
  MaxScoreCollapse,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from '../index.js';
import { ids, matchesOnly, put, q } from './staged-retrieval-helpers.js';

const embedder: IQueryEmbedder = { embedQuery: async () => ({ vector: [1] }) };
const decomposer = (subs: SubQuery[] | Error | 'throw', seen: Array<[string, number]> = []): IQueryDecomposer => ({
  name: 'test-split',
  decompose: async (text, budget) => {
    seen.push([text, budget]);
    if (subs === 'throw') throw new Error('boom');
    if (subs instanceof Error) return { ok: false, error: new RagError(subs.message) };
    return { ok: true, value: subs };
  },
});

async function fixture(queries: string[] = []) {
  const raw = new InMemoryRag();
  await put(raw, 'A', [['full', 'apple one']]);
  await put(raw, 'B', [['full', 'apple banana']]);
  await put(raw, 'C', [['full', 'banana cherry']]);
  await put(raw, 'D', [['full', 'cherry date']]);
  const inner = matchesOnly(raw);
  const rag: IRag = { ...inner, query: (e, k, o) => { queries.push(e.text); return inner.query(e, k, o); } };
  return rag;
}

function staged(rag: IRag, o: Partial<StagedRetrievalOptions>) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 1,
    canonicalKind: 'full',
    sources: { sources: async (options) => [{ name: 'primary', rag, role: 'items', options }] },
    collapse: new MaxScoreCollapse(),
    ...o,
  });
}

describe('StagedRetrieval — query decomposition slot', () => {
  it('none injected → the query runs as is, once', async () => {
    const queries: string[] = [];
    const rag = await fixture(queries);
    await staged(rag, {}).retrieve(rag, q('apple banana'), 3);
    assert.deepEqual(queries, ['apple banana']);
  });

  it('[] → one run with the whole budget', async () => {
    const queries: string[] = [];
    const seen: Array<[string, number]> = [];
    const rag = await fixture(queries);
    const r = await staged(rag, { decompose: { decomposer: decomposer([], seen), queryEmbedder: embedder } }).retrieve(rag, q('apple'), 2);
    assert.deepEqual(seen, [['apple', 2]]);
    assert.deepEqual(queries, ['apple']);
    assert.ok(r.ok && r.value.length === 2);
  });

  it('the budget handed to the decomposer is cut.limit(k)', async () => {
    const seen: Array<[string, number]> = [];
    const rag = await fixture();
    await staged(rag, { cut: new FixedItemsCut(3), decompose: { decomposer: decomposer([], seen), queryEmbedder: embedder } }).retrieve(rag, q('apple'), 20);
    assert.deepEqual(seen, [['apple', 3]]);
  });

  it('each sub-query is reranked against its own text and kept to its k; the union is de-duplicated', async () => {
    const asked: string[] = [];
    const reranker: IReranker = {
      rerank: async (query, results) => {
        asked.push(query);
        return { ok: true, value: results };
      },
    };
    const rag = await fixture();
    const r = await staged(rag, {
      rerank: { reranker, onFailure: 'stage1' },
      decompose: {
        decomposer: decomposer([{ text: 'apple', k: 1 }, { text: 'banana', k: 2 }]),
        queryEmbedder: embedder,
      },
    }).retrieve(rag, q('apple then banana'), 3);
    assert.deepEqual(asked.sort(), ['apple', 'banana']);
    assert.ok(r.ok);
    assert.equal(new Set(r.value.map((x) => x.metadata.id)).size, r.value.length);
    assert.ok(r.value.length <= 3);
  });

  it('budgets summing above the budget are a DECOMPOSE_ERROR — never a silent fall-back', async () => {
    const rag = await fixture();
    for (const subs of [
      [{ text: 'apple', k: 2 }, { text: 'banana', k: 2 }],
      [{ text: 'apple', k: 0 }],
      [{ text: 'apple', k: 1.5 }],
      [{ text: '  ', k: 1 }],
    ]) {
      const r = await staged(rag, { decompose: { decomposer: decomposer(subs), queryEmbedder: embedder } }).retrieve(rag, q('x'), 3);
      assert.equal(r.ok, false);
      assert.ok(!r.ok && r.error.code === 'DECOMPOSE_ERROR', JSON.stringify(subs));
    }
  });

  it('a decomposer error or throw is a DECOMPOSE_ERROR', async () => {
    const rag = await fixture();
    for (const d of [decomposer(new Error('no')), decomposer('throw')]) {
      const r = await staged(rag, { decompose: { decomposer: d, queryEmbedder: embedder } }).retrieve(rag, q('x'), 3);
      assert.ok(!r.ok && r.error.code === 'DECOMPOSE_ERROR');
    }
  });

  it('never more than the budget with any decomposer', async () => {
    const rag = await fixture();
    const r = await staged(rag, {
      decompose: { decomposer: decomposer([{ text: 'apple', k: 1 }, { text: 'cherry', k: 1 }]), queryEmbedder: embedder },
    }).retrieve(rag, q('x'), 2);
    assert.ok(r.ok && r.value.length <= 2);
    assert.ok(ids(r));
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-decompose.test.ts`
Expected: FAIL — the decomposer is never called (`seen` empty; no `DECOMPOSE_ERROR`).

- [ ] **Step 3: Implement**

In `staged-retrieval.ts`: add `QueryEmbedding` (value) and `type SubQuery` to the `@mcp-abap-adt/llm-agent` import; import `ownerFromMetadata` is already there. Add module-level:

```ts
/** The owner-qualified key of a returned result (pass-through records by id). */
export function resultKey(r: RagResult): string {
  const itemId = r.metadata.itemId;
  const owner = ownerFromMetadata(r.metadata);
  return typeof itemId === 'string' && owner
    ? itemKey(String(r.metadata.source), owner, itemId)
    : JSON.stringify(['record', String(r.metadata.id)]);
}

const decomposeError = (message: string): Result<never, RagError> => ({
  ok: false,
  error: new RagError(message, 'DECOMPOSE_ERROR'),
});
```

Replace `retrieve` with:

```ts
  async retrieve(
    _store: IRag,
    query: IQueryEmbedding,
    k: number,
    callOptions?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const budget = this.cut.limit(k);
    const finish = (items: RagResult[]): Result<RagResult[], RagError> => ({
      ok: true,
      value: this.cut.cut(items, k).slice(0, budget),
    });
    const d = this.options.decompose;
    const subs = d
      ? await this.decomposeQuery(d.decomposer, query.text, budget, callOptions)
      : ({ ok: true, value: [] } as const);
    if (!subs.ok) return subs;
    if (!d || subs.value.length === 0) {
      const run = await this.runOne(query, budget, newRunContext(callOptions));
      return run.ok ? finish(run.value) : run;
    }
    const runs = await Promise.all(
      subs.value.map((s) =>
        this.runOne(
          new QueryEmbedding(s.text, d.queryEmbedder, callOptions),
          s.k,
          newRunContext(callOptions),
        ),
      ),
    );
    // Union in sub-query order, de-duplicated by owner-qualified item, best score kept.
    const union: RagResult[] = [];
    const at = new Map<string, number>();
    for (const run of runs) {
      if (!run.ok) return run;
      for (const item of run.value) {
        const key = resultKey(item);
        const i = at.get(key);
        if (i === undefined) {
          at.set(key, union.length);
          union.push(item);
        } else if (item.score > union[i].score) {
          union[i] = item;
        }
      }
    }
    return finish(union);
  }

  /** Calls the consumer's decomposer and checks its answer (spec §4.5). Never swallowed. */
  private async decomposeQuery(
    decomposer: IQueryDecomposer,
    text: string,
    budget: number,
    callOptions?: CallOptions,
  ): Promise<Result<readonly SubQuery[], RagError>> {
    let r: Result<readonly SubQuery[], RagError>;
    try {
      r = await decomposer.decompose(text, budget, callOptions);
    } catch (err) {
      return decomposeError(
        `decomposer ${decomposer.name} threw: ${String(err).slice(0, MAX_THROWN_MESSAGE)}`,
      );
    }
    if (!r.ok) {
      return decomposeError(`decomposer ${decomposer.name} failed: ${r.error.message}`);
    }
    let sum = 0;
    for (const s of r.value) {
      if (!Number.isInteger(s.k) || s.k < 1) {
        return decomposeError(`sub-query k must be an integer ≥ 1 (got ${s.k})`);
      }
      if (typeof s.text !== 'string' || s.text.trim().length === 0) {
        return decomposeError('sub-query text must be non-empty');
      }
      sum += s.k;
    }
    if (sum > budget) {
      return decomposeError(
        `sub-query budgets sum to ${sum}, above the retrieval's budget ${budget}`,
      );
    }
    return r;
  }
```

Add `resultKey` to the `staged-retrieval.js` export line in `collections/index.ts`.

- [ ] **Step 4: Run all StagedRetrieval tests**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): StagedRetrieval calls an injected IQueryDecomposer; k stays the overall limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 15: `ComposedToolsProfile` and tools bindings (libs)

Spec §3.3 (incl. `companionRecordIds`, S7), §6.1 (bind once, reuse), §7.2, §7.3.2 (notes, S1), §7.3.3 (companions), §7.7.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/composed-tools-profile.ts`
- Create: `packages/llm-agent-libs/src/collections/tools-binding.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: `StagedRetrieval` (Tasks 12–14); `prepareItem`, `storeItems`, `getItem`, `removeItem`, `listedCompanions` (Task 11); `isIndexNoteSource`, `IndexNote` (Task 3); `StrategyRag`, `hasRetrievalStrategy` (`src/retrieval/strategy-rag.ts`); indexers of Tasks 8–10.
- Produces:
  ```ts
  export interface ComposedToolsProfileOptions { readonly indexer: IItemIndexer<ToolItem>; readonly companions?: Readonly<Record<string, IItemIndexer<ToolItem>>>; readonly pool: ICandidatePool; readonly collapse: ICollapseRule; readonly rerank?: StagedRetrievalOptions['rerank']; readonly decompose?: StagedRetrievalOptions['decompose']; readonly cut?: IItemCut; readonly telemetry?: StagedRetrievalOptions['telemetry'] }
  export const TOOLS_PROFILE_NAME = 'mcp-tools';
  export class ComposedToolsProfile implements ICollectionProfile<ToolItem> { constructor(composition: ComposedToolsProfileOptions); readonly name: 'mcp-tools'; readonly composition: ComposedToolsProfileOptions }
  // bind(): bound.rag = StrategyRag(target.rag, StagedRetrieval); a companion indexer without a same-named store → throws.
  // index(): companions first; canonical carries companionRecordIds (S7); IndexReport.notes from IIndexNoteSource indexers (S1).
  // remove(): also the listed companion records (S7).
  export function bindToolsProfile(profile: ICollectionProfile<ToolItem>, target: CollectionStore): IBoundCollection<ToolItem>; // idempotent per store
  export function toolsBindingOf(rag: IRag): IBoundCollection<ToolItem> | undefined;         // walks IRagDecorator.inner
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InMemoryRag,
  type IRag,
  recordId,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import { hasRetrievalStrategy } from '../../retrieval/index.js';
import {
  bindToolsProfile,
  ComposedToolsProfile,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  IntentCompanionIndexer,
  ItemPool,
  MaxScoreCollapse,
  RequiredEnumDiscriminator,
  StaticIntentSource,
  SummaryFacet,
  toolItemFromTool,
  toolsBindingOf,
} from '../index.js';

const G = { scope: 'global' } as const;
const tool = (name: string, description: string) =>
  toolItemFromTool({ name, description }, { itemId: `tool:${name}`, originalName: name });
const TOOLS = [tool('read_file', 'Read a file from disk'), tool('list_issues', 'List open issues')];
const profile = (extra: Partial<ConstructorParameters<typeof ComposedToolsProfile>[0]> = {}) =>
  new ComposedToolsProfile({
    indexer: new FacetedToolIndexer([new SummaryFacet()]),
    pool: new ItemPool(10),
    collapse: new MaxScoreCollapse(),
    ...extra,
  });

describe('ComposedToolsProfile', () => {
  it('index → report counted in items; get returns the canonical item', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    const r = await bound.index(TOOLS);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { items: 2, indexedItems: 2, records: 4, failedItems: [] });
    const g = await bound.get({ itemId: 'tool:read_file', owner: G });
    assert.ok(g.ok);
    assert.equal(g.value?.text, 'Tool: read_file — Read a file from disk');
    assert.equal(g.value?.metadata.profile, 'mcp-tools');
  });

  it('retrieval through bound.rag: items keep metadata.id = itemId, so name-based consumers work unchanged', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    await bound.index(TOOLS);
    assert.equal(hasRetrievalStrategy(bound.rag), true);
    const r = await bound.rag.query(new TextOnlyEmbedding('read file'), 1);
    assert.ok(r.ok);
    assert.equal(r.value[0].metadata.id, 'tool:read_file');
    assert.equal(toolNameFromRecord(r.value[0].metadata), 'read_file');
  });

  it('too many records → failedItems too-many-records', async () => {
    const rag = new InMemoryRag();
    const coarse = toolItemFromTool(
      { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B', 'C'] } }, required: ['kind'] } },
      { itemId: 'tool:make', originalName: 'make' },
    );
    const bound = profile({
      indexer: new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 2 }),
    }).bind({ key: 'tools', rag });
    const r = await bound.index([coarse]);
    assert.ok(r.ok);
    assert.deepEqual(r.value.failedItems, [{ itemId: 'tool:make', reason: 'too-many-records' }]);
    assert.equal(r.value.indexedItems, 0);
  });

  it('companions: records go only into the companion store; a missing store is refused at bind', async () => {
    const rag = new InMemoryRag();
    const intents = new InMemoryRag();
    const p = profile({ companions: { intents: new IntentCompanionIndexer(new StaticIntentSource({ read_file: ['open my notes'] })) } });
    assert.throws(() => p.bind({ key: 'tools', rag }), /companion "intents"/);
    const bound = p.bind({ key: 'tools', rag, companions: { intents } });
    const r = await bound.index(TOOLS);
    assert.ok(r.ok && r.value.indexedItems === 2);
    const inCompanion = await intents.getById(recordId(G, 'tool:read_file', 'intent', 0));
    assert.ok(inCompanion.ok && inCompanion.value?.metadata.generated === true);
    const inPrimary = await rag.getById(recordId(G, 'tool:read_file', 'intent', 0));
    assert.ok(inPrimary.ok && inPrimary.value === null);
    const q = await bound.rag.query(new TextOnlyEmbedding('open my notes'), 1);
    assert.ok(q.ok);
    assert.equal(q.value[0].text, 'Tool: read_file — Read a file from disk');
  });

  it('remove deletes the item records', async () => {
    const rag = new InMemoryRag();
    const bound = profile().bind({ key: 'tools', rag });
    await bound.index(TOOLS);
    const n = await bound.remove([{ itemId: 'tool:read_file', owner: G }]);
    assert.ok(n.ok && n.value === 2);
  });
});

describe('bindToolsProfile / toolsBindingOf', () => {
  it('binds once per store (server + builder), found through decorators', () => {
    const raw: IRag = new InMemoryRag();
    const p = profile();
    const a = bindToolsProfile(p, { key: 'tools', rag: raw });
    const b = bindToolsProfile(p, { key: 'tools', rag: a.rag });
    assert.equal(a, b);
    const decorated: IRag = { inner: a.rag, query: (e, k, o) => a.rag.query(e, k, o), healthCheck: (o) => a.rag.healthCheck(o), getById: (i, o) => a.rag.getById(i, o) } as IRag;
    assert.equal(toolsBindingOf(decorated), a);
    assert.equal(toolsBindingOf(raw), undefined);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/composed-tools-profile.ts
import {
  type CallOptions,
  type CollectionStore,
  type IBoundCollection,
  type ICandidatePool,
  type ICollapseRule,
  type ICollectionProfile,
  type IItemCut,
  type IItemIndexer,
  type IndexReport,
  type IRag,
  type ISourceSelector,
  type ItemRef,
  type RagError,
  type RagResult,
  type Result,
  type RetrievalSource,
  recordId,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { StrategyRag } from '../retrieval/strategy-rag.js';
import {
  getItem,
  type PreparedItem,
  prepareItem,
  removeItem,
  storeItems,
} from './record-writer.js';
import {
  StagedRetrieval,
  type StagedRetrievalOptions,
} from './staged-retrieval.js';

export const TOOLS_PROFILE_NAME = 'mcp-tools';

/** A tools profile = a composition of strategies the consumer injects (spec §7.2). */
export interface ComposedToolsProfileOptions {
  /** Fills the primary store. */
  readonly indexer: IItemIndexer<ToolItem>;
  /** Each fills bind()'s companion store of that name (a `variants` source). */
  readonly companions?: Readonly<Record<string, IItemIndexer<ToolItem>>>;
  readonly pool: ICandidatePool;
  readonly collapse: ICollapseRule;
  readonly rerank?: StagedRetrievalOptions['rerank'];
  readonly decompose?: StagedRetrievalOptions['decompose'];
  readonly cut?: IItemCut;
  readonly telemetry?: StagedRetrievalOptions['telemetry'];
}

type Companion = readonly [name: string, indexer: IItemIndexer<ToolItem>, rag: IRag];

const reasonOf = (e: RagError): string =>
  e.code === 'TOO_MANY_RECORDS' ? 'too-many-records' : e.message;

class ToolsBinding implements IBoundCollection<ToolItem> {
  readonly rag: IRag;
  constructor(
    private readonly target: CollectionStore,
    private readonly indexer: IItemIndexer<ToolItem>,
    private readonly companions: readonly Companion[],
    readonly retrieval: StagedRetrieval,
    readonly profileName: string,
  ) {
    this.rag = new StrategyRag(target.rag, retrieval);
  }

  get key(): string {
    return this.target.key;
  }

  async index(
    items: readonly ToolItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>> {
    const failedItems: { itemId: string; reason: string }[] = [];
    const primary: { at: number; item: PreparedItem }[] = [];
    const side = this.companions.map(
      () => [] as { at: number; item: PreparedItem }[],
    );
    for (const [at, tool] of items.entries()) {
      const fail = (reason: string) =>
        failedItems.push({ itemId: tool.itemId, reason });
      const drafts = await this.indexer.toRecords(tool, options);
      if (!drafts.ok) {
        fail(reasonOf(drafts.error));
        continue;
      }
      const p = prepareItem(
        { itemId: tool.itemId, drafts: drafts.value },
        {
          canonicalKind: this.indexer.canonicalKind,
          profile: this.profileName,
          maxRecordsPerItem: this.indexer.maxRecordsPerItem,
        },
      );
      if (!p.ok) {
        fail(p.reason);
        continue;
      }
      const extra: (PreparedItem | undefined)[] = [];
      let refused: string | undefined;
      for (const [name, ci] of this.companions) {
        const cd = await ci.toRecords(tool, options);
        if (!cd.ok) {
          refused = `${name}: ${reasonOf(cd.error)}`;
          break;
        }
        if (cd.value.length === 0) {
          extra.push(undefined);
          continue;
        }
        const cp = prepareItem(
          { itemId: tool.itemId, drafts: cd.value },
          {
            canonicalKind: undefined,
            profile: this.profileName,
            maxRecordsPerItem: ci.maxRecordsPerItem,
          },
        );
        if (!cp.ok) {
          refused = `${name}: ${cp.reason}`;
          break;
        }
        extra.push(cp.item);
      }
      if (refused !== undefined) {
        fail(refused);
        continue;
      }
      primary.push({ at, item: p.item });
      extra.forEach((e, j) => {
        if (e) side[j].push({ at, item: e });
      });
    }
    const main = await storeItems(
      this.target.rag,
      primary.map((p) => p.item),
      options,
    );
    const done = new Set<number>();
    primary.forEach((p, i) => {
      if (main.indexed[i]) done.add(p.at);
      else
        failedItems.push({
          itemId: items[p.at].itemId,
          reason: main.failures[i] ?? 'write-failed',
        });
    });
    let records = main.records;
    for (const [j, [name, , rag]] of this.companions.entries()) {
      const r = await storeItems(rag, side[j].map((s) => s.item), options);
      records += r.records;
      side[j].forEach((s, i) => {
        if (!r.indexed[i] && done.delete(s.at)) {
          failedItems.push({
            itemId: items[s.at].itemId,
            reason: `${name}: ${r.failures[i] ?? 'write-failed'}`,
          });
        }
      });
    }
    return {
      ok: true,
      value: {
        items: items.length,
        indexedItems: done.size,
        records,
        failedItems,
      },
    };
  }

  private canonicalId(ref: ItemRef): string {
    return recordId(ref.owner, ref.itemId, this.indexer.canonicalKind, 0);
  }

  async remove(
    refs: readonly ItemRef[],
    options?: CallOptions,
  ): Promise<Result<number, RagError>> {
    let n = 0;
    for (const ref of refs) {
      const r = await removeItem(this.target.rag, this.canonicalId(ref), options);
      if (!r.ok) return r;
      n += r.value;
    }
    return { ok: true, value: n };
  }

  get(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    return getItem(this.target.rag, this.canonicalId(ref), options, options);
  }
}

/** The tools profile any composition is built with (spec §7.2). */
export class ComposedToolsProfile implements ICollectionProfile<ToolItem> {
  readonly name = TOOLS_PROFILE_NAME;
  constructor(readonly composition: ComposedToolsProfileOptions) {
    if (composition.companions && 'primary' in composition.companions) {
      throw new Error(
        'ComposedToolsProfile: "primary" names the items source; name the companion otherwise',
      );
    }
  }

  bind(target: CollectionStore): IBoundCollection<ToolItem> {
    const c = this.composition;
    const companions: Companion[] = [];
    for (const [name, indexer] of Object.entries(c.companions ?? {})) {
      const rag = target.companions?.[name];
      if (!rag) {
        throw new Error(
          `ComposedToolsProfile: companion "${name}" has no store — bind({ companions: { ${name}: <IRag> } })`,
        );
      }
      companions.push([name, indexer, rag]);
    }
    const sources: ISourceSelector = {
      sources: async (options) => [
        { name: 'primary', rag: target.rag, role: 'items', options },
        ...companions.map(
          ([name, , rag]): RetrievalSource => ({
            name,
            rag,
            role: 'variants',
            itemsOf: 'primary',
            options,
          }),
        ),
      ],
    };
    const retrieval = new StagedRetrieval({
      name: this.name,
      storeKey: target.key,
      pool: c.pool,
      maxRecordsPerItem: c.indexer.maxRecordsPerItem,
      canonicalKind: c.indexer.canonicalKind,
      sources,
      collapse: c.collapse,
      ...(c.rerank ? { rerank: c.rerank } : {}),
      ...(c.decompose ? { decompose: c.decompose } : {}),
      ...(c.cut ? { cut: c.cut } : {}),
      ...(c.telemetry ? { telemetry: c.telemetry } : {}),
    });
    return new ToolsBinding(target, c.indexer, companions, retrieval, this.name);
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/tools-binding.ts
import {
  type CollectionStore,
  type IBoundCollection,
  type ICollectionProfile,
  type IRag,
  isRagDecorator,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import {
  hasRetrievalStrategy,
  StrategyRag,
} from '../retrieval/strategy-rag.js';

const BINDINGS = new WeakMap<IRag, IBoundCollection<ToolItem>>();

/** The tools binding `rag` carries, or one of the stores it decorates (≤ 16 levels). */
export function toolsBindingOf(
  rag: IRag,
): IBoundCollection<ToolItem> | undefined {
  let cur: IRag | undefined = rag;
  for (let depth = 0; cur && depth < 16; depth++) {
    const b = BINDINGS.get(cur);
    if (b) return b;
    cur = isRagDecorator(cur) ? cur.inner : undefined;
  }
  return undefined;
}

/**
 * Bind a tools profile to a store ONCE (spec §6.1): the server binds at
 * creation, the builder reuses it. The bound store always carries the
 * retrieval (a consumer profile whose `rag` lacks it gets a StrategyRag).
 */
export function bindToolsProfile(
  profile: ICollectionProfile<ToolItem>,
  target: CollectionStore,
): IBoundCollection<ToolItem> {
  const existing = toolsBindingOf(target.rag);
  if (existing) return existing;
  const bound = profile.bind(target);
  const rag = hasRetrievalStrategy(bound.rag)
    ? bound.rag
    : new StrategyRag(bound.rag, bound.retrieval);
  const registered: IBoundCollection<ToolItem> =
    rag === bound.rag
      ? bound
      : {
          key: bound.key,
          profileName: bound.profileName,
          rag,
          retrieval: bound.retrieval,
          index: (items, o) => bound.index(items, o),
          remove: (refs, o) => bound.remove(refs, o),
          get: (ref, o) => bound.get(ref, o),
        };
  BINDINGS.set(rag, registered);
  return registered;
}
```

Append to `collections/index.ts`:
```ts
export {
  ComposedToolsProfile,
  type ComposedToolsProfileOptions,
  TOOLS_PROFILE_NAME,
} from './composed-tools-profile.js';
export { bindToolsProfile, toolsBindingOf } from './tools-binding.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Companion records on remove and replacement (S7); notes in the report (S1)**

Spec §3.3 (amended): the canonical record lists the item's companion records in `companionRecordIds`; `remove` and replacement delete them from the companion store. Spec §7.3.2: the binding collects `IIndexNoteSource` notes into `IndexReport.notes`. Write order (spec §3.3): companion records → primary non-canonical → canonical → stale deletes in each store.

Append to `composed-tools-profile.test.ts`:

```ts
describe('companion records (S7) and notes (S1) in the binding', () => {
  const companionProfile = (m: Record<string, string[]>) =>
    profile({ companions: { intents: new IntentCompanionIndexer(new StaticIntentSource(m)) } });

  it('the canonical lists its companion records; remove deletes them too', async () => {
    const rag = new InMemoryRag();
    const intents = new InMemoryRag();
    const bound = companionProfile({ read_file: ['open my notes'] }).bind({ key: 'tools', rag, companions: { intents } });
    await bound.index(TOOLS);
    const cid = recordId(G, 'tool:read_file', 'intent', 0);
    const canon = await rag.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(canon.ok);
    assert.deepEqual(canon.value?.metadata.companionRecordIds, { intents: [cid] });
    const n = await bound.remove([{ itemId: 'tool:read_file', owner: G }]);
    assert.ok(n.ok && n.value === 3, 'full + summary + the companion intent');
    const gone = await intents.getById(cid);
    assert.ok(gone.ok && gone.value === null);
  });

  it('re-indexing without intents deletes the old companion record', async () => {
    const rag = new InMemoryRag();
    const intents = new InMemoryRag();
    await companionProfile({ read_file: ['open my notes'] }).bind({ key: 'tools', rag, companions: { intents } }).index(TOOLS);
    await companionProfile({}).bind({ key: 'tools', rag, companions: { intents } }).index(TOOLS);
    const gone = await intents.getById(recordId(G, 'tool:read_file', 'intent', 0));
    assert.ok(gone.ok && gone.value === null);
    const canon = await rag.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(canon.ok && canon.value?.metadata.companionRecordIds === undefined);
  });

  it('a failed companion write fails the item before its primary records are written', async () => {
    const rag = new InMemoryRag();
    const broken = new InMemoryRag();
    const w = broken.writer();
    w.upsertRaw = async () => ({ ok: false, error: new RagError('down') });
    const bound = companionProfile({ read_file: ['open my notes'] }).bind({ key: 'tools', rag, companions: { intents: broken } });
    const r = await bound.index(TOOLS);
    assert.ok(r.ok);
    assert.deepEqual(r.value.failedItems.map((f) => f.itemId), ['tool:read_file']);
    const canon = await rag.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(canon.ok && canon.value === null);
  });

  it('notes from the indexers land in IndexReport.notes with the item id', async () => {
    const coarse = toolItemFromTool(
      { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B'] }, region: { enum: ['EU', 'US'] } }, required: ['kind', 'region'] } },
      { itemId: 'tool:make', originalName: 'make' },
    );
    const bound = profile({
      indexer: new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 5 }),
    }).bind({ key: 'tools', rag: new InMemoryRag() });
    const r = await bound.index([coarse]);
    assert.ok(r.ok);
    assert.deepEqual(r.value.notes, [{ itemId: 'tool:make', note: 'ambiguous-discriminator', detail: 'kind, region' }]);
    assert.equal(r.value.indexedItems, 1);
  });
});
```
Add `RagError` to the test's `@mcp-abap-adt/llm-agent` import. (If `InMemoryRag.writer()` returns a fresh object per call, wrap the store instead: `{ ...broken, writer: () => ({ ...broken.writer(), upsertRaw: async () => ({ ok: false, error: new RagError('down') }) }) }` cast to `IRag`, keeping `getById` / `query` delegating.)

Run it: FAIL — no `companionRecordIds`; `remove` leaves the intent; no `notes`.

In `composed-tools-profile.ts`: add `type IndexNote`, `isIndexNoteSource` to the `@mcp-abap-adt/llm-agent` import and `listedCompanions` to the `./record-writer.js` import. Replace `ToolsBinding.index` and `ToolsBinding.remove` with:

```ts
  async index(
    items: readonly ToolItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>> {
    const failedItems: { itemId: string; reason: string }[] = [];
    const notes: ({ itemId: string } & IndexNote)[] = [];
    const primary: { at: number; item: PreparedItem }[] = [];
    const side = this.companions.map(
      () => [] as { at: number; item: PreparedItem }[],
    );
    for (const [at, tool] of items.entries()) {
      const fail = (reason: string) =>
        failedItems.push({ itemId: tool.itemId, reason });
      const drafts = await this.indexer.toRecords(tool, options);
      if (!drafts.ok) {
        fail(reasonOf(drafts.error));
        continue;
      }
      // Companions first: their record ids go on the canonical record (S7).
      const extra: (PreparedItem | undefined)[] = [];
      let refused: string | undefined;
      for (const [name, ci] of this.companions) {
        const cd = await ci.toRecords(tool, options);
        if (!cd.ok) {
          refused = `${name}: ${reasonOf(cd.error)}`;
          break;
        }
        if (cd.value.length === 0) {
          extra.push(undefined);
          continue;
        }
        const cp = prepareItem(
          { itemId: tool.itemId, drafts: cd.value },
          {
            canonicalKind: undefined,
            profile: this.profileName,
            maxRecordsPerItem: ci.maxRecordsPerItem,
          },
        );
        if (!cp.ok) {
          refused = `${name}: ${cp.reason}`;
          break;
        }
        extra.push(cp.item);
      }
      if (refused !== undefined) {
        fail(refused);
        continue;
      }
      const companionRecordIds: Record<string, string[]> = {};
      extra.forEach((e, j) => {
        if (e) companionRecordIds[this.companions[j][0]] = e.others.map((r) => r.id);
      });
      const p = prepareItem(
        { itemId: tool.itemId, drafts: drafts.value },
        {
          canonicalKind: this.indexer.canonicalKind,
          profile: this.profileName,
          maxRecordsPerItem: this.indexer.maxRecordsPerItem,
          companionRecordIds,
        },
      );
      if (!p.ok) {
        fail(p.reason);
        continue;
      }
      // S1: what any indexer declined to guess, reported with the item's id.
      for (const ix of [this.indexer, ...this.companions.map(([, ci]) => ci)]) {
        if (!isIndexNoteSource<ToolItem>(ix)) continue;
        for (const n of ix.notesFor(tool)) notes.push({ itemId: tool.itemId, ...n });
      }
      primary.push({ at, item: p.item });
      extra.forEach((e, j) => {
        if (e) side[j].push({ at, item: e });
      });
    }
    // Write order (spec §3.3): companion records → primary non-canonical →
    // canonical → stale deletes. NOT atomic (D13); readers stay safe through hydration.
    let records = 0;
    const sideFailed = new Map<number, string>();
    for (const [j, [name, , rag]] of this.companions.entries()) {
      const r = await storeItems(rag, side[j].map((x) => x.item), options);
      records += r.records;
      side[j].forEach((x, i) => {
        if (!r.indexed[i] && !sideFailed.has(x.at)) {
          sideFailed.set(x.at, `${name}: ${r.failures[i] ?? 'write-failed'}`);
        }
      });
    }
    const live = primary.filter((x) => !sideFailed.has(x.at));
    for (const x of primary) {
      const why = sideFailed.get(x.at);
      if (why) failedItems.push({ itemId: items[x.at].itemId, reason: why });
    }
    const main = await storeItems(
      this.target.rag,
      live.map((x) => x.item),
      options,
    );
    records += main.records;
    let indexedItems = 0;
    for (const [i, x] of live.entries()) {
      if (!main.indexed[i]) {
        failedItems.push({
          itemId: items[x.at].itemId,
          reason: main.failures[i] ?? 'write-failed',
        });
        continue;
      }
      indexedItems++;
      // S7: companion records the previous canonical listed and this one does not.
      const now = listedCompanions(x.item.canonical?.metadata);
      for (const [name, ids] of Object.entries(main.oldCompanions[i])) {
        const keep = new Set(now[name] ?? []);
        const w = this.companionStore(name)?.writer?.();
        for (const id of ids) {
          if (!keep.has(id)) await w?.deleteByIdRaw(id, options);
        }
      }
    }
    return {
      ok: true,
      value: {
        items: items.length,
        indexedItems,
        records,
        failedItems,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }

  private companionStore(name: string): IRag | undefined {
    return this.companions.find(([n]) => n === name)?.[2];
  }

  async remove(
    refs: readonly ItemRef[],
    options?: CallOptions,
  ): Promise<Result<number, RagError>> {
    // S7: the canonical's companionRecordIds are deleted from these stores too.
    const companions = Object.fromEntries(
      this.companions.map(([name, , rag]) => [name, rag]),
    );
    let n = 0;
    for (const ref of refs) {
      const r = await removeItem(
        this.target.rag,
        this.canonicalId(ref),
        options,
        companions,
      );
      if (!r.ok) return r;
      n += r.value;
    }
    return { ok: true, value: n };
  }
```

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts`
Expected: PASS (the earlier tests too: with no companions and no notes the report has no `notes` key and `companionRecordIds` is not written).

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): ComposedToolsProfile and once-per-store tools bindings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 16: Default compositions — `mcpToolsVariants` (libs)

Spec §7.1, §7.4 (the table — every tuned number cites it), §5.5 (both named rerankers are `DecisionReranker` over an injected `IDecisionModel`); D11, D16, D23.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/mcp-tools-variants.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`, `tsconfig.typecheck.json`

**Interfaces:**
- Consumes: `ComposedToolsProfile` (Task 15); `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `ItemPool`, `MaxScoreCollapse`, `FixedItemsCut`; `DecisionReranker`, `TOOL_QUESTION` (`src/reranker/decision-reranker.ts`); `IDecisionModel`, `IReranker`, `IToolIntentSource`. (Libs never imports a provider package: the Cohere model `SapAiCoreDecisionModel` of Task 18 arrives as an `IDecisionModel`.)
- Produces:
  ```ts
  export type VariantIntents = { readonly record: IToolIntentSource } | { readonly companion: IToolIntentSource };
  export interface VariantOptions { readonly intents?: VariantIntents; readonly decompose?: StagedRetrievalOptions['decompose']; readonly telemetry?: StagedRetrievalOptions['telemetry'] }
  export const mcpToolsVariants: {
    baseline(): undefined;
    faceted(o?: VariantOptions): ComposedToolsProfile;
    facetedCohere(o: VariantOptions & { decisionModel: IDecisionModel }): ComposedToolsProfile; // the Cohere model (SapAiCoreDecisionModel)
    facetedJev(o: VariantOptions & { decisionModel: IDecisionModel }): ComposedToolsProfile;
    smallSetJev(o: VariantOptions & { decisionModel: IDecisionModel; poolItems: number }): ComposedToolsProfile;
  };
  export const MCP_TOOLS_VARIANT_NAMES: readonly ['baseline', 'faceted', 'faceted-cohere', 'faceted-jev', 'small-set-jev'];
  // companion placement binds with companions: { intents: <IRag> }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IDecisionModel, IItemIndexer, ToolItem } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker } from '../../reranker/decision-reranker.js';
import {
  type ComposedToolsProfile,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  FixedItemsCut,
  IntentCompanionIndexer,
  IntentRecordIndexer,
  ItemPool,
  MaxScoreCollapse,
  mcpToolsVariants,
  NameTailFacet,
  ParametersFacet,
  StaticIntentSource,
  SummaryFacet,
  TokenBudgetCut,
} from '../index.js';

const model = { decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) } as unknown as IDecisionModel;
const cohereModel = { model: 'cohere-rerank', decide: async () => ({ ok: true, value: { model: 'cohere-rerank', answers: {} } }) } as unknown as IDecisionModel;

function shape(p: ComposedToolsProfile) {
  const c = p.composition;
  return {
    pool: (c.pool as ItemPool).items,
    collapse: c.collapse instanceof MaxScoreCollapse,
    cut: c.cut instanceof FixedItemsCut ? c.cut.k : undefined,
    reranker: c.rerank?.reranker,
    onFailure: c.rerank?.onFailure,
    decompose: c.decompose,
  };
}
function facetsOf(indexer: IItemIndexer<ToolItem>): readonly object[] {
  const base = indexer instanceof IntentRecordIndexer ? indexer.inner : indexer;
  assert.ok(base instanceof FacetedToolIndexer);
  return base.facets;
}
const all = () => [
  mcpToolsVariants.faceted(),
  mcpToolsVariants.facetedCohere({ decisionModel: cohereModel }),
  mcpToolsVariants.facetedJev({ decisionModel: model }),
  mcpToolsVariants.smallSetJev({ decisionModel: model, poolItems: 25 }),
];

describe('mcpToolsVariants — the §7.4 table, exactly', () => {
  it('baseline binds nothing', () => {
    assert.equal(mcpToolsVariants.baseline(), undefined);
  });
  it('faceted: summary + parameters, ItemPool(15), max, no reranker, FixedItemsCut(8)', () => {
    const p = mcpToolsVariants.faceted();
    assert.deepEqual(facetsOf(p.composition.indexer).map((f) => f.constructor), [SummaryFacet, ParametersFacet]);
    assert.deepEqual(shape(p), { pool: 15, collapse: true, cut: 8, reranker: undefined, onFailure: undefined, decompose: undefined });
  });
  it('faceted-cohere: ItemPool(30) + DecisionReranker over the given (Cohere) model + FixedItemsCut(5)', () => {
    const s = shape(mcpToolsVariants.facetedCohere({ decisionModel: cohereModel }));
    assert.ok(s.reranker instanceof DecisionReranker);
    assert.deepEqual({ ...s, reranker: undefined }, { pool: 30, collapse: true, cut: 5, reranker: undefined, onFailure: 'stage1', decompose: undefined });
  });
  it('faceted-cohere and faceted-jev are the same composition with a different model (spec §5.5)', () => {
    const c = shape(mcpToolsVariants.facetedCohere({ decisionModel: cohereModel }));
    const j = shape(mcpToolsVariants.facetedJev({ decisionModel: model }));
    assert.deepEqual({ ...c, reranker: undefined }, { ...j, reranker: undefined });
  });
  it('faceted-jev: ItemPool(30) + DecisionReranker + FixedItemsCut(5)', () => {
    const s = shape(mcpToolsVariants.facetedJev({ decisionModel: model }));
    assert.ok(s.reranker instanceof DecisionReranker);
    assert.deepEqual([s.pool, s.cut], [30, 5]);
  });
  it('small-set-jev: FacetedToolIndexer([]) + ItemPool(poolItems) + max + DecisionReranker + FixedItemsCut(3)', () => {
    const p = mcpToolsVariants.smallSetJev({ decisionModel: model, poolItems: 25 });
    assert.deepEqual(facetsOf(p.composition.indexer), []);
    const s = shape(p);
    assert.ok(s.reranker instanceof DecisionReranker);
    assert.deepEqual([s.pool, s.cut, s.collapse], [25, 3, true]);
  });
  it('no variant contains NameTailFacet, EnumValueToolIndexer or TokenBudgetCut', () => {
    for (const p of all()) {
      assert.ok(!(p.composition.indexer instanceof EnumValueToolIndexer));
      assert.ok(!facetsOf(p.composition.indexer).some((f) => f instanceof NameTailFacet));
      assert.ok(!(p.composition.cut instanceof TokenBudgetCut));
    }
  });
  it('intents: record placement wraps the indexer; companion placement adds a companion', () => {
    const src = new StaticIntentSource({});
    const rec = mcpToolsVariants.faceted({ intents: { record: src } });
    assert.ok(rec.composition.indexer instanceof IntentRecordIndexer);
    const comp = mcpToolsVariants.faceted({ intents: { companion: src } });
    assert.ok(comp.composition.companions?.intents instanceof IntentCompanionIndexer);
  });
  it("the consumer's decomposer is passed through; none otherwise", () => {
    const decompose = { decomposer: { name: 'd', decompose: async () => ({ ok: true as const, value: [] }) }, queryEmbedder: { embedQuery: async () => ({ vector: [1] }) } };
    assert.equal(mcpToolsVariants.facetedJev({ decisionModel: model, decompose }).composition.decompose, decompose);
    for (const p of all()) assert.equal(p.composition.decompose, undefined);
  });
  it('poolItems must be a positive integer', () => {
    assert.throws(() => mcpToolsVariants.smallSetJev({ decisionModel: model, poolItems: 0 }));
  });
});
```

```ts
// packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts
// Compile-time assertions only: listed in tsconfig.typecheck.json, run by `npm run typecheck`.
import type { IDecisionModel, IToolIntentSource } from '@mcp-abap-adt/llm-agent';
import { mcpToolsVariants } from '../mcp-tools-variants.js';

declare const model: IDecisionModel;
declare const intents: IToolIntentSource;
export const _ok = mcpToolsVariants.smallSetJev({ decisionModel: model, poolItems: 25 });
// @ts-expect-error intents are refused on baseline
export const _baselineIntents = mcpToolsVariants.baseline({ intents: { record: intents } });
// @ts-expect-error small-set-jev needs poolItems
export const _noPool = mcpToolsVariants.smallSetJev({ decisionModel: model });
// @ts-expect-error faceted-jev needs a decision model
export const _noModel = mcpToolsVariants.facetedJev({});
// @ts-expect-error faceted-cohere needs a decision model (Cohere: SapAiCoreDecisionModel)
export const _noCohere = mcpToolsVariants.facetedCohere({});
```

Add `"packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts"` to `tsconfig.typecheck.json` `include`.

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts`
Expected: FAIL — `mcpToolsVariants` not exported.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/mcp-tools-variants.ts
/**
 * Default compositions ("variants", spec §7.4). They fill in what the consumer
 * did not choose; each tuned number below cites its measurement (§7.1). None
 * relies on one server's conventions (§7.0). Figures: required-recall, hybrid
 * in-store scoring, measured on mcp-abap-adt (one consumer, one server).
 */
import type {
  IDecisionModel,
  IItemIndexer,
  IReranker,
  IToolIntentSource,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
// Both named rerankers are DecisionReranker over an injected IDecisionModel (spec §5.5):
// Cohere = SapAiCoreDecisionModel (@mcp-abap-adt/sap-aicore-decision), Jev = TypeSafeDecisionModel.
import { DecisionReranker, TOOL_QUESTION } from '../reranker/decision-reranker.js';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import { ComposedToolsProfile } from './composed-tools-profile.js';
import { FixedItemsCut } from './cuts.js';
import { ItemPool } from './item-pool.js';
import { MaxScoreCollapse } from './max-score-collapse.js';
import type { StagedRetrievalOptions } from './staged-retrieval.js';
import { FacetedToolIndexer } from './tools/faceted-tool-indexer.js';
import { ParametersFacet, SummaryFacet } from './tools/facets.js';
import {
  IntentCompanionIndexer,
  IntentRecordIndexer,
} from './tools/intent-indexers.js';

/** Intents: their own record in the tool collection (default) or a companion collection. */
export type VariantIntents =
  | { readonly record: IToolIntentSource }
  | { readonly companion: IToolIntentSource };

export interface VariantOptions {
  readonly intents?: VariantIntents;
  /** The consumer's own decomposer (none ships, spec §4.5). */
  readonly decompose?: StagedRetrievalOptions['decompose'];
  readonly telemetry?: StagedRetrievalOptions['telemetry'];
}

export const MCP_TOOLS_VARIANT_NAMES = [
  'baseline',
  'faceted',
  'faceted-cohere',
  'faceted-jev',
  'small-set-jev',
] as const;

function indexing(
  base: IItemIndexer<ToolItem>,
  intents: VariantIntents | undefined,
): Pick<ComposedToolsProfile['composition'], 'indexer' | 'companions'> {
  if (!intents) return { indexer: base };
  if ('record' in intents) {
    return { indexer: new IntentRecordIndexer(base, intents.record) };
  }
  return {
    indexer: base,
    companions: { intents: new IntentCompanionIndexer(intents.companion) },
  };
}

const facetedBase = () =>
  new FacetedToolIndexer([new SummaryFacet(), new ParametersFacet()]);

const passThrough = (o: VariantOptions) => ({
  ...(o.decompose ? { decompose: o.decompose } : {}),
  ...(o.telemetry ? { telemetry: o.telemetry } : {}),
});

/** DecisionReranker + TOOL_QUESTION over the model the composition names. Cohere reads
 *  neither task nor criteria (spec §5.2); Jev reads both. */
const toolReranker = (model: IDecisionModel): IReranker =>
  new DecisionReranker(model, {
    task: TOOL_QUESTION.task,
    criteria: TOOL_QUESTION.criteria,
  });

export const mcpToolsVariants = {
  /** No choice made: 30.1.0, one record per tool + top-k records. Binds nothing.
   *  Measured: EN-ext 0.943 at k=5 (8.3 tools); 0.977 at k=15 (~25 tools). */
  baseline(): undefined {
    return undefined;
  },

  /** Fine-grained sets. ItemPool(15) + FixedItemsCut(8): the closest measured layout's
   *  numbers (name-derived facets: 0.977 at k=8, ~13 tools; without a reranker
   *  ItemPool(15) = 30). The schema-derived layout is NOT yet measured (D16). */
  faceted(o: VariantOptions = {}): ComposedToolsProfile {
    return new ComposedToolsProfile({
      ...indexing(facetedBase(), o.intents),
      pool: new ItemPool(15),
      collapse: new MaxScoreCollapse(),
      cut: new FixedItemsCut(8),
      ...passThrough(o),
    });
  },

  /** Fine-grained + Cohere on SAP AI Core: pass a SapAiCoreDecisionModel. Pool 30
   *  ITEMS (non-English 0.962 vs 0.846–0.885 with 30 records), k=5. Not measured as
   *  one composition. ≤ 30 tools per query → typically one /rerank call. */
  facetedCohere(o: VariantOptions & { decisionModel: IDecisionModel }): ComposedToolsProfile {
    return new ComposedToolsProfile({
      ...indexing(facetedBase(), o.intents),
      pool: new ItemPool(30),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: toolReranker(o.decisionModel), onFailure: 'stage1' },
      cut: new FixedItemsCut(5),
      ...passThrough(o),
    });
  },

  /** Fine-grained + TypeSafe Jev. Pool 30 items, k=5. TO BE MEASURED AS ONE
   *  COMPOSITION ON FRESH CONSUMER QUERIES BEFORE PROMOTION (D11). */
  facetedJev(o: VariantOptions & { decisionModel: IDecisionModel }): ComposedToolsProfile {
    return new ComposedToolsProfile({
      ...indexing(facetedBase(), o.intents),
      pool: new ItemPool(30),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: toolReranker(o.decisionModel), onFailure: 'stage1' },
      cut: new FixedItemsCut(5),
      ...passThrough(o),
    });
  },

  /** Coarse / small sets: one `full` record per tool + Jev over the WHOLE set
   *  (rerank-all) + 3 tools. Measured on mcp-abap-adt `compact` (25 tools):
   *  0.970 at ~1.6k tokens (whole set ≈ 7.9k); k=3 is the knee (k=2 0.925,
   *  k=5 0.970). `poolItems` is the consumer's tool count, not a tuned number:
   *  the composition root checks poolItems ≥ the count at startup (D23). */
  smallSetJev(
    o: VariantOptions & { decisionModel: IDecisionModel; poolItems: number },
  ): ComposedToolsProfile {
    assertPositiveInteger('smallSetJev', 'poolItems', o.poolItems);
    return new ComposedToolsProfile({
      ...indexing(new FacetedToolIndexer([]), o.intents),
      pool: new ItemPool(o.poolItems),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: toolReranker(o.decisionModel), onFailure: 'stage1' },
      cut: new FixedItemsCut(3),
      ...passThrough(o),
    });
  },
} as const;
```

Append to `collections/index.ts`:
```ts
export {
  MCP_TOOLS_VARIANT_NAMES,
  mcpToolsVariants,
  type VariantIntents,
  type VariantOptions,
} from './mcp-tools-variants.js';
```

- [ ] **Step 4: Run tests and typecheck**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts
npm run typecheck
```
Expected: PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections tsconfig.typecheck.json
git commit -m "feat(libs): mcpToolsVariants — baseline, faceted, faceted-cohere, faceted-jev, small-set-jev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 17: `SharedItemsProfile` (libs)

Spec §8 (all), §3.6; D5, D6, D13–D15.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/shared-items-profile.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/shared-items-profile.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`
- Modify: `packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts` (append)

**Interfaces:**
- Consumes: Tasks 11–14; `StrategyRag`; `SharedItem`, `SharedItemsStores`, `ISharedItemGroups`, `recordId`.
- Produces:
  ```ts
  export interface SharedItemsProfileOptions { readonly maxRecordsPerItem: number; readonly pool: ICandidatePool; readonly collapse: ICollapseRule; readonly rerank?: StagedRetrievalOptions['rerank']; readonly decompose?: StagedRetrievalOptions['decompose']; readonly cut?: IItemCut; readonly telemetry?: StagedRetrievalOptions['telemetry'] }
  export const SHARED_ITEMS_PROFILE_NAME = 'shared-items';
  export class SharedItemsProfile implements ICollectionProfile<SharedItem, SharedItemsStores> { constructor(o: SharedItemsProfileOptions); readonly name: 'shared-items' }
  // refusal reasons: 'reserved-kind', 'too-many-records', 'foreign-user', 'no-partition'
  // sources: 'user' (ragFilter { userId: options.userId }; skipped without userId), 'global' (unfiltered), 'group:<id>' per readable group
  // remove of another user's item → RagError code 'OWNER_MISMATCH'
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/shared-items-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IBoundCollection,
  InMemoryRag,
  type ISharedItemGroups,
  recordId,
  type SharedItem,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { ItemPool, MaxScoreCollapse, SharedItemsProfile } from '../index.js';
import { matchesOnly } from './staged-retrieval-helpers.js';

const profile = () =>
  new SharedItemsProfile({ maxRecordsPerItem: 3, pool: new ItemPool(10), collapse: new MaxScoreCollapse() });
const A: CallOptions = { userId: 'A' };
const B: CallOptions = { userId: 'B' };
const userItem = (userId: string, text: string, extra: Partial<SharedItem> = {}): SharedItem => ({
  itemId: 'case-42',
  visibility: { scope: 'user', userId },
  text,
  data: { by: userId },
  ...extra,
});
const retrieve = (bound: IBoundCollection<SharedItem>, text: string, o?: CallOptions) =>
  bound.retrieval.retrieve(bound.rag, new TextOnlyEmbedding(text), 5, o);

describe('SharedItemsProfile', () => {
  it('identical item ids across users stay separate (get, re-index, remove, retrieval)', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user: matchesOnly(user) });
    await bound.index([userItem('A', 'alpha needle')], A);
    await bound.index([userItem('B', 'bravo needle')], B);
    const idA = recordId({ scope: 'user', userId: 'A' }, 'case-42', 'item', 0);
    const idB = recordId({ scope: 'user', userId: 'B' }, 'case-42', 'item', 0);
    assert.notEqual(idA, idB);
    const getA = await bound.get({ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }, A);
    assert.ok(getA.ok);
    assert.equal(getA.value?.text, 'alpha needle');
    assert.deepEqual(getA.value?.metadata.data, { by: 'A' });
    await bound.index([userItem('B', 'bravo changed')], B);
    const stillA = await user.getById(idA);
    assert.ok(stillA.ok && stillA.value?.text === 'alpha needle');
    await bound.remove([{ itemId: 'case-42', owner: { scope: 'user', userId: 'B' } }], B);
    const afterRemove = await user.getById(idA);
    assert.ok(afterRemove.ok && afterRemove.value !== null);
    const r = await retrieve(bound, 'needle', A);
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => x.metadata.userId), ['A']);
  });

  it('flattens owner keys per visibility', async () => {
    const user = new InMemoryRag();
    const global = new InMemoryRag();
    const group = new InMemoryRag();
    const groups: ISharedItemGroups = {
      readable: async () => [{ groupId: 'g1', rag: group }],
      writable: async (id) => (id === 'g1' ? group : undefined),
    };
    const bound = profile().bind({ key: 'shared', user, global, groups });
    const r = await bound.index(
      [
        userItem('A', 'u'),
        { itemId: 'g', visibility: { scope: 'group', groupId: 'g1' }, text: 'g' },
        { itemId: 'x', visibility: { scope: 'global' }, text: 'x', ttl: 4102444800 },
      ],
      A,
    );
    assert.ok(r.ok && r.value.indexedItems === 3);
    const g = await group.getById(recordId({ scope: 'group', groupId: 'g1' }, 'g', 'item', 0));
    assert.ok(g.ok && g.value?.metadata.groupId === 'g1' && g.value.metadata.visibility === 'group');
    const x = await global.getById(recordId({ scope: 'global' }, 'x', 'item', 0));
    assert.ok(x.ok && x.value?.metadata.visibility === 'global' && x.value.metadata.ttl === 4102444800);
  });

  it('refusals land in failedItems and write nothing', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    const r = await bound.index(
      [
        userItem('B', 'foreign'),
        userItem('A', 'k', { itemId: 'k1', records: [{ kind: 'item', text: 'x' }] }),
        userItem('A', 'm', { itemId: 'm1', records: [{ kind: 'a', text: '1' }, { kind: 'a', text: '2' }, { kind: 'a', text: '3' }] }),
        { itemId: 'gl', visibility: { scope: 'global' }, text: 'no global store' },
      ],
      A,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value.failedItems.map((f) => f.reason), ['foreign-user', 'reserved-kind', 'too-many-records', 'no-partition']);
    assert.equal(r.value.indexedItems, 0);
  });

  it('extra records are searchable and return the item whole', async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user: matchesOnly(user) });
    await bound.index([userItem('A', 'the whole case', { records: [{ kind: 'symptom', text: 'needle' }] })], A);
    const r = await retrieve(bound, 'needle', A);
    assert.ok(r.ok);
    assert.equal(r.value[0].text, 'the whole case');
    assert.deepEqual(r.value[0].metadata.matchedKinds, ['symptom']);
  });

  it('the user partition is skipped without a userId (fail closed); global still answers', async () => {
    const user = new InMemoryRag();
    const global = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user: matchesOnly(user), global: matchesOnly(global) });
    await bound.index([userItem('A', 'needle mine'), { itemId: 'pub', visibility: { scope: 'global' }, text: 'needle public' }], A);
    const r = await retrieve(bound, 'needle');
    assert.ok(r.ok);
    assert.deepEqual(r.value.map((x) => x.metadata.id), ['pub']);
  });

  it("get is identity-checked; removing another user's item is refused", async () => {
    const user = new InMemoryRag();
    const bound = profile().bind({ key: 'shared', user });
    await bound.index([userItem('A', 'secret')], A);
    const asB = await bound.get({ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }, B);
    assert.ok(asB.ok && asB.value === null);
    const rm = await bound.remove([{ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }], B);
    assert.ok(!rm.ok && rm.error.code === 'OWNER_MISMATCH');
  });
});
```

Append to `collection-profile.typecheck.ts` (imports at the top):
```ts
import type { ICollectionProfile, ToolItem } from '@mcp-abap-adt/llm-agent';
import { ItemPool } from '../item-pool.js';
import { MaxScoreCollapse } from '../max-score-collapse.js';
import { SharedItemsProfile } from '../shared-items-profile.js';

const shared = new SharedItemsProfile({ maxRecordsPerItem: 2, pool: new ItemPool(5), collapse: new MaxScoreCollapse() });
// @ts-expect-error a shared-items profile is not a tools profile
export const _notTools: ICollectionProfile<ToolItem> = shared;
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/shared-items-profile.test.ts`
Expected: FAIL — `SharedItemsProfile` not exported.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/shared-items-profile.ts
/**
 * A generic shared base (spec §8): pipeline elements write items through
 * index()/remove(); the profile finds them and returns each item WHOLE, with
 * owner and visibility. What an item holds is the writing element's business.
 * Visibility → partitions (D5): user / global stores given at bind, group
 * stores from the consumer's ISharedItemGroups.
 */
import {
  type CallOptions,
  type IBoundCollection,
  type ICandidatePool,
  type ICollapseRule,
  type ICollectionProfile,
  type IItemCut,
  type IndexReport,
  type IRag,
  type ItemRef,
  RagError,
  type RagResult,
  type RecordDraft,
  type Result,
  type RetrievalSource,
  recordId,
  type SharedItem,
  type SharedItemsStores,
  type SharedItemVisibility,
} from '@mcp-abap-adt/llm-agent';
import { StrategyRag } from '../retrieval/strategy-rag.js';
import { assertPositiveInteger } from '../util/assert-positive-integer.js';
import {
  getItem,
  type PreparedItem,
  prepareItem,
  removeItem,
  storeItems,
} from './record-writer.js';
import {
  StagedRetrieval,
  type StagedRetrievalOptions,
} from './staged-retrieval.js';

export const SHARED_ITEMS_PROFILE_NAME = 'shared-items';
const CANONICAL = 'item';

export interface SharedItemsProfileOptions {
  /** Required (spec §4.4): index() refuses an item with more records. */
  readonly maxRecordsPerItem: number;
  readonly pool: ICandidatePool;
  readonly collapse: ICollapseRule;
  readonly rerank?: StagedRetrievalOptions['rerank'];
  readonly decompose?: StagedRetrievalOptions['decompose'];
  readonly cut?: IItemCut;
  readonly telemetry?: StagedRetrievalOptions['telemetry'];
}

/** What `bound.rag` decorates: the partitions are read by the retrieval itself. */
class PartitionsRag implements IRag {
  constructor(private readonly target: SharedItemsStores) {}
  async query(): Promise<Result<RagResult[], RagError>> {
    return { ok: true, value: [] };
  }
  async healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    for (const rag of [this.target.user, this.target.global]) {
      if (!rag) continue;
      const r = await rag.healthCheck(options);
      if (!r.ok) return r;
    }
    return { ok: true, value: undefined };
  }
  /** Items are addressed by owner through bound.get(), never by a bare id. */
  async getById(): Promise<Result<RagResult | null, RagError>> {
    return { ok: true, value: null };
  }
}

/** The request's options without its identity filter (partition stores are not user-scoped). */
const unfiltered = (options?: CallOptions): CallOptions => ({
  ...options,
  ragFilter: undefined,
});

class SharedItemsBinding implements IBoundCollection<SharedItem> {
  readonly profileName = SHARED_ITEMS_PROFILE_NAME;
  readonly rag: IRag;
  readonly retrieval: StagedRetrieval;

  constructor(
    private readonly target: SharedItemsStores,
    private readonly o: SharedItemsProfileOptions,
  ) {
    this.retrieval = new StagedRetrieval({
      name: SHARED_ITEMS_PROFILE_NAME,
      storeKey: target.key,
      pool: o.pool,
      maxRecordsPerItem: o.maxRecordsPerItem,
      canonicalKind: CANONICAL,
      sources: { sources: (options) => this.sources(options) },
      collapse: o.collapse,
      ...(o.rerank ? { rerank: o.rerank } : {}),
      ...(o.decompose ? { decompose: o.decompose } : {}),
      ...(o.cut ? { cut: o.cut } : {}),
      ...(o.telemetry ? { telemetry: o.telemetry } : {}),
    });
    this.rag = new StrategyRag(new PartitionsRag(target), this.retrieval);
  }

  get key(): string {
    return this.target.key;
  }

  private async sources(options?: CallOptions): Promise<RetrievalSource[]> {
    const out: RetrievalSource[] = [];
    const userId = options?.userId;
    if (this.target.user && userId) {
      out.push({
        name: 'user',
        rag: this.target.user,
        role: 'items',
        options: { ...unfiltered(options), ragFilter: { userId } },
      });
    }
    if (this.target.global) {
      out.push({ name: 'global', rag: this.target.global, role: 'items', options: unfiltered(options) });
    }
    for (const g of (await this.target.groups?.readable(options)) ?? []) {
      out.push({ name: `group:${g.groupId}`, rag: g.rag, role: 'items', options: unfiltered(options) });
    }
    return out;
  }

  private async writable(
    v: SharedItemVisibility,
    options?: CallOptions,
  ): Promise<IRag | string> {
    switch (v.scope) {
      case 'user':
        if (v.userId !== options?.userId) return 'foreign-user';
        return this.target.user ?? 'no-partition';
      case 'group':
        return (await this.target.groups?.writable(v.groupId, options)) ?? 'no-partition';
      case 'global':
        return this.target.global ?? 'no-partition';
    }
  }

  async index(
    items: readonly SharedItem[],
    options?: CallOptions,
  ): Promise<Result<IndexReport, RagError>> {
    const failedItems: { itemId: string; reason: string }[] = [];
    const byStore = new Map<IRag, { at: number; item: PreparedItem }[]>();
    for (const [at, s] of items.entries()) {
      const fail = (reason: string) => failedItems.push({ itemId: s.itemId, reason });
      if ((s.records ?? []).some((r) => r.kind.length === 0 || r.kind === CANONICAL)) {
        fail('reserved-kind');
        continue;
      }
      const store = await this.writable(s.visibility, options);
      if (typeof store === 'string') {
        fail(store);
        continue;
      }
      const drafts: RecordDraft[] = [
        {
          text: s.text,
          itemId: s.itemId,
          recordKind: CANONICAL,
          owner: s.visibility,
          ...(s.data !== undefined ? { metadata: { data: s.data } } : {}),
        },
        ...(s.records ?? []).map((r) => ({
          text: r.text,
          itemId: s.itemId,
          recordKind: r.kind,
          owner: s.visibility,
          itemText: s.text,
        })),
      ];
      const p = prepareItem(
        { itemId: s.itemId, drafts, ...(s.ttl !== undefined ? { ttl: s.ttl } : {}) },
        { canonicalKind: CANONICAL, profile: SHARED_ITEMS_PROFILE_NAME, maxRecordsPerItem: this.o.maxRecordsPerItem },
      );
      if (!p.ok) {
        fail(p.reason);
        continue;
      }
      const list = byStore.get(store) ?? [];
      list.push({ at, item: p.item });
      byStore.set(store, list);
    }
    let indexedItems = 0;
    let records = 0;
    for (const [store, list] of byStore) {
      const r = await storeItems(store, list.map((l) => l.item), options);
      records += r.records;
      list.forEach((l, i) => {
        if (r.indexed[i]) indexedItems++;
        else failedItems.push({ itemId: items[l.at].itemId, reason: r.failures[i] ?? 'write-failed' });
      });
    }
    return { ok: true, value: { items: items.length, indexedItems, records, failedItems } };
  }

  private async readable(
    ref: ItemRef,
    options?: CallOptions,
  ): Promise<{ rag: IRag; filter: CallOptions } | undefined> {
    switch (ref.owner.scope) {
      case 'user': {
        const userId = options?.userId;
        if (!this.target.user || userId !== ref.owner.userId) return undefined;
        return { rag: this.target.user, filter: { ragFilter: { userId } } };
      }
      case 'group': {
        const groupId = ref.owner.groupId;
        const g = ((await this.target.groups?.readable(options)) ?? []).find((x) => x.groupId === groupId);
        return g ? { rag: g.rag, filter: {} } : undefined;
      }
      case 'global':
        return this.target.global ? { rag: this.target.global, filter: {} } : undefined;
      default:
        return undefined;
    }
  }

  async get(ref: ItemRef, options?: CallOptions): Promise<Result<RagResult | null, RagError>> {
    const p = await this.readable(ref, options);
    if (!p) return { ok: true, value: null };
    return getItem(p.rag, recordId(ref.owner, ref.itemId, CANONICAL, 0), p.filter, options);
  }

  async remove(refs: readonly ItemRef[], options?: CallOptions): Promise<Result<number, RagError>> {
    let n = 0;
    for (const ref of refs) {
      if (ref.owner.scope === 'session') {
        return { ok: false, error: new RagError('shared items have no session visibility', 'OWNER_MISMATCH') };
      }
      const store = await this.writable(ref.owner, options);
      if (typeof store === 'string') {
        return {
          ok: false,
          error: new RagError(`cannot remove ${ref.itemId}: ${store}`, store === 'foreign-user' ? 'OWNER_MISMATCH' : 'NO_PARTITION'),
        };
      }
      const r = await removeItem(store, recordId(ref.owner, ref.itemId, CANONICAL, 0), options);
      if (!r.ok) return r;
      n += r.value;
    }
    return { ok: true, value: n };
  }
}

export class SharedItemsProfile
  implements ICollectionProfile<SharedItem, SharedItemsStores>
{
  readonly name = SHARED_ITEMS_PROFILE_NAME;
  constructor(readonly options: SharedItemsProfileOptions) {
    assertPositiveInteger('SharedItemsProfile', 'maxRecordsPerItem', options.maxRecordsPerItem);
  }
  bind(target: SharedItemsStores): IBoundCollection<SharedItem> {
    return new SharedItemsBinding(target, this.options);
  }
}
```

Append to `collections/index.ts`:
```ts
export {
  SHARED_ITEMS_PROFILE_NAME,
  SharedItemsProfile,
  type SharedItemsProfileOptions,
} from './shared-items-profile.js';
```

- [ ] **Step 4: Run tests and typecheck**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/shared-items-profile.test.ts
npm run typecheck
npm test --workspace @mcp-abap-adt/llm-agent-libs
```
Expected: PASS; exit 0; the whole libs suite (golden test included) green.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): SharedItemsProfile — owner-partitioned shared items returned whole

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 18: New package `@mcp-abap-adt/sap-aicore-decision` — `SapAiCoreDecisionModel`

Spec §5 (all), §11; D2 (amended), D10; the goal decision of 2026-10-05 (Cohere reuses what exists). Same shape as `typesafe-decision`: one vendor, one role, peers only, plain `fetch`. Cohere Rerank on SAP AI Core becomes one more `IDecisionModel`; the existing `DecisionReranker` uses it (Tasks 16, 22, 24). No reranker contract, no cross-encoder abstraction.

**Files:**
- Create: `packages/sap-aicore-decision/package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`
- Create (copies): `packages/sap-aicore-decision/LICENSE`, `packages/sap-aicore-decision/GPL-3.0.txt` (from `packages/typesafe-decision/`)
- Create: `packages/sap-aicore-decision/src/index.ts`, `src/sap-aicore-decision-model.ts`, `src/map-rerank.ts`, `src/__tests__/fake-fetch.ts`, `src/__tests__/sap-aicore-decision-model.test.ts`
- Modify: root `package.json` (`build`, `clean` lists — after `packages/typesafe-decision`), `scripts/publish-all.sh` (`PACKAGES`, after `typesafe-decision` — the order list only; nothing is published here), `packages/llm-agent-server/package.json` (`dependencies`), `packages/llm-agent-server/tsconfig.json` (`references`), `package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: `IDecisionModel`, `DecisionRequest`, `DecisionResult`, `DecisionAnswer`, `DecisionError`, `DecisionErrorCode`, `CallOptions`, `Result` (`@mcp-abap-adt/llm-agent`, `src/interfaces/decision-model.ts` — the codes used all exist: `DECISION_UNSUPPORTED_QUESTION`, `DECISION_INVALID_REQUEST`, `DECISION_AUTH`, `DECISION_RATE_LIMITED`, `DECISION_UNAVAILABLE`, `DECISION_ABORTED`, `DECISION_ERROR`); `IBearerCredential` (`@mcp-abap-adt/interfaces-auth`, `token(): Promise<string>`).
- No dependency on `@mcp-abap-adt/sap-aicore-auth`: the AI Core token exchange is reused through the composition root (`credential-for.ts` → `serviceKeyCredential` → `TokenProvider`), exactly as the AI Core embedder and LLM receive their injected `IBearerCredential` (spec §5.2, verified in the repo).
- Produces:
  ```ts
  export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
  export interface SapAiCoreDecisionConfig { deploymentId: string; model: string; resourceGroup?: string; apiBaseUrl: string; credential: IBearerCredential; fetch?: FetchLike }
  export const SAP_AICORE_DEFAULT_RESOURCE_GROUP = 'default';
  export class SapAiCoreDecisionModel implements IDecisionModel { constructor(cfg: SapAiCoreDecisionConfig); readonly model: string }
  // decide(): every question noul + string instructions.passage, string state → ONE
  //   POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank
  //   { model, query: state, documents: passages (question order), top_n: n }
  //   → answers[key] = { type: 'noul', probability: relevance_score }
  // otherwise DecisionError (codes above); never a zero-filled or dropped answer
  ```

- [ ] **Step 1: Scaffold the package**

```json
// packages/sap-aicore-decision/package.json
{
  "name": "@mcp-abap-adt/sap-aicore-decision",
  "version": "30.1.0",
  "description": "Cohere Rerank on an SAP AI Core deployment as a decision model (IDecisionModel) for @mcp-abap-adt/llm-agent.",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE", "GPL-3.0.txt"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "tsc -p tsconfig.json --clean",
    "test": "node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'"
  },
  "license": "LGPL-3.0-only",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fr0ster/llm-agent.git"
  },
  "publishConfig": {
    "access": "public"
  },
  "peerDependencies": {
    "@mcp-abap-adt/interfaces-auth": "^2.1.0",
    "@mcp-abap-adt/llm-agent": "^30.1.0"
  }
}
```
(`version` 30.1.0 is the current lockstep version so the workspace resolves — not a bump; the release step bumps every package together. The peer ranges are the ones `typesafe-decision` declares, as `scoped-dependencies.test.ts` requires.)

```json
// packages/sap-aicore-decision/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "**/*.test.ts", "dist"],
  "references": [{ "path": "../llm-agent" }]
}
```

Run:
```bash
cp packages/typesafe-decision/LICENSE packages/typesafe-decision/GPL-3.0.txt packages/sap-aicore-decision/
printf '# Changelog\n\n## [Unreleased]\n\n- New package: `SapAiCoreDecisionModel`, Cohere Rerank on an SAP AI Core deployment as an `IDecisionModel` (yes/no questions with a passage; one `/rerank` call per decision request). Used by `DecisionReranker`.\n' > packages/sap-aicore-decision/CHANGELOG.md
```

`packages/sap-aicore-decision/README.md`:
````markdown
# @mcp-abap-adt/sap-aicore-decision

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Cohere Rerank on **SAP AI Core** as a decision model (`IDecisionModel`) for `@mcp-abap-adt/llm-agent`.

**TL;DR** — `SapAiCoreDecisionModel` answers yes/no questions about a passage with the passage's
relevance score. Put it into the existing `DecisionReranker` and you have a Cohere reranker: in a
collection profile (`faceted-cohere`), in `rag.retrieval` (`reranker: decision`) or anywhere an
`IReranker` is taken.

```ts
import { DecisionReranker, mcpToolsVariants, TOOL_QUESTION } from '@mcp-abap-adt/llm-agent-libs';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';
import { SapAiCoreDecisionModel } from '@mcp-abap-adt/sap-aicore-decision';

const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY ?? '');
const cohere = new SapAiCoreDecisionModel({
  deploymentId: 'd1234567890',   // the AI Core deployment serving the rerank model
  model: 'cohere-rerank',        // sent as `model`
  resourceGroup: 'default',      // header AI-Resource-Group (default 'default')
  apiBaseUrl,
  credential,
});

const reranker = new DecisionReranker(cohere, { task: TOOL_QUESTION.task, criteria: TOOL_QUESTION.criteria });
const profile = mcpToolsVariants.facetedCohere({ decisionModel: cohere });
```

## What it answers

| Request | Result |
|---|---|
| a text `state`; every question `noul` with a text `instructions.passage` | one `noul` answer per question, `probability` = `relevance_score` |
| a `choice` or `score` question, a `noul` without a passage, a non-text state | `DecisionError` `DECISION_UNSUPPORTED_QUESTION` — nothing is sent |

- `instructions.task` and `criteria` are not read: a cross-encoder scores (query, passage) pairs only.
- **One `/rerank` call per `decide`:** `POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank`,
  body `{ model, query, documents, top_n }`, header `AI-Resource-Group`.
- `DecisionReranker` batches by `maxBatchTokens` (default 48 000 estimated tokens) → one call per
  batch, up to 4 in flight. Tool profiles rerank ≤ 30 tools: typically one call.

## Errors — never a zero-filled answer

| Failure | `DecisionError` code |
|---|---|
| no questions | `DECISION_INVALID_REQUEST` |
| HTTP 401 / 403, or the credential gives no token | `DECISION_AUTH` |
| HTTP 429 | `DECISION_RATE_LIMITED` |
| HTTP 400 / 404 / 422 | `DECISION_INVALID_REQUEST` |
| HTTP 5xx, network failure | `DECISION_UNAVAILABLE` |
| `options.signal` aborted | `DECISION_ABORTED` |
| a wrong result count; a missing, duplicated or out-of-range index; a score that is not a finite number in [0, 1]; a body that is not JSON | `DECISION_ERROR` |

Messages carry the HTTP status, never the token or the response body.

## Rules

- **No env, no timeout, no retries:** the credential is injected and asked for a token on every call;
  `options.signal` aborts; a failure goes to the reranking strategy's `onFailure`.
- **Data sent:** the query and the candidate texts go to your SAP AI Core deployment.
- **Deployment id, not a model name** — resolving a deployment by model name is a follow-up.

## License

**GNU Lesser General Public License v3.0 only** (`LGPL-3.0-only`) — see
[`LICENSE`](LICENSE) (LGPL) and [`GPL-3.0.txt`](GPL-3.0.txt) (the GPL it layers
permissions onto; both are required, the LGPL is not standalone).

Copyright © 2025–2026 Oleksii Kyslytsia

Full detail: [docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).
````

Wire the package in:
- root `package.json`: in both `build` and `clean`, insert ` packages/sap-aicore-decision` right after `packages/typesafe-decision`.
- `scripts/publish-all.sh`: add `  sap-aicore-decision` after `  typesafe-decision` in `PACKAGES` (published before `llm-agent-libs` / `llm-agent-server`, in dependency order: it depends only on `llm-agent`).
- `packages/llm-agent-server/package.json` `dependencies`: `"@mcp-abap-adt/sap-aicore-decision": "^30.1.0",` (alphabetical: after `sap-aicore-auth`, before `sap-aicore-embedder`).
- `packages/llm-agent-server/tsconfig.json` `references`: `{ "path": "../sap-aicore-decision" }`.

Run: `npm install` then `grep -n '"link": true' package-lock.json`
Expected: only `node_modules/@mcp-abap-adt/<workspace sibling>` entries resolving to `packages/*` (the new one included); nothing outside the repo.

- [ ] **Step 2: Write the failing test**

```ts
// packages/sap-aicore-decision/src/__tests__/fake-fetch.ts
/** A recorded request and a scripted response, for driving the model offline. */
export interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: { model?: string; query?: string; documents?: string[]; top_n?: number };
}

export function fakeFetch(
  respond: (req: Recorded) => { status: number; body: unknown },
) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rec: Recorded = { url, headers, body: init.body ? JSON.parse(String(init.body)) : {} };
    calls.push(rec);
    const { status, body } = respond(rec);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

/** A fetch that never answers and rejects on abort (an already-aborted signal at once). */
export function blockingFetch() {
  let markEntered: () => void = () => {};
  const entered = new Promise<void>((r) => {
    markEntered = r;
  });
  const fetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      markEntered();
    });
  return { fetch, entered };
}
```

```ts
// packages/sap-aicore-decision/src/__tests__/sap-aicore-decision-model.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecisionQuestion, DecisionRequest, NoulQuestion } from '@mcp-abap-adt/llm-agent';
import { type FetchLike, SapAiCoreDecisionModel, type SapAiCoreDecisionConfig } from '../index.js';
import { blockingFetch, fakeFetch, type Recorded } from './fake-fetch.js';

const TOKEN = 'SECRET-TOKEN';
let tokenCalls = 0;
const credential = {
  kind: 'bearer' as const,
  token: async () => {
    tokenCalls++;
    return TOKEN;
  },
};
const make = (fetch: FetchLike, extra: Partial<SapAiCoreDecisionConfig> = {}) =>
  new SapAiCoreDecisionModel({ deploymentId: 'd1', model: 'cohere-rerank', apiBaseUrl: 'https://api.example/', credential, fetch, ...extra });
// The shape DecisionReranker sends: the query as the state, one noul question per passage.
const noul = (passage: string): NoulQuestion => ({
  type: 'noul',
  instructions: { task: 'Judge whether calling this tool would help.', passage },
  criteria: { true: 'yes', false: 'no' },
});
const req = (...passages: string[]): DecisionRequest => ({
  state: 'read a file',
  questions: Object.fromEntries(passages.map((p, i) => [`r${i}`, noul(p)])),
});
const scored = (scores: number[]) => (rec: Recorded) => ({
  status: 200,
  body: { results: (rec.body.documents ?? []).map((_, index) => ({ index, relevance_score: scores[index] })) },
});
const codeOf = async (p: ReturnType<SapAiCoreDecisionModel['decide']>) => {
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.message.includes(TOKEN), 'the token never appears in an error');
  return !r.ok ? r.error.code : undefined;
};

describe('SapAiCoreDecisionModel — wire (spec §5.2)', () => {
  it('ONE POST per decide: URL, headers, body with the passages in question order', async () => {
    const { fetch, calls } = fakeFetch(scored([0.1, 0.9]));
    await make(fetch).decide(req('read_file — read a file', 'list_issues — list issues'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example/v2/inference/deployments/d1/rerank');
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['ai-resource-group'], 'default');
    assert.equal(calls[0].headers['content-type'], 'application/json');
    assert.deepEqual(calls[0].body, {
      model: 'cohere-rerank',
      query: 'read a file',
      documents: ['read_file — read a file', 'list_issues — list issues'],
      top_n: 2,
    });
  });
  it('resourceGroup is sent; the bearer is asked on every call', async () => {
    const { fetch, calls } = fakeFetch(scored([0.5]));
    const m = make(fetch, { resourceGroup: 'rg1' });
    const before = tokenCalls;
    await m.decide(req('a'));
    await m.decide(req('a'));
    assert.equal(calls[0].headers['ai-resource-group'], 'rg1');
    assert.equal(tokenCalls - before, 2);
  });
});

describe('SapAiCoreDecisionModel — mapping', () => {
  it('answers by index to the question keys; probability = relevance_score; model = the configured one', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] },
    }));
    const r = await make(fetch).decide(req('a', 'b'));
    assert.ok(r.ok);
    assert.deepEqual(r.value.answers, {
      r0: { type: 'noul', probability: 0.2 },
      r1: { type: 'noul', probability: 0.9 },
    });
    assert.equal(r.value.model, 'cohere-rerank');
    assert.equal(r.value.usage, undefined);
  });
  it('a question key such as __proto__ stays an answer', async () => {
    const { fetch } = fakeFetch(scored([0.4]));
    const r = await make(fetch).decide({ state: 'q', questions: Object.fromEntries([['__proto__', noul('a')]]) });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.value.answers), ['__proto__']);
  });
});

describe('SapAiCoreDecisionModel — only yes/no questions with a passage', () => {
  const unsupported: Array<[string, DecisionRequest]> = [
    ['a choice question', { state: 'q', questions: { a: { type: 'choice', criteria: { x: null, y: null } } as DecisionQuestion } }],
    ['a score question', { state: 'q', questions: { a: { type: 'score', criteria: [null, null] } as DecisionQuestion } }],
    ['a noul question without a passage', { state: 'q', questions: { a: { type: 'noul', instructions: 'is it good?' } } }],
    ['a passage that is not text', { state: 'q', questions: { a: { type: 'noul', instructions: { passage: { x: 1 } } } } }],
    ['a state that is not text', { state: { q: 1 }, questions: { a: noul('p') } }],
    ['one unsupported question among supported ones', { state: 'q', questions: { a: noul('p'), b: { type: 'score', criteria: [null, null] } as DecisionQuestion } }],
  ];
  for (const [name, request] of unsupported) {
    it(`${name} → DECISION_UNSUPPORTED_QUESTION, nothing sent`, async () => {
      const { fetch, calls } = fakeFetch(scored([1]));
      assert.equal(await codeOf(make(fetch).decide(request)), 'DECISION_UNSUPPORTED_QUESTION');
      assert.equal(calls.length, 0);
    });
  }
  it('no questions → DECISION_INVALID_REQUEST', async () => {
    const { fetch } = fakeFetch(scored([]));
    assert.equal(await codeOf(make(fetch).decide({ state: 'q', questions: {} })), 'DECISION_INVALID_REQUEST');
  });
});

describe('SapAiCoreDecisionModel — a bad answer is a DecisionError, never zero-filled', () => {
  const bad: Array<[string, (rec: Recorded) => { status: number; body: unknown }]> = [
    ['fewer results than passages', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } })],
    ['more results than passages', () => ({ status: 200, body: { results: [0, 1, 1].map((index) => ({ index, relevance_score: 1 })) } })],
    ['a duplicate index', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 1 }] } })],
    ['an out-of-range index', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 5, relevance_score: 1 }] } })],
    ['a non-integer index', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 0.5, relevance_score: 1 }] } })],
    ['a non-finite score', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: 'x' }] } })],
    ['a score above 1', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: 1.5 }] } })],
    ['a negative score', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: -0.1 }] } })],
    ['no results array', () => ({ status: 200, body: {} })],
    ['a body that is not JSON', () => ({ status: 200, body: 'not json' })],
  ];
  for (const [name, respond] of bad) {
    it(`${name} → DECISION_ERROR`, async () => {
      const { fetch } = fakeFetch(respond);
      assert.equal(await codeOf(make(fetch).decide(req('a', 'b'))), 'DECISION_ERROR');
    });
  }
});

describe('SapAiCoreDecisionModel — transport errors', () => {
  const statuses: Array<[number, string]> = [
    [400, 'DECISION_INVALID_REQUEST'],
    [401, 'DECISION_AUTH'],
    [403, 'DECISION_AUTH'],
    [404, 'DECISION_INVALID_REQUEST'],
    [422, 'DECISION_INVALID_REQUEST'],
    [429, 'DECISION_RATE_LIMITED'],
    [500, 'DECISION_UNAVAILABLE'],
    [503, 'DECISION_UNAVAILABLE'],
    [418, 'DECISION_ERROR'],
  ];
  for (const [status, code] of statuses) {
    it(`HTTP ${status} → ${code}, the status in the message, never the body`, async () => {
      const { fetch } = fakeFetch(() => ({ status, body: { error: `leak ${TOKEN}` } }));
      const r = await make(fetch).decide(req('a'));
      assert.ok(!r.ok);
      assert.equal(r.error.code, code);
      assert.match(r.error.message, new RegExp(String(status)));
      assert.ok(!r.error.message.includes('leak'));
    });
  }
  it('a network failure → DECISION_UNAVAILABLE', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    assert.equal(await codeOf(make(fetch).decide(req('a'))), 'DECISION_UNAVAILABLE');
  });
  it('a credential that gives no token → DECISION_AUTH, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(scored([1]));
    const broken = { kind: 'bearer' as const, token: async () => { throw new Error(`no ${TOKEN}`); } };
    assert.equal(await codeOf(make(fetch, { credential: broken }).decide(req('a'))), 'DECISION_AUTH');
    assert.equal(calls.length, 0);
  });
  it('an already-aborted signal → DECISION_ABORTED, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(scored([1]));
    const ac = new AbortController();
    ac.abort();
    assert.equal(await codeOf(make(fetch).decide(req('a'), { signal: ac.signal })), 'DECISION_ABORTED');
    assert.equal(calls.length, 0);
  });
  it('an abort while the request is in flight → DECISION_ABORTED', async () => {
    const { fetch, entered } = blockingFetch();
    const ac = new AbortController();
    const pending = make(fetch).decide(req('a'), { signal: ac.signal });
    await entered;
    ac.abort();
    assert.equal(await codeOf(pending), 'DECISION_ABORTED');
  });
  it('the constructor refuses a missing deployment, model, URL or credential', () => {
    const { fetch } = fakeFetch(scored([]));
    assert.throws(() => make(fetch, { deploymentId: '' }));
    assert.throws(() => make(fetch, { model: ' ' }));
    assert.throws(() => make(fetch, { apiBaseUrl: '' }));
    assert.throws(() => make(fetch, { credential: undefined as never }));
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `npx tsc -b packages/llm-agent && node --import tsx/esm --test packages/sap-aicore-decision/src/__tests__/sap-aicore-decision-model.test.ts`
Expected: FAIL — `Cannot find module '../index.js'`.

- [ ] **Step 4: Implement**

```ts
// packages/sap-aicore-decision/src/map-rerank.ts
import {
  DecisionError,
  type DecisionErrorCode,
  type Result,
} from '@mcp-abap-adt/llm-agent';

/** HTTP status → DecisionError code (spec §5.2). Same split as typesafe-decision's mapError. */
export function codeForStatus(status: number): DecisionErrorCode {
  if (status === 401 || status === 403) return 'DECISION_AUTH';
  if (status === 429) return 'DECISION_RATE_LIMITED';
  if (status === 400 || status === 404 || status === 422) {
    return 'DECISION_INVALID_REQUEST';
  }
  if (status >= 500) return 'DECISION_UNAVAILABLE';
  return 'DECISION_ERROR';
}

const bad = (message: string): Result<never, DecisionError> => ({
  ok: false,
  error: new DecisionError(`sap-aicore rerank: ${message}`, 'DECISION_ERROR'),
});

/**
 * `{ results: [{ index, relevance_score }] }` → one score per document, in
 * document order. Exactly one result per document, each a finite number in
 * [0, 1] (the NoulAnswer invariant). Anything else is an error — never a
 * zero-filled or dropped score.
 */
export function mapRerankResults(
  body: unknown,
  documents: number,
): Result<number[], DecisionError> {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return bad('response has no results array');
  if (list.length !== documents) {
    return bad(`${list.length} results for ${documents} documents`);
  }
  const scores = new Map<number, number>();
  for (const e of list) {
    const index = (e as { index?: unknown } | null)?.index;
    const score = (e as { relevance_score?: unknown } | null)?.relevance_score;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= documents
    ) {
      return bad(`out-of-range index ${String(index)}`);
    }
    if (scores.has(index)) return bad(`index ${index} twice`);
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      return bad(`score for index ${index} is not a finite number in [0, 1]`);
    }
    scores.set(index, score);
  }
  const out: number[] = [];
  for (let i = 0; i < documents; i++) {
    const s = scores.get(i);
    if (s === undefined) return bad(`no score for index ${i}`);
    out.push(s);
  }
  return { ok: true, value: out };
}
```

```ts
// packages/sap-aicore-decision/src/sap-aicore-decision-model.ts
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  type CallOptions,
  type DecisionAnswer,
  DecisionError,
  type DecisionErrorCode,
  type DecisionRequest,
  type DecisionResult,
  type IDecisionModel,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { codeForStatus, mapRerankResults } from './map-rerank.js';

export const SAP_AICORE_DEFAULT_RESOURCE_GROUP = 'default';

/** The one fetch shape this model uses; a test seam (unset → global fetch). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SapAiCoreDecisionConfig {
  /** The AI Core deployment that serves the rerank model (D10: an id, not a model name). */
  deploymentId: string;
  /** Sent as `model` in the body (e.g. the Cohere rerank model name). */
  model: string;
  /** Header `AI-Resource-Group`. Unset → 'default', as the AI Core embedder and LLM. */
  resourceGroup?: string;
  /** AI Core REST API base URL (the name `parseServiceKey` returns). */
  apiBaseUrl: string;
  /** Asked for a fresh token on every call; never cached here. */
  credential: IBearerCredential;
  fetch?: FetchLike;
}

const fail = (
  message: string,
  code: DecisionErrorCode = 'DECISION_ERROR',
): Result<never, DecisionError> => ({
  ok: false,
  error: new DecisionError(message, code),
});

const required = (v: string | undefined, field: string): string => {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`SapAiCoreDecisionModel: ${field} is required`);
  }
  return v;
};

const nameOf = (err: unknown): string =>
  err instanceof Error ? err.name : 'Error';

/** The request as (keys, passages, query) — or why this model cannot answer it. */
function passagesOf(
  request: DecisionRequest,
): Result<{ keys: string[]; passages: string[]; query: string }, DecisionError> {
  const keys = Object.keys(request.questions);
  if (keys.length === 0) {
    return fail('decision request has no questions', 'DECISION_INVALID_REQUEST');
  }
  if (typeof request.state !== 'string') {
    return fail(
      'sap-aicore rerank reads a text state only',
      'DECISION_UNSUPPORTED_QUESTION',
    );
  }
  const passages: string[] = [];
  for (const key of keys) {
    const q = request.questions[key];
    if (q.type !== 'noul') {
      return fail(
        `sap-aicore rerank answers yes/no (noul) questions only, not ${q.type}`,
        'DECISION_UNSUPPORTED_QUESTION',
      );
    }
    const ins = q.instructions;
    const passage =
      typeof ins === 'object' && ins !== null && !Array.isArray(ins)
        ? (ins as { passage?: unknown }).passage
        : undefined;
    if (typeof passage !== 'string') {
      return fail(
        'sap-aicore rerank needs instructions.passage (text) in every question',
        'DECISION_UNSUPPORTED_QUESTION',
      );
    }
    passages.push(passage);
  }
  return { ok: true, value: { keys, passages, query: request.state } };
}

/**
 * Cohere Rerank on SAP AI Core as an IDecisionModel (spec §5.2). It answers
 * yes/no questions about a passage with the passage's relevance to the state;
 * `task` and `criteria` are not read (a cross-encoder has no question input).
 * ONE /rerank call per decide. No env, no timeout, no retries.
 */
export class SapAiCoreDecisionModel implements IDecisionModel {
  readonly model: string;
  private readonly url: string;
  private readonly resourceGroup: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly cfg: SapAiCoreDecisionConfig) {
    if (!cfg?.credential) {
      throw new Error('SapAiCoreDecisionModel requires a credential');
    }
    const base = required(cfg.apiBaseUrl, 'apiBaseUrl').replace(/\/+$/, '');
    const deployment = required(cfg.deploymentId, 'deploymentId');
    this.model = required(cfg.model, 'model');
    this.url = `${base}/v2/inference/deployments/${encodeURIComponent(deployment)}/rerank`;
    this.resourceGroup = cfg.resourceGroup ?? SAP_AICORE_DEFAULT_RESOURCE_GROUP;
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    const p = passagesOf(request);
    if (!p.ok) return p;
    const aborted = () => fail('sap-aicore rerank aborted', 'DECISION_ABORTED');
    if (options?.signal?.aborted) return aborted();
    let token: string;
    try {
      token = await this.cfg.credential.token();
    } catch (err) {
      return fail(
        `sap-aicore credential gave no token (${nameOf(err)})`,
        'DECISION_AUTH',
      );
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'AI-Resource-Group': this.resourceGroup,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: p.value.query,
          documents: p.value.passages,
          top_n: p.value.passages.length,
        }),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (options?.signal?.aborted) return aborted();
      return fail(
        `sap-aicore rerank request failed (${nameOf(err)})`,
        'DECISION_UNAVAILABLE',
      );
    }
    if (!res.ok) {
      return fail(`sap-aicore rerank HTTP ${res.status}`, codeForStatus(res.status));
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (options?.signal?.aborted) return aborted();
      return fail('sap-aicore rerank: response is not JSON');
    }
    const scores = mapRerankResults(body, p.value.passages.length);
    if (!scores.ok) return scores;
    // fromEntries defines own properties: a key such as `__proto__` stays an answer.
    const answers: Record<string, DecisionAnswer> = Object.fromEntries(
      p.value.keys.map((key, i) => [
        key,
        { type: 'noul', probability: scores.value[i] } as DecisionAnswer,
      ]),
    );
    return { ok: true, value: { answers, model: this.model } };
  }
}
```

```ts
// packages/sap-aicore-decision/src/index.ts
export { codeForStatus, mapRerankResults } from './map-rerank.js';
export {
  type FetchLike,
  SAP_AICORE_DEFAULT_RESOURCE_GROUP,
  type SapAiCoreDecisionConfig,
  SapAiCoreDecisionModel,
} from './sap-aicore-decision-model.js';
```

- [ ] **Step 5: Run the package and repo tests**

Run:
```bash
node --import tsx/esm --test packages/sap-aicore-decision/src/__tests__/sap-aicore-decision-model.test.ts
npx tsc -b packages/sap-aicore-decision
node --import tsx/esm --test --test-reporter=spec 'test/repo/*.test.ts'
```
Expected: PASS — `licensing`, `readme-badges` and `scoped-dependencies` accept the new package. (How `DecisionReranker` batches map to `/rerank` calls is tested in Task 24, the one package that depends on both libs and this provider.)

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/sap-aicore-decision
git add packages/sap-aicore-decision package.json package-lock.json scripts/publish-all.sh packages/llm-agent-server/package.json packages/llm-agent-server/tsconfig.json
git commit -m "feat(sap-aicore-decision): SapAiCoreDecisionModel — Cohere Rerank on SAP AI Core as an IDecisionModel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 19: `vectorizeMcpTools` fills a tools profile through `bound.index` (libs)

Spec §7.6 (incl. notes logged, S1). The 30.1.0 path stays byte-for-byte (Task 1's golden test).

**Files:**
- Create: `packages/llm-agent-libs/src/mcp/index-tools-through-profile.ts`
- Modify: `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` (the `ns` parameter type; one early return after `ids` is computed)
- Create: `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts`

**Interfaces:**
- Consumes: `toolItemFromTool` (Task 7); `IBoundCollection<ToolItem>`; `ToolCatalogStatus` with `records?`, `profile?` (Task 3).
- Produces:
  ```ts
  // vectorizeMcpTools(…, ns?: { …existing; binding?: IBoundCollection<ToolItem> })
  export function indexToolsThroughProfile(binding: IBoundCollection<ToolItem>, tools: readonly LlmTool[], originalNames: readonly string[], ids: readonly string[], seed: { total: number; clientFailures: number }, logger: ILogger | undefined, options?: CallOptions): Promise<ToolCatalogStatus>;
  // summary: vectorized = items with every record written; failed = tool names; records; profile
  // every IndexReport.notes entry is logged as a warning naming the tool (S1)
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IEmbedder,
  type ILogger,
  type IMcpClient,
  InMemoryRag,
  type McpTool,
  recordId,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  ComposedToolsProfile,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  ItemPool,
  MaxScoreCollapse,
  RequiredEnumDiscriminator,
  SummaryFacet,
} from '../collections/index.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../mcp/vectorize-mcp-tools.js';

const TOOLS: McpTool[] = [
  { name: 'read_file', description: 'Read a file', inputSchema: { properties: { path: { type: 'string' } } } },
  { name: 'list_issues', description: 'List issues', inputSchema: {} },
];
const client = (tools: McpTool[]): IMcpClient =>
  ({ listTools: async () => ({ ok: true, value: tools }), callTool: async () => ({ ok: true, value: { content: [] } }) }) as unknown as IMcpClient;
const profile = (indexer = new FacetedToolIndexer([new SummaryFacet()])) =>
  new ComposedToolsProfile({ indexer, pool: new ItemPool(10), collapse: new MaxScoreCollapse() });

describe('vectorizeMcpTools with a tools profile', () => {
  it('fills through bound.index; accounting in items, plus records and profile', async () => {
    const rag = new InMemoryRag();
    const binding = profile().bind({ key: 'tools', rag });
    const s = await vectorizeMcpTools([client(TOOLS)], binding.rag, new NoopRequestLogger(), undefined, undefined, undefined, { binding });
    assert.deepEqual(s, { total: 2, vectorized: 2, failed: [], clientFailures: 0, complete: true, records: 4, profile: 'mcp-tools' });
    const full = await rag.getById(recordId({ scope: 'global' }, 'tool:read_file', 'full', 0));
    assert.ok(full.ok && full.value);
    assert.equal(full.value.metadata.definitionChars, JSON.stringify({ name: 'read_file', description: 'Read a file', inputSchema: TOOLS[0].inputSchema }).length);
    const legacy = await rag.getById('tool:read_file');
    assert.ok(legacy.ok && legacy.value === null, 'no 30.1.0 record under a profile');
  });

  it('one batch embedding pass for all records of all tools', async () => {
    const batches: number[] = [];
    const embedder: IEmbedder & { embedBatch(t: string[]): Promise<{ vector: number[] }[]> } = {
      embed: async () => ({ vector: [1, 0] }),
      embedBatch: async (texts: string[]) => {
        batches.push(texts.length);
        return texts.map(() => ({ vector: [1, 0] }));
      },
    };
    const binding = profile().bind({ key: 'tools', rag: new VectorRag(symmetricEmbedder(embedder)) });
    await vectorizeMcpTools([client(TOOLS)], binding.rag, new NoopRequestLogger(), undefined, undefined, undefined, { binding });
    assert.deepEqual(batches, [4]);
  });

  it('a failing item is reported by tool name and not counted', async () => {
    const coarse: McpTool = { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B', 'C'] } }, required: ['kind'] } };
    const binding = profile(new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 2 })).bind({ key: 'tools', rag: new InMemoryRag() });
    const s = await vectorizeMcpTools([client([...TOOLS, coarse])], binding.rag, new NoopRequestLogger(), undefined, undefined, undefined, { binding });
    assert.equal(s?.vectorized, 2);
    assert.deepEqual(s?.failed, ['make']);
    assert.equal(s?.complete, false);
  });

  it('every IndexReport note is logged as a warning naming the tool (S1)', async () => {
    const ambiguous: McpTool = { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B'] }, region: { enum: ['EU', 'US'] } }, required: ['kind', 'region'] } };
    const binding = profile(new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 5 })).bind({ key: 'tools', rag: new InMemoryRag() });
    const messages: string[] = [];
    const logger = { log: (e: { message: string }) => messages.push(e.message) } as unknown as ILogger;
    await vectorizeMcpTools([client([ambiguous])], binding.rag, new NoopRequestLogger(), logger, undefined, undefined, { binding });
    assert.ok(messages.some((m) => /make: ambiguous-discriminator \(kind, region\)/.test(m)), messages.join('\n'));
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts`
Expected: FAIL — the 30.1.0 path runs (`legacy` record exists; no `records` / `profile` in the summary).

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/mcp/index-tools-through-profile.ts
import type {
  CallOptions,
  IBoundCollection,
  ILogger,
  LlmTool,
  ToolCatalogStatus,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { toolItemFromTool } from '../collections/tools/tool-item.js';

const MAX_NAMES_IN_LOG = 10;

/**
 * The profile path of vectorizeMcpTools (spec §7.6): ToolItems → bound.index.
 * Accounting counts ITEMS; `records` and `profile` go to the catalog status.
 */
export async function indexToolsThroughProfile(
  binding: IBoundCollection<ToolItem>,
  tools: readonly LlmTool[],
  originalNames: readonly string[],
  ids: readonly string[],
  seed: { total: number; clientFailures: number },
  logger: ILogger | undefined,
  options?: CallOptions,
): Promise<ToolCatalogStatus> {
  // A custom IToolRecordKey can give two tools one id: the later replaces the
  // earlier, which is reported failed — as on the 30.1.0 path.
  const last = new Map<string, number>();
  ids.forEach((id, i) => last.set(id, i));
  const failed: string[] = [];
  const items: ToolItem[] = [];
  const nameOf = new Map<string, string>();
  tools.forEach((t, i) => {
    if (last.get(ids[i]) !== i) {
      failed.push(t.name);
      return;
    }
    items.push(toolItemFromTool(t, { itemId: ids[i], originalName: originalNames[i] }));
    nameOf.set(ids[i], t.name);
  });
  const r = await binding.index(items, options);
  let vectorized = 0;
  let records = 0;
  let reason = '';
  if (r.ok) {
    vectorized = r.value.indexedItems;
    records = r.value.records;
    for (const f of r.value.failedItems) failed.push(nameOf.get(f.itemId) ?? f.itemId);
    // S1: what an indexing strategy declined to guess is never lost on the way to the operator.
    for (const n of r.value.notes ?? []) {
      logger?.log({
        type: 'warning',
        traceId: 'builder',
        message: `tool ${nameOf.get(n.itemId) ?? n.itemId}: ${n.note}${n.detail ? ` (${n.detail})` : ''}`,
      });
    }
  } else {
    reason = `; index failed: ${r.error.message}`;
    for (const it of items) failed.push(it.name);
  }
  const summary: ToolCatalogStatus = {
    total: seed.total,
    vectorized,
    failed,
    clientFailures: seed.clientFailures,
    complete: seed.clientFailures === 0 && failed.length === 0,
    records,
    profile: binding.profileName,
  };
  const head = `vectorized ${vectorized}/${seed.total} MCP tools as ${records} records (profile ${binding.profileName})`;
  const shown = failed.slice(0, MAX_NAMES_IN_LOG).join(', ');
  const more = failed.length > MAX_NAMES_IN_LOG ? ` (+${failed.length - MAX_NAMES_IN_LOG} more)` : '';
  logger?.log({
    type: 'warning',
    traceId: 'builder',
    message: summary.complete
      ? head
      : `${head}, ${failed.length} failed: ${shown}${more}` +
        (seed.clientFailures > 0 ? `; ${seed.clientFailures} client(s) failed to list tools` : '') +
        reason,
  });
  return summary;
}
```

In `vectorize-mcp-tools.ts`:
- add imports: `IBoundCollection`, `ToolItem` to the type import from `@mcp-abap-adt/llm-agent`; `import { indexToolsThroughProfile } from './index-tools-through-profile.js';`
- add to the `ns?: { … }` type, after `toolNamespace?: IToolNamespace;`:
  ```ts
    /** A bound tools profile (spec §7.6): fill through `binding.index` instead of the 30.1.0 records. */
    binding?: IBoundCollection<ToolItem>;
  ```
- immediately after the `const ids = tools.map(…)` block (before `let vectors`), insert:
  ```ts
  if (ns?.binding) {
    return indexToolsThroughProfile(
      ns.binding,
      tools,
      tools.map((t) => provenance.get(t.name)?.originalName ?? t.name),
      ids,
      acc,
      logger,
      options,
    );
  }
  ```

- [ ] **Step 4: Run (profile path + golden + existing vectorize tests)**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/mcp packages/llm-agent-libs/src/__tests__
git add packages/llm-agent-libs/src
git commit -m "feat(libs): vectorizeMcpTools fills a bound tools profile; accounting in items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 20: `SmartAgentBuilder.withToolsProfile` (libs)

Spec §6.1; §16 principle 6 (one call site).

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts` (field near `_retrievalStrategies` ~line 198; method after `withRetrievalStrategy` ~line 449; `toolsRag` computation ~lines 922–926; the `vectorizeMcpTools` call ~line 1220)
- Create: `packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts` (append)

**Interfaces:**
- Consumes: `bindToolsProfile`, `toolsBindingOf` (Task 15); `ns.binding` of `vectorizeMcpTools` (Task 19).
- Produces:
  ```ts
  withToolsProfile(profile: ICollectionProfile<ToolItem>): this;
  // build(): withToolsProfile + withRetrievalStrategy('tools', …) → Error; withToolsProfile without a tools store → Error;
  // a store that already carries a tools binding (server-bound) is reused, never bound twice.
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CollectionStore,
  type ICollectionProfile,
  type IMcpClient,
  InMemoryRag,
  isToolCatalogReporter,
  type McpTool,
  TextOnlyEmbedding,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { bindToolsProfile, mcpToolsVariants, toolsBindingOf } from '../collections/index.js';
import { EmbeddingRetrieval, hasRetrievalStrategy } from '../retrieval/index.js';
import { makeLlm } from '../testing/index.js';

const TOOLS: McpTool[] = [
  { name: 'read_file', description: 'Read a file from disk', inputSchema: {} },
  { name: 'list_issues', description: 'List open issues', inputSchema: {} },
];
const client = (): IMcpClient =>
  ({ listTools: async () => ({ ok: true, value: TOOLS }), callTool: async () => ({ ok: true, value: { content: [] } }) }) as unknown as IMcpClient;
function counting(p: ICollectionProfile<ToolItem>) {
  const c = { binds: 0 };
  const profile: ICollectionProfile<ToolItem> = { name: p.name, bind: (t: CollectionStore) => { c.binds++; return p.bind(t); } };
  return { profile, c };
}
const builder = () => new SmartAgentBuilder({}).withMainLlm(makeLlm([{ content: 'ok' }])).withMcpClients([client()]);

describe('SmartAgentBuilder.withToolsProfile', () => {
  it('binds the tools store, fills it through the profile, and reports records + profile', async () => {
    const tools = new InMemoryRag();
    const handle = await builder().setToolsRag(tools).withToolsProfile(mcpToolsVariants.faceted()).build();
    try {
      const projected = handle.ragStores.tools;
      assert.ok(projected && hasRetrievalStrategy(projected));
      assert.ok(toolsBindingOf(projected));
      const r = await projected.query(new TextOnlyEmbedding('read file'), 1);
      assert.ok(r.ok);
      assert.equal(r.value[0].metadata.id, 'tool:read_file');
      assert.ok(isToolCatalogReporter(handle.agent));
      const s = handle.agent.getToolCatalogStatus();
      assert.equal(s?.profile, 'mcp-tools');
      assert.equal(s?.vectorized, 2);
      assert.ok((s?.records ?? 0) >= 2);
    } finally {
      await handle.close();
    }
  });

  it('a store already bound (by the server) is reused, never bound twice', async () => {
    const { profile, c } = counting(mcpToolsVariants.faceted());
    const bound = bindToolsProfile(profile, { key: 'tools', rag: new InMemoryRag() });
    const handle = await builder().setToolsRag(bound.rag).withToolsProfile(profile).build();
    await handle.close();
    assert.equal(c.binds, 1);
  });

  it("withToolsProfile + withRetrievalStrategy('tools', …) is refused", async () => {
    await assert.rejects(
      builder().setToolsRag(new InMemoryRag()).withToolsProfile(mcpToolsVariants.faceted()).withRetrievalStrategy('tools', new EmbeddingRetrieval()).build(),
      /withToolsProfile and withRetrievalStrategy\('tools'/,
    );
  });

  it('without a profile nothing changes: no binding, no profile in the status', async () => {
    const handle = await builder().setToolsRag(new InMemoryRag()).build();
    try {
      const projected = handle.ragStores.tools;
      assert.ok(projected);
      assert.equal(toolsBindingOf(projected), undefined);
      assert.ok(isToolCatalogReporter(handle.agent));
      assert.equal(handle.agent.getToolCatalogStatus()?.profile, undefined);
    } finally {
      await handle.close();
    }
  });
});
```

Append to `collection-profile.typecheck.ts`:
```ts
import { SmartAgentBuilder } from '../../builder.js';
// @ts-expect-error a shared-items profile is not a tools profile
export const _builderRefusesShared = new SmartAgentBuilder({}).withToolsProfile(shared);
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts`
Expected: FAIL — `withToolsProfile is not a function`.

- [ ] **Step 3: Implement**

In `builder.ts`:
- imports: add `ICollectionProfile`, `ToolItem` to the `@mcp-abap-adt/llm-agent` type import; add `import { bindToolsProfile, toolsBindingOf } from './collections/tools-binding.js';`
- field, after `private readonly _retrievalStrategies = …`:
  ```ts
  private _toolsProfile?: ICollectionProfile<ToolItem>;
  ```
- method, after `withRetrievalStrategy(…)`:
  ```ts
  /**
   * A tools collection profile (spec §6.1): bound to the `tools` store (set by
   * setToolsRag or auto-created), filled through it at build where the 30.1.0
   * tool records were written, and its retrieval applied like an explicit
   * strategy. A store the server already bound is reused, never bound twice.
   */
  withToolsProfile(profile: ICollectionProfile<ToolItem>): this {
    this._toolsProfile = profile;
    return this;
  }
  ```
- replace the `const toolsRag: IRag | undefined = this._toolsRag ?? (…);` block with:
  ```ts
    const baseToolsRag: IRag | undefined =
      this._toolsRag ??
      ((this.cfg.mcp || this._mcpClients || this._mcpServers) && this._embedder
        ? new InMemoryRag()
        : undefined);
    if (this._toolsProfile && this._retrievalStrategies.has('tools')) {
      throw new Error(
        "SmartAgentBuilder: withToolsProfile and withRetrievalStrategy('tools', …) both set — one store, one owner of its ranking",
      );
    }
    if (this._toolsProfile && !baseToolsRag) {
      throw new Error(
        'SmartAgentBuilder: withToolsProfile needs a tools store — setToolsRag(…), or MCP with an embedder',
      );
    }
    // A store the server bound already carries its binding (kept with its decorators).
    const existingToolsBinding = baseToolsRag ? toolsBindingOf(baseToolsRag) : undefined;
    const toolsBinding =
      existingToolsBinding ??
      (baseToolsRag && this._toolsProfile
        ? bindToolsProfile(this._toolsProfile, { key: 'tools', rag: baseToolsRag })
        : undefined);
    const toolsRag: IRag | undefined =
      existingToolsBinding || !toolsBinding ? baseToolsRag : toolsBinding.rag;
  ```
- in the `vectorizeMcpTools(…)` call's `ns` object, after `toolNamespace: …,` add:
  ```ts
            ...(toolsBinding ? { binding: toolsBinding } : {}),
  ```

- [ ] **Step 4: Run (new + existing builder/retrieval tests + golden + typecheck)**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts packages/llm-agent-libs/src/retrieval/__tests__/*.test.ts packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts
npm run typecheck
npm test --workspace @mcp-abap-adt/llm-agent-libs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): SmartAgentBuilder.withToolsProfile — bind once, fill at build, retrieval applied

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 21: YAML `rag.profiles.tools` and `decision.provider: sap-aicore` — types, resolution, validation (server-libs)

Spec §6.2 (all validation rules; only the key `tools`, S8), §5.2 (the Cohere decision model's fields), §13. Names only; instances come in Task 22. **No new section and no new seam:** Cohere is a value of the existing `decision.provider`, built by the existing `makeDecisionModel` seam (Task 24).

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/profiles-config.ts` (types + resolution)
- Create: `packages/llm-agent-server-libs/src/smart-agent/profiles-config-validator.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/decision-config.ts` (`SmartServerDecisionConfig`: `provider: 'typesafe' | 'sap-aicore'`, optional `deploymentId`, `resourceGroup`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/rag-config.ts:161-167` (`SmartServerRagConfig.profiles?`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` (`resolveRagSection`; `resolveDecisionSection` copies the two new fields)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config.ts` (worker refusal)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config-validator.ts` (`checkRag` allowed keys; `checkDecision` per provider; `checkRetrieval` refuses a question / task under Cohere; call `checkProfiles`)
- Modify: `packages/llm-agent-server-libs/src/index.ts` (export the new config types)
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts`

**Interfaces:**
- Consumes: `parseIntegerField` (`decision-config.ts`); `get` (`yaml-loader.ts`); `SmartServerRagStoreConfig` (`rag-config.ts`).
- Produces:
  ```ts
  // decision-config.ts — one interface, additive (spec §17.5): a consumer's own makeDecisionModel still compiles
  export interface SmartServerDecisionConfig { provider: 'typesafe' | 'sap-aicore'; model?: string; credentialRef?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; deploymentId?: string; resourceGroup?: string }
  export type SmartServerIntentSourceConfig = { file: string } | { llm: string };
  export type SmartServerProfileIntentsConfig = { record: SmartServerIntentSourceConfig } | { companion: { source: SmartServerIntentSourceConfig; store: SmartServerRagStoreConfig } };
  export type SmartServerIndexerConfig = { faceted: string[] } | { 'enum-values': { inner: { faceted: string[] }; discriminator: string | { named: string }; maxValues: number } };
  export type SmartServerCutConfig = 'top-items' | Readonly<Record<string, unknown>>; // { fixed-items: n } | { score-floor: {…} } | { token-budget: {…} } | { <registered>: args }
  export interface SmartServerComposeConfig { indexer: SmartServerIndexerConfig; pool: Readonly<Record<string, unknown>>; collapse?: string; reranker?: 'none' | 'decision' | 'llm'; question?: 'tool' | 'passage'; llm?: string; decomposer?: string; cut?: SmartServerCutConfig; onFailure?: 'stage1' | 'error' }
  export interface SmartServerProfileConfig { variant?: string; compose?: SmartServerComposeConfig; intents?: SmartServerProfileIntentsConfig; decomposer?: string; smallSet?: { poolItems: number } }
  export const PROFILE_STORE_KEYS: readonly ['tools'];   // S8: the only key bound from YAML in this PR
  export function resolveProfilesSection(raw: unknown): Record<string, SmartServerProfileConfig> | undefined;
  export function checkProfiles(yaml: YamlConfig, rag: Record<string, unknown>, llmKeys: ReadonlySet<string>, issues: string[]): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import { loadYamlConfig } from '../yaml-loader.js';

const LLM = 'llm:\n  main: { provider: openai, model: gpt-4o }\n  intents: { provider: openai, model: gpt-4o-mini }\n';
const RAG = 'rag:\n  store: { type: in-memory }\n';
const JEV = 'decision:\n  provider: typesafe\n';
const COHERE = 'decision:\n  provider: sap-aicore\n  deploymentId: d1\n  model: cohere-rerank\n';

/** `profiles` lines are indented under `rag:` by the caller. */
function resolve(profiles: string, extra = '') {
  return resolveSmartServerConfig(
    {},
    parse(`${LLM}${RAG}  profiles:\n${profiles.split('\n').map((l) => `    ${l}`).join('\n')}\n${extra}`),
    {},
    { skipProviderRuntimeChecks: true },
  );
}
const refused = (profiles: string, re: RegExp, extra = '') => assert.throws(() => resolve(profiles, extra), re);
const resolveYaml = (yaml: string) =>
  resolveSmartServerConfig({}, parse(yaml), {}, { skipProviderRuntimeChecks: true });

describe('rag.profiles resolution', () => {
  it('a variant with intents and a decomposer name', () => {
    const cfg = resolve('tools:\n  variant: faceted\n  intents: { record: { file: ./i.json } }\n  decomposer: my-splitter');
    assert.deepEqual(cfg.rag?.profiles, {
      tools: { variant: 'faceted', intents: { record: { file: './i.json' } }, decomposer: 'my-splitter' },
    });
  });
  it('small-set-jev with poolItems (string from ${VAR} counts)', () => {
    const cfg = resolve('tools: { variant: small-set-jev, smallSet: { poolItems: "25" } }', JEV);
    assert.deepEqual(cfg.rag?.profiles?.tools, { variant: 'small-set-jev', smallSet: { poolItems: 25 } });
  });
  it('a composition by strategy names', () => {
    const cfg = resolve(
      'tools:\n  compose:\n    indexer: { faceted: [summary, parameters] }\n    pool: { items: 30 }\n    collapse: max\n    reranker: decision\n    question: tool\n    cut: { fixed-items: 5 }\n    onFailure: stage1',
      JEV,
    );
    assert.deepEqual(cfg.rag?.profiles?.tools?.compose, {
      indexer: { faceted: ['summary', 'parameters'] },
      pool: { items: 30 },
      collapse: 'max',
      reranker: 'decision',
      question: 'tool',
      cut: { 'fixed-items': 5 },
      onFailure: 'stage1',
    });
  });
  it('absent → absent (30.1.0)', () => {
    const cfg = resolveYaml(`${LLM}${RAG}`);
    assert.equal(cfg.rag?.profiles, undefined);
  });
});

describe('decision.provider: sap-aicore (Cohere, spec §5.2, §6.2)', () => {
  it('named fields only; typesafe stays as it was', () => {
    const cfg = resolve('tools: { variant: faceted-cohere }', `${COHERE}  resourceGroup: rg\n  credentialRef: AICORE\n`);
    assert.deepEqual(cfg.decision, {
      provider: 'sap-aicore', deploymentId: 'd1', model: 'cohere-rerank', resourceGroup: 'rg', credentialRef: 'AICORE',
    });
    assert.deepEqual(resolveYaml(`${LLM}${RAG}${JEV}`).decision, { provider: 'typesafe' });
  });
  it('sap-aicore needs deploymentId and model; typesafe-only fields are refused there, and the other way round', () => {
    assert.throws(() => resolveYaml(`${LLM}${RAG}decision:\n  provider: sap-aicore\n  model: m\n`), /decision\.deploymentId: required for provider sap-aicore/);
    assert.throws(() => resolveYaml(`${LLM}${RAG}decision:\n  provider: sap-aicore\n  deploymentId: d\n`), /decision\.model: required for provider sap-aicore/);
    assert.throws(() => resolveYaml(`${LLM}${RAG}${COHERE}  timeoutMs: 5000\n`), /decision\.timeoutMs: applies to provider typesafe only/);
    assert.throws(() => resolveYaml(`${LLM}${RAG}${JEV}  deploymentId: d\n`), /decision\.deploymentId: applies to provider sap-aicore only/);
  });
  it('another provider and a secret are refused', () => {
    assert.throws(() => resolveYaml(`${LLM}${RAG}decision:\n  provider: other\n`), /decision\.provider: must be 'typesafe' or 'sap-aicore'/);
    assert.throws(() => resolveYaml(`${LLM}${RAG}${COHERE}  apiKey: x\n`), /decision\.apiKey: secrets are no longer read/);
  });
  it('rag.retrieval: a question or task for the decision reranker is refused under Cohere (it reads no wording)', () => {
    assert.throws(
      () => resolveYaml(`${LLM}${RAG}  retrieval:\n    tools: { strategy: rerank, reranker: decision, question: tool }\n${COHERE}`),
      /rag\.retrieval\.tools: question \/ task do not apply with decision\.provider: sap-aicore/,
    );
    assert.doesNotThrow(() => resolveYaml(`${LLM}${RAG}  retrieval:\n    tools: { strategy: rerank, reranker: decision }\n${COHERE}`));
  });
});

describe('rag.profiles validation — startup errors, never a silent drop', () => {
  it('S8: a key other than tools is refused, pointing to the library API', () => {
    refused('tools-writer: { variant: faceted }', /rag\.profiles\.tools-writer: only the key tools is bound from YAML/);
  });
  it('variant and compose together; neither', () => {
    refused('tools: { variant: faceted, compose: { indexer: { faceted: [] }, pool: { items: 3 } } }', /set variant or compose, not both/);
    refused('tools: { decomposer: x }', /rag\.profiles\.tools: set variant or compose/);
  });
  it('a key under both retrieval and profiles', () => {
    assert.throws(
      () => resolveYaml(`${LLM}${RAG}  retrieval:\n    tools: { strategy: embedding }\n  profiles:\n    tools: { variant: faceted }\n`),
      /also under rag\.retrieval/,
    );
  });
  it('intents or decomposer with baseline', () => {
    refused('tools: { variant: baseline, intents: { record: { file: x.json } } }', /intents: not with variant baseline/);
    refused('tools: { variant: baseline, decomposer: x }', /decomposer: not with variant baseline/);
  });
  it('companion without store; an llm key not in llm:', () => {
    refused('tools: { variant: faceted, intents: { companion: { source: { file: x.json } } } }', /companion\.store: required/);
    refused('tools: { variant: faceted, intents: { record: { llm: nope } } }', /"nope" is not a key of the llm: map/);
  });
  it('small-set-jev: poolItems required and positive; a decision: section required', () => {
    refused('tools: { variant: small-set-jev }', /smallSet\.poolItems: required/, JEV);
    refused('tools: { variant: small-set-jev, smallSet: { poolItems: 0 } }', /smallSet\.poolItems: required/, JEV);
    refused('tools: { variant: small-set-jev, smallSet: { poolItems: 25 } }', /small-set-jev requires a decision: section/);
  });
  it('a decision variant without decision:, or with the other provider (spec §17.5)', () => {
    refused('tools: { variant: faceted-jev }', /faceted-jev requires a decision: section/);
    refused('tools: { variant: faceted-cohere }', /faceted-cohere requires a decision: section/);
    refused('tools: { variant: faceted-cohere }', /faceted-cohere reranks with Cohere — needs decision\.provider: sap-aicore \(got "typesafe"\)/, JEV);
    refused('tools: { variant: faceted-jev }', /faceted-jev reranks with Jev — needs decision\.provider: typesafe \(got "sap-aicore"\)/, COHERE);
    refused('tools: { variant: small-set-jev, smallSet: { poolItems: 25 } }', /small-set-jev reranks with Jev/, COHERE);
  });
  it('compose: decision works with either provider; question refused under Cohere; cross-encoder is not a reranker name', () => {
    const base = 'indexer: { faceted: [] }, pool: { items: 3 }';
    assert.doesNotThrow(() => resolve(`tools: { compose: { ${base}, reranker: decision } }`, COHERE));
    refused(`tools: { compose: { ${base}, reranker: decision, question: tool } }`, /question: Cohere \(decision\.provider: sap-aicore\) reads no question wording/, COHERE);
    refused(`tools: { compose: { ${base}, reranker: cross-encoder } }`, /reranker: must be one of none \| decision \| llm/, COHERE);
    refused(`tools: { compose: { ${base}, reranker: decision } }`, /reranker: decision requires a decision: section/);
  });
  it('compose: non-positive pool; minItems > maxItems; enum-values without maxValues; non-positive budgetTokens; an llm key not in llm:', () => {
    const base = 'indexer: { faceted: [] }, pool: { items: 3 }';
    refused('tools: { compose: { indexer: { faceted: [] }, pool: { items: 0 } } }', /pool\.items: must be a positive integer/);
    refused(`tools: { compose: { ${base}, cut: { score-floor: { minItems: 4, maxItems: 3, minScore: 0.5 } } } }`, /minItems > maxItems/);
    refused('tools: { compose: { indexer: { enum-values: { inner: { faceted: [] }, discriminator: required-enum } }, pool: { items: 3 } } }', /maxValues: required/);
    refused(`tools: { compose: { ${base}, cut: { token-budget: { budgetTokens: 0 } } } }`, /budgetTokens: required/);
    refused(`tools: { compose: { ${base}, reranker: llm, llm: nope } }`, /"nope" is not a key of the llm: map/);
  });
  it('a worker config declaring rag.profiles is refused (server-wide)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'profiles-worker-'));
    writeFileSync(path.join(dir, 'w.yaml'), `${RAG}  profiles:\n    tools: { variant: faceted }\n`);
    const main = path.join(dir, 'main.yaml');
    writeFileSync(main, `${LLM}subagents:\n  - name: w\n    config: ./w.yaml\n`);
    assert.throws(
      () => resolveSmartServerConfig({}, loadYamlConfig(main, {}), {}, { configPath: main, skipProviderRuntimeChecks: true }),
      /subagent 'w' rag\.profiles: profiles are server-wide — set them in the main config's rag\.profiles/,
    );
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx tsc -b packages/llm-agent packages/llm-agent-libs && node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts`
Expected: FAIL — `rag.profiles: unknown key` (from `checkRag`), `decision.provider: must be 'typesafe'`, missing fields.

- [ ] **Step 3: Implement — types and resolution**

`decision-config.ts` — replace `SmartServerDecisionConfig` with (one interface; the validator enforces which fields each provider takes):
```ts
/** `decision:` — a decision model (numbers, not text). Secrets never here. */
export interface SmartServerDecisionConfig {
  /** `typesafe` = TypeSafe Jev; `sap-aicore` = Cohere Rerank on SAP AI Core (spec §5). */
  provider: 'typesafe' | 'sap-aicore';
  /** typesafe: optional (unset → `jev-latest`). sap-aicore: required, sent as `model`. */
  model?: string;
  /** Names the account; the composition root resolves it (default `DECISION`). */
  credentialRef?: string;
  /** typesafe only. */
  baseUrl?: string;
  /** typesafe only: per-attempt timeout in ms (positive integer). */
  timeoutMs?: number;
  /** typesafe only: retries after the first attempt (non-negative integer); `0` disables them. */
  maxRetries?: number;
  /** sap-aicore only (required there): the AI Core deployment serving the rerank model. */
  deploymentId?: string;
  /** sap-aicore only: header `AI-Resource-Group`; unset → 'default'. */
  resourceGroup?: string;
}
```

`resolve-config-sections.ts` `resolveDecisionSection`, after the `baseUrl` block:
```ts
  if (raw.deploymentId !== undefined && raw.deploymentId !== null) {
    out.deploymentId = String(raw.deploymentId);
  }
  if (raw.resourceGroup !== undefined && raw.resourceGroup !== null) {
    out.resourceGroup = String(raw.resourceGroup);
  }
```

```ts
// packages/llm-agent-server-libs/src/smart-agent/profiles-config.ts
/**
 * `rag.profiles` (spec §6.2): NAMES only. The resolver
 * (resolve-collection-profiles.ts) maps names to strategy instances; no
 * component reads configuration. Invalid values are left for the validator
 * (same parser) to report. The decision model comes from the existing
 * `decision:` section (Jev or Cohere) — there is no reranker section here.
 */
import { parseIntegerField } from './decision-config.js';
import type { SmartServerRagStoreConfig } from './rag-config.js';

/** S8: the only store key the server binds from YAML in this PR (its own tools store). */
export const PROFILE_STORE_KEYS = ['tools'] as const;

export type SmartServerIntentSourceConfig = { file: string } | { llm: string };

export type SmartServerProfileIntentsConfig =
  | { record: SmartServerIntentSourceConfig }
  | {
      companion: {
        source: SmartServerIntentSourceConfig;
        store: SmartServerRagStoreConfig;
      };
    };

export type SmartServerIndexerConfig =
  | { faceted: string[] }
  | {
      'enum-values': {
        inner: { faceted: string[] };
        discriminator: string | { named: string };
        maxValues: number;
      };
    };

/** 'top-items' | { fixed-items: n } | { score-floor: {…} } | { token-budget: {…} } | { <registered>: args } */
export type SmartServerCutConfig = 'top-items' | Readonly<Record<string, unknown>>;

export interface SmartServerComposeConfig {
  indexer: SmartServerIndexerConfig;
  /** { items: n } → ItemPool(n), or { <registered>: args }. */
  pool: Readonly<Record<string, unknown>>;
  collapse?: string;
  /** `decision` = DecisionReranker over the `decision:` section's model (Jev or Cohere). */
  reranker?: 'none' | 'decision' | 'llm';
  question?: 'tool' | 'passage';
  llm?: string;
  decomposer?: string;
  cut?: SmartServerCutConfig;
  onFailure?: 'stage1' | 'error';
}

export interface SmartServerProfileConfig {
  variant?: string;
  compose?: SmartServerComposeConfig;
  intents?: SmartServerProfileIntentsConfig;
  decomposer?: string;
  smallSet?: { poolItems: number };
}

type Obj = Record<string, unknown>;
const isMap = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown): number | undefined => {
  const n = parseIntegerField(v);
  return typeof n === 'number' ? n : undefined;
};

/** Integers that arrive as `${VAR}` strings become numbers; everything else is copied. */
function normalizeNumbers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalizeNumbers);
  if (!isMap(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    const n =
      ['items', 'maxValues', 'poolItems', 'fixed-items', 'minItems', 'maxItems', 'budgetTokens'].includes(k)
        ? int(x)
        : undefined;
    out[k] = n ?? normalizeNumbers(x);
  }
  return out;
}

export function resolveProfilesSection(
  raw: unknown,
): Record<string, SmartServerProfileConfig> | undefined {
  if (!isMap(raw)) return undefined;
  const out: Record<string, SmartServerProfileConfig> = {};
  for (const [key, e] of Object.entries(raw)) {
    if (!isMap(e)) continue;
    // checkProfiles validates the raw YAML; the shapes below are what it accepts.
    out[key] = normalizeNumbers(e) as SmartServerProfileConfig;
  }
  return out;
}
```

(The single `as SmartServerProfileConfig` sits at the config boundary: `checkProfiles` below is the runtime check of exactly this shape, run on the raw YAML before the server starts.)

- [ ] **Step 4: Implement — validation**

```ts
// packages/llm-agent-server-libs/src/smart-agent/profiles-config-validator.ts
import { parseIntegerField } from './decision-config.js';
import { PROFILE_STORE_KEYS } from './profiles-config.js';
import { get, type YamlConfig } from './yaml-loader.js';

type Obj = Record<string, unknown>;
const isMap = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown): boolean => {
  const n = parseIntegerField(v);
  return typeof n === 'number' && n > 0;
};
const name = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

const PROFILE_FIELDS = ['variant', 'compose', 'intents', 'decomposer', 'smallSet'];
const COMPOSE_FIELDS = ['indexer', 'pool', 'collapse', 'reranker', 'question', 'llm', 'decomposer', 'cut', 'onFailure'];
const COMPOSE_RERANKERS = ['none', 'decision', 'llm'];
/** The decision provider each named decision variant was measured with (spec §5.5, §17.5). */
const VARIANT_PROVIDER: Readonly<Record<string, { provider: string; model: string }>> = {
  'faceted-cohere': { provider: 'sap-aicore', model: 'Cohere' },
  'faceted-jev': { provider: 'typesafe', model: 'Jev' },
  'small-set-jev': { provider: 'typesafe', model: 'Jev' },
};

function checkIntentSource(label: string, src: unknown, llmKeys: ReadonlySet<string>, issues: string[]): void {
  const keys = isMap(src) ? Object.keys(src) : [];
  if (!isMap(src) || keys.length !== 1 || (keys[0] !== 'file' && keys[0] !== 'llm')) {
    issues.push(`${label}: must be exactly one of { file: <path> } or { llm: <key> }`);
    return;
  }
  const v = src[keys[0]];
  if (!name(v)) issues.push(`${label}.${keys[0]}: must be a non-empty string`);
  else if (keys[0] === 'llm' && !llmKeys.has(String(v))) {
    issues.push(`${label}.llm: "${String(v)}" is not a key of the llm: map`);
  }
}

function checkIntents(label: string, v: unknown, llmKeys: ReadonlySet<string>, issues: string[]): void {
  const keys = isMap(v) ? Object.keys(v) : [];
  if (!isMap(v) || keys.length !== 1 || (keys[0] !== 'record' && keys[0] !== 'companion')) {
    issues.push(`${label}: set exactly one of record or companion`);
    return;
  }
  if (keys[0] === 'record') {
    checkIntentSource(`${label}.record`, v.record, llmKeys, issues);
    return;
  }
  const c = v.companion;
  if (!isMap(c)) {
    issues.push(`${label}.companion: must be { source, store }`);
    return;
  }
  checkIntentSource(`${label}.companion.source`, c.source, llmKeys, issues);
  if (!isMap(c.store) || !name(c.store.type)) {
    issues.push(`${label}.companion.store: required (a store mapping with type:, like rag.store)`);
  }
}

function checkCut(label: string, cut: unknown, issues: string[]): void {
  if (cut == null || cut === 'top-items') return;
  if (!isMap(cut) || Object.keys(cut).length !== 1) {
    issues.push(`${label}: top-items, { fixed-items: n }, { score-floor: {…} }, { token-budget: {…} } or { <registered>: {…} }`);
    return;
  }
  const [[kind, v]] = Object.entries(cut);
  if (kind === 'fixed-items' && !posInt(v)) issues.push(`${label}.fixed-items: must be a positive integer`);
  if (kind === 'score-floor') {
    const o = isMap(v) ? v : {};
    const min = parseIntegerField(o.minItems);
    const max = parseIntegerField(o.maxItems);
    if (typeof min !== 'number' || min < 0) issues.push(`${label}.score-floor.minItems: must be a non-negative integer`);
    if (typeof max !== 'number' || max < 1) issues.push(`${label}.score-floor.maxItems: must be a positive integer`);
    if (typeof min === 'number' && typeof max === 'number' && min > max) issues.push(`${label}.score-floor: minItems > maxItems`);
    if (!Number.isFinite(Number(o.minScore)) || o.minScore == null) issues.push(`${label}.score-floor.minScore: must be a number`);
  }
  if (kind === 'token-budget') {
    const o = isMap(v) ? v : {};
    if (!posInt(o.budgetTokens)) issues.push(`${label}.token-budget.budgetTokens: required — a positive integer`);
    if (o.maxItems != null && !posInt(o.maxItems)) issues.push(`${label}.token-budget.maxItems: must be a positive integer`);
    if (o.estimator != null && !name(o.estimator)) issues.push(`${label}.token-budget.estimator: must be a registered name`);
  }
}

function checkIndexer(label: string, ix: unknown, issues: string[]): void {
  const names = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!isMap(ix)) {
    issues.push(`${label}: required — { faceted: [facet names] } or { enum-values: { inner, discriminator, maxValues } }`);
  } else if ('faceted' in ix) {
    if (!names(ix.faceted)) issues.push(`${label}.faceted: must be a list of facet names`);
  } else if ('enum-values' in ix) {
    const e = ix['enum-values'];
    const o = isMap(e) ? e : {};
    if (!isMap(o.inner) || !names(o.inner.faceted)) issues.push(`${label}.enum-values.inner: required — { faceted: [facet names] }`);
    if (!posInt(o.maxValues)) issues.push(`${label}.enum-values.maxValues: required — a positive integer`);
    const d = o.discriminator;
    if (!name(d) && !(isMap(d) && name(d.named))) {
      issues.push(`${label}.enum-values.discriminator: required — required-enum, { named: <parameter> } or a registered name`);
    }
  } else {
    issues.push(`${label}: must be { faceted: … } or { enum-values: … }`);
  }
}

interface DecisionCtx {
  llmKeys: ReadonlySet<string>;
  /** `decision.provider` when a decision: section exists, else undefined. */
  decisionProvider: string | undefined;
  hasDecision: boolean;
}

function checkCompose(label: string, c: unknown, ctx: DecisionCtx, issues: string[]): void {
  if (!isMap(c)) {
    issues.push(`${label}: must be a mapping`);
    return;
  }
  for (const f of Object.keys(c)) if (!COMPOSE_FIELDS.includes(f)) issues.push(`${label}.${f}: unknown key`);
  checkIndexer(`${label}.indexer`, c.indexer, issues);
  if (!isMap(c.pool)) issues.push(`${label}.pool: required — { items: <n> } or { <registered>: {…} }`);
  else if ('items' in c.pool && !posInt(c.pool.items)) issues.push(`${label}.pool.items: must be a positive integer`);
  if (c.collapse != null && !name(c.collapse)) issues.push(`${label}.collapse: must be a name (max or a registered one)`);
  const rr = c.reranker ?? 'none';
  if (!COMPOSE_RERANKERS.includes(String(rr))) {
    issues.push(`${label}.reranker: must be one of ${COMPOSE_RERANKERS.join(' | ')} (got ${JSON.stringify(rr)})`);
  }
  if (c.question != null) {
    if (rr !== 'decision' && rr !== 'llm') issues.push(`${label}.question: only applies to reranker decision | llm`);
    else if (c.question !== 'tool' && c.question !== 'passage') issues.push(`${label}.question: must be tool | passage`);
    else if (rr === 'decision' && ctx.decisionProvider === 'sap-aicore') {
      issues.push(`${label}.question: Cohere (decision.provider: sap-aicore) reads no question wording — remove it`);
    }
  }
  if (rr === 'decision' && !ctx.hasDecision) issues.push(`${label}.reranker: decision requires a decision: section`);
  if (rr === 'llm') {
    if (!name(c.llm)) issues.push(`${label}.llm: required for reranker: llm (a key of the llm: map)`);
    else if (!ctx.llmKeys.has(String(c.llm))) issues.push(`${label}.llm: "${String(c.llm)}" is not a key of the llm: map`);
  } else if (c.llm != null) {
    issues.push(`${label}.llm: only applies to reranker: llm`);
  }
  if (c.onFailure != null) {
    if (c.onFailure !== 'stage1' && c.onFailure !== 'error') issues.push(`${label}.onFailure: must be stage1 | error`);
    if (rr === 'none') issues.push(`${label}.onFailure: only applies with a reranker`);
  }
  if (c.decomposer != null && !name(c.decomposer)) issues.push(`${label}.decomposer: must be none or a registered name`);
  checkCut(`${label}.cut`, c.cut, issues);
}

/** `rag.profiles` — validated on the raw YAML (spec §6.2). Names are checked at startup by the resolver. */
export function checkProfiles(
  yaml: YamlConfig,
  rag: Obj,
  llmKeys: ReadonlySet<string>,
  issues: string[],
): void {
  const raw = rag.profiles;
  if (raw == null) return;
  if (!isMap(raw)) {
    issues.push('rag.profiles: must be a mapping of store key → profile');
    return;
  }
  const retrieval = isMap(rag.retrieval) ? rag.retrieval : {};
  const decision = get(yaml, 'decision');
  const hasDecision = decision != null;
  const decisionProvider = isMap(decision) && typeof decision.provider === 'string' ? decision.provider : undefined;
  for (const [key, entry] of Object.entries(raw)) {
    const label = `rag.profiles.${key}`;
    if (!(PROFILE_STORE_KEYS as readonly string[]).includes(key)) {
      // S8: the server binds only its own tools store from YAML in this PR.
      issues.push(
        `${label}: only the key tools is bound from YAML in this release — bind other stores in your composition root (profile.bind({ key, rag }) + builder.withRetrievalStrategy(key, bound.retrieval))`,
      );
      continue;
    }
    if (!isMap(entry)) {
      issues.push(`${label}: must be a mapping`);
      continue;
    }
    for (const f of Object.keys(entry)) if (!PROFILE_FIELDS.includes(f)) issues.push(`${label}.${f}: unknown key`);
    if (key in retrieval) issues.push(`${label}: ${key} is also under rag.retrieval — one store, one owner of its ranking`);
    const hasVariant = entry.variant != null;
    const hasCompose = entry.compose != null;
    if (hasVariant && hasCompose) issues.push(`${label}: set variant or compose, not both`);
    if (!hasVariant && !hasCompose) issues.push(`${label}: set variant or compose`);
    if (hasVariant && !name(entry.variant)) issues.push(`${label}.variant: must be a name`);
    const variant = entry.variant;
    if (variant === 'baseline') {
      if (entry.intents != null) issues.push(`${label}.intents: not with variant baseline`);
      if (entry.decomposer != null) issues.push(`${label}.decomposer: not with variant baseline`);
    }
    if (variant === 'small-set-jev') {
      if (!isMap(entry.smallSet) || !posInt(entry.smallSet.poolItems)) {
        issues.push(`${label}.smallSet.poolItems: required for small-set-jev — a positive integer ≥ the store's tool count`);
      }
    } else if (entry.smallSet != null) {
      issues.push(`${label}.smallSet: only applies to variant small-set-jev`);
    }
    const wants = typeof variant === 'string' ? VARIANT_PROVIDER[variant] : undefined;
    if (wants && !hasDecision) {
      issues.push(`${label}.variant: ${variant} requires a decision: section (provider: ${wants.provider})`);
    } else if (wants && decisionProvider !== wants.provider) {
      issues.push(
        `${label}.variant: ${variant} reranks with ${wants.model} — needs decision.provider: ${wants.provider} (got ${JSON.stringify(decisionProvider)}); for the other model use compose with reranker: decision`,
      );
    }
    if (entry.decomposer != null && !name(entry.decomposer)) issues.push(`${label}.decomposer: must be a registered name`);
    if (entry.intents != null) checkIntents(`${label}.intents`, entry.intents, llmKeys, issues);
    if (hasCompose) checkCompose(`${label}.compose`, entry.compose, { llmKeys, decisionProvider, hasDecision }, issues);
  }
}
```

`config-validator.ts`:
- `checkDecision` — replace its body's provider check and add the per-provider rules (the `apiKey`, `credentialRef`, `timeoutMs`, `maxRetries` checks stay):
  ```ts
  const TYPESAFE_ONLY = ['baseUrl', 'timeoutMs', 'maxRetries'] as const;
  const SAP_AICORE_ONLY = ['deploymentId', 'resourceGroup'] as const;
  // inside checkDecision, replacing the `d.provider !== 'typesafe'` block and the model/baseUrl string loop:
      if (d.provider !== 'typesafe' && d.provider !== 'sap-aicore') {
        issues.push(
          `decision.provider: must be 'typesafe' or 'sap-aicore' (got ${JSON.stringify(d.provider)})`,
        );
      }
      for (const key of ['model', 'baseUrl', 'deploymentId', 'resourceGroup'] as const) {
        const v = d[key];
        if (v !== undefined && v !== null && (typeof v !== 'string' || !v.trim())) {
          issues.push(`decision.${key}: must be a non-empty string`);
        }
      }
      const set = (k: string) => d[k] !== undefined && d[k] !== null;
      if (d.provider === 'sap-aicore') {
        if (!set('deploymentId')) {
          issues.push('decision.deploymentId: required for provider sap-aicore (the AI Core deployment serving the rerank model)');
        }
        if (!set('model')) issues.push('decision.model: required for provider sap-aicore (sent as model)');
        for (const k of TYPESAFE_ONLY) if (set(k)) issues.push(`decision.${k}: applies to provider typesafe only`);
      }
      if (d.provider === 'typesafe') {
        for (const k of SAP_AICORE_ONLY) if (set(k)) issues.push(`decision.${k}: applies to provider sap-aicore only`);
      }
  ```
- `checkRetrieval`: after the `task` check add
  ```ts
    if (
      e.reranker === 'decision' &&
      get(yaml, 'decision', 'provider') === 'sap-aicore' &&
      (isSet('question') || isSet('task'))
    ) {
      issues.push(
        `${label}: question / task do not apply with decision.provider: sap-aicore — Cohere reads only the query and the passage`,
      );
    }
  ```
- `checkRag`: accept `profiles` (`key !== 'store' && key !== 'embedder' && key !== 'retrieval' && key !== 'profiles'`, message `rag holds store:, embedder:, retrieval: and profiles:`); after `checkRetrieval(yaml, rawRag …)` add `checkProfiles(yaml, rawRag as Record<string, unknown>, retrievalLlmKeys(get(yaml, 'llm')), issues);`.

Wiring edits:
- `rag-config.ts` `SmartServerRagConfig`, after `retrieval?`:
  ```ts
  /** Collection profiles, keyed by store key — only `tools` in this release (spec §6.2, S8); absent → 30.1.0 behaviour. */
  profiles?: Record<string, SmartServerProfileConfig>;
  ```
  (`import type { SmartServerProfileConfig } from './profiles-config.js';`)
- `resolve-config-sections.ts` `resolveRagSection`: after `...resolveRetrieval(get(yaml, 'rag', 'retrieval')),` add
  ```ts
    ...(() => {
      const profiles = resolveProfilesSection(get(yaml, 'rag', 'profiles'));
      return profiles ? { profiles } : {};
    })(),
  ```
- `config.ts` `resolveWorkerConfig`, after the `rag.retrieval` refusal:
  ```ts
  if ((get(subYaml, 'rag', 'profiles') ?? undefined) !== undefined) {
    throw new Error(
      `subagent '${name}' rag.profiles: profiles are server-wide — set them in the main config's rag.profiles`,
    );
  }
  ```
- `smart-server.ts`: **no change** in this task — the `decision:` section and `BuildAgentDeps.makeDecisionModel` already exist.
- `src/index.ts`: export `PROFILE_STORE_KEYS` and the types `SmartServerProfileConfig`, `SmartServerComposeConfig`, `SmartServerProfileIntentsConfig`, `SmartServerIntentSourceConfig`, `SmartServerIndexerConfig`, `SmartServerCutConfig` from `./smart-agent/profiles-config.js` (`SmartServerDecisionConfig` is already exported).

- [ ] **Step 5: Run (new + existing config tests)**

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/config-validation.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/decision-config.test.ts`
Expected: PASS. (If an existing test asserts the old message `decision.provider: must be 'typesafe'`, update it to the new message — the rule widened, the check did not weaken.)

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): rag.profiles.tools YAML and decision.provider sap-aicore — names, resolution, startup validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 22: Names → instances — `resolve-collection-profiles.ts` (server-libs)

Spec §6.2 (registries, the existing `makeDecisionModel` seam for Jev AND Cohere, intents file, companion store via `makeRag`), §5.5, §7.4 (D23 startup check).

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/resolve-collection-profiles.ts`
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`SmartServerConfig.toolsVariantFactories?`, `.toolsStrategyFactories?`)
- Modify: `packages/llm-agent-server-libs/src/index.ts` (export the registry types and `BUILT_IN_TOOLS_VARIANTS`, `BUILT_IN_TOOLS_STRATEGIES`)

**Interfaces:**
- Consumes: Task 21 config types; libs exports (Tasks 5–17): `ComposedToolsProfile`, `mcpToolsVariants`, facets, discriminators, `EnumValueToolIndexer`, `FacetedToolIndexer`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, cuts, `ToolDefinitionSizeEstimator`, `DecisionReranker`, `LlmReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `wrapDecisionModel`.
- Produces:
  ```ts
  export interface ToolsVariantInput { readonly decisionModel?: IDecisionModel; readonly poolItems?: number; readonly intents?: VariantIntents; readonly decompose?: StagedRetrievalOptions['decompose'] } // decisionModel = the decision: section's model (Jev or Cohere)
  export type ToolsVariantFactory = (input: ToolsVariantInput) => ICollectionProfile<ToolItem> | undefined;
  export interface ToolsStrategyFactories { readonly facets?: Readonly<Record<string, () => IToolFacet>>; readonly discriminators?: Readonly<Record<string, () => IDiscriminatorSelector>>; readonly pools?: Readonly<Record<string, (args: unknown) => ICandidatePool>>; readonly collapse?: Readonly<Record<string, () => ICollapseRule>>; readonly cuts?: Readonly<Record<string, (args: unknown) => IItemCut>>; readonly estimators?: Readonly<Record<string, () => IItemSizeEstimator>>; readonly decomposers?: Readonly<Record<string, (deps: { queryEmbedder: IQueryEmbedder }) => IQueryDecomposer>> }
  export const BUILT_IN_TOOLS_VARIANTS: Readonly<Record<string, ToolsVariantFactory>>;
  export const BUILT_IN_TOOLS_STRATEGIES: ToolsStrategyFactories;
  export interface ResolvedToolsProfile { readonly key: string; readonly profile?: ICollectionProfile<ToolItem>; readonly companions: Readonly<Record<string, IRag>>; readonly variant?: string; readonly poolItems?: number }
  export interface ResolveCollectionProfilesInput { profiles?: Record<string, SmartServerProfileConfig>; decisionCfg?: SmartServerDecisionConfig; makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel>; resolveLlm: (key: string) => Promise<ILlm>; queryEmbedder?: IQueryEmbedder; makeCompanionStore: (store: SmartServerRagStoreConfig) => Promise<IRag>; readFile?: (path: string) => string; variantFactories?: Readonly<Record<string, ToolsVariantFactory>>; strategyFactories?: ToolsStrategyFactories }
  export function resolveCollectionProfiles(input: ResolveCollectionProfilesInput): Promise<Map<string, ResolvedToolsProfile>>;
  export function assertSmallSetPool(p: ResolvedToolsProfile | undefined, status: ToolCatalogStatus | undefined): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type IDecisionModel, type ILlm, InMemoryRag } from '@mcp-abap-adt/llm-agent';
import {
  ComposedToolsProfile,
  DecisionReranker,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  FixedItemsCut,
  IntentCompanionIndexer,
  IntentRecordIndexer,
  ItemPool,
  MaxScoreCollapse,
  NamedDiscriminator,
  ParametersFacet,
  SummaryFacet,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  assertSmallSetPool,
  type ResolveCollectionProfilesInput,
  resolveCollectionProfiles,
} from '../resolve-collection-profiles.js';

const model = { decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) } as unknown as IDecisionModel;
function input(over: Partial<ResolveCollectionProfilesInput> = {}) {
  const seams = { decision: 0, stores: 0 };
  const i: ResolveCollectionProfilesInput = {
    decisionCfg: { provider: 'typesafe' },
    makeDecisionModel: async () => { seams.decision++; return model; },
    resolveLlm: async () => ({}) as ILlm,
    queryEmbedder: { embedQuery: async () => ({ vector: [1] }) },
    makeCompanionStore: async () => { seams.stores++; return new InMemoryRag(); },
    readFile: () => JSON.stringify({ read_file: ['open my notes'] }),
    ...over,
  };
  return { i, seams };
}
const composed = (p: unknown) => {
  assert.ok(p instanceof ComposedToolsProfile);
  return p.composition;
};

describe('resolveCollectionProfiles', () => {
  // The resolver is keyed (a library function); YAML allows only `tools` (Task 21, S8).
  it('variants: baseline binds nothing; faceted; the decision variants share ONE decision model from the existing seam', async () => {
    const { i, seams } = input({
      profiles: {
        a: { variant: 'baseline' },
        b: { variant: 'faceted' },
        c: { variant: 'faceted-jev' },
        d: { variant: 'small-set-jev', smallSet: { poolItems: 25 } },
      },
    });
    const out = await resolveCollectionProfiles(i);
    assert.equal(out.get('a')?.profile, undefined);
    assert.equal((composed(out.get('b')?.profile).pool as ItemPool).items, 15);
    assert.ok(composed(out.get('c')?.profile).rerank?.reranker instanceof DecisionReranker);
    assert.equal(out.get('d')?.poolItems, 25);
    assert.deepEqual(seams, { decision: 1, stores: 0 });
  });

  it('faceted-cohere: DecisionReranker over the model makeDecisionModel builds from decision: (provider sap-aicore)', async () => {
    const seen: string[] = [];
    const { i } = input({
      decisionCfg: { provider: 'sap-aicore', deploymentId: 'd1', model: 'cohere-rerank' },
      makeDecisionModel: async (cfg) => { seen.push(cfg.provider); return model; },
      profiles: { tools: { variant: 'faceted-cohere' } },
    });
    const out = await resolveCollectionProfiles(i);
    const c = composed(out.get('tools')?.profile);
    assert.ok(c.rerank?.reranker instanceof DecisionReranker);
    assert.equal((c.pool as ItemPool).items, 30);
    assert.deepEqual(seen, ['sap-aicore']);
  });

  it('intents: record from a file; companion builds its store through the seam', async () => {
    const { i, seams } = input({
      profiles: {
        r: { variant: 'faceted', intents: { record: { file: './i.json' } } },
        c: { variant: 'faceted', intents: { companion: { source: { file: './i.json' }, store: { type: 'in-memory' } } } },
      },
    });
    const out = await resolveCollectionProfiles(i);
    assert.ok(composed(out.get('r')?.profile).indexer instanceof IntentRecordIndexer);
    assert.ok(composed(out.get('c')?.profile).companions?.intents instanceof IntentCompanionIndexer);
    assert.ok(out.get('c')?.companions.intents);
    assert.equal(seams.stores, 1);
  });

  it('compose: every value a name of a strategy', async () => {
    const { i } = input({
      profiles: {
        w: {
          compose: {
            indexer: { faceted: ['summary', 'parameters'] },
            pool: { items: 30 },
            collapse: 'max',
            reranker: 'decision',
            question: 'tool',
            cut: { 'fixed-items': 5 },
            onFailure: 'error',
          },
        },
        v: {
          compose: {
            indexer: { 'enum-values': { inner: { faceted: [] }, discriminator: { named: 'object_type' }, maxValues: 40 } },
            pool: { items: 25 },
          },
        },
      },
    });
    const out = await resolveCollectionProfiles(i);
    const w = composed(out.get('w')?.profile);
    assert.ok(w.indexer instanceof FacetedToolIndexer);
    assert.deepEqual(w.indexer.facets.map((f) => f.constructor), [SummaryFacet, ParametersFacet]);
    assert.equal((w.pool as ItemPool).items, 30);
    assert.ok(w.cut instanceof FixedItemsCut && w.cut.k === 5);
    assert.equal(w.rerank?.onFailure, 'error');
    const v = composed(out.get('v')?.profile);
    assert.ok(v.indexer instanceof EnumValueToolIndexer);
    assert.ok(v.indexer.opts.discriminator instanceof NamedDiscriminator);
  });

  it("the consumer's registries: a variant and a decomposer", async () => {
    const mine = new ComposedToolsProfile({ indexer: new FacetedToolIndexer([]), pool: new ItemPool(3), collapse: new MaxScoreCollapse() });
    const { i } = input({
      profiles: { t: { variant: 'mine', decomposer: 'my-split' } },
      variantFactories: { mine: (vi) => { assert.ok(vi.decompose); return mine; } },
      strategyFactories: { decomposers: { 'my-split': () => ({ name: 'my-split', decompose: async () => ({ ok: true, value: [] }) }) } },
    });
    const out = await resolveCollectionProfiles(i);
    assert.equal(out.get('t')?.profile, mine);
  });

  it('unknown names and missing seams are startup errors naming the key', async () => {
    await assert.rejects(resolveCollectionProfiles(input({ profiles: { t: { variant: 'nope' } } }).i), /rag\.profiles\.t: unknown variant "nope"/);
    await assert.rejects(resolveCollectionProfiles(input({ profiles: { t: { compose: { indexer: { faceted: ['nope'] }, pool: { items: 3 } } } } }).i), /rag\.profiles\.t: unknown facet "nope"/);
    await assert.rejects(resolveCollectionProfiles(input({ profiles: { t: { variant: 'faceted', decomposer: 'nope' } } }).i), /unknown decomposer "nope" \(none is built in/);
    await assert.rejects(resolveCollectionProfiles(input({ profiles: { t: { variant: 'faceted-cohere' } }, makeDecisionModel: undefined }).i), /makeDecisionModel is required/);
  });

  it('assertSmallSetPool: poolItems below the tool count fails startup (D23)', () => {
    const p = { key: 'tools', companions: {}, variant: 'small-set-jev', poolItems: 20 };
    const status = (total: number) => ({ total, vectorized: total, failed: [], clientFailures: 0, complete: true });
    assert.throws(() => assertSmallSetPool(p, status(25)), /smallSet\.poolItems \(20\) is below the 25 tools/);
    assert.doesNotThrow(() => assertSmallSetPool(p, status(20)));
    assert.doesNotThrow(() => assertSmallSetPool(undefined, status(99)));
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-server-libs/src/smart-agent/resolve-collection-profiles.ts
/**
 * `rag.profiles` names → strategy instances (spec §6.2). The ONLY place the
 * server turns profile configuration into objects; components get instances.
 * Unknown name → startup error. The decision model (Jev or Cohere, by
 * `decision.provider`) comes from the composition root's existing
 * makeDecisionModel seam; the library constructs none from config.
 */
import { readFileSync } from 'node:fs';
import type {
  ICandidatePool,
  ICollapseRule,
  ICollectionProfile,
  IDecisionModel,
  IDiscriminatorSelector,
  IItemCut,
  IItemIndexer,
  IItemSizeEstimator,
  ILlm,
  IQueryDecomposer,
  IQueryEmbedder,
  IRag,
  IReranker,
  IToolFacet,
  IToolIntentSource,
  ToolCatalogStatus,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import {
  ComposedToolsProfile,
  DecisionReranker,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  FixedItemsCut,
  IntentCompanionIndexer,
  IntentRecordIndexer,
  ItemPool,
  LlmIntentSource,
  LlmReranker,
  MaxScoreCollapse,
  mcpToolsVariants,
  NamedDiscriminator,
  NameTailFacet,
  PASSAGE_QUESTION,
  ParametersFacet,
  RequiredEnumDiscriminator,
  ScoreFloorCut,
  type StagedRetrievalOptions,
  StaticIntentSource,
  SummaryFacet,
  TOOL_QUESTION,
  TokenBudgetCut,
  ToolDefinitionSizeEstimator,
  type VariantIntents,
  wrapDecisionModel,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerDecisionConfig } from './decision-config.js';
import type {
  SmartServerComposeConfig,
  SmartServerCutConfig,
  SmartServerIntentSourceConfig,
  SmartServerProfileConfig,
  SmartServerProfileIntentsConfig,
} from './profiles-config.js';
import type { SmartServerRagStoreConfig } from './rag-config.js';

export interface ToolsVariantInput {
  /** The decision: section's model — Jev (typesafe) or Cohere (sap-aicore). */
  readonly decisionModel?: IDecisionModel;
  readonly poolItems?: number;
  readonly intents?: VariantIntents;
  readonly decompose?: StagedRetrievalOptions['decompose'];
}
export type ToolsVariantFactory = (
  input: ToolsVariantInput,
) => ICollectionProfile<ToolItem> | undefined;

export interface ToolsStrategyFactories {
  readonly facets?: Readonly<Record<string, () => IToolFacet>>;
  readonly discriminators?: Readonly<Record<string, () => IDiscriminatorSelector>>;
  readonly pools?: Readonly<Record<string, (args: unknown) => ICandidatePool>>;
  readonly collapse?: Readonly<Record<string, () => ICollapseRule>>;
  readonly cuts?: Readonly<Record<string, (args: unknown) => IItemCut>>;
  readonly estimators?: Readonly<Record<string, () => IItemSizeEstimator>>;
  /** None is built in: the consumer registers its own (spec §4.5). */
  readonly decomposers?: Readonly<
    Record<string, (deps: { queryEmbedder: IQueryEmbedder }) => IQueryDecomposer>
  >;
}

const need = <T>(v: T | undefined, why: string): T => {
  if (v === undefined) throw new Error(why);
  return v;
};
const variantOptions = (i: ToolsVariantInput) => ({
  ...(i.intents ? { intents: i.intents } : {}),
  ...(i.decompose ? { decompose: i.decompose } : {}),
});

export const BUILT_IN_TOOLS_VARIANTS: Readonly<Record<string, ToolsVariantFactory>> = {
  baseline: () => mcpToolsVariants.baseline(),
  faceted: (i) => mcpToolsVariants.faceted(variantOptions(i)),
  'faceted-cohere': (i) =>
    mcpToolsVariants.facetedCohere({
      ...variantOptions(i),
      decisionModel: need(i.decisionModel, 'faceted-cohere needs the Cohere decision model (decision.provider: sap-aicore)'),
    }),
  'faceted-jev': (i) =>
    mcpToolsVariants.facetedJev({
      ...variantOptions(i),
      decisionModel: need(i.decisionModel, 'faceted-jev needs a decision model'),
    }),
  'small-set-jev': (i) =>
    mcpToolsVariants.smallSetJev({
      ...variantOptions(i),
      decisionModel: need(i.decisionModel, 'small-set-jev needs a decision model'),
      poolItems: need(i.poolItems, 'small-set-jev needs smallSet.poolItems'),
    }),
};

export const BUILT_IN_TOOLS_STRATEGIES: ToolsStrategyFactories = {
  facets: {
    summary: () => new SummaryFacet(),
    parameters: () => new ParametersFacet(),
    // opt-in, convention-dependent (spec §7.3.1)
    'name-tail': () => new NameTailFacet(),
  },
  discriminators: { 'required-enum': () => new RequiredEnumDiscriminator() },
  collapse: { max: () => new MaxScoreCollapse() },
  estimators: { 'tool-definition': () => new ToolDefinitionSizeEstimator() },
};

export interface ResolvedToolsProfile {
  readonly key: string;
  /** Undefined = baseline (no profile is bound). */
  readonly profile?: ICollectionProfile<ToolItem>;
  /** Companion stores the binding needs (`intents` for the companion placement). */
  readonly companions: Readonly<Record<string, IRag>>;
  readonly variant?: string;
  /** small-set-jev: checked against the tool count at startup (D23). */
  readonly poolItems?: number;
}

export interface ResolveCollectionProfilesInput {
  profiles?: Record<string, SmartServerProfileConfig>;
  decisionCfg?: SmartServerDecisionConfig;
  /** The existing seam; builds TypeSafeDecisionModel or SapAiCoreDecisionModel by provider. */
  makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IDecisionModel>;
  /** Resolves a key of the `llm:` map (strict). */
  resolveLlm: (key: string) => Promise<ILlm>;
  /** The store's query embedder (the one makeRag gives the store); for decomposers. */
  queryEmbedder?: IQueryEmbedder;
  /** Builds a companion store through the makeRag seam (shares the primary's embedder). */
  makeCompanionStore: (store: SmartServerRagStoreConfig) => Promise<IRag>;
  /** Test seam; default readFileSync(path, 'utf8'). */
  readFile?: (path: string) => string;
  variantFactories?: Readonly<Record<string, ToolsVariantFactory>>;
  strategyFactories?: ToolsStrategyFactories;
}

const MISSING_DECISION_SEAM =
  'BuildAgentDeps.makeDecisionModel is required: the config asks for a decision model, and the library constructs none from configuration. Supply it from your composition root.';

type Obj = Record<string, unknown>;
const isMap = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseIntentsFile(text: string, path: string): Record<string, readonly string[]> {
  const raw: unknown = JSON.parse(text);
  if (!isMap(raw)) throw new Error(`intents file ${path}: must be { "<tool name>": ["intent", …] }`);
  const out: Record<string, readonly string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) {
      throw new Error(`intents file ${path}: "${k}" must be a list of strings`);
    }
    out[k] = v;
  }
  return out;
}

export async function resolveCollectionProfiles(
  input: ResolveCollectionProfilesInput,
): Promise<Map<string, ResolvedToolsProfile>> {
  const out = new Map<string, ResolvedToolsProfile>();
  const entries = Object.entries(input.profiles ?? {});
  if (entries.length === 0) return out;
  const variants = { ...BUILT_IN_TOOLS_VARIANTS, ...input.variantFactories };
  const s: ToolsStrategyFactories = {
    facets: { ...BUILT_IN_TOOLS_STRATEGIES.facets, ...input.strategyFactories?.facets },
    discriminators: { ...BUILT_IN_TOOLS_STRATEGIES.discriminators, ...input.strategyFactories?.discriminators },
    pools: { ...input.strategyFactories?.pools },
    collapse: { ...BUILT_IN_TOOLS_STRATEGIES.collapse, ...input.strategyFactories?.collapse },
    cuts: { ...input.strategyFactories?.cuts },
    estimators: { ...BUILT_IN_TOOLS_STRATEGIES.estimators, ...input.strategyFactories?.estimators },
    decomposers: { ...input.strategyFactories?.decomposers },
  };
  const readFile = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  let decision: IDecisionModel | undefined;
  const decisionModel = async (): Promise<IDecisionModel> => {
    if (decision) return decision;
    const cfg = need(input.decisionCfg, 'a decision: section is required');
    const make = need(input.makeDecisionModel, MISSING_DECISION_SEAM);
    decision = wrapDecisionModel(await make(cfg));
    return decision;
  };
  const pick = <T>(reg: Readonly<Record<string, T>> | undefined, kind: string, n: string): T => {
    const f = reg?.[n];
    if (!f) throw new Error(`unknown ${kind} "${n}" (known: ${Object.keys(reg ?? {}).join(', ') || 'none'})`);
    return f;
  };
  const intentSource = async (src: SmartServerIntentSourceConfig): Promise<IToolIntentSource> =>
    'file' in src
      ? new StaticIntentSource(parseIntentsFile(readFile(src.file), src.file))
      : new LlmIntentSource(await input.resolveLlm(src.llm));
  const intentsOf = async (
    cfg: SmartServerProfileIntentsConfig,
    companions: Record<string, IRag>,
  ): Promise<VariantIntents> => {
    if ('record' in cfg) return { record: await intentSource(cfg.record) };
    companions.intents = await input.makeCompanionStore(cfg.companion.store);
    return { companion: await intentSource(cfg.companion.source) };
  };
  const decomposeOf = (n: string): StagedRetrievalOptions['decompose'] => {
    const f = s.decomposers?.[n];
    if (!f) throw new Error(`unknown decomposer "${n}" (none is built in — register yours in toolsStrategyFactories.decomposers)`);
    const queryEmbedder = need(input.queryEmbedder, `decomposer "${n}" needs the store's query embedder (rag.embedder)`);
    return { decomposer: f({ queryEmbedder }), queryEmbedder };
  };
  const facetsOf = (names: readonly string[]) => names.map((n) => pick(s.facets, 'facet', n)());
  const cutOf = (cut: SmartServerCutConfig | undefined): IItemCut | undefined => {
    if (cut === undefined || cut === 'top-items') return undefined;
    const [[kind, v]] = Object.entries(cut);
    const o = isMap(v) ? v : {};
    switch (kind) {
      case 'fixed-items':
        return new FixedItemsCut(Number(v));
      case 'score-floor':
        return new ScoreFloorCut({ minItems: Number(o.minItems), maxItems: Number(o.maxItems), minScore: Number(o.minScore) });
      case 'token-budget':
        return new TokenBudgetCut({
          budgetTokens: Number(o.budgetTokens),
          ...(o.maxItems != null ? { maxItems: Number(o.maxItems) } : {}),
          ...(typeof o.estimator === 'string' ? { estimator: pick(s.estimators, 'estimator', o.estimator)() } : {}),
        });
      default:
        return pick(s.cuts, 'cut', kind)(v);
    }
  };
  const composeOf = async (
    c: SmartServerComposeConfig,
    intents: VariantIntents | undefined,
    decompose: StagedRetrievalOptions['decompose'],
  ): Promise<ICollectionProfile<ToolItem>> => {
    let base: IItemIndexer<ToolItem>;
    if ('faceted' in c.indexer) base = new FacetedToolIndexer(facetsOf(c.indexer.faceted));
    else {
      const e = c.indexer['enum-values'];
      const d = e.discriminator;
      base = new EnumValueToolIndexer(new FacetedToolIndexer(facetsOf(e.inner.faceted)), {
        discriminator: typeof d === 'string' ? pick(s.discriminators, 'discriminator', d)() : new NamedDiscriminator(d.named),
        maxValues: e.maxValues,
      });
    }
    const indexing = !intents
      ? { indexer: base }
      : 'record' in intents
        ? { indexer: new IntentRecordIndexer(base, intents.record) }
        : { indexer: base, companions: { intents: new IntentCompanionIndexer(intents.companion) } };
    const [[poolKind, poolArgs]] = Object.entries(c.pool);
    const pool = poolKind === 'items' ? new ItemPool(Number(poolArgs)) : pick(s.pools, 'pool', poolKind)(poolArgs);
    const preset = (c.question ?? 'tool') === 'tool' ? TOOL_QUESTION : PASSAGE_QUESTION;
    let reranker: IReranker | undefined;
    switch (c.reranker ?? 'none') {
      case 'decision':
        // Jev or Cohere, whichever decision.provider names (spec §6.2).
        reranker = new DecisionReranker(await decisionModel(), { task: preset.task, criteria: preset.criteria });
        break;
      case 'llm':
        reranker = new LlmReranker(await input.resolveLlm(need(c.llm, 'reranker: llm needs llm:')), { question: { task: preset.task } });
        break;
    }
    const cut = cutOf(c.cut);
    return new ComposedToolsProfile({
      ...indexing,
      pool,
      collapse: pick(s.collapse, 'collapse rule', c.collapse ?? 'max')(),
      ...(reranker ? { rerank: { reranker, onFailure: c.onFailure ?? 'stage1' } } : {}),
      ...(decompose ? { decompose } : {}),
      ...(cut ? { cut } : {}),
    });
  };

  for (const [key, cfg] of entries) {
    try {
      const companions: Record<string, IRag> = {};
      const intents = cfg.intents ? await intentsOf(cfg.intents, companions) : undefined;
      const decomposerName = cfg.decomposer ?? cfg.compose?.decomposer;
      const decompose = decomposerName && decomposerName !== 'none' ? decomposeOf(decomposerName) : undefined;
      if (cfg.variant !== undefined) {
        const factory = variants[cfg.variant];
        if (!factory) throw new Error(`unknown variant "${cfg.variant}" (known: ${Object.keys(variants).join(', ')})`);
        const builtIn = cfg.variant in BUILT_IN_TOOLS_VARIANTS;
        const wantsDecision = builtIn
          ? cfg.variant === 'faceted-cohere' || cfg.variant === 'faceted-jev' || cfg.variant === 'small-set-jev'
          : input.decisionCfg !== undefined && input.makeDecisionModel !== undefined;
        const profile = factory({
          ...(wantsDecision ? { decisionModel: await decisionModel() } : {}),
          ...(cfg.smallSet ? { poolItems: cfg.smallSet.poolItems } : {}),
          ...(intents ? { intents } : {}),
          ...(decompose ? { decompose } : {}),
        });
        out.set(key, {
          key,
          ...(profile ? { profile } : {}),
          companions,
          variant: cfg.variant,
          ...(cfg.variant === 'small-set-jev' && cfg.smallSet ? { poolItems: cfg.smallSet.poolItems } : {}),
        });
      } else if (cfg.compose) {
        out.set(key, { key, profile: await composeOf(cfg.compose, intents, decompose), companions });
      }
    } catch (err) {
      throw new Error(`rag.profiles.${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** D23: small-set-jev reranks the WHOLE set — its pool must hold every tool listed. */
export function assertSmallSetPool(
  p: ResolvedToolsProfile | undefined,
  status: ToolCatalogStatus | undefined,
): void {
  if (p?.poolItems === undefined || !status) return;
  if (status.total > p.poolItems) {
    throw new Error(
      `rag.profiles.${p.key}: small-set-jev reranks the whole set, but smallSet.poolItems (${p.poolItems}) is below the ${status.total} tools listed — set poolItems ≥ ${status.total}`,
    );
  }
}
```

`smart-server.ts` `SmartServerConfig`, after `embedderFactories?`:
```ts
  /** Named tools profile compositions for `rag.profiles.<key>.variant` (merged over the built-ins). */
  toolsVariantFactories?: Readonly<Record<string, ToolsVariantFactory>>;
  /** Named strategies for `rag.profiles.<key>.compose` / `decomposer` (merged over the built-ins). */
  toolsStrategyFactories?: ToolsStrategyFactories;
```

Export from `src/index.ts`: `assertSmallSetPool`, `BUILT_IN_TOOLS_STRATEGIES`, `BUILT_IN_TOOLS_VARIANTS`, `resolveCollectionProfiles`, and types `ResolvedToolsProfile`, `ToolsStrategyFactories`, `ToolsVariantFactory`, `ToolsVariantInput`.

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): resolve rag.profiles names to strategy instances; small-set pool check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 23: SmartServer wiring — bind at creation, workers by key, startup check (server-libs)

Spec §6.1 (server binds, builder reuses), §6.2 (only `rag.profiles.tools`, S8; workers' tools stores get the main config's binding), §7.4 (D23).

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (field near `_retrievalStrategies` ~line 840; resolution after `resolvedEmbedder` ~line 1434; the `toolsRag` creation ~line 1550; the worker `makeToolsRag` ~line 2170; before `new HealthChecker(` ~line 1888)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts` (append tests; reuses its stub MCP server)

**Interfaces:**
- Consumes: `resolveCollectionProfiles`, `assertSmallSetPool`, `ResolvedToolsProfile` (Task 22); `bindToolsProfile` (`@mcp-abap-adt/llm-agent-libs`, Task 15); `toMakeRagInput` (`rag-config.ts`); `isToolCatalogReporter` (`@mcp-abap-adt/llm-agent`).
- Produces: `rag.profiles.tools` binds the server's tools store (main and every worker store) at creation; startup fails when `small-set-jev`'s `poolItems` < the listed tool count; a `SmartServerConfig` built in code with a `rag.profiles` key other than `tools` is refused at start too (S8 — such a config skips the YAML validator of Task 21, so the server checks again: never a silent drop).

- [ ] **Step 1: Write the failing tests (append to `mcp-yaml-vectorization.test.ts`)**

```ts
test('rag.profiles.tools: the server binds its tools store and fills it through the profile', async (t) => {
  const stub = await startStubOrSkip(t, ['EchoTool', 'GetTable']);
  if (!stub) return;
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      mode: 'smart',
      rag: { store: { type: 'in-memory' }, profiles: { tools: { variant: 'faceted' } } },
      mcp: { type: 'http', url: stub.url },
    },
    constructionSeams,
  );
  let handle: Awaited<ReturnType<SmartServer['start']>> | undefined;
  try {
    handle = await server.start();
    const toolsRag = (server as unknown as Internals)._toolsRag;
    assert.ok(toolsRag);
    assert.ok(toolsBindingOf(toolsRag), 'the tools store carries its binding');
    const full = await toolsRag.getById(recordId({ scope: 'global' }, 'tool:EchoTool', 'full', 0));
    assert.ok(full.ok && full.value, 'profile records are written under owner-scoped ids');
    const legacy = await toolsRag.getById('tool:EchoTool');
    assert.ok(legacy.ok && legacy.value === null, 'no 30.1.0 record under a profile');
  } finally {
    if (handle) await handle.close();
    await stub.close();
  }
});

test('rag.profiles.tools small-set-jev: poolItems below the tool count fails startup', async (t) => {
  const stub = await startStubOrSkip(t, ['EchoTool', 'GetTable']);
  if (!stub) return;
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      mode: 'smart',
      decision: { provider: 'typesafe' },
      rag: { store: { type: 'in-memory' }, profiles: { tools: { variant: 'small-set-jev', smallSet: { poolItems: 1 } } } },
      mcp: { type: 'http', url: stub.url },
    },
    {
      ...constructionSeams,
      makeDecisionModel: async () =>
        ({ decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) }) as never,
    },
  );
  try {
    await assert.rejects(server.start(), /smallSet\.poolItems \(1\) is below the 2 tools/);
  } finally {
    await stub.close();
  }
});

test('S8: a rag.profiles key other than tools in a config built in code is refused at start', async () => {
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      rag: { store: { type: 'in-memory' }, profiles: { 'tools-coarse': { variant: 'faceted' } } },
    },
    constructionSeams,
  );
  await assert.rejects(server.start(), /rag\.profiles\.tools-coarse/);
});
```
Add to the file's imports: `recordId` from `@mcp-abap-adt/llm-agent`, `toolsBindingOf` from `@mcp-abap-adt/llm-agent-libs`.

- [ ] **Step 2: Run to see them fail**

Run: `npx tsc -b packages/llm-agent-libs && node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts`
Expected: FAIL — the store carries no binding; startup does not refuse.

- [ ] **Step 3: Implement**

In `smart-server.ts`:
- imports: `bindToolsProfile` from `@mcp-abap-adt/llm-agent-libs`; `isToolCatalogReporter` from `@mcp-abap-adt/llm-agent` (if not already imported); `assertSmallSetPool`, `type ResolvedToolsProfile`, `resolveCollectionProfiles` from `./resolve-collection-profiles.js`.
- field, after `private _retrievalStrategies …`:
  ```ts
  /** `rag.profiles`, resolved once, server-wide (spec §6.2). */
  private _toolsProfiles: Map<string, ResolvedToolsProfile> = new Map();
  ```
- right after `const resolvedEmbedder = await resolveRetrievalEmbedder(…);` (~line 1434):
  ```ts
    // ---- Collection profiles (spec §6.2) ---------------------------------
    // Resolved ONCE, server-wide, after the embedder: a companion store is
    // built through makeRag with the primary's embedder, and a decomposer
    // gets the store's query embedder.
    this._toolsProfiles = await resolveCollectionProfiles({
      profiles: this.cfg.rag?.profiles,
      decisionCfg: this.cfg.decision,
      makeDecisionModel: this._deps.makeDecisionModel,
      resolveLlm: (key) => this.roleLlm().resolveNamed(key),
      queryEmbedder: resolvedEmbedder,
      makeCompanionStore: async (store) =>
        this._deps.makeRag(toMakeRagInput(store, resolvedEmbedder, 'rag.profiles companion')),
      variantFactories: this.cfg.toolsVariantFactories,
      strategyFactories: this.cfg.toolsStrategyFactories,
    });
    // S8 (spec §6.2): only the server's own `tools` store is bound from config.
    // The YAML validator refuses other keys; a config built in code skips it,
    // so refuse here too — never a silent drop.
    for (const key of this._toolsProfiles.keys()) {
      if (key !== 'tools') {
        throw new Error(
          `rag.profiles.${key}: the server binds profiles only to its own tools store; bind other stores in your composition root (builder.withRetrievalStrategy(key, bound.retrieval))`,
        );
      }
    }
  ```
- add the method next to `withStrategy`:
  ```ts
  /**
   * The server-built tools store (main or worker) bound to `rag.profiles.tools`
   * when configured — a store per binding, one profile (goal 6) — else wrapped
   * in its `rag.retrieval` strategy as in 30.1.0. The builder reuses the binding.
   */
  private withToolsStore(store: IRag): IRag {
    const p = this._toolsProfiles.get('tools');
    if (p?.profile) {
      return bindToolsProfile(p.profile, { key: 'tools', rag: store, companions: p.companions }).rag;
    }
    return this.withStrategy('tools', store);
  }
  ```
- replace `toolsRag = this.withStrategy('tools', await this._deps.makeRag(input));` with `toolsRag = this.withToolsStore(await this._deps.makeRag(input));`
- in the worker `makeToolsRag` closure, replace `this.withStrategy(\n'tools',\n await this._deps.makeRag(…))` with `this.withToolsStore(await this._deps.makeRag(…))` (same inner `makeRag(...)` argument).
- immediately before `const healthChecker = new HealthChecker({`:
  ```ts
    // D23: small-set-jev reranks the whole set — refuse to serve when its pool is smaller.
    assertSmallSetPool(
      this._toolsProfiles.get('tools'),
      isToolCatalogReporter(smartAgent) ? smartAgent.getToolCatalogStatus() : undefined,
    );
  ```

- [ ] **Step 4: Run (new + existing server tests)**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-wiring.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-server-libs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): SmartServer binds rag.profiles.tools at store creation; small-set startup check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 24: Composition root — the `sap-aicore` arm of `createMakeDecisionModel` (server)

Spec §5.2 (credential injected; the AI Core token exchange reused), §5.3 (batches → `/rerank` calls), §6.2 (`decision.provider: sap-aicore`, default ref `DECISION` → `DECISION_SERVICE_KEY`), §11. **No new seam:** the existing `BuildAgentDeps.makeDecisionModel` builds the Cohere model too.

**Files:**
- Modify: `packages/llm-agent-server/src/composition/make-decision-model.ts` (`DecisionProviderCtors`, `SHIPPED_DECISION_PROVIDERS`, the `sap-aicore` arm)
- Create: `packages/llm-agent-server/src/composition/__tests__/make-decision-model-sap-aicore.test.ts`

**Interfaces:**
- Consumes: `SapAiCoreDecisionModel`, `SapAiCoreDecisionConfig` (Task 18); `SmartServerDecisionConfig` with `provider: 'sap-aicore'`, `deploymentId`, `resourceGroup` (Task 21); `Lookup` (`lookup.ts`: `require('bearer')`, `requireApiBaseUrl()`); `DEFAULT_DECISION_REF` and `envCredentialEntries` (`credential-for.ts`: `<REF>_SERVICE_KEY` → `serviceKeyCredential` from `@mcp-abap-adt/sap-aicore-auth` → bearer + `apiBaseUrl` — already a dependency of the server); `DecisionReranker`, `TOOL_QUESTION` (`@mcp-abap-adt/llm-agent-libs`, for the batching test).
- Produces:
  ```ts
  export interface DecisionProviderCtors {
    typesafe: new (cfg: TypeSafeDecisionConfig) => IDecisionModel;
    'sap-aicore': new (cfg: SapAiCoreDecisionConfig) => IDecisionModel;
  }
  export const SHIPPED_DECISION_PROVIDERS: DecisionProviderCtors; // + 'sap-aicore': SapAiCoreDecisionModel
  // createMakeDecisionModel(lookup, ctors?) — unchanged signature; new arm:
  //   'sap-aicore' → lookup(cfg.credentialRef, DEFAULT_DECISION_REF, 'decision sap-aicore')
  //                  .require('bearer') + .requireApiBaseUrl(); deploymentId, model, resourceGroup? by name
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server/src/composition/__tests__/make-decision-model-sap-aicore.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { type RagResult, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker, TOOL_QUESTION } from '@mcp-abap-adt/llm-agent-libs';
import { SapAiCoreDecisionModel } from '@mcp-abap-adt/sap-aicore-decision';
import {
  type CredentialEntry,
  envCredentialEntries,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';
import {
  createMakeDecisionModel,
  type DecisionProviderCtors,
  SHIPPED_DECISION_PROVIDERS,
} from '../make-decision-model.js';

const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };

function harness(entries: Record<string, CredentialEntry>) {
  const seen: Array<Record<string, unknown>> = [];
  const record = class {
    constructor(cfg: Record<string, unknown>) {
      seen.push(cfg);
    }
    async decide() {
      return { ok: true, value: { model: 'f', answers: {} } };
    }
  };
  const ctors = { typesafe: record, 'sap-aicore': record } as unknown as DecisionProviderCtors;
  return { seen, make: createMakeDecisionModel(createLookup(memoizeCredentials((r) => entries[r])), ctors) };
}

describe('makeDecisionModel — provider sap-aicore (Cohere, spec §5.2, §6.2)', () => {
  it('the shipped providers include SapAiCoreDecisionModel', () => {
    assert.equal(SHIPPED_DECISION_PROVIDERS['sap-aicore'], SapAiCoreDecisionModel);
  });
  it('default ref DECISION: bearer + apiBaseUrl from the service-key entry; named fields only', async () => {
    const { seen, make } = harness({ DECISION: { credential: bearer, apiBaseUrl: 'https://api' } });
    await make({ provider: 'sap-aicore', deploymentId: 'd1', model: 'cohere-rerank' });
    assert.deepEqual(seen[0], { deploymentId: 'd1', model: 'cohere-rerank', apiBaseUrl: 'https://api', credential: bearer });
  });
  it('a named ref; resourceGroup only when set; credentialRef and provider never reach the provider', async () => {
    const { seen, make } = harness({ AICORE: { credential: bearer, apiBaseUrl: 'https://api' } });
    await make({ provider: 'sap-aicore', deploymentId: 'd1', model: 'm', credentialRef: 'AICORE', resourceGroup: 'rg' });
    assert.equal(seen[0].resourceGroup, 'rg');
    assert.equal('credentialRef' in seen[0], false);
    assert.equal('provider' in seen[0], false);
  });
  it('an api-key entry or a named ref without an entry is refused', async () => {
    await assert.rejects(
      harness({ DECISION: { credential: staticApiKey('k') } }).make({ provider: 'sap-aicore', deploymentId: 'd', model: 'm' }),
      /must hold a bearer credential/,
    );
    await assert.rejects(
      harness({}).make({ provider: 'sap-aicore', deploymentId: 'd', model: 'm', credentialRef: 'NOPE' }),
      /credentialRef 'NOPE'/,
    );
  });
  it('a config built in code without deploymentId or model fails loudly', async () => {
    const { make } = harness({ DECISION: { credential: bearer, apiBaseUrl: 'https://api' } });
    await assert.rejects(make({ provider: 'sap-aicore', model: 'm' }), /decision sap-aicore needs deploymentId and model/);
  });
  it('DECISION_SERVICE_KEY through the shipped env rule builds a SapAiCoreDecisionModel (token exchange reused)', async () => {
    const key = JSON.stringify({ clientid: 'c', clientsecret: 's', url: 'https://auth.example', serviceurls: { AI_API_URL: 'https://api.example/' } });
    const lookup = createLookup(memoizeCredentials(envCredentialEntries({ DECISION_SERVICE_KEY: key })));
    const model = await createMakeDecisionModel(lookup)({ provider: 'sap-aicore', deploymentId: 'd1', model: 'cohere-rerank' });
    assert.ok(model instanceof SapAiCoreDecisionModel);
  });
});

describe('DecisionReranker over SapAiCoreDecisionModel — batches → /rerank calls (spec §5.3)', () => {
  const docs = (n: number): RagResult[] =>
    Array.from({ length: n }, (_, i) => ({ text: `tool ${i} ${'x'.repeat(40)}`, metadata: { id: `t${i}` }, score: 0 }));
  function cohere() {
    const calls: number[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { documents: string[] };
      calls.push(body.documents.length);
      // relevance = the tool number / 100, so the merged order is known
      const results = body.documents.map((d, index) => ({ index, relevance_score: Number(d.split(' ')[1]) / 100 }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    };
    return { calls, model: new SapAiCoreDecisionModel({ deploymentId: 'd', model: 'm', apiBaseUrl: 'https://api', credential: bearer, fetch }) };
  }
  const tool = { task: TOOL_QUESTION.task, criteria: TOOL_QUESTION.criteria };

  it('the default budget sends 30 tools in ONE call', async () => {
    const { calls, model } = cohere();
    const r = await new DecisionReranker(model, tool).rerank('q', docs(30));
    assert.ok(r.ok);
    assert.deepEqual(calls, [30]);
  });
  it('a small maxBatchTokens splits into several calls; the scores merge into one order', async () => {
    const { calls, model } = cohere();
    const r = await new DecisionReranker(model, { ...tool, maxBatchTokens: 200 }).rerank('q', docs(10));
    assert.ok(r.ok);
    assert.ok(calls.length > 1, `expected several calls, got ${calls.length}`);
    assert.equal(calls.reduce((a, b) => a + b, 0), 10);
    assert.deepEqual(r.value.map((x) => x.metadata.id), ['t9', 't8', 't7', 't6', 't5', 't4', 't3', 't2', 't1', 't0']);
  });
  it('a bad /rerank answer is a DecisionError, which DecisionReranker turns into RERANK_ERROR', async () => {
    const fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const model = new SapAiCoreDecisionModel({ deploymentId: 'd', model: 'm', apiBaseUrl: 'https://api', credential: bearer, fetch });
    const r = await new DecisionReranker(model, tool).rerank('q', docs(2));
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx tsc -b packages/sap-aicore-decision packages/llm-agent-libs packages/llm-agent-server-libs && node --import tsx/esm --test packages/llm-agent-server/src/composition/__tests__/make-decision-model-sap-aicore.test.ts`
Expected: FAIL — `SHIPPED_DECISION_PROVIDERS['sap-aicore']` is undefined; `unknown decision provider 'sap-aicore'`. (The batching cases pass already: they exercise Task 18's model through the unchanged `DecisionReranker`.)

- [ ] **Step 3: Implement**

In `make-decision-model.ts`:
```ts
import type { IDecisionModel } from '@mcp-abap-adt/llm-agent';
import type { SmartServerDecisionConfig } from '@mcp-abap-adt/llm-agent-server-libs';
import {
  type SapAiCoreDecisionConfig,
  SapAiCoreDecisionModel,
} from '@mcp-abap-adt/sap-aicore-decision';
import {
  type TypeSafeDecisionConfig,
  TypeSafeDecisionModel,
} from '@mcp-abap-adt/typesafe-decision';
import { DEFAULT_DECISION_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

/** Injectable so a test records what each constructor receives. */
export interface DecisionProviderCtors {
  typesafe: new (cfg: TypeSafeDecisionConfig) => IDecisionModel;
  'sap-aicore': new (cfg: SapAiCoreDecisionConfig) => IDecisionModel;
}

export const SHIPPED_DECISION_PROVIDERS: DecisionProviderCtors = {
  typesafe: TypeSafeDecisionModel,
  'sap-aicore': SapAiCoreDecisionModel,
};
```
and, in `createMakeDecisionModel`'s `switch`, before `default:`:
```ts
      case 'sap-aicore': {
        // The validator requires both; a SmartServerConfig built in code skips it.
        if (cfg.deploymentId === undefined || cfg.model === undefined) {
          throw new Error('decision sap-aicore needs deploymentId and model');
        }
        // A SAP AI Core service key (<REF>_SERVICE_KEY): bearer + apiBaseUrl,
        // exchanged by sap-aicore-auth's serviceKeyCredential (credential-for.ts).
        const entry = lookup(
          cfg.credentialRef,
          DEFAULT_DECISION_REF,
          'decision sap-aicore',
        );
        return new ctors['sap-aicore']({
          deploymentId: cfg.deploymentId,
          model: cfg.model,
          credential: entry.require('bearer'),
          apiBaseUrl: entry.requireApiBaseUrl(),
          ...(cfg.resourceGroup !== undefined
            ? { resourceGroup: cfg.resourceGroup }
            : {}),
        });
      }
```
(The `typesafe` arm is unchanged. `composition/index.ts` needs no change: `makeDecisionModel: createMakeDecisionModel(lookup)` already serves both providers.)

- [ ] **Step 4: Run**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-server/src/composition/__tests__/make-decision-model-sap-aicore.test.ts packages/llm-agent-server/src/composition/__tests__/make-decision-model.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-server
```
Expected: PASS (the existing typesafe tests unchanged).

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server/src
git add packages/llm-agent-server/src
git commit -m "feat(server): makeDecisionModel builds SapAiCoreDecisionModel for decision.provider sap-aicore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 25: F1 — the store's embedder through `IRetrievalEmbedderOwner` (providers + libs)

Spec §10.1; D8. Removes the `(toolsRag as any).embedder` cast.

**Files:**
- Modify: `packages/qdrant-rag/src/qdrant-rag.ts`, `packages/pg-vector-rag/src/pg-vector-rag.ts`, `packages/hana-vector-rag/src/hana-vector-rag.ts` (implement the capability)
- Modify: `packages/qdrant-rag/src/qdrant-rag.test.ts`, `packages/pg-vector-rag/src/__tests__/pg-vector-rag.test.ts`, `packages/hana-vector-rag/src/__tests__/hana-vector-rag.test.ts` (append one test each)
- Modify: `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts:168-171`
- Create: `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-f1.test.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts` (append the server-level regression)

**Interfaces:**
- Consumes: `IRetrievalEmbedderOwner`, `retrievalEmbedderOf` (Task 4).
- Produces: `QdrantRag`, `PgVectorRag`, `HanaVectorRag` each `implements IRag, IRetrievalEmbedderOwner` with `get retrievalEmbedder(): IRetrievalEmbedder`; `vectorizeMcpTools` finds the embedder behind `StrategyRag` / `FallbackRag`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-f1.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  type IEmbedder,
  type IMcpClient,
  InMemoryRag,
  type IRag,
  type McpTool,
  symmetricEmbedder,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../mcp/vectorize-mcp-tools.js';
import { EmbeddingRetrieval, StrategyRag } from '../retrieval/index.js';

const TOOLS: McpTool[] = ['a_tool', 'b_tool', 'c_tool'].map((name) => ({ name, description: `does ${name}`, inputSchema: {} }));
const client = { listTools: async () => ({ ok: true, value: TOOLS }), callTool: async () => ({ ok: true, value: { content: [] } }) } as unknown as IMcpClient;
function batching() {
  const batches: number[] = [];
  const singles = { n: 0 };
  const embedder: IEmbedder & { embedBatch(t: string[]): Promise<{ vector: number[] }[]> } = {
    embed: async () => {
      singles.n++;
      return { vector: [1, 0] };
    },
    embedBatch: async (texts: string[]) => {
      batches.push(texts.length);
      return texts.map(() => ({ vector: [1, 0] }));
    },
  };
  return { rag: new VectorRag(symmetricEmbedder(embedder)), batches, singles };
}

describe('F1: vectorizeMcpTools finds the store embedder behind decorators', () => {
  const wrappers: Array<[string, (inner: IRag) => IRag]> = [
    ['StrategyRag', (inner) => new StrategyRag(inner, new EmbeddingRetrieval())],
    ['FallbackRag', (inner) => new FallbackRag(inner, new InMemoryRag(), new CircuitBreaker({ failureThreshold: 1 }))],
  ];
  for (const [label, wrap] of wrappers) {
    it(`through ${label}: one batch, no per-tool embedding`, async () => {
      const { rag, batches, singles } = batching();
      const s = await vectorizeMcpTools([client], wrap(rag), new NoopRequestLogger(), undefined);
      assert.equal(s?.vectorized, 3);
      assert.deepEqual(batches, [3]);
      assert.equal(singles.n, 0);
    });
  }
});
```

Append to `packages/qdrant-rag/src/qdrant-rag.test.ts` (uses the file's `makeEmbedder`):
```ts
describe('QdrantRag — IRetrievalEmbedderOwner (F1)', () => {
  it('exposes the embedder it writes with', () => {
    const embedder = symmetricEmbedder(makeEmbedder());
    const rag = new QdrantRag({ url: 'http://127.0.0.1:1', collectionName: 'c', embedder });
    assert.equal(retrievalEmbedderOf(rag), embedder);
  });
});
```
Append to `packages/pg-vector-rag/src/__tests__/pg-vector-rag.test.ts` (uses `makeFakeClient`, `makeEmbedder`):
```ts
describe('PgVectorRag — IRetrievalEmbedderOwner (F1)', () => {
  it('exposes the embedder it writes with', () => {
    const embedder = symmetricEmbedder(makeEmbedder(3));
    const rag = new PgVectorRag({ collectionName: 'docs', dimension: 3, embedder }, makeFakeClient());
    assert.equal(retrievalEmbedderOf(rag), embedder);
  });
});
```
Append to `packages/hana-vector-rag/src/__tests__/hana-vector-rag.test.ts`:
```ts
describe('HanaVectorRag — IRetrievalEmbedderOwner (F1)', () => {
  it('exposes the embedder it writes with', () => {
    const embedder = symmetricEmbedder(makeEmbedder(3));
    const rag = new HanaVectorRag(
      { collectionName: 'docs', dimension: 3, embedder, credential: staticLogin('u', 'p') },
      makeFakeClient(),
    );
    assert.equal(retrievalEmbedderOf(rag), embedder);
  });
});
```
(Add `retrievalEmbedderOf` to each file's `@mcp-abap-adt/llm-agent` import. Check each constructor's second argument against the file's existing tests — Qdrant takes only the config.)

Append the server-level regression to `mcp-yaml-vectorization.test.ts`:
```ts
test('F1: with rag.retrieval.tools the server still embeds the catalog in batches', async (t) => {
  const stub = await startStubOrSkip(t, ['EchoTool', 'GetTable', 'ListRows']);
  if (!stub) return;
  const batches: number[] = [];
  const singles = { n: 0 };
  const embedder = {
    embed: async () => {
      singles.n++;
      return { vector: [1, 0] };
    },
    embedBatch: async (texts: string[]) => {
      batches.push(texts.length);
      return texts.map(() => ({ vector: [1, 0] }));
    },
  };
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      mode: 'smart',
      decision: { provider: 'typesafe' },
      rag: { store: { type: 'in-memory' }, retrieval: { tools: { strategy: 'rerank', reranker: 'decision' } } },
      mcp: { type: 'http', url: stub.url },
    },
    {
      ...constructionSeams,
      embedder,
      makeDecisionModel: async () =>
        ({ decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) }) as never,
    },
  );
  let handle: Awaited<ReturnType<SmartServer['start']>> | undefined;
  try {
    handle = await server.start();
    assert.deepEqual(batches, [3], 'one batch for the whole catalog');
  } finally {
    if (handle) await handle.close();
    await stub.close();
  }
});
```
(The `embedder` DI makes the in-memory store a `VectorRag` through the seams; if the seam only builds a `VectorRag` from `rag.embedder`, set that section instead and keep the assertion. `singles.n` may count health or query embeddings after start, so only `batches` is asserted.)

- [ ] **Step 2: Run to see them fail**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-f1.test.ts
npm test --workspace @mcp-abap-adt/qdrant-rag --workspace @mcp-abap-adt/pg-vector-rag --workspace @mcp-abap-adt/hana-vector-rag
```
Expected: FAIL — `batches` empty (sequential fallback), and the providers return `undefined`.

- [ ] **Step 3: Implement**

In each of `qdrant-rag.ts`, `pg-vector-rag.ts`, `hana-vector-rag.ts`: add `type IRetrievalEmbedderOwner` to the `@mcp-abap-adt/llm-agent` type import, change `implements IRag` to `implements IRag, IRetrievalEmbedderOwner`, and add after the constructor:
```ts
  /** IRetrievalEmbedderOwner: the embedder this store writes and searches with (F1). */
  get retrievalEmbedder(): IRetrievalEmbedder {
    return this.embedder;
  }
```

In `vectorize-mcp-tools.ts` replace
```ts
  // biome-ignore lint/suspicious/noExplicitAny: reading the store's private embedder for batch optimisation
  const storeEmbedder = (toolsRag as any).embedder as
    | IRetrievalEmbedder
    | undefined;
```
with
```ts
  // The store's own embedder, found through decorators (StrategyRag, FallbackRag) — F1.
  const storeEmbedder = retrievalEmbedderOf(toolsRag);
```
add `retrievalEmbedderOf` to the value import from `@mcp-abap-adt/llm-agent`, and drop the now-unused `IRetrievalEmbedder` type import.

- [ ] **Step 4: Run (F1 + golden + provider + server suites)**

Run:
```bash
npx tsc -b packages/qdrant-rag packages/pg-vector-rag packages/hana-vector-rag packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-f1.test.ts packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts
npm test --workspace @mcp-abap-adt/qdrant-rag --workspace @mcp-abap-adt/pg-vector-rag --workspace @mcp-abap-adt/hana-vector-rag
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/qdrant-rag packages/pg-vector-rag packages/hana-vector-rag packages/llm-agent-libs/src packages/llm-agent-server-libs/src
git add packages/qdrant-rag packages/pg-vector-rag packages/hana-vector-rag packages/llm-agent-libs/src packages/llm-agent-server-libs/src
git commit -m "fix: vectorizeMcpTools finds the store embedder behind StrategyRag/FallbackRag (F1)

Stores declare IRetrievalEmbedderOwner; the any-cast read of a private field is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 26: F2, F3 — de-duplication in `tools-rag-handle` and `skill-select`

Spec §10.2.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/tools-rag-handle.ts:66-73`
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-handle-dedupe.test.ts`
- Modify: `packages/llm-agent/src/interfaces/tool-record-key.ts` (add `skillNameFromRecord`), `packages/llm-agent/src/interfaces/index.ts`
- Modify: `packages/llm-agent/src/interfaces/tool-record-key.test.ts` (append)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/skill-select.ts:33-38` and the fallback loop below it

**Interfaces:**
- Produces: `export function skillNameFromRecord(meta: { id?: unknown; name?: unknown }): string | undefined;` — `metadata.name` first, else the id without `skill:` and without a `:…` / `#…` suffix; `undefined` for a non-skill record.

- [ ] **Step 1: Write the failing tests**

Append to `packages/llm-agent/src/interfaces/tool-record-key.test.ts`:
```ts
import { skillNameFromRecord } from './tool-record-key.js';

describe('skillNameFromRecord (F3)', () => {
  it('metadata.name first', () => {
    assert.equal(skillNameFromRecord({ id: 'skill:deploy:extra', name: 'deploy' }), 'deploy');
  });
  it('else the id without skill: and without a :… or #… suffix', () => {
    assert.equal(skillNameFromRecord({ id: 'skill:deploy' }), 'deploy');
    assert.equal(skillNameFromRecord({ id: 'skill:deploy:v2' }), 'deploy');
    assert.equal(skillNameFromRecord({ id: 'skill:deploy#summary:0' }), 'deploy');
  });
  it('a non-skill record → undefined', () => {
    assert.equal(skillNameFromRecord({ id: 'tool:x', name: 'x' }), undefined);
    assert.equal(skillNameFromRecord({}), undefined);
  });
});
```
(Merge the import into the file's existing imports; reuse its `assert` / `describe` imports.)

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-handle-dedupe.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IRag, LlmTool, RagResult } from '@mcp-abap-adt/llm-agent';
import { makeToolsRagHandle } from '../tools-rag-handle.js';

const tool = (name: string): LlmTool => ({ name, description: name, inputSchema: {} });
const hit = (id: string, name?: string): RagResult => ({ text: id, metadata: { id, ...(name ? { name } : {}) }, score: 1 });

describe('F2: tools-rag-handle de-duplicates by tool name', () => {
  it('a tool with two hits is returned once, order preserved', async () => {
    const rag: IRag = {
      query: async () => ({ ok: true, value: [hit('tool:a', 'a'), hit('tool:b', 'b'), hit('tool:a:x', 'a')] }),
      healthCheck: async () => ({ ok: true, value: undefined }),
      getById: async () => ({ ok: true, value: null }),
    };
    const handle = await makeToolsRagHandle([], rag, { embedQuery: async () => ({ vector: [1] }) }, undefined, {
      namespacedTools: [tool('a'), tool('b')],
    });
    const r = await handle.query('q', 5);
    assert.deepEqual(r.map((t) => t.name), ['a', 'b']);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run:
```bash
node --import tsx/esm --test packages/llm-agent/src/interfaces/tool-record-key.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-handle-dedupe.test.ts
```
Expected: FAIL — `skillNameFromRecord` not exported; `['a', 'b', 'a']`.

- [ ] **Step 3: Implement**

`tool-record-key.ts`, after `toolNameFromRecord`:
```ts
/**
 * Recover a skill's name from a stored record (F3). `metadata.name` (written by
 * vectorizeSkills) first; else the id without `skill:` and without a `:…` /
 * `#…` suffix. Undefined for a record that is not a skill.
 */
export function skillNameFromRecord(meta: {
  id?: unknown;
  name?: unknown;
}): string | undefined {
  const id = meta?.id;
  if (typeof id !== 'string' || !id.startsWith('skill:')) return undefined;
  if (typeof meta.name === 'string' && meta.name.length > 0) return meta.name;
  return id.slice(6).replace(/[:#].*$/, '');
}
```
Export it in `interfaces/index.ts` next to `toolNameFromRecord`.

`tools-rag-handle.ts`, the hits loop:
```ts
          const hits: LlmTool[] = [];
          const seen = new Set<string>();
          for (const r of ragResult.value) {
            const name = toolNameFromRecord(r.metadata);
            if (name === undefined || seen.has(name)) continue;
            const tool = catalog.get(name);
            if (tool) {
              seen.add(name);
              hits.push(tool);
            }
          }
```

`skill-select.ts`: import `skillNameFromRecord` from `@mcp-abap-adt/llm-agent`; replace the `ragSkillNames` initialiser with
```ts
    const ragSkillNames = new Set(
      allRagResults
        .map((r) => skillNameFromRecord(r.metadata))
        .filter((n): n is string => n !== undefined),
    );
```
and in the fallback loop replace the `id.startsWith('skill:')` block with
```ts
            const name = skillNameFromRecord(r.metadata);
            if (name !== undefined) ragSkillNames.add(name);
```

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent
node --import tsx/esm --test packages/llm-agent/src/interfaces/tool-record-key.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-handle-dedupe.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-libs --workspace @mcp-abap-adt/llm-agent-server-libs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent/src packages/llm-agent-libs/src packages/llm-agent-server-libs/src
git add packages/llm-agent/src packages/llm-agent-libs/src packages/llm-agent-server-libs/src
git commit -m "fix: de-duplicate tools by name in tools-rag-handle (F2) and skill names in skill-select (F3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 27: Delete the orphan `IToolIndexingStrategy`

Spec §10.3. Unexported and unwired; its docs are rewritten in Task 33.

**Files:**
- Delete: `packages/llm-agent/src/rag/tool-indexing-strategy.ts`

- [ ] **Step 1: Prove nothing imports it**

Run: `git grep -n "tool-indexing-strategy\|OriginalToolIndexing\|IntentToolIndexing\|SynonymToolIndexing\|IToolDescriptor\|IToolIndexEntry" -- packages`
Expected: hits only inside `packages/llm-agent/src/rag/tool-indexing-strategy.ts` itself.

- [ ] **Step 2: Delete and verify**

Run:
```bash
git rm packages/llm-agent/src/rag/tool-indexing-strategy.ts
npx tsc -b packages/llm-agent && npm test --workspace @mcp-abap-adt/llm-agent
git grep -n "IToolIndexingStrategy" -- packages
```
Expected: build and tests pass; the last grep prints nothing.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(llm-agent)!: delete the unexported, unwired IToolIndexingStrategy

Replaced by collection profiles: OriginalToolIndexing → FacetedToolIndexer's full record;
IntentToolIndexing → IntentRecordIndexer / IntentCompanionIndexer; SynonymToolIndexing is
not ported (its verb synonyms are words the provider did not write).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

(The `!` marks the removal for readers; it removes nothing a consumer could import — the release stays a minor, spec §13.)

---

## Task 28: Observability — `IRetrievalMetrics` in the metrics, `StagedRetrieval` span and counter

Spec §9.1, §9.3; §4.5 (`decompose_error`), §4.6 (`orphan`), §4.10 (`over_budget`, `cut.tokens` / `cut.budgetTokens` through `ISizeBoundedCut`, S6).

**Files:**
- Modify: `packages/llm-agent-libs/src/metrics/in-memory-metrics.ts`, `packages/llm-agent-libs/src/metrics/noop-metrics.ts`
- Modify: `packages/llm-agent-libs/src/collections/staged-retrieval.ts` (`retrieve` → telemetry wrapper + `run`)
- Create: `packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-telemetry.test.ts`

**Interfaces:**
- Consumes: `IRetrievalMetrics`, `isRetrievalMetrics`, `isSizeBoundedCut` (Task 3); `TokenBudgetCut` (Task 6, an `ISizeBoundedCut`); `ITracer`, `ISpan`; Tasks 12–14.
- Produces: `InMemoryMetrics` and `NoopMetrics` `implements IMetrics, IRetrievalMetrics` (`retrievalOutcome`); `InMemoryMetrics.snapshot().retrievalOutcome`. One `retrievalOutcome` count per retrieval — `ok` | `rerank_fallback` | `rerank_error` | `decompose_error` | `over_budget` | `empty` — plus `orphan` counted by the number of orphans. Span `retrieval` with `store`, `strategy`, `sources`, `candidates.records`, `items.collapsed`, `items.returned`, `decomposer`, `subqueries`, `rerank.outcome`, `rerank.error`, `orphans`, `hydration.reads`, `cut.name`, and for a cut with `ISizeBoundedCut` also `cut.tokens` / `cut.budgetTokens`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-telemetry.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InMemoryRag,
  type IRag,
  type IReranker,
  isRetrievalMetrics,
  type ITracer,
  RagError,
  recordId,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryMetrics } from '../../metrics/in-memory-metrics.js';
import { NoopMetrics } from '../../metrics/noop-metrics.js';
import { ItemPool, MaxScoreCollapse, StagedRetrieval, type StagedRetrievalOptions } from '../index.js';
import { G, matchesOnly, put, q } from './staged-retrieval-helpers.js';

function spyTracer() {
  const spans: Array<{ name: string; attrs: Record<string, unknown>; status?: string; ended: boolean }> = [];
  const tracer: ITracer = {
    startSpan(name, o) {
      const s = { name, attrs: { ...(o?.attributes ?? {}) } as Record<string, unknown>, status: undefined as string | undefined, ended: false };
      spans.push(s);
      return {
        name,
        setAttribute: (k, v) => { s.attrs[k] = v; },
        addEvent: () => {},
        setStatus: (st) => { s.status = st; },
        end: () => { s.ended = true; },
      };
    },
  };
  return { tracer, spans };
}
const outcomes = (m: InMemoryMetrics) => Object.fromEntries(m.snapshot().retrievalOutcome?.byAttributes ?? []);
function staged(rag: IRag, o: Partial<StagedRetrievalOptions>) {
  return new StagedRetrieval({
    name: 'test', storeKey: 'tools', pool: new ItemPool(10), maxRecordsPerItem: 3, canonicalKind: 'full',
    sources: { sources: async (options) => [{ name: 'primary', rag, role: 'items', options }] },
    collapse: new MaxScoreCollapse(), ...o,
  });
}
async function store() {
  const raw = new InMemoryRag();
  await put(raw, 'A', [['full', 'needle a']]);
  await put(raw, 'Y', [['full', 'yankee'], ['summary', 'needle y']]);
  await raw.writer().deleteByIdRaw(recordId(G, 'Y', 'full', 0));
  return matchesOnly(raw);
}
const key = (outcome: string) => `outcome=${outcome},store=tools,strategy=test`;

describe('StagedRetrieval telemetry', () => {
  it('the metrics implement IRetrievalMetrics', () => {
    assert.equal(isRetrievalMetrics(new InMemoryMetrics()), true);
    assert.equal(isRetrievalMetrics(new NoopMetrics()), true);
  });

  it('ok + orphans counted; the span carries the run', async () => {
    const metrics = new InMemoryMetrics();
    const { tracer, spans } = spyTracer();
    const rag = await store();
    await staged(rag, { telemetry: { tracer, metrics } }).retrieve(rag, q('needle'), 3);
    assert.deepEqual(outcomes(metrics), { [key('ok')]: 1, [key('orphan')]: 1 });
    const s = spans[0];
    assert.equal(s.name, 'retrieval');
    assert.equal(s.attrs.store, 'tools');
    assert.equal(s.attrs.strategy, 'test');
    assert.equal(s.attrs.sources, 'primary');
    assert.equal(s.attrs.orphans, 1);
    assert.equal(s.attrs['items.returned'], 1);
    assert.equal(s.attrs['hydration.reads'], 1);
    assert.equal(s.attrs['rerank.outcome'], 'none');
    assert.equal(s.attrs.decomposer, 'none');
    assert.equal(s.attrs['cut.name'], 'top-items');
    assert.equal(s.ended, true);
  });

  it('a wrong score count is counted rerank_fallback (stage1) or rerank_error (error) — never silent', async () => {
    const rag = await store();
    const dropping: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r.slice(1) }) };
    for (const [onFailure, outcome] of [['stage1', 'rerank_fallback'], ['error', 'rerank_error']] as const) {
      const metrics = new InMemoryMetrics();
      const { tracer, spans } = spyTracer();
      await staged(rag, { rerank: { reranker: dropping, onFailure }, telemetry: { tracer, metrics } }).retrieve(rag, q('needle'), 3);
      assert.equal(outcomes(metrics)[key(outcome)], 1);
      assert.match(String(spans[0].attrs['rerank.error']), /RERANK_ERROR/);
    }
  });

  it('decompose_error is counted and the span status is error', async () => {
    const rag = await store();
    const metrics = new InMemoryMetrics();
    const { tracer, spans } = spyTracer();
    const decomposer = { name: 'bad', decompose: async () => ({ ok: false as const, error: new RagError('no') }) };
    await staged(rag, { decompose: { decomposer, queryEmbedder: { embedQuery: async () => ({ vector: [1] }) } }, telemetry: { tracer, metrics } }).retrieve(rag, q('needle'), 3);
    assert.equal(outcomes(metrics)[key('decompose_error')], 1);
    assert.equal(spans[0].status, 'error');
    assert.equal(spans[0].attrs.decomposer, 'bad');
  });

  it('an empty result is counted empty', async () => {
    const metrics = new InMemoryMetrics();
    const rag = matchesOnly(new InMemoryRag());
    await staged(rag, { telemetry: { metrics } }).retrieve(rag, q('nothing'), 3);
    assert.deepEqual(outcomes(metrics), { [key('empty')]: 1 });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-telemetry.test.ts`
Expected: FAIL — `isRetrievalMetrics(new InMemoryMetrics())` is false.

- [ ] **Step 3: Implement — metrics**

`in-memory-metrics.ts`: import `type IRetrievalMetrics` from `@mcp-abap-adt/llm-agent`; `export class InMemoryMetrics implements IMetrics, IRetrievalMetrics {`; add `readonly retrievalOutcome = new MemCounter();` after `toolCacheHitCount`; add `retrievalOutcome: this.retrievalOutcome.snapshot(),` to `snapshot()`.

`noop-metrics.ts`: import `type IRetrievalMetrics` from `@mcp-abap-adt/llm-agent`; `export class NoopMetrics implements IMetrics, IRetrievalMetrics {`; add `readonly retrievalOutcome: ICounter = noopCounter;`.

- [ ] **Step 4: Implement — `StagedRetrieval` telemetry**

In `staged-retrieval.ts`, add `type ISpan` to the `@mcp-abap-adt/llm-agent` import, rename the Task 14 `retrieve` method to `private async run(query, k, callOptions, runs: RunStats[], info: { subqueries: number })`, and inside it replace each `newRunContext(callOptions)` with a context whose stats are collected:
```ts
    const ctx = () => {
      const c = newRunContext(callOptions);
      runs.push(c.stats);
      return c;
    };
```
(`this.runOne(query, budget, ctx())` and, per sub-query, `this.runOne(new QueryEmbedding(…), s.k, ctx())`; set `info.subqueries = subs.value.length` after a successful decomposition.) Then add:

```ts
  async retrieve(
    _store: IRag,
    query: IQueryEmbedding,
    k: number,
    callOptions?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const t = this.options.telemetry;
    const traceId = callOptions?.trace?.traceId;
    const span = t?.tracer?.startSpan('retrieval', {
      ...(traceId ? { traceId } : {}),
      attributes: { store: this.options.storeKey, strategy: this.name },
    });
    const runs: RunStats[] = [];
    const info = { subqueries: 0 };
    const result = await this.run(query, k, callOptions, runs, info);
    this.report(result, runs, info, span);
    return result;
  }

  /** One outcome per retrieval + orphans by count (spec §9.1); never a new logger. */
  private report(
    result: Result<RagResult[], RagError>,
    runs: readonly RunStats[],
    info: { subqueries: number },
    span: ISpan | undefined,
  ): void {
    const sum = (f: (s: RunStats) => number) => runs.reduce((a, s) => a + f(s), 0);
    const orphans = sum((s) => s.orphans);
    const all = runs.map((s) => s.rerankOutcome);
    const rerank = all.includes('error')
      ? 'error'
      : all.includes('fallback')
        ? 'fallback'
        : all.includes('ok')
          ? 'ok'
          : 'none';
    const rerankError = runs.find((s) => s.rerankError !== undefined)?.rerankError;
    const outcome = !result.ok && result.error.code === 'DECOMPOSE_ERROR'
      ? 'decompose_error'
      : rerank === 'error'
        ? 'rerank_error'
        : rerank === 'fallback'
          ? 'rerank_fallback'
          : result.ok && result.value.length === 0
            ? 'empty'
            : result.ok
              ? 'ok'
              : undefined;
    const metrics = this.options.telemetry?.metrics;
    const attrs = (o: string) => ({ store: this.options.storeKey, strategy: this.name, outcome: o });
    if (metrics) {
      if (outcome) metrics.retrievalOutcome.add(1, attrs(outcome));
      if (orphans > 0) metrics.retrievalOutcome.add(orphans, attrs('orphan'));
    }
    if (!span) return;
    span.setAttribute('sources', [...new Set(runs.flatMap((s) => s.sources))].join(','));
    span.setAttribute('candidates.records', sum((s) => s.candidateRecords));
    span.setAttribute('items.collapsed', sum((s) => s.collapsedItems));
    span.setAttribute('items.returned', result.ok ? result.value.length : 0);
    span.setAttribute('decomposer', this.options.decompose?.decomposer.name ?? 'none');
    span.setAttribute('subqueries', info.subqueries);
    span.setAttribute('rerank.outcome', rerank);
    if (rerankError !== undefined) span.setAttribute('rerank.error', rerankError);
    span.setAttribute('orphans', orphans);
    span.setAttribute('hydration.reads', sum((s) => s.hydrationReads));
    span.setAttribute('cut.name', this.cut.name);
    if (result.ok) span.setStatus('ok');
    else span.setStatus('error', result.error.message);
    span.end();
  }
```

- [ ] **Step 5: Run (telemetry + all StagedRetrieval + metrics tests)**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval*.test.ts packages/llm-agent-libs/src/metrics/__tests__/metrics.test.ts
```
Expected: PASS.

- [ ] **Step 6: `over_budget` and `cut.tokens` / `cut.budgetTokens` through `ISizeBoundedCut` (S6, spec §4.10)**

Append to `staged-retrieval-telemetry.test.ts` (add `CharsPerTokenEstimator`, `TokenBudgetCut` to the `../index.js` import):

```ts
describe('StagedRetrieval telemetry — size-bounded cuts (S6)', () => {
  const est = new CharsPerTokenEstimator(1); // the hydrated item 'needle a' = 8 tokens
  it('cut.tokens and cut.budgetTokens on the span', async () => {
    const rag = await store();
    const { tracer, spans } = spyTracer();
    await staged(rag, { cut: new TokenBudgetCut({ budgetTokens: 100, estimator: est }), telemetry: { tracer } }).retrieve(rag, q('needle'), 3);
    assert.equal(spans[0].attrs['cut.budgetTokens'], 100);
    assert.equal(spans[0].attrs['cut.tokens'], 8);
    assert.equal(spans[0].attrs['cut.name'], 'token-budget');
  });
  it('the top item alone over budget is counted over_budget, not empty', async () => {
    const rag = await store();
    const metrics = new InMemoryMetrics();
    const r = await staged(rag, { cut: new TokenBudgetCut({ budgetTokens: 3, estimator: est }), telemetry: { metrics } }).retrieve(rag, q('needle'), 3);
    assert.ok(r.ok && r.value.length === 0);
    assert.equal(outcomes(metrics)[key('over_budget')], 1);
    assert.equal(outcomes(metrics)[key('empty')], undefined);
  });
  it('a count cut carries no token attributes', async () => {
    const rag = await store();
    const { tracer, spans } = spyTracer();
    await staged(rag, { telemetry: { tracer } }).retrieve(rag, q('needle'), 3);
    assert.equal('cut.tokens' in spans[0].attrs, false);
  });
});
```

Run it: FAIL — no `cut.tokens`; the empty result is counted `empty`.

In `staged-retrieval.ts`: add `isSizeBoundedCut` to the `@mcp-abap-adt/llm-agent` import; widen `info` to `{ subqueries: number; firstRanked?: RagResult }` (in `retrieve`: `const info: { subqueries: number; firstRanked?: RagResult } = { subqueries: 0 };`, and the same type on `run` / `report`); in `run`, make `finish` record the first ranked, hydrated item before the cut:
```ts
    const finish = (items: RagResult[]): Result<RagResult[], RagError> => {
      info.firstRanked = items[0];
      return { ok: true, value: this.cut.cut(items, k).slice(0, budget) };
    };
```
In `report`, before computing `outcome`:
```ts
    // S6: a cut with ISizeBoundedCut tells the telemetry its budget and estimator.
    const sized = isSizeBoundedCut(this.cut) ? this.cut : undefined;
    const overBudget =
      sized !== undefined &&
      result.ok &&
      result.value.length === 0 &&
      info.firstRanked !== undefined &&
      sized.estimator.estimate(info.firstRanked) > sized.budgetTokens;
```
insert `: overBudget ? 'over_budget'` into the `outcome` chain right before the `empty` branch (`… : rerank === 'fallback' ? 'rerank_fallback' : overBudget ? 'over_budget' : result.ok && result.value.length === 0 ? 'empty' : …`), and after `span.setAttribute('cut.name', this.cut.name);`:
```ts
    if (sized) {
      span.setAttribute('cut.budgetTokens', sized.budgetTokens);
      span.setAttribute(
        'cut.tokens',
        result.ok ? result.value.reduce((a, it) => a + sized.estimator.estimate(it), 0) : 0,
      );
    }
```

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-telemetry.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): retrieval telemetry — IRetrievalMetrics counter, a retrieval span per StagedRetrieval, size-budget outcome

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 29: Observability — the 30.1.0 rerank strategies and `/health`

Spec §9.2 (additive `telemetry` option), §9.1 (`/health`: `toolCatalog.records` / `.profile`, `metrics.retrievalOutcome`).

**Files:**
- Modify: `packages/llm-agent-libs/src/retrieval/reranked-retrieval.ts`
- Create: `packages/llm-agent-libs/src/retrieval/__tests__/reranked-retrieval-telemetry.test.ts`
- Modify: `packages/llm-agent-libs/src/health/health-checker.ts`
- Create: `packages/llm-agent-libs/src/health/__tests__/health-tool-catalog-profile.test.ts`

**Interfaces:**
- Produces: `RerankedRetrieval(reranker, { overfetch?, storeName?, telemetry? })`, `RerankAllRetrieval(reranker, { maxCandidates, storeName?, telemetry? })`; a fallback counts `rerank_fallback`, a success `ok`; behaviour otherwise unchanged. **S4, decided (spec §9.2): telemetry only — the §4.8 output check is NOT applied here**, so a short reranker answer is accepted as in 30.1.0 (goal 4). `/health` copies `records` and `profile` (carried by `ToolCatalogStatus`, S3) into `components.toolCatalog` when present.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/llm-agent-libs/src/retrieval/__tests__/reranked-retrieval-telemetry.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type IRag, type IReranker, RagError, type RagResult, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { InMemoryMetrics } from '../../metrics/in-memory-metrics.js';
import { RerankAllRetrieval, RerankedRetrieval } from '../index.js';

const hits: RagResult[] = [{ text: 'a', metadata: { id: 'a' }, score: 0.9 }, { text: 'b', metadata: { id: 'b' }, score: 0.8 }];
const store: IRag = {
  query: async (_q, k) => ({ ok: true, value: hits.slice(0, k) }),
  healthCheck: async () => ({ ok: true, value: undefined }),
  getById: async () => ({ ok: true, value: null }),
};
const failing: IReranker = { rerank: async () => ({ ok: false, error: new RagError('down', 'RERANK_ERROR') }) };
const passing: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };
const outcomes = (m: InMemoryMetrics) => Object.fromEntries(m.snapshot().retrievalOutcome?.byAttributes ?? []);

describe('30.1.0 rerank strategies: optional telemetry (spec §9.2)', () => {
  it('a fallback is counted, not only a session step; results unchanged', async () => {
    const metrics = new InMemoryMetrics();
    const r = await new RerankedRetrieval(failing, { storeName: 'tools', telemetry: { metrics } }).retrieve(store, new TextOnlyEmbedding('q'), 2);
    assert.ok(r.ok && r.value.length === 2);
    assert.deepEqual(outcomes(metrics), { 'outcome=rerank_fallback,store=tools,strategy=rerank': 1 });
  });
  it('a success is counted ok (rerank-all)', async () => {
    const metrics = new InMemoryMetrics();
    await new RerankAllRetrieval(passing, { maxCandidates: 2, storeName: 'tools', telemetry: { metrics } }).retrieve(store, new TextOnlyEmbedding('q'), 1);
    assert.deepEqual(outcomes(metrics), { 'outcome=ok,store=tools,strategy=rerank-all': 1 });
  });
  it('without telemetry nothing changes', async () => {
    const r = await new RerankedRetrieval(failing).retrieve(store, new TextOnlyEmbedding('q'), 2);
    assert.ok(r.ok && r.value.length === 2);
  });
  it('S4: no output check — a short reranker answer is accepted as in 30.1.0, and counted ok', async () => {
    const metrics = new InMemoryMetrics();
    const short: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r.slice(0, 1) }) };
    const r = await new RerankedRetrieval(short, { storeName: 'tools', telemetry: { metrics } }).retrieve(store, new TextOnlyEmbedding('q'), 2);
    assert.ok(r.ok && r.value.length === 1);
    assert.deepEqual(outcomes(metrics), { 'outcome=ok,store=tools,strategy=rerank': 1 });
  });
});
```

```ts
// packages/llm-agent-libs/src/health/__tests__/health-tool-catalog-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../../agent.js';
import { ToolCatalogStatusHolder } from '../../mcp/tool-catalog-status.js';
import { InMemoryMetrics } from '../../metrics/in-memory-metrics.js';
import { makeDefaultDeps } from '../../testing/index.js';
import { HealthChecker } from '../health-checker.js';

const base = { total: 2, vectorized: 2, failed: [], clientFailures: 0, complete: true };
async function health(status: typeof base & { records?: number; profile?: string }) {
  const holder = new ToolCatalogStatusHolder();
  holder.publish(status);
  const { deps } = makeDefaultDeps();
  const agent = new SmartAgent({ ...deps, toolCatalogStatus: holder }, { maxIterations: 5 });
  const metrics = new InMemoryMetrics();
  metrics.retrievalOutcome.add(1, { store: 'tools', strategy: 'mcp-tools', outcome: 'ok' });
  return new HealthChecker({ agent, startTime: Date.now(), version: 'x', metrics }).check();
}

describe('/health — collection profiles', () => {
  it('toolCatalog carries records and profile under a profile', async () => {
    const h = await health({ ...base, records: 6, profile: 'mcp-tools' });
    assert.deepEqual(h.components.toolCatalog, { vectorized: 2, total: 2, complete: true, clientFailures: 0, records: 6, profile: 'mcp-tools' });
  });
  it('without a profile toolCatalog is as in 30.1.0', async () => {
    const h = await health(base);
    assert.deepEqual(Object.keys(h.components.toolCatalog ?? {}).sort(), ['clientFailures', 'complete', 'total', 'vectorized']);
  });
  it('metrics.retrievalOutcome is in the snapshot', async () => {
    const h = await health(base);
    assert.equal(h.metrics?.retrievalOutcome?.total, 1);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/retrieval/__tests__/reranked-retrieval-telemetry.test.ts packages/llm-agent-libs/src/health/__tests__/health-tool-catalog-profile.test.ts`
Expected: FAIL — no `retrievalOutcome` counts; no `records` / `profile` in `/health`.

- [ ] **Step 3: Implement**

`reranked-retrieval.ts`: add `type IRetrievalMetrics`, `type ITracer` to the import; define
```ts
type Telemetry = { tracer?: ITracer; metrics?: IRetrievalMetrics };
```
give `rerankOrFallback` a trailing `telemetry?: Telemetry` parameter and, at its two exits:
```ts
const count = (outcome: 'ok' | 'rerank_fallback', error?: string) => {
  telemetry?.metrics?.retrievalOutcome.add(1, { store: storeName ?? '', strategy: name, outcome });
  const span = telemetry?.tracer?.startSpan('retrieval', {
    ...(options?.trace?.traceId ? { traceId: options.trace.traceId } : {}),
    attributes: { store: storeName ?? '', strategy: name, 'rerank.outcome': outcome === 'ok' ? 'ok' : 'fallback' },
  });
  if (error !== undefined) span?.setAttribute('rerank.error', error);
  span?.setStatus('ok');
  span?.end();
};
```
calling `count('ok')` before the success `return`, and `count('rerank_fallback', \`${code}: ${message}\`)` before the fallback `return`. Extend both option types with `telemetry?: Telemetry` (`{ overfetch?: number; storeName?: string; telemetry?: Telemetry }` and `{ maxCandidates: number; storeName?: string; telemetry?: Telemetry }`) and pass `this.opts.telemetry` to `rerankOrFallback`.

`health-checker.ts`, in the `toolCatalog` object:
```ts
                clientFailures: tc.clientFailures,
                ...(tc.records !== undefined ? { records: tc.records } : {}),
                ...(tc.profile !== undefined ? { profile: tc.profile } : {}),
```

- [ ] **Step 4: Run (new + existing retrieval/health suites)**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/retrieval/__tests__/*.test.ts packages/llm-agent-libs/src/health/__tests__/*.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): telemetry option on the 30.1.0 rerank strategies; /health shows profile and records

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 30: Conformance kit `@mcp-abap-adt/llm-agent/testing/collection-profile-conformance`

Spec §14.2 (at most `cut.limit(k)` items — S9), §7.9 (a consumer-built profile passes the same kit).

**Files:**
- Create: `packages/llm-agent/src/testing/collection-profile-conformance.ts`
- Modify: `packages/llm-agent/package.json` (`exports`)
- Create: `packages/llm-agent-libs/src/collections/__tests__/collection-profile-conformance.test.ts`

**Interfaces:**
- Consumes: contracts of Tasks 2–3 only (the kit lives in the contracts package).
- Produces:
  ```ts
  export interface CollectionProfileHarness<TItem> {
    readonly name: string;
    /** A FRESH binding over empty stores; with `decomposer` / `cut` the retrieval must use them; undefined → that case is skipped. */
    bind(opts?: { decomposer?: IQueryDecomposer; cut?: IItemCut }): Promise<IBoundCollection<TItem> | undefined>;
    /** Index calls to make, each with its writer's options (two owners may reuse one itemId). */
    readonly writes: readonly { readonly items: readonly TItem[]; readonly options?: CallOptions }[];
    /** Every written item, and the options that may read it back with get(). */
    readonly refs: readonly { readonly ref: ItemRef; readonly options?: CallOptions }[];
    /** A reader and the refs it may see. */
    readonly reader: { readonly options?: CallOptions; readonly visible: readonly ItemRef[] };
    readonly query: IQueryEmbedding;
    /** The binding's raw stores, queried unfiltered with a large k to inspect records. */
    rawStores(bound: IBoundCollection<TItem>): readonly IRag[];
    /** The profile cut's limit for a caller's k (default: k) — the kit checks at most cut.limit(k) items (S9, decided). A FixedItemsCut owns k. */
    limit?(requestedK: number): number;
    readonly sizeBounded?: { readonly cut: IItemCut; readonly estimator: IItemSizeEstimator; readonly budgetTokens: number };
  }
  export interface CollectionProfileConformanceCase { readonly name: string; run<TItem>(h: CollectionProfileHarness<TItem>): Promise<void> }
  export const collectionProfileConformanceCases: readonly CollectionProfileConformanceCase[];
  ```

- [ ] **Step 1: Write the kit**

```ts
// packages/llm-agent/src/testing/collection-profile-conformance.ts
/**
 * Conformance kit for any ICollectionProfile (spec §14.2). Framework-agnostic:
 * each case throws (node:assert) on a violation. A consumer runs it against its
 * own profile:
 *
 *   for (const c of collectionProfileConformanceCases) it(c.name, () => c.run(myHarness));
 */
import assert from 'node:assert/strict';
import type {
  IBoundCollection,
  IItemCut,
  IItemSizeEstimator,
  IQueryDecomposer,
  ItemRef,
  RecordOwner,
} from '../interfaces/collection-profile.js';
import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IRag } from '../interfaces/rag.js';
import type { CallOptions, RagMetadata, RagResult } from '../interfaces/types.js';

export interface CollectionProfileHarness<TItem> {
  readonly name: string;
  bind(opts?: {
    decomposer?: IQueryDecomposer;
    cut?: IItemCut;
  }): Promise<IBoundCollection<TItem> | undefined>;
  readonly writes: readonly { readonly items: readonly TItem[]; readonly options?: CallOptions }[];
  readonly refs: readonly { readonly ref: ItemRef; readonly options?: CallOptions }[];
  readonly reader: { readonly options?: CallOptions; readonly visible: readonly ItemRef[] };
  readonly query: IQueryEmbedding;
  rawStores(bound: IBoundCollection<TItem>): readonly IRag[];
  /** The profile cut's limit for a caller's k (default: k). The kit checks at most
   *  cut.limit(k) items (spec §14.2, S9) — a FixedItemsCut owns k. */
  limit?(requestedK: number): number;
  readonly sizeBounded?: {
    readonly cut: IItemCut;
    readonly estimator: IItemSizeEstimator;
    readonly budgetTokens: number;
  };
}

export interface CollectionProfileConformanceCase {
  readonly name: string;
  run<TItem>(h: CollectionProfileHarness<TItem>): Promise<void>;
}

const OWNER_KEY: Record<string, string | undefined> = {
  global: undefined,
  group: 'groupId',
  user: 'userId',
  session: 'sessionId',
};

function ownerOf(meta: RagMetadata): RecordOwner | undefined {
  const v = meta.visibility;
  const k = (f: string) => (typeof meta[f] === 'string' ? String(meta[f]) : undefined);
  if (v === 'global') return { scope: 'global' };
  if (v === 'group' && k('groupId')) return { scope: 'group', groupId: String(k('groupId')) };
  if (v === 'user' && k('userId')) return { scope: 'user', userId: String(k('userId')) };
  if (v === 'session' && k('sessionId')) return { scope: 'session', sessionId: String(k('sessionId')) };
  return undefined;
}
const sameRef = (a: ItemRef, b: ItemRef) => JSON.stringify(a) === JSON.stringify(b);
const refOf = (r: RagResult): ItemRef | undefined => {
  const owner = ownerOf(r.metadata);
  return typeof r.metadata.itemId === 'string' && owner ? { itemId: r.metadata.itemId, owner } : undefined;
};

async function filled<TItem>(h: CollectionProfileHarness<TItem>, opts?: Parameters<CollectionProfileHarness<TItem>['bind']>[0]) {
  const bound = await h.bind(opts);
  if (!bound) return undefined;
  for (const w of h.writes) {
    const r = await bound.index(w.items, w.options);
    assert.ok(r.ok, `${h.name}: index failed`);
    assert.deepEqual(r.value.failedItems, [], `${h.name}: items failed to index`);
  }
  return bound;
}

async function rawRecords(stores: readonly IRag[], q: IQueryEmbedding): Promise<RagResult[]> {
  const out: RagResult[] = [];
  for (const s of stores) {
    const r = await s.query(q, 10_000);
    assert.ok(r.ok);
    out.push(...r.value);
  }
  return out;
}

export const collectionProfileConformanceCases: readonly CollectionProfileConformanceCase[] = [
  {
    name: 'every profile record carries owner keys and a visibility',
    async run(h) {
      const bound = await filled(h);
      assert.ok(bound);
      const recs = (await rawRecords(h.rawStores(bound), h.query)).filter((r) => typeof r.metadata.itemId === 'string');
      assert.ok(recs.length > 0, `${h.name}: no profile records found`);
      for (const r of recs) {
        const v = String(r.metadata.visibility);
        assert.ok(v in OWNER_KEY, `${h.name}: record without a visibility`);
        const key = OWNER_KEY[v];
        if (key) assert.equal(typeof r.metadata[key], 'string', `${h.name}: ${v} record without ${key}`);
      }
    },
  },
  {
    name: 'ids are deterministic and owner-scoped: re-indexing adds no record; one itemId under two owners is two items',
    async run(h) {
      const bound = await filled(h);
      assert.ok(bound);
      const before = (await rawRecords(h.rawStores(bound), h.query)).length;
      for (const w of h.writes) await bound.index(w.items, w.options);
      assert.equal((await rawRecords(h.rawStores(bound), h.query)).length, before, `${h.name}: re-index changed the record count`);
      for (const { ref, options } of h.refs) {
        const g = await bound.get(ref, options);
        assert.ok(g.ok && g.value, `${h.name}: get(${ref.itemId}) found nothing`);
        assert.equal(g.value.metadata.id, ref.itemId);
      }
      const byId = new Map<string, string[]>();
      for (const { ref, options } of h.refs) {
        const g = await bound.get(ref, options);
        const texts = byId.get(ref.itemId) ?? [];
        if (g.ok && g.value) texts.push(g.value.text);
        byId.set(ref.itemId, texts);
      }
      for (const [itemId, texts] of byId) {
        if (texts.length > 1) assert.equal(new Set(texts).size, texts.length, `${h.name}: owners of ${itemId} share a record`);
      }
    },
  },
  {
    name: 'every returned item is hydrated from its canonical record; nothing outside the identity filter',
    async run(h) {
      const bound = await filled(h);
      assert.ok(bound);
      const r = await bound.retrieval.retrieve(bound.rag, h.query, 10, h.reader.options);
      assert.ok(r.ok);
      for (const item of r.value) {
        const ref = refOf(item);
        if (!ref) continue;
        assert.ok(h.reader.visible.some((v) => sameRef(v, ref)), `${h.name}: ${ref.itemId} is outside the reader's filter`);
        const opts = h.refs.find((x) => sameRef(x.ref, ref))?.options;
        const g = await bound.get(ref, opts);
        assert.ok(g.ok && g.value);
        assert.equal(item.text, g.value.text, `${h.name}: ${ref.itemId} not hydrated from its canonical record`);
        assert.notEqual(g.value.metadata.generated, true, `${h.name}: a generated record is canonical`);
      }
    },
  },
  {
    name: 'at most cut.limit(k) distinct items, with or without a decomposer',
    async run(h) {
      const bound = await filled(h);
      assert.ok(bound);
      const limit = (k: number) => h.limit?.(k) ?? k;
      for (const k of [1, 2, 3]) {
        const r = await bound.retrieval.retrieve(bound.rag, h.query, k, h.reader.options);
        assert.ok(r.ok && r.value.length <= limit(k), `${h.name}: more than ${limit(k)} items for k=${k}`);
        const keys = r.value.map((x) => JSON.stringify(refOf(x) ?? x.metadata.id));
        assert.equal(new Set(keys).size, keys.length, `${h.name}: duplicate items`);
      }
      const split: IQueryDecomposer = {
        name: 'conformance-split',
        decompose: async (text, budget) => ({ ok: true, value: [{ text, k: Math.max(1, budget - 1) }, ...(budget > 1 ? [{ text, k: 1 }] : [])] }),
      };
      const withSplit = await filled(h, { decomposer: split });
      if (!withSplit) return;
      const r = await withSplit.retrieval.retrieve(withSplit.rag, h.query, 2, h.reader.options);
      assert.ok(r.ok && r.value.length <= limit(2), `${h.name}: a decomposer exceeded the limit`);
    },
  },
  {
    name: 'an adversarial decomposer overrunning the budget is a DECOMPOSE_ERROR',
    async run(h) {
      const overrun: IQueryDecomposer = {
        name: 'conformance-overrun',
        decompose: async (text, budget) => ({ ok: true, value: [{ text, k: budget }, { text, k: budget }] }),
      };
      const bound = await filled(h, { decomposer: overrun });
      if (!bound) return;
      const r = await bound.retrieval.retrieve(bound.rag, h.query, 2, h.reader.options);
      assert.ok(!r.ok && r.error.code === 'DECOMPOSE_ERROR', `${h.name}: overrun not refused`);
    },
  },
  {
    name: 'a size-bounded cut keeps the summed size within the budget; no item is truncated',
    async run(h) {
      if (!h.sizeBounded) return;
      const { cut, estimator, budgetTokens } = h.sizeBounded;
      const bound = await filled(h, { cut });
      if (!bound) return;
      const r = await bound.retrieval.retrieve(bound.rag, h.query, 10, h.reader.options);
      assert.ok(r.ok);
      const total = r.value.reduce((a, x) => a + estimator.estimate(x), 0);
      assert.ok(total <= budgetTokens, `${h.name}: ${total} > ${budgetTokens} tokens`);
      for (const item of r.value) {
        const ref = refOf(item);
        if (!ref) continue;
        const g = await bound.get(ref, h.refs.find((x) => sameRef(x.ref, ref))?.options);
        assert.ok(g.ok && g.value && g.value.text === item.text, `${h.name}: ${ref.itemId} truncated`);
      }
    },
  },
];
```

`packages/llm-agent/package.json` `exports`, after `./testing/rag-filter-conformance`:
```json
    "./testing/collection-profile-conformance": {
      "types": "./dist/testing/collection-profile-conformance.d.ts",
      "import": "./dist/testing/collection-profile-conformance.js",
      "default": "./dist/testing/collection-profile-conformance.js"
    }
```

- [ ] **Step 2: Write the test that runs the kit (fails until the kit is built)**

```ts
// packages/llm-agent-libs/src/collections/__tests__/collection-profile-conformance.test.ts
import { describe, it } from 'node:test';
import type { IItemCut, IQueryDecomposer, IToolFacet, SharedItem, ToolItem } from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import {
  type CollectionProfileHarness,
  collectionProfileConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/collection-profile-conformance';
// §7.9: a consumer-built profile, from the PUBLIC exports only
import {
  ComposedToolsProfile,
  FacetedToolIndexer,
  ItemPool,
  MaxScoreCollapse,
  mcpToolsVariants,
  SharedItemsProfile,
  StaticIntentSource,
  SummaryFacet,
  TokenBudgetCut,
  ToolDefinitionSizeEstimator,
  toolItemFromTool,
} from '../../index.js';
import { matchesOnly } from './staged-retrieval-helpers.js';

const tools: ToolItem[] = ['read_file', 'write_file', 'list_files'].map((n) =>
  toolItemFromTool(
    { name: n, description: `${n.replace('_', ' ')} needle`, inputSchema: { 'x-resource': 'file', properties: { path: { type: 'string' } } } },
    { itemId: `tool:${n}`, originalName: n },
  ),
);
const G = { scope: 'global' } as const;
type KitOptions = { decomposer?: IQueryDecomposer; cut?: IItemCut };
/** The kit's options → a profile's options (a decomposer needs a query embedder). */
const asProfileOptions = (o: KitOptions = {}) => ({
  ...(o.decomposer ? { decompose: { decomposer: o.decomposer, queryEmbedder: { embedQuery: async () => ({ vector: [1] }) } } } : {}),
  ...(o.cut ? { cut: o.cut } : {}),
});

/** The consumer's facet: reads its server's annotation from the schema it kept (spec §7.9). */
class ResourceFacet implements IToolFacet {
  readonly kind = 'resource';
  derive(tool: ToolItem): string | undefined {
    const r = tool.inputSchema['x-resource'];
    return typeof r === 'string' ? `${tool.originalName} — ${r}` : undefined;
  }
}

function toolsHarness(name: string, limit: number, make: (o: ReturnType<typeof asProfileOptions>) => ComposedToolsProfile): CollectionProfileHarness<ToolItem> {
  const stores: InMemoryRag[] = [];
  return {
    name,
    bind: async (opts) => {
      const rag = new InMemoryRag();
      stores.push(rag);
      const p = make(asProfileOptions(opts));
      return p.bind({ key: 'tools', rag: matchesOnly(rag) });
    },
    limit: () => limit,
    writes: [{ items: tools }],
    refs: tools.map((t) => ({ ref: { itemId: t.itemId, owner: G } })),
    reader: { visible: tools.map((t) => ({ itemId: t.itemId, owner: G })) },
    query: new TextOnlyEmbedding('needle'),
    rawStores: () => [stores[stores.length - 1]],
    sizeBounded: { cut: new TokenBudgetCut({ budgetTokens: 60 }), estimator: new ToolDefinitionSizeEstimator(), budgetTokens: 60 },
  };
}

const intents = new StaticIntentSource({ read_file: ['open my notes needle'] });
const harnesses: CollectionProfileHarness<ToolItem>[] = [
  toolsHarness('faceted + intent record', 8, (o) => {
    const base = mcpToolsVariants.faceted({ intents: { record: intents } }).composition;
    return new ComposedToolsProfile({ ...base, ...o });
  }),
  toolsHarness('consumer-built (§7.9)', 5, (o) =>
    new ComposedToolsProfile({
      indexer: new FacetedToolIndexer([new SummaryFacet(), new ResourceFacet()]),
      pool: new ItemPool(20),
      collapse: new MaxScoreCollapse(),
      cut: new TokenBudgetCut({ budgetTokens: 10_000, maxItems: 5 }),
      ...o,
    }),
  ),
];

function sharedHarness(): CollectionProfileHarness<SharedItem> {
  let user = new InMemoryRag();
  let global = new InMemoryRag();
  const item = (userId: string): SharedItem => ({ itemId: 'case-42', visibility: { scope: 'user', userId }, text: `case of ${userId} needle`, records: [{ kind: 'symptom', text: 'needle symptom' }] });
  return {
    name: 'shared items',
    bind: async (opts) => {
      user = new InMemoryRag();
      global = new InMemoryRag();
      return new SharedItemsProfile({ maxRecordsPerItem: 3, pool: new ItemPool(10), collapse: new MaxScoreCollapse(), ...asProfileOptions(opts) }).bind({ key: 'shared', user: matchesOnly(user), global: matchesOnly(global) });
    },
    writes: [
      { items: [item('A')], options: { userId: 'A' } },
      { items: [item('B')], options: { userId: 'B' } },
      { items: [{ itemId: 'pub', visibility: { scope: 'global' }, text: 'public needle' }], options: { userId: 'A' } },
    ],
    refs: [
      { ref: { itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }, options: { userId: 'A' } },
      { ref: { itemId: 'case-42', owner: { scope: 'user', userId: 'B' } }, options: { userId: 'B' } },
      { ref: { itemId: 'pub', owner: { scope: 'global' } } },
    ],
    reader: {
      options: { userId: 'A' },
      visible: [{ itemId: 'case-42', owner: { scope: 'user', userId: 'A' } }, { itemId: 'pub', owner: { scope: 'global' } }],
    },
    query: new TextOnlyEmbedding('needle'),
    rawStores: () => [user, global],
  };
}

describe('collection-profile conformance kit', () => {
  for (const h of harnesses) {
    for (const c of collectionProfileConformanceCases) it(`${h.name}: ${c.name}`, () => c.run(h));
  }
  const shared = sharedHarness();
  for (const c of collectionProfileConformanceCases) it(`${shared.name}: ${c.name}`, () => c.run(shared));
});
```

- [ ] **Step 3: Build the kit and run**

Run:
```bash
npx tsc -b packages/llm-agent packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/collection-profile-conformance.test.ts
```
Expected: PASS for all three harnesses. (Before Step 1's build the import fails — that is the red state.) If the token-budget case fails because a tool's definition exceeds 60 tokens, raise `budgetTokens` to just above the largest `definitionChars / 4` printed by the failure — the kit's bound is what is checked, not a number.

- [ ] **Step 4: Commit**

```bash
npx biome check --write packages/llm-agent/src/testing packages/llm-agent-libs/src/collections
git add packages/llm-agent/src/testing packages/llm-agent/package.json packages/llm-agent-libs/src/collections
git commit -m "feat(llm-agent): collection-profile conformance kit; run against the shipped and a consumer-built profile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 31: `evaluateRetrieval` in `@mcp-abap-adt/llm-agent-libs/testing`

Spec §14.3 (the harness core a consumer runs against its own catalog and labels).

**Files:**
- Create: `packages/llm-agent-libs/src/testing/evaluate-retrieval.ts`
- Modify: `packages/llm-agent-libs/src/testing/index.ts` (export)
- Create: `packages/llm-agent-libs/src/testing/__tests__/evaluate-retrieval.test.ts`

**Interfaces:**
- Consumes: `IRag`, `IRetrievalStrategy`, `IQueryEmbedder`, `IItemSizeEstimator`, `QueryEmbedding`, `TextOnlyEmbedding`, `toolNameFromRecord`; `ToolDefinitionSizeEstimator` (Task 6).
- Produces:
  ```ts
  export interface RetrievalCase { readonly query: string; readonly expect: readonly string[]; readonly required?: readonly (readonly string[])[] }
  export interface RetrievalEvalReport {
    readonly ks: readonly number[];
    /** AND of OR-groups: every group has a returned name. `required` absent → one group = expect. */
    readonly requiredRecall: Readonly<Record<number, number>>;
    readonly mrr: number;                                   // first expected name, at the largest k
    readonly avgItems: Readonly<Record<number, number>>;
    readonly avgPromptTokens: Readonly<Record<number, number>>; // summed estimator size of returned items
    readonly errors: number;
    readonly cases: readonly { readonly query: string; readonly rank: number | null; readonly hitAt: Readonly<Record<number, boolean>> }[];
  }
  export function evaluateRetrieval(input: { store: IRag; strategy: IRetrievalStrategy; cases: readonly RetrievalCase[]; ks: readonly number[]; queryEmbedder?: IQueryEmbedder; estimator?: IItemSizeEstimator; options?: CallOptions }): Promise<RetrievalEvalReport>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/testing/__tests__/evaluate-retrieval.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type IRag, RagError, type RagResult } from '@mcp-abap-adt/llm-agent';
import { EmbeddingRetrieval } from '../../retrieval/index.js';
import { evaluateRetrieval } from '../index.js';

const item = (name: string, definitionChars: number): RagResult => ({
  text: name,
  metadata: { id: `tool:${name}`, name, definitionChars },
  score: 1,
});
const store = (byQuery: Record<string, RagResult[]>): IRag => ({
  query: async (q, k) => ({ ok: true, value: (byQuery[q.text] ?? []).slice(0, k) }),
  healthCheck: async () => ({ ok: true, value: undefined }),
  getById: async () => ({ ok: true, value: null }),
});

describe('evaluateRetrieval', () => {
  it('required-recall is an AND of OR-groups; MRR; items; prompt tokens', async () => {
    const s = store({
      'create and activate': [item('CreateClass', 400), item('Other', 40), item('Activate', 40)],
      'read it': [item('Other', 40), item('ReadClass', 400)],
    });
    const r = await evaluateRetrieval({
      store: s,
      strategy: new EmbeddingRetrieval(),
      ks: [1, 3],
      cases: [
        { query: 'create and activate', expect: ['CreateClass'], required: [['CreateClass'], ['Activate', 'ActivateObjects']] },
        { query: 'read it', expect: ['ReadClass', 'GetClass'] },
      ],
    });
    assert.deepEqual(r.requiredRecall, { 1: 0, 3: 1 });
    assert.equal(r.mrr, (1 + 1 / 2) / 2);
    assert.deepEqual(r.avgItems, { 1: 1, 3: 2.5 });
    assert.deepEqual(r.avgPromptTokens, { 1: (100 + 10) / 2, 3: (120 + 110) / 2 });
    assert.equal(r.errors, 0);
  });
  it('a strategy error is a miss and counted', async () => {
    const failing: IRag = { ...store({}), query: async () => ({ ok: false, error: new RagError('x') }) };
    const r = await evaluateRetrieval({ store: failing, strategy: new EmbeddingRetrieval(), ks: [1], cases: [{ query: 'q', expect: ['A'] }] });
    assert.equal(r.errors, 1);
    assert.deepEqual(r.requiredRecall, { 1: 0 });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/testing/__tests__/evaluate-retrieval.test.ts`
Expected: FAIL — `evaluateRetrieval` not exported.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/testing/evaluate-retrieval.ts
import {
  type CallOptions,
  type IItemSizeEstimator,
  type IQueryEmbedder,
  type IRag,
  type IRetrievalStrategy,
  QueryEmbedding,
  type RagResult,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import { ToolDefinitionSizeEstimator } from '../collections/size-estimators.js';

export interface RetrievalCase {
  readonly query: string;
  readonly expect: readonly string[];
  /** AND of OR-groups; absent → one group: `expect`. */
  readonly required?: readonly (readonly string[])[];
}

export interface RetrievalEvalReport {
  readonly ks: readonly number[];
  readonly requiredRecall: Readonly<Record<number, number>>;
  readonly mrr: number;
  readonly avgItems: Readonly<Record<number, number>>;
  readonly avgPromptTokens: Readonly<Record<number, number>>;
  readonly errors: number;
  readonly cases: readonly {
    readonly query: string;
    readonly rank: number | null;
    readonly hitAt: Readonly<Record<number, boolean>>;
  }[];
}

const nameOf = (r: RagResult): string | undefined =>
  toolNameFromRecord(r.metadata) ??
  (typeof r.metadata.name === 'string' ? r.metadata.name : undefined);

/**
 * The measurement core of scripts/rag-eval (spec §14.3): a consumer runs its own
 * catalog and labels through any store + strategy (a profile's retrieval included).
 */
export async function evaluateRetrieval(input: {
  store: IRag;
  strategy: IRetrievalStrategy;
  cases: readonly RetrievalCase[];
  ks: readonly number[];
  queryEmbedder?: IQueryEmbedder;
  estimator?: IItemSizeEstimator;
  options?: CallOptions;
}): Promise<RetrievalEvalReport> {
  const ks = [...input.ks].sort((a, b) => a - b);
  const maxK = ks[ks.length - 1] ?? 1;
  const estimator = input.estimator ?? new ToolDefinitionSizeEstimator();
  const hits: Record<number, number> = {};
  const items: Record<number, number> = {};
  const tokens: Record<number, number> = {};
  for (const k of ks) {
    hits[k] = 0;
    items[k] = 0;
    tokens[k] = 0;
  }
  let rr = 0;
  let errors = 0;
  const cases: RetrievalEvalReport['cases'][number][] = [];
  for (const c of input.cases) {
    const groups = c.required ?? [c.expect];
    const hitAt: Record<number, boolean> = {};
    let rank: number | null = null;
    for (const k of ks) {
      const q = input.queryEmbedder
        ? new QueryEmbedding(c.query, input.queryEmbedder, input.options)
        : new TextOnlyEmbedding(c.query);
      const r = await input.strategy.retrieve(input.store, q, k, input.options);
      if (!r.ok) {
        errors++;
        hitAt[k] = false;
        continue;
      }
      const names = r.value.map(nameOf);
      hitAt[k] = groups.every((g) => g.some((n) => names.includes(n)));
      if (hitAt[k]) hits[k]++;
      items[k] += r.value.length;
      tokens[k] += r.value.reduce((a, x) => a + estimator.estimate(x), 0);
      if (k === maxK) {
        const i = names.findIndex((n) => n !== undefined && c.expect.includes(n));
        rank = i === -1 ? null : i + 1;
      }
    }
    if (rank !== null) rr += 1 / rank;
    cases.push({ query: c.query, rank, hitAt });
  }
  const n = input.cases.length || 1;
  const per = (m: Record<number, number>) =>
    Object.fromEntries(ks.map((k) => [k, m[k] / n]));
  return {
    ks,
    requiredRecall: per(hits),
    mrr: rr / n,
    avgItems: per(items),
    avgPromptTokens: per(tokens),
    errors,
    cases,
  };
}
```

Append to `packages/llm-agent-libs/src/testing/index.ts`:
```ts
export {
  evaluateRetrieval,
  type RetrievalCase,
  type RetrievalEvalReport,
} from './evaluate-retrieval.js';
```

- [ ] **Step 4: Run**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/testing/__tests__/evaluate-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/testing
git add packages/llm-agent-libs/src/testing
git commit -m "feat(libs): evaluateRetrieval — required-recall, MRR, items and prompt tokens per k

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 32: `scripts/rag-eval` — profile arms, required-recall, prompt size

Spec §14.3 (flags; any tools snapshot; the decision model picked like `decision:` — Jev or Cohere; the acceptance runs are env-gated and are the consumer check, not part of `npm test`).

**Files:**
- Create: `scripts/rag-eval/profile-arm.ts`
- Modify: `scripts/rag-eval/rag-eval.ts` (flags, `Case.required`, one call into the profile arm)
- Modify: `scripts/rag-eval/README.md`
- Create: `test/repo/rag-eval-profile-arm.test.ts`
- Modify: `tsconfig.typecheck.json` (`include`: `scripts/rag-eval/profile-arm.ts`, `test/repo/rag-eval-profile-arm.test.ts`)

**Interfaces:**
- Consumes: `mcpToolsVariants`, `ComposedToolsProfile`, facets, `EnumValueToolIndexer`, discriminators, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `ItemPool`, `MaxScoreCollapse`, cuts, `DecisionReranker`, `TOOL_QUESTION` (libs sources); `vectorizeMcpTools` (`ns.binding`); `evaluateRetrieval` (Task 31); `buildCompositionDeps` (`makeDecisionModel`, which builds `SapAiCoreDecisionModel` for `provider: 'sap-aicore'` — Task 24).
- Produces:
  ```ts
  export interface ProfileArmFlags { variant?: string; indexer?: 'faceted' | 'enum-values'; facets?: string[]; discriminator?: string; maxValues?: number; intents?: 'off' | 'record' | 'companion'; intentsFile?: string; poolItems?: number; reranker?: 'none' | 'decision'; cut?: string; budgetTokens?: number }
  export interface ProfileArmDeps { decisionModel?: () => Promise<IDecisionModel>; decisionProvider?: 'typesafe' | 'sap-aicore'; readFile?: (p: string) => string } // the model --decision-provider built (Jev or Cohere)
  export function buildProfileArm(flags: ProfileArmFlags, deps: ProfileArmDeps): Promise<{ label: string; profile: ComposedToolsProfile | undefined; companions: string[] }>;
  export function runProfileArm(arm: { label: string; profile: ComposedToolsProfile | undefined }, input: { tools: McpTool[]; cases: RetrievalCase[]; ks: number[]; makeStore: () => Promise<IRag>; queryEmbedder?: IQueryEmbedder }): Promise<RetrievalEvalReport & { label: string }>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/rag-eval-profile-arm.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type IDecisionModel, InMemoryRag, type McpTool } from '../../packages/llm-agent/src/index.js';
import { buildProfileArm, runProfileArm } from '../../scripts/rag-eval/profile-arm.js';

const tools: McpTool[] = [
  { name: 'ReadClass', description: 'Read class source', inputSchema: { properties: { class_name: { type: 'string' } } } },
  { name: 'WhereUsed', description: 'Where-used list of an object', inputSchema: { properties: { object_name: { type: 'string' } } } },
];

describe('rag-eval profile arms', () => {
  it('--variant faceted builds the shipped composition', async () => {
    const arm = await buildProfileArm({ variant: 'faceted' }, {});
    assert.equal(arm.label, 'variant=faceted');
    assert.ok(arm.profile);
  });
  it('--variant baseline binds nothing', async () => {
    const arm = await buildProfileArm({ variant: 'baseline' }, {});
    assert.equal(arm.profile, undefined);
  });
  it('a composition by strategy names; unknown names fail', async () => {
    const arm = await buildProfileArm({ indexer: 'faceted', facets: ['summary', 'parameters'], poolItems: 10, cut: 'fixed-items:3' }, {});
    assert.ok(arm.profile);
    await assert.rejects(buildProfileArm({ indexer: 'faceted', facets: ['nope'], poolItems: 10 }, {}), /unknown facet "nope"/);
    await assert.rejects(buildProfileArm({ variant: 'faceted-jev' }, {}), /decision/);
  });
  it('a named decision variant needs the decision provider it was measured with (spec §6.2)', async () => {
    const model = { decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) } as unknown as IDecisionModel;
    const arm = await buildProfileArm({ variant: 'faceted-cohere' }, { decisionModel: async () => model, decisionProvider: 'sap-aicore' });
    assert.ok(arm.profile);
    await assert.rejects(
      buildProfileArm({ variant: 'faceted-cohere' }, { decisionModel: async () => model, decisionProvider: 'typesafe' }),
      /faceted-cohere reranks with Cohere — needs --decision-provider sap-aicore/,
    );
    await assert.rejects(
      buildProfileArm({ variant: 'small-set-jev', poolItems: 2 }, { decisionModel: async () => model, decisionProvider: 'sap-aicore' }),
      /small-set-jev reranks with Jev — needs --decision-provider typesafe/,
    );
  });
  it('runs a snapshot through the profile path and reports required-recall and prompt size', async () => {
    const arm = await buildProfileArm({ variant: 'faceted' }, {});
    const r = await runProfileArm(arm, {
      tools,
      cases: [{ query: 'where used of a table', expect: ['WhereUsed'] }],
      ks: [1, 3],
      makeStore: async () => new InMemoryRag(),
    });
    assert.equal(r.label, 'variant=faceted');
    assert.equal(r.requiredRecall[3], 1);
    assert.ok(r.avgPromptTokens[3] > 0);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test test/repo/rag-eval-profile-arm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `profile-arm.ts`**

```ts
// scripts/rag-eval/profile-arm.ts
/**
 * Profile arms for rag-eval (spec §14.3): a shipped default composition by name
 * (--variant) or a composition by strategy names. Vectorized through the same
 * profile path as the server (vectorizeMcpTools with a binding) and measured by
 * evaluateRetrieval. Works on ANY tools snapshot — no server is special-cased.
 */
import { readFileSync } from 'node:fs';
import type {
  IDecisionModel,
  IItemCut,
  IItemIndexer,
  IMcpClient,
  IQueryEmbedder,
  IRag,
  IReranker,
  McpTool,
  ToolItem,
} from '../../packages/llm-agent/src/index.js';
import {
  ComposedToolsProfile,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  FixedItemsCut,
  IntentCompanionIndexer,
  IntentRecordIndexer,
  ItemPool,
  MaxScoreCollapse,
  mcpToolsVariants,
  NamedDiscriminator,
  NameTailFacet,
  ParametersFacet,
  RequiredEnumDiscriminator,
  StaticIntentSource,
  SummaryFacet,
  TokenBudgetCut,
} from '../../packages/llm-agent-libs/src/collections/index.js';
import { NoopRequestLogger } from '../../packages/llm-agent-libs/src/logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../../packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.js';
import { DecisionReranker, TOOL_QUESTION } from '../../packages/llm-agent-libs/src/reranker/index.js';
import { EmbeddingRetrieval } from '../../packages/llm-agent-libs/src/retrieval/index.js';
import {
  evaluateRetrieval,
  type RetrievalCase,
  type RetrievalEvalReport,
} from '../../packages/llm-agent-libs/src/testing/evaluate-retrieval.js';

export interface ProfileArmFlags {
  variant?: string;
  indexer?: 'faceted' | 'enum-values';
  facets?: string[];
  discriminator?: string;
  maxValues?: number;
  intents?: 'off' | 'record' | 'companion';
  intentsFile?: string;
  poolItems?: number;
  /** decision = DecisionReranker over the model --decision-provider builds (Jev or Cohere). */
  reranker?: 'none' | 'decision';
  /** top-items | fixed-items:<n> | token-budget:<n> */
  cut?: string;
  budgetTokens?: number;
}

export interface ProfileArmDeps {
  /** Built from --decision-provider: TypeSafeDecisionModel or SapAiCoreDecisionModel. */
  decisionModel?: () => Promise<IDecisionModel>;
  /** Which provider decisionModel is; a named variant is checked against it (spec §6.2). */
  decisionProvider?: 'typesafe' | 'sap-aicore';
  readFile?: (path: string) => string;
}

/** The decision provider each named decision variant was measured with (spec §5.5). */
const VARIANT_PROVIDER: Readonly<Record<string, { provider: 'typesafe' | 'sap-aicore'; model: string }>> = {
  'faceted-cohere': { provider: 'sap-aicore', model: 'Cohere' },
  'faceted-jev': { provider: 'typesafe', model: 'Jev' },
  'small-set-jev': { provider: 'typesafe', model: 'Jev' },
};

const FACETS: Record<string, () => SummaryFacet | ParametersFacet | NameTailFacet> = {
  summary: () => new SummaryFacet(),
  parameters: () => new ParametersFacet(),
  'name-tail': () => new NameTailFacet(),
};

export async function buildProfileArm(
  f: ProfileArmFlags,
  deps: ProfileArmDeps,
): Promise<{ label: string; profile: ComposedToolsProfile | undefined; companions: string[] }> {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const intents =
    f.intents && f.intents !== 'off'
      ? new StaticIntentSource(JSON.parse(read(f.intentsFile ?? '')) as Record<string, string[]>)
      : undefined;
  const placement = intents ? (f.intents === 'record' ? { record: intents } : { companion: intents }) : undefined;
  const need = async <T>(get: (() => Promise<T>) | undefined, what: string): Promise<T> => {
    if (!get) throw new Error(`${what} is not configured for this run`);
    return get();
  };
  if (f.variant) {
    const v = f.variant;
    const opts = placement ? { intents: placement } : {};
    const wants = VARIANT_PROVIDER[v];
    if (wants && deps.decisionModel && deps.decisionProvider !== wants.provider) {
      throw new Error(`${v} reranks with ${wants.model} — needs --decision-provider ${wants.provider}`);
    }
    const model = () => need(deps.decisionModel, 'decision model (--decision-provider: DECISION_API_KEY, or a sap-aicore deployment)');
    const profile =
      v === 'baseline'
        ? undefined
        : v === 'faceted'
          ? mcpToolsVariants.faceted(opts)
          : v === 'faceted-cohere'
            ? mcpToolsVariants.facetedCohere({ ...opts, decisionModel: await model() })
            : v === 'faceted-jev'
              ? mcpToolsVariants.facetedJev({ ...opts, decisionModel: await model() })
              : v === 'small-set-jev'
                ? mcpToolsVariants.smallSetJev({ ...opts, decisionModel: await model(), poolItems: f.poolItems ?? 0 })
                : undefined;
    if (profile === undefined && v !== 'baseline') throw new Error(`unknown variant "${v}"`);
    return { label: `variant=${v}`, profile, companions: placement && 'companion' in placement ? ['intents'] : [] };
  }
  const facets = (f.facets ?? []).map((n) => {
    const make = FACETS[n];
    if (!make) throw new Error(`unknown facet "${n}"`);
    return make();
  });
  let base: IItemIndexer<ToolItem> = new FacetedToolIndexer(facets);
  if (f.indexer === 'enum-values') {
    base = new EnumValueToolIndexer(base, {
      discriminator:
        !f.discriminator || f.discriminator === 'required-enum'
          ? new RequiredEnumDiscriminator()
          : new NamedDiscriminator(f.discriminator),
      maxValues: f.maxValues ?? 0,
    });
  }
  const indexing = !placement
    ? { indexer: base }
    : 'record' in placement
      ? { indexer: new IntentRecordIndexer(base, placement.record) }
      : { indexer: base, companions: { intents: new IntentCompanionIndexer(placement.companion) } };
  let reranker: IReranker | undefined;
  if (f.reranker === 'decision') {
    // Jev or Cohere, whichever --decision-provider built (Cohere ignores the wording).
    reranker = new DecisionReranker(await need(deps.decisionModel, 'decision model (--decision-provider)'), {
      task: TOOL_QUESTION.task,
      criteria: TOOL_QUESTION.criteria,
    });
  }
  let cut: IItemCut | undefined;
  const [kind, n] = (f.cut ?? 'top-items').split(':');
  if (kind === 'fixed-items') cut = new FixedItemsCut(Number(n));
  else if (kind === 'token-budget') cut = new TokenBudgetCut({ budgetTokens: Number(n ?? f.budgetTokens) });
  else if (kind !== 'top-items') throw new Error(`unknown cut "${f.cut}"`);
  const profile = new ComposedToolsProfile({
    ...indexing,
    pool: new ItemPool(f.poolItems ?? 30),
    collapse: new MaxScoreCollapse(),
    ...(reranker ? { rerank: { reranker, onFailure: 'stage1' as const } } : {}),
    ...(cut ? { cut } : {}),
  });
  const label = [
    `indexer=${f.indexer ?? 'faceted'}[${(f.facets ?? []).join(',')}]`,
    `pool=${f.poolItems ?? 30}`,
    `reranker=${f.reranker ?? 'none'}`,
    `cut=${f.cut ?? 'top-items'}`,
    `intents=${f.intents ?? 'off'}`,
  ].join(' ');
  return { label, profile, companions: 'companions' in indexing ? ['intents'] : [] };
}

export async function runProfileArm(
  arm: { label: string; profile: ComposedToolsProfile | undefined; companions?: string[] },
  input: {
    tools: McpTool[];
    cases: RetrievalCase[];
    ks: number[];
    makeStore: () => Promise<IRag>;
    queryEmbedder?: IQueryEmbedder;
  },
): Promise<RetrievalEvalReport & { label: string }> {
  const client = {
    listTools: async () => ({ ok: true, value: input.tools }),
    callTool: async () => {
      throw new Error('rag-eval: callTool is not part of retrieval');
    },
  } as unknown as IMcpClient;
  const raw = await input.makeStore();
  const companions: Record<string, IRag> = {};
  for (const c of arm.companions ?? []) companions[c] = await input.makeStore();
  const binding = arm.profile?.bind({ key: 'tools', rag: raw, companions });
  const store = binding?.rag ?? raw;
  await vectorizeMcpTools([client], store, new NoopRequestLogger(), undefined, undefined, undefined, binding ? { binding } : undefined);
  const report = await evaluateRetrieval({
    store,
    // The bound store already applies the profile's retrieval; baseline is the 30.1.0 ranking.
    strategy: new EmbeddingRetrieval(),
    cases: input.cases,
    ks: input.ks,
    ...(input.queryEmbedder ? { queryEmbedder: input.queryEmbedder } : {}),
  });
  return { ...report, label: arm.label };
}
```

Edits to `rag-eval.ts`:
- `interface Case { query: string; expect: string[]; required?: string[][] }` (an optional `required` field in the queries file — AND of OR-groups).
- add to the `parseArgs` options: `variant`, `indexer`, `facets`, `discriminator`, `'max-values'`, `intents`, `'intents-file'`, `'pool-items'`, `cut`, `'budget-tokens'`, `'decision-provider'` (`typesafe` | `sap-aicore`, default `typesafe`), `'rerank-deployment'`, `'rerank-model'`, `'rerank-credential-ref'` (all `{ type: 'string' }`), and allow `--reranker none|decision` alongside the existing values (`decision` = Jev or Cohere by `--decision-provider`).
- one decision model per run, picked like the server's `decision:` section: `--decision-provider typesafe` → the existing `TypeSafeDecisionModel` construction (`staticApiKey(process.env.DECISION_API_KEY ?? '')`); `--decision-provider sap-aicore` → `buildCompositionDeps(process.env).makeDecisionModel({ provider: 'sap-aicore', deploymentId: <--rerank-deployment>, model: <--rerank-model>, ...(credentialRef ? { credentialRef } : {}) })` (default ref `DECISION` → `DECISION_SERVICE_KEY`; a missing `--rerank-deployment` / `--rerank-model` skips the arm with a printed reason, like a missing key). The existing `buildReranker` for `--reranker decision` arms takes the same model, so the 30.1.0 rerank arms can be measured with Cohere too.
- when `--variant` or `--indexer` is given: build `ProfileArmDeps` — `decisionModel` (the model above, lazily) and `decisionProvider` — then, per matrix entry, call `runProfileArm(await buildProfileArm(flags, deps), { tools, cases, ks: [...REPORT_KS], makeStore: <the entry's existing makeRag path>, queryEmbedder: <the entry's resolved embedder> })` and print one row per k: `required-recall`, `avg items`, `avg prompt tokens`, `MRR`. The existing arms and their output are unchanged when no profile flag is given.

`scripts/rag-eval/README.md`: add a "Profile arms" section listing the flags above (including `--decision-provider` and the three `--rerank-*` flags for Cohere on SAP AI Core), the `required` field (`"required": [["CreateClass"], ["Activate", "ActivateObjects"]]`), the prompt-size column, `evaluateRetrieval` from `@mcp-abap-adt/llm-agent-libs/testing` for consumers, and the four acceptance runs of spec §14.3 (each env-gated; the hub's consumer check).

- [ ] **Step 4: Run (unit + typecheck)**

Run:
```bash
node --import tsx/esm --test test/repo/rag-eval-profile-arm.test.ts test/repo/rag-eval-fallbacks.test.ts
npm run typecheck
```
Expected: PASS; exit 0.

- [ ] **Step 5: Commit**

```bash
npx biome check --write scripts/rag-eval test/repo
git add scripts/rag-eval test/repo tsconfig.typecheck.json
git commit -m "feat(rag-eval): profile arms (--variant or a composition), required-recall and prompt size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 33: Reference docs — every page the change touches

Spec §13 (docs updated in the same PR), §10.3 (rewrite the `IToolIndexingStrategy` pages). The user's rule: a release updates **all** documentation the change touches, not only the changelog. ADHD-friendly: TL;DR first, short chunks.

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`, `docs/PERFORMANCE.md`, `docs/EXAMPLES.md`, `docs/TROUBLESHOOTING.md`, `docs/DEPLOYMENT.md`, `docs/SECURITY_THREAT_MODEL.md`, `docs/QUICK_START.md`
- Modify: `packages/llm-agent/README.md`, `packages/llm-agent-libs/README.md`, `packages/llm-agent-server-libs/README.md`, `packages/llm-agent-server/README.md`, `packages/typesafe-decision/README.md` (one line: the decision model is one of two providers)
- Modify: `examples/docker-sap-ai-core/smart-server.yaml` (a commented `decision: { provider: sap-aicore … }` + `rag.profiles` block)
- (`packages/sap-aicore-decision/README.md` was written in Task 18.)

- [ ] **Step 1: `docs/INTEGRATION.md` — replace the whole `## IToolIndexingStrategy` section (heading through the line before the next `## `) with:**

````markdown
## Collection profiles

**TL;DR.** A *collection profile* is how ONE kind of collection is **filled** and **searched**:
an indexer (one item → several records), a candidate pool counted in **items**, a collapse rule
(records → items), an optional reranker on the item's **provider text**, and one final cut counted in
**items**. No profile → 30.1.0 behaviour, unchanged. Contracts: `packages/llm-agent/src/interfaces/collection-profile.ts`;
strategies: `packages/llm-agent-libs/src/collections/`.

### The contract

```ts
interface ICollectionProfile<TItem, TTarget extends BindTarget = CollectionStore> {
  readonly name: string;
  bind(target: TTarget): IBoundCollection<TItem>;   // once per store of that kind
}
interface IBoundCollection<TItem> {
  readonly rag: IRag;                    // register this under the store key
  index(items, options?): Promise<Result<IndexReport, RagError>>;
  remove(refs: ItemRef[], options?): Promise<Result<number, RagError>>;
  get(ref: ItemRef, options?): Promise<Result<RagResult | null, RagError>>;
  readonly retrieval: IRetrievalStrategy; // k counts ITEMS
}
```

- **One profile, several stores:** `bind()` per store (e.g. a reader and a writer tool store).
- **The retrieval half is an `IRetrievalStrategy`** (`StagedRetrieval`): every path that honours
  per-store strategies (`rag.retrieval`, `withRetrievalStrategy`, the `RerankHandler` precedence) gets it.

### Records, owners, ids

- Every record has an `owner` (`global` | `group` | `user` | `session`), flattened into
  `metadata.visibility` + `userId` / `groupId` / `sessionId`.
- **Physical ids are owner-scoped:** `recordId(owner, itemId, kind, n)` (exported; use it in your own profile).
  Two users writing `case-42` into one store never touch each other's records.
- **Migration note:** under a profile, `rag.getById(itemId)` on the raw store finds nothing — use
  `bound.get({ itemId, owner })`. Returned items still carry `metadata.id = itemId`.
- **Every returned item is hydrated from its canonical record**, whichever record matched; a hit whose
  canonical record is missing is dropped and counted (`outcome=orphan`).
- **Replacing an item is not atomic** (several writes, no locks): serialize concurrent writers of one
  item yourself. Readers stay safe through hydration.
- **Companion records** (e.g. intents in their own store) are listed on the canonical record
  (`companionRecordIds`), so `remove` and re-indexing clear them too.
- **`IndexReport.notes`** carries what an indexer declined to guess (e.g. `ambiguous-discriminator`);
  write your own through the optional `IIndexNoteSource` capability.

### MCP tools — choose strategies, or start from a default composition

| Default (`mcpToolsVariants.*`) | Tool-set shape | Composition |
|---|---|---|
| `baseline()` | any | binds nothing — 30.1.0 |
| `faceted()` | fine-grained | `full` + `summary` + `parameters` records, `ItemPool(15)`, max collapse, `FixedItemsCut(8)` |
| `facetedCohere({ decisionModel })` | fine-grained | faceted + `ItemPool(30)` + `DecisionReranker(TOOL_QUESTION)` over your `SapAiCoreDecisionModel` (Cohere) + `FixedItemsCut(5)` |
| `facetedJev({ decisionModel })` | fine-grained | the same over your `TypeSafeDecisionModel` (Jev) — *to be measured as one composition before promotion* |
| `smallSetJev({ decisionModel, poolItems })` | coarse / small | one `full` record per tool + Jev over the whole set (`poolItems` ≥ your tool count) + `FixedItemsCut(3)` |

Each default cites its measurement in the source and in [PERFORMANCE.md](PERFORMANCE.md#collection-profiles).
Intents are an add-on: `{ intents: { record: source } }` (own record kind) or `{ intents: { companion: source } }`
(own store, bind with `companions: { intents: store }`).

Compose your own — any strategy combines with any other:

```ts
import type { IToolFacet, ToolItem } from '@mcp-abap-adt/llm-agent';
import {
  ComposedToolsProfile, FacetedToolIndexer, SummaryFacet,
  ItemPool, MaxScoreCollapse, TokenBudgetCut,
} from '@mcp-abap-adt/llm-agent-libs';

/** Your server keeps the target in an `x-resource` annotation (your knowledge, your code). */
class ResourceFacet implements IToolFacet {
  readonly kind = 'resource';
  derive(tool: ToolItem): string | undefined {
    const r = tool.inputSchema['x-resource'];
    return typeof r === 'string' ? `${tool.originalName} — ${r}` : undefined;
  }
}

const myTools = new ComposedToolsProfile({
  indexer: new FacetedToolIndexer([new SummaryFacet(), new ResourceFacet()]),
  pool: new ItemPool(20),
  collapse: new MaxScoreCollapse(),
  cut: new TokenBudgetCut({ budgetTokens: 4000, maxItems: 5 }), // count 5, budget only as a guard
});
builder.withToolsProfile(myTools);
```

- Shipped tools strategies read only what every MCP server exports (name, description, input schema).
  `NameTailFacet` assumes verb-first names and is opt-in; `EnumValueToolIndexer` and `TokenBudgetCut`
  are generic strategies in no default (measured worse as defaults).
- `withToolsProfile` + `withRetrievalStrategy('tools', …)` is refused at build (one owner of a store's ranking).

### Shared items

```ts
const shared = new SharedItemsProfile({
  maxRecordsPerItem: 4, pool: new ItemPool(30), collapse: new MaxScoreCollapse(), cut: new FixedItemsCut(3),
}).bind({ key: 'shared', user: userStore, global: globalStore, groups: myGroups });

await shared.index([{ itemId: 'case-42', visibility: { scope: 'user', userId: 'alice' },
  text: 'the whole case', records: [{ kind: 'symptom', text: 'timeout on save' }], data: { fixed: true } }],
  { userId: 'alice' });
builder.withRetrievalStrategy('shared', shared.retrieval); // and register shared.rag under 'shared'
```

- Partitions by visibility: `user` (read with `ragFilter.userId`, skipped without one), `global`
  (unfiltered), groups from your `ISharedItemGroups` (your authorization).
- A `user` item whose `userId` ≠ the request's is refused; a visibility without a store is refused.
- What an item holds, when it is written and by whom is the writing element's business.

### Query decomposition — the `IQueryDecomposer` slot

- `StagedRetrieval` calls your `decompose(text, budget)`; `budget = cut.limit(k)`.
- Sub-query `k`s must be integers ≥ 1 summing to ≤ `budget`; texts non-empty. Anything else — or an
  error — is a `DECOMPOSE_ERROR`, returned, never a silent fall-back. `[]` = run the query as is.
- **k stays the overall limit:** the merged union is cut once. None ships; you measure yours (§ rag-eval).

### Rerankers

Both named rerankers are the existing `DecisionReranker`; the alternative is the `IDecisionModel` you
put into it:

| Reranker | Decision model | Package |
|---|---|---|
| Cohere Rerank on SAP AI Core | `SapAiCoreDecisionModel` (yes/no questions with a passage; one `/rerank` call per batch) | `@mcp-abap-adt/sap-aicore-decision` |
| TypeSafe Jev | `TypeSafeDecisionModel` | `@mcp-abap-adt/typesafe-decision` |

Any reranker composes with any indexing. Under a profile every reranker result is checked: wrong count,
a duplicate or a non-finite score is a `RERANK_ERROR` (`onFailure: 'stage1'` keeps the stage-1 order,
`'error'` returns it) — counted, never silent. A size-bounded cut (`ISizeBoundedCut`, e.g.
`TokenBudgetCut`) adds `cut.tokens` / `cut.budgetTokens` and `outcome=over_budget`.

### Conformance kit

```ts
import { collectionProfileConformanceCases } from '@mcp-abap-adt/llm-agent/testing/collection-profile-conformance';
for (const c of collectionProfileConformanceCases) it(c.name, () => c.run(myHarness));
```

It checks owner keys on every record, owner-scoped ids, hydration, at most `cut.limit(k)` items with or
without a decomposer, an overrunning decomposer refused, the identity filter, and a size-bounded cut's budget.

### Migrating from `IToolIndexingStrategy`

The unexported, unwired `IToolIndexingStrategy` is deleted:
`OriginalToolIndexing` → `FacetedToolIndexer`'s `full` record (or no profile at all);
`IntentToolIndexing` → `IntentRecordIndexer` / `IntentCompanionIndexer` with `LlmIntentSource` or `StaticIntentSource`;
`SynonymToolIndexing` is not ported (its synonyms were not the provider's words).
````

Also in `docs/INTEGRATION.md`:
- `## IReranker` (line ~1044): add one line under its intro — `Shipped implementations: LlmReranker, DecisionReranker (over any IDecisionModel — TypeSafe Jev or Cohere on SAP AI Core).`; under `### Example: Cross-encoder reranker via external API` add one sentence: for Cohere on SAP AI Core there is a shipped decision model — use `DecisionReranker(new SapAiCoreDecisionModel(…))` instead of writing your own.
- `## IDecisionModel` (~1165): add `SapAiCoreDecisionModel` (`@mcp-abap-adt/sap-aicore-decision`) beside `TypeSafeDecisionModel`, with its rule: only `noul` questions with `instructions.passage`; any other question type → `DECISION_UNSUPPORTED_QUESTION`; `task` / `criteria` are not read.
- `## IRetrievalStrategy` (~1096): add `StagedRetrieval` to the built-ins list with a link to `#collection-profiles`, plus the additive `telemetry` option of `RerankedRetrieval` / `RerankAllRetrieval` (telemetry only, no output check there).

- [ ] **Step 2: `docs/PERFORMANCE.md` — replace the `## Tool Indexing Strategies` section with `## Collection profiles`:**

````markdown
## Collection profiles

**TL;DR.** Several records per tool + collapse by the best hit + a pool counted in **items** + a
reranker on the provider text. Measured in one consumer on one server (`mcp-abap-adt`) — a direction,
not a benchmark; measure your own catalog with `scripts/rag-eval` / `evaluateRetrieval`.

| Measured (required-recall, hybrid in-store scoring) | Consequence |
|---|---|
| one record per tool: 0.943 at k=5; 0.977 at k=15 (~25 tools) | `baseline` stays the default |
| `full` + operation + object records, collapse by max: 0.966 at k=5; 0.977 at k=8 (~13 tools) | `faceted` (schema-derived `parameters` replaces the name-derived record — not yet measured) |
| collapse by count or RRF | worse than max — only `MaxScoreCollapse` ships |
| pool of 30 **records** with several records per tool → non-English 0.846–0.885 | pool counted in **items**: 30 items → 0.962 (Cohere) / 1.000 (Jev) |
| rerankers (one record per tool, pool 30 items, k=5): Cohere EN 0.931, Jev EN 0.977; non-English 0.962 / 1.000 | `faceted-cohere` (`DecisionReranker` over `SapAiCoreDecisionModel`), `faceted-jev` (over `TypeSafeDecisionModel`) |
| coarse `compact` set (25 tools): one record + Jev over the whole set, k=3 → 0.970 at ~1.6k tokens (whole set ≈ 7.9k) | `small-set-jev` |
| per-value records on `compact`: worse (non-English 0.857 vs 1.000) | `EnumValueToolIndexer` in no default |
| token budget as the main cut: 0.910 vs 0.970 for k=3 at equal tokens | `TokenBudgetCut` is a guard, not a main cut |
| an LLM as reranker | no gain, 6–10k tokens per query |

Knobs, all chosen by the strategies you inject: pool size (`ItemPool(n)`), cut (`TopItemsCut`,
`FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`), reranker, intents (add-on for stage 1 only —
within noise once a reranker runs). The library picks no number for you.
````

Also in `docs/PERFORMANCE.md` `### Retrieval strategy per store (rag.retrieval)` (~line 105): add a final paragraph pointing to `rag.profiles` for multi-record tools stores and stating the two are exclusive per key.

- [ ] **Step 3: `docs/ARCHITECTURE.md`**

- In `### 4. RAG Layer` core contracts, replace the `IToolIndexingStrategy` bullet with:
  `- ICollectionProfile, IBoundCollection, IItemIndexer, ICandidatePool, ICollapseRule, IItemCut, IItemSizeEstimator, IQueryDecomposer, ISourceSelector, IRetrievalMetrics, IRetrievalEmbedderOwner — collection profiles: how one kind of collection is filled and searched (see INTEGRATION.md#collection-profiles)`.
- Replace the `Tool indexing strategies (IToolIndexingStrategy):` list with a `Collection profiles (llm-agent-libs, src/collections/):` list: `StagedRetrieval`, `ComposedToolsProfile` + `mcpToolsVariants` (baseline / faceted / faceted-cohere / faceted-jev / small-set-jev), `SharedItemsProfile`, the generic strategies (`ItemPool`, `MaxScoreCollapse`, the four cuts, size estimators, facets, discriminators, intent indexers).
- In the retrieval-strategy section (~lines 228–275): one paragraph — a profiled `tools` store is a `StrategyRag` like any explicit strategy, so `RerankHandler` skips it; `rag.profiles` is server-wide like `rag.retrieval`, rejected in worker configs, not hot-reloadable; the server binds at store creation and the builder reuses the binding.
- In `## Architecture Principles` check (if the page keeps a per-feature compliance list): add the §16 summary of the spec in five lines (built on `IRetrievalStrategy`/`StrategyRag`; app is the example via YAML; interfaces; small new interfaces; everything a strategy; small modules).

- [ ] **Step 4: `docs/EXAMPLES.md` — after `### Per-store retrieval strategies (rag.retrieval)`, add:**

````markdown
### Collection profiles (`rag.profiles`)

**TL;DR.** Pick a default composition by name, or compose one from strategy names. Absent → 30.1.0.
A key may be under `rag.retrieval` **or** `rag.profiles`, not both.

Cohere on SAP AI Core — the `decision:` section's provider picks the reranker's model:

```yaml
decision:                         # ONE decision model per server
  provider: sap-aicore            # Cohere Rerank on SAP AI Core (typesafe = TypeSafe Jev)
  deploymentId: ${RERANK_DEPLOYMENT_ID}
  model: cohere-rerank            # sent as `model`
  resourceGroup: default
  credentialRef: AICORE           # AICORE_SERVICE_KEY; default ref DECISION → DECISION_SERVICE_KEY
rag:
  store: { type: in-memory }
  embedder: { provider: sap-ai-core, model: text-embedding-ada-002 }
  profiles:                       # only the key `tools` in this release
    tools:
      variant: faceted-cohere     # baseline | faceted | faceted-cohere | faceted-jev | small-set-jev | a registered name
      intents:
        record: { file: ./tool-intents.json }   # { "<tool name>": ["intent", …] }
```

Coarse / small tool set (Jev over the whole set, 3 tools):

```yaml
decision:
  provider: typesafe              # small-set-jev and faceted-jev need Jev
rag:
  profiles:
    tools:
      variant: small-set-jev
      smallSet: { poolItems: 25 }  # ≥ the store's tool count — checked at startup
```

Your own composition, every value a name:

```yaml
rag:
  profiles:
    tools:
      compose:
        indexer: { faceted: [summary, parameters] }   # name-tail is opt-in (verb-first names)
        pool: { items: 30 }
        collapse: max
        reranker: decision                            # none | decision | llm — decision = the decision: model (Jev or Cohere)
        question: tool                                # Jev / llm only; refused under Cohere (it reads no wording)
        cut: { fixed-items: 5 }                       # top-items | fixed-items | score-floor | token-budget
        onFailure: stage1                             # stage1 | error
```

- Your own strategies: register them on `SmartServerConfig.toolsVariantFactories` /
  `toolsStrategyFactories` (facets, discriminators, pools, collapse, cuts, estimators, decomposers) and
  name them here. A decomposer is never built in.
- `rag.profiles` is server-wide; a worker config must not declare it. In this release only the key
  `tools` (the server's own tools store) is accepted; any other key is refused at startup — bind other
  stores in code (`profile.bind({ key, rag })` + `builder.withRetrievalStrategy(key, bound.retrieval)`).
- A named variant must match `decision.provider`: `faceted-cohere` ↔ `sap-aicore`; `faceted-jev`,
  `small-set-jev` ↔ `typesafe`. `compose` with `reranker: decision` takes either.
````

And add a programmatic snippet (`builder.withToolsProfile(mcpToolsVariants.facetedJev({ decisionModel }))`) next to the existing builder example.

- [ ] **Step 5: `docs/TROUBLESHOOTING.md` — under `## Reranking`, add:**

````markdown
### A profiled store returns fewer items than k, or a reranker fallback you did not see

**Symptom.** With `rag.profiles`, a store returns fewer tools than expected, or the ranking looks like stage 1.

**Cause / fix.**

| Signal | Meaning | Fix |
|---|---|---|
| `retrievalOutcome{outcome=rerank_fallback}` / session step `retrieval_rerank_error` | the reranker failed or returned a wrong / duplicate / non-finite score set (`RERANK_ERROR`) — stage-1 order kept | check the reranker's credentials, deployment and model; a custom `IReranker` must return exactly its candidates |
| `outcome=orphan` | a record matched but its item's canonical record is gone (deleted item, interrupted replacement) | re-index the item; stale records are harmless — they are never returned |
| `outcome=decompose_error` | your `IQueryDecomposer` failed or its budgets summed above k | fix the decomposer |
| `outcome=over_budget` (with a `TokenBudgetCut`; span `cut.tokens` / `cut.budgetTokens`) | the top tool alone is larger than `budgetTokens` | size the budget ≥ your largest tool |
| `IndexReport.notes` / a startup warning `tool <name>: ambiguous-discriminator (a, b)` | `RequiredEnumDiscriminator` found several required enums and picked none | name the parameter: `NamedDiscriminator('<parameter>')` |
| `rerank_fallback` with `decision.provider: sap-aicore` | the `/rerank` call failed or answered wrongly (`DecisionError` → `RERANK_ERROR`): auth (`DECISION_SERVICE_KEY`), deployment id, resource group | check the service key and the deployment |

### Switching a profile on a persistent tools store

Turning a profile on, off, or changing its variant / intent placement on a persistent store (Qdrant,
pg-vector, HANA) needs a **fresh collection** (redeploy), like an embedder change: profile records and
30.1.0 records sit side by side otherwise. Every record carries `metadata.profile` for diagnosis.
In-memory stores are rebuilt every boot and need nothing.
````

- [ ] **Step 6: `docs/DEPLOYMENT.md`, `docs/SECURITY_THREAT_MODEL.md`, `docs/QUICK_START.md`**

- `DEPLOYMENT.md` `## Per-store reranking (rag.retrieval)` (~line 400): next to the TypeSafe paragraph, add Cohere on SAP AI Core — `decision.provider: sap-aicore` with `deploymentId`, `model`, `resourceGroup?`; the credential is a SAP AI Core **service key** in `DECISION_SERVICE_KEY` (or `<REF>_SERVICE_KEY` with `decision.credentialRef`, e.g. `AICORE` to share the LLM's account), exchanged for a bearer token by `sap-aicore-auth`; one `/rerank` call per batch. Then a sub-section `### Collection profiles (rag.profiles)` — only the key `tools`, server-wide, not hot-reloadable, worker configs rejected, a named variant must match `decision.provider`, `small-set-jev` startup check, and the fresh-collection rule for persistent stores.
- `SECURITY_THREAT_MODEL.md`, AS-7 (external rerankers): add Cohere on SAP AI Core — `decision.provider: sap-aicore` (for `faceted-cohere`, `compose` with `reranker: decision`, or `rag.retrieval` with `reranker: decision`) sends the query and the candidate tool texts to the SAP AI Core deployment named in `decision:`; opt-in. Add: shared items store whatever the writer puts in `text` / `data`; redaction is the writer's; user partitions are read with the request's `userId` and skipped without one.
- `QUICK_START.md` "Optional: per-store reranking": one short paragraph + link to EXAMPLES `#collection-profiles-ragprofiles` for multi-record tools stores.

- [ ] **Step 7: `README.md` and package READMEs**

- `README.md` `### RAG is a composition, not a backend`: add a bullet —
  `- **Collection profiles** — per kind of collection, how it is filled and searched: several records per tool, collapse to items, a reranker on the provider text, a cut counted in items. Default compositions for fine-grained and small tool sets; compose your own from strategies. Off by default ([INTEGRATION.md](docs/INTEGRATION.md#collection-profiles)).`
- `README.md` Packages table: add after `typesafe-decision`:
  `| [`@mcp-abap-adt/sap-aicore-decision`](packages/sap-aicore-decision/README.md) | Decision model provider — Cohere Rerank on SAP AI Core (`SapAiCoreDecisionModel`, an `IDecisionModel`). |`
- `README.md` `### Decision models` (~line 148): two sentences + the YAML lines — there are two providers: `typesafe` (Jev) and `sap-aicore` (Cohere Rerank on SAP AI Core: yes/no questions with a passage only; `deploymentId`, `model`, `resourceGroup?`; default ref `DECISION` → `DECISION_SERVICE_KEY`). Either serves `reranker: decision` in `rag.retrieval` and the decision variants of `rag.profiles`.
- `packages/llm-agent/README.md`: list the new contracts (`ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IIndexNoteSource`, `ISizeBoundedCut`, `recordId`, `RecordOwner`, `ToolItem`, `SharedItem`, `IRetrievalMetrics`, `IRetrievalEmbedderOwner`, `retrievalEmbedderOf`, `skillNameFromRecord`) and the `./testing/collection-profile-conformance` entry.
- `packages/llm-agent-libs/README.md`: add to the export list `StagedRetrieval`, `ComposedToolsProfile`, `mcpToolsVariants`, `SharedItemsProfile`, `bindToolsProfile`, `toolsBindingOf`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `ToolDefinitionSizeEstimator`, `CharsPerTokenEstimator`, `toolItemFromTool`, `checkRerankOutput`; `SmartAgentBuilder.withToolsProfile`; `testing`: `evaluateRetrieval`.
- `packages/llm-agent-server-libs/README.md`: `rag.profiles` (key `tools`), `decision.provider: sap-aicore` (the existing `BuildAgentDeps.makeDecisionModel` seam builds it — a custom composition root adds a `sap-aicore` arm), `toolsVariantFactories` / `toolsStrategyFactories`, `resolveCollectionProfiles`.
- `packages/llm-agent-server/README.md`: the binary's `makeDecisionModel` builds `SapAiCoreDecisionModel` for `decision.provider: sap-aicore` (default credential ref `DECISION` → `DECISION_SERVICE_KEY`, a SAP AI Core service key) and ships `@mcp-abap-adt/sap-aicore-decision`.
- `packages/typesafe-decision/README.md`: one line — TypeSafe Jev is one of two shipped decision models; the other is `@mcp-abap-adt/sap-aicore-decision` (Cohere on SAP AI Core).

- [ ] **Step 8: Example config**

In `examples/docker-sap-ai-core/smart-server.yaml`, append a commented block (comments only — the example keeps running unchanged):
```yaml
# Collection profiles (optional) — see docs/EXAMPLES.md#collection-profiles-ragprofiles
# decision:
#   provider: sap-aicore            # Cohere Rerank on SAP AI Core
#   deploymentId: ${RERANK_DEPLOYMENT_ID}
#   model: cohere-rerank
#   credentialRef: AICORE           # AICORE_SERVICE_KEY
# rag:
#   profiles:
#     tools: { variant: faceted-cohere }
```

- [ ] **Step 9: Verify nothing still describes the deleted contract or the old behaviour as current**

Run:
```bash
git grep -n "IToolIndexingStrategy\|OriginalToolIndexing\|SynonymToolIndexing\|IntentToolIndexing" -- README.md docs packages examples ':!docs/superpowers'
git grep -n "collection-profiles\|#collection-profiles" -- README.md docs | head
```
Expected: the first prints nothing outside `CHANGELOG.md` history; the second shows the new anchors are linked. Open each linked anchor once to confirm it resolves (`## Collection profiles` → `#collection-profiles`; `### Collection profiles (\`rag.profiles\`)` → `#collection-profiles-ragprofiles`).

- [ ] **Step 10: Commit**

```bash
git add README.md docs packages/llm-agent/README.md packages/llm-agent-libs/README.md packages/llm-agent-server-libs/README.md packages/llm-agent-server/README.md packages/typesafe-decision/README.md examples/docker-sap-ai-core/smart-server.yaml
git commit -m "docs: collection profiles across README, architecture, integration, performance, examples, troubleshooting, deployment, security

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 34: CHANGELOG, migration notes, `CLAUDE.md`

Spec §13. No version heading and no bump — the entry goes under `## [Unreleased]`; the release step turns it into a version.

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `CLAUDE.md` (architecture list, key API notes, key layers, environment)

- [ ] **Step 1: `CHANGELOG.md` — under `## [Unreleased]`:**

```markdown
### Added

- **Collection profiles** — how one kind of collection is filled AND searched, chosen by the consumer as injected strategies. `@mcp-abap-adt/llm-agent`: `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IndexReport`, `RecordDraft` / `IndexedRecord`, `RecordOwner`, `ItemRef`, `recordId` (owner-scoped physical ids, `h:`+sha256 above 200 characters), `ICandidatePool`, `ICollapseRule`, `IItemCut`, `IItemSizeEstimator`, `ISizeBoundedCut` (+ `isSizeBoundedCut`), `IIndexNoteSource` (+ `isIndexNoteSource`, `IndexNote`), `IQueryDecomposer`, `ISourceSelector`, `RetrievalSource`, `ToolItem`, `IToolFacet`, `IDiscriminatorSelector`, `IToolIntentSource`, `SharedItem`, `ISharedItemGroups`, `SharedItemsStores`, `IRetrievalMetrics` (+ `isRetrievalMetrics`), `IRetrievalEmbedderOwner` (+ `retrievalEmbedderOf`), `skillNameFromRecord`; conformance kit `@mcp-abap-adt/llm-agent/testing/collection-profile-conformance`. `@mcp-abap-adt/llm-agent-libs`: `StagedRetrieval` (an `IRetrievalStrategy`: candidates counted in items → collapse → reranker on provider text → hydration from the canonical record → one cut), `ComposedToolsProfile`, `mcpToolsVariants` (`baseline`, `faceted`, `faceted-cohere`, `faceted-jev`, `small-set-jev`), `SharedItemsProfile`, `bindToolsProfile` / `toolsBindingOf`, the strategies (`ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `ToolDefinitionSizeEstimator`, `CharsPerTokenEstimator`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet` (opt-in), `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`), `checkRerankOutput`, `SmartAgentBuilder.withToolsProfile`, and `evaluateRetrieval` in `/testing`. See README "RAG is a composition", `docs/INTEGRATION.md#collection-profiles`, `docs/PERFORMANCE.md#collection-profiles`.
- **New package `@mcp-abap-adt/sap-aicore-decision`** — `SapAiCoreDecisionModel`, Cohere Rerank on an SAP AI Core deployment as an `IDecisionModel`: yes/no (`noul`) questions with a passage, answered with the passage's `relevance_score` in ONE `/rerank` call per decision request; any other question type is `DECISION_UNSUPPORTED_QUESTION`; a wrong / duplicate / out-of-range answer is a `DecisionError`, never zero-filled. Used by the existing `DecisionReranker` — no new reranker contract. Credential injected (a SAP AI Core service key via `sap-aicore-auth`), no env, no timeout, no retries. Published at the same version, before the server.
- **SmartServer:** `rag.profiles.tools` (`variant` or `compose`, `intents`, `decomposer`, `smallSet.poolItems`; only the key `tools` in this release) and `decision.provider: sap-aicore` (`deploymentId`, `model`, `resourceGroup?`; default credential ref `DECISION` → `DECISION_SERVICE_KEY`), built by the existing `makeDecisionModel` seam; `SmartServerConfig.toolsVariantFactories` / `toolsStrategyFactories` for your own names. Startup refuses a `rag.profiles` key other than `tools`, a key under both `rag.retrieval` and `rag.profiles`, unknown names, a named variant whose `decision.provider` is the other model, a question / task under Cohere, and `small-set-jev` whose `poolItems` is below the listed tool count.
- **Observability:** `retrievalOutcome` counter (`ok`, `rerank_fallback`, `rerank_error`, `decompose_error`, `orphan`, `over_budget`, `empty`) on `InMemoryMetrics` / `NoopMetrics` and in `/health` metrics; a `retrieval` span per profiled retrieval; `/health` `components.toolCatalog.records` / `.profile` under a profile. `RerankedRetrieval` / `RerankAllRetrieval` accept an optional `telemetry` (additive).
- `scripts/rag-eval`: profile arms (`--variant`, or `--indexer` / `--facets` / `--discriminator` / `--max-values` / `--intents` / `--pool-items` / `--reranker none|decision`, `--decision-provider typesafe|sap-aicore` + `--rerank-deployment` / `--rerank-model` / `--rerank-credential-ref` / `--cut` / `--budget-tokens`), required-recall (`required` in the queries file: an AND of OR-groups), average items and prompt tokens.

### Fixed

- `vectorizeMcpTools` found no batch embedder behind `StrategyRag` (any `rag.retrieval.tools` entry) or `FallbackRag` and wrote the catalog one tool at a time; stores now declare `IRetrievalEmbedderOwner` (`VectorRag`, `QdrantRag`, `PgVectorRag`, `HanaVectorRag`) and the private-field read is gone (F1).
- `tools-rag-handle` returned a tool twice when two of its records matched (F2); `skill-select` read `skill:<name>:<suffix>` as the name `<name>:<suffix>` (F3).

### Removed

- `packages/llm-agent/src/rag/tool-indexing-strategy.ts` (`IToolIndexingStrategy`, `OriginalToolIndexing`, `IntentToolIndexing`, `SynonymToolIndexing`) — never exported, never wired. Its docs described it as usable; they now describe collection profiles.

### Migration

- **Nothing changes unless you opt in.** No profile → the same records (pinned by a golden test), stages, k and YAML as before.
- **Opting in on a persistent tools store** (Qdrant, pg-vector, HANA) needs a fresh collection — profile records sit beside 30.1.0 records otherwise. In-memory stores need nothing.
- **Under a profile, `rag.getById(itemId)` on the raw store finds nothing** — records are addressed by owner-scoped ids; use `bound.get({ itemId, owner })`. Returned items keep `metadata.id = itemId`, so name-based consumers are unaffected.
- **k counts items under a profile**; a default composition with `FixedItemsCut` owns its k (the caller's k does not undo the measured cut).
- **`ToolCatalogStatus` gains optional `records` / `profile`**, `MetricsSnapshot` optional `retrievalOutcome`, `HealthComponentStatus.toolCatalog` optional `records` / `profile` — an exhaustive object literal of these types needs no change.
- **`SmartServerDecisionConfig.provider` gains `'sap-aicore'`** (plus optional `deploymentId`, `resourceGroup`). Your own composition root's `makeDecisionModel` compiles unchanged; to serve Cohere, add a `sap-aicore` arm that builds `SapAiCoreDecisionModel` from a bearer credential and `apiBaseUrl` (the shipped binary does).
- **Intents are generated at every indexing** — the framework does not cache them; use a `StaticIntentSource` over a file generated at deploy, or your own caching `IToolIntentSource`.
- If you imported `tool-indexing-strategy.ts` by deep path: use `FacetedToolIndexer` (`full` record) and `IntentRecordIndexer` / `IntentCompanionIndexer` with `LlmIntentSource` instead.
```

- [ ] **Step 2: `CLAUDE.md`**

- `## Architecture` provider paragraph: after the `typesafe-decision` paragraph add — `@mcp-abap-adt/sap-aicore-decision` is a provider package (`SapAiCoreDecisionModel`, Cohere Rerank on SAP AI Core as an `IDecisionModel`, used by `DecisionReranker`): peers on `llm-agent` and `interfaces-auth`, a regular dependency of `llm-agent-server`; the binary's `makeDecisionModel` builds it for `decision.provider: sap-aicore`.
- `### Key API notes`: add —
  `- Collection profiles: builder.withToolsProfile(profile) or YAML rag.profiles.<key> (variant | compose); a key is under rag.retrieval OR rag.profiles. Under a profile k counts items, every returned item is its canonical record, and records are addressed by recordId(owner, itemId, kind, n) — never by the bare itemId`.
- `### Key layers` table, `llm-agent-libs` row: append `, collection profiles (StagedRetrieval, ComposedToolsProfile, mcpToolsVariants, SharedItemsProfile)`.
- `## Environment` table: add `| DECISION_SERVICE_KEY | SAP AI Core service key of the decision: section with provider: sap-aicore and no credentialRef (Cohere Rerank); read only when a decision reranker builds the model |`, and widen the `DECISION_API_KEY` row's wording to "provider: typesafe".

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: changelog and migration notes for collection profiles; CLAUDE.md key API notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 35: Final verification gate (no commit unless something is fixed)

- [ ] **Step 1: Full gate, exactly as CI runs it**

Run (repo root):
```bash
npm run lint:check
npm run build
npm run typecheck
npm test
```
Expected: all exit 0.

- [ ] **Step 2: Default behaviour unchanged**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts`
Expected: PASS (the golden file is the one committed in Task 1 — `git log --oneline -- packages/llm-agent-libs/src/__tests__/fixtures/baseline-tool-records.golden.json` shows exactly one commit).

- [ ] **Step 3: Dependencies — workspace siblings only**

Run:
```bash
grep -n '"link": true' package-lock.json
git grep -n '"file:\|"link:\|"workspace:' -- 'packages/*/package.json' package.json
```
Expected: `"link": true` only for `node_modules/@mcp-abap-adt/<sibling>` entries resolving into `packages/`; the second grep prints nothing.

- [ ] **Step 4: Gates and spec coverage**

- Spec issues S1–S9 are decided (spec §17.4) and done in their tasks (Tasks 3, 6, 9, 10, 11, 15, 19, 21, 23, 28, 29, 30); a new gap found while executing was taken to the user before any code (fix the spec before the plan).
- No reference to the withdrawn design is left: `git grep -n -i "crossEncoder\|cross-encoder\|sap-aicore-reranker\|SapAiCoreReranker\|makeCrossEncoder\|CROSS_ENCODER" -- packages docs README.md CLAUDE.md examples scripts ':!docs/superpowers'` prints nothing (the pre-existing `### Example: Cross-encoder reranker via external API` heading in `docs/INTEGRATION.md` is the one allowed hit).
- The spec's §14.3 acceptance runs are the consumer check (env-gated, not `npm test`); list them in the PR description as the next stage. Do **not** delete the spec or this plan: they stay until the work, consumer check included, is fully implemented (CLAUDE.md "Plans and Specs").
- No version bump, no tag, no publish.

- [ ] **Step 5: Push**

```bash
git push
```

---

## Spec issues — decided by the user on 2026-10-05

Found while planning; all decided (spec §17.4) and written into the tasks above — no step is gated.

| # | Issue | Decision | Done in |
|---|---|---|---|
| S1 | No channel from an indexer to `IndexReport.notes` | Optional capability `IIndexNoteSource` (`notesFor(item)`); the binding collects notes; the server logs them | Tasks 3, 9, 10, 15, 19 |
| S2 | "Fill once" intents needed the store inside a pure indexer | Dropped: intents are generated at indexing; caching is the consumer's concern; `generatedFrom` stays as provenance | Task 10 |
| S3 | `ToolCatalogStatus` missing from spec §3.8 | Optional `records` / `profile` on `ToolCatalogStatus`, listed in §3.8 | Tasks 3, 19, 29 |
| S4 | Output check on the 30.1.0 rerank strategies? | No — telemetry only, no 30.1.0 behaviour change | Task 29 |
| S5 | Default `credentialRef` of `crossEncoder:` | Dropped with `crossEncoder:` — Cohere is `decision.provider: sap-aicore`, default ref `DECISION` → `DECISION_SERVICE_KEY` | Tasks 21, 24 |
| S6 | `StagedRetrieval` could not learn a size cut's tokens | Optional capability `ISizeBoundedCut` (`budgetTokens`, `estimator`), implemented by `TokenBudgetCut` | Tasks 3, 6, 28 |
| S7 | `remove` left companion records behind | Reserved key `companionRecordIds` on the canonical record; `remove` and replacement clear companion records | Tasks 2, 11, 15 |
| S8 | YAML keys other than `tools` had no store or filling path | Only `rag.profiles.tools`; any other key refused at config resolution (and at server start for a config built in code) | Tasks 21, 23 |
| S9 | "At most k" contradicted `FixedItemsCut` | The kit checks at most `cut.limit(k)` items | Task 30 |
| — | Spec header "Status" line | Updated: every decision is taken (D16, D18, D22, D23 included) | spec header |

**Cohere on SAP AI Core** (goal decision 2026-10-05): one more `IDecisionModel` — `SapAiCoreDecisionModel` in the new package `@mcp-abap-adt/sap-aicore-decision` (Task 18), used by the existing `DecisionReranker` (Tasks 16, 22, 24). The former `sap-aicore-reranker` package, `SapAiCoreReranker`, the `crossEncoder:` section and the `makeCrossEncoder` seam are gone from the plan.

**Choices made while writing these in** are listed for the user's review in spec §17.5 (one `SmartServerDecisionConfig` interface with optional fields; named variants checked against `decision.provider`; a question / task refused under Cohere; non-text state → `DECISION_UNSUPPORTED_QUESTION`; a score outside [0, 1] → `DECISION_ERROR`; no peer on `sap-aicore-auth`). One stays open for the user: whether answering a `noul` question with the passage's relevance while not reading `task` / `criteria` fully meets `IDecisionModel`'s "answers are never faked" (spec §17.5).

---

## Self-review (done while writing)

- **Spec coverage.** §3 contracts → Tasks 2–4 (S1 / S6 capabilities and the S7 reserved key in 2–3); §4 `StagedRetrieval` → 12–14 (+28 telemetry, incl. `over_budget`); §4.9/§4.10 cuts → 6; §5 rerankers → 18 (`SapAiCoreDecisionModel`), 16 (both decision variants), 24 (the composition root's `sap-aicore` arm + batches → `/rerank` calls); §6.1 builder → 20; §6.2 YAML → 21–23 (no new seam); §7.0–§7.5 tools strategies and variants → 7–10, 15, 16; §7.6 filling → 19 (notes logged); §7.7 skills pass-through → 12 (pass-through test), 26 (F3); §7.8 migration → 33/34 docs; §7.9 consumer-built profile → 30; §8 shared items → 17; §9 observability → 28–29 (S4: telemetry only on 30.1.0 strategies); §10 fixes → 25–27; §11 placement → File Structure, Task 18 wiring; §13 compatibility/docs → 1 (golden), 33–34; §14.1 unit tests → per task; §14.2 kit → 30 (S9); §14.3 harness → 31–32 (acceptance runs = consumer check, env-gated).
- **Placeholders.** None; no gated step remains.
- **Type consistency.** `StagedRetrievalOptions` (Task 12) is the shape Tasks 15–17, 22 and 30 pass; `ComposedToolsProfile.composition` (Task 15) is what Tasks 16, 22, 30 inspect; `IBoundCollection<ToolItem>` + `bindToolsProfile` / `toolsBindingOf` (Task 15) are what Tasks 19, 20, 23 use; `ToolCatalogStatus.records/profile` (Task 3) feed Tasks 19 and 29; `RunStats` (Task 12) is what Task 28 reports; `CompanionIds` / `listedCompanions` / `oldCompanions` (Task 11) are what Task 15 uses; `SapAiCoreDecisionConfig` (Task 18) is what Task 24 constructs; `SmartServerDecisionConfig` (Task 21) is what Tasks 22 and 24 read; `mcpToolsVariants.facetedCohere({ decisionModel })` (Task 16) is what Tasks 22 and 32 call.
- **Review Focus.** Each of the five lines has its test in the named task (Tasks 6, 12, 13, 14, 17, 18).
