# Slice 1 — Batch DAG coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in DAG coordinator (planner → interpreter) that runs end-to-end alongside the untouched linear coordinator, selected by presence of `coordinator.planner` in YAML.

**Architecture:** New, distinct types/interfaces (`PlanNode`/`DagPlan`, `IInterpreter`, `IPlanner`) + implementations (`composeNodeTask`, `DagPlanInterpreter`, `LlmDagPlanner`, `DagCoordinatorHandler`). Workers are the existing top-level `subagents:` (`ISubAgent`), dispatched directly at `layer+1`. Linear `Plan`/`PlanStep`/`CoordinatorHandler` are NOT edited. One PR, milestone commits.

**Tech Stack:** TypeScript (ESM, strict), Biome, `node --test` via `tsx/esm`. Packages: `@mcp-abap-adt/llm-agent` (interfaces), `@mcp-abap-adt/llm-agent-libs` (impls + pipeline), `@mcp-abap-adt/llm-agent-server` (config interpretation).

Spec: `docs/superpowers/specs/2026-05-25-slice1-batch-dag-coordinator-design.md`

---

## File Structure

New:
- `packages/llm-agent/src/interfaces/dag-plan.ts` — `PlanNode`, `DagPlan`.
- `packages/llm-agent/src/interfaces/planner.ts` — `PlannerCatalogEntry`, `PlannerInput`, `IPlanner`.
- `packages/llm-agent/src/interfaces/interpreter.ts` — `IInterpreter`, `InterpretContext`, `NodeResult`, `InterpretResult`.
- `packages/llm-agent-libs/src/coordinator/dag/compose-node-task.ts`
- `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`
- `packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts`
- `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`

Modified (additive):
- `packages/llm-agent/src/index.ts` (export the new interface modules).
- `packages/llm-agent-libs/src/pipeline/handlers/index.ts` (register the DAG coordinator handler).
- `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` (wire DAG coordinator into the coordinator stage when a DAG config is present).
- `packages/llm-agent-server/src/smart-agent/config.ts` + `smart-server.ts` (interpret `coordinator.planner`; fail-loud on stray linear-only fields).

Untouched: linear `coordinator.ts` interfaces, `CoordinatorHandler`, `compose-task.ts`, dispatch strategies.

Tests (new): one `__tests__` file per new unit, plus a backward-compat config guard.

---

## Task 1: New interfaces and types (`@mcp-abap-adt/llm-agent`)

**Files:**
- Create: `packages/llm-agent/src/interfaces/dag-plan.ts`
- Create: `packages/llm-agent/src/interfaces/planner.ts`
- Create: `packages/llm-agent/src/interfaces/interpreter.ts`
- Modify: `packages/llm-agent/src/index.ts`

- [ ] **Step 1: Create `dag-plan.ts`**

```ts
// packages/llm-agent/src/interfaces/dag-plan.ts
export interface PlanNode {
  id: string;
  goal: string;
  agent?: string;
  dependsOn?: string[];
  needsInput?: boolean;
}

export interface DagPlan {
  nodes: PlanNode[];
  objective?: string;
  rationale?: string;
  createdAt: number;
}
```

- [ ] **Step 2: Create `planner.ts`**

```ts
// packages/llm-agent/src/interfaces/planner.ts
import type { DagPlan } from './dag-plan.js';

export interface PlannerCatalogEntry {
  name: string;
  description?: string;
}

export interface PlannerInput {
  prompt: string;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

export interface IPlanner {
  readonly name: string;
  plan(input: PlannerInput): Promise<DagPlan>;
}
```

- [ ] **Step 3: Create `interpreter.ts`**

```ts
// packages/llm-agent/src/interfaces/interpreter.ts
import type { ISubAgent } from './subagent.js';

export interface IInterpreter<TInput, TOutput> {
  readonly name: string;
  interpret(input: TInput, ctx: InterpretContext): Promise<TOutput>;
}

export interface InterpretContext {
  inputText: string;
  workers: ReadonlyMap<string, ISubAgent>;
  sessionId: string;
  signal?: AbortSignal;
  /** This coordinator's depth (root = 0). Workers run at layer + 1. */
  layer: number;
}

export interface NodeResult {
  nodeId: string;
  output: string;
  status: 'done' | 'failed' | 'skipped';
  error?: string;
  durationMs: number;
}

export interface InterpretResult {
  nodeResults: Record<string, NodeResult>;
  ok: boolean;
  error?: string;
  output: string;
}
```

- [ ] **Step 4: Export from the package index**

In `packages/llm-agent/src/index.ts`, add (next to the other `interfaces/*` re-exports):

