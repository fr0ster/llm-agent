# Slice 2: Plan Reviewer Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional plan-reviewer gate between planning and execution in the DAG coordinator, and reconcile the planner so both roles run through the one `ISubAgent` path.

**Architecture:** A *role* is a typed adapter that owns a `DirectLlmSubAgent`, builds its `task` from typed input, calls `run()`, and parses the string `output` into a typed structure. `LlmDagPlanner` is refactored onto this pattern (removing its direct `ILlm.chat`). A new `IReviewStrategy` (with `LlmReviewStrategy` + `NoopReviewStrategy`) judges a `DagPlan`; `DagCoordinatorHandler` runs it as a fail-loud gate between `planner.plan()` and `interpreter.interpret()`. Selection is by presence of `coordinator.reviewer` in YAML.

**Tech Stack:** TypeScript (ESM, strict), Node `node:test` runner via `tsx`, Biome, monorepo workspaces.

**Spec:** `docs/superpowers/specs/2026-05-26-slice2-plan-reviewer-design.md`

**Conventions reminder:** ESM `.js` import extensions; interfaces start with `I`; tests live in `__tests__/` beside the unit, named `*.test.ts`; run a package's tests with `npm run test --workspace <pkg>`; build all with `npm run build`; lint with `npm run lint`.

---

### Task 1: `IReviewStrategy` contracts

**Files:**
- Create: `packages/llm-agent/src/interfaces/review.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (barrel)

- [ ] **Step 1: Create the contracts file**

Create `packages/llm-agent/src/interfaces/review.ts`:

```ts
import type { DagPlan } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ReviewInput {
  prompt: string;
  plan: DagPlan;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export type ReviewVerdict = { pass: true } | { pass: false; feedback: string };

export interface IReviewStrategy {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewVerdict>;
}
```

- [ ] **Step 2: Export from the barrel**

In `packages/llm-agent/src/interfaces/index.ts`, add after the planner export block (the `} from './planner.js';` line near line 80):

```ts
export type {
  IReviewStrategy,
  ReviewInput,
  ReviewVerdict,
} from './review.js';
```

- [ ] **Step 3: Build to verify it compiles and re-exports**

Run: `npm run build`
Expected: build succeeds (the root `src/index.ts` re-exports `interfaces/index.js` via `export * `, so the new types are public automatically).

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent/src/interfaces/review.ts packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(slice2): add IReviewStrategy contracts (ReviewInput/ReviewVerdict)"
```

---

### Task 2: Refactor `LlmDagPlanner` onto a `DirectLlmSubAgent`

This removes the slice-1 direct-`ILlm` call. Behavior (the combined prompt + the parsing/validation) must stay identical — guarded by the existing planner tests.

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-dag-planner.test.ts` (existing — must keep passing)

- [ ] **Step 1: Run the existing planner tests to confirm the green baseline**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`
Expected: `ℹ fail 0` (all existing tests pass before the refactor).

- [ ] **Step 2: Rewrite `llm-dag-planner.ts` to own a `DirectLlmSubAgent`**

Replace the full contents of `packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts` with:

