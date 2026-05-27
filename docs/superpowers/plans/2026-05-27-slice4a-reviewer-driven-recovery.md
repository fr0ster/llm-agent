# Slice 4a: Autonomous reviewer-driven recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a DAG node failure, let the reviewer replan the remaining objective against the current system state and have the interpreter swap to that plan and continue.

**Architecture:** Add an optional `IReviewStrategy.reviewExecutionFailure` (abort | revise-with-whole-remainder-plan); a `revise` `ErrorReaction` variant; a `ReviewerErrorStrategy` that delegates to the reviewer; two optional `ErrorContext` fields (`plan`, `completedResults`). The interpreter keeps a mutable `currentPlan`, passes it + the completed trace to the strategy, and on `revise` swaps the whole remaining plan (dropping old results), bounded by the existing per-run budget.

**Tech Stack:** TypeScript (ESM, strict), `node:test` via `tsx`, Biome, monorepo workspaces.

**Spec:** `docs/superpowers/specs/2026-05-27-slice4a-reviewer-driven-recovery-design.md`

**Conventions:** ESM `.js` import extensions; interfaces start with `I`; tests in `__tests__/` (`node:test`: `import { describe, it } from 'node:test'`, `import assert from 'node:assert/strict'`); `npm run test --workspace <pkg>`; `npm run build`; `npm run lint` (auto-fix) then `npm run lint:check`. The husky pre-commit "hook ignored / not executable" hint is harmless.

---

### Task 1: Contracts — execution-failure review + `revise` reaction

**Files:**
- Modify: `packages/llm-agent/src/interfaces/review.ts`
- Modify: `packages/llm-agent/src/interfaces/error-strategy.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (barrel)

- [ ] **Step 1: Extend `review.ts`** — replace its contents with:

```ts
import type { DagPlan } from './dag-plan.js';
import type { NodeResult } from './interpreter.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ReviewInput {
  prompt: string;
  plan: DagPlan;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export type ReviewVerdict = { pass: true } | { pass: false; feedback: string };

/** Input to the reviewer when a node FAILED during execution (slice 4a). */
export interface ExecutionFailureInput {
  objective?: string;
  /** The plan as it stands now. */
  plan: DagPlan;
  /** Completed/failed nodes so far — the reviewer's view of current state. */
  trace: NodeResult[];
  failedNodeId: string;
  error: string;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export type ExecutionReviewDecision =
  | { action: 'abort' }
  | { action: 'revise'; revisedPlan: DagPlan };

export interface IReviewStrategy {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewVerdict>;
  /** Decide recovery for an execution failure (slice 4a). OPTIONAL — a reviewer
   *  that omits it cannot drive recovery (the strategy treats that as abort). */
  reviewExecutionFailure?(
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewDecision>;
}
```

- [ ] **Step 2: Extend `error-strategy.ts`** — replace its contents with:

```ts
import type { DagPlan, PlanNode } from './dag-plan.js';
import type { NodeResult } from './interpreter.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ErrorContext {
  /** The composed task the failed node was given. */
  task: string;
  /** Replans/revises still allowed this run (the interpreter owns the counter). */
  remainingReplans: number;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  /** NEW (4a), OPTIONAL — the current plan and completed results, so a
   *  reviewer-driven strategy can replan the remainder against current state.
   *  Optional so external literals don't break; the interpreter always sets them. */
  plan?: DagPlan;
  completedResults?: NodeResult[];
}

export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan } // slice 3: local splice
  | { action: 'revise'; revisedPlan: DagPlan }; // slice 4a: whole-remainder swap

export interface IErrorStrategy {
  readonly name: string;
  /** Per-run budget ceiling (replan AND revise consume it). Default 4. */
  readonly maxReplans?: number;
  onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction>;
}
```

- [ ] **Step 3: Barrel** — in `packages/llm-agent/src/interfaces/index.ts`, find the existing `export type { ... } from './review.js';` block and add `ExecutionFailureInput` and `ExecutionReviewDecision` to it (Biome will sort). The `error-strategy.js` export block already exports `ErrorContext`/`ErrorReaction`/`IErrorStrategy` — no new names there.

- [ ] **Step 4: Build + lint** — `npm run build && npm run lint && npm run lint:check`. Expected: clean. (No runtime code changed; this compiles since `reviewExecutionFailure?` is optional and the `ErrorContext` fields are optional.)

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/review.ts packages/llm-agent/src/interfaces/error-strategy.ts packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(slice4a): contracts — reviewExecutionFailure + revise ErrorReaction"
```

