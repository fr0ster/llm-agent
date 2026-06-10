# Controller Execution-Result Control & Data Backbone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the `controller` pipeline so a separate reviewer role judges every step, results are persisted write-after-review into an append-only RAG keyed by `(runId, seq, attempt)`, and the whole run is crash-recoverable through a durable `runId`/`runPhase` state machine with bounded resume/tool/control counters and a unified finalizer.

**Architecture:** All work lives under `packages/llm-agent-server-libs/src/smart-agent/controller/` plus two small extensions to lower packages (`@mcp-abap-adt/llm-agent` metadata/filter, its in-memory RAG `matches()`). The existing `ControllerCoordinatorHandler` (a deterministic loop over opaque subagents) is extended in place; new roles (`IReviewer`, `IFinalizer`) and run-scope helpers are added as separate focused modules and wired through `ControllerFactory`. The design spec is the authoritative contract: `docs/superpowers/specs/2026-06-10-controller-execution-result-control-design.md` — each task cites the section it implements.

**Tech Stack:** TypeScript (ESM, strict), Node ≥ 22, `node:test` via `tsx/esm`, Biome. No new runtime dependencies.

**Conventions for every task:**
- ESM imports use `.js` extensions; interfaces are `I`-prefixed.
- Test runner (from repo root): `node --import tsx/esm --test --test-reporter=spec <path-to-test-file>`.
- When a task edits a **lower** package (`packages/llm-agent/...` or `packages/llm-agent-libs/...`), run `npm run build` BEFORE running tests, because `tsx` resolves workspace imports (`@mcp-abap-adt/llm-agent*`) to each package's compiled `dist/`, not its `src/`. Tasks that touch only `llm-agent-server-libs/src` and its own `__tests__` do not need a rebuild (tsx loads that package's src directly).
- Commit after each task with a Conventional Commit message; never squash.
- Branch: `design/controller-execution-result-control` (already checked out).

---

## File Structure

**New files** (`packages/llm-agent-server-libs/src/smart-agent/controller/`):
- `outcome.ts` — the `Outcome` type, outcome-precedence resolver, status constants. One responsibility: the reviewer's verdict shape + how multiple artifacts at one `(runId, seq)` collapse to one.
- `reviewer.ts` — `IReviewer` interface + `LlmReviewer` default impl + reviewer system prompt.
- `finalizer.ts` — `IFinalizer` interface + `LlmFinalizer` default impl + finalizer read policy (budget/order/truncate/overflow).
- `run-scope.ts` — `runId` minter, request-fingerprint, strict request classification, fresh-run reset, terminal store (separate keyed TTL store) read/write/GC.
- Test files mirror each under `__tests__/`.

**Modified files:**
- `packages/llm-agent/src/interfaces/knowledge-rag.ts` — `KnowledgeEntryMetadata` += `runId/seq/attempt/status`; `KnowledgeFilter` += equality on the same.
- `packages/llm-agent-libs/src/rag/knowledge-rag.ts` — `matches()` honours the new filter fields.
- `controller/types.ts` — extend `SessionBundle` (runId/runState/runPhase/nextSeq/inFlightStep/markers/counters), `ControllerConfig.subagents` (+reviewer/finalizer), `ControllerConfig.budgets` (+resume/eval/finalize caps), `PlannerNextInput.lastOutcome`/`IControllerPlanner.commit` (+`partial`).
- `controller/session-bundle.ts` — `emptyBundle()` carries the new run-scoped fields; add `resetRun()`.
- `controller/controller-coordinator-handler.ts` — write-after-review, durable counters, three-stage recovery, attempt-keyed external resume, unified finalizer, evaluator confirmation transition.
- `controller/planner.ts` — `partial` transition; `commit(bundle, 'advanced'|'failed'|'partial')`.
- `factories/controller-factory.ts` — build `LlmReviewer`/`LlmFinalizer`, pass `reviewer`/`finalizer` deps + models.

---

## Phase A — Contracts & types (build stays green; no behavior change)

### Task 1: `Outcome` type + precedence resolver

**Spec:** "Core idea", "Outcome persistence" (precedence `ok/exists > partial > failed`, tie-break latest).

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// outcome.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Outcome, resolveByPrecedence } from '../outcome.js';

const mk = (status: Outcome['status'], approved = ''): Outcome => ({
  status,
  approved,
  remainder: '',
  note: '',
});

