# Controller Planner — Phase 2: Live Digest Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the step-state digest board LIVE for the plan-first (adaptive) controller path — every plan step gets a stable `stepId` at creation, each create/replan is persisted as a `plan-decision` artifact, the reviewer returns a planning `digest`, the controller persists `stepId`+`digest` on each `step-result`, and the rendered board (with a bounded, deterministic compaction budget) replaces the payload-free `plannerPrivate` blob in the planner's prompts.

**Architecture:** Phase 1 already added the READ side — `reconstructBoard` (board.ts) reads `metadata.stepId`/`metadata.digest` off `step-result` entries and merges `plan-decision` structure + claims + in-flight into a `Map<stepId, BoardEntry>`; `writePlanDecision`/`readPlanDecisions`/`deterministicId` (artifacts.ts) persist/read decisions; `projectStepState` (outcome.ts) projects status→board state. Phase 2 wires the WRITE side and the planner integration: (1) the adaptive planner mints `stepId`s and records `PlanDecision`s onto the bundle when it (re)builds `bundle.plan`; (2) the handler drains+persists those decisions before dispatch; (3) the reviewer's `ReviewOutcome` carries a `digest`, validated by `parseReview`; (4) the handler writes `stepId`+`digest` on the `step-result`; (5) a new pure `renderBoard` turns the reconstructed board into a bounded text block; (6) the handler reconstructs+renders the board each turn and passes it to the planner via `PlannerNextInput.boardText`, which the planner prompts use in place of `plannerPrivate` (graceful fallback to `plannerPrivate` when the board is empty — this is how the legacy `IncrementalPlanner`, which writes no decisions, keeps working unchanged).

**Tech Stack:** TypeScript (ESM, strict), Node ≥22 `node:test` (co-located `__tests__/*.test.ts`, run via `npm run -w @mcp-abap-adt/llm-agent-server-libs test`), Biome lint/format. Package: `@mcp-abap-adt/llm-agent-server-libs`, directory `src/smart-agent/controller/`.

**Out of scope (later phases — do NOT implement here):** the §D deferred-expansion / discovery fan-out (`expand`/`page` decisions, `DiscoveryDigest` enumeration, `settle-envelope` secret store, `expanding`/`expanded` board states, `chain-outcome`), and the §C clean break to two capability-tuned planners. Phase 2 keeps the existing `IncrementalPlanner`/`AdaptivePlanner` and wires the live board into the adaptive (plan-first) path only. `ReviewOutcome` defines `digest` now; the optional `enumeration` field is added in the discovery phase.

**Step-start claims (§F source 3) — explicitly deferred.** Phase 2 does NOT write the durable `step-start` claim artifact at dispatch. The board's transient `executing`/`awaiting-external` state therefore comes from the bundle's `inFlightStep` + `pending` (`reconstructBoard` source 3, the bundle half), which is correct for the live (non-crashed) path. The durable claim half — which lets a crash mid-step re-derive `executing` from an artifact after a lost bundle, and which fixes the §F contested-slot winner at dispatch — lands with the deferred-expansion phase (it needs the `stepId → {slotId, decisionId}` mapping that fan-out introduces). Consequence accepted for Phase 2: a crash AFTER a step started but BEFORE its `step-result` loses only that step's transient-`executing` precision on reconstruct (it reverts to `planned` until re-dispatched) — never a committed outcome. The handler still passes `claims: await readClaims(...)` to `reconstructBoard` (it is `[]` in Phase 2; wiring it now means the discovery phase only adds the WRITE, not the read).

---

## File Structure

| File | Phase-2 responsibility |
|------|------------------------|
| `src/smart-agent/controller/artifacts.ts` | ADD pure `mintCreateStepIds` / `mintReplanStepIds` (deterministic stepId minting at plan creation). |
| `src/smart-agent/controller/outcome.ts` | ADD `ReviewOutcome = Outcome & { digest: string }`. |
| `src/smart-agent/controller/reviewer.ts` | `ReviewResult.outcome` becomes `ReviewOutcome`; `REVIEWER_SYSTEM` asks for `digest`; `parseReview` validates+bounds `digest` (threaded `maxDigestChars`); `ReviewOpts` gains `maxDigestChars`. |
| `src/smart-agent/controller/board.ts` | ADD pure `renderBoard(board, budget)` + `BoardBudget` type + `validateBoardBudget(budget)` (load-time fail-loud invariant). |
| `src/smart-agent/controller/types.ts` | `PlannerNextInput` gains `boardText?`; `SessionBundle` gains `pendingPlanDecisions?: PlanDecision[]`; `ControllerConfig['budgets']` gains the five board-budget knobs. |
| `src/smart-agent/controller/session-bundle.ts` | `resetRun` clears `pendingPlanDecisions` (run-scoped). |
| `src/pipelines/controller.ts` | `parseConfig` defaults the five board knobs into `budgets` (Task 3). |
| `src/factories/controller-factory.ts` | `build()` calls `validateBoardBudget` once (fail-loud at composition — the single chokepoint both the pipeline plugin and direct programmatic users pass through) (Task 8). |
| `src/smart-agent/controller/planner.ts` | `AdaptivePlanner` mints stepIds + records `PlanDecision`s onto the bundle when it (re)builds `bundle.plan`; the three prompt sites use `boardText` with `plannerPrivate` fallback. |
| `src/smart-agent/controller/controller-coordinator-handler.ts` | Drain+persist `bundle.pendingPlanDecisions` after `planner.next()`; reconstruct+render the board and pass `boardText` into `planner.next()` (fail-loud on `BoardOverBudgetError`); write `stepId`+`digest` on the `step-result`; write a `failed` `step-result` for every control-failure branch so the board carries it (Task 6D); thread `maxDigestChars` (from `cfg`) into the reviewer and the default-reviewer/coerced paths. |

---

## Task 1: Deterministic stepId minting helpers (artifacts.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts`

Per §F: a `stepId` is assigned when the step first enters the plan. For create-plan the whole plan is minted at once (`deterministicId(runId,'create',index)`); for a replan that REPLACES the failed step's tail, the replacement steps are minted (`deterministicId(runId,'replan',anchorStepId,index)`), and the FIRST replacement carries `supersedesStepId = anchorStepId` (it supersedes the failed step). Minting is pure and deterministic so an at-least-once planner re-call produces identical ids.

- [ ] **Step 1: Write the failing tests**

Append to `artifacts.test.ts`:

```ts
import { mintCreateStepIds, mintReplanStepIds } from '../artifacts.js';

test('mintCreateStepIds assigns deterministic per-index stepIds', () => {
  const steps = [
    { name: 'a', instructions: 'fetch a' },
    { name: 'b', instructions: 'fetch b' },
  ];
  const out1 = mintCreateStepIds(steps, 'run-1');
  const out2 = mintCreateStepIds(steps, 'run-1');
  assert.equal(out1.length, 2);
  assert.ok(out1[0].stepId && out1[1].stepId);
  assert.notEqual(out1[0].stepId, out1[1].stepId); // distinct per index
  assert.deepEqual(
    out1.map((s) => s.stepId),
    out2.map((s) => s.stepId),
  ); // deterministic (re-call → same ids)
  assert.notEqual(mintCreateStepIds(steps, 'run-2')[0].stepId, out1[0].stepId); // runId-scoped
  // original input not mutated
  assert.equal(steps[0].stepId, undefined);
});

test('mintReplanStepIds mints new ids; first supersedes the anchor', () => {
  const rest = [
    { name: 'x', instructions: 'redo' },
    { name: 'y', instructions: 'then' },
  ];
  const out = mintReplanStepIds(rest, 'run-1', 'anchor-step');
  assert.equal(out[0].supersedesStepId, 'anchor-step');
  assert.equal(out[1].supersedesStepId, undefined); // only the first supersedes
  assert.ok(out[0].stepId && out[1].stepId);
  assert.notEqual(out[0].stepId, out[1].stepId);
  // deterministic + anchor-scoped
  assert.deepEqual(
    mintReplanStepIds(rest, 'run-1', 'anchor-step').map((s) => s.stepId),
    out.map((s) => s.stepId),
  );
  assert.notEqual(
    mintReplanStepIds(rest, 'run-1', 'other-anchor')[0].stepId,
    out[0].stepId,
  );
});

test('mintReplanStepIds on an empty tail returns []', () => {
  assert.deepEqual(mintReplanStepIds([], 'run-1', 'anchor'), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="mint"`
