# Controller `adaptive` Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second controller planner implementation, `adaptive`, that builds a full plan once, emits its steps deterministically (no LLM call per step), and rebuilds the remaining plan only when a step fails — selectable via `config.planner: incremental | adaptive`.

**Architecture:** Extract the planner-decision layer behind an `IControllerPlanner` seam (`next(input) → NextStep | null`). `IncrementalPlanner` wraps today's per-step `planNext` (behavior-identical). `AdaptivePlanner` holds the plan + cursor in the durable `SessionBundle`: it calls the planner LLM to **create** the plan, advances the cursor on `lastOutcome:'advanced'`, **replans** the remainder on `lastOutcome:'failed'`, and does one **finalize** LLM call at the end. The handler's loop becomes planner-agnostic and feeds each step's `runStep` outcome (`'advanced'|'failed'`, the signal added in the prior commit) back into `planner.next`. The executor, tool-routing, durable bundle, suspend/resume, and token rollup are untouched. Budget/limit handling stays as-is (a separate selectable strategy is future work).

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node ≥ 22, `node:test` + `node:assert/strict` via `node --import tsx/esm --test`, Biome. Branch: `feat/controller-plan-first`.

**Test command:** `cd packages/llm-agent-server-libs && node --import tsx/esm --test --test-reporter=spec 'src/smart-agent/controller/__tests__/<file>.test.ts'`. Always `npx biome check --write <files>` before committing.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `smart-agent/controller/types.ts` (modify) | `ControllerConfig.planner?: 'incremental' \| 'adaptive'`; `SessionBundle.plan?: Step[]` + `planCursor?: number`; export `PlannerKind`, `PlannerNextInput`, `IControllerPlanner` |
| `smart-agent/controller/planner.ts` (create) | `IncrementalPlanner`, `AdaptivePlanner`, `makePlanner(kind, deps)` — the pluggable planner implementations |
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
   *  call / after a rewind). The adaptive planner advances on 'advanced' and
   *  replans on 'failed'; the incremental planner ignores it. */
  lastOutcome?: 'advanced' | 'failed';
  /** True when re-asking after an unparsable reply (stern format reminder). */
  retrying: boolean;
  logUsage?: (role: string, u?: LlmUsage) => void;
}

export interface IControllerPlanner {
  next(input: PlannerNextInput): Promise<NextStep | null>;
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
import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import {
  extractJsonObject,
  parseNextStep,
} from './controller-coordinator-handler.js';
import type { ISubagentClient } from './subagent-client.js';
import type {
  ControllerConfig,
  IControllerPlanner,
  NextStep,
  PlannerKind,
  PlannerNextInput,
  Step,
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

const budgets = { maxSteps: 20, maxRetries: 3, maxRewinds: 5 };

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
      budgets,
    );
    const next = await p.next({ bundle: b, prompt: 'r', toolCatalog: '', retrying: false });
    assert.equal(next?.kind, 'next');
    assert.equal(next?.kind === 'next' && next.step.name, 's1');
    assert.equal(b.plan?.length, 2);
    assert.equal(b.planCursor, 0);
  });

  it("advances the cursor on lastOutcome 'advanced'", async () => {
    const b: SessionBundle = {
      ...bundle(),
      plan: [
        { name: 's1', instructions: 'a' },
        { name: 's2', instructions: 'b' },
      ],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(planner([]), budgets);
    const next = await p.next({
      bundle: b,
      prompt: 'r',
      toolCatalog: '',
      retrying: false,
      lastOutcome: 'advanced',
    });
    assert.equal(b.planCursor, 1);
    assert.equal(next?.kind === 'next' && next.step.name, 's2');
  });

  it('finalizes (one LLM call) when the cursor passes the last step', async () => {
    const b: SessionBundle = {
      ...bundle(),
      plannerPrivate: '\n[step s1] data',
      plan: [{ name: 's1', instructions: 'a' }],
      planCursor: 0,
    };
    const p = new AdaptivePlanner(
      planner([{ kind: 'content', content: 'FINAL ANSWER' }]),
      budgets,
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
      budgets,
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
      budgets,
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
      budgets,
    );
    assert.equal(
      await p.next({ bundle: bundle(), prompt: 'r', toolCatalog: '', retrying: false }),
      null,
    );
  });
});
```
- [ ] **Step 2: run → FAIL** (`AdaptivePlanner` missing).
- [ ] **Step 3: implement** — add to `planner.ts`:
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

const FINALIZE_SYSTEM =
  'All planned steps are complete. Using the progress below (the fetched results), ' +
  'write the final answer to the user request. Plain text, no JSON.';

/** Parse {"plan":[{name,instructions},...]} from a (possibly fenced) reply.
 *  Returns null when no valid plan array is present. */
function parsePlan(content: string): Step[] | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as { plan?: unknown };
    if (!Array.isArray(obj.plan)) return null;
    const steps: Step[] = [];
    for (const raw of obj.plan) {
      const s = raw as Partial<Step>;
      if (typeof s.name === 'string' && typeof s.instructions === 'string') {
        steps.push({ name: s.name, instructions: s.instructions, ...(s.type ? { type: s.type } : {}) });
      }
    }
    return steps;
  } catch {
    return null;
  }
}

export class AdaptivePlanner implements IControllerPlanner {
  constructor(
    private readonly planner: ISubagentClient,
    private readonly budgets: ControllerConfig['budgets'],
  ) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const { bundle, prompt, toolCatalog, lastOutcome, retrying, logUsage } = input;

    // 1. No plan yet → create it.
    if (!bundle.plan) {
      const plan = await this.callPlan(CREATE_PLAN_SYSTEM, bundle, prompt, toolCatalog, retrying, logUsage);
      if (plan === null) return null; // format failure → handler retries
      bundle.plan = plan;
      bundle.planCursor = 0;
      return this.stepAtCursor(bundle, prompt, logUsage);
    }

    // 2. Previous step failed → replan the remainder (from the cursor).
    if (lastOutcome === 'failed') {
      const rest = await this.callPlan(REPLAN_SYSTEM, bundle, prompt, toolCatalog, retrying, logUsage);
      if (rest === null) return null;
      const cursor = bundle.planCursor ?? 0;
      bundle.plan = [...bundle.plan.slice(0, cursor), ...rest];
      return this.stepAtCursor(bundle, prompt, logUsage);
    }

    // 3. Previous step advanced → move to the next step.
    if (lastOutcome === 'advanced') {
      bundle.planCursor = (bundle.planCursor ?? 0) + 1;
    }

    return this.stepAtCursor(bundle, prompt, logUsage);
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
  deps: { planner: ISubagentClient; budgets: ControllerConfig['budgets'] },
): IControllerPlanner {
  return kind === 'adaptive'
    ? new AdaptivePlanner(deps.planner, deps.budgets)
    : new IncrementalPlanner(deps.planner);
}
```
- [ ] **Step 4: run → PASS (all AdaptivePlanner cases).** `npm run build` clean. biome.
- [ ] **Step 5: commit** `feat(controller): AdaptivePlanner (plan-first, replan-on-failure, finalize) + makePlanner`

