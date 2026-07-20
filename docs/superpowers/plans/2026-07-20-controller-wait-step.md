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
- Tests inject an `IWaitStrategy` — never a real multi-second sleep. The controller must never construct a timer inline.
- Branch: `feat/controller-wait-step` (already created, spec already committed).

## File Structure

| File | Responsibility |
|---|---|
| `packages/llm-agent/src/interfaces/wait-strategy.ts` | **new** — `IWaitStrategy` + `DefaultWaitStrategy`. The consumer-swappable mechanism. |
| `packages/llm-agent-server-libs/src/smart-agent/controller/wait-step.ts` | **new** — pure logic: path decision, applied duration, remaining sleep. No I/O, no timer. |
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

### Task 4a: `IWaitStrategy` — the consumer-swappable wait mechanism

The engine decides whether and how long to wait; HOW the waiting happens is the
consumer's variation point, so it is a strategy (principle 5), injected exactly
like the controller's existing `deps.stepExecutionControl ?? new DefaultStepExecutionControl()`
(`handler:906`). Testability follows for free — suites inject a strategy that
returns immediately instead of sleeping.

**Files:**
- Create: `packages/llm-agent/src/interfaces/wait-strategy.ts`
- Modify: `packages/llm-agent/src/index.ts` (export it the way sibling interfaces are exported)
- Test: `packages/llm-agent/src/interfaces/__tests__/wait-strategy.test.ts`

**Interfaces:**
- Produces: `IWaitStrategy`, `DefaultWaitStrategy` — consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultWaitStrategy } from '../wait-strategy.js';

test('DefaultWaitStrategy resolves elapsed after the delay', async () => {
  const t0 = Date.now();
  assert.equal(await new DefaultWaitStrategy().wait(20), 'elapsed');
  assert.ok(Date.now() - t0 >= 15);
});

test('DefaultWaitStrategy returns aborted immediately for an already-aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  assert.equal(await new DefaultWaitStrategy().wait(60_000, ac.signal), 'aborted');
  assert.ok(Date.now() - t0 < 100, 'must not wait out the duration');
});

test('DefaultWaitStrategy resolves aborted when the signal fires mid-wait', async () => {
  const ac = new AbortController();
  const p = new DefaultWaitStrategy().wait(60_000, ac.signal);
  ac.abort();
  assert.equal(await p, 'aborted');
});

test('DefaultWaitStrategy treats a non-positive duration as elapsed', async () => {
  assert.equal(await new DefaultWaitStrategy().wait(0), 'elapsed');
});
```

- [ ] **Step 2: Run and verify they fail**

```bash
npx tsx --test packages/llm-agent/src/interfaces/__tests__/wait-strategy.test.ts
```
Expected: FAIL — `Cannot find module '../wait-strategy.js'`.

- [ ] **Step 3: Implement**

```ts
/**
 * How a controller `wait` step is actually served.
 *
 * The engine owns WHETHER to wait and FOR HOW LONG (planner duration, engine
 * clamps). This interface owns only the MECHANISM, so a consumer can replace a
 * blocking sleep with something their deployment prefers — suspending and
 * resuming the run instead of holding an HTTP connection for minutes, adding
 * jitter, or yielding to their own scheduler — without forking the controller.
 */
export interface IWaitStrategy {
  readonly name: string;
  /** Wait `ms`, resolving early with 'aborted' if `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'>;
}

/** Plain timer. Honouring `signal` is part of the contract, not an extra. */
export class DefaultWaitStrategy implements IWaitStrategy {
  readonly name = 'default-wait';