Expected: FAIL — `mintCreateStepIds`/`mintReplanStepIds` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `artifacts.ts` (after `decisionWinner`):

```ts
/** Mint stable plan-time stepIds for a freshly created plan (§F). Pure: returns
 *  NEW step objects (does not mutate the input). `deterministicId(runId,'create',i)`
 *  is replay-stable — an at-least-once planner re-call produces identical ids. */
export function mintCreateStepIds(steps: Step[], runId: string): Step[] {
  return steps.map((s, i) => ({
    ...s,
    stepId: deterministicId(runId, 'create', i),
  }));
}

/** Mint stepIds for a replan's replacement tail (§F). Each replacement gets a NEW
 *  stepId keyed by the superseded anchor; the FIRST replacement carries
 *  `supersedesStepId = anchorStepId` (it replaces the failed step). Pure. */
export function mintReplanStepIds(
  steps: Step[],
  runId: string,
  anchorStepId: string,
): Step[] {
  return steps.map((s, i) => ({
    ...s,
    stepId: deterministicId(runId, 'replan', anchorStepId, i),
    ...(i === 0 ? { supersedesStepId: anchorStepId } : {}),
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="mint"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/artifacts.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/artifacts.test.ts
git commit -m "feat(controller): deterministic stepId minting for create/replan plans (Phase 2)"
```

---

## Task 2: ReviewOutcome with a planning digest (outcome.ts + reviewer.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/reviewer.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/reviewer.test.ts` (create if absent)

Per §A: the reviewer RETURNS its verdict plus a planning `digest` (the planning-relevant extract — a few-line summary the planner reads, distinct from the full `approved` content that goes to RAG). `ReviewOutcome = Outcome & { digest: string }`. `parseReview` validates `digest` (required non-empty on a settle) and DEFENSIVELY truncates it to `maxDigestChars` (the LLM is asked to keep it short, but we enforce the bound — the full result is in RAG regardless, §B). A reply with a valid status but a missing/empty `digest` is a JUDGE-failure (re-ask path). The coerced-failed and coerced-ok branches synthesize a digest from `note`/`approved` so every returned `ReviewOutcome` has one.

- [ ] **Step 1: Write the failing tests**

Create `reviewer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReview } from '../reviewer.js';

const MAX = 200;

test('parseReview returns digest on a well-formed ok verdict', () => {
  const r = parseReview(
    JSON.stringify({
      status: 'ok',
      approved: 'FULL CONTENT',
      remainder: '',
      note: 'done',
      digest: 'includes: A, B, C',
    }),
    MAX,
  );
  assert.equal(r.kind, 'outcome');
  if (r.kind !== 'outcome') return;
  assert.equal(r.outcome.status, 'ok');
  assert.equal(r.outcome.digest, 'includes: A, B, C');
});

test('parseReview judge-fails when digest is missing on a settle', () => {
  const r = parseReview(
    JSON.stringify({ status: 'ok', approved: 'X', remainder: '', note: '' }),
    MAX,
  );
  assert.equal(r.kind, 'judge-failure');
});

test('parseReview truncates an over-long digest to maxDigestChars', () => {
  const long = 'x'.repeat(500);
  const r = parseReview(
    JSON.stringify({
      status: 'ok',
      approved: 'X',
      remainder: '',
      note: '',
      digest: long,
    }),
    MAX,
  );
  assert.equal(r.kind, 'outcome');
  if (r.kind !== 'outcome') return;
  assert.equal(r.outcome.digest.length, MAX);
});

test('parseReview coerces empty-approved success to failed WITH a digest', () => {
  const r = parseReview(
    JSON.stringify({
      status: 'ok',
      approved: '',
      remainder: 'still missing Z',
      note: 'nothing usable',
      digest: 'n/a',
    }),
    MAX,
  );
  assert.equal(r.kind, 'outcome');
  if (r.kind !== 'outcome') return;
  assert.equal(r.outcome.status, 'failed');
  assert.ok(r.outcome.digest.length > 0); // synthesized from note
});

test('parseReview judge-fails on unparsable reply', () => {
  assert.equal(parseReview('not json', MAX).kind, 'judge-failure');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="parseReview"`
Expected: FAIL — `parseReview` takes one arg and returns no `digest`.

- [ ] **Step 3a: Add `ReviewOutcome` to outcome.ts**

Add to `outcome.ts` (after the `Outcome` definition):

```ts
/** The reviewer's verdict PLUS the planning `digest` (§A): the planning-relevant
 *  extract the planner board shows, distinct from the full `approved` content that
 *  goes to RAG. Bounded by `maxDigestChars` (non-discovery free text, §B). */
export type ReviewOutcome = Outcome & { digest: string };
```

- [ ] **Step 3b: Thread digest through reviewer.ts**

In `reviewer.ts`:

1. Import `ReviewOutcome`:
```ts
import type { Outcome, ReviewOutcome } from './outcome.js';
```

2. Change `ReviewResult` to carry a `ReviewOutcome`:
```ts
export type ReviewResult =
  | { kind: 'outcome'; outcome: ReviewOutcome }
  | { kind: 'judge-failure'; reason: string };
```

3. Add `maxDigestChars` to `ReviewOpts`:
```ts
export interface ReviewOpts {
  hint?: string;
  logUsage?: (role: string, u?: LlmUsage) => void;
  /** Defensive cap on the returned `digest` (§B). Defaults to 500 when omitted. */
  maxDigestChars?: number;
}
```

4. Extend `REVIEWER_SYSTEM` — change the JSON-shape sentence and add a digest instruction. Replace the `'{"status":...,"note":<short reason>}. '` literal with:
```ts
        '{"status":"ok"|"exists"|"failed"|"partial","approved":<content to keep>,' +
        '"remainder":<what is still missing>,"note":<short reason>,' +
        '"digest":<a SHORT plain-text extract of what this step established that the ' +
        'PLANNER needs to decide the next step — e.g. the key names/ids/outcome, NOT ' +
        'the full content>}. ' +
```
And before `'Output JSON only.'` append:
```ts
        'The "digest" is REQUIRED and MUST be a non-empty plain-text string (keep it ' +
        'brief — the full result is stored separately). ' +
```

5. In `LlmReviewer.review`, pass `maxDigestChars` to `parseReview`:
```ts
    return parseReview(res.content, opts.maxDigestChars ?? 500);
```

6. Rewrite `parseReview` to validate+bound the digest. Replace the whole function body:

```ts
export function parseReview(
  content: string,
  maxDigestChars = 500,
): ReviewResult {
  const json = extractJsonObject(content);
  if (json === null)
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  try {
    const o = JSON.parse(json) as Partial<ReviewOutcome>;
    const status = o.status;
    const approved = typeof o.approved === 'string' ? o.approved : '';
    const remainder = typeof o.remainder === 'string' ? o.remainder : '';
    const note = typeof o.note === 'string' ? o.note : '';
    const rawDigest = typeof o.digest === 'string' ? o.digest : '';
    if (
      status !== 'ok' &&
      status !== 'exists' &&
      status !== 'failed' &&
      status !== 'partial'
    ) {
      return { kind: 'judge-failure', reason: 'missing/invalid status' };
    }
    // Digest is REQUIRED on every settle (it is the planner's board content). A
    // missing/empty digest is a judge-failure (re-ask), distinct from a real
    // verdict. Bound it defensively (the full result is in RAG regardless).
    if (rawDigest.trim().length === 0) {
      return { kind: 'judge-failure', reason: 'missing digest' };
    }
    const digest = rawDigest.slice(0, maxDigestChars);
    if (
      (status === 'ok' || status === 'exists' || status === 'partial') &&
      approved.length === 0
    ) {
      const coercedNote = note
        ? `${note} [coerced: reviewer returned ${status} with empty approved]`
        : `reviewer returned ${status} with empty approved`;
      return {
        kind: 'outcome',
        outcome: {
          status: 'failed',
          approved: '',
          remainder: remainder || approved,
          note: coercedNote,
          digest: (note || coercedNote).slice(0, maxDigestChars),
        },
      };
    }
    if (status === 'partial' && remainder.trim().length === 0) {
      return {
        kind: 'outcome',
        outcome: { status: 'ok', approved, remainder: '', note, digest },
      };
    }
    return {
      kind: 'outcome',
      outcome: { status, approved, remainder, note, digest },
    };
  } catch {
    return { kind: 'judge-failure', reason: 'unparsable reviewer reply' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="parseReview"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/outcome.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/reviewer.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/reviewer.test.ts
git commit -m "feat(controller): reviewer returns a bounded planning digest (ReviewOutcome) (Phase 2)"
```