---

### Task 2: Reviewer `reviewExecutionFailure` implementations

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dag/llm-review-strategy.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dag/noop-review-strategy.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-review-strategy.test.ts` (existing — extend)

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe('LlmReviewStrategy', ...)` block in `llm-review-strategy.test.ts` (the `llm(content)` helper already exists). Also add the new imports at the top: `type ExecutionFailureInput`, `type NodeResult` from `@mcp-abap-adt/llm-agent`. Add:

```ts
  const failInput: ExecutionFailureInput = {
    objective: 'build it',
    plan: { nodes: [{ id: 'n1', goal: 'do', agent: 'w' }], createdAt: 0 },
    trace: [
      { nodeId: 'n0', output: 'created table T', status: 'done', durationMs: 1 },
    ] as NodeResult[],
    failedNodeId: 'n1',
    error: 'table already exists',
    agents: [{ name: 'w', description: 'worker' }],
    sessionId: 't',
  };

  it('reviewExecutionFailure parses a revise decision', async () => {
    const s = new LlmReviewStrategy(
      llm('{"action":"revise","plan":{"nodes":[{"id":"r1","goal":"modify table T","agent":"w"}],"createdAt":0}}'),
    );
    const d = await s.reviewExecutionFailure!(failInput);
    assert.equal(d.action, 'revise');
    assert.equal(
      d.action === 'revise' ? d.revisedPlan.nodes[0].goal : '',
      'modify table T',
    );
  });

  it('reviewExecutionFailure parses an abort decision', async () => {
    const s = new LlmReviewStrategy(llm('{"action":"abort"}'));
    const d = await s.reviewExecutionFailure!(failInput);
    assert.deepEqual(d, { action: 'abort' });
  });

  it('reviewExecutionFailure throws on malformed JSON', async () => {
    const s = new LlmReviewStrategy(llm('not json'));
    await assert.rejects(() => s.reviewExecutionFailure!(failInput), /JSON/i);
  });

  it('reviewExecutionFailure throws on a revise with no nodes', async () => {
    const s = new LlmReviewStrategy(
      llm('{"action":"revise","plan":{"nodes":[],"createdAt":0}}'),
    );
    await assert.rejects(
      () => s.reviewExecutionFailure!(failInput),
      /no nodes|empty/i,
    );
  });
```

Add to the `NoopReviewStrategy` describe block:

```ts
  it('reviewExecutionFailure always aborts', async () => {
    const d = await new NoopReviewStrategy().reviewExecutionFailure!({
      plan: { nodes: [], createdAt: 0 },
      trace: [],
      failedNodeId: 'x',
      error: 'e',
      agents: [],
      sessionId: 't',
    });
    assert.deepEqual(d, { action: 'abort' });
  });
```