```ts
export * from './interfaces/dag-plan.js';
export * from './interfaces/planner.js';
export * from './interfaces/interpreter.js';
```

- [ ] **Step 5: Build to verify types compile**

Run: `npm run build`
Expected: success, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/dag-plan.ts packages/llm-agent/src/interfaces/planner.ts packages/llm-agent/src/interfaces/interpreter.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): slice1 #DAG contracts — PlanNode/DagPlan, IPlanner, IInterpreter"
```

---

## Task 2: `composeNodeTask` (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/compose-node-task.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/compose-node-task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';
import { composeNodeTask } from '../compose-node-task.js';

function plan(objective?: string): DagPlan {
  return { nodes: [], objective, createdAt: 0 };
}
function node(o: Partial<PlanNode> = {}): PlanNode {
  return { id: 'n1', goal: 'Summarize', ...o };
}

describe('composeNodeTask', () => {
  it('bare goal when no objective/deps/needsInput', () => {
    assert.equal(composeNodeTask(node(), plan(), 'RAW', {}), 'Summarize');
  });

  it('prepends objective when present', () => {
    const t = composeNodeTask(node(), plan('Ship it'), 'RAW', {});
    assert.match(t, /Task: Summarize/);
    assert.match(t, /Overall objective: Ship it/);
  });

  it('embeds dependency outputs (data-flow along edges)', () => {
    const t = composeNodeTask(
      node({ dependsOn: ['a', 'b'] }),
      plan(),
      'RAW',
      { a: 'OUT_A', b: 'OUT_B' },
    );
    assert.match(t, /Input from a:\n---\nOUT_A\n---/);
    assert.match(t, /Input from b:\n---\nOUT_B\n---/);
    assert.doesNotMatch(t, /RAW/); // no inputText unless needsInput
  });

  it('embeds the original prompt as delimited data when needsInput', () => {
    const t = composeNodeTask(node({ needsInput: true }), plan(), 'RAW', {});
    assert.match(t, /Input \(user-provided data\):\n---\nRAW\n---/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/compose-node-task.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/coordinator/dag/compose-node-task.ts
import type { DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';

/**
 * Deterministically compose a worker's task from the node's intent, the plan
 * objective, the outputs of THIS node's dependencies, and the original prompt
 * (only when needsInput). No LLM. DAG-scoped (NOT the linear composeTask).
 */
export function composeNodeTask(
  node: PlanNode,
  plan: DagPlan,
  inputText: string,
  depOutputs: Record<string, string>,
): string {
  const deps = node.dependsOn ?? [];
  if (!plan.objective && deps.length === 0 && !node.needsInput) {
    return node.goal;
  }
  const parts: string[] = [`Task: ${node.goal}`];
  if (plan.objective) parts.push(`Overall objective: ${plan.objective}`);
  for (const depId of deps) {
    parts.push(`Input from ${depId}:\n---\n${depOutputs[depId] ?? ''}\n---`);
  }
  if (node.needsInput) {
    parts.push(`Input (user-provided data):\n---\n${inputText}\n---`);
  }
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run, expect PASS (4 tests)**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/compose-node-task.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dag/compose-node-task.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/compose-node-task.test.ts
git commit -m "feat(libs): slice1 composeNodeTask — goal + objective + dep outputs + material"
```

---

## Task 3: `DagPlanInterpreter` (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ISubAgent,
  ISubAgentInput,
  InterpretContext,
} from '@mcp-abap-adt/llm-agent';
import { DagPlanInterpreter } from '../dag-plan-interpreter.js';

function worker(
  name: string,
  run: (i: ISubAgentInput) => Promise<{ output: string }>,
): ISubAgent {
  return {
    name,
    capabilities: { kind: 'constrained', canDispatchChildren: false, contextPolicy: 'optional' },
    run: run as ISubAgent['run'],
  } as ISubAgent;
}

function ctx(workers: Array<[string, ISubAgent]>): InterpretContext {
  return { inputText: 'RAW', workers: new Map(workers), sessionId: 't', layer: 0 };
}

const dag = (nodes: DagPlan['nodes'], objective?: string): DagPlan => ({
  nodes, objective, createdAt: 0,
});