---

## Task 3: Contract — bundle/planner-input fields, board-budget config, reset (types.ts, session-bundle.ts, controller.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/session-bundle.ts`
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts`
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts`

One coherent contract change so the rest compiles: (a) the adaptive planner records `PlanDecision`s on the bundle (controller drains+persists — "planner constructs, controller persists"); (b) the handler passes the rendered board via `PlannerNextInput.boardText`; (c) the five board-budget knobs live on `ControllerConfig['budgets']` (so the handler's `cfg = deps.config.budgets` reads them directly) WITH defaults applied in `parseConfig`; (d) `resetRun` clears the new run-scoped bundle field.

- [ ] **Step 1: Add `pendingPlanDecisions` to `SessionBundle` + the import**

Add the import at the top of `types.ts` (type-only — `artifacts.ts` imports `Step` from `types.ts`, but `import type` emits no runtime require, so the ESM cycle is harmless):

```ts
import type { PlanDecision } from './artifacts.js';
```

Add to the `SessionBundle` interface (near `plan?`/`planCursor?`):

```ts
  /** Plan decisions the planner produced this turn (create/replan), NOT yet
   *  persisted. The controller drains + `writePlanDecision`s them after
   *  `planner.next()` returns and BEFORE dispatch (§A: planner constructs, controller
   *  persists; §F: every decision is a durable artifact). Cleared once drained, and
   *  on `resetRun`. */
  pendingPlanDecisions?: PlanDecision[];
```

- [ ] **Step 2: Add `boardText` to `PlannerNextInput`**

```ts
  /** The rendered step-state digest board (§B), reconstructed by the controller
   *  from artifacts before each call. When present + non-empty it REPLACES the
   *  legacy `plannerPrivate` blob in the planner prompt; empty/absent → the planner
   *  falls back to `plannerPrivate` (so the decision-less IncrementalPlanner is
   *  unchanged). */
  boardText?: string;
```

- [ ] **Step 3: Add the five board-budget knobs to `ControllerConfig['budgets']`**

Add to the `budgets:` object in the `ControllerConfig` interface (after `maxReviewRetries?`):

```ts
    /** Board render budget (§B). Defaulted in parseConfig; validated at load. */
    maxDigestChars?: number;
    maxIntentChars?: number;
    maxActiveSteps?: number;
    maxBoardChars?: number;
    keepRecentDigests?: number;
```

- [ ] **Step 4: Default the knobs in `parseConfig` (controller.ts)**

In `parseConfig`, the `budgets` literal currently defaults `maxSteps/maxRetries/maxRewinds/maxToolCalls` then spreads `...budgetsRaw`. Add the five board defaults BEFORE the spread (so explicit config still overrides):

```ts
      budgets: {
        maxSteps: 20,
        maxRetries: 3,
        maxRewinds: 5,
        maxToolCalls: 10,
        maxDigestChars: 500,
        maxIntentChars: 120,
        maxActiveSteps: 16,
        maxBoardChars: 12000,
        keepRecentDigests: 8,
        ...budgetsRaw,
      } as ControllerConfig['budgets'],
```

- [ ] **Step 5: Clear `pendingPlanDecisions` in `resetRun` (session-bundle.ts)**

In `resetRun`, alongside the other run-scoped clears (e.g. after `bundle.plan = undefined;`):

```ts
  bundle.pendingPlanDecisions = undefined;
```

- [ ] **Step 6: Write a failing test for the defaults**

Add to `controller.test.ts` (reuse its `parseConfig` access — match how the file already tests it):

```ts
test('parseConfig defaults the board-budget knobs', () => {
  const cfg = parseConfig({ subagents: { /* minimal valid subagents */ } });
  assert.equal(cfg.budgets.maxDigestChars, 500);
  assert.equal(cfg.budgets.maxBoardChars, 12000);
  assert.equal(cfg.budgets.keepRecentDigests, 8);
});

test('parseConfig lets explicit budgets override board defaults', () => {
  const cfg = parseConfig({
    subagents: { /* minimal valid subagents */ },
    budgets: { maxBoardChars: 9000 },
  });
  assert.equal(cfg.budgets.maxBoardChars, 9000);
  assert.equal(cfg.budgets.maxDigestChars, 500); // untouched default
});
```

> Match the file's actual `parseConfig` import + the minimal valid `subagents` literal the other tests in this file already use.

- [ ] **Step 7: Build + run**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Expected: success.
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="board-budget knobs|override board defaults"`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/session-bundle.ts \
        packages/llm-agent-server-libs/src/pipelines/controller.ts \
        packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts
git commit -m "feat(controller): board-budget config contract + bundle/planner-input fields + reset (Phase 2)"
```

---

## Task 4: Adaptive planner mints stepIds + records plan decisions

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

When `AdaptivePlanner` builds the initial plan, it mints create-stepIds and records a `{kind:'create'}` `PlanDecision`. When it replans the tail, it mints replan-stepIds (anchored on the failed step's `stepId`) and records a `{kind:'replan', anchor}` decision. Decisions accumulate on `bundle.pendingPlanDecisions` (the controller drains them — Task 6).

- [ ] **Step 1: Write the failing test**

Add to `planner.test.ts` (reuse the file's existing fake `ISubagentClient` pattern; this sketch assumes a `fakeClient(replies: string[])` helper — match the file's actual harness):

```ts
import { AdaptivePlanner } from '../planner.js';

test('AdaptivePlanner mints create stepIds + records a create plan-decision', async () => {
  const client = fakeClient([
    JSON.stringify({
      plan: [
        { name: 'a', instructions: 'fetch a' },
        { name: 'b', instructions: 'fetch b' },
      ],
    }),
  ]);
  const planner = new AdaptivePlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g' }); // test helper
  const next = await planner.next({ bundle, prompt: 'g', retrying: false });
  assert.equal(next?.kind, 'next');
  // every plan step has a stepId
  assert.ok(bundle.plan?.every((s) => typeof s.stepId === 'string'));
  // a create decision was recorded for the controller to persist
  assert.equal(bundle.pendingPlanDecisions?.length, 1);
  const dec = bundle.pendingPlanDecisions?.[0];
  assert.equal(dec?.kind, 'create');
  assert.equal(dec?.steps.length, 2);
  assert.equal(dec?.steps[0].stepId, bundle.plan?.[0].stepId);
});

test('AdaptivePlanner replan mints anchored stepIds + records a replan decision', async () => {
  const client = fakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }), // create
    JSON.stringify({ plan: [{ name: 'a2', instructions: 'fetch a differently' }] }), // replan
  ]);
  const planner = new AdaptivePlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g' });
  await planner.next({ bundle, prompt: 'g', retrying: false }); // create; cursor 0
  const anchor = bundle.plan?.[0].stepId;
  bundle.pendingPlanDecisions = []; // controller drained the create decision
  const next = await planner.next({
    bundle,
    prompt: 'g',
    retrying: false,
    lastOutcome: 'failed',
  });
  assert.equal(next?.kind, 'next');
  const dec = bundle.pendingPlanDecisions?.[0];
  assert.equal(dec?.kind, 'replan');
  assert.equal((dec as { anchor?: string })?.anchor, anchor);
  assert.equal(dec?.steps[0].supersedesStepId, anchor);
  assert.notEqual(dec?.steps[0].stepId, anchor); // new identity
});
```

> Before writing, open `planner.test.ts` and reuse its actual fake-client + bundle factory. If no `newBundle` helper exists, build a minimal `SessionBundle` literal inline (set at least `runId`, `goal`, `plannerPrivate: ''`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="AdaptivePlanner.*decision"`
Expected: FAIL — `pendingPlanDecisions` never populated; plan steps have no `stepId`.

- [ ] **Step 3: Implement minting + decision recording**

In `planner.ts`:

1. Add imports:
```ts
import {
  mintCreateStepIds,
  mintReplanStepIds,
  type PlanDecision,
} from './artifacts.js';
```

2. In `AdaptivePlanner.next`, the create branch (currently lines ~238-241):
```ts
      if (plan === null || plan.length === 0) return null;
      const minted = mintCreateStepIds(plan, bundle.runId ?? '');
      bundle.plan = minted;
      bundle.planCursor = 0;
      recordDecision(bundle, { kind: 'create', runId: bundle.runId ?? '', steps: minted });
      return this.stepAtCursor(bundle, prompt, logUsage);
```

3. In the replan branch (currently lines ~270-277), after `if (rest === null) return null;`:
```ts
      if (rest === null) return null;
      const anchor = bundle.plan[cursor]?.stepId ?? '';
      const mintedRest = mintReplanStepIds(rest, bundle.runId ?? '', anchor);
      bundle.plan = [...bundle.plan.slice(0, cursor), ...mintedRest];
      if (mintedRest.length > 0) {
        recordDecision(bundle, {
          kind: 'replan',
          runId: bundle.runId ?? '',
          anchor,
          steps: mintedRest,
        });
      }
      bundle.lastOutcome = undefined;
      return this.stepAtCursor(bundle, prompt, logUsage);
```
(An empty replan — `{"plan":[]}` meaning "remaining work is done" — records NO decision; nothing entered the plan.)

4. Add a module-level helper (after `parsePlan`):
```ts
/** Queue a plan decision for the controller to persist (§A boundary: the planner
 *  CONSTRUCTS the decision; the controller does the durable write). */
function recordDecision(bundle: SessionBundle, decision: PlanDecision): void {
  (bundle.pendingPlanDecisions ??= []).push(decision);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="AdaptivePlanner.*decision"`
Expected: PASS (2 tests). Then run the full planner suite to confirm no regression:
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="Planner|planner"`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): adaptive planner mints stepIds + records create/replan decisions (Phase 2)"
```

---

## Task 5: renderBoard with bounded deterministic compaction (board.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/board.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/board.test.ts`

Per §B: render the reconstructed board to ONE text block, bounded by a deterministic compaction policy with a GUARANTEED cap. `validateBoardBudget` enforces the load-time invariant. Phase 2 renders the states that exist now (`planned`/`executing`/`awaiting-external`/`done`/`partial`/`failed`); discovery protection (`expanding`/`expanded`, "done discovery not yet fully-expanded") is deferred to the discovery phase — the render treats every non-terminal state as protected/actionable and every terminal state (`done`/`partial`/`failed`) as compactable.

Rendering rules:
1. **Actionable (NOT-terminal) entries** (`planned`/`executing`/`awaiting-external`) are ALWAYS rendered individually, never aggregated: `[<stepId8> <state>] <intent≤maxIntentChars>` (stepId shown as its first 8 chars for readability; intent truncated to `maxIntentChars`).
2. **Terminal entries** (`done`/`partial`/`failed`): the most recent `K` (`keepRecentDigests`) by `seq` are kept in full — `[seq N name state] digest`. Older terminal entries compact oldest-first to `[seq N name state]`. If, after summarizing ALL older terminals, the rendered length still exceeds `maxBoardChars`, the oldest summaries drop to a single `… M earlier steps omitted` marker (full results stay in RAG, recallable by seq).
3. Deterministic ordering: actionable block first (by `seq ?? Infinity`, then `stepId`), then terminal block by `seq`.
4. **GUARANTEED cap (§B):** the only content `renderBoard` cannot compact away is the protected actionable block + the `K` recent digests + the omitted marker. If, after exhausting all older-summary drops, the text STILL exceeds `maxBoardChars`, `renderBoard` THROWS `BoardOverBudgetError` rather than returning a lossy/over-budget board — the controller catches it and fails loud / suspends BEFORE the planner call (§B). So `renderBoard` NEVER returns a string longer than `maxBoardChars`. `validateBoardBudget` sizes the load-time invariant so this throw is unreachable for a capacity-gated board; in Phase 2 (no §D capacity gate) a pathologically large plan can still trip it — fail-loud, by design.

- [ ] **Step 1: Write the failing tests**

Add to `board.test.ts`:

```ts
import {
  renderBoard,
  validateBoardBudget,
  type BoardBudget,
  type BoardEntry,
} from '../board.js';

const BUDGET: BoardBudget = {
  maxDigestChars: 80,
  maxIntentChars: 40,
  maxActiveSteps: 8,
  maxBoardChars: 4000,
  keepRecentDigests: 3,
};

function entry(p: Partial<BoardEntry> & { stepId: string }): BoardEntry {
  return {
    name: p.name ?? 'step',
    instructions: p.instructions ?? 'do the thing',
    state: p.state ?? 'planned',
    ...p,
  };
}

test('renderBoard renders actionable steps individually with stepId + state', () => {
  const board = new Map<string, BoardEntry>([
    ['s1', entry({ stepId: 's1aaaaaa', state: 'planned', instructions: 'fetch the list' })],
    ['s2', entry({ stepId: 's2bbbbbb', state: 'executing', seq: 1, instructions: 'read row 1' })],
  ]);
  const text = renderBoard(board, BUDGET);
  assert.match(text, /planned/);
  assert.match(text, /executing/);
  assert.match(text, /fetch the list/);
  assert.match(text, /s1aaaaaa/.source.slice(0, 8) === 's1aaaaaa' ? /s1aaaaaa/ : /s1/);
});

test('renderBoard keeps the most recent K terminal digests in full, summarizes older', () => {
  const board = new Map<string, BoardEntry>();
  for (let i = 0; i < 6; i++) {
    board.set(`d${i}`, entry({
      stepId: `step${i}`,
      name: `n${i}`,
      state: 'done',
      seq: i,
      digest: `DIGEST_${i}`,
    }));
  }
  const text = renderBoard(board, BUDGET); // keepRecentDigests = 3
  assert.match(text, /DIGEST_5/); // recent kept in full
  assert.match(text, /DIGEST_3/);
  assert.doesNotMatch(text, /DIGEST_0/); // old compacted to summary (no digest)
  assert.match(text, /seq 0 n0 done/); // summary form present
});

test('renderBoard truncates a non-discovery digest to maxDigestChars', () => {
  const board = new Map<string, BoardEntry>([
    ['d', entry({ stepId: 's', state: 'done', seq: 0, digest: 'y'.repeat(500) })],
  ]);
  const text = renderBoard(board, BUDGET);
  assert.ok(!text.includes('y'.repeat(81))); // bounded to maxDigestChars (80)
});

test('renderBoard truncates actionable intent to maxIntentChars', () => {
  const board = new Map<string, BoardEntry>([
    ['s', entry({ stepId: 's', state: 'planned', instructions: 'z'.repeat(200) })],
  ]);
  const text = renderBoard(board, BUDGET);
  assert.ok(!text.includes('z'.repeat(41)));
});

test('renderBoard is empty for an empty board', () => {
  assert.equal(renderBoard(new Map(), BUDGET), '');
});

test('renderBoard never returns over-cap text — throws when it cannot compact enough', () => {
  // A tight cap with protected actionable content that alone exceeds it.
  const tight: BoardBudget = { ...BUDGET, maxBoardChars: 60, maxActiveSteps: 100 };
  const board = new Map<string, BoardEntry>();
  for (let i = 0; i < 10; i++) {
    board.set(`s${i}`, entry({ stepId: `actv${i}`, state: 'planned', instructions: 'x'.repeat(40) }));
  }
  assert.throws(() => renderBoard(board, tight), /BoardOverBudget|maxBoardChars/);
});

test('renderBoard output never exceeds maxBoardChars when it does return', () => {
  const board = new Map<string, BoardEntry>();
  for (let i = 0; i < 40; i++) {
    board.set(`d${i}`, entry({ stepId: `step${i}`, name: `n${i}`, state: 'done', seq: i, digest: `D${i}`.repeat(10) }));
  }
  const text = renderBoard(board, BUDGET);
  assert.ok(text.length <= BUDGET.maxBoardChars);
});

test('validateBoardBudget passes a well-sized budget', () => {
  assert.doesNotThrow(() => validateBoardBudget(BUDGET));
});

test('validateBoardBudget fails loud when the worst case cannot fit', () => {
  assert.throws(
    () => validateBoardBudget({ ...BUDGET, maxBoardChars: 50 }),
    /maxBoardChars/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="renderBoard|validateBoardBudget"`
Expected: FAIL — `renderBoard`/`validateBoardBudget`/`BoardBudget` not exported.

- [ ] **Step 3: Implement renderBoard + validateBoardBudget**

Append to `board.ts`:

```ts
/** Thrown by renderBoard when the protected (uncompactable) content still exceeds
 *  maxBoardChars (§B): the controller catches it and fails loud / suspends BEFORE
 *  the planner call rather than feeding a lossy board. */
export class BoardOverBudgetError extends Error {
  constructor(
    readonly rendered: number,
    readonly cap: number,
  ) {
    super(`rendered board (${rendered} chars) exceeds maxBoardChars (${cap})`);
    this.name = 'BoardOverBudgetError';
  }
}

/** Board render budget (§B). All bounds are REQUIRED so the cap is guaranteed. */
export interface BoardBudget {
  /** Cap on a non-discovery free-text digest (terminal entries). */
  maxDigestChars: number;
  /** Cap on an actionable entry's rendered intent (never dropped, only trimmed). */
  maxIntentChars: number;
  /** Bound on simultaneously-actionable entries (the §D capacity gate enforces it;
   *  here it sizes the load-time invariant). */
  maxActiveSteps: number;
  /** Hard cap on the whole rendered board. */
  maxBoardChars: number;
  /** Number of most-recent terminal digests kept in full before compaction. */
  keepRecentDigests: number;
}

const TERMINAL: ReadonlySet<StepState> = new Set([
  'done',
  'partial',
  'failed',
]);

/** Validate the board budget at load (§B fail-loud invariant): all knobs are
 *  non-negative integers, and the worst-case actionable block + the kept digests +
 *  headroom fit `maxBoardChars`. A fixed per-line overhead (~24 chars: `[`, stepId8,
 *  space, state, `] `, newline) is folded into the estimate.
 *
 *  The `maxActiveSteps` term is the §D-capacity-gated worst case (fan-out ≤
 *  maxFanOut, one window at a time). In Phase 2 (no §D gate) the actionable count is
 *  NOT bounded by maxActiveSteps — a one-shot plan materialises every future step as
 *  `planned`. So this check is the load-time sizing guide; the HARD runtime
 *  guarantee that the board never exceeds the cap is `renderBoard`'s
 *  `BoardOverBudgetError` throw (the controller catches it → fail-loud). */
export function validateBoardBudget(b: BoardBudget): void {
  for (const [k, v] of Object.entries(b)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`BoardBudget.${k} must be a non-negative integer (got ${v})`);
    }
  }
  const PER_LINE_OVERHEAD = 24;
  const actionableWorstCase =
    b.maxActiveSteps * (PER_LINE_OVERHEAD + b.maxIntentChars);
  const digestsWorstCase =
    b.keepRecentDigests * (PER_LINE_OVERHEAD + b.maxDigestChars);
  const headroom = 256;
  const needed = actionableWorstCase + digestsWorstCase + headroom;
  if (needed > b.maxBoardChars) {
    throw new Error(
      `BoardBudget invariant violated: worst-case board (${needed}) exceeds ` +
        `maxBoardChars (${b.maxBoardChars}). Increase maxBoardChars or reduce ` +
        `maxActiveSteps/maxIntentChars/keepRecentDigests/maxDigestChars.`,
    );
  }
}

/** Render the reconstructed board to ONE bounded text block (§B). Deterministic:
 *  same board ⇒ same output. Actionable (not-terminal) entries are always rendered
 *  individually (stepId + state + bounded intent); terminal entries keep the most
 *  recent K digests in full and compact older ones oldest-first, dropping to an
 *  "omitted" marker if the cap is still exceeded. */
export function renderBoard(
  board: Map<string, BoardEntry>,
  budget: BoardBudget,
): string {
  const entries = [...board.values()];
  if (entries.length === 0) return '';
  const short = (id: string) => id.slice(0, 8);

  const actionable = entries
    .filter((e) => !TERMINAL.has(e.state))
    .sort(
      (a, b) =>
        (a.seq ?? Number.POSITIVE_INFINITY) -
          (b.seq ?? Number.POSITIVE_INFINITY) ||
        a.stepId.localeCompare(b.stepId),
    )
    .map(
      (e) =>
        `[${short(e.stepId)} ${e.state}] ${e.instructions.slice(0, budget.maxIntentChars)}`,
    );

  const terminals = entries
    .filter((e) => TERMINAL.has(e.state))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const cutoff = Math.max(0, terminals.length - budget.keepRecentDigests);
  // Recent terminals: full digest. Older: summary line.
  const recentLines = terminals
    .slice(cutoff)
    .map(
      (e) =>
        `[seq ${e.seq ?? 0} ${e.name} ${e.state}] ${(e.digest ?? '').slice(0, budget.maxDigestChars)}`,
    );
  let olderLines = terminals
    .slice(0, cutoff)
    .map((e) => `[seq ${e.seq ?? 0} ${e.name} ${e.state}]`);

  const assemble = (older: string[], omitted: number): string =>
    [
      ...actionable,
      ...(omitted > 0 ? [`… ${omitted} earlier steps omitted`] : []),
      ...older,
      ...recentLines,
    ].join('\n');

  let text = assemble(olderLines, 0);
  // If still over cap, drop older summaries oldest-first into one marker.
  let omitted = 0;
  while (text.length > budget.maxBoardChars && olderLines.length > 0) {
    olderLines = olderLines.slice(1);
    omitted++;
    text = assemble(olderLines, omitted);
  }
  // GUARANTEED cap (§B): older summaries are now exhausted. The remaining content
  // (protected actionable block + K recent digests + omitted marker) is
  // uncompactable — if it STILL exceeds the cap, do NOT return a lossy board; throw
  // so the controller fails loud / suspends BEFORE the planner call.
  if (text.length > budget.maxBoardChars) {
    throw new BoardOverBudgetError(text.length, budget.maxBoardChars);
  }
  return text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="renderBoard|validateBoardBudget"`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/board.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/board.test.ts
git commit -m "feat(controller): renderBoard + validateBoardBudget bounded compaction (Phase 2)"
```

---

## Task 6: Handler — persist decisions, reconstruct+render the board, write stepId+digest

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`

This wires Phase-2's pieces into the live loop. Three integration points:

**(A) Drain + persist `pendingPlanDecisions` after `planner.next()`.** Right after the `planner.next({...})` call (around line 673) and before dispatch, drain `bundle.pendingPlanDecisions` and `writePlanDecision` each, incrementing `bundle.writeOrdinal` per write. This makes every create/replan a durable artifact (§F).

**(B) Reconstruct + render the board, pass `boardText` into `planner.next()`.** Before each `planner.next()` call, build the board from artifacts and render it; thread it through `PlannerNextInput.boardText`.

**(C) Persist `stepId` + `digest` on the `step-result`.** At the post-review write site (line 1040) add `stepId: step.stepId` and `digest: outcome.digest`. For the default (no-`deps.reviewer`) path, synthesize a digest. Thread `maxDigestChars` (from config) into the reviewer calls.

- [ ] **Step 1: Write the failing test**

Add to `controller-coordinator-handler.test.ts` (reuse the file's existing in-memory-backend + fake-deps harness). Two focused assertions:

```ts
// NOTE: `KnowledgeBackend.scan(sessionId)` takes ONLY the sessionId and returns
// ALL entries (no filter arg); filter in the test. (Filtered reads in product
// code go through `IKnowledgeRagHandle.list({runId, artifactType})`.)
test('handler persists a plan-decision after the planner creates a plan', async () => {
  // ... build deps with an AdaptivePlanner whose client returns a 1-step plan,
  //     an executor that returns content, a reviewer that returns ok+digest ...
  const { backend, sessionId, runId } = await runOneTurn(/* fixture */);
  const all = await backend.scan(sessionId);
  const decisions = all.filter(
    (e) => e.metadata.artifactType === 'plan-decision' && e.metadata.runId === runId,
  );
  assert.ok(decisions.length >= 1);
});

test('handler writes stepId + digest on the step-result', async () => {
  const { backend, sessionId, runId } = await runOneTurn(/* fixture */);
  const all = await backend.scan(sessionId);
  const results = all.filter(
    (e) => e.metadata.artifactType === 'step-result' && e.metadata.runId === runId,
  );
  assert.ok(results.length >= 1);
  assert.ok(results[0].metadata.stepId, 'stepId persisted');
  assert.ok(results[0].metadata.digest, 'digest persisted');
});
```

> Reuse the harness already in `controller-coordinator-handler.test.ts` (it constructs `deps` + an in-memory `KnowledgeBackend` and drives a turn). If a `runOneTurn`-style helper does not exist, follow the file's existing pattern for invoking the handler and reading back artifacts via `backend.scan(sessionId)` + a metadata filter.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="plan-decision|stepId \+ digest"`
Expected: FAIL — no `plan-decision` artifacts written; `step-result` has no `stepId`/`digest`.

- [ ] **Step 3a: Drain + persist decisions (point A)**

Add imports near the top of the handler (top-level — NOT inside any function body):
```ts
import { readClaims, readPlanDecisions, writePlanDecision } from './artifacts.js';
import {
  BoardOverBudgetError,
  type BoardBudget,
  reconstructBoard,
  renderBoard,
} from './board.js';
```
(Merge with the existing `./artifacts.js` import if one already exists. `BoardOverBudgetError` is used by the §B fail-loud catch in Step 3b — it must be at the top, not re-imported inline.)

Immediately AFTER the `const next = await planner.next({ ... })` call (~line 673-694) and BEFORE the code that acts on `next`, drain the queue:

```ts
    // Persist every plan decision the planner produced this turn (§F) BEFORE the
    // board reflects it. The planner CONSTRUCTS the decision; the controller does
    // the durable write (§A boundary). One write per decision, monotonic ordinal.
    const drained = bundle.pendingPlanDecisions ?? [];
    bundle.pendingPlanDecisions = [];
    for (const decision of drained) {
      bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
      await writePlanDecision(
        deps.backend,
        sessionId,
        decision,
        JSON.stringify(decision.steps),
        new Date().toISOString(),
        bundle.writeOrdinal,
      );
    }
```

> `plannerOutput` (4th arg) folds into the LLM-authored decision's content hash (§F) — the serialized minted steps are a stable proxy for "this planner output". Identical re-emission → identical id (dedup); a different plan → a different id. This is sufficient for create/replan dedup in Phase 2.

- [ ] **Step 3b: Reconstruct + render the board (point B)**

Define the board budget once near the handler's config resolution. `parseConfig`
(Task 3) guarantees the five knobs are present; the `?? default` is a defensive
fallback for hand-built configs and keeps the type `number` (the config fields are
optional). Build it from `cfg` (`= deps.config.budgets`):

```ts
    const boardBudget: BoardBudget = {
      maxDigestChars: cfg.maxDigestChars ?? 500,
      maxIntentChars: cfg.maxIntentChars ?? 120,
      maxActiveSteps: cfg.maxActiveSteps ?? 16,
      maxBoardChars: cfg.maxBoardChars ?? 12000,
      keepRecentDigests: cfg.keepRecentDigests ?? 8,
    };
```

Add a helper (module scope) that builds the rendered board from artifacts:

```ts
async function renderLiveBoard(
  rag: IKnowledgeRagHandle,
  bundle: SessionBundle,
  budget: BoardBudget,
): Promise<string> {
  const runId = bundle.runId;
  if (!runId) return '';
  const [structure, claims] = await Promise.all([
    readPlanDecisions(rag, runId),
    readClaims(rag, runId),
  ]);
  const stepResults = await rag.list({ runId, artifactType: 'step-result' });
  const board = reconstructBoard({
    structure,
    stepResults,
    claims,
    inFlight: bundle.inFlightStep,
    pending: bundle.pending,
  });
  return renderBoard(board, budget);
}
```

Then, right BEFORE the `planner.next({...})` call, compute the board text and pass
it. `renderLiveBoard` can throw `BoardOverBudgetError` (§B fail-loud) — do NOT
swallow it into a truncated board; surface it via the handler's EXISTING store-first
terminal-error path, `abortTerminal`, exactly as the `maxStepAttempts` overflow does
(`controller-coordinator-handler.ts:762`). `now`, `terminalTtlMs`, and `usageNow`
are already in scope inside the run loop (bound at the top of the loop method, lines
~203/207/220). `abortTerminal` returns `Promise<void>`; the loop method returns
`Promise<boolean>`, so `return true` after it (mirroring the existing callers):

```ts
      // (BoardOverBudgetError is imported at the top of the file — Step 3a.)
      let boardText: string;
      try {
        boardText = await renderLiveBoard(rag, bundle, boardBudget);
      } catch (err) {
        if (err instanceof BoardOverBudgetError) {
          // §B: never feed the planner a lossy board — fail loud (store-first
          // terminal error), identical to the maxStepAttempts overflow path.
          await this.abortTerminal(
            ctx,
            sessionId,
            bundle,
            `board exceeds maxBoardChars: ${err.message}`,
            now,
            terminalTtlMs,
            usageNow(),
          );
          return true;
        }
        throw err;
      }
      const next = await planner.next({
        bundle,
        prompt,
        // ...existing fields (lastOutcome / retrying / resumedExternal / logUsage / options)...
        boardText,
      });
```

> There is only ONE `planner.next()` call in the handler (line 673). If the board must be rendered AFTER decisions are persisted to reflect the just-created plan, note that the board for THIS turn's prompt is built from PRIOR turns' artifacts (the current plan is created INSIDE this `next()` call) — so render BEFORE `next()`. The newly drained decisions surface on the NEXT turn's board. This is correct: the planner needs "what happened so far," not the plan it is currently emitting.

- [ ] **Step 3c: Persist stepId + digest on the step-result (point C)**

Thread `maxDigestChars` into the reviewer calls (lines ~996 and ~1029): add `maxDigestChars: cfg.maxDigestChars ?? 500` to the `ReviewOpts` object passed to `deps.reviewer.review(...)`.

In the default-reviewer branch (lines ~1000-1008), add a `digest`:
```ts
          : {
              kind: 'outcome',
              outcome: {
                status: 'ok',
                approved: res.content,
                remainder: '',
                note: '',
                digest: res.content.slice(0, cfg.maxDigestChars ?? 500),
              },
            };
```

At the `writeArtifact` step-result call (lines ~1040-1056), add two metadata fields:
```ts
            status: outcome.status,
            note: outcome.note,
            remainder: outcome.remainder,
            stepId: step.stepId,
            digest: outcome.digest,
            writeOrdinal: bundle.writeOrdinal,
            content: outcome.approved,
```

> `outcome` is now a `ReviewOutcome` (Task 2) so `outcome.digest` is typed. `step.stepId` is set because the adaptive planner minted it (Task 4). For a step with no `stepId` (legacy incremental path), `metadata.stepId` is `undefined` — `reconstructBoard` already skips entries with no `stepId`, so the incremental path stays board-less (its `step-result`s carry a digest but no board entry — harmless).

- [ ] **Step 3d: Control-failure branches write a `failed` step-result (board carries the reason)**

Several CONTROL-failure branches in the run loop currently write their reason ONLY to `bundle.plannerPrivate`, then `return settle('failed')` to drive a replan. Because the board is reconstructed from `step-result` artifacts, a control failure that writes no `step-result` leaves NO `failed` board entry — the planner's board-based replan would not see the reason (and the step would render as stale `executing` from the in-flight). Make every such branch ALSO write a `failed` `step-result` carrying `stepId` + the reason as `digest`/`note`, so the board (and thus the §C board-only planners) is authoritative for step failures. This is the durable, §C-ready half; the `plannerPrivate` append stays (Task 7 renders it as the non-board delta safety net).

Add a closure inside the run-loop method (it captures `step`, `bundle`, `rag`, `meta`, `cfg`, `ctx` — all already in scope at the post-review write site):

```ts
    /** Persist a controller-level (non-reviewer) step failure as a `failed`
     *  step-result so the board reflects it (the planner replans from the board). */
    const writeControlFailure = async (reason: string): Promise<void> => {
      const seq = bundle.inFlightStep?.seq ?? bundle.nextSeq ?? 0;
      const attempt = bundle.inFlightStep?.attempt ?? 0;
      bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
      await writeArtifact(
        rag,
        {
          ...meta,
          artifactType: 'step-result',
          task: step.name,
          runId: bundle.runId,
          seq,
          attempt,
          status: 'failed',
          note: reason,
          remainder: '',
          stepId: step.stepId,
          digest: reason.slice(0, cfg.maxDigestChars ?? 500),
          writeOrdinal: bundle.writeOrdinal,
          content: '',
        },
        ctx.options,
      );
    };
```

At EACH of these branches, call `await writeControlFailure(<reason>);` immediately BEFORE the existing `bundle.plannerPrivate += ...` line (keep the append). Use the SAME reason text that goes to `plannerPrivate`:

| handler line | reason |
|---|---|
| ~1022 reviewer unverifiable | `` `reviewer unverifiable after ${cfg.maxReviewRetries ?? 2} retries: ${review.reason}` `` |
| ~1082 executor error (retries exhausted) | `` `executor error: ${res.error}` `` |
| ~1101 empty tool call | `'empty tool call'` |
| ~1114 maxToolCalls (external pre-check) | `'tool-call budget exhausted (maxToolCalls)'` |
| ~1160 unavailable tool | `` `requested unavailable tool ${name}` `` |
| ~1173 maxToolCalls (post-increment) | `'tool-call budget exhausted (maxToolCalls)'` |

> All six already increment `bundle.budgets.stepsUsed` and `return settle('failed')` — leave that unchanged; only ADD the `writeControlFailure(...)` call. The reviewer-unverifiable branch (~1022) already builds its reason string inline; reuse it.

Also add this assertion to the Step-1 `step-result` test (or a third test): drive a control-failure turn (e.g. an executor that always errors past `maxRetries`) and assert a `step-result` with `status === 'failed'` and a non-empty `digest` + `stepId` exists.

- [ ] **Step 4: Build + run the handler tests**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Expected: success.
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="plan-decision|stepId \+ digest|control.failure"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
git commit -m "feat(controller): persist plan-decisions, render live board, write stepId+digest (Phase 2)"
```

---

## Task 7: Planner prompts consume the board (planner.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

Replace the payload-free `Progress:${bundle.plannerPrivate}` blob with the rendered board PLUS the `plannerPrivate` tail. The board is the AUTHORITATIVE structured step state (states + digests, incl. control failures via Task 6D), so it fixes the loop/bloat the spec targets. But `plannerPrivate` ALSO carries deltas the board does NOT model — clarify answers (`controller-coordinator-handler.ts:490`) and the legacy seeded-bundle external-tool result (`:464`) — and the adaptive replan reads them (`planner.ts:244`). So the render is ADDITIVE, not exclusive-or: dropping `plannerPrivate` when the board is non-empty would silently lose those replan signals. When the board is EMPTY (legacy `IncrementalPlanner`, which writes no decisions) the prompt is `plannerPrivate` alone — byte-identical to today.

> The terse `[seq N name status]` lines in `plannerPrivate` now duplicate the board's terminal entries — accepted interim cost. They retire together with `plannerPrivate` when the §C planner restructure moves both planners to a board-only context.

- [ ] **Step 1: Write the failing tests**

Add to `planner.test.ts`:

```ts
test('AdaptivePlanner prompt carries boardText when present', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]); // captures the messages it was sent
  const planner = new AdaptivePlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '' });
  await planner.next({
    bundle,
    prompt: 'g',
    retrying: false,
    boardText: '[step1aaa done] includes A,B',
  });
  assert.match(client.lastUserContent(), /includes A,B/); // board used
});

