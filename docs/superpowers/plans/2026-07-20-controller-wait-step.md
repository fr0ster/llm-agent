# Controller `wait` Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the planner schedule a pause that the controller serves itself — no executor call, no reviewer call, no MCP call, no tokens.

**Architecture:** `Step.type: 'wait'` short-circuits the controller's step loop before evidence recall, tool selection, executor and reviewer. Pure decision logic lives in a small focused module; the handler consumes it. Durable deadline fields on `InFlightStep` make a crash mid-sleep resumable without double-charging.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node ≥ 22, `node:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-20-controller-wait-step-design.md` — read it before Task 1. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- All artifacts in **English**; Conventional Commits.
- Gate before every commit: `npm run build && npm run lint && npm test` — `npm run lint` (`biome check --write`), NOT `npm run format`, because only `check` sorts imports and CI runs `check`.
- Additive changes only: every new field is optional; a plan with no `wait` step must behave byte-identically.
- No new tool names in the engine. Nothing in this work may reference an MCP tool called `wait`.
- Tests use an injected timer/clock — never a real multi-second sleep.
- Branch: `feat/controller-wait-step` (already created, spec already committed).

## File Structure

| File | Responsibility |
|---|---|
| `packages/llm-agent-server-libs/src/smart-agent/controller/wait-step.ts` | **new** — pure logic: path decision, applied duration, remaining sleep. No I/O. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/wait-step.test.ts` | **new** — unit tests for the above. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` | `Step.waitMs`, `InFlightStep.waitStartedAt/appliedWaitMs`, `budgets.waitMsUsed`, config knobs. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts` | `parsePlan` preserves + validates `waitMs`; planner prompt rule. |
| `packages/llm-agent-server-libs/src/pipelines/controller.ts` | `parseConfig` defaults + validation for the two knobs. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts` | dispatch branch at the existing step-start site. |

---

### Task 1: `Step.waitMs` — carried and validated through `parsePlan`

Without this every wait is zero-length: `parsePlan` rebuilds each step from exactly four properties, so an emitted `waitMs` is dropped.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` (the `Step` interface, ~line 16-32)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts:172` (the `steps.push({...})` literal)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

**Interfaces:**
- Produces: `Step.waitMs?: number` — read by Tasks 4 and 5.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/planner.test.ts` (import `parsePlan` the way the existing tests in that file do — if it is not exported, export it):

```ts
test('parsePlan preserves waitMs on a wait step', () => {
  const plan = parsePlan(
    JSON.stringify({
      plan: [
        { name: 'settle', instructions: 'let activation settle',
          type: 'wait', waitMs: 30000 },
      ],
    }),
  );
  assert.equal(plan?.[0].waitMs, 30000);
  assert.equal(plan?.[0].type, 'wait');
});