describe('resolveByPrecedence', () => {
  it('prefers ok/exists over partial over failed', () => {
    assert.equal(resolveByPrecedence([mk('failed'), mk('partial'), mk('ok')])?.status, 'ok');
    assert.equal(resolveByPrecedence([mk('failed'), mk('partial')])?.status, 'partial');
    assert.equal(resolveByPrecedence([mk('failed')])?.status, 'failed');
  });
  it('treats exists at the same rank as ok (tie-break: latest wins)', () => {
    const r = resolveByPrecedence([mk('ok', 'first'), mk('exists', 'second')]);
    assert.equal(r?.approved, 'second');
  });
  it('returns undefined for an empty list', () => {
    assert.equal(resolveByPrecedence([]), undefined);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts`
Expected: FAIL — cannot find module `../outcome.js`.

- [ ] **Step 3: Implement `outcome.ts`**

```ts
// outcome.ts
/** Authoritative per-step verdict, produced ONLY by the reviewer (the executor
 *  never sets status). Persisted in full on the step artifact so a crash between
 *  the artifact write and the bundle persist loses neither `remainder` nor `note`. */
export interface Outcome {
  status: 'ok' | 'exists' | 'failed' | 'partial';
  /** Content to keep: the executor's content for ok/exists, or the validated
   *  accepted extract for partial. */
  approved: string;
  /** What is still missing (drives a partial replan). */
  remainder: string;
  note: string;
}

/** Rank used to collapse multiple artifacts at one (runId, seq) to a single
 *  resolved outcome. ok and exists share the top rank; partial beats failed. */
const RANK: Record<Outcome['status'], number> = {
  ok: 3,
  exists: 3,
  partial: 2,
  failed: 1,
};

/** Resolve many same-`seq` outcomes to one by precedence (ok/exists > partial >
 *  failed); on a rank tie the LAST element wins (latest write). Input order is
 *  assumed chronological (oldest first), matching list()/scan() order.
 *  Returns undefined for an empty list. */
export function resolveByPrecedence(
  outcomes: readonly Outcome[],
): Outcome | undefined {
  let best: Outcome | undefined;
  let bestRank = 0;
  for (const o of outcomes) {
    const r = RANK[o.status];
    if (best === undefined || r >= bestRank) {
      best = o;
      bestRank = r;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/outcome.test.ts
git commit -m "feat(controller): Outcome type + precedence resolver (ok/exists>partial>failed)"
```

---

### Task 2: Extend RAG metadata/filter with `runId/seq/attempt/status`

**Spec:** "Data backbone & RAG contract changes" — `KnowledgeEntryMetadata += runId/seq/attempt/status`; `KnowledgeFilter += equality on runId, seq, attempt, status`.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/knowledge-rag.ts:3-30`
- Modify: `packages/llm-agent-libs/src/rag/knowledge-rag.ts:155-170` (the `matches()` function)
- Test: `packages/llm-agent-libs/src/rag/__tests__/knowledge-rag-filter.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// knowledge-rag-filter.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KnowledgeEntryMetadata } from '@mcp-abap-adt/llm-agent';
import { InMemoryKnowledgeBackend, makeKnowledgeRag } from '../knowledge-rag.js';

const meta = (over: Partial<KnowledgeEntryMetadata>): KnowledgeEntryMetadata => ({
  traceId: 't', turnId: 't', stepperId: 'controller', task: 'x',
  artifactType: 'step-result', createdAt: '2026-06-10T00:00:00.000Z', ...over,
});

describe('knowledge filter by runId/seq/attempt/status', () => {
  it('list() matches on runId+seq+attempt+status equality', async () => {
    const be = new InMemoryKnowledgeBackend();
    const rag = makeKnowledgeRag(be, 's1');
    await rag.write({ content: 'a', metadata: meta({ runId: 'R1', seq: 0, attempt: 0, status: 'failed' }) });
    await rag.write({ content: 'b', metadata: meta({ runId: 'R1', seq: 0, attempt: 1, status: 'ok' }) });
    await rag.write({ content: 'c', metadata: meta({ runId: 'R2', seq: 0, attempt: 0, status: 'ok' }) });

    const r1seq0 = await rag.list({ runId: 'R1', seq: 0 });
    assert.equal(r1seq0.length, 2);
    const r1seq0att1 = await rag.list({ runId: 'R1', seq: 0, attempt: 1 });
    assert.equal(r1seq0att1.length, 1);
    assert.equal(r1seq0att1[0].content, 'b');
    const oks = await rag.list({ runId: 'R1', status: 'ok' });
    assert.equal(oks.length, 1);
    assert.equal(oks[0].content, 'b');
  });
});
```

> NOTE: confirm the in-memory rag handle is constructed via an exported helper. If the package exports a factory under a different name than `makeKnowledgeRag`, read `packages/llm-agent-libs/src/rag/knowledge-rag.ts` and use the actual export (the `KnowledgeRag` class or its factory). Adjust the import accordingly; the assertions are unchanged.

- [ ] **Step 2: Add the metadata + filter fields**

In `packages/llm-agent/src/interfaces/knowledge-rag.ts`, extend `KnowledgeEntryMetadata` (after `identityKey`):

```ts
  /** Controller run-scope identity (execution-result-control design). `runId`
   *  scopes one user request; `seq` is the stable step index; `attempt` is the
   *  fresh-execution counter (retry/replan reuses the same seq); `status` is the
   *  reviewer's verdict. Exact (runId,seq,attempt) answers "did THIS execution
   *  commit?"; (runId,seq) is the cross-attempt resolution scope. */
  runId?: string;
  seq?: number;
  attempt?: number;
  status?: 'ok' | 'exists' | 'failed' | 'partial';
  /** The reviewer's full control fields, persisted on the artifact so the
   *  COMPLETE Outcome (not just status+approved) survives a crash — `remainder`
   *  drives a partial replan, `note` is the audit reason. No filter equality is
   *  defined on these (they are read back, never queried by value). */
  note?: string;
  remainder?: string;
```

And extend `KnowledgeFilter` (after `toolName`):

```ts
  runId?: string;
  seq?: number;
  attempt?: number;
  status?: 'ok' | 'exists' | 'failed' | 'partial';
```

- [ ] **Step 3: Honour the new fields in `matches()`**

In `packages/llm-agent-libs/src/rag/knowledge-rag.ts`, inside `matches()` (after the `toolName` check, before `return true`):

```ts
  if (f.runId !== undefined && m.runId !== f.runId) return false;
  if (f.seq !== undefined && m.seq !== f.seq) return false;
  if (f.attempt !== undefined && m.attempt !== f.attempt) return false;
  if (f.status !== undefined && m.status !== f.status) return false;
```

- [ ] **Step 3b: Push the filter INTO `semanticQuery` so it is applied PRE-cap (ranking preserved)**

The current `query()` (`knowledge-rag.ts:69-81`) caps with `semanticQuery(…, k)`
THEN filters — so in a multi-run session foreign-run hits fill the top-K before the
`runId` filter runs (spec: the filter must be applied PRE-cap). The fix preserves
the backend's RANKING (semantic where available) by pushing the filter INTO
`semanticQuery` (the spec's "native" option), with each backend applying it to its
candidate set BEFORE the cap — NOT replacing ranking with recency.

Extend the `KnowledgeBackend` interface (knowledge-rag.ts) `semanticQuery` with an
optional filter; document the pre-cap contract:

```ts
  /** Semantic top-K. When `filter` is given it MUST be applied to the candidate
   *  set BEFORE the K cap (so a runId filter is never starved by other runs'
   *  artifacts crowding the cap), preserving the backend's native ranking. */
  semanticQuery(
    sid: string,
    text: string,
    k?: number,
    filter?: KnowledgeFilter,
  ): Promise<readonly KnowledgeEntry[]>;
```

`InMemoryKnowledgeBackend.semanticQuery` — filter first, then cap (its order is
insertion = its "semantic" proxy; ranking unchanged):

```ts
  async semanticQuery(sid: string, _text: string, k?: number, filter?: KnowledgeFilter) {
    let a = this.of(sid);
    if (filter) a = a.filter((e) => matches(e.metadata, filter));
    return k ? a.slice(0, k) : a.slice();
  }
```

(`matches` is exported / module-visible in `knowledge-rag.ts`.)

`JsonlKnowledgeBackend.semanticQuery` (server-libs) — add the param; when a filter
is present, prefer a native filter on the injected semantic index if it supports
one, else use the **exhaustive `scan()`** (guaranteed complete) filtered, ranked by
the index where possible (recency fallback otherwise — the spec's
list-then-rank-locally):

```ts
  async semanticQuery(sid: string, text: string, k?: number, filter?: KnowledgeFilter) {
    if (filter) {
      // GUARANTEED run-scoping (the semantic index may cap below the run's size):
      // exhaustive scan → filter → most-recent K. (A future vector adapter with a
      // metadata filter can rank semantically within the run.)
      const all = (await this.scan(sid)).filter((e) => matchesFilter(e.metadata, filter));
      const ranked = all.slice().sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
      return k ? ranked.slice(0, k) : ranked;
    }
    if (this.semantic) return this.semantic.query(sid, text, k);
    const all = await this.scan(sid);
    return k ? all.slice(-k) : all;
  }
```

> `matchesFilter` is a small local copy in the Jsonl backend (or import the shared
> `matches` from `@mcp-abap-adt/llm-agent-libs` if it is exported). If `matches` is
> not exported, export it from `knowledge-rag.ts` and import it here — one shared
> predicate, no duplication.

`KnowledgeRag.query` passes the filter through (the backend applied it pre-cap; a
defensive post-filter is harmless):

```ts
  async query(text, opts) {
    const hits = await this.backend.semanticQuery(this.sessionId, text, opts?.k, opts?.filter);
    return opts?.filter ? hits.filter((e) => matches(e.metadata, opts.filter!)) : hits;
  }
```

Add a test proving the runId filter survives the cap INDEPENDENTLY of any inner
semantic cap: write `k+2` foreign-run `step-result`s + 1 target-run entry, then
`query(text, { k: 3, filter: { runId: 'R-target' } })` must return the target entry
(a post-cap filter would crowd it out).

- [ ] **Step 4: Build the lower packages, then run the test**

Run: `npm run build && node --import tsx/esm --test --test-reporter=spec packages/llm-agent-libs/src/rag/__tests__/knowledge-rag-filter.test.ts`
Expected: build OK, tests PASS. If build fails because the `status` union is duplicated, ensure the metadata and filter unions are written identically.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/knowledge-rag.ts packages/llm-agent-libs/src/rag/knowledge-rag.ts packages/llm-agent-libs/src/rag/__tests__/knowledge-rag-filter.test.ts
git commit -m "feat(rag): KnowledgeEntryMetadata/Filter gain runId/seq/attempt/status equality"
```

---

### Task 3: Extend `SessionBundle` + reset helper

**Spec:** "Run scope & lifecycle (durable runId)", "Stable seq + durable counters", "General invariant". Implements the durable shape:
`runId`, `runState ∈ {idle,active,suspended,terminal}`, `runPhase ∈ {evaluating,planning,executing,finalizing}`, `nextSeq`, `inFlightStep`, the in-flight markers (`evalCallInFlight`/`plannerCallInFlight`/`finalizeCallInFlight`), the resume counters (`evalResumeCount`/`plannerResumeCount`/`finalizeAttempt`), and `originalRequest`.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/session-bundle.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/session-bundle.test.ts` (extend existing)

- [ ] **Step 1: Add the types to `types.ts`**

Add the `InFlightStep`, `RunState`, `RunPhase`, `ControlFailure` types and extend `SessionBundle`. Replace the existing `SessionBundle` interface (`types.ts:37-48`) with:

```ts
export type RunState = 'idle' | 'active' | 'suspended' | 'terminal';
export type RunPhase = 'evaluating' | 'planning' | 'executing' | 'finalizing';

/** Controller-level (non-reviewer) failure that drives a replan with no
 *  reviewable artifact (e.g. the maxToolCalls budget). Persisted atomically with
 *  inFlightStep.phase='awaiting-replan' so a crash before the replan keeps the
 *  reason; fed to the planner, then cleared when the revised step is set. */
export interface ControlFailure {
  reason: 'maxToolCalls';
  seq: number;
}

export interface InFlightStep {
  seq: number;
  step: Step;
  /** Fresh-execution counter (first dispatch / revised replan step). Part of the
   *  artifact identity (runId, seq, attempt). */
  attempt: number;
  /** Crash-replay counter of ONE attempt; reset on commit / fresh attempt. */
  resumeCount: number;
  phase: 'executing' | 'awaiting-replan';
  /** Durable executor message log for this seq — the suspend/resume +
   *  crash-replay rebuild source; external tool results are appended here. */
  transcript: Message[];
  /** Durable external round-trip count; ++ persisted BEFORE each surfaced call. */
  toolCallCount: number;
  controlFailure?: ControlFailure;
}

export interface SessionBundle {
  goal: string;
  plannerPrivate: string;
  budgets: { stepsUsed: number; rewindsUsed: number };
  plan?: Step[];
  planCursor?: number;
  pending?: PendingMarker;
  /** Last reviewed step outcome that drives the planner transition; 'partial'
   *  added by this design. */
  lastOutcome?: 'advanced' | 'failed' | 'partial';

  // -- Run scope (execution-result-control design) -----------------------
  runId?: string;
  runState?: RunState;
  runPhase?: RunPhase;
  /** The verbatim request that started this run (finalizer input + identity
   *  fingerprint source). */
  originalRequest?: string;
  nextSeq?: number;
  inFlightStep?: InFlightStep;
  // In-flight markers: persisted true BEFORE the role's LLM call; cleared in the
  // atomic decision/answer write. Recovery charges the matching resume counter
  // only when the marker proves a call was running.
  evalCallInFlight?: boolean;
  plannerCallInFlight?: boolean;
  finalizeCallInFlight?: boolean;
  evalResumeCount?: number;
  plannerResumeCount?: number;
  finalizeAttempt?: number;
  /** Legacy (no-finalizer) answer: the adaptive/incremental planner's composed
   *  `done.result`, persisted DURABLY in the same write that enters `finalizing`,
   *  so a crash before the terminal write can recover it on resume (rather than
   *  emitting an empty success). Cleared by the run reset. */
  legacyFinalAnswer?: string;
}
```

Add `import type { Message } from '@mcp-abap-adt/llm-agent';` at the top of `types.ts` (it is not yet imported there).

- [ ] **Step 2: Extend `ControllerConfig.budgets` + `subagents`**

In `types.ts`, extend `ControllerConfig.subagents` to add the two roles and `budgets` to add the caps:

```ts
  subagents: {
    evaluator: ControllerSubagentConfig;
    planner: ControllerSubagentConfig;
    executor: ControllerSubagentConfig;
    /** Optional; default to the planner's config when absent (no breaking change). */
    reviewer?: ControllerSubagentConfig;
    finalizer?: ControllerSubagentConfig;
  };
```

and in `budgets`:

```ts
  budgets: {
    maxSteps: number;
    maxRetries: number;
    maxRewinds: number;
    maxToolCalls?: number;
    /** Durable fresh-attempt cap per step: bounds how many times a non-advancing
     *  step is re-executed/replanned at the same seq before the run aborts. */
    maxStepAttempts?: number;
    /** Durable crash-replay caps (one per LLM-invoking phase). Defaults applied
     *  in the handler when absent. */
    maxStepResumes?: number;
    maxPlannerResumes?: number;
    maxEvalResumes?: number;
    maxFinalizeRetries?: number;
    /** In-process re-ask budget for judge (reviewer) provider/malformed failures
     *  within one live review (NOT a crash bound). */
    maxReviewRetries?: number;
  };
```

Also add, directly on `ControllerConfig` (sibling of `budgets`), the finalizer-exhaustion policy:

```ts
  /** Behaviour when the finalizer's retry budget is exhausted (spec
   *  "Finalizer failure semantics"). 'error' → terminal control error
   *  (deterministic, default); 'best-effort' → compose from the already-approved
   *  results with an explicit incomplete marker. */
  onFinalizeExhausted?: 'error' | 'best-effort';
```

- [ ] **Step 3: Extend `PlannerNextInput.lastOutcome` and `IControllerPlanner.commit`**

In `types.ts`, change `lastOutcome?: 'advanced' | 'failed';` (in `PlannerNextInput`) to `lastOutcome?: 'advanced' | 'failed' | 'partial';` and `commit?(bundle: SessionBundle, outcome: 'advanced' | 'failed'): void;` to `commit?(bundle: SessionBundle, outcome: 'advanced' | 'failed' | 'partial'): void;`.

- [ ] **Step 4: Add `resetRun()` to `session-bundle.ts`**

Append to `packages/llm-agent-server-libs/src/smart-agent/controller/session-bundle.ts`:

```ts
import type { RunPhase, RunState } from './types.js';

/** Atomic fresh-run reset: clears EVERY run-scoped field and starts in
 *  `evaluating`. The caller mints + assigns a fresh `runId` and the new
 *  `originalRequest`. The terminal store (a separate keyed TTL store) is NOT
 *  touched here so a prior run's outcome stays replayable by its runId. */
export function resetRun(bundle: SessionBundle, originalRequest: string): void {
  bundle.goal = '';
  bundle.plannerPrivate = '';
  bundle.budgets = { stepsUsed: 0, rewindsUsed: 0 };
  bundle.plan = undefined;
  bundle.planCursor = undefined;
  bundle.pending = undefined;
  bundle.lastOutcome = undefined;
  bundle.runState = 'active';
  bundle.runPhase = 'evaluating' as RunPhase;
  bundle.originalRequest = originalRequest;
  bundle.nextSeq = 0;
  bundle.inFlightStep = undefined;
  bundle.evalCallInFlight = false;
  bundle.plannerCallInFlight = false;
  bundle.finalizeCallInFlight = false;
  bundle.evalResumeCount = 0;
  bundle.plannerResumeCount = 0;
  bundle.finalizeAttempt = 0;
  bundle.legacyFinalAnswer = undefined;
}
```

`SessionBundle` is already imported there; add `RunState` to the import only if used (it is referenced in the cast — keep the cast to `RunPhase` and drop the unused `RunState` import if Biome warns).

- [ ] **Step 5: Test the reset is exhaustive**

Add to `__tests__/session-bundle.test.ts`:

```ts
import { resetRun } from '../session-bundle.js';
// inside describe(...)
it('resetRun clears every run-scoped field and starts in evaluating', () => {
  const b = {
    goal: 'old', plannerPrivate: 'x', budgets: { stepsUsed: 5, rewindsUsed: 2 },
    plan: [{ name: 's', instructions: 'i' }], planCursor: 1,
    pending: { kind: 'clarify', question: 'q', position: 'goal' },
    lastOutcome: 'failed', runState: 'terminal', runPhase: 'finalizing',
    nextSeq: 4, inFlightStep: { seq: 3 } as never,
    plannerResumeCount: 9, finalizeAttempt: 7,
  } as never as import('../types.js').SessionBundle;
  resetRun(b, 'new request');
  assert.equal(b.goal, '');
  assert.equal(b.runState, 'active');
  assert.equal(b.runPhase, 'evaluating');
  assert.equal(b.originalRequest, 'new request');
  assert.equal(b.nextSeq, 0);
  assert.equal(b.inFlightStep, undefined);
  assert.equal(b.plannerResumeCount, 0);
  assert.equal(b.finalizeAttempt, 0);
});
```

- [ ] **Step 6: Build (types live in llm-agent-server-libs only — no lower-package change) and run**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/session-bundle.test.ts`
Expected: PASS. The pre-existing controller handler still compiles because every new field is optional and `lastOutcome` only widened its union.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts packages/llm-agent-server-libs/src/smart-agent/controller/session-bundle.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/session-bundle.test.ts
git commit -m "feat(controller): durable run-scope fields on SessionBundle + resetRun()"
```

---

## Phase B — Run-scope primitives (pure, fully unit-testable)

### Task 4: `runId` minter + request fingerprint

**Spec:** "Run scope & lifecycle" (injectable runId minter), "Canonical fingerprint" (normalized request hash).

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/run-scope.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// run-scope.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fingerprintRequest } from '../run-scope.js';

describe('fingerprintRequest', () => {
  it('is stable across whitespace/transport noise', () => {
    assert.equal(
      fingerprintRequest('  read T100  '),
      fingerprintRequest('read T100'),
    );
  });
  it('differs for different content', () => {
    assert.notEqual(fingerprintRequest('read T100'), fingerprintRequest('read T200'));
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the minter + fingerprint in `run-scope.ts`**

```ts
// run-scope.ts
import { createHash } from 'node:crypto';

/** Injectable runId minter (matches the existing id-minter pattern); tests pass a
 *  deterministic counter. Default is time+random based. */
export type RunIdMinter = () => string;

/** Canonical identity fingerprint of a request: a hash of the NORMALIZED text
 *  (trimmed, internal whitespace collapsed). Used only for identity comparison —
 *  the verbatim request is kept separately for the finalizer. */
export function fingerprintRequest(request: string): string {
  const normalized = request.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/run-scope.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts
git commit -m "feat(controller): runId minter type + canonical request fingerprint"
```

---

### Task 5: Terminal store (separate keyed TTL store)

**Spec:** "`done`/abort" + "Terminal-write reconciliation" — a SEPARATE per-session store `{ runId → { terminalOutcome, expiresAt } }`, discriminated `terminalOutcome = {kind:'success', answer} | {kind:'error', error}`, GC'd by TTL, replayed only by explicit token.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/run-scope.ts`
- Test: extend `__tests__/run-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import {
  type TerminalOutcome,
  readTerminal,
  writeTerminal,
  gcTerminal,
} from '../run-scope.js';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';

describe('terminal store', () => {
  it('writes and reads a discriminated terminal outcome by runId, store-first', async () => {
    const be = new InMemoryKnowledgeBackend();
    const out: TerminalOutcome = { kind: 'success', answer: 'ANSWER' };
    await writeTerminal(be, 'sess', 'R1', out, 1000, '2026-06-10T00:00:00.000Z');
    const got = await readTerminal(be, 'sess', 'R1', '2026-06-10T00:00:00.500Z');
    assert.deepEqual(got, out);
  });
  it('returns undefined once expired (TTL elapsed)', async () => {
    const be = new InMemoryKnowledgeBackend();
    await writeTerminal(be, 'sess', 'R1', { kind: 'error', error: 'boom' }, 1000, '2026-06-10T00:00:00.000Z');
    const got = await readTerminal(be, 'sess', 'R1', '2026-06-10T00:00:02.000Z');
    assert.equal(got, undefined);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`
Expected: FAIL — `writeTerminal` not exported.

- [ ] **Step 3: Implement the terminal store**

Append to `run-scope.ts`:

```ts
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';

const TERMINAL_ARTIFACT_TYPE = 'controller-terminal';

export type TerminalOutcome =
  | { kind: 'success'; answer: string }
  | { kind: 'error'; error: string };

interface TerminalEntry {
  runId: string;
  terminalOutcome: TerminalOutcome;
  /** Absolute expiry timestamp (ISO). */
  expiresAt: string;
}

/** Persist a terminal outcome keyed by runId with a TTL. Written into the same
 *  KnowledgeBackend as the bundle but under a distinct artifactType so it
 *  survives the next run's bundle reset (the TTL promise). Pass `nowIso` so the
 *  caller controls time (no Date.now() in pure/testable code). */
export async function writeTerminal(
  be: KnowledgeBackend,
  sessionId: string,
  runId: string,
  terminalOutcome: TerminalOutcome,
  ttlMs: number,
  nowIso: string,
): Promise<void> {
  const expiresAt = new Date(new Date(nowIso).getTime() + ttlMs).toISOString();
  const entry: TerminalEntry = { runId, terminalOutcome, expiresAt };
  await be.put(sessionId, {
    content: JSON.stringify(entry),
    metadata: {
      traceId: sessionId,
      turnId: sessionId,
      stepperId: 'controller',
      task: 'terminal',
      artifactType: TERMINAL_ARTIFACT_TYPE,
      runId,
      createdAt: nowIso,
    },
  });
}

/** Read the latest non-expired terminal outcome for runId, or undefined. */
export async function readTerminal(
  be: KnowledgeBackend,
  sessionId: string,
  runId: string,
  nowIso: string,
): Promise<TerminalOutcome | undefined> {
  const now = new Date(nowIso).getTime();
  const entries = await be.scan(sessionId);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.metadata.artifactType !== TERMINAL_ARTIFACT_TYPE) continue;
    if (e.metadata.runId !== runId) continue;
    try {
      const parsed = JSON.parse(e.content) as TerminalEntry;
      if (new Date(parsed.expiresAt).getTime() <= now) return undefined;
      return parsed.terminalOutcome;
    } catch {
      // malformed — keep scanning backwards
    }
  }
  return undefined;
}

/** Best-effort GC marker: returns the runIds whose entries are expired as of
 *  nowIso (backends without delete simply ignore stale rows on read). */
export async function gcTerminal(
  be: KnowledgeBackend,
  sessionId: string,
  nowIso: string,
): Promise<string[]> {
  const now = new Date(nowIso).getTime();
  const expired: string[] = [];
  for (const e of await be.scan(sessionId)) {
    if (e.metadata.artifactType !== TERMINAL_ARTIFACT_TYPE) continue;
    try {
      const parsed = JSON.parse(e.content) as TerminalEntry;
      if (new Date(parsed.expiresAt).getTime() <= now) expired.push(parsed.runId);
    } catch {
      // ignore
    }
  }
  return expired;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/run-scope.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts
git commit -m "feat(controller): terminal store (keyed TTL) for done/abort replay"
```

---

### Task 6: Strict request classification

**Spec:** "Request classification — strict ordered algorithm" + "Crash recovery". Implements the ordered decision: (1) `newRun` flag → fresh; (2) explicit key/runId → strict (terminal-replay / active-resume guarded by `runState ∈ {active,suspended}` / not-found); (3) no key → fingerprint recovers only an ACTIVE run, terminal fingerprint match → fresh.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/run-scope.ts`
- Test: extend `__tests__/run-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { classifyRequest } from '../run-scope.js';

describe('classifyRequest (strict ordered)', () => {
  const bundle = (over = {}) => ({
    runId: 'R1', runState: 'active', runPhase: 'planning',
    originalRequest: 'read T100', ...over,
  }) as never as import('../types.js').SessionBundle;

  it('newRun flag wins over everything', () => {
    const r = classifyRequest({
      bundle: bundle(), incomingRequest: 'read T100', newRun: true,
      explicitKey: 'R1', terminalExists: true,
    });
    assert.equal(r.kind, 'fresh');
  });
  it('explicit key in terminal store → replay', () => {
    const r = classifyRequest({
      bundle: bundle({ runState: 'terminal' }), incomingRequest: 'x',
      explicitKey: 'R9', terminalExists: true,
    });
    assert.deepEqual(r, { kind: 'replay', runId: 'R9' });
  });
  it('explicit key == active bundle runId → resume', () => {
    const r = classifyRequest({
      bundle: bundle(), incomingRequest: 'x', explicitKey: 'R1', terminalExists: false,
    });
    assert.deepEqual(r, { kind: 'resume' });
  });
  it('explicit key matches a TERMINAL current run with no store entry → not-found', () => {
    const r = classifyRequest({
      bundle: bundle({ runState: 'terminal' }), incomingRequest: 'x',
      explicitKey: 'R1', terminalExists: false,
    });
    assert.equal(r.kind, 'not-found');
  });
  it('no key + fingerprint matches an ACTIVE run → resume', () => {
    const r = classifyRequest({
      bundle: bundle(), incomingRequest: 'read T100', terminalExists: false,
    });
    assert.deepEqual(r, { kind: 'resume' });
  });
  it('no key + fingerprint matches a TERMINAL run → fresh (no replay)', () => {
    const r = classifyRequest({
      bundle: bundle({ runState: 'terminal' }), incomingRequest: 'read T100',
      terminalExists: true,
    });
    assert.equal(r.kind, 'fresh');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`
Expected: FAIL — `classifyRequest` not exported.

- [ ] **Step 3: Implement `classifyRequest`**

Append to `run-scope.ts`:

```ts
import type { SessionBundle } from './types.js';

export type Classification =
  | { kind: 'fresh' }
  | { kind: 'resume' }
  | { kind: 'replay'; runId: string }
  | { kind: 'not-found' };

export interface ClassifyInput {
  bundle: SessionBundle;
  incomingRequest: string;
  /** Explicit idempotency key / runId supplied by the caller (if any). */
  explicitKey?: string;
  /** True when the consumer set the newRun flag for THIS request. */
  newRun?: boolean;
  /** Whether `explicitKey` (or, for fingerprint matches, the current bundle's
   *  runId) has a non-expired terminal-store entry. The handler computes this via
   *  readTerminal() before calling classify. */
  terminalExists: boolean;
}

/** Strict ordered request classification. First matching branch wins. */
export function classifyRequest(input: ClassifyInput): Classification {
  const { bundle, incomingRequest, explicitKey, newRun, terminalExists } = input;
  // 1. newRun overrides any replay.
  if (newRun) return { kind: 'fresh' };

  // 2. Explicit key → STRICT routing, no fingerprint fallback.
  if (explicitKey) {
    if (terminalExists) return { kind: 'replay', runId: explicitKey };
    const live = bundle.runState === 'active' || bundle.runState === 'suspended';
    if (explicitKey === bundle.runId && live) return { kind: 'resume' };
    return { kind: 'not-found' };
  }

  // 3. No key → fingerprint recovers ONLY an in-flight active run of the same
  //    request; a terminal fingerprint match starts fresh (can't tell a
  //    lost-response retry from an intentional re-run).
  const live = bundle.runState === 'active' || bundle.runState === 'suspended';
  const sameRequest =
    bundle.originalRequest !== undefined &&
    fingerprintRequest(bundle.originalRequest) === fingerprintRequest(incomingRequest);
  if (live && sameRequest) return { kind: 'resume' };
  return { kind: 'fresh' };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/run-scope.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/run-scope.test.ts
git commit -m "feat(controller): strict ordered request classification"
```

---

## Phase C — Roles

### Task 7: `IReviewer` + `LlmReviewer`

**Spec:** "Core idea: separate DOING from JUDGING", "Interfaces" (`IReviewer.review(step, evidence, executorResult, opts) → Outcome`), "Reviewer is ALWAYS-ON, tool-less by default".

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/reviewer.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/reviewer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// reviewer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ISubagentClient } from '../subagent-client.js';
import { LlmReviewer } from '../reviewer.js';

const client = (reply: string): ISubagentClient => ({
  async send() {
    return { kind: 'content', content: reply };
  },
});

describe('LlmReviewer', () => {
  it('parses a well-formed verdict into an Outcome', async () => {
    const r = new LlmReviewer(
      client(JSON.stringify({ status: 'ok', approved: 'RESULT', remainder: '', note: 'good' })),
    );
    const res = await r.review(
      { name: 's1', instructions: 'do' },
      [{ ref: 'x', hit: true }],
      'RESULT',
      {},
    );
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'ok');
    assert.equal(res.kind === 'outcome' && res.outcome.approved, 'RESULT');
  });

  it('a well-formed FAILED verdict is a real step outcome (NOT a judge failure)', async () => {
    const r = new LlmReviewer(
      client(JSON.stringify({ status: 'failed', approved: '', remainder: 'all', note: 'not done' })),
    );
    const res = await r.review({ name: 's1', instructions: 'do' }, [], 'RESULT', {});
    assert.equal(res.kind, 'outcome');
    assert.equal(res.kind === 'outcome' && res.outcome.status, 'failed');
  });

  it('status:ok with empty approved is a JUDGE FAILURE (contradictory → re-ask, not a step failure)', async () => {
    const r = new LlmReviewer(
      client(JSON.stringify({ status: 'ok', approved: '', remainder: '', note: '' })),
    );
    const res = await r.review({ name: 's1', instructions: 'do' }, [], 'RESULT', {});
    assert.equal(res.kind, 'judge-failure');
  });

  it('an unparsable reply is a JUDGE FAILURE', async () => {
    const r = new LlmReviewer(client('not json at all'));
    const res = await r.review({ name: 's1', instructions: 'do' }, [], 'RESULT', {});
    assert.equal(res.kind, 'judge-failure');
  });

  it('a provider error is a JUDGE FAILURE (NOT a step status:failed)', async () => {
    const errClient: ISubagentClient = { async send() { return { kind: 'error', error: 'boom' }; } };
    const r = new LlmReviewer(errClient);
    const res = await r.review({ name: 's1', instructions: 'do' }, [], 'RESULT', {});
    assert.equal(res.kind, 'judge-failure');
    assert.match(res.kind === 'judge-failure' ? res.reason : '', /boom|review/i);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/reviewer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reviewer.ts`**

```ts
// reviewer.ts
import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import { extractJsonObject } from './controller-coordinator-handler.js';
import { appendHint } from './prompts.js';
import type { Outcome } from './outcome.js';
import type { ISubagentClient } from './subagent-client.js';
import type { Step } from './types.js';

/** One reference's evidence: whether the per-reference recall found anything. */
export interface Evidence {
  ref: string;
  hit: boolean;
  topArtifact?: string;
}

export interface ReviewOpts {
  hint?: string;
  logUsage?: (role: string, u?: LlmUsage) => void;
}

/** The reviewer's return: EITHER an authoritative step Outcome (incl. a genuine
 *  `failed` verdict → step replan), OR a judge-failure — the reviewer could not
 *  produce a verdict (provider error / malformed / contradictory ok-with-empty).
 *  The controller MUST treat these differently: a judge-failure is re-asked
 *  within maxReviewRetries and, on exhaustion, ABORTS the run (the step outcome
 *  is unverifiable) — it is NEVER mapped to a step `failed`/replan (spec
 *  "Reviewer/finalizer failure semantics"). */
export type ReviewResult =
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'judge-failure'; reason: string };

/** Separate judging role. The controller depends ONLY on this; `status` always
 *  comes through a well-formed Outcome. Default impl is LLM-backed; swappable. */
export interface IReviewer {
  review(
    step: Step,
    evidence: readonly Evidence[],
    executorResult: string,
    opts: ReviewOpts,
  ): Promise<ReviewResult>;
}

const REVIEWER_SYSTEM =
  'You are the reviewer. You did NOT do the work — you JUDGE it. Given the ' +
  'step intent, the per-reference evidence, and the executor\'s result, decide ' +
  'the authoritative outcome and return a SINGLE JSON object: ' +
  '{"status":"ok"|"exists"|"failed"|"partial","approved":<content to keep>,' +
  '"remainder":<what is still missing>,"note":<short reason>}. ' +
  'Use "ok" when the step is fully satisfied, "exists" when the target already ' +
  'existed (idempotent no-op success), "partial" when only part is done (put the ' +
  'accepted content in "approved" and what remains in "remainder"), "failed" when ' +
  'the result does not satisfy the step. "approved" MUST be non-empty for ok/' +
  'exists/partial. Judge ONLY from the evidence + result; do NOT invent facts. ' +
  'Output JSON only.';

export class LlmReviewer implements IReviewer {
  constructor(private readonly client: ISubagentClient) {}

  async review(
    step: Step,
    evidence: readonly Evidence[],
    executorResult: string,
    opts: ReviewOpts,
  ): Promise<ReviewResult> {
    const evidenceBlock = evidence
      .map((e) => `- ${e.ref}: ${e.hit ? 'present' : 'MISSING'}`)
      .join('\n');
    const res = await this.client.send([
      { role: 'system', content: appendHint(REVIEWER_SYSTEM, opts.hint) },
      {
        role: 'user',
        content:
          `Step: ${step.name}\nIntent: ${step.instructions}\n` +
          `Evidence:\n${evidenceBlock || '(none)'}\n` +
          `Executor result:\n${executorResult}`,
      },
    ]);
    opts.logUsage?.('reviewer', res.usage);
    if (res.kind !== 'content') {
      // Provider/transport error → JUDGE failure (the verdict is unknown), NOT a
      // step failure. The handler re-asks within maxReviewRetries, then aborts.
      return { kind: 'judge-failure', reason: `reviewer error: ${res.kind === 'error' ? res.error : res.kind}` };
    }
    return parseReview(res.content);
  }
}

/** Parse a reviewer reply into a ReviewResult. A well-formed verdict (any of
 *  ok/exists/partial/failed) is an `outcome`. Unparsable, missing/invalid status,
 *  or ok/exists/partial with EMPTY approved (contradictory) is a `judge-failure`
 *  (re-ask, then abort) — it is NEVER coerced to a step `failed`. */
export function parseReview(content: string): ReviewResult {
  const json = extractJsonObject(content);
  if (json === null) return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  try {
    const o = JSON.parse(json) as Partial<Outcome>;
    const status = o.status;
    const approved = typeof o.approved === 'string' ? o.approved : '';
    const remainder = typeof o.remainder === 'string' ? o.remainder : '';
    const note = typeof o.note === 'string' ? o.note : '';
    if (status !== 'ok' && status !== 'exists' && status !== 'failed' && status !== 'partial') {
      return { kind: 'judge-failure', reason: 'missing/invalid status' };
    }
    if ((status === 'ok' || status === 'exists' || status === 'partial') && approved.length === 0) {
      return { kind: 'judge-failure', reason: `${status} with empty approved (contradictory)` };
    }
    return { kind: 'outcome', outcome: { status, approved, remainder, note } };
  } catch {
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  }
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/reviewer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/reviewer.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/reviewer.test.ts
git commit -m "feat(controller): IReviewer + LlmReviewer returning ReviewResult (outcome | judge-failure)"
```

---

### Task 8: `IFinalizer` + `LlmFinalizer` with read policy

**Spec:** "Interfaces" (`IFinalizer.finalize(goal, request, approvedResults) → answer`), "Finalizer read policy (budget / ordering / truncation / overflow)".

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/finalizer.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/finalizer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// finalizer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ISubagentClient } from '../subagent-client.js';
import { LlmFinalizer, orderAndTruncate, reduceToBudget } from '../finalizer.js';

describe('orderAndTruncate', () => {
  it('orders by seq and caps each result to C chars with a marker', () => {
    const out = orderAndTruncate(
      [{ seq: 1, content: 'BBBBB' }, { seq: 0, content: 'AAAAA' }],
      3,
    );
    assert.equal(out[0].seq, 0);
    assert.equal(out[0].content, 'AAA…[truncated]');
    assert.equal(out[1].seq, 1);
  });
});

describe('reduceToBudget', () => {
  it('always returns a body within budget (hard guarantee), even with many small results', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ seq: i, content: 'x'.repeat(100) }));
    const budget = 500;
    const body = reduceToBudget(many, 1000, budget);
    assert.ok(body.length <= budget, `body ${body.length} <= budget ${budget}`);
  });
  it('keeps a compact extract of EVERY result for a feasible budget (none dropped) and logs reductions', () => {
    const logs: string[] = [];
    const body = reduceToBudget(
      [{ seq: 0, content: 'A'.repeat(5000) }, { seq: 1, content: 'B'.repeat(5000) }, { seq: 2, content: 'C'.repeat(5000) }],
      1000, 900, (m) => logs.push(m),
    );
    assert.ok(body.length <= 900);
    // Every result is still represented by its [#seq] header (not dropped).
    assert.ok(body.includes('[#0]') && body.includes('[#1]') && body.includes('[#2]'),
      'all three results kept a compact extract');
    assert.ok(logs.length > 0 && /overflow/.test(logs.join(' ')), 'reductions logged');
  });

  it('never returns more than budget even when budget is below a single marker', () => {
    const body = reduceToBudget([{ seq: 0, content: 'X'.repeat(1000) }], 1000, 5);
    assert.ok(body.length <= 5, `tiny-budget body ${body.length} <= 5`);
  });
});

describe('LlmFinalizer', () => {
  it('composes the answer from approved results', async () => {
    const client: ISubagentClient = {
      async send() { return { kind: 'content', content: 'FINAL ANSWER' }; },
    };
    const f = new LlmFinalizer(client, { budget: 1000, perResultCap: 100 });
    const answer = await f.finalize('goal', 'request',
      [{ seq: 0, content: 'A' }, { seq: 1, content: 'B' }], {});
    assert.equal(answer, 'FINAL ANSWER');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/finalizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `finalizer.ts`**

```ts
// finalizer.ts
import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import { appendHint } from './prompts.js';
import type { ISubagentClient } from './subagent-client.js';

export interface ApprovedResult {
  seq: number;
  content: string;
}

export interface FinalizeOpts {
  hint?: string;
  logUsage?: (role: string, u?: LlmUsage) => void;
  /** Narrator for reduction events (spec: "log every reduction"). */
  log?: (msg: string) => void;
}

export interface FinalizerPolicy {
  /** Total token-ish budget B (chars proxy here); overflow → reduce. */
  budget: number;
  /** Per-result cap C (chars). */
  perResultCap: number;
}

/** Single finalizer for BOTH planners: compose the answer from the run-scoped
 *  approved results after `done`. */
export interface IFinalizer {
  finalize(
    goal: string,
    request: string,
    approvedResults: readonly ApprovedResult[],
    opts: FinalizeOpts,
  ): Promise<string>;
}

const FINALIZE_SYSTEM =
  'All planned steps are complete. Using the fetched results below, write the ' +
  'final answer to the user request. Plain text, no JSON. Do not invent facts ' +
  'beyond the provided results.';

const TRUNC_MARKER = '…[truncated]';

/** Order results by seq and cap each to `cap` chars with a marker. Pure. */
export function orderAndTruncate(
  results: readonly ApprovedResult[],
  cap: number,
): ApprovedResult[] {
  return results
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((r) =>
      r.content.length > cap
        ? { seq: r.seq, content: r.content.slice(0, cap) + TRUNC_MARKER }
        : r,
    );
}

/** Compose the finalizer body, reducing to fit `budget` as a map-reduce that keeps
 *  a compact representation of EVERY result (spec: "summarize largest/oldest into
 *  compact extracts; never silently drop; log every reduction"):
 *  1. Reduce the LARGEST result's cap (halving, logged) until the body fits or
 *     every result is at the per-result floor.
 *  2. If still over budget (many results), HARD-distribute the budget evenly: each
 *     result keeps a compact head extract sized to its fair per-result share (with
 *     a `…[truncated]` marker) — so NO result is dropped, every `[#seq]` is still
 *     present. The share is sized to account for prefix+marker+separator overhead
 *     so the joined body is <= budget by construction.
 *  3. If the budget cannot hold N compact extracts, emit a single compact MANIFEST
 *     that NAMES every seq (e.g. "[results omitted — too small for budget: #0 #1
 *     #2]") so no result is silently dropped (#3/plan-8); a final hard slice
 *     guarantees <= budget for a truly pathological budget.
 *  Deterministic; an LLM-summarizer map-reduce is a future variant. Pure aside
 *  from `log`. */
export function reduceToBudget(
  results: readonly ApprovedResult[],
  perResultCap: number,
  budget: number,
  log?: (msg: string) => void,
): string {
  const FLOOR = 80;
  const SEP = '\n\n';
  const ordered = results.slice().sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) return '';
  const caps = new Map<number, number>(ordered.map((r) => [r.seq, perResultCap]));
  const chunk = (r: ApprovedResult) => {
    const cap = caps.get(r.seq)!;
    const c = r.content.length > cap ? r.content.slice(0, cap) + TRUNC_MARKER : r.content;
    return `[#${r.seq}] ${c}`;
  };
  const render = () => ordered.map(chunk).join(SEP);
  let body = render();
  // Pass 1: halve the largest reducible result until fit or all at floor.
  while (body.length > budget) {
    let target: number | undefined;
    let largest = -1;
    for (const r of ordered) {
      const cap = caps.get(r.seq)!;
      const len = Math.min(r.content.length, cap);
      if (cap > FLOOR && len > largest) {
        largest = len;
        target = r.seq;
      }
    }
    if (target === undefined) break; // all at floor
    const next = Math.max(FLOOR, Math.floor(caps.get(target)! / 2));
    caps.set(target, next);
    log?.(`finalizer overflow: reduced result #${target} cap → ${next} chars`);
    body = render();
  }
  // Pass 2: even per-result share so EVERY result keeps a compact extract.
  if (body.length > budget) {
    const n = ordered.length;
    const overheadPerResult = `[#${ordered[ordered.length - 1].seq}] `.length + TRUNC_MARKER.length + SEP.length;
    const share = Math.max(0, Math.floor(budget / n) - overheadPerResult);
    for (const r of ordered) caps.set(r.seq, share);
    log?.(`finalizer overflow: even per-result share ${share} chars across ${n} results (none dropped)`);
    body = render();
  }
  // Pass 3: budget too small for N compact extracts → compact MANIFEST naming
  // every seq (no result silently dropped). A final slice guards a pathological
  // budget smaller than even the manifest.
  if (body.length > budget) {
    const manifest = `[results omitted — budget too small to inline: ${ordered.map((r) => `#${r.seq}`).join(' ')}]`;
    log?.(`finalizer overflow: emitting compact manifest of ${ordered.length} seqs (budget ${budget})`);
    body = manifest.length <= budget ? manifest : manifest.slice(0, budget);
  }
  return body;
}

export class LlmFinalizer implements IFinalizer {
  constructor(
    private readonly client: ISubagentClient,
    private readonly policy: FinalizerPolicy,
  ) {}

  async finalize(
    goal: string,
    request: string,
    approvedResults: readonly ApprovedResult[],
    opts: FinalizeOpts,
  ): Promise<string> {
    const body = reduceToBudget(
      approvedResults,
      this.policy.perResultCap,
      this.policy.budget,
      opts.log,
    );
    const res = await this.client.send([
      { role: 'system', content: appendHint(FINALIZE_SYSTEM, opts.hint) },
      { role: 'user', content: `Goal: ${goal}\nRequest: ${request}\nResults:\n${body}` },
    ]);
    opts.logUsage?.('finalizer', res.usage);
    if (res.kind !== 'content') {
      throw new Error(`finalizer error: ${res.kind === 'error' ? res.error : res.kind}`);
    }
    return res.content;
  }
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/finalizer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/finalizer.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/finalizer.test.ts
git commit -m "feat(controller): IFinalizer + LlmFinalizer with order/truncate/overflow read policy"
```

---

### Task 9: Planner `partial` transition

**Spec:** "Planner transitions (#2 — partial is a first-class outcome)" — `commit()`/`lastOutcome` extended to `advanced|failed|partial`; `partial` advances the cursor for the accepted part AND forces a replan of the remainder.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts:159-228`
- Test: extend `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// in planner.test.ts
import { AdaptivePlanner } from '../planner.js';
// inside describe(...)
it('commit(partial) advances the cursor (accepted part not re-run)', () => {
  const p = new AdaptivePlanner({ async send() { return { kind: 'content', content: '' }; } });
  const bundle = {
    goal: 'g', plannerPrivate: '', budgets: { stepsUsed: 1, rewindsUsed: 0 },
    plan: [{ name: 's1', instructions: 'i' }, { name: 's2', instructions: 'j' }],
    planCursor: 0,
  } as never as import('../types.js').SessionBundle;
  p.commit(bundle, 'partial');
  assert.equal(bundle.planCursor, 1);
});
it('next() replans when lastOutcome is partial', async () => {
  let sawReplan = false;
  const p = new AdaptivePlanner({
    async send(messages) {
      if (typeof messages[0]?.content === 'string' && /REVISED/.test(messages[0].content)) sawReplan = true;
      return { kind: 'content', content: JSON.stringify({ plan: [] }) };
    },
  });
  const bundle = {
    goal: 'g', plannerPrivate: '\n[step s1 partial] only half',
    budgets: { stepsUsed: 1, rewindsUsed: 0 },
    plan: [{ name: 's1', instructions: 'i' }], planCursor: 1, lastOutcome: 'partial',
  } as never as import('../types.js').SessionBundle;
  await p.next({ bundle, prompt: 'p', lastOutcome: 'partial', retrying: false });
  assert.ok(sawReplan, 'partial triggered a REVISED replan');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`
Expected: FAIL — `commit(bundle,'partial')` not handled (cursor stays 0) and/or replan not triggered for `partial`.

- [ ] **Step 3: Implement the `partial` handling in `planner.ts`**

In `AdaptivePlanner.commit`, change the signature and body to:

```ts
  commit(bundle: SessionBundle, outcome: 'advanced' | 'failed' | 'partial'): void {
    // Both 'advanced' and 'partial' advance the cursor: the accepted part of a
    // partial is committed and must not be re-run. 'failed' leaves the cursor so
    // next() replans from it.
    if (outcome === 'advanced' || outcome === 'partial') {
      bundle.planCursor = (bundle.planCursor ?? 0) + 1;
    }
  }
```

In `AdaptivePlanner.next`, change the replan trigger (`if (lastOutcome === 'failed' || resumedExternal)`) to also fire for `partial`:

```ts
    if (lastOutcome === 'failed' || lastOutcome === 'partial' || resumedExternal) {
      const system = resumedExternal
        ? EXTERNAL_RESULT_REPLAN_SYSTEM
        : REPLAN_SYSTEM; // REPLAN_SYSTEM mentions REVISED — matches the test
```

(The remainder of that branch is unchanged: it slices `plan` at the cursor, calls the replan, clears `bundle.lastOutcome`, and emits the step at the cursor. Because `commit('partial')` already advanced the cursor, the replan plans the remainder AFTER the accepted part.)

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`
Expected: PASS (existing planner tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): planner partial transition (advance accepted + replan remainder)"
```

---

## Phase D — Handler integration (the rewrite, in green increments)

> Each Phase-D task keeps `ControllerCoordinatorHandler` compiling and its existing test suite green. New deps (`reviewer`, `finalizer`, `runIdMinter`, `now`, `terminalTtlMs`) are added to `ControllerHandlerDeps` with safe behaviour so the factory task (Phase E) can wire them last. Until Phase E the existing tests construct the handler without the new deps; make the new deps OPTIONAL on `ControllerHandlerDeps` and supply built-in defaults (a pass-through reviewer that approves content, a finalizer that echoes — see Step 1 of Task 10) so the legacy suite stays green. The factory then injects the real impls.

### Task 10: Add reviewer/finalizer/run-scope deps with safe defaults

**Spec:** "Interfaces" (DI seams), "Config & roles contract".

**Files:**
- Modify: `controller-coordinator-handler.ts:90-125` (the `ControllerHandlerDeps` interface) and constructor area.
- Test: extend `__tests__/controller-coordinator-handler.test.ts` — add a default-reviewer regression.

- [ ] **Step 1: Extend `ControllerHandlerDeps`**

Add to the `ControllerHandlerDeps` interface:

```ts
  /** Judge role. Optional; when absent the handler uses a built-in
   *  approve-content reviewer (legacy behaviour — every content result is 'ok')
   *  so pre-reviewer callers keep working. The factory injects LlmReviewer. */
  reviewer?: IReviewer;
  /** Finalizer role. Optional; when absent the adaptive planner's own finalize is
   *  used and the incremental planner's `done.result` is the answer (legacy). */
  finalizer?: IFinalizer;
  /** Injectable runId minter (tests pass a deterministic counter). */
  runIdMinter?: RunIdMinter;
  /** Clock seam (ISO now). Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Terminal-store TTL in ms (default 24h). */
  terminalTtlMs?: number;
```

Add the imports at the top of the handler:

```ts
import type { IReviewer } from './reviewer.js';
import type { IFinalizer } from './finalizer.js';
import type { RunIdMinter } from './run-scope.js';
```

And `import type { Outcome } from './outcome.js';`.

Inside `execute`, resolve the seams once near the top (after `const deps = this.deps;`):

```ts
    const now = deps.now ?? (() => new Date().toISOString());
    const mintRunId =
      deps.runIdMinter ?? (() => `run-${now()}-${Math.round(Math.random() * 1e9)}`);
    const terminalTtlMs = deps.terminalTtlMs ?? 24 * 60 * 60 * 1000;
```

> `Math.random()` is acceptable here (runtime path, not a workflow script). The minter is injectable so tests stay deterministic.

- [ ] **Step 2: Build (server-libs only) and run the existing suite**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — all existing tests unchanged (new deps are optional, defaults preserve behaviour).

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts
git commit -m "feat(controller): optional reviewer/finalizer/run-scope deps with legacy-safe defaults"
```

---

### Task 11: Write-after-review in `runStep`

**Spec:** "Outcome persistence (write-after-review)" + "Reviewer crash safety". The executor result is held in memory; the reviewer judges; the controller writes the artifact ONCE with `attempt` + the full `Outcome`; maps status → planner transition.

**Files:**
- Modify: `controller-coordinator-handler.ts` (the `res.kind === 'content'` branch of `runStep`, currently lines 458-468) + the failed branches.
- Test: extend `__tests__/controller-coordinator-handler.test.ts`.

- [ ] **Step 1: Write the failing test (reviewer downgrades a confabulated success to failed)**

```ts
it('reviewer verdict (not the executor) decides the outcome', async () => {
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({ kind: 'next', step: { name: 's1', instructions: 'do' } }) },
      { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'final' }) },
    ],
    executor: [{ kind: 'content', content: 'I think it worked' }],
  });
  // Inject a reviewer that fails the step regardless of the executor's claim.
  h.deps.reviewer = {
    async review() { return { status: 'failed', approved: '', remainder: 'all', note: 'not done' }; },
  };
  const handler = new ControllerCoordinatorHandler(h.deps);
  const { ctx } = fakeCtx();
  await handler.execute(ctx, {}, undefined);
  // The written step-result artifact must carry status:'failed', not a bare success.
  const stepArtifact = h.rag.written.find((e) => e.metadata.artifactType === 'step-result');
  assert.equal(stepArtifact?.metadata.status, 'failed');
});

it('a judge-failure is re-asked then ABORTS the run (terminal error), not a step replan', async () => {
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({ kind: 'next', step: { name: 's1', instructions: 'do' } }) },
      // A replan would consume this; the run must NOT reach it.
      { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'should-not-happen' }) },
    ],
    executor: [{ kind: 'content', content: 'result' }, { kind: 'content', content: 'result' }],
    config: baseConfig({ maxReviewRetries: 1 }),
  });
  let reviewCalls = 0;
  h.deps.reviewer = {
    async review() { reviewCalls++; return { kind: 'judge-failure', reason: 'provider down' }; },
  };
  const handler = new ControllerCoordinatorHandler(h.deps);
  const { ctx, captured } = fakeCtx();
  await handler.execute(ctx, {}, undefined);
  assert.equal(reviewCalls, 2, 're-asked once (maxReviewRetries=1) then aborted');
  assert.ok(captured.find((c) => c.ok && /unverifiable|Error:/i.test(c.value.content)),
    'surfaced a terminal error, not a replanned done');
  const bundle = await hydrateBundle(h.backend, 'sess-1');
  assert.equal(bundle.runState, 'terminal');
  const { readTerminal } = await import('../run-scope.js');
  const term = await readTerminal(h.backend, 'sess-1', bundle.runId!, new Date().toISOString());
  assert.equal(term?.kind, 'error');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — current code writes the artifact with no `status` and always settles `'advanced'`.

- [ ] **Step 3: Implement write-after-review**

Replace the `res.kind === 'content'` branch in `runStep` (currently `controller-coordinator-handler.ts:458-468`) with: hold the result, run the reviewer (default impl approves), write once with attempt+status, settle by mapped outcome.

```ts
      if (res.kind === 'content') {
        // Hold the executor's result in memory; the reviewer (NOT the executor)
        // decides the outcome. Default reviewer (no deps.reviewer) approves the
        // content as 'ok' to preserve legacy behaviour.
        let review: ReviewResult = deps.reviewer
          ? await deps.reviewer.review(step, evidence, res.content, {
              hint: deps.config.subagents.reviewer?.hint,
              logUsage,
            })
          : { kind: 'outcome', outcome: { status: 'ok', approved: res.content, remainder: '', note: '' } };

        // Judge failure (provider error / malformed / contradictory ok-with-empty)
        // is NOT a step failure: re-ask the reviewer within maxReviewRetries (an
        // in-process budget — a crash mid-review re-executes the step per #2/18),
        // then ABORT the run (the step outcome is unverifiable). It is never
        // mapped to settle('failed')/replan.
        let reviewRetries = 0;
        while (review.kind === 'judge-failure') {
          reviewRetries++;
          if (reviewRetries > (cfg.maxReviewRetries ?? 2)) {
            return abortRun(`step ${step.name} outcome unverifiable: ${review.reason}`);
          }
          review = await deps.reviewer!.review(step, evidence, res.content, {
            hint: deps.config.subagents.reviewer?.hint,
            logUsage,
          });
        }

        const outcome = review.outcome;
        const seq = bundle.inFlightStep?.seq ?? bundle.nextSeq ?? 0;
        const attempt = bundle.inFlightStep?.attempt ?? 0;
        // ONE write, post-review, carrying the COMPLETE Outcome + identity
        // (status/note/remainder all durable, so a crash before the bundle
        // persist loses neither remainder nor note — #2/26).
        await writeArtifact(rag, {
          ...meta,
          artifactType: 'step-result',
          task: step.name,
          runId: bundle.runId,
          seq,
          attempt,
          status: outcome.status,
          note: outcome.note,
          remainder: outcome.remainder,
          content: outcome.approved,
        });
        bundle.budgets.stepsUsed++;
        const mapped = mapOutcome(outcome.status); // 'advanced' | 'failed' | 'partial'
        // Payload-free control cache (spec): {seq,status,note,remainder}, NOT the
        // approved content — the content lives in results-RAG (recalled per step,
        // read by the finalizer). Normal commit AND reconciliation use the SAME
        // helper so they produce identical control state (#3/plan-6).
        recordStepControl(bundle, {
          seq: bundle.inFlightStep?.seq ?? seq,
          name: step.name,
          status: outcome.status,
          note: outcome.note,
          remainder: outcome.remainder,
        });
        return settle(mapped);
      }
```

Add the shared `recordStepControl` helper near `mapOutcome`:

```ts
/** Append ONE payload-free control record to plannerPrivate (the cache holds
 *  {seq,status,note,remainder}, never the approved content). Used by both normal
 *  settle and crash/external reconciliation so plannerPrivate is identical
 *  whichever path committed the step. */
function recordStepControl(
  bundle: SessionBundle,
  rec: { seq: number; name: string; status: Outcome['status']; note?: string; remainder?: string },
): void {
  bundle.plannerPrivate +=
    `\n[seq ${rec.seq} ${rec.name} ${rec.status}]` +
    (rec.note ? ` ${rec.note}` : '') +
    (rec.remainder ? ` remainder: ${rec.remainder}` : '');
}
```

`abortRun` is a small closure inside `runStep` that delegates to the handler's
`abortTerminal` and returns the `'aborted'` step result so the caller stops the
loop. Define it near the top of `runStep` (after `settle`):

```ts
    // Unrecoverable abort: store-first terminal ERROR, flip the bundle terminal,
    // surface the error, and signal the caller to stop. Used for an unverifiable
    // reviewer outcome (judge-failure budget exhausted). Returns 'aborted'.
    const abortRun = async (error: string): Promise<'aborted'> => {
      await this.abortTerminal(ctx, sessionId, bundle, error, now, terminalTtlMs, usageNow?.());
      return 'aborted';
    };
```

Set `runStep`'s return union to the FULL set `'advanced' | 'failed' | 'partial' | 'suspended' | 'aborted'` (it returns `settle(...)` — which yields `advanced`/`failed`/`partial` — plus the `'suspended'`/`'aborted'` sentinels). Use this exact union everywhere `runStep`'s type appears (signature, `settle`, `abortRun`). Add `now: () => string` and `terminalTtlMs: number` to its parameters (pass them from `execute`), and in `execute` treat the terminal/suspend sentinels as run-ending:

```ts
      if (completed === 'suspended' || completed === 'aborted') return true;
```

Define the shared `abortTerminal` private method on the handler (used here and by the resume-budget guards in Task 13 and the finalizer in Task 15):

```ts
  /** Store-first terminal ERROR: write the terminal outcome to the TTL store
   *  FIRST (keyed by runId), THEN flip the bundle to terminal and surface the
   *  error. The store-first order makes the abort idempotent across a crash
   *  between the two writes (spec "Terminal-write reconciliation"). */
  private async abortTerminal(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    error: string,
    now: () => string,
    terminalTtlMs: number,
    usage?: TerminalUsage,
  ): Promise<void> {
    await writeTerminal(
      this.deps.backend,
      sessionId,
      bundle.runId ?? sessionId,
      { kind: 'error', error },
      terminalTtlMs,
      now(),
    );
    bundle.pending = undefined;
    bundle.inFlightStep = undefined;
    bundle.runState = 'terminal';
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceFinal(ctx, `Error: ${error}`, usage);
  }
```

Add `import type { ReviewResult } from './reviewer.js';` (alongside the `IReviewer` import) and ensure `writeTerminal` is imported from `./run-scope.js`.

Add the `mapOutcome` helper near the other pure helpers at the bottom of the file:

```ts
/** Map a reviewer status to the planner transition. ok/exists advance; partial
 *  advances the accepted part AND forces a remainder replan; failed replans. */
function mapOutcome(status: Outcome['status']): 'advanced' | 'failed' | 'partial' {
  if (status === 'ok' || status === 'exists') return 'advanced';
  if (status === 'partial') return 'partial';
  return 'failed';
}
```

Widen `settle`'s type to `'advanced' | 'failed' | 'partial'` (signature at `runStep` line ~399) and the `runStep` return type, and `onCommit`'s type, to include `'partial'`. The `writeArtifact` `Artifact` type already spreads `KnowledgeEntryMetadata`, which now (Task 2) carries `runId/seq/attempt/status`.

Add the per-`requires` evidence gathering BEFORE the executor loop (after the existing recall block, ~line 432). For now, derive a single whole-step evidence entry from the recall; the full per-reference manifest is Task 16:

```ts
    // Evidence for the reviewer: whether the step's recall surfaced anything.
    // The per-reference manifest (step.requires) is added later; for now one
    // whole-step evidence entry keeps the reviewer grounded.
    const evidence = [{ ref: recallText, hit: recalled.length > 0 }];
```

- [ ] **Step 4: Run, verify it passes (and legacy suite stays green)**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — the new test plus all existing (default reviewer keeps the happy path 'advanced').

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): write-after-review — reviewer decides status; artifact carries attempt+Outcome"
```

---

### Task 12: Durable counters + `inFlightStep` lifecycle

**Spec:** "Stable seq + durable counters", "inFlightStep lifecycle by outcome", "maxToolCalls exceeded is a controller failure", "every fresh attempt resets resumeCount/transcript/toolCallCount".

**Files:**
- Modify: `controller-coordinator-handler.ts` — establish `inFlightStep` before executing a step; increment `attempt` before the executor call; replace the local `toolCalls` with durable `inFlightStep.toolCallCount`; commit/advance `nextSeq` on settle; persist `controlFailure` on the maxToolCalls path.
- Test: extend handler test.

- [ ] **Step 1: Write the failing test (toolCallCount is durable across a re-entry)**

```ts
it('maxToolCalls is bounded by the durable toolCallCount, and abort is a controlFailure replan', async () => {
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({ kind: 'next', step: { name: 's1', instructions: 'do' } }) },
      { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'after-budget' }) },
    ],
    executor: Array.from({ length: 20 }, () => toolCall('LoopTool', {})),
    selectTools: [{ name: 'LoopTool', description: '', inputSchema: {} }],
    isExternalTool: () => false,
    config: baseConfig({ maxToolCalls: 2 }),
  });
  const handler = new ControllerCoordinatorHandler(h.deps);
  const { ctx } = fakeCtx();
  await handler.execute(ctx, {}, undefined);
  assert.ok(h.mcpCalls.length <= 2, 'callMcp bounded by maxToolCalls');
  const bundle = await hydrateBundle(h.backend, 'sess-1');
  assert.equal(bundle.budgets.stepsUsed, 1);
});

it('maxStepResumes: a crash-replay with no committed artifact charges resumeCount and aborts at the cap', async () => {
  const backend = new InMemoryKnowledgeBackend();
  // Seed an executing inFlightStep at resumeCount === cap, no committed artifact.
  await persistBundle(backend, 'sess-1', {
    goal: 'g', plannerPrivate: '', budgets: { stepsUsed: 0, rewindsUsed: 0 },
    runId: 'R1', runState: 'active', runPhase: 'executing', originalRequest: 'x', nextSeq: 0,
    inFlightStep: { seq: 0, step: { name: 's1', instructions: 'i' }, attempt: 0, resumeCount: 1, phase: 'executing', transcript: [], toolCallCount: 0 },
    plan: [{ name: 's1', instructions: 'i' }], planCursor: 0,
  } as never);
  let plannerCalls = 0;
  const h = harness({
    evaluator: [], executor: [{ kind: 'content', content: 'x' }],
    planner: [], config: { ...baseConfig(), planner: 'adaptive', budgets: { ...baseConfig().budgets, maxStepResumes: 1 } },
  });
  h.deps.backend = backend;
  // The executing-recovery is planner-INDEPENDENT: the in-flight step is
  // reconciled/aborted DIRECTLY, the planner must NOT be consulted for it.
  h.deps.planner = { async send() { plannerCalls++; return { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'should-not-run' }) }; } };
  const { ctx, captured } = fakeCtx({ textOrMessages: 'x' });
  await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
  const bundle = await hydrateBundle(backend, 'sess-1');
  assert.equal(bundle.runState, 'terminal', 'aborted at maxStepResumes');
  assert.equal(plannerCalls, 0, 'planner was NOT consulted for the in-flight executing step');
  assert.ok(captured.find((c) => c.ok && /maxStepResumes|Error:/.test(c.value.content)));
});
```

- [ ] **Step 2: Run, verify it fails / regresses**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: the existing `internal tool-call budget` test currently passes against the LOCAL `toolCalls`; this task moves it to durable state. After Step 3 both must pass.

- [ ] **Step 3: Executing recovery (planner-independent) + fresh-attempt open**

Add the imports this task needs (Task 12 owns them so it compiles standalone;
later tasks reuse them): `import { resolveByPrecedence } from './outcome.js';`
(`Outcome` is already imported in Task 10; `mapOutcome` is the local helper added
in Task 11).

First declare the transient continuation flag near the existing
`let resumedExternal = false;` at the top of `execute` (Task 12 owns it so this
task compiles standalone; Task 14 only SETS it):

```ts
    let externalContinuation = false;