---

## Task 4: Handler loop — planner-agnostic, threads `lastOutcome`, persists plan

**Files:** Modify `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`

Replace the inline `this.planNext(...)` call in `execute()`'s main loop with a `makePlanner`-selected planner, and feed `runStep`'s outcome back as `lastOutcome`. Delete the now-extracted `planNext` method (its logic lives in `IncrementalPlanner`). Keep `parseNextStep`/`extractJsonObject` exported (Task 2 Step 1) — they are still referenced by `IncrementalPlanner`.

- [ ] **Step 1:** Add the import at the top of the handler: `import { makePlanner } from './planner.js';`

- [ ] **Step 2:** In `execute()`, just before the `while (bundle.budgets.stepsUsed < cfg.maxSteps)` loop, construct the planner and the outcome tracker:
```ts
    const planner = makePlanner(deps.config.planner ?? 'incremental', {
      planner: deps.planner,
      budgets: deps.config.budgets,
    });
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
        retrying: planParseRetries > 0,
        logUsage,
      });
      // The adaptive planner mutates bundle.plan/planCursor in next(); persist so
      // a stateless resume continues from the same point. (No-op for incremental.)
      await persistBundle(deps.backend, sessionId, bundle);
```

- [ ] **Step 4:** In the same loop, after the `null` (parse-retry) branch's `planParseRetries = 0;`, the `rewind` branch must clear the outcome (no step ran), and the `next` branch must record the step outcome. Change the rewind branch to add `lastOutcome = undefined;` before its `continue;`, and change the step-execution tail from:
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
      lastOutcome = completed; // 'advanced' | 'failed' → fed into the next planner.next
    }
```

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
- [ ] **Step 3:** Run the full controller + pipeline suites (TAP summary) → 0 fail. `npm run build` clean. biome on touched files.
- [ ] **Step 4: commit** `test(controller): end-to-end adaptive planner path`

---

## Self-Review

**1. Spec coverage (the agreed design):**
- New planner as a distinct named implementation, not a flavor toggle → Tasks 2/3 (`IncrementalPlanner`/`AdaptivePlanner` behind `IControllerPlanner`), selected by `config.planner` (Tasks 1/5). ✓
- Adaptive = build full plan once → emit step-by-step → replan only on failure → Task 3 (`createPlan`/`stepAtCursor`/replan-on-`failed`). ✓
- "Remembers which steps ran" → `bundle.plan` + `planCursor` (Task 1), persisted each iteration (Task 4 Step 3). ✓
- Executor returns errors already; loop now distinguishes them → the prior `runStep → 'failed'` commit (`540c4dfa`) feeds `lastOutcome` (Task 4 Step 4). ✓
- Finalize call at the end → Task 3 `stepAtCursor` when `cursor >= plan.length`. ✓
- Core untouched (executor, subagent-client, tool-routing/offered-set, toolsRag, durable bundle, suspend/resume, token rollup) → only `types.ts`, `planner.ts`, the handler loop, and `parseConfig` change. ✓
- Limits/budgets unchanged (future selectable strategy) → no budget logic touched; adaptive reuses `budgets`. ✓
- Default `incremental` (no behavior change; adaptive opt-in) → Task 5. ✓

**2. Placeholder scan:** Every code step has complete code (prompts, parsers, the state machine, the loop edits, tests). No TBD/“similar to”/vague-handling. ✓

**3. Type consistency:** `IControllerPlanner.next(PlannerNextInput) → Promise<NextStep | null>` is used identically in Tasks 2/3/4. `PlannerNextInput` fields (`bundle/prompt/toolCatalog/lastOutcome/retrying/logUsage`) match across the planner impls and the handler call (Task 4 Step 3). `makePlanner(kind, {planner, budgets})` signature matches its call site. `bundle.plan: Step[]`/`planCursor: number` consistent (Tasks 1/3/4/6). `lastOutcome: 'advanced'|'failed'` matches `runStep`'s post-`540c4dfa` return.

**Verify-on-implement:** confirm `parseNextStep`/`extractJsonObject` exist in the handler (they do — added in the parser-tolerance commit) before exporting them in Task 2 Step 1; confirm `types.ts` already imports `LlmUsage` (it imports `LlmUsage, StreamToolCall`).

> Implement on `feat/controller-plan-first` (already has the `runStep → 'failed'` commit `540c4dfa`).
