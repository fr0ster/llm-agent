# Controller Planner — Phase 1: Identity & Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (LIBRARY FOUNDATION ONLY):** Ship the durable identity + artifact
foundation the rest of the controller-planner spec builds on — as **types,
helpers, and a pure reconstruction function with unit tests**. Specifically:
stable `Step.stepId`; the metadata FIELDS + filter predicate for `plan-decision`
/ `step-start` / `step-result.digest`; the `plan-decision` and `step-start`
write/read helpers; and `reconstructBoard` (3 of the 4 sources; `chain-outcome`
source-4 lands in Phase 4). **Explicit non-goal:** Phase 1 does NOT make the live
controller PRODUCE these artifacts — the handler still writes `step-result`
WITHOUT `stepId`/`digest` (`controller-coordinator-handler.ts:~1040`), the planner
does not yet assign `stepId`, and the reviewer does not yet return a `digest`.
That PRODUCTION wiring is Phase 2+ (reviewer returns digest, planner assigns
stepId, handler writes `plan-decision`/`step-start`/digest). So `reconstructBoard`
is validated against SYNTHETIC artifacts here; it cannot reconstruct a real run
until Phase 2 wires production.

**Architecture:** Append-only `KnowledgeBackend` artifacts (existing
`be.put(sessionId,{content,metadata})` + `rag.list({runId,artifactType})`
pattern). New artifacts carry deterministic content-hash ids. The board is a
DERIVED projection rebuilt from artifacts + the bundle's in-flight state, with the
spec's §F attempt-scoped resolution. **NO handler behaviour change in Phase 1** —
pure types/helpers/reconstruction + unit tests; the handler is wired in Phase 2.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), `node:test` via `tsx`, Biome, `node:crypto` `createHash` (NO new `uuid` dependency — the spec's `uuidv5(...)` is realised as a deterministic sha256-based id, matching `run-scope.ts`).

**Spec:** `docs/superpowers/specs/2026-06-14-controller-planner-design.md` §A (digest field), §E (step-state set), §F (identity, plan-decision kind table, claim, attempt-scoped board resolution).

---

## File structure

- **Modify** `packages/llm-agent/src/interfaces/knowledge-rag.ts` — extend `KnowledgeEntryMetadata` + `KnowledgeFilter` with the new optional artifact fields (`stepId`, `decisionId`, `slotId`, `kind`, `digest`, `supersedesStepId`). Core contracts package; lowest layer, built first.
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` — `Step` gains `stepId`, `discovery?`, `supersedesStepId?`.
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts` — add `projectStepState` (settled `Outcome.status` → board terminal state).
- **Create** `packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts` — `deterministicId`, the `plan-decision` kind table (`decisionId`/`slotId`), `PlanDecision` + `StepStartClaim` types, and their write/read helpers.
- **Create** `packages/llm-agent-server-libs/src/smart-agent/controller/board.ts` — `BoardEntry`, the step-state set, and `reconstructBoard` (sources 1–3, attempt-scoped).
- **Create** tests alongside: `controller/__tests__/artifacts.test.ts`, `controller/__tests__/board.test.ts`; extend `controller/__tests__/outcome.test.ts`, `controller/__tests__/types.test.ts`.

> **Build note:** `knowledge-rag.ts` is in the lowest package (`@mcp-abap-adt/llm-agent`). After editing it, run `npm run build` before the server-libs tests so the workspace import resolves (per the build-before-dev rule). Each task that edits a lower package says so.

---

### Task 1: Extend the artifact metadata contract + the filter predicate

> Adding fields to `KnowledgeFilter` is INERT unless the `matches()` predicate
> (`packages/llm-agent-libs/src/rag/knowledge-rag.ts`) honours them — today it
> checks only traceId/turnId/stepperId/parentStepperId/toolName/artifactType/
> runId/seq/attempt/status. A `list({ slotId })` would silently ignore `slotId`.
> So this task updates BOTH the contract (core) AND the predicate (libs), with a
> test that proves the new filters actually filter.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/knowledge-rag.ts` (the types)
- Modify: `packages/llm-agent-libs/src/rag/knowledge-rag.ts` (the `matches()` predicate)
- Test: `packages/llm-agent/src/interfaces/__tests__/knowledge-rag-meta.test.ts` (create, type-level)
- Test: `packages/llm-agent-libs/src/rag/__tests__/matches-board-filters.test.ts` (create, predicate)

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KnowledgeEntryMetadata, KnowledgeFilter } from '../knowledge-rag.js';

test('KnowledgeEntryMetadata carries the controller board-identity fields', () => {
  const m: KnowledgeEntryMetadata = {
    traceId: 't', turnId: 't', stepperId: 'controller', task: 'controller',
    artifactType: 'plan-decision', createdAt: 'now',
    stepId: 's1', decisionId: 'd1', slotId: 'run|create', kind: 'create',
    digest: 'the include list', supersedesStepId: 's0',
  };
  assert.equal(m.stepId, 's1');
  assert.equal(m.kind, 'create');
  const f: KnowledgeFilter = { runId: 'r', artifactType: 'plan-decision', slotId: 'run|create' };
  assert.equal(f.slotId, 'run|create');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx/esm --test packages/llm-agent/src/interfaces/__tests__/knowledge-rag-meta.test.ts`
Expected: FAIL — `stepId`/`decisionId`/`slotId`/`kind`/`digest`/`supersedesStepId` are not on the types (TS compile error under tsx).

- [ ] **Step 3: Add the fields**

In `KnowledgeEntryMetadata` (after `writeOrdinal`):

```ts
  /** Stable plan-time step identity (controller board). 1:1 with a board entry;
   *  retries share it, a replan-replacement gets a new one + `supersedesStepId`. */
  stepId?: string;
  /** A replan-replacement step's superseded predecessor (§F). */
  supersedesStepId?: string;
  /** Content-hash id of a `plan-decision` (dedup / canonical selection, §F). */
  decisionId?: string;
  /** The decision SLOT a `plan-decision`/`step-start` claim occupies (§F). */
  slotId?: string;
  /** `plan-decision` kind: 'create' | 'replan' | 'expand' | 'page'. */
  kind?: string;
  /** The reviewer's planning-relevant digest, persisted on `step-result` so the
   *  board's per-step digest is reconstructible from artifacts (§A/§F). */
  digest?: string;
```

In `KnowledgeFilter` (after `status`): add `stepId?: string; decisionId?: string; slotId?: string; kind?: string;`

- [ ] **Step 4: Failing predicate test** — `matches-board-filters.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matches } from '../knowledge-rag.js';
import type { KnowledgeEntryMetadata } from '@mcp-abap-adt/llm-agent';

const m: KnowledgeEntryMetadata = {
  traceId: 't', turnId: 't', stepperId: 'controller', task: 'controller',
  artifactType: 'plan-decision', createdAt: 'now',
  stepId: 's1', decisionId: 'dA', slotId: 'slot1', kind: 'create',
};
test('matches() honours the new board-identity filters', () => {
  assert.equal(matches(m, { slotId: 'slot1' }), true);
  assert.equal(matches(m, { slotId: 'slotX' }), false);
  assert.equal(matches(m, { decisionId: 'dA' }), true);
  assert.equal(matches(m, { decisionId: 'dB' }), false);
  assert.equal(matches(m, { stepId: 's1' }), true);
  assert.equal(matches(m, { stepId: 's2' }), false);
  assert.equal(matches(m, { kind: 'create' }), true);
  assert.equal(matches(m, { kind: 'replan' }), false);
  // combined still ANDs with existing fields
  assert.equal(matches(m, { artifactType: 'plan-decision', slotId: 'slot1' }), true);
  assert.equal(matches(m, { artifactType: 'step-result', slotId: 'slot1' }), false);
});
```

- [ ] **Step 5: Run → fail** (matches ignores the new fields → `slotX`/`dB`/`s2`/`replan` cases wrongly return true).

Run: `node --import tsx/esm --test packages/llm-agent-libs/src/rag/__tests__/matches-board-filters.test.ts`
Expected: FAIL.

- [ ] **Step 6: Update `matches()`** (`packages/llm-agent-libs/src/rag/knowledge-rag.ts`, before `return true;`):

```ts
  if (f.stepId !== undefined && m.stepId !== f.stepId) return false;
  if (f.decisionId !== undefined && m.decisionId !== f.decisionId) return false;
  if (f.slotId !== undefined && m.slotId !== f.slotId) return false;
  if (f.kind !== undefined && m.kind !== f.kind) return false;
```

- [ ] **Step 7: Build + run both tests → pass**

Run: `npm run build` then both: the core meta test AND `matches-board-filters.test.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/knowledge-rag.ts \
        packages/llm-agent/src/interfaces/__tests__/knowledge-rag-meta.test.ts \
        packages/llm-agent-libs/src/rag/knowledge-rag.ts \
        packages/llm-agent-libs/src/rag/__tests__/matches-board-filters.test.ts
git commit -m "feat(knowledge-rag): board-identity metadata fields + matches() predicate (stepId/decisionId/slotId/kind/digest/supersedesStepId)"
```

---

### Task 2: `Step` gains stable identity fields

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts:13-20`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/types.test.ts`

- [ ] **Step 1: Add a failing test** to `types.test.ts`:

```ts
import type { Step } from '../types.js';
test('Step carries stable stepId + optional discovery/supersedes', () => {
  const s: Step = {
    stepId: 's1', name: 'Fetch', instructions: 'read it',
    discovery: true, supersedesStepId: 's0',
  };
  assert.equal(s.stepId, 's1');
  assert.equal(s.discovery, true);
  assert.equal(s.supersedesStepId, 's0');
});
```

- [ ] **Step 2: Run → fail** (`stepId`/`discovery`/`supersedesStepId` not on `Step`).

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/types.test.ts`
Expected: FAIL (compile).

- [ ] **Step 3: Extend `Step`** (`types.ts`), keeping existing fields:

```ts
export interface Step {
  /** Stable plan-time identity (§F). 1:1 with a board entry; assigned at
   *  create-plan or fan-out. Optional only so older call-sites compile during
   *  the migration; the planner/handler always set it. */
  stepId?: string;
  name: string;
  instructions: string;
  type?: string;
  /** Marks a discovery step whose result enumerates remaining work (§D). */
  discovery?: true;
  /** When this step REPLACES a failed step on replan, the superseded `stepId` (§F). */
  supersedesStepId?: string;
  requires?: string[];
}
```

- [ ] **Step 4: Run → pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/types.test.ts
git commit -m "feat(controller/types): Step gains stepId/discovery?/supersedesStepId? (board identity)"
```

---

### Task 3: `deterministicId` helper

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts`
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts`

- [ ] **Step 1: Failing test** (`artifacts.test.ts`):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deterministicId } from '../artifacts.js';