test('AdaptivePlanner prompt is ADDITIVE: board + plannerPrivate deltas both survive', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner = new AdaptivePlanner(client);
  // plannerPrivate carries a NON-board delta (clarify answer / external result).
  const bundle = newBundle({
    runId: 'run-1',
    goal: 'g',
    plannerPrivate: '\n[clarify answer] use system PRD',
  });
  await planner.next({
    bundle,
    prompt: 'g',
    retrying: false,
    boardText: '[step1aaa done] includes A,B',
  });
  const userMsg = client.lastUserContent();
  assert.match(userMsg, /includes A,B/); // board present
  assert.match(userMsg, /use system PRD/); // non-board delta NOT lost
});

test('AdaptivePlanner prompt falls back to plannerPrivate alone when boardText empty', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner = new AdaptivePlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '\n[seq 0 a ok]' });
  await planner.next({ bundle, prompt: 'g', retrying: false, boardText: '' });
  assert.match(client.lastUserContent(), /\[seq 0 a ok\]/); // legacy blob, unchanged
});
```

> Reuse / extend the file's existing fake client so it records the last `send(messages)` and exposes the last user-role content. If the harness lacks a recorder, add a tiny one in the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="carries boardText|ADDITIVE|falls back to plannerPrivate"`
Expected: FAIL — prompt still uses `plannerPrivate` unconditionally (board ignored).