```

**(A) Top-of-loop executing recovery — does NOT consult the planner (#3/plan-4).**
An in-flight executing step (a crash-replay or an external continuation) must be
reconciled/re-run DIRECTLY from `inFlightStep.step`, because a custom/incremental
planner is not guaranteed to re-emit the same step (it may return a different step
or `done`). Add this as the FIRST statement inside the `while` loop body, BEFORE
`planner.next(...)`:

```ts
      const inf = bundle.inFlightStep;
      if (inf && inf.phase === 'executing') {
        // Reconcile by THIS attempt's resolved artifact first.
        const committed = await rag.list({ runId: bundle.runId, seq: inf.seq, attempt: inf.attempt, artifactType: 'step-result' });
        const resolved = resolveByPrecedence(
          committed.map((e) => ({ status: (e.metadata.status ?? 'failed') as Outcome['status'], approved: e.content, remainder: e.metadata.remainder ?? '', note: e.metadata.note ?? '' })),
        );
        if (resolved) {
          // Already committed → adopt, do NOT re-run. Apply the SAME commit side
          // effects as settle() — including planner.commit() so the adaptive
          // planCursor advances in lockstep with nextSeq (#1/plan-5); otherwise the
          // planner could re-emit an already-committed step.
          const mapped = mapOutcome(resolved.status);
          bundle.lastOutcome = mapped;
          planner.commit?.(bundle, mapped);
          // Same payload-free control record as the normal path (#3/plan-6), so
          // the planner sees identical state whichever path committed; carries the
          // durable note/remainder for replan after a crash (#4/plan-5, #5/plan-4).
          recordStepControl(bundle, { seq: inf.seq, name: inf.step.name, status: resolved.status, note: resolved.note, remainder: resolved.remainder });
          if (resolved.status === 'failed') {
            inf.phase = 'awaiting-replan';
          } else {
            bundle.nextSeq = inf.seq + 1;
            bundle.inFlightStep = undefined;
            bundle.runPhase = 'planning';
          }
          await persistBundle(deps.backend, sessionId, bundle);
          continue; // re-enter the loop with reconciled state → planner.next
        }
        // No artifact for this attempt → re-run the SAME step directly.
        // Distinguish a live external CONTINUATION (bounded by toolCallCount, not a
        // crash) from a genuine crash-replay (charged to resumeCount).
        if (externalContinuation) {
          externalContinuation = false; // consume the transient flag — no charge
        } else {
          inf.resumeCount += 1;
          if (inf.resumeCount > (cfg.maxStepResumes ?? 3)) {
            await this.abortTerminal(ctx, sessionId, bundle, `step "${inf.step.name}" exceeded maxStepResumes`, now, terminalTtlMs, usageNow());
            return true;
          }
        }
        await persistBundle(deps.backend, sessionId, bundle);
        const completed = await this.runStep(
          ctx, sessionId, bundle, rag, meta, inf.step, isExternalTool,
          logUsage, usageNow, (o) => planner.commit?.(bundle, o), now, terminalTtlMs,
        );
        if (completed === 'suspended' || completed === 'aborted') return true;
        continue; // settle() already advanced/cleared inFlightStep
      }