test('deterministicId is stable + order-sensitive + collision-resistant on segments', () => {
  assert.equal(deterministicId('run1', 'create'), deterministicId('run1', 'create'));
  assert.notEqual(deterministicId('run1', 'create'), deterministicId('run1', 'replan'));
  // segment boundary is unambiguous: ['a','bc'] !== ['ab','c']
  assert.notEqual(deterministicId('a', 'bc'), deterministicId('ab', 'c'));
});
```

- [ ] **Step 2: Run → fail** (module missing).

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts`
Expected: FAIL — cannot find `../artifacts.js`.

- [ ] **Step 3: Implement** (`artifacts.ts`):

```ts
import { createHash } from 'node:crypto';

/** Deterministic content-hash id (the spec's `uuidv5(...)` realised without a
 *  new dependency — matches run-scope.ts's createHash usage). Segments are
 *  length-prefixed so no concatenation collision is possible
 *  (['a','bc'] and ['ab','c'] hash differently). */
export function deterministicId(...segments: (string | number)[]): string {
  const h = createHash('sha256');
  for (const s of segments) {
    const str = String(s);
    h.update(String(str.length));
    h.update('\u0000');
    h.update(str);
  }
  return h.digest('hex');
}
```

- [ ] **Step 4: Run → pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts
git commit -m "feat(controller/artifacts): deterministicId (length-prefixed sha256 content-hash id)"
```

---

### Task 4: `projectStepState` — settled Outcome → board terminal state

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts`

