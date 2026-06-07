# Controller `adaptive` Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second controller planner implementation, `adaptive`, that builds a full plan once, emits its steps deterministically (no LLM call per step), and rebuilds the remaining plan on a step failure or when an external-tool result arrives on resume — selectable via `config.planner: incremental | adaptive`.

**Architecture:** Extract the planner-decision layer behind an `IControllerPlanner` seam (`next(input) → NextStep | null`). `IncrementalPlanner` wraps today's per-step `planNext` (behavior-identical). `AdaptivePlanner` holds the plan + cursor in the durable `SessionBundle`: it calls the planner LLM to **create** the plan, **advances the cursor in `commit()`** (persisted together with the step result immediately after `runStep`, so a resume never repeats a step), **replans** the remainder on a step failure or an external-tool resume result (a dedicated prompt for each), and does one **finalize** LLM call at the end. The handler's loop becomes planner-agnostic and feeds each step's `runStep` outcome (`'advanced'|'failed'`, the signal added in the prior commit) back into `planner.next`. The executor, tool-routing, durable bundle, suspend/resume, and token rollup are untouched. Budget/limit handling stays as-is (a separate selectable strategy is future work). **`rewind` stays incremental-only** — `AdaptivePlanner` never returns `{kind:'rewind'}` (its backtracking IS the failure-driven replan); the handler keeps its `rewind` branch for the shared `NextStep` contract / the incremental planner.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node ≥ 22, `node:test` + `node:assert/strict` via `node --import tsx/esm --test`, Biome. Branch: `feat/controller-plan-first`.

**Test command:** `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec 'src/smart-agent/controller/__tests__/<file>.test.ts'`. Always `npx biome check --write <files>` before committing.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `smart-agent/controller/types.ts` (modify) | `ControllerConfig.planner?: 'incremental' \| 'adaptive'`; `SessionBundle.plan?: Step[]` + `planCursor?: number`; export `PlannerKind`, `PlannerNextInput`, `IControllerPlanner` |
| `smart-agent/controller/planner.ts` (create) | `IncrementalPlanner`, `AdaptivePlanner`, `makePlanner(kind, planner)` — the pluggable planner implementations |
| `smart-agent/controller/controller-coordinator-handler.ts` (modify) | Move the planner system-prompt/`planNext` into `IncrementalPlanner`; make the loop planner-agnostic (construct via `makePlanner`, thread `lastOutcome`, persist plan/cursor) |
| `pipelines/controller.ts` (modify) | `parseConfig` defaults `planner: 'incremental'`; passes it through (already in `cfg`) |
| `smart-agent/controller/__tests__/planner.test.ts` (create) | Adaptive unit tests (create/advance/replan/finalize/parse-retry) |
| `smart-agent/controller/__tests__/controller-coordinator-handler.test.ts` (modify) | One end-to-end adaptive path test through the handler |

**Default is `incremental`** — current behavior is preserved; `adaptive` is opt-in until validated live. Flipping the default is a one-line change in `parseConfig` later.

---

## Task 1: Types — config knob, bundle plan state, planner seam

**Files:** Modify `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`; Test `…/controller/__tests__/types.test.ts` (existing — extend)

- [ ] **Step 1: failing test** — append inside the existing `describe('controller types', …)` in `types.test.ts`:
```ts
  it('ControllerConfig.planner + SessionBundle.plan/planCursor + planner seam types', () => {
    const cfg: Partial<ControllerConfig> = { planner: 'adaptive' };
    const bundle: SessionBundle = {
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      plan: [{ name: 's1', instructions: 'do' }],
      planCursor: 0,
    };
    assert.equal(cfg.planner, 'adaptive');
    assert.equal(bundle.plan?.[0].name, 's1');
    assert.equal(bundle.planCursor, 0);
  });
```
- [ ] **Step 2: run → FAIL** (`planner`/`plan`/`planCursor` not on the types).
- [ ] **Step 3: implement** — in `types.ts`:
  - Add to `ControllerConfig` (after `sessionMemory`): `planner?: 'incremental' | 'adaptive';`
  - Add to `SessionBundle` (after `budgets`): `plan?: Step[];` and `planCursor?: number;`
  - Add the seam exports at the end of the file:
```ts
export type PlannerKind = 'incremental' | 'adaptive';

export interface PlannerNextInput {
  bundle: SessionBundle;
  prompt: string;
  toolCatalog: string;
  /** Outcome of the step run since the previous `next()` (undefined on the first
   *  call / after a rewind / on resume). The adaptive planner replans on 'failed';
   *  the incremental planner ignores it. Cursor advance on 'advanced' happens in
   *  commit(), not here. */
  lastOutcome?: 'advanced' | 'failed';
  /** True when re-asking after an unparsable reply (stern format reminder). */
  retrying: boolean;
  /** True on the first call of a turn that just resumed an EXTERNAL-tool result
   *  (the result is now in `bundle.plannerPrivate`). The adaptive planner replans
   *  from the cursor so it incorporates the result via the planner — which reads
   *  plannerPrivate — instead of blindly re-running the suspended step (the
   *  executor prompt does NOT include plannerPrivate). Incremental ignores it
   *  (its planner already sees plannerPrivate every call). */
  resumedExternal?: boolean;
  logUsage?: (role: string, u?: LlmUsage) => void;
}

export interface IControllerPlanner {
  next(input: PlannerNextInput): Promise<NextStep | null>;
  /** Optional: record a just-finished step's outcome so the planner's durable
   *  bookkeeping (e.g. the adaptive cursor) is updated and can be persisted in the
   *  SAME write that follows. Incremental does not implement it (no-op). */
  commit?(bundle: SessionBundle, outcome: 'advanced' | 'failed'): void;
}
```
  - Add `LlmUsage` to the existing `@mcp-abap-adt/llm-agent` import in `types.ts` (it already imports `LlmUsage, StreamToolCall`). Confirm `Step` and `NextStep` are declared above these (they are).
