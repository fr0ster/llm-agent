# Slice 3: Replan-by-leaf-signal + remove nested dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dynamic decomposition (a worker signals a node is too big → the coordinator re-plans it into a finer sub-graph) and remove the nested-dispatch surface so subagents are always leaves.

**Architecture:** Part A is additive: a `NeedsDecompositionError` exception + an `IErrorStrategy` (interpreter/execution strategy) the `DagPlanInterpreter` consults on a node failure (`abort` | `replan`); replan splices a planner-produced sub-DAG into the running plan; the interpreter owns a per-run replan budget. Part B is a breaking removal (major bump) of the layer/kind/canDispatchChildren/maxLayer nesting surface across interfaces and call sites; the linear `CoordinatorHandler` becomes leaves-only; existing YAML stays loadable (`coordinator.maxLayer` tolerated/ignored).

**Tech Stack:** TypeScript (ESM, strict), `node:test` via `tsx`, Biome, monorepo workspaces.

**Spec:** `docs/superpowers/specs/2026-05-26-slice3-replan-and-remove-nested-dispatch-design.md`

**Conventions:** ESM `.js` import extensions; interfaces start with `I`; tests in `__tests__/` (`node:test`); `npm run test --workspace <pkg>`; `npm run build`; `npm run lint`. The husky pre-commit "hook ignored / not executable" hint is harmless.

**Ordering rule for Part B:** removing a required field breaks compilation everywhere it is used. Each Part-B task removes a field **together with all its readers/writers in the same commit**, so `npm run build` is green after every commit. Use the compiler as the guide: remove the field, run `npm run build`, delete the now-erroring usages.

---

## PART A — Replan-by-leaf-signal (additive)

### Task 1: Contracts — `NeedsDecompositionError`, `IErrorStrategy`

**Files:**
- Create: `packages/llm-agent/src/needs-decomposition-error.ts`
- Create: `packages/llm-agent/src/interfaces/error-strategy.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (barrel)
- Modify: `packages/llm-agent/src/index.ts` (export the error class)

- [ ] **Step 1: Create the error class** `packages/llm-agent/src/needs-decomposition-error.ts`:

```ts
/**
 * Thrown by a worker when its node cannot be done as-is and needs to be broken
 * into a finer sub-graph. An abnormal/exceptional outcome (the node produced no
 * usable output) — handled by the interpreter's IErrorStrategy.
 */
export class NeedsDecompositionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`needs decomposition: ${reason}`);
    this.name = 'NeedsDecompositionError';
    this.reason = reason;
  }
}
```

- [ ] **Step 2: Create the strategy contracts** `packages/llm-agent/src/interfaces/error-strategy.ts`:

```ts
import type { DagPlan, PlanNode } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ErrorContext {
  /** The composed task the failed node was given (goal + dep outputs + user
   *  input) — so a replan re-plans with full context, not the bare goal. */
  task: string;
  /** Replans still allowed this run (maxReplans - replansUsed), set by the
   *  interpreter. A replan-capable strategy MUST return `{ action: 'abort' }`
   *  with no planner/LLM call when this is <= 0. */
  remainingReplans: number;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan };

export interface IErrorStrategy {
  readonly name: string;
  /** Replan budget ceiling for an interpret run; the interpreter owns the
   *  counter and reads this once. Omitted → interpreter default ceiling (4). */
  readonly maxReplans?: number;
  onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction>;
}
```

- [ ] **Step 3: Barrel exports** — in `packages/llm-agent/src/interfaces/index.ts`, add (alphabetical placement is auto-fixed by Biome):

```ts
export type {
  ErrorContext,
  ErrorReaction,
  IErrorStrategy,
} from './error-strategy.js';
```

In `packages/llm-agent/src/index.ts`, add a value export for the error class (it is a runtime class, not just a type):

```ts
export { NeedsDecompositionError } from './needs-decomposition-error.js';
```

- [ ] **Step 4: Build** — `npm run build && npm run lint && npm run lint:check`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/needs-decomposition-error.ts packages/llm-agent/src/interfaces/error-strategy.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(slice3): NeedsDecompositionError + IErrorStrategy contracts"
```

---

### Task 2: `AbortErrorStrategy` + `ReplanErrorStrategy`

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/abort-error-strategy.ts`
- Create: `packages/llm-agent-libs/src/coordinator/dag/replan-error-strategy.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/index.ts` (barrel) + `packages/llm-agent-libs/src/index.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/replan-error-strategy.test.ts`

- [ ] **Step 1: Write the failing test** `__tests__/replan-error-strategy.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type DagPlan,
  type ErrorContext,
  type IPlanner,
  NeedsDecompositionError,
  type PlanNode,
} from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../abort-error-strategy.js';
import { ReplanErrorStrategy } from '../replan-error-strategy.js';