> Distinct from the existing `mapOutcome` in the handler (which returns the PLANNER
> TRANSITION `advanced|failed|partial`). The board needs the §E STEP STATE
> `done|partial|failed` (ok/exists both → `done`).

- [ ] **Step 1: Failing test** (append to `outcome.test.ts`):

```ts
import { projectStepState } from '../outcome.js';
test('projectStepState maps a settled outcome to the board terminal state', () => {
  assert.equal(projectStepState('ok'), 'done');
  assert.equal(projectStepState('exists'), 'done');
  assert.equal(projectStepState('partial'), 'partial');
  assert.equal(projectStepState('failed'), 'failed');
});
```

- [ ] **Step 2: Run → fail** (`projectStepState` not exported).

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (append to `outcome.ts`):

```ts
/** Board terminal state for a SETTLED step (§E): ok/exists → done; partial →
 *  partial; failed → failed. (NOT the planner transition `advanced|...`.) */
export type SettledStepState = 'done' | 'partial' | 'failed';
export function projectStepState(status: Outcome['status']): SettledStepState {
  if (status === 'ok' || status === 'exists') return 'done';
  return status; // 'partial' | 'failed'
}
```

- [ ] **Step 4: Run → pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts
git commit -m "feat(controller/outcome): projectStepState (settled Outcome → board done|partial|failed)"
```

---

### Task 5: `plan-decision` — kind-specific decisionId/slotId + type

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts`

> The §F kind table. Phase 1 only WRITES `create`/`replan`; `expand`/`page` are
> defined here (pure computation) but exercised in Phase 4.

- [ ] **Step 1: Failing test** (append):

```ts
import { decisionSlotId, decisionId } from '../artifacts.js';
test('decisionSlotId follows the §F kind table', () => {
  assert.equal(decisionSlotId({ kind: 'create', runId: 'r' }),
    deterministicId('r', 'create'));
  assert.equal(decisionSlotId({ kind: 'replan', runId: 'r', anchor: 'sX' }),
    deterministicId('r', 'replan', 'anchor', 'sX'));
  assert.equal(decisionSlotId({ kind: 'replan', runId: 'r', triggerId: 'tg' }),
    deterministicId('r', 'replan', 'trigger', 'tg'));
  // anchor vs trigger never collide (discriminator segment)
  assert.notEqual(decisionSlotId({ kind: 'replan', runId: 'r', anchor: 'x' }),
    decisionSlotId({ kind: 'replan', runId: 'r', triggerId: 'x' }));
  assert.equal(decisionSlotId({ kind: 'expand', runId: 'r', discoveryStepId: 'd', offset: 5 }),
    deterministicId('r', 'expand', 'd', 5));
  assert.equal(decisionSlotId({ kind: 'page', runId: 'r', discoveryChainId: 'c', pageIndex: 2 }),
    deterministicId('r', 'page', 'c', 2));
});
test('decisionId folds plannerOutput for LLM-authored kinds, omits it for page', () => {
  const a = decisionId({ kind: 'create', runId: 'r' }, 'PLAN-A');
  const b = decisionId({ kind: 'create', runId: 'r' }, 'PLAN-B');
  assert.notEqual(a, b); // content-hash includes plannerOutput
  // page is deterministic: plannerOutput ignored, tokenHash folded instead
  const p = decisionId({ kind: 'page', runId: 'r', discoveryChainId: 'c', pageIndex: 2, tokenHash: 'th' }, 'ignored');
  assert.equal(p, deterministicId('r', 'page', 'c', 2, 'th'));
});
```

