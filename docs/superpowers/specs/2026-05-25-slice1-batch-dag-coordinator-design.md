# Slice 1 — Batch DAG coordinator (MVP)

Status: design (implementable spec; sub-project 1 of the coordinator-redesign epic)
Date: 2026-05-25
Epic: `2026-05-25-coordinator-redesign-epic-overview.md`

## Goal

Add a **new, opt-in DAG coordinator** that, in one PR, runs end-to-end:
prompt → planner builds a `DagPlan` → plan interpreter executes the DAG
(topological, parallel where independent, data-flow along edges) → aggregated
result. Built **alongside** the existing linear coordinator, which stays
untouched. Selection is by **presence of declared components** in YAML (no
selector flag). Honors progressive complexity: a 1-node plan (single worker
pipeline) is the natural default; fan-out only when the planner decides.

## Principles carried from the epic anchor

- **New, distinct types — no superset.** New graph types/interfaces live beside
  the linear `Plan`/`PlanStep`/`CoordinatorHandler`, which are NOT edited.
- **Shared seam = `ISubAgent`.** Workers are `ISubAgent`s; the DAG interpreter
  dispatches to them directly (it does NOT reuse the linear `IDispatchStrategy`,
  which is tied to `PlanStep`).
- **Coordinator is a thin sequencer**, a pipeline stage (replaces `tool-loop`
  when its DAG config is present), exactly like today's coordinator stage.
- **YAML backward-compat is sacred:** additive/optional only; existing configs
  load and behave unchanged; a regression guard loads the existing examples.
- Out of scope here (later slices): reviewer gate (2), replan/leaf-signal +
  nested-dispatch removal (3), dialog/resumable + extracting an `ICoordinator`
  interface (4), formalizing the YAML interpreter under `IInterpreter` (deferred).

## New types (package `@mcp-abap-adt/llm-agent`)

```ts
// interfaces/dag-plan.ts  (NEW — distinct from the linear Plan/PlanStep)
export interface PlanNode {
  id: string;
  /** The task instruction for this node (composed into the worker's task). */
  goal: string;
  /** Worker subagent name from the catalog; absent → the default worker. */
  agent?: string;
  /** Node ids whose outputs feed this node. Absent/empty → a root node (no deps). */
  dependsOn?: string[];
  /** When true, the original client prompt is embedded as delimited data. */
  needsInput?: boolean;
}

export interface DagPlan {
  nodes: PlanNode[];
  /** Shared objective forwarded into every node's composed task. */
  objective?: string;
  rationale?: string;
  createdAt: number;
}
```

Note: in this NEW type, **absent `dependsOn` means "root / no dependency"**
(parallelizable). There is no legacy-sequential overloading — that concern only
existed for the shared linear type, which we are not touching.

## New interfaces (package `@mcp-abap-adt/llm-agent`)

```ts
// interfaces/interpreter.ts  (NEW)
/** One generic interface; this epic ships the Plan implementation. The YAML
 *  interpreter (the server) is recognized as IInterpreter<Yaml,Pipeline> but is
 *  not rewritten here. */
export interface IInterpreter<TInput, TOutput> {
  readonly name: string;
  interpret(input: TInput, ctx: InterpretContext): Promise<TOutput>;
}

export interface InterpretContext {
  /** Original consumer prompt — the material a node embeds when needsInput. */
  inputText: string;
  /** Worker subagents available to dispatch, keyed by name. */
  workers: ReadonlyMap<string, ISubAgent>;
  sessionId: string;
  signal?: AbortSignal;
  /** Dispatch depth of THIS coordinator (root = 0). Workers are dispatched at
   *  `layer + 1` so they remain non-root leaves under the current layer rules
   *  (until slice 3 removes the nested API). */
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
  /** false if any node failed or was skipped (unreachable due to a failed dep). */
  ok: boolean;
  /** Set when `ok` is false — a human-readable summary of the failure. */
  error?: string;
  /** Final aggregated text (only meaningful when ok). */
  output: string;
}
```