```

**(B) Fresh-attempt open at the `next.kind === 'next'` dispatch site.** Replace the
existing fresh dispatch (around line 344) so it ONLY opens a new in-flight step for
a step the planner just emitted (a brand-new seq, or a revised step after
`awaiting-replan`). Crash-replay/continuation is handled by (A) above, so this site
never re-enters an `executing` step.

```ts
      // The planner emitted a step to run. Open a fresh attempt at the current
      // seq: attempt 0 for a new seq, or attempt+1 for a revised step after
      // awaiting-replan (same seq).
      const seq = bundle.nextSeq ?? 0;
      const prev = bundle.inFlightStep; // only ever phase 'awaiting-replan' here
      const attempt = prev && prev.seq === seq ? prev.attempt + 1 : 0;
      // Durable fresh-attempt cap (0-based index; cap N → N executions 0..N-1).
      if (attempt >= (cfg.maxStepAttempts ?? 5)) {
        await this.abortTerminal(ctx, sessionId, bundle, `step "${next.step.name}" exceeded maxStepAttempts`, now, terminalTtlMs, usageNow());
        return true;
      }
      bundle.inFlightStep = {
        seq,
        step: next.step,
        attempt,
        resumeCount: 0,
        phase: 'executing',
        transcript: [],
        toolCallCount: 0,
      };
      bundle.runPhase = 'executing';
      await persistBundle(deps.backend, sessionId, bundle);