- [ ] **Step 2: Run to verify failure** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "reviewExecutionFailure|fail|is not a function"`. Expected: failures (method undefined).

- [ ] **Step 3: Implement in `llm-review-strategy.ts`** — add the new types to the import from `@mcp-abap-adt/llm-agent` (`ExecutionFailureInput`, `ExecutionReviewDecision`), add a second static prompt constant, and add the method. Add this constant near `REVIEWER_SYSTEM`:

```ts
const EXECUTION_REVIEW_SYSTEM = `You are a recovery reviewer. A step of a DAG plan FAILED during execution. You are given the objective, the current plan, the execution trace (what already ran and its output — this reflects the CURRENT system state), the failed step id, and the error.
Decide recovery and respond with ONLY a JSON object:
{"action":"abort"}  — if recovery is not possible
{"action":"revise","plan":{"nodes":[{"id":"...","goal":"...","agent":"<worker or omit>","dependsOn":[],"needsInput":false}],"objective":"..."}}  — a NEW plan for the REMAINING objective.
The revised plan MUST treat the current state as the starting point: do not redo work already done (per the trace); if an artifact already exists, modify it instead of recreating it (idempotent/adaptive).`;
```

Add the method to the class:

```ts
  async reviewExecutionFailure(
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewDecision> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const traceText = input.trace
      .map((r) => `- ${r.nodeId} [${r.status}]: ${r.output || r.error || ''}`)
      .join('\n');
    const task = `Objective: ${input.objective ?? '(none)'}\n\nAvailable workers:\n${
      catalog || '(none)'
    }\n\nCurrent plan (JSON):\n${JSON.stringify(input.plan)}\n\nExecution trace (current state):\n${
      traceText || '(nothing completed)'
    }\n\nFailed step: ${input.failedNodeId}\nError: ${input.error}`;

    const res = await this.executionAgent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
    });

    const match = res.output.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Recovery reviewer output did not contain a JSON object: ${res.output.slice(0, 200)}`,
      );
    let parsed: { action?: unknown; plan?: unknown };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Recovery reviewer output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (parsed.action === 'abort') return { action: 'abort' };
    if (parsed.action !== 'revise') {
      throw new Error(
        `Recovery reviewer action must be 'abort' | 'revise': ${match[0].slice(0, 200)}`,
      );
    }
    const plan = parsed.plan as { nodes?: unknown } | undefined;
    if (
      !plan ||
      !Array.isArray(plan.nodes) ||
      plan.nodes.length === 0 ||
      plan.nodes.some(
        (n) =>
          typeof (n as { id?: unknown }).id !== 'string' ||
          typeof (n as { goal?: unknown }).goal !== 'string' ||
          ((n as { goal?: string }).goal ?? '').trim() === '',
      )
    ) {
      throw new Error(
        `Recovery reviewer revise plan must have non-empty nodes with string id+goal: ${match[0].slice(0, 200)}`,
      );
    }
    return { action: 'revise', revisedPlan: plan as DagPlan };
  }
```

(Add `DagPlan` to the `import type { ... } from '@mcp-abap-adt/llm-agent'` block at
the top of `llm-review-strategy.ts` for the `plan as DagPlan` cast.)

Add a second `DirectLlmSubAgent` for execution review in the constructor (the plan-gate critic and the recovery critic use different system prompts):

```ts
  private readonly executionAgent: DirectLlmSubAgent;
  // ...in constructor, after this.agent = ...:
    this.executionAgent = new DirectLlmSubAgent('recovery-reviewer', llm, {
      systemPrompt: EXECUTION_REVIEW_SYSTEM,
      contextPolicy: 'optional',
    });
```

- [ ] **Step 4: Implement in `noop-review-strategy.ts`** — add the method (and import the types):

```ts
import type {
  ExecutionReviewDecision,
  IReviewStrategy,
  ReviewVerdict,
} from '@mcp-abap-adt/llm-agent';

/** Always-pass reviewer; always-abort recovery. Explicit opt-out / test double. */
export class NoopReviewStrategy implements IReviewStrategy {
  readonly name = 'noop-review';
  async review(): Promise<ReviewVerdict> {
    return { pass: true };
  }
  async reviewExecutionFailure(): Promise<ExecutionReviewDecision> {
    return { action: 'abort' };
  }
}
```

- [ ] **Step 5: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0`.

- [ ] **Step 6: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag/llm-review-strategy.ts packages/llm-agent-libs/src/coordinator/dag/noop-review-strategy.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-review-strategy.test.ts
git commit -m "feat(slice4a): reviewExecutionFailure on Llm/Noop review strategies"
```

---