- [ ] **Step 2: Run → fail.** Same command. Expected: FAIL.

- [ ] **Step 3: Implement** (append to `artifacts.ts`):

```ts
export type DecisionKey =
  | { kind: 'create'; runId: string }
  | { kind: 'replan'; runId: string; anchor: string }
  | { kind: 'replan'; runId: string; triggerId: string }
  | { kind: 'expand'; runId: string; discoveryStepId: string; offset: number }
  | { kind: 'page'; runId: string; discoveryChainId: string; pageIndex: number; tokenHash: string };

/** Slot the decision occupies (one winner per slot, §F). */
export function decisionSlotId(k: DecisionKey): string {
  switch (k.kind) {
    case 'create': return deterministicId(k.runId, 'create');
    case 'replan':
      return 'anchor' in k
        ? deterministicId(k.runId, 'replan', 'anchor', k.anchor)
        : deterministicId(k.runId, 'replan', 'trigger', k.triggerId);
    case 'expand': return deterministicId(k.runId, 'expand', k.discoveryStepId, k.offset);
    case 'page': return deterministicId(k.runId, 'page', k.discoveryChainId, k.pageIndex);
  }
}

/** Content-hash decision id. LLM-authored kinds fold `plannerOutput` (identical
 *  output → identical id → dedup; differing → different id). The controller-
 *  authored `page` is deterministic from its key fields + tokenHash (no
 *  plannerOutput). (§F: at-least-once invocation, exactly-once applied effect.) */
export function decisionId(k: DecisionKey, plannerOutput: string): string {
  switch (k.kind) {
    case 'create': return deterministicId(k.runId, 'create', plannerOutput);
    case 'replan':
      return 'anchor' in k
        ? deterministicId(k.runId, 'replan', 'anchor', k.anchor, plannerOutput)
        : deterministicId(k.runId, 'replan', 'trigger', k.triggerId, plannerOutput);
    case 'expand': return deterministicId(k.runId, 'expand', k.discoveryStepId, k.offset, plannerOutput);
    case 'page': return deterministicId(k.runId, 'page', k.discoveryChainId, k.pageIndex, k.tokenHash);
  }
}
```

- [ ] **Step 4: Run → pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts
git commit -m "feat(controller/artifacts): plan-decision kind table (decisionSlotId/decisionId per §F)"
```

---

### Task 6: `plan-decision` write/read helpers

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts`

- [ ] **Step 1: Failing test** (append; uses a tiny in-memory backend stub):

```ts
import { writePlanDecision, readPlanDecisions, type PlanDecision } from '../artifacts.js';

function fakeBackend() {
  const rows: { content: string; metadata: Record<string, unknown> }[] = [];
  return {
    rows,
    put: async (_sid: string, e: { content: string; metadata: Record<string, unknown> }) => { rows.push(e); },
    list: async (f: { runId?: string; artifactType?: string }) =>
      rows.filter((r) => (!f.runId || r.metadata.runId === f.runId) &&
        (!f.artifactType || r.metadata.artifactType === f.artifactType)),
  };
}

test('writePlanDecision persists kind/decisionId/slotId + steps; readPlanDecisions returns them', async () => {
  const be = fakeBackend();
  const dec: PlanDecision = {
    runId: 'r', kind: 'create',
    steps: [{ stepId: 's1', name: 'Fetch', instructions: 'read' }],
  };
  await writePlanDecision(be as never, 'sess', dec, 'PLAN-A', 'now', 1);
  const got = await readPlanDecisions(be as never, 'r');
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'create');
  assert.equal(got[0].slotId, deterministicId('r', 'create'));
  assert.equal(got[0].decisionId, deterministicId('r', 'create', 'PLAN-A'));
  assert.equal(got[0].steps[0].stepId, 's1');
});
```

- [ ] **Step 2: Run → fail.** Same command. Expected: FAIL.

- [ ] **Step 3: Implement** (append to `artifacts.ts`):

