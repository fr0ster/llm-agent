# Coordinator step-input + clarification (#145) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Coordinator generate complete subagent tasks (specific goal + shared objective + client material as delimited data) and return a clarification instead of dispatching when the request is ambiguous.

**Architecture:** The planner authors structured intent per step (`goal`, plan-level `objective`, `needsInput` flag). A deterministic helper (`composeTask`) assembles the final `task` string for both `SelfDispatch` and `SubAgentDispatch`, embedding `ctx.inputText` verbatim as delimited data when `needsInput` is set. `context` (RAG/MCP-RAG) is unchanged. An initial planner may return `{clarification}`; the handler streams it and stops without dispatching.

**Tech Stack:** TypeScript (ESM, strict), Biome, `node --test` via `tsx/esm`. Monorepo workspaces; `@mcp-abap-adt/llm-agent` holds interfaces, `@mcp-abap-adt/llm-agent-libs` holds the coordinator.

Spec: `docs/superpowers/specs/2026-05-25-coordinator-step-input-145-design.md`

---

## File Structure

- `packages/llm-agent/src/interfaces/coordinator.ts` — add `PlanStep.needsInput?`, `Plan.objective?`, `Plan.clarification?`.
- `packages/llm-agent/src/interfaces/skill.ts` — add `ISkillMeta.objective?`, and `needsInput?`/`inputTemplate?` to `ISkillMeta.steps`.
- `packages/llm-agent-libs/src/coordinator/dispatch/compose-task.ts` — NEW. Deterministic task composer + tests.
- `packages/llm-agent-libs/src/coordinator/dispatch/self.ts` — use `composeTask`.
- `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts` — use `composeTask`.
- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — parse `objective`/`clarification`/`needsInput`; update prompt.
- `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts` — parse `objective`/`needsInput`; update prompt.
- `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts` — map `objective`/`needsInput`/`inputTemplate`.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — clarification short-circuit.

Tests:
- `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/compose-task.test.ts` — NEW.
- `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts` — NEW.
- `packages/llm-agent-libs/src/coordinator/planning/__tests__/skill-steps.test.ts` — extend.
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-clarification.test.ts` — NEW.

---

## Task 1: Extend shared interfaces

**Files:**
- Modify: `packages/llm-agent/src/interfaces/coordinator.ts`
- Modify: `packages/llm-agent/src/interfaces/skill.ts`

- [ ] **Step 1: Add fields to `PlanStep` and `Plan`**

In `packages/llm-agent/src/interfaces/coordinator.ts`, change the `PlanStep` and `Plan` interfaces to:

```ts
export interface PlanStep {
  id: string;
  goal: string;
  agent?: string;
  inputTemplate?: string;
  /**
   * When true, the Coordinator embeds the client request (`ctx.inputText`)
   * verbatim as delimited data inside the composed `task`. Default false —
   * no material is forwarded unless the planner asks for it.
   */
  needsInput?: boolean;
  expectedTools?: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface Plan {
  steps: PlanStep[];
  /**
   * Shared objective for the whole plan ("why"), authored once by the planner.
   * Forwarded into every dispatched step's `task` so subagents act as a team.
   */
  objective?: string;
  /**
   * Set by the initial planner when it cannot form an unambiguous plan. When
   * present, the Coordinator streams it to the consumer and dispatches nothing.
   */
  clarification?: string;
  rationale?: string;
  createdAt: number;
  source: 'planner-llm' | 'skill-steps' | 'manual';
}
```

- [ ] **Step 2: Add fields to `ISkillMeta`**

In `packages/llm-agent/src/interfaces/skill.ts`, add `objective?` to `ISkillMeta` and `needsInput?`/`inputTemplate?` to each step. Replace the `steps?` block and add `objective?` just above the index signature:

```ts
  steps?: Array<{
    id: string;
    goal: string;
    /**
     * Optional subagent name to route this step to. Read by SkillStepsPlanning
     * → propagated to PlanStep.agent → resolved by SubAgentDispatch /
     * HybridDispatch. Omit when the surrounding dispatch strategy is
     * registry-free (SelfDispatch) or when HybridDispatch should fall back
     * to self.
     */
    agent?: string;
    expectedTools?: string[];
    /** Mirrors PlanStep.needsInput — embed client material as delimited data. */
    needsInput?: boolean;
    /** Mirrors PlanStep.inputTemplate — advanced override for task composition. */
    inputTemplate?: string;
  }>;
  /** Shared objective forwarded to every step (mirrors Plan.objective). */
  objective?: string;
  /** Vendor-specific extensions (hooks, agent, etc.). */
  [key: string]: unknown;
```

- [ ] **Step 3: Build to verify the types compile**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent/src/interfaces/coordinator.ts packages/llm-agent/src/interfaces/skill.ts
git commit -m "feat(llm-agent): #145 add objective/clarification/needsInput to coordinator + skill interfaces"
```

---

## Task 2: `composeTask` helper (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dispatch/compose-task.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/compose-task.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/compose-task.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, PlanStep } from '@mcp-abap-adt/llm-agent';
import { composeTask } from '../compose-task.js';

function ctx(
  overrides: Partial<ICoordinatorContext> = {},
): ICoordinatorContext {
  return {
    inputText: 'RAW USER REQUEST',
    registry: new Map(),
    stepResults: {},
    sessionId: 't',
    ...overrides,
  } as unknown as ICoordinatorContext;
}

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return { id: 's1', goal: 'Summarize it', status: 'pending', ...overrides };
}