- [ ] **Step 3: Implement the additive swap**

Add a module-level helper in `planner.ts` (after `withSkillsBlock`):

```ts
/** The planner's progress context. With a live board, render the AUTHORITATIVE
 *  structured board AND the plannerPrivate tail — the latter carries non-board
 *  deltas the planner still needs (clarify answers, legacy external-tool result).
 *  An empty board (decision-less IncrementalPlanner) → plannerPrivate alone,
 *  byte-identical to the legacy prompt. */
function progressBlock(bundle: SessionBundle, boardText?: string): string {
  return boardText && boardText.length > 0
    ? `${boardText}\n${bundle.plannerPrivate}`
    : bundle.plannerPrivate;
}
```

Thread `boardText` into the three prompt sites:

1. `IncrementalPlanner.next` — destructure `boardText` from `input` (line ~85) and change line ~98:
```ts
          `Goal: ${bundle.goal}\nProgress:${progressBlock(bundle, boardText)}\nRequest: ${prompt}`,
```

2. `AdaptivePlanner.next` — destructure `boardText` from `input` (line ~213-221) and pass it down. The two prompt sites are in `stepAtCursor` (finalize, line ~319) and `callPlan` (line ~364). Thread `boardText` as a parameter to both:
   - Add `boardText?: string` param to `callPlan` and `stepAtCursor`; pass `boardText` from `next()` at every call (the create call ~225, the replan call ~261, and the `stepAtCursor` calls ~241/277/285).
   - In `stepAtCursor` finalize (line ~319):
