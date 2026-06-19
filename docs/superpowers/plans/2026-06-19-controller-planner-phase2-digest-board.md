# Controller Planner — Phase 2: Live Digest Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the step-state digest board LIVE for the plan-first (adaptive) controller path — every plan step gets a stable `stepId` at creation, each create/replan is persisted as a `plan-decision` artifact, the reviewer returns a planning `digest`, the controller persists `stepId`+`digest` on each `step-result`, and the rendered board (with a bounded, deterministic compaction budget) replaces the payload-free `plannerPrivate` blob in the planner's prompts.

**Architecture:** Phase 1 already added the READ side — `reconstructBoard` (board.ts) reads `metadata.stepId`/`metadata.digest` off `step-result` entries and merges `plan-decision` structure + claims + in-flight into a `Map<stepId, BoardEntry>`; `writePlanDecision`/`readPlanDecisions`/`deterministicId` (artifacts.ts) persist/read decisions; `projectStepState` (outcome.ts) projects status→board state. Phase 2 wires the WRITE side and the planner integration: (1) the adaptive planner mints `stepId`s and records `PlanDecision`s onto the bundle when it (re)builds `bundle.plan`; (2) the handler drains+persists those decisions before dispatch; (3) the reviewer's `ReviewOutcome` carries a `digest`, validated by `parseReview`; (4) the handler writes `stepId`+`digest` on the `step-result`; (5) a new pure `renderBoard` turns the reconstructed board into a bounded text block; (6) the handler reconstructs+renders the board each turn and passes it to the planner via `PlannerNextInput.boardText`, which the planner prompts use in place of `plannerPrivate` (graceful fallback to `plannerPrivate` when the board is empty — this is how the legacy `IncrementalPlanner`, which writes no decisions, keeps working unchanged).

**Tech Stack:** TypeScript (ESM, strict), Node ≥22 `node:test` (co-located `__tests__/*.test.ts`, run via `npm run -w @mcp-abap-adt/llm-agent-server-libs test`), Biome lint/format. Package: `@mcp-abap-adt/llm-agent-server-libs`, directory `src/smart-agent/controller/`.

**Out of scope (later phases — do NOT implement here):** the §D deferred-expansion / discovery fan-out (`expand`/`page` decisions, `DiscoveryDigest` enumeration, `settle-envelope` secret store, `expanding`/`expanded` board states, `chain-outcome`), and the §C clean break to two capability-tuned planners. Phase 2 keeps the existing `IncrementalPlanner`/`AdaptivePlanner` and wires the live board into the adaptive (plan-first) path only. `ReviewOutcome` defines `digest` now; the optional `enumeration` field is added in the discovery phase.

---

## File Structure

| File | Phase-2 responsibility |
|------|------------------------|
| `src/smart-agent/controller/artifacts.ts` | ADD pure `mintCreateStepIds` / `mintReplanStepIds` (deterministic stepId minting at plan creation). |
| `src/smart-agent/controller/outcome.ts` | ADD `ReviewOutcome = Outcome & { digest: string }`. |
| `src/smart-agent/controller/reviewer.ts` | `ReviewResult.outcome` becomes `ReviewOutcome`; `REVIEWER_SYSTEM` asks for `digest`; `parseReview` validates+bounds `digest` (threaded `maxDigestChars`); `ReviewOpts` gains `maxDigestChars`. |
| `src/smart-agent/controller/board.ts` | ADD pure `renderBoard(board, budget)` + `BoardBudget` type + `validateBoardBudget(budget)` (load-time fail-loud invariant). |
| `src/smart-agent/controller/types.ts` | `PlannerNextInput` gains `boardText?`; `SessionBundle` gains `pendingPlanDecisions?: PlanDecision[]`. |
| `src/smart-agent/controller/planner.ts` | `AdaptivePlanner` mints stepIds + records `PlanDecision`s onto the bundle when it (re)builds `bundle.plan`; the three prompt sites use `boardText` with `plannerPrivate` fallback. |
| `src/smart-agent/controller/controller-coordinator-handler.ts` | Drain+persist `bundle.pendingPlanDecisions` after `planner.next()`; reconstruct+render the board and pass `boardText` into `planner.next()`; write `stepId`+`digest` on the `step-result`; thread `maxDigestChars` into the reviewer and the default-reviewer/coerced paths. |

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