  wait(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (ms <= 0) return Promise.resolve('elapsed');
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(handle);
        resolve('aborted');
      };
      const handle = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve('elapsed');
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test packages/llm-agent/src/interfaces/__tests__/wait-strategy.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Full gate and commit**

```bash
npm run build && npm run lint && npm test
git add -A
git commit -m "feat(agent): add IWaitStrategy — consumer-swappable wait mechanism"
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
  - (the sleeping itself lives in `IWaitStrategy`, Task 4a — `wait-step.ts` stays pure)

- [ ] **Step 1: Write the failing tests**

Create `__tests__/wait-step.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWait, isWaitStep, planWait } from '../wait-step.js';

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

test('fresh: partial remaining cap truncates but is NOT a skip', () => {
  const p = call({ step: step(30_000), waitMsUsed: 1_790_000 });
  assert.deepEqual(p, { kind: 'fresh', applied: 10_000, clamped: true, cappedSkip: false });
});

test('fresh: cap fully spent is a skip, not a clamp', () => {
  const p = call({ step: step(30_000), waitMsUsed: 1_800_000 });
  assert.deepEqual(p, { kind: 'fresh', applied: 0, clamped: false, cappedSkip: true });
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
    // Truncated by EITHER bound, but still sleeping. `clamped` says "shorter
    // than asked", it does not say which bound won.
    clamped: applied > 0 && applied < requested,
    // Only a TRUE skip: no sleep at all. A partial truncation by the cap is a
    // clamp, not a skip — reporting "no wait performed" while sleeping 10 s
    // would be a false artifact.
    cappedSkip: applied === 0 && requested > 0,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/wait-step.test.ts
```
Expected: PASS (8 tests).

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

**Integration note (read before coding) — THERE ARE TWO CALL SITES.**

The controller reaches `runStep` from two places, and a wait must be
intercepted at BOTH:

| site | line | condition |
|---|---|---|
| fresh dispatch | `handler:835-846` | `next.kind === 'next'` — sets `inFlightStep`, persists, calls `runStep(next.step)` |
| crash-replay / continuation resume | `handler:636-659` | an existing `inf.phase === 'executing'` with no artifact — calls `runStep(inf.step)` directly |

Wiring only the fresh site is the trap: a resumed wait would go to the
executor and reviewer, breaking the deliverable's core promise and making the
entire deadline contract unreachable — the resume path is precisely where that
contract matters.

So the branch is extracted as ONE private method, `serveWaitStep(...)`, called
from both sites — but at DIFFERENT points in each, see the placement table
below. The fresh site takes it just before `runStep`; the resume site must take
it earlier, before that path's `resumeCount` accounting.

`serveWaitStep` also OWNS its artifact writes. Do not call `writeControlFailure`
from these sites: that helper is local to `runStep` (`handler:1156`) and is not
in scope here. `serveWaitStep` writes both the settling artifact and the
torn-write control-failure itself, using the same `writeArtifact` metadata
shape.

Clock: capture `const waitNow = Date.parse(now())` ONCE per invocation and use
that single value for both `planWait({ now: waitNow })` and
`waitStartedAt = waitNow`. `deps.now` (`handler:221`) returns an ISO string, so
it must be parsed to epoch ms. Two separate `Date.now()` reads would skew the
deadline and defeat clock injection in tests.

**Placement and persist ordering — the two sites are NOT symmetric.** Say it
once, here, so the per-site instructions below cannot drift from it:

| site | insert `serveWaitStep` | why there |
|---|---|---|
| fresh (`handler:835-846`) | AFTER the existing `persistBundle`, before `runStep` | the in-flight step must already exist and be durable |
| resume (`handler:636-659`) | BEFORE the `resumeCount` accounting AND before that path's `persistBundle` | a wait remainder must not be charged as a crash replay (see call site B) |

In both cases the fresh path inside `serveWaitStep` does its OWN
`persistBundle` before sleeping — one extra write, on wait steps only.

An earlier draft said "after the existing persist at each site". That is wrong
for the resume site: its `persistBundle` sits *after* the `resumeCount`
increment and the `maxStepResumes` terminal abort, so obeying it would
reintroduce the bug where repeated abort/resume of a long wait kills the run.
Symmetry is the wrong goal here — the two sites guard different things.

- [ ] **Step 1: Write the failing tests**

Append to `controller-coordinator-handler.test.ts`, following the `harness({...})` pattern already used there:

```ts
**Every Task 5 test injects a wait strategy** so nothing sleeps in real time:

```ts
const instantWaiter = (slept: number[] = []) => ({
  name: 'test-instant',
  async wait(ms: number) { slept.push(ms); return 'elapsed' as const; },
});
// h.deps.waitStrategy = instantWaiter(slept);   // then assert on `slept`
```

`slept` also lets a test assert the DURATION the controller decided on, which
is stronger than asserting elapsed wall-clock and costs nothing.

it('serves a RESUMED wait without the executor — the crash-replay path', async () => {
  // Guards the second call site: a bundle already carrying an in-flight wait
  // must be served by the controller, not handed to runStep.
  let executorCalls = 0;
  const h = harness({ /* pre-seeded bundle: inFlightStep = a wait step,
                         phase 'executing', waitStartedAt far in the past,
                         appliedWaitMs 30_000, no artifact for this attempt */ });
  const realExecutor = h.deps.subagents.executor;
  h.deps.subagents.executor = {
    async send(...a: unknown[]) { executorCalls++; return realExecutor.send(...(a as never)); },
  } as never;

  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
  assert.equal(executorCalls, 0, 'a resumed wait must not reach the executor');
});

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

it('a settled wait leaves the bundle exactly as an executed step would', async () => {
  // Guards settle parity: lastOutcome, the planner cursor (onCommit), nextSeq,
  // runPhase and the board entry — not just stepsUsed.
  const commits: string[] = [];
  const h = harness({ /* single wait-step plan */ });
  h.deps.planner = { ...h.deps.planner, commit: (_b, o) => commits.push(o) } as never;

  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
  const bundle = await hydrateBundle(h.deps.backend, 'sess-1');

  assert.equal(bundle.lastOutcome, 'advanced');
  assert.deepEqual(commits, ['advanced'], 'planner cursor must advance via onCommit');
  assert.equal(bundle.nextSeq, 1);
  assert.equal(bundle.inFlightStep, undefined);
  assert.equal(bundle.runPhase, 'planning');
  assert.ok(
    boardOf(bundle).some((e) => e.name === 'settle'),
    'the wait must appear on the board (recordStepControl)',
  );
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

**First, extract the settle logic so the wait path cannot drift from it.**
`runStep`'s local `settle` (`handler:946`) does more than the obvious: it sets
`bundle.lastOutcome`, calls `onCommit?.(outcome)` — which is how the PLANNER's
cursor advances — moves `nextSeq` (not `planCursor`), sets `runPhase`, and
persists all of it in ONE write. A hand-rolled equivalent in the wait branch
would silently leave the bundle in a state that does not match a completed
step, and the planner's cursor would never move.

Lift that body into a module-level function in `wait-step.ts`'s sibling — or a
private handler method — and have BOTH `runStep`'s local `settle` and
`serveWaitStep` call it. Note the backend type: `persistBundle` takes a
`KnowledgeBackend` imported from `@mcp-abap-adt/llm-agent-libs`
(`session-bundle.ts:1,26`) — there is no `IBackend` in this codebase:

```ts
export async function settleStep(
  backend: KnowledgeBackend, sessionId: string, bundle: SessionBundle,
  outcome: 'advanced' | 'failed' | 'partial',
  onCommit?: (o: 'advanced' | 'failed' | 'partial') => void,
): Promise<'advanced' | 'failed' | 'partial'> {
  bundle.lastOutcome = outcome;
  onCommit?.(outcome);
  if (outcome === 'advanced' || outcome === 'partial') {
    bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
    bundle.inFlightStep = undefined;
    bundle.runPhase = 'planning';
  } else {
    if (bundle.inFlightStep) bundle.inFlightStep.phase = 'awaiting-replan';
    bundle.runPhase = 'executing';
  }
  await persistBundle(backend, sessionId, bundle);
  return outcome;
}
```

The return type is NOT cosmetic: `runStep` consumes the value directly with
`return settle(mapped)` (`handler:1321`), so a `Promise<void>` helper would
either break the build or force a wrapper — defeating the point of extracting
it. Keep the signature identical to today's local `settle`.

Replace `runStep`'s local `settle` body with a call to it, so the two can never
diverge. Its existing tests must stay green — that is the proof the extraction
is behaviour-preserving.

The wait path must also mirror the advanced path's other two steps, which
happen BEFORE settle (`handler:1312-1320`): `bundle.budgets.stepsUsed++` and
`recordStepControl(...)`. `recordStepControl` is the board projection — omit it
and the wait step never appears on the board, contradicting the spec's
legibility rule.

Then add the private method on the handler and call it from both sites.

```ts
  /** Serve a `type: 'wait'` step: the controller waits itself — no executor,
   *  no reviewer, no MCP. Returns 'served' when the step settled and the loop
   *  should continue, 'aborted' when the caller cancelled (no artifact, no
   *  advance), or 'not-a-wait' so the caller falls through to runStep. */
  private async serveWaitStep(args: {
    ctx: PipelineContext; sessionId: string; bundle: SessionBundle;
    rag: IKnowledgeRagHandle; meta: KnowledgeEntryMetadata; step: Step;
    cfg: ControllerConfig['budgets']; nowIso: () => string;
    onCommit?: (o: 'advanced' | 'failed' | 'partial') => void;
  }): Promise<'served' | 'aborted' | 'not-a-wait'> {
    const { bundle, step, cfg } = args;
    if (!isWaitStep(step) || !bundle.inFlightStep) return 'not-a-wait';

    const waitNow = Date.parse(args.nowIso());
    const plan = planWait({
      step,
      inFlight: bundle.inFlightStep,
      maxWaitMs: cfg.maxWaitMs ?? 600_000,
      maxTotalWaitMs: cfg.maxTotalWaitMs ?? 1_800_000,
      waitMsUsed: bundle.budgets.waitMsUsed ?? 0,
      now: waitNow,
    });

    if (plan.kind === 'fresh') {
      bundle.budgets.waitMsUsed = (bundle.budgets.waitMsUsed ?? 0) + plan.applied;
      bundle.inFlightStep.waitStartedAt = waitNow;      // SAME reading as planWait
      bundle.inFlightStep.appliedWaitMs = plan.applied;
      await persistBundle(this.deps.backend, args.sessionId, bundle);  // durable BEFORE sleep
    }

    if (plan.kind === 'torn') {
      // Mirror cutControlFailure (handler:1187) exactly — the artifact alone is
      // not enough. plannerPrivate is how the planner LEARNS why it is
      // replanning, and inFlightStep.controlFailure is how durable recovery
      // routes by phase. Omit either and the replan happens blind.
      const reason = `wait deadline half-written: missing ${plan.missing}`;
      bundle.budgets.stepsUsed++;
      await this.writeWaitArtifact(args, 'failed',
        `Wait deadline half-written: missing ${plan.missing}. The step never ran.`,
        reason);
      bundle.plannerPrivate += `\n[seq ${bundle.inFlightStep.seq} ${step.name} control-failed] ${reason}`;
      bundle.inFlightStep.controlFailure = {
        reason: 'control-failure',        // generic; NOT widened for waits
        seq: bundle.inFlightStep.seq,
      };
      await settleStep(this.deps.backend, args.sessionId, bundle, 'failed', args.onCommit);
      return 'served';                                   // planner replans
    }

    const toSleep = plan.kind === 'fresh' ? plan.applied : plan.remaining;
    const waiter = this.deps.waitStrategy ?? new DefaultWaitStrategy();
    const outcome = await waiter.wait(toSleep, args.ctx.options?.signal);
    if (outcome === 'aborted') return 'aborted';         // no artifact, no advance

    const { text, note } = describeWait(plan, step);
    await this.writeWaitArtifact(args, 'ok', text, note);
    bundle.budgets.stepsUsed++;
    recordStepControl(bundle, {
      seq: bundle.inFlightStep.seq,
      name: step.name,
      status: 'ok',
      note,
      remainder: '',
    });
    await settleStep(this.deps.backend, args.sessionId, bundle, 'advanced', args.onCommit);
    return 'served';
  }
```

`describeWait` is a pure helper — put it in `wait-step.ts` beside `planWait` and
unit-test it there:

```ts
export function describeWait(plan: WaitPlan, step: Step): { text: string; note: string } {
  if (plan.kind === 'resume') {
    return plan.deadlinePassed
      ? { text: 'Wait deadline had already elapsed during the outage; no additional sleep was performed.',
          note: 'resumed after deadline' }
      : { text: `Waited the remaining ${plan.remaining} ms of the scheduled pause.`, note: '' };
  }
  if (plan.kind === 'fresh' && plan.cappedSkip) {
    return { text: "No wait performed: the run's total wait budget is spent.",
             note: 'total wait budget spent' };
  }
  if (plan.kind === 'fresh' && plan.clamped) {
    return { text: `Waited ${plan.applied} ms (requested ${step.waitMs} ms, truncated by a wait bound).`,
             note: 'clamped' };
  }
  return { text: `Waited ${(plan as { applied: number }).applied} ms for the system to settle.`, note: '' };
}
```

`writeWaitArtifact` is a small private method wrapping the existing
`writeArtifact` metadata shape — `content` is NEVER empty, since an
empty-content `ok` risks being carried into approved content and surfacing as a
blank executed step:

```ts
  private async writeWaitArtifact(
    args: { rag: IKnowledgeRagHandle; meta: KnowledgeEntryMetadata; bundle: SessionBundle; step: Step; ctx: PipelineContext },
    status: 'ok' | 'failed', text: string, note: string,
  ): Promise<void> {
    const { bundle, step } = args;
    bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
    await writeArtifact(args.rag, {
      ...args.meta,
      artifactType: 'step-result',
      task: step.name,
      runId: bundle.runId,
      seq: bundle.inFlightStep?.seq ?? 0,
      attempt: bundle.inFlightStep?.attempt ?? 0,
      status, note, remainder: '',
      stepId: step.stepId,
      digest: text.slice(0, this.deps.config.budgets.maxDigestChars ?? 500),
      writeOrdinal: bundle.writeOrdinal,
      content: text,
    }, args.ctx.options);
  }
```

**Call site A — fresh dispatch (`handler:835-846`).** After
`bundle.inFlightStep = {...}` and the existing `persistBundle`, before
`runStep`:

```ts
      const waitOutcome = await this.serveWaitStep({
        ctx, sessionId, bundle, rag, meta, step: next.step,
        cfg: cfg, nowIso: now,
        onCommit: (o) => planner.commit?.(bundle, o),
      });
      if (waitOutcome === 'aborted') return true;
      if (waitOutcome === 'served') continue;
```

**Call site B — resume (`handler:636-659`). PLACEMENT IS LOAD-BEARING.**

Insert it immediately after the `// No artifact for this attempt` comment and
**BEFORE** the `if (externalContinuation) { ... } else { inf.resumeCount += 1; ... }`
block — NOT immediately before `runStep`.

Between those two points the controller charges `inf.resumeCount += 1` and
terminally aborts the run once `maxStepResumes` (default 3) is exceeded. That
accounting exists for a step whose EXECUTOR crashed mid-flight and is being
replayed. A wait is not being replayed: it is being continued against a
deadline that is already durable, and continuing it costs nothing.

Placing the branch after that accounting would mean a caller who cancels and
reconnects four times during a 360-second wait terminally kills the run —
directly contradicting the spec, which says an aborted wait stays in-flight and
the next resume serves it normally. A wait remainder is not a crash replay and
must not be charged as one.

```ts
      const waitOutcome = await this.serveWaitStep({
        ctx, sessionId, bundle, rag, meta, step: inf.step,
        cfg: cfg, nowIso: now,
        onCommit: (o) => planner.commit?.(bundle, o),
      });
      if (waitOutcome === 'aborted') return true;
      if (waitOutcome === 'served') continue;
```

Import `isWaitStep`, `planWait`, `describeWait` from `./wait-step.js`, and
`DefaultWaitStrategy` from `@mcp-abap-adt/llm-agent`.

Add the dep beside the existing `stepExecutionControl?: IStepExecutionControl`
(`handler:173`):

```ts
  waitStrategy?: IWaitStrategy;
```

The controller must NEVER construct a timer inline — every wait goes through
the strategy, which is what makes the suites fast and lets a consumer replace
blocking with suspend/resume.

**Type names used above, verified against the source** (do not guess these —
an earlier draft of this plan invented `IBackend`, `IRunScopedRag` and
`ArtifactMeta`, none of which exist):

| in the snippets | real declaration |
|---|---|
| backend for `persistBundle` | `KnowledgeBackend` — `session-bundle.ts:1,26` |
| `rag` | `IKnowledgeRagHandle` — `handler:888` |
| `meta` | `KnowledgeEntryMetadata` — `handler:889` |
| `writeArtifact`'s 2nd param | `Artifact` — `memorizer.ts:13` |

**Verify the real signatures before writing.** There is a standing comment at
`handler:656` warning that a previous plan misstated `runStep`'s parameter
order. Read the actual declarations of `runStep`, `writeArtifact` and
`persistBundle` in the file and match them — this plan's snippets are a guide,
not a substitute for the source.

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

it('a partial cap truncation reports a clamp, NOT "no wait performed"', async () => {
  const h = harness({ /* waitMs 30_000; maxTotalWaitMs leaves only 10_000 */ });
  const art = await runAndReadStepResult(h);
  assert.match(art.content, /10000/);
  assert.doesNotMatch(art.content, /No wait performed/);
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

it('repeated abort/resume of a wait does NOT consume maxStepResumes', async () => {
  // Guards the placement: the wait branch must run BEFORE resumeCount is charged.
  const h = harness({ /* pre-seeded in-flight wait, resumeCount already at
                         cfg.maxStepResumes (default 3) */ });
  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
  const bundle = await hydrateBundle(h.deps.backend, 'sess-1');
  assert.notEqual(bundle.runPhase, 'terminal', 'a resumed wait must not be aborted as a crash replay');
});

it('a torn deadline yields a control-failure and a replan, not a sleep', async () => {
  const h = harness({ /* bundle pre-seeded: waitStartedAt set, appliedWaitMs absent */ });
  const art = await runAndReadStepResult(h);
  assert.equal(art.metadata.status, 'failed');
  assert.match(art.metadata.note, /half-written|missing appliedWaitMs/i);

  const bundle = await hydrateBundle(h.deps.backend, 'sess-1');
  assert.match(bundle.plannerPrivate, /control-failed.*half-written/s,
    'the planner must learn WHY it is replanning');
  assert.equal(bundle.inFlightStep?.controlFailure?.reason, 'control-failure');
  assert.equal(bundle.inFlightStep?.phase, 'awaiting-replan');
});

it('an abort mid-wait writes no artifact, does not advance, keeps the deadline', async () => {
  const h = harness({ /* single wait step, waitMs 60_000 */ });
  // Assert the BRANCH via the strategy — do not race a real AbortController
  // against a real timer.
  h.deps.waitStrategy = { name: 'test-abort', async wait() { return 'aborted' as const; } };
  await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
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