```

In `runStep`, replace the local `let toolCalls = 0;` and its increments with the durable counter:

```ts
    const maxToolCalls = cfg.maxToolCalls ?? 10;
    const inFlight = bundle.inFlightStep; // set by the caller
```

At the internal-tool branch (currently `toolCalls++; if (toolCalls > maxToolCalls)`), use:

```ts
      // Durable round-trip count: ++ and persist BEFORE surfacing the call so it
      // survives a resume (never a per-resume local).
      if (inFlight) {
        inFlight.toolCallCount += 1;
        await persistBundle(deps.backend, sessionId, bundle);
      }
      if ((inFlight?.toolCallCount ?? 0) > maxToolCalls) {
        // Controller-level failure (NOT a reviewer status): record the reason
        // durably and replan at the same seq.
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[seq ${inFlight?.seq ?? bundle.nextSeq ?? 0} ${step.name} control-failed] tool-call budget exhausted (maxToolCalls)`;
        if (inFlight) {
          inFlight.phase = 'awaiting-replan';
          inFlight.controlFailure = { reason: 'maxToolCalls', seq: inFlight.seq };
        }
        return settle('failed');
      }
```

In `settle`, on a committing outcome (`advanced`/`partial`) advance `nextSeq` and clear `inFlightStep`; on `failed` leave the seq for replan. Replace the `settle` body:

```ts
    const settle = async (
      outcome: 'advanced' | 'failed' | 'partial',
    ): Promise<'advanced' | 'failed' | 'partial'> => {
      bundle.lastOutcome = outcome;
      onCommit?.(outcome);
      if (outcome === 'advanced' || outcome === 'partial') {
        bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
        bundle.inFlightStep = undefined;
        bundle.runPhase = 'planning';
      } else {
        // 'failed' — normative atomic transition: keep the same seq and mark the
        // step awaiting-replan in the SAME persist, so recovery routes to replan
        // by durable phase (not by a live lastOutcome or a later reconciliation).
        if (bundle.inFlightStep) bundle.inFlightStep.phase = 'awaiting-replan';
        bundle.runPhase = 'executing';
      }
      await persistBundle(deps.backend, sessionId, bundle);
      return outcome;
    };
```

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — the new test + the existing `internal tool-call budget` test (now backed by durable count) + the rest.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): durable inFlightStep (attempt/resumeCount/toolCallCount/controlFailure) + nextSeq lifecycle"
```

---

### Task 13: Three-stage recovery + planner/eval/finalize crash guards

**Spec:** "Crash recovery — active with no pending", "Active run, match → resume in a fixed three-stage order", "General invariant" (per-phase in-flight markers + resume counters), "planner guard covers awaiting-replan replan".

**Files:**
- Modify: `controller-coordinator-handler.ts` — at the top of `execute`, run classification + the three-stage recovery; guard each LLM call with its marker/counter.
- Test: extend handler test with crash-recovery cases.

- [ ] **Step 1: Write the failing tests**

```ts
it('three-stage recovery: terminal store wins over phase (no re-finalize)', async () => {
  const backend = new InMemoryKnowledgeBackend();
  // Seed an ACTIVE bundle stuck in finalizing AND a terminal outcome for its runId.
  await persistBundle(backend, 'sess-1', {
    goal: 'g', plannerPrivate: '', budgets: { stepsUsed: 1, rewindsUsed: 0 },
    runId: 'R1', runState: 'active', runPhase: 'finalizing',
    originalRequest: 'do the thing', nextSeq: 1,
  } as never);
  const { writeTerminal } = await import('../run-scope.js');
  await writeTerminal(backend, 'sess-1', 'R1', { kind: 'success', answer: 'ALREADY' }, 60000, '2026-06-10T00:00:00.000Z');
  const h = harness({ evaluator: [], planner: [], executor: [] });
  h.deps.backend = backend;
  h.deps.now = () => '2026-06-10T00:00:01.000Z';
  const { ctx, captured } = fakeCtx({ textOrMessages: 'do the thing' });
  await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
  assert.ok(captured.find((c) => c.ok && c.value.finishReason === 'stop' && c.value.content === 'ALREADY'),
    'adopted terminal outcome without re-finalizing');
});