```ts
import type {
  DagPlan,
  ILlm,
  IPlanner,
  PlanNode,
  PlannerInput,
} from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';

// Static planner instructions. The agent catalog and user prompt are NOT here —
// they are dynamic and go into the per-call `task` (see plan()).
const PLANNER_SYSTEM = `You are a planner. Decompose the user request into a DAG of tasks.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids),"needsInput"(optional bool)}.
Use "dependsOn" to express order/data-flow; independent nodes run in parallel.
If the request needs no decomposition, emit a SINGLE node.
Emit a plan-level "objective". Respond with ONLY:
{"objective":"...","nodes":[{"id":"n1","goal":"...","agent":"<worker name or omit>","dependsOn":[],"needsInput":false}]}`;

/**
 * Role adapter: owns a constrained `DirectLlmSubAgent` and turns its string
 * output into a typed `DagPlan`. (Slice 2: planner now flows through the one
 * ISubAgent path instead of calling ILlm directly.)
 */
export class LlmDagPlanner implements IPlanner {
  readonly name = 'llm-dag';
  private readonly agent: DirectLlmSubAgent;

  constructor(llm: ILlm) {
    this.agent = new DirectLlmSubAgent('planner', llm, {
      systemPrompt: PLANNER_SYSTEM,
      contextPolicy: 'optional',
    });
  }

  async plan(input: PlannerInput): Promise<DagPlan> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const task = `Available workers:\n${catalog || '(none)'}\n\n${input.prompt}`;

    const res = await this.agent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
      layer: 0,
    });
    const content = res.output;

    const match = content.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Planner output did not contain a JSON object: ${content.slice(0, 200)}`,
      );
    // Field values come straight from untrusted JSON, so they are typed as
    // `unknown` and validated below before being narrowed to PlanNode.
    let parsed: {
      objective?: unknown;
      rationale?: unknown;
      nodes?: Array<{
        id?: unknown;
        goal?: unknown;
        agent?: unknown;
        dependsOn?: unknown;
        needsInput?: unknown;
      }>;
    };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Planner output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      throw new Error(`Planner returned no nodes: ${match[0].slice(0, 200)}`);
    }
    if (
      parsed.objective !== undefined &&
      typeof parsed.objective !== 'string'
    ) {
      throw new Error(
        `Planner objective must be a string: ${JSON.stringify(parsed.objective)}`,
      );
    }
    if (
      parsed.rationale !== undefined &&
      typeof parsed.rationale !== 'string'
    ) {
      throw new Error(
        `Planner rationale must be a string: ${JSON.stringify(parsed.rationale)}`,
      );
    }
    const nodes: PlanNode[] = parsed.nodes.map((n, i) => {
      if (typeof n.goal !== 'string' || n.goal.trim() === '') {
        throw new Error(`Planner node is missing a goal: ${JSON.stringify(n)}`);
      }
      if (n.id !== undefined && typeof n.id !== 'string') {
        throw new Error(
          `Planner node has a non-string id: ${JSON.stringify(n)}`,
        );
      }
      if (n.agent !== undefined && typeof n.agent !== 'string') {
        throw new Error(
          `Planner node has a non-string agent: ${JSON.stringify(n)}`,
        );
      }
      if (
        n.dependsOn !== undefined &&
        (!Array.isArray(n.dependsOn) ||
          n.dependsOn.some((d) => typeof d !== 'string'))
      ) {
        throw new Error(
          `Planner node dependsOn must be an array of strings: ${JSON.stringify(n)}`,
        );
      }
      if (n.needsInput !== undefined && typeof n.needsInput !== 'boolean') {
        throw new Error(
          `Planner node needsInput must be a boolean: ${JSON.stringify(n)}`,
        );
      }
      return {
        id: (n.id as string | undefined) ?? `n${i + 1}`,
        goal: n.goal,
        agent: n.agent as string | undefined,
        dependsOn: n.dependsOn as string[] | undefined,
        needsInput: n.needsInput as boolean | undefined,
      };
    });
    return {
      nodes,
      objective: parsed.objective as string | undefined,
      rationale: parsed.rationale as string | undefined,
      createdAt: Date.now(),
    };
  }
}
```

- [ ] **Step 3: Run the existing planner tests — they must still pass unchanged**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`
Expected: `ℹ fail 0`. The existing fixtures (single-node, dependsOn, malformed-JSON throw, node-field-type rejects, objective/rationale rejects, "throws the LLM error when not ok") all still pass: the failing-LLM mock makes `DirectLlmSubAgent.run()` throw `res.error`, which propagates identically.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: build OK; lint reports `Fixed` at most formatting, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts
git commit -m "refactor(slice2): LlmDagPlanner owns a DirectLlmSubAgent (one ISubAgent path)"
```

---

### Task 3: `LlmReviewStrategy` + `NoopReviewStrategy`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/llm-review-strategy.ts`
- Create: `packages/llm-agent-libs/src/coordinator/dag/noop-review-strategy.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-review-strategy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-review-strategy.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan, ILlm, ReviewInput } from '@mcp-abap-adt/llm-agent';
import { LlmReviewStrategy } from '../llm-review-strategy.js';
import { NoopReviewStrategy } from '../noop-review-strategy.js';

function llm(content: string): ILlm {
  return { chat: async () => ({ ok: true, value: { content } }) } as unknown as ILlm;
}
const plan: DagPlan = {
  nodes: [{ id: 'n1', goal: 'do it', agent: 'w' }],
  createdAt: 0,
};
const input: ReviewInput = {
  prompt: 'do it',
  plan,
  agents: [{ name: 'w', description: 'worker' }],
  sessionId: 't',
};

describe('LlmReviewStrategy', () => {
  it('returns pass:true on a positive verdict', async () => {
    const v = await new LlmReviewStrategy(llm('{"pass": true}')).review(input);
    assert.deepEqual(v, { pass: true });
  });

  it('returns pass:false with feedback on a negative verdict', async () => {
    const v = await new LlmReviewStrategy(
      llm('{"pass": false, "feedback": "no worker can read tables"}'),
    ).review(input);
    assert.deepEqual(v, {
      pass: false,
      feedback: 'no worker can read tables',
    });
  });

  it('throws on malformed JSON', async () => {
    await assert.rejects(
      () => new LlmReviewStrategy(llm('not json')).review(input),
      /JSON/i,
    );
  });

  it('throws when pass is not a boolean', async () => {
    await assert.rejects(
      () => new LlmReviewStrategy(llm('{"pass": "yes"}')).review(input),
      /boolean 'pass'/,
    );
  });

  it('throws when a rejection has no feedback string', async () => {
    await assert.rejects(
      () => new LlmReviewStrategy(llm('{"pass": false}')).review(input),
      /feedback/,
    );
  });

  it('throws the LLM error when the call is not ok', async () => {
    const failing = {
      chat: async () => ({ ok: false, error: new Error('quota') }),
    } as unknown as ILlm;
    await assert.rejects(
      () => new LlmReviewStrategy(failing).review(input),
      /quota/,
    );
  });
});

describe('NoopReviewStrategy', () => {
  it('always passes', async () => {
    const v = await new NoopReviewStrategy().review(input);
    assert.deepEqual(v, { pass: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "review|fail|cannot find"`