- [ ] **Step 4: run → PASS.** Repo-root `npm run build` → clean.
- [ ] **Step 5: commit** `git add -A packages/llm-agent-server-libs/src/smart-agent/controller && git commit -m "feat(controller): planner config knob, bundle plan state, IControllerPlanner seam"`

---

## Task 2: `IncrementalPlanner` — extract today's planNext (behavior-identical)

**Files:** Create `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts`; Test `…/controller/__tests__/planner.test.ts`

This moves the existing planner prompt/parse out of the handler into an `IControllerPlanner`. The handler keeps `parseNextStep`/`extractJsonObject` (Task 4 imports them); here `planner.ts` re-uses them via export.

- [ ] **Step 1:** In `controller-coordinator-handler.ts`, export the two pure parser helpers so `planner.ts` can reuse them (do NOT duplicate). Change `function parseNextStep` → `export function parseNextStep` and `function extractJsonObject` → `export function extractJsonObject`. Run `npm run build` → clean.

- [ ] **Step 2: failing test** (`planner.test.ts`):
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ISubagentClient } from '../subagent-client.js';
import type { SessionBundle, SubagentResult } from '../types.js';
import { IncrementalPlanner } from '../planner.js';

const planner = (queue: SubagentResult[]): ISubagentClient => ({
  async send() {
    return queue.shift() ?? { kind: 'content', content: '' };
  },
});
const bundle = (): SessionBundle => ({
  goal: 'g',
  plannerPrivate: '',
  budgets: { stepsUsed: 0, rewindsUsed: 0 },
});

describe('IncrementalPlanner', () => {
  it('returns the planner LLM decision each call', async () => {
    const p = new IncrementalPlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            kind: 'next',
            step: { name: 's1', instructions: 'do' },
          }),
        },
      ]),
    );
    const next = await p.next({
      bundle: bundle(),
      prompt: 'req',
      toolCatalog: '- GetX: read',
      retrying: false,
    });
    assert.equal(next?.kind, 'next');
    assert.equal(next?.kind === 'next' && next.step.name, 's1');
  });
  it('non-content planner reply → null (format failure)', async () => {
    const p = new IncrementalPlanner(planner([{ kind: 'error', error: 'x' }]));
    assert.equal(
      await p.next({ bundle: bundle(), prompt: 'r', toolCatalog: '', retrying: false }),
      null,
    );
  });
});
```
- [ ] **Step 3: run → FAIL** (module missing).
- [ ] **Step 4: implement** `planner.ts` — `IncrementalPlanner` whose `next()` is the verbatim body of the current `planNext` (system prompt + user message + `logUsage('planner', res.usage)` + `parseNextStep`):
```ts
// Task 2 imports ONLY what IncrementalPlanner uses (the repo has noUnusedLocals;
// Task 3 extends this block with extractJsonObject / ControllerConfig / PlannerKind
// / Step / LlmUsage for AdaptivePlanner + makePlanner).
import { parseNextStep } from './controller-coordinator-handler.js';
import type { ISubagentClient } from './subagent-client.js';
import type {
  IControllerPlanner,
  NextStep,
  PlannerNextInput,
} from './types.js';

const PLANNER_SYSTEM =
  'You are the planner. Given the goal and progress, return a SINGLE JSON ' +
  'object: {"kind":"next","step":{"name":...,"instructions":...}} to take the ' +
  'next step, {"kind":"done","result":...} when the goal is met, or ' +
  '{"kind":"rewind","reason":...} to discard the current path. Output JSON only.\n' +
  'An executor carries out each step against the LIVE SAP system using the ' +
  'tools listed below. Any fact about the system MUST be obtained by planning a ' +
  'step that fetches it with a tool — do NOT answer from prior knowledge, and do ' +
  'NOT mark the goal "done" until the required data has actually been fetched ' +
  '(fetched results appear under Progress). Until then, return a concrete ' +
  '"next" fetch step.';

const RETRY_HINT =
  '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw ' +
  'JSON object — no prose, no explanation, no markdown code fences.';