### Task 3: `ReviewerErrorStrategy`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/reviewer-error-strategy.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/index.ts` + `packages/llm-agent-libs/src/index.ts` (barrels)
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/reviewer-error-strategy.test.ts`

- [ ] **Step 1: Write the failing test**:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ErrorContext,
  ExecutionFailureInput,
  IReviewStrategy,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';
import { ReviewerErrorStrategy } from '../reviewer-error-strategy.js';

const node: PlanNode = { id: 'n1', goal: 'do' };
const plan: DagPlan = { nodes: [node], objective: 'O', createdAt: 0 };
const revised: DagPlan = { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 };

function ctx(over: Partial<ErrorContext> = {}): ErrorContext {
  return {
    task: 'Task: do',
    remainingReplans: 4,
    agents: [{ name: 'w' }],
    sessionId: 't',
    plan,
    completedResults: [
      { nodeId: 'n0', output: 'state', status: 'done', durationMs: 1 },
    ],
    ...over,
  };
}
function reviewer(
  cap: { input?: ExecutionFailureInput },
  decision: Awaited<ReturnType<NonNullable<IReviewStrategy['reviewExecutionFailure']>>>,
): IReviewStrategy {
  return {
    name: 'r',
    review: async () => ({ pass: true }),
    reviewExecutionFailure: async (input) => {
      cap.input = input;
      return decision;
    },
  };
}

describe('ReviewerErrorStrategy', () => {
  it('maps a revise decision to a revise reaction and forwards plan+trace', async () => {
    const cap: { input?: ExecutionFailureInput } = {};
    const r = await new ReviewerErrorStrategy(
      reviewer(cap, { action: 'revise', revisedPlan: revised }),
    ).onNodeFailure(node, new Error('boom'), ctx());
    assert.deepEqual(r, { action: 'revise', revisedPlan: revised });
    assert.equal(cap.input?.failedNodeId, 'n1');
    assert.equal(cap.input?.objective, 'O');
    assert.equal(cap.input?.trace.length, 1);
  });

  it('maps an abort decision to abort', async () => {
    const r = await new ReviewerErrorStrategy(
      reviewer({}, { action: 'abort' }),
    ).onNodeFailure(node, new Error('boom'), ctx());
    assert.deepEqual(r, { action: 'abort' });
  });

  it('aborts without calling the reviewer when budget exhausted', async () => {
    const cap: { input?: ExecutionFailureInput } = {};
    const r = await new ReviewerErrorStrategy(
      reviewer(cap, { action: 'revise', revisedPlan: revised }),
    ).onNodeFailure(node, new Error('boom'), ctx({ remainingReplans: 0 }));
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.input, undefined);
  });

  it('aborts when the reviewer cannot do recovery (no method)', async () => {
    const bare: IReviewStrategy = { name: 'r', review: async () => ({ pass: true }) };
    const r = await new ReviewerErrorStrategy(bare).onNodeFailure(
      node,
      new Error('boom'),
      ctx(),
    );
    assert.deepEqual(r, { action: 'abort' });
  });

  it('aborts when plan/completedResults are absent', async () => {
    const cap: { input?: ExecutionFailureInput } = {};
    const r = await new ReviewerErrorStrategy(
      reviewer(cap, { action: 'revise', revisedPlan: revised }),
    ).onNodeFailure(node, new Error('boom'), ctx({ plan: undefined }));
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.input, undefined);
  });

  it('exposes maxReplans', () => {
    assert.equal(
      new ReviewerErrorStrategy(reviewer({}, { action: 'abort' }), 2).maxReplans,
      2,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "reviewer-error|cannot find|fail"`. Expected: module-not-found.

- [ ] **Step 3: Implement `reviewer-error-strategy.ts`**:

```ts
import type {
  ErrorContext,
  ErrorReaction,
  IErrorStrategy,
  IReviewStrategy,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';

/**
 * Error strategy that delegates recovery to the reviewer: on a node failure it
 * asks the reviewer to replan the REMAINING objective against current state
 * (`reviewExecutionFailure`), returning a `revise` reaction (whole-remainder
 * swap) or `abort`. Stateless — the interpreter owns the per-run budget.
 */
export class ReviewerErrorStrategy implements IErrorStrategy {
  readonly name = 'reviewer';
  constructor(
    private readonly reviewer: IReviewStrategy,
    readonly maxReplans = 4,
  ) {}

  async onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction> {
    if (
      ctx.remainingReplans <= 0 ||
      !this.reviewer.reviewExecutionFailure ||
      !ctx.plan ||
      !ctx.completedResults
    ) {
      return { action: 'abort' };
    }
    const decision = await this.reviewer.reviewExecutionFailure({
      objective: ctx.plan.objective,
      plan: ctx.plan,
      trace: ctx.completedResults,
      failedNodeId: node.id,
      error: error instanceof Error ? error.message : String(error),
      agents: ctx.agents,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    });
    if (decision.action === 'revise') {
      return { action: 'revise', revisedPlan: decision.revisedPlan };
    }
    return { action: 'abort' };
  }
}
```