Expected: FAIL — module `../llm-review-strategy.js` not found.

- [ ] **Step 3: Implement `NoopReviewStrategy`**

Create `packages/llm-agent-libs/src/coordinator/dag/noop-review-strategy.ts`:

```ts
import type { IReviewStrategy, ReviewVerdict } from '@mcp-abap-adt/llm-agent';

/** Always-pass reviewer. Explicit opt-out / test double. */
export class NoopReviewStrategy implements IReviewStrategy {
  readonly name = 'noop-review';
  async review(): Promise<ReviewVerdict> {
    return { pass: true };
  }
}
```

- [ ] **Step 4: Implement `LlmReviewStrategy`**

Create `packages/llm-agent-libs/src/coordinator/dag/llm-review-strategy.ts`:

```ts
import type {
  ILlm,
  IReviewStrategy,
  ReviewInput,
  ReviewVerdict,
} from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';

// Static critic instructions. The user prompt, plan and catalog are dynamic and
// go into the per-call `task` (see review()).
const REVIEWER_SYSTEM = `You are a plan reviewer. Given the user request, the available workers, and a proposed DAG plan, decide whether the plan can fulfil the request with those workers.
Respond with ONLY a JSON object:
{"pass": true}  — the plan is adequate
{"pass": false, "feedback": "<what is wrong or what must be clarified>"}  — otherwise`;

/**
 * Role adapter: owns a constrained `DirectLlmSubAgent` critic and turns its
 * string output into a typed `ReviewVerdict`.
 */
export class LlmReviewStrategy implements IReviewStrategy {
  readonly name = 'llm-review';
  private readonly agent: DirectLlmSubAgent;

  constructor(llm: ILlm) {
    this.agent = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: REVIEWER_SYSTEM,
      contextPolicy: 'optional',
    });
  }

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const task = `User request:\n${input.prompt}\n\nAvailable workers:\n${
      catalog || '(none)'
    }\n\nProposed plan (JSON):\n${JSON.stringify(input.plan)}`;

    const res = await this.agent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
      layer: 0,
    });

    const match = res.output.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Reviewer output did not contain a JSON object: ${res.output.slice(0, 200)}`,
      );
    let parsed: { pass?: unknown; feedback?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Reviewer output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (typeof parsed.pass !== 'boolean') {
      throw new Error(
        `Reviewer verdict must have a boolean 'pass': ${match[0].slice(0, 200)}`,
      );
    }
    if (parsed.pass === false) {
      if (typeof parsed.feedback !== 'string' || parsed.feedback.trim() === '') {
        throw new Error(
          `Reviewer rejection must include a non-empty 'feedback' string: ${match[0].slice(0, 200)}`,
        );
      }
      return { pass: false, feedback: parsed.feedback };
    }
    return { pass: true };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Build + lint, then commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/coordinator/dag/llm-review-strategy.ts \
        packages/llm-agent-libs/src/coordinator/dag/noop-review-strategy.ts \
        packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-review-strategy.test.ts
git commit -m "feat(slice2): LlmReviewStrategy + NoopReviewStrategy"
```

---

### Task 4: Reviewer gate in `DagCoordinatorHandler`

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator.test.ts` (existing)

The builder/pipeline need NO change: `withDagCoordinator(deps)` stores the whole deps object and the pipeline passes it to `new DagCoordinatorHandler(deps)`, so a new optional `reviewer` field on the deps flows through automatically.

- [ ] **Step 1: Write the failing tests**

In `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator.test.ts`, add these inside the `describe('DagCoordinatorHandler', ...)` block (after the last existing test, before the closing `});`). Note the test helpers `planner`, `interp`, `makeCtx` already exist in this file:

```ts
  it('passes through to interpret when the reviewer passes', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: true, output: '42' }),
      workers: new Map(),
      reviewer: { name: 'r', review: async () => ({ pass: true }) },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(yields[0].value.content, '42');
  });

  it('rejects the plan as COORDINATOR_PLAN_REJECTED when the reviewer fails', async () => {
    const { ctx, yields } = makeCtx('hi');
    let interpreted = false;
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: {
        name: 'i',
        interpret: async () => {
          interpreted = true;
          return { nodeResults: {}, ok: true, output: 'x' };
        },
      },
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => ({ pass: false, feedback: 'no reader worker' }),
      },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(interpreted, false); // gate blocks execution
    const err = (ctx as unknown as { error?: { code?: string; message?: string } }).error;
    assert.equal(err?.code, 'COORDINATOR_PLAN_REJECTED');
    assert.match(err?.message ?? '', /no reader worker/);
    assert.equal(yields.length, 0);
  });

  it('maps a reviewer throw to COORDINATOR_REVIEW_FAILED', async () => {
    const { ctx } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: true, output: 'x' }),
      workers: new Map(),
      reviewer: {
        name: 'r',
        review: async () => {
          throw new Error('critic boom');
        },
      },
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal(
      (ctx as unknown as { error?: { code?: string } }).error?.code,
      'COORDINATOR_REVIEW_FAILED',
    );
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail|reviewer"`
Expected: FAIL — `reviewer` is not a known property of the deps type / gate not implemented.

- [ ] **Step 3: Add `reviewer` to the deps interface**

In `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`, add `IReviewStrategy` to the type imports from `@mcp-abap-adt/llm-agent` (the existing import block at the top), and add the field to `DagCoordinatorHandlerDeps`:

```ts
  /** Optional plan reviewer. When present, the coordinator runs it as a gate
   *  between planning and execution; a non-pass verdict fails loud (batch).
   *  Absent → no gate. */
  reviewer?: IReviewStrategy;
```

(Add it right after the `activation?: IActivationStrategy;` field.)

- [ ] **Step 4: Insert the gate in `execute()`**

In `dag-coordinator.ts`, between the planner block (which ends by assigning `plan`) and the interpreter block (`let result: InterpretResult; try { result = await this.deps.interpreter.interpret(...) }`), insert:

```ts
    if (this.deps.reviewer) {
      let verdict: ReviewVerdict;
      try {
        verdict = await this.deps.reviewer.review({
          prompt: ctx.inputText,
          plan,
          agents: [...this.deps.workers.values()].map((w) => ({
            name: w.name,
            description: w.description,
          })),
          sessionId: ctx.sessionId,
          signal: ctx.options?.signal,
        });
      } catch (err) {
        ctx.error = new OrchestratorError(
          errMsg(err),
          'COORDINATOR_REVIEW_FAILED',
        );
        return false;
      }
      if (!verdict.pass) {
        ctx.error = new OrchestratorError(
          verdict.feedback,
          'COORDINATOR_PLAN_REJECTED',
        );
        return false;
      }
    }
```

Add `ReviewVerdict` to the type imports from `@mcp-abap-adt/llm-agent` as well (alongside `IReviewStrategy`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`
Expected: `ℹ fail 0` (new gate tests pass; all prior handler tests — no-reviewer path — still pass).

- [ ] **Step 6: Build + lint, then commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts \
        packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator.test.ts
git commit -m "feat(slice2): plan-reviewer gate in DagCoordinatorHandler (terminal)"
```

---

### Task 5: Config validation for `coordinator.reviewer`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts` (existing)

- [ ] **Step 1: Write the failing tests**

In `packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts`, add inside the `describe(...)` block (before the closing `});`):

```ts
  it('accepts a DAG coordinator with a reviewer', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planner: { type: 'llm' },
        reviewer: { type: 'llm', plannerLlm: 'helper' },
      }),
    );
  });
  it('rejects an unknown reviewer.type', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          reviewer: { type: 'bogus' },
        }),
      /reviewer: unknown type 'bogus'/,
    );
  });
  it('rejects a bad reviewer.plannerLlm', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          reviewer: { type: 'llm', plannerLlm: 'bogus' },
        }),
      /reviewer\.plannerLlm must be one of/,
    );
  });
  it('rejects reviewer in a linear coordinator', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planning: 'one-shot',
          reviewer: { type: 'llm' },
        }),
      /reviewer/,
    );
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail|reviewer"`
Expected: FAIL (reviewer not yet validated / not in DAG_ONLY).

- [ ] **Step 3: Extract a shared LLM-role validator and validate planner + reviewer with it**

In `packages/llm-agent-server/src/smart-agent/config.ts`:

(a) Add `'reviewer'` to the `DAG_ONLY` array:

```ts
const DAG_ONLY = ['planner', 'interpreter', 'reviewer'];
```

(b) Add this helper above `assertCoordinatorConfigShape`:

```ts
/** Validate a `{ type?: 'llm'; plannerLlm?: main|planner|helper }` role block. */
function assertLlmRoleShape(label: string, role: unknown): void {
  if (typeof role !== 'object' || role === null || Array.isArray(role)) {
    throw new Error(
      `coordinator.${label} must be an object (e.g. { type: llm }), got: ${JSON.stringify(role)}`,
    );
  }
  const kind = (role as { type?: unknown }).type;
  if (kind !== undefined && kind !== 'llm') {
    throw new Error(
      `coordinator.${label}: unknown type '${String(kind)}' (only 'llm' is supported)`,
    );
  }
  const sel = (role as { plannerLlm?: unknown }).plannerLlm;
  if (
    sel !== undefined &&
    sel !== 'main' &&
    sel !== 'planner' &&
    sel !== 'helper'
  ) {
    throw new Error(
      `coordinator.${label}.plannerLlm must be one of main | planner | helper, got: ${String(sel)}`,
    );
  }
}
```

(c) In `assertCoordinatorConfigShape`, replace the existing inline planner-shape validation (the `const planner = coord.planner; if (typeof planner !== 'object' ...) { ... } const plannerKind = ...; const plannerLlmSel = ...;` block inside `if (isDag) { ... }`) with calls to the helper, and validate the reviewer when present:

```ts
  if (isDag) {
    assertLlmRoleShape('planner', coord.planner);
    if (coord.reviewer !== undefined) {
      assertLlmRoleShape('reviewer', coord.reviewer);
    }
    for (const f of LINEAR_ONLY) {
      if (coord[f] !== undefined) {
        throw new Error(
          `coordinator: '${f}' is a linear-only field and cannot be combined with 'planner' (DAG mode)`,
        );
      }
    }
  } else {
    for (const f of DAG_ONLY) {
      if (coord[f] !== undefined) {
        throw new Error(
          `coordinator: '${f}' is a DAG-only field; a linear coordinator uses 'planning'/'dispatch'`,
        );
      }
    }
  }
```

(d) Add `reviewer?` to the `YamlCoordinator` type (the interface in this file that already declares `planner?` / `interpreter?`):

```ts
  reviewer?: { type?: string; plannerLlm?: 'main' | 'planner' | 'helper' };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"`
Expected: `ℹ fail 0` (new reviewer cases pass; the existing planner-shape cases still pass — they now run through `assertLlmRoleShape`, same messages).

- [ ] **Step 5: Build + lint, then commit**

```bash
npm run build && npm run lint
git add packages/llm-agent-server/src/smart-agent/config.ts \
        packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts
git commit -m "feat(slice2): validate coordinator.reviewer config (shared LLM-role validator)"
```

---

### Task 6: Wire the reviewer in the smart-server DAG branch

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts`

- [ ] **Step 1: Import the reviewer implementation**

In `smart-server.ts`, find the import that brings in `LlmDagPlanner` / `DagPlanInterpreter` from `@mcp-abap-adt/llm-agent-libs` and add `LlmReviewStrategy` to it. Add `IReviewStrategy` to the type import from `@mcp-abap-adt/llm-agent`.

- [ ] **Step 2: Build the reviewer and pass it to `withDagCoordinator`**

In the DAG branch (the `if (coordCfg.planner !== undefined) { ... }` block), after the `const planner = new LlmDagPlanner(plannerLlm);` line and before the `builder = builder.withDagCoordinator({...})` call, add:

```ts
        // Optional plan reviewer (presence of `coordinator.reviewer` = gate on).
        let reviewer: IReviewStrategy | undefined;
        if (coordCfg.reviewer !== undefined) {
          const reviewerBlock = coordCfg.reviewer as {
            plannerLlm?: 'main' | 'planner' | 'helper';
          };
          const reviewerLlm =
            reviewerBlock.plannerLlm === 'main'
              ? mainLlm
              : (helperLlm ?? mainLlm);
          reviewer = new LlmReviewStrategy(reviewerLlm);
        }
```

Then add `reviewer` to the `withDagCoordinator` call:

```ts
        builder = builder.withDagCoordinator({
          planner,
          interpreter,
          workers,
          activation,
          reviewer,
        });
```

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: build OK, no lint errors. (`reviewer` is `IReviewStrategy | undefined`, which matches the optional deps field.)

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts
git commit -m "feat(slice2): wire LlmReviewStrategy from coordinator.reviewer config"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm backward-compat guard still holds**

The existing server test `existing-coordinator-yaml-loads.test.ts` (and `dag-coordinator-config.test.ts` linear cases) guard that example YAMLs without a reviewer still validate as linear. Run:

Run: `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"`
Expected: `ℹ fail 0`.

- [ ] **Step 2: Run the whole suite across workspaces**

Run: `npm run test 2>&1 | grep -iE "ℹ fail [1-9]" || echo "NO FAILURES"`
Expected: `NO FAILURES`.

- [ ] **Step 3: Final build + lint:check**

Run: `npm run build && npm run lint:check`
Expected: build OK; `No fixes applied` (clean).

- [ ] **Step 4: Commit any formatting-only changes if present**

```bash
git status --short
# if anything is modified by lint, stage and commit:
git add -A && git commit -m "chore(slice2): formatting" || echo "nothing to commit"
```