```ts
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import type { IKnowledgeRagHandle } from '@mcp-abap-adt/llm-agent';
import type { Step } from './types.js';

export const PLAN_DECISION_ARTIFACT = 'plan-decision';

/** PlanDecision is a DISCRIMINATED UNION by kind, so the required key fields are
 *  type-enforced (a `page` MUST carry `tokenHash`, an `expand` MUST carry
 *  `discoveryStepId`+`offset`, etc.) — no silent empty-default. `decisionId`/
 *  `slotId` are resolved on READ (computed on write). */
export type PlanDecision = { steps: Step[]; decisionId?: string; slotId?: string } & (
  | { kind: 'create'; runId: string }
  | { kind: 'replan'; runId: string; anchor: string }
  | { kind: 'replan'; runId: string; triggerId: string }
  | { kind: 'expand'; runId: string; discoveryStepId: string; offset: number }
  | { kind: 'page'; runId: string; discoveryChainId: string; pageIndex: number; tokenHash: string }
);

/** The DecisionKey for slot/id computation. Fail-loud: a malformed decision
 *  (e.g. a `page` with no `tokenHash`) throws rather than hashing a '' field. */
function keyOf(d: PlanDecision): DecisionKey {
  switch (d.kind) {
    case 'create': return { kind: 'create', runId: d.runId };
    case 'replan':
      if ('anchor' in d) return { kind: 'replan', runId: d.runId, anchor: d.anchor };
      if ('triggerId' in d) return { kind: 'replan', runId: d.runId, triggerId: d.triggerId };
      throw new Error('plan-decision replan requires anchor or triggerId');
    case 'expand':
      if (d.discoveryStepId === undefined || d.offset === undefined)
        throw new Error('plan-decision expand requires discoveryStepId + offset');
      return { kind: 'expand', runId: d.runId, discoveryStepId: d.discoveryStepId, offset: d.offset };
    case 'page':
      if (!d.tokenHash) throw new Error('plan-decision page requires tokenHash');
      return { kind: 'page', runId: d.runId, discoveryChainId: d.discoveryChainId, pageIndex: d.pageIndex, tokenHash: d.tokenHash };
  }
}

export async function writePlanDecision(
  be: KnowledgeBackend,
  sessionId: string,
  d: PlanDecision,
  plannerOutput: string,
  nowIso: string,
  writeOrdinal: number,
): Promise<void> {
  const k = keyOf(d);
  await be.put(sessionId, {
    content: JSON.stringify({ steps: d.steps }),
    metadata: {
      traceId: sessionId, turnId: sessionId, stepperId: 'controller',
      task: 'controller', artifactType: PLAN_DECISION_ARTIFACT,
      runId: d.runId, kind: d.kind, slotId: decisionSlotId(k),
      decisionId: decisionId(k, plannerOutput), createdAt: nowIso, writeOrdinal,
    },
  });
}

/** Flat read-shape: the board's structure source needs only kind + steps + the
 *  resolved ids, NOT the kind-specific key fields (anchor/offset/...), which are
 *  not stored on the artifact. (Write input is the validated `PlanDecision`
 *  union; read output is this record.) */
export interface PlanDecisionRecord {
  runId: string;
  kind: DecisionKey['kind'];
  decisionId?: string;
  slotId?: string;
  steps: Step[];
}

export async function readPlanDecisions(
  rag: IKnowledgeRagHandle,
  runId: string,
): Promise<PlanDecisionRecord[]> {
  const list = await rag.list({
    runId, artifactType: PLAN_DECISION_ARTIFACT,
  });
  return list.map((e) => ({
    runId,
    kind: (e.metadata.kind ?? 'create') as DecisionKey['kind'],
    decisionId: e.metadata.decisionId,
    slotId: e.metadata.slotId,
    steps: (JSON.parse(e.content) as { steps: Step[] }).steps,
  }));
}
```

> Note: READS go through `IKnowledgeRagHandle.list({runId,artifactType})` (the
> same handle `collectApproved` uses); WRITES go through `KnowledgeBackend.put`.
> The real `KnowledgeBackend` has `scan(sessionId)`, NOT `list()` — so the read
> helpers take the RAG handle, never the backend. The test's fake satisfies the
> `.list` shape and is passed with an `as never` cast. The board (Task 8) consumes
> `PlanDecisionRecord[]` (read-shape), not the write-input union.

- [ ] **Step 4: Build (lower package edits in core were Task 1) + run → pass.**

Run: `npm run build` then the artifacts test. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts
git commit -m "feat(controller/artifacts): plan-decision write/read helpers"
```

---

### Task 7: `step-start` claim — write + first-claim-per-slot winner

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts`

- [ ] **Step 1: Failing test** (append):

```ts
import { writeStepStartClaim, readClaims, decisionWinner } from '../artifacts.js';

test('decisionWinner = the decisionId of the FIRST claim for a slot (attempt-independent)', async () => {
  const be = fakeBackend();
  const base = { runId: 'r', slotId: 'slot1', stepId: 's1', seq: 0 };
  await writeStepStartClaim(be as never, 'sess', { ...base, attempt: 0, decisionId: 'decA' }, 'now', 1);
  // a competing decision claims the SAME slot later — must NOT win
  await writeStepStartClaim(be as never, 'sess', { ...base, attempt: 0, decisionId: 'decB' }, 'now', 2);
  const claims = await readClaims(be as never, 'r');
  assert.equal(decisionWinner(claims, 'slot1'), 'decA');
  // a retry (new attempt) of the winning decision does not change the slot owner
  await writeStepStartClaim(be as never, 'sess', { ...base, attempt: 1, decisionId: 'decA' }, 'now', 3);
  assert.equal(decisionWinner(await readClaims(be as never, 'r'), 'slot1'), 'decA');
});
```

- [ ] **Step 2: Run → fail.** Same command. Expected: FAIL.

- [ ] **Step 3: Implement** (append to `artifacts.ts`):