- [ ] **Step 4: Barrels** — in `packages/llm-agent-libs/src/coordinator/index.ts` add `export { ReviewerErrorStrategy } from './dag/reviewer-error-strategy.js';`. In `packages/llm-agent-libs/src/index.ts` add `ReviewerErrorStrategy` to the named re-export block from `./coordinator/index.js`.

- [ ] **Step 5: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0`.

- [ ] **Step 6: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag/reviewer-error-strategy.ts packages/llm-agent-libs/src/coordinator/index.ts packages/llm-agent-libs/src/index.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/reviewer-error-strategy.test.ts
git commit -m "feat(slice4a): ReviewerErrorStrategy (delegates recovery to the reviewer)"
```

---

### Task 4: Interpreter — `currentPlan`, pass trace, handle `revise`

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts` (existing — extend)

- [ ] **Step 1: Write the failing tests** — at the top of the test file add `import { ReviewerErrorStrategy } from '../reviewer-error-strategy.js';`. Inside the `describe('DagPlanInterpreter', ...)` block add:

```ts
  it('revises the whole remaining plan on failure and runs it (state-baselined)', async () => {
    let bigCalls = 0;
    const big = worker('big', async () => {
      bigCalls++;
      throw new Error('table already exists');
    });
    const fix = worker('fix', async () => ({ output: 'fixed' }));
    const reviewer = {
      name: 'r',
      review: async () => ({ pass: true as const }),
      reviewExecutionFailure: async () => ({
        action: 'revise' as const,
        revisedPlan: {
          nodes: [{ id: 'f1', goal: 'modify table', agent: 'fix' }],
          createdAt: 0,
        },
      }),
    };
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'create table', agent: 'big' }]),
      ctx([['big', big], ['fix', fix]], new ReviewerErrorStrategy(reviewer, 4)),
    );
    assert.equal(r.ok, true);
    assert.equal(r.output, 'fixed');
    assert.equal(bigCalls, 1); // old failed node not re-run; replaced by revised plan
  });

  it('revise with an empty plan fails loud (COORDINATOR_PLAN_INVALID)', async () => {
    const big = worker('big', async () => {
      throw new Error('boom');
    });
    const reviewer = {
      name: 'r',
      review: async () => ({ pass: true as const }),
      reviewExecutionFailure: async () => ({
        action: 'revise' as const,
        revisedPlan: { nodes: [], createdAt: 0 },
      }),
    };
    await assert.rejects(
      () =>
        I().interpret(
          dag([{ id: 'n1', goal: 'g', agent: 'big' }]),
          ctx([['big', big]], new ReviewerErrorStrategy(reviewer, 4)),
        ),
      /COORDINATOR_PLAN_INVALID/,
    );
  });