## Task 3: Bundle + planner-input fields for decisions and board text (types.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`

The adaptive planner records the `PlanDecision`s it produces this turn onto the bundle (the controller drains+persists them — preserving the "planner constructs, controller persists" boundary). The handler passes the rendered board into the planner via `PlannerNextInput.boardText`. No behavior yet — just the fields the next tasks fill.

- [ ] **Step 1: Add `pendingPlanDecisions` to `SessionBundle`**

Add to the `SessionBundle` interface (near `plan?`/`planCursor?`):

```ts
  /** Plan decisions the planner produced this turn (create/replan), NOT yet
   *  persisted. The controller drains + `writePlanDecision`s them after
   *  `planner.next()` returns and BEFORE dispatch (§A: planner constructs, controller
   *  persists; §F: every decision is a durable artifact). Cleared once drained. */
  pendingPlanDecisions?: PlanDecision[];
```

Add the import at the top of `types.ts` (alongside the existing imports):

```ts
import type { PlanDecision } from './artifacts.js';
```

> If this introduces an import cycle (`artifacts.ts` imports `Step` from `types.ts`), use a type-only import — `import type` does not emit a runtime require, so the ESM cycle is harmless. Confirm `npm run -w @mcp-abap-adt/llm-agent-server-libs build` stays green at Step 3.

- [ ] **Step 2: Add `boardText` to `PlannerNextInput`**

Add to the `PlannerNextInput` interface:

```ts
  /** The rendered step-state digest board (§B), reconstructed by the controller
   *  from artifacts before each call. When present + non-empty it REPLACES the
   *  legacy `plannerPrivate` blob in the planner prompt; empty/absent → the planner
   *  falls back to `plannerPrivate` (so the decision-less IncrementalPlanner is
   *  unchanged). */
  boardText?: string;
```

- [ ] **Step 3: Build to verify the types compile**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Expected: success (no emit errors).

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts
git commit -m "feat(controller): bundle.pendingPlanDecisions + PlannerNextInput.boardText (Phase 2)"
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

/** Validate the board budget at load (§B fail-loud invariant): the worst-case
 *  actionable block + the kept digests + headroom must fit `maxBoardChars`.
 *  A fixed per-line overhead (~24 chars: `[`, stepId8, space, state, `] `, newline)
 *  is folded into the estimate. */
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
  return text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="renderBoard|validateBoardBudget"`
Expected: PASS (7 tests).

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

Add imports near the top of the handler:
```ts
import { writePlanDecision } from './artifacts.js';
import { reconstructBoard, renderBoard, type BoardBudget } from './board.js';
import { readPlanDecisions, readClaims } from './artifacts.js';
```
(Merge with the existing `./artifacts.js` import if one already exists.)

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

Define the board budget once near the handler's config resolution (use config values when present, else defaults that satisfy `validateBoardBudget`):

```ts
    const boardBudget: BoardBudget = {
      maxDigestChars: cfg.maxDigestChars ?? 500,
      maxIntentChars: cfg.maxIntentChars ?? 120,
      maxActiveSteps: cfg.maxActiveSteps ?? 16,
      maxIntentChars: cfg.maxIntentChars ?? 120,
      maxBoardChars: cfg.maxBoardChars ?? 12000,
      keepRecentDigests: cfg.keepRecentDigests ?? 8,
    };
```
(Remove the duplicated `maxIntentChars` key — shown twice above by mistake; include it ONCE.)

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

Then, right BEFORE the `planner.next({...})` call, compute the board text and pass it:

```ts
      const boardText = await renderLiveBoard(rag, bundle, boardBudget);
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

