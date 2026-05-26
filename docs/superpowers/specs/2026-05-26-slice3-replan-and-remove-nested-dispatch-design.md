# Slice 3: Replan-by-leaf-signal + remove nested dispatch

Status: design (active — slice 3 of the coordinator-redesign epic)
Date: 2026-05-26
Epic anchor: `docs/superpowers/specs/2026-05-25-coordinator-redesign-epic-overview.md`
Builds on: slice 1 (batch DAG coordinator, #158), slice 2 (plan reviewer gate, #160)

## Goal

Give the DAG coordinator **dynamic decomposition** — a worker can signal that its
node is too big, and the coordinator re-plans that node into a finer sub-graph —
and **remove the nested-dispatch surface** entirely, so subagents are always
leaves. Dynamic decomposition relocates from "subagent spawns subagents" to
"coordinator replans a node by leaf-signal."

This is **one slice** with an additive half (A: replan) and a subtractive half
(B: remove nesting). B is a **breaking change to the programmatic API** (the
`ISubAgent` surface) → major version bump. Existing **YAML** configs keep loading
(YAML backward-compat is preserved; see §B).

## Terminology

Locked vocabulary (epic overview): **Pipeline** (interpreted description),
**Interpreter** (executes it), **Subagent** (a node the interpreter dispatches —
now *always a leaf*), **Component** (a subagent's internals).

Principle applied here: **a strategy is anything we want to configure via YAML.**
`IErrorStrategy` is configurable (`coordinator.errorStrategy`) → it is a strategy.
"Subagents are leaves" is *not* configurable → it is an invariant, removed in code,
not a strategy.

## A. Replan-by-leaf-signal (additive)

### A.1 Leaf-signal = a typed exception

A worker that determines its node cannot be done as-is and needs decomposition
**throws** a typed error (decomposition is an abnormal/exceptional outcome — the
node produced no usable output):

```ts
// packages/llm-agent/src/needs-decomposition-error.ts (or interfaces/-adjacent)
export class NeedsDecompositionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`needs decomposition: ${reason}`);
    this.name = 'NeedsDecompositionError';
    this.reason = reason;
  }
}
```

This is the **proactive** signal. **Reactive** failures (any other throw, or an
`errorClass: 'epicfail'` result) flow through the same place and are handled by
the error strategy too. No new field is added to `ISubAgentResult`
(`errorClass: 'epicfail'` is left untouched — a known minor inconsistency that is
out of scope here).

### A.2 `IErrorStrategy` (new contract)

```ts
// packages/llm-agent/src/interfaces/error-strategy.ts
import type { DagPlan, PlanNode } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ErrorContext {
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}
export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan };

export interface IErrorStrategy {
  readonly name: string;
  onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction>;
}
```

(The `ErrorReaction` union is a plain discriminated union — extensible if a later
slice needs more reactions; no forward-compat machinery is added now.)

### A.3 Implementations

- **`AbortErrorStrategy`** — always `{ action: 'abort' }`. This is the slice-1/2
  behavior (a failed node fails the plan). It is the **default** when no error
  strategy is configured.
- **`ReplanErrorStrategy`** — owns an `IPlanner` and a `maxReplans` budget. It
  replans **only** for `NeedsDecompositionError` (the explicit "decompose me"
  signal); **any other error → `{ action: 'abort' }`** (a transient MCP/LLM failure
  is not fixed by decomposition and must not trigger a replan storm). On a
  `NeedsDecompositionError`: call `planner.plan({ prompt: <node.goal> + '\n\n' +
  error.reason, agents, sessionId, signal })` to get a sub-`DagPlan`, return
  `{ action: 'replan', subPlan }`. When the budget is exhausted it returns
  `{ action: 'abort' }` (logged).

### A.4 Interpreter changes (`DagPlanInterpreter`)

- `InterpretContext` gains `errorStrategy: IErrorStrategy` (always populated by the
  handler; defaults to `AbortErrorStrategy`). `InterpretContext.layer` is **removed**
  (see §B).
- In the per-node `try/catch`, on a caught error (and on an `errorClass: 'epicfail'`
  result), instead of immediately recording `failed`, call
  `ctx.errorStrategy.onNodeFailure(node, error, { agents, sessionId, signal })`,
  where `agents` is built from `ctx.workers` (same catalog the planner sees):
  - `{ action: 'abort' }` → record the node `failed` (current behavior).
  - `{ action: 'replan', subPlan }` → **splice** the sub-plan in place of the node
    (see A.5) and continue the wave loop; do NOT record the node as `failed`.
- A **global replan budget** is tracked on the interpret run (an integer counter,
  default from the strategy's `maxReplans`, default value **4**). Each applied
  replan decrements it; at zero the next failure aborts. Prevents infinite replan
  loops.

### A.5 Splice semantics

Given failed node `X` and a returned `subPlan` (its nodes `S = {s1..sk}`):

1. Namespace the sub-plan node ids to avoid collisions (prefix with `X.id + ':'`),
   rewriting intra-sub-plan `dependsOn` accordingly.
2. Sub-plan nodes whose (namespaced) `dependsOn` is empty inherit `X`'s
   `dependsOn` (so the sub-graph starts where `X` started).
3. Every node that depended on `X` is rewritten to depend on the **terminal**
   nodes of the sub-plan (sub-plan nodes that nothing in `S` depends on) — so
   `X`'s consumers now consume the sub-graph's outputs.
4. Remove `X`; add `S`. Continue interpreting (the ready-set loop naturally picks
   up the new nodes). Sub-nodes are **flat** — same level, no nesting.

Validation (duplicate ids, missing deps, cycles, unresolvable workers, the
`contextPolicy: 'required'` rejection from slice 1) is re-run on the spliced graph
before the next wave so a bad sub-plan fails loud as `COORDINATOR_PLAN_INVALID`.

### A.6 Wiring

- `DagCoordinatorHandlerDeps` gains `errorStrategy?: IErrorStrategy`; the handler
  passes `errorStrategy ?? new AbortErrorStrategy()` into `InterpretContext`.
- `SmartAgentBuilder.withDagCoordinator(deps)` already forwards the whole deps
  object — `errorStrategy` flows through automatically.
- **Config (YAML, this IS a strategy → configurable):**
  `coordinator.errorStrategy: { type: 'abort' | 'replan'; maxReplans?: number }`,
  default `abort`. DAG-only (added to `DAG_ONLY`; validated by a small shape
  guard). `replan` reuses `coordinator.planner` (the same planner LLM). smart-server
  builds `AbortErrorStrategy` or `ReplanErrorStrategy(planner, maxReplans ?? 4)`.

## B. Remove nested dispatch (breaking — programmatic API; major bump)

The recursive subagent-spawns-subagent surface is removed; subagents are leaves.

### B.1 Interface removals (`@mcp-abap-adt/llm-agent`)

- `SubAgentCapabilities`: remove `kind` and `canDispatchChildren`; drop the
  `SubAgentKind = 'autonomous' | 'constrained'` type. `SubAgentCapabilities` keeps
  only `contextPolicy`.
- `ISubAgentInput`: remove the required `layer` field.
- `InterpretContext` (`interpreter.ts`) and `ICoordinatorContext` (`coordinator.ts`):
  remove the `layer` field. (`InterpretContext` instead gains `errorStrategy`.)

### B.2 Call-site removals (`llm-agent-libs`)

- `DagPlanInterpreter`: drop `layer: ctx.layer + 1` from the `worker.run(...)` call.
- `LlmDagPlanner`, `LlmReviewStrategy`: drop `layer: 0` from their `agent.run(...)`
  calls.
- `coordinator/dispatch/subagent.ts`: drop `childLayer`/`layer` plumbing.
- `pipeline/handlers/subagent.ts`: drop `layer: (ctx.layer ?? 0) + 1`.
- `pipeline/default-pipeline.ts`: drop `layer: options?.layer ?? 0`.
- `subagent/smart-agent-subagent.ts`: drop `kind`/`canDispatchChildren` from its
  `capabilities`; drop `layer: input.layer` plumbing.
- `subagent/direct-llm-subagent.ts`: drop `kind`/`canDispatchChildren` from its
  `capabilities` (keep `contextPolicy`).
- **Linear `CoordinatorHandler` (`pipeline/handlers/coordinator.ts`) → leaves-only:**
  remove the `maxLayer` dep field and the `validatePlan` layer/kind gate (the
  `layer >= maxLayer` and `layer >= 1 && kind === 'autonomous'` checks). The linear
  coordinator keeps working — it just no longer enforces (or supports) nesting.
  Remove `maxLayer` from `CoordinatorHandlerDeps` and from the builder/pipeline
  options that thread it.

### B.3 YAML backward-compat (preserved)

The breaking change is **programmatic only**. Existing YAML must keep loading:

- `coordinator.maxLayer` stays **accepted but ignored** (it remains in the
  `LINEAR_ONLY` list so the DAG/linear-mixing guard is unaffected; the linear
  builder simply no longer reads it). A YAML that sets `maxLayer: N` loads and runs
  unchanged (the value is a no-op). No reject, no rename.
- No other YAML field changes. The existing example configs must still parse and
  validate (regression guard).

## Error handling summary

| Situation (DAG interpret) | Outcome |
|---------------------------|---------|
| node throws `NeedsDecompositionError` | error strategy consulted; replan strategy expands the node into a sub-graph, abort strategy fails it |
| node throws any other error / returns `errorClass: 'epicfail'` | error strategy consulted; **both** strategies abort (replan only fires for `NeedsDecompositionError`) → node `failed` |
| replan budget exhausted | next `NeedsDecompositionError` aborts → node `failed`, `InterpretResult.ok = false` |
| spliced sub-plan is structurally invalid | `COORDINATOR_PLAN_INVALID` (validation re-run) |
| all nodes done | aggregated terminal output (unchanged) |

Error codes from slices 1–2 (`COORDINATOR_PLAN_INVALID`, `COORDINATOR_STEP_FAILED`,
…) are unchanged; they remain provisional.

## Testing

- **`NeedsDecompositionError`** — constructs with `reason`; `instanceof Error`.
- **`AbortErrorStrategy`** — always `{ action: 'abort' }`.
- **`ReplanErrorStrategy`** — `NeedsDecompositionError` → calls planner with
  goal+reason → `{ action: 'replan', subPlan }`; a generic error (e.g. plain
  `Error`) → `{ action: 'abort' }` (no planner call); budget exhausted → `{ action:
  'abort' }` even for `NeedsDecompositionError`.
- **Interpreter replan** — a worker that throws `NeedsDecompositionError` with a
  replan strategy expands into a sub-graph and the run completes with the
  sub-graph's output; dependents of the failed node consume the sub-graph
  terminals; abort strategy (default) still fails the node as before; an invalid
  sub-plan → `COORDINATOR_PLAN_INVALID`; infinite-replan guard: a sub-plan that
  itself keeps signalling stops at the budget and aborts.
- **Splice** — id-namespacing avoids collisions; empty-dep sub-nodes inherit the
  failed node's deps; terminal sub-nodes feed the failed node's consumers (a
  focused unit test on the splice helper with a small graph).
- **Nested-dispatch removal** — the linear `CoordinatorHandler` no longer rejects
  a plan for layer/kind reasons (the prior layer-gate tests are removed/updated to
  assert the gate is gone); subagents build without `kind`/`canDispatchChildren`;
  the codebase compiles with `layer` removed everywhere.
- **Config** — `coordinator.errorStrategy: { type: replan, maxReplans: 3 }`
  accepted; unknown `errorStrategy.type` rejected; `errorStrategy` in a linear
  coordinator rejected (DAG-only).
- **YAML backward-compat** — existing example YAMLs still validate; a YAML with
  `coordinator.maxLayer: 2` still loads and runs (value ignored).
- **Full suite** green across workspaces; build + lint:check clean.

## Out of scope

- Dialog / resumable coordinator (slice 4). No forward-compat machinery for it is
  added here — slice 3 is designed for its own requirements; if slice 4 finds that
  breaking these contracts is better, it will break them then (git + the slice
  process handle that).
- Reworking `errorClass: 'epicfail'` into the exception model (left as-is).
- An `IResult` type hierarchy for subagent results (not pursued).
- Result-side review; reviewer-as-named-catalog-subagent.