```

- [ ] **Step 2: Run to verify failure** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: failures (revise not handled).

- [ ] **Step 3: Rewrite the `interpret()` body** — replace the body from `const results: Record<string, NodeResult> = {};` through the closing `}` of `interpret()` with this (introduces `currentPlan`, passes `plan`/`completedResults`, handles `revise` with same-wave precedence):

```ts
    const results: Record<string, NodeResult> = {};
    const done = new Set<string>();
    let currentPlan = plan;
    const maxReplans = ctx.errorStrategy.maxReplans ?? 4;
    let replansUsed = 0;

    for (;;) {
      const ready = currentPlan.nodes.filter(
        (n) =>
          !(n.id in results) && (n.dependsOn ?? []).every((d) => done.has(d)),
      );
      if (ready.length === 0) break;

      type Outcome =
        | { node: PlanNode; kind: 'done'; output: string; durationMs: number }
        | {
            node: PlanNode;
            kind: 'failed';
            error: unknown;
            task: string;
            durationMs: number;
          };
      const planForWave = currentPlan;
      const outcomes = await Promise.all(
        ready.map(async (n): Promise<Outcome> => {
          const depOutputs: Record<string, string> = {};
          for (const d of n.dependsOn ?? []) depOutputs[d] = results[d].output;
          const task = composeNodeTask(n, planForWave, ctx.inputText, depOutputs);
          const started = Date.now();
          try {
            const res = await this.resolveWorker(n, ctx).run({
              task,
              sessionId: ctx.sessionId,
              signal: ctx.signal,
            });
            if (res.errorClass === 'epicfail') {
              return {
                node: n,
                kind: 'failed',
                error: new Error('epicfail'),
                task,
                durationMs: Date.now() - started,
              };
            }
            return {
              node: n,
              kind: 'done',
              output: res.output,
              durationMs: Date.now() - started,
            };
          } catch (error) {
            return {
              node: n,
              kind: 'failed',
              error,
              task,
              durationMs: Date.now() - started,
            };
          }
        }),
      );

      let splicedThisWave = false;
      // Record successes first, then process failures in plan-node order.
      for (const o of outcomes) {
        if (o.kind !== 'done') continue;
        results[o.node.id] = {
          nodeId: o.node.id,
          output: o.output,
          status: 'done',
          durationMs: o.durationMs,
        };
        done.add(o.node.id);
      }
      const failures = outcomes.filter(
        (o): o is Extract<Outcome, { kind: 'failed' }> => o.kind === 'failed',
      );
      let revised = false;
      for (const o of failures) {
        if (revised) break;
        const remainingReplans = maxReplans - replansUsed;
        const reaction = await ctx.errorStrategy.onNodeFailure(o.node, o.error, {
          task: o.task,
          remainingReplans,
          agents: [...ctx.workers.values()].map((w) => ({
            name: w.name,
            description: w.description,
          })),
          sessionId: ctx.sessionId,
          signal: ctx.signal,
          plan: currentPlan,
          completedResults: Object.values(results),
        });
        if (reaction.action === 'replan' && remainingReplans > 0) {
          if (reaction.subPlan.nodes.length === 0) {
            throw new PlanInvalidError(
              `COORDINATOR_PLAN_INVALID: replan for node '${o.node.id}' produced an empty sub-plan`,
            );
          }
          currentPlan = spliceSubPlan(currentPlan, o.node.id, reaction.subPlan);
          replansUsed++;
          splicedThisWave = true;
        } else if (reaction.action === 'revise' && remainingReplans > 0) {
          if (reaction.revisedPlan.nodes.length === 0) {
            throw new PlanInvalidError(
              `COORDINATOR_PLAN_INVALID: revise for node '${o.node.id}' produced an empty plan`,
            );
          }
          // Whole-remainder swap: supersede the entire wave. Drop all results
          // (completed work lives in the world + was given to the reviewer as
          // trace); run the revised plan from scratch.
          currentPlan = reaction.revisedPlan;
          for (const key of Object.keys(results)) delete results[key];
          done.clear();
          replansUsed++;
          splicedThisWave = true;
          revised = true;
        } else {
          results[o.node.id] = {
            nodeId: o.node.id,
            output: '',
            status: 'failed',
            error: o.error instanceof Error ? o.error.message : String(o.error),
            durationMs: o.durationMs,
          };
        }
      }

      if (splicedThisWave) this.validate(currentPlan, ctx);
    }

    for (const n of currentPlan.nodes) {
      if (!(n.id in results)) {
        results[n.id] = {
          nodeId: n.id,
          output: '',
          status: 'skipped',
          durationMs: 0,
        };
      }
    }

    const failed = currentPlan.nodes.filter(
      (n) => results[n.id].status !== 'done',
    );
    if (failed.length > 0) {
      const first = currentPlan.nodes.find(
        (n) => results[n.id].status === 'failed',
      );
      return {
        nodeResults: results,
        ok: false,
        error: first
          ? `node '${first.id}' failed: ${results[first.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
      };
    }

    const depended = new Set(
      currentPlan.nodes.flatMap((n) => n.dependsOn ?? []),
    );
    const terminals = currentPlan.nodes.filter((n) => !depended.has(n.id));
    const output = terminals.map((n) => results[n.id].output).join('\n\n');
    return { nodeResults: results, ok: true, output };
```

Notes for the implementer:
- This removes the old `liveNodes` variable in favor of `currentPlan` (a `DagPlan`, not a node array). `spliceSubPlan(currentPlan, id, subPlan)` already returns a `DagPlan`, so assign it directly.
- `composeNodeTask` now receives `planForWave` (a snapshot of `currentPlan` at wave start) so a mid-wave revise doesn't change tasks already composed.
- The `validate(currentPlan, ctx)` call replaces the old `validate({ ...plan, nodes: liveNodes }, ctx)`.
- The top-of-method `this.validate(plan, ctx)` (initial validation) stays unchanged.

- [ ] **Step 4: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0` (new revise tests pass; all slice-1/2/3 interpreter tests — replan, budget, concurrent-wave, contextPolicy — still pass; the `currentPlan` rename is behavior-preserving for them).

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
git commit -m "feat(slice4a): interpreter currentPlan + revise reaction (whole-remainder swap)"
```

---

### Task 5: Config + smart-server wiring for `errorStrategy: reviewer`

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts` (existing)

- [ ] **Step 1: Failing config tests** — add inside the describe block:

```ts
  it('accepts errorStrategy reviewer with maxReplans', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planner: { type: 'llm' },
        reviewer: { type: 'llm' },
        errorStrategy: { type: 'reviewer', maxReplans: 2 },
      }),
    );
  });
  it('still rejects an unknown errorStrategy.type', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          errorStrategy: { type: 'bogus' },
        }),
      /errorStrategy: unknown type 'bogus'/,
    );
  });