- [ ] **Step 4: Build + run the handler tests**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Expected: success.
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="plan-decision|stepId \+ digest"`
Expected: PASS (2 tests).

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

Swap the payload-free `Progress:${bundle.plannerPrivate}` blob for the rendered board, with a graceful fallback to `plannerPrivate` when the board is empty (the decision-less `IncrementalPlanner` thus keeps its exact legacy prompt).

- [ ] **Step 1: Write the failing test**

Add to `planner.test.ts`:

```ts
test('AdaptivePlanner prompt carries boardText when present', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]); // captures the messages it was sent
  const planner = new AdaptivePlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '\n[seq 0 a ok]' });
  await planner.next({
    bundle,
    prompt: 'g',
    retrying: false,
    boardText: '[step1aaa done] includes A,B',
  });
  const userMsg = client.lastUserContent();
  assert.match(userMsg, /includes A,B/); // board used
  assert.doesNotMatch(userMsg, /\[seq 0 a ok\]/); // legacy blob NOT used
});

test('AdaptivePlanner prompt falls back to plannerPrivate when boardText empty', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner = new AdaptivePlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '\n[seq 0 a ok]' });
  await planner.next({ bundle, prompt: 'g', retrying: false, boardText: '' });
  assert.match(client.lastUserContent(), /\[seq 0 a ok\]/); // fallback to legacy blob
});
```

> Reuse / extend the file's existing fake client so it records the last `send(messages)` and exposes the last user-role content. If the harness lacks a recorder, add a tiny one in the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="prompt carries boardText|falls back to plannerPrivate"`
Expected: FAIL — prompt still uses `plannerPrivate` unconditionally.

- [ ] **Step 3: Implement the swap**

Add a module-level helper in `planner.ts` (after `withSkillsBlock`):

```ts
/** The planner's progress context: the rendered digest board when present,
 *  else the legacy plannerPrivate blob (so a decision-less planner is unchanged). */
function progressBlock(bundle: SessionBundle, boardText?: string): string {
  return boardText && boardText.length > 0 ? boardText : bundle.plannerPrivate;
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

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="prompt carries boardText|falls back to plannerPrivate"`
Expected: PASS (2 tests). Then the full planner suite:
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="Planner|planner"`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): planner prompts consume the rendered board (plannerPrivate fallback) (Phase 2)"
```

---

## Task 8: Validate the board budget at composition (factory) + green gate

**Files:**
- Modify: the controller factory that resolves controller config (search `src/factories/` for where `maxRetries`/`maxReviewRetries` are read — the same place resolves the new board knobs).
- Test: `packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts`

Per §B the board-budget invariant is validated AT LOAD (fail-loud), not per-turn. Call `validateBoardBudget` once during factory composition so a mis-sized config aborts startup with a clear message rather than degrading a planner prompt.

- [ ] **Step 1: Locate the config-resolution site**

Run: `grep -rn "maxReviewRetries\|maxRetries" packages/llm-agent-server-libs/src/factories/`
Read the resolution there. The new knobs (`maxDigestChars`, `maxIntentChars`, `maxActiveSteps`, `maxBoardChars`, `keepRecentDigests`) are optional config with the same defaults used in Task 6's `boardBudget`.

- [ ] **Step 2: Write the failing test**

Add to `controller-factory.test.ts`:

```ts
test('controller factory rejects a board budget that cannot fit', async () => {
  await assert.rejects(
    () => buildControllerFromConfig({ /* minimal valid config */,
      controller: { maxBoardChars: 50, maxActiveSteps: 16, maxIntentChars: 120 },
    }),
    /maxBoardChars/,
  );
});
```

> Match the actual factory entry-point name + config shape used by the other tests in this file. If the factory does not currently surface these knobs, the test asserts that a clearly-too-small `maxBoardChars` aborts composition.

