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
}

export interface NodeResult {
  nodeId: string;
  output: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface InterpretResult {
  nodeResults: Record<string, NodeResult>;
  /** Final aggregated text streamed to the consumer. */
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
- Validate the DAG once: every `dependsOn` id exists; **no cycles** (topological
  sort; a cycle → throw `COORDINATOR_PLAN_INVALID`).
- Loop: compute the **ready set** (nodes whose deps are all done & ok and not yet
  run); dispatch all ready nodes **concurrently** (`Promise.all`); for each,
  `composeNodeTask(...)` → look up the worker `ISubAgent` (`node.agent` or the
  single default worker) → `worker.run({ task, sessionId, signal, layer: 0 })`
  → record `NodeResult`.
- If a node fails (`ok:false`), its dependents become unreachable; mark them
  skipped, finish the rest, and the interpret result is a failure
  (`COORDINATOR_STEP_FAILED` surfaced by the coordinator). (Replan-on-failure is
  slice 3.)
- Aggregate: concatenate **terminal nodes'** outputs (nodes that are no node's
  dependency) in deterministic id order into `InterpretResult.output`. For a
  1-node plan this is just that node's output (clean, no headers).
- Parallelism is unbounded ready-set concurrency for the MVP (a `maxParallel`
  bound is deferred — note in out-of-scope).

### `coordinator/dag/llm-dag-planner.ts`
`LlmDagPlanner implements IPlanner` — builds a planner system prompt listing the
worker catalog and instructing a JSON `DagPlan` (nodes with `id`/`goal`/`agent?`/
`dependsOn?`/`needsInput?` + `objective`), calls its LLM (or planner `ISubAgent`),
parses + validates the JSON into a `DagPlan`. Fails loud on malformed JSON or a
node missing a `goal`. Progressive-complexity: the prompt tells it to emit a
**single node** when no decomposition is needed.

### `pipeline/handlers/dag-coordinator.ts`
`DagCoordinatorHandler implements IStageHandler` — the batch DAG coordinator
(thin sequencer). On `execute`:
1. Build `PlannerInput` from `ctx.inputText` + the worker catalog.
2. `plan = await planner.plan(input)` (wrap errors → `COORDINATOR_PLAN_FAILED`).
3. (Reviewer gate — slice 2 — skipped here.)
4. `result = await interpreter.interpret(plan, interpretCtx)`.
5. Stream `result.output` raw + finish `stop`; on interpreter failure set
   `ctx.error` (`COORDINATOR_STEP_FAILED`) and return false.

No `ICoordinator` interface is extracted yet — that happens in slice 4 when the
dialog implementation provides the second impl (epic rule: introduce the
interface when the second implementation appears).

## Config interpretation (package `@mcp-abap-adt/llm-agent-server`)

New optional `coordinator` fields, **distinct names** from the linear ones:

```yaml
coordinator:
  planner:     { type: llm, plannerLlm: main }     # selects LlmDagPlanner
  interpreter: { type: dag }                        # selects DagPlanInterpreter (default)
  subagents:                                        # worker catalog; each is a pipeline
    summarizer: { ...pipeline (llm/rag/mcp/prompt)... }
```

- **Presence of `planner` (and/or `subagents`/`interpreter`)** → the server
  interprets the DAG coordinator (wires `DagCoordinatorHandler`).
- **Old `planning`/`dispatch`** (no new fields) → the existing linear coordinator,
  unchanged.
- **Mixing** old (`planning`) and new (`planner`) in one `coordinator` block →
  **fail-loud** config-validation error (no silent fallback).
- A bare worker config with a single `subagents` entry is the
  progressive-complexity default (one pipeline).

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
- `DagPlanInterpreter`: linear chain (sequential), diamond (parallel middle), single-node (raw output), missing-dep id → throw, cycle → throw, a node failure skips dependents and surfaces failure.
- `LlmDagPlanner` (fake LLM): parses a DAG; single-node case; malformed JSON / missing goal → throw.
- `DagCoordinatorHandler` (fake planner + fake workers): end-to-end prompt → DAG → aggregated output streamed raw; planner error → `COORDINATOR_PLAN_FAILED`; interpreter failure → `COORDINATOR_STEP_FAILED`.
- Config: new `planner`/`subagents` fields → DAG coordinator wired; old `planning` → linear (unchanged); mixing → fail-loud; **existing `docs/examples/coordinator-orchestration*.yaml` still parse + validate** (backward-compat regression guard).

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