```

- [ ] **Step 2: Run to verify** — `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "reviewer|fail"`. Expected: the `reviewer` case fails (type not allowed yet).

- [ ] **Step 3: Config — allow `reviewer` type** — in `config.ts` `assertErrorStrategyShape`, update the type check to include `'reviewer'`:

```ts
  if (type !== undefined && type !== 'abort' && type !== 'replan' && type !== 'reviewer') {
    throw new Error(
      `coordinator.errorStrategy: unknown type '${String(type)}' (only 'abort' | 'replan' | 'reviewer')`,
    );
  }
```

- [ ] **Step 4: Server wiring** — in `smart-server.ts`:
  - add `ReviewerErrorStrategy` to the import from `@mcp-abap-adt/llm-agent-libs` (alongside `AbortErrorStrategy`/`ReplanErrorStrategy`).
  - in the DAG branch, the existing block builds `errorStrategy` from `esCfg.type` (`replan` → ReplanErrorStrategy; `abort` → AbortErrorStrategy). Add a `reviewer` arm. The `reviewer` variable is already built earlier in the same branch. Replace the existing if/else chain with:

```ts
        let errorStrategy: IErrorStrategy | undefined;
        if (esCfg?.type === 'replan') {
          errorStrategy = new ReplanErrorStrategy(planner, esCfg.maxReplans);
        } else if (esCfg?.type === 'abort') {
          errorStrategy = new AbortErrorStrategy();
        } else if (esCfg?.type === 'reviewer') {
          if (!reviewer) {
            throw new Error(
              "coordinator.errorStrategy.type='reviewer' requires a configured coordinator.reviewer",
            );
          }
          errorStrategy = new ReviewerErrorStrategy(reviewer, esCfg.maxReplans);
        }
```

- [ ] **Step 5: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0`.

- [ ] **Step 6: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts
git commit -m "feat(slice4a): wire coordinator.errorStrategy=reviewer (requires reviewer)"
```

---

### Task 6: Full verification

- [ ] **Step 1: Backward-compat guard** — `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"` → `ℹ fail 0` (existing example-YAML and abort/replan config tests unchanged).

- [ ] **Step 2: Full suite** — `npm run test 2>&1 | grep -iE "ℹ fail [1-9]" || echo "NO FAILURES"` → `NO FAILURES`.

- [ ] **Step 3: Build + lint:check** — `npm run build && npm run lint:check`. Expected: clean (no new warnings).

- [ ] **Step 4: Commit any formatting** — `git add -A && git commit -m "chore(slice4a): formatting" || echo "nothing to commit"`.