- [ ] **Step 3: Wire `validateBoardBudget` into the factory**

In the factory, after resolving the controller config, build the same `BoardBudget` literal as Task 6 (with defaults) and call:
```ts
import { validateBoardBudget } from '../smart-agent/controller/board.js';
// ...
validateBoardBudget(boardBudget);
```
Resolve the budget once and pass it through to the handler (so the handler does not re-build it ad hoc — thread it via the controller deps/config). If threading is too invasive for Phase 2, keep the handler's local default budget AND validate the same literal in the factory; the defaults are identical so the invariant holds.

- [ ] **Step 4: Run the factory test**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="board budget"`
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
git add packages/llm-agent-server-libs/src/factories/ \
        packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.test.ts
git commit -m "feat(controller): validate board budget at composition (fail-loud) (Phase 2)"
```

---

## Self-Review

**Spec coverage (§A, §B, §E, §F — Phase-2 slice):**
- §A two representations / reviewer returns digest, controller persists → Task 2 (`ReviewOutcome`, `parseReview`) + Task 6c (controller writes `digest` to `step-result`). ✓
- §A migration contract (digest required, bounded, malformed → judge-failure) → Task 2. ✓ (`enumeration` explicitly deferred to discovery phase.)
- §B digest board replaces the blob → Task 7. ✓
- §B budget / deterministic compaction / GUARANTEED cap → Task 5 (`renderBoard`). ✓
- §B `maxIntentChars` REQUIRED + actionable never aggregated → Task 5 (actionable rendered individually, intent bounded). ✓
- §B config invariant fail-loud at load → Task 5 (`validateBoardBudget`) + Task 8 (called at composition). ✓
- §E step-state vocabulary → already in Phase-1 `board.ts`; Task 5 renders the Phase-2 subset (terminal vs actionable); `expanding`/`expanded` deferred. ✓ (explicit scope note)
- §F stepId at creation, retry vs replan identity (`supersedesStepId`) → Task 1 + Task 4. ✓
- §F every decision is a durable artifact (create/replan) → Task 4 (record) + Task 6a (persist). ✓ (`expand`/`page` deferred)
- §F step-result carries digest so the board is artifact-reconstructible → Task 6c. ✓

**Placeholder scan:** Every code step shows the actual code. Two deliberate "match the file's harness" notes (Task 4/6/7/8 tests) point at reusing the EXISTING test fixtures rather than re-inventing them — the test bodies are given; only the fixture wiring is delegated to the existing file conventions. No "TBD"/"add error handling"/"similar to" placeholders.

**Type consistency:** `ReviewOutcome` (Task 2) = `Outcome & {digest}`; `ReviewResult.outcome` uses it (Task 2); the handler's `outcome` variable is therefore `ReviewOutcome` and `outcome.digest` is valid (Task 6c); the default-reviewer branch constructs a `ReviewOutcome` (Task 6c). `BoardBudget` fields are identical between `renderBoard`/`validateBoardBudget` (Task 5), the handler's local budget (Task 6b), and the factory (Task 8). `mintCreateStepIds`/`mintReplanStepIds` return `Step[]` consumed by `bundle.plan` and `PlanDecision.steps`. `PlannerNextInput.boardText` (Task 3) is read in Task 7. `bundle.pendingPlanDecisions: PlanDecision[]` (Task 3) is written in Task 4 and drained in Task 6a.

**Known fix to apply during execution:** Task 6b's `boardBudget` literal lists `maxIntentChars` twice — include it ONCE (noted inline).

**Deferred (later phases, NOT gaps):** discovery fan-out / `expand`/`page` decisions / `DiscoveryDigest` enumeration / `settle-envelope` / `expanding`/`expanded` states / `chain-outcome` (discovery phase); the §C clean break to capability-tuned planners (planner-restructure phase). The incremental planner stays on `plannerPrivate` and is unchanged.