describe('composeTask', () => {
  it('returns bare goal when no objective, needsInput, or inputTemplate', () => {
    const task = composeTask(step(), ctx());
    assert.equal(task, 'Summarize it');
  });

  it('prepends the plan objective when present', () => {
    const c = ctx({
      plan: { steps: [], objective: 'Ship the release', createdAt: 0, source: 'planner-llm' },
    });
    const task = composeTask(step(), c);
    assert.match(task, /Task: Summarize it/);
    assert.match(task, /Overall objective: Ship the release/);
  });

  it('embeds inputText verbatim as delimited data when needsInput is true', () => {
    const task = composeTask(step({ needsInput: true }), ctx());
    assert.match(task, /Input \(user-provided data\):/);
    assert.match(task, /---\nRAW USER REQUEST\n---/);
  });

  it('does not include inputText when needsInput is false', () => {
    const task = composeTask(step({ needsInput: false }), ctx());
    assert.doesNotMatch(task, /RAW USER REQUEST/);
  });

  it('inputTemplate overrides and expands {{...}} placeholders', () => {
    const c = ctx({
      plan: { steps: [], objective: 'OBJ', createdAt: 0, source: 'planner-llm' },
    });
    const task = composeTask(
      step({ inputTemplate: '{{goal}} || {{objective}} || {{inputText}}' }),
      c,
    );
    assert.equal(task, 'Summarize it || OBJ || RAW USER REQUEST');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dispatch/__tests__/compose-task.test.ts`
Expected: FAIL — cannot find module `../compose-task.js`.

- [ ] **Step 3: Implement `composeTask`**

Create `packages/llm-agent-libs/src/coordinator/dispatch/compose-task.ts`:

```ts
import type { ICoordinatorContext, PlanStep } from '@mcp-abap-adt/llm-agent';
import { resolveTemplate } from '../../util/template.js';

/**
 * Deterministically compose the executor `task` from the planner's structured
 * intent. The planner decides (goal, plan objective, needsInput); this helper
 * assembles the final string with no LLM involvement, so client material is
 * inserted verbatim and losslessly.
 *
 * - `step.inputTemplate` (advanced override) wins and is resolved as-is.
 * - No-regression path: when there is no objective and no needsInput (and no
 *   template), the task reduces to the bare `step.goal` — unchanged behavior.
 * - Otherwise: "Task: <goal>", then "Overall objective: <objective>" when the
 *   plan carries one, then the client request as delimited data when
 *   `step.needsInput` is true.
 */
export function composeTask(step: PlanStep, ctx: ICoordinatorContext): string {
  if (step.inputTemplate) {
    const renderCtx: Record<string, unknown> = {
      goal: step.goal,
      objective: ctx.plan?.objective ?? '',
      inputText: ctx.inputText,
      stepResults: ctx.stepResults,
      step,
    };
    return resolveTemplate(step.inputTemplate, renderCtx);
  }

  const objective = ctx.plan?.objective;

  // No-regression path: nothing to compose → bare goal (unchanged behavior).
  if (!objective && !step.needsInput) {
    return step.goal;
  }

  const parts: string[] = [`Task: ${step.goal}`];
  if (objective) {
    parts.push(`Overall objective: ${objective}`);
  }
  if (step.needsInput) {
    parts.push(`Input (user-provided data):\n---\n${ctx.inputText}\n---`);
  }
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dispatch/__tests__/compose-task.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dispatch/compose-task.ts packages/llm-agent-libs/src/coordinator/dispatch/__tests__/compose-task.test.ts
git commit -m "feat(libs): #145 deterministic composeTask helper (objective + goal + material-as-data)"
```

---

## Task 3: Wire `composeTask` into both dispatch strategies (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts:51-59`
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/self.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/subagent-dispatch.test.ts`

- [ ] **Step 1: Write the failing capture test**

Create `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/subagent-dispatch.test.ts`. A fake subagent records the `task` it receives, so we verify the composed task end-to-end (deterministic, no LLM, no log leakage):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  ISubAgent,
  ISubAgentInput,
  PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { SubAgentDispatch } from '../subagent.js';

describe('SubAgentDispatch task composition', () => {
  it('passes objective + verbatim material in the composed task', async () => {
    const captured: { task?: string } = {};
    const fakeSub: ISubAgent = {
      capabilities: {
        kind: 'constrained',
        canDispatchChildren: false,
        contextPolicy: 'optional',
      },
      run: async (input: ISubAgentInput) => {
        captured.task = input.task;
        return { output: 'done' };
      },
    } as unknown as ISubAgent;

    const ctx = {
      inputText: 'RELEASE-TASKS-BLOB',
      registry: new Map([['summarizer', fakeSub]]),
      stepResults: {},
      sessionId: 't',
      plan: {
        steps: [],
        objective: 'Ship the release',
        createdAt: 0,
        source: 'planner-llm',
      },
    } as unknown as ICoordinatorContext;

    const step: PlanStep = {
      id: 's1',
      goal: 'Summarize',
      agent: 'summarizer',
      needsInput: true,
      status: 'pending',
    };

    const res = await new SubAgentDispatch().dispatch(step, ctx);
    assert.equal(res.ok, true);
    assert.match(captured.task ?? '', /RELEASE-TASKS-BLOB/);
    assert.match(captured.task ?? '', /Overall objective: Ship the release/);
  });
});
```

Also create `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/self-dispatch.test.ts` — the self path had the identical defect, so it needs its own capture test (a fake `ILlm.chat` records the messages):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, ILlm, PlanStep } from '@mcp-abap-adt/llm-agent';
import { SelfDispatch } from '../self.js';

describe('SelfDispatch task composition', () => {
  it('passes the composed task (with material + objective) into the user message', async () => {
    const captured: { messages?: Array<{ role: string; content: unknown }> } = {};
    const llm = {
      chat: async (messages: Array<{ role: string; content: unknown }>) => {
        captured.messages = messages;
        return { ok: true, value: { content: 'done' } };
      },
    } as unknown as ILlm;

    const ctx = {
      inputText: 'RELEASE-TASKS-BLOB',
      registry: new Map(),
      stepResults: {},
      sessionId: 't',
      plan: {
        steps: [],
        objective: 'Ship the release',
        createdAt: 0,
        source: 'planner-llm',
      },
    } as unknown as ICoordinatorContext;

    const step: PlanStep = {
      id: 's1',
      goal: 'Summarize',
      needsInput: true,
      status: 'pending',
    };

    const res = await new SelfDispatch(llm).dispatch(step, ctx);
    assert.equal(res.ok, true);
    const userMsg = captured.messages?.find((m) => m.role === 'user');
    assert.match(String(userMsg?.content ?? ''), /RELEASE-TASKS-BLOB/);
    assert.match(String(userMsg?.content ?? ''), /Overall objective: Ship the release/);
  });
});
```

- [ ] **Step 2: Run both tests to verify they fail**

Run: `cd packages/llm-agent-libs && npx tsx --test 'src/coordinator/dispatch/__tests__/*-dispatch.test.ts'`
Expected: FAIL — current code sets `task = step.goal` (subagent) / `Current step: ${goal}` (self), so neither carries the material/objective and the assertions fail.

- [ ] **Step 3: Use `composeTask` in `SubAgentDispatch`**

In `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`, remove the local `renderCtx`/`resolveTemplate` task block and the now-unused `resolveTemplate` import. Replace the block:

```ts
    const renderCtx: Record<string, unknown> = {
      inputText: ctx.inputText,
      stepResults: ctx.stepResults,
      step: step,
      goal: step.goal,
    };
    const task = step.inputTemplate
      ? resolveTemplate(step.inputTemplate, renderCtx)
      : step.goal;
```

with:

```ts
    const task = composeTask(step, ctx);
```

Change the import line `import { resolveTemplate } from '../../util/template.js';` to:

```ts
import { composeTask } from './compose-task.js';
```

- [ ] **Step 4: Use `composeTask` in `SelfDispatch`**

In `packages/llm-agent-libs/src/coordinator/dispatch/self.ts`, add the import after the existing type import:

```ts
import { composeTask } from './compose-task.js';
```

Replace the `userMsg` construction:

```ts
    const priorBlock =
      Object.values(ctx.stepResults)
        .map((r) => `- ${r.stepId}: ${r.output.slice(0, 300)}`)
        .join('\n') || '(none)';
    const userMsg = `Current step: ${step.goal}\n\nResults so far:\n${priorBlock}`;
```

with:

```ts
    const priorBlock =
      Object.values(ctx.stepResults)
        .map((r) => `- ${r.stepId}: ${r.output.slice(0, 300)}`)
        .join('\n') || '(none)';
    const userMsg = `${composeTask(step, ctx)}\n\nResults so far:\n${priorBlock}`;
```

- [ ] **Step 5: Build to verify both strategies compile**

Run: `npm run build`
Expected: build succeeds; no unused-import errors from Biome/TS.

- [ ] **Step 6: Run the dispatch test suite to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test 'src/coordinator/dispatch/__tests__/*.test.ts'`
Expected: PASS — composeTask (5) + subagent-dispatch capture (1) + self-dispatch capture (1) green.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dispatch/self.ts \
  packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts \
  packages/llm-agent-libs/src/coordinator/dispatch/__tests__/subagent-dispatch.test.ts \
  packages/llm-agent-libs/src/coordinator/dispatch/__tests__/self-dispatch.test.ts
git commit -m "fix(libs): #145 both dispatch paths compose task via composeTask (self no longer drops inputText)"
```

---

## Task 4: One-shot planner — parse objective/clarification/needsInput (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts`
- Test: `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, ILlm } from '@mcp-abap-adt/llm-agent';
import { OneShotPlanning } from '../one-shot.js';

function makeCtx(): ICoordinatorContext {
  return {
    inputText: 'Summarize this: a, b, c',
    registry: new Map(),
    stepResults: {},
    sessionId: 't',
  } as unknown as ICoordinatorContext;
}

function llmReturning(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content } }),
  } as unknown as ILlm;
}

describe('OneShotPlanning parsing', () => {
  it('parses objective and per-step needsInput', async () => {
    const llm = llmReturning(
      '{"objective":"Ship checklist","steps":[{"id":"s1","goal":"Summarize","needsInput":true}],"rationale":"R"}',
    );
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.objective, 'Ship checklist');
    assert.equal(plan.steps[0].needsInput, true);
    assert.equal(plan.clarification, undefined);
  });

  it('returns a clarification plan with no steps', async () => {
    const llm = llmReturning('{"clarification":"What should I summarize?"}');
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.clarification, 'What should I summarize?');
    assert.equal(plan.steps.length, 0);
  });

  it('throws when output has neither steps nor clarification', async () => {
    const llm = llmReturning('{"objective":"x"}');
    await assert.rejects(
      () => new OneShotPlanning(llm).buildInitialPlan(makeCtx()),
      /neither steps nor a clarification/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/one-shot.test.ts`
Expected: FAIL — `plan.objective` is `undefined` and clarification branch not handled (parse error or wrong shape).

- [ ] **Step 3: Update the parse + return in `one-shot.ts`**

In `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts`, replace the parse-and-return block inside `buildInitialPlan` (from `const parsed = JSON.parse(...)` through the `return { steps, rationale, ... }`) with:

```ts
    const jsonText = extractJson(response.value.content);
    const parsed = JSON.parse(jsonText) as {
      objective?: string;
      clarification?: string;
      steps?: Array<{
        id?: string;
        goal: string;
        agent?: string;
        needsInput?: boolean;
      }>;
      rationale?: string;
    };

    if (parsed.clarification && (parsed.steps?.length ?? 0) === 0) {
      return {
        steps: [],
        clarification: parsed.clarification,
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    }

    // Without a clarification, a usable plan must carry at least one valid step.
    // An empty/malformed plan must fail loud (→ COORDINATOR_PLAN_FAILED) rather
    // than silently produce blank coordinator output.
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(
        `Planner returned neither steps nor a clarification: ${jsonText.slice(0, 200)}`,
      );
    }
    for (const s of parsed.steps) {
      if (typeof s.goal !== 'string' || s.goal.trim() === '') {
        throw new Error(`Planner step is missing a goal: ${JSON.stringify(s)}`);
      }
    }

    const steps: PlanStep[] = parsed.steps.map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      goal: s.goal,
      agent: s.agent,
      needsInput: s.needsInput,
      status: 'pending',
    }));

    return {
      steps,
      objective: parsed.objective,
      rationale: parsed.rationale,
      createdAt: Date.now(),
      source: 'planner-llm',
    };
```

- [ ] **Step 4: Update the planner system prompt in `one-shot.ts`**

Replace the `systemPrompt` template literal with:

```ts
    const systemPrompt = `You are a planner. Decompose the user request into ordered steps.
The dispatched executor sees ONLY the step you author (its "goal" plus the shared
"objective", and the user's input as delimited data when you set "needsInput").
It never sees the raw user request as an instruction. So set "needsInput": true on
any step that must act on the user's provided material (text to summarize, code to
review, etc.).
Emit a plan-level "objective" (the shared purpose) so all steps stay aligned.
For each step, choose the best agent from the list (or omit "agent" if no specialist fits).
If the request is too ambiguous to plan, respond with ONLY {"clarification":"<your question>"}.
Otherwise respond with ONLY a JSON object of shape:
{"objective":"...","steps":[{"id":"step-1","goal":"...","agent":"optional-name","needsInput":false}],"rationale":"..."}

Available agents:
${agentsBlock || '(none — use self-dispatch)'}${skillBlock}`;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/one-shot.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/planning/one-shot.ts packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts
git commit -m "feat(libs): #145 one-shot planner emits objective/needsInput + clarification union"
```

---

## Task 5: Replan planner — parse objective/needsInput (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts`
- Test: `packages/llm-agent-libs/src/coordinator/planning/__tests__/replan-on-error.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/coordinator/planning/__tests__/replan-on-error.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ICoordinatorContext, ILlm } from '@mcp-abap-adt/llm-agent';
import { ReplanOnErrorPlanning } from '../replan-on-error.js';

function makeCtx(): ICoordinatorContext {
  return {
    inputText: 'do stuff',
    registry: new Map(),
    stepResults: {},
    sessionId: 't',
  } as unknown as ICoordinatorContext;
}

function llmReturning(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content } }),
  } as unknown as ILlm;
}

describe('ReplanOnErrorPlanning.rebuildPlan parsing', () => {
  it('parses objective and per-step needsInput', async () => {
    const llm = llmReturning(
      '{"objective":"Recover","steps":[{"id":"r1","goal":"Retry","needsInput":true}],"rationale":"R"}',
    );
    const plan = await new ReplanOnErrorPlanning(llm).rebuildPlan(makeCtx(), []);
    assert.equal(plan.objective, 'Recover');
    assert.equal(plan.steps[0].needsInput, true);
  });

  it('throws when replan output has no steps', async () => {
    const llm = llmReturning('{"objective":"x"}');
    await assert.rejects(
      () => new ReplanOnErrorPlanning(llm).rebuildPlan(makeCtx(), []),
      /Replan returned no steps/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/replan-on-error.test.ts`
Expected: FAIL — `plan.objective`/`needsInput` undefined and the malformed case does not yet throw.

- [ ] **Step 3: Update the parse + return in `replan-on-error.ts`**

In `rebuildPlan`, replace the parse-and-return block (from `const parsed = JSON.parse(...)` through the closing `return { ... }`) with:

```ts
    const jsonText = extractJson(response.value.content);
    const parsed = JSON.parse(jsonText) as {
      objective?: string;
      steps?: Array<{
        id?: string;
        goal: string;
        agent?: string;
        needsInput?: boolean;
      }>;
      rationale?: string;
    };
    // A replan must yield at least one valid step; an empty/malformed result
    // fails loud (→ COORDINATOR_REPLAN_FAILED) instead of stalling silently.
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(`Replan returned no steps: ${jsonText.slice(0, 200)}`);
    }
    for (const s of parsed.steps) {
      if (typeof s.goal !== 'string' || s.goal.trim() === '') {
        throw new Error(`Replan step is missing a goal: ${JSON.stringify(s)}`);
      }
    }
    return {
      steps: parsed.steps.map((s, i) => ({
        id: s.id ?? `replan-${i + 1}`,
        goal: s.goal,
        agent: s.agent,
        needsInput: s.needsInput,
        status: 'pending',
      })),
      objective: parsed.objective,
      rationale: parsed.rationale,
      createdAt: Date.now(),
      source: 'planner-llm',
    };
```

- [ ] **Step 4: Update the replan system prompt in `replan-on-error.ts`**

In the `systemPrompt` template, replace the final instruction lines (the `Respond with ONLY a JSON object:` block) with:

```ts
Set "needsInput": true on any step that must act on the user's provided material.
Re-state the shared "objective".

Respond with ONLY a JSON object:
{"objective":"...","steps":[{"id":"...","goal":"...","agent":"optional","needsInput":false}],"rationale":"..."}`;
```

(Leave the earlier interpolated context — `Original user request`, `Results so far`, `Previously remaining steps`, `Available agents` — unchanged.)

- [ ] **Step 5: Build, then run the test to verify it passes**

Run: `npm run build`
Expected: build succeeds.

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/replan-on-error.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts \
  packages/llm-agent-libs/src/coordinator/planning/__tests__/replan-on-error.test.ts
git commit -m "feat(libs): #145 replan planner emits objective/needsInput + fail-loud validation"
```

---

## Task 6: SkillStepsPlanning — map objective/needsInput/inputTemplate (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts:43-58`
- Test: `packages/llm-agent-libs/src/coordinator/planning/__tests__/skill-steps.test.ts`

- [ ] **Step 1: Add a failing test to the existing suite**

Append this `it(...)` block inside the existing `describe('SkillStepsPlanning', ...)` in `packages/llm-agent-libs/src/coordinator/planning/__tests__/skill-steps.test.ts`:

```ts
  it('maps objective, needsInput, and inputTemplate from skill meta', async () => {
    const meta: ISkillMeta = {
      name: 'summarize-skill',
      description: 'one-step summary',
      objective: 'Produce a tight checklist',
      steps: [
        {
          id: 'sum',
          goal: 'Summarize',
          needsInput: true,
          inputTemplate: '{{goal}}::{{inputText}}',
        },
      ],
    };
    const plan = await new SkillStepsPlanning().buildInitialPlan(makeCtx(meta));
    assert.equal(plan.objective, 'Produce a tight checklist');
    assert.equal(plan.steps[0].needsInput, true);
    assert.equal(plan.steps[0].inputTemplate, '{{goal}}::{{inputText}}');
  });

  it('leaves objective undefined when skill meta omits it (no fallback)', async () => {
    const meta: ISkillMeta = {
      name: 'no-objective',
      description: '',
      steps: [{ id: 'a', goal: 'Do a thing' }],
    };
    const plan = await new SkillStepsPlanning().buildInitialPlan(makeCtx(meta));
    assert.equal(plan.objective, undefined);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/skill-steps.test.ts`
Expected: FAIL — `plan.objective` and `plan.steps[0].needsInput` are `undefined` (not yet mapped).

- [ ] **Step 3: Map the new fields in `skill-steps.ts`**

In `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts`, replace the `steps`/`return` block inside `buildInitialPlan` with:

```ts
    const steps: PlanStep[] = meta.steps.map((s) => ({
      id: s.id,
      goal: s.goal,
      agent: s.agent,
      expectedTools: s.expectedTools,
      needsInput: s.needsInput,
      inputTemplate: s.inputTemplate,
      status: 'pending',
    }));
    return {
      steps,
      objective: meta.objective,
      rationale: `Steps declared by skill '${meta.name}'`,
      createdAt: Date.now(),
      source: 'skill-steps',
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/skill-steps.test.ts`
Expected: PASS — all existing tests plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts packages/llm-agent-libs/src/coordinator/planning/__tests__/skill-steps.test.ts
git commit -m "feat(libs): #145 skill-steps map objective/needsInput/inputTemplate (no objective fallback)"
```

---

## Task 7: CoordinatorHandler — clarification short-circuit (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts:93-110`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-clarification.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-clarification.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
} from '@mcp-abap-adt/llm-agent';
import { CoordinatorHandler } from '../coordinator.js';

const clarifyPlanning: IPlanningStrategy = {
  name: 'clarify',
  buildInitialPlan: async (): Promise<Plan> => ({
    steps: [],
    clarification: 'What should I summarize?',
    createdAt: 0,
    source: 'planner-llm',
  }),
  shouldReplan: () => false,
  rebuildPlan: async () => ({ steps: [], createdAt: 0, source: 'planner-llm' }),
};

const throwingDispatch: IDispatchStrategy = {
  name: 'never',
  dispatch: async () => {
    throw new Error('dispatch must not be called on clarification');
  },
};

describe('CoordinatorHandler clarification gate', () => {
  it('streams the clarification and dispatches nothing', async () => {
    const yields: Array<{ ok: boolean; value: { content: string; finishReason?: string } }> = [];
    const ctx = {
      inputText: 'ambiguous',
      sessionId: 't',
      yield: (c: { ok: boolean; value: { content: string; finishReason?: string } }) => {
        yields.push(c);
      },
    } as unknown as Parameters<CoordinatorHandler['execute']>[0];

    const handler = new CoordinatorHandler({
      planning: clarifyPlanning,
      dispatch: throwingDispatch,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
      maxLayer: 1,
    });

    const ok = await handler.execute(ctx, {}, {} as never);

    assert.equal(ok, true);
    assert.equal(yields[0].value.content, 'What should I summarize?');
    assert.equal(yields[1].value.finishReason, 'stop');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/coordinator-clarification.test.ts`
Expected: FAIL — `throwingDispatch` is invoked (no clarification short-circuit yet), so the handler throws/errors.

- [ ] **Step 3: Add the clarification short-circuit in `coordinator.ts`**

In `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`, immediately after the line `ctx.stepResults = coordCtx.stepResults;` (just before the `// Validate plan against layer rules` comment), insert:

```ts
    // Clarification gate: the planner decided the request is too ambiguous to
    // plan. Stream the question and dispatch nothing — the Coordinator asking
    // back, not a subagent failing on empty material.
    if (plan.clarification) {
      ctx.options?.sessionLogger?.logStep('coordinator_clarification', {
        length: plan.clarification.length,
      });
      ctx.yield({ ok: true, value: { content: plan.clarification } });
      ctx.yield({
        ok: true,
        value: { content: '', finishReason: 'stop' },
      });
      return true;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/coordinator-clarification.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-clarification.test.ts
git commit -m "feat(libs): #145 CoordinatorHandler returns clarification without dispatching"
```

---

## Task 8: Full gate + lint + smoke

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: all packages compile.

- [ ] **Step 2: Lint check**

Run: `npm run lint:check`
Expected: no errors. (If Biome flags formatting, run `npm run lint` and amend the last commit.)

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all workspace tests pass, including the four coordinator suites touched/added here.

- [ ] **Step 4: Manual smoke against the #145 repro (optional, needs a running LLM)**

The deterministic proof that the material reaches the subagent is the Task 3
capture test (a fake subagent records `input.task`). This smoke step verifies
the user-visible behavior only — we do NOT log the composed task or raw user
material (avoids leaking user data into logs).

With a configured `smart-server.yaml` (a `summarizer` constrained subagent +
`coordinator` activation), send:

```
Summarize this into a checklist: Our release needs a DB migration, a feature flag
rollout, a smoke test on staging, and a customer email. Keep it tight.
```

Expected: the response is a real checklist covering the four release tasks — not
"could you share the text?". Then send an ambiguous request (e.g. just
"summarize") and confirm the coordinator returns a clarification question
instead of dispatching.

- [ ] **Step 5: Final commit (only if lint produced changes)**

```bash
git add -A
git commit -m "chore(libs): #145 lint/format pass"
```

---

## Notes for the implementer

- `npx tsx --test <file>` runs a single suite fast during TDD; `npm test` runs the whole workspace via each package's `node --import tsx/esm --test` script.
- Type-only imports from `@mcp-abap-adt/llm-agent` are erased at runtime, so the libs tests run against the new interface fields without rebuilding the interfaces package first. `npm run build` (Task 1 Step 3, Task 8 Step 1) is what actually type-checks the new fields end-to-end.
- Do NOT touch `DefaultSubAgentContextBuilder` or `req.inputText` usage — material travels through `task`, not `context` (see spec §1).
- The objective task-shape change for planner-LLM plans is intentional (spec "Backward compatibility & deliberate behavior change"). Do not make it opt-in.
