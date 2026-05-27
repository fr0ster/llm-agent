# Slice 4a: Autonomous reviewer-driven execution-error recovery

Status: design (active — slice 4a of the coordinator-redesign epic)
Date: 2026-05-27
Epic anchor: `docs/superpowers/specs/2026-05-25-coordinator-redesign-epic-overview.md`
Builds on: slice 1 (DAG coordinator), slice 2 (plan reviewer), slice 3 (replan + IErrorStrategy)

## Goal

When a node fails during DAG execution, let the **reviewer** decide recovery: it
replans the **remaining objective** taking the **current (mutated) system state as
the new baseline**, and the interpreter swaps the running plan for that revised
plan and continues — without re-doing completed work and without rolling back side
effects.

This is the autonomous half of the epic's slice 4. The human-in-the-loop half
(pause-on-clarification + resume across turns, `ICoordinator` extraction) is
**slice 4b** and is out of scope here. When the reviewer cannot decide
autonomously, 4a **fails loud** (abort); 4b will add the pause.

## Scope & compatibility

**Additive, no breaking change** (the new reviewer method is optional; new
`errorStrategy: { type: reviewer }`, a `revise` `ErrorReaction` variant, two
`ErrorContext` fields). Existing strategies (`abort`, `replan`) and `ReviewVerdict`
are unchanged. It lands before the epic's pending release, so it ships inside the
**same pending major (17.0.0)** as slice 3 — but 4a itself breaks nothing.

**Tracked invariant (must not break): backward compatibility with existing YAML.**
Every existing example config (`docs/examples/*.yaml`, `examples/**`) must keep
validating and loading unchanged. `coordinator.errorStrategy` already exists
(slice 3, `abort|replan`); `reviewer` is an added value. **Regression guard:** the
existing-config tests must stay green.

## Model — "new plan = current state as the new origin"

On execution error we **return to replanning**, but the current system state is the
new reference point. Completed work persists in the world (a created table stays);
the revised plan is written **idempotently/adaptively** against that state ("table
exists → modify, don't create"). We do **not** reset side effects and we do **not**
compute a surgical dependent-closure — the reviewer produces a fresh plan for the
remaining objective, and the interpreter runs it from scratch. The completed
nodes' outputs are handed to the reviewer as the **execution trace** (state
knowledge), not preserved as graph nodes.

## Architecture

### A.1 Reviewer gains execution-failure review

Extend `IReviewStrategy` (in `@mcp-abap-adt/llm-agent`) with a second method:

```ts
export interface ExecutionFailureInput {
  objective?: string;        // plan-level objective (the remaining goal)
  plan: DagPlan;             // the plan as it stands now
  trace: NodeResult[];       // completed/failed nodes so far = current state knowledge
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
  review(input: ReviewInput): Promise<ReviewVerdict>;            // slice 2 (unchanged)
  reviewExecutionFailure?(                                       // NEW (4a), OPTIONAL
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewDecision>;
}
```

The new method is **optional** → no break for existing/external `IReviewStrategy`
implementors (truly additive). The two in-box impls implement it. `ReviewerErrorStrategy`
treats a reviewer that does not implement it as "cannot decide" (abort); the server
fails loud at startup if `errorStrategy.type==='reviewer'` is configured with a
reviewer that lacks the method.