export class IncrementalPlanner implements IControllerPlanner {
  constructor(private readonly planner: ISubagentClient) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const { bundle, prompt, toolCatalog, retrying, logUsage } = input;
    const res = await this.planner.send([
      { role: 'system', content: PLANNER_SYSTEM + (retrying ? RETRY_HINT : '') },
      {
        role: 'user',
        content:
          `Goal: ${bundle.goal}\nProgress:${bundle.plannerPrivate}\nRequest: ${prompt}\n` +
          `Available tools (the executor picks the exact one):\n${toolCatalog}`,
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') return null;
    return parseNextStep(res.content);
  }
}
```
- [ ] **Step 5: run → PASS (2).** `npm run build` clean. `npx biome check --write …/controller/`.
- [ ] **Step 6: commit** `feat(controller): extract IncrementalPlanner behind IControllerPlanner`

---

## Task 3: `AdaptivePlanner` — plan-first + replan-on-error + finalize

**Files:** Modify `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts`; Test `…/controller/__tests__/planner.test.ts`

State lives in the bundle: `bundle.plan` (the ordered steps) and `bundle.planCursor` (index of the step currently in flight). The handler persists the bundle after each `next()` (Task 4), so plan/cursor survive suspend/resume.

- [ ] **Step 1: failing tests** — append to `planner.test.ts`:
```ts
import { AdaptivePlanner } from '../planner.js';


describe('AdaptivePlanner', () => {
  it('first call creates the full plan and returns step 0', async () => {
    const b = bundle();
    const p = new AdaptivePlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [
              { name: 's1', instructions: 'fetch A' },
              { name: 's2', instructions: 'fetch B' },
            ],
          }),
        },
      ]),
    );
    const next = await p.next({ bundle: b, prompt: 'r', toolCatalog: '', retrying: false });
    assert.equal(next?.kind, 'next');
    assert.equal(next?.kind === 'next' && next.step.name, 's1');
    assert.equal(b.plan?.length, 2);
    assert.equal(b.planCursor, 0);
  });

  it('commit advances the cursor on success; next() then returns the next step', async () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [
        { name: 's1', instructions: 'a' },
        { name: 's2', instructions: 'b' },
      ],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(planner([]));
    p.commit(b, 'advanced'); // ← advance happens in commit, persisted by the handler
    assert.equal(b.planCursor, 1);
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'advanced',
    });
    assert.equal(next?.kind === 'next' && next.step.name, 's2');
  });

  it('commit on failure does NOT advance the cursor', () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 0,
    };
    new AdaptivePlanner(planner([])).commit(b, 'failed');
    assert.equal(b.planCursor, 0);
  });

  it('finalizes (one LLM call) when the cursor passes the last step', async () => {
    // commit() already advanced the cursor past the only step.
    const b: SessionBundle = {
      ...bundle(),
      plannerPrivate: '\n[step s1] data',
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 1,
    };
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: 'FINAL ANSWER' }]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'advanced',
    });
    assert.equal(next?.kind, 'done');
    assert.equal(next?.kind === 'done' && next.result, 'FINAL ANSWER');
  });

  it('rejects a malformed plan step (missing instructions) → null', async () => {
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: JSON.stringify({ plan: [{ name: 's1' }] }) }]),
    );
    assert.equal(
      await p.next({ bundle: bundle(), prompt: 'r', toolCatalog: '', retrying: false }),
      null,
    );
  });

  it("replans the remainder on lastOutcome 'failed'", async () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [
        { name: 's1', instructions: 'a' },
        { name: 's2', instructions: 'b' },
      ],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(
      planner([
        {
          kind: 'content',
          content: JSON.stringify({ plan: [{ name: 's1b', instructions: 'retry differently' }] }),
        },
      ]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.equal(next?.kind === 'next' && next.step.name, 's1b');
    assert.equal(b.plan?.[0].name, 's1b'); // remainder replaced from the cursor
  });

  it('replan returning an empty plan → done via finalize', async () => {
    const b: SessionBundle = {
      ...bundle(),
      plannerPrivate: '\n[step s1 failed] boom',
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(
      planner([
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // nothing left to do
        { kind: 'content', content: 'done despite failure' }, // finalize
      ]),
    );
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'failed',
    });
    assert.equal(next?.kind, 'done');
  });

  it('unparsable create-plan reply → null (handler retries)', async () => {
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: 'not json at all' }]),
    );
    assert.equal(
      await p.next({ bundle: bundle(), prompt: 'r', toolCatalog: '', retrying: false }),
      null,
    );
  });
});
```
- [ ] **Step 2: run → FAIL** (`AdaptivePlanner` missing).
- [ ] **Step 3: implement** — first EXTEND the import block at the top of `planner.ts` (Task 2 imported only IncrementalPlanner's needs; AdaptivePlanner + `makePlanner` add more). The block becomes:
```ts
import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import {
  extractJsonObject,
  parseNextStep,
} from './controller-coordinator-handler.js';
import type { ISubagentClient } from './subagent-client.js';
import type {
  IControllerPlanner,
  NextStep,
  PlannerKind,
  PlannerNextInput,
  SessionBundle,
  Step,
} from './types.js';
```
Then append the AdaptivePlanner code:
```ts
const CREATE_PLAN_SYSTEM =
  'You are the planner. Produce a COMPLETE, ordered plan to achieve the goal as ' +
  'a SINGLE JSON object: {"plan":[{"name":...,"instructions":...}, ...]}. Each ' +
  'step is one concrete action an executor performs against the LIVE SAP system ' +
  'using the available tools. Any fact about the system MUST be fetched with a ' +
  'tool — plan fetch steps; never answer from prior knowledge. Output JSON only.';