it('planner replan crash-guard: a crash mid-replan charges plannerResumeCount, capped', async () => {
  // Seed awaiting-replan with plannerCallInFlight already true (a crash during a
  // prior replan) → recovery charges plannerResumeCount; with cap 0 it aborts.
  const backend = new InMemoryKnowledgeBackend();
  await persistBundle(backend, 'sess-1', {
    goal: 'g', plannerPrivate: '', budgets: { stepsUsed: 1, rewindsUsed: 0 },
    runId: 'R1', runState: 'active', runPhase: 'executing',
    originalRequest: 'x', nextSeq: 0,
    inFlightStep: { seq: 0, step: { name: 's1', instructions: 'i' }, attempt: 0, resumeCount: 0, phase: 'awaiting-replan', transcript: [], toolCallCount: 0 },
    plannerCallInFlight: true, plannerResumeCount: 0,
  } as never);
  const h = harness({ evaluator: [], planner: [{ kind: 'content', content: JSON.stringify({ plan: [] }) }], executor: [],
    config: { ...baseConfig(), planner: 'adaptive', budgets: { ...baseConfig().budgets, maxPlannerResumes: 0 } } });
  h.deps.backend = backend;
  const { ctx, captured } = fakeCtx({ textOrMessages: 'x' });
  await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
  assert.ok(captured.find((c) => c.ok && /unable|abort|planner/i.test(c.value.content)),
    'replan crash-loop aborted via maxPlannerResumes');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — no terminal-first recovery, no planner replan guard.

- [ ] **Step 3: Implement the recovery preamble + guards**

Near the top of `execute`, after hydrating the bundle and resolving `now`/`mintRunId`, classify the request and run the three-stage recovery. Add a private helper `resumeOrFresh`:

```ts
    // Classification + terminal-first recovery. The handler reads the terminal
    // store for the resolved runId BEFORE any phase resume (stage 1).
    const explicitKey = ctx.options?.runId as string | undefined; // resume token, if any
    const newRun = (ctx.options as { newRun?: boolean } | undefined)?.newRun ?? false;
    const keyForTerminal = explicitKey ?? bundle.runId;
    const terminalExists = keyForTerminal
      ? (await readTerminal(deps.backend, sessionId, keyForTerminal, now())) !== undefined
      : false;
    const cls = classifyRequest({ bundle, incomingRequest: prompt, explicitKey, newRun, terminalExists });

    if (cls.kind === 'replay') {
      const out = await readTerminal(deps.backend, sessionId, cls.runId, now());
      if (out) {
        if (out.kind === 'success') this.surfaceFinal(ctx, out.answer, usageNow());
        else this.surfaceFinal(ctx, `Error: ${out.error}`, usageNow());
        return true;
      }
      // expired between classify and read → fall through to fresh
    }
    if (cls.kind === 'not-found') {
      return this.escalate(ctx, sessionId, bundle, 'this run is no longer resumable — start a new request', usageNow());
    }
    if (cls.kind === 'fresh') {
      resetRun(bundle, prompt);
      bundle.runId = mintRunId();
      await persistBundle(deps.backend, sessionId, bundle);
    }
    // cls.kind === 'resume': stage 1 terminal-first (any phase).
    if (cls.kind === 'resume' && bundle.runId) {
      const term = await readTerminal(deps.backend, sessionId, bundle.runId, now());
      if (term) {
        bundle.runState = 'terminal';
        await persistBundle(deps.backend, sessionId, bundle);
        if (term.kind === 'success') this.surfaceFinal(ctx, term.answer, usageNow());
        else this.surfaceFinal(ctx, `Error: ${term.error}`, usageNow());
        return true;
      }
    }
```

Wrap the planner call in `execute` with the guard. Before each `planner.next(...)` call, set `bundle.plannerCallInFlight = true; bundle.runPhase = bundle.runPhase ?? 'planning';` and persist; on a VALID decision, clear it and reset `plannerResumeCount` in the same persist that already happens after a valid decision. On entry, if `plannerCallInFlight` is already true, charge the counter first:

```ts
      if (bundle.plannerCallInFlight) {
        bundle.plannerResumeCount = (bundle.plannerResumeCount ?? 0) + 1;
        if (bundle.plannerResumeCount > (cfg.maxPlannerResumes ?? 3)) {
          // Exhausted resume budget is an UNRECOVERABLE abort (spec): store-first
          // terminal ERROR, NOT a suspend/escalate.
          await this.abortTerminal(ctx, sessionId, bundle, 'planner resume budget exhausted', now, terminalTtlMs, usageNow());
          return true;
        }
      }
      bundle.plannerCallInFlight = true;
      await persistBundle(deps.backend, sessionId, bundle);
      const next = await planner.next({ ... }); // existing call
      bundle.plannerCallInFlight = false;
      bundle.plannerResumeCount = 0;
      await persistBundle(deps.backend, sessionId, bundle); // existing persist
```

Apply the SAME marker pattern around `establishTargetState` (evaluator → `evalCallInFlight`/`evalResumeCount`, `runPhase='evaluating'`); on exhausting `maxEvalResumes`, **abort the same way** (`abortTerminal('evaluator resume budget exhausted', …)` then `return true`) — NOT escalate. The replan call inside the adaptive planner runs through `planner.next`, so the planner guard above already covers the `awaiting-replan` replan (no separate site).

The finalizing-phase recovery route (a crash DURING finalizing, no terminal entry
yet) re-invokes the finalizer — but that depends on `this.finalize()`, which is
created in Task 15, so it is added THERE (not here) to keep this task standalone-
buildable. Task 13 only establishes the terminal-first stage-1 check + the
classification/eval/planner guards.

Add imports: `import { classifyRequest, readTerminal, writeTerminal } from './run-scope.js';` and `import { resetRun } from './session-bundle.js';`.

> The escalate() path stays for the rewind/step/parse budgets (legacy human-in-loop "please confirm how to proceed" — a SUSPEND, not a terminal). Only the durable RESUME budgets (eval/planner) and judge-failure budget and finalize-exhausted(error) are terminal aborts. Do NOT convert the rewind/step/parse escalations.

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — the two recovery tests + the existing suite (a brand-new request classifies as `fresh` → `resetRun` runs at the top; the happy-path tests still go goal→step→done because `resetRun` sets `runState='active'` and goal is established right after).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): three-stage recovery (terminal-first) + eval/planner crash guards"
```

---

### Task 14: External-tool resume — artifact-first by `(runId, seq, attempt)`, durable injection

**Spec:** "External-tool resume", "Consume pending BEFORE runPhase", "artifact-first, outcome-routed", "next external call replaces the consumed marker".

**Files:**
- Modify: `controller-coordinator-handler.ts` — the `bundle.pending?.kind === 'external-tool'` branch (currently lines 192-218) and the external-tool suspend site in `runStep` (lines 507-523).
- Test: extend handler test.

- [ ] **Step 1: Write the failing test**

```ts
it('external resume: an already-committed artifact at (runId,seq,attempt) is adopted (no re-call)', async () => {
  const backend = new InMemoryKnowledgeBackend();
  const extId = externalToolCallId('ExtTool', { q: 'x' });
  // Bundle suspended on ExtTool at seq 0 attempt 0, AND a committed ok artifact already exists.
  await persistBundle(backend, 'sess-1', {
    goal: 'g', plannerPrivate: '', budgets: { stepsUsed: 0, rewindsUsed: 0 },
    runId: 'R1', runState: 'suspended', runPhase: 'executing', originalRequest: 'x', nextSeq: 0,
    inFlightStep: { seq: 0, step: { name: 's1', instructions: 'i' }, attempt: 0, resumeCount: 0, phase: 'executing', transcript: [], toolCallCount: 1 },
    pending: { kind: 'external-tool', extId, toolName: 'ExtTool', args: { q: 'x' }, position: 's1' },
  } as never);
  const rag = stubRag(async () => []);
  // Pre-write the committed artifact for this attempt.
  await rag.write({ content: 'DONE', metadata: { traceId: 't', turnId: 't', stepperId: 'controller', task: 's1', artifactType: 'step-result', createdAt: '2026-06-10T00:00:00.000Z', runId: 'R1', seq: 0, attempt: 0, status: 'ok' } });
  const h = harness({ evaluator: [], planner: [{ kind: 'content', content: JSON.stringify({ kind: 'done', result: 'fin' }) }], executor: [] });
  h.deps.backend = backend;
  h.deps.knowledgeRagFor = () => rag;
  const { ctx } = fakeCtx({ externalResults: new Map([[extId, 'LATE RESULT']]) });
  await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
  const b = await hydrateBundle(backend, 'sess-1');
  assert.equal(b.pending, undefined, 'pending cleared (adopted, not re-run)');
  assert.equal(b.nextSeq, 1, 'advanced past the adopted seq');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — current resume branch unconditionally records the external result and continues planning.

- [ ] **Step 3a: Hoist planner construction above the resume preamble**

The external artifact-first adopt (below) calls `planner.commit(...)`, so `planner`
must already exist when the resume preamble runs. Move the existing
`const planner = makePlanner(deps.config.planner ?? 'incremental', deps.planner, deps.config.subagents.planner?.hint);`
(currently constructed just before the main loop) to BEFORE the
`bundle.pending?.kind === 'external-tool'` resume branch near the top of `execute`.
It is stateless construction, safe to hoist; the main loop uses the same instance.

- [ ] **Step 3: Implement artifact-first external resume**

Replace the `bundle.pending?.kind === 'external-tool'` branch (lines 192-218) with the three-stage logic (artifact-first → result-by-extId → inject-and-clear). Because the executor result still flows through `runStep`'s reviewer + write, "inject" means: append the result to `inFlightStep.transcript`, clear pending, set `runState='active'`, keep `runPhase='executing'`; the loop then re-runs the in-flight step (rebuilding from the transcript). When `inFlightStep` is absent (legacy adaptive external-result-replan path), preserve the existing behaviour (record to plannerPrivate + `resumedExternal=true`).

```ts
    if (bundle.pending?.kind === 'external-tool') {
      const { extId, toolName } = bundle.pending;
      const seq = bundle.inFlightStep?.seq;
      const attempt = bundle.inFlightStep?.attempt;
      // Stage 1: artifact-first — did THIS attempt already commit?
      if (bundle.runId !== undefined && seq !== undefined && attempt !== undefined) {
        const existing = await rag.list({ runId: bundle.runId, seq, attempt, artifactType: 'step-result' });
        const resolved = resolveByPrecedence(
          existing.map((e) => ({ status: (e.metadata.status ?? 'failed') as Outcome['status'], approved: e.content, remainder: e.metadata.remainder ?? '', note: e.metadata.note ?? '' })),
        );
        if (resolved) {
          bundle.pending = undefined;
          bundle.runState = 'active';
          // Apply the SAME commit side effects as settle(), incl. planner.commit()
          // so the adaptive planCursor advances with nextSeq (#1/plan-5). `planner`
          // must be constructed BEFORE this preamble (hoist — see Step 3a below).
          const mapped = mapOutcome(resolved.status);
          bundle.lastOutcome = mapped;
          planner.commit?.(bundle, mapped);
          // Same payload-free control record as the normal path (#3/plan-6).
          recordStepControl(bundle, { seq: seq!, name: bundle.inFlightStep?.step.name ?? 'step', status: resolved.status, note: resolved.note, remainder: resolved.remainder });
          if (resolved.status === 'failed') {
            if (bundle.inFlightStep) bundle.inFlightStep.phase = 'awaiting-replan';
          } else {
            bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
            bundle.inFlightStep = undefined;
            bundle.runPhase = 'planning';
          }
          await persistBundle(deps.backend, sessionId, bundle);
          // fall through to the loop
        }
      }
      if (bundle.pending?.kind === 'external-tool') {
        const result = ctx.externalResults?.get(extId);
        if (result === undefined) {
          this.surfaceToolCall(ctx, { id: extId, name: toolName, arguments: (bundle.pending.args ?? {}) as Record<string, unknown> }, usageNow());
          return true;
        }
        await writeArtifact(rag, { ...meta, artifactType: 'mcp-result', toolName, task: bundle.pending.position, content: result });
        if (bundle.inFlightStep) {
          // Inject into the durable transcript; the loop re-runs the in-flight step.
          bundle.inFlightStep.transcript.push(
            { role: 'assistant', content: null, tool_calls: [{ id: extId, type: 'function', function: { name: toolName, arguments: JSON.stringify(bundle.pending.args ?? {}) } }] },
            { role: 'tool', tool_call_id: extId, content: result },
          );
          bundle.pending = undefined;
          bundle.runState = 'active';
          // This is a legitimate external CONTINUATION (bounded by toolCallCount),
          // NOT a crash-replay: the dispatch site must NOT charge resumeCount when
          // it re-runs the in-flight step this same invocation. The transient flag
          // is consumed once at the dispatch site (see Task 12).
          externalContinuation = true;
        } else {
          // Legacy adaptive path: feed via plannerPrivate + replan.
          bundle.plannerPrivate += `\n[external tool ${toolName} result] ${result}`;
          bundle.pending = undefined;
          resumedExternal = true;
        }
        await persistBundle(deps.backend, sessionId, bundle);
      }
    } else if (bundle.pending?.kind === 'clarify') {
      // ... unchanged clarify branch ...
    }
```

In `runStep`, when an external tool is hit, persist `inFlightStep.toolCallCount++` BEFORE surfacing, set the pending marker, and ensure `runState='suspended'`. The marker REPLACES any prior one (new extId). Update the existing `isExternalTool(name)` block (lines 507-523):

```ts
      if (isExternalTool(name)) {
        // Bound external round-trips by the SAME durable toolCallCount/maxToolCalls
        // as internal calls (#4/plan-4): check BEFORE surfacing, so an external
        // tool cannot exceed the cap. Exhausted → control-failed replan (same seq).
        if (inFlight && inFlight.toolCallCount + 1 > maxToolCalls) {
          bundle.budgets.stepsUsed++;
          bundle.plannerPrivate += `\n[seq ${inFlight?.seq ?? bundle.nextSeq ?? 0} ${step.name} control-failed] tool-call budget exhausted (maxToolCalls)`;
          inFlight.phase = 'awaiting-replan';
          inFlight.controlFailure = { reason: 'maxToolCalls', seq: inFlight.seq };
          return settle('failed');
        }
        await syncTranscript(); // durable executor turns before we suspend (#2/plan-6)
        const extId = externalToolCallId(name, args);
        if (inFlight) { inFlight.toolCallCount += 1; }
        bundle.pending = { kind: 'external-tool', extId, toolName: name, args, position: step.name };
        bundle.runState = 'suspended';
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceToolCall(ctx, { id: extId, name, arguments: args }, usageNow?.());
        return 'suspended';
      }
```

**Durable transcript = the FULL executor exchange (#3/plan-5).** The transcript
must carry EVERY executor/tool turn (prior executor messages + internal tool
results), not just the post-resume external pair — otherwise a process crash
mid-internal-rounds rebuilds with incomplete context. Implement it as the
authoritative dynamic log appended after a fixed static prefix:

1. Build the static prefix (system + user + optional recall block) and record its
   length, then seed the dynamic turns from the durable transcript:

```ts
    // `messages` = static prefix (system/user/recall) + durable dynamic turns.
    const staticLen = messages.length; // after pushing system/user/recall
    if (inFlight && inFlight.transcript.length > 0) {
      messages.push(...inFlight.transcript);
    }
    // Persist the dynamic tail into the durable transcript after each exchange.
    const syncTranscript = async () => {
      if (inFlight) {
        inFlight.transcript = messages.slice(staticLen);
        await persistBundle(deps.backend, sessionId, bundle);
      }
    };
```

2. Call `await syncTranscript();` after EVERY mutation of the dynamic `messages`
   in the inner loop — not only the internal-tool round-trip but ALSO the
   retry-message pushes (executor error, empty tool call, unavailable tool) — and
   AGAIN immediately BEFORE the external-tool suspend persist (#2/plan-6). Any turn
   the executor saw must be durable before the process can suspend or crash, or a
   resume would rebuild with a shorter conversation than the executor actually had.
   The external suspend path then persists the marker on top of an already-synced
   transcript; the resume injection appends the external assistant/tool pair.

The `externalContinuation` transient flag is already declared in Task 12 (Step 3A);
this task only SETS it when injecting the tool result. The Task 12 top-of-loop
executing-recovery block consumes it (re-runs the in-flight step without charging
resumeCount).

Add `import { resolveByPrecedence } from './outcome.js';` (Outcome already imported).

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — the adopt test + existing external-tool tests (the legacy adaptive external-resume tests still pass via the `inFlightStep`-absent branch, since those seeded bundles have no `inFlightStep`).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): artifact-first external resume by (runId,seq,attempt) + durable transcript injection"
```

---

### Task 15: Unified finalizer + terminal-write-first ordering

**Spec:** "Finalizer (unified, after done)", "Terminal-write reconciliation" (store-first, then bundle), "done carries no answer".

**Files:**
- Modify: `controller-coordinator-handler.ts` — the `next.kind === 'done'` branch (lines 316-321) and the budget/rewind/parse escalations (write a terminal error).
- Test: extend handler test.

- [ ] **Step 1: Write the failing test**

```ts
it('done → finalizer composes from approved results; terminal store written first', async () => {
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({ kind: 'next', step: { name: 's1', instructions: 'do' } }) },
      { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'IGNORED-when-finalizer-present' }) },
    ],
    executor: [{ kind: 'content', content: 'STEP RESULT' }],
  });
  h.deps.finalizer = { async finalize(_g, _r, approved) { return `COMPOSED(${approved.map((a) => a.content).join(',')})`; } };
  const handler = new ControllerCoordinatorHandler(h.deps);
  const { ctx, captured } = fakeCtx();
  await handler.execute(ctx, {}, undefined);
  assert.ok(captured.find((c) => c.ok && c.value.finishReason === 'stop' && /COMPOSED\(/.test(c.value.content)),
    'finalizer composed the answer from approved results');
  const bundle = await hydrateBundle(h.backend, 'sess-1');
  assert.equal(bundle.runState, 'terminal');
  const { readTerminal } = await import('../run-scope.js');
  const term = await readTerminal(h.backend, 'sess-1', bundle.runId!, new Date().toISOString());
  assert.equal(term?.kind, 'success');
});