```ts
          content: `Goal: ${bundle.goal}\nRequest: ${prompt}\nProgress:${progressBlock(bundle, boardText)}`,
```
   - In `callPlan` (line ~364):
```ts
          `Goal: ${bundle.goal}\nProgress:${progressBlock(bundle, boardText)}${completedBlock}\nRequest: ${prompt}`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="carries boardText|ADDITIVE|falls back to plannerPrivate"`
Expected: PASS (3 tests). Then the full planner suite:
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="Planner|planner"`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): planner prompts consume the rendered board (plannerPrivate fallback) (Phase 2)"
```

---

## Task 8: Validate the board budget at composition (ControllerFactory.build) + green gate

**Files:**
- Modify: `packages/llm-agent-server-libs/src/factories/controller-factory.ts` (the `build()` method)
- Test: `packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts`

Per §B the board-budget invariant is validated AT LOAD (fail-loud), not per-turn. `ControllerFactory.build(config, deps)` is the SINGLE composition chokepoint: the pipeline plugin's `build()` delegates to it (`controller.ts:158` — `new ControllerFactory().build(cfg, deps)`), AND it is the documented programmatic entry point. Validating HERE (next to the existing embedder / `semanticRecallCapable` fail-loud asserts) covers BOTH paths — a direct factory user cannot bypass it and hit a runtime `BoardOverBudgetError` in the turn loop.