const REPLAN_SYSTEM =
  'You are the planner. A step just FAILED. Given the goal, the progress so far ' +
  '(fetched results + the failure), produce a REVISED plan for the REMAINING work ' +
  'as {"plan":[{"name":...,"instructions":...}, ...]}. If the goal is already ' +
  'satisfied despite the failure, return {"plan":[]}. Output JSON only.';

const EXTERNAL_RESULT_REPLAN_SYSTEM =
  'You are the planner. A NEW external tool result just arrived (see Progress) — ' +
  'this is NOT a failure. Given the goal and the progress (including the new ' +
  'result), produce a REVISED plan for the REMAINING work as ' +
  '{"plan":[{"name":...,"instructions":...}, ...]}. If the goal is already ' +
  'satisfied by the result, return {"plan":[]}. Output JSON only.';

const FINALIZE_SYSTEM =
  'All planned steps are complete. Using the progress below (the fetched results), ' +
  'write the final answer to the user request. Plain text, no JSON.';

/** Parse {"plan":[{name,instructions},...]} from a (possibly fenced) reply.
 *  Returns null on format failure: no `plan` array, OR ANY entry missing a valid
 *  name/instructions (so a half-formed step is a retryable format error, not a
 *  silently-dropped step). An explicitly empty `{"plan":[]}` is VALID (= nothing
 *  left to do — used by replan to signal completion). */
function parsePlan(content: string): Step[] | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as { plan?: unknown };
    if (!Array.isArray(obj.plan)) return null;
    const steps: Step[] = [];
    for (const raw of obj.plan) {
      const s = raw as Partial<Step>;
      if (typeof s.name !== 'string' || typeof s.instructions !== 'string') {
        return null; // malformed step → format failure (handler retries)
      }
      steps.push({
        name: s.name,
        instructions: s.instructions,
        ...(s.type ? { type: s.type } : {}),
      });
    }
    return steps;
  } catch {
    return null;
  }
}

export class AdaptivePlanner implements IControllerPlanner {
  // No budget field: replans are bounded by the loop's maxSteps (a failed step
  // bumps stepsUsed in runStep). Replan-specific budgeting is the deferred
  // "limits as a selectable strategy" work.
  constructor(private readonly planner: ISubagentClient) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const { bundle, prompt, toolCatalog, lastOutcome, resumedExternal, retrying, logUsage } = input;

    // 1. No plan yet → create it.
    if (!bundle.plan) {
      const plan = await this.callPlan(CREATE_PLAN_SYSTEM, bundle, prompt, toolCatalog, retrying, logUsage);
      if (plan === null) return null; // format failure → handler retries
      bundle.plan = plan;
      bundle.planCursor = 0;
      return this.stepAtCursor(bundle, prompt, logUsage);
    }

    // 2. Previous step failed, OR an external-tool result just arrived → replan
    //    the remainder from the cursor. The planner reads plannerPrivate (which
    //    now holds the failure/external result), so the revised plan incorporates
    //    it — no reliance on the executor seeing it. Use the matching prompt: an
    //    external result is NOT a failure, so it gets its own framing.
    if (lastOutcome === 'failed' || resumedExternal) {
      const system = resumedExternal
        ? EXTERNAL_RESULT_REPLAN_SYSTEM
        : REPLAN_SYSTEM;
      const rest = await this.callPlan(system, bundle, prompt, toolCatalog, retrying, logUsage);
      if (rest === null) return null;
      const cursor = bundle.planCursor ?? 0;
      bundle.plan = [...bundle.plan.slice(0, cursor), ...rest];
      return this.stepAtCursor(bundle, prompt, logUsage);
    }