- **`LlmReviewStrategy.reviewExecutionFailure`** — prompts its `DirectLlmSubAgent`
  critic with: the objective, the current plan (JSON), the **execution trace**
  (each completed node's id + output → what was done / current state), the failed
  node id + error, and the agent catalog. The critic is instructed to emit ONLY a
  JSON object: `{"action":"abort"}` or `{"action":"revise","plan":{...DagPlan...}}`,
  where the revised plan covers the **remaining** objective and is written
  **against the current state** (idempotent: "object exists → modify, not create").
  Parsing mirrors the planner (regex-extract JSON, try/catch, validate the
  discriminator and the revised plan via the same node-field checks). Re-inspection
  via tools is enabled only if the reviewer is configured as a tool-capable
  subagent; the MVP relies on the trace.
- **`NoopReviewStrategy.reviewExecutionFailure`** → always `{ action: 'abort' }`.

### A.2 New non-local error reaction + ErrorContext fields

In `error-strategy.ts`:

```ts
export type ErrorReaction =
  | { action: 'abort' }
  | { action: 'replan'; subPlan: DagPlan }            // slice 3 (local)
  | { action: 'revise'; revisedPlan: DagPlan };        // NEW (4a, whole-remainder)

export interface ErrorContext {
  task: string;
  remainingReplans: number;     // shared budget (replan AND revise consume it)
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
  // NEW (4a): the current plan + completed results, so a reviewer-driven
  // strategy can replan the remainder against current state.
  plan: DagPlan;
  completedResults: NodeResult[];
}
```

Existing strategies (`AbortErrorStrategy`, `ReplanErrorStrategy`) ignore the new
fields — no behavior change.

### A.3 `ReviewerErrorStrategy implements IErrorStrategy`

```
new ReviewerErrorStrategy(reviewer: IReviewStrategy, maxReplans = 4)
```
- `maxReplans` is the per-run revision-budget ceiling (reuses slice-3's interpreter
  counter — a revise consumes the same budget as a replan).
- `onNodeFailure(node, error, ctx)`: if `ctx.remainingReplans <= 0` **or** the
  reviewer does not implement `reviewExecutionFailure` → `{action:'abort'}` (no
  reviewer call). Otherwise build `ExecutionFailureInput` from `ctx.plan`,
  `ctx.completedResults`, `node.id`, `errMsg(error)`, `ctx.agents`, and call
  `reviewer.reviewExecutionFailure(...)`. Map `{action:'abort'}` →
  `{action:'abort'}`; `{action:'revise', revisedPlan}` →
  `{action:'revise', revisedPlan}`.

### A.4 Interpreter — pass trace, handle `revise`

In `DagPlanInterpreter`:
- When building `ErrorContext` for `onNodeFailure`, also pass `plan: { ...plan, nodes: liveNodes }` and `completedResults: Object.values(results)`.
- Handle the `revise` reaction in the serial apply phase (alongside `replan`):
  ```
  if (reaction.action === 'revise' && remainingReplans > 0) {
    liveNodes = reaction.revisedPlan.nodes;   // swap the whole remaining plan
    // start the revised plan from scratch — completed work lives in the world
    // (and was given to the reviewer as trace); old results are dropped.
    for (const key of Object.keys(results)) delete results[key];
    done.clear();
    replansUsed++;
    splicedThisWave = true;
    break;   // a whole-plan swap supersedes the rest of this wave's outcomes
  }
  ```
  (`break` exits the per-wave outcome loop: the old plan's other outcomes are moot
  once the plan is replaced.) `replan` (local splice, slice 3) keeps its existing
  behavior and does NOT break the loop.
- After the wave, the existing `if (splicedThisWave) this.validate(...)` re-validates
  the swapped graph (empty/dup/missing-dep/cycle/unresolvable/contextPolicy) → an
  invalid revised plan fails loud as `COORDINATOR_PLAN_INVALID`. Guard: an empty
  `revisedPlan.nodes` is rejected the same way the empty-sub-plan guard rejects an
  empty replan (`COORDINATOR_PLAN_INVALID`).

### A.5 Config + wiring

- `coordinator.errorStrategy: { type: 'abort' | 'replan' | 'reviewer'; maxReplans? }`.
  `maxReplans` is the single per-run intervention-budget ceiling for ALL types (a
  reviewer `revise` consumes it just like a `replan`). DAG-only (already in
  `DAG_ONLY`). `assertErrorStrategyShape` adds `'reviewer'` to the allowed types.
- smart-server DAG branch: `if (esCfg.type === 'reviewer')` → require a configured
  `coordinator.reviewer` (the same `LlmReviewStrategy` instance built for the plan
  gate) and build `new ReviewerErrorStrategy(reviewer, esCfg.maxReplans)`. Fail loud
  at startup if `errorStrategy.type==='reviewer'` but no `reviewer` is configured.

## Error handling

| Situation | Outcome |
|-----------|---------|
| node fails, errorStrategy=reviewer, budget>0 | reviewer decides: `abort` → node failed; `revise` → swap remaining plan, continue |
| reviewer returns `abort` (cannot decide autonomously) | node failed → `InterpretResult.ok=false` (4b will pause instead) |
| budget exhausted | abort with no reviewer call |
| revised plan empty / structurally invalid | `COORDINATOR_PLAN_INVALID` (re-validation) |
| errorStrategy=reviewer but no reviewer configured | fail loud at startup |
| errorStrategy=abort/replan | unchanged (slice 1–3 behavior) |

## Testing

- **`LlmReviewStrategy.reviewExecutionFailure`** — `{action:'revise',plan}` parsed
  into `{action:'revise', revisedPlan}` with the trace embedded in the critic
  prompt; `{action:'abort'}` parsed; malformed JSON throws; an invalid revised plan
  (bad node fields) throws.
- **`NoopReviewStrategy.reviewExecutionFailure`** → always abort.
- **`ReviewerErrorStrategy`** — failure with budget>0 calls the reviewer and returns
  its decision; `remainingReplans<=0` → abort with the reviewer mock NOT called;
  builds `ExecutionFailureInput` with the plan + completed trace.
- **Interpreter revise** — a node fails, the reviewer returns a revised plan; the
  interpreter swaps to it, old results dropped, the revised plan runs and the run
  completes with the revised plan's output; an empty revised plan →
  `COORDINATOR_PLAN_INVALID`; budget exhausted → the node fails (`ok=false`);
  two failures in one wave → the first revise swaps and supersedes the rest.
- **Config** — `errorStrategy: { type: reviewer, maxReplans: 2 }` accepted;
  `reviewer` type with no `coordinator.reviewer` → startup error.
- **Backward-compat guard** — existing example YAMLs still validate; `abort`/`replan`
  error strategies behave exactly as in slice 3.
- **Full suite** green; build + lint:check clean.

## Out of scope (→ slice 4b)

- Human-in-the-loop pause-on-clarification + resume across turns.
- Formal `ICoordinator` extraction (batch + dialog impls).
- `ReviewVerdict.needsClarification` and the resumable store.
- Surgical dependent-closure / result-reset cascade (superseded by full
  state-baselined replan-of-remainder), and side-effect rollback/compensation
  (explicitly not done — the revised plan is state-aware instead).