- [ ] **Step 1: Write the failing test**

Add to `controller-factory.test.ts` (reuse the file's existing `deps` fixture — an embedder + semantic-capable backend, since those asserts run first):

```ts
test('ControllerFactory.build rejects a board budget that cannot fit', async () => {
  const config = {
    ...baseControllerConfig, // the file's minimal valid ControllerConfig fixture
    budgets: {
      ...baseControllerConfig.budgets,
      maxBoardChars: 50, // far too small for the default actionable worst-case
      maxActiveSteps: 16,
      maxIntentChars: 120,
      maxDigestChars: 500,
      keepRecentDigests: 8,
    },
  };
  await assert.rejects(
    () => new ControllerFactory().build(config, semanticCapableDeps()),
    /maxBoardChars/,
  );
});
```

> Match the file's actual `ControllerFactory` import + the deps fixture it already uses (it MUST pass the embedder + `semanticRecallCapable` backend asserts to reach the budget check). If the file lacks a ready `baseControllerConfig`, build a minimal valid `ControllerConfig` inline (3 subagents + a `budgets` block with the too-small `maxBoardChars`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="board budget that cannot fit"`
Expected: FAIL — `build()` does not validate the budget yet.

- [ ] **Step 3: Wire `validateBoardBudget` into `ControllerFactory.build()`**

Add the import to `controller-factory.ts`:
```ts
import { validateBoardBudget } from '../smart-agent/controller/board.js';
```
In `build(config, deps)`, AFTER the existing embedder + `semanticRecallCapable` fail-loud asserts and BEFORE the role-LLM resolution (`Promise.all([...])`), validate the resolved board budget (the five knobs are present when `config` came through `parseConfig`, which defaulted them in Task 3; the `?? default` keeps a hand-built config safe and the type `number`):
```ts
    const b = config.budgets;
    validateBoardBudget({
      maxDigestChars: b.maxDigestChars ?? 500,
      maxIntentChars: b.maxIntentChars ?? 120,
      maxActiveSteps: b.maxActiveSteps ?? 16,
      maxBoardChars: b.maxBoardChars ?? 12000,
      keepRecentDigests: b.keepRecentDigests ?? 8,
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="board budget that cannot fit"`
Expected: PASS.

- [ ] **Step 5: Full green gate**

```bash
npm run -w @mcp-abap-adt/llm-agent build
npm run -w @mcp-abap-adt/llm-agent-libs build
npm run -w @mcp-abap-adt/llm-agent-server-libs build
npm run -w @mcp-abap-adt/llm-agent-server-libs test
npm run lint:check
```
Expected: all builds succeed, full server-libs suite green, lint clean. Confirm 0 NUL bytes:
```bash
! grep -rlP '\x00' packages/llm-agent-server-libs/src/smart-agent/controller/ && echo "NO NUL"
```

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/factories/controller-factory.ts \
        packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts
git commit -m "feat(controller): validate board budget at composition (fail-loud) (Phase 2)"
```

---

## Self-Review

**Spec coverage (§A, §B, §E, §F — Phase-2 slice):**
- §A two representations / reviewer returns digest, controller persists → Task 2 (`ReviewOutcome`, `parseReview`) + Task 6c (controller writes `digest` to `step-result`). ✓
- §A migration contract (digest required, bounded, malformed → judge-failure) → Task 2. ✓ (`enumeration` explicitly deferred to discovery phase.)
- §B digest board supplants the payload-free blob as the AUTHORITATIVE step state → Task 7. The render is ADDITIVE (board + `plannerPrivate` tail), NOT exclusive-or, so non-board replan deltas (clarify answers, legacy external-tool results) are never lost; control-step failures are promoted ONTO the board as `failed` step-results (Task 6D) so the board is authoritative for failures too (and the §C board-only planners will see them). The terse duplicate `[seq N name status]` lines retire with `plannerPrivate` in §C. ✓
- Lost-signal safety: every handler branch that feeds a replan surfaces its reason into the planner prompt — control failures via a `failed` step-result on the board (Task 6D), clarify/legacy-external deltas via the additive `plannerPrivate` tail (Task 7). ✓
- §B budget / deterministic compaction / GUARANTEED cap → Task 5 (`renderBoard` compacts terminals; throws `BoardOverBudgetError` rather than returning over-cap text). ✓
- §B `maxIntentChars` REQUIRED + actionable never aggregated → Task 5 (actionable rendered individually, intent bounded). ✓
- §B fail-loud, never a lossy board → Task 5 (`renderBoard` throws) + Task 6b (handler catches → terminal control error). ✓
- §B config invariant fail-loud at load → Task 5 (`validateBoardBudget`) + Task 8 (called in `ControllerFactory.build()` — the single chokepoint the pipeline plugin AND direct programmatic users pass through, so neither path can reach a runtime `BoardOverBudgetError`). ✓
- §B board-budget config contract (knobs on `budgets`, defaulted in `parseConfig`, read by the handler as `cfg.*`) → Task 3. ✓
- §E step-state vocabulary → already in Phase-1 `board.ts`; Task 5 renders the Phase-2 subset (terminal vs actionable); `expanding`/`expanded` deferred. ✓ (explicit scope note)
- §F stepId at creation, retry vs replan identity (`supersedesStepId`) → Task 1 + Task 4. ✓
- §F every decision is a durable artifact (create/replan) → Task 4 (record) + Task 6a (persist). ✓ (`expand`/`page` deferred)
- §F step-result carries digest so the board is artifact-reconstructible → Task 6c. ✓

**Placeholder scan:** Every code step shows the actual code, including the §B fail-loud path (Task 6b now calls the concrete `this.abortTerminal(...)` + `return true`, mirroring the `maxStepAttempts` caller at `controller-coordinator-handler.ts:762` — no `failRun(...)` placeholder). The remaining "match the file's harness" notes (Task 4/6/7/8 TESTS) delegate only the reuse of EXISTING test fixtures (fake client / in-memory backend / ctx factory / `parseConfig` access) — the test bodies and all PRODUCTION code are given in full. No "TBD"/"add error handling"/"similar to" placeholders in any production-code step.

**Type consistency:** `ReviewOutcome` (Task 2) = `Outcome & {digest}`; `ReviewResult.outcome` uses it (Task 2); the handler's `outcome` variable is therefore `ReviewOutcome` and `outcome.digest` is valid (Task 6c); the default-reviewer branch constructs a `ReviewOutcome` (Task 6c). `BoardBudget` fields are identical between `renderBoard`/`validateBoardBudget` (Task 5), the handler's budget built from `cfg` (Task 6b), and `build()` (Task 8). The five board knobs are defined ONCE on `ControllerConfig['budgets']` (Task 3), defaulted in `parseConfig` (Task 3), and read by the handler as `cfg.maxDigestChars` etc. (`cfg = deps.config.budgets`, Task 6). `mintCreateStepIds`/`mintReplanStepIds` return `Step[]` consumed by `bundle.plan` and `PlanDecision.steps`. `PlannerNextInput.boardText` (Task 3) is read in Task 7. `bundle.pendingPlanDecisions: PlanDecision[]` (Task 3) is written in Task 4, drained in Task 6a, cleared in `resetRun` (Task 3). `BoardOverBudgetError` (Task 5) is thrown by `renderBoard` and caught in Task 6b.

**Config-contract closure (review fix):** the handler's `cfg = deps.config.budgets` reads the board knobs directly because Task 3 adds them to `ControllerConfig['budgets']` AND defaults them in `parseConfig` — one contract across types → parser → handler → `build()`. No task references a config field that another task did not define.

**Deferred (later phases, NOT gaps):** (1) discovery fan-out / `expand`/`page` decisions / `DiscoveryDigest` enumeration / `settle-envelope` / `expanding`/`expanded` states / `chain-outcome` (discovery phase); (2) the §C clean break to capability-tuned planners (planner-restructure phase); (3) the durable `step-start` claim write at dispatch (§F source-3 artifact half) — Phase 2 derives transient `executing`/`awaiting-external` from the bundle's in-flight only, and passes an (always-empty) `claims` array to `reconstructBoard`; the claim WRITE lands with the discovery phase (it needs the fan-out `stepId → {slotId, decisionId}` mapping). The incremental planner stays on `plannerPrivate` and is unchanged.