    // 3. Otherwise emit the step at the cursor (or finalize). The cursor is
    //    advanced by commit() AFTER a step succeeds — NOT here — so the advance
    //    is persisted together with the step result (see Task 4), and a resume
    //    with lastOutcome=undefined continues from the next uncompleted step
    //    instead of repeating the last one.
    return this.stepAtCursor(bundle, prompt, logUsage);
  }

  /** Commit the just-finished step's outcome so the advance is persisted with it.
   *  On success the cursor moves to the next step; a failure leaves the cursor so
   *  the next next() can replan from it. (No LLM call — pure bookkeeping.) */
  commit(bundle: SessionBundle, outcome: 'advanced' | 'failed'): void {
    if (outcome === 'advanced') {
      bundle.planCursor = (bundle.planCursor ?? 0) + 1;
    }
  }

  /** Return the step at the cursor, or finalize → done when the plan is exhausted. */
  private async stepAtCursor(
    bundle: SessionBundle,
    prompt: string,
    logUsage?: (role: string, u?: LlmUsage) => void,
  ): Promise<NextStep> {
    const plan = bundle.plan ?? [];
    const cursor = bundle.planCursor ?? 0;
    if (cursor >= plan.length) {
      const res = await this.planner.send([
        { role: 'system', content: FINALIZE_SYSTEM },
        {
          role: 'user',
          content: `Goal: ${bundle.goal}\nRequest: ${prompt}\nProgress:${bundle.plannerPrivate}`,
        },
      ]);
      logUsage?.('finalizer', res.usage);
      return {
        kind: 'done',
        result: res.kind === 'content' ? res.content : 'completed',
      };
    }
    return { kind: 'next', step: plan[cursor] };
  }

  private async callPlan(
    system: string,
    bundle: SessionBundle,
    prompt: string,
    toolCatalog: string,
    retrying: boolean,
    logUsage?: (role: string, u?: LlmUsage) => void,
  ): Promise<Step[] | null> {
    const res = await this.planner.send([
      {
        role: 'system',
        content:
          system +
          (retrying
            ? '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw JSON object.'
            : ''),
      },
      {
        role: 'user',
        content:
          `Goal: ${bundle.goal}\nProgress:${bundle.plannerPrivate}\nRequest: ${prompt}\n` +
          `Available tools (the executor picks the exact one):\n${toolCatalog}`,
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') return null;
    return parsePlan(res.content);
  }
}

export function makePlanner(
  kind: PlannerKind,
  planner: ISubagentClient,
): IControllerPlanner {
  return kind === 'adaptive'
    ? new AdaptivePlanner(planner)
    : new IncrementalPlanner(planner);
}
```
- [ ] **Step 4: run → PASS (all AdaptivePlanner cases).** `npm run build` clean. biome.
- [ ] **Step 5: commit** `feat(controller): AdaptivePlanner (plan-first, replan-on-failure, finalize) + makePlanner`

---

## Task 4: Handler loop — planner-agnostic, threads `lastOutcome`, persists plan

**Files:** Modify `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`

Replace the inline `this.planNext(...)` call in `execute()`'s main loop with a `makePlanner`-selected planner, and feed `runStep`'s outcome back as `lastOutcome`. Delete the now-extracted `planNext` method (its logic lives in `IncrementalPlanner`). Keep `parseNextStep`/`extractJsonObject` exported (Task 2 Step 1) — they are still referenced by `IncrementalPlanner`.

- [ ] **Step 1:** Add the import at the top of the handler: `import { makePlanner } from './planner.js';`

- [ ] **Step 2a:** Near the TOP of `execute()` (before the "Resume from a persisted pending marker" block, so the resume branch can set it), declare:
```ts
    // True for the first planner.next of a turn that resumed an external-tool
    // result (the result is now in plannerPrivate) → the adaptive planner replans
    // with it rather than blindly re-running the suspended step. Set in the
    // external-tool resume branch below.
    let resumedExternal = false;
```

- [ ] **Step 2b:** In the existing external-tool resume branch (where the handler writes the `mcp-result` artifact, appends `[external tool … result]` to `plannerPrivate`, and clears `bundle.pending`), add `resumedExternal = true;` right after `bundle.pending = undefined;`.

- [ ] **Step 2c:** Just before the `while (bundle.budgets.stepsUsed < cfg.maxSteps)` loop, construct the planner and the outcome tracker:
```ts
    const planner = makePlanner(deps.config.planner ?? 'incremental', deps.planner);
    let lastOutcome: 'advanced' | 'failed' | undefined;
```
(The `const cfg = deps.config.budgets;` and `let planParseRetries = 0;` lines stay.)

- [ ] **Step 3:** Replace the loop body's planner call + step handling. The current code is:
```ts
      const next = await this.planNext(
        bundle,
        prompt,
        toolCatalog,
        planParseRetries > 0,
        logUsage,
      );
```
with:
```ts
      const next = await planner.next({
        bundle,
        prompt,
        toolCatalog,
        lastOutcome,
        resumedExternal,
        retrying: planParseRetries > 0,
        logUsage,
      });
      // NB: do NOT reset resumedExternal here — if this replan reply was malformed
      // (next === null), the parse-retry below must keep replanning. It is reset
      // only after a VALID decision (Step 4, beside `planParseRetries = 0;`).
      // The adaptive planner mutates bundle.plan/planCursor in next(); persist so
      // a stateless resume continues from the same point. (No-op for incremental.)
      await persistBundle(deps.backend, sessionId, bundle);
```

- [ ] **Step 4:** In the same loop: (i) the `null` (parse-retry) branch leaves `resumedExternal` as-is and `continue`s (so a malformed replan keeps replanning); (ii) right after that branch's `planParseRetries = 0;` (a VALID decision was produced), add `resumedExternal = false;` (consumed only now); (iii) the `rewind` branch adds `lastOutcome = undefined;` before its `continue;`; (iv) record the step outcome in the `next` branch tail. Concretely, after the `null`-branch:
```ts
      planParseRetries = 0;
      resumedExternal = false; // a valid decision consumed any external-resume replan
```
and change the step-execution tail from:
```ts
      const completed = await this.runStep( … );
      if (completed === 'suspended') return true;
      // 'advanced' OR 'failed' → loop continues …
    }
```
to:
```ts
      const completed = await this.runStep(
        ctx,
        sessionId,
        bundle,
        rag,
        meta,
        next.step,
        isExternalTool,
        logUsage,
        total,
      );
      if (completed === 'suspended') return true;
      // Commit the outcome (adaptive advances its cursor) and persist IMMEDIATELY,
      // so the cursor advance lands together with the step result runStep just
      // wrote — a resume then continues from the next uncompleted step rather than
      // repeating this one. (commit is a no-op for incremental.)
      planner.commit?.(bundle, completed);
      await persistBundle(deps.backend, sessionId, bundle);
      lastOutcome = completed; // 'advanced' | 'failed' → fed into the next planner.next
    }