```ts
export const STEP_START_ARTIFACT = 'step-start';

export interface StepStartClaim {
  runId: string;
  slotId: string;
  stepId: string;
  seq: number;
  attempt: number;
  decisionId: string;
  /** Monotonic per-run write ordinal (REQUIRED on a persisted claim — the
   *  controller increments it before each write, so within one run two claims
   *  NEVER share an ordinal). This is the deterministic "first" key; there is no
   *  createdAt tie-break (claims of one synthMeta call share a timestamp). */
  writeOrdinal: number;
}

export async function writeStepStartClaim(
  be: KnowledgeBackend,
  sessionId: string,
  // `writeOrdinal` is supplied as a separate arg (it is the value WRITTEN to
  // metadata), so the claim INPUT omits it; `StepStartClaim` stays the
  // read/persisted shape with `writeOrdinal` required.
  c: Omit<StepStartClaim, 'writeOrdinal'>,
  nowIso: string,
  writeOrdinal: number,
): Promise<void> {
  await be.put(sessionId, {
    content: '',
    metadata: {
      traceId: sessionId, turnId: sessionId, stepperId: 'controller',
      task: 'controller', artifactType: STEP_START_ARTIFACT,
      runId: c.runId, slotId: c.slotId, stepId: c.stepId, seq: c.seq,
      attempt: c.attempt, decisionId: c.decisionId, createdAt: nowIso, writeOrdinal,
    },
  });
}

export async function readClaims(
  rag: IKnowledgeRagHandle,
  runId: string,
): Promise<StepStartClaim[]> {
  const list = await rag.list({
    runId, artifactType: STEP_START_ARTIFACT,
  });
  // A persisted claim ALWAYS has a writeOrdinal (writeStepStartClaim sets it).
  // Drop any claim missing it (malformed/foreign row) rather than defaulting to
  // 0, which would make ordering input-dependent.
  return list.flatMap((e) => {
    if (typeof e.metadata.writeOrdinal !== 'number') return [];
    return [{
      runId, slotId: e.metadata.slotId ?? '', stepId: e.metadata.stepId ?? '',
      seq: e.metadata.seq ?? 0, attempt: e.metadata.attempt ?? 0,
      decisionId: e.metadata.decisionId ?? '', writeOrdinal: e.metadata.writeOrdinal,
    }];
  });
}

/** The decision that owns a slot = the FIRST claim for it, by ascending
 *  `writeOrdinal` (monotonic per run ⇒ unique ⇒ a total, input-order-independent
 *  order). Attempt-independent: a retry never changes which decision owns the
 *  slot (§F). */
export function decisionWinner(claims: StepStartClaim[], slotId: string): string | undefined {
  const forSlot = claims.filter((c) => c.slotId === slotId);
  if (forSlot.length === 0) return undefined;
  forSlot.sort((a, b) => a.writeOrdinal - b.writeOrdinal);
  return forSlot[0].decisionId;
}
```

- [ ] **Step 4: Build + run → pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts
git commit -m "feat(controller/artifacts): step-start claim + first-claim-per-slot decisionWinner"
```

---

### Task 8: Board reconstruction (sources 1–3, attempt-scoped)

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/board.ts`
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/board.test.ts`

> Sources per §F: (1) structure ← `plan-decision`; (2) terminal ← `step-result`
> (precedence-resolved among SETTLED attempts); (3) transient ← `step-start` claim +
> bundle in-flight. Source 4 (`chain-outcome`) is Phase 4. Attempt-scoped: current
> attempt = MAX attempt; if unsettled (claim/in-flight, no result) → transient
> `executing`; else `resolveByPrecedence` over settled attempts.

- [ ] **Step 1: Failing test** (`board.test.ts`):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconstructBoard, type BoardInputs } from '../board.js';
import type { InFlightStep, PendingMarker } from '../types.js';

const meta = (m: Record<string, unknown>) => ({ content: m.content ?? '', metadata: { traceId: 't', turnId: 't', stepperId: 'controller', task: 'controller', createdAt: 'now', ...m } });

test('failed(attempt0) → executing(attempt1 claim, no result) → done(attempt1 result)', () => {
  const structure = [{ runId: 'r', kind: 'create' as const, steps: [{ stepId: 's1', name: 'Fetch', instructions: 'read' }] }];
  // attempt0 settled failed; attempt1 claimed but NOT yet settled
  const stepResults = [meta({ artifactType: 'step-result', runId: 'r', stepId: 's1', seq: 0, attempt: 0, status: 'failed', digest: 'd0', writeOrdinal: 1 })];
  const claims = [{ runId: 'r', slotId: 'slot1', stepId: 's1', seq: 0, attempt: 1, decisionId: 'decA', writeOrdinal: 2 }];
  const board1 = reconstructBoard({ structure, stepResults, claims, inFlight: undefined } as BoardInputs);
  assert.equal(board1.get('s1')!.state, 'executing'); // live retry supersedes stale failed

  // now attempt1 settles ok
  const stepResults2 = [...stepResults, meta({ artifactType: 'step-result', runId: 'r', stepId: 's1', seq: 0, attempt: 1, status: 'ok', digest: 'd1', writeOrdinal: 3 })];
  const board2 = reconstructBoard({ structure, stepResults: stepResults2, claims, inFlight: undefined } as BoardInputs);
  assert.equal(board2.get('s1')!.state, 'done');
  assert.equal(board2.get('s1')!.digest, 'd1');
});

test('precedence among settled attempts: a late failed does NOT overwrite a committed ok', () => {
  const structure = [{ runId: 'r', kind: 'create' as const, steps: [{ stepId: 's1', name: 'X', instructions: 'y' }] }];
  const stepResults = [
    meta({ artifactType: 'step-result', runId: 'r', stepId: 's1', seq: 0, attempt: 0, status: 'ok', digest: 'good', writeOrdinal: 1 }),
    meta({ artifactType: 'step-result', runId: 'r', stepId: 's1', seq: 0, attempt: 0, status: 'failed', digest: 'bad', writeOrdinal: 2 }),
  ];
  const b = reconstructBoard({ structure, stepResults, claims: [], inFlight: undefined } as BoardInputs);
  assert.equal(b.get('s1')!.state, 'done');
});

test('a planned step with no result/claim is "planned"', () => {
  const structure = [{ runId: 'r', kind: 'create' as const, steps: [{ stepId: 's1', name: 'X', instructions: 'y' }] }];
  const b = reconstructBoard({ structure, stepResults: [], claims: [], inFlight: undefined } as BoardInputs);
  assert.equal(b.get('s1')!.state, 'planned');
});

test('in-flight step + external-tool pending → awaiting-external (run-level pending threaded in)', () => {
  const structure = [{ runId: 'r', kind: 'create' as const, steps: [{ stepId: 's1', name: 'X', instructions: 'y' }] }];
  // `satisfies` (not a cast) so the test catches drift in the real contracts.
  const inFlight = {
    seq: 0, step: { stepId: 's1', name: 'X', instructions: 'y' }, attempt: 0,
    resumeCount: 0, phase: 'executing', transcript: [], toolCallCount: 0,
  } satisfies InFlightStep;
  const pending = {
    kind: 'external-tool', extId: 'e', toolName: 't', args: {}, position: 'p',
  } satisfies PendingMarker;
  const b = reconstructBoard({ structure, stepResults: [], claims: [], inFlight, pending } satisfies BoardInputs);
  assert.equal(b.get('s1')!.state, 'awaiting-external');
  // same in-flight, no external pending → plain executing
  const b2 = reconstructBoard({ structure, stepResults: [], claims: [], inFlight } satisfies BoardInputs);
  assert.equal(b2.get('s1')!.state, 'executing');
});
```

