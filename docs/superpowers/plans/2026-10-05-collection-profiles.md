# Collection Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every kind of RAG collection an injected indexing + retrieval pair (a *collection profile*): several owner-scoped records per item, collapse back to items, an optional reranker on provider text, a final cut counted in items — with 30.1.0 behaviour unchanged when no profile is set.

**Architecture:** Contracts land in `@mcp-abap-adt/llm-agent` (`src/interfaces/collection-profile.ts`); generic strategies, `StagedRetrieval` (an `IRetrievalStrategy`), `ComposedToolsProfile`, the default compositions (`mcpToolsVariants`) and `SharedItemsProfile` land in `@mcp-abap-adt/llm-agent-libs` (`src/collections/`); the decision contracts split — `IProbabilityDecision` (today's `IDecisionModel`, renamed, alias kept) and the new `IRelevanceDecision`; every reranker moves to the new vendor-neutral package `@mcp-abap-adt/llm-agent-reranker` (`ProbabilityReranker` = today's `DecisionReranker`, the new `RelevanceReranker`, `LlmReranker`, `NoopReranker`; libs keeps the old names as deprecated aliases); a new provider package `@mcp-abap-adt/sap-aicore-decision` ships `SapAiCoreRelevanceDecision` (Cohere Rerank on SAP AI Core as an `IRelevanceDecision`); `SmartAgentBuilder.withToolsProfile` and the server's `rag.profiles` YAML plus `decision.provider: sap-aicore` (server-libs; one `decision:` section, the provider decides the kind) wire them; the released probability seam `BuildAgentDeps.makeDecisionModel` is renamed `makeProbabilityDecision` (deprecated alias kept; both supplied → startup error) beside the new `makeRelevanceDecision`; the binary's `createMakeDecisionModel` becomes `createMakeProbabilityDecision` and it gains `createMakeRelevanceDecision`.

**Tech Stack:** TypeScript 6 (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome, npm workspaces monorepo.

**Spec:** `docs/superpowers/specs/2026-10-05-collection-profiles-design.md` (approved 2026-10-05, frozen; amended 2026-10-05 with the user's decisions on S1–S9, spec §17.4, and on probability vs relevance decisions, the reranker package, the caller's k, cleanup failures and provider text composition, spec §17.6; and on relevance comparability, the second seam and the seam rename, spec §17.7; and on the server filling a bound tools profile from ready clients, D31, spec §6.3, §17.8; and on filling following the store's lifecycle, D34–D35, spec §17.9; and on only complete fills memoized, single-flight worker construction, the startup fill on every path, the direct hot-reload test and runtime-removed tools, D36–D40, spec §6.6, §17.10 — D36 superseded and D37 moved out by the next amendment; and on a tools store filled once at instance creation, the fill source as an injected strategy, the offline corpus API, refill and single-flight out, D41–D45, spec §3.10, §6.3–§6.5, §17.11). **Goal:** `docs/superpowers/goals/2026-10-04-collection-profiles.md` (user-owned; never edited). Executors read the spec section each task cites.

## Global Constraints

- **Nothing changes by default.** No profile set → 30.1.0 behaviour byte for byte: same records (golden test, Task 1), same stages, same k, same `RerankHandler` precedence, same YAML (spec §13).
- **All contract changes additive or aliased.** `IRag`, `IReranker`, `IRetrievalStrategy`, `IMetrics` are not changed (spec §3). Renames (`IDecisionModel` → `IProbabilityDecision`, `DecisionReranker` → `ProbabilityReranker`, `wrapDecisionModel` → `wrapProbabilityDecision`, `DECISION_RERANK_DEFAULT_*`, `BuildAgentDeps.makeDecisionModel` → `makeProbabilityDecision`) keep the old names exported as **deprecated aliases** until the next major (the seam alias: both supplied → startup error naming both, spec §3.8, D30); moved rerankers stay importable from libs (spec §13). The only removal is the unexported `packages/llm-agent/src/rag/tool-indexing-strategy.ts` (spec §10.3).
- **A probability and a relevance are different decisions.** A relevance score is never read as a probability: no [0, 1] check on it, no default threshold on it (spec §3.9, §5). It is comparable for the same query and model, also across calls, so `RelevanceReranker` batches by default like `ProbabilityReranker` (spec §3.9, §5.2, D28).
- **Failure handling, not concurrency.** A failed stale delete is kept (`staleRecordIds`) and retried; no generations, no locks for RAG (spec §3.3, D13). Concurrent writes to a persistent store — in one process or across processes — are the backend's responsibility; nothing in this plan serializes them. The deploy step's write-ahead service record (Task 19A) is failure handling of one step, not a lock. Single-flight worker construction is **not** in this plan (D45: a separate issue, spec §15).
- **Owner in every physical id.** Every profile record id is `recordId(owner, itemId, kind, n)`; no code path addresses a record by the bare `itemId` (spec §3.1).
- **Components carry no tuned number.** Pool sizes, k, `budgetTokens`, `maxValues` are required constructor arguments; tuned numbers live only in `mcpToolsVariants`, each next to its measurement (spec §7.1).
- **`k` is the overall limit, in items.** The caller's k caps every cut: a retrieval never returns more than `min(k, cut.limit(k))` ≤ k items, with or without a decomposer; `FixedItemsCut(n)` is a ceiling (spec §4.5, §4.9, §17.6 F1).
- **Filled once, at instance creation; the source is the consumer's strategy.** Every tools write reads the binding **and its fill source** from the store it writes (`boundToolsOf` / `toolsBindingOf`) — never from an option (spec §6.3 rule 1, D34, D42); whoever creates a bound store fills it, once — the main store in `_buildInfra`, a worker's own store by its construction (`buildSubAgent` without `injected`), so lazy rebuilds after `PUT /v1/config` / hot reload are filled too (rule 2, D35); workers on the shared clients are filled at startup on every path — on `yamlBuilderConnect` right after the harvest (D38). **Never refilled while running** (D41): no refill API, no fill memo, no retry, a per-session re-wire never fills; an incomplete fill is reported and stays. `toolsChanged` is the source's answer (D44): `live` / `consumer` re-index as 30.1.0, `corpus` / `prebuilt` write nothing. The four sources: `LiveToolsFill` (default), `ToolsCorpusLoader` (in-memory, a corpus built at build time, no embedding call), `PrebuiltToolsStore` (persistent, written by the consumer's deploy step, never by the process), `ConsumerToolsFill`. Every fill path is listed in spec §6.4; a new one must say which mechanism fills it.
- **Never silent.** Reranker output errors, decomposer errors, orphans and over-budget cuts are returned or counted (spec §4.8, §4.5, §4.6, §4.10, §9).
- **Shipped tools strategies read only what every MCP server exports** (name, description, input schema); `NameTailFacet` is opt-in and in no variant; `EnumValueToolIndexer` and `TokenBudgetCut` are in no variant (spec §7.0, §7.4).
- **ESM only**, `.js` extensions in relative imports; Biome style (2 spaces, single quotes, semicolons); no `any` (Biome warns); no per-file licence header; every package `LGPL-3.0-only` (spec §11).
- **Library packages declare `@mcp-abap-adt/*` as peers** (`test/repo/scoped-dependencies.test.ts`); only `@mcp-abap-adt/llm-agent-server` takes regular deps.
- **Workspace siblings only.** The new packages (`llm-agent-reranker`, `sap-aicore-decision`) are linked as workspace siblings during development; no `file:` / `link:` to anything outside this repo. After any `npm install`, `grep -n '"link": true' package-lock.json` must list only `packages/*` siblings.
- **No version bumps, no `npm publish`, no tag** in this plan — the user publishes; release is a separate step. The new packages' `version` is the current lockstep `30.1.0` (not a bump) so the workspace resolves. Publish order (the release's job): `llm-agent` → `llm-agent-reranker` → `typesafe-decision`, `sap-aicore-decision`, … → `llm-agent-libs` → `llm-agent-server-libs` → `llm-agent-server`.
- **Imports between packages resolve to `dist/`.** After editing a package another package imports, rebuild it before running the dependent's tests: `npx tsc -b packages/<pkg>` (or `npm run build`).
- **Spec issues S1–S9 are decided** (spec §17.4), and so are D24–D27, F1, F3, F4 (spec §17.6) and D28–D30 (spec §17.7: relevance scores comparable per query and model → batching by default; the second seam `makeRelevanceDecision` approved; `makeDecisionModel` → `makeProbabilityDecision`) and D31–D33 (spec §17.8: the server fills a bound tools profile from the clients it uses, Task 23A) and D34–D35 (spec §17.9: the binding travels with the store; whoever creates a bound store fills it — Tasks 19, 23A) and D38–D40 (spec §17.10: startup fill on every path; the hot-reload test through the reload entry point; runtime-removed tools stay — Task 23A; D36 is superseded and D37 moved out, below) and D41–D45 (spec §17.11: filled once at instance creation, no memo, no retry — Task 23A; the fill source strategy — Tasks 19, 20, 23B; the offline corpus API and the `serviceRecord` key — Tasks 2, 11, 12, 19A; `toolsChanged` by source — Tasks 19, 19A; single-flight construction out — Task 22A deleted, no task depends on it); all are written into the tasks below; no step waits on the user. A NEW gap found while executing goes to the user first — the rule is *fix the spec before the plan*.
- Commits: Conventional Commits, each ending with
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd
  ```

## Review Focus

The eight inputs the spec implies, most likely to bite a user, each pinned by a test in its owning task:

1. **Identical `itemId`s across owners** (users A and B both write `case-42` into one `user` store) — two separate items: A's `get` returns A's text and `data`, B's re-index and `remove` leave A untouched, A's retrieval returns only A's item. → Task 17 (`identical item ids across users stay separate`), Task 12 (`collapse keys on the owner-qualified item`).
2. **Canonical record missing** (deleted item, interrupted replacement) — the hit is dropped, never returned with its own text, does not use up k, and is counted. → Task 12 (`a hit without its canonical record is an orphan`), Task 28 (`orphan counted`).
3. **Decomposer overrunning the budget** (Σk > budget, a `k < 1`, empty text, a thrown error) — `DECOMPOSE_ERROR` returned, never a silent fall-back, never more than `budget` items. → Task 14 (`budgets summing above the budget are a DECOMPOSE_ERROR`).
4. **Reranker returning the wrong score count** (fewer/more results, a duplicate, a non-finite score) — `RERANK_ERROR`; `stage1` keeps the stage-1 order, `error` returns the error. → Task 13 (`a reranker that drops a candidate is a RERANK_ERROR`), Task 4C (`RelevanceReranker`: wrong count / duplicate / out-of-range / non-finite → `RERANK_ERROR`), Task 18 (`SapAiCoreRelevanceDecision`: a wrong `/rerank` result is a `DecisionError`, never zero-filled).
5. **A tool definition larger than the token budget** (top item alone over budget) — empty result, never truncated, never replaced by a smaller lower-ranked tool. → Task 6 (`the top item alone over budget gives an empty result`).
6. **A caller's k below a profile's own cut** (k=2 against `FixedItemsCut(5)`) — at most 2 items, also after decomposition. → Task 6 (`FixedItemsCut is a ceiling`), Task 12 (`a consumer cut whose limit ignores k is still capped`), Task 14, Task 30 (`a caller k below the profile's own default cut`).
7. **A stale-record delete that fails** during a replacement — the item is `cleanup-failed`, never indexed; the id stays listed and the next `index` / `remove` deletes it. → Task 11 (`replacement → failed stale delete → … → remove leaves nothing`), Task 15, Task 30.
8. **Two score scales in one result** (`keepStage1Top` pins stage-1 items beside reranked ones; a failed rerank falls back to stage 1) — a pinned item carries its reranked score, never its embedding score, under a probability and a relevance reranker; the `stage1` fallback returns stage-1 ids and scores; `keepStage1Top` + `ScoreFloorCut` and `ScoreFloorCut` + `onFailure: 'stage1'` are refused with their messages. → Task 13 (`a pinned item carries its RERANKED score …`, `a failed rerank under 'stage1' with keepStage1Top …`, the two rejection cases), Task 21 (`compose: score-floor with a reranker needs onFailure: error`).

## File Structure

**`packages/llm-agent/src/`** (contracts)
- `interfaces/collection-profile.ts` — NEW: every contract of spec §3.1–§3.6 + `recordId`, `isRetrievalMetrics`.
- `interfaces/decision-model.ts` — `IProbabilityDecision` (+ deprecated `IDecisionModel` alias), `IRelevanceDecision`, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore` (spec §3.9, Task 4A).
- `interfaces/retrieval-embedder-owner.ts` — NEW: `IRetrievalEmbedderOwner`, `retrievalEmbedderOf` (spec §3.7).
- `interfaces/tools-fill-source.ts` — NEW: `IToolsFillSource`, `ToolsFillContext` (spec §3.10, Task 19).
- `interfaces/index.ts` — export the above.
- `interfaces/health.ts`, `interfaces/metrics.ts`, `interfaces/tool-catalog.ts` — additive optional fields (spec §3.8; `ToolCatalogStatus.records` / `.profile` per S3).
- `interfaces/tool-record-key.ts` — `skillNameFromRecord` (F3).
- `rag/vector-rag.ts` — implements `IRetrievalEmbedderOwner`.
- `rag/tool-indexing-strategy.ts` — DELETED.
- `testing/collection-profile-conformance.ts` — NEW conformance kit; `package.json` `exports` entry.

**`packages/llm-agent-reranker/`** — NEW package (Tasks 4B–4C): `src/probability-reranker.ts` (moved from libs `reranker/decision-reranker.ts`), `src/relevance-reranker.ts`, `src/llm-reranker.ts`, `src/noop-reranker.ts` (moved), `src/assert-positive-integer.ts` (copy), `src/index.ts`, tests; `package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `GPL-3.0.txt`. libs' `src/reranker/` is removed; libs re-exports the names (deprecated).

**`packages/llm-agent-libs/src/collections/`** (NEW directory, small modules)
- `owner.ts` — owner ↔ metadata flattening, item keys.
- `item-pool.ts`, `max-score-collapse.ts`, `cuts.ts`, `token-budget-cut.ts`, `size-estimators.ts` — generic strategies.
- `tools/derive-tool-facets.ts`, `tools/tool-item.ts`, `tools/facets.ts`, `tools/tool-text.ts` (provider text composers, F4), `tools/faceted-tool-indexer.ts`, `tools/discriminators.ts`, `tools/enum-value-tool-indexer.ts`, `tools/intent-sources.ts`, `tools/intent-indexers.ts` — tools indexing.
- `record-writer.ts` — id assignment, batch embed + write, replacement, `get`, `remove`.
- `rerank-check.ts`, `staged-retrieval.ts` — the retrieval half.
- `composed-tools-profile.ts`, `tools-binding.ts` (the binding, its target and its fill source travel with the store, Tasks 15, 19), `mcp-tools-variants.ts` — tools profile.
- `tools/tools-fill-sources.ts` — `LiveToolsFill`, `ConsumerToolsFill` (Task 19), `ToolsCorpusLoader`, `PrebuiltToolsStore` (Task 19A).
- `tools/tools-corpus.ts`, `tools/corpus-capture-rag.ts` — the offline corpus: `buildToolsCorpus`, `parseToolsCorpus`, `deployToolsCorpus`, the corpus types, `TOOLS_CORPUS_RECORD_ID` (Task 19A).
- `shared-items-profile.ts` — shared items profile.
- `index.ts` — exports; re-exported from `src/index.ts`.
- `__tests__/*.test.ts`, `__tests__/collection-profile.typecheck.ts`.

**Other libs files:** `mcp/fill-tools-binding.ts` (NEW, Task 23A: `fillToolsBinding`), `adapters/usage-logging-decision-model.ts` (`wrapProbabilityDecision`, `wrapRelevanceDecision`, deprecated `wrapDecisionModel`), `index.ts` (deprecated reranker re-exports), `mcp/vectorize-mcp-tools.ts` (dispatches to the store's fill source; the live profile path, the binding read from the store — D34, D42, Task 19; F1), `mcp/tool-registry.ts` (`event: 'tools-changed'`; `mcp/tool-registry-revectorize-profile.test.ts` NEW, Task 19), `builder.ts` (`withToolsProfile`), `metrics/in-memory-metrics.ts`, `metrics/noop-metrics.ts`, `retrieval/reranked-retrieval.ts` (telemetry), `health/health-checker.ts` (`HealthCheckerDeps.toolCatalog`, Task 23A; records/profile, Task 29), `pipeline/handlers/skill-select.ts` (F3), `testing/evaluate-retrieval.ts` + `testing/index.ts`.

**`packages/sap-aicore-decision/`** — NEW package (`package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `GPL-3.0.txt`, `src/index.ts`, `src/sap-aicore-relevance-decision.ts`, `src/map-rerank.ts`, `src/__tests__/fake-fetch.ts`, `src/__tests__/sap-aicore-relevance-decision.test.ts`).

**`packages/llm-agent-server-libs/src/smart-agent/`** — `profiles-config.ts` (NEW: YAML types), `profiles-config-validator.ts` (NEW), `decision-config.ts` (`provider: 'sap-aicore'`, `DECISION_KINDS`), `decision-seams.ts` (NEW: the decision of the provider's kind → its reranker), `resolve-retrieval.ts` (kind dispatch), `resolve-config-sections.ts`, `config.ts`, `config-validator.ts`, `resolve-collection-profiles.ts` (NEW), `smart-server.ts` (`makeProbabilityDecision` seam + its deprecated alias `makeDecisionModel`, Task 20A; `makeRelevanceDecision` seam; binds `rag.profiles.tools`, Task 23; fills the main store once at startup and a worker's own store by its construction, D35, D41, Task 23A; `toolsFillFactories` and the bind with the configured fill source, Task 23B), `workers/worker-registry.ts` (descriptors and slot count to workers, Task 23A) + `workers/connected-mcp-server.ts` (NEW, Task 23A), `config-reload-watcher.ts` (`_onReload` awaitable, Task 23A), `__tests__/profile-fill-ready-clients.test.ts` (NEW, Task 23A, incl. `PUT /v1/config`, hot reload through the reload entry point, a re-wire never fills, a throwing fill leaves no cached worker; Task 23B: `fill: corpus` / `prebuilt`), `profiles-config.ts` / `profiles-config-validator.ts` / `resolve-collection-profiles.ts` (`fill`, Task 23B), `__tests__/config-reload-entry.test.ts` (NEW, Task 23A), `tools-rag-handle.ts` (F2); `package.json` (peer `llm-agent-reranker`).

**`packages/llm-agent-server/src/composition/`** — `make-relevance-decision.ts` (NEW: `createMakeRelevanceDecision`, the `sap-aicore` arm), `make-probability-decision.ts` (RENAMED from `make-decision-model.ts`, Task 20A: `createMakeProbabilityDecision`; names the other seam for `sap-aicore`, Task 24), `index.ts`, `__tests__/make-relevance-decision.test.ts` (NEW), `__tests__/make-probability-decision.test.ts` (RENAMED).

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

Spec §3.1 (incl. the reserved keys `companionRecordIds` — S7 — and `staleRecordIds` / `staleCompanionRecordIds` — F3).

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
  export type ReservedRecordKey = 'id' | 'itemId' | 'recordKind' | 'itemText' | 'profile' | 'generated' | 'recordIds' | 'companionRecordIds' | 'staleRecordIds' | 'staleCompanionRecordIds' | 'visibility' | 'userId' | 'groupId' | 'sessionId' | 'ttl' | 'serviceRecord';
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
 * `staleRecordIds` / `staleCompanionRecordIds` (canonical only): old ids a replacement
 * must still delete — this store / per companion; kept until a delete succeeds (F3).
 * `serviceRecord`: a store's service record (`deployToolsCorpus`, spec §6.5) — never an
 * item; `StagedRetrieval` drops a hit that carries it (spec §4.3, D43).
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
  | 'staleRecordIds'
  | 'staleCompanionRecordIds'
  | 'visibility'
  | 'userId'
  | 'groupId'
  | 'sessionId'
  | 'ttl'
  | 'serviceRecord';

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
// @ts-expect-error extras cannot set staleRecordIds (F3)
export const _staleExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { staleRecordIds: [] } };
// @ts-expect-error extras cannot set staleCompanionRecordIds (F3)
export const _staleCompanionExtra: RecordDraft = { text: 't', itemId: 'i', recordKind: 'full', owner: { scope: 'global' }, metadata: { staleCompanionRecordIds: {} } };
```

Add `"packages/llm-agent/src/interfaces/__tests__/collection-profile.typecheck.ts"` to `include` in `tsconfig.typecheck.json`. (Biome may reflow the one-line statements: run `npx biome check --write` on the file, then confirm each `@ts-expect-error` still sits directly above a single-line statement; if Biome splits one, add `// biome-ignore format: one statement per @ts-expect-error line` above that statement.)

- [ ] **Step 5: Run tests and the typecheck**

Run:
```bash
node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/record-id.test.ts
npm run typecheck
npx tsc -b packages/llm-agent
```
Expected: PASS; typecheck exit 0 (an unused `@ts-expect-error` would fail with TS2578); the build compiles `collection-profile.ts` and the new `interfaces/index.ts` export block (the typecheck file imports `../collection-profile.js` directly, never `index.ts`; the tsx test does not type-check).

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
  export interface IToolTextComposer { readonly name: string; compose(tool: ToolItem): string } // F4: the `full` text (spec §3.5, §7.3.1)
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

Add these imports at the top of the file, merging `IRag` into Task 2's `./rag.js` import (one import per module):
```ts
import type { ICounter } from './metrics.js';
import type { IRag, RagJsonValue } from './rag.js';
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
  /** An UPPER BOUND, in items, on what `cut` returns for `requestedK` — never above
   *  `requestedK` (the caller's k caps every cut, spec §4.9). The retrieval's budget.
   *  A cut may stop earlier; it never returns more than this. */
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

/** Composes the provider text of a tool — the canonical `full` record's text, also the
 *  reranker's item text and every non-canonical record's `itemText` (spec §3.5, §7.3.1).
 *  Provider words only. Non-empty; pure. */
export interface IToolTextComposer {
  readonly name: string;
  compose(tool: ToolItem): string;
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
  type IToolTextComposer,
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

## Task 4A: Decision contracts — `IProbabilityDecision` (rename + alias) and `IRelevanceDecision` (llm-agent); usage-logging wrappers (libs)

Spec §3.9, §3.8 (rows for the rename, `IRelevanceDecision`, reused `DecisionError`), §5.4 (`wrap*` stay in libs), §13 (aliases); D24.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/decision-model.ts` (rename, alias, relevance types)
- Modify: `packages/llm-agent/src/interfaces/index.ts` (export the new names; keep `IDecisionModel`)
- Create: `packages/llm-agent/src/interfaces/__tests__/decision-model.typecheck.ts`
- Modify: `packages/llm-agent-libs/src/adapters/usage-logging-decision-model.ts` (`wrapProbabilityDecision`, `wrapRelevanceDecision`, deprecated `wrapDecisionModel`)
- Modify: `packages/llm-agent-libs/src/adapters/__tests__/usage-logging-decision-model.test.ts`
- Modify: `packages/llm-agent-libs/src/index.ts`, `tsconfig.typecheck.json`

**Interfaces:**
- Produces (llm-agent):
  ```ts
  export interface IProbabilityDecision { readonly model?: string; decide(request: DecisionRequest, options?: CallOptions): Promise<Result<DecisionResult, DecisionError>> }
  /** @deprecated Use IProbabilityDecision. Kept as an alias until the next major. */
  export type IDecisionModel = IProbabilityDecision;
  export interface RelevanceRequest { query: string; passages: readonly string[] }
  export interface RelevanceScore { index: number; score: number }          // NOT a probability
  export interface RelevanceResult { scores: readonly RelevanceScore[]; model: string; usage?: { inputTokens: number; outputTokens?: number } }
  export interface IRelevanceDecision { readonly model?: string; score(request: RelevanceRequest, options?: CallOptions): Promise<Result<RelevanceResult, DecisionError>> }
  ```
  No new error code: `DecisionError` / `DecisionErrorCode` serve both (spec §3.8).
- Produces (libs):
  ```ts
  export function wrapProbabilityDecision(inner: IProbabilityDecision): IProbabilityDecision; // ex-wrapDecisionModel, same behaviour
  export function wrapRelevanceDecision(inner: IRelevanceDecision): IRelevanceDecision;       // component: 'decision'; idempotent
  /** @deprecated Use wrapProbabilityDecision. */
  export const wrapDecisionModel: typeof wrapProbabilityDecision;
  ```

- [ ] **Step 1: Write the failing checks**

```ts
// packages/llm-agent/src/interfaces/__tests__/decision-model.typecheck.ts
// Compile-time only (tsconfig.typecheck.json → `npm run typecheck`).
import type {
  IDecisionModel,
  IProbabilityDecision,
  IRelevanceDecision,
  RelevanceResult,
} from '../decision-model.js';

declare const oldName: IDecisionModel;
declare const newName: IProbabilityDecision;
// The alias is the same type both ways: no 30.1.0 implementation or caller breaks.
export const _a: IProbabilityDecision = oldName;
export const _b: IDecisionModel = newName;
declare const relevance: IRelevanceDecision;
// @ts-expect-error a relevance decision is not a probability decision (no decide)
export const _c: IProbabilityDecision = relevance;
// @ts-expect-error a probability decision is not a relevance decision (no score)
export const _d: IRelevanceDecision = newName;
// @ts-expect-error a relevance result has scores, not answers
export const _e: RelevanceResult = { answers: {}, model: 'm' };
```

Add `"packages/llm-agent/src/interfaces/__tests__/decision-model.typecheck.ts"` to `tsconfig.typecheck.json` `include`.

In `usage-logging-decision-model.test.ts`, keep every existing case, rename `describe('wrapDecisionModel'` to `describe('wrapProbabilityDecision'` and every `wrapDecisionModel(` call in it to `wrapProbabilityDecision(`, and replace the file's two import statements (lines 3–9 today) with this complete block:

```ts
import {
  DecisionError,
  type IDecisionModel,
  type IRelevanceDecision,
  type IRequestLogger,
  type LlmCallEntry,
} from '@mcp-abap-adt/llm-agent';
import {
  wrapDecisionModel,
  wrapProbabilityDecision,
  wrapRelevanceDecision,
} from '../usage-logging-decision-model.js';
```

(`IDecisionModel` stays: the existing `model()` / `failing` fixtures are typed with it, which also pins the alias.) Then append:

```ts
describe('wrapRelevanceDecision', () => {
  const relevance = (ok: boolean): IRelevanceDecision => ({
    model: 'cohere-rerank',
    score: async (r) =>
      ok
        ? { ok: true, value: { model: 'cohere-rerank', scores: r.passages.map((_, index) => ({ index, score: 0.5 })) } }
        : { ok: false, error: new DecisionError('down', 'DECISION_UNAVAILABLE') },
  });
  it('logs a successful call as component decision, estimated tokens without usage', async () => {
    const calls: unknown[] = [];
    const r = await wrapRelevanceDecision(relevance(true)).score(
      { query: 'q', passages: ['a', 'b'] },
      { requestLogger: { logLlmCall: (c: unknown) => calls.push(c) } as never },
    );
    assert.ok(r.ok);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { component: string }).component, 'decision');
    assert.equal((calls[0] as { estimated?: boolean }).estimated, true);
  });
  it('no logger → no-op; a failure is not logged; idempotent', async () => {
    const once = wrapRelevanceDecision(relevance(false));
    assert.equal(wrapRelevanceDecision(once), once);
    const r = await once.score({ query: 'q', passages: ['a'] });
    assert.equal(r.ok, false);
  });
  it('wrapDecisionModel is the deprecated alias of wrapProbabilityDecision', () => {
    assert.equal(wrapDecisionModel, wrapProbabilityDecision);
  });
});
```

Run: `npm run typecheck; node --import tsx/esm --test packages/llm-agent-libs/src/adapters/__tests__/usage-logging-decision-model.test.ts`
Expected: FAIL — `IProbabilityDecision`, `wrapRelevanceDecision` do not exist.

- [ ] **Step 2: Implement the contracts**

In `decision-model.ts`, replace the `IDecisionModel` interface (keep its doc comment, first line changed) and append the relevance types:

```ts
/**
 * A model that answers typed questions about a state with probabilities, not text
 * (spec §3.9; 30.1.0's `IDecisionModel`, renamed — same members, same rules).
 *
 * - Returns `Result`; never throws for provider failures.
 * - A question type the implementation cannot answer fails the whole request
 *   with `DECISION_UNSUPPORTED_QUESTION`; answers are never dropped or faked.
 * - Cancellation through `options.signal` yields `DECISION_ABORTED`.
 * - On `ok: true` the numeric invariants documented on the answer types hold;
 *   consumers may rely on them without re-checking.
 */
export interface IProbabilityDecision {
  /** Configured model identifier, for logs. */
  readonly model?: string;
  decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>>;
}

/** @deprecated Use `IProbabilityDecision`. Kept as an alias until the next major. */
export type IDecisionModel = IProbabilityDecision;

/** What a relevance decision judges: passages against one query. */
export interface RelevanceRequest {
  /** Non-empty. */
  query: string;
  /** Non-empty; each a non-empty string. `RelevanceScore.index` points into it. */
  passages: readonly string[];
}

/** One passage's relevance. */
export interface RelevanceScore {
  /** Index into `RelevanceRequest.passages`. */
  index: number;
  /** Finite. NOT a probability: higher = more relevant. Comparable for the same query
   *  and model — also across calls; never across queries or models. */
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
 * A model that scores how relevant each passage is to a query — a
 * cross-encoder (spec §3.9).
 *
 * - Returns `Result`; never throws for provider failures. Errors are
 *   `DecisionError` with the existing codes; `DECISION_UNSUPPORTED_QUESTION`
 *   is never returned.
 * - The score is NOT a probability. It depends on the (query, passage) pair
 *   alone — a cross-encoder scores each pair independently — so scores for the
 *   SAME query from the SAME model are comparable, also across calls (a
 *   reranker may batch and merge). Never compare across queries, across
 *   models, or with a probability. A threshold on it is the consumer's
 *   calibration.
 * - Cancellation through `options.signal` yields `DECISION_ABORTED`.
 */
export interface IRelevanceDecision {
  /** Configured model identifier, for logs. */
  readonly model?: string;
  score(
    request: RelevanceRequest,
    options?: CallOptions,
  ): Promise<Result<RelevanceResult, DecisionError>>;
}
```

In `interfaces/index.ts`, add to the `./decision-model.js` type export list: `IProbabilityDecision`, `IRelevanceDecision`, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore` (keep `IDecisionModel`).

- [ ] **Step 3: Implement the wrappers**

Today `usage-logging-decision-model.ts` imports `IDecisionModel` (type-only) and has ONE construction site, `new UsageLoggingDecisionModel(inner)` inside `wrapDecisionModel`. Replace the whole file with (cumulative: the import block names every type both classes use and nothing else — `noUnusedLocals`):

```ts
import type {
  CallOptions,
  DecisionError,
  DecisionRequest,
  DecisionResult,
  IProbabilityDecision,
  IRelevanceDecision,
  RelevanceRequest,
  RelevanceResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

const BRAND = Symbol.for('@mcp-abap-adt/usage-logging-decision-model');
const RELEVANCE_BRAND = Symbol.for('@mcp-abap-adt/usage-logging-relevance-decision');

class UsageLoggingProbabilityDecision implements IProbabilityDecision {
  readonly [BRAND] = true;
  constructor(private readonly inner: IProbabilityDecision) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>> {
    const started = Date.now();
    const r = await this.inner.decide(request, options);
    const logger = options?.requestLogger;
    if (!r.ok || !logger) return r;
    const usage = r.value.usage;
    const promptTokens = usage?.inputTokens ?? Math.ceil(JSON.stringify(request).length / 4);
    const completionTokens = usage?.outputTokens ?? 0;
    logger.logLlmCall({
      component: 'decision',
      model: r.value.model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      durationMs: Date.now() - started,
      scope: 'request',
      requestId: options?.trace?.traceId,
      ...(usage === undefined ? { estimated: true } : {}),
    });
    return r;
  }
}

class UsageLoggingRelevanceDecision implements IRelevanceDecision {
  readonly [RELEVANCE_BRAND] = true;
  constructor(private readonly inner: IRelevanceDecision) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async score(
    request: RelevanceRequest,
    options?: CallOptions,
  ): Promise<Result<RelevanceResult, DecisionError>> {
    const started = Date.now();
    const r = await this.inner.score(request, options);
    const logger = options?.requestLogger;
    if (!r.ok || !logger) return r;
    const usage = r.value.usage;
    const promptTokens = usage?.inputTokens ?? Math.ceil(JSON.stringify(request).length / 4);
    const completionTokens = usage?.outputTokens ?? 0;
    logger.logLlmCall({
      component: 'decision',
      model: r.value.model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      durationMs: Date.now() - started,
      scope: 'request',
      requestId: options?.trace?.traceId,
      ...(usage === undefined ? { estimated: true } : {}),
    });
    return r;
  }
}

/**
 * Account every successful probability-decision call to the request's logger
 * (`component: 'decision'`). No logger → no-op. Idempotent.
 */
export function wrapProbabilityDecision(inner: IProbabilityDecision): IProbabilityDecision {
  if ((inner as { [BRAND]?: boolean })[BRAND]) return inner;
  return new UsageLoggingProbabilityDecision(inner);
}

/** Account every successful relevance call to the request's logger
 *  (`component: 'decision'`). No logger → no-op. Idempotent. */
export function wrapRelevanceDecision(inner: IRelevanceDecision): IRelevanceDecision {
  if ((inner as { [RELEVANCE_BRAND]?: boolean })[RELEVANCE_BRAND]) return inner;
  return new UsageLoggingRelevanceDecision(inner);
}

/** @deprecated Use `wrapProbabilityDecision`. Kept as an alias until the next major. */
export const wrapDecisionModel = wrapProbabilityDecision;
```

The probability brand symbol keeps its 30.1.0 key (`usage-logging-decision-model`), so a model wrapped by a 30.1.0 `wrapDecisionModel` is still recognised and not wrapped twice. `UsageLoggingDecisionModel` was not exported, so the class rename touches no other file (`grep -rn UsageLoggingDecisionModel packages --include='*.ts'` → only this file before the edit, nothing after).

In `packages/llm-agent-libs/src/index.ts`, replace the `wrapDecisionModel` export line (line 19 today) with:
```ts
export {
  wrapDecisionModel,
  wrapProbabilityDecision,
  wrapRelevanceDecision,
} from './adapters/usage-logging-decision-model.js';
```

Callers stay on the alias until their own task switches them (server-libs: Task 22).

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent packages/llm-agent-libs packages/typesafe-decision
npm run typecheck
node --import tsx/esm --test packages/llm-agent-libs/src/adapters/__tests__/usage-logging-decision-model.test.ts
npm test --workspace @mcp-abap-adt/typesafe-decision
```
Expected: PASS; the `tsc -b` line builds both edited packages (`llm-agent`: `decision-model.ts`, `interfaces/index.ts`; `llm-agent-libs`: the wrapper and `src/index.ts`) and `typesafe-decision`, whose `TypeSafeDecisionModel` (typed `IDecisionModel`) still compiles — the alias is the same type. The test file is not in any `tsc -b` project (`**/__tests__/**` is excluded); tsx runs it without type-checking.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent/src/interfaces packages/llm-agent-libs/src/adapters packages/llm-agent-libs/src/index.ts
git add packages/llm-agent/src/interfaces packages/llm-agent-libs/src/adapters packages/llm-agent-libs/src/index.ts tsconfig.typecheck.json
git commit -m "feat(llm-agent): IProbabilityDecision (IDecisionModel renamed, alias kept) and IRelevanceDecision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 4B: New package `@mcp-abap-adt/llm-agent-reranker` — the rerankers move; `ProbabilityReranker` (rename + aliases)

Spec §5.1, §5.4, §11, §13; D26 (goal decision 2026-10-05: one vendor-neutral reranker package). Retrieval strategies (`RerankedRetrieval`, `RerankAllRetrieval`, later `StagedRetrieval`) stay in libs and see rerankers only through `IReranker`.

**Files:**
- Create: `packages/llm-agent-reranker/package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `GPL-3.0.txt` (copies from `packages/typesafe-decision/`)
- Move (`git mv`): `packages/llm-agent-libs/src/reranker/decision-reranker.ts` → `packages/llm-agent-reranker/src/probability-reranker.ts`; `llm-reranker.ts`, `noop-reranker.ts` → `packages/llm-agent-reranker/src/`; `__tests__/decision-reranker.test.ts` → `src/__tests__/probability-reranker.test.ts`; `__tests__/decision-reranker-batching.test.ts` → `src/__tests__/probability-reranker-batching.test.ts`; `__tests__/reranker.test.ts` → `src/__tests__/reranker.test.ts`
- Create: `packages/llm-agent-reranker/src/index.ts`, `src/assert-positive-integer.ts` (copy), `src/__tests__/fake-llm.ts`, `src/__tests__/aliases.test.ts` (in libs: `packages/llm-agent-libs/src/__tests__/reranker-aliases.test.ts`)
- Delete: `packages/llm-agent-libs/src/reranker/` (`index.ts`, `types.ts` and the moved files)
- Modify (libs): `src/index.ts` (re-exports + deprecated aliases), every internal `./reranker/…` import (`agent.ts`, `agent/rag-orchestrator-types.ts`, `builder.ts`, `interfaces/pipeline.ts`, `pipeline/context.ts`, `pipeline/default-pipeline.ts`, `testing/index.ts`), `package.json` (`peerDependencies`), `tsconfig.json` (`references`), `README.md`
- Modify (repo): root `package.json` (`build`, `clean` — right after `packages/llm-agent`), `scripts/publish-all.sh` (`PACKAGES` — right after `llm-agent`), `packages/llm-agent-server/package.json` (`dependencies`), `packages/llm-agent-server/tsconfig.json` (`references`), `package-lock.json` (via `npm install`)

**Interfaces:**
- Produces (`@mcp-abap-adt/llm-agent-reranker`):
  ```ts
  export class ProbabilityReranker implements IReranker { constructor(decision: IProbabilityDecision, options?: ProbabilityRerankerOptions) } // ex-DecisionReranker, same behaviour
  export interface ProbabilityRerankerOptions { task?: DecisionEntry; criteria?: {…}; maxBatchTokens?: number; concurrency?: number } // ex-DecisionRerankerOptions
  export const PROBABILITY_RERANK_DEFAULT_TASK; export const PROBABILITY_RERANK_DEFAULT_CRITERIA; // ex-DECISION_RERANK_DEFAULT_*
  export const TOOL_QUESTION; export const PASSAGE_QUESTION;
  export class LlmReranker; export class NoopReranker;          // moved, unchanged
  ```
- Produces (libs root, deprecated until the next major): `DecisionReranker` (= `ProbabilityReranker`, value + type), `DecisionRerankerOptions` (= `ProbabilityRerankerOptions`), `DECISION_RERANK_DEFAULT_TASK`, `DECISION_RERANK_DEFAULT_CRITERIA`; re-exports of `ProbabilityReranker`, `ProbabilityRerankerOptions`, `PROBABILITY_RERANK_DEFAULT_*`, `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` (deprecated path — import from `@mcp-abap-adt/llm-agent-reranker`).

- [ ] **Step 1: Scaffold the package**

```json
// packages/llm-agent-reranker/package.json
{
  "name": "@mcp-abap-adt/llm-agent-reranker",
  "version": "30.1.0",
  "description": "Vendor-neutral rerankers for @mcp-abap-adt/llm-agent: ProbabilityReranker, RelevanceReranker, LlmReranker, NoopReranker.",
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
    "@mcp-abap-adt/llm-agent": "^30.1.0"
  }
}
```
(Peer `@mcp-abap-adt/llm-agent` only: nothing in the rerankers imports `interfaces-auth` — verify with `grep -rn "interfaces-auth" packages/llm-agent-reranker/src` → empty. `version` 30.1.0 = the lockstep version, not a bump.)

```json
// packages/llm-agent-reranker/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["**/__tests__/**", "**/*.test.ts", "dist"],
  "references": [{ "path": "../llm-agent" }]
}
```

Run:
```bash
mkdir -p packages/llm-agent-reranker/src/__tests__
cp packages/typesafe-decision/LICENSE packages/typesafe-decision/GPL-3.0.txt packages/llm-agent-reranker/
cp packages/llm-agent-libs/src/util/assert-positive-integer.ts packages/llm-agent-reranker/src/assert-positive-integer.ts
git mv packages/llm-agent-libs/src/reranker/decision-reranker.ts packages/llm-agent-reranker/src/probability-reranker.ts
git mv packages/llm-agent-libs/src/reranker/llm-reranker.ts packages/llm-agent-reranker/src/llm-reranker.ts
git mv packages/llm-agent-libs/src/reranker/noop-reranker.ts packages/llm-agent-reranker/src/noop-reranker.ts
git mv packages/llm-agent-libs/src/reranker/__tests__/decision-reranker.test.ts packages/llm-agent-reranker/src/__tests__/probability-reranker.test.ts
git mv packages/llm-agent-libs/src/reranker/__tests__/decision-reranker-batching.test.ts packages/llm-agent-reranker/src/__tests__/probability-reranker-batching.test.ts
git mv packages/llm-agent-libs/src/reranker/__tests__/reranker.test.ts packages/llm-agent-reranker/src/__tests__/reranker.test.ts
git rm packages/llm-agent-libs/src/reranker/index.ts packages/llm-agent-libs/src/reranker/types.ts
printf '# Changelog\n\n## [Unreleased]\n\n- New package: every reranker of the llm-agent family, vendor-neutral. `ProbabilityReranker` (was `DecisionReranker` in `llm-agent-libs`), `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` moved here; `RelevanceReranker` is new. `llm-agent-libs` re-exports the old names as deprecated aliases until the next major.\n' > packages/llm-agent-reranker/CHANGELOG.md
```
(The copy of `assertPositiveInteger` is deliberate, spec §5.4: libs keeps its own for `RerankedRetrieval`; the reranker package cannot import libs — libs depends on it — and a non-contract helper does not belong in `llm-agent`.)

`packages/llm-agent-reranker/README.md` — badges and licence block as in `packages/typesafe-decision/README.md`; body:
````markdown
# @mcp-abap-adt/llm-agent-reranker

**TL;DR** — every reranker of the llm-agent family, with no vendor code. A reranker **adapts a
decision**; the decision comes from a provider package you inject.

| Reranker | Adapts | Provider example | `score` it writes |
|---|---|---|---|
| `ProbabilityReranker` (was `DecisionReranker`) | `IProbabilityDecision` | `TypeSafeDecisionModel` (`@mcp-abap-adt/typesafe-decision`, Jev) | P(relevant), in [0, 1] |
| `RelevanceReranker` | `IRelevanceDecision` | `SapAiCoreRelevanceDecision` (`@mcp-abap-adt/sap-aicore-decision`, Cohere) | relevance score — **not a probability** |
| `LlmReranker` | `ILlm` | any LLM | 0–1 from the model |
| `NoopReranker` | — | — | unchanged |

- Wording presets for the probability reranker: `TOOL_QUESTION`, `PASSAGE_QUESTION`.
- A relevance score is comparable for the same query and model (also across calls — `RelevanceReranker` batches); never a probability; a threshold on it is your calibration.
- **Moved from `@mcp-abap-adt/llm-agent-libs`** — the old imports still work there as deprecated
  aliases until the next major. Migrate: `DecisionReranker` → `ProbabilityReranker`,
  `DECISION_RERANK_DEFAULT_*` → `PROBABILITY_RERANK_DEFAULT_*`, import from this package.
````

- [ ] **Step 2: Rename inside the moved files**

Every rename below is listed with **each use** in the moved file (line numbers of today's `packages/llm-agent-libs/src/reranker/…` files; read the file, they are all there). A renamed declaration whose uses are not all renamed does not compile — the build in this step catches it.

In `probability-reranker.ts` (was `decision-reranker.ts`):
- L1–10, the `@mcp-abap-adt/llm-agent` import: `type IDecisionModel` (L5) → `type IProbabilityDecision`; add `type IReranker` (L12's `import type { IReranker } from './types.js'` is deleted — `types.js` is gone);
- L11: `'../util/assert-positive-integer.js'` → `'./assert-positive-integer.js'`;
- `DECISION_RERANK_DEFAULT_TASK` → `PROBABILITY_RERANK_DEFAULT_TASK`: its declaration L14 and its uses L26 (in `PASSAGE_QUESTION`) and L85 (in `rerank`);
- `DECISION_RERANK_DEFAULT_CRITERIA` → `PROBABILITY_RERANK_DEFAULT_CRITERIA`: its declaration L17 and its uses L27 (in `PASSAGE_QUESTION`) and L86 (in `rerank`);
- `DecisionRerankerOptions` → `ProbabilityRerankerOptions`: its declaration L41 and its use L66 (the constructor's `options` type);
- `class DecisionReranker` (L59) → `class ProbabilityReranker`, and the two `assertPositiveInteger('DecisionReranker', …)` labels (L71, L75) → `'ProbabilityReranker'`;
- the constructor parameter `private readonly model: IDecisionModel` (L65) → `private readonly decision: IProbabilityDecision`, **and its only member access**, L159 in `runBatch`: `await this.model.decide({ state: query, questions }, options)` → `await this.decision.decide({ state: query, questions }, options)`;
- the class doc (L54–58): "Rerank RAG results with a probability decision (spec §5.1): the query as the state, one yes/no question per passage, batched under a token budget. `score` becomes P(relevant). Any failed batch fails the whole call." Behaviour unchanged.
- **Not renamed:** `DecisionAnswer`, `DecisionEntry`, `NoulQuestion`, `res.value.answers` (the shared decision vocabulary, spec §17.5), the error text `decision rerank failed: …` / `decision rerank: no yes/no answer …` (asserted by the moved tests).

In `llm-reranker.ts`: L8 `'../util/assert-positive-integer.js'` → `'./assert-positive-integer.js'`; L9 `'./decision-reranker.js'` → `'./probability-reranker.js'` (it imports `PASSAGE_QUESTION`, whose name is unchanged); L10 `import type { IReranker } from './types.js'` → `type IReranker` added to the L1–7 `@mcp-abap-adt/llm-agent` imports. The file has **no** `this.model`: L181 `model: this.llm.model ?? 'unknown'` reads `ILlm.model` and is not part of the rename — leave it. In `noop-reranker.ts`: L7 `import type { IReranker } from './types.js'` → `type IReranker` added to its L1–6 `@mcp-abap-adt/llm-agent` import.

In the moved tests:
- `probability-reranker.test.ts` (was `decision-reranker.test.ts`): L6 `type IDecisionModel` → `type IProbabilityDecision`, and its uses L23, L119, L140 (`const model: IDecisionModel` → `: IProbabilityDecision`); L9–13 import `PROBABILITY_RERANK_DEFAULT_CRITERIA`, `PROBABILITY_RERANK_DEFAULT_TASK`, `ProbabilityReranker` from `'../probability-reranker.js'`; `DECISION_RERANK_DEFAULT_CRITERIA` → `PROBABILITY_RERANK_DEFAULT_CRITERIA` at L36 (describe title), L38, L60, L98; `DECISION_RERANK_DEFAULT_TASK` → `PROBABILITY_RERANK_DEFAULT_TASK` at L59, L112; `describe('DecisionReranker'` (L42) → `describe('ProbabilityReranker'`; `new DecisionReranker(` → `new ProbabilityReranker(` at L45, L53, L66, L80, L90, L106, L125, L133, L153. **Stay:** the local variable `model`, the result field `{ model: 'fake', answers }` (that is `DecisionResult.model`, not the renamed parameter) and `/DECISION_AUTH/` (L128, an error code).
- `probability-reranker-batching.test.ts` (was `decision-reranker-batching.test.ts`): L6 `type IDecisionModel` → `type IProbabilityDecision` and its use L24; L9–13 import `ProbabilityReranker`, `PASSAGE_QUESTION`, `TOOL_QUESTION` from `'../probability-reranker.js'`; describe titles L53, L62, L102 `DecisionReranker …` → `ProbabilityReranker …`; `new DecisionReranker(` → `new ProbabilityReranker(` at L68, L87, L97, L113, L120; **the expected message L114** `` new RegExp(`DecisionReranker: ${field} must be a positive integer`) `` → `` `ProbabilityReranker: ${field} must be a positive integer` `` (the constructor labels changed above). **Stays:** `{ model: 'f', answers }` (L47, `DecisionResult.model`).
- `reranker.test.ts`: L4 `import { makeLlm } from '../../testing/index.js'` → `'./fake-llm.js'` (below); L5–6 `'../llm-reranker.js'`, `'../noop-reranker.js'` resolve unchanged after the move.

`reranker.test.ts` imported `makeLlm` from libs' testing — the reranker package must not import libs (a cycle, and `scoped-dependencies.test.ts` would demand a peer): create

```ts
// packages/llm-agent-reranker/src/__tests__/fake-llm.ts
import type { ILlm, LlmResponse } from '@mcp-abap-adt/llm-agent';

/** Scripted ILlm: answers `chat` with the queued responses in order (an Error is thrown). */
export function makeLlm(responses: Array<{ content: string } | Error>): ILlm & { callCount: number } {
  let callCount = 0;
  const queue = [...responses];
  return {
    get callCount() {
      return callCount;
    },
    async chat() {
      callCount++;
      const next = queue.shift();
      if (!next) throw new Error('fake-llm: no response queued');
      if (next instanceof Error) return { ok: false, error: next } as never;
      return { ok: true, value: { content: next.content, finishReason: 'stop' } as LlmResponse };
    },
  } as ILlm & { callCount: number };
}
```
(Match the shape `makeLlm` in `packages/llm-agent-libs/src/testing/index.ts` returns for the calls `LlmReranker` makes — copy its body if `ILlm` needs more members; keep it test-only.) Switch `reranker.test.ts` to `./fake-llm.js`.

```ts
// packages/llm-agent-reranker/src/index.ts
export { LlmReranker } from './llm-reranker.js';
export { NoopReranker } from './noop-reranker.js';
export {
  PASSAGE_QUESTION,
  PROBABILITY_RERANK_DEFAULT_CRITERIA,
  PROBABILITY_RERANK_DEFAULT_TASK,
  ProbabilityReranker,
  type ProbabilityRerankerOptions,
  TOOL_QUESTION,
} from './probability-reranker.js';
```

Build the new package on its own and run the moved tests — the batching tests included — **before** libs is touched, so a missed rename (e.g. a leftover `this.model.decide`) fails here, in the package that owns it:

```bash
npx tsc -b packages/llm-agent-reranker
node --import tsx/esm --test packages/llm-agent-reranker/src/__tests__/probability-reranker-batching.test.ts packages/llm-agent-reranker/src/__tests__/probability-reranker.test.ts packages/llm-agent-reranker/src/__tests__/reranker.test.ts
grep -rn "this\.model\|IDecisionModel\|DecisionReranker\|DECISION_RERANK\|decision-reranker\|\.\./util/\|\./types\.js\|testing/index" packages/llm-agent-reranker/src
```
Expected: the build is clean (a renamed parameter with a leftover `this.model` is `TS2339: Property 'model' does not exist`); every moved test PASSES under the new names, the option-validation cases with the `ProbabilityReranker:` message; the grep prints nothing.

- [ ] **Step 3: libs depends on the package and keeps the old names (deprecated)**

`packages/llm-agent-libs/package.json` `peerDependencies`: add `"@mcp-abap-adt/llm-agent-reranker": "^30.1.0"` (a workspace sibling — the repo's standing exception; no `file:` / `link:`). `tsconfig.json` `references`: add `{ "path": "../llm-agent-reranker" }`.

Internal imports: `./reranker/types.js` / `../reranker/types.js` (`IReranker`) → `type IReranker` from `@mcp-abap-adt/llm-agent`; `./reranker/noop-reranker.js` / `../reranker/noop-reranker.js` (`NoopReranker`) → `@mcp-abap-adt/llm-agent-reranker`. Files: `agent.ts`, `agent/rag-orchestrator-types.ts`, `builder.ts`, `interfaces/pipeline.ts`, `pipeline/context.ts`, `pipeline/default-pipeline.ts`, `testing/index.ts`. Verify: `grep -rn "reranker/" packages/llm-agent-libs/src` → empty.

`scripts/rag-eval/rag-eval.ts` (in `tsconfig.typecheck.json`, so `npm run typecheck` below compiles it) imports `DecisionReranker`, `LlmReranker`, `TOOL_QUESTION` from `'../../packages/llm-agent-libs/src/reranker/index.js'` (lines 54–58) — a file this task deletes. Switch it now: the import becomes
```ts
import {
  LlmReranker,
  ProbabilityReranker,
  TOOL_QUESTION,
} from '../../packages/llm-agent-reranker/src/index.js';
```
and `new DecisionReranker(` (line 537) becomes `new ProbabilityReranker(` (same arguments). Verify: `grep -rn "reranker/" scripts test/repo` → empty.

In `packages/llm-agent-libs/src/index.ts`, replace the Reranker block with:

```ts
// ---------------------------------------------------------------------------
// Reranker — moved to @mcp-abap-adt/llm-agent-reranker (spec §5.4). Re-exported
// here for 30.1.0 imports; the whole block is deprecated until the next major.
// ---------------------------------------------------------------------------
import {
  PROBABILITY_RERANK_DEFAULT_CRITERIA,
  PROBABILITY_RERANK_DEFAULT_TASK,
  ProbabilityReranker,
  type ProbabilityRerankerOptions,
} from '@mcp-abap-adt/llm-agent-reranker';

export {
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  LlmReranker,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  NoopReranker,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  PASSAGE_QUESTION,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  PROBABILITY_RERANK_DEFAULT_CRITERIA,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  PROBABILITY_RERANK_DEFAULT_TASK,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  ProbabilityReranker,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  type ProbabilityRerankerOptions,
  /** @deprecated Import from `@mcp-abap-adt/llm-agent-reranker`. */
  TOOL_QUESTION,
} from '@mcp-abap-adt/llm-agent-reranker';

/** @deprecated Use `ProbabilityReranker` from `@mcp-abap-adt/llm-agent-reranker`. */
export const DecisionReranker = ProbabilityReranker;
/** @deprecated Use `ProbabilityReranker` from `@mcp-abap-adt/llm-agent-reranker`. */
export type DecisionReranker = ProbabilityReranker;
/** @deprecated Use `ProbabilityRerankerOptions` from `@mcp-abap-adt/llm-agent-reranker`. */
export type DecisionRerankerOptions = ProbabilityRerankerOptions;
/** @deprecated Use `PROBABILITY_RERANK_DEFAULT_TASK` from `@mcp-abap-adt/llm-agent-reranker`. */
export const DECISION_RERANK_DEFAULT_TASK = PROBABILITY_RERANK_DEFAULT_TASK;
/** @deprecated Use `PROBABILITY_RERANK_DEFAULT_CRITERIA` from `@mcp-abap-adt/llm-agent-reranker`. */
export const DECISION_RERANK_DEFAULT_CRITERIA = PROBABILITY_RERANK_DEFAULT_CRITERIA;
```

```ts
// packages/llm-agent-libs/src/__tests__/reranker-aliases.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as reranker from '@mcp-abap-adt/llm-agent-reranker';
import {
  DECISION_RERANK_DEFAULT_CRITERIA,
  DECISION_RERANK_DEFAULT_TASK,
  DecisionReranker,
  type DecisionRerankerOptions,
  LlmReranker,
  NoopReranker,
  PASSAGE_QUESTION,
  TOOL_QUESTION,
} from '../index.js';

describe('30.1.0 reranker names stay available from libs (deprecated aliases, spec §13)', () => {
  it('the aliases are the reranker package objects', () => {
    assert.equal(DecisionReranker, reranker.ProbabilityReranker);
    assert.equal(DECISION_RERANK_DEFAULT_TASK, reranker.PROBABILITY_RERANK_DEFAULT_TASK);
    assert.equal(DECISION_RERANK_DEFAULT_CRITERIA, reranker.PROBABILITY_RERANK_DEFAULT_CRITERIA);
    assert.equal(LlmReranker, reranker.LlmReranker);
    assert.equal(NoopReranker, reranker.NoopReranker);
    assert.equal(TOOL_QUESTION, reranker.TOOL_QUESTION);
    assert.equal(PASSAGE_QUESTION, reranker.PASSAGE_QUESTION);
  });
  it('a 30.1.0-style construction still compiles and works', () => {
    const opts: DecisionRerankerOptions = { maxBatchTokens: 1000 };
    const r = new DecisionReranker({ decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) }, opts);
    assert.ok(r instanceof reranker.ProbabilityReranker);
  });
});
```

- [ ] **Step 4: Wire the package into the repo**

- root `package.json`: in `build` and `clean`, insert ` packages/llm-agent-reranker` right after `packages/llm-agent` (before `packages/typesafe-decision`).
- `scripts/publish-all.sh` `PACKAGES`: add `  llm-agent-reranker` right after `  llm-agent` — publish order `llm-agent` → `llm-agent-reranker` → … → `llm-agent-libs` (libs peers on it). The list only; nothing is published here.
- `packages/llm-agent-server/package.json` `dependencies`: `"@mcp-abap-adt/llm-agent-reranker": "^30.1.0"` (the binary provides every peer of the libraries it ships, `scoped-dependencies.test.ts`). `tsconfig.json` `references`: `{ "path": "../llm-agent-reranker" }`.
- `packages/llm-agent-libs/README.md`: in the export list, replace `LlmReranker`, `NoopReranker`, `DecisionReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `wrapDecisionModel` with "`wrapProbabilityDecision`, `wrapRelevanceDecision`; the rerankers (`LlmReranker`, `NoopReranker`, `DecisionReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`) are deprecated re-exports of `@mcp-abap-adt/llm-agent-reranker`".

Run:
```bash
npm install
grep -n '"link": true' package-lock.json
```
Expected: only `packages/*` workspace siblings (the new one included); nothing outside the repo.

- [ ] **Step 5: Run**

Run:
```bash
npm run build
npm test --workspace @mcp-abap-adt/llm-agent-reranker
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/reranker-aliases.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-libs
npm test --workspace @mcp-abap-adt/llm-agent-server-libs
node --import tsx/esm --test --test-reporter=spec 'test/repo/*.test.ts'
npm run typecheck
```
Expected: PASS — the moved tests pass under the new names; server-libs still compiles against the libs aliases (it switches in Task 22); `scoped-dependencies`, `licensing`, `readme-badges` accept the new package.

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/llm-agent-reranker packages/llm-agent-libs/src
git add -A packages/llm-agent-reranker packages/llm-agent-libs package.json package-lock.json scripts/publish-all.sh scripts/rag-eval/rag-eval.ts packages/llm-agent-server/package.json packages/llm-agent-server/tsconfig.json
git commit -m "feat(llm-agent-reranker): new vendor-neutral reranker package; DecisionReranker → ProbabilityReranker (aliases kept in libs)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 4C: `RelevanceReranker` (llm-agent-reranker)

Spec §5.2 (behaviour, output check, batches by default), §3.9 (scores comparable for the same query and model); D24, D28. Adapts any `IRelevanceDecision`; Cohere's `SapAiCoreRelevanceDecision` arrives in Task 18.

**Files:**
- Create: `packages/llm-agent-reranker/src/relevance-reranker.ts`
- Create: `packages/llm-agent-reranker/src/__tests__/relevance-reranker.test.ts`
- Modify: `packages/llm-agent-reranker/src/index.ts`

**Interfaces:**
- Consumes: `IRelevanceDecision`, `RelevanceResult`, `IReranker`, `RagError`, `RagResult`, `CallOptions`, `Result` (Task 4A); `assertPositiveInteger` (Task 4B copy).
- Produces:
  ```ts
  export interface RelevanceRerankerOptions { maxBatchTokens?: number /* default 48000 */; concurrency?: number /* default 4 */ } // the same defaults and validation as ProbabilityReranker
  export class RelevanceReranker implements IReranker { constructor(decision: IRelevanceDecision, options?: RelevanceRerankerOptions) }
  // batches by default; the scores of all batches merged into one order (comparable for the same query and model, spec §3.9)
  // score := the relevance score (NOT a probability); wrong count / duplicate / out-of-range / non-finite → RERANK_ERROR
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-reranker/src/__tests__/relevance-reranker.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DecisionError,
  type IRelevanceDecision,
  type RagResult,
  type RelevanceRequest,
  type RelevanceScore,
} from '@mcp-abap-adt/llm-agent';
import { RelevanceReranker } from '../index.js';

const mk = (n: number, len = 8): RagResult[] =>
  Array.from({ length: n }, (_, i) => ({ text: `p${i}`.padEnd(len, 'x'), metadata: { id: `p${i}` }, score: 0.5 }));
const ids = (r: RagResult[]) => r.map((x) => x.metadata.id);

function decision(answer: (req: RelevanceRequest) => readonly RelevanceScore[] | DecisionError) {
  const calls: RelevanceRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  const d: IRelevanceDecision = {
    model: 'fake',
    score: async (req) => {
      calls.push(req);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const a = answer(req);
      return a instanceof DecisionError ? { ok: false, error: a } : { ok: true, value: { model: 'fake', scores: a } };
    },
  };
  return { d, calls, peak: () => peak };
}
const byLength = (req: RelevanceRequest) => req.passages.map((p, index) => ({ index, score: p.length }));
/** score = the passage's number (`p7xxx` → 7): the merged order is known whatever the batching. */
const byNumber = (req: RelevanceRequest) => req.passages.map((p, index) => ({ index, score: Number.parseInt(p.slice(1), 10) }));

describe('RelevanceReranker (spec §5.2)', () => {
  it('a small set under the default budget: ONE call; score = the relevance score; sorted, ties in input order', async () => {
    const { d, calls } = decision((req) => req.passages.map((_, index) => ({ index, score: [0.2, 3.5, 0.2][index] })));
    const r = await new RelevanceReranker(d).rerank('q', mk(3));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { query: 'q', passages: mk(3).map((x) => x.text) });
    assert.ok(r.ok);
    assert.deepEqual(ids(r.value), ['p1', 'p0', 'p2']);
    assert.equal(r.value[0].score, 3.5, 'not clamped: a relevance score is not a probability');
  });
  it('no candidates → no call', async () => {
    const { d, calls } = decision(byLength);
    const r = await new RelevanceReranker(d).rerank('q', []);
    assert.ok(r.ok && r.value.length === 0);
    assert.equal(calls.length, 0);
  });
  it('scores in any order are mapped by index', async () => {
    const { d } = decision(() => [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
    const r = await new RelevanceReranker(d).rerank('q', mk(2));
    assert.ok(r.ok);
    assert.deepEqual(ids(r.value), ['p1', 'p0']);
  });
  const badAnswers: Array<[string, readonly RelevanceScore[]]> = [
    ['a wrong count', [{ index: 0, score: 1 }]],
    ['a duplicate index', [{ index: 0, score: 1 }, { index: 0, score: 1 }]],
    ['an out-of-range index', [{ index: 0, score: 1 }, { index: 2, score: 1 }]],
    ['a non-integer index', [{ index: 0, score: 1 }, { index: 0.5, score: 1 }]],
    ['a non-finite score', [{ index: 0, score: 1 }, { index: 1, score: Number.NaN }]],
  ];
  for (const [name, answer] of badAnswers) {
    it(`${name} → RERANK_ERROR`, async () => {
      const { d } = decision(() => answer);
      const r = await new RelevanceReranker(d).rerank('q', mk(2));
      assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
    });
  }
  it('a DecisionError → RERANK_ERROR naming its code', async () => {
    const { d } = decision(() => new DecisionError('down', 'DECISION_UNAVAILABLE'));
    const r = await new RelevanceReranker(d).rerank('q', mk(2));
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR' && r.error.message.includes('DECISION_UNAVAILABLE'));
  });
  it('batches by default: over the default 48000-token budget → several calls, scores merged across calls by score (D28)', async () => {
    const { d, calls } = decision(byNumber);
    const results = mk(60, 4000); // ~1000 tokens each → two batches under 48000
    const r = await new RelevanceReranker(d).rerank('q', results);
    assert.ok(r.ok && r.value.length === 60);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.flatMap((c) => c.passages), results.map((x) => x.text), 'every passage scored once, in batch order');
    // the highest scores sit in the SECOND call: merging orders across calls, not per call
    assert.deepEqual(ids(r.value).slice(0, 3), ['p59', 'p58', 'p57']);
    assert.deepEqual(ids(r.value).at(-1), 'p0');
  });
  it('maxBatchTokens set → several calls, up to concurrency in flight, merged into one order by score', async () => {
    const { d, calls, peak } = decision(byNumber);
    const results = mk(6, 40); // ~10 tokens each
    const r = await new RelevanceReranker(d, { maxBatchTokens: 25, concurrency: 2 }).rerank('q', results);
    assert.ok(r.ok && r.value.length === 6);
    assert.ok(calls.length > 1);
    assert.ok(peak() <= 2);
    assert.deepEqual(calls.flatMap((c) => c.passages).sort(), results.map((x) => x.text).sort());
    assert.deepEqual(ids(r.value), ['p5', 'p4', 'p3', 'p2', 'p1', 'p0']);
  });
  it('a passage larger than the budget is a batch of its own, never dropped', async () => {
    const { d, calls } = decision(byNumber);
    const r = await new RelevanceReranker(d, { maxBatchTokens: 50 }).rerank('q', mk(3, 400)); // ~100 tokens each
    assert.ok(r.ok && r.value.length === 3);
    assert.deepEqual(calls.map((c) => c.passages.length), [1, 1, 1]);
  });
  it('any failed batch fails the whole rerank', async () => {
    let n = 0;
    const { d } = decision((req) => (n++ === 1 ? new DecisionError('x') : byLength(req)));
    const r = await new RelevanceReranker(d, { maxBatchTokens: 25 }).rerank('q', mk(6, 40));
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });
  it('options are validated as ProbabilityReranker validates them: positive integers', () => {
    const { d } = decision(byLength);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new RelevanceReranker(d, { maxBatchTokens: bad }), /maxBatchTokens/);
      assert.throws(() => new RelevanceReranker(d, { concurrency: bad }), /concurrency/);
    }
    assert.doesNotThrow(() => new RelevanceReranker(d));
  });
});
```

Run: `node --import tsx/esm --test packages/llm-agent-reranker/src/__tests__/relevance-reranker.test.ts`
Expected: FAIL — `RelevanceReranker` not exported.

- [ ] **Step 2: Implement**

```ts
// packages/llm-agent-reranker/src/relevance-reranker.ts
import {
  type CallOptions,
  type IRelevanceDecision,
  type IReranker,
  RagError,
  type RagResult,
  type RelevanceScore,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { assertPositiveInteger } from './assert-positive-integer.js';

/** The same defaults as `ProbabilityReranker` (spec §5.2, D28). */
const DEFAULT_MAX_BATCH_TOKENS = 48_000;
const DEFAULT_CONCURRENCY = 4;
const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export interface RelevanceRerankerOptions {
  /**
   * Estimated-token budget per `score()` call (~4 chars/token, query + passages);
   * a positive integer. Default 48000 (as `ProbabilityReranker`). The scores of
   * all batches are merged into one order: relevance scores are comparable for
   * the same query and model, also across calls (`IRelevanceDecision`, spec §3.9).
   */
  maxBatchTokens?: number;
  /** Max `score()` calls in flight; a positive integer. Default 4 (as `ProbabilityReranker`). */
  concurrency?: number;
}

const rerankError = (message: string): Result<never, RagError> => ({
  ok: false,
  error: new RagError(`relevance rerank: ${message}`, 'RERANK_ERROR'),
});

/** One entry per passage of the call, each index once, every score finite (spec §5.2). */
function checkScores(scores: readonly RelevanceScore[], n: number): string | undefined {
  if (scores.length !== n) return `${scores.length} scores for ${n} passages`;
  const seen = new Set<number>();
  for (const s of scores) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= n) return `out-of-range index ${s.index}`;
    if (seen.has(s.index)) return `index ${s.index} twice`;
    if (typeof s.score !== 'number' || !Number.isFinite(s.score)) return `non-finite score for index ${s.index}`;
    seen.add(s.index);
  }
  return undefined;
}

/**
 * Rerank RAG results with a relevance decision (a cross-encoder). `score`
 * becomes the RELEVANCE SCORE — NOT a probability. Scores for the same query
 * from the same model are comparable across calls, so candidates are batched
 * under `maxBatchTokens` (up to `concurrency` calls in flight) and the batches
 * are merged into one order. A threshold on the score is the consumer's
 * calibration (no default uses one). Any failed call or bad answer fails the
 * whole rerank with RERANK_ERROR.
 */
export class RelevanceReranker implements IReranker {
  private readonly maxBatchTokens: number;
  private readonly concurrency: number;

  /** @throws Error when `maxBatchTokens` or `concurrency` is not a positive integer. */
  constructor(
    private readonly decision: IRelevanceDecision,
    options: RelevanceRerankerOptions = {},
  ) {
    this.maxBatchTokens = options.maxBatchTokens ?? DEFAULT_MAX_BATCH_TOKENS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    assertPositiveInteger('RelevanceReranker', 'maxBatchTokens', this.maxBatchTokens);
    assertPositiveInteger('RelevanceReranker', 'concurrency', this.concurrency);
  }

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    if (results.length === 0) return { ok: true, value: results };
    const batches = this.batches(query, results);
    const score = new Array<number>(results.length);
    for (let b = 0; b < batches.length; b += this.concurrency) {
      const slice = batches.slice(b, b + this.concurrency);
      const settled = await Promise.all(
        slice.map((idxs) =>
          this.decision.score({ query, passages: idxs.map((i) => results[i].text) }, options),
        ),
      );
      for (const [j, res] of settled.entries()) {
        if (!res.ok) {
          return rerankError(`failed: ${res.error.code}: ${res.error.message}`);
        }
        const idxs = slice[j];
        const bad = checkScores(res.value.scores, idxs.length);
        if (bad) return rerankError(bad);
        for (const s of res.value.scores) score[idxs[s.index]] = s.score;
      }
    }
    return {
      ok: true,
      value: results
        .map((r, i) => ({ r: { ...r, score: score[i] }, i }))
        .sort((x, y) => y.r.score - x.r.score || x.i - y.i)
        .map((x) => x.r),
    };
  }

  /** Batches under the token budget; a passage over the budget is a batch of its own (spec §5.2). */
  private batches(query: string, results: RagResult[]): number[][] {
    const budget = this.maxBatchTokens;
    const queryCost = estimateTokens(query);
    const out: number[][] = [];
    let cur: number[] = [];
    let used = queryCost;
    results.forEach((r, i) => {
      const cost = estimateTokens(r.text);
      if (cur.length > 0 && used + cost > budget) {
        out.push(cur);
        cur = [];
        used = queryCost;
      }
      cur.push(i);
      used += cost;
    });
    if (cur.length > 0) out.push(cur);
    return out;
  }
}
```

Append to `packages/llm-agent-reranker/src/index.ts`:
```ts
export {
  RelevanceReranker,
  type RelevanceRerankerOptions,
} from './relevance-reranker.js';
```

And to `packages/llm-agent-reranker/README.md`, under the table: a "`RelevanceReranker`" section — batches by default like `ProbabilityReranker` (`maxBatchTokens` 48000, `concurrency` 4), the batches' scores merged into one order because relevance scores are comparable for the same query and model; output check (wrong count, duplicate, out-of-range, non-finite → `RERANK_ERROR`); the score is not a probability.

- [ ] **Step 3: Run**

Run:
```bash
node --import tsx/esm --test packages/llm-agent-reranker/src/__tests__/relevance-reranker.test.ts
npx tsc -b packages/llm-agent-reranker
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
npx biome check --write packages/llm-agent-reranker
git add packages/llm-agent-reranker
git commit -m "feat(llm-agent-reranker): RelevanceReranker over an IRelevanceDecision — batched by default, output checked

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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/pool-and-collapse.test.ts
```
Expected: PASS (`tsc -b` type-checks the task's sources and `collections/index.ts` and rebuilds `llm-agent` through the project references; the tsx run does not type-check).

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

Spec §4.9, §4.10 (incl. `ISizeBoundedCut`, S6); D17, D19; §17.6 F1 (the caller's k caps every cut).

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
  export class FixedItemsCut implements IItemCut { constructor(n: number); readonly name: 'fixed-items' } // a CEILING: limit(k) = min(k, n)
  export class ScoreFloorCut implements IItemCut { constructor(o: { minItems: number; maxItems: number; minScore: number }); readonly name: 'score-floor' } // limit(k) = min(k, maxItems)
  export class TokenBudgetCut implements IItemCut, ISizeBoundedCut { constructor(o: { budgetTokens: number; maxItems?: number; estimator?: IItemSizeEstimator }); readonly name: 'token-budget'; readonly budgetTokens: number; readonly estimator: IItemSizeEstimator } // limit(k) = min(k, maxItems ?? k)
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
  it('FixedItemsCut is a ceiling under the caller k (spec §4.9, F1)', () => {
    const c = new FixedItemsCut(3);
    assert.equal(c.limit(20), 3);
    assert.deepEqual(ids(c.cut(ranked, 20)), ['a', 'b', 'c']);
    assert.equal(c.limit(2), 2);
    assert.deepEqual(ids(c.cut(ranked, 2)), ['a', 'b']);
    assert.throws(() => new FixedItemsCut(0));
  });
  it('ScoreFloorCut: minItems, then up to maxItems while score ≥ minScore — all capped by k', () => {
    const c = new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0.5 });
    assert.equal(c.limit(20), 3);
    assert.deepEqual(ids(c.cut(ranked, 20)), ['a', 'b']);
    const floor3 = new ScoreFloorCut({ minItems: 3, maxItems: 3, minScore: 0.95 });
    assert.deepEqual(ids(floor3.cut(ranked, 20)), ['a', 'b', 'c']);
    assert.equal(floor3.limit(2), 2);
    assert.deepEqual(ids(floor3.cut(ranked, 2)), ['a', 'b']);
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
  it('min(requestedK, maxItems ?? requestedK) is the ceiling and the limit', () => {
    assert.equal(new TokenBudgetCut({ budgetTokens: 999 }).limit(2), 2);
    assert.deepEqual(ids(new TokenBudgetCut({ budgetTokens: 999 }).cut(tools, 2)), ['a', 'b']);
    const c = new TokenBudgetCut({ budgetTokens: 999, maxItems: 1 });
    assert.equal(c.limit(20), 1);
    assert.deepEqual(ids(c.cut(tools, 20)), ['a']);
    const wide = new TokenBudgetCut({ budgetTokens: 999, maxItems: 5 });
    assert.equal(wide.limit(2), 2);
    assert.deepEqual(ids(wide.cut(tools, 2)), ['a', 'b']);
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

/** A ceiling: at most `n` items, never more than the caller's k (spec §4.9, F1). */
export class FixedItemsCut implements IItemCut {
  readonly name = 'fixed-items';
  constructor(readonly n: number) {
    assertPositiveInteger('FixedItemsCut', 'n', n);
  }
  limit(requestedK: number): number {
    return Math.min(requestedK, this.n);
  }
  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    return items.slice(0, this.limit(requestedK));
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
  limit(requestedK: number): number {
    return Math.min(requestedK, this.opts.maxItems);
  }
  cut(items: readonly RagResult[], requestedK: number): RagResult[] {
    const max = this.limit(requestedK);
    const min = Math.min(this.opts.minItems, max);
    const out: RagResult[] = [];
    for (const it of items) {
      if (out.length >= max) break;
      if (out.length >= min && it.score < this.opts.minScore) {
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

/** ~4 chars per token — the unit the probability reranker (ex-DecisionReranker) already budgets in. */
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
 * `min(requestedK, maxItems ?? requestedK)`. Stops at the first item that does not fit (D19);
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
    return Math.min(requestedK, this.maxItems ?? requestedK);
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/cuts.test.ts
```
Expected: PASS (`tsc -b` type-checks the task's sources and `collections/index.ts` and rebuilds `llm-agent` through the project references; the tsx run does not type-check).

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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/derive-tool-facets.test.ts packages/llm-agent-libs/src/collections/__tests__/tool-item.test.ts
```
Expected: PASS (`tsc -b` type-checks the task's sources and `collections/index.ts` and rebuilds `llm-agent` through the project references; the tsx run does not type-check).

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): server-agnostic tool word derivation and ToolItem from tools/list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 8: Facets, provider text composers and `FacetedToolIndexer` (libs)

Spec §7.3.1 (incl. the provider text composer, §17.6 F4), §7.0.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/tools/facets.ts`
- Create: `packages/llm-agent-libs/src/collections/tools/tool-text.ts`
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
  export function fullToolText(tool: ToolItem): string; // C0: `Tool: <name> — <description>` + `\nParameters: a, b`
  export class ParameterNamesToolText implements IToolTextComposer { readonly name: 'parameter-names' } // C0, the default — = fullToolText
  export class EnumValuesToolText implements IToolTextComposer { readonly name: 'enum-values' }         // C0e: C0 + `\n<param>: <values>` per parameter with string values
  export class SchemaToolText implements IToolTextComposer { readonly name: 'schema' }                  // C0s: C0 + `\n<param>: <first clause>[; values: <values>]` per parameter
  export class FacetedToolIndexer implements IItemIndexer<ToolItem> { constructor(facets: readonly IToolFacet[], opts?: { text?: IToolTextComposer }); readonly name: 'faceted'; readonly canonicalKind: 'full'; readonly maxRecordsPerItem: number /* 1 + facets */; readonly facets: readonly IToolFacet[]; readonly text: IToolTextComposer /* default ParameterNamesToolText */ }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EnumValuesToolText,
  FacetedToolIndexer,
  fullToolText,
  NameTailFacet,
  ParameterNamesToolText,
  ParametersFacet,
  SchemaToolText,
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

describe('provider text composers (F4) — the default stays C0', () => {
  it('no text option → ParameterNamesToolText, byte-identical to fullToolText', async () => {
    const i = new FacetedToolIndexer([new SummaryFacet()]);
    assert.ok(i.text instanceof ParameterNamesToolText);
    assert.equal(new ParameterNamesToolText().compose(tool), fullToolText(tool));
  });
  it('EnumValuesToolText (C0e): C0 + the string values of each parameter that has them', () => {
    assert.equal(
      new EnumValuesToolText().compose(tool),
      `${fullToolText(tool)}\nstate: OPEN, MERGED_ALL`,
    );
  });
  it('SchemaToolText (C0s): C0 + each parameter description first clause and values', () => {
    assert.equal(
      new SchemaToolText().compose(tool),
      `${fullToolText(tool)}\nrepo_name: Repository\nstate: values OPEN, MERGED_ALL`,
    );
  });
  it('the composer text is the full record text AND every facet itemText', async () => {
    const r = await new FacetedToolIndexer([new SummaryFacet()], { text: new EnumValuesToolText() }).toRecords(tool);
    assert.ok(r.ok);
    const [full, summary] = r.value;
    assert.equal(full.text, new EnumValuesToolText().compose(tool));
    assert.equal(summary.itemText, full.text);
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
  IToolTextComposer,
  RagError,
  RecordDraft,
  Result,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { ParameterNamesToolText } from './tool-text.js';

const GLOBAL = { scope: 'global' } as const;

/**
 * `full` (canonical, not a facet — it cannot be left out) + one record per
 * facet that yields text. Tool catalogs are global. The `full` text comes from
 * the injected provider text composer (F4); absent → C0 (measured default).
 */
export class FacetedToolIndexer implements IItemIndexer<ToolItem> {
  readonly name = 'faceted';
  readonly canonicalKind = 'full';
  readonly maxRecordsPerItem: number;
  readonly text: IToolTextComposer;

  constructor(
    readonly facets: readonly IToolFacet[],
    opts: { text?: IToolTextComposer } = {},
  ) {
    this.text = opts.text ?? new ParameterNamesToolText();
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
    const full = this.text.compose(tool);
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

```ts
// packages/llm-agent-libs/src/collections/tools/tool-text.ts
/**
 * Provider text composers (spec §7.3.1, review finding 4). The default stays C0
 * (measured). C0e / C0s are strategies in no default: on mcp-abap-adt `compact`
 * with Jev over the whole set they were within noise of C0 (EN k3 C0 .970 / C0s
 * .970 / C0e 1.000; non-ASCII k3 1.000 / 1.000 / .905; equal tokens). Provider
 * words only — nothing is written over the provider's text.
 */
import type { IToolTextComposer, ToolItem } from '@mcp-abap-adt/llm-agent';
import { firstClause } from './derive-tool-facets.js';

/** C0: `Tool: <name> — <description>` + `\nParameters: a, b` (the 30.1.0-shaped text). */
export function fullToolText(tool: ToolItem): string {
  const head = `Tool: ${tool.name} — ${tool.description}`;
  return tool.parameters.length > 0
    ? `${head}\nParameters: ${tool.parameters.map((p) => p.name).join(', ')}`
    : head;
}

/** C0 — the default. */
export class ParameterNamesToolText implements IToolTextComposer {
  readonly name = 'parameter-names';
  compose(tool: ToolItem): string {
    return fullToolText(tool);
  }
}

/** C0e — C0 + one line per parameter with string values: `<param>: <v1>, <v2>`. */
export class EnumValuesToolText implements IToolTextComposer {
  readonly name = 'enum-values';
  compose(tool: ToolItem): string {
    const lines = tool.parameters
      .filter((p) => p.values.length > 0)
      .map((p) => `${p.name}: ${p.values.map((v) => v.value).join(', ')}`);
    return [fullToolText(tool), ...lines].join('\n');
  }
}

/** C0s — C0 + one line per parameter with a description or values:
 *  `<param>: <first clause>` and/or `values <v1>, <v2>` (joined by `; `). */
export class SchemaToolText implements IToolTextComposer {
  readonly name = 'schema';
  compose(tool: ToolItem): string {
    const lines = tool.parameters.flatMap((p) => {
      const parts = [
        ...(p.description && firstClause(p.description) ? [firstClause(p.description)] : []),
        ...(p.values.length > 0 ? [`values ${p.values.map((v) => v.value).join(', ')}`] : []),
      ];
      return parts.length > 0 ? [`${p.name}: ${parts.join('; ')}`] : [];
    });
    return [fullToolText(tool), ...lines].join('\n');
  }
}
```

Append to `collections/index.ts`:
```ts
export { FacetedToolIndexer } from './tools/faceted-tool-indexer.js';
export { NameTailFacet, ParametersFacet, SummaryFacet } from './tools/facets.js';
export {
  EnumValuesToolText,
  fullToolText,
  ParameterNamesToolText,
  SchemaToolText,
} from './tools/tool-text.js';
```

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/faceted-tool-indexer.test.ts
```
Expected: PASS (`tsc -b` type-checks the task's sources and `collections/index.ts` and rebuilds `llm-agent` through the project references; the tsx run does not type-check).

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src/collections
git commit -m "feat(libs): schema-derived tool facets, provider text composers and FacetedToolIndexer

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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/enum-value-tool-indexer.test.ts
```
Expected: PASS (`tsc -b` type-checks the task's sources and `collections/index.ts` and rebuilds `llm-agent` through the project references; the tsx run does not type-check).

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
import { fullToolText } from './tool-text.js';

/** `itemText`: the inner indexer's canonical text (its composer's, F4); undefined → companion (no itemText). */
async function intentDraft(
  source: IToolIntentSource,
  tool: ToolItem,
  itemText: string | undefined,
  options?: CallOptions,
): Promise<Result<RecordDraft | undefined, RagError>> {
  const r = await source.intentsFor(tool, options);
  if (!r.ok) return r;
  if (r.value.length === 0) return { ok: true, value: undefined };
  const provider = itemText ?? fullToolText(tool);
  return {
    ok: true,
    value: {
      text: r.value.join('\n'),
      itemId: tool.itemId,
      recordKind: 'intent',
      owner: { scope: 'global' },
      generated: true,
      // The reranker reads provider text, never intents (spec §4.6).
      ...(itemText !== undefined ? { itemText } : {}),
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
    // itemText = the inner's canonical text, so a composer (F4) reaches the reranker too.
    const canonical = base.value.find((d) => d.recordKind === this.inner.canonicalKind);
    const intent = await intentDraft(
      this.source,
      tool,
      canonical?.text ?? fullToolText(tool),
      options,
    );
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
    const intent = await intentDraft(this.source, tool, undefined, options);
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/intents.test.ts
```
Expected: PASS (`tsc -b` type-checks the task's sources and `collections/index.ts` and rebuilds `llm-agent` through the project references; the tsx run does not type-check).

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

Spec §3.1, §3.3 (incl. `companionRecordIds`, S7, and **cleanup failures kept for retry** — `staleRecordIds` / `staleCompanionRecordIds`, §17.6 F3), §4.4 (refusal), §7.6 (one batch pass), §8.2. Failure handling only — no generations, no locks (D13).

**A replacement replaces the record — on every backend.** Re-indexing writes the same ids again, and the backends differ on what a write to an existing id does with the old metadata (read in the repo, 2026-10-05):

| Backend | Write to an existing id | Code |
|---|---|---|
| `InMemoryRag` | **merges**: `metadata = { ...old, ...new }` | `in-memory-rag.ts` `upsert` (in-place branch); `writer().upsertRaw` calls it |
| `VectorRag` | **merges**: `slot.metadata = { ...slot.metadata, ...metadata }` | `vector-rag.ts` `upsertKnownVector`; `upsertRaw` / `upsertPrecomputedRaw` call it |
| Qdrant | **replaces**: `PUT /points` with the whole payload `{ text, ...metadata }` (also `upsertManyPrecomputedRaw`) | `qdrant-rag.ts` `upsertKnownVector`, `upsertManyPrecomputedRaw` |
| pg-vector | **replaces**: `ON CONFLICT (id) DO UPDATE SET … metadata = EXCLUDED.metadata` | `pg-vector-rag.ts` `upsertKnown` |
| HANA | **replaces**: `UPSERT … WITH PRIMARY KEY` (whole row, metadata as one JSON) | `hana-vector-rag.ts` `upsertKnown` |
| `FallbackRag` | whatever its primary (and fallback) does — it delegates | `resilience/fallback-rag.ts` |

So on a merging store a key the new record leaves out would **survive** the replacement (an old `data`, `itemText`, `generated`, `companionRecordIds`, a settled stale list…). The writer therefore:
- writes **every** `ReservedRecordKey` except `id` on **every** record write, absent ones as `undefined` (`UNSET_RESERVED`, compile-checked against `ReservedRecordKey` with `satisfies`, so a new reserved key is a compile error until listed);
- on the **canonical**, also writes `undefined` for every extra the OLD canonical had and the new one has not (the old record is already read for the stale set; `id`, `text`, `namespace` are the store's own and never cleared).

Correct on both kinds: a merging store overwrites the key with `undefined` (reads see `undefined`); a replacing store gets the whole new payload, and `JSON.stringify` drops `undefined` keys, so the key is simply absent. Limit: a non-canonical record's dropped **extra** (not reserved) can survive on a merging store — its old metadata is not read. Readers never see it: retrieval returns the canonical record (hydration, spec §4.6).

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
  // F3: stale deletes in the primary AND in the given companion stores, every Result checked;
  // ids written ahead on the canonical (staleRecordIds / staleCompanionRecordIds), settled after.
  export function storeItems(rag: IRag, items: readonly PreparedItem[], options?: CallOptions, companions?: Readonly<Record<string, IRag>>): Promise<{ indexed: boolean[]; records: number; failures: (string | undefined)[]; batchFailure?: string }>;
  export function getItem(rag: IRag, canonicalId: string, filter: CallOptions | undefined, options?: CallOptions): Promise<Result<RagResult | null, RagError>>;
  export function removeItem(rag: IRag, canonicalId: string, options?: CallOptions, companions?: Readonly<Record<string, IRag>>): Promise<Result<number, RagError>>; // S7 + F3: listed AND stale ids; a failed delete keeps the canonical and returns an error
  export function listedCompanions(meta: RagMetadata | undefined, key?: 'companionRecordIds' | 'staleCompanionRecordIds'): CompanionIds;
  export function asItem(canonical: RagResult, score: number, extra?: { matchedKinds?: string[]; source?: string }): RagResult; // metadata.id = itemId
  export function isExpired(meta: RagMetadata, nowSecs?: number): boolean;
  ```
  Failure reasons: `'too-many-records'`, `'missing-canonical'`, `'owner-mismatch'`, `'item-id-mismatch'`, `'no-records'`, `'write-failed'`, `'read-failed: <message>'`, `'cleanup-failed: <n> stale record(s) kept for retry'` (F3).

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IEmbedder,
  InMemoryRag,
  type IRag,
  RagError,
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
    // Every reserved key but `id` is written, absent ones as `undefined` (merging stores).
    assert.deepEqual(canonical?.metadata, {
      data: { n: 1 },
      itemId: 'case-42',
      recordKind: 'item',
      profile: 'shared-items',
      visibility: 'user',
      userId: 'A',
      groupId: undefined,
      sessionId: undefined,
      generated: undefined,
      itemText: undefined,
      ttl: 99,
      recordIds: others.map((r) => r.id),
      companionRecordIds: undefined,
      staleRecordIds: undefined,
      staleCompanionRecordIds: undefined,
      serviceRecord: undefined,
    });
    assert.equal(others[0].metadata.itemText, 'canon');
    assert.ok('companionRecordIds' in others[0].metadata, 'non-canonical records write every reserved key too');
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

  it('S7: the canonical lists companion ids; replacement deletes the unlisted ones; removeItem clears them', async () => {
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
    await storeItems(rag, [p.item], undefined, { intents });
    const n = await removeItem(rag, recordId(U_A, 'case-42', 'item', 0), undefined, { intents });
    assert.ok(n.ok && n.value === 2);
    const gone = await intents.getById(cid);
    assert.ok(gone.ok && gone.value === null);
    // replacement with no companion record: the old one is a stale companion id, deleted
    await intents.writer().upsertRaw(cid, 'open my notes', { visibility: 'user', userId: 'A' });
    await storeItems(rag, [p.item], undefined, { intents });
    const q = prepareItem({ itemId: 'case-42', drafts: [draft('item', 'c2')] }, { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 });
    assert.ok(q.ok);
    const r = await storeItems(rag, [q.item], undefined, { intents });
    assert.deepEqual(r.indexed, [true]);
    const gone2 = await intents.getById(cid);
    assert.ok(gone2.ok && gone2.value === null);
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

describe('replacement replaces the record on a store that merges metadata (spec §3.3)', () => {
  const stores: [string, () => IRag][] = [
    ['InMemoryRag', () => new InMemoryRag()],
    [
      'VectorRag',
      () => new VectorRag(symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) })),
    ],
  ];
  for (const [name, make] of stores) {
    it(`${name}: keys the new item leaves out are gone after replacement`, async () => {
      const rag = make();
      const canonId = recordId(U_A, 'case-42', 'item', 0);
      const noteId = recordId(U_A, 'case-42', 'note', 0);
      const old = prepareItem(
        {
          itemId: 'case-42',
          // canonical: extra `data` + `itemText`; note: `itemText` (draft helper)
          drafts: [{ ...draft('item', 'v1'), itemText: 'old text' }, draft('note', 'n0')],
        },
        {
          canonicalKind: 'item',
          profile: 'p',
          maxRecordsPerItem: 5,
          companionRecordIds: { intents: [recordId(U_A, 'case-42', 'intent', 0)] },
        },
      );
      const next = prepareItem(
        {
          itemId: 'case-42',
          drafts: [
            { text: 'v2', itemId: 'case-42', recordKind: 'item', owner: U_A },
            { text: 'n0-v2', itemId: 'case-42', recordKind: 'note', owner: U_A },
          ],
        },
        { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
      );
      assert.ok(old.ok && next.ok);
      await storeItems(rag, [old.item]);
      const before = await rag.getById(canonId);
      assert.ok(before.ok && before.value);
      assert.deepEqual(before.value.metadata.data, { n: 1 });
      assert.equal(before.value.metadata.itemText, 'old text');
      assert.ok(before.value.metadata.companionRecordIds !== undefined);

      const r = await storeItems(rag, [next.item]);
      assert.deepEqual(r.indexed, [true]);
      const after = await rag.getById(canonId);
      assert.ok(after.ok && after.value);
      assert.equal(after.value.text, 'v2');
      for (const k of ['data', 'itemText', 'companionRecordIds', 'staleRecordIds', 'staleCompanionRecordIds']) {
        assert.equal(after.value.metadata[k], undefined, k);
      }
      assert.equal(after.value.metadata.itemId, 'case-42', 'the framework keys are rewritten');
      const note = await rag.getById(noteId);
      assert.ok(note.ok && note.value);
      assert.equal(note.value.text, 'n0-v2');
      assert.equal(note.value.metadata.itemText, undefined, 'reserved keys are rewritten on every record');
    });
  }
});

/** A store whose writer fails deleteByIdRaw for the ids in `failing` (F3 tests). */
function flakyDeletes(inner: InMemoryRag, failing: Set<string>): IRag {
  const w = inner.writer();
  return {
    ...inner,
    query: inner.query.bind(inner),
    getById: inner.getById.bind(inner),
    writer: () => ({
      ...w,
      deleteByIdRaw: async (id: string, o?: CallOptions) =>
        failing.has(id)
          ? { ok: false as const, error: new RagError('delete down') }
          : w.deleteByIdRaw(id, o),
    }),
  } as IRag;
}

describe('cleanup failures are kept for retry (spec §3.3, F3)', () => {
  const canonId = recordId(U_A, 'case-42', 'item', 0);
  const staleId = recordId(U_A, 'case-42', 'note', 1);

  it('replacement → failed stale delete → not indexed, id kept → retry → gone → remove leaves nothing', async () => {
    const raw = new InMemoryRag();
    const failing = new Set([staleId]);
    const rag = flakyDeletes(raw, failing);
    const v1 = prep([draft('item', 'v1'), draft('note', 'a'), draft('note', 'b')]);
    assert.ok(v1.ok);
    await storeItems(rag, [v1.item]);
    const v2 = prep([draft('item', 'v2'), draft('note', 'a2')]);
    assert.ok(v2.ok);
    const r = await storeItems(rag, [v2.item]);
    assert.deepEqual(r.indexed, [false]);
    assert.match(r.failures[0] ?? '', /^cleanup-failed: 1 stale record/);
    const canon = await raw.getById(canonId);
    assert.ok(canon.ok && canon.value?.text === 'v2', 'the new records are written');
    assert.deepEqual(canon.value?.metadata.staleRecordIds, [staleId]);
    const still = await raw.getById(staleId);
    assert.ok(still.ok && still.value !== null);

    failing.clear();
    const retry = await storeItems(rag, [v2.item]);
    assert.deepEqual(retry.indexed, [true]);
    const gone = await raw.getById(staleId);
    assert.ok(gone.ok && gone.value === null);
    const settled = await raw.getById(canonId);
    assert.ok(settled.ok && settled.value?.metadata.staleRecordIds === undefined);

    const n = await removeItem(rag, canonId);
    assert.ok(n.ok);
    for (const id of [canonId, recordId(U_A, 'case-42', 'note', 0), staleId]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
  });

  it('remove retries the pending ids; a failed delete keeps the canonical and returns an error', async () => {
    const raw = new InMemoryRag();
    const failing = new Set([staleId]);
    const rag = flakyDeletes(raw, failing);
    const v1 = prep([draft('item', 'v1'), draft('note', 'a'), draft('note', 'b')]);
    const v2 = prep([draft('item', 'v2'), draft('note', 'a2')]);
    assert.ok(v1.ok && v2.ok);
    await storeItems(rag, [v1.item]);
    await storeItems(rag, [v2.item]);
    const failed = await removeItem(rag, canonId);
    assert.equal(failed.ok, false);
    const kept = await raw.getById(canonId);
    assert.ok(kept.ok && kept.value !== null, 'the canonical stays so a retry finds the list');
    failing.clear();
    const done = await removeItem(rag, canonId);
    assert.ok(done.ok);
    for (const id of [canonId, staleId]) {
      const x = await raw.getById(id);
      assert.ok(x.ok && x.value === null, id);
    }
  });

  it('a failed companion stale delete is kept in staleCompanionRecordIds and retried', async () => {
    const rag = new InMemoryRag();
    const rawIntents = new InMemoryRag();
    const cid = recordId(U_A, 'case-42', 'intent', 0);
    const failing = new Set([cid]);
    const intents = flakyDeletes(rawIntents, failing);
    await rawIntents.writer().upsertRaw(cid, 'open my notes', { visibility: 'user', userId: 'A' });
    const withIntent = prepareItem(
      { itemId: 'case-42', drafts: [draft('item', 'c')] },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5, companionRecordIds: { intents: [cid] } },
    );
    const without = prepareItem(
      { itemId: 'case-42', drafts: [draft('item', 'c2')] },
      { canonicalKind: 'item', profile: 'p', maxRecordsPerItem: 5 },
    );
    assert.ok(withIntent.ok && without.ok);
    await storeItems(rag, [withIntent.item], undefined, { intents });
    const r = await storeItems(rag, [without.item], undefined, { intents });
    assert.deepEqual(r.indexed, [false]);
    const canon = await rag.getById(canonId);
    assert.ok(canon.ok);
    assert.deepEqual(canon.value?.metadata.staleCompanionRecordIds, { intents: [cid] });
    failing.clear();
    const retry = await storeItems(rag, [without.item], undefined, { intents });
    assert.deepEqual(retry.indexed, [true]);
    const gone = await rawIntents.getById(cid);
    assert.ok(gone.ok && gone.value === null);
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
 * new `recordIds` AND, written ahead, the stale ids still to delete) → deletes
 * of those stale ids, each Result checked → the canonical settled to what is
 * still pending (F3). NOT atomic, no locks, no generations (D13): readers stay
 * safe through hydration (§4.6); a failed cleanup is kept, never reported indexed.
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
  type ReservedRecordKey,
  type Result,
  ragIdentityFilter,
  recordId,
  retrievalEmbedderOf,
} from '@mcp-abap-adt/llm-agent';
import { ownerMetadata } from './owner.js';

/**
 * Every reserved key but `id` (the store writes it), explicitly `undefined`, under
 * every record write. InMemoryRag and VectorRag MERGE metadata on the same id, so a
 * key left out would survive a replacement; Qdrant, pg-vector and HANA replace the
 * whole payload and JSON.stringify drops `undefined`, so the same write is right
 * there too (spec §3.3: a replacement replaces the record). `satisfies` makes a key
 * added to ReservedRecordKey a compile error here until it is listed.
 */
const UNSET_RESERVED = {
  itemId: undefined,
  recordKind: undefined,
  itemText: undefined,
  profile: undefined,
  generated: undefined,
  recordIds: undefined,
  companionRecordIds: undefined,
  staleRecordIds: undefined,
  staleCompanionRecordIds: undefined,
  visibility: undefined,
  userId: undefined,
  groupId: undefined,
  sessionId: undefined,
  ttl: undefined,
  // A service record is the deploy step's (spec §6.5), never an item record.
  serviceRecord: undefined,
} satisfies Record<Exclude<ReservedRecordKey, 'id'>, undefined>;

/** Keys the store itself owns on a read record; never cleared by the writer. */
const STORE_OWN_KEYS: ReadonlySet<string> = new Set(['id', 'text', 'namespace']);

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
        ...UNSET_RESERVED,
        ...(d.metadata ?? {}),
        itemId: w.itemId,
        recordKind: d.recordKind,
        profile: o.profile,
        ...ownerMetadata(owner),
        generated: d.generated ? true : undefined,
        itemText: d.itemText,
        ttl: w.ttl,
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
          companionRecordIds:
            companions && Object.keys(companions).length > 0 ? companions : undefined,
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

const listed = (
  meta: RagMetadata | undefined,
  key: 'recordIds' | 'staleRecordIds' = 'recordIds',
): string[] => {
  const raw = meta?.[key];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
};

/** S7 / F3: the companion ids a canonical record lists under `key` (malformed entries ignored). */
export function listedCompanions(
  meta: RagMetadata | undefined,
  key: 'companionRecordIds' | 'staleCompanionRecordIds' = 'companionRecordIds',
): CompanionIds {
  const raw = meta?.[key];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [name, ids] of Object.entries(raw)) {
    if (Array.isArray(ids)) out[name] = ids.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

/** The stale ids still to delete: primary + per companion (F3). */
interface Stale {
  primary: string[];
  companions: Record<string, string[]>;
}

const pendingCount = (st: Stale): number =>
  st.primary.length +
  Object.values(st.companions).reduce((n, ids) => n + ids.length, 0);

/**
 * The new canonical, with `undefined` for every extra the OLD canonical had and the
 * new one has not — a merging store would otherwise keep it (reserved keys are
 * already all written, UNSET_RESERVED).
 */
function clearingOld(c: PreparedRecord, old: RagMetadata | undefined): PreparedRecord {
  if (!old) return c;
  const dropped = Object.keys(old).filter(
    (k) => !STORE_OWN_KEYS.has(k) && !(k in c.metadata),
  );
  if (dropped.length === 0) return c;
  return {
    ...c,
    metadata: { ...Object.fromEntries(dropped.map((k) => [k, undefined])), ...c.metadata },
  };
}

/** The canonical with the stale lists written onto it (`undefined` when empty). */
function withStale(c: PreparedRecord, st: Stale): PreparedRecord {
  const { staleRecordIds: _a, staleCompanionRecordIds: _b, ...rest } = c.metadata;
  const comp = Object.fromEntries(
    Object.entries(st.companions).filter(([, ids]) => ids.length > 0),
  );
  return {
    ...c,
    metadata: {
      ...rest,
      // Always written, `undefined` once settled: InMemoryRag's upsert MERGES metadata
      // on the same id, so an omitted key would keep the previous list.
      staleRecordIds: st.primary.length > 0 ? st.primary : undefined,
      staleCompanionRecordIds: Object.keys(comp).length > 0 ? comp : undefined,
    },
  };
}

/** Delete each id; `ok` (deleted or already absent) = done; `ok: false` or a throw = kept. */
async function deleteAll(
  rag: IRag | undefined,
  ids: readonly string[],
  options?: CallOptions,
): Promise<string[]> {
  const w = rag?.writer?.();
  if (!w) return [...ids];
  const kept: string[] = [];
  for (const id of ids) {
    try {
      const d = await w.deleteByIdRaw(id, options);
      if (!d.ok) kept.push(id);
    } catch {
      kept.push(id);
    }
  }
  return kept;
}

/**
 * Write prepared items into ONE store (spec §3.3 order). `indexed[i]` = every
 * record of item i written AND its stale cleanup done (F3). `companions`: the
 * bound companion stores, for the item's stale companion records (S7); a
 * companion the caller does not pass is not carried (S7 rule).
 */
export async function storeItems(
  rag: IRag,
  items: readonly PreparedItem[],
  options?: CallOptions,
  companions: Readonly<Record<string, IRag>> = {},
): Promise<{
  indexed: boolean[];
  records: number;
  failures: (string | undefined)[];
  batchFailure?: string;
}> {
  const failures: (string | undefined)[] = items.map(() => undefined);
  const stale: Stale[] = items.map(() => ({ primary: [], companions: {} }));
  const olds: (RagMetadata | undefined)[] = items.map(() => undefined);
  await Promise.all(
    items.map(async (it, i) => {
      if (!it.canonical) return;
      const r = await rag.getById(it.canonical.id, options);
      if (!r.ok) {
        failures[i] = `read-failed: ${r.error.message}`;
        return;
      }
      const old = r.value?.metadata;
      olds[i] = old;
      const keep = new Set([...it.others.map((x) => x.id), it.canonical.id]);
      stale[i].primary = [
        ...new Set([...listed(old), ...listed(old, 'staleRecordIds')]),
      ].filter((id) => !keep.has(id));
      const now = listedCompanions(it.canonical.metadata);
      const was = listedCompanions(old);
      const wasStale = listedCompanions(old, 'staleCompanionRecordIds');
      for (const name of Object.keys(companions)) {
        const keepC = new Set(now[name] ?? []);
        const ids = [
          ...new Set([...(was[name] ?? []), ...(wasStale[name] ?? [])]),
        ].filter((id) => !keepC.has(id));
        if (ids.length > 0) stale[i].companions[name] = ids;
      }
    }),
  );
  // Write ahead (F3): the canonical carries what must still be deleted — and
  // clears the old extras it no longer has (merging stores).
  const prepared = items.map((it, i) =>
    it.canonical
      ? { ...it, canonical: withStale(clearingOld(it.canonical, olds[i]), stale[i]) }
      : it,
  );
  const live = prepared.filter((_, i) => failures[i] === undefined);
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
  const indexed = await Promise.all(
    prepared.map(async (it, i) => {
      if (failures[i] !== undefined) return false;
      const ids = [...it.others, ...(it.canonical ? [it.canonical] : [])].map((r) => r.id);
      if (!ids.every((id) => written.has(id))) {
        failures[i] = 'write-failed';
        return false;
      }
      if (!it.canonical || pendingCount(stale[i]) === 0) return true;
      // Delete every stale id, each Result checked (primary and companions).
      const left: Stale = {
        primary: await deleteAll(rag, stale[i].primary, options),
        companions: {},
      };
      for (const [name, cids] of Object.entries(stale[i].companions)) {
        const k = await deleteAll(companions[name], cids, options);
        if (k.length > 0) left.companions[name] = k;
      }
      // Settle: the canonical lists exactly what is still pending. If this write
      // fails, the written-ahead superset stays — retrying a deleted id is a no-op.
      await writeAll(rag, [withStale(it.canonical, left)], vectors, new Set<string>(), options);
      const n = pendingCount(left);
      if (n > 0) {
        failures[i] = `cleanup-failed: ${n} stale record(s) kept for retry`;
        return false;
      }
      return true;
    }),
  );
  return {
    indexed,
    records: written.size,
    failures,
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
      // RagMetadata's index signature types itemId as unknown (TS2322 against id?: string);
      // a canonical always carries a string one.
      id:
        typeof canonical.metadata.itemId === 'string'
          ? canonical.metadata.itemId
          : canonical.metadata.id,
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
 * Delete what the canonical lists AND what it still has pending (F3) — the
 * companion records in the given companion stores (S7), then its own store's
 * records — then the canonical. Every delete is tried; if any fails, the
 * canonical is KEPT (so a retry finds the list) and an error is returned.
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
  const meta = r.value.metadata;
  let n = 0;
  let failed = 0;
  const del = async (
    w: ReturnType<NonNullable<IRag['writer']>> | undefined,
    id: string,
  ): Promise<void> => {
    if (!w) return;
    try {
      const d = await w.deleteByIdRaw(id, options);
      if (!d.ok) failed++;
      else if (d.value) n++;
    } catch {
      failed++;
    }
  };
  const listedC = listedCompanions(meta);
  const staleC = listedCompanions(meta, 'staleCompanionRecordIds');
  for (const name of new Set([...Object.keys(listedC), ...Object.keys(staleC)])) {
    const cw = companions?.[name]?.writer?.();
    if (!cw) continue;
    for (const id of new Set([...(listedC[name] ?? []), ...(staleC[name] ?? [])])) {
      await del(cw, id);
    }
  }
  for (const id of new Set([...listed(meta), ...listed(meta, 'staleRecordIds')])) {
    await del(writer, id);
  }
  if (failed > 0) {
    return {
      ok: false,
      error: new RagError(
        `remove: ${failed} record delete(s) failed; the item is kept so a retry finds them`,
      ),
    };
  }
  await del(writer, canonicalId);
  if (failed > 0) {
    return { ok: false, error: new RagError('remove: the canonical record delete failed') };
  }
  return { ok: true, value: n };
}
```

Append to `collections/index.ts`:
```ts
export { asItem } from './record-writer.js';
```

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts
```
Expected: PASS (`tsc -b` type-checks `record-writer.ts` and `collections/index.ts`; the tsx run does not). (If `VectorRag` writes ids into `metadata.id` differently from `InMemoryRag`, `getById(recordId(...))` must still find the record — VectorRag replaces "the slot with the same `metadata.id`", spec §3.1.) The replacement test runs on `InMemoryRag` and `VectorRag` — the two stores that merge metadata (table above); a `tsc` error naming `UNSET_RESERVED` means `ReservedRecordKey` gained or lost a key: list it there.

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

Spec §4.1–§4.4 (incl. the service-record drop, D43), §4.6 (hydration), §4.9; D14, D15. The reranker (Task 13), decomposer (Task 14) and telemetry (Task 28) build on this file.

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
  // A record without itemId passes through as itself. A hit carrying `serviceRecord` is dropped (spec §4.3, D43).
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
  type IItemCut,
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

  it('a service record (serviceRecord set) is dropped: not an item, not an orphan (D43)', async () => {
    const raw = new InMemoryRag();
    await raw.writer().upsertRaw('tools-corpus', 'needle service', { serviceRecord: { kind: 'tools-corpus' } });
    const rag = matchesOnly(raw);
    const r = await staged(primary(rag)).retrieve(rag, q('needle'), 3);
    assert.ok(r.ok);
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

  it('the cut is applied once: at most min(k, cut.limit(k)) items — the caller k caps every cut (F1)', async () => {
    const raw = new InMemoryRag();
    for (const id of ['a', 'b', 'c', 'd']) await put(raw, id, [['full', `needle ${id}x`]]);
    const rag = matchesOnly(raw);
    const fixed = await staged(primary(rag), { cut: new FixedItemsCut(2) }).retrieve(rag, q('needle'), 10);
    assert.ok(fixed.ok && fixed.value.length === 2);
    const capped = await staged(primary(rag), { cut: new FixedItemsCut(3) }).retrieve(rag, q('needle'), 1);
    assert.ok(capped.ok && capped.value.length === 1);
    const top = await staged(primary(rag)).retrieve(rag, q('needle'), 3);
    assert.ok(top.ok && top.value.length === 3);
    // a consumer cut whose limit ignores k is still capped by StagedRetrieval
    const greedy: IItemCut = { name: 'greedy', limit: () => 10, cut: (items) => [...items] };
    const g = await staged(primary(rag), { cut: greedy }).retrieve(rag, q('needle'), 2);
    assert.ok(g.ok && g.value.length === 2);
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
    // The caller's k caps every cut, a consumer's included (spec §4.5, F1).
    const budget = Math.min(k, this.cut.limit(k));
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
        // A store's service record (deployToolsCorpus, spec §4.3, D43) is never
        // an item: not passed through, not an orphan, not reranked.
        if (h.metadata.serviceRecord !== undefined) continue;
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts
```
Expected: PASS (`tsc -b` type-checks `staged-retrieval.ts` and `collections/index.ts`; the tsx run does not).

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

Spec §4.6 (reranker text), §4.7 (incl. F5: pinned items carry reranked scores; `keepStage1Top` / the `stage1` fallback never with `ScoreFloorCut`), §4.8, §9.1 (session step), §9.3.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/rerank-check.ts`
- Modify: `packages/llm-agent-libs/src/collections/staged-retrieval.ts` (replace `rank`, add `itemText`, the two `ScoreFloorCut` rejections in the constructor)
- Create: `packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`

**Interfaces:**
- Consumes: Task 12 (`Unit`, `RunContext`, `canonicalOf`); `ScoreFloorCut` (Task 6); for the tests `ProbabilityReranker`, `RelevanceReranker` (`@mcp-abap-adt/llm-agent-reranker`, Tasks 4B–4C).
- Produces:
  ```ts
  export function checkRerankOutput(candidates: readonly RagResult[], out: readonly RagResult[]): string | undefined; // undefined = valid
  // StagedRetrieval: reranker failure → session step 'retrieval_rerank_error' { store, strategy, code, message };
  //   onFailure 'stage1' → stage-1 order AND stage-1 scores (stats.rerankOutcome 'fallback'); 'error' → RagError code 'RERANK_ERROR' (stats 'error').
  // keepStage1Top n > 0 → the stage-1 top-n first, each with its RERANKED score; the rest by reranked score.
  // constructor throws: keepStage1Top > 0 with ScoreFloorCut; ScoreFloorCut with rerank.onFailure 'stage1' (spec §4.7, F5).
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CallOptions,
  type IItemCut,
  InMemoryRag,
  type IProbabilityDecision,
  type IRag,
  type IRelevanceDecision,
  type IReranker,
  RagError,
  type RagResult,
  type RetrievalSource,
  recordId,
} from '@mcp-abap-adt/llm-agent';
import { ProbabilityReranker, RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import {
  checkRerankOutput,
  ItemPool,
  MaxScoreCollapse,
  ScoreFloorCut,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from '../index.js';
import { G, ids, matchesOnly, put, q } from './staged-retrieval-helpers.js';

function staged(
  rag: IRag,
  rerank: StagedRetrievalOptions['rerank'],
  extra: (o?: CallOptions) => RetrievalSource[] = () => [],
  cut?: IItemCut,
) {
  return new StagedRetrieval({
    name: 'test',
    storeKey: 'tools',
    pool: new ItemPool(10),
    maxRecordsPerItem: 3,
    canonicalKind: 'full',
    sources: { sources: async (options) => [{ name: 'primary', rag, role: 'items', options }, ...extra(options)] },
    collapse: new MaxScoreCollapse(),
    rerank,
    ...(cut ? { cut } : {}),
  });
}

/** A probability decision answering P(relevant) per passage text. */
function probabilityDecision(p: ReadonlyMap<string, number>): IProbabilityDecision {
  return {
    decide: async (req) => ({
      ok: true,
      value: {
        model: 'fake',
        answers: Object.fromEntries(
          Object.entries(req.questions).map(([k, qq]) => [
            k,
            { type: 'noul' as const, probability: p.get(String((qq as { instructions: { passage: string } }).instructions.passage)) ?? 0 },
          ]),
        ),
      },
    }),
  };
}

/** A relevance decision answering a score per passage text — not a probability. */
function relevanceDecision(s: ReadonlyMap<string, number>): IRelevanceDecision {
  return {
    score: async ({ passages }) => ({
      ok: true,
      value: { model: 'fake', scores: passages.map((text, index) => ({ index, score: s.get(text) ?? 0 })) },
    }),
  };
}

/** Reranked scores by stage-1 rank: the stage-1 top gets the LOWEST, so a pinned item is visible. */
const RERANKED = { probability: [0.05, 0.9, 0.8], relevance: [-3.5, 9.25, 4.5] } as const;
const floor = () => new ScoreFloorCut({ minItems: 1, maxItems: 3, minScore: 0.5 });

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

  for (const kind of ['probability', 'relevance'] as const) {
    it(`keepStage1Top: a pinned item carries its RERANKED score, never the embedding score (${kind})`, async () => {
      const rag = await fixture();
      const stage1 = await staged(rag, undefined).retrieve(rag, q('needle'), 3);
      assert.ok(stage1.ok && stage1.value.length === 3);
      const given = new Map(stage1.value.map((x, i) => [x.text, RERANKED[kind][i]] as const));
      const reranker: IReranker =
        kind === 'probability'
          ? new ProbabilityReranker(probabilityDecision(given))
          : new RelevanceReranker(relevanceDecision(given));
      const r = await staged(rag, { reranker, onFailure: 'stage1', keepStage1Top: 1 }).retrieve(rag, q('needle'), 3);
      assert.ok(r.ok && r.value.length === 3);
      assert.equal(r.value[0].metadata.id, stage1.value[0].metadata.id, 'pinned first, though the reranker put it last');
      for (const x of r.value) assert.equal(x.score, given.get(x.text), `${String(x.metadata.id)} carries its reranked score`);
      assert.notEqual(r.value[0].score, stage1.value[0].score, 'never the stage-1 (embedding) score');
      assert.deepEqual(
        r.value.slice(1).map((x) => x.score),
        [...RERANKED[kind].slice(1)].sort((a, b) => b - a),
        'the rest by reranked score',
      );
    });
  }

  it("a failed rerank under 'stage1' with keepStage1Top returns the stage-1 result — its ids AND its stage-1 scores", async () => {
    const rag = await fixture();
    const stage1 = await staged(rag, undefined).retrieve(rag, q('needle'), 3);
    const { reranker } = spy(() => new Error('bad'));
    const r = await staged(rag, { reranker, onFailure: 'stage1', keepStage1Top: 1 }).retrieve(rag, q('needle'), 3);
    assert.ok(stage1.ok && r.ok);
    assert.deepEqual(
      r.value.map((x) => [x.metadata.id, x.score]),
      stage1.value.map((x) => [x.metadata.id, x.score]),
    );
  });

  it('keepStage1Top with ScoreFloorCut is rejected at construction (keepStage1Top is unmeasured, D7)', async () => {
    const rag = await fixture();
    const { reranker } = spy(reversed);
    for (const onFailure of ['stage1', 'error'] as const) {
      assert.throws(
        () => staged(rag, { reranker, onFailure, keepStage1Top: 1 }, undefined, floor()),
        /^Error: StagedRetrieval: keepStage1Top cannot be combined with ScoreFloorCut — keepStage1Top is unmeasured \(D7\)/,
      );
    }
    // keepStage1Top with a rank-order cut stays allowed
    assert.doesNotThrow(() => staged(rag, { reranker, onFailure: 'stage1', keepStage1Top: 1 }));
  });

  it("ScoreFloorCut with a reranker needs onFailure 'error' — a stage1 fallback would cut stage-1 scores", async () => {
    const rag = await fixture();
    const { reranker } = spy(reversed);
    assert.throws(
      () => staged(rag, { reranker, onFailure: 'stage1' }, undefined, floor()),
      /^Error: StagedRetrieval: ScoreFloorCut with a reranker needs rerank\.onFailure 'error'/,
    );
    assert.doesNotThrow(() => staged(rag, { reranker, onFailure: 'error' }, undefined, floor()));
    assert.doesNotThrow(() => staged(rag, undefined, undefined, floor()), 'without a reranker the floor cuts stage-1 scores, calibrated on them');
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

Run:
```bash
npx tsc -b packages/llm-agent-reranker
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts
```
Expected: FAIL — `checkRerankOutput` not exported. (Once it is, the pinned-score cases fail on the pinned item's stage-1 score and the two rejection cases on "Missing expected exception" until Step 3 is in.)

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

In `staged-retrieval.ts`: add `RagError` as a value import (change `type RagError` to `RagError` in the import list), import `checkRerankOutput` from `./rerank-check.js`, change `import { TopItemsCut } from './cuts.js'` to `import { ScoreFloorCut, TopItemsCut } from './cuts.js'`, add `const MAX_THROWN_MESSAGE = 500;` at module level, append to the end of the constructor (after `this.cut = …`, so a consumer's `cut` is the one checked):

```ts
    // Spec §4.7 (F5): pinned items are unmeasured (D7), and a 'stage1' fallback
    // returns stage-1 scores — a threshold calibrated on reranked scores must
    // see neither.
    const rr = options.rerank;
    if (rr && this.cut instanceof ScoreFloorCut) {
      if ((rr.keepStage1Top ?? 0) > 0) {
        throw new Error(
          'StagedRetrieval: keepStage1Top cannot be combined with ScoreFloorCut — keepStage1Top is unmeasured (D7); a threshold over a pinned head would let an unmeasured order decide what a calibrated threshold keeps',
        );
      }
      if (rr.onFailure !== 'error') {
        throw new Error(
          "StagedRetrieval: ScoreFloorCut with a reranker needs rerank.onFailure 'error' — a 'stage1' fallback returns stage-1 scores, which a threshold calibrated on reranker scores must not cut",
        );
      }
    }
```

and replace the `rank` method with:

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
    // Pinned items keep their stage-1 PLACE but carry their RERANKED score
    // (spec §4.7, F5): one scale across the result. The output check above
    // guarantees every live unit has a reranked entry.
    const rerankedByKey = new Map(reranked.map((u) => [u.key, u] as const));
    const head: Unit[] = [];
    for (const u of live.slice(0, keepTop)) {
      const scored = rerankedByKey.get(u.key);
      if (scored) head.push(scored);
    }
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-rerank.test.ts packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts
```
Expected: PASS — incl. the pinned-score cases under both rerankers, the stage1-fallback case and both rejections. After this task the `@mcp-abap-adt/llm-agent` import of `staged-retrieval.ts` is: `type CallOptions, type ICandidatePool, type ICollapseRule, type IItemCut, type IQueryDecomposer, type IQueryEmbedder, type IQueryEmbedding, type IRag, type IReranker, type IRetrievalMetrics, type IRetrievalStrategy, type ISourceSelector, type ITracer, matchesRagIdentity, RagError, type RagResult, type Result, type RetrievalSource, ragIdentityFilter, recordId, type SourcedHit` — every name used.

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
- Produces: decomposer errors and failed checks → `RagError(…, 'DECOMPOSE_ERROR')`; at most `min(k, cut.limit(k))` ≤ k items in every case. Exported helper `resultKey(r: RagResult): string` (owner-qualified item key of a returned result) — used by Task 30's kit test.

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

  it('the budget handed to the decomposer is min(k, cut.limit(k)) (F1)', async () => {
    const seen: Array<[string, number]> = [];
    const rag = await fixture();
    const s = staged(rag, { cut: new FixedItemsCut(3), decompose: { decomposer: decomposer([], seen), queryEmbedder: embedder } });
    await s.retrieve(rag, q('apple'), 20);
    await s.retrieve(rag, q('apple'), 2);
    assert.deepEqual(seen, [['apple', 3], ['apple', 2]]);
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
    // The caller's k caps every cut, also after decomposition (spec §4.5, F1).
    const budget = Math.min(k, this.cut.limit(k));
    const finish = (items: RagResult[]): Result<RagResult[], RagError> => ({
      ok: true,
      value: this.cut.cut(items, k).slice(0, budget),
    });
    const d = this.options.decompose;
    let subs: readonly SubQuery[] = [];
    if (d) {
      const decomposed = await this.decomposeQuery(d.decomposer, query.text, budget, callOptions);
      if (!decomposed.ok) return decomposed;
      subs = decomposed.value;
    }
    if (!d || subs.length === 0) {
      const run = await this.runOne(query, budget, newRunContext(callOptions));
      return run.ok ? finish(run.value) : run;
    }
    const runs = await Promise.all(
      subs.map((s) =>
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

Add `resultKey` to the `staged-retrieval.js` export line in `collections/index.ts`:
```ts
export {
  resultKey,
  type RunStats,
  StagedRetrieval,
  type StagedRetrievalOptions,
} from './staged-retrieval.js';
```

After this task the `@mcp-abap-adt/llm-agent` import of `staged-retrieval.ts` is Task 13's list plus `QueryEmbedding` (value, after `matchesRagIdentity`) and `type SubQuery` (after `type SourcedHit`); `itemKey` and `ownerFromMetadata` (from `./owner.js`, Task 12) are now used by `resultKey` as well.

- [ ] **Step 4: Run all StagedRetrieval tests**

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval*.test.ts
```
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
- Consumes: `StagedRetrieval` (Tasks 12–14); `prepareItem`, `storeItems` (with the companion stores, F3), `getItem`, `removeItem` (Task 11); `isIndexNoteSource`, `IndexNote` (Task 3); `StrategyRag`, `hasRetrievalStrategy` (`src/retrieval/strategy-rag.ts`); indexers of Tasks 8–10.
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts
```
Expected: PASS (`tsc -b` type-checks the edited sources; the tsx run does not, and `__tests__/**` is excluded from the package build).

- [ ] **Step 5: Companion records on remove and replacement (S7); notes in the report (S1)**

Spec §3.3 (amended): the canonical record lists the item's companion records in `companionRecordIds`; `remove` and replacement delete them from the companion store — through Task 11's `storeItems` / `removeItem`, which check every delete and keep failures in `staleCompanionRecordIds` for retry (F3). Spec §7.3.2: the binding collects `IIndexNoteSource` notes into `IndexReport.notes`. Write order (spec §3.3): companion records → primary non-canonical → canonical → stale deletes in each store.

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

  it('F3: a failed stale companion delete is reported cleanup-failed and retried by the next index', async () => {
    const rag = new InMemoryRag();
    const rawIntents = new InMemoryRag();
    const cid = recordId(G, 'tool:read_file', 'intent', 0);
    let fail = true;
    const w = rawIntents.writer();
    const intents = {
      ...rawIntents,
      query: rawIntents.query.bind(rawIntents),
      getById: rawIntents.getById.bind(rawIntents),
      writer: () => ({ ...w, deleteByIdRaw: async (id: string, o?: CallOptions) => (fail && id === cid ? { ok: false as const, error: new RagError('down') } : w.deleteByIdRaw(id, o)) }),
    } as IRag;
    await companionProfile({ read_file: ['open my notes'] }).bind({ key: 'tools', rag, companions: { intents } }).index(TOOLS);
    const again = companionProfile({}).bind({ key: 'tools', rag, companions: { intents } });
    const r1 = await again.index(TOOLS);
    assert.ok(r1.ok);
    assert.deepEqual(r1.value.failedItems.map((f) => f.itemId), ['tool:read_file']);
    assert.match(r1.value.failedItems[0].reason, /^cleanup-failed/);
    fail = false;
    const r2 = await again.index(TOOLS);
    assert.ok(r2.ok && r2.value.failedItems.length === 0);
    const gone = await rawIntents.getById(cid);
    assert.ok(gone.ok && gone.value === null);
    const n = await again.remove([{ itemId: 'tool:read_file', owner: G }]);
    assert.ok(n.ok);
    const canon = await rag.getById(recordId(G, 'tool:read_file', 'full', 0));
    assert.ok(canon.ok && canon.value === null);
  });

  it('a failed companion write fails the item before its primary records are written', async () => {
    const rag = new InMemoryRag();
    // InMemoryRag.writer() returns a FRESH object per call (in-memory-rag.ts `writer()`), so
    // patching one writer instance changes nothing: wrap the store instead.
    const raw = new InMemoryRag();
    const broken = {
      query: raw.query.bind(raw),
      healthCheck: raw.healthCheck.bind(raw),
      getById: raw.getById.bind(raw),
      writer: () => ({ ...raw.writer(), upsertRaw: async () => ({ ok: false as const, error: new RagError('down') }) }),
    } as IRag;
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
Add `RagError` and `type CallOptions` to the test's `@mcp-abap-adt/llm-agent` import; the complete import is:
```ts
import {
  type CallOptions,
  InMemoryRag,
  type IRag,
  RagError,
  recordId,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
```

Run it: FAIL — no `companionRecordIds`; `remove` leaves the intent; no `notes`.

In `composed-tools-profile.ts`: add `type IndexNote`, `isIndexNoteSource` to the `@mcp-abap-adt/llm-agent` import. Replace `ToolsBinding.index` and `ToolsBinding.remove` with:

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
    // S7 + F3: storeItems deletes the stale companion records too (every Result checked)
    // and reports `cleanup-failed` when one is kept for retry.
    const main = await storeItems(
      this.target.rag,
      live.map((x) => x.item),
      options,
      Object.fromEntries(this.companions.map(([name, , rag]) => [name, rag])),
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts packages/llm-agent-libs/src/collections/__tests__/record-writer.test.ts
```
Expected: PASS; `tsc -b` type-checks the replaced `index` / `remove` and the added `IndexNote` / `isIndexNoteSource` imports (the earlier tests too: with no companions and no notes the report has no `notes` key and `companionRecordIds` is not written).

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

Spec §7.1, §7.4 (the table — every tuned number cites it), §5.5 (`faceted-cohere` = `RelevanceReranker` over an `IRelevanceDecision`; `faceted-jev`, `small-set-jev` = `ProbabilityReranker` over an `IProbabilityDecision`); §4.9 (every `FixedItemsCut` is a ceiling under k); D11, D16, D23, D24, D27.

**Files:**
- Create: `packages/llm-agent-libs/src/collections/mcp-tools-variants.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts`
- Modify: `packages/llm-agent-libs/src/collections/index.ts`, `tsconfig.typecheck.json`

**Interfaces:**
- Consumes: `ComposedToolsProfile` (Task 15); `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `ItemPool`, `MaxScoreCollapse`, `FixedItemsCut`; `ProbabilityReranker`, `RelevanceReranker`, `TOOL_QUESTION` (`@mcp-abap-adt/llm-agent-reranker`, Tasks 4B–4C); `IProbabilityDecision`, `IRelevanceDecision`, `IReranker`, `IToolIntentSource`. (Libs never imports a provider package: Cohere's `SapAiCoreRelevanceDecision` of Task 18 arrives as an `IRelevanceDecision`, Jev as an `IProbabilityDecision`.)
- Produces:
  ```ts
  export type VariantIntents = { readonly record: IToolIntentSource } | { readonly companion: IToolIntentSource };
  export interface VariantOptions { readonly intents?: VariantIntents; readonly decompose?: StagedRetrievalOptions['decompose']; readonly telemetry?: StagedRetrievalOptions['telemetry'] }
  export const mcpToolsVariants: {
    baseline(): undefined;
    faceted(o?: VariantOptions): ComposedToolsProfile;
    facetedCohere(o: VariantOptions & { relevanceDecision: IRelevanceDecision }): ComposedToolsProfile; // Cohere: SapAiCoreRelevanceDecision
    facetedJev(o: VariantOptions & { probabilityDecision: IProbabilityDecision }): ComposedToolsProfile;
    smallSetJev(o: VariantOptions & { probabilityDecision: IProbabilityDecision; poolItems: number }): ComposedToolsProfile;
  };
  export const MCP_TOOLS_VARIANT_NAMES: readonly ['baseline', 'faceted', 'faceted-cohere', 'faceted-jev', 'small-set-jev'];
  // companion placement binds with companions: { intents: <IRag> }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IItemIndexer,
  IProbabilityDecision,
  IRelevanceDecision,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { ProbabilityReranker, RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
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
  ParameterNamesToolText,
  ParametersFacet,
  StaticIntentSource,
  SummaryFacet,
  TokenBudgetCut,
} from '../index.js';

const model: IProbabilityDecision = { decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) };
const cohere: IRelevanceDecision = { model: 'cohere-rerank', score: async () => ({ ok: true, value: { model: 'cohere-rerank', scores: [] } }) };

function shape(p: ComposedToolsProfile) {
  const c = p.composition;
  return {
    pool: (c.pool as ItemPool).items,
    collapse: c.collapse instanceof MaxScoreCollapse,
    cut: c.cut instanceof FixedItemsCut ? c.cut.n : undefined,
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
  mcpToolsVariants.facetedCohere({ relevanceDecision: cohere }),
  mcpToolsVariants.facetedJev({ probabilityDecision: model }),
  mcpToolsVariants.smallSetJev({ probabilityDecision: model, poolItems: 25 }),
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
  it('faceted-cohere: ItemPool(30) + RelevanceReranker over the given relevance decision + FixedItemsCut(5)', () => {
    const s = shape(mcpToolsVariants.facetedCohere({ relevanceDecision: cohere }));
    assert.ok(s.reranker instanceof RelevanceReranker);
    assert.deepEqual({ ...s, reranker: undefined }, { pool: 30, collapse: true, cut: 5, reranker: undefined, onFailure: 'stage1', decompose: undefined });
  });
  it('faceted-cohere and faceted-jev share indexing, pool, collapse and cut; only the reranker differs (spec §5.5)', () => {
    const c = shape(mcpToolsVariants.facetedCohere({ relevanceDecision: cohere }));
    const j = shape(mcpToolsVariants.facetedJev({ probabilityDecision: model }));
    assert.deepEqual({ ...c, reranker: undefined }, { ...j, reranker: undefined });
  });
  it('faceted-jev: ItemPool(30) + ProbabilityReranker + FixedItemsCut(5)', () => {
    const s = shape(mcpToolsVariants.facetedJev({ probabilityDecision: model }));
    assert.ok(s.reranker instanceof ProbabilityReranker);
    assert.deepEqual([s.pool, s.cut], [30, 5]);
  });
  it('small-set-jev: FacetedToolIndexer([]) + ItemPool(poolItems) + max + ProbabilityReranker + FixedItemsCut(3)', () => {
    const p = mcpToolsVariants.smallSetJev({ probabilityDecision: model, poolItems: 25 });
    assert.deepEqual(facetsOf(p.composition.indexer), []);
    const s = shape(p);
    assert.ok(s.reranker instanceof ProbabilityReranker);
    assert.deepEqual([s.pool, s.cut, s.collapse], [25, 3, true]);
  });
  it('every variant cut is a ceiling under the caller k (F1)', () => {
    for (const p of all()) assert.equal(p.composition.cut?.limit(2), 2);
  });
  it('the default provider text stays C0 (ParameterNamesToolText) in every variant (F4)', () => {
    for (const p of all()) {
      const base = p.composition.indexer instanceof IntentRecordIndexer ? p.composition.indexer.inner : p.composition.indexer;
      assert.ok(base instanceof FacetedToolIndexer && base.text instanceof ParameterNamesToolText);
    }
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
    assert.equal(mcpToolsVariants.facetedJev({ probabilityDecision: model, decompose }).composition.decompose, decompose);
    for (const p of all()) assert.equal(p.composition.decompose, undefined);
  });
  it('poolItems must be a positive integer', () => {
    assert.throws(() => mcpToolsVariants.smallSetJev({ probabilityDecision: model, poolItems: 0 }));
  });
});
```

```ts
// packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts
// Compile-time assertions only: listed in tsconfig.typecheck.json, run by `npm run typecheck`.
import type {
  IProbabilityDecision,
  IRelevanceDecision,
  IToolIntentSource,
} from '@mcp-abap-adt/llm-agent';
import { mcpToolsVariants } from '../mcp-tools-variants.js';

declare const model: IProbabilityDecision;
declare const cohere: IRelevanceDecision;
declare const intents: IToolIntentSource;
export const _ok = mcpToolsVariants.smallSetJev({ probabilityDecision: model, poolItems: 25 });
export const _okCohere = mcpToolsVariants.facetedCohere({ relevanceDecision: cohere });
// @ts-expect-error intents are refused on baseline
export const _baselineIntents = mcpToolsVariants.baseline({ intents: { record: intents } });
// @ts-expect-error small-set-jev needs poolItems
export const _noPool = mcpToolsVariants.smallSetJev({ probabilityDecision: model });
// @ts-expect-error faceted-jev needs a probability decision
export const _noModel = mcpToolsVariants.facetedJev({});
// @ts-expect-error faceted-cohere needs a relevance decision (Cohere: SapAiCoreRelevanceDecision)
export const _noCohere = mcpToolsVariants.facetedCohere({});
// @ts-expect-error faceted-cohere does not take a probability decision (spec §5.5)
export const _wrongKind = mcpToolsVariants.facetedCohere({ relevanceDecision: model });
// @ts-expect-error small-set-jev does not take a relevance decision
export const _wrongKind2 = mcpToolsVariants.smallSetJev({ probabilityDecision: cohere, poolItems: 25 });
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
  IItemIndexer,
  IProbabilityDecision,
  IRelevanceDecision,
  IReranker,
  IToolIntentSource,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
// spec §5.5: Cohere = RelevanceReranker over an IRelevanceDecision (SapAiCoreRelevanceDecision);
// Jev = ProbabilityReranker over an IProbabilityDecision (TypeSafeDecisionModel).
import {
  ProbabilityReranker,
  RelevanceReranker,
  TOOL_QUESTION,
} from '@mcp-abap-adt/llm-agent-reranker';
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

/** Jev: ProbabilityReranker + TOOL_QUESTION wording (spec §5.5). */
const probabilityToolReranker = (decision: IProbabilityDecision): IReranker =>
  new ProbabilityReranker(decision, {
    task: TOOL_QUESTION.task,
    criteria: TOOL_QUESTION.criteria,
  });

/** Cohere: RelevanceReranker — no wording; batched by default, ≤ 30 tools fit one call (spec §5.2).
 *  Its scores are NOT probabilities; no default thresholds them. */
const relevanceToolReranker = (decision: IRelevanceDecision): IReranker =>
  new RelevanceReranker(decision);

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

  /** Fine-grained + Cohere on SAP AI Core: pass a SapAiCoreRelevanceDecision. Pool 30
   *  ITEMS (non-English 0.962 vs 0.846–0.885 with 30 records), at most 5 (a ceiling
   *  under k). Not measured as one composition. ≤ 30 tools per query → one /rerank call. */
  facetedCohere(o: VariantOptions & { relevanceDecision: IRelevanceDecision }): ComposedToolsProfile {
    return new ComposedToolsProfile({
      ...indexing(facetedBase(), o.intents),
      pool: new ItemPool(30),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: relevanceToolReranker(o.relevanceDecision), onFailure: 'stage1' },
      cut: new FixedItemsCut(5),
      ...passThrough(o),
    });
  },

  /** Fine-grained + TypeSafe Jev. Pool 30 items, k=5. TO BE MEASURED AS ONE
   *  COMPOSITION ON FRESH CONSUMER QUERIES BEFORE PROMOTION (D11). */
  facetedJev(o: VariantOptions & { probabilityDecision: IProbabilityDecision }): ComposedToolsProfile {
    return new ComposedToolsProfile({
      ...indexing(facetedBase(), o.intents),
      pool: new ItemPool(30),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: probabilityToolReranker(o.probabilityDecision), onFailure: 'stage1' },
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
    o: VariantOptions & { probabilityDecision: IProbabilityDecision; poolItems: number },
  ): ComposedToolsProfile {
    assertPositiveInteger('smallSetJev', 'poolItems', o.poolItems);
    return new ComposedToolsProfile({
      ...indexing(new FacetedToolIndexer([]), o.intents),
      pool: new ItemPool(o.poolItems),
      collapse: new MaxScoreCollapse(),
      rerank: { reranker: probabilityToolReranker(o.probabilityDecision), onFailure: 'stage1' },
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
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/mcp-tools-variants.test.ts
npm run typecheck
```
Expected: PASS; exit 0. `tsc -b` type-checks `mcp-tools-variants.ts` under the package build and (re)builds the referenced `llm-agent-reranker` `dist/`, which `npm run typecheck` resolves `@mcp-abap-adt/llm-agent-reranker` to.

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

In `collection-profile.typecheck.ts`, replace the Task 16 import block with this complete one (one import per module; every name used):
```ts
import type {
  ICollectionProfile,
  IProbabilityDecision,
  IRelevanceDecision,
  IToolIntentSource,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { ItemPool } from '../item-pool.js';
import { MaxScoreCollapse } from '../max-score-collapse.js';
import { mcpToolsVariants } from '../mcp-tools-variants.js';
import { SharedItemsProfile } from '../shared-items-profile.js';
```
and append:
```ts

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
npx tsc -b packages/llm-agent-libs
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

## Task 18: New package `@mcp-abap-adt/sap-aicore-decision` — `SapAiCoreRelevanceDecision`

Spec §5.3, §5.4, §11; D2 (amended twice), D10, D25. Same shape as `typesafe-decision`: one vendor, one role, peers only, plain `fetch`. Cohere Rerank on SAP AI Core is an **`IRelevanceDecision`** (Task 4A) — a relevance score per passage, **not** a probability; `RelevanceReranker` (Task 4C) adapts it (Tasks 16, 22, 24). The withdrawn `SapAiCoreDecisionModel` (Cohere behind `IDecisionModel`) is not built.

**Files:**
- Create: `packages/sap-aicore-decision/package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`
- Create (copies): `packages/sap-aicore-decision/LICENSE`, `packages/sap-aicore-decision/GPL-3.0.txt` (from `packages/typesafe-decision/`)
- Create: `packages/sap-aicore-decision/src/index.ts`, `src/sap-aicore-relevance-decision.ts`, `src/map-rerank.ts`, `src/__tests__/fake-fetch.ts`, `src/__tests__/sap-aicore-relevance-decision.test.ts`
- Modify: root `package.json` (`build`, `clean` lists — after `packages/typesafe-decision`), `scripts/publish-all.sh` (`PACKAGES`, after `typesafe-decision` — the order list only; nothing is published here), `packages/llm-agent-server/package.json` (`dependencies`), `packages/llm-agent-server/tsconfig.json` (`references`), `package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: `IRelevanceDecision`, `RelevanceRequest`, `RelevanceResult`, `RelevanceScore`, `DecisionError`, `DecisionErrorCode`, `CallOptions`, `Result` (`@mcp-abap-adt/llm-agent`, Task 4A — the codes used all exist: `DECISION_INVALID_REQUEST`, `DECISION_AUTH`, `DECISION_RATE_LIMITED`, `DECISION_UNAVAILABLE`, `DECISION_ABORTED`, `DECISION_ERROR`; `DECISION_UNSUPPORTED_QUESTION` is never returned); `IBearerCredential` (`@mcp-abap-adt/interfaces-auth`, `token(): Promise<string>`).
- No dependency on `@mcp-abap-adt/sap-aicore-auth`: the AI Core token exchange is reused through the composition root (`credential-for.ts` → `serviceKeyCredential` → `TokenProvider`), exactly as the AI Core embedder and LLM receive their injected `IBearerCredential` (spec §5.3, verified in the repo).
- Produces:
  ```ts
  export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
  export interface SapAiCoreRelevanceConfig { deploymentId: string; model: string; resourceGroup?: string; apiBaseUrl: string; credential: IBearerCredential; fetch?: FetchLike }
  export const SAP_AICORE_DEFAULT_RESOURCE_GROUP = 'default';
  export class SapAiCoreRelevanceDecision implements IRelevanceDecision { constructor(cfg: SapAiCoreRelevanceConfig); readonly model: string }
  // score({ query, passages }) → ONE
  //   POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank
  //   { model, query, documents: passages, top_n: passages.length }
  //   → scores: results.map(r => ({ index: r.index, score: r.relevance_score }))  — NOT a probability
  // otherwise DecisionError (codes above); never a zero-filled or dropped score
  ```

- [ ] **Step 1: Scaffold the package**

```json
// packages/sap-aicore-decision/package.json
{
  "name": "@mcp-abap-adt/sap-aicore-decision",
  "version": "30.1.0",
  "description": "Cohere Rerank on an SAP AI Core deployment as a relevance decision (IRelevanceDecision) for @mcp-abap-adt/llm-agent.",
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
(`version` 30.1.0 is the current lockstep version so the workspace resolves — not a bump; the release step bumps every package together and must raise the `llm-agent` peer floor to the release that first exports `IRelevanceDecision`. The peer ranges are the ones `typesafe-decision` declares, as `scoped-dependencies.test.ts` requires.)

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
printf '# Changelog\n\n## [Unreleased]\n\n- New package: `SapAiCoreRelevanceDecision`, Cohere Rerank on an SAP AI Core deployment as an `IRelevanceDecision` (one relevance score per passage — not a probability; one `/rerank` call per `score`). Adapted by `RelevanceReranker` (`@mcp-abap-adt/llm-agent-reranker`).\n' > packages/sap-aicore-decision/CHANGELOG.md
```

`packages/sap-aicore-decision/README.md`:
````markdown
# @mcp-abap-adt/sap-aicore-decision

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL_v3-blue.svg)](https://www.gnu.org/licenses/lgpl-3.0)

Cohere Rerank on **SAP AI Core** as a relevance decision (`IRelevanceDecision`) for `@mcp-abap-adt/llm-agent`.

**TL;DR** — `SapAiCoreRelevanceDecision` scores how relevant each passage is to a query. Put it into
`RelevanceReranker` (`@mcp-abap-adt/llm-agent-reranker`) and you have a Cohere reranker: in a
collection profile (`faceted-cohere`), in `rag.retrieval` (`reranker: decision` with
`decision.provider: sap-aicore`) or anywhere an `IReranker` is taken.

> **A relevance score is not a probability.** Scores for the same query from the same model are
> comparable (also across calls — `RelevanceReranker` batches and merges); never across queries or
> models. A threshold on them is your calibration for this provider; no default composition uses one.

```ts
import { RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import { mcpToolsVariants } from '@mcp-abap-adt/llm-agent-libs';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';
import { SapAiCoreRelevanceDecision } from '@mcp-abap-adt/sap-aicore-decision';

const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY ?? '');
const cohere = new SapAiCoreRelevanceDecision({
  deploymentId: 'd1234567890',   // the AI Core deployment serving the rerank model
  model: 'cohere-rerank',        // sent as `model`
  resourceGroup: 'default',      // header AI-Resource-Group (default 'default')
  apiBaseUrl,
  credential,
});

const reranker = new RelevanceReranker(cohere);                       // batched (48000 tokens / call), merged by score
const profile = mcpToolsVariants.facetedCohere({ relevanceDecision: cohere });
```

## What it does

- **One `/rerank` call per `score`:** `POST {apiBaseUrl}/v2/inference/deployments/{deploymentId}/rerank`,
  body `{ model, query, documents, top_n }`, header `AI-Resource-Group`.
- Returns `scores: [{ index, score }]` — `score` = Cohere's `relevance_score`, one per passage.
- No wording: a cross-encoder reads the query and the passages only.

## Errors — never a zero-filled score

| Failure | `DecisionError` code |
|---|---|
| empty query, no passages, an empty passage | `DECISION_INVALID_REQUEST` (nothing sent) |
| HTTP 401 / 403, or the credential gives no token | `DECISION_AUTH` |
| HTTP 429 | `DECISION_RATE_LIMITED` |
| HTTP 400 / 404 / 422 | `DECISION_INVALID_REQUEST` |
| HTTP 5xx, network failure | `DECISION_UNAVAILABLE` |
| `options.signal` aborted | `DECISION_ABORTED` |
| a wrong result count; a missing, duplicated, non-integer or out-of-range index; a non-finite score; a body that is not JSON | `DECISION_ERROR` |

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
- `scripts/publish-all.sh`: add `  sap-aicore-decision` after `  typesafe-decision` in `PACKAGES` (published after `llm-agent` and before `llm-agent-libs` / `llm-agent-server`, in dependency order: it depends only on `llm-agent`).
- `packages/llm-agent-server/package.json` `dependencies`: `"@mcp-abap-adt/sap-aicore-decision": "^30.1.0",` (alphabetical: after `sap-aicore-auth`, before `sap-aicore-embedder`).
- `packages/llm-agent-server/tsconfig.json` `references`: `{ "path": "../sap-aicore-decision" }`.

Run: `npm install` then `grep -n '"link": true' package-lock.json`
Expected: only `node_modules/@mcp-abap-adt/<workspace sibling>` entries resolving to `packages/*` (the new one included); nothing outside the repo.

- [ ] **Step 2: Write the failing test**

```ts
// packages/sap-aicore-decision/src/__tests__/fake-fetch.ts
/** A recorded request and a scripted response, for driving the provider offline. */
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
// packages/sap-aicore-decision/src/__tests__/sap-aicore-relevance-decision.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RelevanceRequest } from '@mcp-abap-adt/llm-agent';
import {
  type FetchLike,
  type SapAiCoreRelevanceConfig,
  SapAiCoreRelevanceDecision,
} from '../index.js';
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
const make = (fetch: FetchLike, extra: Partial<SapAiCoreRelevanceConfig> = {}) =>
  new SapAiCoreRelevanceDecision({ deploymentId: 'd1', model: 'cohere-rerank', apiBaseUrl: 'https://api.example/', credential, fetch, ...extra });
const req = (...passages: string[]): RelevanceRequest => ({ query: 'read a file', passages });
const scored = (scores: number[]) => (rec: Recorded) => ({
  status: 200,
  body: { results: (rec.body.documents ?? []).map((_, index) => ({ index, relevance_score: scores[index] })) },
});
const codeOf = async (p: ReturnType<SapAiCoreRelevanceDecision['score']>) => {
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !r.error.message.includes(TOKEN), 'the token never appears in an error');
  return !r.ok ? r.error.code : undefined;
};

describe('SapAiCoreRelevanceDecision — wire (spec §5.3)', () => {
  it('ONE POST per score: URL, headers, body with the passages in order', async () => {
    const { fetch, calls } = fakeFetch(scored([0.1, 0.9]));
    await make(fetch).score(req('read_file — read a file', 'list_issues — list issues'));
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
    await m.score(req('a'));
    await m.score(req('a'));
    assert.equal(calls[0].headers['ai-resource-group'], 'rg1');
    assert.equal(tokenCalls - before, 2);
  });
});

describe('SapAiCoreRelevanceDecision — mapping (not a probability)', () => {
  it('scores = results as {index, score}; model = the configured one; no usage', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] },
    }));
    const r = await make(fetch).score(req('a', 'b'));
    assert.ok(r.ok);
    assert.deepEqual(r.value.scores, [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
    assert.equal(r.value.model, 'cohere-rerank');
    assert.equal(r.value.usage, undefined);
  });
  it('a score outside [0, 1] is accepted — a relevance score is not a probability', async () => {
    const { fetch } = fakeFetch(scored([1.7, -0.3]));
    const r = await make(fetch).score(req('a', 'b'));
    assert.ok(r.ok);
    assert.deepEqual(r.value.scores.map((s) => s.score), [1.7, -0.3]);
  });
});

describe('SapAiCoreRelevanceDecision — invalid requests', () => {
  for (const [name, request] of [
    ['an empty query', { query: ' ', passages: ['a'] }],
    ['no passages', { query: 'q', passages: [] }],
    ['an empty passage', { query: 'q', passages: ['a', ''] }],
  ] as const) {
    it(`${name} → DECISION_INVALID_REQUEST, nothing sent`, async () => {
      const { fetch, calls } = fakeFetch(scored([1]));
      assert.equal(await codeOf(make(fetch).score(request)), 'DECISION_INVALID_REQUEST');
      assert.equal(calls.length, 0);
    });
  }
});

describe('SapAiCoreRelevanceDecision — a bad answer is a DecisionError, never zero-filled', () => {
  const bad: Array<[string, (rec: Recorded) => { status: number; body: unknown }]> = [
    ['fewer results than passages', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }] } })],
    ['more results than passages', () => ({ status: 200, body: { results: [0, 1, 1].map((index) => ({ index, relevance_score: 1 })) } })],
    ['a duplicate index', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 1 }] } })],
    ['an out-of-range index', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 5, relevance_score: 1 }] } })],
    ['a non-integer index', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 0.5, relevance_score: 1 }] } })],
    ['a non-finite score', () => ({ status: 200, body: { results: [{ index: 0, relevance_score: 1 }, { index: 1, relevance_score: 'x' }] } })],
    ['no results array', () => ({ status: 200, body: {} })],
    ['a body that is not JSON', () => ({ status: 200, body: 'not json' })],
  ];
  for (const [name, respond] of bad) {
    it(`${name} → DECISION_ERROR`, async () => {
      const { fetch } = fakeFetch(respond);
      assert.equal(await codeOf(make(fetch).score(req('a', 'b'))), 'DECISION_ERROR');
    });
  }
});

describe('SapAiCoreRelevanceDecision — transport errors', () => {
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
      const r = await make(fetch).score(req('a'));
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
    assert.equal(await codeOf(make(fetch).score(req('a'))), 'DECISION_UNAVAILABLE');
  });
  it('a credential that gives no token → DECISION_AUTH, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(scored([1]));
    const broken = { kind: 'bearer' as const, token: async () => { throw new Error(`no ${TOKEN}`); } };
    assert.equal(await codeOf(make(fetch, { credential: broken }).score(req('a'))), 'DECISION_AUTH');
    assert.equal(calls.length, 0);
  });
  it('an already-aborted signal → DECISION_ABORTED, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(scored([1]));
    const ac = new AbortController();
    ac.abort();
    assert.equal(await codeOf(make(fetch).score(req('a'), { signal: ac.signal })), 'DECISION_ABORTED');
    assert.equal(calls.length, 0);
  });
  it('an abort while the request is in flight → DECISION_ABORTED', async () => {
    const { fetch, entered } = blockingFetch();
    const ac = new AbortController();
    const pending = make(fetch).score(req('a'), { signal: ac.signal });
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

Run: `npx tsc -b packages/llm-agent && node --import tsx/esm --test packages/sap-aicore-decision/src/__tests__/sap-aicore-relevance-decision.test.ts`
Expected: FAIL — `Cannot find module '../index.js'`.

- [ ] **Step 4: Implement**

```ts
// packages/sap-aicore-decision/src/map-rerank.ts
import {
  DecisionError,
  type DecisionErrorCode,
  type RelevanceScore,
  type Result,
} from '@mcp-abap-adt/llm-agent';

/** HTTP status → DecisionError code (spec §5.3). Same split as typesafe-decision's mapError. */
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
 * `{ results: [{ index, relevance_score }] }` → `RelevanceScore[]` (order as
 * returned). Exactly one entry per document, each index once and in range,
 * each score finite. NO [0, 1] check: a relevance score is not a probability
 * (spec §3.9). Anything else is an error — never a zero-filled or dropped score.
 */
export function mapRerankResults(
  body: unknown,
  documents: number,
): Result<RelevanceScore[], DecisionError> {
  const list = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return bad('response has no results array');
  if (list.length !== documents) {
    return bad(`${list.length} results for ${documents} documents`);
  }
  const seen = new Set<number>();
  const out: RelevanceScore[] = [];
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
    if (seen.has(index)) return bad(`index ${index} twice`);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return bad(`score for index ${index} is not a finite number`);
    }
    seen.add(index);
    out.push({ index, score });
  }
  return { ok: true, value: out };
}
```

```ts
// packages/sap-aicore-decision/src/sap-aicore-relevance-decision.ts
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  type CallOptions,
  DecisionError,
  type DecisionErrorCode,
  type IRelevanceDecision,
  type RelevanceRequest,
  type RelevanceResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { codeForStatus, mapRerankResults } from './map-rerank.js';

export const SAP_AICORE_DEFAULT_RESOURCE_GROUP = 'default';

/** The one fetch shape this provider uses; a test seam (unset → global fetch). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SapAiCoreRelevanceConfig {
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
    throw new Error(`SapAiCoreRelevanceDecision: ${field} is required`);
  }
  return v;
};

const nameOf = (err: unknown): string =>
  err instanceof Error ? err.name : 'Error';

/**
 * Cohere Rerank on SAP AI Core as an IRelevanceDecision (spec §5.3): one
 * relevance score per passage — NOT a probability, comparable only within this
 * call. ONE /rerank call per score(). No env, no timeout, no retries.
 */
export class SapAiCoreRelevanceDecision implements IRelevanceDecision {
  readonly model: string;
  private readonly url: string;
  private readonly resourceGroup: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly cfg: SapAiCoreRelevanceConfig) {
    if (!cfg?.credential) {
      throw new Error('SapAiCoreRelevanceDecision requires a credential');
    }
    const base = required(cfg.apiBaseUrl, 'apiBaseUrl').replace(/\/+$/, '');
    const deployment = required(cfg.deploymentId, 'deploymentId');
    this.model = required(cfg.model, 'model');
    this.url = `${base}/v2/inference/deployments/${encodeURIComponent(deployment)}/rerank`;
    this.resourceGroup = cfg.resourceGroup ?? SAP_AICORE_DEFAULT_RESOURCE_GROUP;
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
  }

  async score(
    request: RelevanceRequest,
    options?: CallOptions,
  ): Promise<Result<RelevanceResult, DecisionError>> {
    if (typeof request.query !== 'string' || request.query.trim().length === 0) {
      return fail('relevance request has an empty query', 'DECISION_INVALID_REQUEST');
    }
    if (request.passages.length === 0) {
      return fail('relevance request has no passages', 'DECISION_INVALID_REQUEST');
    }
    if (request.passages.some((p) => typeof p !== 'string' || p.length === 0)) {
      return fail('relevance request has an empty passage', 'DECISION_INVALID_REQUEST');
    }
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
          query: request.query,
          documents: request.passages,
          top_n: request.passages.length,
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
    const scores = mapRerankResults(body, request.passages.length);
    if (!scores.ok) return scores;
    return { ok: true, value: { scores: scores.value, model: this.model } };
  }
}
```

```ts
// packages/sap-aicore-decision/src/index.ts
export { codeForStatus, mapRerankResults } from './map-rerank.js';
export {
  type FetchLike,
  SAP_AICORE_DEFAULT_RESOURCE_GROUP,
  type SapAiCoreRelevanceConfig,
  SapAiCoreRelevanceDecision,
} from './sap-aicore-relevance-decision.js';
```

- [ ] **Step 5: Run the package and repo tests**

Run:
```bash
node --import tsx/esm --test packages/sap-aicore-decision/src/__tests__/sap-aicore-relevance-decision.test.ts
npx tsc -b packages/sap-aicore-decision
npm run build
node --import tsx/esm --test --test-reporter=spec 'test/repo/*.test.ts'
```
Expected: PASS — `licensing`, `readme-badges` and `scoped-dependencies` accept the new package. (How `RelevanceReranker` batches map to `/rerank` calls is tested in Task 24, the one package that depends on both the reranker package and this provider.)

- [ ] **Step 6: Commit**

```bash
npx biome check --write packages/sap-aicore-decision
git add packages/sap-aicore-decision package.json package-lock.json scripts/publish-all.sh packages/llm-agent-server/package.json packages/llm-agent-server/tsconfig.json
git commit -m "feat(sap-aicore-decision): SapAiCoreRelevanceDecision — Cohere Rerank on SAP AI Core as an IRelevanceDecision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 19: `vectorizeMcpTools` runs the store's fill source — the binding and its source read from the store; `live` fills through `bound.index` (llm-agent + libs)

Spec §3.10 (`IToolsFillSource`, `ToolsFillContext`; D42, D44), §7.6 (incl. notes logged, S1), §6.3 rule 1 (D34 — the binding travels with the store, §17.9; D42 — so does its fill source), §6.4 rows 1, 3, 9, 10. The 30.1.0 path stays byte-for-byte (Task 1's golden test).

**Fill sources (D42).** A bound store carries its binding AND its `IToolsFillSource`, attached by `bindToolsProfile(profile, target, source?)` (absent → `LiveToolsFill`). `vectorizeMcpTools` becomes a thin dispatcher: no binding → the 30.1.0 records (unchanged); a binding → `source.fill(ctx)` at the store's creation (the builder's `build()`, `fillToolsBinding`), or `source.toolsChanged(ctx)` on a reconnect (`McpToolRegistry` passes `event: 'tools-changed'`). The live listing + `bound.index` path below is what `ctx.indexLiveTools` runs, so `live` is exactly the behaviour this task had before. `corpus` / `prebuilt` arrive in Task 19A.

**Why the binding is read from the store, not passed.** `vectorizeMcpTools` has two callers in libs today — the builder's fill at `build()` and `McpToolRegistry.revectorizeTools` (a reconnect that reports `toolsChanged`) — and Task 23A adds `fillToolsBinding`. The registry holds `ragStores`, never a binding: an option only the startup caller passes would refill a profiled store with 30.1.0 records on every reconnect and skip a writerless binding silently (review finding (a)). So no caller passes one: `vectorizeMcpTools` asks the store (`toolsBindingOf`, through `IRagDecorator.inner` — a `StrategyRag`, the circuit breaker's `FallbackRag`). Every binding in this plan is attached by `bindToolsProfile` (Tasks 20, 23, 32; the docs' snippet), so none is lost.

**Files:**
- Create: `packages/llm-agent/src/interfaces/tools-fill-source.ts` (`IToolsFillSource`, `ToolsFillContext`; spec §3.10)
- Modify: `packages/llm-agent/src/interfaces/index.ts` (export them)
- Create: `packages/llm-agent-libs/src/collections/tools/tools-fill-sources.ts` (`LiveToolsFill`, `ConsumerToolsFill`; Task 19A appends `ToolsCorpusLoader`, `PrebuiltToolsStore`)
- Modify: `packages/llm-agent-libs/src/collections/tools-binding.ts` (the registry keeps `{ binding, target, source }`; `boundToolsOf`; `bindToolsProfile`'s third parameter)
- Modify: `packages/llm-agent-libs/src/collections/index.ts` (export the two sources)
- Create: `packages/llm-agent-libs/src/mcp/index-tools-through-profile.ts`
- Modify: `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` (the existing function becomes the internal `listAndIndexTools`, with the profile branch below; the exported `vectorizeMcpTools` dispatches to the store's fill source; the inline `ns` type becomes `VectorizeNs` and gains `event?`)
- Modify: `packages/llm-agent-libs/src/mcp/tool-registry.ts` (`revectorizeTools` passes `event: 'tools-changed'`)
- Create: `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts`
- Create: `packages/llm-agent-libs/src/mcp/tool-registry-revectorize-profile.test.ts`
- Create: `packages/llm-agent-libs/src/collections/__tests__/tools-fill-source.test.ts`

**Interfaces:**
- Consumes: `toolItemFromTool` (Task 7); `bindToolsProfile`, `toolsBindingOf` (Task 15); `mcpToolsVariants` (Task 16, test only); `IBoundCollection<ToolItem>`, `CollectionStore`; `ToolCatalogStatus` with `records?`, `profile?` (Task 3).
- Produces:
  ```ts
  // @mcp-abap-adt/llm-agent — interfaces/tools-fill-source.ts (spec §3.10)
  export interface IToolsFillSource { readonly name: string; fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined>; toolsChanged(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined> }
  export interface ToolsFillContext { readonly binding: IBoundCollection<ToolItem>; readonly target: CollectionStore; indexLiveTools(options?: CallOptions): Promise<ToolCatalogStatus | undefined>; readonly logger?: ILogger }
  // @mcp-abap-adt/llm-agent-libs
  export class LiveToolsFill implements IToolsFillSource { readonly name: 'live' }        // fill = toolsChanged = ctx.indexLiveTools()
  export class ConsumerToolsFill implements IToolsFillSource { readonly name: 'consumer' } // fill → undefined; toolsChanged = ctx.indexLiveTools()
  export function bindToolsProfile(profile: ICollectionProfile<ToolItem>, target: CollectionStore, source?: IToolsFillSource): IBoundCollection<ToolItem>; // absent → LiveToolsFill; an explicit different source on a bound store → throws
  // internal to libs: boundToolsOf(rag): { binding, target, source } | undefined
  // vectorizeMcpTools(…) — same parameters; ns gains `event?: 'create' | 'tools-changed'` (default 'create'):
  //   no binding → the 30.1.0 records; a binding → source.fill(ctx) / source.toolsChanged(ctx),
  //   ctx.indexLiveTools = the listing + indexToolsThroughProfile.
  export function indexToolsThroughProfile(binding: IBoundCollection<ToolItem>, tools: readonly LlmTool[], originalNames: readonly string[], ids: readonly string[], seed: { total: number; clientFailures: number }, logger: ILogger | undefined, options?: CallOptions): Promise<ToolCatalogStatus>;
  // summary: vectorized = items with every record written; failed = tool names; records; profile
  // every IndexReport.notes entry is logged as a warning naming the tool (S1)
  // a binding needs NO raw writer on binding.rag: the 30.1.0 "no writer → undefined" guard is the legacy path's only
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IBoundCollection,
  type IEmbedder,
  type ILogger,
  type IMcpClient,
  type IRag,
  InMemoryRag,
  type McpTool,
  recordId,
  symmetricEmbedder,
  type ToolItem,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  bindToolsProfile,
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

// Every binding is attached with bindToolsProfile: vectorizeMcpTools reads it from the store (D34).
describe('vectorizeMcpTools with a tools profile', () => {
  it('fills through bound.index; accounting in items, plus records and profile', async () => {
    const rag = new InMemoryRag();
    const binding = bindToolsProfile(profile(), { key: 'tools', rag });
    const s = await vectorizeMcpTools([client(TOOLS)], binding.rag, new NoopRequestLogger(), undefined);
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
    const binding = bindToolsProfile(profile(), { key: 'tools', rag: new VectorRag(symmetricEmbedder(embedder)) });
    await vectorizeMcpTools([client(TOOLS)], binding.rag, new NoopRequestLogger(), undefined);
    assert.deepEqual(batches, [4]);
  });

  it('a failing item is reported by tool name and not counted', async () => {
    const coarse: McpTool = { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B', 'C'] } }, required: ['kind'] } };
    const binding = bindToolsProfile(profile(new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 2 })), { key: 'tools', rag: new InMemoryRag() });
    const s = await vectorizeMcpTools([client([...TOOLS, coarse])], binding.rag, new NoopRequestLogger(), undefined);
    assert.equal(s?.vectorized, 2);
    assert.deepEqual(s?.failed, ['make']);
    assert.equal(s?.complete, false);
  });

  it('every IndexReport note is logged as a warning naming the tool (S1)', async () => {
    const ambiguous: McpTool = { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B'] }, region: { enum: ['EU', 'US'] } }, required: ['kind', 'region'] } };
    const binding = bindToolsProfile(profile(new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 5 })), { key: 'tools', rag: new InMemoryRag() });
    const messages: string[] = [];
    const logger = { log: (e: { message: string }) => messages.push(e.message) } as unknown as ILogger;
    await vectorizeMcpTools([client([ambiguous])], binding.rag, new NoopRequestLogger(), logger);
    assert.ok(messages.some((m) => /make: ambiguous-discriminator \(kind, region\)/.test(m)), messages.join('\n'));
  });

  it('a binding whose rag has no writer still fills through its own index; catalog complete, not unknown', async () => {
    // IRag allows a store without writer() (a query facade); StrategyRag preserves that.
    // The profile indexes through its OWN backend, so vectorizeMcpTools must not
    // require a raw writer on binding.rag when a binding is present.
    const backend = new InMemoryRag();
    const backendWriter = backend.writer();
    assert.ok(backendWriter);
    const facade: IRag = {
      query: (e, k, o) => backend.query(e, k, o),
      healthCheck: (o) => backend.healthCheck(o),
      getById: (id, o) => backend.getById(id, o),
    };
    assert.equal(facade.writer?.(), undefined);
    const facadeBinding: IBoundCollection<ToolItem> = {
      key: 'tools',
      profileName: 'facade-profile',
      rag: facade,
      retrieval: { name: 'plain', retrieve: (store, q, k, o) => store.query(q, k, o) },
      index: async (items, o) => {
        for (const it of items) {
          const w = await backendWriter.upsertRaw(`p:${it.itemId}`, `${it.name} ${it.description}`, { name: it.name }, o);
          if (!w.ok) return w;
        }
        return { ok: true, value: { items: items.length, indexedItems: items.length, records: items.length, failedItems: [] } };
      },
      remove: async () => ({ ok: true, value: 0 }),
      get: (ref, o) => backend.getById(`p:${ref.itemId}`, o),
    };
    // Attached to the store like every binding (D34); bindToolsProfile adds the
    // StrategyRag, which keeps the missing writer missing.
    const binding = bindToolsProfile({ name: 'facade-profile', bind: () => facadeBinding }, { key: 'tools', rag: facade });
    assert.equal(binding.rag.writer?.(), undefined, 'the bound store is still writerless');
    const s = await vectorizeMcpTools([client(TOOLS)], binding.rag, new NoopRequestLogger(), undefined);
    assert.deepEqual(s, { total: 2, vectorized: 2, failed: [], clientFailures: 0, complete: true, records: 2, profile: 'facade-profile' });
    const hits = await binding.retrieval.retrieve(binding.rag, { text: 'read a file', toVector: async () => [] }, 2);
    assert.ok(hits.ok);
    assert.deepEqual(hits.value.map((h) => h.metadata.id).sort(), ['p:tool:list_issues', 'p:tool:read_file']);
    const legacy = await backend.getById('tool:read_file');
    assert.ok(legacy.ok && legacy.value === null, 'no 30.1.0 record');
  });

  it('without a binding, a store without a writer still returns undefined (30.1.0 unchanged)', async () => {
    const backend = new InMemoryRag();
    const facade: IRag = {
      query: (e, k, o) => backend.query(e, k, o),
      healthCheck: (o) => backend.healthCheck(o),
      getById: (id, o) => backend.getById(id, o),
    };
    let listed = 0;
    const counting = { ...client(TOOLS), listTools: async () => { listed++; return { ok: true, value: TOOLS }; } } as unknown as IMcpClient;
    const s = await vectorizeMcpTools([counting], facade, new NoopRequestLogger(), undefined);
    assert.equal(s, undefined);
    assert.equal(listed, 0, 'the legacy guard returns before listing, as in 30.1.0');
  });
});
```

The reconnect path (spec §6.3 rule 1, §6.4 row 3) — a `toolsChanged` refill of a bound store goes through the profile:

```ts
// packages/llm-agent-libs/src/mcp/tool-registry-revectorize-profile.test.ts
/**
 * Spec §6.3 rule 1 (D34): a reconnect that reports toolsChanged refills a
 * bound store through its profile — vectorizeMcpTools reads the binding from
 * the store, so McpToolRegistry (which holds ragStores, never a binding) gets
 * the profile path without knowing about it. Unbound stores: the existing
 * tool-registry-revectorize.test.ts pins 30.1.0, unchanged.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  type IBoundCollection,
  type IMcpClient,
  InMemoryRag,
  type IRag,
  type IToolIntentSource,
  type McpTool,
  TextOnlyEmbedding,
  type ToolItem,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import { bindToolsProfile, mcpToolsVariants } from '../collections/index.js';
import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';
import { McpToolRegistry } from './tool-registry.js';

const tool = (name: string, description: string): McpTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});
const client = (tools: McpTool[]): IMcpClient =>
  ({
    listTools: async () => ({ ok: true as const, value: tools }),
    callTool: async () => ({ ok: true as const, value: { content: [] } }),
  }) as unknown as IMcpClient;

/** Each resolve hands back the current clients with toolsChanged: a reconnect. */
function reconnecting(first: IMcpClient[]) {
  let clients = first;
  const strategy = {
    resolve: async () => ({ clients, toolsChanged: true }),
  } as unknown as IMcpConnectionStrategy;
  return {
    strategy,
    next(c: IMcpClient[]) {
      clients = c;
    },
  };
}

/** Intents follow the description: words no primary record contains. */
const intentsFromDescription: IToolIntentSource = {
  name: 'from-description',
  intentsFor: async (t) => ({
    ok: true as const,
    value: [t.description.includes('v2') ? 'zebra crossing' : 'walrus colony'],
  }),
};

/** `name`'s score for a query on `rag`; 0 = not retrieved. */
async function score(rag: IRag, q: string, name: string): Promise<number> {
  const r = await rag.query(new TextOnlyEmbedding(q), 10);
  assert.ok(r.ok);
  return r.value.find((h) => toolNameFromRecord(h.metadata) === name)?.score ?? 0;
}

describe('McpToolRegistry toolsChanged on a bound store (D34)', () => {
  it('updated and newly added tools are re-indexed through the profile; companions follow; no 30.1.0 record', async () => {
    const rag = new InMemoryRag();
    const intents = new InMemoryRag();
    const bound = bindToolsProfile(
      mcpToolsVariants.faceted({ intents: { companion: intentsFromDescription } }),
      { key: 'tools', rag, companions: { intents } },
    );
    const conn = reconnecting([client([tool('read_file', 'Read a file v1')])]);
    const registry = new McpToolRegistry([], conn.strategy, { tools: bound.rag });

    await registry.resolveActiveClients();
    assert.ok((await score(bound.rag, 'walrus colony', 'read_file')) > 0, 'filled with its v1 intent');

    conn.next([client([tool('read_file', 'Read a file v2'), tool('list_issues', 'List open issues')])]);
    await registry.resolveActiveClients();

    const item = await bound.get({ itemId: 'tool:read_file', owner: { scope: 'global' } });
    assert.ok(item.ok && item.value, 'the updated item is whole');
    assert.ok((await score(bound.rag, 'v2', 'read_file')) > 0, 'the primary records carry the new description');
    assert.ok((await score(bound.rag, 'zebra crossing', 'read_file')) > 0, 'the companion record was rewritten');
    assert.equal(await score(bound.rag, 'walrus colony', 'read_file'), 0, 'the old intent is gone');
    const added = await bound.get({ itemId: 'tool:list_issues', owner: { scope: 'global' } });
    assert.ok(added.ok && added.value, 'the new tool is indexed');
    for (const id of ['tool:read_file', 'tool:list_issues']) {
      const legacy = await rag.getById(id);
      assert.ok(legacy.ok && legacy.value === null, `no 30.1.0 record ${id}`);
    }
  });

  it('a binding over a writerless store is refreshed through its own index, not skipped', async () => {
    const backend = new InMemoryRag();
    const backendWriter = backend.writer();
    assert.ok(backendWriter);
    const facade: IRag = {
      query: (e, k, o) => backend.query(e, k, o),
      healthCheck: (o) => backend.healthCheck(o),
      getById: (id, o) => backend.getById(id, o),
    };
    const indexed: string[][] = [];
    const facadeBinding: IBoundCollection<ToolItem> = {
      key: 'tools',
      profileName: 'facade-profile',
      rag: facade,
      retrieval: { name: 'plain', retrieve: (store, q, k, o) => store.query(q, k, o) },
      index: async (items, o) => {
        indexed.push(items.map((i) => i.name));
        for (const it of items) {
          const w = await backendWriter.upsertRaw(`p:${it.itemId}`, `${it.name} ${it.description}`, { name: it.name }, o);
          if (!w.ok) return w;
        }
        return { ok: true, value: { items: items.length, indexedItems: items.length, records: items.length, failedItems: [] } };
      },
      remove: async () => ({ ok: true, value: 0 }),
      get: (ref, o) => backend.getById(`p:${ref.itemId}`, o),
    };
    const bound = bindToolsProfile({ name: 'facade-profile', bind: () => facadeBinding }, { key: 'tools', rag: facade });
    assert.equal(bound.rag.writer?.(), undefined, 'precondition: no raw writer');
    const conn = reconnecting([client([tool('read_file', 'Read a file')])]);
    const registry = new McpToolRegistry([], conn.strategy, { tools: bound.rag });

    await registry.resolveActiveClients();
    conn.next([client([tool('read_file', 'Read a file'), tool('list_issues', 'List open issues')])]);
    await registry.resolveActiveClients();

    assert.deepEqual(indexed, [['read_file'], ['read_file', 'list_issues']]);
  });

  it('a bound store behind the circuit breaker (FallbackRag) is still found', async () => {
    const rag = new InMemoryRag();
    const bound = bindToolsProfile(mcpToolsVariants.faceted(), { key: 'tools', rag });
    const guarded = new FallbackRag(bound.rag, new InMemoryRag(), new CircuitBreaker());
    const conn = reconnecting([client([tool('read_file', 'Read a file')])]);
    const registry = new McpToolRegistry([], conn.strategy, { tools: guarded });

    await registry.resolveActiveClients();

    const item = await bound.get({ itemId: 'tool:read_file', owner: { scope: 'global' } });
    assert.ok(item.ok && item.value, 'filled through the profile');
    const legacy = await rag.getById('tool:read_file');
    assert.ok(legacy.ok && legacy.value === null, 'no 30.1.0 record');
  });
});
```

The fill sources themselves (spec §3.10, D42, D44):

```ts
// packages/llm-agent-libs/src/collections/__tests__/tools-fill-source.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IMcpClient,
  InMemoryRag,
  type IToolsFillSource,
  type McpTool,
  type ToolsFillContext,
} from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '../../logger/noop-request-logger.js';
import type { IMcpConnectionStrategy } from '../../interfaces/mcp-connection-strategy.js';
import { McpToolRegistry } from '../../mcp/tool-registry.js';
import { vectorizeMcpTools } from '../../mcp/vectorize-mcp-tools.js';
import { bindToolsProfile, ConsumerToolsFill, LiveToolsFill, mcpToolsVariants } from '../index.js';
import { boundToolsOf } from '../tools-binding.js';

const TOOLS: McpTool[] = [{ name: 'read_file', description: 'Read a file', inputSchema: {} }];
let listed = 0;
const client = (): IMcpClient =>
  ({
    listTools: async () => {
      listed++;
      return { ok: true, value: TOOLS };
    },
    callTool: async () => ({ ok: true, value: { content: [] } }),
  }) as unknown as IMcpClient;
const G = { scope: 'global' } as const;
const has = async (rag: InMemoryRag) => {
  const b = boundToolsOf(rag)?.binding;
  const r = b ? await b.get({ itemId: 'tool:read_file', owner: G }) : undefined;
  return !!(r?.ok && r.value);
};

describe('tools fill sources (spec §3.10)', () => {
  it('no source → live: the binding carries LiveToolsFill', () => {
    const b = bindToolsProfile(mcpToolsVariants.faceted(), { key: 'tools', rag: new InMemoryRag() });
    assert.ok(boundToolsOf(b.rag)?.source instanceof LiveToolsFill);
  });

  it('consumer: creation writes and lists nothing (status unknown); toolsChanged re-indexes through the profile', async () => {
    const rag = new InMemoryRag();
    const b = bindToolsProfile(mcpToolsVariants.faceted(), { key: 'tools', rag }, new ConsumerToolsFill());
    listed = 0;
    const s = await vectorizeMcpTools([client()], b.rag, new NoopRequestLogger(), undefined);
    assert.equal(s, undefined);
    assert.equal(listed, 0, 'nothing listed at creation');
    assert.equal(await has(rag), false, 'nothing written');
    const t = await vectorizeMcpTools([client()], b.rag, new NoopRequestLogger(), undefined, undefined, undefined, { event: 'tools-changed' });
    assert.equal(t?.complete, true);
    assert.equal(await has(rag), true, 'a reconnect re-indexes, as 30.1.0');
  });

  it("a consumer's own source gets the binding, the target and the live path; its status is the catalog status", async () => {
    const raw = new InMemoryRag();
    const seen: ToolsFillContext[] = [];
    const own: IToolsFillSource = {
      name: 'own',
      fill: async (ctx, o) => {
        seen.push(ctx);
        return ctx.indexLiveTools(o);
      },
      toolsChanged: async () => undefined,
    };
    const b = bindToolsProfile(mcpToolsVariants.faceted(), { key: 'tools', rag: raw }, own);
    const s = await vectorizeMcpTools([client()], b.rag, new NoopRequestLogger(), undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].binding, b);
    assert.equal(seen[0].target.rag, raw);
    assert.equal(s?.vectorized, 1);
    assert.equal(s?.profile, 'mcp-tools');
  });

  it('a reconnect calls the source’s toolsChanged, never its fill', async () => {
    const calls: string[] = [];
    const own: IToolsFillSource = {
      name: 'own',
      fill: async () => {
        calls.push('fill');
        return undefined;
      },
      toolsChanged: async () => {
        calls.push('toolsChanged');
        return undefined;
      },
    };
    const b = bindToolsProfile(mcpToolsVariants.faceted(), { key: 'tools', rag: new InMemoryRag() }, own);
    const strategy = { resolve: async () => ({ clients: [client()], toolsChanged: true }) } as unknown as IMcpConnectionStrategy;
    await new McpToolRegistry([], strategy, { tools: b.rag }).resolveActiveClients();
    assert.deepEqual(calls, ['toolsChanged']);
  });

  it('binding a bound store again: the same binding; a different explicit source → throws', () => {
    const p = mcpToolsVariants.faceted();
    const b = bindToolsProfile(p, { key: 'tools', rag: new InMemoryRag() });
    assert.equal(bindToolsProfile(p, { key: 'tools', rag: b.rag }), b);
    assert.throws(
      () => bindToolsProfile(p, { key: 'tools', rag: b.rag }, new ConsumerToolsFill()),
      /already bound with fill source live/,
    );
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts packages/llm-agent-libs/src/mcp/tool-registry-revectorize-profile.test.ts packages/llm-agent-libs/src/collections/__tests__/tools-fill-source.test.ts`
Expected: FAIL — the 30.1.0 path runs on every caller, the registry's included (`legacy` records exist; no `records` / `profile` in the summary; the writerless binding is never indexed); `LiveToolsFill`, `ConsumerToolsFill` and `boundToolsOf` do not exist.

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
- add imports: `import { toolsBindingOf } from '../collections/tools-binding.js';` and `import { indexToolsThroughProfile } from './index-tools-through-profile.js';`. No new type import: the binding's type is inferred from `toolsBindingOf`, and `noUnusedLocals` would reject an unused one. (No cycle: `collections/tools-binding.ts` imports only `@mcp-abap-adt/llm-agent` and `retrieval/strategy-rag.ts`.)
- extract the inline `ns?: { … }` parameter type into `type VectorizeNs = { descriptors?…; configuredSlotCount?…; toolNamespace?…; prebuiltView?…; /** What happened to the store (spec §3.10): its creation (default) or a reconnect's toolsChanged. Read only for a bound store. */ event?: 'create' | 'tools-changed' }` (same members otherwise) — still no `binding` option (D34): the binding is the store's.
- rename the existing `export async function vectorizeMcpTools(…)` to the module-internal `async function listAndIndexTools(…)` (same parameters, `ns?: VectorizeNs`); the edits below go INTO it. It is the 30.1.0 path for an unbound store and `ctx.indexLiveTools` for a bound one.
- the writer guard (lines 144–148 today) applies ONLY to the 30.1.0 path. A bound profile indexes through `binding.index` — its own backend — so `binding.rag` may be a writerless query facade (allowed by `IRag`, preserved by `StrategyRag`); requiring a raw writer there would skip `index()` and leave the catalog empty and its status unknown. Replace:
  ```ts
  const writer = toolsRag?.writer?.();
  // No store, or a deliberately read-only one: nothing is attempted, and the
  // status stays unknown rather than reporting a permanently incomplete
  // catalog for a configuration that never intended to write.
  if (!toolsRag || !writer) return undefined;
  ```
  with:
  ```ts
  const writer = toolsRag?.writer?.();
  // The binding travels with the store (spec §6.3 rule 1, D34): every caller —
  // the builder's fill, a reconnect's toolsChanged (McpToolRegistry), and
  // fillToolsBinding — gets the profile path from the store it fills, found
  // through IRagDecorator.inner (StrategyRag, the breaker's FallbackRag).
  const binding = toolsRag ? toolsBindingOf(toolsRag) : undefined;
  // No store: nothing is attempted. Without a binding (the 30.1.0 path) a
  // deliberately read-only store is skipped too, and the status stays unknown
  // rather than reporting a permanently incomplete catalog for a configuration
  // that never intended to write. A bound profile writes through
  // `binding.index` (its own backend), never through `toolsRag.writer()`, so
  // it needs no raw writer (spec §7.6).
  if (!toolsRag || (!writer && !binding)) return undefined;
  ```
- immediately after the `const ids = tools.map(…)` block (before `let vectors`), insert the profile branch, then re-narrow `writer` for the 30.1.0 code below it (it reads `writer.upsertPrecomputedRaw`, `writer.upsertManyPrecomputedRaw` and passes `writer` to `writeOne`; under `strict` the guard above no longer narrows it to `IRagBackendWriter`):
  ```ts
  if (binding) {
    return indexToolsThroughProfile(
      binding,
      tools,
      tools.map((t) => provenance.get(t.name)?.originalName ?? t.name),
      ids,
      acc,
      logger,
      options,
    );
  }
  // 30.1.0 path from here on. Unreachable without a writer (the guard above
  // returned), but the compiler needs the narrowing.
  if (!writer) return undefined;
  ```

Then add the exported dispatcher at the end of `vectorize-mcp-tools.ts` (imports: `boundToolsOf` from `'../collections/tools-binding.js'`; `ToolsFillContext` into the `@mcp-abap-adt/llm-agent` type import):
```ts
/**
 * Tools vectorization (spec §3.10, §6.3 rule 1; D34, D42). An unbound store →
 * the 30.1.0 records, byte for byte. A bound store → its fill source decides:
 * `fill` when the store's instance is created (the builder's build(),
 * fillToolsBinding), `toolsChanged` on a reconnect (McpToolRegistry). The
 * source gets the live path as `indexLiveTools`; it needs no clients itself.
 */
export async function vectorizeMcpTools(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
  toolRecordKey: IToolRecordKey = defaultToolRecordKey,
  options?: CallOptions,
  ns?: VectorizeNs,
): Promise<ToolVectorizationSummary | undefined> {
  const bound = toolsRag ? boundToolsOf(toolsRag) : undefined;
  if (!toolsRag || !bound) {
    return listAndIndexTools(clients, toolsRag, requestLogger, logger, toolRecordKey, options, ns);
  }
  const store: IRag = toolsRag;
  const ctx: ToolsFillContext = {
    binding: bound.binding,
    target: bound.target,
    logger,
    indexLiveTools: (o) =>
      listAndIndexTools(clients, store, requestLogger, logger, toolRecordKey, o ?? options, ns),
  };
  return ns?.event === 'tools-changed'
    ? bound.source.toolsChanged(ctx, options)
    : bound.source.fill(ctx, options);
}
```
(`listAndIndexTools` keeps its own `toolsBindingOf` branch: with a binding it runs `indexToolsThroughProfile`, which is what `indexLiveTools` means. `IRag` and `IToolRecordKey` are already imported there.)

In `tool-registry.ts`, `revectorizeTools`: the `ns` object passed to `vectorizeMcpTools` gains `event: 'tools-changed',` after `toolNamespace: this.toolNamespace,`, and its comment (after "…an aborted reconnect stops promptly.") gains:
```ts
    // A store bound to a tools profile is answered by its fill source
    // (spec §3.10, D44): `live`/`corpus`/`consumer` re-index through the
    // profile, `prebuilt` writes nothing. vectorizeMcpTools reads the binding
    // and its source from the store, so this registry needs neither.
```

The contract (`packages/llm-agent/src/interfaces/tools-fill-source.ts`):
```ts
import type { ILogger } from '../logger/types.js';
import type { CollectionStore, IBoundCollection, ToolItem } from './collection-profile.js';
import type { ToolCatalogStatus } from './tool-catalog.js';
import type { CallOptions } from './types.js';

/**
 * Where a bound tools store's records come from (spec §3.10, D42). Attached
 * with the binding (`bindToolsProfile(profile, target, source)`) and read from
 * the store by whatever writes it. A store is filled ONCE, when its instance
 * is created (D41) — never refilled while it runs.
 */
export interface IToolsFillSource {
  /** 'live' | 'corpus' | 'prebuilt' | 'consumer' | a consumer's own. */
  readonly name: string;
  /** Once, at the store's creation. `undefined` = nothing attempted. Throws on
   *  an incompatible corpus or store — never a silent empty store. */
  fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
  /** A reconnect reported `toolsChanged` (30.1.0's revectorizeTools; D44). */
  toolsChanged(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
}

export interface ToolsFillContext {
  readonly binding: IBoundCollection<ToolItem>;
  /** The stores the binding was made over (primary + companions). */
  readonly target: CollectionStore;
  /** The live path: list the clients' tools (namespaced, keyed as tool
   *  selection reads them) and index them through `binding.index`. */
  indexLiveTools(options?: CallOptions): Promise<ToolCatalogStatus | undefined>;
  readonly logger?: ILogger;
}
```
(`ILogger` lives in `logger/types.ts`, re-exported from the package root, so the root sees the new types through `interfaces/index.ts`.) `interfaces/index.ts`: `export type { IToolsFillSource, ToolsFillContext } from './tools-fill-source.js';`.

`packages/llm-agent-libs/src/collections/tools/tools-fill-sources.ts`:
```ts
import type { CallOptions, IToolsFillSource, ToolCatalogStatus, ToolsFillContext } from '@mcp-abap-adt/llm-agent';

/** The default (spec §3.10): the MCP tool list, indexed through the profile — 30.1.0's behaviour. */
export class LiveToolsFill implements IToolsFillSource {
  readonly name = 'live';
  fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined> {
    return ctx.indexLiveTools(options);
  }
  toolsChanged(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined> {
    return ctx.indexLiveTools(options);
  }
}

/** The consumer fills the store itself (`bound.index`, `fillToolsBinding`); a reconnect re-indexes as 30.1.0. */
export class ConsumerToolsFill implements IToolsFillSource {
  readonly name = 'consumer';
  async fill(): Promise<ToolCatalogStatus | undefined> {
    return undefined;
  }
  toolsChanged(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined> {
    return ctx.indexLiveTools(options);
  }
}
```

`packages/llm-agent-libs/src/collections/tools-binding.ts` (Task 15's file) — the registry carries the target and the source with the binding:
- imports: add `type IToolsFillSource` to the `@mcp-abap-adt/llm-agent` import; `import { LiveToolsFill } from './tools/tools-fill-sources.js';`
- replace `const BINDINGS = new WeakMap<IRag, IBoundCollection<ToolItem>>();` and `toolsBindingOf` with:
  ```ts
  /** What a bound tools store carries (spec §3.10, D34, D42). */
  export interface BoundTools {
    readonly binding: IBoundCollection<ToolItem>;
    readonly target: CollectionStore;
    readonly source: IToolsFillSource;
  }
  const BINDINGS = new WeakMap<IRag, BoundTools>();

  /** The binding, target and fill source `rag` carries, or one of the stores it decorates (≤ 16 levels). Internal to libs. */
  export function boundToolsOf(rag: IRag): BoundTools | undefined {
    let cur: IRag | undefined = rag;
    for (let depth = 0; cur && depth < 16; depth++) {
      const b = BINDINGS.get(cur);
      if (b) return b;
      cur = isRagDecorator(cur) ? cur.inner : undefined;
    }
    return undefined;
  }

  /** The tools binding `rag` carries, or one of the stores it decorates. */
  export function toolsBindingOf(rag: IRag): IBoundCollection<ToolItem> | undefined {
    return boundToolsOf(rag)?.binding;
  }
  ```
- `bindToolsProfile` gains `source?: IToolsFillSource` as its third parameter; its first lines become
  ```ts
  const existing = boundToolsOf(target.rag);
  if (existing) {
    if (source && source !== existing.source) {
      throw new Error(
        `bindToolsProfile: the store is already bound with fill source ${existing.source.name} — bind once, with the source that fills it (spec §3.10)`,
      );
    }
    return existing.binding;
  }
  ```
  and its registration `BINDINGS.set(rag, registered);` becomes `BINDINGS.set(rag, { binding: registered, target, source: source ?? new LiveToolsFill() });`. Its doc gains: "`source` — where the records come from (spec §3.10); absent → `LiveToolsFill`."
- `collections/index.ts`: `export { ConsumerToolsFill, LiveToolsFill } from './tools/tools-fill-sources.js';` (`boundToolsOf` / `BoundTools` stay internal).

- [ ] **Step 4: Run (profile path + reconnect + golden + existing vectorize/registry tests)**

Run:
```bash
npx tsc -b packages/llm-agent packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts packages/llm-agent-libs/src/mcp/tool-registry-revectorize-profile.test.ts packages/llm-agent-libs/src/collections/__tests__/tools-fill-source.test.ts packages/llm-agent-libs/src/collections/__tests__/composed-tools-profile.test.ts packages/llm-agent-libs/src/mcp/tool-registry-revectorize.test.ts packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts
```
Expected: PASS (`tsc -b` type-checks the edited sources; the tsx run does not). The existing `tool-registry-revectorize.test.ts` passes unchanged: its stores carry no binding, so the 30.1.0 records are written as before.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent/src/interfaces packages/llm-agent-libs/src/mcp packages/llm-agent-libs/src/collections packages/llm-agent-libs/src/__tests__
git add packages/llm-agent/src packages/llm-agent-libs/src
git commit -m "feat(libs): the tools fill source — vectorizeMcpTools runs the store's source; live fills a bound profile, accounting in items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 19A: Offline tools corpus — `buildToolsCorpus`, `parseToolsCorpus`, `deployToolsCorpus`; the `corpus` and `prebuilt` fill sources (libs)

Spec §6.5 (D43), §3.10 (`ToolsCorpusLoader`, `PrebuiltToolsStore`; compatibility checked at creation; D42, D44), §4.3 (the service record is dropped — Task 12), §3.1 (`serviceRecord` — Tasks 2, 11), §14.1 (offline corpus, fill sources).

**Why.** A tools store is filled once at instance creation (D41). Two of the four sources need the profile's indexer to run **outside** the process: the consumer's **build** step produces a corpus (records + vectors) with the same profile and an embedder; its **deploy** step writes that corpus into a persistent store with precomputed vectors — no embedding call — in place, idempotent, with a service record (fingerprint, corpus hash, record hashes). At instance creation `ToolsCorpusLoader` — one small class whose only job is this — checks a built corpus's fingerprint, writes its records with their precomputed vectors into the fresh in-memory store and reports the status (no service record, no diff, no refill, no memo, no retry, no watching); `PrebuiltToolsStore` only checks a deployed persistent store and never writes. Neither writes on `toolsChanged` (D44).

**Files:**
- Create: `packages/llm-agent-libs/src/collections/tools/corpus-capture-rag.ts` (internal: the build step's capture store)
- Create: `packages/llm-agent-libs/src/collections/tools/tools-corpus.ts` (types, `buildToolsCorpus`, `parseToolsCorpus`, `deployToolsCorpus`, `readToolsCorpusService`, `TOOLS_CORPUS_RECORD_ID`)
- Modify: `packages/llm-agent-libs/src/collections/tools/tools-fill-sources.ts` (append `ToolsCorpusLoader`, `PrebuiltToolsStore`)
- Modify: `packages/llm-agent-libs/src/collections/index.ts` (exports)
- Create: `packages/llm-agent-libs/src/collections/__tests__/tools-corpus.test.ts`

**Interfaces:**
- Consumes: `bindToolsProfile`, `boundToolsOf` (Tasks 15, 19); `LiveToolsFill`'s module (Task 19); `vectorizeMcpTools` (Task 19, tests); `mcpToolsVariants` (Task 16, tests); `toolItemFromTool` (Task 7); `recordId`, `VectorRag`, `IRetrievalEmbedderOwner` (Tasks 2, 4); `StagedRetrieval` dropping `serviceRecord` hits (Task 12).
- Produces (all exported from `@mcp-abap-adt/llm-agent-libs`):
  ```ts
  export interface ToolsCorpusIdentity { readonly profile: string; readonly embedder: string }
  export interface ToolsCorpusManifest { readonly format: 1; readonly identity: ToolsCorpusIdentity; readonly profileName: string; readonly companions: readonly string[]; readonly dimensions: number; readonly items: number; readonly records: number; readonly corpusHash: string }
  export interface ToolsCorpusRecord { readonly store: string; readonly id: string; readonly text: string; readonly vector: readonly number[]; readonly metadata: RagMetadata }
  export interface ToolsCorpus { readonly manifest: ToolsCorpusManifest; readonly records: readonly ToolsCorpusRecord[] }
  export interface ToolsCorpusDeployReport { readonly unchanged: boolean; readonly upserted: number; readonly deleted: number }
  export const TOOLS_CORPUS_RECORD_ID = 'tools-corpus';
  export function buildToolsCorpus(input: { readonly profile: ICollectionProfile<ToolItem>; readonly embedder: IRetrievalEmbedder; readonly identity: ToolsCorpusIdentity; readonly items: readonly ToolItem[]; readonly companions?: readonly string[] }, options?: CallOptions): Promise<ToolsCorpus>;
  export function parseToolsCorpus(json: string): ToolsCorpus;
  export function deployToolsCorpus(corpus: ToolsCorpus, target: CollectionStore, options?: CallOptions): Promise<ToolsCorpusDeployReport>;
  export class ToolsCorpusLoader implements IToolsFillSource { constructor(o: { corpus: ToolsCorpus; expect: ToolsCorpusIdentity }); readonly name: 'corpus' } // fill: check + precomputed writes + status; toolsChanged: no write
  export class PrebuiltToolsStore implements IToolsFillSource { constructor(o: { expect: ToolsCorpusIdentity }); readonly name: 'prebuilt' }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-libs/src/collections/__tests__/tools-corpus.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IEmbedResult,
  type ILogger,
  InMemoryRag,
  type IRag,
  type IRagBackendWriter,
  type IRetrievalEmbedder,
  type IToolIntentSource,
  type McpTool,
  RagError,
  recordId,
  TextOnlyEmbedding,
  toolNameFromRecord,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '../../logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../../mcp/vectorize-mcp-tools.js';
import {
  bindToolsProfile,
  buildToolsCorpus,
  ToolsCorpusLoader,
  deployToolsCorpus,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  mcpToolsVariants,
  ComposedToolsProfile,
  ItemPool,
  MaxScoreCollapse,
  parseToolsCorpus,
  PrebuiltToolsStore,
  RequiredEnumDiscriminator,
  TOOLS_CORPUS_RECORD_ID,
  type ToolsCorpus,
  toolItemFromTool,
} from '../index.js';

const G = { scope: 'global' } as const;
const ID = { profile: 'faceted@1', embedder: 'bag-of-words-8' };
const TOOLS: McpTool[] = [
  { name: 'read_file', description: 'Read a file from disk', inputSchema: { properties: { path: { type: 'string' } } } },
  { name: 'list_issues', description: 'List open issues', inputSchema: {} },
];
const items = (tools: McpTool[]) => tools.map((t) => toolItemFromTool(t, { itemId: `tool:${t.name}`, originalName: t.name }));

/** A deterministic 8-dim bag of words; counts document and query embeddings apart. */
function countingEmbedder() {
  const calls = { documents: 0, queries: 0 };
  const vec = (text: string): number[] => {
    const v = new Array<number>(8).fill(0);
    for (const w of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 8;
      v[h] += 1;
    }
    return v.some((x) => x > 0) ? v : [1, 0, 0, 0, 0, 0, 0, 0];
  };
  const embedder: IRetrievalEmbedder = {
    embedDocument: async (t): Promise<IEmbedResult> => {
      calls.documents++;
      return { vector: vec(t) };
    },
    embedDocuments: async (ts) => {
      calls.documents += ts.length;
      return ts.map((t) => ({ vector: vec(t) }));
    },
    embedQuery: async (t) => {
      calls.queries++;
      return { vector: vec(t) };
    },
  };
  return { embedder, calls };
}

/** Intents in their own companion store, so the corpus carries companion records. */
const intents: IToolIntentSource = {
  name: 'walrus',
  intentsFor: async (t) => ({ ok: true as const, value: [`walrus ${t.originalName}`] }),
};
const profile = () => mcpToolsVariants.faceted({ intents: { companion: intents } });

async function build(tools: McpTool[] = TOOLS): Promise<{ corpus: ToolsCorpus; calls: { documents: number } }> {
  const { embedder, calls } = countingEmbedder();
  const corpus = await buildToolsCorpus({ profile: profile(), embedder, identity: ID, items: items(tools), companions: ['intents'] });
  return { corpus, calls };
}

/** A deploy target: VectorRag primary + companion, both accepting precomputed vectors. */
function target() {
  const { embedder, calls } = countingEmbedder();
  return { store: { key: 'tools', rag: new VectorRag(embedder), companions: { intents: new VectorRag(embedder) } }, calls };
}

/** A store whose writer is spied (and whose delete can be made to fail once). */
function spied(inner: IRag, opts: { failDeleteOnce?: boolean } = {}) {
  const writes: string[] = [];
  let failDelete = opts.failDeleteOnce ?? false;
  const w = inner.writer?.() as IRagBackendWriter;
  const writer: IRagBackendWriter = {
    upsertRaw: (id, t, m, o) => {
      writes.push(`upsert:${id}`);
      return w.upsertRaw(id, t, m, o);
    },
    upsertPrecomputedRaw: (id, t, v, m, o) => {
      writes.push(`upsert:${id}`);
      return (w.upsertPrecomputedRaw as NonNullable<IRagBackendWriter['upsertPrecomputedRaw']>)(id, t, v, m, o);
    },
    deleteByIdRaw: async (id, o) => {
      writes.push(`delete:${id}`);
      if (failDelete) {
        failDelete = false;
        return { ok: false as const, error: new RagError('delete down') };
      }
      return w.deleteByIdRaw(id, o);
    },
  };
  const rag: IRag = {
    query: (e, k, o) => inner.query(e, k, o),
    healthCheck: (o) => inner.healthCheck(o),
    getById: (id, o) => inner.getById(id, o),
    writer: () => writer,
  };
  return { rag, writes };
}

describe('buildToolsCorpus (build step)', () => {
  it("records + vectors from the profile's own indexer: owner-scoped ids, one dimension, companion records, a manifest", async () => {
    const { corpus, calls } = await build();
    const m = corpus.manifest;
    assert.deepEqual(
      { format: m.format, identity: m.identity, profileName: m.profileName, companions: m.companions, dimensions: m.dimensions, items: m.items },
      { format: 1, identity: ID, profileName: 'mcp-tools', companions: ['intents'], dimensions: 8, items: 2 },
    );
    assert.equal(m.records, corpus.records.length);
    assert.ok(calls.documents > 0, 'the build step embeds');
    const primary = corpus.records.filter((r) => r.store === '').map((r) => r.id);
    assert.ok(primary.includes(recordId(G, 'tool:read_file', 'full', 0)));
    assert.ok(corpus.records.some((r) => r.store === 'intents'), 'companion records under their store name');
    assert.ok(corpus.records.every((r) => r.vector.length === 8));
  });

  it('a tool that fails to index → throws naming it; no tools → throws', async () => {
    const coarse: McpTool = { name: 'make', description: 'Make', inputSchema: { properties: { kind: { enum: ['A', 'B', 'C'] } }, required: ['kind'] } };
    const strict = new ComposedToolsProfile({
      indexer: new EnumValueToolIndexer(new FacetedToolIndexer([]), { discriminator: new RequiredEnumDiscriminator(), maxValues: 2 }),
      pool: new ItemPool(10),
      collapse: new MaxScoreCollapse(),
    });
    const { embedder } = countingEmbedder();
    await assert.rejects(buildToolsCorpus({ profile: strict, embedder, identity: ID, items: items([coarse]) }), /make/);
    await assert.rejects(buildToolsCorpus({ profile: profile(), embedder, identity: ID, items: [], companions: ['intents'] }), /no tools/);
  });
});

describe('parseToolsCorpus', () => {
  it('round-trips; a changed record, another format or a mixed dimension → throws', async () => {
    const { corpus } = await build();
    const json = JSON.stringify(corpus);
    assert.deepEqual(parseToolsCorpus(json), JSON.parse(json));
    const tampered = JSON.parse(json);
    tampered.records[0].text = 'changed';
    assert.throws(() => parseToolsCorpus(JSON.stringify(tampered)), /hash/);
    assert.throws(() => parseToolsCorpus(JSON.stringify({ ...corpus, manifest: { ...corpus.manifest, format: 2 } })), /format/);
    const mixed = JSON.parse(json);
    mixed.records[0].vector = [1, 2];
    assert.throws(() => parseToolsCorpus(JSON.stringify(mixed)), /dimension/);
  });
});

describe('deployToolsCorpus (deploy step)', () => {
  it('no embedding call; retrievable through the binding; the service record is never an item; a second deploy changes nothing', async () => {
    const { corpus } = await build();
    const { store, calls } = target();
    const r = await deployToolsCorpus(corpus, store);
    assert.equal(calls.documents, 0, 'precomputed vectors only');
    assert.equal(r.unchanged, false);
    assert.equal(r.upserted, corpus.records.length);
    const b = bindToolsProfile(profile(), store, new PrebuiltToolsStore({ expect: ID }));
    const hits = await b.rag.query(new TextOnlyEmbedding('read file disk'), 5);
    assert.ok(hits.ok);
    assert.ok(hits.value.some((h) => toolNameFromRecord(h.metadata) === 'read_file'));
    assert.ok(hits.value.every((h) => h.metadata.serviceRecord === undefined), 'the service record is dropped');
    const again = await deployToolsCorpus(corpus, store);
    assert.deepEqual(again, { unchanged: true, upserted: 0, deleted: 0 });
  });

  it('in place: a changed tool is upserted, a dropped tool deleted (primary and companion), the rest untouched', async () => {
    const { corpus: v1 } = await build();
    const { store } = target();
    await deployToolsCorpus(v1, store);
    const { corpus: v2 } = await build([{ ...TOOLS[0], description: 'Read a file from disk, v2' }]);
    const spyPrimary = spied(store.rag);
    const spyIntents = spied(store.companions.intents);
    const r = await deployToolsCorpus(v2, { key: 'tools', rag: spyPrimary.rag, companions: { intents: spyIntents.rag } });
    const dropped = v1.records.filter((x) => !v2.records.some((y) => y.store === x.store && y.id === x.id));
    assert.equal(r.deleted, dropped.length);
    assert.ok(spyIntents.writes.some((w) => w.startsWith('delete:')), "the dropped tool's companion record is deleted");
    const gone = await store.rag.getById(recordId(G, 'tool:list_issues', 'full', 0));
    assert.ok(gone.ok && gone.value === null);
    const changed = v2.records.filter((y) => !v1.records.some((x) => x.store === y.store && x.id === y.id && x.text === y.text));
    assert.equal(r.upserted, changed.length, 'only new or changed records are written');
  });

  it('a store without precomputed writes → throws; a failed delete → throws, and a rerun deletes it', async () => {
    const { corpus } = await build();
    await assert.rejects(deployToolsCorpus(corpus, { key: 'tools', rag: new InMemoryRag(), companions: { intents: new InMemoryRag() } }), /precomputed/);
    const { store } = target();
    await deployToolsCorpus(corpus, store);
    const { corpus: smaller } = await build([TOOLS[0]]);
    const flaky = spied(store.rag, { failDeleteOnce: true });
    const t = { key: 'tools', rag: flaky.rag, companions: store.companions };
    await assert.rejects(deployToolsCorpus(smaller, t), /delete/);
    const rerun = await deployToolsCorpus(smaller, t);
    assert.equal(rerun.unchanged, false);
    const gone = await store.rag.getById(recordId(G, 'tool:list_issues', 'full', 0));
    assert.ok(gone.ok && gone.value === null, 'the rerun deleted what the failed run kept');
  });
});

describe('fill sources: corpus and prebuilt (spec §3.10)', () => {
  it('corpus: loaded at creation with no embedding call; the catalog complete; toolsChanged writes nothing', async () => {
    const { corpus } = await build();
    const { store, calls } = target();
    const spy = spied(store.rag);
    const b = bindToolsProfile(profile(), { key: 'tools', rag: spy.rag, companions: store.companions }, new ToolsCorpusLoader({ corpus, expect: ID }));
    const s = await vectorizeMcpTools([], b.rag, new NoopRequestLogger(), undefined);
    assert.deepEqual(s, { total: 2, vectorized: 2, failed: [], clientFailures: 0, complete: true, records: corpus.records.length, profile: 'mcp-tools' });
    assert.equal(calls.documents, 0);
    const item = await b.get({ itemId: 'tool:read_file', owner: G });
    assert.ok(item.ok && item.value);
    const svc = await store.rag.getById(TOOLS_CORPUS_RECORD_ID);
    assert.ok(svc.ok && svc.value === null, 'the loader writes records only — no service record');
    const written = spy.writes.length;
    await vectorizeMcpTools([], b.rag, new NoopRequestLogger(), undefined, undefined, undefined, { event: 'tools-changed' });
    assert.equal(spy.writes.length, written, 'a reconnect writes nothing: no refill');
  });

  it('corpus: a different embedder, profile or companion set → throws naming it', async () => {
    const { corpus } = await build();
    const run = (expect: typeof ID, companions: Record<string, IRag>) => {
      const { embedder } = countingEmbedder();
      const b = bindToolsProfile(profile(), { key: 'tools', rag: new VectorRag(embedder), companions }, new ToolsCorpusLoader({ corpus, expect }));
      return vectorizeMcpTools([], b.rag, new NoopRequestLogger(), undefined);
    };
    const { embedder } = countingEmbedder();
    await assert.rejects(run({ ...ID, embedder: 'other' }, { intents: new VectorRag(embedder) }), /embedder/);
    await assert.rejects(run({ ...ID, profile: 'other' }, { intents: new VectorRag(embedder) }), /profile/);
  });

  it('prebuilt: a deployed store is checked and NEVER written — not at creation, not on toolsChanged', async () => {
    const { corpus } = await build();
    const { store } = target();
    await deployToolsCorpus(corpus, store);
    const spy = spied(store.rag);
    const messages: string[] = [];
    const logger = { log: (e: { message: string }) => messages.push(e.message) } as unknown as ILogger;
    const b = bindToolsProfile(profile(), { key: 'tools', rag: spy.rag, companions: store.companions }, new PrebuiltToolsStore({ expect: ID }));
    const s = await vectorizeMcpTools([], b.rag, new NoopRequestLogger(), logger);
    assert.equal(s?.complete, true);
    assert.equal(s?.vectorized, 2);
    await vectorizeMcpTools([], b.rag, new NoopRequestLogger(), logger, undefined, undefined, { event: 'tools-changed' });
    assert.deepEqual(spy.writes, [], 'the process never writes a prebuilt store');
    assert.ok(messages.some((m) => /prebuilt/.test(m)), 'the reconnect is logged, not written');
  });

  it('prebuilt: a store never deployed → throws pointing at the deploy step; a mismatching identity → throws', async () => {
    const { embedder } = countingEmbedder();
    const empty = bindToolsProfile(profile(), { key: 'tools', rag: new VectorRag(embedder), companions: { intents: new VectorRag(embedder) } }, new PrebuiltToolsStore({ expect: ID }));
    await assert.rejects(vectorizeMcpTools([], empty.rag, new NoopRequestLogger(), undefined), /deployToolsCorpus/);
    const { corpus } = await build();
    const { store } = target();
    await deployToolsCorpus(corpus, store);
    const other = bindToolsProfile(profile(), store, new PrebuiltToolsStore({ expect: { ...ID, embedder: 'other' } }));
    await assert.rejects(vectorizeMcpTools([], other.rag, new NoopRequestLogger(), undefined), /embedder/);
  });

  it(`the service record lives under ${TOOLS_CORPUS_RECORD_ID}`, async () => {
    const { corpus } = await build();
    const { store } = target();
    await deployToolsCorpus(corpus, store);
    const svc = await store.rag.getById(TOOLS_CORPUS_RECORD_ID);
    assert.ok(svc.ok && svc.value?.metadata.serviceRecord);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/tools-corpus.test.ts`
Expected: FAIL — `buildToolsCorpus`, `ToolsCorpusLoader`, … are not exported.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/collections/tools/corpus-capture-rag.ts
import {
  type CallOptions,
  type IRag,
  type IRagBackendWriter,
  type IRetrievalEmbedder,
  type IRetrievalEmbedderOwner,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
} from '@mcp-abap-adt/llm-agent';

export interface CapturedRecord {
  readonly id: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly metadata: RagMetadata;
}

/**
 * The build step's store (spec §6.5): owns the embedder (so the record writer
 * batch-embeds exactly as at run time) and keeps every write. Not searchable —
 * nothing is served from it.
 */
export class CorpusCaptureRag implements IRag, IRetrievalEmbedderOwner {
  private readonly rows = new Map<string, CapturedRecord>();
  constructor(readonly retrievalEmbedder: IRetrievalEmbedder) {}

  async query(): Promise<Result<RagResult[], RagError>> {
    return { ok: false, error: new RagError('corpus capture store: not searchable') };
  }
  async healthCheck(): Promise<Result<void, RagError>> {
    return { ok: true, value: undefined };
  }
  async getById(id: string): Promise<Result<RagResult | null, RagError>> {
    const r = this.rows.get(id);
    return { ok: true, value: r ? { text: r.text, metadata: { ...r.metadata, id }, score: 1 } : null };
  }
  writer(): IRagBackendWriter {
    const put = (id: string, text: string, vector: readonly number[], metadata: RagMetadata) => {
      this.rows.set(id, { id, text, vector: [...vector], metadata });
    };
    return {
      upsertRaw: async (id, text, metadata, options?: CallOptions) => {
        const e = await this.retrievalEmbedder.embedDocument(text, options);
        put(id, text, e.vector, metadata);
        return { ok: true, value: undefined };
      },
      upsertPrecomputedRaw: async (id, text, vector, metadata) => {
        put(id, text, vector, metadata);
        return { ok: true, value: undefined };
      },
      upsertManyPrecomputedRaw: async (items) => {
        for (const i of items) put(i.id, i.text, i.vector, i.metadata);
        return { ok: true, value: undefined };
      },
      deleteByIdRaw: async (id) => ({ ok: true, value: this.rows.delete(id) }),
    };
  }
  /** Everything written, in write order. */
  records(): readonly CapturedRecord[] {
    return [...this.rows.values()];
  }
}
```

```ts
// packages/llm-agent-libs/src/collections/tools/tools-corpus.ts
import { createHash } from 'node:crypto';
import type {
  CallOptions,
  CollectionStore,
  ICollectionProfile,
  IRag,
  IRagBackendWriter,
  IRetrievalEmbedder,
  RagMetadata,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { CorpusCaptureRag } from './corpus-capture-rag.js';

export interface ToolsCorpusIdentity {
  /** The consumer's name for the profile composition, e.g. 'faceted@1' — the same at build time and at instance creation. */
  readonly profile: string;
  /** The consumer's name for the document embedder, e.g. 'aicore-te3-small'. */
  readonly embedder: string;
}
export interface ToolsCorpusManifest {
  readonly format: 1;
  readonly identity: ToolsCorpusIdentity;
  readonly profileName: string;
  readonly companions: readonly string[];
  readonly dimensions: number;
  readonly items: number;
  readonly records: number;
  readonly corpusHash: string;
}
export interface ToolsCorpusRecord {
  /** '' = the primary store; else the companion's name. */
  readonly store: string;
  readonly id: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly metadata: RagMetadata;
}
export interface ToolsCorpus {
  readonly manifest: ToolsCorpusManifest;
  readonly records: readonly ToolsCorpusRecord[];
}
export interface ToolsCorpusDeployReport {
  readonly unchanged: boolean;
  readonly upserted: number;
  readonly deleted: number;
}

/** The service record's id. `recordId` output always has `:` and `#` (or `h:`), so it never collides. */
export const TOOLS_CORPUS_RECORD_ID = 'tools-corpus';

/** What the service record's `serviceRecord` key holds (spec §6.5). */
export interface ToolsCorpusService {
  readonly kind: 'tools-corpus';
  /** Absent while a first deploy is in progress. */
  readonly manifest?: ToolsCorpusManifest;
  /** Per store ('' = primary): record id → record hash. */
  readonly hashes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Write-ahead: ids an unfinished run may have written, per store. Absent once a deploy completed. */
  readonly pending?: Readonly<Record<string, readonly string[]>>;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const recordHash = (r: ToolsCorpusRecord): string =>
  sha(JSON.stringify([r.store, r.id, r.text, r.metadata, r.vector]));
function corpusHashOf(identity: ToolsCorpusIdentity, records: readonly ToolsCorpusRecord[]): string {
  return sha(JSON.stringify([identity, records.map(recordHash).sort()]));
}

/** Build step (spec §6.5): provider tool definitions → records + vectors with the profile's own indexer. */
export async function buildToolsCorpus(
  input: {
    readonly profile: ICollectionProfile<ToolItem>;
    readonly embedder: IRetrievalEmbedder;
    readonly identity: ToolsCorpusIdentity;
    readonly items: readonly ToolItem[];
    readonly companions?: readonly string[];
  },
  options?: CallOptions,
): Promise<ToolsCorpus> {
  if (input.items.length === 0) {
    throw new Error('buildToolsCorpus: no tools — a corpus is built from at least one tool');
  }
  const names = [...new Set(input.companions ?? [])].sort();
  const primary = new CorpusCaptureRag(input.embedder);
  const companions: Record<string, CorpusCaptureRag> = {};
  for (const n of names) companions[n] = new CorpusCaptureRag(input.embedder);
  const bound = input.profile.bind({ key: 'tools', rag: primary, companions });
  const r = await bound.index(input.items, options);
  if (!r.ok) throw new Error(`buildToolsCorpus: index failed: ${r.error.message}`);
  if (r.value.failedItems.length > 0) {
    const list = r.value.failedItems.map((f) => `${f.itemId} (${f.reason})`).join(', ');
    throw new Error(`buildToolsCorpus: ${r.value.failedItems.length} tool(s) failed — a corpus is complete or not built: ${list}`);
  }
  const records: ToolsCorpusRecord[] = [
    ...primary.records().map((x) => ({ store: '', ...x })),
    ...names.flatMap((n) => companions[n].records().map((x) => ({ store: n, ...x }))),
  ];
  const dims = new Set(records.map((x) => x.vector.length));
  if (dims.size !== 1) throw new Error(`buildToolsCorpus: vectors of ${dims.size} dimensions — one embedder, one dimension`);
  return {
    manifest: {
      format: 1,
      identity: input.identity,
      profileName: bound.profileName,
      companions: names,
      dimensions: [...dims][0],
      items: input.items.length,
      records: records.length,
      corpusHash: corpusHashOf(input.identity, records),
    },
    records,
  };
}

/** The serialized corpus back (`JSON.stringify(corpus)`), checked: shape, format, one dimension, the hash. */
export function parseToolsCorpus(json: string): ToolsCorpus {
  const c = JSON.parse(json) as ToolsCorpus;
  const m = c?.manifest;
  if (!m || m.format !== 1) throw new Error(`tools corpus: unknown format ${String(m?.format)} (expected 1)`);
  if (typeof m.identity?.profile !== 'string' || typeof m.identity?.embedder !== 'string') {
    throw new Error('tools corpus: manifest.identity needs profile and embedder');
  }
  if (!Array.isArray(c.records) || c.records.length !== m.records) {
    throw new Error(`tools corpus: ${String(c.records?.length)} records, manifest says ${m.records}`);
  }
  for (const r of c.records) {
    if (typeof r.store !== 'string' || typeof r.id !== 'string' || typeof r.text !== 'string') {
      throw new Error('tools corpus: a record needs store, id and text');
    }
    if (r.store !== '' && !m.companions.includes(r.store)) {
      throw new Error(`tools corpus: record ${r.id} in companion ${r.store}, which the manifest does not list`);
    }
    if (!Array.isArray(r.vector) || r.vector.length !== m.dimensions || !r.vector.every(Number.isFinite)) {
      throw new Error(`tools corpus: record ${r.id} — vector dimension ${String(r.vector?.length)}, expected ${m.dimensions}`);
    }
  }
  if (corpusHashOf(m.identity, c.records) !== m.corpusHash) {
    throw new Error('tools corpus: hash mismatch — the file changed after it was built');
  }
  return c;
}

/** The service record a deploy left in `rag`, or undefined. A read error throws. */
export async function readToolsCorpusService(rag: IRag, options?: CallOptions): Promise<ToolsCorpusService | undefined> {
  const r = await rag.getById(TOOLS_CORPUS_RECORD_ID, options);
  if (!r.ok) throw new Error(`tools corpus: reading the service record failed: ${r.error.message}`);
  const v = r.value?.metadata.serviceRecord as unknown as ToolsCorpusService | undefined;
  return v?.kind === 'tools-corpus' ? v : undefined;
}

function storesOf(corpus: ToolsCorpus, target: CollectionStore): Map<string, IRag> {
  const have = Object.keys(target.companions ?? {}).sort();
  const want = [...corpus.manifest.companions].sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    throw new Error(`tools corpus: companion stores [${have.join(', ')}] ≠ the corpus's [${want.join(', ')}]`);
  }
  const m = new Map<string, IRag>([['', target.rag]]);
  for (const n of want) m.set(n, (target.companions as Record<string, IRag>)[n]);
  return m;
}

function precomputedWriter(name: string, rag: IRag): IRagBackendWriter {
  const w = rag.writer?.();
  if (!w || !(w.upsertManyPrecomputedRaw || w.upsertPrecomputedRaw)) {
    throw new Error(`tools corpus: store '${name || 'primary'}' accepts no precomputed vectors — loading or deploying a corpus makes no embedding call`);
  }
  return w;
}

async function upsertAll(w: IRagBackendWriter, rows: readonly ToolsCorpusRecord[], options?: CallOptions): Promise<void> {
  if (rows.length === 0) return;
  const items = rows.map((r) => ({ id: r.id, text: r.text, vector: [...r.vector], metadata: r.metadata }));
  if (w.upsertManyPrecomputedRaw) {
    const res = await w.upsertManyPrecomputedRaw(items, options);
    if (!res.ok) throw new Error(`deployToolsCorpus: write failed: ${res.error.message}`);
    return;
  }
  for (const i of items) {
    const res = await (w.upsertPrecomputedRaw as NonNullable<IRagBackendWriter['upsertPrecomputedRaw']>)(i.id, i.text, i.vector, i.metadata, options);
    if (!res.ok) throw new Error(`deployToolsCorpus: write of ${i.id} failed: ${res.error.message}`);
  }
}

/**
 * The records only, precomputed, into a store that holds none of them yet —
 * what `ToolsCorpusLoader` does at instance creation (spec §3.10). Internal.
 */
export async function writeToolsCorpusRecords(
  corpus: ToolsCorpus,
  target: CollectionStore,
  options?: CallOptions,
): Promise<void> {
  for (const [n, rag] of storesOf(corpus, target)) {
    await upsertAll(precomputedWriter(n, rag), corpus.records.filter((r) => r.store === n), options);
  }
}

async function writeService(w: IRagBackendWriter, dims: number, svc: ToolsCorpusService, options?: CallOptions): Promise<void> {
  const unit = new Array<number>(dims).fill(0);
  unit[0] = 1;
  const row: ToolsCorpusRecord = {
    store: '',
    id: TOOLS_CORPUS_RECORD_ID,
    text: `tools corpus ${svc.manifest?.corpusHash ?? 'pending'}`,
    vector: unit,
    metadata: { serviceRecord: svc },
  };
  await upsertAll(w, [row], options);
}

/**
 * Deploy step (spec §6.5): a built corpus into a store and its companions —
 * precomputed vectors, in place, one current state, idempotent, write-ahead.
 */
export async function deployToolsCorpus(
  corpus: ToolsCorpus,
  target: CollectionStore,
  options?: CallOptions,
): Promise<ToolsCorpusDeployReport> {
  const old = await readToolsCorpusService(target.rag, options);
  const m = corpus.manifest;
  if (
    old?.manifest?.corpusHash === m.corpusHash &&
    old.manifest.identity.profile === m.identity.profile &&
    old.manifest.identity.embedder === m.identity.embedder &&
    !old.pending
  ) {
    return { unchanged: true, upserted: 0, deleted: 0 };
  }
  const stores = storesOf(corpus, target);
  const writers = new Map([...stores].map(([n, rag]) => [n, precomputedWriter(n, rag)] as const));
  const hashes: Record<string, Record<string, string>> = {};
  const byStore = new Map<string, ToolsCorpusRecord[]>();
  for (const r of corpus.records) {
    (hashes[r.store] ??= {})[r.id] = recordHash(r);
    byStore.set(r.store, [...(byStore.get(r.store) ?? []), r]);
  }
  const changed = new Map<string, ToolsCorpusRecord[]>();
  const pending: Record<string, string[]> = {};
  for (const [n, rows] of byStore) {
    const c = rows.filter((r) => old?.hashes[n]?.[r.id] !== hashes[n][r.id]);
    changed.set(n, c);
    if (c.length > 0) pending[n] = c.map((r) => r.id);
  }
  const primaryWriter = writers.get('') as IRagBackendWriter;
  // 1. write ahead: every id this run may write is listed before it is written
  const carried: Record<string, string[]> = {};
  for (const [n, ids] of Object.entries(old?.pending ?? {})) carried[n] = [...ids];
  for (const [n, ids] of Object.entries(pending)) carried[n] = [...new Set([...(carried[n] ?? []), ...ids])];
  await writeService(primaryWriter, m.dimensions, { kind: 'tools-corpus', manifest: old?.manifest, hashes: old?.hashes ?? {}, pending: carried }, options);
  // 2. upsert the new and changed records
  let upserted = 0;
  for (const [n, rows] of changed) {
    await upsertAll(writers.get(n) as IRagBackendWriter, rows, options);
    upserted += rows.length;
  }
  // 3. delete what the corpus no longer holds (listed or pending), every Result checked
  let deleted = 0;
  for (const [n, w] of writers) {
    const before = new Set([...Object.keys(old?.hashes[n] ?? {}), ...(carried[n] ?? [])]);
    for (const id of before) {
      if (hashes[n]?.[id] !== undefined) continue;
      const res = await w.deleteByIdRaw(id, options);
      if (!res.ok) throw new Error(`deployToolsCorpus: delete of ${id} failed: ${res.error.message} — the service record still lists it; rerun the deploy step`);
      if (res.value) deleted++;
    }
  }
  // 4. the final service record: one current state
  await writeService(primaryWriter, m.dimensions, { kind: 'tools-corpus', manifest: m, hashes }, options);
  return { unchanged: false, upserted, deleted };
}
```

Append to `tools-fill-sources.ts` (imports: `ToolsCorpus`, `ToolsCorpusIdentity`, `ToolsCorpusManifest`, `readToolsCorpusService`, `writeToolsCorpusRecords` from `'./tools-corpus.js'`):
```ts
function checkCompatible(m: ToolsCorpusManifest, expect: ToolsCorpusIdentity, ctx: ToolsFillContext, what: string): void {
  const differs: string[] = [];
  if (m.identity.profile !== expect.profile) differs.push(`profile "${m.identity.profile}" ≠ expected "${expect.profile}"`);
  if (m.identity.embedder !== expect.embedder) differs.push(`embedder "${m.identity.embedder}" ≠ expected "${expect.embedder}"`);
  if (m.profileName !== ctx.binding.profileName) differs.push(`profileName "${m.profileName}" ≠ the binding's "${ctx.binding.profileName}"`);
  const have = Object.keys(ctx.target.companions ?? {}).sort().join(', ');
  const want = [...m.companions].sort().join(', ');
  if (have !== want) differs.push(`companions [${want}] ≠ the store's [${have}]`);
  if (differs.length > 0) throw new Error(`${what}: incompatible — ${differs.join('; ')} (spec §3.10)`);
}

/** A store built ahead is never written after its creation (D44): a reconnect is logged only. */
function warnUnchanged(ctx: ToolsFillContext, what: string): void {
  ctx.logger?.log({
    type: 'warning',
    traceId: 'builder',
    message: `tools store '${ctx.binding.key}' is ${what}: the live tool list changed, nothing written — the next build / deploy brings it (spec §3.10, D44)`,
  });
}

const statusOf = (m: ToolsCorpusManifest): ToolCatalogStatus => ({
  total: m.items,
  vectorized: m.items,
  failed: [],
  clientFailures: 0,
  complete: true,
  records: m.records,
  profile: m.profileName,
});

/**
 * The in-memory source (spec §3.10): fills the store with a corpus built at
 * build time, at instance creation — check the fingerprint, write the records
 * with their precomputed vectors (no embedding call), report the status.
 * Nothing else: no service record, no diff, no refill, no memo, no retry, no
 * watching — a reconnect writes nothing.
 */
export class ToolsCorpusLoader implements IToolsFillSource {
  readonly name = 'corpus';
  constructor(private readonly o: { readonly corpus: ToolsCorpus; readonly expect: ToolsCorpusIdentity }) {}
  async fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined> {
    checkCompatible(this.o.corpus.manifest, this.o.expect, ctx, 'tools corpus');
    await writeToolsCorpusRecords(this.o.corpus, ctx.target, options);
    return statusOf(this.o.corpus.manifest);
  }
  async toolsChanged(ctx: ToolsFillContext): Promise<ToolCatalogStatus | undefined> {
    warnUnchanged(ctx, 'loaded from a corpus built at build time');
    return undefined;
  }
}

/** A store filled by the consumer's build/deploy step: bound for retrieval, checked, never written (spec §3.10). */
export class PrebuiltToolsStore implements IToolsFillSource {
  readonly name = 'prebuilt';
  constructor(private readonly o: { readonly expect: ToolsCorpusIdentity }) {}
  async fill(ctx: ToolsFillContext, options?: CallOptions): Promise<ToolCatalogStatus | undefined> {
    const svc = await readToolsCorpusService(ctx.target.rag, options);
    if (!svc?.manifest) {
      throw new Error(`prebuilt tools store '${ctx.binding.key}': no deployed corpus — run the deploy step (deployToolsCorpus) first`);
    }
    if (svc.pending) {
      throw new Error(`prebuilt tools store '${ctx.binding.key}': a deploy is in progress or was interrupted — rerun the deploy step (deployToolsCorpus)`);
    }
    checkCompatible(svc.manifest, this.o.expect, ctx, `prebuilt tools store '${ctx.binding.key}'`);
    return statusOf(svc.manifest);
  }
  async toolsChanged(ctx: ToolsFillContext): Promise<ToolCatalogStatus | undefined> {
    warnUnchanged(ctx, 'prebuilt by the deploy step');
    return undefined;
  }
}
```

Append to `collections/index.ts`:
```ts
export { ToolsCorpusLoader, PrebuiltToolsStore } from './tools/tools-fill-sources.js';
export {
  buildToolsCorpus,
  deployToolsCorpus,
  parseToolsCorpus,
  TOOLS_CORPUS_RECORD_ID,
  type ToolsCorpus,
  type ToolsCorpusDeployReport,
  type ToolsCorpusIdentity,
  type ToolsCorpusManifest,
  type ToolsCorpusRecord,
} from './tools/tools-corpus.js';
```
(`CorpusCaptureRag`, `ToolsCorpusService`, `readToolsCorpusService` and `writeToolsCorpusRecords` stay internal.)

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/tools-corpus.test.ts packages/llm-agent-libs/src/collections/__tests__/tools-fill-source.test.ts packages/llm-agent-libs/src/collections/__tests__/staged-retrieval.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-libs
```
Expected: PASS. `tsc -b` with `noUnusedLocals` proves every import is used (`ToolsCorpusManifest` by `checkCompatible` / `statusOf`; `RagMetadata` by the record types). The Task 12 suite passes with its service-record case.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src/collections
git add packages/llm-agent-libs/src
git commit -m "feat(libs): offline tools corpus — build, parse, deploy in place; ToolsCorpusLoader and PrebuiltToolsStore fill sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 20: `SmartAgentBuilder.withToolsProfile` (libs)

Spec §6.1 (incl. the fill source, §3.10, D42); §16 principle 6 (one call site).

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts` (field near `_retrievalStrategies` ~line 198; method after `withRetrievalStrategy` ~line 449; `toolsRag` computation ~lines 922–926). The `vectorizeMcpTools` call (~line 1220) is **not** changed: it already passes `toolsRag`, the bound store, and Task 19 reads the binding from it (D34).
- Create: `packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts`
- Modify: `packages/llm-agent-libs/src/collections/__tests__/collection-profile.typecheck.ts` (append)

**Interfaces:**
- Consumes: `bindToolsProfile` (its `source` parameter), `toolsBindingOf` (Tasks 15, 19); `vectorizeMcpTools` running the store's fill source (Task 19); `ConsumerToolsFill` (Task 19, test).
- Produces:
  ```ts
  withToolsProfile(profile: ICollectionProfile<ToolItem>, source?: IToolsFillSource): this; // source absent → LiveToolsFill
  // build(): withToolsProfile + withRetrievalStrategy('tools', …) → Error; withToolsProfile without a tools store → Error;
  // a store that already carries a tools binding (server-bound) is reused, never bound twice.
  // withMcpClients / withMcpServers: bound, NOT filled (no vectorization there, as in 30.1.0; spec §6.1 limit).
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
  type IMcpConnectionStrategy,
  InMemoryRag,
  isToolCatalogReporter,
  type McpTool,
  TextOnlyEmbedding,
  type ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { bindToolsProfile, ConsumerToolsFill, mcpToolsVariants, toolsBindingOf } from '../collections/index.js';
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
// Through a connection strategy, not withMcpClients: the builder vectorizes (and so fills a
// profile) only on the auto-connect branch — withMcpClients / withMcpServers skip vectorization
// entirely (builder.ts ~1144, "Caller-provided clients: skip auto-connect and vectorization").
const connection: IMcpConnectionStrategy = {
  resolve: async () => ({ clients: [client()], toolsChanged: true }),
};
const builder = () => new SmartAgentBuilder({}).withMainLlm(makeLlm([{ content: 'ok' }])).withMcpConnectionStrategy(connection);

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

  it('the fill source is the builder’s to pass: consumer → nothing written at build, no status (D42)', async () => {
    const tools = new InMemoryRag();
    const handle = await builder().setToolsRag(tools).withToolsProfile(mcpToolsVariants.faceted(), new ConsumerToolsFill()).build();
    try {
      assert.ok(isToolCatalogReporter(handle.agent));
      assert.equal(handle.agent.getToolCatalogStatus(), undefined, 'nothing attempted');
      const b = handle.ragStores.tools ? toolsBindingOf(handle.ragStores.tools) : undefined;
      assert.ok(b);
      const got = await b.get({ itemId: 'tool:read_file', owner: { scope: 'global' } });
      assert.ok(got.ok && got.value === null, 'the consumer fills it, not the builder');
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

In `collection-profile.typecheck.ts`, add `import { SmartAgentBuilder } from '../../builder.js';` to the import block at the top (first line after the `@mcp-abap-adt/llm-agent` import; `shared` is Task 17's), and append:
```ts
// @ts-expect-error a shared-items profile is not a tools profile
export const _builderRefusesShared = new SmartAgentBuilder({}).withToolsProfile(shared);
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts`
Expected: FAIL — `withToolsProfile is not a function`.

- [ ] **Step 3: Implement**

In `builder.ts`:
- imports: add `ICollectionProfile`, `IToolsFillSource`, `ToolItem` to the `@mcp-abap-adt/llm-agent` type import; add `import { bindToolsProfile, toolsBindingOf } from './collections/tools-binding.js';`
- fields, after `private readonly _retrievalStrategies = …`:
  ```ts
  private _toolsProfile?: ICollectionProfile<ToolItem>;
  private _toolsFillSource?: IToolsFillSource;
  ```
- method, after `withRetrievalStrategy(…)`:
  ```ts
  /**
   * A tools collection profile (spec §6.1): bound to the `tools` store (set by
   * setToolsRag or auto-created), filled through it at build where the 30.1.0
   * tool records were written, and its retrieval applied like an explicit
   * strategy. A store the server already bound is reused, never bound twice.
   * Filled ONLY on the auto-connect branch: with withMcpClients / withMcpServers
   * the builder does not vectorize (as in 30.1.0) — bound, not filled; the
   * consumer fills it through `fillToolsBinding` / `bound.index` (spec §6.1 limit).
   * `source` — where the records come from (spec §3.10); absent → live.
   */
  withToolsProfile(profile: ICollectionProfile<ToolItem>, source?: IToolsFillSource): this {
    this._toolsProfile = profile;
    this._toolsFillSource = source;
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
        ? bindToolsProfile(
            this._toolsProfile,
            { key: 'tools', rag: baseToolsRag },
            this._toolsFillSource,
          )
        : undefined);
    const toolsRag: IRag | undefined =
      existingToolsBinding || !toolsBinding ? baseToolsRag : toolsBinding.rag;
  ```
  `toolsRag` now carries the binding and its fill source (registered by `bindToolsProfile`, or found on the server-bound store — whose source the server chose, so the builder's `source` is not applied to it), so the existing `vectorizeMcpTools(…, toolsRag, …)` call runs the source's `fill` — the store's creation — and every later `toolsChanged` of the agent's `McpToolRegistry` (its `ragStores.tools` is this store, or the breaker's `FallbackRag` over it) runs the source's `toolsChanged`. Nothing is passed beside the store (D34, D42).

- [ ] **Step 4: Run (new + existing builder/retrieval tests + golden + typecheck)**

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/builder-tools-profile.test.ts packages/llm-agent-libs/src/retrieval/__tests__/*.test.ts packages/llm-agent-libs/src/__tests__/baseline-tool-records.golden.test.ts
npm run typecheck
npm test --workspace @mcp-abap-adt/llm-agent-libs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src
git add packages/llm-agent-libs/src
git commit -m "feat(libs): SmartAgentBuilder.withToolsProfile — bind once with its fill source, fill at build, retrieval applied

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 20A: Rename the probability seam — `makeProbabilityDecision` (alias `makeDecisionModel`) and `createMakeProbabilityDecision` (server-libs + server)

Spec §3.8 (the seam rows), §6.2 (the probability seam's alias; the seam-missing message), §11, §13 (migration), §14.1; D30 (§17.7). The released seam `BuildAgentDeps.makeDecisionModel` is renamed symmetric to its contract (`IProbabilityDecision`) and to `makeRelevanceDecision`. `makeDecisionModel` stays a `@deprecated` alias until the next major; **both supplied → the SmartServer constructor throws naming both** (never silently pick one); the seam-missing message names `makeProbabilityDecision`. Done before Tasks 21–24, so they use the new name only. The app's `createMakeDecisionModel` is internal to `@mcp-abap-adt/llm-agent-server` (not exported from its root), so it is renamed without an alias.

Every 30.1.0 use of the old seam, found with `git grep -n "makeDecisionModel\|createMakeDecisionModel\|make-decision-model" -- ':!docs/superpowers'`:
- server-libs: `smart-agent/smart-server.ts` (`BuildAgentDeps` ~381; the `_deps` `Pick<…>` ~1061; the conditional spread ~1106; the `resolveRetrievalStrategies` call ~1320), `smart-agent/resolve-retrieval.ts` (`ResolveRetrievalInput.makeDecisionModel` ~26 — internal, not exported from the package root; `MISSING_SEAM` ~34; the call ~65–67);
- server-libs tests: `__tests__/resolve-retrieval.test.ts` (~82, ~112, ~159), `__tests__/retrieval-wiring.test.ts` (~284, ~307, ~331, ~473, ~496, ~538, ~597), `__tests__/session-history.test.ts` (~237);
- server (the binary's composition root): `composition/make-decision-model.ts` (`createMakeDecisionModel`, `DecisionProviderCtors`, `SHIPPED_DECISION_PROVIDERS`), `composition/index.ts` (`CompositionDeps.makeDecisionModel`, `buildCompositionDeps`), `composition/__tests__/make-decision-model.test.ts`; `smart-agent/cli.ts` passes `buildCompositionDeps(process.env)` whole (no change there);
- docs: `docs/INTEGRATION.md` (~1222), `docs/TROUBLESHOOTING.md` (~295) — Task 33; `CHANGELOG.md`, `packages/llm-agent-server-libs/CHANGELOG.md`, `packages/llm-agent-server/CHANGELOG.md` keep their released entries; the new entries are Task 34's. `README.md` and `docs/EXAMPLES.md` do not name the seam today (Task 33 re-greps).

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-retrieval.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-retrieval.test.ts`, `__tests__/retrieval-wiring.test.ts`, `__tests__/session-history.test.ts`
- Modify: `packages/llm-agent-server-libs/src/__typechecks__/construction-seams.ts`
- Rename: `packages/llm-agent-server/src/composition/make-decision-model.ts` → `make-probability-decision.ts`; `composition/__tests__/make-decision-model.test.ts` → `__tests__/make-probability-decision.test.ts`
- Modify: `packages/llm-agent-server/src/composition/index.ts`, `composition/__tests__/model-resolver.test.ts`

**Interfaces:**
- Consumes: `IProbabilityDecision` (Task 4A). `resolve-retrieval.ts` keeps its 30.1.0 imports from libs (deprecated aliases since Task 4B) until Task 22 moves them.
- Produces:
  ```ts
  // smart-server.ts — BuildAgentDeps
  makeProbabilityDecision?: (cfg: SmartServerDecisionConfig) => Promise<IProbabilityDecision>;
  /** @deprecated Use `makeProbabilityDecision` (same type). Kept until the next major; supplying both is an error. */
  makeDecisionModel?: (cfg: SmartServerDecisionConfig) => Promise<IProbabilityDecision>;
  // resolve-retrieval.ts (internal)
  ResolveRetrievalInput.makeProbabilityDecision?  // was makeDecisionModel; MISSING_SEAM names BuildAgentDeps.makeProbabilityDecision
  // server composition (internal)
  export function createMakeProbabilityDecision(lookup: Lookup, ctors?: ProbabilityProviderCtors): (cfg: SmartServerDecisionConfig) => Promise<IProbabilityDecision>;
  export interface ProbabilityProviderCtors { typesafe: new (cfg: TypeSafeDecisionConfig) => IProbabilityDecision }  // was DecisionProviderCtors
  export const SHIPPED_PROBABILITY_PROVIDERS: ProbabilityProviderCtors;                                             // was SHIPPED_DECISION_PROVIDERS
  CompositionDeps.makeProbabilityDecision  // was makeDecisionModel; the binary supplies only the new key
  ```

- [ ] **Step 1: Write the failing tests**

In `retrieval-wiring.test.ts`, rename every `makeDecisionModel:` key to `makeProbabilityDecision:` (seven places), then append to the `describe('retrieval strategy wiring (§13.4)'` block:

```ts
  it('the deprecated alias makeDecisionModel still builds the probability decision (D30)', async () => {
    const { model, seen } = recordingModel();
    const { makeRag } = labelledStores();
    const server = new SmartServer(
      { ...configFrom(TOOLS_DECISION_YAML), pluginLoader: noPlugins },
      { ...constructionSeams, makeRag, embedder: stubEmbedder, makeDecisionModel: async () => model },
    );
    await chatOnce(server);
    assert.equal(seen.length, 1, 'the alias reaches the same seam');
    assert.ok(tasksOf(seen[0].req).every((t) => t === TOOL_QUESTION.task));
  });

  it('makeDecisionModel AND makeProbabilityDecision both supplied → the constructor throws naming both (D30)', async () => {
    const { model } = recordingModel();
    const deps: BuildAgentDeps = {
      ...constructionSeams,
      embedder: stubEmbedder,
      makeDecisionModel: async () => model,
      makeProbabilityDecision: async () => model,
    };
    const both =
      /BuildAgentDeps\.makeDecisionModel and BuildAgentDeps\.makeProbabilityDecision are both supplied/;
    assert.throws(() => new SmartServer({ ...configFrom(TOOLS_DECISION_YAML), pluginLoader: noPlugins }, deps), both);
    // the embedded entry point constructs a SmartServer too
    await assert.rejects(buildAgent({ ...configFrom(TOOLS_DECISION_YAML), pluginLoader: noPlugins }, deps), both);
    // never silently picked: even a config that asks for no decision is refused
    assert.throws(() => new SmartServer({ ...configFrom(BASE_YAML), pluginLoader: noPlugins }, deps), both);
  });
```

In `resolve-retrieval.test.ts`: rename `makeDecisionModel:` → `makeProbabilityDecision:` (~82, ~112) and change the expected message (~159) to `/BuildAgentDeps\.makeProbabilityDecision is required/`. In `session-history.test.ts` (~237): `makeDecisionModel:` → `makeProbabilityDecision:`.

In `__typechecks__/construction-seams.ts` (in `tsconfig.typecheck.json`, so `npm run typecheck` checks it under `noUnusedLocals`): add `IProbabilityDecision` to the file's first line, `import type { IEmbedder, ILlm, IRag } from '@mcp-abap-adt/llm-agent';` → `import type { IEmbedder, ILlm, IProbabilityDecision, IRag } from '@mcp-abap-adt/llm-agent';`, then append at the end of the file (after its `void _embedders;`):
```ts
declare const decision: IProbabilityDecision;
// D30: the new seam, and the deprecated alias of the same type, both compile on their own.
const _probabilitySeam: BuildAgentDeps = { ..._allSeams, makeProbabilityDecision: async () => decision };
const _aliasSeam: BuildAgentDeps = { ..._allSeams, makeDecisionModel: async () => decision };

// referenced, like the fixtures above, so noUnusedLocals (TS6133) stays quiet
void _probabilitySeam;
void _aliasSeam;
```

In the server package: `git mv packages/llm-agent-server/src/composition/__tests__/make-decision-model.test.ts packages/llm-agent-server/src/composition/__tests__/make-probability-decision.test.ts`; in it, import `createMakeProbabilityDecision`, `type ProbabilityProviderCtors` from `'../make-probability-decision.js'`, use them in `harness`, and rename `describe('makeDecisionModel'` → `describe('makeProbabilityDecision'`. In `model-resolver.test.ts`, the "hands out all four seams" case becomes "all five": add `'makeProbabilityDecision'` to the list, and add:
```ts
  it('the binary supplies the new seam only — never the deprecated alias (D30)', () => {
    const deps = buildCompositionDeps({}) as Record<string, unknown>;
    assert.equal(typeof deps.makeProbabilityDecision, 'function');
    assert.equal('makeDecisionModel' in deps, false);
  });
```

Run:
```bash
npx tsc -b packages/llm-agent-reranker packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-wiring.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-retrieval.test.ts
node --import tsx/esm --test packages/llm-agent-server/src/composition/__tests__/make-probability-decision.test.ts packages/llm-agent-server/src/composition/__tests__/model-resolver.test.ts
```
Expected: FAIL — `makeProbabilityDecision` is not a member of `BuildAgentDeps` / `ResolveRetrievalInput` (the seam is never called, so the rerank count is 0), the both-supplied server constructs without error, the missing-seam message names `makeDecisionModel`, and `'../make-probability-decision.js'` is not found.

- [ ] **Step 2: Implement — server-libs**

`smart-server.ts`, `BuildAgentDeps` — replace the `makeDecisionModel?` member with:
```ts
  /**
   * Builds the probability decision (`IProbabilityDecision`) from the `decision:`
   * section when its provider is of kind probability (typesafe); the root resolves
   * its credentialRef. Optional: required only when the config asks for one
   * (a `reranker: decision` under such a provider). Spec §3.8, §6.2.
   */
  makeProbabilityDecision?: (
    cfg: SmartServerDecisionConfig,
  ) => Promise<IProbabilityDecision>;
  /**
   * @deprecated Use `makeProbabilityDecision` — the same seam under its old name,
   * kept until the next major. Supplying BOTH is a startup error (spec §13, D30).
   */
  makeDecisionModel?: (
    cfg: SmartServerDecisionConfig,
  ) => Promise<IProbabilityDecision>;
```
(import: in the `@mcp-abap-adt/llm-agent` VALUE import (L49–66), replace `type IDecisionModel,` (L55) with `type IProbabilityDecision,` — `IDecisionModel` has no other use in the file (L383 was this member), so leaving it is a TS6133 under `noUnusedLocals`.)

Beside `assertConstructionSeams`:
```ts
/**
 * The probability seam under its new name or its deprecated alias (D30). Both
 * supplied is a consumer bug — which one was meant is unknowable — so it fails,
 * whatever the config asks for; never silently pick one.
 */
function probabilityDecisionSeam(
  deps: BuildAgentDeps | undefined,
): BuildAgentDeps['makeProbabilityDecision'] {
  if (deps?.makeProbabilityDecision && deps.makeDecisionModel) {
    throw new Error(
      'BuildAgentDeps.makeDecisionModel and BuildAgentDeps.makeProbabilityDecision are both supplied: ' +
        'makeDecisionModel is the deprecated alias of makeProbabilityDecision — supply only makeProbabilityDecision.',
    );
  }
  return deps?.makeProbabilityDecision ?? deps?.makeDecisionModel;
}
```
In the constructor, right after `assertConstructionSeams(deps);`: `const makeProbabilityDecision = probabilityDecisionSeam(deps);`. In the `_deps` type's `Pick<BuildAgentDeps, …>` list replace `'makeDecisionModel'` with `'makeProbabilityDecision'`; replace the conditional spread with
```ts
      ...(makeProbabilityDecision ? { makeProbabilityDecision } : {}),
```
and in `start()` pass `makeProbabilityDecision: this._deps.makeProbabilityDecision,` to `resolveRetrievalStrategies`. Nothing else reads the alias: the server holds the one resolved seam.

`resolve-retrieval.ts`: add `IProbabilityDecision` to the L1–6 `import type { … } from '@mcp-abap-adt/llm-agent'` — keep `IDecisionModel` there: the 30.1.0 closure's `let decisionModel: IDecisionModel | undefined` (L50) still uses it until Task 22 replaces the closure (the same type — `IDecisionModel` is the deprecated alias since Task 4A — so `wrapDecisionModel(await input.makeProbabilityDecision(…))` assigns cleanly). Rename the input field `makeDecisionModel` → `makeProbabilityDecision` (typed `(cfg) => Promise<IProbabilityDecision>`), its two uses (`if (!input.makeProbabilityDecision) …`, `await input.makeProbabilityDecision(input.decisionCfg)`), and
```ts
const MISSING_SEAM =
  'BuildAgentDeps.makeProbabilityDecision is required: the config asks for a probability decision, and the library constructs none from configuration. Supply it from your composition root.';
```

- [ ] **Step 3: Implement — the server's composition root**

```bash
git mv packages/llm-agent-server/src/composition/make-decision-model.ts packages/llm-agent-server/src/composition/make-probability-decision.ts
```
In it: `DecisionProviderCtors` → `ProbabilityProviderCtors`, `SHIPPED_DECISION_PROVIDERS` → `SHIPPED_PROBABILITY_PROVIDERS`, `createMakeDecisionModel` → `createMakeProbabilityDecision`, `IDecisionModel` → `IProbabilityDecision` (the same type), and the doc line `` `BuildAgentDeps.makeDecisionModel` `` → `` `BuildAgentDeps.makeProbabilityDecision` ``. Behaviour unchanged.

`composition/index.ts`:
```ts
import { createMakeProbabilityDecision } from './make-probability-decision.js';
…
  makeProbabilityDecision: NonNullable<BuildAgentDeps['makeProbabilityDecision']>;
…
    makeProbabilityDecision: createMakeProbabilityDecision(lookup),
```
(and "the three construction seams … and the skill-store wrapper" doc: add "and the probability decision seam").

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent-server-libs packages/llm-agent-server
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-wiring.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-retrieval.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/session-history.test.ts
node --import tsx/esm --test packages/llm-agent-server/src/composition/__tests__/make-probability-decision.test.ts packages/llm-agent-server/src/composition/__tests__/model-resolver.test.ts
npm run typecheck
git grep -n "makeDecisionModel\|createMakeDecisionModel\|make-decision-model" -- packages ':!**/CHANGELOG.md'
```
Expected: PASS; typecheck clean (`_aliasSeam` compiles — `@deprecated` is not an error); the grep prints only the `@deprecated` member and `probabilityDecisionSeam` in `smart-server.ts`, `_aliasSeam` in `__typechecks__/construction-seams.ts`, and the alias / both-supplied / binary-supplies-only-the-new-seam tests.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src packages/llm-agent-server/src
git add packages/llm-agent-server-libs/src packages/llm-agent-server/src
git commit -m "refactor(server-libs): makeDecisionModel → makeProbabilityDecision (deprecated alias kept; both supplied is an error)

The binary's createMakeDecisionModel becomes createMakeProbabilityDecision.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 21: YAML `rag.profiles.tools` and `decision.provider: sap-aicore` — types, resolution, validation (server-libs)

Spec §6.2 (all validation rules; only the key `tools`, S8; one `decision:` section — the provider decides the kind), §5.3 (the Cohere provider's fields), §13; D27. Names only; instances come in Task 22. **No new section:** Cohere is a value of the existing `decision.provider`; the provider → kind table (`DECISION_KINDS`) is the one place that says `typesafe` → probability, `sap-aicore` → relevance. The relevance seam (`makeRelevanceDecision`) is Task 22/23's, its app arm Task 24's.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/profiles-config.ts` (types + resolution)
- Create: `packages/llm-agent-server-libs/src/smart-agent/profiles-config-validator.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/decision-config.ts` (`SmartServerDecisionConfig`: `provider: 'typesafe' | 'sap-aicore'`, optional `deploymentId`, `resourceGroup`; `DecisionKind`, `DECISION_KINDS`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/rag-config.ts:161-167` (`SmartServerRagConfig.profiles?`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` (`resolveRagSection`; `resolveDecisionSection` copies the two new fields)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config.ts` (worker refusal)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config-validator.ts` (`checkRag` allowed keys; `checkDecision` per provider; `checkRetrieval` refuses a question / task for a relevance decision; call `checkProfiles`)
- Modify: `packages/llm-agent-server-libs/src/index.ts` (export the new config types)
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts`

**Interfaces:**
- Consumes: `parseIntegerField` (`decision-config.ts`); `get` (`yaml-loader.ts`); `SmartServerRagStoreConfig` (`rag-config.ts`).
- Produces:
  ```ts
  // decision-config.ts — one interface, additive (spec §17.5): a consumer's own probability seam (makeProbabilityDecision, or the deprecated makeDecisionModel) still compiles
  export interface SmartServerDecisionConfig { provider: 'typesafe' | 'sap-aicore'; model?: string; credentialRef?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; deploymentId?: string; resourceGroup?: string }
  export type DecisionKind = 'probability' | 'relevance';
  export const DECISION_KINDS: Readonly<Record<SmartServerDecisionConfig['provider'], DecisionKind>>; // { typesafe: 'probability', 'sap-aicore': 'relevance' } — the one place (spec §6.2)
  export type SmartServerIntentSourceConfig = { file: string } | { llm: string };
  export type SmartServerProfileIntentsConfig = { record: SmartServerIntentSourceConfig } | { companion: { source: SmartServerIntentSourceConfig; store: SmartServerRagStoreConfig } };
  export type SmartServerIndexerConfig = { faceted: string[] } | { 'enum-values': { inner: { faceted: string[] }; discriminator: string | { named: string }; maxValues: number } };
  export type SmartServerCutConfig = 'top-items' | Readonly<Record<string, unknown>>; // { fixed-items: n } | { score-floor: {…} } | { token-budget: {…} } | { <registered>: args }
  export interface SmartServerComposeConfig { indexer: SmartServerIndexerConfig; text?: string /* provider text composer name, F4 */; pool: Readonly<Record<string, unknown>>; collapse?: string; reranker?: 'none' | 'decision' | 'llm'; question?: 'tool' | 'passage'; llm?: string; decomposer?: string; cut?: SmartServerCutConfig; onFailure?: 'stage1' | 'error' }
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
import { DECISION_KINDS } from '../decision-config.js';
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

describe('decision.provider: sap-aicore (Cohere, a relevance decision — spec §5.3, §6.2)', () => {
  it('the provider decides the kind: one table', () => {
    assert.deepEqual(DECISION_KINDS, { typesafe: 'probability', 'sap-aicore': 'relevance' });
  });
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
  it('rag.retrieval: a question or task for the decision reranker is refused for a relevance decision (it reads no wording)', () => {
    assert.throws(
      () => resolveYaml(`${LLM}${RAG}  retrieval:\n    tools: { strategy: rerank, reranker: decision, question: tool }\n${COHERE}`),
      /rag\.retrieval\.tools: question \/ task apply to a probability decision only — decision\.provider sap-aicore is a relevance decision/,
    );
    assert.throws(
      () => resolveYaml(`${LLM}${RAG}  retrieval:\n    tools: { strategy: rerank, reranker: decision, task: judge }\n${COHERE}`),
      /question \/ task apply to a probability decision only/,
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
  it('a decision variant without decision:, or with a decision of the other kind (spec §6.2, D27)', () => {
    refused('tools: { variant: faceted-jev }', /faceted-jev requires a decision: section/);
    refused('tools: { variant: faceted-cohere }', /faceted-cohere requires a decision: section/);
    refused('tools: { variant: faceted-cohere }', /faceted-cohere needs a relevance decision — decision\.provider: sap-aicore \(got "typesafe", a probability decision\)/, JEV);
    refused('tools: { variant: faceted-jev }', /faceted-jev needs a probability decision — decision\.provider: typesafe \(got "sap-aicore", a relevance decision\)/, COHERE);
    refused('tools: { variant: small-set-jev, smallSet: { poolItems: 25 } }', /small-set-jev needs a probability decision/, COHERE);
  });
  it('compose: decision works with either kind; question refused for relevance; cross-encoder is not a reranker name; text is a name', () => {
    const base = 'indexer: { faceted: [] }, pool: { items: 3 }';
    assert.doesNotThrow(() => resolve(`tools: { compose: { ${base}, reranker: decision } }`, COHERE));
    assert.doesNotThrow(() => resolve(`tools: { compose: { ${base}, text: enum-values } }`));
    refused(`tools: { compose: { ${base}, text: 7 } }`, /compose\.text: must be a name/);
    refused(`tools: { compose: { ${base}, reranker: decision, question: tool } }`, /question: a relevance decision \(decision\.provider: sap-aicore\) reads no wording — remove it/, COHERE);
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
  it('compose: score-floor with a reranker needs onFailure: error (a stage1 fallback returns stage-1 scores, spec §4.7 F5)', () => {
    const base = 'indexer: { faceted: [] }, pool: { items: 3 }';
    const floor = 'cut: { score-floor: { minItems: 1, maxItems: 3, minScore: 0.5 } }';
    refused(`tools: { compose: { ${base}, reranker: decision, ${floor} } }`, /compose\.cut: score-floor with a reranker needs onFailure: error/, COHERE);
    refused(`tools: { compose: { ${base}, reranker: decision, onFailure: stage1, ${floor} } }`, /compose\.cut: score-floor with a reranker needs onFailure: error/, COHERE);
    assert.doesNotThrow(() => resolve(`tools: { compose: { ${base}, reranker: decision, onFailure: error, ${floor} } }`, COHERE));
    assert.doesNotThrow(() => resolve(`tools: { compose: { ${base}, ${floor} } }`));
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
/** `decision:` — ONE decision per server (numbers, not text); the provider decides its kind. Secrets never here. */
export interface SmartServerDecisionConfig {
  /** `typesafe` = TypeSafe Jev (probability); `sap-aicore` = Cohere Rerank on SAP AI Core (relevance) — spec §5. */
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

/** What a decision is based on (spec §3.9). */
export type DecisionKind = 'probability' | 'relevance';

/** The ONE place that maps a provider to its kind (spec §6.2): the resolver calls the seam of
 *  that kind and builds the matching reranker; the validator checks variants and wording by it. */
export const DECISION_KINDS: Readonly<
  Record<SmartServerDecisionConfig['provider'], DecisionKind>
> = Object.freeze({ typesafe: 'probability', 'sap-aicore': 'relevance' });
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
  /** Provider text composer name (F4): parameter-names (default) | enum-values | schema | a registered one. */
  text?: string;
  /** `decision` = the reranker of the `decision:` section's kind: ProbabilityReranker (typesafe)
   *  or RelevanceReranker (sap-aicore). */
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
import { DECISION_KINDS, type DecisionKind, parseIntegerField } from './decision-config.js';
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
const COMPOSE_FIELDS = ['indexer', 'text', 'pool', 'collapse', 'reranker', 'question', 'llm', 'decomposer', 'cut', 'onFailure'];
const COMPOSE_RERANKERS = ['none', 'decision', 'llm'];
/** The kind of decision each named decision variant takes (spec §5.5, §6.2, D27). */
const VARIANT_KIND: Readonly<Record<string, DecisionKind>> = {
  'faceted-cohere': 'relevance',
  'faceted-jev': 'probability',
  'small-set-jev': 'probability',
};
const kindOf = (provider: string | undefined): DecisionKind | undefined =>
  provider !== undefined && provider in DECISION_KINDS
    ? DECISION_KINDS[provider as keyof typeof DECISION_KINDS]
    : undefined;
const providerOf = (kind: DecisionKind): string =>
  Object.entries(DECISION_KINDS).find(([, k]) => k === kind)?.[0] ?? '?';

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
  if (c.text != null && !name(c.text)) issues.push(`${label}.text: must be a name (parameter-names | enum-values | schema | a registered one)`);
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
    else if (rr === 'decision' && kindOf(ctx.decisionProvider) === 'relevance') {
      issues.push(
        `${label}.question: a relevance decision (decision.provider: ${ctx.decisionProvider}) reads no wording — remove it`,
      );
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
  // Spec §4.7 (F5): a 'stage1' fallback (the default) returns stage-1 scores; a
  // threshold calibrated on reranked scores must not cut them. StagedRetrieval's
  // constructor refuses the same; this names the YAML key first.
  if (rr !== 'none' && isMap(c.cut) && 'score-floor' in c.cut && (c.onFailure ?? 'stage1') !== 'error') {
    issues.push(
      `${label}.cut: score-floor with a reranker needs onFailure: error — a stage1 fallback returns stage-1 scores, which a threshold calibrated on reranker scores must not cut`,
    );
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
    const wants = typeof variant === 'string' ? VARIANT_KIND[variant] : undefined;
    if (wants && !hasDecision) {
      issues.push(`${label}.variant: ${variant} requires a decision: section (provider: ${providerOf(wants)})`);
    } else if (wants && kindOf(decisionProvider) !== wants) {
      issues.push(
        `${label}.variant: ${variant} needs a ${wants} decision — decision.provider: ${providerOf(wants)} (got ${JSON.stringify(decisionProvider)}, a ${kindOf(decisionProvider) ?? 'unknown'} decision); for the other kind use compose with reranker: decision`,
      );
    }
    if (entry.decomposer != null && !name(entry.decomposer)) issues.push(`${label}.decomposer: must be a registered name`);
    if (entry.intents != null) checkIntents(`${label}.intents`, entry.intents, llmKeys, issues);
    if (hasCompose) checkCompose(`${label}.compose`, entry.compose, { llmKeys, decisionProvider, hasDecision }, issues);
  }
}
```

`config-validator.ts`:
- imports (cumulative; both are used below, and neither is imported today): line 1 `import { parseIntegerField } from './decision-config.js';` → `import { DECISION_KINDS, parseIntegerField } from './decision-config.js';` (used by the `checkRetrieval` rule); add `import { checkProfiles } from './profiles-config-validator.js';` (used in the `checkRag` caller). No cycle: `profiles-config-validator.ts` imports only `decision-config.js`, `profiles-config.js` and `yaml-loader.js`.
- `TYPESAFE_ONLY` / `SAP_AICORE_ONLY` below are MODULE-level constants (next to `RETRIEVAL_STRATEGIES`), not locals of `checkDecision`.
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
    const provider = get(yaml, 'decision', 'provider');
    if (
      e.reranker === 'decision' &&
      typeof provider === 'string' &&
      DECISION_KINDS[provider as keyof typeof DECISION_KINDS] === 'relevance' &&
      (isSet('question') || isSet('task'))
    ) {
      issues.push(
        `${label}: question / task apply to a probability decision only — decision.provider ${provider} is a relevance decision (it reads only the query and the passages)`,
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
- `resolve-config-sections.ts`: add `import { resolveProfilesSection } from './profiles-config.js';` (beside the `./llm-config-map.js` import — not imported today); in `resolveRagSection`, after `...resolveRetrieval(get(yaml, 'rag', 'retrieval')),` add
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
- `smart-server.ts`: **no change** in this task — the `decision:` section already exists; the relevance seam lands in Tasks 22–23.
- `src/index.ts`: export `DECISION_KINDS`, type `DecisionKind` (from `./smart-agent/decision-config.js`), `PROFILE_STORE_KEYS` and the types `SmartServerProfileConfig`, `SmartServerComposeConfig`, `SmartServerProfileIntentsConfig`, `SmartServerIntentSourceConfig`, `SmartServerIndexerConfig`, `SmartServerCutConfig` from `./smart-agent/profiles-config.js` (`SmartServerDecisionConfig` is already exported).

- [ ] **Step 5: Run (new + existing config tests)**

Run: `npx tsc -b packages/llm-agent-server-libs && node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/config-validation.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/decision-config.test.ts`
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

Spec §6.2 (registries; ONE `decision:` section whose provider decides the kind — `makeProbabilityDecision` (Task 20A) builds the probability decision, the new optional `makeRelevanceDecision` the relevance one; `reranker: decision` builds the matching reranker in `rag.profiles` AND `rag.retrieval`; intents file; companion store **sections** kept for the server, which builds one companion store per primary binding — §7.3.3, D33), §3.8 (the seam row), §5.5, §7.3.1 (text composers, F4), §7.4 (D23 startup check); D27.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/resolve-collection-profiles.ts`
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts`
- Create: `packages/llm-agent-server-libs/src/smart-agent/decision-seams.ts` (`decisionRerankerFor` — the one place a `decision:` section becomes a reranker, shared by both resolvers)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-retrieval.ts` (`reranker: decision` by kind through `decisionRerankerFor`; `makeRelevanceDecision?` input; imports from `@mcp-abap-adt/llm-agent-reranker`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-*.test.ts` (the relevance arm)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`SmartServerConfig.toolsVariantFactories?`, `.toolsStrategyFactories?`; `BuildAgentDeps.makeRelevanceDecision?` beside `makeProbabilityDecision`, threaded wherever `makeProbabilityDecision` is (Task 20A) — the `Pick<…>` at ~1061, the spread at ~1106, the `resolveRetrievalStrategies` call at ~1320)
- Modify: `packages/llm-agent-server-libs/package.json` (`peerDependencies`: `"@mcp-abap-adt/llm-agent-reranker": "^30.1.0"`), `tsconfig.json` (`references`: `../llm-agent-reranker`)
- Modify: `packages/llm-agent-server-libs/src/index.ts` (export the registry types and `BUILT_IN_TOOLS_VARIANTS`, `BUILT_IN_TOOLS_STRATEGIES`)

**Interfaces:**
- Consumes: Task 21 config types incl. `DECISION_KINDS`; libs exports (Tasks 5–17): `ComposedToolsProfile`, `mcpToolsVariants`, facets, text composers (`ParameterNamesToolText`, `EnumValuesToolText`, `SchemaToolText`), discriminators, `EnumValueToolIndexer`, `FacetedToolIndexer`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, cuts, `ToolDefinitionSizeEstimator`, `wrapProbabilityDecision`, `wrapRelevanceDecision` (Task 4A); `@mcp-abap-adt/llm-agent-reranker` (Tasks 4B–4C): `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`.
- Produces:
  ```ts
  export interface ToolsVariantInput { readonly probabilityDecision?: IProbabilityDecision; readonly relevanceDecision?: IRelevanceDecision; readonly poolItems?: number; readonly intents?: VariantIntents; readonly decompose?: StagedRetrievalOptions['decompose'] } // the decision: section's decision, of its provider's kind
  // decision-seams.ts
  export interface DecisionSeams { decisionCfg?: SmartServerDecisionConfig; makeProbabilityDecision?: (cfg: SmartServerDecisionConfig) => Promise<IProbabilityDecision>; makeRelevanceDecision?: (cfg: SmartServerDecisionConfig) => Promise<IRelevanceDecision> }
  export function decisionBuilders(seams: DecisionSeams): { kind: DecisionKind | undefined; probability(): Promise<IProbabilityDecision>; relevance(): Promise<IRelevanceDecision> } // each built ONCE, wrapped once for usage logging
  export function decisionRerankerFor(b: ReturnType<typeof decisionBuilders>, wording: { task: DecisionEntry; criteria: …; explicit: boolean }): Promise<IReranker> // probability → ProbabilityReranker(wording); relevance → RelevanceReranker (explicit wording → error)
  export type ToolsVariantFactory = (input: ToolsVariantInput) => ICollectionProfile<ToolItem> | undefined;
  export interface ToolsStrategyFactories { readonly facets?: Readonly<Record<string, () => IToolFacet>>; readonly texts?: Readonly<Record<string, () => IToolTextComposer>> /* F4 */; readonly discriminators?: Readonly<Record<string, () => IDiscriminatorSelector>>; readonly pools?: Readonly<Record<string, (args: unknown) => ICandidatePool>>; readonly collapse?: Readonly<Record<string, () => ICollapseRule>>; readonly cuts?: Readonly<Record<string, (args: unknown) => IItemCut>>; readonly estimators?: Readonly<Record<string, () => IItemSizeEstimator>>; readonly decomposers?: Readonly<Record<string, (deps: { queryEmbedder: IQueryEmbedder }) => IQueryDecomposer>> }
  export const BUILT_IN_TOOLS_VARIANTS: Readonly<Record<string, ToolsVariantFactory>>;
  export const BUILT_IN_TOOLS_STRATEGIES: ToolsStrategyFactories;
  export interface ResolvedToolsProfile { readonly key: string; readonly profile?: ICollectionProfile<ToolItem>; readonly companionStores: Readonly<Record<string, SmartServerRagStoreConfig>>; readonly variant?: string; readonly poolItems?: number } // store SECTIONS: the server builds one companion store per primary binding (D33)
  export interface ResolveCollectionProfilesInput extends DecisionSeams { profiles?: Record<string, SmartServerProfileConfig>; resolveLlm: (key: string) => Promise<ILlm>; queryEmbedder?: IQueryEmbedder; readFile?: (path: string) => string; variantFactories?: Readonly<Record<string, ToolsVariantFactory>>; strategyFactories?: ToolsStrategyFactories }
  export function resolveCollectionProfiles(input: ResolveCollectionProfilesInput): Promise<Map<string, ResolvedToolsProfile>>;
  export function assertSmallSetPool(p: ResolvedToolsProfile | undefined, status: ToolCatalogStatus | undefined): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, IProbabilityDecision, IRelevanceDecision } from '@mcp-abap-adt/llm-agent';
import { ProbabilityReranker, RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import {
  ComposedToolsProfile,
  EnumValuesToolText,
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

const model: IProbabilityDecision = { decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) };
const cohere: IRelevanceDecision = { model: 'c', score: async () => ({ ok: true, value: { model: 'c', scores: [] } }) };
function input(over: Partial<ResolveCollectionProfilesInput> = {}) {
  const seams = { decision: 0, relevance: 0 };
  const i: ResolveCollectionProfilesInput = {
    decisionCfg: { provider: 'typesafe' },
    makeProbabilityDecision: async () => { seams.decision++; return model; },
    makeRelevanceDecision: async () => { seams.relevance++; return cohere; },
    resolveLlm: async () => ({}) as ILlm,
    queryEmbedder: { embedQuery: async () => ({ vector: [1] }) },
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
    assert.ok(composed(out.get('c')?.profile).rerank?.reranker instanceof ProbabilityReranker);
    assert.equal(out.get('d')?.poolItems, 25);
    assert.deepEqual(seams, { decision: 1, relevance: 0 });
  });

  it('faceted-cohere: RelevanceReranker over the relevance decision makeRelevanceDecision builds (provider sap-aicore)', async () => {
    const seen: string[] = [];
    const { i, seams } = input({
      decisionCfg: { provider: 'sap-aicore', deploymentId: 'd1', model: 'cohere-rerank' },
      makeRelevanceDecision: async (cfg) => { seen.push(cfg.provider); return cohere; },
      profiles: { tools: { variant: 'faceted-cohere' } },
    });
    const out = await resolveCollectionProfiles(i);
    const c = composed(out.get('tools')?.profile);
    assert.ok(c.rerank?.reranker instanceof RelevanceReranker);
    assert.equal((c.pool as ItemPool).items, 30);
    assert.deepEqual(seen, ['sap-aicore']);
    assert.equal(seams.decision, 0, 'the probability seam is not called for a relevance provider');
  });

  it('compose reranker: decision builds the reranker of the provider kind (D27)', async () => {
    const base = { indexer: { faceted: [] }, pool: { items: 3 }, reranker: 'decision' as const };
    const jev = await resolveCollectionProfiles(input({ profiles: { t: { compose: base } } }).i);
    assert.ok(composed(jev.get('t')?.profile).rerank?.reranker instanceof ProbabilityReranker);
    const coh = await resolveCollectionProfiles(
      input({ decisionCfg: { provider: 'sap-aicore', deploymentId: 'd', model: 'm' }, profiles: { t: { compose: base } } }).i,
    );
    assert.ok(composed(coh.get('t')?.profile).rerank?.reranker instanceof RelevanceReranker);
  });

  it('compose text: a provider text composer by name (F4); absent → the C0 default', async () => {
    const out = await resolveCollectionProfiles(
      input({ profiles: { t: { compose: { indexer: { faceted: [] }, text: 'enum-values', pool: { items: 3 } } } } }).i,
    );
    const ix = composed(out.get('t')?.profile).indexer;
    assert.ok(ix instanceof FacetedToolIndexer && ix.text instanceof EnumValuesToolText);
  });

  it('intents: record from a file; companion keeps its store SECTION — no store is built here (D33)', async () => {
    const { i } = input({
      profiles: {
        r: { variant: 'faceted', intents: { record: { file: './i.json' } } },
        c: { variant: 'faceted', intents: { companion: { source: { file: './i.json' }, store: { type: 'in-memory' } } } },
      },
    });
    const out = await resolveCollectionProfiles(i);
    assert.ok(composed(out.get('r')?.profile).indexer instanceof IntentRecordIndexer);
    assert.ok(composed(out.get('c')?.profile).companions?.intents instanceof IntentCompanionIndexer);
    // The server builds one companion store per primary binding from this section (Task 23).
    assert.deepEqual(out.get('c')?.companionStores, { intents: { type: 'in-memory' } });
    assert.deepEqual(out.get('r')?.companionStores, {});
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
    assert.ok(w.cut instanceof FixedItemsCut && w.cut.n === 5);
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
    await assert.rejects(resolveCollectionProfiles(input({ profiles: { t: { variant: 'faceted-jev' } }, makeProbabilityDecision: undefined }).i), /makeProbabilityDecision is required/);
    await assert.rejects(
      resolveCollectionProfiles(input({ decisionCfg: { provider: 'sap-aicore', deploymentId: 'd', model: 'm' }, profiles: { t: { variant: 'faceted-cohere' } }, makeRelevanceDecision: undefined }).i),
      /makeRelevanceDecision is required/,
    );
    await assert.rejects(resolveCollectionProfiles(input({ profiles: { t: { compose: { indexer: { faceted: [] }, text: 'nope', pool: { items: 3 } } } } }).i), /unknown text composer "nope"/);
  });

  it('assertSmallSetPool: poolItems below the tool count fails startup (D23)', () => {
    const p = { key: 'tools', companionStores: {}, variant: 'small-set-jev', poolItems: 20 };
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
// packages/llm-agent-server-libs/src/smart-agent/decision-seams.ts
/**
 * ONE decision: section → its decision, of the kind its provider names
 * (DECISION_KINDS, spec §6.2), built ONCE through the seam of that kind and
 * wrapped once for usage logging; and `reranker: decision` → the matching
 * reranker. Shared by rag.retrieval and rag.profiles, so both agree.
 */
import type {
  DecisionEntry,
  IProbabilityDecision,
  IRelevanceDecision,
  IReranker,
} from '@mcp-abap-adt/llm-agent';
import { ProbabilityReranker, RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import { wrapProbabilityDecision, wrapRelevanceDecision } from '@mcp-abap-adt/llm-agent-libs';
import { DECISION_KINDS, type DecisionKind, type SmartServerDecisionConfig } from './decision-config.js';

export interface DecisionSeams {
  decisionCfg?: SmartServerDecisionConfig;
  /** Probability providers (typesafe). The renamed 30.1.0 seam (Task 20A); SmartServer has already resolved its deprecated alias. */
  makeProbabilityDecision?: (cfg: SmartServerDecisionConfig) => Promise<IProbabilityDecision>;
  /** Relevance providers (sap-aicore). New, optional (spec §3.8). */
  makeRelevanceDecision?: (cfg: SmartServerDecisionConfig) => Promise<IRelevanceDecision>;
}

const missing = (seam: string) =>
  `BuildAgentDeps.${seam} is required: the config asks for a decision of that kind, and the library constructs none from configuration. Supply it from your composition root.`;

export function decisionBuilders(seams: DecisionSeams) {
  const cfg = seams.decisionCfg;
  const kind: DecisionKind | undefined = cfg ? DECISION_KINDS[cfg.provider] : undefined;
  let p: IProbabilityDecision | undefined;
  let r: IRelevanceDecision | undefined;
  return {
    kind,
    async probability(): Promise<IProbabilityDecision> {
      if (p) return p;
      if (!cfg) throw new Error('reranker: decision requires a decision: section');
      if (!seams.makeProbabilityDecision) throw new Error(missing('makeProbabilityDecision'));
      p = wrapProbabilityDecision(await seams.makeProbabilityDecision(cfg));
      return p;
    },
    async relevance(): Promise<IRelevanceDecision> {
      if (r) return r;
      if (!cfg) throw new Error('reranker: decision requires a decision: section');
      if (!seams.makeRelevanceDecision) throw new Error(missing('makeRelevanceDecision'));
      r = wrapRelevanceDecision(await seams.makeRelevanceDecision(cfg));
      return r;
    },
  };
}

/** `reranker: decision` → ProbabilityReranker (with wording) or RelevanceReranker (no wording). */
export async function decisionRerankerFor(
  b: ReturnType<typeof decisionBuilders>,
  wording: {
    task: DecisionEntry;
    criteria: { true?: DecisionEntry; false?: DecisionEntry };
    /** The config set question / task explicitly (the validator already refused it for relevance). */
    explicit: boolean;
  },
): Promise<IReranker> {
  if (b.kind === 'relevance') {
    if (wording.explicit) {
      throw new Error('question / task apply to a probability decision only');
    }
    return new RelevanceReranker(await b.relevance());
  }
  return new ProbabilityReranker(await b.probability(), {
    task: wording.task,
    criteria: wording.criteria,
  });
}
```

In `resolve-retrieval.ts` (the 30.1.0 `rag.retrieval` resolver): `ResolveRetrievalInput` extends `DecisionSeams` (drops its own `decisionCfg` / `makeProbabilityDecision` fields — same names, same types as after Task 20A, so `smart-server.ts` call sites compile; the missing-seam message stays `BuildAgentDeps.makeProbabilityDecision is required: …`, so the Task 20A test keeps passing); replace the `decisionModel` / `decisionReranker` closure with `const decisions = decisionBuilders(input);` and a cache keyed by `JSON.stringify([preset.criteria, task])` over `decisionRerankerFor(decisions, { task, criteria: preset.criteria, explicit: cfg.question !== undefined || cfg.task !== undefined })`; import `LlmReranker`, `PASSAGE_QUESTION`, `TOOL_QUESTION` from `@mcp-abap-adt/llm-agent-reranker` (libs keeps `EmbeddingRetrieval`, `RerankedRetrieval`, `RerankAllRetrieval`). Under `typesafe` nothing changes (golden: the existing `retrieval-*` tests pass untouched).

Everything the replaced closure used goes with it — `noUnusedLocals` (`tsconfig.base.json`) fails the build on any leftover. In today's `resolve-retrieval.ts` (read it):
- L1–6 `@mcp-abap-adt/llm-agent` type import: drop `IDecisionModel` (L2; its only use was the closure's `let decisionModel` at L50) and `IProbabilityDecision` (added in Task 20A for the `makeProbabilityDecision` field, which now comes from `DecisionSeams`; nothing else in the file names it); keep `ILlm` (`resolveLlm`), `IReranker` (the reranker cache and `let reranker`), `IRetrievalStrategy`;
- L7–16 `@mcp-abap-adt/llm-agent-libs` import: keep only `EmbeddingRetrieval`, `RerankAllRetrieval`, `RerankedRetrieval`; drop `DecisionReranker` (L8) and `wrapDecisionModel` (L15) — `decisionRerankerFor` / `decisionBuilders` build and wrap now; `LlmReranker`, `PASSAGE_QUESTION`, `TOOL_QUESTION` move to the `@mcp-abap-adt/llm-agent-reranker` import;
- L17–20 `./decision-config.js` type import: drop `SmartServerDecisionConfig` (its only uses were the two dropped members below); keep `SmartServerRetrievalConfig` (`retrieval?`) — the import becomes `import type { SmartServerRetrievalConfig } from './decision-config.js';`;
- add `import { type DecisionSeams, decisionBuilders, decisionRerankerFor } from './decision-seams.js';` and `import { LlmReranker, PASSAGE_QUESTION, TOOL_QUESTION } from '@mcp-abap-adt/llm-agent-reranker';` (all used: `extends DecisionSeams`, `decisionBuilders(input)`, `decisionRerankerFor(…)`, `new LlmReranker`, the L84 preset);
- L22–31 `ResolveRetrievalInput`: drop its own `decisionCfg` and `makeProbabilityDecision` members (both now come from `DecisionSeams`);
- L33–34 `const MISSING_SEAM`: delete — `decision-seams.ts`'s `missing('makeProbabilityDecision')` produces `BuildAgentDeps.makeProbabilityDecision is required: …`, which the Task 20A test (`/BuildAgentDeps\.makeProbabilityDecision is required/`) matches;
- L50–76 `let decisionModel`, `const decisionRerankers`, `const decisionReranker = async (…)`: replaced as above; the one call site L89 `reranker = await decisionReranker(preset, task);` becomes the cached `decisionRerankerFor(…)` call (with `explicit` from `cfg`);
- **the 30.1.0 runtime error for a missing `decision:` section is kept, text and place.** 30.1.0 (L60–64) throws `'rag.retrieval: reranker: decision requires a decision: section'` before it looks at the seam; `decisionBuilders` throws the unprefixed `'reranker: decision requires a decision: section'` (the profiles resolver prefixes `rag.profiles.<key>: ` when it rethrows). So the replacement call site checks first, exactly as 30.1.0 did:
  ```ts
  if (cfg.reranker === 'decision') {
    if (!input.decisionCfg) {
      throw new Error(
        'rag.retrieval: reranker: decision requires a decision: section',
      );
    }
    // … the cached decisionRerankerFor(decisions, { task, criteria: preset.criteria, explicit }) call
  }
  ```
  (No decision is built for a cached wording, so the check before the cache lookup changes nothing else: with no `decision:` section nothing was ever cached.)
- the function doc L36–42 ("The decision model is built ONCE and shared; one `DecisionReranker` per distinct question wording") → "The decision of the `decision:` section's kind is built ONCE and shared (`decisionBuilders`); one reranker per distinct question wording (`decisionRerankerFor`)."

Check: `git grep -n "IDecisionModel\|IProbabilityDecision\|SmartServerDecisionConfig\|DecisionReranker\|wrapDecisionModel\|MISSING_SEAM\|decisionModel\b" packages/llm-agent-server-libs/src/smart-agent/resolve-retrieval.ts` → empty.

Add to the retrieval tests (`packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-retrieval.test.ts`, inside its `describe`):

```ts
it('reranker: decision without a decision: section → the 30.1.0 error text, unchanged', async () => {
  await assert.rejects(
    resolveRetrievalStrategies({
      retrieval: { tools: { strategy: 'rerank', reranker: 'decision' } },
      makeProbabilityDecision: async () => {
        throw new Error('the seam is not reached without a decision: section');
      },
      resolveLlm: noLlm,
    }),
    { message: 'rag.retrieval: reranker: decision requires a decision: section' },
  );
});

it('reranker: decision under a relevance provider builds a RelevanceReranker over makeRelevanceDecision', async () => {
  const out = await resolveRetrievalStrategies({
    retrieval: { tools: { strategy: 'rerank', reranker: 'decision' } },
    decisionCfg: { provider: 'sap-aicore', deploymentId: 'd', model: 'm' },
    makeRelevanceDecision: async () => ({ score: async () => ({ ok: true, value: { model: 'm', scores: [] } }) }),
    resolveLlm: async () => { throw new Error('unused'); },
  });
  assert.ok(out.get('tools'));   // a RerankedRetrieval whose reranker is a RelevanceReranker
});
```
(Assert the reranker class through whatever accessor the existing retrieval tests use; add `rerankerOf` to the test helper if none exists.)

`smart-server.ts` `BuildAgentDeps`, beside `makeProbabilityDecision` (Task 20A; its deprecated alias `makeDecisionModel` stays where Task 20A put it):
```ts
  /** Builds the relevance decision for a `decision:` provider of kind relevance (sap-aicore).
   *  Optional: a config that never asks for one needs none (spec §3.8, §6.2). */
  makeRelevanceDecision?: (cfg: SmartServerDecisionConfig) => Promise<IRelevanceDecision>;
```
and thread it exactly where `makeProbabilityDecision` is threaded (the `Pick<…>` list, the conditional spread `...(deps?.makeRelevanceDecision ? { makeRelevanceDecision: deps.makeRelevanceDecision } : {})`, the `resolveRetrievalStrategies` input; Task 23 adds it to the `resolveCollectionProfiles` input it introduces). The relevance seam has no alias, so it is read straight from `deps`. Import: add `type IRelevanceDecision,` to the `@mcp-abap-adt/llm-agent` value import (L49–66, beside `type IProbabilityDecision` from Task 20A).

```ts
// packages/llm-agent-server-libs/src/smart-agent/resolve-collection-profiles.ts
/**
 * `rag.profiles` names → strategy instances (spec §6.2). The ONLY place the
 * server turns profile configuration into objects; components get instances.
 * Unknown name → startup error. The decision (Jev = probability, Cohere =
 * relevance, by `decision.provider`) comes from the composition root's seam of
 * that kind (decision-seams.ts); the library constructs none from config.
 */
import { readFileSync } from 'node:fs';
import type {
  ICandidatePool,
  ICollapseRule,
  ICollectionProfile,
  IDiscriminatorSelector,
  IItemCut,
  IItemIndexer,
  IItemSizeEstimator,
  ILlm,
  IQueryDecomposer,
  IQueryEmbedder,
  IReranker,
  IProbabilityDecision,
  IRelevanceDecision,
  IToolFacet,
  IToolIntentSource,
  IToolTextComposer,
  ToolCatalogStatus,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { LlmReranker, PASSAGE_QUESTION, TOOL_QUESTION } from '@mcp-abap-adt/llm-agent-reranker';
import {
  ComposedToolsProfile,
  EnumValuesToolText,
  EnumValueToolIndexer,
  FacetedToolIndexer,
  FixedItemsCut,
  IntentCompanionIndexer,
  IntentRecordIndexer,
  ItemPool,
  LlmIntentSource,
  MaxScoreCollapse,
  mcpToolsVariants,
  NamedDiscriminator,
  NameTailFacet,
  ParameterNamesToolText,
  ParametersFacet,
  RequiredEnumDiscriminator,
  SchemaToolText,
  ScoreFloorCut,
  type StagedRetrievalOptions,
  StaticIntentSource,
  SummaryFacet,
  TokenBudgetCut,
  ToolDefinitionSizeEstimator,
  type VariantIntents,
} from '@mcp-abap-adt/llm-agent-libs';
import { type DecisionSeams, decisionBuilders, decisionRerankerFor } from './decision-seams.js';
import type {
  SmartServerComposeConfig,
  SmartServerCutConfig,
  SmartServerIntentSourceConfig,
  SmartServerProfileConfig,
  SmartServerProfileIntentsConfig,
} from './profiles-config.js';
import type { SmartServerRagStoreConfig } from './rag-config.js';

export interface ToolsVariantInput {
  /** The decision: section's decision when its provider is of kind probability (typesafe, Jev). */
  readonly probabilityDecision?: IProbabilityDecision;
  /** … when its provider is of kind relevance (sap-aicore, Cohere). */
  readonly relevanceDecision?: IRelevanceDecision;
  readonly poolItems?: number;
  readonly intents?: VariantIntents;
  readonly decompose?: StagedRetrievalOptions['decompose'];
}
export type ToolsVariantFactory = (
  input: ToolsVariantInput,
) => ICollectionProfile<ToolItem> | undefined;

export interface ToolsStrategyFactories {
  readonly facets?: Readonly<Record<string, () => IToolFacet>>;
  /** Provider text composers (F4); built-ins parameter-names (default), enum-values, schema. */
  readonly texts?: Readonly<Record<string, () => IToolTextComposer>>;
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
      relevanceDecision: need(i.relevanceDecision, 'faceted-cohere needs a relevance decision (decision.provider: sap-aicore)'),
    }),
  'faceted-jev': (i) =>
    mcpToolsVariants.facetedJev({
      ...variantOptions(i),
      probabilityDecision: need(i.probabilityDecision, 'faceted-jev needs a probability decision (decision.provider: typesafe)'),
    }),
  'small-set-jev': (i) =>
    mcpToolsVariants.smallSetJev({
      ...variantOptions(i),
      probabilityDecision: need(i.probabilityDecision, 'small-set-jev needs a probability decision (decision.provider: typesafe)'),
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
  texts: {
    'parameter-names': () => new ParameterNamesToolText(),
    'enum-values': () => new EnumValuesToolText(),
    schema: () => new SchemaToolText(),
  },
  discriminators: { 'required-enum': () => new RequiredEnumDiscriminator() },
  collapse: { max: () => new MaxScoreCollapse() },
  estimators: { 'tool-definition': () => new ToolDefinitionSizeEstimator() },
};

export interface ResolvedToolsProfile {
  readonly key: string;
  /** Undefined = baseline (no profile is bound). */
  readonly profile?: ICollectionProfile<ToolItem>;
  /**
   * The store SECTION of each companion the profile needs (`intents` for the companion
   * placement) — never a built store. The profile instance may be shared by several
   * bindings; companion storage may not (spec §7.3.3, D33): the server builds one store per
   * primary binding from this section, with that primary's embedder.
   */
  readonly companionStores: Readonly<Record<string, SmartServerRagStoreConfig>>;
  readonly variant?: string;
  /** small-set-jev: checked against the tool count at startup (D23). */
  readonly poolItems?: number;
}

/** decisionCfg + the seam of each kind (decision-seams.ts). */
export interface ResolveCollectionProfilesInput extends DecisionSeams {
  profiles?: Record<string, SmartServerProfileConfig>;
  /** Resolves a key of the `llm:` map (strict). */
  resolveLlm: (key: string) => Promise<ILlm>;
  /** The store's query embedder (the one makeRag gives the store); for decomposers. */
  queryEmbedder?: IQueryEmbedder;
  /** Test seam; default readFileSync(path, 'utf8'). */
  readFile?: (path: string) => string;
  variantFactories?: Readonly<Record<string, ToolsVariantFactory>>;
  strategyFactories?: ToolsStrategyFactories;
}

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
    texts: { ...BUILT_IN_TOOLS_STRATEGIES.texts, ...input.strategyFactories?.texts },
    discriminators: { ...BUILT_IN_TOOLS_STRATEGIES.discriminators, ...input.strategyFactories?.discriminators },
    pools: { ...input.strategyFactories?.pools },
    collapse: { ...BUILT_IN_TOOLS_STRATEGIES.collapse, ...input.strategyFactories?.collapse },
    cuts: { ...input.strategyFactories?.cuts },
    estimators: { ...BUILT_IN_TOOLS_STRATEGIES.estimators, ...input.strategyFactories?.estimators },
    decomposers: { ...input.strategyFactories?.decomposers },
  };
  const readFile = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  // ONE decision per server, of its provider's kind, built once (spec §6.2).
  const decisions = decisionBuilders(input);
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
    companionStores: Record<string, SmartServerRagStoreConfig>,
  ): Promise<VariantIntents> => {
    if ('record' in cfg) return { record: await intentSource(cfg.record) };
    // The section only: one store per primary binding is built by the server (D33).
    companionStores.intents = cfg.companion.store;
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
    const text = c.text ? { text: pick(s.texts, 'text composer', c.text)() } : {};
    let base: IItemIndexer<ToolItem>;
    if ('faceted' in c.indexer) base = new FacetedToolIndexer(facetsOf(c.indexer.faceted), text);
    else {
      const e = c.indexer['enum-values'];
      const d = e.discriminator;
      base = new EnumValueToolIndexer(new FacetedToolIndexer(facetsOf(e.inner.faceted), text), {
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
        // The reranker of decision.provider's kind (spec §6.2, D27).
        reranker = await decisionRerankerFor(decisions, {
          task: preset.task,
          criteria: preset.criteria,
          explicit: c.question !== undefined,
        });
        break;
      case 'llm':
        // TOOL_QUESTION.task is a DecisionEntry; LlmReranker's question.task is a string (as resolve-retrieval.ts casts it)
        reranker = new LlmReranker(await input.resolveLlm(need(c.llm, 'reranker: llm needs llm:')), { question: { task: preset.task as string } });
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
      const companionStores: Record<string, SmartServerRagStoreConfig> = {};
      const intents = cfg.intents ? await intentsOf(cfg.intents, companionStores) : undefined;
      const decomposerName = cfg.decomposer ?? cfg.compose?.decomposer;
      const decompose = decomposerName && decomposerName !== 'none' ? decomposeOf(decomposerName) : undefined;
      if (cfg.variant !== undefined) {
        const factory = variants[cfg.variant];
        if (!factory) throw new Error(`unknown variant "${cfg.variant}" (known: ${Object.keys(variants).join(', ')})`);
        const builtIn = cfg.variant in BUILT_IN_TOOLS_VARIANTS;
        // A built-in decision variant gets the decision of the kind it takes (the validator
        // already matched the provider's kind); a consumer's variant gets whatever the
        // decision: section builds, if anything.
        const wants: 'probability' | 'relevance' | undefined = builtIn
          ? cfg.variant === 'faceted-cohere'
            ? 'relevance'
            : cfg.variant === 'faceted-jev' || cfg.variant === 'small-set-jev'
              ? 'probability'
              : undefined
          : decisions.kind;
        const profile = factory({
          ...(wants === 'probability' ? { probabilityDecision: await decisions.probability() } : {}),
          ...(wants === 'relevance' ? { relevanceDecision: await decisions.relevance() } : {}),
          ...(cfg.smallSet ? { poolItems: cfg.smallSet.poolItems } : {}),
          ...(intents ? { intents } : {}),
          ...(decompose ? { decompose } : {}),
        });
        out.set(key, {
          key,
          ...(profile ? { profile } : {}),
          companionStores,
          variant: cfg.variant,
          ...(cfg.variant === 'small-set-jev' && cfg.smallSet ? { poolItems: cfg.smallSet.poolItems } : {}),
        });
      } else if (cfg.compose) {
        out.set(key, { key, profile: await composeOf(cfg.compose, intents, decompose), companionStores });
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
with, beside the `./resolve-retrieval.js` import (L139–142): `import type { ToolsStrategyFactories, ToolsVariantFactory } from './resolve-collection-profiles.js';` (type-only — `resolve-collection-profiles.ts` does not import `smart-server.ts`, and a type import emits nothing either way). Task 23 turns this into the one value import from that module.

Export from `src/index.ts`: `assertSmallSetPool`, `BUILT_IN_TOOLS_STRATEGIES`, `BUILT_IN_TOOLS_VARIANTS`, `resolveCollectionProfiles`, `decisionBuilders`, `decisionRerankerFor`, and types `DecisionSeams`, `ResolvedToolsProfile`, `ToolsStrategyFactories`, `ToolsVariantFactory`, `ToolsVariantInput`.

`config-validator.ts` already imports `DECISION_KINDS` from `./decision-config.js` (Task 21); nothing to change there.

- [ ] **Step 4: Run**

Run:
```bash
npm install && grep -n '"link": true' package-lock.json
npx tsc -b packages/llm-agent-server-libs
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-retrieval.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-*.test.ts
node --import tsx/esm --test --test-reporter=spec 'test/repo/*.test.ts'
```
Expected: PASS (incl. `resolve-retrieval.test.ts`: the 30.1.0 missing-`decision:` text and the relevance reranker); only workspace siblings are linked; `scoped-dependencies` accepts the new peer.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs package-lock.json
git commit -m "feat(server-libs): resolve rag.profiles names to strategy instances; decision: by kind; small-set pool check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 23: SmartServer wiring — bind at creation, workers by key, startup check (server-libs)

Spec §6.1 (server binds, builder reuses), §6.2 (only `rag.profiles.tools`, S8; workers' tools stores get the main config's profile; a persistent companion store with a worker's own `rag` refused), §7.3.3 (companion storage per primary binding, D33), §7.4 (D23).

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (field near `_retrievalStrategies` ~line 840; resolution after `resolvedEmbedder` ~line 1434; the `toolsRag` creation ~line 1550; the worker `makeToolsRag` ~line 2170; before `new HealthChecker(` ~line 1888)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts` (append tests; reuses its stub MCP server)

**Interfaces:**
- Consumes: `resolveCollectionProfiles`, `assertSmallSetPool`, `ResolvedToolsProfile` (Task 22); `bindToolsProfile` (`@mcp-abap-adt/llm-agent-libs`, Task 15); `toMakeRagInput` (`rag-config.ts`); `isToolCatalogReporter` (`@mcp-abap-adt/llm-agent`).
- Produces: `rag.profiles.tools` binds the server's tools store (main and every worker store) at creation, each primary binding with companion stores of its own, built through `makeRag` with that primary's embedder (D33; a worker reading the main store shares the main binding, companions included); startup refuses a non-in-memory companion store when a worker declares its own `rag` (D33); startup fails when `small-set-jev`'s `poolItems` < the listed tool count; a `SmartServerConfig` built in code with a `rag.profiles` key other than `tools` is refused at start too (S8 — such a config skips the YAML validator of Task 21, so the server checks again: never a silent drop).

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
      makeProbabilityDecision: async () =>
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

/** A companion intents file (empty map: the companion stores are what these tests count). */
function companionFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'intents.json');
  writeFileSync(file, '{}');
  return file;
}

test('D33: every primary binding gets companion stores of its own; a reader worker shares the main binding', async (t) => {
  const file = companionFile(t);
  const companions: IRag[] = [];
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      mode: 'smart',
      rag: {
        store: { type: 'in-memory' },
        profiles: {
          tools: {
            variant: 'faceted',
            intents: { companion: { source: { file }, store: { type: 'in-memory', collectionName: 'companion' } } },
          },
        },
      },
      mcpClients: [],
      subAgentConfigs: [
        { name: 'reader', config: { skipModelValidation: true } },
        { name: 'own', config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } } } },
      ],
    } as unknown as SmartServerConfig,
    {
      ...constructionSeams,
      makeRag: async (input) => {
        const rag = await constructionSeams.makeRag(input);
        if (input.store.collectionName === 'companion') companions.push(rag);
        return rag;
      },
    },
  );
  const handle = await server.start();
  try {
    assert.equal(companions.length, 2, 'main + the worker with its own store; the reader worker builds none');
    assert.notEqual(companions[0], companions[1], 'two catalogs never share a companion store');
  } finally {
    await handle.close();
  }
});

test('D33: a persistent companion store with a worker that has its own rag is refused at start', async (t) => {
  const file = companionFile(t);
  const server = new SmartServer(
    {
      port: 0,
      llm: { model: 'test-model' },
      skipModelValidation: true,
      rag: {
        store: { type: 'in-memory' },
        profiles: {
          tools: {
            variant: 'faceted',
            intents: {
              companion: { source: { file }, store: { type: 'qdrant', url: 'http://127.0.0.1:9', collectionName: 'intents' } },
            },
          },
        },
      },
      mcpClients: [],
      subAgentConfigs: [{ name: 'own', config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } } } }],
    } as unknown as SmartServerConfig,
    constructionSeams,
  );
  await assert.rejects(server.start(), /companion\.store: a qdrant companion .* worker 'own' has its own tools store/);
});
```
Add to the file's imports: `recordId` from `@mcp-abap-adt/llm-agent`, `toolsBindingOf` from `@mcp-abap-adt/llm-agent-libs`; `type SmartServerConfig` beside `SmartServer` (`'../smart-server.js'`); `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';`, `import { tmpdir } from 'node:os';`, `import { join } from 'node:path';` (`IRag` is already imported).

- [ ] **Step 2: Run to see them fail**

Run: `npx tsc -b packages/llm-agent-libs && node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts`
Expected: FAIL — the store carries no binding; startup does not refuse; no companion store is built.

- [ ] **Step 3: Implement**

In `smart-server.ts`:
- imports: `bindToolsProfile` into the `@mcp-abap-adt/llm-agent-libs` value import (L74–91); `isToolCatalogReporter` into the `@mcp-abap-adt/llm-agent` value import (L49–66 — not imported today); replace Task 22's `import type { ToolsStrategyFactories, ToolsVariantFactory } from './resolve-collection-profiles.js';` with ONE import from that module:
  ```ts
  import {
    assertSmallSetPool,
    type ResolvedToolsProfile,
    resolveCollectionProfiles,
    type ToolsStrategyFactories,
    type ToolsVariantFactory,
  } from './resolve-collection-profiles.js';
  ```
  (`IRag`, `IRetrievalEmbedder` (type import, L11–48), `toMakeRagInput`, `SmartServerRagConfig` and `withStrategy` are already there; `withStrategy` keeps its `history` callers and the unbound arm of `withToolsStore`, so nothing becomes unused.)
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
      makeProbabilityDecision: this._deps.makeProbabilityDecision,
      // the relevance seam (Task 22); the provider's kind picks which one is called
      makeRelevanceDecision: this._deps.makeRelevanceDecision,
      resolveLlm: (key) => this.roleLlm().resolveNamed(key),
      queryEmbedder: resolvedEmbedder,
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
    // D33 (spec §7.3.3): companion storage is per primary binding. A persistent
    // companion section names ONE collection; a worker with its own tools store
    // would need a second one the config does not name — refuse, never derive.
    const ownStoreWorker = (this.cfg.subAgentConfigs ?? []).find((w) => w.config.rag);
    if (ownStoreWorker) {
      const sections = this._toolsProfiles.get('tools')?.companionStores ?? {};
      for (const [companion, section] of Object.entries(sections)) {
        if (section.type !== 'in-memory') {
          throw new Error(
            `rag.profiles.tools.intents.companion.store: a ${section.type} companion holds one catalog's ${companion} records, but worker '${ownStoreWorker.name}' has its own tools store and would share it — use an in-memory companion store, intents.record, or bind that worker's store in your composition root`,
          );
        }
      }
    }
  ```
- add the method next to `withStrategy`:
  ```ts
  /**
   * The server-built tools store (main or worker) bound to `rag.profiles.tools`
   * when configured — a store per binding, one profile (goal 6) — else wrapped
   * in its `rag.retrieval` strategy as in 30.1.0. The builder reuses the binding.
   *
   * Each PRIMARY binding gets companion stores of its own (spec §7.3.3, D33),
   * built here through makeRag with this primary's embedder: two catalogs that
   * share one companion store would overwrite and delete each other's records
   * (`recordId` has no binding in it). A worker reading the main store by
   * reference never comes here — it shares the main binding, companions included.
   */
  private async withToolsStore(
    store: IRag,
    embedder: IRetrievalEmbedder | undefined,
  ): Promise<IRag> {
    const p = this._toolsProfiles.get('tools');
    if (!p?.profile) return this.withStrategy('tools', store);
    const companions: Record<string, IRag> = {};
    for (const [name, section] of Object.entries(p.companionStores)) {
      companions[name] = await this._deps.makeRag(
        toMakeRagInput(section, embedder, 'rag.profiles.tools.intents.companion'),
      );
    }
    return bindToolsProfile(p.profile, { key: 'tools', rag: store, companions }).rag;
  }
  ```
- main store: replace `toolsRag = this.withStrategy('tools', await this._deps.makeRag(input));` with `toolsRag = await this.withToolsStore(await this._deps.makeRag(input), resolvedEmbedder);` (`resolvedEmbedder` is what `input` was built with, two lines above).
- in the worker `makeToolsRag` closure, keep the worker's input so its embedder reaches the companions:
  ```ts
      makeToolsRag: subCfg.rag
        ? async () => {
            const input = await this._workerRagInput(
              name,
              subCfg.rag as SmartServerRagConfig,
              subCfg.embedder,
              embedderFactories,
            );
            return this.withToolsStore(await this._deps.makeRag(input), input.embedder);
          }
        : undefined,
  ```
  (`input.embedder` reads both `MakeRagInput` arms: optional on in-memory, required on the vector arm. `makeHistoryRag` is unchanged — `withStrategy` keeps it as a caller.)
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
npx tsc -b packages/llm-agent-server-libs
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-wiring.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-server-libs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): SmartServer binds rag.profiles.tools at store creation, companions per binding; small-set startup check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 23A: The server fills a bound tools store once, when it is created — the main store at startup, a worker's store by the worker's construction (libs + server-libs)

Spec §6.3 (D31; D32 — a worker's fill keeps the identity its agent dispatches by, §17.8; D34 — the binding travels with the store; D35 — whoever creates a bound store fills it, §17.9; D38 — workers on the shared clients filled at startup, on `yamlBuilderConnect` right after the harvest; D39 — the hot-reload test drives the reload entry point; §17.10; **D41 — filled once at creation, never refilled: no memo, no retry, a re-wire never fills; D42 — the store's fill source runs, §17.11**), §6.4 (rows 4–7, 5a), §6.6 (only `tools`), §6.1 (the builder keeps its limit), §7.3.3 (D33 — companion storage per primary binding, built in Task 23), §7.6 (the profile path, reused), §3.8 (`fillToolsBinding`, `HealthCheckerDeps.toolCatalog`; the two no-contract-change rows), §14.1. The YAML `fill` key arrives in Task 23B; until then every server-bound store carries the default `live` source.

**Why.** After Task 23 a YAML `rag.profiles.tools` is bound on every path, but filled only where the builder connects itself (`yamlBuilderConnect` in `smart-server.ts`). The other provisioning paths in `_buildInfra` hand the clients to the builder through `withMcpClients` (main: `buildBaseBuilder` → `builder.withMcpClients(parts.mcpClients)`; workers: `buildSubAgent` → `subBuilder.withMcpClients(...)`), and the builder does not vectorize there (spec §6.1). The paths, as they are in `smart-server.ts` today:

| Path | Code | Clients |
|---|---|---|
| ready clients | `diOrPluginMcpClients = this._deps.mcpClients ?? this.cfg.mcpClients ?? (plugins.mcpClients.length > 0 ? plugins.mcpClients : undefined)`; `hasReadyClients` = presence (even `[]`) | `mcpClients = diOrPluginMcpClients` → `buildSharedPipelineInfra` → `_sharedMcpClients` |
| injected seam | `else if (this.cfg.mcp && this._mcpSeamInjected)` → `_resolveMcpWithDescriptors` (`connectMcpWithDescriptors` > bare `connectMcp`) | `_stepperMcpClients` → `_sharedMcpClients`, `_sharedMcpClientDescriptors`, `_configuredSlotCount` |
| YAML builder connect | `yamlBuilderConnect = mcpFromYaml` (YAML `mcp:`, no ready clients, no seam) | the builder connects and fills (Task 20); harvested into `_sharedMcpClients` after `build()` |
| no MCP | none of the above | `buildSharedPipelineInfra` → `_sharedMcpClients = []` |

**Where a worker's own store is created — and so filled (D35, D41).** `buildSubAgent` → `resolveWorkerLlmSet` → `makeToolsRag` → `withToolsStore` (Task 23) creates and binds it. That runs on the worker's **construction** — `buildSubAgent` without `injected`: the startup primary build (`_buildInfra`'s `subAgentConfigs` loop) and the lazy rebuild in `WorkerRegistry.build` after `PUT /v1/config` or a hot reload drained the cache (`WorkerRegistry.drain` → the next session's cache miss). Filling it only in `_buildInfra` would leave every rebuilt store empty (review finding (b)), so the construction fills it, right before `subBuilder.build()`. A per-session re-wire (`injected` set) receives the cached store by reference and **never fills** (D41): no memo, no retry — an incomplete fill is reported and stays. On `yamlBuilderConnect` the shared clients are known only after the workers' startup build, so `_buildInfra` fills the workers on them in one pass right after the harvest — at startup, completing their creation (D38). A construction whose fill throws removes the worker's cache entry before rethrowing, so no session re-wires a worker whose store was never filled. (Two sessions arriving together after a drain may still construct one worker twice — the 30.1.0 race moved to a separate issue, spec §15, D45; each construction then fills its own new store.)

**Files:**
- Create: `packages/llm-agent-libs/src/mcp/fill-tools-binding.ts`
- Modify: `packages/llm-agent-libs/src/index.ts` (export beside `HealthChecker`, ~line 82)
- Modify: `packages/llm-agent-libs/src/health/health-checker.ts` (`HealthCheckerDeps.toolCatalog?`)
- Create: `packages/llm-agent-libs/src/__tests__/fill-tools-binding.test.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (fields after Task 23's `_toolsProfiles`; methods after Task 23's `withToolsStore`; the fill block right after the `if (yamlBuilderConnect) { … buildToolsRagHandle … }` harvest block ~line 1782; Task 23's `assertSmallSetPool(…)` call and `new HealthChecker({` ~line 1888)
- Create: `packages/llm-agent-server-libs/src/smart-agent/workers/connected-mcp-server.ts` (D32: an already-connected client as an `IMcpServer`, so a worker's builder gets clients WITH descriptors through the existing `withMcpServers`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/workers/worker-registry.ts` (`WorkerLlmSet.mcpClientDescriptors?`, backfilled beside `mcpClients`; `BuildSubAgentFn`'s `injected.mcpClientDescriptors?` / `injected.configuredSlotCount?`; the per-session re-wire forwards the descriptors and slot count of the clients it hands over)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` `buildSubAgent` (`injected.mcpClientDescriptors?` / `configuredSlotCount?`; `withToolNamespace`; clients with descriptors → `withMcpServers`; **the worker's own bound store filled before `subBuilder.build()`**, D35)
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/profile-fill-ready-clients.test.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts` (append the D38 startup fill on `yamlBuilderConnect`; reuses its stub MCP server)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config-reload-watcher.ts` (`_onReload` returns the drain + invalidation as one promise, D39)
- Create: `packages/llm-agent-server-libs/src/smart-agent/__tests__/config-reload-entry.test.ts` (the watcher's `reload` event reaches `_onReload`, D39)

**Interfaces:**
- Consumes: `vectorizeMcpTools`, which reads the binding from the store (Task 19, D34); `bindToolsProfile`, `toolsBindingOf` (Task 15); `mcpToolsVariants` (Task 16); `ToolsVariantFactory`, `SmartServerConfig.toolsVariantFactories` (Task 22); Task 23's `_toolsProfiles`, `withToolsStore`, `assertSmallSetPool` call and `isToolCatalogReporter` import; `ToolCatalogStatus.records` / `.profile` (Task 3).
- Produces:
  ```ts
  // @mcp-abap-adt/llm-agent-libs
  export interface FillToolsBindingOptions { readonly logger?: ILogger; readonly toolRecordKey?: IToolRecordKey; readonly toolNamespace?: IToolNamespace; readonly descriptors?: readonly McpClientDescriptor[]; readonly configuredSlotCount?: number; readonly callOptions?: CallOptions }
  export function fillToolsBinding(clients: readonly IMcpClient[], binding: IBoundCollection<ToolItem>, options?: FillToolsBindingOptions): Promise<ToolCatalogStatus | undefined>; // runs the store's fill source at creation (D42); undefined when the source attempts nothing (consumer) or callOptions.signal is already aborted; rejects a binding its store does not carry (D34)
  // HealthCheckerDeps gains: toolCatalog?: IToolCatalogReporter  (absent → the agent's own status, 30.1.0)
  ```
  The server: with a bound `tools` store, `_buildInfra` fills it once from `_sharedMcpClients` on every path except `yamlBuilderConnect` (there the builder filled it at its `build()`). The worker's construction (`buildSubAgent` without `injected`) fills a worker's OWN bound store (D35, D41), before `subBuilder.build()`, from the clients its re-wires will hand that worker — the worker's own `mcpClients` in array order (they carry no descriptors), or the shared clients with `_sharedMcpClientDescriptors` / `_configuredSlotCount` once they are known (D32); on `yamlBuilderConnect` `_buildInfra` fills those workers right after the harvest (`fillSharedClientWorkerStores`, D38). So startup, a lazy rebuild, `PUT /v1/config` and hot reload all fill it — once per store. A per-session re-wire never fills; nothing is memoized or retried (D41). A worker on its own `mcp:` is filled by its own builder on the construction's build. A construction whose fill throws drops the worker's cache entry. `ConfigReloadWatcher._onReload` returns the drain + invalidation as one promise and the server keeps the watcher (`_configReload`), so tests drive a hot reload directly (D39). Every worker's builder dispatches by the identity its store was filled with (the clients' descriptors through `withMcpServers` + `connectedMcpServer`, the server's `withToolNamespace`). `/health` and the D23 check read the main status; a worker's fill is logged only. Without a binding nothing new runs.

- [ ] **Step 1: Write the failing libs test**

```ts
// packages/llm-agent-libs/src/__tests__/fill-tools-binding.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IMcpClient,
  InMemoryRag,
  type McpTool,
  type ToolCatalogStatus,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import {
  bindToolsProfile,
  ComposedToolsProfile,
  FacetedToolIndexer,
  ItemPool,
  MaxScoreCollapse,
  SummaryFacet,
} from '../collections/index.js';
import { HealthChecker } from '../health/health-checker.js';
import { fillToolsBinding } from '../mcp/fill-tools-binding.js';

const TOOLS: McpTool[] = [
  { name: 'read_file', description: 'Read a file', inputSchema: { properties: { path: { type: 'string' } } } },
  { name: 'list_issues', description: 'List issues', inputSchema: {} },
];
const client = (tools: McpTool[] | 'fail'): IMcpClient =>
  ({
    listTools: async () =>
      tools === 'fail' ? { ok: false, error: { message: 'listTools failed' } } : { ok: true, value: tools },
    callTool: async () => ({ ok: true, value: { content: [] } }),
  }) as unknown as IMcpClient;
const profile = () =>
  new ComposedToolsProfile({
    indexer: new FacetedToolIndexer([new SummaryFacet()]),
    pool: new ItemPool(10),
    collapse: new MaxScoreCollapse(),
  });
const bound = () => bindToolsProfile(profile(), { key: 'tools', rag: new InMemoryRag() });

describe('fillToolsBinding', () => {
  it('fills a bound store through the profile path; status in items, plus records and profile', async () => {
    const b = bound();
    const s = await fillToolsBinding([client(TOOLS)], b);
    assert.deepEqual(s, { total: 2, vectorized: 2, failed: [], clientFailures: 0, complete: true, records: 4, profile: 'mcp-tools' });
    const item = await b.get({ itemId: 'tool:read_file', owner: { scope: 'global' } });
    assert.ok(item.ok && item.value, 'the canonical record is there');
    const legacy = await b.rag.getById('tool:read_file');
    assert.ok(legacy.ok && legacy.value === null, 'never the 30.1.0 record');
  });

  it('a client whose listTools fails is counted — never a silent empty store', async () => {
    const s = await fillToolsBinding([client(TOOLS), client('fail')], bound());
    assert.equal(s?.clientFailures, 1);
    assert.equal(s?.complete, false);
    assert.equal(s?.vectorized, 2);
  });

  it('several clients: item ids follow the client order (defaultToolRecordKey)', async () => {
    const b = bound();
    await fillToolsBinding([client([TOOLS[0]]), client([TOOLS[1]])], b);
    const second = await b.get({ itemId: 'tool:1:list_issues', owner: { scope: 'global' } });
    assert.ok(second.ok && second.value);
  });

  it('refuses a binding its store does not carry — a later toolsChanged refill would miss it (D34)', async () => {
    const loose = profile().bind({ key: 'tools', rag: new InMemoryRag() }); // not through bindToolsProfile
    await assert.rejects(fillToolsBinding([client(TOOLS)], loose), /bindToolsProfile/);
    const r = await loose.rag.getById('tool:read_file');
    assert.ok(r.ok && r.value === null, 'nothing written, not even a 30.1.0 record');
  });
});

describe('HealthCheckerDeps.toolCatalog', () => {
  const agent = (status?: ToolCatalogStatus) =>
    ({
      healthCheck: async () => ({ ok: true, value: { llm: true, rag: true, mcp: [] } }),
      getToolCatalogStatus: () => status,
    }) as unknown as SmartAgent;
  const partial: ToolCatalogStatus = { total: 3, vectorized: 2, failed: ['x'], clientFailures: 0, complete: false };

  it('a supplied reporter is what /health reports', async () => {
    const h = await new HealthChecker({
      agent: agent(undefined),
      startTime: Date.now(),
      version: 'x',
      toolCatalog: { getToolCatalogStatus: () => partial },
    }).check();
    assert.equal(h.status, 'degraded');
    assert.deepEqual(h.components.toolCatalog, { vectorized: 2, total: 3, complete: false, clientFailures: 0 });
  });

  it("absent → the agent's own status, as in 30.1.0", async () => {
    const h = await new HealthChecker({ agent: agent(undefined), startTime: Date.now(), version: 'x' }).check();
    assert.equal(h.status, 'healthy');
    assert.equal(h.components.toolCatalog, undefined);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/fill-tools-binding.test.ts`
Expected: FAIL — `../mcp/fill-tools-binding.js` does not exist; `toolCatalog` is not read.

- [ ] **Step 3: Implement (libs)**

```ts
// packages/llm-agent-libs/src/mcp/fill-tools-binding.ts
import type {
  CallOptions,
  IBoundCollection,
  ILogger,
  IMcpClient,
  IToolNamespace,
  IToolRecordKey,
  McpClientDescriptor,
  ToolCatalogStatus,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { toolsBindingOf } from '../collections/tools-binding.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { vectorizeMcpTools } from './vectorize-mcp-tools.js';

export interface FillToolsBindingOptions {
  readonly logger?: ILogger;
  /** Default `defaultToolRecordKey` — the one the builder uses unless `withToolRecordKey` set another. */
  readonly toolRecordKey?: IToolRecordKey;
  /** Default `defaultToolNamespace`. */
  readonly toolNamespace?: IToolNamespace;
  /** Stable slots from a connection result; absent → array order. */
  readonly descriptors?: readonly McpClientDescriptor[];
  readonly configuredSlotCount?: number;
  readonly callOptions?: CallOptions;
}

/**
 * Fill a bound tools store at its creation (spec §6.3, D31, D41): runs the
 * fill source the store carries (§3.10, D42) through `vectorizeMcpTools`,
 * which reads the binding and its source from `binding.rag` (D34). For `live`
 * that is list, namespace, key, `toolItemFromTool`, `binding.index` — the
 * profile path (§7.6), reused, never duplicated; `corpus` / `prebuilt` read no
 * client. The typed `binding` parameter guarantees there is one, so the 30.1.0
 * record path cannot be reached here.
 *
 * Resolves `undefined` when the source attempts nothing (`consumer`) or
 * `callOptions.signal` is already aborted.
 * Rejects a binding its store does not carry (made by `profile.bind()`, not
 * `bindToolsProfile`): this fill and every later `toolsChanged` refill would
 * write 30.1.0 records into it. Rejects as `vectorizeMcpTools` does too: an
 * `IToolRecordKey` id without `tool:`, or descriptors that do not match the
 * clients.
 */
export async function fillToolsBinding(
  clients: readonly IMcpClient[],
  binding: IBoundCollection<ToolItem>,
  options: FillToolsBindingOptions = {},
): Promise<ToolCatalogStatus | undefined> {
  if (toolsBindingOf(binding.rag) !== binding) {
    throw new Error(
      `fillToolsBinding: the store does not carry this binding (profile ${binding.profileName}) — bind with bindToolsProfile(profile, target), not profile.bind(target), so every refill of the store finds it`,
    );
  }
  return vectorizeMcpTools(
    [...clients],
    binding.rag,
    // The profile path logs no embedding usage through the request logger (Task 19).
    new NoopRequestLogger(),
    options.logger,
    options.toolRecordKey,
    options.callOptions,
    {
      descriptors: options.descriptors,
      configuredSlotCount: options.configuredSlotCount,
      toolNamespace: options.toolNamespace,
    },
  );
}
```
(`toolRecordKey` `undefined` → `vectorizeMcpTools`' default parameter `defaultToolRecordKey` applies.)

`packages/llm-agent-libs/src/index.ts`, right after the `HealthChecker` / `HealthCheckerDeps` export block:
```ts
export {
  type FillToolsBindingOptions,
  fillToolsBinding,
} from './mcp/fill-tools-binding.js';
```

`packages/llm-agent-libs/src/health/health-checker.ts`:
- type import: `import type { CircuitBreaker, IToolCatalogReporter } from '@mcp-abap-adt/llm-agent';`
- `HealthCheckerDeps`, after `metrics?`:
  ```ts
  /**
   * The tool catalog /health reports. Absent → the agent's own status (30.1.0).
   * A server that fills the tools store outside the builder passes its own
   * (spec §6.3) — the builder's status holder is private to build().
   */
  toolCatalog?: IToolCatalogReporter;
  ```
- field `private readonly toolCatalog?: IToolCatalogReporter;`, set in the constructor: `this.toolCatalog = deps.toolCatalog;`
- in `check()`, replace
  ```ts
    const tc = isToolCatalogReporter(this.agent)
      ? this.agent.getToolCatalogStatus()
      : undefined;
  ```
  with
  ```ts
    const reporter =
      this.toolCatalog ??
      (isToolCatalogReporter(this.agent) ? this.agent : undefined);
    const tc = reporter?.getToolCatalogStatus();
  ```

- [ ] **Step 4: Run (libs)**

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/fill-tools-binding.test.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools-profile.test.ts packages/llm-agent-libs/src/health/health-checker.test.ts
```
Expected: PASS.

- [ ] **Step 5: Write the failing server tests**

```ts
// packages/llm-agent-server-libs/src/smart-agent/__tests__/profile-fill-ready-clients.test.ts
/**
 * Spec §6.3 (D31): with ready clients or an injected seam the startup builder
 * gets the clients through withMcpClients and does not vectorize, so the
 * SERVER fills a bound `rag.profiles.tools` store — once per store, before
 * it reports ready. Without a profile nothing new runs (30.1.0).
 * D35, D41: a worker's own store is filled by the construction that creates
 * it, so the stores rebuilt after PUT /v1/config and a hot reload are filled
 * too; a per-session re-wire never fills, and nothing is retried.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ILlm,
  type IMcpClient,
  type IRag,
  type IToolIntentSource,
  recordId,
  SimpleRagRegistry,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  emptyLoadedPlugins,
  mcpToolsVariants,
  type SessionAgentParts,
  toolItemFromTool,
  toolsBindingOf,
} from '@mcp-abap-adt/llm-agent-libs';
import type { ToolsVariantFactory } from '../resolve-collection-profiles.js';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

type Deps = ConstructorParameters<typeof SmartServer>[1];
type Internals = { _toolsRag?: IRag };
/** White-box: the main dispatch catalog, the worker cache and a session's worker re-wire. */
type WorkerInternals = {
  _namespacedTools?: readonly { name: string }[];
  _workers: {
    cache: Map<string, { toolsRag?: IRag }>;
    build(parts: SessionAgentParts): Promise<Map<string, { run(input: unknown): Promise<unknown> }>>;
    drain(): Promise<void>;
  };
  _embeddedSessionParts(mcpClients: undefined, ragRegistry: SimpleRagRegistry): SessionAgentParts;
  /** The server's reload entry point (D39): the watcher it holds. */
  _configReload?: { _onReload(update: { maxIterations?: number }): Promise<void> };
};
type Health = {
  status: string;
  components: {
    toolCatalog?: { total: number; vectorized: number; complete: boolean; clientFailures: number };
  };
};

function client(names: readonly string[], opts: { fail?: boolean } = {}): IMcpClient {
  return {
    async listTools() {
      if (opts.fail) return { ok: false as const, error: { message: 'listTools failed' } };
      return {
        ok: true as const,
        value: names.map((name) => ({
          name,
          description: `Tool ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  } as unknown as IMcpClient;
}

/** `faceted` (or `make()`), with each `index` call recorded as the tool names it indexed and each `bind` (one per store built) in `binds`. */
function countingVariant(
  calls: string[][],
  make: () => ReturnType<typeof mcpToolsVariants.faceted> = () => mcpToolsVariants.faceted(),
  binds?: string[],
): ToolsVariantFactory {
  return () => {
    const inner = make();
    return {
      name: inner.name,
      bind(target) {
        binds?.push(target.key);
        const b = inner.bind(target);
        return {
          key: b.key,
          profileName: b.profileName,
          rag: b.rag,
          retrieval: b.retrieval,
          index: (items, o) => {
            calls.push(items.map((i) => i.name));
            return b.index(items, o);
          },
          remove: (refs, o) => b.remove(refs, o),
          get: (ref, o) => b.get(ref, o),
        };
      },
    };
  };
}

function cfg(extra: Record<string, unknown>, calls?: string[][]): SmartServerConfig {
  return {
    port: 0,
    llm: { model: 'test-model' },
    skipModelValidation: true,
    mode: 'smart',
    rag: calls
      ? { store: { type: 'in-memory' }, profiles: { tools: { variant: 'counting' } } }
      : { store: { type: 'in-memory' } },
    ...(calls ? { toolsVariantFactories: { counting: countingVariant(calls) } } : {}),
    ...extra,
  } as unknown as SmartServerConfig;
}

function getHealth(port: number): Promise<Health> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw) as Health);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function withServer(
  config: SmartServerConfig,
  deps: Deps,
  body: (s: { port: number; toolsRag: IRag | undefined; server: SmartServer }) => Promise<void>,
): Promise<void> {
  const server = new SmartServer(config, deps);
  const handle = await server.start();
  try {
    await body({ port: handle.port, toolsRag: (server as unknown as Internals)._toolsRag, server });
  } finally {
    await handle.close();
  }
}

/** Single-client ids are `tool:<name>` (defaultToolRecordKey, clientCount 1). */
async function assertFilled(toolsRag: IRag | undefined, names: readonly string[]): Promise<void> {
  assert.ok(toolsRag, 'the tools store exists');
  const binding = toolsBindingOf(toolsRag);
  assert.ok(binding, 'the tools store carries its binding');
  for (const name of names) {
    const got = await binding.get({ itemId: `tool:${name}`, owner: { scope: 'global' } });
    assert.ok(got.ok && got.value, `${name} is in the store`);
  }
  const hits = await toolsRag.query(new TextOnlyEmbedding(`Tool ${names[0]}`), 5);
  assert.ok(hits.ok);
  assert.ok(
    hits.value.some((h) => toolNameFromRecord(h.metadata) === names[0]),
    `${names[0]} is retrievable through the profile`,
  );
}

test('(1) ready clients + rag.profiles.tools → filled once, retrievable, catalog complete', async () => {
  const calls: string[][] = [];
  await withServer(
    cfg({ mcpClients: [client(['EchoTool', 'GetTable'])] }, calls),
    constructionSeams,
    async ({ port, toolsRag }) => {
      await assertFilled(toolsRag, ['EchoTool', 'GetTable']);
      assert.deepEqual(calls, [['EchoTool', 'GetTable']]);
      const tc = (await getHealth(port)).components.toolCatalog;
      assert.ok(tc, '/health reports the catalog');
      assert.equal(tc.complete, true);
      assert.equal(tc.total, 2);
      assert.equal(tc.vectorized, 2);
      assert.equal(tc.clientFailures, 0);
    },
  );
});

test('(2) injected connectMcp seam + YAML mcp: → filled the same way', async () => {
  const calls: string[][] = [];
  await withServer(
    cfg({ mcp: { type: 'http', url: 'http://127.0.0.1:9/never-connected' } }, calls),
    { ...constructionSeams, connectMcp: async () => [client(['EchoTool', 'GetTable'])] },
    async ({ port, toolsRag }) => {
      await assertFilled(toolsRag, ['EchoTool', 'GetTable']);
      assert.equal(calls.length, 1);
      assert.equal((await getHealth(port)).components.toolCatalog?.complete, true);
    },
  );
});

test('(3) plugin clients → included in the fill', async () => {
  const calls: string[][] = [];
  await withServer(
    cfg(
      { pluginLoader: { load: async () => ({ ...emptyLoadedPlugins(), mcpClients: [client(['PluginTool'])] }) } },
      calls,
    ),
    constructionSeams,
    async ({ toolsRag }) => {
      await assertFilled(toolsRag, ['PluginTool']);
      assert.deepEqual(calls, [['PluginTool']]);
    },
  );
});

test('(4) no profile + ready clients → nothing new (30.1.0 unchanged)', async () => {
  await withServer(
    cfg({ mcpClients: [client(['EchoTool'])] }),
    constructionSeams,
    async ({ port, toolsRag }) => {
      assert.ok(toolsRag);
      assert.equal(toolsBindingOf(toolsRag), undefined, 'no binding');
      const legacy = await toolsRag.getById('tool:EchoTool');
      assert.ok(legacy.ok && legacy.value === null, 'no 30.1.0 record: withMcpClients does not vectorize');
      const profiled = await toolsRag.getById(recordId({ scope: 'global' }, 'tool:EchoTool', 'full', 0));
      assert.ok(profiled.ok && profiled.value === null, 'no profile record');
      assert.equal((await getHealth(port)).components.toolCatalog, undefined, 'no catalog status, as in 30.1.0');
    },
  );
});

test('(5) a client whose listTools fails → counted and degraded, the others filled — never a silent empty store', async () => {
  const calls: string[][] = [];
  await withServer(
    cfg({ mcpClients: [client(['EchoTool']), client([], { fail: true })] }, calls),
    constructionSeams,
    async ({ port, toolsRag }) => {
      assert.ok(toolsRag);
      // two clients → ids `tool:<slot>:<name>`; check by retrieval, not by id
      const hits = await toolsRag.query(new TextOnlyEmbedding('Tool EchoTool'), 5);
      assert.ok(hits.ok && hits.value.some((h) => toolNameFromRecord(h.metadata) === 'EchoTool'));
      const h = await getHealth(port);
      assert.ok(h.components.toolCatalog, 'the catalog is reported, not left unknown');
      assert.equal(h.components.toolCatalog.clientFailures, 1);
      assert.equal(h.components.toolCatalog.complete, false);
      assert.equal(h.components.toolCatalog.total, 1);
      assert.equal(h.components.toolCatalog.vectorized, 1);
      assert.notEqual(h.status, 'healthy', 'an incomplete catalog degrades /health');
    },
  );
});

test('(6) main + workers → every store filled exactly once', async () => {
  const calls: string[][] = [];
  await withServer(
    cfg(
      {
        mcpClients: [client(['EchoTool'])],
        subAgentConfigs: [
          // reads the main store (no own rag) — must not fill it again
          { name: 'reader', config: { skipModelValidation: true } },
          // its own store, bound with the main profile (Task 23), its own clients
          {
            name: 'own',
            config: {
              skipModelValidation: true,
              rag: { store: { type: 'in-memory' } },
              mcpClients: [client(['WorkerTool'])],
            },
          },
        ],
      },
      calls,
    ),
    constructionSeams,
    async ({ toolsRag }) => {
      await assertFilled(toolsRag, ['EchoTool']);
      assert.deepEqual(calls.filter((c) => c.includes('EchoTool')), [['EchoTool']], 'the main store, once');
      assert.deepEqual(calls.filter((c) => c.includes('WorkerTool')), [['WorkerTool']], "the worker's own store, once, from its own clients");
      assert.equal(calls.length, 2, 'two stores, two fills');
    },
  );
});

/** Records the tool names each chat call offers; answers "ok" with no tool call. */
function recordingLlm(offered: string[][]): ILlm {
  return {
    model: 'test-model',
    chat: async (_messages: unknown, tools?: readonly { name: string }[]) => {
      if (tools && tools.length > 0) offered.push(tools.map((t) => t.name));
      return { ok: true as const, value: { content: 'ok', toolCalls: [] } };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
}

test('(7) D32: a worker filled from the shared clients holds the names its agent dispatches by — labels, a missing slot, a collision', async () => {
  const offered: string[][] = [];
  // Slots 0 and 2 connected, slot 1 down (3 configured); both servers expose `Search`.
  const seam = async () => ({
    clients: [client(['Search', 'Lookup']), client(['Search', 'Fetch'])],
    clientDescriptors: [
      { slotIndex: 0, label: 'alpha' },
      { slotIndex: 2, label: 'gamma' },
    ],
    configuredSlotCount: 3,
  });
  await withServer(
    cfg(
      {
        mcp: { type: 'http', url: 'http://127.0.0.1:9/never-connected' },
        subAgentConfigs: [
          {
            name: 'own',
            // its own store, no own clients → filled from the shared clients
            config: {
              skipModelValidation: true,
              agent: { classificationEnabled: false },
              rag: { store: { type: 'in-memory' } },
            },
          },
        ],
      },
      [],
    ),
    { ...constructionSeams, makeLlm: async () => recordingLlm(offered), connectMcpWithDescriptors: seam },
    async ({ toolsRag, server }) => {
      const s = server as unknown as WorkerInternals;
      const catalog = ['Fetch', 'Lookup', 'alpha__Search', 'gamma__Search'];
      assert.deepEqual(s._namespacedTools?.map((t) => t.name).sort(), catalog, 'the main dispatch catalog');
      const workerRag = s._workers.cache.get('own')?.toolsRag;
      assert.ok(toolsRag && workerRag && workerRag !== toolsRag, "the worker's own store");
      for (const [who, rag] of [['main', toolsRag], ['worker', workerRag]] as const) {
        const b = toolsBindingOf(rag);
        assert.ok(b, `${who}: bound`);
        // ids over the STABLE slot and the configured count: gamma is slot 2 of 3, not position 1
        const gamma = await b.get({ itemId: 'tool:2:Search', owner: { scope: 'global' } });
        assert.ok(gamma.ok && gamma.value, `${who}: tool:2:Search`);
        const hits = await rag.query(new TextOnlyEmbedding('Tool Search Lookup Fetch'), 10);
        assert.ok(hits.ok);
        assert.deepEqual(
          [...new Set(hits.value.map((h) => toolNameFromRecord(h.metadata)))].sort(),
          catalog,
          `${who}: the store holds exactly the catalog's names`,
        );
      }
      // The worker's agent as a session re-wires it: the shared clients WITH their descriptors.
      const workers = await s._workers.build(s._embeddedSessionParts(undefined, new SimpleRagRegistry()));
      await workers.get('own')?.run({ task: 'Tool Search', sessionId: 's1' });
      const names = offered.flat();
      assert.ok(
        names.includes('alpha__Search') && names.includes('gamma__Search'),
        `both colliding tools retrieved from the worker's store are offered — none dropped; offered ${JSON.stringify(offered)}`,
      );
      assert.ok(!names.some((n) => /^s\d+__/.test(n)), 'no array-position name');
      assert.ok(names.every((n) => catalog.includes(n)), 'every offered name is one the catalog can call');
    },
  );
});

/** Intents derived from the description: the two catalogs' `Lookup` get different intents. */
const intentsByDescription: IToolIntentSource = {
  name: 'by-description',
  intentsFor: async (t) => ({
    ok: true as const,
    value: [t.description.includes('invoice') ? 'billing ledger question' : 'forklift stock question'],
  }),
};

function describedClient(name: string, description: string): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [{ name, description, inputSchema: { type: 'object', properties: {} } }] };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'ok' } };
    },
  } as unknown as IMcpClient;
}

test('(8) D33: main + a worker with their own stores keep their own companion records — fill, replace, remove', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'intents.json');
  writeFileSync(file, '{}');
  const config = {
    port: 0,
    llm: { model: 'test-model' },
    skipModelValidation: true,
    mode: 'smart',
    rag: {
      store: { type: 'in-memory' },
      profiles: {
        tools: {
          variant: 'by-description',
          // the store section is what matters here; the variant brings its own intent source
          intents: { companion: { source: { file }, store: { type: 'in-memory' } } },
        },
      },
    },
    toolsVariantFactories: {
      'by-description': () => mcpToolsVariants.faceted({ intents: { companion: intentsByDescription } }),
    },
    mcpClients: [describedClient('Lookup', 'Find a customer invoice')],
    subAgentConfigs: [
      {
        name: 'own',
        config: {
          skipModelValidation: true,
          rag: { store: { type: 'in-memory' } },
          mcpClients: [describedClient('Lookup', 'Find a warehouse pallet')],
        },
      },
    ],
  } as unknown as SmartServerConfig;
  await withServer(config, constructionSeams, async ({ toolsRag, server }) => {
    const workerRag = (server as unknown as WorkerInternals)._workers.cache.get('own')?.toolsRag;
    assert.ok(toolsRag && workerRag);
    const main = toolsBindingOf(toolsRag);
    const worker = toolsBindingOf(workerRag);
    assert.ok(main && worker);
    const ref = { itemId: 'tool:Lookup', owner: { scope: 'global' as const } };
    /** `Lookup`'s score for a query; 0 = no shared word with any of its records. */
    const score = async (rag: IRag, q: string) => {
      const r = await rag.query(new TextOnlyEmbedding(q), 5);
      assert.ok(r.ok);
      return r.value.find((h) => toolNameFromRecord(h.metadata) === 'Lookup')?.score ?? 0;
    };
    const own = async (when: string) => {
      assert.ok((await score(workerRag, 'forklift stock')) > 0, `${when}: the worker finds Lookup by its own intents`);
      assert.equal(await score(workerRag, 'billing ledger'), 0, `${when}: never by the main's intents`);
      const w = await worker.get(ref);
      assert.ok(w.ok && w.value, `${when}: the worker's item is whole`);
    };

    // fill: each by its own intents only (a shared store would hold the LAST fill's intent for both)
    assert.ok((await score(toolsRag, 'billing ledger')) > 0, 'the main finds Lookup by its own intents');
    assert.equal(await score(toolsRag, 'forklift stock'), 0, "the main never by the worker's intents");
    await own('after the fill');

    // replace the main's item: its companion record is rewritten in ITS companion store only
    const replaced = await main.index([
      toolItemFromTool(
        { name: 'Lookup', description: 'Find a customer invoice by number', inputSchema: { type: 'object', properties: {} } },
        { itemId: 'tool:Lookup', originalName: 'Lookup' },
      ),
    ]);
    assert.ok(replaced.ok && replaced.value.failedItems.length === 0);
    assert.ok((await score(toolsRag, 'billing ledger')) > 0);
    await own('after the main replaced its item');

    // remove the main's item: its companion record goes, the worker's stays
    const removed = await main.remove([ref]);
    assert.ok(removed.ok);
    const gone = await main.get(ref);
    assert.ok(gone.ok && gone.value === null, "the main's item is gone");
    await own('after the main removed its item');
  });
});

// ---- D35: a worker's store is filled when the worker is built — also after a drain ----

/** Two labelled servers, slot 1 of 3 down, `Search` on both (as in (7)). */
const labelledSeam = async () => ({
  clients: [client(['Search', 'Lookup']), client(['Search', 'Fetch'])],
  clientDescriptors: [
    { slotIndex: 0, label: 'alpha' },
    { slotIndex: 2, label: 'gamma' },
  ],
  configuredSlotCount: 3,
});
const SHARED_CATALOG = ['Fetch', 'Lookup', 'alpha__Search', 'gamma__Search'];
const SHARED_IDS = ['tool:0:Search', 'tool:0:Lookup', 'tool:2:Search', 'tool:2:Fetch'];

/** Companion intents no primary record contains: `walrus <tool>`. */
const walrusIntents: IToolIntentSource = {
  name: 'walrus',
  intentsFor: async (t) => ({ ok: true as const, value: [`walrus ${t.originalName.toLowerCase()}`] }),
};

function emptyIntentsFile(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'companion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'intents.json');
  writeFileSync(file, '{}');
  return file;
}

/** Main + two workers with their own in-memory primary and companion stores: one on the shared clients, one on DI clients. */
function rebuildConfig(
  file: string,
  calls: string[][],
  extra: Record<string, unknown> = {},
  binds?: string[],
): SmartServerConfig {
  return {
    port: 0,
    llm: { model: 'test-model' },
    skipModelValidation: true,
    mode: 'smart',
    rag: {
      store: { type: 'in-memory' },
      profiles: {
        tools: {
          variant: 'counting-walrus',
          intents: { companion: { source: { file }, store: { type: 'in-memory' } } },
        },
      },
    },
    toolsVariantFactories: {
      'counting-walrus': countingVariant(
        calls,
        () => mcpToolsVariants.faceted({ intents: { companion: walrusIntents } }),
        binds,
      ),
    },
    mcp: { type: 'http', url: 'http://127.0.0.1:9/never-connected' },
    subAgentConfigs: [
      { name: 'shared', config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } } } },
      {
        name: 'di',
        config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } }, mcpClients: [client(['WorkerTool'])] },
      },
    ],
    ...extra,
  } as unknown as SmartServerConfig;
}

/** A rebuilt worker store: a new instance, bound, every item whole, retrievable by its primary AND its companion records, under the names its agent dispatches by. */
async function assertRebuiltAndFilled(
  rag: IRag | undefined,
  before: IRag | undefined,
  expect: { names: readonly string[]; ids: readonly string[]; primaryQuery: string },
  who: string,
): Promise<void> {
  assert.ok(rag, `${who}: rebuilt`);
  assert.notEqual(rag, before, `${who}: a new store, not the drained one`);
  const b = toolsBindingOf(rag);
  assert.ok(b, `${who}: bound`);
  for (const itemId of expect.ids) {
    const got = await b.get({ itemId, owner: { scope: 'global' } });
    assert.ok(got.ok && got.value, `${who}: ${itemId}`);
  }
  for (const [q, via] of [
    [expect.primaryQuery, 'primary'],
    ['walrus', 'companion'],
  ] as const) {
    const hits = await rag.query(new TextOnlyEmbedding(q), 10);
    assert.ok(hits.ok);
    assert.deepEqual(
      [...new Set(hits.value.map((h) => toolNameFromRecord(h.metadata)))].sort(),
      [...expect.names].sort(),
      `${who}: every name retrievable by its ${via} records`,
    );
  }
}

/** The next two sessions after a drain: the first constructs the workers (and fills), the second re-wires them (never fills, D41). */
async function rebuildAndCheck(s: WorkerInternals, before: Record<'shared' | 'di', IRag | undefined>, calls: string[][]): Promise<void> {
  for (let i = 0; i < 2; i++) await s._workers.build(s._embeddedSessionParts(undefined, new SimpleRagRegistry()));
  await assertRebuiltAndFilled(
    s._workers.cache.get('shared')?.toolsRag,
    before.shared,
    { names: SHARED_CATALOG, ids: SHARED_IDS, primaryQuery: 'Tool Search Lookup Fetch' },
    'shared',
  );
  await assertRebuiltAndFilled(
    s._workers.cache.get('di')?.toolsRag,
    before.di,
    { names: ['WorkerTool'], ids: ['tool:WorkerTool'], primaryQuery: 'Tool WorkerTool' },
    'di',
  );
  assert.equal(calls.length, 2, 'each rebuilt store filled exactly once; the main store not again');
}

function putConfig(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/config',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

test('(9) PUT /v1/config: the next session rebuilds the drained workers and fills their new stores — shared and DI clients', async (t) => {
  const calls: string[][] = [];
  await withServer(
    rebuildConfig(emptyIntentsFile(t), calls),
    { ...constructionSeams, connectMcpWithDescriptors: labelledSeam },
    async ({ port, server }) => {
      const s = server as unknown as WorkerInternals;
      const before = { shared: s._workers.cache.get('shared')?.toolsRag, di: s._workers.cache.get('di')?.toolsRag };
      assert.ok(before.shared && before.di, 'precondition: both workers built (and filled) at startup');
      assert.equal(calls.length, 3, 'precondition: main + two workers filled at startup');
      calls.length = 0;
      assert.equal(await putConfig(port, { agent: { maxIterations: 25 } }), 200);
      assert.equal(s._workers.cache.size, 0, 'precondition: the PUT drained the worker cache');
      await rebuildAndCheck(s, before, calls);
    },
  );
});

test('(10) hot reload: the server reload entry point drains the workers; the next session rebuilds and fills them', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-reload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'smart-server.yaml');
  writeFileSync(configFile, 'agent:\n  maxIterations: 10\n');
  const calls: string[][] = [];
  await withServer(
    rebuildConfig(emptyIntentsFile(t), calls, { configFile }),
    { ...constructionSeams, connectMcpWithDescriptors: labelledSeam },
    async ({ server }) => {
      const s = server as unknown as WorkerInternals;
      const before = { shared: s._workers.cache.get('shared')?.toolsRag, di: s._workers.cache.get('di')?.toolsRag };
      assert.ok(before.shared && before.di, 'precondition: both workers built at startup');
      assert.ok(s._configReload, 'precondition: a configFile gives the server its reload watcher');
      calls.length = 0;
      // The reload entry point itself — what the file watcher's `reload` event
      // calls (pinned by config-reload-entry.test.ts). Awaited: no fs.watch, no
      // debounce, no polling (D39).
      await s._configReload._onReload({ maxIterations: 25 });
      assert.equal(s._workers.cache.size, 0, 'the reload drained the worker cache');
      await rebuildAndCheck(s, before, calls);
    },
  );
});

/** A client whose `listTools()` fails while `down.list` is set. */
function toggledClient(names: readonly string[], down: { list: boolean }): IMcpClient {
  const up = client(names);
  return {
    async listTools() {
      if (down.list) return { ok: false as const, error: { message: 'listTools failed' } };
      return up.listTools();
    },
    callTool: up.callTool,
  } as unknown as IMcpClient;
}

/** No main MCP; one worker `di` with its own store and its own client. */
function diWorkerConfig(variant: ToolsVariantFactory, workerClient: IMcpClient): SmartServerConfig {
  return {
    port: 0,
    llm: { model: 'test-model' },
    skipModelValidation: true,
    mode: 'smart',
    rag: { store: { type: 'in-memory' }, profiles: { tools: { variant: 'v' } } },
    toolsVariantFactories: { v: variant },
    subAgentConfigs: [
      {
        name: 'di',
        config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } }, mcpClients: [workerClient] },
      },
    ],
  } as unknown as SmartServerConfig;
}

const workerFills = (calls: string[][]) => calls.filter((c) => c.includes('WorkerTool')).length;

async function workerHas(s: WorkerInternals, name: string): Promise<boolean> {
  const rag = s._workers.cache.get('di')?.toolsRag;
  const b = rag ? toolsBindingOf(rag) : undefined;
  assert.ok(b, "the worker's store is bound");
  const got = await b.get({ itemId: `tool:${name}`, owner: { scope: 'global' } });
  assert.ok(got.ok);
  return got.value !== null;
}

const rewire = (s: WorkerInternals) =>
  s._workers.build(s._embeddedSessionParts(undefined, new SimpleRagRegistry()));

test('(11) D41: an incomplete fill stays — after the client recovers, re-wires never fill the store', async () => {
  const calls: string[][] = [];
  const down = { list: true };
  await withServer(
    diWorkerConfig(countingVariant(calls), toggledClient(['WorkerTool'], down)),
    constructionSeams,
    async ({ server }) => {
      const s = server as unknown as WorkerInternals;
      assert.equal(workerFills(calls), 0, 'startup: nothing listed, nothing indexed');
      assert.equal(await workerHas(s, 'WorkerTool'), false);
      down.list = false;
      await rewire(s);
      await rewire(s);
      assert.equal(workerFills(calls), 0, 'a re-wire never fills: no memo, no retry');
      assert.equal(await workerHas(s, 'WorkerTool'), false, 'the store stays as it was created');
    },
  );
});

/** `faceted`, its `index` rejecting while `down.throw` is set. */
function throwingIndexVariant(down: { throw: boolean }): ToolsVariantFactory {
  return () => {
    const inner = mcpToolsVariants.faceted();
    return {
      name: inner.name,
      bind(target) {
        const b = inner.bind(target);
        return {
          key: b.key,
          profileName: b.profileName,
          rag: b.rag,
          retrieval: b.retrieval,
          index: async (items, o) => {
            if (down.throw) throw new Error('index down');
            return b.index(items, o);
          },
          remove: (refs, o) => b.remove(refs, o),
          get: (ref, o) => b.get(ref, o),
        };
      },
    };
  };
}

test('(12) D41: a construction whose fill throws leaves no cached worker — the next session constructs it again', async () => {
  const down = { throw: false };
  await withServer(
    diWorkerConfig(throwingIndexVariant(down), client(['WorkerTool'])),
    constructionSeams,
    async ({ server }) => {
      const s = server as unknown as WorkerInternals;
      assert.equal(await workerHas(s, 'WorkerTool'), true, 'precondition: filled at startup');
      await s._workers.drain();
      down.throw = true;
      await assert.rejects(rewire(s), /index down/);
      assert.equal(s._workers.cache.has('di'), false, 'no cached worker with an unfilled store');
      down.throw = false;
      await rewire(s);
      assert.equal(await workerHas(s, 'WorkerTool'), true, 'constructed again, and filled');
    },
  );
});
```

- [ ] **Step 6: Run to see them fail**

Run: `npx tsc -b packages/llm-agent-libs && node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profile-fill-ready-clients.test.ts`
Expected: FAIL — (1), (2), (3), (5), (6) find the store empty (`calls` is `[]`, no `toolCatalog`); (7), (8) find the worker's store empty; (9) fails its startup precondition (`calls.length` is 0), and the rebuilt stores are empty too; (10) finds no `_configReload`; (12) fails its precondition (no startup fill); (4) passes already (it pins 30.1.0), and so does (11) (nothing fills a worker yet — it pins that a re-wire never will). In `mcp-yaml-vectorization.test.ts` the D38 test finds the worker's store empty after `start()`. `config-reload-entry.test.ts` passes already: it pins the existing link from the watcher's event to `_onReload`.

- [ ] **Step 7: Implement (server)**

In `smart-server.ts`:
- imports (cumulative after Task 23):
  - the `@mcp-abap-adt/llm-agent` **type** import (L11–48): add `ToolCatalogStatus` (`McpClientDescriptor` is already there).
  - the `@mcp-abap-adt/llm-agent-libs` **value** import (L74–91, which Task 23 extended with `bindToolsProfile`): add `fillToolsBinding`, `toolsBindingOf`.
  - `isToolCatalogReporter` (Task 23) stays: it moves into `mainToolCatalogStatus` below, so it is still used.
- field, after Task 23's `_toolsProfiles`:
  ```ts
  /** The main tools store's catalog when the server filled it (spec §6.3); undefined → the startup agent's, as in 30.1.0. */
  private _serverToolCatalog?: ToolCatalogStatus;
  ```
- methods, after Task 23's `withToolsStore`:
  ```ts
  /**
   * Fill a server-bound tools store ONCE, at its creation (spec §6.3, D31,
   * D41), through `fillToolsBinding` — which runs the store's fill source
   * (§3.10, D42). The binding and its source are the store's own (D34). An
   * unbound store → nothing (30.1.0). No memo and no retry: callers call this
   * only where the store is created, and an incomplete fill stays reported.
   */
  private fillBoundToolsStore(
    store: IRag | undefined,
    clients: readonly IMcpClient[],
    slots: {
      descriptors?: readonly McpClientDescriptor[];
      configuredSlotCount?: number;
    } = {},
  ): Promise<ToolCatalogStatus | undefined> {
    const binding = store ? toolsBindingOf(store) : undefined;
    if (!binding) return Promise.resolve(undefined);
    return fillToolsBinding(clients, binding, {
      logger: this._fileLogger,
      toolNamespace: this._toolNamespace,
      descriptors: slots.descriptors,
      configuredSlotCount: slots.configuredSlotCount,
    });
  }

  /**
   * yamlBuilderConnect only (spec §6.3, D38): the shared clients are harvested
   * after the workers' startup build, so every worker with its own bound store,
   * no own clients and no own `mcp:` is filled here — once, at startup, right
   * after the harvest — from the clients and descriptors a re-wire hands it
   * (D32). This completes those workers' creation; it is not a refill (D41).
   */
  private async fillSharedClientWorkerStores(): Promise<void> {
    for (const sub of this.cfg.subAgentConfigs ?? []) {
      const set = this._workers.cache.get(sub.name);
      if (!set?.toolsRag || sub.config.mcp) continue;
      if (set.mcpClients && set.mcpClients.length > 0) continue;
      await this.fillBoundToolsStore(set.toolsRag, this._sharedMcpClients ?? [], {
        descriptors: this._sharedMcpClientDescriptors,
        configuredSlotCount: this._configuredSlotCount,
      });
    }
  }

  /** The catalog /health and the D23 check read: the server's own fill, else the startup agent's (30.1.0). */
  private mainToolCatalogStatus(agent: SmartAgent): ToolCatalogStatus | undefined {
    return (
      this._serverToolCatalog ??
      (isToolCatalogReporter(agent) ? agent.getToolCatalogStatus() : undefined)
    );
  }
  ```
- `buildSubAgent` — the worker's agent dispatches by the identity its store was filled with (D32), and the worker's own bound store is filled here (D35):
  - its `injected` parameter type gains, after `mcpClients: IMcpClient[];`:
    ```ts
      /** The descriptors of `mcpClients` when any were reported (D32); absent → array order. */
      mcpClientDescriptors?: readonly McpClientDescriptor[];
      /** The configured slot count those descriptors index into (record ids, D32). */
      configuredSlotCount?: number;
    ```
  - right after `subBuilder = subBuilder.withHelperLlm(helperLlm);`:
    ```ts
    // One naming rule for every catalog (D32): the startup builder and the
    // authoritative snapshot use this namespace, so the worker's does too.
    subBuilder = subBuilder.withToolNamespace(this._toolNamespace);
    ```
  - replace the MCP-clients priority block
    ```ts
    if (cached.mcpClients && cached.mcpClients.length > 0) {
      subBuilder = subBuilder.withMcpClients(cached.mcpClients);
    } else if (injected?.mcpClients && injected.mcpClients.length > 0) {
      subBuilder = subBuilder.withMcpClients(injected.mcpClients);
    }
    ```
    with (same priority; the descriptors travel with the clients they describe):
    ```ts
    const workerMcp =
      cached.mcpClients && cached.mcpClients.length > 0
        ? {
            clients: cached.mcpClients,
            descriptors: cached.mcpClientDescriptors,
            configuredSlotCount: undefined,
          }
        : injected?.mcpClients && injected.mcpClients.length > 0
          ? {
              clients: injected.mcpClients,
              descriptors: injected.mcpClientDescriptors,
              configuredSlotCount: injected.configuredSlotCount,
            }
          : undefined;
    const workerDescriptors = workerMcp?.descriptors;
    if (workerMcp && workerDescriptors) {
      // withMcpClients carries no descriptors; withMcpServers does (to the
      // pipeline's mcpClientDescriptors) and, like it, skips vectorization.
      // A length mismatch leaves a server without a descriptor, and the
      // builder's all-or-none check fails loud.
      subBuilder = subBuilder.withMcpServers(
        workerMcp.clients.map((c, i) => connectedMcpServer(c, workerDescriptors[i])),
      );
    } else if (workerMcp) {
      subBuilder = subBuilder.withMcpClients(workerMcp.clients);
    }
    ```
  - immediately before `const handle = await subBuilder.build();` (after the `withRetrievalStrategy` loop), the fill — on the construction only (D35, D41):
    ```ts
    // ---- The construction that creates a bound store fills it, once (spec §6.3 rule 2, D35, D41) ----
    // `!injected` is the worker's construction: resolveWorkerLlmSet created
    // its OWN store (cached.toolsRag, bound by withToolsStore) in this very
    // call — the startup primary build, or the lazy rebuild after a drain
    // (PUT /v1/config, hot reload). A per-session re-wire (`injected`) gets the
    // cached store by reference and never fills: no memo, no retry. The fill
    // runs the store's fill source (D42) from the clients every re-wire will
    // hand this worker, so its records carry the names its agent dispatches
    // by (D32). A store read by reference (no cached.toolsRag: the main one)
    // is never filled here.
    if (!injected && cached.toolsRag) {
      const fillFrom =
        workerMcp ??
        // Nothing of its own is handed over: a worker on its own `mcp:` is
        // filled by its own builder on this build (§6.1). Otherwise the shared
        // clients with their descriptors, once known — on yamlBuilderConnect
        // they are harvested after the startup build and _buildInfra fills
        // this store right after the harvest (D38).
        (!subCfg.mcp && this._sharedMcpClients !== undefined
          ? {
              clients: this._sharedMcpClients,
              descriptors: this._sharedMcpClientDescriptors,
              configuredSlotCount: this._configuredSlotCount,
            }
          : undefined);
      if (fillFrom) {
        try {
          await this.fillBoundToolsStore(cached.toolsRag, fillFrom.clients, {
            descriptors: fillFrom.descriptors,
            configuredSlotCount: fillFrom.configuredSlotCount,
          });
        } catch (err) {
          // resolveWorkerLlmSet cached the set before this build: drop it, so no
          // session re-wires a worker whose store was never filled (spec §6.3).
          this._workers.cache.delete(name);
          throw err;
        }
      }
    }
    ```
  - import: `import { connectedMcpServer } from './workers/connected-mcp-server.js';` beside the `./workers/worker-registry.js` import (`McpClientDescriptor` is already in the type import).
- `packages/llm-agent-server-libs/src/smart-agent/workers/connected-mcp-server.ts` (new):
  ```ts
  import type { IMcpClient, IMcpServer, McpClientDescriptor } from '@mcp-abap-adt/llm-agent';

  /**
   * An already-connected client as an `IMcpServer` (spec §6.3, D32): `start()`
   * hands it over, `stop()` leaves it to its owner (the server, or the worker's
   * own connection). A worker's builder gets clients WITH their descriptors
   * through the existing `withMcpServers` — `withMcpClients` carries none — so
   * its catalog names tools as the store it searches does. No builder change.
   */
  export function connectedMcpServer(
    client: IMcpClient,
    descriptor: McpClientDescriptor,
  ): IMcpServer {
    return { descriptor, start: async () => client, stop: async () => {} };
  }
  ```
- `workers/worker-registry.ts` (D32):
  - type import from `@mcp-abap-adt/llm-agent`: add `McpClientDescriptor`;
  - `WorkerLlmSet`, after `mcpClients?`:
    ```ts
      /** The descriptors the worker's OWN connection (`subCfg.mcp`) reported for
       *  `mcpClients`, backfilled with them; absent for DI clients (none exist). */
      mcpClientDescriptors?: readonly McpClientDescriptor[];
    ```
  - `backfillWorkerCacheFromHandle`: its `handle` type gains `mcpClientDescriptors?: readonly McpClientDescriptor[];`, and the `mcpClients` backfill becomes
    ```ts
      if (
        (!entry.mcpClients || entry.mcpClients.length === 0) &&
        handle.mcpClients &&
        handle.mcpClients.length > 0
      ) {
        entry.mcpClients = handle.mcpClients;
        // paired with them: the slots and labels of the worker's own connection (D32)
        if (handle.mcpClientDescriptors) {
          entry.mcpClientDescriptors = handle.mcpClientDescriptors;
        }
      }
    ```
    (`SmartAgentHandle.mcpClientDescriptors` is set on the builder's auto-connect branch — the only one that backfills clients.)
  - `BuildSubAgentFn`'s `injected` type gains `mcpClientDescriptors?: readonly McpClientDescriptor[];` and `configuredSlotCount?: number;`
  - in `build(parts)`, after `const injectedToolsRag = …;`:
    ```ts
      // The identity of the clients handed over (D32): the worker's own
      // (descriptors only — its connection's, or none for DI clients), or the
      // session's (`SessionAgentParts`: the shared set's slots, labels and
      // configured slot count — what the worker's store is filled with).
      const ownClients = !!cached.mcpClients && cached.mcpClients.length > 0;
      const injectedDescriptors = ownClients
        ? cached.mcpClientDescriptors
        : parts.mcpClientDescriptors;
      const injectedSlotCount = ownClients ? undefined : parts.configuredSlotCount;
    ```
    and in the `injected` object, after `mcpClients: injectedMcpClients,`:
    ```ts
          ...(injectedDescriptors ? { mcpClientDescriptors: injectedDescriptors } : {}),
          ...(injectedSlotCount !== undefined ? { configuredSlotCount: injectedSlotCount } : {}),
    ```
  - the lazy build-on-miss in `WorkerRegistry.build` (`if (!this.cache.has(sub.name)) await this.deps.buildSubAgent(…)` with no `injected`) is unchanged: it is the worker's construction, and `buildSubAgent` fills the new store there (D35, D41) — that is what makes `PUT /v1/config` and hot reload fill the rebuilt workers' stores. (Two sessions missing together may construct a worker twice, each filling its own store — the 30.1.0 race moved to a separate issue, spec §15, D45.)
- in `_buildInfra`, immediately after the harvest block
  ```ts
    if (yamlBuilderConnect) {
      this._sharedMcpClients = globalMcpClients ?? [];
      await this.buildToolsRagHandle({ toolsRag, resolvedEmbedder });
    }
  ```
  insert:
  ```ts
    // ---- The main tools store, filled once where it was created (spec §6.3, D41) ----
    // The builder fills it only on its own connect (yamlBuilderConnect: its
    // build() ran the store's fill source); every other path handed it the
    // clients through withMcpClients, which does not vectorize. Fill ONCE here
    // — clients resolved, before the small-set check, /health and listen. No
    // binding → nothing runs (30.1.0). Workers' own stores are filled by their
    // construction (D35), so a rebuild after a drain is filled too — except, on
    // yamlBuilderConnect, the workers on the shared clients: those clients are
    // known only now, so their creation completes here, at startup (D38).
    if (yamlBuilderConnect) {
      await this.fillSharedClientWorkerStores();
    } else {
      this._serverToolCatalog = await this.fillBoundToolsStore(
        toolsRag,
        this._sharedMcpClients ?? [],
        {
          descriptors: this._sharedMcpClientDescriptors,
          configuredSlotCount: this._configuredSlotCount,
        },
      );
    }
  ```
- Task 23's D23 check reads the same status as `/health`; replace
  ```ts
      isToolCatalogReporter(smartAgent) ? smartAgent.getToolCatalogStatus() : undefined,
  ```
  with
  ```ts
      this.mainToolCatalogStatus(smartAgent),
  ```
- in `new HealthChecker({`, after `agent: smartAgent,`:
  ```ts
      // The server's own fill when it filled the main store (spec §6.3), else
      // the startup agent's status — as in 30.1.0.
      toolCatalog: {
        getToolCatalogStatus: () => this.mainToolCatalogStatus(smartAgent),
      },
  ```
- the reload entry point the hot-reload test drives (D39):
  - field, beside `_serverToolCatalog`: `private _configReload?: ConfigReloadWatcher;`
  - in the `if (this.cfg.configFile) {` block: after `reloadWatcher.start();` add `this._configReload = reloadWatcher;` and replace `closeFns.push(() => reloadWatcher.stop());` with `closeFns.push(() => this._configReload?.stop());` (the field is read, so `noUnusedLocals` accepts it).
- `config-reload-watcher.ts` (D39) — `_onReload` returns what it starts, so a caller can await it; the watcher still fires and forgets:
  - in `start()`: `this.watcher.on('reload', (update: HotReloadableConfig) => this._onReload(update));` → `this.watcher.on('reload', (update: HotReloadableConfig) => { void this._onReload(update); });`
  - `private _onReload(update: HotReloadableConfig): void {` → `private _onReload(update: HotReloadableConfig): Promise<void> {`, with the doc line "The reload entry point (spec §14.1, D39). Resolves when the worker drain and the session invalidation have settled; their failures are logged, never thrown."
  - the two fire-and-forget calls become named promises, returned at the end (after the weight updates, which stay synchronous):
    ```ts
      const drained = this.deps.drainWorkers().catch((err: unknown) => {
        this.deps.log({ event: 'config_reload_drain_error', error: String(err) });
      });
      const invalidated = this.deps.invalidateSessions().catch((err: unknown) => {
        this.deps.log({ event: 'config_reload_invalidate_error', error: String(err) });
      });
      // … the RAG weight updates, unchanged …
      return Promise.all([drained, invalidated]).then(() => undefined);
    ```
- `__tests__/config-reload-entry.test.ts` (new, D39 — the one link the server test skips):
  ```ts
  /**
   * Spec §14.1 (D39): the file watcher's `reload` event calls the reload entry
   * point (`_onReload`). The server's hot-reload test drives that entry point
   * directly; this pins the link it skips. No file change, no debounce: the
   * event is emitted on the watcher's own emitter.
   */
  import assert from 'node:assert/strict';
  import type { EventEmitter } from 'node:events';
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { test } from 'node:test';
  import { ConfigReloadWatcher } from '../config-reload-watcher.js';

  test("the watcher's reload event reaches _onReload: agent update, worker drain, session invalidation", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'reload-entry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const configFile = join(dir, 'smart-server.yaml');
    writeFileSync(configFile, 'agent:\n  maxIterations: 10\n');
    const seen: string[] = [];
    const watcher = new ConfigReloadWatcher({
      configFile,
      log: () => {},
      applyAgentUpdate: () => {
        seen.push('agent');
      },
      mirrorCfg: () => {},
      drainWorkers: async () => {
        seen.push('drain');
      },
      invalidateSessions: async () => {
        seen.push('invalidate');
      },
      ragStores: {},
    });
    // White-box: the inner ConfigWatcher (an EventEmitter) and the entry point.
    const inner = watcher as unknown as {
      watcher: EventEmitter;
      _onReload: (u: unknown) => Promise<void>;
    };
    const reached: unknown[] = [];
    const entry = inner._onReload.bind(watcher);
    inner._onReload = (u) => {
      reached.push(u);
      return entry(u);
    };
    watcher.start();
    t.after(() => watcher.stop());
    inner.watcher.emit('reload', { maxIterations: 25 });
    assert.deepEqual(reached, [{ maxIterations: 25 }], 'the event reached the entry point');
    assert.deepEqual(seen, ['agent', 'drain', 'invalidate']);
  });
  ```
- `mcp-yaml-vectorization.test.ts` — append (D38; `toolsBindingOf` and `IRag` are already imported there by Task 23):
  ```ts
  test('D38: yamlBuilderConnect — a worker with its own store on the shared clients is filled at startup, before any session', async (t) => {
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
        subAgentConfigs: [
          { name: 'shared', config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } } } },
        ],
      },
      constructionSeams,
    );
    let handle: Awaited<ReturnType<SmartServer['start']>> | undefined;
    try {
      handle = await server.start();
      const workerRag = (server as unknown as { _workers: { cache: Map<string, { toolsRag?: IRag }> } })._workers.cache.get(
        'shared',
      )?.toolsRag;
      assert.ok(workerRag, "the worker's own store");
      const b = toolsBindingOf(workerRag);
      assert.ok(b, 'bound');
      for (const name of ['EchoTool', 'GetTable']) {
        const got = await b.get({ itemId: `tool:${name}`, owner: { scope: 'global' } });
        assert.ok(got.ok && got.value, `${name}: filled right after the harvest — no session has run`);
      }
      assert.equal(stub.initializeCount(), 1, 'one connection: the fill used the harvested clients');
    } finally {
      if (handle) await handle.close();
      await stub.close();
    }
  });
  ```

Failure policy (spec §6.3) needs no extra code: `vectorizeMcpTools` counts a failing or throwing `listTools()` in `clientFailures`, sets `complete: false` and logs the summary through `this._fileLogger`; `HealthChecker` turns `complete: false` into `degraded` (main store); startup goes on. A thrown error (an `IToolRecordKey` id without `tool:`, mismatched descriptors, a binding its store does not carry) propagates: out of `_buildInfra` (main store, or a worker's startup build) and fails startup, as on the builder's path; out of `WorkerRegistry.build` on a lazy rebuild, failing that session's worker build like any worker build error — `buildSubAgent` drops the worker's cache entry first, so the next session constructs it again (and a configuration error stays loud). An incomplete fill is not retried (D41): it stays reported until a reconnect's `toolsChanged` re-indexes or a new instance is created. `/health` reports the main catalog only (spec §6.3); a worker's fill is the logged summary line.

- [ ] **Step 8: Run (gate: build + the new and neighbouring tests)**

Run:
```bash
npx tsc -b packages/llm-agent-libs packages/llm-agent-server-libs
npm run typecheck
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profile-fill-ready-clients.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/server-namespace-snapshot.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/retrieval-wiring.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/config-reload-entry.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/config-reload-weights.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/worker-llm-cache.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-libs
npm test --workspace @mcp-abap-adt/llm-agent-server-libs
```
Expected: PASS. `tsc -b` with `strict` + `noUnusedLocals` proves the cumulative imports and members: every added name is used (`ToolCatalogStatus` by the field and methods, `fillToolsBinding`/`toolsBindingOf` by `fillBoundToolsStore`, `fillBoundToolsStore` by `_buildInfra`, `buildSubAgent` and `fillSharedClientWorkerStores`, `fillSharedClientWorkerStores` by `_buildInfra`, `_configReload` read by the close function, `isToolCatalogReporter` by `mainToolCatalogStatus`, `connectedMcpServer` by `buildSubAgent`, `McpClientDescriptor` in `worker-registry.ts` by `WorkerLlmSet`, the handle type and `BuildSubAgentFn`); nothing named `fillWorkerToolsStores`, `_filledToolsBindings`, `_toolsFills` or `markToolsFilledByBuilder` exists (no memo, no refill — D41). The existing worker and reload tests (`retrieval-wiring.test.ts`, `worker-llm-keys.test.ts`, `worker-llm-cache.test.ts`, `smart-server-config-reload.test.ts`, `config-reload-weights.test.ts` — it calls `_onReload` and ignores the returned promise; the weights are still applied synchronously) pass unchanged: without a profile no store carries a binding, so the fill block does nothing; without descriptors a worker still gets `withMcpClients`, and the default namespace is what `withToolNamespace` threads when none is injected.

- [ ] **Step 9: Commit**

```bash
npx biome check --write packages/llm-agent-libs/src packages/llm-agent-server-libs/src
git add packages/llm-agent-libs/src packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): fill a bound tools store once at its creation — main at startup, workers by their construction; workers keep catalog identity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 23B: YAML `rag.profiles.tools.fill` → the store's fill source (server-libs)

Spec §6.2 (`fill`, its validation and resolution; `toolsFillFactories`), §3.10 (the four sources; D42, D44), §6.5 (the recommended mapping), §14.1 (server `fill`). After Task 23A every server-bound store carries the default `live` source; this task lets the YAML (or a config built in code) choose another one, server-wide: the main store and every worker store the server builds are bound with it (`withToolsStore`).

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/profiles-config.ts` (`SmartServerFillConfig`; `SmartServerProfileConfig.fill?`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/profiles-config-validator.ts` (`'fill'` in `PROFILE_FIELDS`; `checkFill`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-collection-profiles.ts` (`ResolvedToolsProfile.fill?`; `ResolveCollectionProfilesInput.fillFactories?`; `resolveFill`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`SmartServerConfig.toolsFillFactories?`; the resolver call; `withToolsStore` binds with the source; the worker check beside Task 23's D33 check)
- Modify: `packages/llm-agent-server-libs/src/index.ts` (export `SmartServerFillConfig`)
- Modify (append): `__tests__/profiles-config.test.ts`, `__tests__/resolve-collection-profiles.test.ts`, `__tests__/profile-fill-ready-clients.test.ts`

**Interfaces:**
- Consumes: `LiveToolsFill`, `ConsumerToolsFill` (Task 19); `ToolsCorpusLoader`, `PrebuiltToolsStore`, `parseToolsCorpus`, `buildToolsCorpus`, `deployToolsCorpus` (Task 19A); `bindToolsProfile`'s `source` (Task 19); Task 23's `withToolsStore` and D33 check; Task 23A's test helpers.
- Produces:
  ```ts
  // profiles-config.ts
  export type SmartServerFillConfig =
    | string                                                            // live | consumer | a name in toolsFillFactories
    | { corpus: { file: string; profile: string; embedder: string } }  // ToolsCorpusLoader (in-memory)
    | { prebuilt: { profile: string; embedder: string } };             // PrebuiltToolsStore (persistent)
  // SmartServerProfileConfig gains: fill?: SmartServerFillConfig
  // resolve-collection-profiles.ts
  // ResolvedToolsProfile gains: readonly fill?: IToolsFillSource   (absent → bindToolsProfile's default, live)
  // ResolveCollectionProfilesInput gains: fillFactories?: Readonly<Record<string, () => IToolsFillSource>>
  // smart-server.ts — SmartServerConfig gains: toolsFillFactories?: Readonly<Record<string, () => IToolsFillSource>>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `profiles-config.test.ts`:
```ts
describe('rag.profiles.tools.fill (spec §6.2, §3.10)', () => {
  it('names and the two shapes resolve as written', () => {
    assert.equal(resolve('tools: { variant: faceted, fill: consumer }').rag?.profiles?.tools?.fill, 'consumer');
    assert.deepEqual(
      resolve('tools:\n  variant: faceted\n  fill: { corpus: { file: ./c.json, profile: faceted@1, embedder: bow } }').rag?.profiles?.tools?.fill,
      { corpus: { file: './c.json', profile: 'faceted@1', embedder: 'bow' } },
    );
  });
  it('a corpus without file / profile / embedder, a prebuilt without profile / embedder, another shape → refused', () => {
    refused('tools: { variant: faceted, fill: { corpus: { profile: p, embedder: e } } }', /fill\.corpus\.file: required/);
    refused('tools: { variant: faceted, fill: { corpus: { file: f, embedder: e } } }', /fill\.corpus\.profile: required/);
    refused('tools: { variant: faceted, fill: { prebuilt: { profile: p } } }', /fill\.prebuilt\.embedder: required/);
    refused('tools: { variant: faceted, fill: { other: {} } }', /fill: a name, \{ corpus: … \} or \{ prebuilt: … \}/);
  });
  it('prebuilt over an in-memory tools store → refused (empty at every start)', () => {
    refused('tools: { variant: faceted, fill: { prebuilt: { profile: p, embedder: e } } }', /fill\.prebuilt: .*in-memory/);
  });
});
```

Append to `resolve-collection-profiles.test.ts` (imports: `buildToolsCorpus`, `ConsumerToolsFill`, `mcpToolsVariants`, `PrebuiltToolsStore`, `ToolsCorpusLoader`, `toolItemFromTool` into the `@mcp-abap-adt/llm-agent-libs` import):
```ts
describe('fill → the fill source (spec §6.2)', () => {
  it('absent → none (bindToolsProfile defaults to live); names, corpus, prebuilt, a registered name', async () => {
    const embedder = { embedDocument: async () => ({ vector: [1, 0] }), embedDocuments: async (t: string[]) => t.map(() => ({ vector: [1, 0] })), embedQuery: async () => ({ vector: [1, 0] }) };
    const corpus = await buildToolsCorpus({
      profile: mcpToolsVariants.faceted(),
      embedder,
      identity: { profile: 'faceted@1', embedder: 'e' },
      items: [toolItemFromTool({ name: 'read_file', description: 'Read a file' }, { itemId: 'tool:read_file', originalName: 'read_file' })],
    });
    const run = async (fill: unknown, over: Partial<ResolveCollectionProfilesInput> = {}) =>
      (await resolveCollectionProfiles(input({ profiles: { tools: { variant: 'faceted', fill } } as never, ...over }).i)).get('tools')?.fill;
    assert.equal(await run(undefined), undefined);
    assert.ok((await run('consumer')) instanceof ConsumerToolsFill);
    assert.ok((await run({ corpus: { file: 'c.json', profile: 'faceted@1', embedder: 'e' } }, { readFile: () => JSON.stringify(corpus) })) instanceof ToolsCorpusLoader);
    assert.ok((await run({ prebuilt: { profile: 'faceted@1', embedder: 'e' } })) instanceof PrebuiltToolsStore);
    const own = { name: 'own', fill: async () => undefined, toolsChanged: async () => undefined };
    assert.equal(await run('own', { fillFactories: { own: () => own } }), own);
    await assert.rejects(run('nope'), /rag\.profiles\.tools: unknown fill source "nope"/);
    await assert.rejects(run({ corpus: { file: 'c.json', profile: 'p', embedder: 'e' } }, { readFile: () => '{"manifest":{"format":2}}' }), /format/);
  });
});
```

Append to `profile-fill-ready-clients.test.ts` (imports: `deployToolsCorpus`, `buildToolsCorpus` into the `@mcp-abap-adt/llm-agent-libs` import; `VectorRag`, `type IRetrievalEmbedder` into the `@mcp-abap-adt/llm-agent` import):
```ts
// ---- D42: the fill source from config — corpus (in-memory) and prebuilt (persistent) ----

/** A 2-dim document embedder that counts document embeddings. */
function docCounting() {
  const calls = { documents: 0 };
  const v = (t: string) => ({ vector: [t.length % 7, 1] });
  const embedder: IRetrievalEmbedder = {
    embedDocument: async (t) => { calls.documents++; return v(t); },
    embedDocuments: async (ts) => { calls.documents += ts.length; return ts.map(v); },
    embedQuery: async (t) => v(t),
  };
  return { embedder, calls };
}
const ECHO = toolItemFromTool({ name: 'EchoTool', description: 'Tool EchoTool', inputSchema: { type: 'object', properties: {} } }, { itemId: 'tool:EchoTool', originalName: 'EchoTool' });
const FILL_ID = { profile: 'faceted@1', embedder: 'counting' };

test('(14) fill: corpus — the server loads a built corpus into its in-memory store at startup, no embedding call', async (t) => {
  const { embedder, calls } = docCounting();
  const corpus = await buildToolsCorpus({ profile: mcpToolsVariants.faceted(), embedder, identity: FILL_ID, items: [ECHO] });
  calls.documents = 0;
  const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'tools-corpus.json');
  writeFileSync(file, JSON.stringify(corpus));
  await withServer(
    {
      ...cfg({ mcpClients: [client(['EchoTool'])] }),
      rag: { store: { type: 'in-memory' }, profiles: { tools: { variant: 'faceted', fill: { corpus: { file, ...FILL_ID } } } } },
    } as unknown as SmartServerConfig,
    { ...constructionSeams, makeRag: async () => new VectorRag(embedder) },
    async ({ port, toolsRag }) => {
      const b = toolsRag ? toolsBindingOf(toolsRag) : undefined;
      assert.ok(b);
      const got = await b.get({ itemId: 'tool:EchoTool', owner: { scope: 'global' } });
      assert.ok(got.ok && got.value, 'loaded from the corpus');
      assert.equal(calls.documents, 0, 'no embedding call at startup');
      assert.equal((await getHealth(port)).components.toolCatalog?.complete, true);
    },
  );
});

test('(15) fill: prebuilt — a deployed store is checked at startup and never written', async () => {
  const { embedder } = docCounting();
  const corpus = await buildToolsCorpus({ profile: mcpToolsVariants.faceted(), embedder, identity: FILL_ID, items: [ECHO] });
  const writes: string[] = [];
  const makeRag = async () => {
    const inner = new VectorRag(embedder);
    await deployToolsCorpus(corpus, { key: 'tools', rag: inner }); // the deploy step, before the process starts
    const w = inner.writer();
    const rag: IRag = {
      query: (e, k, o) => inner.query(e, k, o),
      healthCheck: (o) => inner.healthCheck(o),
      getById: (id, o) => inner.getById(id, o),
      writer: () => ({
        upsertRaw: (id, ...rest) => { writes.push(id); return w.upsertRaw(id, ...rest); },
        deleteByIdRaw: (id, o) => { writes.push(id); return w.deleteByIdRaw(id, o); },
      }),
    };
    return rag;
  };
  await withServer(
    {
      ...cfg({ mcpClients: [client(['EchoTool'])] }),
      rag: { store: { type: 'in-memory' }, profiles: { tools: { variant: 'faceted', fill: { prebuilt: FILL_ID } } } },
    } as unknown as SmartServerConfig,
    { ...constructionSeams, makeRag },
    async ({ port }) => {
      assert.equal((await getHealth(port)).components.toolCatalog?.complete, true, 'status from the service record');
      assert.deepEqual(writes, [], 'the process never writes a prebuilt store');
    },
  );
});

test('(16) fill: corpus / prebuilt with a worker that has its own rag AND its own clients → refused at start', async () => {
  const server = new SmartServer(
    {
      ...cfg({}),
      rag: { store: { type: 'in-memory' }, profiles: { tools: { variant: 'faceted', fill: { prebuilt: FILL_ID } } } },
      subAgentConfigs: [{ name: 'own', config: { skipModelValidation: true, rag: { store: { type: 'in-memory' } }, mcpClients: [client(['WorkerTool'])] } }],
    } as unknown as SmartServerConfig,
    constructionSeams,
  );
  await assert.rejects(server.start(), /fill: prebuilt .* worker 'own' has its own tools store and its own MCP clients/);
});
```
(`VectorRag.writer()` is always present, so `w` needs no guard; the facade's writer has no precomputed methods, so a write attempt would also fail loudly.)

- [ ] **Step 2: Run to see them fail**

Run: `npx tsc -b packages/llm-agent-libs && node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/profile-fill-ready-clients.test.ts`
Expected: FAIL — `fill` is an unknown profile field; `ResolvedToolsProfile` has no `fill`; (14) indexes live (document calls > 0); (15) writes; (16) starts.

- [ ] **Step 3: Implement**

`profiles-config.ts`: add `SmartServerFillConfig` (above) and `fill?: SmartServerFillConfig;` to `SmartServerProfileConfig`.

`profiles-config-validator.ts`: `const PROFILE_FIELDS = ['variant', 'compose', 'intents', 'decomposer', 'smallSet', 'fill'];` and, called from `checkProfiles` for each profile entry `e` with `label = rag.profiles.<key>` (beside the `intents` check):
```ts
function checkFill(label: string, v: unknown, storeType: unknown, issues: string[]): void {
  if (v == null) return;
  if (typeof v === 'string') {
    if (!name(v)) issues.push(`${label}.fill: must be a non-empty name`);
    return; // live | consumer | a registered name — unknown names fail at resolution
  }
  const keys = isMap(v) ? Object.keys(v) : [];
  if (!isMap(v) || keys.length !== 1 || (keys[0] !== 'corpus' && keys[0] !== 'prebuilt')) {
    issues.push(`${label}.fill: a name, { corpus: … } or { prebuilt: … }`);
    return;
  }
  const o = isMap(v[keys[0]]) ? (v[keys[0]] as Obj) : {};
  const fields = keys[0] === 'corpus' ? ['file', 'profile', 'embedder'] : ['profile', 'embedder'];
  for (const f of fields) if (!name(o[f])) issues.push(`${label}.fill.${keys[0]}.${f}: required — a non-empty string`);
  if (keys[0] === 'prebuilt' && storeType === 'in-memory') {
    issues.push(`${label}.fill.prebuilt: an in-memory tools store is empty at every start — use fill: { corpus: … }`);
  }
}
```
(`storeType` = `isMap(rag.store) ? rag.store.type : undefined` — `checkProfiles` already receives `rag`.)

`resolve-collection-profiles.ts`:
- imports: `ConsumerToolsFill`, `LiveToolsFill`, `parseToolsCorpus`, `PrebuiltToolsStore`, `ToolsCorpusLoader` into the `@mcp-abap-adt/llm-agent-libs` value import; `IToolsFillSource` into the `@mcp-abap-adt/llm-agent` type import; `SmartServerFillConfig` into the `./profiles-config.js` type import.
- `ResolvedToolsProfile` gains `readonly fill?: IToolsFillSource;` (doc: "where the store's records come from, spec §3.10; absent → live"); `ResolveCollectionProfilesInput` gains `fillFactories?: Readonly<Record<string, () => IToolsFillSource>>;`.
- add:
  ```ts
  /** `fill` → ONE fill source instance, server-wide (spec §6.2, §3.10). Absent → undefined (live). */
  function resolveFill(
    fill: SmartServerFillConfig | undefined,
    readFile: (path: string) => string,
    factories: Readonly<Record<string, () => IToolsFillSource>> | undefined,
  ): IToolsFillSource | undefined {
    if (fill === undefined) return undefined;
    if (fill === 'live') return new LiveToolsFill();
    if (fill === 'consumer') return new ConsumerToolsFill();
    if (typeof fill === 'string') {
      const make = factories?.[fill];
      if (!make) {
        throw new Error(`unknown fill source "${fill}" — live | consumer | { corpus: … } | { prebuilt: … } | a name in toolsFillFactories`);
      }
      return make();
    }
    if ('corpus' in fill) {
      const { file, profile, embedder } = fill.corpus;
      return new ToolsCorpusLoader({ corpus: parseToolsCorpus(readFile(file)), expect: { profile, embedder } });
    }
    return new PrebuiltToolsStore({ expect: { profile: fill.prebuilt.profile, embedder: fill.prebuilt.embedder } });
  }
  ```
- in the loop, inside the `try` (so a failure is prefixed `rag.profiles.<key>: `), after `const decompose = …;`: `const fill = resolveFill(cfg.fill, readFile, input.fillFactories);`, and each `out.set(key, { … })` gains `...(fill ? { fill } : {}),`.

`smart-server.ts`:
- `SmartServerConfig`, after `toolsStrategyFactories?`:
  ```ts
  /** Named tools fill sources for `rag.profiles.tools.fill` (spec §3.10). */
  toolsFillFactories?: Readonly<Record<string, () => IToolsFillSource>>;
  ```
  (`IToolsFillSource` into the `@mcp-abap-adt/llm-agent` type import.)
- the `resolveCollectionProfiles({ … })` call (Task 23) gains `fillFactories: this.cfg.toolsFillFactories,`.
- in `withToolsStore`, the bind becomes `bindToolsProfile(p.profile, { key: 'tools', rag: store, companions }, p.fill).rag` — the main store and every worker store the server builds get the one configured source.
- after Task 23's D33 check:
  ```ts
    // spec §6.2: a corpus / prebuilt store holds the SHARED catalog. A worker
    // with its own tools store AND its own clients has another catalog — refuse,
    // never load the wrong one. (A config built in code skips the YAML validator.)
    const fillSource = this._toolsProfiles.get('tools')?.fill;
    if (fillSource && (fillSource.name === 'corpus' || fillSource.name === 'prebuilt')) {
      const own = (this.cfg.subAgentConfigs ?? []).find(
        (w) => w.config.rag && ((w.config.mcpClients?.length ?? 0) > 0 || w.config.mcp),
      );
      if (own) {
        throw new Error(
          `rag.profiles.tools.fill: ${fillSource.name} holds the shared tool catalog, but worker '${own.name}' has its own tools store and its own MCP clients — bind that worker's store in your composition root`,
        );
      }
    }
  ```
- `src/index.ts`: export `type SmartServerFillConfig` beside the other profile config types.

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent-server-libs
node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/__tests__/profiles-config.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/resolve-collection-profiles.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/profile-fill-ready-clients.test.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-yaml-vectorization.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-server-libs
```
Expected: PASS. Without `fill` nothing changes: `ResolvedToolsProfile.fill` is absent and `bindToolsProfile` attaches `LiveToolsFill`, as after Task 23A.

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server-libs/src
git add packages/llm-agent-server-libs/src
git commit -m "feat(server-libs): rag.profiles.tools.fill — live, consumer, corpus, prebuilt or a registered fill source

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 24: Composition root — `createMakeRelevanceDecision` with the `sap-aicore` arm (server)

Spec §5.3 (credential injected; the AI Core token exchange reused), §5.2 (batched by default; one `/rerank` call per batch, scores merged by score), §6.2 (`decision.provider: sap-aicore` is a relevance decision, default ref `DECISION` → `DECISION_SERVICE_KEY`), §3.8 (the `makeRelevanceDecision` seam row), §11; D25, D27. The probability seam (`makeProbabilityDecision`, `typesafe`; renamed in Task 20A) keeps its behaviour; the relevance seam is the app's new `createMakeRelevanceDecision`.

**Files:**
- Create: `packages/llm-agent-server/src/composition/make-relevance-decision.ts` (`RelevanceProviderCtors`, `SHIPPED_RELEVANCE_PROVIDERS`, `createMakeRelevanceDecision`)
- Modify: `packages/llm-agent-server/src/composition/make-probability-decision.ts` (an explicit `sap-aicore` case that names the other seam)
- Modify: `packages/llm-agent-server/src/composition/index.ts` (`makeRelevanceDecision: createMakeRelevanceDecision(lookup)` beside `makeProbabilityDecision`)
- Create: `packages/llm-agent-server/src/composition/__tests__/make-relevance-decision.test.ts`

**Interfaces:**
- Consumes: `SapAiCoreRelevanceDecision`, `SapAiCoreRelevanceConfig` (Task 18); `SmartServerDecisionConfig` with `provider: 'sap-aicore'`, `deploymentId`, `resourceGroup` (Task 21); `BuildAgentDeps.makeRelevanceDecision` (Task 22); `Lookup` (`lookup.ts`: `require('bearer')`, `requireApiBaseUrl()`); `DEFAULT_DECISION_REF` and `envCredentialEntries` (`credential-for.ts`: `<REF>_SERVICE_KEY` → `serviceKeyCredential` from `@mcp-abap-adt/sap-aicore-auth` → bearer + `apiBaseUrl` — already a dependency of the server); `RelevanceReranker` (`@mcp-abap-adt/llm-agent-reranker`, for the batching test).
- Produces:
  ```ts
  export interface RelevanceProviderCtors { 'sap-aicore': new (cfg: SapAiCoreRelevanceConfig) => IRelevanceDecision }
  export const SHIPPED_RELEVANCE_PROVIDERS: RelevanceProviderCtors; // 'sap-aicore': SapAiCoreRelevanceDecision
  export function createMakeRelevanceDecision(lookup: Lookup, ctors?: RelevanceProviderCtors): (cfg: SmartServerDecisionConfig) => Promise<IRelevanceDecision>;
  //   'sap-aicore' → lookup(cfg.credentialRef, DEFAULT_DECISION_REF, 'decision sap-aicore')
  //                  .require('bearer') + .requireApiBaseUrl(); deploymentId, model, resourceGroup? by name
  //   a probability provider (typesafe) → error naming makeProbabilityDecision
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/llm-agent-server/src/composition/__tests__/make-relevance-decision.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { type RagResult, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import { SapAiCoreRelevanceDecision } from '@mcp-abap-adt/sap-aicore-decision';
import {
  type CredentialEntry,
  envCredentialEntries,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';
import { createMakeProbabilityDecision } from '../make-probability-decision.js';
import {
  createMakeRelevanceDecision,
  type RelevanceProviderCtors,
  SHIPPED_RELEVANCE_PROVIDERS,
} from '../make-relevance-decision.js';

const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };

function harness(entries: Record<string, CredentialEntry>) {
  const seen: Array<Record<string, unknown>> = [];
  const record = class {
    constructor(cfg: Record<string, unknown>) {
      seen.push(cfg);
    }
    async score() {
      return { ok: true, value: { model: 'f', scores: [] } };
    }
  };
  const ctors = { 'sap-aicore': record } as unknown as RelevanceProviderCtors;
  return { seen, make: createMakeRelevanceDecision(createLookup(memoizeCredentials((r) => entries[r])), ctors) };
}

describe('makeRelevanceDecision — provider sap-aicore (Cohere, spec §5.3, §6.2)', () => {
  it('the shipped relevance providers include SapAiCoreRelevanceDecision', () => {
    assert.equal(SHIPPED_RELEVANCE_PROVIDERS['sap-aicore'], SapAiCoreRelevanceDecision);
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
  it('each seam refuses the other kind, naming the right seam', async () => {
    await assert.rejects(harness({}).make({ provider: 'typesafe' }), /typesafe is a probability decision — built by makeProbabilityDecision/);
    const lookup = createLookup(memoizeCredentials(() => undefined));
    await assert.rejects(
      createMakeProbabilityDecision(lookup)({ provider: 'sap-aicore', deploymentId: 'd', model: 'm' }),
      /sap-aicore is a relevance decision — built by makeRelevanceDecision/,
    );
  });
  it('DECISION_SERVICE_KEY through the shipped env rule builds a SapAiCoreRelevanceDecision (token exchange reused)', async () => {
    const key = JSON.stringify({ clientid: 'c', clientsecret: 's', url: 'https://auth.example', serviceurls: { AI_API_URL: 'https://api.example/' } });
    const lookup = createLookup(memoizeCredentials(envCredentialEntries({ DECISION_SERVICE_KEY: key })));
    const d = await createMakeRelevanceDecision(lookup)({ provider: 'sap-aicore', deploymentId: 'd1', model: 'cohere-rerank' });
    assert.ok(d instanceof SapAiCoreRelevanceDecision);
  });
});

describe('RelevanceReranker over SapAiCoreRelevanceDecision — calls → /rerank (spec §5.2)', () => {
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
    return { calls, decision: new SapAiCoreRelevanceDecision({ deploymentId: 'd', model: 'm', apiBaseUrl: 'https://api', credential: bearer, fetch }) };
  }

  it('by default (48000-token batches), 30 tools fit ONE call', async () => {
    const { calls, decision } = cohere();
    const r = await new RelevanceReranker(decision).rerank('q', docs(30));
    assert.ok(r.ok);
    assert.deepEqual(calls, [30]);
  });
  it('a smaller maxBatchTokens splits into several /rerank calls; the scores merge into one order by score', async () => {
    const { calls, decision } = cohere();
    const r = await new RelevanceReranker(decision, { maxBatchTokens: 40 }).rerank('q', docs(10));
    assert.ok(r.ok);
    assert.ok(calls.length > 1, `expected several calls, got ${calls.length}`);
    assert.equal(calls.reduce((a, b) => a + b, 0), 10);
    assert.deepEqual(r.value.map((x) => x.metadata.id), ['t9', 't8', 't7', 't6', 't5', 't4', 't3', 't2', 't1', 't0']);
  });
  it('a bad /rerank answer is a DecisionError, which RelevanceReranker turns into RERANK_ERROR', async () => {
    const fetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const decision = new SapAiCoreRelevanceDecision({ deploymentId: 'd', model: 'm', apiBaseUrl: 'https://api', credential: bearer, fetch });
    const r = await new RelevanceReranker(decision).rerank('q', docs(2));
    assert.ok(!r.ok && r.error.code === 'RERANK_ERROR');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx tsc -b packages/sap-aicore-decision packages/llm-agent-reranker packages/llm-agent-libs packages/llm-agent-server-libs && node --import tsx/esm --test packages/llm-agent-server/src/composition/__tests__/make-relevance-decision.test.ts`
Expected: FAIL — `Cannot find module '../make-relevance-decision.js'`. (The reranker cases would pass already: they exercise Tasks 4C and 18.)

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-server/src/composition/make-relevance-decision.ts
import type { IRelevanceDecision } from '@mcp-abap-adt/llm-agent';
import {
  DECISION_KINDS,
  type SmartServerDecisionConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import {
  type SapAiCoreRelevanceConfig,
  SapAiCoreRelevanceDecision,
} from '@mcp-abap-adt/sap-aicore-decision';
import { DEFAULT_DECISION_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

/** Injectable so a test records what each constructor receives. */
export interface RelevanceProviderCtors {
  'sap-aicore': new (cfg: SapAiCoreRelevanceConfig) => IRelevanceDecision;
}

export const SHIPPED_RELEVANCE_PROVIDERS: RelevanceProviderCtors = {
  'sap-aicore': SapAiCoreRelevanceDecision,
};

/**
 * `BuildAgentDeps.makeRelevanceDecision` (spec §3.8, §6.2): the relevance
 * providers of the ONE `decision:` section. The provider config is built from
 * NAMED fields — nothing spreads `cfg` — so `credentialRef` cannot ride along.
 */
export function createMakeRelevanceDecision(
  lookup: Lookup,
  ctors: RelevanceProviderCtors = SHIPPED_RELEVANCE_PROVIDERS,
): (cfg: SmartServerDecisionConfig) => Promise<IRelevanceDecision> {
  return async (cfg) => {
    if (DECISION_KINDS[cfg.provider] !== 'relevance') {
      throw new Error(
        `decision provider ${cfg.provider} is a ${DECISION_KINDS[cfg.provider]} decision — built by makeProbabilityDecision, not makeRelevanceDecision`,
      );
    }
    switch (cfg.provider) {
      case 'sap-aicore': {
        // The validator requires both; a SmartServerConfig built in code skips it.
        if (cfg.deploymentId === undefined || cfg.model === undefined) {
          throw new Error('decision sap-aicore needs deploymentId and model');
        }
        // A SAP AI Core service key (<REF>_SERVICE_KEY): bearer + apiBaseUrl,
        // exchanged by sap-aicore-auth's serviceKeyCredential (credential-for.ts).
        const entry = lookup(cfg.credentialRef, DEFAULT_DECISION_REF, 'decision sap-aicore');
        return new ctors['sap-aicore']({
          deploymentId: cfg.deploymentId,
          model: cfg.model,
          credential: entry.require('bearer'),
          apiBaseUrl: entry.requireApiBaseUrl(),
          ...(cfg.resourceGroup !== undefined ? { resourceGroup: cfg.resourceGroup } : {}),
        });
      }
      default:
        throw new Error(`unknown relevance provider '${String(cfg.provider)}'`);
    }
  };
}
```

In `make-probability-decision.ts` (renamed and typed `IProbabilityDecision` in Task 20A), in the `switch`, before `default:`:
```ts
      case 'sap-aicore':
        throw new Error(
          'decision provider sap-aicore is a relevance decision — built by makeRelevanceDecision, not makeProbabilityDecision',
        );
```

In `composition/index.ts`: add `import { createMakeRelevanceDecision } from './make-relevance-decision.js';` beside the `./make-probability-decision.js` import, `makeRelevanceDecision: NonNullable<BuildAgentDeps['makeRelevanceDecision']>;` to the deps type and `makeRelevanceDecision: createMakeRelevanceDecision(lookup),` beside `makeProbabilityDecision: createMakeProbabilityDecision(lookup),`; in `model-resolver.test.ts`, add `'makeRelevanceDecision'` to the seams list (six).

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent-server
node --import tsx/esm --test packages/llm-agent-server/src/composition/__tests__/make-relevance-decision.test.ts packages/llm-agent-server/src/composition/__tests__/make-probability-decision.test.ts packages/llm-agent-server/src/composition/__tests__/model-resolver.test.ts
npm test --workspace @mcp-abap-adt/llm-agent-server
```
Expected: PASS (the existing typesafe tests unchanged).

- [ ] **Step 5: Commit**

```bash
npx biome check --write packages/llm-agent-server/src
git add packages/llm-agent-server/src
git commit -m "feat(server): makeRelevanceDecision builds SapAiCoreRelevanceDecision for decision.provider sap-aicore

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
(Add `retrievalEmbedderOf` to each file's VALUE import from `@mcp-abap-adt/llm-agent` — not the `import type { IEmbedder }` line; these provider packages' `tsconfig.json` include `src/**/*.ts` without excluding tests, so Step 4's `tsc -b` type-checks the tests too. Check each constructor's second argument against the file's existing tests — Qdrant takes only the config.)

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
      makeProbabilityDecision: async () =>
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
and in the fallback loop replace BOTH the `const id = r.metadata.id as string;` line and the `if (id?.startsWith('skill:')) { … }` block below it with
```ts
            const name = skillNameFromRecord(r.metadata);
            if (name !== undefined) ragSkillNames.add(name);
```
(leaving `const id` behind is an unused local — `noUnusedLocals` fails the build). `skillNameFromRecord` joins the existing value import: `import { QueryEmbedding, skillNameFromRecord, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';`.

- [ ] **Step 4: Run**

Run:
```bash
npx tsc -b packages/llm-agent packages/llm-agent-libs packages/llm-agent-server-libs
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

`in-memory-metrics.ts`: add `IRetrievalMetrics` to the existing `import type { … } from '@mcp-abap-adt/llm-agent'` block (after `IMetrics`; one import per module); `export class InMemoryMetrics implements IMetrics, IRetrievalMetrics {`; add `readonly retrievalOutcome = new MemCounter();` after `toolCacheHitCount`; add `retrievalOutcome: this.retrievalOutcome.snapshot(),` to `snapshot()`.

`noop-metrics.ts`: add `import type { IRetrievalMetrics } from '@mcp-abap-adt/llm-agent';` above the existing `import type { ICounter, IHistogram, IMetrics } from './types.js';` (`ICounter` stays imported from `./types.js` — it is the same type, re-exported there); `export class NoopMetrics implements IMetrics, IRetrievalMetrics {`; add `readonly retrievalOutcome: ICounter = noopCounter;`.

- [ ] **Step 4: Implement — `StagedRetrieval` telemetry**

In `staged-retrieval.ts`, add `type ISpan` to the `@mcp-abap-adt/llm-agent` import (after `type IRetrievalStrategy`… alphabetical: `type ISourceSelector, type ISpan, type ITracer`), and add, next to `RunStats`:

```ts
/** What one retrieval observed beyond its runs; filled by `run`, read by `report`. */
interface RunInfo {
  subqueries: number;
}
```

Replace the Task 14 `retrieve` method with the private `run` below — the same body with three changes: the signature (no `store` parameter; `callOptions` is a required parameter of type `CallOptions | undefined`, so no optional parameter precedes the required `runs` / `info`), every `newRunContext(callOptions)` becomes `newCtx()`, which records each run's stats, and `info.subqueries` is set after a successful decomposition:

```ts
  private async run(
    query: IQueryEmbedding,
    k: number,
    callOptions: CallOptions | undefined,
    runs: RunStats[],
    info: RunInfo,
  ): Promise<Result<RagResult[], RagError>> {
    const newCtx = (): RunContext => {
      const c = newRunContext(callOptions);
      runs.push(c.stats);
      return c;
    };
    // The caller's k caps every cut, also after decomposition (spec §4.5, F1).
    const budget = Math.min(k, this.cut.limit(k));
    const finish = (items: RagResult[]): Result<RagResult[], RagError> => ({
      ok: true,
      value: this.cut.cut(items, k).slice(0, budget),
    });
    const d = this.options.decompose;
    let subs: readonly SubQuery[] = [];
    if (d) {
      const decomposed = await this.decomposeQuery(d.decomposer, query.text, budget, callOptions);
      if (!decomposed.ok) return decomposed;
      subs = decomposed.value;
      info.subqueries = subs.length;
    }
    if (!d || subs.length === 0) {
      const one = await this.runOne(query, budget, newCtx());
      return one.ok ? finish(one.value) : one;
    }
    const results = await Promise.all(
      subs.map((s) =>
        this.runOne(new QueryEmbedding(s.text, d.queryEmbedder, callOptions), s.k, newCtx()),
      ),
    );
    // Union in sub-query order, de-duplicated by owner-qualified item, best score kept.
    const union: RagResult[] = [];
    const at = new Map<string, number>();
    for (const r of results) {
      if (!r.ok) return r;
      for (const item of r.value) {
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
```

(The local names `one` / `results` replace Task 14's `run` / `runs` so they do not shadow the method or the `runs` parameter.) Then add the public `retrieve` (the `IRetrievalStrategy` signature, unchanged) and `report`:

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
    const info: RunInfo = { subqueries: 0 };
    const result = await this.run(query, k, callOptions, runs, info);
    this.report(result, runs, info, span);
    return result;
  }

  /** One outcome per retrieval + orphans by count (spec §9.1); never a new logger. */
  private report(
    result: Result<RagResult[], RagError>,
    runs: readonly RunStats[],
    info: RunInfo,
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
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval*.test.ts packages/llm-agent-libs/src/metrics/__tests__/metrics.test.ts
```
Expected: PASS (`tsc -b` type-checks `staged-retrieval.ts` and both metrics classes; the tsx run does not).

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

In `staged-retrieval.ts`: add `isSizeBoundedCut` (value) to the `@mcp-abap-adt/llm-agent` import; widen `RunInfo` (the one type `retrieve`, `run` and `report` share):
```ts
interface RunInfo {
  subqueries: number;
  /** The first ranked, hydrated item before the cut — what an over-budget check measures. */
  firstRanked?: RagResult;
}
```
in `run`, make `finish` record the first ranked, hydrated item before the cut:
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/collections/__tests__/staged-retrieval*.test.ts
```
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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/retrieval/__tests__/*.test.ts packages/llm-agent-libs/src/health/__tests__/*.test.ts
```
Expected: PASS (`tsc -b` type-checks `reranked-retrieval.ts` and `health-checker.ts`; tsx does not).

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

Spec §14.2 (at most `min(k, cut.limit(k))` ≤ k items — S9 as amended by F1; every shipped profile called with a k below its default cut; a failed stale delete reported `cleanup-failed` and retried — F3), §7.9 (a consumer-built profile passes the same kit).

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
    /** The profile cut's own limit for a caller's k (default: k). The kit checks at most min(k, limit(k)) — never more than k (F1). */
    limit?(requestedK: number): number;
    /** The profile's own default cut (e.g. 5 for faceted-jev): the kit also calls with every k below it and asserts ≤ k (F1). */
    readonly defaultK?: number;
    readonly sizeBounded?: { readonly cut: IItemCut; readonly estimator: IItemSizeEstimator; readonly budgetTokens: number };
    /** F3: a binding whose stores fail every delete while `control.failDeletes` is true; `before` → `after` drops records of `ref`'s item. Undefined → that case is skipped. */
    readonly cleanup?: { bind(control: { failDeletes: boolean }): Promise<IBoundCollection<TItem>>; readonly before: readonly TItem[]; readonly after: readonly TItem[]; readonly ref: ItemRef; readonly options?: CallOptions };
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
  /** The profile cut's own limit for a caller's k (default: k). The kit checks at
   *  most min(k, limit(k)) items — never more than k (spec §14.2, F1). */
  limit?(requestedK: number): number;
  /** The profile's own default cut; the kit calls with every k below it (F1). */
  readonly defaultK?: number;
  readonly sizeBounded?: {
    readonly cut: IItemCut;
    readonly estimator: IItemSizeEstimator;
    readonly budgetTokens: number;
  };
  /** F3: stores that fail every delete while `control.failDeletes`; `before` → `after`
   *  leaves stale records of `ref`'s item. Undefined → the cleanup case is skipped. */
  readonly cleanup?: {
    bind(control: { failDeletes: boolean }): Promise<IBoundCollection<TItem>>;
    readonly before: readonly TItem[];
    readonly after: readonly TItem[];
    readonly ref: ItemRef;
    readonly options?: CallOptions;
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
    name: 'at most min(k, cut.limit(k)) ≤ k distinct items, with or without a decomposer',
    async run(h) {
      const bound = await filled(h);
      assert.ok(bound);
      // F1: the caller's k caps every cut.
      const limit = (k: number) => Math.min(k, h.limit?.(k) ?? k);
      const ks = new Set([1, 2, 3, ...Array.from({ length: Math.max(0, (h.defaultK ?? 0) - 1) }, (_, i) => i + 1)]);
      for (const k of ks) {
        const r = await bound.retrieval.retrieve(bound.rag, h.query, k, h.reader.options);
        assert.ok(r.ok && r.value.length <= limit(k), `${h.name}: more than ${limit(k)} items for k=${k}`);
        // Annotated: inside the loop, `r`'s assertion narrowing makes the inferred type circular (TS7022 under strict).
        const keys: string[] = r.value.map((x) => JSON.stringify(refOf(x) ?? x.metadata.id));
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
    name: "a caller k below the profile's own default cut caps the result (F1)",
    async run(h) {
      if (h.defaultK === undefined || h.defaultK < 2) return;
      const bound = await filled(h);
      assert.ok(bound);
      const k = h.defaultK - 1;
      const r = await bound.retrieval.retrieve(bound.rag, h.query, k, h.reader.options);
      assert.ok(r.ok && r.value.length <= k, `${h.name}: ${r.ok ? r.value.length : 'error'} items for k=${k} (default ${h.defaultK})`);
    },
  },
  {
    name: 'a failed stale delete is reported cleanup-failed, kept, and retried; remove then leaves nothing (F3)',
    async run(h) {
      if (!h.cleanup) return;
      const c = h.cleanup;
      const control = { failDeletes: false };
      const bound = await c.bind(control);
      const first = await bound.index(c.before, c.options);
      assert.ok(first.ok && first.value.failedItems.length === 0, `${h.name}: first index failed`);
      control.failDeletes = true;
      const second = await bound.index(c.after, c.options);
      assert.ok(second.ok);
      assert.ok(
        second.value.failedItems.some((f) => f.itemId === c.ref.itemId && f.reason.startsWith('cleanup-failed')),
        `${h.name}: a failed cleanup was not reported`,
      );
      control.failDeletes = false;
      const retry = await bound.index(c.after, c.options);
      assert.ok(retry.ok && retry.value.failedItems.length === 0, `${h.name}: the retry did not clean up`);
      const removed = await bound.remove([c.ref], c.options);
      assert.ok(removed.ok, `${h.name}: remove failed`);
      const left = (await rawRecords(h.rawStores(bound), h.query)).filter((r) => r.metadata.itemId === c.ref.itemId);
      assert.deepEqual(left, [], `${h.name}: records of ${c.ref.itemId} outlived remove`);
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
import type {
  CallOptions,
  IItemCut,
  IProbabilityDecision,
  IQueryDecomposer,
  IRag,
  IRelevanceDecision,
  IToolFacet,
  SharedItem,
  ToolItem,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, RagError, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
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

/** A store whose deletes fail while control.failDeletes (F3). */
function flaky(inner: InMemoryRag, control: { failDeletes: boolean }): IRag {
  const w = inner.writer();
  const base = matchesOnly(inner);
  return {
    ...base,
    writer: () => ({
      ...w,
      deleteByIdRaw: async (id: string, o?: CallOptions) =>
        control.failDeletes ? { ok: false as const, error: new RagError('delete down') } : w.deleteByIdRaw(id, o),
    }),
  } as IRag;
}

function toolsHarness(
  name: string,
  limit: number,
  make: (o: ReturnType<typeof asProfileOptions>) => ComposedToolsProfile,
  /** false for a profile with one record per item (nothing can go stale). */
  cleanupCase = true,
): CollectionProfileHarness<ToolItem> {
  const stores: InMemoryRag[] = [];
  return {
    name,
    bind: async (opts) => {
      const rag = new InMemoryRag();
      stores.push(rag);
      const p = make(asProfileOptions(opts));
      return p.bind({ key: 'tools', rag: matchesOnly(rag) });
    },
    limit: (k) => Math.min(k, limit),
    defaultK: limit,
    ...(cleanupCase
      ? {
          cleanup: {
            bind: async (control: { failDeletes: boolean }) => {
              const rag = new InMemoryRag();
              stores.push(rag);
              return make({}).bind({ key: 'tools', rag: flaky(rag, control) });
            },
            before: tools,
            // no description and no parameters → its summary / parameters records go stale
            after: tools.map((t) => (t.originalName === 'read_file' ? { ...t, description: '', parameters: [] } : t)),
            ref: { itemId: 'tool:read_file', owner: G },
          },
        }
      : {}),
    writes: [{ items: tools }],
    refs: tools.map((t) => ({ ref: { itemId: t.itemId, owner: G } })),
    reader: { visible: tools.map((t) => ({ itemId: t.itemId, owner: G })) },
    query: new TextOnlyEmbedding('needle'),
    rawStores: () => [stores[stores.length - 1]],
    sizeBounded: { cut: new TokenBudgetCut({ budgetTokens: 60 }), estimator: new ToolDefinitionSizeEstimator(), budgetTokens: 60 },
  };
}

const intents = new StaticIntentSource({ read_file: ['open my notes needle'] });
// Fakes for the shipped decision variants (F1: each is called with k below its default).
const jev: IProbabilityDecision = {
  decide: async (req) => ({
    ok: true,
    value: { model: 'fake', answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'noul' as const, probability: 0.5 }])) },
  }),
};
const cohere: IRelevanceDecision = {
  score: async (req) => ({ ok: true, value: { model: 'fake', scores: req.passages.map((_, index) => ({ index, score: 1 })) } }),
};
const harnesses: CollectionProfileHarness<ToolItem>[] = [
  toolsHarness('variant faceted', 8, (o) => new ComposedToolsProfile({ ...mcpToolsVariants.faceted().composition, ...o })),
  toolsHarness('variant faceted-cohere', 5, (o) => new ComposedToolsProfile({ ...mcpToolsVariants.facetedCohere({ relevanceDecision: cohere }).composition, ...o })),
  toolsHarness('variant faceted-jev', 5, (o) => new ComposedToolsProfile({ ...mcpToolsVariants.facetedJev({ probabilityDecision: jev }).composition, ...o })),
  toolsHarness('variant small-set-jev', 3, (o) => new ComposedToolsProfile({ ...mcpToolsVariants.smallSetJev({ probabilityDecision: jev, poolItems: 3 }).composition, ...o }), false),
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
Expected: PASS for every harness (the four shipped variants, faceted + intents, the consumer-built one, shared items) — including "a caller k below the profile's own default cut" (F1) and the cleanup case (F3) where a harness supplies it. (Before Step 1's build the import fails — that is the red state.) If the token-budget case fails because a tool's definition exceeds 60 tokens, raise `budgetTokens` to just above the largest `definitionChars / 4` printed by the failure — the kit's bound is what is checked, not a number.

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

Run:
```bash
npx tsc -b packages/llm-agent-libs
node --import tsx/esm --test packages/llm-agent-libs/src/testing/__tests__/evaluate-retrieval.test.ts
```
Expected: PASS (`tsc -b` type-checks `testing/evaluate-retrieval.ts` and `testing/index.ts` and emits `dist/testing`, which `@mcp-abap-adt/llm-agent-libs/testing` resolves to).

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

Spec §14.3 (flags; any tools snapshot; the decision picked like `decision:` — Jev = probability, Cohere = relevance — and with it the reranker kind; `--text` for the provider text composer, F4; the acceptance runs are env-gated and are the consumer check, not part of `npm test`).

**Files:**
- Create: `scripts/rag-eval/profile-arm.ts`
- Modify: `scripts/rag-eval/rag-eval.ts` (flags, `Case.required`, one call into the profile arm)
- Modify: `scripts/rag-eval/README.md`
- Create: `test/repo/rag-eval-profile-arm.test.ts`
- Modify: `tsconfig.typecheck.json` (`include`: `scripts/rag-eval/profile-arm.ts`, `test/repo/rag-eval-profile-arm.test.ts`)

**Interfaces:**
- Consumes: `mcpToolsVariants`, `ComposedToolsProfile`, facets, text composers, `EnumValueToolIndexer`, discriminators, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `ItemPool`, `MaxScoreCollapse`, cuts (libs sources); `ProbabilityReranker`, `RelevanceReranker`, `TOOL_QUESTION` (`packages/llm-agent-reranker/src`); `vectorizeMcpTools` (the binding and its fill source read from the store, Task 19), `bindToolsProfile` (Tasks 15, 19 — every arm binds with the default `LiveToolsFill`: the harness measures retrieval over a store it fills itself, once per arm, so the live source is the right one; `ToolsCorpusLoader` / `PrebuiltToolsStore` are pinned by Task 19A, not measured here); `evaluateRetrieval` (Task 31); `TypeSafeDecisionModel` (constructed directly for `typesafe`, as `rag-eval.ts` does today), `buildCompositionDeps(…).makeRelevanceDecision` for `sap-aicore` (Task 24).
- Produces:
  ```ts
  export interface ProfileArmFlags { variant?: string; indexer?: 'faceted' | 'enum-values'; facets?: string[]; text?: 'parameter-names' | 'enum-values' | 'schema'; discriminator?: string; maxValues?: number; intents?: 'off' | 'record' | 'companion'; intentsFile?: string; poolItems?: number; reranker?: 'none' | 'decision'; cut?: string; budgetTokens?: number }
  export interface ProfileArmDeps { decisionProvider?: 'typesafe' | 'sap-aicore'; probabilityDecision?: () => Promise<IProbabilityDecision>; relevanceDecision?: () => Promise<IRelevanceDecision>; readFile?: (p: string) => string } // the decision --decision-provider built, of its kind
  export function buildProfileArm(flags: ProfileArmFlags, deps: ProfileArmDeps): Promise<{ label: string; profile: ComposedToolsProfile | undefined; companions: string[] }>;
  export function runProfileArm(arm: { label: string; profile: ComposedToolsProfile | undefined }, input: { tools: McpTool[]; cases: RetrievalCase[]; ks: number[]; makeStore: () => Promise<IRag>; queryEmbedder?: IQueryEmbedder }): Promise<RetrievalEvalReport & { label: string }>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/repo/rag-eval-profile-arm.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  InMemoryRag,
  type IProbabilityDecision,
  type IRelevanceDecision,
  type McpTool,
} from '../../packages/llm-agent/src/index.js';
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
  it('a named decision variant needs a decision of its kind (spec §6.2, D27)', async () => {
    const jev: IProbabilityDecision = { decide: async () => ({ ok: true, value: { model: 'm', answers: {} } }) };
    const cohere: IRelevanceDecision = { score: async () => ({ ok: true, value: { model: 'c', scores: [] } }) };
    const arm = await buildProfileArm({ variant: 'faceted-cohere' }, { relevanceDecision: async () => cohere, decisionProvider: 'sap-aicore' });
    assert.ok(arm.profile);
    await assert.rejects(
      buildProfileArm({ variant: 'faceted-cohere' }, { probabilityDecision: async () => jev, decisionProvider: 'typesafe' }),
      /faceted-cohere needs a relevance decision — --decision-provider sap-aicore/,
    );
    await assert.rejects(
      buildProfileArm({ variant: 'small-set-jev', poolItems: 2 }, { relevanceDecision: async () => cohere, decisionProvider: 'sap-aicore' }),
      /small-set-jev needs a probability decision — --decision-provider typesafe/,
    );
  });
  it('--text picks the provider text composer (F4)', async () => {
    const arm = await buildProfileArm({ indexer: 'faceted', facets: [], text: 'enum-values', poolItems: 10 }, {});
    assert.ok(arm.profile);
    assert.match(arm.label, /text=enum-values/);
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
 * profile path as the server (vectorizeMcpTools on a store bound by bindToolsProfile) and measured by
 * evaluateRetrieval. Works on ANY tools snapshot — no server is special-cased.
 */
import { readFileSync } from 'node:fs';
import type {
  IItemCut,
  IItemIndexer,
  IMcpClient,
  IProbabilityDecision,
  IRelevanceDecision,
  IQueryEmbedder,
  IRag,
  IReranker,
  McpTool,
  ToolItem,
} from '../../packages/llm-agent/src/index.js';
import {
  bindToolsProfile,
  ComposedToolsProfile,
  EnumValuesToolText,
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
  ParameterNamesToolText,
  ParametersFacet,
  RequiredEnumDiscriminator,
  SchemaToolText,
  StaticIntentSource,
  SummaryFacet,
  TokenBudgetCut,
} from '../../packages/llm-agent-libs/src/collections/index.js';
import { NoopRequestLogger } from '../../packages/llm-agent-libs/src/logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../../packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.js';
import {
  ProbabilityReranker,
  RelevanceReranker,
  TOOL_QUESTION,
} from '../../packages/llm-agent-reranker/src/index.js';
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
  /** Provider text composer (F4); absent → parameter-names (C0, the default). */
  text?: 'parameter-names' | 'enum-values' | 'schema';
  discriminator?: string;
  maxValues?: number;
  intents?: 'off' | 'record' | 'companion';
  intentsFile?: string;
  poolItems?: number;
  /** decision = the reranker of --decision-provider's kind: ProbabilityReranker (Jev) or RelevanceReranker (Cohere). */
  reranker?: 'none' | 'decision';
  /** top-items | fixed-items:<n> | token-budget:<n> */
  cut?: string;
  budgetTokens?: number;
}

export interface ProfileArmDeps {
  /** Which provider --decision-provider names; its kind decides the reranker (spec §6.2). */
  decisionProvider?: 'typesafe' | 'sap-aicore';
  /** typesafe: TypeSafeDecisionModel. */
  probabilityDecision?: () => Promise<IProbabilityDecision>;
  /** sap-aicore: SapAiCoreRelevanceDecision. */
  relevanceDecision?: () => Promise<IRelevanceDecision>;
  readFile?: (path: string) => string;
}

type Kind = 'probability' | 'relevance';
/** As server-libs' DECISION_KINDS (spec §6.2). */
const PROVIDER_KIND: Readonly<Record<'typesafe' | 'sap-aicore', Kind>> = { typesafe: 'probability', 'sap-aicore': 'relevance' };
const KIND_PROVIDER: Readonly<Record<Kind, string>> = { probability: 'typesafe', relevance: 'sap-aicore' };
/** The kind of decision each named decision variant takes (spec §5.5). */
const VARIANT_KIND: Readonly<Record<string, Kind>> = {
  'faceted-cohere': 'relevance',
  'faceted-jev': 'probability',
  'small-set-jev': 'probability',
};
const TEXTS = {
  'parameter-names': () => new ParameterNamesToolText(),
  'enum-values': () => new EnumValuesToolText(),
  schema: () => new SchemaToolText(),
} as const;

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
    const wants = VARIANT_KIND[v];
    const have = deps.decisionProvider ? PROVIDER_KIND[deps.decisionProvider] : undefined;
    if (wants && have && have !== wants) {
      throw new Error(`${v} needs a ${wants} decision — --decision-provider ${KIND_PROVIDER[wants]}`);
    }
    const probability = () => need(deps.probabilityDecision, 'probability decision (--decision-provider typesafe: DECISION_API_KEY)');
    const relevance = () => need(deps.relevanceDecision, 'relevance decision (--decision-provider sap-aicore: a deployment)');
    const profile =
      v === 'baseline'
        ? undefined
        : v === 'faceted'
          ? mcpToolsVariants.faceted(opts)
          : v === 'faceted-cohere'
            ? mcpToolsVariants.facetedCohere({ ...opts, relevanceDecision: await relevance() })
            : v === 'faceted-jev'
              ? mcpToolsVariants.facetedJev({ ...opts, probabilityDecision: await probability() })
              : v === 'small-set-jev'
                ? mcpToolsVariants.smallSetJev({ ...opts, probabilityDecision: await probability(), poolItems: f.poolItems ?? 0 })
                : undefined;
    if (profile === undefined && v !== 'baseline') throw new Error(`unknown variant "${v}"`);
    return { label: `variant=${v}`, profile, companions: placement && 'companion' in placement ? ['intents'] : [] };
  }
  const facets = (f.facets ?? []).map((n) => {
    const make = FACETS[n];
    if (!make) throw new Error(`unknown facet "${n}"`);
    return make();
  });
  const text = f.text ? { text: TEXTS[f.text]() } : {};
  let base: IItemIndexer<ToolItem> = new FacetedToolIndexer(facets, text);
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
    // The reranker of --decision-provider's kind (spec §6.2): Jev → probability, Cohere → relevance.
    reranker =
      PROVIDER_KIND[deps.decisionProvider ?? 'typesafe'] === 'relevance'
        ? new RelevanceReranker(await need(deps.relevanceDecision, 'relevance decision (--decision-provider sap-aicore)'))
        : new ProbabilityReranker(await need(deps.probabilityDecision, 'probability decision (--decision-provider typesafe)'), {
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
    `text=${f.text ?? 'parameter-names'}`,
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
  // bindToolsProfile attaches the binding to the store: vectorizeMcpTools reads it from there (spec §6.3 rule 1, D34).
  const store = arm.profile ? bindToolsProfile(arm.profile, { key: 'tools', rag: raw, companions }).rag : raw;
  await vectorizeMcpTools([client], store, new NoopRequestLogger(), undefined);
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
- add to the `parseArgs` options: `variant`, `indexer`, `facets`, `text` (`parameter-names` | `enum-values` | `schema`), `discriminator`, `'max-values'`, `intents`, `'intents-file'`, `'pool-items'`, `cut`, `'budget-tokens'`, `'decision-provider'` (`typesafe` | `sap-aicore`, default `typesafe`), `'rerank-deployment'`, `'rerank-model'`, `'rerank-credential-ref'` (all `{ type: 'string' }`), and allow `--reranker none|decision` alongside the existing values (`decision` = Jev or Cohere by `--decision-provider`).
- one decision per run, picked like the server's `decision:` section, and of its provider's kind: `--decision-provider typesafe` → the existing `TypeSafeDecisionModel` construction (`staticApiKey(process.env.DECISION_API_KEY ?? '')`), a probability decision; `--decision-provider sap-aicore` → `buildCompositionDeps(process.env).makeRelevanceDecision({ provider: 'sap-aicore', deploymentId: <--rerank-deployment>, model: <--rerank-model>, ...(credentialRef ? { credentialRef } : {}) })` (default ref `DECISION` → `DECISION_SERVICE_KEY`; a missing `--rerank-deployment` / `--rerank-model` skips the arm with a printed reason, like a missing key), a relevance decision. The existing `buildReranker` for `--reranker decision` arms builds `ProbabilityReranker` or `RelevanceReranker` by that kind (add `RelevanceReranker` to the `packages/llm-agent-reranker/src/index.js` import Task 4B already switched), so the 30.1.0 rerank arms can be measured with Cohere too.
- when `--variant` or `--indexer` is given: build `ProfileArmDeps` — `decisionProvider` and the decision of its kind (`probabilityDecision` or `relevanceDecision`, lazily) — then, per matrix entry, call `runProfileArm(await buildProfileArm(flags, deps), { tools, cases, ks: [...REPORT_KS], makeStore: <the entry's existing makeRag path>, queryEmbedder: <the entry's resolved embedder> })` and print one row per k: `required-recall`, `avg items`, `avg prompt tokens`, `MRR`. The existing arms and their output are unchanged when no profile flag is given.

`scripts/rag-eval/README.md`: add a "Profile arms" section listing the flags above (including `--text` with the C0 / C0e / C0s `compact` figures as the caveat, `--decision-provider` and the three `--rerank-*` flags for Cohere on SAP AI Core — a relevance decision, its scores not probabilities), the `required` field (`"required": [["CreateClass"], ["Activate", "ActivateObjects"]]`), the prompt-size column, `evaluateRetrieval` from `@mcp-abap-adt/llm-agent-libs/testing` for consumers, and the four acceptance runs of spec §14.3 (each env-gated; the hub's consumer check).

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
- Modify: `packages/llm-agent/README.md`, `packages/llm-agent-libs/README.md`, `packages/llm-agent-server-libs/README.md`, `packages/llm-agent-server/README.md`, `packages/typesafe-decision/README.md` (`IProbabilityDecision`; one of two decision kinds), `scripts/rag-eval/README.md` (already in Task 32 — check it)
- Modify: `examples/docker-sap-ai-core/smart-server.yaml` (a commented `decision: { provider: sap-aicore … }` + `rag.profiles` block)
- (`packages/sap-aicore-decision/README.md` was written in Task 18; `packages/llm-agent-reranker/README.md` in Tasks 4B–4C.)
- Every page that names a renamed or moved symbol (`IDecisionModel`, `DecisionReranker`, `DecisionRerankerOptions`, `DECISION_RERANK_DEFAULT_*`, `wrapDecisionModel`, `makeDecisionModel` / `createMakeDecisionModel`, rerankers imported from libs) uses the new name / package and says the old one is a deprecated alias (spec §13). Found today: `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md` (~207, ~1026), `docs/EXAMPLES.md` (~335–353), `docs/INTEGRATION.md` (~1044, ~1165, ~1221), `docs/PERFORMANCE.md`, `docs/TROUBLESHOOTING.md` (~295: the seam-missing message is now `BuildAgentDeps.makeProbabilityDecision is required: …`; add the both-supplied error `BuildAgentDeps.makeDecisionModel and BuildAgentDeps.makeProbabilityDecision are both supplied` → remove `makeDecisionModel`), `packages/llm-agent/README.md`, `packages/llm-agent-libs/README.md`, `packages/typesafe-decision/README.md`, `scripts/rag-eval/README.md` — re-run the Step 9 grep for the full list.

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
- **A failed cleanup is never reported as indexed:** if a stale record's delete fails, the item lands in
  `failedItems` (`cleanup-failed: …`), the id stays on the canonical record (`staleRecordIds` /
  `staleCompanionRecordIds`), and the next `index` or `remove` retries it.
- **Companion records** (e.g. intents in their own store) are listed on the canonical record
  (`companionRecordIds`), so `remove` and re-indexing clear them too.
- **`IndexReport.notes`** carries what an indexer declined to guess (e.g. `ambiguous-discriminator`);
  write your own through the optional `IIndexNoteSource` capability.

### MCP tools — choose strategies, or start from a default composition

| Default (`mcpToolsVariants.*`) | Tool-set shape | Composition |
|---|---|---|
| `baseline()` | any | binds nothing — 30.1.0 |
| `faceted()` | fine-grained | `full` + `summary` + `parameters` records, `ItemPool(15)`, max collapse, `FixedItemsCut(8)` |
| `facetedCohere({ relevanceDecision })` | fine-grained | faceted + `ItemPool(30)` + `RelevanceReranker` over your `SapAiCoreRelevanceDecision` (Cohere) + at most 5 |
| `facetedJev({ probabilityDecision })` | fine-grained | faceted + `ItemPool(30)` + `ProbabilityReranker(TOOL_QUESTION)` over your `TypeSafeDecisionModel` (Jev) + at most 5 — *to be measured as one composition before promotion* |
| `smallSetJev({ probabilityDecision, poolItems })` | coarse / small | one `full` record per tool + Jev over the whole set (`poolItems` ≥ your tool count) + at most 3 |

**The caller's k caps every cut:** a `FixedItemsCut(n)` is a ceiling — a caller asking for 2 gets at
most 2. The provider text of the `full` record is a strategy too (`FacetedToolIndexer(facets, { text })`):
`ParameterNamesToolText` (default, measured), `EnumValuesToolText`, `SchemaToolText` — the latter two
were within noise of the default on one coarse server (see PERFORMANCE.md).

Each default cites its measurement in the source and in [PERFORMANCE.md](PERFORMANCE.md#collection-profiles).
Intents are an add-on: `{ intents: { record: source } }` (own record kind) or `{ intents: { companion: source } }`
(own store, bind with `companions: { intents: store }`). A companion store belongs to ONE binding: two
catalogs that share one would overwrite and delete each other's intent records (ids carry no binding),
so give every binding its own — the profile instance itself can be shared.

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
- **The builder fills the profile only where it vectorizes** — the auto-connect branch (YAML `mcp:` /
  `withMcpConnectionStrategy`). With `withMcpClients` or `withMcpServers` it skips vectorization, as
  before, so the profile is bound but the store stays empty. Fill it yourself (spec §6.1):

  ```ts
  import { defaultToolRecordKey } from '@mcp-abap-adt/llm-agent';
  import { bindToolsProfile, toolItemFromTool } from '@mcp-abap-adt/llm-agent-libs';

  const bound = bindToolsProfile(myTools, { key: 'tools', rag: toolsRag });
  const listed = await client.listTools();
  if (listed.ok) {
    const report = await bound.index(
      listed.value.map((t) =>
        toolItemFromTool(t, {
          itemId: defaultToolRecordKey.key({ toolName: t.name, clientIndex: 0, clientCount: 1 }),
          originalName: t.name,
        }),
      ),
    );
    // report: Result<IndexReport> — check failedItems
  }
  builder.withMcpClients([client]).setToolsRag(bound.rag).withToolsProfile(myTools); // reused, not bound twice
  ```

  Several clients: `clientIndex` / `clientCount` follow the client order (or use your own
  `IToolRecordKey`, the one given to `withToolRecordKey`). After `build()`,
  `toolsBindingOf(handle.ragStores.tools)?.index(items)` works too. With several clients, call
  `fillToolsBinding(clients, bound, { toolRecordKey, toolNamespace })` instead — the same filling
  path the builder and the server use (lists, namespaces, keys, `bound.index`).
- **The binding and its fill source travel with the store.** Every later write reads them from the
  store itself: a reconnect that reports `toolsChanged`, and `fillToolsBinding`. Bind with
  `bindToolsProfile(profile, target, source?)`, never with `profile.bind()` alone. A binding the
  store does not carry is invisible to those paths, and `fillToolsBinding` refuses it.
- **A tools store is filled once, when it is created — never refilled while running.** Where the
  records come from is the **fill source** you pass (spec §3.10):

  | Source | At creation | On `toolsChanged` | For |
  |---|---|---|---|
  | `LiveToolsFill` (default) | lists the MCP tools, indexes them through the profile | re-indexes (a changed tool's records and companions replaced, a new tool added; a removed tool stays) | anything; 30.1.0's behaviour |
  | `ToolsCorpusLoader({ corpus, expect })` | checks the corpus's fingerprint, writes its records with their precomputed vectors — **no embedding call** | nothing | an **in-memory** store |
  | `PrebuiltToolsStore({ expect })` | checks the store's service record; **never writes** | nothing | a **persistent** store your deploy step filled |
  | `ConsumerToolsFill` | nothing — you fill (`fillToolsBinding`, `bound.index`) | re-indexes | your own filling |

  An incomplete fill (a client that failed to list) is reported (`complete: false`, `/health`
  `degraded`) and stays — no retry.
- **Build and deploy a corpus** (spec §6.5):

  ```ts
  // build step (CI): the profile's own indexer + your document embedder
  const corpus = await buildToolsCorpus({ profile, embedder, identity: { profile: 'faceted@1', embedder: 'te3-small' }, items });
  writeFileSync('dist/tools-corpus.json', JSON.stringify(corpus));
  // deploy step (persistent store): precomputed vectors, in place, idempotent
  const report = await deployToolsCorpus(parseToolsCorpus(readFileSync('dist/tools-corpus.json', 'utf8')), { key: 'tools', rag: qdrantRag });
  ```

  `identity` is your own name for the profile composition and the embedder: use the same strings in
  `expect` at run time. A mismatch fails at instance creation, naming what differs.
- **The server fills `rag.profiles.tools` itself, on every path** (spec §6.3), with the configured
  `fill` source (`rag.profiles.tools.fill`, default `live`): with ready clients
  (`BuildAgentDeps.mcpClients`, `mcpClients`, plugin clients) or an injected `connectMcp` seam it
  fills the bound store once at startup, before it reports ready; on its own YAML `mcp:` connect the
  builder fills it. Workers reading the main store are not filled again. A worker with its own
  store is filled **by its construction**: at startup, and for its new store when `PUT /v1/config`
  or a hot reload rebuilds the worker; a per-session re-wire never fills. It is filled from its own clients, or from
  the shared clients with the same slot descriptors and namespace as the main store, so its
  records carry the names its agent can call. Each store with its own binding gets its own
  companion store. A client that fails to list is counted, never a silent empty store: for the
  main store, `/health` shows `toolCatalog.clientFailures` and `degraded`. `/health` reports the
  main catalog only; a worker's fill is logged.

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

- `StagedRetrieval` calls your `decompose(text, budget)`; `budget = min(k, cut.limit(k))` — never above the caller's k.
- Sub-query `k`s must be integers ≥ 1 summing to ≤ `budget`; texts non-empty. Anything else — or an
  error — is a `DECOMPOSE_ERROR`, returned, never a silent fall-back. `[]` = run the query as is.
- **k stays the overall limit:** the merged union is cut once. None ships; you measure yours (§ rag-eval).

### Rerankers

**A decision and a reranker are different things; a probability and a relevance are different
decisions.** Every reranker is in `@mcp-abap-adt/llm-agent-reranker`; the decision comes from a provider:

| Reranker | Decision (contract) | Provider (package) | `score` it writes |
|---|---|---|---|
| `ProbabilityReranker` (was `DecisionReranker`) | `IProbabilityDecision` (was `IDecisionModel`) | `TypeSafeDecisionModel` (`@mcp-abap-adt/typesafe-decision`, Jev) | P(relevant) in [0, 1] |
| `RelevanceReranker` | `IRelevanceDecision` | `SapAiCoreRelevanceDecision` (`@mcp-abap-adt/sap-aicore-decision`, Cohere; one `/rerank` call per batch) | relevance — **not a probability**; comparable for the same query and model, so batches merge into one order |

- A threshold (`ScoreFloorCut`) on relevance scores is your calibration for that provider; no default uses one. Under a reranker it needs `onFailure: 'error'` (a `'stage1'` fallback returns stage-1 scores) and never goes with `keepStage1Top` — both refused at construction.
- `keepStage1Top: n` pins the stage-1 top-n first; each pinned item carries its **reranked** score, the rest follow by reranked score. Unmeasured — default 0.
- The old names still import from `@mcp-abap-adt/llm-agent-libs` / `@mcp-abap-adt/llm-agent` as deprecated aliases until the next major.

Any reranker composes with any indexing. Under a profile every reranker result is checked: wrong count,
a duplicate or a non-finite score is a `RERANK_ERROR` (`onFailure: 'stage1'` keeps the stage-1 order,
`'error'` returns it) — counted, never silent. A size-bounded cut (`ISizeBoundedCut`, e.g.
`TokenBudgetCut`) adds `cut.tokens` / `cut.budgetTokens` and `outcome=over_budget`.

### Conformance kit

```ts
import { collectionProfileConformanceCases } from '@mcp-abap-adt/llm-agent/testing/collection-profile-conformance';
for (const c of collectionProfileConformanceCases) it(c.name, () => c.run(myHarness));
```

It checks owner keys on every record, owner-scoped ids, hydration, at most `min(k, cut.limit(k))` ≤ k
items with or without a decomposer (and with a k below the profile's own default cut), an overrunning
decomposer refused, the identity filter, a size-bounded cut's budget, and — when your harness supplies
it — that a failed stale delete is reported `cleanup-failed` and retried.

### Migrating from `IToolIndexingStrategy`

The unexported, unwired `IToolIndexingStrategy` is deleted:
`OriginalToolIndexing` → `FacetedToolIndexer`'s `full` record (or no profile at all);
`IntentToolIndexing` → `IntentRecordIndexer` / `IntentCompanionIndexer` with `LlmIntentSource` or `StaticIntentSource`;
`SynonymToolIndexing` is not ported (its synonyms were not the provider's words).
````

Also in `docs/INTEGRATION.md`:
- `## IReranker` (line ~1044): add one line under its intro — `Shipped implementations (@mcp-abap-adt/llm-agent-reranker): ProbabilityReranker (over an IProbabilityDecision — TypeSafe Jev), RelevanceReranker (over an IRelevanceDecision — Cohere on SAP AI Core), LlmReranker, NoopReranker.`; under `### Example: Cross-encoder reranker via external API` add one sentence: a cross-encoder is a relevance decision — implement `IRelevanceDecision` and use `RelevanceReranker`; for Cohere on SAP AI Core use the shipped `SapAiCoreRelevanceDecision`.
- `## IDecisionModel` (~1165): rename the section `## IProbabilityDecision (was IDecisionModel)` — the old name is a deprecated alias; add a sibling section `## IRelevanceDecision` (spec §3.9): request (query + passages), result (`{index, score}` per passage + `model`), errors (`DecisionError`, existing codes), "not a probability; comparable for the same query and model — a cross-encoder scores each (query, passage) pair independently, so `RelevanceReranker` batches (48000 tokens / call by default) and merges", the shipped `SapAiCoreRelevanceDecision`. At ~1221: `wrapDecisionModel` → `wrapProbabilityDecision` (+ `wrapRelevanceDecision`); at ~1222 the seam paragraph: "supply the model through the optional `BuildAgentDeps.makeProbabilityDecision` seam (`makeDecisionModel` is its deprecated alias until the next major; supplying both is a startup error) … returns an `IProbabilityDecision`", plus one sentence for the relevance seam `BuildAgentDeps.makeRelevanceDecision` (`decision.provider: sap-aicore`).
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
| rerankers (one record per tool, pool 30 items, k=5): Cohere EN 0.931, Jev EN 0.977; non-English 0.962 / 1.000 | `faceted-cohere` (`RelevanceReranker` over `SapAiCoreRelevanceDecision`), `faceted-jev` (`ProbabilityReranker` over `TypeSafeDecisionModel`) |
| provider text on `compact` (Jev over the whole set; EN 67 / non-ASCII 21 rows; equal tokens ~1.6k at k=3): C0 names + description + parameter names EN .970 / .970 (k3 / k5), non-ASCII 1.000; C0s + property descriptions + enum values .970 / .985, 1.000; C0e + enum values 1.000 / 1.000, .905. Without a reranker schema text helps non-ASCII at k=5 (.667 → .857) but hurts EN at k=2–3 | within noise, no winner: the default stays C0 (`ParameterNamesToolText`); `EnumValuesToolText` / `SchemaToolText` are strategies to measure on your server. `compact` already names its objects in descriptions, so "objects only in an enum" is neither confirmed nor refuted |
| coarse `compact` set (25 tools): one record + Jev over the whole set, k=3 → 0.970 at ~1.6k tokens (whole set ≈ 7.9k) | `small-set-jev` |
| per-value records on `compact`: worse (non-English 0.857 vs 1.000) | `EnumValueToolIndexer` in no default |
| token budget as the main cut: 0.910 vs 0.970 for k=3 at equal tokens | `TokenBudgetCut` is a guard, not a main cut |
| an LLM as reranker | no gain, 6–10k tokens per query |

Knobs, all chosen by the strategies you inject: pool size (`ItemPool(n)`), cut (`TopItemsCut`,
`FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut` — every one capped by the caller's k), provider
text (`ParameterNamesToolText` default), reranker, intents (add-on for stage 1 only — within noise
once a reranker runs). The library picks no number for you.
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

Cohere on SAP AI Core — the `decision:` section's provider decides the kind of decision, and with it
the reranker (`typesafe` → probability → `ProbabilityReranker`; `sap-aicore` → relevance → `RelevanceReranker`):

```yaml
decision:                         # ONE decision per server
  provider: sap-aicore            # Cohere Rerank on SAP AI Core — a relevance decision (typesafe = TypeSafe Jev, a probability)
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

Where the tools store's records come from (`fill`, default `live`) — a store is filled once, at start:

```yaml
rag:
  profiles:
    tools:
      variant: faceted
      # in-memory store: load the corpus your build step made (no embedding call at start)
      fill: { corpus: { file: ./dist/tools-corpus.json, profile: faceted@1, embedder: te3-small } }
      # persistent store your deploy step filled (deployToolsCorpus): checked, never written
      # fill: { prebuilt: { profile: faceted@1, embedder: te3-small } }
      # fill: consumer        # you fill it yourself
```

Your own composition, every value a name:

```yaml
rag:
  profiles:
    tools:
      compose:
        indexer: { faceted: [summary, parameters] }   # name-tail is opt-in (verb-first names)
        # text: enum-values                           # provider text: parameter-names (default) | enum-values | schema
        pool: { items: 30 }
        collapse: max
        reranker: decision                            # none | decision | llm — decision = the reranker of the decision: kind
        question: tool                                # probability (typesafe) / llm only; refused for relevance (no wording)
        cut: { fixed-items: 5 }                       # top-items | fixed-items | score-floor | token-budget
        onFailure: stage1                             # stage1 | error
```

- Your own strategies: register them on `SmartServerConfig.toolsVariantFactories` /
  `toolsStrategyFactories` (facets, discriminators, pools, collapse, cuts, estimators, decomposers) and
  name them here. A decomposer is never built in.
- The server fills the bound `tools` store at startup from the MCP clients it uses — YAML `mcp:`, an
  injected `connectMcp`, `mcpClients` or plugin clients alike — once, before `/health` reports ready.
  A client whose `listTools()` fails shows in `/health` (`toolCatalog.clientFailures`, `degraded`).
  A worker with its own `rag:` gets its store filled when the worker is built, so after `PUT /v1/config`
  or a hot reload its rebuilt store is filled too; its result is logged, not in `/health`. When an MCP
  connection reports changed tools, the bound store is re-indexed through the profile.
- `intents.companion.store`: the server builds one companion store per tools store it binds (the main
  one and each worker's own), so catalogs never share intent records. A persistent companion store
  (`qdrant`, `pg-vector`, `hana`) names one collection, so with a worker that has its own `rag:` it is
  refused at startup — use `in-memory`, `intents.record`, or bind that worker's store in code.
- `rag.profiles` is server-wide; a worker config must not declare it. In this release only the key
  `tools` (the server's own tools store) is accepted; any other key is refused at startup — bind other
  stores in code (`profile.bind({ key, rag })` + `builder.withRetrievalStrategy(key, bound.retrieval)`).
- A named variant needs a decision of its kind: `faceted-cohere` ↔ relevance (`sap-aicore`);
  `faceted-jev`, `small-set-jev` ↔ probability (`typesafe`). `compose` with `reranker: decision` takes either.
- A `score-floor` cut over relevance scores is your calibration for that provider — no default uses one. With a reranker it needs `onFailure: error`: a `stage1` fallback returns stage-1 scores, which that threshold must not cut (refused at startup).
````

And add a programmatic snippet (`builder.withToolsProfile(mcpToolsVariants.facetedJev({ probabilityDecision }))`) next to the existing builder example. In the existing decision-model example (~line 335): `wrapDecisionModel` → `wrapProbabilityDecision`, `DecisionReranker` → `ProbabilityReranker` imported from `@mcp-abap-adt/llm-agent-reranker`, with a one-line note that the old names still work as deprecated aliases.

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
| `failedItems` reason `cleanup-failed: <n> stale record(s) kept for retry` | a replacement wrote the new records but a stale record's delete failed | re-run `index` (or `remove`) once the store is healthy — the ids are kept on the canonical record and retried |

### Switching a profile on a persistent tools store

Turning a profile on, off, or changing its variant / intent placement on a persistent store (Qdrant,
pg-vector, HANA) needs a **fresh collection** (redeploy), like an embedder change: profile records and
30.1.0 records sit side by side otherwise. Every record carries `metadata.profile` for diagnosis.
In-memory stores are rebuilt every boot and need nothing.

### `prebuilt tools store …: no deployed corpus` / `… incompatible` at startup

The store is bound with `fill: { prebuilt: … }` but your deploy step has not written it
(`deployToolsCorpus`), was interrupted (`a deploy is in progress or was interrupted` — rerun it), or
wrote a corpus built with another profile or embedder name (`incompatible — embedder "…" ≠ expected
"…"`). Rerun the deploy step with the corpus your build step made, and use the same `profile` /
`embedder` names in the YAML. `tools corpus: incompatible …` is the same check for `fill: { corpus: … }`.
````

- [ ] **Step 6: `docs/DEPLOYMENT.md`, `docs/SECURITY_THREAT_MODEL.md`, `docs/QUICK_START.md`**

- `DEPLOYMENT.md` `## Per-store reranking (rag.retrieval)` (~line 400): next to the TypeSafe paragraph, add Cohere on SAP AI Core — `decision.provider: sap-aicore` (a relevance decision; `reranker: decision` then builds a `RelevanceReranker`) with `deploymentId`, `model`, `resourceGroup?`; the credential is a SAP AI Core **service key** in `DECISION_SERVICE_KEY` (or `<REF>_SERVICE_KEY` with `decision.credentialRef`, e.g. `AICORE` to share the LLM's account), exchanged for a bearer token by `sap-aicore-auth`; one `/rerank` call per batch (48000 estimated tokens by default — ≤ 30 tools is one call); `question` / `task` are refused with it. Then a sub-section `### Collection profiles (rag.profiles)` — only the key `tools`, server-wide, not hot-reloadable, worker configs rejected, a named variant needs a decision of its kind, `small-set-jev` startup check, the fresh-collection rule for persistent stores, and one companion store per bound tools store (a persistent companion store with a worker that has its own `rag:` is refused). A custom composition root that serves Cohere supplies `BuildAgentDeps.makeRelevanceDecision`. Then `### The tools corpus — build step and deploy step`: TL;DR table (build → `buildToolsCorpus` in CI; deploy → `deployToolsCorpus` into the persistent store, idempotent, a service record `tools-corpus` with the fingerprint and corpus hash; run time → `fill: { prebuilt: … }`, or `fill: { corpus: { file } }` for an in-memory store), the two script sketches of spec §6.5, the rule that the `profile` / `embedder` names match across build, deploy and YAML, and that the process never writes a prebuilt store (a changed tool list waits for the next build / deploy).
- `SECURITY_THREAT_MODEL.md`, AS-7 (external rerankers): add Cohere on SAP AI Core — `decision.provider: sap-aicore` (for `faceted-cohere`, `compose` with `reranker: decision`, or `rag.retrieval` with `reranker: decision`) sends the query and the candidate tool texts to the SAP AI Core deployment named in `decision:`; opt-in. Add: shared items store whatever the writer puts in `text` / `data`; redaction is the writer's; user partitions are read with the request's `userId` and skipped without one.
- `QUICK_START.md` "Optional: per-store reranking": one short paragraph + link to EXAMPLES `#collection-profiles-ragprofiles` for multi-record tools stores.

- [ ] **Step 7: `README.md` and package READMEs**

- `README.md` `### RAG is a composition, not a backend`: add a bullet —
  `- **Collection profiles** — per kind of collection, how it is filled and searched: several records per tool, collapse to items, a reranker on the provider text, a cut counted in items. Default compositions for fine-grained and small tool sets; compose your own from strategies. Off by default ([INTEGRATION.md](docs/INTEGRATION.md#collection-profiles)).`
- `README.md` Packages table: add after `llm-agent`:
  `| [`@mcp-abap-adt/llm-agent-reranker`](packages/llm-agent-reranker/README.md) | Vendor-neutral rerankers — `ProbabilityReranker`, `RelevanceReranker`, `LlmReranker`, `NoopReranker`. |`
  and after `typesafe-decision`:
  `| [`@mcp-abap-adt/sap-aicore-decision`](packages/sap-aicore-decision/README.md) | Relevance decision provider — Cohere Rerank on SAP AI Core (`SapAiCoreRelevanceDecision`, an `IRelevanceDecision`). |`
  and reword the `typesafe-decision` row: "Probability decision provider — TypeSafe Jev (`IProbabilityDecision`)".
- `README.md` `### Decision models` (~line 148): two sentences + the YAML lines — a probability and a relevance are different decisions; ONE `decision:` section, the provider decides the kind: `typesafe` (Jev, probability → `ProbabilityReranker`) or `sap-aicore` (Cohere Rerank on SAP AI Core, relevance → `RelevanceReranker`; `deploymentId`, `model`, `resourceGroup?`; default ref `DECISION` → `DECISION_SERVICE_KEY`). Either serves `reranker: decision` in `rag.retrieval` and the decision variants of `rag.profiles`.
- `packages/llm-agent/README.md`: list `IProbabilityDecision` (was `IDecisionModel`, kept as a deprecated alias) and `IRelevanceDecision` (+ `RelevanceRequest`, `RelevanceResult`, `RelevanceScore`), and the new contracts (`ICollectionProfile`, `IToolTextComposer`, `IBoundCollection`, `IItemIndexer`, `IIndexNoteSource`, `ISizeBoundedCut`, `recordId`, `RecordOwner`, `ToolItem`, `SharedItem`, `IRetrievalMetrics`, `IRetrievalEmbedderOwner`, `retrievalEmbedderOf`, `skillNameFromRecord`) and the `./testing/collection-profile-conformance` entry.
- `packages/llm-agent-libs/README.md`: add to the export list `StagedRetrieval`, `ComposedToolsProfile`, `mcpToolsVariants`, `SharedItemsProfile`, `bindToolsProfile`, `toolsBindingOf`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet`, `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`, `ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `ToolDefinitionSizeEstimator`, `CharsPerTokenEstimator`, `ParameterNamesToolText`, `EnumValuesToolText`, `SchemaToolText`, `fullToolText`, `toolItemFromTool`, `fillToolsBinding`, `LiveToolsFill`, `ToolsCorpusLoader`, `PrebuiltToolsStore`, `ConsumerToolsFill`, `buildToolsCorpus`, `parseToolsCorpus`, `deployToolsCorpus`, `TOOLS_CORPUS_RECORD_ID`, `checkRerankOutput`, `wrapProbabilityDecision`, `wrapRelevanceDecision`; `SmartAgentBuilder.withToolsProfile`; `testing`: `evaluateRetrieval`. State that the rerankers moved to `@mcp-abap-adt/llm-agent-reranker` and the libs names (`DecisionReranker`, `LlmReranker`, …, `wrapDecisionModel`) are deprecated re-exports until the next major.
- `packages/llm-agent-server-libs/README.md`: `rag.profiles` (key `tools`, `compose.text`), `decision.provider: sap-aicore` (a relevance decision, built by the new optional `BuildAgentDeps.makeRelevanceDecision` seam — a custom composition root that serves Cohere supplies it), the probability seam `BuildAgentDeps.makeProbabilityDecision` (was `makeDecisionModel`, a deprecated alias until the next major; both supplied → startup error), `DECISION_KINDS`, `toolsVariantFactories` / `toolsStrategyFactories` (incl. `texts`), `resolveCollectionProfiles`.
- `packages/llm-agent-server/README.md`: the binary supplies `makeProbabilityDecision` (TypeSafe, was `makeDecisionModel`) and `makeRelevanceDecision`; `makeRelevanceDecision` builds `SapAiCoreRelevanceDecision` for `decision.provider: sap-aicore` (default credential ref `DECISION` → `DECISION_SERVICE_KEY`, a SAP AI Core service key); it ships `@mcp-abap-adt/sap-aicore-decision` and `@mcp-abap-adt/llm-agent-reranker`.
- `packages/typesafe-decision/README.md`: `TypeSafeDecisionModel` implements `IProbabilityDecision` (the old name `IDecisionModel` is a deprecated alias of the same type); Jev is the probability decision, Cohere on SAP AI Core (`@mcp-abap-adt/sap-aicore-decision`) the relevance one; the reranker is `ProbabilityReranker` from `@mcp-abap-adt/llm-agent-reranker`.

- [ ] **Step 8: Example config**

In `examples/docker-sap-ai-core/smart-server.yaml`, append a commented block (comments only — the example keeps running unchanged):
```yaml
# Collection profiles (optional) — see docs/EXAMPLES.md#collection-profiles-ragprofiles
# decision:
#   provider: sap-aicore            # Cohere Rerank on SAP AI Core — a relevance decision
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
git grep -n -w "IDecisionModel\|DecisionReranker\|DecisionRerankerOptions\|wrapDecisionModel\|DECISION_RERANK_DEFAULT_TASK\|DECISION_RERANK_DEFAULT_CRITERIA\|SapAiCoreDecisionModel\|makeDecisionModel\|createMakeDecisionModel" -- README.md CLAUDE.md docs examples scripts 'packages/*/README.md' ':!docs/superpowers' ':!**/CHANGELOG.md'
git grep -n -i "within one call\|one call by default" -- README.md CLAUDE.md docs examples 'packages/*/README.md' ':!docs/superpowers'
```
Expected: the first prints nothing outside `CHANGELOG.md` history; the second shows the new anchors are linked; the third prints only lines that say the name is a deprecated alias (and nothing for `SapAiCoreDecisionModel`, which was never released, or `createMakeDecisionModel`, which was internal); the fourth prints nothing (relevance scores are comparable for the same query and model, D28). Open each linked anchor once to confirm it resolves (`## Collection profiles` → `#collection-profiles`; `### Collection profiles (\`rag.profiles\`)` → `#collection-profiles-ragprofiles`).

- [ ] **Step 10: Commit**

```bash
git add README.md docs packages/llm-agent/README.md packages/llm-agent-libs/README.md packages/llm-agent-server-libs/README.md packages/llm-agent-server/README.md packages/typesafe-decision/README.md scripts/rag-eval/README.md examples/docker-sap-ai-core/smart-server.yaml
git commit -m "docs: collection profiles across README, architecture, integration, performance, examples, troubleshooting, deployment, security

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012KjevEeQGZMkWMfnupJ7Yd"
```

---

## Task 34: CHANGELOG, migration notes, `CLAUDE.md`

Spec §13. No version heading and no bump — the entry goes under `## [Unreleased]`; the release step turns it into a version.

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `packages/llm-agent-server-libs/CHANGELOG.md`, `packages/llm-agent-server/CHANGELOG.md` (an `## Unreleased` section above `## 30.1.0`; the released 30.1.0 entries stay as written)
- Modify: `CLAUDE.md` (architecture list, key API notes, key layers, environment)

- [ ] **Step 1: `CHANGELOG.md` — under `## [Unreleased]`:**

```markdown
### Added

- **Collection profiles** — how one kind of collection is filled AND searched, chosen by the consumer as injected strategies. `@mcp-abap-adt/llm-agent`: `ICollectionProfile`, `IBoundCollection`, `IItemIndexer`, `IndexReport`, `RecordDraft` / `IndexedRecord`, `RecordOwner`, `ItemRef`, `recordId` (owner-scoped physical ids, `h:`+sha256 above 200 characters), `ICandidatePool`, `ICollapseRule`, `IItemCut`, `IItemSizeEstimator`, `ISizeBoundedCut` (+ `isSizeBoundedCut`), `IIndexNoteSource` (+ `isIndexNoteSource`, `IndexNote`), `IQueryDecomposer`, `ISourceSelector`, `RetrievalSource`, `ToolItem`, `IToolFacet`, `IDiscriminatorSelector`, `IToolIntentSource`, `SharedItem`, `ISharedItemGroups`, `SharedItemsStores`, `IRetrievalMetrics` (+ `isRetrievalMetrics`), `IRetrievalEmbedderOwner` (+ `retrievalEmbedderOf`), `skillNameFromRecord`; conformance kit `@mcp-abap-adt/llm-agent/testing/collection-profile-conformance`. `@mcp-abap-adt/llm-agent-libs`: `StagedRetrieval` (an `IRetrievalStrategy`: candidates counted in items → collapse → reranker on provider text → hydration from the canonical record → one cut), `ComposedToolsProfile`, `mcpToolsVariants` (`baseline`, `faceted`, `faceted-cohere`, `faceted-jev`, `small-set-jev`), `SharedItemsProfile`, `bindToolsProfile` / `toolsBindingOf`, `fillToolsBinding` (the server fills a bound `rag.profiles.tools` from ready clients too, spec §6.3; a tools store is filled **once, when it is created** — at startup, or a worker's new store after `PUT /v1/config` or hot reload — and never refilled while running; every write reads the binding and its fill source from the store), the strategies (`ItemPool`, `MaxScoreCollapse`, `TopItemsCut`, `FixedItemsCut`, `ScoreFloorCut`, `TokenBudgetCut`, `ToolDefinitionSizeEstimator`, `CharsPerTokenEstimator`, `FacetedToolIndexer`, `SummaryFacet`, `ParametersFacet`, `NameTailFacet` (opt-in), `EnumValueToolIndexer`, `RequiredEnumDiscriminator`, `NamedDiscriminator`, `IntentRecordIndexer`, `IntentCompanionIndexer`, `StaticIntentSource`, `LlmIntentSource`), `checkRerankOutput`, `SmartAgentBuilder.withToolsProfile`, and `evaluateRetrieval` in `/testing`. See README "RAG is a composition", `docs/INTEGRATION.md#collection-profiles`, `docs/PERFORMANCE.md#collection-profiles`.
- **Probability and relevance decisions** (`@mcp-abap-adt/llm-agent`): `IProbabilityDecision` (the renamed `IDecisionModel` — yes/no, choice and score questions answered with probabilities) and the new `IRelevanceDecision` (`RelevanceRequest` → `RelevanceResult`: one relevance score per passage — **not a probability**; comparable for the same query and model, also across calls; errors are `DecisionError` with the existing codes). Usage-logging wrappers `wrapProbabilityDecision` / `wrapRelevanceDecision` (libs).
- **New package `@mcp-abap-adt/llm-agent-reranker`** — every reranker, vendor-neutral: `ProbabilityReranker` (was `DecisionReranker`), the new `RelevanceReranker` (batched by default like `ProbabilityReranker` — `maxBatchTokens` 48000, `concurrency` 4 — the batches' scores merged into one order; wrong count / duplicate / out-of-range / non-finite → `RERANK_ERROR`; `score` = the relevance score), `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION`, `PROBABILITY_RERANK_DEFAULT_*`. Peer: `@mcp-abap-adt/llm-agent`. Published right after `llm-agent`.
- **New package `@mcp-abap-adt/sap-aicore-decision`** — `SapAiCoreRelevanceDecision`, Cohere Rerank on an SAP AI Core deployment as an `IRelevanceDecision`: ONE `/rerank` call per `score`; a wrong / duplicate / out-of-range / non-finite answer is a `DecisionError`, never zero-filled. Credential injected (a SAP AI Core service key via `sap-aicore-auth`), no env, no timeout, no retries. Published at the same version, before the server.
- **SmartServer:** `rag.profiles.tools` (`variant` or `compose` incl. `text`, `intents`, `decomposer`, `smallSet.poolItems`; only the key `tools` in this release) and `decision.provider: sap-aicore` (`deploymentId`, `model`, `resourceGroup?`; default credential ref `DECISION` → `DECISION_SERVICE_KEY`). ONE `decision:` section — the provider decides the kind (`typesafe` → probability, `sap-aicore` → relevance) and `reranker: decision` builds `ProbabilityReranker` or `RelevanceReranker` (in `rag.profiles` and `rag.retrieval`); the relevance decision is built by the new optional seam `BuildAgentDeps.makeRelevanceDecision`, the probability decision by `BuildAgentDeps.makeProbabilityDecision` (renamed from `makeDecisionModel`, see Migration). `SmartServerConfig.toolsVariantFactories` / `toolsStrategyFactories` for your own names. Startup refuses a `rag.profiles` key other than `tools`, a key under both `rag.retrieval` and `rag.profiles`, unknown names, a named variant whose decision is of the other kind, a question / task for a relevance decision, and `small-set-jev` whose `poolItems` is below the listed tool count.
- **Where a tools store's records come from is a strategy** (`IToolsFillSource`, `ToolsFillContext` in `@mcp-abap-adt/llm-agent`): `LiveToolsFill` (default — the MCP tool list, indexed through the profile), `ToolsCorpusLoader` (an in-memory store loaded at creation from a corpus built at build time — no embedding call), `PrebuiltToolsStore` (a persistent store your deploy step filled — checked at creation, never written by the process), `ConsumerToolsFill` (you fill it). Offline corpus API: `buildToolsCorpus` (build step), `parseToolsCorpus`, `deployToolsCorpus` (deploy step: precomputed vectors, in place, idempotent, a `tools-corpus` service record with the fingerprint and corpus hash). YAML `rag.profiles.tools.fill`; `SmartServerConfig.toolsFillFactories`; `bindToolsProfile(profile, target, source?)`, `withToolsProfile(profile, source?)`.
- **Provider text is a strategy** (`IToolTextComposer`): `ParameterNamesToolText` (the default, unchanged), `EnumValuesToolText`, `SchemaToolText` — the latter two measured within noise on one coarse server, in no default.
- **Observability:** `retrievalOutcome` counter (`ok`, `rerank_fallback`, `rerank_error`, `decompose_error`, `orphan`, `over_budget`, `empty`) on `InMemoryMetrics` / `NoopMetrics` and in `/health` metrics; a `retrieval` span per profiled retrieval; `/health` `components.toolCatalog.records` / `.profile` under a profile. `RerankedRetrieval` / `RerankAllRetrieval` accept an optional `telemetry` (additive).
- `scripts/rag-eval`: profile arms (`--variant`, or `--indexer` / `--facets` / `--discriminator` / `--max-values` / `--intents` / `--pool-items` / `--reranker none|decision`, `--decision-provider typesafe|sap-aicore` + `--rerank-deployment` / `--rerank-model` / `--rerank-credential-ref` / `--cut` / `--budget-tokens`), required-recall (`required` in the queries file: an AND of OR-groups), average items and prompt tokens.

### Fixed

- `vectorizeMcpTools` found no batch embedder behind `StrategyRag` (any `rag.retrieval.tools` entry) or `FallbackRag` and wrote the catalog one tool at a time; stores now declare `IRetrievalEmbedderOwner` (`VectorRag`, `QdrantRag`, `PgVectorRag`, `HanaVectorRag`) and the private-field read is gone (F1).
- `tools-rag-handle` returned a tool twice when two of its records matched (F2); `skill-select` read `skill:<name>:<suffix>` as the name `<name>:<suffix>` (F3).
- **SmartServer workers on the shared MCP clients** named colliding tools by array position (`s<i>__<tool>`, default namespace) while the main tools store — which a worker without its own `rag` searches — holds `<label>__<tool>` / `s<slotIndex>__<tool>`, so those hits were dropped. A worker's builder now gets the clients with their slot descriptors (and a worker's own `mcp:` connection keeps its descriptors across per-session re-wires) and the server's `IToolNamespace`: it exposes what the main catalog exposes. No collision and no custom namespace → names unchanged.

### Removed

- `packages/llm-agent/src/rag/tool-indexing-strategy.ts` (`IToolIndexingStrategy`, `OriginalToolIndexing`, `IntentToolIndexing`, `SynonymToolIndexing`) — never exported, never wired. Its docs described it as usable; they now describe collection profiles.

### Migration

- **Nothing changes unless you opt in.** No profile → the same records (pinned by a golden test), stages, k and YAML as before.
- **Renamed — old names kept as deprecated aliases until the next major:**

  | Old (30.1.0) | New | Import from |
  |---|---|---|
  | `IDecisionModel` | `IProbabilityDecision` | `@mcp-abap-adt/llm-agent` |
  | `DecisionReranker`, `DecisionRerankerOptions` | `ProbabilityReranker`, `ProbabilityRerankerOptions` | `@mcp-abap-adt/llm-agent-reranker` |
  | `DECISION_RERANK_DEFAULT_TASK`, `DECISION_RERANK_DEFAULT_CRITERIA` | `PROBABILITY_RERANK_DEFAULT_TASK`, `PROBABILITY_RERANK_DEFAULT_CRITERIA` | `@mcp-abap-adt/llm-agent-reranker` |
  | `wrapDecisionModel` | `wrapProbabilityDecision` | `@mcp-abap-adt/llm-agent-libs` |
  | `BuildAgentDeps.makeDecisionModel` | `BuildAgentDeps.makeProbabilityDecision` | `@mcp-abap-adt/llm-agent-server-libs` |
  | `LlmReranker`, `NoopReranker`, `TOOL_QUESTION`, `PASSAGE_QUESTION` from libs | same names | `@mcp-abap-adt/llm-agent-reranker` |

  What to do: switch imports and names at your pace; a class implementing `IDecisionModel` needs no change (same type). **Your own composition root:** rename the `BuildAgentDeps` key `makeDecisionModel` → `makeProbabilityDecision` (same function, same signature); until then `makeDecisionModel` keeps working, deprecated. Supplying **both** keys fails at startup with `BuildAgentDeps.makeDecisionModel and BuildAgentDeps.makeProbabilityDecision are both supplied` — remove `makeDecisionModel`. A missing seam now reads `BuildAgentDeps.makeProbabilityDecision is required`. Install `@mcp-abap-adt/llm-agent-reranker` next to `llm-agent-libs` (a new peer of libs). No behaviour changes.
- **Opting in on a persistent tools store** (Qdrant, pg-vector, HANA) needs a fresh collection — profile records sit beside 30.1.0 records otherwise. In-memory stores need nothing.
- **Under a profile, `rag.getById(itemId)` on the raw store finds nothing** — records are addressed by owner-scoped ids; use `bound.get({ itemId, owner })`. Returned items keep `metadata.id = itemId`, so name-based consumers are unaffected.
- **k counts items under a profile, and the caller's k caps every cut:** a default composition's `FixedItemsCut(n)` is a ceiling — a larger caller's k does not undo the measured cut, a smaller one still wins.
- **A failed stale-record cleanup is reported** (`failedItems` reason `cleanup-failed: …`) and retried by the next `index` / `remove` — not reported as indexed.
- **Shipping a tools corpus:** build it in your build step (`buildToolsCorpus`, serialized with `JSON.stringify`); for an in-memory store load it at start (`ToolsCorpusLoader`, YAML `fill: { corpus: … }`); for a persistent store write it in your deploy step (`deployToolsCorpus`) and bind it with `PrebuiltToolsStore` (YAML `fill: { prebuilt: … }`). The `profile` / `embedder` names must be the same in the build step and at run time — a mismatch fails at startup. A store is filled once; a changed tool list on a `corpus` / `prebuilt` store waits for the next build / deploy.
- **`ToolCatalogStatus` gains optional `records` / `profile`**, `MetricsSnapshot` optional `retrievalOutcome`, `HealthComponentStatus.toolCatalog` optional `records` / `profile` — an exhaustive object literal of these types needs no change.
- **`SmartServerDecisionConfig.provider` gains `'sap-aicore'`** (plus optional `deploymentId`, `resourceGroup`). Your own composition root's probability seam compiles unchanged (under either name); to serve Cohere, supply the new `BuildAgentDeps.makeRelevanceDecision` that builds `SapAiCoreRelevanceDecision` from a bearer credential and `apiBaseUrl` (the shipped binary does).
- **Intents are generated at every indexing** — the framework does not cache them; use a `StaticIntentSource` over a file generated at build time, a corpus built at build time (`buildToolsCorpus`), or your own caching `IToolIntentSource`.
- If you imported `tool-indexing-strategy.ts` by deep path: use `FacetedToolIndexer` (`full` record) and `IntentRecordIndexer` / `IntentCompanionIndexer` with `LlmIntentSource` instead.
```

- [ ] **Step 1b: package CHANGELOGs (seam rename, D30)**

`packages/llm-agent-server-libs/CHANGELOG.md`, above `## 30.1.0`:
```markdown
## Unreleased

`BuildAgentDeps.makeDecisionModel` is renamed **`makeProbabilityDecision`** (same type); `makeDecisionModel` stays a deprecated alias until the next major, and supplying both fails at startup naming both. New optional seam `BuildAgentDeps.makeRelevanceDecision` (`decision.provider: sap-aicore`); `rag.profiles.tools`, each bound tools store filled once at its creation by the configured `fill` source (`live` from the clients the server uses — ready clients, injected seam, plugin clients, YAML `mcp:` —, `corpus`, `prebuilt`, `consumer`, or `toolsFillFactories`), each with its own companion stores; workers on the shared clients now name tools as the main catalog does (fix); rerankers from `@mcp-abap-adt/llm-agent-reranker` (new peer). See the root CHANGELOG.
```
`packages/llm-agent-server/CHANGELOG.md`, above `## 30.1.0`:
```markdown
## Unreleased

Supplies `makeProbabilityDecision` (was `makeDecisionModel`; TypeSafe, default credential ref `DECISION`) and the new `makeRelevanceDecision` (`SapAiCoreRelevanceDecision`, default ref `DECISION` → `DECISION_SERVICE_KEY`); bundles `@mcp-abap-adt/sap-aicore-decision` and `@mcp-abap-adt/llm-agent-reranker`.
```

- [ ] **Step 2: `CLAUDE.md`**

- `## Architecture` provider paragraph: reword the `typesafe-decision` paragraph to `IProbabilityDecision` and add — `@mcp-abap-adt/sap-aicore-decision` is a provider package (`SapAiCoreRelevanceDecision`, Cohere Rerank on SAP AI Core as an `IRelevanceDecision`, adapted by `RelevanceReranker`): peers on `llm-agent` and `interfaces-auth`, a regular dependency of `llm-agent-server`; the binary's `makeRelevanceDecision` builds it for `decision.provider: sap-aicore`. And — `@mcp-abap-adt/llm-agent-reranker` holds every reranker (vendor-neutral; peer `llm-agent`); libs depends on it and re-exports the 30.1.0 names as deprecated aliases; retrieval strategies stay in libs and use rerankers through `IReranker`. Publish order: `llm-agent` → `llm-agent-reranker` → providers → … → `llm-agent-libs`.
- `### Key API notes`: add — `A probability and a relevance are different decisions: IProbabilityDecision (was IDecisionModel) vs IRelevanceDecision (scores, not probabilities). One decision: section; its provider decides the kind and reranker: decision builds ProbabilityReranker or RelevanceReranker.`
- `### Key API notes`: add —
  `- Collection profiles: builder.withToolsProfile(profile) or YAML rag.profiles.<key> (variant | compose); a key is under rag.retrieval OR rag.profiles. Under a profile k counts items, every returned item is its canonical record, and records are addressed by recordId(owner, itemId, kind, n) — never by the bare itemId`.
  `- A tools store is filled ONCE, when it is created (never refilled while running); where its records come from is an IToolsFillSource (live default | ToolsCorpusLoader for in-memory | PrebuiltToolsStore for persistent, written only by the consumer's deploy step via deployToolsCorpus | ConsumerToolsFill), attached with the binding (bindToolsProfile(profile, target, source)).`
- `### Key layers` table, `llm-agent-libs` row: append `, collection profiles (StagedRetrieval, ComposedToolsProfile, mcpToolsVariants, SharedItemsProfile)`.
- `## Environment` table: add `| DECISION_SERVICE_KEY | SAP AI Core service key of the decision: section with provider: sap-aicore and no credentialRef (Cohere Rerank, a relevance decision); read only when a decision reranker builds it |`, and widen the `DECISION_API_KEY` row's wording to "provider: typesafe".

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md packages/llm-agent-server-libs/CHANGELOG.md packages/llm-agent-server/CHANGELOG.md
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

- Spec issues S1–S9 are decided (spec §17.4) and done in their tasks (Tasks 3, 6, 9, 10, 11, 15, 19, 21, 23, 28, 29, 30); D24–D27, F1, F3, F4 (spec §17.6) in Tasks 4A–4C, 6, 8, 11, 12, 14, 15, 16, 18, 21–24, 30, 32–34; D28–D30 (spec §17.7) in Tasks 4A, 4C, 20A, 22–24, 33, 34; D31–D35 (spec §17.8, §17.9) in Tasks 19, 20, 22, 23, 23A, 32–34; D38–D40 (spec §17.10) in Task 23A (D36 superseded, D37 moved out); D41–D45 (spec §17.11) in Tasks 2, 11, 12, 19, 19A, 20, 23A, 23B, 33, 34; a new gap found while executing was taken to the user before any code (fix the spec before the plan).
- The renames left the old names as aliases only: `git grep -n -w "IDecisionModel\|DecisionReranker\|wrapDecisionModel\|makeDecisionModel" -- packages/*/src ':!**/__tests__/**'` prints only the alias declarations (`decision-model.ts`, libs `index.ts`, `usage-logging-decision-model.ts`, the `@deprecated` `BuildAgentDeps.makeDecisionModel` and `probabilityDecisionSeam` in `smart-server.ts`) and `typesafe-decision` (unchanged, it implements the same type); `git grep -n "createMakeDecisionModel\|make-decision-model" -- packages` prints nothing; `git grep -n "SapAiCoreDecisionModel" -- packages docs` prints nothing.
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
| S9 | "At most k" contradicted `FixedItemsCut` | The kit checks at most `cut.limit(k)` items — amended by F1: `cut.limit(k)` ≤ k for every cut, so the kit checks ≤ k, also for k below each shipped profile's default | Tasks 6, 12, 14, 30 |
| — | Spec header "Status" line | Updated: every decision is taken (D16, D18, D22, D23 included) | spec header |

## Decided by the user on 2026-10-05 — decisions split, reranker package, review findings (spec §17.6)

| # | Decision | Done in |
|---|---|---|
| D24 | Probability vs relevance: `IProbabilityDecision` (rename + alias), `IRelevanceDecision`; `ProbabilityReranker` (rename + aliases), `RelevanceReranker` | Tasks 4A, 4B, 4C |
| D25 | Packages by role: `typesafe-decision` unchanged; `sap-aicore-decision` = `SapAiCoreRelevanceDecision` (`IRelevanceDecision`); `SapAiCoreDecisionModel` withdrawn | Task 18, 24 |
| D26 | All rerankers in the new `@mcp-abap-adt/llm-agent-reranker`; libs re-exports old names as deprecated aliases | Task 4B (4C adds `RelevanceReranker`) |
| D27 | One `decision:` section; the provider decides the kind (`DECISION_KINDS`); `reranker: decision` builds the matching reranker; wording refused for relevance | Tasks 21, 22, 23, 24, 32 |
| F1 | The caller's k caps every cut (`FixedItemsCut` is a ceiling), also after decomposition; the kit calls each shipped profile with k below its default | Tasks 6, 12, 14, 16, 30 |
| F3 | Cleanup failures kept: every stale delete checked; `cleanup-failed`; `staleRecordIds` / `staleCompanionRecordIds` retried by `index` / `remove` | Tasks 2–3 (reserved keys), 11, 15, 30 |
| F4 | Provider text composition is a strategy (`IToolTextComposer`); the default stays C0 (measured); C0e / C0s in no default | Tasks 3, 8, 10, 16, 21, 22, 32 |

**Withdrawn:** `SapAiCoreDecisionModel` (Cohere behind `IDecisionModel`, amendment 3) — never built. Still gone from earlier: the `sap-aicore-reranker` package, `SapAiCoreReranker`, the `crossEncoder:` section and the `makeCrossEncoder` seam.

**Choices made while writing these in** are listed for the user's review in spec §17.5 — `{index, score}` relevance results, `DecisionError` reused, and others; the second seam and the batching question were decided on 2026-10-05 (below).

## Decided by the user on 2026-10-05 — relevance comparability, the second seam, the seam rename (spec §17.7)

| # | Decision | Done in |
|---|---|---|
| D28 | Relevance scores are comparable for the same query and model (a cross-encoder scores each pair independently) — written into the `IRelevanceDecision` docs; `RelevanceReranker` batches by default like `ProbabilityReranker` (`maxBatchTokens` 48000, `concurrency` 4, same validation), the batches' scores merged into one order by score; no single-call default | Tasks 4A, 4C, 16, 18, 24, 33, 34 |
| D29 | The second optional seam `makeRelevanceDecision` is approved | Tasks 22, 23, 24 |
| D30 | `BuildAgentDeps.makeDecisionModel` → `makeProbabilityDecision` (deprecated alias kept; both supplied → startup error naming both; the missing-seam message names the new seam); the app's `createMakeDecisionModel` → `createMakeProbabilityDecision` (`make-probability-decision.ts`) | Tasks 20A, 22, 23, 24, 25, 33, 34, 35 |

## Decided by the user on 2026-10-05 — the server fills a bound profile (spec §17.8)

| # | Decision | Done in |
|---|---|---|
| D31 | The server fills a bound tools profile from the MCP clients it uses (ready clients, injected seam, plugin clients), once per store, before it reports ready, through `fillToolsBinding` (the profile path of `vectorizeMcpTools`); `/health` and the D23 check read its status (`HealthCheckerDeps.toolCatalog`); failures follow the 30.1.0 catalog policy; workers reading the main store are not filled again; no profile → 30.1.0. The builder keeps its `withMcpClients` / `withMcpServers` limit | Tasks 23A, 33, 34 |
| D32 | A worker's fill keeps the identity its agent dispatches by: from the shared clients with the main fill's `_sharedMcpClientDescriptors` / `_configuredSlotCount` / `IToolNamespace`; own `mcpClients` in array order (no descriptors exist); the worker's builder gets the clients with their descriptors (`withMcpServers` + `connectedMcpServer`) and the server's `withToolNamespace`. No contract change; fixes 30.1.0 workers' `s<i>__` names. *For the user's review:* the adapter over a `withMcpClients` descriptors parameter | Tasks 23A, 33, 34 |
| D33 | Companion storage per primary binding: `ResolvedToolsProfile.companionStores` (sections), the server builds one companion store per bound tools store with that store's embedder; readers share the main binding; no `recordId` change. *For the user's review:* a persistent companion store with a worker's own `rag` is refused at start (no derived collection names) — recommendation applied (spec §17.9) | Tasks 22, 23, 23A, 33, 34 |

## Review findings on 2026-10-05 — filling follows the store's lifecycle (spec §17.9)

(a) `McpToolRegistry.revectorizeTools` passed no binding, so a reconnect refilled a profiled store with 30.1.0 records and skipped a writerless binding; (b) workers were filled only in `_buildInfra`, so `PUT /v1/config` and hot reload rebuilt workers with empty bound stores. Fixed by the principle, not the two call sites; every fill path is audited in spec §6.4.

| # | Decision | Done in |
|---|---|---|
| D34 | The binding travels with the store: `vectorizeMcpTools` reads it with `toolsBindingOf(toolsRag)` (through decorators) and has no `binding` option; every caller — the builder's fill, `revectorizeTools` on `toolsChanged`, `fillToolsBinding`, `rag-eval` — gets the profile path from the store (writer not required), an unbound store gets exactly 30.1.0. `fillToolsBinding` keeps its typed `binding` parameter and rejects a binding its store does not carry. Tests: `toolsChanged` with updated + new tools, companions updated, a writerless binding refreshed, a store behind `FallbackRag` | Tasks 19, 20, 23A, 32, 33, 34 |
| D35 | Whoever creates a bound store fills it: the main store in `_buildInfra`; a worker's own store in `buildSubAgent`, before `subBuilder.build()`, from the clients that builder is handed (primary build: the shared clients with their descriptors once known) — so startup, a lazy rebuild, `PUT /v1/config` and hot reload all fill it. `fillWorkerToolsStores` is gone; *amended by D41: only the worker's construction fills — no memo, no retry, a re-wire never fills*; reader workers never filled; `/health` = the main catalog, a worker's fill logged. Tests (9) `PUT /v1/config`, (10) hot reload | Tasks 23A, 33 |

## Decided by the user on 2026-10-05 — fill memo, single-flight, startup fill, direct reload (spec §17.10)

| # | Decision | Done in |
|---|---|---|
| D36 | *Superseded by D41 — withdrawn; its tests (11), (12) are replaced.* Only complete fills are memoized: a fill in flight is shared per binding; one resolving `complete: false` (index Result failure, `listTools` client failures) or aborted, or rejecting, is evicted, so the worker's next build or re-wire retries it — no timers, no retry loops. Builder-filled bindings are marked only when complete. Tests (11) index failure → success on the next build of the same binding, (12) `listTools` failure → recovery | Task 23A |
| D37 | *Moved out by D45 — Task 22A and test (13) deleted; a separate issue (spec §15).* Single-flight worker construction (`WorkerRegistry.resolve`; the construction builds into its own map and publishes once; drain rule: a construction publishes only into the generation it started in — one overtaken by a drain closes what it built, its waiters resolve in the current generation, and `drain()` awaits it). A pre-existing 30.1.0 in-process race, not a RAG protocol: concurrent persistent-store writes stay the backend's. Tests: the registry unit test (Task 22A); (13) two simultaneous first sessions after a drain → one construction, one fill | Tasks 22A, 23A, 34 |
| D38 | Workers on the shared clients are filled at startup on every path; on `yamlBuilderConnect` one pass right after the harvest (`fillSharedClientWorkerStores`). Startup filling concerns only `tools` (S8); runtime-changing collections are written by pipeline elements during work or stay 30.1.0 (goal 8) | Task 23A (+ the D38 test in `mcp-yaml-vectorization.test.ts`) |
| D39 | The hot-reload test calls the server's reload entry point (`_configReload._onReload`, now awaitable) instead of `fs.watch` + debounce polling; `config-reload-entry.test.ts` pins that the watcher's `reload` event calls it | Task 23A |
| D40 | Tools a server removes at runtime (`notifications/tools/list_changed` → `toolsChanged`) stay in the store, as in 30.1.0; removal out of scope (spec note only) | spec §6.3, §15 — no code |

Recommendations applied to the earlier open choices (the user may still overrule): a persistent companion store with a worker-owned `rag` is refused at startup (Task 23); the internal `connectedMcpServer` adapter is kept — no `withMcpClients` change (Task 23A); the worker tool-naming fix is a CHANGELOG "Fixed" entry (Task 34).

## Decided by the user on 2026-10-05 — fill once at creation; the fill source is a strategy; refill and single-flight out (spec §17.11)

| # | Decision | Done in |
|---|---|---|
| D41 | A tools store is filled once, when its instance is created; never refilled while running. The main store in `_buildInfra`; a worker's own store by its construction (`buildSubAgent` without `injected`); a per-session re-wire never fills. No refill API, no memo, no retry; an incomplete fill is reported and stays. A construction whose fill throws drops the worker's cache entry. Tests: (11) a re-wire never fills after a failed listing; (12) a throwing fill leaves no cached worker | Task 23A |
| D42 | The fill source is a strategy: `IToolsFillSource` / `ToolsFillContext` (llm-agent), attached with the binding (`bindToolsProfile(profile, target, source?)`, default `LiveToolsFill`) and read from the store; `vectorizeMcpTools` dispatches `fill` / `toolsChanged`; `LiveToolsFill`, `ConsumerToolsFill`, `ToolsCorpusLoader`, `PrebuiltToolsStore`; `withToolsProfile(profile, source?)`; YAML `fill` + `toolsFillFactories` | Tasks 19, 19A, 20, 23B, 33, 34 |
| D43 | Offline corpus API: `buildToolsCorpus` (build step, the profile's own indexer over capture stores), `parseToolsCorpus`, `deployToolsCorpus` (deploy step: precomputed, in place, idempotent, write-ahead, a `tools-corpus` service record); reserved key `serviceRecord`, dropped by `StagedRetrieval`. `ToolsCorpusLoader` — the in-memory source — checks the fingerprint, writes the records precomputed and reports the status, nothing else | Tasks 2, 11, 12, 19A, 33, 34 |
| D44 | `toolsChanged` is the source's answer: `live` / `consumer` re-index as 30.1.0; `corpus` / `prebuilt` write nothing and log a warning | Tasks 19, 19A |
| D45 | Single-flight worker construction and the drain ordering move out (a pre-existing 30.1.0 race; spec §15 describes it for a separate issue). Task 22A deleted; no remaining task depends on it — Task 23A goes back to `WorkerRegistry.build`'s existing lazy build-on-miss | Task 23A (references removed) |

---

## Self-review (done while writing)

- **Spec coverage.** §3 contracts → Tasks 2–4 (S1 / S6 capabilities and the S7 / F3 reserved keys in 2–3); §3.9 decision contracts → 4A; §4 `StagedRetrieval` → 12–14 (+28 telemetry, incl. `over_budget`; F1 cap in 12 and 14); §4.9/§4.10 cuts → 6 (F1); §5 rerankers → 4B (package, `ProbabilityReranker`), 4C (`RelevanceReranker`), 18 (`SapAiCoreRelevanceDecision`), 16 (the decision variants), 24 (`createMakeRelevanceDecision` + calls → `/rerank`); §6.1 builder → 20; the probability seam rename with its alias (§3.8, §13, D30) → 20A; §6.2 YAML → 21–23 (one `decision:` section, kind table, the `makeRelevanceDecision` seam); §6.3 server filling from ready clients (D31) → 23A, a worker's fill and dispatch keep one identity (D32) → 23A, the binding read from the store on every fill incl. `toolsChanged` (D34) → 19 (+20, 23A, 32), workers filled by their construction — startup, lazy rebuild, `PUT /v1/config`, hot reload (D35, D41) → 23A; filled once, no memo, no retry, a re-wire never fills (D41) → 23A; startup fill on `yamlBuilderConnect` (D38), the hot reload through the reload entry point (D39) → 23A; §3.10 fill sources (D42, D44) → 19 (contract, live, consumer, dispatch), 19A (corpus loader, prebuilt), 20 (builder), 23B (YAML); §6.5 offline corpus (D43) → 19A (+ `serviceRecord` in 2, 11, 12); single-flight construction (D37) → moved out (D45, spec §15), no task; only `tools` gets a fill source (§6.6) and runtime-removed tools stay (D40) → no code, spec notes; §6.4 fill-path audit → rows 1/3/10 in 19, rows 4–7 and 5a in 23A, rows 11–12 in 19A, row 9 in 33; §7.3.3 companion storage per primary binding (D33) → 22 (sections), 23 (a store per binding, persistent refusal), 23A (isolation through fill, replace, remove); §7.3.1 provider text composers → 8 (F4); §3.3 cleanup failures → 11, 15 (F3); §7.0–§7.5 tools strategies and variants → 7–10, 15, 16; §7.6 filling → 19 (notes logged); §7.7 skills pass-through → 12 (pass-through test), 26 (F3); §7.8 migration → 33/34 docs; §7.9 consumer-built profile → 30; §8 shared items → 17; §9 observability → 28–29 (S4: telemetry only on 30.1.0 strategies); §10 fixes → 25–27; §11 placement → File Structure, Task 18 wiring; §13 compatibility/docs → 1 (golden), 33–34; §14.1 unit tests → per task; §14.2 kit → 30 (S9); §14.3 harness → 31–32 (acceptance runs = consumer check, env-gated).
- **Placeholders.** None; no gated step remains.
- **Type consistency.** `StagedRetrievalOptions` (Task 12) is the shape Tasks 15–17, 22 and 30 pass; `ComposedToolsProfile.composition` (Task 15) is what Tasks 16, 22, 30 inspect; `IBoundCollection<ToolItem>` + `bindToolsProfile` / `toolsBindingOf` (Task 15; `source` and `boundToolsOf` from Task 19) are what Tasks 19, 19A, 20, 23, 23A, 23B and 32 use — every tools write reads the binding and its fill source from the store (D34, D42), and no task passes either beside its store; `IToolsFillSource` / `ToolsFillContext` (Task 19) are what Tasks 19A, 20, 23B implement or pass; `ToolsCorpus` / `ToolsCorpusIdentity` (Task 19A) are what Task 23B parses and constructs; `ResolvedToolsProfile.fill` (Task 23B) is what `withToolsStore` binds with; **cumulative compile:** Task 19 adds the contract (llm-agent) before libs uses it; 19A only appends to Task 19's module; 23A uses only Task 19's default source; 23B adds the config field, resolver output and server use in one task; `ToolCatalogStatus.records/profile` (Task 3) feed Tasks 19 and 29; `RunStats` (Task 12) is what Task 28 reports; `CompanionIds` / `listedCompanions` and `storeItems(rag, items, options, companions)` (Task 11) are what Tasks 15 and 17 use; `IProbabilityDecision` / `IRelevanceDecision` (Task 4A) are what Tasks 4B, 4C, 16, 18, 22, 24, 32 take; `SapAiCoreRelevanceConfig` (Task 18) is what Task 24 constructs; `SmartServerDecisionConfig` + `DECISION_KINDS` (Task 21) are what Tasks 22 and 24 read; `BuildAgentDeps.makeProbabilityDecision` and `createMakeProbabilityDecision` (Task 20A) are what Tasks 22–25 use (the alias `makeDecisionModel` is read only by Task 20A's `probabilityDecisionSeam`); `DecisionSeams` (Task 22) is what Task 23 threads; `ResolvedToolsProfile.companionStores` (store sections, Task 22) is what Task 23's `withToolsStore` builds one companion store per binding from; `mcpToolsVariants.facetedCohere({ relevanceDecision })` / `facetedJev({ probabilityDecision })` / `smallSetJev({ probabilityDecision, poolItems })` (Task 16) are what Tasks 22, 30 and 32 call.
- **Review Focus.** Each of the eight lines has its test in the named task (Tasks 4C, 6, 11, 12, 13, 14, 17, 18, 21, 30).