```

> **Resume semantics (adaptive).** Cursor = next-uncompleted-step index, advanced in
> `commit` and persisted with the step result. A fresh turn / plain resume calls
> `planner.next` with `lastOutcome=undefined` → `stepAtCursor` returns the step at
> the (already-advanced) cursor — i.e. the next pending step, never a repeat.
> **External-tool resume is different:** `runStep` returns `'suspended'` BEFORE commit,
> so the cursor does NOT move and the pending marker is persisted. On resume the
> handler's external-tool branch appends the tool result to `plannerPrivate`, clears
> pending, and sets `resumedExternal = true`. The first `planner.next` then **replans**
> from the cursor (NOT a blind re-run) — the planner reads `plannerPrivate`, so it sees
> the result; the executor never needs to (its prompt excludes `plannerPrivate`). The
> replan uses a dedicated "external result arrived" prompt (NOT the failure prompt).
> Tested in Task 6 Step 4 (which asserts the replan prompt contains the result).

- [ ] **Step 5:** Delete the `private async planNext(...) { … }` method entirely (now in `IncrementalPlanner`). Keep `parseNextStep` + `extractJsonObject` (exported, used by the planner). Run `npm run build` → clean (no references to the removed method remain).

- [ ] **Step 6: run the full controller suite** — `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=tap 'src/smart-agent/controller/__tests__/*.test.ts' 'src/pipelines/__tests__/*.test.ts' 2>/dev/null | grep -E '^# (tests|pass|fail)'` → all pass (incremental behavior unchanged; default planner is `incremental`).

- [ ] **Step 7: commit** `git add -A packages/llm-agent-server-libs/src/smart-agent/controller && git commit -m "feat(controller): planner-agnostic loop (makePlanner + lastOutcome feedback)"`

---

## Task 5: Plugin config — default `planner: incremental`, pass through

**Files:** Modify `packages/llm-agent-server-libs/src/pipelines/controller.ts`; Test `pipelines/__tests__/controller.test.ts`

- [ ] **Step 1: failing test** — append to `controller.test.ts`:
```ts
  it('parseConfig defaults planner to incremental and preserves an explicit choice', () => {
    const plugin = new ControllerPipelinePlugin();
    const base = { subagents: { evaluator: { provider: 'openai' }, planner: { provider: 'openai' }, executor: { provider: 'openai' } } };
    assert.equal(plugin.parseConfig(base).planner, 'incremental');
    assert.equal(plugin.parseConfig({ ...base, planner: 'adaptive' }).planner, 'adaptive');
  });
```
- [ ] **Step 2: run → FAIL** (`planner` undefined / not defaulted).
- [ ] **Step 3: implement** — in `controller.ts` `parseConfig`, add `planner` to the returned config object (alongside `targetState`/`sessionMemory`/`budgets`):
```ts
      planner: (cfg.planner === 'adaptive' ? 'adaptive' : 'incremental') as ControllerConfig['planner'],
```
(`cfg` is the raw `Record<string, unknown>` already destructured at the top of `parseConfig`.)
- [ ] **Step 4: run → PASS.** `npm run build` clean. biome.
- [ ] **Step 5: commit** `feat(pipelines): controller config planner knob (default incremental)`

---

## Task 6: End-to-end adaptive path through the handler

**Files:** Modify `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`

Proves the planner-agnostic loop drives `AdaptivePlanner` correctly with the real `runStep`.

- [ ] **Step 1: failing test** — append inside the existing `describe('ControllerCoordinatorHandler', …)`. Reuse the file's `harness`/`fakeCtx`. Set the config's planner to `adaptive`:
```ts
  it('adaptive planner: create plan → run steps → finalize', async () => {
    const h = harness({
      evaluator: [{ kind: 'content', content: 'Goal: do it' }],
      // planner queue: (1) create-plan, (2) finalize
      planner: [
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'fetch A' }],
          }),
        },
        { kind: 'content', content: 'FINAL' },
      ],
      executor: [{ kind: 'content', content: 'did s1' }],
      config: { ...baseConfig(), planner: 'adaptive' },
    });
    const { ctx, captured } = fakeCtx();
    const ret = await new ControllerCoordinatorHandler(h.deps).execute(ctx, {}, undefined);

    assert.equal(ret, true);
    assert.ok(
      captured.find(
        (c) => c.ok && c.value.finishReason === 'stop' && c.value.content === 'FINAL',
      ),
      'finalized result surfaced',
    );
    const bundle = await hydrateBundle(h.backend, 'sess-1');
    assert.equal(bundle.plan?.length, 1);
    assert.equal(bundle.budgets.stepsUsed, 1);
  });