for (const bad of [undefined, '30000', Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
  test(`parsePlan rejects a wait step with waitMs=${String(bad)}`, () => {
    const plan = parsePlan(
      JSON.stringify({
        plan: [
          { name: 'settle', instructions: 'x', type: 'wait',
            ...(bad === undefined ? {} : { waitMs: bad }) },
        ],
      }),
    );
    assert.equal(plan, null);
  });
}

test('waitMs on a NON-wait step is ignored, step still parses', () => {
  const plan = parsePlan(
    JSON.stringify({
      plan: [{ name: 'read', instructions: 'read X', waitMs: 5 }],
    }),
  );
  assert.equal(plan?.length, 1);
  assert.equal(plan?.[0].waitMs, undefined);
});
```

Note: `Number.POSITIVE_INFINITY` does not survive `JSON.stringify` (it becomes `null`), which still parses as non-numeric — the assertion holds either way.

- [ ] **Step 2: Run and verify they fail**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
```
Expected: the `waitMs` preservation test fails (`undefined !== 30000`); the rejection tests fail (a plan is returned instead of `null`).

- [ ] **Step 3: Add the field**

In `types.ts`, inside `interface Step`, after `type?: string;`:

```ts
  /** Pause duration for a `type: 'wait'` step, served by the controller itself
   *  (no executor, no reviewer, no MCP). Planner-authored values must be a
   *  positive finite integer; see the wait-step spec. Ignored on other types. */
  waitMs?: number;
```

- [ ] **Step 4: Preserve and validate in `parsePlan`**

In `planner.ts`, immediately before `steps.push({`:

```ts
      const isWait = s.type === 'wait';
      const waitMs = (raw as { waitMs?: unknown }).waitMs;
      if (isWait && !isPositiveFiniteInt(waitMs)) return null;
```

Add above `function parsePlan`:

```ts
/** A planner-authored duration: positive, finite, integral. Zero is rejected —
 *  it settles OK while granting no settle time, the same failure mode as a
 *  dropped `waitMs`. */
function isPositiveFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
```

Then extend the pushed literal:

```ts
        ...(isWait ? { waitMs: waitMs as number } : {}),
```

- [ ] **Step 5: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
```
Expected: PASS, and no previously-passing test in that file breaks.

- [ ] **Step 6: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(controller): carry and validate Step.waitMs through parsePlan"
```

---

### Task 2: `maxWaitMs` / `maxTotalWaitMs` config knobs

`parseConfig` is the single place controller budget defaults live; defaulting anywhere else creates a second source of truth and silently ignores YAML overrides.

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` (the config `budgets` block, ~line 192-205)
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts:120` (defaults block)
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts` (create if absent, mirroring a sibling plugin test)

**Interfaces:**
- Produces: `cfg.budgets.maxWaitMs: number`, `cfg.budgets.maxTotalWaitMs: number` — read by Tasks 4 and 5.

- [ ] **Step 1: Write the failing tests**

```ts
const base = {
  subagents: { evaluator: { provider: 'x' }, planner: { provider: 'x' }, executor: { provider: 'x' } },
};

test('parseConfig defaults the wait knobs', () => {
  const cfg = new ControllerPipelinePlugin().parseConfig(base);
  assert.equal(cfg.budgets.maxWaitMs, 600_000);
  assert.equal(cfg.budgets.maxTotalWaitMs, 1_800_000);
});

test('parseConfig honours explicit wait knobs', () => {
  const cfg = new ControllerPipelinePlugin().parseConfig({
    ...base, budgets: { maxWaitMs: 90_000, maxTotalWaitMs: 0 },
  });
  assert.equal(cfg.budgets.maxWaitMs, 90_000);
  assert.equal(cfg.budgets.maxTotalWaitMs, 0);
});

for (const bad of ['600000', Number.NaN, -1, 0, 1.5]) {
  test(`parseConfig throws for maxWaitMs=${String(bad)}`, () => {
    assert.throws(() => new ControllerPipelinePlugin().parseConfig({
      ...base, budgets: { maxWaitMs: bad },
    }), /maxWaitMs/);
  });
}

for (const bad of ['1800000', Number.NaN, -1, 1.5]) {
  test(`parseConfig throws for maxTotalWaitMs=${String(bad)}`, () => {
    assert.throws(() => new ControllerPipelinePlugin().parseConfig({
      ...base, budgets: { maxTotalWaitMs: bad },
    }), /maxTotalWaitMs/);
  });
}
```

- [ ] **Step 2: Run and verify they fail**

```bash
npx tsx --test packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts
```
Expected: FAIL — `undefined !== 600000`, and no throw for bad values.

- [ ] **Step 3: Add the fields to the config type**

In `types.ts`, inside the config `budgets` block:

```ts
    /** Absurdity bound on ONE wait step, ms. Set above the planner's working
     *  range — it is not a policy that overrides the planner's judgement. */
    maxWaitMs?: number;
    /** Cumulative wait budget for the whole run, ms. `0` disables waiting. */
    maxTotalWaitMs?: number;
```

- [ ] **Step 4: Default and validate in `parseConfig`**

In `pipelines/controller.ts`, above the `return {`:

```ts
    const requireInt = (
      key: 'maxWaitMs' | 'maxTotalWaitMs',
      min: number,
    ): void => {
      const v = budgetsRaw[key];
      if (v === undefined) return;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
        throw new Error(
          `controller: 'budgets.${key}' must be a ${min > 0 ? 'positive' : 'non-negative'} finite integer (ms), got ${JSON.stringify(v)}`,
        );
      }
    };
    requireInt('maxWaitMs', 1);
    requireInt('maxTotalWaitMs', 0);
```

Then in the `budgets:` defaults block, alongside `maxSteps: 20`:

```ts
        maxWaitMs: 600_000,
        maxTotalWaitMs: 1_800_000,
```

- [ ] **Step 5: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts
```
Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(controller): add maxWaitMs/maxTotalWaitMs budgets with load-time validation"
```

---

### Task 3: Durable fields for the deadline and the spent budget

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts` (`InFlightStep` ~line 96, `SessionBundle.budgets` ~line 123)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/session-bundle.test.ts` (or the existing bundle round-trip test file)

**Interfaces:**
- Produces: `InFlightStep.waitStartedAt?: number`, `InFlightStep.appliedWaitMs?: number`, `SessionBundle.budgets.waitMsUsed?: number` — read by Tasks 4 and 5.

- [ ] **Step 1: Write the failing test**

```ts
test('bundle round-trips wait deadline fields and waitMsUsed', async () => {
  const backend = makeBackend();               // as the sibling tests build it
  const b = await hydrateBundle(backend, 'sess-wait');
  b.budgets.waitMsUsed = 30_000;
  b.inFlightStep = {
    seq: 1, step: { name: 'w', instructions: 'w', type: 'wait', waitMs: 30_000 },
    attempt: 0, resumeCount: 0, phase: 'executing', transcript: [], toolCallCount: 0,
    waitStartedAt: 1_700_000_000_000, appliedWaitMs: 30_000,
  };
  await persistBundle(backend, 'sess-wait', b);

  const again = await hydrateBundle(backend, 'sess-wait');
  assert.equal(again.budgets.waitMsUsed, 30_000);
  assert.equal(again.inFlightStep?.waitStartedAt, 1_700_000_000_000);
  assert.equal(again.inFlightStep?.appliedWaitMs, 30_000);
});

test('a bundle written without waitMsUsed reads as absent, not NaN', async () => {
  const backend = makeBackend();
  const b = await hydrateBundle(backend, 'sess-legacy');
  await persistBundle(backend, 'sess-legacy', b);
  const again = await hydrateBundle(backend, 'sess-legacy');
  assert.equal(again.budgets.waitMsUsed ?? 0, 0);
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/session-bundle.test.ts
```
Expected: FAIL — TypeScript rejects the unknown properties.

- [ ] **Step 3: Add the fields**

In `types.ts`, inside `interface InFlightStep`:

```ts
  /** Epoch ms when this wait's sleep began. Persisted BEFORE sleeping, with
   *  `appliedWaitMs`, so a crash mid-sleep resumes against a fixed deadline.
   *  Exactly one of the two present is a torn write → control-failure. */
  waitStartedAt?: number;
  /** Post-clamp duration this wait is serving. Never recomputed on resume. */
  appliedWaitMs?: number;
```

In `SessionBundle`, change:

```ts
  budgets: { stepsUsed: number; rewindsUsed: number; waitMsUsed?: number };
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/session-bundle.test.ts
```
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(controller): durable wait deadline fields and per-run wait budget"
```

---

### Task 4: `wait-step.ts` — the decision logic

All arithmetic and branching, with zero I/O, so it is exhaustively testable without a controller.

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/wait-step.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/wait-step.test.ts`

**Interfaces:**
- Consumes: `Step.waitMs` (Task 1), `cfg.budgets.maxWaitMs`/`maxTotalWaitMs` (Task 2), `InFlightStep.waitStartedAt`/`appliedWaitMs` and `budgets.waitMsUsed` (Task 3).
- Produces:
  - `type WaitPlan = { kind: 'fresh'; applied: number; clamped: boolean; cappedSkip: boolean } | { kind: 'resume'; remaining: number; deadlinePassed: boolean } | { kind: 'torn'; missing: 'waitStartedAt' | 'appliedWaitMs' }`
  - `function isWaitStep(step: Step): boolean`
  - `function planWait(args: { step: Step; inFlight: Pick<InFlightStep,'waitStartedAt'|'appliedWaitMs'>; maxWaitMs: number; maxTotalWaitMs: number; waitMsUsed: number; now: number }): WaitPlan`
  - `function sleepUntilAborted(ms: number, signal: AbortSignal | undefined, timer: TimerLike): Promise<'elapsed' | 'aborted'>`
  - `interface TimerLike { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/wait-step.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWaitStep, planWait, sleepUntilAborted } from '../wait-step.js';

const step = (waitMs?: number) =>
  ({ name: 'w', instructions: 'w', type: 'wait', ...(waitMs ? { waitMs } : {}) }) as never;

const call = (o: Partial<Parameters<typeof planWait>[0]>) =>
  planWait({
    step: step(30_000), inFlight: {}, maxWaitMs: 600_000,
    maxTotalWaitMs: 1_800_000, waitMsUsed: 0, now: 1_000_000, ...o,
  });

test('isWaitStep is true only for type wait', () => {
  assert.equal(isWaitStep({ name: 'a', instructions: 'b', type: 'wait' } as never), true);
  assert.equal(isWaitStep({ name: 'a', instructions: 'b' } as never), false);
  assert.equal(isWaitStep({ name: 'a', instructions: 'b', type: 'other' } as never), false);
});

test('fresh: honours a planner duration inside the working range', () => {
  for (const ms of [30_000, 90_000, 120_000, 360_000]) {
    const p = call({ step: step(ms) });
    assert.deepEqual(p, { kind: 'fresh', applied: ms, clamped: false, cappedSkip: false });
  }
});

test('fresh: clamps above maxWaitMs and reports it', () => {
  const p = call({ step: step(3_600_000) });
  assert.deepEqual(p, { kind: 'fresh', applied: 600_000, clamped: true, cappedSkip: false });
});

test('fresh: total cap spent → applied 0, cappedSkip', () => {
  const p = call({ waitMsUsed: 1_800_000 });
  assert.deepEqual(p, { kind: 'fresh', applied: 0, clamped: false, cappedSkip: true });
});

test('fresh: partial remaining cap truncates the wait', () => {
  const p = call({ step: step(30_000), waitMsUsed: 1_790_000 });
  assert.equal(p.kind === 'fresh' && p.applied, 10_000);
});

test('resume: sleeps only the remainder, never recomputes', () => {
  const p = planWait({
    step: step(30_000), inFlight: { waitStartedAt: 1_000_000, appliedWaitMs: 30_000 },
    maxWaitMs: 5_000, maxTotalWaitMs: 0, waitMsUsed: 999_999, now: 1_010_000,
  });
  // maxWaitMs/cap changed since — must NOT move the deadline.
  assert.deepEqual(p, { kind: 'resume', remaining: 20_000, deadlinePassed: false });
});

test('resume: deadline already passed → remaining 0', () => {
  const p = planWait({
    step: step(30_000), inFlight: { waitStartedAt: 1_000_000, appliedWaitMs: 30_000 },
    maxWaitMs: 600_000, maxTotalWaitMs: 1_800_000, waitMsUsed: 30_000, now: 9_000_000,
  });
  assert.deepEqual(p, { kind: 'resume', remaining: 0, deadlinePassed: true });
});

test('torn: exactly one deadline field present, either way round', () => {
  assert.deepEqual(call({ inFlight: { waitStartedAt: 5 } }),
    { kind: 'torn', missing: 'appliedWaitMs' });
  assert.deepEqual(call({ inFlight: { appliedWaitMs: 5 } }),
    { kind: 'torn', missing: 'waitStartedAt' });
});

test('sleepUntilAborted returns aborted immediately on an aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  const fake = { setTimeout: () => 1, clearTimeout: () => {} };
  assert.equal(await sleepUntilAborted(60_000, ac.signal, fake), 'aborted');
});

test('sleepUntilAborted resolves elapsed via the injected timer', async () => {
  const fake = { setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout: () => {} };
  assert.equal(await sleepUntilAborted(60_000, undefined, fake), 'elapsed');
});
```

- [ ] **Step 2: Run and verify they fail**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/wait-step.test.ts
```
Expected: FAIL — `Cannot find module '../wait-step.js'`.

- [ ] **Step 3: Implement the module**

Create `wait-step.ts`:

```ts
import type { InFlightStep, Step } from './types.js';

export interface TimerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type WaitPlan =
  | { kind: 'fresh'; applied: number; clamped: boolean; cappedSkip: boolean }
  | { kind: 'resume'; remaining: number; deadlinePassed: boolean }
  | { kind: 'torn'; missing: 'waitStartedAt' | 'appliedWaitMs' };

/** A wait step is served by the controller itself — never dispatched to the
 *  executor, the reviewer or an MCP client. */
export function isWaitStep(step: Step): boolean {
  return step.type === 'wait';
}

/**
 * Decide how to serve a wait, branching on BOTH deadline fields.
 *
 * Branching on one field alone is the trap: a torn write that persisted
 * `waitStartedAt` but not `appliedWaitMs` would take the fresh path, reset the
 * deadline and charge the budget twice — silently, in exactly the crash case
 * the durable contract exists to survive.
 */
export function planWait(args: {
  step: Step;
  inFlight: Pick<InFlightStep, 'waitStartedAt' | 'appliedWaitMs'>;
  maxWaitMs: number;
  maxTotalWaitMs: number;
  waitMsUsed: number;
  now: number;
}): WaitPlan {
  const { waitStartedAt, appliedWaitMs } = args.inFlight;
  const hasStart = waitStartedAt !== undefined;
  const hasApplied = appliedWaitMs !== undefined;

  if (hasStart !== hasApplied) {
    return { kind: 'torn', missing: hasStart ? 'appliedWaitMs' : 'waitStartedAt' };
  }

  if (hasStart && hasApplied) {
    // Resume: recompute NOTHING. A later clamp or cap change must not move a
    // deadline that was fixed when the wait started.
    const remaining = Math.max(0, waitStartedAt + appliedWaitMs - args.now);
    return { kind: 'resume', remaining, deadlinePassed: remaining === 0 };
  }

  const requested = args.step.waitMs ?? 0;
  const capRemaining = Math.max(0, args.maxTotalWaitMs - args.waitMsUsed);
  const applied = Math.min(requested, args.maxWaitMs, capRemaining);
  return {
    kind: 'fresh',
    applied,
    clamped: applied < requested && applied === args.maxWaitMs,
    cappedSkip: applied < requested && applied === capRemaining,
  };
}

/** Sleep, resolving early when the signal aborts. The timer is injected so
 *  tests never wait in real time. */
export function sleepUntilAborted(
  ms: number,
  signal: AbortSignal | undefined,
  timer: TimerLike,
): Promise<'elapsed' | 'aborted'> {
  if (signal?.aborted) return Promise.resolve('aborted');
  if (ms <= 0) return Promise.resolve('elapsed');
  return new Promise((resolve) => {
    const handle = timer.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('elapsed');
    }, ms);
    function onAbort(): void {
      timer.clearTimeout(handle);
      resolve('aborted');
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/wait-step.test.ts
```
Expected: PASS (11 tests).

- [ ] **Step 5: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(controller): wait-step decision logic (fresh/resume/torn, clamp, cap)"
```

---

### Task 5: Dispatch the wait in the controller step loop

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts:835-846` (the step-start site: `bundle.inFlightStep = {...}` → `persistBundle` → `runStep`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: no new exports.

**Integration note (read before coding):** the existing site already sets `bundle.inFlightStep` and then calls `persistBundle` *before* `runStep`. Set the fresh path's `waitStartedAt` / `appliedWaitMs` / `budgets.waitMsUsed` on those objects **before that existing `persistBundle` call**, so "persist before sleep" costs no extra write and cannot drift from the generic step-start persist.

- [ ] **Step 1: Write the failing tests**

Append to `controller-coordinator-handler.test.ts`, following the `harness({...})` pattern already used there:

```ts
it('serves a wait step with zero executor, reviewer and MCP calls', async () => {
  let executorCalls = 0;
  let reviewerCalls = 0;
  const h = harness({
    evaluator: [{ kind: 'content', content: 'Goal' }],
    planner: [
      { kind: 'content', content: JSON.stringify({
          plan: [{ name: 'settle', instructions: 'let it settle',
                   type: 'wait', waitMs: 30_000 }] }) },
      { kind: 'content', content: 'd' },
    ],
    executor: [{ kind: 'content', content: 'should not be called' }],
  });
  const realExecutor = h.deps.subagents.executor;
  h.deps.subagents.executor = {
    async send(...a: unknown[]) { executorCalls++; return realExecutor.send(...(a as never)); },
  } as never;
  h.deps.reviewer = { async review() { reviewerCalls++; throw new Error('unreachable'); } };

  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);

  assert.equal(executorCalls, 0, 'executor must not be invoked for a wait step');
  assert.equal(reviewerCalls, 0, 'reviewer must not be invoked for a wait step');
});

it('a settled wait consumes one stepsUsed unit', async () => {
  const h = harness({ /* same single wait-step plan as above */ });
  const bundle = await runAndReadBundle(h);       // helper used by sibling tests
  assert.equal(bundle.budgets.stepsUsed, 1);
});

it('a wait charges waitMsUsed and persists the deadline BEFORE sleeping', async () => {
  // Assert on the bundle observed at the first persist after dispatch.
  const persisted: unknown[] = [];
  const h = harness({ /* single wait-step plan */ });
  h.deps.backend = spyBackend(persisted, h.deps.backend);
  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
  const withDeadline = persisted.find(
    (b) => (b as { inFlightStep?: { appliedWaitMs?: number } }).inFlightStep?.appliedWaitMs !== undefined,
  );
  assert.ok(withDeadline, 'deadline must be persisted before the sleep resolves');
});
```

- [ ] **Step 2: Run and verify they fail**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
```
Expected: FAIL — the executor is invoked for the wait step.

- [ ] **Step 3: Implement the dispatch branch**

At the step-start site, after `bundle.inFlightStep = {...}` and BEFORE `await persistBundle(...)`:

```ts
      if (isWaitStep(next.step)) {
        const plan = planWait({
          step: next.step,
          inFlight: bundle.inFlightStep,
          maxWaitMs: cfg.maxWaitMs ?? 600_000,
          maxTotalWaitMs: cfg.maxTotalWaitMs ?? 1_800_000,
          waitMsUsed: bundle.budgets.waitMsUsed ?? 0,
          now: Date.now(),
        });
        if (plan.kind === 'fresh') {
          bundle.budgets.waitMsUsed = (bundle.budgets.waitMsUsed ?? 0) + plan.applied;
          bundle.inFlightStep.waitStartedAt = Date.now();
          bundle.inFlightStep.appliedWaitMs = plan.applied;
        }
        bundle.runPhase = 'executing';
        await persistBundle(deps.backend, sessionId, bundle);   // deadline durable BEFORE sleep

        if (plan.kind === 'torn') {
          await writeControlFailure(`wait deadline half-written: missing ${plan.missing}`);
          continue;                                             // planner replans
        }
        const toSleep =
          plan.kind === 'fresh'
            ? plan.applied
            : plan.remaining;
        const outcome = await sleepUntilAborted(toSleep, ctx.options?.signal, globalThis);
        if (outcome === 'aborted') return true;                 // no artifact, no advance
        await settleWait(bundle, next.step, plan);              // one of the four settling cases
        continue;
      }
```

Import `isWaitStep`, `planWait`, `sleepUntilAborted` from `./wait-step.js`.

`settleWait` writes the step-result through the same `writeArtifact` shape the
controller already uses, then increments `stepsUsed` and advances the cursor —
mirroring what `settle('advanced', …)` does for an executed step:

```ts
      const settleWait = async (plan: WaitPlan): Promise<void> => {
        const text =
          plan.kind === 'resume'
            ? plan.deadlinePassed
              ? `Wait deadline had already elapsed during the outage; no additional sleep was performed.`
              : `Waited the remaining ${plan.remaining} ms of the scheduled pause.`
            : plan.cappedSkip
              ? `No wait performed: the run's total wait budget is spent.`
              : plan.clamped
                ? `Waited ${plan.applied} ms (requested ${next.step.waitMs} ms, clamped to maxWaitMs).`
                : `Waited ${plan.applied} ms for the system to settle.`;
        const note =
          plan.kind === 'resume' && plan.deadlinePassed
            ? 'resumed after deadline'
            : plan.kind === 'fresh' && plan.cappedSkip
              ? 'total wait budget spent'
              : plan.kind === 'fresh' && plan.clamped
                ? 'clamped to maxWaitMs'
                : '';
        bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
        await writeArtifact(
          rag,
          {
            ...meta,
            artifactType: 'step-result',
            task: next.step.name,
            runId: bundle.runId,
            seq: bundle.inFlightStep.seq,
            attempt: bundle.inFlightStep.attempt,
            status: 'ok',
            note,
            remainder: '',
            stepId: next.step.stepId,
            digest: text.slice(0, cfg.maxDigestChars ?? 500),
            writeOrdinal: bundle.writeOrdinal,
            content: text,
          },
          ctx.options,
        );
        bundle.budgets.stepsUsed++;
        bundle.inFlightStep = undefined;
        bundle.planCursor = (bundle.planCursor ?? 0) + 1;
        await persistBundle(deps.backend, sessionId, bundle);
      };
```

`content` is never empty — an empty-content `ok` risks being carried into
approved content and surfacing as a blank executed step in the final answer.

- [ ] **Step 4: Write the remaining case tests**

Still in `controller-coordinator-handler.test.ts` — one per outcome the spec
pins:

```ts
it('clamped wait records the requested and the applied duration', async () => {
  const h = harness({ /* plan with waitMs: 3_600_000, cfg.maxWaitMs 600_000 */ });
  const art = await runAndReadStepResult(h);
  assert.equal(art.metadata.status, 'ok');
  assert.match(art.content, /600000/);
  assert.match(art.metadata.note, /clamp/i);
});

it('total cap spent → wait is skipped without sleeping', async () => {
  const h = harness({ /* plan with one wait; cfg.maxTotalWaitMs: 0 */ });
  const art = await runAndReadStepResult(h);
  assert.match(art.content, /No wait performed/);
  assert.match(art.metadata.note, /budget spent/i);
});

it('resumed after an elapsed deadline settles without sleeping again', async () => {
  const h = harness({ /* bundle pre-seeded: inFlightStep with a wait step,
                          waitStartedAt far in the past, appliedWaitMs 30_000 */ });
  const art = await runAndReadStepResult(h);
  assert.match(art.content, /already elapsed/);
  assert.match(art.metadata.note, /resumed after deadline/);
});

it('a torn deadline yields a control-failure and a replan, not a sleep', async () => {
  const h = harness({ /* bundle pre-seeded: waitStartedAt set, appliedWaitMs absent */ });
  const art = await runAndReadStepResult(h);
  assert.equal(art.metadata.status, 'failed');
  assert.match(art.metadata.note, /half-written|missing appliedWaitMs/i);
});

it('an abort mid-wait writes no artifact, does not advance, keeps the deadline', async () => {
  const ac = new AbortController();
  const h = harness({ /* single wait step, waitMs 60_000 */ });
  const p = new ControllerCoordinatorHandler(h.deps)
    .execute(fakeCtx({ signal: ac.signal }).ctx, {}, undefined);
  ac.abort();
  await p;
  const bundle = await hydrateBundle(h.deps.backend, 'sess-1');
  assert.equal(bundle.budgets.stepsUsed, 0, 'must not advance');
  assert.ok(bundle.inFlightStep?.appliedWaitMs, 'deadline stays persisted');
  assert.equal(bundle.budgets.waitMsUsed, 60_000, 'charged once, not refunded');
});

it('a resumed wait does not re-charge waitMsUsed', async () => {
  const h = harness({ /* pre-seeded in-flight wait, waitMsUsed already 60_000 */ });
  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
  const bundle = await hydrateBundle(h.deps.backend, 'sess-1');
  assert.equal(bundle.budgets.waitMsUsed, 60_000);
});

it('a plan with no wait step behaves exactly as before', async () => {
  // The existing suites cover this; assert explicitly that a normal plan still
  // reaches the executor once.
});
```

`runAndReadStepResult` reads the single `step-result` artifact the run wrote —
build it from the `rag.list({ runId, artifactType: 'step-result' })` calls the
sibling tests already make, rather than inventing a new fixture.

- [ ] **Step 5: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts
```
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(controller): serve wait steps in the step loop, no executor or reviewer"
```

---

### Task 6: Teach the planner to schedule waits, and document it

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts` (the plan-creation system prompt)
- Modify: `docs/EXAMPLES.md` (a wait-bearing plan snippet), `docs/TROUBLESHOOTING.md` (the request-timeout consequence)
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('the plan-creation prompt teaches the wait step', async () => {
  const seen: Message[][] = [];
  const client = { async send(m: Message[]) { seen.push(m); return { ok: true, value: { content: '{"plan":[]}' } }; } };
  await new LlmPlanner(client as never).next(/* as sibling tests call it */);
  const sys = seen[0].find((m) => m.role === 'system')?.content ?? '';
  assert.match(sys, /type.*wait/i);
  assert.match(sys, /waitMs/);
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
```
Expected: FAIL — the prompt does not mention `wait`.

- [ ] **Step 3: Extend the prompt**

Append to the plan-creation system prompt:

```
When a step creates or activates an object that a LATER step consumes, insert a
step {"name":...,"instructions":...,"type":"wait","waitMs":<ms>} between them,
so the system has time to settle. Choose waitMs from the operation: a short
settle is ~30000, a slow activation ~120000 or more. waitMs MUST be a positive
whole number of milliseconds. A wait step needs no "requires".
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
```
Expected: PASS.

- [ ] **Step 5: Document the operator consequence**

In `docs/TROUBLESHOOTING.md`, add a short subsection: a wait blocks the request, so `maxWaitMs` above the deployment's client/proxy/load-balancer request timeout will surface as a client-side timeout rather than a completed plan; raise the request timeout together with the knob. Note that a client disconnect does not currently cancel an in-flight wait.

- [ ] **Step 6: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(controller): teach the planner to schedule waits; document the timeout consequence"
```

---

## Done criteria

Every checklist line in the spec's Testing section has a passing test, `npm test` is green across the workspace, and a plan containing no `wait` step produces byte-identical behaviour to `main`.

Delete this plan file and the spec file once merged — `CLAUDE.md` keeps only in-progress plans and specs in the tree.