it('finalizer provider failure exhausts maxFinalizeRetries → onFinalizeExhausted:error → terminal error', async () => {
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({ kind: 'next', step: { name: 's1', instructions: 'do' } }) },
      { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'r' }) },
    ],
    executor: [{ kind: 'content', content: 'STEP' }],
    config: { ...baseConfig(), onFinalizeExhausted: 'error', budgets: { ...baseConfig().budgets, maxFinalizeRetries: 1 } },
  });
  h.deps.finalizer = { async finalize() { throw new Error('finalizer down'); } };
  const handler = new ControllerCoordinatorHandler(h.deps);
  const { ctx, captured } = fakeCtx();
  await handler.execute(ctx, {}, undefined);
  assert.ok(captured.find((c) => c.ok && /Error:/.test(c.value.content)), 'terminal error surfaced');
  const bundle = await hydrateBundle(h.backend, 'sess-1');
  assert.equal(bundle.runState, 'terminal');
  const { readTerminal } = await import('../run-scope.js');
  const term = await readTerminal(h.backend, 'sess-1', bundle.runId!, new Date().toISOString());
  assert.equal(term?.kind, 'error');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — `done` currently surfaces `next.result` directly; no terminal store write.

- [ ] **Step 3: Implement unified finalize + terminal-first**

Replace the `next.kind === 'done'` branch (lines 316-321) with: read the approved results, run the finalizer (default: use `next.result`), write the terminal store FIRST, then flip the bundle to terminal.

```ts
      if (next.kind === 'done') {
        // Pass next.result as the legacy answer: used only when no finalizer is
        // injected (3-role config) — the adaptive planner already composed it.
        return this.finalize(ctx, sessionId, bundle, rag, prompt, logUsage, usageNow, now, terminalTtlMs, next.result);
      }
```

**Finalizing-phase recovery route (now that `finalize()` exists).** In the recovery
preamble built in Task 13 — after the terminal-first stage-1 check found NO terminal
entry, and BEFORE the main planner loop — add: a crash DURING finalizing (no
terminal outcome yet) re-runs the finalizer rather than re-planning:

```ts
    if (cls.kind === 'resume' && bundle.runState === 'active' && bundle.runPhase === 'finalizing') {
      // No terminal entry (stage-1 checked) → the finalizer never completed.
      // Re-run it; finalize() charges finalizeAttempt under finalizeCallInFlight,
      // checks the cap before re-invoking, and applies onFinalizeExhausted.
      return this.finalize(ctx, sessionId, bundle, rag, prompt, logUsage, usageNow, now, terminalTtlMs);
    }
```

Add the unified `finalize()` private method — the SINGLE finalize path for both the
done-branch and the finalizing-phase recovery route (Task 13). It owns the full
lifecycle: durable `finalizeCallInFlight` marker + `finalizeAttempt` charging,
`maxFinalizeRetries`, in-call provider-failure retries, `onFinalizeExhausted`, the
durable `bundle.originalRequest` as the finalizer input (NOT the live `prompt`),
and store-first terminal write.

```ts
  private async finalize(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    rag: IKnowledgeRagHandle,
    prompt: string,
    logUsage: (role: string, u?: LlmUsage) => void,
    usageNow: () => TerminalUsage,
    now: () => string,
    terminalTtlMs: number,
    /** Used ONLY when no finalizer is injected (3-role config): the adaptive
     *  planner's already-composed done.result. */
    legacyAnswer?: string,
  ): Promise<boolean> {
    const deps = this.deps;
    const cfg = deps.config.budgets;
    const maxFinalizeRetries = cfg.maxFinalizeRetries ?? 2;

    // The finalizer reads the run's approved results + the DURABLE originalRequest
    // (the verbatim request that started the run), never the live resume prompt.
    const request = bundle.originalRequest ?? prompt;
    const approved =
      deps.finalizer && bundle.runId ? await collectApproved(rag, bundle.runId) : [];

    // Shared exhaustion handler (pre-call AND in-catch): apply onFinalizeExhausted.
    // Returns the best-effort answer string, or null when policy is 'error' (the
    // run was aborted terminally — the caller returns true).
    const onExhausted = async (reason: string): Promise<string | null> => {
      if ((deps.config.onFinalizeExhausted ?? 'error') === 'best-effort') {
        return (
          approved.map((a) => `[#${a.seq}] ${a.content}`).join('\n\n') +
          '\n\n[incomplete: the final answer could not be composed]'
        );
      }
      await this.abortTerminal(ctx, sessionId, bundle, reason, now, terminalTtlMs, usageNow());
      return null;
    };

    // Crash-replay charge: if a prior finalize call was in flight, this re-entry
    // is a replay — charge finalizeAttempt and CHECK the cap BEFORE re-invoking,
    // so an already-exhausted run does not get one more finalizer call.
    if (bundle.finalizeCallInFlight) {
      bundle.finalizeAttempt = (bundle.finalizeAttempt ?? 0) + 1;
      if ((bundle.finalizeAttempt ?? 0) > maxFinalizeRetries) {
        const best = await onExhausted('finalizer retry budget exhausted on recovery');
        if (best === null) return true;
        await this.commitTerminalSuccess(ctx, sessionId, bundle, best, now, terminalTtlMs, usageNow());
        return true;
      }
    }
    // For the legacy (no-finalizer) path, persist the planner's composed answer
    // DURABLY in the SAME write that enters `finalizing`, so a crash before the
    // terminal write can recover it (#2/plan-3) rather than emitting empty.
    if (!deps.finalizer && legacyAnswer !== undefined) {
      bundle.legacyFinalAnswer = legacyAnswer;
    }
    bundle.runPhase = 'finalizing';
    bundle.finalizeCallInFlight = true;
    await persistBundle(deps.backend, sessionId, bundle);

    let answer: string | undefined;
    if (deps.finalizer && bundle.runId) {
      // In-call provider-failure retries, bounded by maxFinalizeRetries and the
      // durable finalizeAttempt (which already counts crash-replays).
      while (answer === undefined) {
        try {
          const composed = await deps.finalizer.finalize(bundle.goal, request, approved, {
            hint: deps.config.subagents.finalizer?.hint,
            logUsage,
            log: (m) => dlog(m),
          });
          // Empty-but-ok finalizer output is a JUDGE failure (spec), not a valid
          // answer → throw so it retries within maxFinalizeRetries (never written
          // as a terminal success).
          if (composed.trim().length === 0) {
            throw new Error('finalizer returned an empty answer');
          }
          answer = composed;
        } catch (e) {
          bundle.finalizeAttempt = (bundle.finalizeAttempt ?? 0) + 1;
          await persistBundle(deps.backend, sessionId, bundle);
          if ((bundle.finalizeAttempt ?? 0) > maxFinalizeRetries) {
            const best = await onExhausted(`finalizer failed after ${maxFinalizeRetries} retries: ${String(e)}`);
            if (best === null) return true; // 'error' policy aborted terminally
            answer = best; // 'best-effort'
            break;
          }
          // else: loop and retry the finalizer.
        }
      }
    } else {
      // Legacy (no finalizer injected): the adaptive planner already composed the
      // answer in done.result. Prefer the live param, else the durable copy
      // persisted on the finalizing-entry write (recovers across a crash).
      answer = legacyAnswer ?? bundle.legacyFinalAnswer ?? '';
    }

    await this.commitTerminalSuccess(ctx, sessionId, bundle, answer ?? '', now, terminalTtlMs, usageNow());
    return true;
  }

  /** Store-first terminal SUCCESS: write the terminal store FIRST, then flip the
   *  bundle to terminal and surface the answer (mirror of abortTerminal). */
  private async commitTerminalSuccess(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    answer: string,
    now: () => string,
    terminalTtlMs: number,
    usage?: TerminalUsage,
  ): Promise<void> {
    await writeTerminal(
      this.deps.backend, sessionId, bundle.runId ?? sessionId,
      { kind: 'success', answer }, terminalTtlMs, now(),
    );
    bundle.pending = undefined;
    bundle.finalizeCallInFlight = false;
    bundle.runState = 'terminal';
    bundle.inFlightStep = undefined;
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceFinal(ctx, answer, usage);
  }
```

> **Finalizing-recovery + legacy.** The finalizing-phase recovery route (Task 13)
> calls `this.finalize(...)` with NO `legacyAnswer`. A legacy (no-finalizer) run
> that crashed after writing the terminal store re-surfaces it via the stage-1
> terminal-first check, so it never reaches `finalize()` without a finalizer; a
> legacy run that crashed BEFORE the terminal write has `runPhase:'finalizing'`
> with no terminal entry and `legacyAnswer` unavailable on resume — in that
> narrow case `finalize()` emits an empty answer, which is acceptable because the
> incremental/adaptive planner's `done` is deterministic and a re-run would
> recompute it; deployments needing a stronger guarantee inject a finalizer.

Add the `collectApproved` helper (exact list by runId, resolve each seq by
precedence, reconstructing the FULL Outcome from metadata so note/remainder are
not lost — #2):

```ts
/** Gather the run's approved results, one per seq, resolved by outcome
 *  precedence (ok/exists > partial > failed), ordered by seq. Reconstructs the
 *  complete Outcome from artifact metadata (status/note/remainder) + content. */
async function collectApproved(
  rag: IKnowledgeRagHandle,
  runId: string,
): Promise<{ seq: number; content: string }[]> {
  const all = await rag.list({ runId, artifactType: 'step-result' });
  const bySeq = new Map<number, Outcome[]>();
  for (const e of all) {
    const seq = e.metadata.seq ?? 0;
    const o: Outcome = {
      status: (e.metadata.status ?? 'failed') as Outcome['status'],
      approved: e.content,
      remainder: e.metadata.remainder ?? '',
      note: e.metadata.note ?? '',
    };
    const arr = bySeq.get(seq);
    if (arr) arr.push(o);
    else bySeq.set(seq, [o]);
  }
  const out: { seq: number; content: string }[] = [];
  for (const [seq, outcomes] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    const resolved = resolveByPrecedence(outcomes);
    if (resolved && resolved.status !== 'failed') out.push({ seq, content: resolved.approved });
  }
  return out;
}
```

Add `import { writeTerminal } from './run-scope.js';` (alongside the existing
run-scope imports). Leave `escalate` UNCHANGED — escalation is a SUSPEND
(human-in-loop "please confirm how to proceed") for the rewind/step/parse budgets,
NOT a terminal. The terminal store is written only on `done`/finalize and on an
unrecoverable abort (judge-failure or resume-budget exhaustion, via
`abortTerminal`).

- [ ] **Step 4: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — the finalizer test + existing (with no `deps.finalizer`, the adaptive `FINAL`/`done.result` path is preserved; the terminal store is still written, which the existing tests don't assert against, so they stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): unified finalizer after done + store-first terminal write"
```

