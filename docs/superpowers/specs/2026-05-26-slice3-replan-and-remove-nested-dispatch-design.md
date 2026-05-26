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

**Ownership note:** `IErrorStrategy` is an **interpreter (execution) strategy**, not
a coordinator policy. It is invoked by the `DagPlanInterpreter` — the component that
actually executes the Pipeline/DAG and can exist and run **without any coordinator**
(e.g. a direct `interpret(plan, ctx)` call). The coordinator's only role is to pass
the *configured* strategy through into `InterpretContext`; it does not call the
strategy itself. This keeps the failure-reaction decision next to the execution that
produces the failure.

```ts
// packages/llm-agent/src/interfaces/error-strategy.ts
import type { DagPlan, PlanNode } from './dag-plan.js';
import type { PlannerCatalogEntry } from './planner.js';

export interface ErrorContext {
  /** The composed task the failed node was given (goal + dependency outputs +
   *  original user input) — so a replan can re-plan with full context, not just
   *  the bare goal. */
  task: string;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}
export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan };

export interface IErrorStrategy {
  readonly name: string;
  /** Replan budget ceiling for an interpret run. Read once by the interpreter,
   *  which owns the per-run counter. Omitted (e.g. AbortErrorStrategy) → the
   *  interpreter uses its default ceiling (4). The strategy never counts. */
  readonly maxReplans?: number;
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
- **`ReplanErrorStrategy`** — owns an `IPlanner` and a `maxReplans` **config**
  value only (a constant, NOT a mutable counter — the strategy is a stateless
  singleton; see A.4 for where the per-run counter lives). It replans **only** for
  `NeedsDecompositionError` (the explicit "decompose me" signal); **any other error
  → `{ action: 'abort' }`** (a transient MCP/LLM failure is not fixed by
  decomposition and must not trigger a replan storm). On a `NeedsDecompositionError`:
  call `planner.plan({ prompt: ctx.task + '\n\nThis task needs decomposition: ' +
  error.reason, agents, sessionId, signal })` — the **composed task** (not the bare
  goal) plus the reason — to get a sub-`DagPlan`, return `{ action: 'replan', subPlan }`.
  The strategy exposes `maxReplans` (a getter/readonly field) so the interpreter can
  read the budget ceiling, but does NOT track how many replans have happened.

### A.4 Interpreter changes (`DagPlanInterpreter`)

- `InterpretContext` gains `errorStrategy: IErrorStrategy` (always populated by the
  handler; defaults to `AbortErrorStrategy`). `InterpretContext.layer` is **removed**
  (see §B).
- **Wave model — collect, then apply serially.** A wave still runs its ready nodes
  concurrently (`Promise.all`), but a node's `run()` rejection/`epicfail` is no
  longer turned into a plan mutation *inside* the concurrent map. Instead each
  ready node's settled outcome is recorded as either `success(output)` or
  `failure(node, error, task)` into a per-wave outcomes list. **After the whole
  wave settles**, the interpreter processes outcomes **sequentially** (single-
  threaded, deterministic order — e.g. plan-node order):
  - success → record `done` (as today).
  - failure → call `ctx.errorStrategy.onNodeFailure(node, error, { task, agents,
    sessionId, signal })` (`task` = the composed task already built for that node;
    `agents` from `ctx.workers`):
    - `{ action: 'abort' }` → record the node `failed`.
    - `{ action: 'replan', subPlan }` (and budget remaining) → **splice** the
      sub-plan in place of the node (A.5), incrementing the per-run counter; do NOT
      record `failed`.
  This serialization means concurrent failures in the same wave never mutate
  `plan.nodes`, the replan counter, or validation state simultaneously — all
  splices for a wave are applied one-by-one, and graph **re-validation runs once**
  after the wave's splices are applied, before the next ready-set is computed.
  (Within a wave, independent failures are still all handled; they're just applied
  in sequence rather than racing.)
- A **per-invocation replan budget**: `interpret()` creates a local counter at the
  start of each call, initialized from the strategy's `maxReplans` ceiling (read
  once; default **4** when the strategy doesn't expose one — e.g. `AbortErrorStrategy`).
  Each applied replan increments a local `replansUsed`; when `replansUsed >=
  maxReplans` the interpreter treats further `{ action: 'replan' }` reactions as
  `abort`. The counter is **local to the interpret run** — never mutable state on
  the (singleton) strategy — so concurrent or repeated `interpret()` calls don't
  share or leak a budget. Prevents infinite replan loops.

### A.5 Splice semantics

Given failed node `X` and a returned `subPlan` (its nodes `S = {s1..sk}`):

1. Namespace the sub-plan node ids to avoid collisions (prefix with `X.id + ':'`),
   rewriting intra-sub-plan `dependsOn` accordingly.
2. Sub-plan **root** nodes (those whose namespaced `dependsOn` is empty) inherit
   `X`'s `dependsOn` (so the sub-graph starts where `X` started) **and** `X`'s
   `needsInput` flag — otherwise a node that originally consumed the user input
   would silently lose it after decomposition. (Belt-and-suspenders: the replan
   prompt handed to the planner already embeds `X`'s composed task — goal + the
   original input/dep context — so the sub-planner is aware of the available input;
   inheriting `needsInput` onto the roots guarantees the data is actually fed at
   interpret time regardless of how the sub-planner set the flag.)
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
- `InterpretContext` (`interpreter.ts`): remove `layer`; add `errorStrategy`.
- `ICoordinatorContext` (`coordinator.ts`): remove `layer`.
- `CallOptions` (`types.ts`): remove `layer?`.
- `SubAgentContextRequest` (`subagent-context.ts`): remove `layer`.
- `EpicFailTrace` (`coordinator.ts`): remove `layer` and `childTrace?` — these are
  the **cross-layer epicfail propagation** chain (#128–#132). `EpicFailTrace` keeps
  its non-nesting fields; the `errorClass: 'epicfail'` discriminator and the
  `epicFailTrace?` result field themselves are retained (a flat trace, no chain).

Complete public-API removal list (the breaking surface): `SubAgentKind`,
`SubAgentCapabilities.kind`, `SubAgentCapabilities.canDispatchChildren`,
`ISubAgentInput.layer`, `InterpretContext.layer`, `ICoordinatorContext.layer`,
`CallOptions.layer`, `SubAgentContextRequest.layer`, `EpicFailTrace.layer`,
`EpicFailTrace.childTrace`.

### B.2 Call-site removals (`llm-agent-libs`)

- `DagPlanInterpreter`: drop `layer: ctx.layer + 1` from the `worker.run(...)` call.
- `LlmDagPlanner`, `LlmReviewStrategy`: drop `layer: 0` from their `agent.run(...)`
  calls.
- `coordinator/dispatch/subagent.ts`: drop `childLayer`/`layer` plumbing.
- `pipeline/handlers/subagent.ts`: drop `layer: (ctx.layer ?? 0) + 1`.
- `pipeline/default-pipeline.ts`: drop `layer: options?.layer ?? 0`.
- `pipeline/context.ts`: remove `PipelineContext.layer?` and any reads of it.
- Any code that builds/propagates `EpicFailTrace.layer`/`childTrace` (the
  cross-layer chain) — stop populating them; an epicfail trace is now flat.
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
- **`ReplanErrorStrategy`** — reaction **by error type** only (the strategy is
  stateless, it does NOT track budget): `NeedsDecompositionError` → calls planner
  with `ctx.task`+reason → `{ action: 'replan', subPlan }`; a generic error (e.g.
  plain `Error`) → `{ action: 'abort' }` (no planner call). Plus: it **exposes**
  `maxReplans` (config readback) — but exhaustion behavior is NOT tested here (it's
  the interpreter's; see the per-run-budget test).
- **Interpreter replan** — a worker that throws `NeedsDecompositionError` with a
  replan strategy expands into a sub-graph and the run completes with the
  sub-graph's output; dependents of the failed node consume the sub-graph
  terminals; abort strategy (default) still fails the node as before; an invalid
  sub-plan → `COORDINATOR_PLAN_INVALID`; infinite-replan guard: a sub-plan that
  itself keeps signalling stops at the budget and aborts.
- **Splice** — id-namespacing avoids collisions; root sub-nodes inherit the failed
  node's `dependsOn` **and** `needsInput`; terminal sub-nodes feed the failed node's
  consumers (a focused unit test on the splice helper with a small graph).
- **Per-run budget** — two separate `interpret()` calls each get a fresh replan
  budget (no leakage between runs through the singleton strategy); within one run,
  the (maxReplans+1)-th replan signal aborts.
- **Concurrent-wave failures** — a wave with two nodes that both throw
  `NeedsDecompositionError` is handled deterministically: both failures are
  collected, then splices applied one-by-one (no interleaved mutation), and the run
  completes with both sub-graphs spliced. (Asserts serial application, not a race.)
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