```ts
// interfaces/planner.ts  (NEW)
export interface PlannerCatalogEntry { name: string; description: string }

export interface PlannerInput {
  prompt: string;
  agents: PlannerCatalogEntry[];
  sessionId: string;
  signal?: AbortSignal;
}

/** Typed adapter over ISubAgent (the epic's "planner is a subagent"): a concrete
 *  IPlanner owns an ISubAgent / LLM, builds its prompt from PlannerInput, and
 *  parses the result into a DagPlan. */
export interface IPlanner {
  readonly name: string;
  plan(input: PlannerInput): Promise<DagPlan>;
}
```

## New implementations (package `@mcp-abap-adt/llm-agent-libs`)

### `coordinator/dag/compose-node-task.ts`
`composeNodeTask(node, plan, ctx, depOutputs)` — deterministic, new (mirrors the
spirit of the linear `composeTask`, but DAG-scoped). Produces the worker `task`:
- `Task: <goal>`
- `Overall objective: <objective>` when `plan.objective` set
- `Input from <depId>:\n---\n<output>\n---` for each `dependsOn` dependency
  (data-flow along edges — the node sees *its* deps' outputs, not all prior)
- `Input (user-provided data):\n---\n<inputText>\n---` when `node.needsInput`
- When none apply → bare `goal` (single-node simple case).

### `coordinator/dag/dag-plan-interpreter.ts`
`DagPlanInterpreter implements IInterpreter<DagPlan, InterpretResult>`:
- **Validate the DAG once → throw `COORDINATOR_PLAN_INVALID`** on a structural
  error the plan can't recover from:
  - **empty `nodes`** (`nodes.length === 0`) — a DAG plan must have ≥1 node; the
    trivial/single-pipeline case is a 1-node plan, not an empty one;
  - **duplicate node `id`s** — they would collide in `Record<string, NodeResult>`,
    in dependency resolution, and in aggregation;
  - a `dependsOn` id that doesn't exist;
  - a **cycle** (topological sort detects it);
  - a node whose `agent` can't be resolved (see worker resolution below).

  These are malformed-plan errors, not execution failures.
- **Worker resolution (F4):** a node's worker is `workers.get(node.agent)` when
  `agent` is set; when `agent` is **absent**, it resolves to the sole worker
  **iff `workers.size === 1`** (the progressive-complexity single-pipeline
  default). An absent `agent` with **more than one** worker is ambiguous →
  `COORDINATOR_PLAN_INVALID` (caught in validation). No implicit "first worker".
- **Execute:** loop computing the **ready set** (nodes whose deps are all `done`
  and not yet run); dispatch all ready nodes **concurrently** (`Promise.all`);
  for each, `composeNodeTask(...)` → resolved worker
  `worker.run({ task, sessionId, signal, layer: ctx.layer + 1 })` (workers stay
  non-root leaves). **`ISubAgent.run` returns `ISubAgentResult` (no `ok` field);
  failures surface as a thrown error or `errorClass: 'epicfail'`** — so each
  dispatch is wrapped: resolves cleanly → `NodeResult.status: 'done'` with
  `result.output`; **throws** (caught) → `status: 'failed'` with the error
  message; a resolved result carrying `errorClass: 'epicfail'` → also `'failed'`
  (slice 1 records it as a node failure; cross-DAG epicfail propagation is out of
  scope). The interpreter never lets a worker error escape as an unhandled throw.
- **Failure handling (F2, no throw from the interpreter):** once a node is
  `failed`, its transitive dependents can never become ready — mark them
  `skipped`; finish any still-runnable independent nodes; then **return** an
  `InterpretResult` with `ok: false` and an `error` summary (which node failed).
  Node failures are a returned result, not an interpreter throw. (Replan-on-failure
  is slice 3.)
- **Aggregate (success):** concatenate **terminal nodes'** outputs (nodes that
  are no other node's dependency) in deterministic id order into
  `InterpretResult.output`; for a 1-node plan it is just that node's output
  (clean, no headers). `ok: true`.
- Parallelism is unbounded ready-set concurrency for the MVP (a `maxParallel`
  bound is deferred — see out-of-scope).

### `coordinator/dag/llm-dag-planner.ts`
`LlmDagPlanner implements IPlanner` — builds a planner system prompt listing the
worker catalog and instructing a JSON `DagPlan` (nodes with `id`/`goal`/`agent?`/
`dependsOn?`/`needsInput?` + `objective`), **calls an `ILlm` directly**, parses +
validates the JSON into a `DagPlan`. Fails loud on malformed JSON or a node
missing a `goal`. Progressive-complexity: the prompt tells it to emit a **single
node** when no decomposition is needed.

**Documented MVP exception (F5):** the epic invariant is "planner is supervised
through the `ISubAgent` path." Slice 1 has no supervision/restart machinery yet
(that arrives with replan in slice 3 / dialog in slice 4), so `LlmDagPlanner`
calls the `ILlm` **directly** rather than wrapping a planner `ISubAgent`. This is
one model for the slice (not "LLM or ISubAgent"). The `IPlanner` interface is the
stable seam; reconciling the concrete planner onto the supervised `ISubAgent`
path is deferred to the slice that introduces supervision. This exception is
called out so it is not mistaken for the end state.

### `pipeline/handlers/dag-coordinator.ts`
`DagCoordinatorHandler implements IStageHandler` — the batch DAG coordinator
(thin sequencer). On `execute`:
1. Build `PlannerInput` from `ctx.inputText` + the worker catalog.
2. `plan = await planner.plan(input)` (wrap errors → `COORDINATOR_PLAN_FAILED`).
3. (Reviewer gate — slice 2 — skipped here.)
4. `result = await interpreter.interpret(plan, { inputText: ctx.inputText,
   workers, sessionId: ctx.sessionId, signal, layer: ctx.layer ?? 0 })`.
   A structural-plan error throws `COORDINATOR_PLAN_INVALID` — caught and set on
   `ctx.error`, return false.
5. If `result.ok === false` → set `ctx.error` = `OrchestratorError(result.error,
   'COORDINATOR_STEP_FAILED')`, return false. Otherwise stream `result.output`
   raw + an empty finish chunk (`finishReason: 'stop'`), return true.

No `ICoordinator` interface is extracted yet — that happens in slice 4 when the
dialog implementation provides the second impl (epic rule: introduce the
interface when the second implementation appears).

## Config interpretation (package `@mcp-abap-adt/llm-agent-server`)

New optional `coordinator` fields, **distinct names** from the linear ones. The
worker catalog is the **existing top-level `subagents:`** (the current
`SubAgentRegistry` config — shared with the linear coordinator, NOT a new
`coordinator.subagents` shape):

```yaml
subagents:                       # EXISTING top-level catalog — an ARRAY of entries,
  - name: summarizer             #   each { name, description?, config: <path> } where
    description: Summarizes ...  #   `config` points to that subagent's own pipeline YAML.
    config: ../subagents/summarizer.yaml

coordinator:
  planner:     { type: llm }     # presence → DAG mode; LLM defaults to planner/main
  # interpreter: { type: dag }   # optional; defaults to DagPlanInterpreter
```

(The existing `subagents:` parser — array of `{ name, description?, config }`,
each `config` a path to a nested pipeline YAML — is reused as-is; no new worker
syntax is introduced. `node.agent` matches a subagent `name`.)

`InterpretContext.workers` is built from that existing registry; this slice adds
**no new subagent config shape** (backward-compat: existing `subagents:` configs
load unchanged).

- **The DAG selector is the presence of `coordinator.planner`.** `subagents` is
  **NOT** a selector — it is shared (the existing linear coordinator already
  dispatches to a subagent catalog), so its presence alone says nothing about
  which coordinator. `interpreter` is optional and, when omitted, defaults to
  `DagPlanInterpreter`.
- **`planner` is therefore required to enter DAG mode** (its presence is the
  signal). Its content may be minimal: `planner: { type: llm }` defaults the
  planner LLM to the resolved planner/main LLM (same resolution as today's
  `coordinator.plannerLlm`). So the minimal DAG config is `coordinator.planner`
  + a single-entry `subagents` catalog — the progressive-complexity default
  (one worker pipeline).
- **Old `planning`/`dispatch`** (and no `planner`) → the existing linear
  coordinator, unchanged.
- **Mixing / stray linear-only fields → fail-loud (no silent partial config).**
  In DAG mode (`coordinator.planner` present), the **linear-only** fields are
  rejected with a clear validation error, because they are meaningless or have a
  different shape here:
  - `planning`, `dispatch` — linear strategy selectors (replaced by `planner`/`interpreter`);
  - `maxSteps`, `maxRetriesPerStep`, `failPolicy` — linear step-loop knobs (the
    DAG interpreter has no step loop in slice 1);
  - `maxLayer` — nesting control (nested dispatch is being removed in slice 3);
  - top-level `coordinator.plannerLlm` — the DAG planner's LLM lives in
    `coordinator.planner` (e.g. `planner.plannerLlm`), so a sibling `plannerLlm`
    is ambiguous → reject.
  - **`activation`** (`explicit`/`auto`) is the one **shared** field — it governs
    whether the coordinator engages at all, orthogonal to the engine — so it is
    **allowed** in DAG mode.

  Conversely, a linear `coordinator` (no `planner`) rejects the new DAG-only
  fields (`planner`/`interpreter`) the same way. Each rejection names the field.

## Files touched

New (created):
- `packages/llm-agent/src/interfaces/dag-plan.ts`
- `packages/llm-agent/src/interfaces/interpreter.ts`
- `packages/llm-agent/src/interfaces/planner.ts` (+ barrel exports in the package index)
- `packages/llm-agent-libs/src/coordinator/dag/compose-node-task.ts`
- `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`
- `packages/llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts`
- `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts` (+ register in handler registry)
- `packages/llm-agent-server/src/smart-agent/config.ts` (interpret new fields; validation)

Untouched (must not change): linear `coordinator.ts` interfaces, linear
`CoordinatorHandler`, `IPlanningStrategy`/dispatch strategies, `compose-task.ts`.

## Testing

Unit (`node --test` via tsx):
- `compose-node-task`: bare goal / +objective / +dep outputs (data-flow) / +needsInput material.
- `DagPlanInterpreter`: linear chain (sequential), diamond (parallel middle), single-node (raw output); validation throws on empty `nodes`, duplicate ids, missing-dep id, cycle, and unresolvable `agent` (absent agent with >1 worker); a worker that **throws** → that node `failed` + dependents `skipped` + `ok:false`; absent `agent` with exactly one worker resolves to it.
- `LlmDagPlanner` (fake LLM): parses a DAG; single-node case; malformed JSON / missing goal → throw.
- `DagCoordinatorHandler` (fake planner + fake workers): end-to-end prompt → DAG → aggregated output streamed raw; planner error → `COORDINATOR_PLAN_FAILED`; interpreter failure → `COORDINATOR_STEP_FAILED`.
- Config: `coordinator.planner` present → DAG coordinator wired (workers from existing top-level `subagents:`); old `planning` → linear (unchanged); a linear-only field (`maxSteps`/`failPolicy`/`plannerLlm`/…) in DAG mode → fail-loud naming the field; `activation` allowed in DAG mode; **existing `docs/examples/coordinator-orchestration*.yaml` still parse + validate** (backward-compat regression guard).

Smoke (needs LLM): a multi-step prompt fans out into a DAG and aggregates; a simple prompt yields a single-node plan answered by one pipeline.

## Backward compatibility

- No `coordinator:` block → `tool-loop` (today), unchanged.
- Existing `coordinator:` (linear `planning`/`dispatch`) → linear coordinator, unchanged.
- All new types/interfaces/fields are additive; the linear path's code is not edited.

## Out of scope (later slices / deferred)

- Reviewer gate (slice 2); replan-by-leaf-signal + nested-dispatch removal (slice 3);
  dialog/resumable + `ICoordinator` interface extraction (slice 4).
- `maxParallel` concurrency bound (start unbounded).
- Formalizing the server as `IInterpreter<Yaml,Pipeline>` (recognized only).