```
(`baseConfig()` returns a `ControllerConfig` without `planner` → spreading `planner: 'adaptive'` selects the adaptive path.)
- [ ] **Step 2: run → FAIL** if the loop isn't wired; **PASS** once Tasks 3–4 are in. (If implementing in order it should pass directly — still run it.)

- [ ] **Step 3: durable resume — a persisted cursor resumes from the NEXT step (no repeat).** Seed a mid-run bundle directly (`plan=[s1,s2]`, `planCursor=1`, goal set) via `persistBundle`, then run once and assert the executor's first step is **s2**, not s1. (Seeding the cursor avoids the budget-escalation side effects of a two-leg `maxSteps:1` setup — it tests the resume path cleanly.) Append:
```ts
  it('adaptive: a persisted cursor resumes from the NEXT step (no repeat)', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig(), planner: 'adaptive' };
    await persistBundle(backend, 'sess-1', {
      goal: 'Goal',
      plannerPrivate: '\n[step s1] did A',
      budgets: { stepsUsed: 1, rewindsUsed: 0 },
      plan: [
        { name: 's1', instructions: 'fetch A' },
        { name: 's2', instructions: 'fetch B' },
      ],
      planCursor: 1, // s1 already completed + persisted
    });
    const seen: string[] = [];
    const h = harness({
      evaluator: [], // goal already set → evaluator not called
      planner: [{ kind: 'content', content: 'FINAL' }], // finalize after s2
      executor: [],
      config: cfg,
    });
    h.deps.backend = backend;
    h.deps.executor = {
      async send(messages: Message[]) {
        const u = messages.find((m) => m.role === 'user');
        if (typeof u?.content === 'string') seen.push(u.content);
        return { kind: 'content', content: 'did it' };
      },
    };
    await new ControllerCoordinatorHandler(h.deps).execute(fakeCtx().ctx, {}, undefined);
    assert.ok(seen.some((c) => c.includes('fetch B')), 'resumed at s2');
    assert.ok(!seen.some((c) => c.includes('fetch A')), 's1 was NOT repeated');
  });
```

- [ ] **Step 4: external-tool resume REPLANS with the result visible to the planner.** Append a test (Finding 1): leg 1 — the executor emits an EXTERNAL tool call → suspend (cursor unmoved). Leg 2 — resume with `ctx.externalResults`; the handler appends the result to `plannerPrivate` + sets `resumedExternal`, so the adaptive planner **replans** (proving the planner SEES the result — it cannot rely on the executor seeing it). Capture the planner's replan prompt and assert it contains the result:
```ts
  it('adaptive + external tool: suspend keeps cursor; resume replans with the result visible to the planner', async () => {
    const backend = new InMemoryKnowledgeBackend();
    const cfg: ControllerConfig = { ...baseConfig(), planner: 'adaptive' };
    const extId = externalToolCallId('ExtTool', { q: 'x' });

    // Leg 1 — 1-step plan; executor emits an external tool call → suspend.
    const h1 = harness({
      evaluator: [{ kind: 'content', content: 'Goal' }],
      planner: [
        { kind: 'content', content: JSON.stringify({ plan: [{ name: 's1', instructions: 'do' }] }) },
      ],
      executor: [toolCall('ExtTool', { q: 'x' })],
      config: cfg,
    });
    h1.deps.backend = backend;
    const { ctx: c1, captured: cap1 } = fakeCtx({
      externalTools: [{ name: 'ExtTool', description: '', inputSchema: {} }],
    });
    await new ControllerCoordinatorHandler(h1.deps).execute(c1, {}, undefined);
    let b = await hydrateBundle(backend, 'sess-1');
    assert.equal(b.pending?.kind, 'external-tool');
    assert.equal(b.planCursor, 0, 'cursor unmoved on suspend');
    assert.ok(cap1.find((c) => c.ok && c.value.finishReason === 'tool_calls'));

    // Leg 2 — resume with the result. Capture the planner replan prompt to PROVE
    // it sees the result (via plannerPrivate). Replan returns empty → finalize.
    const seenPlanner: string[] = [];
    let pCall = 0;
    const h2 = harness({ evaluator: [], planner: [], executor: [], config: cfg });
    h2.deps.backend = backend;
    h2.deps.planner = {
      async send(messages: Message[]) {
        const u = messages.find((m) => m.role === 'user');
        if (typeof u?.content === 'string') seenPlanner.push(u.content);
        return pCall++ === 0
          ? { kind: 'content', content: JSON.stringify({ plan: [] }) } // nothing left
          : { kind: 'content', content: 'FINAL' }; // finalize
      },
    };
    const { ctx: c2, captured: cap2 } = fakeCtx({
      externalResults: new Map([[extId, 'TOOL RESULT']]),
    });
    const ret = await new ControllerCoordinatorHandler(h2.deps).execute(c2, {}, undefined);

    assert.equal(ret, true);
    b = await hydrateBundle(backend, 'sess-1');
    assert.equal(b.pending, undefined);
    assert.ok(
      seenPlanner.some((c) => c.includes('TOOL RESULT')),
      'the planner replan saw the external tool result (via plannerPrivate)',
    );
    assert.ok(
      cap2.find((c) => c.ok && c.value.finishReason === 'stop' && c.value.content === 'FINAL'),
    );
  });