const node: PlanNode = { id: 'n1', goal: 'big task' };
const subPlan: DagPlan = { nodes: [{ id: 's1', goal: 'small' }], createdAt: 0 };
function ctx(remainingReplans: number): ErrorContext {
  return {
    task: 'Task: big task',
    remainingReplans,
    agents: [{ name: 'w' }],
    sessionId: 't',
  };
}
function planner(captured: { prompt?: string }): IPlanner {
  return {
    name: 'p',
    plan: async (input) => {
      captured.prompt = input.prompt;
      return subPlan;
    },
  };
}

describe('AbortErrorStrategy', () => {
  it('always aborts', async () => {
    const r = await new AbortErrorStrategy().onNodeFailure(
      node,
      new NeedsDecompositionError('too big'),
      ctx(5),
    );
    assert.deepEqual(r, { action: 'abort' });
  });
});

describe('ReplanErrorStrategy', () => {
  it('replans on NeedsDecompositionError using the composed task + reason', async () => {
    const cap: { prompt?: string } = {};
    const r = await new ReplanErrorStrategy(planner(cap), 4).onNodeFailure(
      node,
      new NeedsDecompositionError('too big'),
      ctx(4),
    );
    assert.deepEqual(r, { action: 'replan', subPlan });
    assert.match(cap.prompt ?? '', /Task: big task/);
    assert.match(cap.prompt ?? '', /too big/);
  });

  it('aborts on a generic error without calling the planner', async () => {
    const cap: { prompt?: string } = {};
    const r = await new ReplanErrorStrategy(planner(cap), 4).onNodeFailure(
      node,
      new Error('mcp timeout'),
      ctx(4),
    );
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.prompt, undefined); // planner NOT called
  });

  it('aborts without calling the planner when the budget is exhausted', async () => {
    const cap: { prompt?: string } = {};
    const r = await new ReplanErrorStrategy(planner(cap), 4).onNodeFailure(
      node,
      new NeedsDecompositionError('too big'),
      ctx(0),
    );
    assert.deepEqual(r, { action: 'abort' });
    assert.equal(cap.prompt, undefined);
  });

  it('exposes maxReplans', () => {
    assert.equal(new ReplanErrorStrategy(planner({}), 3).maxReplans, 3);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "error-strategy|cannot find|fail"`. Expected: module-not-found failure.

- [ ] **Step 3: Implement `AbortErrorStrategy`** `abort-error-strategy.ts`:

```ts
import type {
  ErrorReaction,
  IErrorStrategy,
} from '@mcp-abap-adt/llm-agent';

/** Default reaction: a failed node fails the plan (slice-1/2 behavior). */
export class AbortErrorStrategy implements IErrorStrategy {
  readonly name = 'abort';
  async onNodeFailure(): Promise<ErrorReaction> {
    return { action: 'abort' };
  }
}
```

- [ ] **Step 4: Implement `ReplanErrorStrategy`** `replan-error-strategy.ts`:

```ts
import {
  type ErrorContext,
  type ErrorReaction,
  type IErrorStrategy,
  type IPlanner,
  NeedsDecompositionError,
  type PlanNode,
} from '@mcp-abap-adt/llm-agent';

/**
 * Replans a node ONLY for NeedsDecompositionError (the explicit "decompose me"
 * signal). Any other error → abort (a transient MCP/LLM failure is not fixed by
 * decomposition). Stateless: holds the maxReplans ceiling but never counts — the
 * interpreter owns the per-run counter and passes `remainingReplans`.
 */
export class ReplanErrorStrategy implements IErrorStrategy {
  readonly name = 'replan';
  constructor(
    private readonly planner: IPlanner,
    readonly maxReplans = 4,
  ) {}

  async onNodeFailure(
    _node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction> {
    if (!(error instanceof NeedsDecompositionError)) {
      return { action: 'abort' };
    }
    if (ctx.remainingReplans <= 0) {
      return { action: 'abort' }; // budget exhausted — no planner/LLM call
    }
    const subPlan = await this.planner.plan({
      prompt: `${ctx.task}\n\nThis task needs decomposition: ${error.reason}`,
      agents: ctx.agents,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    });
    return { action: 'replan', subPlan };
  }
}
```

- [ ] **Step 5: Barrels** — in `packages/llm-agent-libs/src/coordinator/index.ts` add:

```ts
export { AbortErrorStrategy } from './dag/abort-error-strategy.js';
export { ReplanErrorStrategy } from './dag/replan-error-strategy.js';
```

and add both names to the re-export block in `packages/llm-agent-libs/src/index.ts` (the named block that already re-exports `LlmDagPlanner` etc. from `./coordinator/index.js`).

- [ ] **Step 6: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0`.

- [ ] **Step 7: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag/abort-error-strategy.ts packages/llm-agent-libs/src/coordinator/dag/replan-error-strategy.ts packages/llm-agent-libs/src/coordinator/index.ts packages/llm-agent-libs/src/index.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/replan-error-strategy.test.ts
git commit -m "feat(slice3): AbortErrorStrategy + ReplanErrorStrategy"
```

---

### Task 3: Splice helper (`spliceSubPlan`)

A pure function that replaces a node with a sub-plan, used by the interpreter on replan.

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/splice-sub-plan.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/splice-sub-plan.test.ts`

- [ ] **Step 1: Write the failing test** `__tests__/splice-sub-plan.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan } from '@mcp-abap-adt/llm-agent';
import { spliceSubPlan } from '../splice-sub-plan.js';

describe('spliceSubPlan', () => {
  it('replaces a node with a namespaced sub-plan and rewires consumers', () => {
    // X (needsInput) <- Y depends on X
    const plan: DagPlan = {
      nodes: [
        { id: 'X', goal: 'big', needsInput: true },
        { id: 'Y', goal: 'after', dependsOn: ['X'] },
      ],
      createdAt: 0,
    };
    const sub: DagPlan = {
      nodes: [
        { id: 'a', goal: 'step a' }, // root of sub-plan
        { id: 'b', goal: 'step b', dependsOn: ['a'] }, // terminal of sub-plan
      ],
      createdAt: 0,
    };
    const out = spliceSubPlan(plan, 'X', sub);
    const ids = out.nodes.map((n) => n.id).sort();
    // X removed; sub nodes namespaced with 'X:'
    assert.deepEqual(ids, ['X:a', 'X:b', 'Y']);
    const a = out.nodes.find((n) => n.id === 'X:a')!;
    const b = out.nodes.find((n) => n.id === 'X:b')!;
    const y = out.nodes.find((n) => n.id === 'Y')!;
    // root sub-node inherits X's deps (none here) AND X's needsInput
    assert.equal(a.needsInput, true);
    assert.deepEqual(a.dependsOn ?? [], []);
    // intra-sub dependsOn is namespaced
    assert.deepEqual(b.dependsOn, ['X:a']);
    // Y now depends on the sub-plan terminal (X:b), not X
    assert.deepEqual(y.dependsOn, ['X:b']);
  });

  it('a multi-root sub-plan: every root inherits the replaced node deps', () => {
    const plan: DagPlan = {
      nodes: [
        { id: 'P', goal: 'pre' },
        { id: 'X', goal: 'big', dependsOn: ['P'] },
      ],
      createdAt: 0,
    };
    const sub: DagPlan = {
      nodes: [
        { id: 'r1', goal: 'root1' },
        { id: 'r2', goal: 'root2' },
      ],
      createdAt: 0,
    };
    const out = spliceSubPlan(plan, 'X', sub);
    assert.deepEqual(
      out.nodes.find((n) => n.id === 'X:r1')!.dependsOn,
      ['P'],
    );
    assert.deepEqual(
      out.nodes.find((n) => n.id === 'X:r2')!.dependsOn,
      ['P'],
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "splice|cannot find|fail"`. Expected: module-not-found.

- [ ] **Step 3: Implement** `splice-sub-plan.ts`:

```ts
import type { DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';

/**
 * Replace node `nodeId` in `plan` with the nodes of `subPlan`, flat (no nesting):
 * - sub-plan node ids are namespaced `${nodeId}:${id}` (collision-safe);
 * - sub-plan ROOT nodes (no intra-sub deps) inherit the replaced node's
 *   `dependsOn` AND `needsInput`;
 * - consumers that depended on `nodeId` now depend on the sub-plan's TERMINAL
 *   nodes (sub nodes nothing else in the sub-plan depends on).
 * Returns a new DagPlan (no mutation of the input).
 */
export function spliceSubPlan(
  plan: DagPlan,
  nodeId: string,
  subPlan: DagPlan,
): DagPlan {
  const replaced = plan.nodes.find((n) => n.id === nodeId);
  if (!replaced) return plan;
  const ns = (id: string) => `${nodeId}:${id}`;

  const subDependedOn = new Set(
    subPlan.nodes.flatMap((n) => n.dependsOn ?? []),
  );
  const terminals = subPlan.nodes
    .filter((n) => !subDependedOn.has(n.id))
    .map((n) => ns(n.id));
  const inheritedDeps = replaced.dependsOn ?? [];

  const splicedSubNodes: PlanNode[] = subPlan.nodes.map((n) => {
    const intra = (n.dependsOn ?? []).map(ns);
    const isRoot = (n.dependsOn ?? []).length === 0;
    return {
      ...n,
      id: ns(n.id),
      dependsOn: isRoot ? inheritedDeps : intra,
      needsInput: isRoot ? (replaced.needsInput ?? n.needsInput) : n.needsInput,
    };
  });

  const rest = plan.nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => {
      const deps = n.dependsOn ?? [];
      if (!deps.includes(nodeId)) return n;
      const rewired = deps.filter((d) => d !== nodeId).concat(terminals);
      return { ...n, dependsOn: rewired };
    });

  return { ...plan, nodes: [...rest, ...splicedSubNodes] };
}
```

- [ ] **Step 4: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0`.

- [ ] **Step 5: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag/splice-sub-plan.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/splice-sub-plan.test.ts
git commit -m "feat(slice3): spliceSubPlan helper (flat sub-graph splice)"
```

---

### Task 4: Interpreter — error strategy, collect-then-apply waves, per-run budget

**Files:**
- Modify: `packages/llm-agent/src/interfaces/interpreter.ts` (add `errorStrategy` to `InterpretContext`)
- Modify: `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts` (existing — extend)

> NOTE: `InterpretContext.layer` is removed in Part B (Task 8). In THIS task keep
> `layer` as-is (the existing `worker.run({... layer: ctx.layer + 1})` stays) and
> only ADD `errorStrategy`. This keeps the build green; Task 8 drops `layer`.

- [ ] **Step 1: Add `errorStrategy` to `InterpretContext`** in `interpreter.ts`:

```ts
import type { IErrorStrategy } from './error-strategy.js';
import type { ISubAgent } from './subagent.js';

export interface InterpretContext {
  inputText: string;
  workers: ReadonlyMap<string, ISubAgent>;
  sessionId: string;
  signal?: AbortSignal;
  /** Reaction to a node failure (abort | replan). Always populated by the
   *  caller; defaults to AbortErrorStrategy. */
  errorStrategy: IErrorStrategy;
  layer: number;
}
```

- [ ] **Step 2: Write failing interpreter tests** — append inside the existing `describe('DagPlanInterpreter', ...)` in `dag-plan-interpreter.test.ts`. The existing `ctx(...)` helper builds an `InterpretContext`; update it to also set `errorStrategy: new AbortErrorStrategy()` by default, and add an overload for a custom strategy. Add at the top of the file:

```ts
import { AbortErrorStrategy } from '../abort-error-strategy.js';
import { ReplanErrorStrategy } from '../replan-error-strategy.js';
import { NeedsDecompositionError } from '@mcp-abap-adt/llm-agent';
```

Update the existing `ctx` helper to default `errorStrategy`:

```ts
function ctx(
  workers: Array<[string, ISubAgent]>,
  errorStrategy: import('@mcp-abap-adt/llm-agent').IErrorStrategy =
    new AbortErrorStrategy(),
): InterpretContext {
  return {
    inputText: 'RAW',
    workers: new Map(workers),
    sessionId: 't',
    layer: 0,
    errorStrategy,
  };
}
```

Then add these tests:

```ts
  it('replans a node that throws NeedsDecompositionError into a sub-graph', async () => {
    let calls = 0;
    const big = worker('big', async () => {
      calls++;
      if (calls === 1) throw new NeedsDecompositionError('split me');
      return { output: 'unreachable' };
    });
    const small = worker('small', async () => ({ output: 'done-small' }));
    const planner = {
      name: 'p',
      plan: async () => ({
        nodes: [{ id: 's1', goal: 'small', agent: 'small' }],
        createdAt: 0,
      }),
    };
    const c = ctx(
      [['big', big], ['small', small]],
      new ReplanErrorStrategy(planner, 4),
    );
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      c,
    );
    assert.equal(r.ok, true);
    assert.match(r.output, /done-small/);
  });

  it('default AbortErrorStrategy still fails the node (slice-1 behavior)', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('split me');
    });
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      ctx([['big', big]]),
    );
    assert.equal(r.ok, false);
  });

  it('stops replanning at the budget (infinite-signal guard)', async () => {
    const big = worker('big', async () => {
      throw new NeedsDecompositionError('always too big');
    });
    // planner keeps producing a single node that also targets 'big'
    const planner = {
      name: 'p',
      plan: async () => ({
        nodes: [{ id: 'again', goal: 'big', agent: 'big' }],
        createdAt: 0,
      }),
    };
    const r = await I().interpret(
      dag([{ id: 'n1', goal: 'big', agent: 'big' }]),
      ctx([['big', big]], new ReplanErrorStrategy(planner, 2)),
    );
    assert.equal(r.ok, false); // budget exhausted → aborts
  });
```

- [ ] **Step 3: Run to verify failures** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: failures (replan not implemented; some existing tests may need the `errorStrategy` field — that's why Step 1 added it and the helper sets a default).

- [ ] **Step 4: Rewrite the wave loop in `dag-plan-interpreter.ts`** — replace the `interpret()` body's main loop (the `for (;;) { ... await Promise.all(...) }` block, current lines ~27–82) with the collect-then-apply version. Replace from `const results: Record<string, NodeResult> = {};` through the end of the `for (;;)` loop with:

```ts
    const results: Record<string, NodeResult> = {};
    const done = new Set<string>();
    let liveNodes = plan.nodes;
    const maxReplans = ctx.errorStrategy.maxReplans ?? 4;
    let replansUsed = 0;

    for (;;) {
      const ready = liveNodes.filter(
        (n) =>
          !(n.id in results) && (n.dependsOn ?? []).every((d) => done.has(d)),
      );
      if (ready.length === 0) break;

      // Phase 1: run the wave concurrently, COLLECT outcomes (no mutation here).
      type Outcome =
        | { node: PlanNode; kind: 'done'; output: string; durationMs: number }
        | {
            node: PlanNode;
            kind: 'failed';
            error: unknown;
            task: string;
            durationMs: number;
          };
      const outcomes = await Promise.all(
        ready.map(async (n): Promise<Outcome> => {
          const depOutputs: Record<string, string> = {};
          for (const d of n.dependsOn ?? [])
            depOutputs[d] = results[d].output;
          const task = composeNodeTask(n, plan, ctx.inputText, depOutputs);
          const started = Date.now();
          try {
            const res = await this.resolveWorker(n, ctx).run({
              task,
              sessionId: ctx.sessionId,
              signal: ctx.signal,
              layer: ctx.layer + 1,
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

      // Phase 2: apply outcomes SERIALLY (deterministic; no concurrent mutation).
      let splicedThisWave = false;
      for (const o of outcomes) {
        if (o.kind === 'done') {
          results[o.node.id] = {
            nodeId: o.node.id,
            output: o.output,
            status: 'done',
            durationMs: o.durationMs,
          };
          done.add(o.node.id);
          continue;
        }
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
        });
        if (reaction.action === 'replan' && remainingReplans > 0) {
          liveNodes = spliceSubPlan(
            { ...plan, nodes: liveNodes },
            o.node.id,
            reaction.subPlan,
          ).nodes;
          replansUsed++;
          splicedThisWave = true;
        } else {
          results[o.node.id] = {
            nodeId: o.node.id,
            output: '',
            status: 'failed',
            error:
              o.error instanceof Error ? o.error.message : String(o.error),
            durationMs: o.durationMs,
          };
        }
      }

      // Re-validate ONCE after this wave's splices, before the next ready-set.
      if (splicedThisWave) this.validate({ ...plan, nodes: liveNodes }, ctx);
    }
```

Then update the tail of `interpret()` (the skipped-nodes loop, the failed-aggregation, and terminal-output computation) to iterate over `liveNodes` instead of `plan.nodes`:

```ts
    for (const n of liveNodes) {
      if (!(n.id in results)) {
        results[n.id] = {
          nodeId: n.id,
          output: '',
          status: 'skipped',
          durationMs: 0,
        };
      }
    }

    const failed = liveNodes.filter((n) => results[n.id].status !== 'done');
    if (failed.length > 0) {
      const first = liveNodes.find((n) => results[n.id].status === 'failed');
      return {
        nodeResults: results,
        ok: false,
        error: first
          ? `node '${first.id}' failed: ${results[first.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
      };
    }

    const depended = new Set(liveNodes.flatMap((n) => n.dependsOn ?? []));
    const terminals = liveNodes.filter((n) => !depended.has(n.id));
    const output = terminals.map((n) => results[n.id].output).join('\n\n');
    return { nodeResults: results, ok: true, output };
```

Add the splice import at the top of the file: `import { spliceSubPlan } from './splice-sub-plan.js';`. Note `validate()` already accepts `(plan, ctx)`; calling it with `{ ...plan, nodes: liveNodes }` re-runs duplicate-id / missing-dep / cycle / unresolvable-worker / contextPolicy checks on the spliced graph.

- [ ] **Step 5: Keep the build green — set `errorStrategy` in the handler's InterpretContext.** `InterpretContext.errorStrategy` is now REQUIRED, and `DagCoordinatorHandler` is the only other place that constructs an `InterpretContext` (besides tests). In `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`, import `{ AbortErrorStrategy }` from `'../../coordinator/index.js'` and add `errorStrategy: new AbortErrorStrategy(),` to the `InterpretContext` object literal passed to `this.deps.interpreter.interpret(plan, {...})`. (Task 5 refines this to read `this.deps.errorStrategy`.) Without this step the workspace build fails at the end of this task.

- [ ] **Step 6: Run tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0` (new replan/abort/budget tests pass; existing interpreter tests still pass — they use the `AbortErrorStrategy` default the updated `ctx` helper sets).

- [ ] **Step 7: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent/src/interfaces/interpreter.ts packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
git commit -m "feat(slice3): interpreter error-strategy gate + collect-then-apply waves + per-run replan budget"
```

---

### Task 5: Wire `errorStrategy` through the DAG coordinator handler + config + server

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts`

- [ ] **Step 1: Handler deps + InterpretContext** — in `dag-coordinator.ts` (the `AbortErrorStrategy` import was added in Task 4):
  - add `IErrorStrategy` to the type import from `@mcp-abap-adt/llm-agent`.
  - add to `DagCoordinatorHandlerDeps`: `errorStrategy?: IErrorStrategy;`
  - **change** the `InterpretContext` field added in Task 4 from `errorStrategy: new AbortErrorStrategy()` to:

```ts
        errorStrategy: this.deps.errorStrategy ?? new AbortErrorStrategy(),
```

(Builder/pipeline need no change — `withDagCoordinator(deps)` forwards the whole deps object.)

- [ ] **Step 2: Config — failing tests** — in `dag-coordinator-config.test.ts` add inside the describe block:

```ts
  it('accepts a DAG coordinator with errorStrategy replan', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planner: { type: 'llm' },
        errorStrategy: { type: 'replan', maxReplans: 3 },
      }),
    );
  });
  it('accepts errorStrategy abort', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({
        planner: { type: 'llm' },
        errorStrategy: { type: 'abort' },
      }),
    );
  });
  it('rejects an unknown errorStrategy.type', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planner: { type: 'llm' },
          errorStrategy: { type: 'bogus' },
        }),
      /errorStrategy: unknown type 'bogus'/,
    );
  });
  it('rejects errorStrategy in a linear coordinator', () => {
    assert.throws(
      () =>
        assertCoordinatorConfigShape({
          planning: 'one-shot',
          errorStrategy: { type: 'abort' },
        }),
      /errorStrategy/,
    );
  });
```

- [ ] **Step 3: Config — implement** — in `config.ts`:
  - add `'errorStrategy'` to the `DAG_ONLY` array.
  - add a shape guard (next to `assertLlmRoleShape`):

```ts
function assertErrorStrategyShape(es: unknown): void {
  if (typeof es !== 'object' || es === null || Array.isArray(es)) {
    throw new Error(
      `coordinator.errorStrategy must be an object (e.g. { type: replan }), got: ${JSON.stringify(es)}`,
    );
  }
  const type = (es as { type?: unknown }).type;
  if (type !== undefined && type !== 'abort' && type !== 'replan') {
    throw new Error(
      `coordinator.errorStrategy: unknown type '${String(type)}' (only 'abort' | 'replan')`,
    );
  }
  const mr = (es as { maxReplans?: unknown }).maxReplans;
  if (mr !== undefined && (typeof mr !== 'number' || mr < 0)) {
    throw new Error(
      `coordinator.errorStrategy.maxReplans must be a non-negative number, got: ${String(mr)}`,
    );
  }
}
```

  - in `assertCoordinatorConfigShape`, inside the `if (isDag) { ... }` branch (after the reviewer validation), add:

```ts
    if (coord.errorStrategy !== undefined) {
      assertErrorStrategyShape(coord.errorStrategy);
    }
```

  - add `errorStrategy?: { type?: string; maxReplans?: number }` to the `YamlCoordinator` type.

- [ ] **Step 4: Server wiring** — in `smart-server.ts`, in the DAG branch after the planner/reviewer are built and before `withDagCoordinator(...)`:
  - import `AbortErrorStrategy`, `ReplanErrorStrategy` from `@mcp-abap-adt/llm-agent-libs`; `IErrorStrategy` (type) from `@mcp-abap-adt/llm-agent`.

```ts
        let errorStrategy: IErrorStrategy | undefined;
        const esCfg = coordCfg.errorStrategy as
          | { type?: string; maxReplans?: number }
          | undefined;
        if (esCfg?.type === 'replan') {
          errorStrategy = new ReplanErrorStrategy(planner, esCfg.maxReplans);
        } else if (esCfg?.type === 'abort') {
          errorStrategy = new AbortErrorStrategy();
        }
```

  - add `errorStrategy` to the `withDagCoordinator({ planner, interpreter, workers, activation, reviewer, errorStrategy })` call.

- [ ] **Step 5: Run server tests** — `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"`. Expected: `ℹ fail 0`.

- [ ] **Step 6: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts
git commit -m "feat(slice3): wire coordinator.errorStrategy (abort|replan) through handler/config/server"
```

---

## PART B — Remove nested dispatch (breaking; major bump)

Each task removes a slice of the surface together with all its readers, keeping the build green. Run `npm run build` after each removal and delete the erroring usages.

### Task 6: Remove `kind` / `canDispatchChildren` / `SubAgentKind`

**Files:** `packages/llm-agent/src/interfaces/subagent.ts`, `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`, `packages/llm-agent-libs/src/subagent/direct-llm-subagent.ts`, `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`, and any tests building `capabilities`.

- [ ] **Step 1:** In `subagent.ts`: delete the `SubAgentKind` type (lines ~13) and, in `SubAgentCapabilities`, delete the `kind` and `canDispatchChildren` fields — leaving only `contextPolicy`. Update the doc comments that reference autonomous/constrained/layer.

- [ ] **Step 2:** In `smart-agent-subagent.ts`: in its static `capabilities`, delete `kind: 'autonomous'` and `canDispatchChildren: true` (keep `contextPolicy: 'optional'`).

- [ ] **Step 3:** In `direct-llm-subagent.ts`: in the `capabilities` it builds, delete `kind: 'constrained'` and `canDispatchChildren: false` (keep `contextPolicy`).

- [ ] **Step 4:** In linear `coordinator.ts` `validatePlan`: delete the kind gate block:

```ts
      if (layer >= 1 && sub.capabilities.kind === 'autonomous') {
        return `Step '${step.id}' targets autonomous subagent '${step.agent}' but layer ${layer} only allows constrained subagents.`;
      }
```

(the surrounding `for (const step of plan.steps)` loop body now only had this check + the `if (!step.agent) continue;`/`registry.get`; once the gate is gone the loop is dead — but DON'T fully remove `validatePlan` yet, that is Task 7. For now leave `validatePlan` returning only the `maxLayer` check.)

- [ ] **Step 5:** Run `npm run build`; for each compile error in tests/src that references `kind` or `canDispatchChildren` on a capabilities literal, delete those properties. Search to be exhaustive: `grep -rn "canDispatchChildren\|SubAgentKind\|kind: 'autonomous'\|kind: 'constrained'" packages --include='*.ts' | grep -v dist`.

- [ ] **Step 6:** `npm run build && npm run lint && npm run lint:check && npm run test`. Expected: build clean; `NO FAILURES`. Then commit:

```bash
git add -A
git commit -m "refactor(slice3)!: remove SubAgentKind/kind/canDispatchChildren (leaves-only)"
```

---

### Task 7: Remove `maxLayer` + linear `validatePlan` layer gate

**Files:** `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`, `packages/llm-agent/src/interfaces/coordinator.ts` (`ICoordinatorConfig.maxLayer`), the builder + pipeline that thread `maxLayer`, `packages/llm-agent-server/src/smart-agent/config.ts` (keep YAML `maxLayer` tolerated).

- [ ] **Step 1:** In linear `coordinator.ts`: delete `maxLayer` from `CoordinatorHandlerDeps`; delete the entire `validatePlan` method and its call site (the `const validationError = this.validatePlan(...)` block and the `if (validationError) { ... COORDINATOR_LAYER_VIOLATION ... }`). Delete the now-stale comments referencing layer rules / maxLayer. The `layer >= maxLayer` ceiling is gone — the linear coordinator no longer enforces nesting.

- [ ] **Step 2:** In `interfaces/coordinator.ts`: delete `ICoordinatorConfig.maxLayer` (lines ~127–132).

- [ ] **Step 3:** Find where `maxLayer` is threaded into `CoordinatorHandlerDeps` (the builder `withCoordinator` and/or `DefaultPipeline` options and `smart-server.ts` linear branch). Search: `grep -rn "maxLayer" packages --include='*.ts' | grep -v dist | grep -v __tests__`. Remove each `maxLayer:` assignment and any `maxLayer` field on builder/pipeline option types.

- [ ] **Step 4: YAML backward-compat** — in `config.ts`, `maxLayer` must stay **accepted** (it is already in `LINEAR_ONLY`, so a linear config with `maxLayer` still validates; a DAG config with `maxLayer` is still rejected as a linear-only field — unchanged). Confirm `LINEAR_ONLY` still contains `'maxLayer'`. Do NOT remove it. The smart-server linear branch simply no longer reads it (Step 3 removed the read). Add/keep a test asserting a linear YAML with `maxLayer: 2` still validates (see existing config tests; add one if absent):

```ts
  it('still accepts a linear coordinator with maxLayer (now a no-op)', () => {
    assert.doesNotThrow(() =>
      assertCoordinatorConfigShape({ planning: 'one-shot', maxLayer: 2 }),
    );
  });
```

- [ ] **Step 5:** Update/remove linear-coordinator tests that asserted layer-violation behavior (search `grep -rn "COORDINATOR_LAYER_VIOLATION\|maxLayer\|layer >=" packages --include='*.test.ts'`). Replace "rejects at layer N" tests with the absence of the gate (or delete them).

- [ ] **Step 6:** `npm run build && npm run lint && npm run lint:check && npm run test`. Expected: clean; `NO FAILURES`. Commit:

```bash
git add -A
git commit -m "refactor(slice3)!: remove maxLayer + linear validatePlan layer gate (leaves-only); tolerate YAML maxLayer"
```

---

### Task 8: Remove `layer` everywhere

**Files:** `packages/llm-agent/src/interfaces/subagent.ts` (`ISubAgentInput.layer`), `interpreter.ts` (`InterpretContext.layer`), `coordinator.ts` (`ICoordinatorContext.layer`), `types.ts` (`CallOptions.layer`), `subagent-context.ts` (`SubAgentContextRequest.layer`), `packages/llm-agent-libs/src/pipeline/context.ts` (`PipelineContext.layer`), plus call sites: `dag-plan-interpreter.ts`, `llm-dag-planner.ts`, `llm-review-strategy.ts`, `coordinator/dispatch/subagent.ts`, `pipeline/handlers/subagent.ts`, `pipeline/handlers/coordinator.ts`, `pipeline/default-pipeline.ts`, `subagent/smart-agent-subagent.ts`.

- [ ] **Step 1:** Delete the `layer` field from each interface: `ISubAgentInput.layer`, `InterpretContext.layer`, `ICoordinatorContext.layer`, `CallOptions.layer` (`types.ts`), `SubAgentContextRequest.layer` (`subagent-context.ts`), `PipelineContext.layer` (`context.ts`). Update the doc comments that explain layer/dispatch-depth.

- [ ] **Step 2:** Run `npm run build` and remove every erroring usage. The known sites (verify with `grep -rn "\\blayer\\b" packages --include='*.ts' | grep -v dist`):
  - `dag-plan-interpreter.ts`: drop `layer: ctx.layer + 1` from the `worker.run({...})` call (the run input becomes `{ task, sessionId, signal }`).
  - `llm-dag-planner.ts` and `llm-review-strategy.ts`: drop `layer: 0` from the `agent.run({...})` calls.
  - `coordinator/dispatch/subagent.ts`: remove `childLayer` computation and the `layer:` fields it passed (lines ~53,61,90,98).
  - `pipeline/handlers/subagent.ts`: drop `layer: (ctx.layer ?? 0) + 1`.
  - `pipeline/handlers/coordinator.ts`: drop `layer: ctx.layer ?? 0` from the `coordCtx` literal, and the `ctx.layer ?? 0` arg previously passed to `validatePlan` (removed in Task 7).
  - `pipeline/default-pipeline.ts`: drop `layer: options?.layer ?? 0` from the context it builds.
  - `subagent/smart-agent-subagent.ts`: drop `layer: input.layer` from the inner pipeline invocation (the inner SmartAgent no longer receives a layer).

- [ ] **Step 3:** Update tests that construct `ISubAgentInput` / `InterpretContext` / `ICoordinatorContext` with `layer`. Search: `grep -rn "layer" packages --include='*.test.ts' | grep -v dist`. Remove the `layer` properties from those literals (e.g. the `ctx` helper in `dag-plan-interpreter.test.ts` loses `layer: 0`; `DirectLlmSubAgent`/interpreter input literals lose `layer`).

- [ ] **Step 4:** `npm run build && npm run lint && npm run lint:check && npm run test`. Expected: clean; `NO FAILURES`. Commit:

```bash
git add -A
git commit -m "refactor(slice3)!: remove layer from ISubAgentInput and all contexts/call sites"
```

---

### Task 9: Flatten `EpicFailTrace` (remove `layer` + `childTrace`)

**Files:** `packages/llm-agent/src/interfaces/coordinator.ts` (`EpicFailTrace`), and any code building/reading `layer`/`childTrace` (mainly `coordinator/dispatch/subagent.ts`).

- [ ] **Step 1:** In `interfaces/coordinator.ts`, in `EpicFailTrace`, delete the `layer: number;` and `childTrace?: EpicFailTrace;` fields (the cross-layer propagation chain #128–#132). Keep `stepId`, `agentName`, `attempts`, `originalError`. Update the doc comment to say the trace is flat (no chain).

- [ ] **Step 2:** Run `npm run build`; find code that set `layer`/`childTrace` on an `EpicFailTrace` and remove those assignments. Search: `grep -rn "childTrace\|EpicFailTrace" packages --include='*.ts' | grep -v dist`. (The `errorClass: 'epicfail'` discriminator and `epicFailTrace?` result field stay.)

- [ ] **Step 3:** Update any test asserting `childTrace`/`layer` on a trace. Search `grep -rn "childTrace\|\.layer" packages --include='*.test.ts' | grep -v dist`.

- [ ] **Step 4:** `npm run build && npm run lint && npm run lint:check && npm run test`. Expected: clean; `NO FAILURES`. Commit:

```bash
git add -A
git commit -m "refactor(slice3)!: flatten EpicFailTrace (drop layer + childTrace cross-layer chain)"
```

---

### Task 10: Full verification

- [ ] **Step 1: Confirm no nesting surface remains** —
  `grep -rn "\\bmaxLayer\\b\|canDispatchChildren\|SubAgentKind\|childTrace" packages --include='*.ts' | grep -v dist | grep -v __tests__`
  Expected: no matches in `src` (only possibly YAML/config comments). `grep -rn "\\blayer\\b" packages/llm-agent/src --include='*.ts'` should show no interface `layer` fields.

- [ ] **Step 2: Backward-compat guard** — `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"` → `ℹ fail 0` (existing-coordinator-yaml-loads + the `maxLayer` tolerance test pass).

- [ ] **Step 3: Full suite** — `npm run test 2>&1 | grep -iE "ℹ fail [1-9]" || echo "NO FAILURES"` → `NO FAILURES`.

- [ ] **Step 4: Build + lint:check** — `npm run build && npm run lint:check`. Expected: clean.

- [ ] **Step 5:** Commit any formatting-only changes: `git add -A && git commit -m "chore(slice3): formatting" || echo "nothing to commit"`.