- [ ] **Step 2: Run → fail** (module missing).

Run: `node --import tsx/esm --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/board.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (`board.ts`):

```ts
import type { KnowledgeEntry } from '@mcp-abap-adt/llm-agent';
import type { Outcome } from './outcome.js';
import { projectStepState, resolveByPrecedence } from './outcome.js';
import type { PlanDecisionRecord, StepStartClaim } from './artifacts.js';
import type { InFlightStep, PendingMarker } from './types.js';

export type StepState =
  | 'planned' | 'executing' | 'awaiting-external'
  | 'done' | 'partial' | 'failed';

export interface BoardEntry {
  stepId: string;
  name: string;
  instructions: string;
  state: StepState;
  digest?: string;
  seq?: number;
  attempt?: number;
}

export interface BoardInputs {
  structure: PlanDecisionRecord[];
  stepResults: readonly KnowledgeEntry[];
  claims: StepStartClaim[];
  inFlight?: InFlightStep;
  /** The run-level pending marker — it lives on the SessionBundle, NOT on
   *  InFlightStep. Passed in so the board can refine the current in-flight step's
   *  transient state to `awaiting-external` when the run is suspended on an
   *  external tool. */
  pending?: PendingMarker;
}

/** Rebuild the step-state board from artifacts (§F), sources 1–3. */
export function reconstructBoard(input: BoardInputs): Map<string, BoardEntry> {
  const board = new Map<string, BoardEntry>();

  // (1) Structure ← plan-decision steps (later decisions append/replace).
  for (const dec of input.structure) {
    for (const s of dec.steps) {
      if (!s.stepId) continue;
      board.set(s.stepId, {
        stepId: s.stepId, name: s.name, instructions: s.instructions,
        state: 'planned',
      });
    }
  }

  // Index step-result entries by stepId.
  const resultsByStep = new Map<string, KnowledgeEntry[]>();
  for (const e of input.stepResults) {
    if (e.metadata.artifactType !== 'step-result') continue;
    const id = e.metadata.stepId;
    if (!id) continue;
    (resultsByStep.get(id) ?? resultsByStep.set(id, []).get(id)!).push(e);
  }
  const claimsByStep = new Map<string, StepStartClaim[]>();
  for (const c of input.claims) {
    (claimsByStep.get(c.stepId) ?? claimsByStep.set(c.stepId, []).get(c.stepId)!).push(c);
  }

  // (2)+(3) Terminal / transient state, attempt-scoped (§F).
  for (const [stepId, entry] of board) {
    const results = resultsByStep.get(stepId) ?? [];
    const claims = claimsByStep.get(stepId) ?? [];
    const maxResultAttempt = results.reduce((m, e) => Math.max(m, e.metadata.attempt ?? 0), -1);
    const maxClaimAttempt = claims.reduce((m, c) => Math.max(m, c.attempt), -1);
    const inFlightForStep =
      input.inFlight && input.inFlight.step?.stepId === stepId ? input.inFlight : undefined;
    const maxAttempt = Math.max(maxResultAttempt, maxClaimAttempt,
      inFlightForStep ? inFlightForStep.attempt : -1);

    if (maxAttempt < 0) continue; // never started → stays 'planned'

    const settledForCurrent = results.filter((e) => (e.metadata.attempt ?? 0) === maxAttempt);
    if (settledForCurrent.length === 0) {
      // (3) current attempt unsettled (claim/in-flight, no result) → transient.
      entry.state =
        inFlightForStep?.phase === 'executing' && input.pending?.kind === 'external-tool'
          ? 'awaiting-external'
          : 'executing';
      entry.attempt = maxAttempt;
      continue;
    }
    // (2) current attempt settled → precedence over its settled outcomes.
    const outcomes: Outcome[] = settledForCurrent
      .sort((a, b) => (a.metadata.writeOrdinal ?? 0) - (b.metadata.writeOrdinal ?? 0))
      .map((e) => ({
        status: (e.metadata.status ?? 'failed') as Outcome['status'],
        approved: e.content, remainder: e.metadata.remainder ?? '', note: e.metadata.note ?? '',
      }));
    const resolved = resolveByPrecedence(outcomes);
    if (!resolved) continue;
    entry.state = projectStepState(resolved.status);
    entry.attempt = maxAttempt;
    // digest from the precedence-winning entry (matched by status, latest ordinal).
    const winner = [...settledForCurrent].reverse()
      .find((e) => (e.metadata.status ?? 'failed') === resolved.status);
    entry.digest = winner?.metadata.digest;
  }
  return board;
}
```

> `InFlightStep.step` is the existing `{ step: Step }` field (`types.ts`); after
> Task 2 it carries `stepId`. The run-level `pending` lives on the SessionBundle
> (NOT on `InFlightStep`), so it is passed via `BoardInputs.pending`; the
> `awaiting-external` branch reads `input.pending`. The caller threads
> `bundle.pending` in Phase 2/5; for Phase 1 the unit test (Step 1b below) covers
> the `awaiting-external` refinement with a synthetic `inFlight` + `pending`.

- [ ] **Step 4: Build + run → pass.** Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/board.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/board.test.ts
git commit -m "feat(controller/board): artifact-reconstructed step-state board (sources 1-3, attempt-scoped)"
```