describe('DagPlanInterpreter', () => {
  const I = () => new DagPlanInterpreter();

  it('runs a single-node plan and returns its raw output', async () => {
    const w = worker('w', async () => ({ output: '42' }));
    const r = await I().interpret(dag([{ id: 'n1', goal: 'g', agent: 'w' }]), ctx([['w', w]]));
    assert.equal(r.ok, true);
    assert.equal(r.output, '42');
  });

  it('runs a dependency chain in order, feeding outputs forward', async () => {
    const seen: Record<string, string> = {};
    const w = worker('w', async (i) => {
      const tag = i.task.includes('Input from a') ? 'b' : 'a';
      seen[tag] = i.task;
      return { output: tag === 'a' ? 'A' : 'B' };
    });
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'first', agent: 'w' },
        { id: 'b', goal: 'second', agent: 'w', dependsOn: ['a'] },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, true);
    assert.match(seen.b, /Input from a:\n---\nA\n---/);
    assert.equal(r.output, 'B'); // terminal node only
  });

  it('resolves an absent agent to the sole worker', async () => {
    const w = worker('only', async () => ({ output: 'ok' }));
    const r = await I().interpret(dag([{ id: 'n1', goal: 'g' }]), ctx([['only', w]]));
    assert.equal(r.ok, true);
  });

  it('marks a failed node and skips its dependents (ok=false)', async () => {
    const w = worker('w', async (i) =>
      i.task.includes('boom') ? Promise.reject(new Error('boom')) : { output: 'ok' },
    );
    const r = await I().interpret(
      dag([
        { id: 'a', goal: 'boom', agent: 'w' },
        { id: 'b', goal: 'after', agent: 'w', dependsOn: ['a'] },
      ]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, false);
    assert.equal(r.nodeResults.a.status, 'failed');
    assert.equal(r.nodeResults.b.status, 'skipped');
  });

  it('throws COORDINATOR_PLAN_INVALID on empty / duplicate / missing-dep / cycle / unresolvable-agent', async () => {
    const w = worker('w', async () => ({ output: 'ok' }));
    const c = ctx([['w', w], ['w2', w]]);
    await assert.rejects(() => I().interpret(dag([]), c), /COORDINATOR_PLAN_INVALID/);
    await assert.rejects(() => I().interpret(dag([{ id: 'x', goal: 'g', agent: 'w' }, { id: 'x', goal: 'g', agent: 'w' }]), c), /COORDINATOR_PLAN_INVALID/);
    await assert.rejects(() => I().interpret(dag([{ id: 'a', goal: 'g', agent: 'w', dependsOn: ['zzz'] }]), c), /COORDINATOR_PLAN_INVALID/);
    await assert.rejects(() => I().interpret(dag([{ id: 'a', goal: 'g', agent: 'w', dependsOn: ['b'] }, { id: 'b', goal: 'g', agent: 'w', dependsOn: ['a'] }]), c), /COORDINATOR_PLAN_INVALID/);
    await assert.rejects(() => I().interpret(dag([{ id: 'a', goal: 'g' }]), c), /COORDINATOR_PLAN_INVALID/); // absent agent, >1 worker
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts
import type {
  DagPlan,
  IInterpreter,
  InterpretContext,
  InterpretResult,
  ISubAgent,
  NodeResult,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';
import { composeNodeTask } from './compose-node-task.js';

class PlanInvalidError extends Error {
  readonly code = 'COORDINATOR_PLAN_INVALID';
}

export class DagPlanInterpreter
  implements IInterpreter<DagPlan, InterpretResult>
{
  readonly name = 'dag';

  async interpret(plan: DagPlan, ctx: InterpretContext): Promise<InterpretResult> {
    this.validate(plan, ctx);

    const results: Record<string, NodeResult> = {};
    const done = new Set<string>();

    // Loop dispatching ready nodes concurrently until none remain runnable.
    for (;;) {
      const ready = plan.nodes.filter(
        (n) =>
          !(n.id in results) &&
          (n.dependsOn ?? []).every((d) => done.has(d)),
      );
      if (ready.length === 0) break;

      await Promise.all(
        ready.map(async (n) => {
          const depOutputs: Record<string, string> = {};
          for (const d of n.dependsOn ?? []) depOutputs[d] = results[d].output;
          const task = composeNodeTask(n, plan, ctx.inputText, depOutputs);
          const worker = this.resolveWorker(n, ctx);
          const started = Date.now();
          try {
            const res = await worker.run({
              task,
              sessionId: ctx.sessionId,
              signal: ctx.signal,
              layer: ctx.layer + 1,
            });
            if (res.errorClass === 'epicfail') {
              results[n.id] = { nodeId: n.id, output: '', status: 'failed', error: 'epicfail', durationMs: Date.now() - started };
            } else {
              results[n.id] = { nodeId: n.id, output: res.output, status: 'done', durationMs: Date.now() - started };
              done.add(n.id);
            }
          } catch (err) {
            results[n.id] = {
              nodeId: n.id, output: '', status: 'failed',
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - started,
            };
          }
        }),
      );
    }

    // Any node not done is failed or skipped (unreachable due to a failed dep).
    for (const n of plan.nodes) {
      if (!(n.id in results)) {
        results[n.id] = { nodeId: n.id, output: '', status: 'skipped', durationMs: 0 };
      }
    }

    const failed = plan.nodes.filter((n) => results[n.id].status !== 'done');
    if (failed.length > 0) {
      const first = plan.nodes.find((n) => results[n.id].status === 'failed');
      return {
        nodeResults: results,
        ok: false,
        error: first
          ? `node '${first.id}' failed: ${results[first.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
      };
    }

    // Aggregate terminal nodes (no node depends on them) in id order.
    const depended = new Set(plan.nodes.flatMap((n) => n.dependsOn ?? []));
    const terminals = plan.nodes.filter((n) => !depended.has(n.id));
    const output = terminals
      .map((n) => results[n.id].output)
      .join('\n\n');
    return { nodeResults: results, ok: true, output };
  }

  private resolveWorker(node: PlanNode, ctx: InterpretContext): ISubAgent {
    if (node.agent) {
      const w = ctx.workers.get(node.agent);
      if (!w) throw new PlanInvalidError(`COORDINATOR_PLAN_INVALID: node '${node.id}' targets unknown worker '${node.agent}'`);
      return w;
    }
    if (ctx.workers.size === 1) return [...ctx.workers.values()][0];
    throw new PlanInvalidError(`COORDINATOR_PLAN_INVALID: node '${node.id}' omits 'agent' but there are ${ctx.workers.size} workers`);
  }

  private validate(plan: DagPlan, ctx: InterpretContext): void {
    if (plan.nodes.length === 0) {
      throw new PlanInvalidError('COORDINATOR_PLAN_INVALID: empty plan (no nodes)');
    }
    const ids = new Set<string>();
    for (const n of plan.nodes) {
      if (ids.has(n.id)) throw new PlanInvalidError(`COORDINATOR_PLAN_INVALID: duplicate node id '${n.id}'`);
      ids.add(n.id);
    }
    for (const n of plan.nodes) {
      for (const d of n.dependsOn ?? []) {
        if (!ids.has(d)) throw new PlanInvalidError(`COORDINATOR_PLAN_INVALID: node '${n.id}' depends on unknown '${d}'`);
      }
      this.resolveWorker(n, ctx); // throws on unresolvable agent
    }
    this.assertAcyclic(plan);
  }

  private assertAcyclic(plan: DagPlan): void {
    const state = new Map<string, 0 | 1 | 2>(); // 0 unseen,1 in-stack,2 done
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));
    const visit = (id: string): void => {
      const s = state.get(id) ?? 0;
      if (s === 1) throw new PlanInvalidError(`COORDINATOR_PLAN_INVALID: cycle at '${id}'`);
      if (s === 2) return;
      state.set(id, 1);
      for (const d of byId.get(id)?.dependsOn ?? []) visit(d);
      state.set(id, 2);
    };
    for (const n of plan.nodes) visit(n.id);
  }
}
```

- [ ] **Step 4: Run, expect PASS (5 tests)**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
git commit -m "feat(libs): slice1 DagPlanInterpreter — topological/parallel walk, data-flow, validation, ok/error result"
```

---

## Task 4: `LlmDagPlanner` (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts`
- Test: `packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-dag-planner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, PlannerInput } from '@mcp-abap-adt/llm-agent';
import { LlmDagPlanner } from '../llm-dag-planner.js';

function llm(content: string): ILlm {
  return { chat: async () => ({ ok: true, value: { content } }) } as unknown as ILlm;
}
const input: PlannerInput = {
  prompt: 'Do X then Y',
  agents: [{ name: 'w', description: 'worker' }],
  sessionId: 't',
};

describe('LlmDagPlanner', () => {
  it('parses a DAG with dependsOn', async () => {
    const p = await new LlmDagPlanner(llm(
      '{"objective":"O","nodes":[{"id":"a","goal":"X","agent":"w"},{"id":"b","goal":"Y","agent":"w","dependsOn":["a"]}]}',
    )).plan(input);
    assert.equal(p.objective, 'O');
    assert.equal(p.nodes.length, 2);
    assert.deepEqual(p.nodes[1].dependsOn, ['a']);
  });

  it('accepts a single-node plan (progressive complexity)', async () => {
    const p = await new LlmDagPlanner(llm('{"nodes":[{"id":"n1","goal":"answer"}]}')).plan(input);
    assert.equal(p.nodes.length, 1);
  });

  it('throws on malformed JSON', async () => {
    await assert.rejects(() => new LlmDagPlanner(llm('not json')).plan(input), /JSON/i);
  });

  it('throws when a node is missing a goal', async () => {
    await assert.rejects(
      () => new LlmDagPlanner(llm('{"nodes":[{"id":"a"}]}')).plan(input),
      /missing a goal/,
    );
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/llm-dag-planner.test.ts`

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts
import type {
  DagPlan,
  ILlm,
  IPlanner,
  PlannerInput,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';

/**
 * MVP exception (slice 1): calls the ILlm directly rather than wrapping a
 * supervised planner ISubAgent. The IPlanner interface is the stable seam;
 * moving onto the ISubAgent supervision path is deferred to the slice that
 * introduces supervision/restart.
 */
export class LlmDagPlanner implements IPlanner {
  readonly name = 'llm-dag';
  constructor(private readonly llm: ILlm) {}

  async plan(input: PlannerInput): Promise<DagPlan> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const system = `You are a planner. Decompose the user request into a DAG of tasks.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids),"needsInput"(optional bool)}.
Use "dependsOn" to express order/data-flow; independent nodes run in parallel.
If the request needs no decomposition, emit a SINGLE node.
Emit a plan-level "objective". Respond with ONLY:
{"objective":"...","nodes":[{"id":"n1","goal":"...","agent":"optional","dependsOn":[],"needsInput":false}]}

Available workers:
${catalog || '(none)'}`;

    const res = await this.llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      [],
      { signal: input.signal, sessionId: input.sessionId },
    );
    if (!res.ok) throw res.error;

    const match = res.value.content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Planner output did not contain a JSON object: ${res.value.content.slice(0, 200)}`);
    const parsed = JSON.parse(match[0]) as {
      objective?: string;
      nodes?: Array<{ id?: string; goal?: string; agent?: string; dependsOn?: string[]; needsInput?: boolean }>;
    };
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      throw new Error(`Planner returned no nodes: ${match[0].slice(0, 200)}`);
    }
    const nodes: PlanNode[] = parsed.nodes.map((n, i) => {
      if (typeof n.goal !== 'string' || n.goal.trim() === '') {
        throw new Error(`Planner node is missing a goal: ${JSON.stringify(n)}`);
      }
      return {
        id: n.id ?? `n${i + 1}`,
        goal: n.goal,
        agent: n.agent,
        dependsOn: n.dependsOn,
        needsInput: n.needsInput,
      };
    });
    return { nodes, objective: parsed.objective, createdAt: Date.now() };
  }
}
```

- [ ] **Step 4: Run, expect PASS (4 tests)**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/dag/__tests__/llm-dag-planner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/llm-dag-planner.test.ts
git commit -m "feat(libs): slice1 LlmDagPlanner — prompt+catalog -> DagPlan (direct-LLM MVP), fail-loud parse"
```

---

## Task 5: `DagCoordinatorHandler` (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
} from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

const planner = (nodes: DagPlan['nodes']): IPlanner => ({
  name: 'p',
  plan: async () => ({ nodes, createdAt: 0 }),
});
const interp = (r: InterpretResult): IInterpreter<DagPlan, InterpretResult> => ({
  name: 'i',
  interpret: async () => r,
});

function makeCtx(inputText: string) {
  const yields: Array<{ ok: boolean; value: { content: string; finishReason?: string } }> = [];
  const ctx = {
    inputText, sessionId: 't',
    yield: (c: { ok: boolean; value: { content: string; finishReason?: string } }) => yields.push(c),
  } as unknown as Parameters<DagCoordinatorHandler['execute']>[0];
  return { ctx, yields };
}

describe('DagCoordinatorHandler', () => {
  it('plans then interprets and streams the output raw', async () => {
    const { ctx, yields } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: true, output: '42' }),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(yields[0].value.content, '42');
    assert.equal(yields[1].value.finishReason, 'stop');
  });

  it('maps interpreter ok:false to COORDINATOR_STEP_FAILED', async () => {
    const { ctx } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: planner([{ id: 'n1', goal: 'g' }]),
      interpreter: interp({ nodeResults: {}, ok: false, error: 'boom', output: '' }),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal((ctx as unknown as { error?: { code?: string } }).error?.code, 'COORDINATOR_STEP_FAILED');
  });

  it('maps a planner throw to COORDINATOR_PLAN_FAILED', async () => {
    const { ctx } = makeCtx('hi');
    const h = new DagCoordinatorHandler({
      planner: { name: 'p', plan: async () => { throw new Error('nope'); } },
      interpreter: interp({ nodeResults: {}, ok: true, output: 'x' }),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal((ctx as unknown as { error?: { code?: string } }).error?.code, 'COORDINATOR_PLAN_FAILED');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/dag-coordinator.test.ts`

- [ ] **Step 3: Implement**

```ts
// packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export interface DagCoordinatorHandlerDeps {
  planner: IPlanner;
  interpreter: IInterpreter<DagPlan, InterpretResult>;
  workers: ReadonlyMap<string, ISubAgent>;
}

export class DagCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: DagCoordinatorHandlerDeps) {}

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    let plan: DagPlan;
    try {
      plan = await this.deps.planner.plan({
        prompt: ctx.inputText,
        agents: [...this.deps.workers.values()].map((w) => ({
          name: w.name,
          description: w.description,
        })),
        sessionId: ctx.sessionId,
        signal: ctx.options?.signal,
      });
    } catch (err) {
      ctx.error = wrap(err, 'COORDINATOR_PLAN_FAILED');
      return false;
    }

    let result: InterpretResult;
    try {
      result = await this.deps.interpreter.interpret(plan, {
        inputText: ctx.inputText,
        workers: this.deps.workers,
        sessionId: ctx.sessionId,
        signal: ctx.options?.signal,
        layer: ctx.layer ?? 0,
      });
    } catch (err) {
      // COORDINATOR_PLAN_INVALID (structural) or any interpreter throw.
      ctx.error = wrap(err, 'COORDINATOR_PLAN_INVALID');
      return false;
    }

    if (!result.ok) {
      ctx.error = new OrchestratorError(
        `coordinator: ${result.error ?? 'plan execution failed'}`,
        'COORDINATOR_STEP_FAILED',
      );
      return false;
    }

    ctx.options?.sessionLogger?.logStep('dag_coordinator_final', {
      nodeCount: plan.nodes.length,
      outputLength: result.output.length,
    });
    ctx.yield({ ok: true, value: { content: result.output } });
    ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
    return true;
  }
}

function wrap(err: unknown, code: string): OrchestratorError {
  if (err instanceof OrchestratorError) return err;
  const e = err as { code?: string; message?: string };
  // Preserve a structural plan-invalid code if the interpreter set one.
  const finalCode = e?.code === 'COORDINATOR_PLAN_INVALID' ? e.code : code;
  return new OrchestratorError(e?.message ?? String(err), finalCode);
}
```

- [ ] **Step 4: Run, expect PASS (3 tests)**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/dag-coordinator.test.ts`

- [ ] **Step 5: Build + commit**

Run `npm run build`, then:

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator.test.ts
git commit -m "feat(libs): slice1 DagCoordinatorHandler — sequence planner -> interpreter; plan/step error mapping; raw stream"
```

---

## Task 6: Wire the DAG coordinator into the pipeline

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/index.ts`
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-wiring.test.ts`

- [ ] **Step 1: Add a DAG coordinator option to the handler registry**

In `packages/llm-agent-libs/src/pipeline/handlers/index.ts`:
- import `DagCoordinatorHandler` and `DagCoordinatorHandlerDeps` from `./dag-coordinator.js`;
- add `dagCoordinator?: DagCoordinatorHandlerDeps` to the registry options interface (next to the existing `coordinator?: CoordinatorHandlerDeps`);
- when `opts.dagCoordinator` is set, register it under the same stage name as the linear coordinator so the existing `coordinator` / `coordinator-activate` gating applies:

```ts
  if (opts.dagCoordinator) {
    registry.set('coordinator', new DagCoordinatorHandler(opts.dagCoordinator));
  } else if (opts.coordinator) {
    registry.set('coordinator', new CoordinatorHandler(opts.coordinator));
  }
```

(The two are mutually exclusive — config validation in Task 7 guarantees only one is set.)

- [ ] **Step 2: Add a DAG coordinator config to `DefaultPipeline` and wire it**

In `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`:
- add `dagCoordinator?: DagCoordinatorHandlerDeps` to the pipeline options interface (alongside `coordinator?: ICoordinatorConfig`);
- store it (`this.dagCoordinator = options.dagCoordinator`);
- in the `buildDefaultHandlerRegistry({ ... })` call, pass `dagCoordinator: this.dagCoordinator`, and treat its presence the same as a configured linear coordinator for `coordinatorActivation` (so the `coordinator-activate` stage and the `when: 'coordinatorActive'` gating still apply):

```ts
    const dagConfigured = this.dagCoordinator != null;
    // ...existing coordPlanning/coordDispatch/coordinatorConfigured...
    const anyCoordinator = coordinatorConfigured || dagConfigured;
    // registry:
    //   coordinator: coordinatorConfigured ? {linear deps} : undefined  (existing)
    //   dagCoordinator: this.dagCoordinator,
    //   coordinatorActivation: anyCoordinator ? (activation ?? ExplicitActivation) : undefined
```

Keep the existing linear `coordinator:` wiring untouched; only ADD the `dagCoordinator` branch and broaden the `coordinatorActivation` guard from `coordinatorConfigured` to `anyCoordinator`.

- [ ] **Step 3: Write a wiring test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DagPlan, IInterpreter, InterpretResult, IPlanner } from '@mcp-abap-adt/llm-agent';
import { buildDefaultHandlerRegistry } from '../index.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

describe('handler registry — DAG coordinator', () => {
  it('registers DagCoordinatorHandler under the coordinator stage when dagCoordinator is set', () => {
    const planner = { name: 'p', plan: async () => ({ nodes: [{ id: 'n', goal: 'g' }], createdAt: 0 }) } as IPlanner;
    const interpreter = { name: 'i', interpret: async () => ({ nodeResults: {}, ok: true, output: 'x' }) } as IInterpreter<DagPlan, InterpretResult>;
    const reg = buildDefaultHandlerRegistry({
      dagCoordinator: { planner, interpreter, workers: new Map() },
      coordinatorActivation: { name: 'explicit', shouldActivate: () => true },
    });
    assert.ok(reg.get('coordinator') instanceof DagCoordinatorHandler);
  });
});
```

- [ ] **Step 4: Build + run, expect PASS**

Run: `npm run build`, then `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/dag-coordinator-wiring.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/index.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator-wiring.test.ts
git commit -m "feat(libs): slice1 wire DagCoordinatorHandler into the coordinator stage (presence-selected)"
```

---

## Task 7: Interpret `coordinator.planner` in the server config (TDD)

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCoordinatorConfigShape } from '../config.js';

describe('coordinator config shape (DAG vs linear)', () => {
  it('accepts a DAG coordinator (planner present, activation allowed)', () => {
    assert.doesNotThrow(() => assertCoordinatorConfigShape({ planner: { type: 'llm' }, activation: 'auto' }));
  });
  it('accepts a linear coordinator (planning present)', () => {
    assert.doesNotThrow(() => assertCoordinatorConfigShape({ planning: 'one-shot', dispatch: 'hybrid' }));
  });
  it('rejects mixing planner with linear-only fields', () => {
    assert.throws(() => assertCoordinatorConfigShape({ planner: { type: 'llm' }, maxSteps: 5 }), /maxSteps/);
    assert.throws(() => assertCoordinatorConfigShape({ planner: { type: 'llm' }, planning: 'one-shot' }), /planning/);
    assert.throws(() => assertCoordinatorConfigShape({ planner: { type: 'llm' }, plannerLlm: 'main' }), /plannerLlm/);
  });
  it('rejects DAG-only fields in a linear coordinator', () => {
    assert.throws(() => assertCoordinatorConfigShape({ planning: 'one-shot', interpreter: { type: 'dag' } }), /interpreter/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/dag-coordinator-config.test.ts`

- [ ] **Step 3: Add `assertCoordinatorConfigShape` to `config.ts`**

```ts
// packages/llm-agent-server/src/smart-agent/config.ts  (new exported helper)
const LINEAR_ONLY = ['planning', 'dispatch', 'maxSteps', 'maxRetriesPerStep', 'failPolicy', 'maxLayer', 'plannerLlm'];
const DAG_ONLY = ['planner', 'interpreter'];

/** Fail-loud guard: a coordinator block is either DAG (has `planner`) or linear,
 *  never mixed. `activation` is shared and always allowed. */
export function assertCoordinatorConfigShape(coord: Record<string, unknown>): void {
  const isDag = coord.planner !== undefined;
  if (isDag) {
    for (const f of LINEAR_ONLY) {
      if (coord[f] !== undefined) {
        throw new Error(`coordinator: '${f}' is a linear-only field and cannot be combined with 'planner' (DAG mode)`);
      }
    }
  } else {
    for (const f of DAG_ONLY) {
      if (coord[f] !== undefined) {
        throw new Error(`coordinator: '${f}' is a DAG-only field; a linear coordinator uses 'planning'/'dispatch'`);
      }
    }
  }
}
```

- [ ] **Step 4: Wire DAG-mode construction in `smart-server.ts`**

In the coordinator-config region of `smart-server.ts` (where it currently calls `resolveCoordinatorPlanning`/`resolveCoordinatorDispatch` and `builder.withCoordinator(...)`):
- call `assertCoordinatorConfigShape(coordCfg)` first (fail-loud);
- if `coordCfg.planner` is present (DAG mode), build the DAG deps and pass them via a new builder method `withDagCoordinator({ planner, interpreter, workers })` instead of `withCoordinator(...)`:
  - `planner = new LlmDagPlanner(plannerLlm)` (the already-resolved `plannerLlm`; `coordCfg.planner.plannerLlm` overrides 'main'/'helper' the same way the linear path resolves it);
  - `interpreter = new DagPlanInterpreter()` (default; `coordCfg.interpreter` reserved for future impls);
  - `workers` = the subagent registry already built from top-level `subagents:` (the same `Map<string, ISubAgent>` the linear path passes to `withSubAgents`);
- else keep the existing linear `withCoordinator(...)` path unchanged.

Add `withDagCoordinator(deps)` to `SmartAgentBuilder` (stores into the pipeline options' `dagCoordinator`), mirroring the existing `withCoordinator`. Export `LlmDagPlanner` / `DagPlanInterpreter` from `@mcp-abap-adt/llm-agent-libs` so the server can construct them.

- [ ] **Step 5: Run, expect PASS + build**

Run: `cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/dag-coordinator-config.test.ts`, then `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/index.ts
git add packages/llm-agent-server/src/smart-agent/__tests__/dag-coordinator-config.test.ts
git commit -m "feat(server): slice1 interpret coordinator.planner (DAG mode) with fail-loud shape guard; builder.withDagCoordinator"
```

---

## Task 8: Backward-compat guard + full gate

**Files:**
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/existing-coordinator-yaml-loads.test.ts`

- [ ] **Step 1: Backward-compat regression test — existing example configs still parse + validate**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { assertCoordinatorConfigShape } from '../config.js';

const EXAMPLES = [
  'docs/examples/coordinator-orchestration.yaml',
  'docs/examples/coordinator-orchestration-deepseek.yaml',
];

describe('existing coordinator example YAMLs remain valid (backward-compat)', () => {
  for (const rel of EXAMPLES) {
    it(`${rel} parses and its coordinator block is a valid linear shape`, () => {
      const y = parseYaml(readFileSync(`${process.cwd()}/../../${rel}`, 'utf8')) as { coordinator?: Record<string, unknown> };
      // (resolve the path from the package cwd; adjust the prefix if the test runs from repo root)
      if (y.coordinator) {
        assert.doesNotThrow(() => assertCoordinatorConfigShape(y.coordinator!));
      }
    });
  }
});
```

(If the relative path resolution differs in this runner, read the files via an absolute path from the repo root — the assertion is what matters: the existing blocks pass `assertCoordinatorConfigShape` as linear.)

- [ ] **Step 2: Run, expect PASS**

Run: `cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/existing-coordinator-yaml-loads.test.ts`

- [ ] **Step 3: Full gate**

Run: `npm run build` (clean), `npm run lint:check` (clean; `npm run lint` to fix formatting on touched files if flagged), `npm test` (0 failures across workspaces).

- [ ] **Step 4: Manual smoke (optional, needs LLM)**

A YAML with `subagents:` (≥1) + `coordinator: { planner: { type: llm } }`: a multi-step prompt fans out into a DAG and aggregates; a simple prompt yields a single-node plan answered by one worker. A config with no `coordinator:` still runs tool-loop unchanged.

- [ ] **Step 5: Final commit (only if lint produced changes)**

```bash
git add -A && git commit -m "chore: slice1 lint/format + backward-compat guard"
```

---

## Notes for the implementer

- `OrchestratorError(message, code)` is the existing error class (see `agent.ts`, used by the linear `CoordinatorHandler`); reuse its `code` field for `COORDINATOR_PLAN_FAILED` / `COORDINATOR_PLAN_INVALID` / `COORDINATOR_STEP_FAILED`.
- The linear coordinator (`CoordinatorHandler`, `Plan`/`PlanStep`, `IPlanningStrategy`, dispatch strategies, `compose-task.ts`) must NOT be edited — slice 1 is purely additive.
- `ISubAgent.run` returns `ISubAgentResult` (no `ok`); the interpreter maps resolve→done, throw→failed, `errorClass:'epicfail'`→failed (already in Task 3).
- Workers come from the EXISTING top-level `subagents:` registry; no new subagent config shape.
- Verify integration points against the real code before editing wiring (Task 6/7): `buildDefaultHandlerRegistry` options, `DefaultPipeline` coordinator/`coordinator-activate` gating, and the smart-server coordinator block. If a signature differs slightly, follow the existing linear-coordinator wiring as the template.