```
(Add to the test file's imports if absent: `externalToolCallId` from `@mcp-abap-adt/llm-agent`, `type { Message }`, and `persistBundle` from `../session-bundle.js`.)

- [ ] **Step 5:** Run the full controller + pipeline suites (TAP summary) → 0 fail. `npm run build` clean. biome on touched files.
- [ ] **Step 6: commit** `test(controller): adaptive end-to-end + durable-resume + external-tool-resume`

---

## Self-Review

**1. Spec coverage (the agreed design):**
- New planner as a distinct named implementation, not a flavor toggle → Tasks 2/3 (`IncrementalPlanner`/`AdaptivePlanner` behind `IControllerPlanner`), selected by `config.planner` (Tasks 1/5). ✓
- Adaptive = build full plan once → emit step-by-step → replan only on failure → Task 3 (`createPlan`/`stepAtCursor`/replan-on-`failed`). ✓
- "Remembers which steps ran" → `bundle.plan` + `planCursor` (Task 1); the cursor advances in `commit()` and is persisted in the SAME write that follows `runStep` (Task 4 Step 4), so a resume continues from the next uncompleted step — proven by the durable-resume test (Task 6 Step 3). ✓ *(Finding 3 fixed: advance is committed-with-result, not deferred to the next `next()`.)*
- Executor returns errors already; loop now distinguishes them → the prior `runStep → 'failed'` commit (`540c4dfa`) feeds `lastOutcome`, which drives replan (Task 3) and is committed (Task 4 Step 4). ✓
- Finalize call at the end → Task 3 `stepAtCursor` when `cursor >= plan.length`. ✓
- Malformed plan steps are a retryable format failure, not silently dropped → `parsePlan` returns null on any bad entry (Task 3) + test. ✓ *(Finding 2.)*
- `rewind` is incremental-only; adaptive never emits it (replan IS its backtrack) → Architecture note + loop keeps the branch for incremental. ✓ *(Open question.)*
- External-tool suspend/resume under adaptive: cursor unmoved on suspend; on resume the handler sets `resumedExternal` and the planner **replans** from the cursor (a dedicated "external result arrived" prompt, NOT the failure prompt) so the result reaches the planner via `plannerPrivate` — the executor is never relied on to see it. `resumedExternal` survives parse-retries (reset only after a valid decision). → Task 6 Step 4 test (asserts the replan prompt contains the result) + the resume-semantics note in Task 4. ✓ *(Findings 4 + 2nd-round 1/2/3.)*
- Task 2 imports only IncrementalPlanner's needs (repo has `noUnusedLocals`); Task 3 extends the import block → Task 2/Task 3 Step 3. ✓ *(Finding 1.)*
- Core untouched (executor, subagent-client, tool-routing/offered-set, toolsRag, durable bundle, suspend/resume, token rollup) → only `types.ts`, `planner.ts`, the handler loop, and `parseConfig` change. ✓
- Limits/budgets unchanged (future selectable strategy) → no budget logic touched. `AdaptivePlanner` takes NO budget field (replans are bounded by the loop's `maxSteps` via `stepsUsed++` on failure); the loop's existing `maxRewinds`/`maxSteps` enforcement is unchanged. ✓ *(Finding 2: removed the unused `budgets` ctor field → no TS6138.)*
- Default `incremental` (no behavior change; adaptive opt-in) → Task 5. ✓

**2. Placeholder scan:** Every code step has complete code (prompts, parsers, the state machine, the loop edits, tests). No TBD/“similar to”/vague-handling. ✓

**3. Type consistency:** `IControllerPlanner.next(PlannerNextInput) → Promise<NextStep | null>` is used identically in Tasks 2/3/4. `PlannerNextInput` fields (`bundle/prompt/toolCatalog/lastOutcome/retrying/logUsage`) match across the planner impls and the handler call (Task 4 Step 3). `makePlanner(kind, planner)` signature matches its call site (Task 4 Step 2c). `bundle.plan: Step[]`/`planCursor: number` consistent (Tasks 1/3/4/6). `lastOutcome: 'advanced'|'failed'` matches `runStep`'s post-`540c4dfa` return.

**Verify-on-implement:** confirm `parseNextStep`/`extractJsonObject` exist in the handler (they do — added in the parser-tolerance commit) before exporting them in Task 2 Step 1; confirm `types.ts` already imports `LlmUsage` (it imports `LlmUsage, StreamToolCall`).

> Implement on `feat/controller-plan-first` (already has the `runStep → 'failed'` commit `540c4dfa`).