---

### Task 16: Evaluator confirmation transition + per-`requires` evidence + empty-clarify rejection

**Spec:** "evaluating phase" (needs-confirmation → suspended), "Clarify-resume semantics are deterministic" (empty answer rejected), "Dependency manifest & miss detection" (per-`requires` evidence map).

**Files:**
- Modify: `controller/types.ts` (`Step` += optional `requires`), `controller-coordinator-handler.ts` (evidence map + empty-clarify), `reviewer.ts` already consumes `Evidence`.
- Test: extend handler + reviewer tests.

- [ ] **Step 1: Add `requires` to `Step`**

In `types.ts`, extend `Step`:

```ts
export interface Step {
  name: string;
  instructions: string;
  type?: string;
  /** Plain-language references this step depends on (decided by the reviewer,
   *  not the doer). Drives the per-reference evidence map. */
  requires?: string[];
}
```

The planner already emits `name`/`instructions`; `parsePlan`/`parseNextStep` carry `type` through. Extend both to carry `requires` when present (in `planner.ts` `parsePlan`, add `...(Array.isArray(s.requires) ? { requires: s.requires } : {})`; in `controller-coordinator-handler.ts` `parseNextStep`, the `next` branch returns `obj.step` as-is, so `requires` already passes through — no change).

- [ ] **Step 2: Write the failing tests**

```ts
// handler test
it('empty clarify answer is rejected: stays suspended, re-asks', async () => {
  const backend = new InMemoryKnowledgeBackend();
  await persistBundle(backend, 'sess-1', {
    goal: '', plannerPrivate: '', budgets: { stepsUsed: 0, rewindsUsed: 0 },
    runId: 'R1', runState: 'suspended', runPhase: 'evaluating', originalRequest: 'orig',
    pending: { kind: 'clarify', question: 'which table?', position: 'goal', proposedTarget: 'T100' },
  } as never);
  const h = harness({ evaluator: [], planner: [], executor: [] });
  h.deps.backend = backend;
  const { ctx, captured } = fakeCtx({ textOrMessages: '   ' }); // whitespace only
  await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);
  const b = await hydrateBundle(backend, 'sess-1');
  assert.equal(b.goal, '', 'empty answer did NOT become the goal');
  assert.equal(b.pending?.kind, 'clarify', 'still suspended on clarify');
  assert.ok(captured.find((c) => c.ok && /which table/i.test(c.value.content)), 're-surfaced the question');
});

it('per-requires evidence is passed to the reviewer', async () => {
  let seenEvidence: unknown;
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({ kind: 'next', step: { name: 's1', instructions: 'do', requires: ['table T100', 'domain ZD'] } }) },
      { kind: 'content', content: JSON.stringify({ kind: 'done', result: 'd' }) },
    ],
    executor: [{ kind: 'content', content: 'r' }],
    ragQuery: async (text) => (/T100/.test(text) ? [{ content: 'T100 def', metadata: { traceId: 't', turnId: 't', stepperId: 'controller', task: 'x', artifactType: 'mcp-result', createdAt: '2026-06-10T00:00:00.000Z' } }] : []),
  });
  h.deps.reviewer = { async review(_s, evidence) { seenEvidence = evidence; return { status: 'ok', approved: 'r', remainder: '', note: '' }; } };
  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
  assert.deepEqual(seenEvidence, [{ ref: 'table T100', hit: true }, { ref: 'domain ZD', hit: false }]);
});
```

- [ ] **Step 3: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: FAIL — empty answer currently becomes the goal verbatim; evidence is whole-step only.

- [ ] **Step 4: Implement empty-clarify rejection + per-`requires` evidence**

In the `bundle.pending?.kind === 'clarify'` branch, guard the goal-position case on a non-empty answer:

```ts
    } else if (bundle.pending?.kind === 'clarify') {
      if (bundle.pending.position === 'goal') {
        const answer = prompt.trim();
        if (answer.length === 0) {
          // Empty/whitespace is not an established goal — stay suspended, re-ask.
          this.surfaceClarify(ctx, bundle.pending.question, usageNow());
          return true;
        }
        const proposed = bundle.pending.proposedTarget;
        bundle.goal = proposed && isAffirmation(answer) ? proposed : answer;
        bundle.runState = 'active';
        bundle.runPhase = 'planning';
      }
      bundle.plannerPrivate += `\n[clarify answer] ${prompt}`;
      bundle.pending = undefined;
      await persistBundle(deps.backend, sessionId, bundle);
    }
```

In `runStep`, build the per-`requires` evidence map (replace the single whole-step `evidence` from Task 11):

```ts
    // Per-reference evidence: one recall query per requires[] reference so the
    // reviewer knows WHICH dependency was present. Falls back to the whole-step
    // recall when the step declares no requires. EVERY recall is run-scoped by
    // runId (#1/plan-6) so a multi-run session never surfaces a foreign run's
    // artifacts (the query() pre-cap filter from Task 3b makes runId authoritative).
    const refs = step.requires && step.requires.length > 0 ? step.requires : [recallText];
    const evidence = await Promise.all(
      refs.map(async (ref) => {
        const hits = await resolveNeed(rag, ref, RECALL_K, { artifactType: RECALL_ARTIFACT_TYPES, runId: bundle.runId });
        return { ref, hit: hits.length > 0 };
      }),
    );
```

**Whole-step recall = over-fetch → dedup-by-precedence → cap (#2/plan-8).** Per the
spec, duplicates of a `(runId, seq)` (a step's retries) are bounded by
`maxStepAttempts`, so the whole-step content recall must over-fetch `k' = k ×
(maxStepAttempts + 1)`, dedup `(runId, seq)` by outcome precedence, then take the
top `k` distinct steps — otherwise one step's retries can fill the whole top-K and
crowd out other steps. Add a helper and use it for the whole-step recall (the
per-reference evidence above only needs hit/no-hit, so it keeps the simple
`resolveNeed`):

```ts
/** Run-scoped semantic recall with the spec's over-fetch → dedup → cap. Pulls
 *  k' = k × (maxStepAttempts + 1) ranked candidates filtered to `runId`, dedups
 *  each (runId, seq) to its precedence-winning artifact, returns the top-k distinct
 *  steps' content. */
async function runScopedRecall(
  rag: IKnowledgeRagHandle,
  text: string,
  k: number,
  runId: string | undefined,
  maxStepAttempts: number,
  artifactType: readonly string[],
): Promise<readonly KnowledgeEntry[]> {
  const kPrime = k * (maxStepAttempts + 1);
  const hits = await rag.query(text, { k: kPrime, filter: { runId, artifactType } });
  // Dedup by (runId, seq): keep the precedence-winning entry per seq.
  const bySeq = new Map<number, KnowledgeEntry>();
  for (const e of hits) {
    const seq = e.metadata.seq ?? -1;
    const prev = bySeq.get(seq);
    if (!prev || rankStatus(e.metadata.status) >= rankStatus(prev.metadata.status)) bySeq.set(seq, e);
  }
  return [...bySeq.values()].slice(0, k);
}
/** Outcome-precedence rank used for dedup (ok/exists > partial > failed > none). */
function rankStatus(s?: string): number {
  return s === 'ok' || s === 'exists' ? 3 : s === 'partial' ? 2 : s === 'failed' ? 1 : 0;
}
```

Replace the existing whole-step episodic recall call in `runStep`
(`resolveNeed(rag, recallText, RECALL_K, { artifactType: RECALL_ARTIFACT_TYPES })`)
with `runScopedRecall(rag, recallText, RECALL_K, bundle.runId, cfg.maxStepAttempts ?? 5, RECALL_ARTIFACT_TYPES)`.
Add `KnowledgeEntry` to the existing `@mcp-abap-adt/llm-agent` type import in the handler.

**Run-scope the artifact writes (#1/plan-6).** Add `runId: bundle.runId` to every
`mcp-result` write (the internal-tool round-trip write and the external resume
write) so internal tool results are recalled within the run too. The `step-result`
write already carries `runId` (Task 11). With all artifacts tagged and every recall
run-scoped, recall is strictly per-run.

(The evaluator `needs-confirmation` → suspended transition is already correct in the existing code at lines 245-257, which persists the clarify marker and surfaces it; add `bundle.runState = 'suspended';` there to match the run-state contract.)

- [ ] **Step 5: Run, verify it passes**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
Expected: PASS — empty-clarify + evidence tests + the existing clarify tests (a non-empty refinement still becomes the goal).

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): evaluator suspended transition, empty-clarify rejection, per-requires evidence map"
```

---

## Phase E — Factory wiring & config

### Task 17: `ControllerFactory` builds reviewer/finalizer; config + models

**Spec:** "Config & roles contract" — `subagents` gains `reviewer`/`finalizer` (default to planner's model when absent); the factory builds the DEFAULT `IReviewer`/`IFinalizer`; `models`/`/v1/usage` gain `reviewer`/`finalizer`.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/factories/controller-factory.ts`
- Modify: `controller-coordinator-handler.ts` — `ControllerHandlerDeps.models` + `makeLogUsage` to attribute `reviewer`/`finalizer`.
- Test: `packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts` (extend or create).

- [ ] **Step 1: Write the failing test**

```ts
// controller-factory reviewer/finalizer wiring
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ControllerFactory } from '../controller-factory.js';

const fakeLlm = (model: string) => ({
  model,
  async chat() { return { ok: true, value: { content: 'x' } }; },
}) as never;

describe('ControllerFactory reviewer/finalizer', () => {
  it('builds a handler with reviewer+finalizer; reviewer/finalizer default to planner model', async () => {
    const cfg = {
      subagents: {
        evaluator: { provider: 'x', model: 'm-eval' },
        planner: { provider: 'x', model: 'm-plan' },
        executor: { provider: 'x', model: 'm-exec' },
      },
      targetState: { strategy: 'consumer-confirm', distanceThreshold: 0.5 },
      sessionMemory: { collection: 'c' },
      budgets: { maxSteps: 5, maxRetries: 2, maxRewinds: 2 },
    } as never;
    const { handler } = await new ControllerFactory().build(cfg, {
      makeRoleLlm: async (role) => fakeLlm(`m-${role}`),
      callMcp: async () => '',
      backend: {} as never,
      knowledgeRagFor: () => ({}) as never,
      selectTools: async () => [],
    });
    assert.ok(handler, 'handler built with reviewer/finalizer wired');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts`
Expected: FAIL — `makeRoleLlm('reviewer')`/`'finalizer'` not resolved; deps not passed.

- [ ] **Step 3: Implement the wiring**

In `controller-factory.ts`, resolve reviewer/finalizer LLMs (defaulting to the planner config when the subagent is absent) and construct the default impls:

```ts
import { LlmReviewer } from '../smart-agent/controller/reviewer.js';
import { LlmFinalizer } from '../smart-agent/controller/finalizer.js';
// ...
    const reviewerLlm = config.subagents.reviewer
      ? await deps.makeRoleLlm('reviewer')
      : plannerLlm;
    const finalizerLlm = config.subagents.finalizer
      ? await deps.makeRoleLlm('finalizer')
      : plannerLlm;

    const handler = new ControllerCoordinatorHandler({
      // ...existing fields...
      reviewer: new LlmReviewer(makeSubagentClient(reviewerLlm)),
      finalizer: new LlmFinalizer(makeSubagentClient(finalizerLlm), {
        budget: 12000,
        perResultCap: 4000,
      }),
      config,
      models: {
        evaluator: evaluatorLlm.model ?? 'unknown',
        planner: plannerLlm.model ?? 'unknown',
        executor: executorLlm.model ?? 'unknown',
        reviewer: reviewerLlm.model ?? 'unknown',
        finalizer: finalizerLlm.model ?? 'unknown',
      },
    });
```

In `controller-coordinator-handler.ts`, widen `ControllerHandlerDeps.models` to include `reviewer`/`finalizer`:

```ts
  models: { evaluator: string; planner: string; executor: string; reviewer?: string; finalizer?: string };
```

and in `makeLogUsage`, attribute the two roles (the `role === 'finalizer'` branch currently maps to `models.planner`; change it to prefer `models.finalizer`):

```ts
    const model =
      role === 'finalizer'
        ? (models.finalizer ?? models.planner)
        : role === 'reviewer'
          ? (models.reviewer ?? models.planner)
          : role === 'embedding'
            ? 'embedder'
            : ((models as Record<string, string>)[role] ?? 'unknown');
```

> The `makeRoleLlm` resolver in production must map `'reviewer'`/`'finalizer'` to `config.subagents.reviewer ?? config.subagents.planner` (and likewise finalizer). Document this in the factory JSDoc example so callers wire it; the factory itself only calls `makeRoleLlm('reviewer')` when `config.subagents.reviewer` is present, else reuses `plannerLlm` — so a 3-role config needs no resolver change.

- [ ] **Step 4: Run, verify it passes; then the full controller suite**

Run: `node --import tsx/esm --test --test-reporter=spec packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts`
Expected: PASS.
Run: `node --import tsx/esm --test --test-reporter=spec 'packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/*.test.ts'`
Expected: all controller tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/factories/controller-factory.ts packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts
git commit -m "feat(controller): factory wires LlmReviewer/LlmFinalizer; reviewer/finalizer usage attribution"
```

---

## Phase F — Full verification

### Task 18: Build + full suites + spec cross-check

**Files:** none (verification).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: clean compile across all packages (the metadata/filter change in `@mcp-abap-adt/llm-agent` propagates to dependents).

- [ ] **Step 2: Lint**

Run: `npm run lint:check`
Expected: no errors (fix with `npm run lint` if Biome flags formatting).

- [ ] **Step 3: Run every package's tests**

Run: `npm run test`
Expected: all workspace suites green, including the new controller tests and the unchanged `public-api.test.ts` (the six factories still export).

- [ ] **Step 4: Spec cross-check (self-review)**

Open `docs/superpowers/specs/2026-06-10-controller-execution-result-control-design.md` and confirm each section maps to a task: Core idea/Roles → Tasks 7,8,11; Outcome persistence → Tasks 1,11; Replay identity (attempt-keyed) → Tasks 2,11,12,14; Planner transitions → Task 9; Finalizer → Tasks 8,15; Run scope & lifecycle → Tasks 3,4,5,6,13,15; Recovery three-stage → Tasks 13,14; Data backbone & RAG → Task 2; Dependency manifest → Task 16; Config & roles → Tasks 3,17. Note any uncovered clause and add a follow-up task.

- [ ] **Step 5: Finish the branch**

Use **superpowers:finishing-a-development-branch** to verify tests, present merge/PR options, and complete.

---

## Out of scope (deferred — do NOT implement here)

- WRITE exactly-once / non-idempotent side-effect durability (separate spec). The at-least-once + tool-idempotency contract is the boundary; re-execution may repeat side effects (spec "Idempotency & durability").
- Target-model-aware planning + per-step model routing.
- Skills-RAG procedural knowledge channel.
- Tool-verifying reviewer (read-only state check) — `IReviewer` is the seam; only the LLM default impl ships here.
- Backend-native `DISTINCT (runId, seq)` and a stricter controller-side dependency-match threshold (spec "Open questions").