---

### Task 9: Phase-1 green gate (full suites + lint)

- [ ] **Step 1:** `npm run build` — expect clean.
- [ ] **Step 2:** `npm run test --workspace @mcp-abap-adt/llm-agent` — core metadata test green.
- [ ] **Step 3:** `npm run test --workspace @mcp-abap-adt/llm-agent-server-libs` — controller artifacts/board/outcome/types tests green; **no regression** in existing controller tests (`step-result` writers untouched in behaviour; new fields are additive/optional).
- [ ] **Step 4:** `npm run lint:check` — clean on the new/edited files.
- [ ] **Step 5: Commit** any lint fixes; then proceed to **Phase 2 (digest board)**, which renders this board into the planner prompt and wires the reviewer `digest` return.

---

## Self-Review

**1. Spec coverage (Phase-1 slice of §A/§E/§F):**
- `Step.stepId/discovery?/supersedesStepId?` — Task 2 ✓
- `plan-decision` kind table (decisionId/slotId, create/replan/expand/page) — Task 5 ✓ (write of create/replan — Task 6; expand/page WRITE deferred to Phase 4, computation present)
- `step-result` `digest`/`stepId` — **FIELD ONLY** (Task 1 adds the metadata
  fields + filter predicate; `reconstructBoard` READS them). The PRODUCTION
  write-site (handler writing `stepId`/`digest` onto `step-result`, gated on the
  reviewer first RETURNING a digest) is **explicitly NOT in Phase 1** — it is Phase
  2. So this row is "field + read path covered; production deferred", NOT "produced".
- `step-start` claim + first-claim-per-slot winner — Task 7 ✓
- Board reconstruction sources 1–3 + attempt-scoped resolution — Task 8 ✓; source 4 (`chain-outcome`) explicitly Phase 4.

**2. Placeholder scan:** every step has runnable code/commands; no TBD/TODO; no
literal NUL bytes (the `deterministicId` separator is the escaped `'\u0000'`). The
only forward-reference is the `step-result.digest`/`stepId` PRODUCTION write-site
(the handler writing them, gated on the reviewer returning a digest) — explicitly
Phase 2, with the field + read path present here. `awaiting-external` is NOT
deferred: `BoardInputs.pending` carries the run-level marker and Task 8 unit-tests
the refinement.

**3. Type consistency:** `deterministicId` signature stable across Tasks 3/5/6; `DecisionKey` reused by `decisionSlotId`/`decisionId`; `PlanDecision`/`StepStartClaim` exported from `artifacts.ts` and imported by `board.ts`; `projectStepState`/`resolveByPrecedence`/`Outcome` all from `outcome.ts`; `KnowledgeEntry`/`KnowledgeEntryMetadata` from core. `Step.stepId` optional (migration-safe) — board skips entries without it.

**4. Scope:** Phase 1 ships pure types/helpers/reconstruction with unit tests and NO handler behaviour change — safe, independently testable, and the foundation Phases 2–5 consume.
