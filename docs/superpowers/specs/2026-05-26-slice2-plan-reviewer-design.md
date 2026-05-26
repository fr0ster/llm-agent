# Slice 2: Plan reviewer gate + roles unified on `ISubAgent`

Status: design (active — slice 2 of the coordinator-redesign epic)
Date: 2026-05-26
Epic anchor: `docs/superpowers/specs/2026-05-25-coordinator-redesign-epic-overview.md`
Builds on: slice 1 (batch DAG coordinator, merged in #158)

## Goal

Add an optional **plan reviewer gate** between planning and execution in the DAG
coordinator, and — in the same slice — reconcile the planner so every role
(planner, reviewer) runs through the **one `ISubAgent` path** the epic mandates,
instead of calling the LLM directly.

This ships a working, testable capability (a configurable plan critic that can
reject a plan before any worker runs) AND removes the slice-1 "planner calls the
LLM directly" MVP debt, aligning the code with the locked terminology.

## Terminology

Uses the locked vocabulary from the epic overview: **Pipeline** (the interpreted
description), **Interpreter** (executes a Pipeline), **Subagent** (a node the
interpreter dispatches; `ISubAgent`), **Component** (a subagent's internals).

Planner and reviewer are **subagents that produce / judge a Pipeline**:
- planner → produces a `DagPlan` (a Plan-pipeline),
- reviewer → judges a `DagPlan` and returns a verdict.

A **role** = a typed adapter that *owns* an `ISubAgent`, builds the subagent's
`task` from typed input, calls `run()`, and parses the subagent's string `output`
into a typed structure. The role does NOT extend or replace `ISubAgent`.

## Scope (batch only)

Slice 2 is **batch / terminal**: a failed review fails the request loudly with the
critic's feedback as the error. There is **no resume / ask-and-resume** — that is
the dialog/resumable coordinator (slice 4). The verdict type therefore carries no
resume token in this slice.

## Architecture

### Part 1 — Reconcile the planner onto `ISubAgent` (remove slice-1 debt)

`LlmDagPlanner` (in `llm-agent-libs/src/coordinator/dag/llm-dag-planner.ts`) stops
calling `ILlm` directly. Internally it now **owns a `DirectLlmSubAgent`**:

- constructed with `name: 'planner'`, the existing planner system prompt, and
  `contextPolicy: 'optional'` (the task is self-contained — prompt + catalog);
- `plan()` composes the task string (user prompt + agent catalog) exactly as the
  current prompt builder does, calls `subagent.run({ task, sessionId, signal })`,
  then runs the **same** JSON-extraction + validation already present
  (objective/rationale/node-field-type checks from the slice-1 review).

Public contract unchanged: `IPlanner`, `new LlmDagPlanner(llm)`, and the YAML
config (`coordinator.planner: { type: llm, plannerLlm? }`) are all identical. The
change is internal — the planner now flows through the uniform subagent path.

### Part 2 — Reviewer interfaces and implementations

New contracts in `@mcp-abap-adt/llm-agent` (interfaces package):

```ts
// review.ts
export interface ReviewInput {
  prompt: string;
  plan: DagPlan;
  agents: PlannerCatalogEntry[];   // same catalog shape the planner sees
  sessionId: string;
  signal?: AbortSignal;
}
export type ReviewVerdict =
  | { pass: true }
  | { pass: false; feedback: string };
export interface IReviewStrategy {
  readonly name: string;
  review(input: ReviewInput): Promise<ReviewVerdict>;
}
```

Implementations in `llm-agent-libs/src/coordinator/dag/`:

- **`LlmReviewStrategy implements IReviewStrategy`** — owns a `DirectLlmSubAgent`
  critic (`name: 'reviewer'`, `contextPolicy: 'optional'`, a critic system
  prompt). `review()` composes a task (user prompt + the plan serialized as JSON +
  the agent catalog), calls `run()`, and parses the critic's output. Output
  protocol: the critic returns ONLY a JSON object — `{"pass": true}` or
  `{"pass": false, "feedback": "<why + what to clarify>"}`. Parsing mirrors the
  planner: regex-extract the JSON object, `JSON.parse` inside try/catch (malformed
  → throw a clear error), validate `pass` is boolean and `feedback` is a string
  when `pass === false`.
- **`NoopReviewStrategy implements IReviewStrategy`** — always returns
  `{ pass: true }`. For explicit opt-out and tests. (Absence of a reviewer in the
  handler simply skips the gate; Noop is the explicit always-pass strategy.)

### Part 3 — Gate in `DagCoordinatorHandler`

`DagCoordinatorHandlerDeps` gains an optional `reviewer?: IReviewStrategy`.

`execute()` flow becomes: **plan → (review gate) → interpret**:

```
plan = await planner.plan({ prompt, agents, sessionId, signal })   // existing
if (reviewer) {
  let verdict;
  try {
    verdict = await reviewer.review({ prompt: ctx.inputText, plan, agents, sessionId, signal });
  } catch (err) {
    ctx.error = new OrchestratorError(errMsg(err), 'COORDINATOR_REVIEW_FAILED');
    return false;
  }
  if (!verdict.pass) {
    ctx.error = new OrchestratorError(verdict.feedback, 'COORDINATOR_PLAN_REJECTED');
    return false;
  }
}
result = await interpreter.interpret(plan, ...)                     // existing
```

- `agents` for the reviewer = the same catalog the handler builds for the planner
  (`workers.values()` → `{ name, description }`).
- A rejected plan is **terminal** (fail-loud), surfacing the critic's feedback.
- Error codes `COORDINATOR_PLAN_REJECTED` / `COORDINATOR_REVIEW_FAILED` are
  **provisional** — internal codes, not a public API contract; they may be
  refined/unified in a later pass.

### Part 4 — Builder + server wiring

- **Builder** (`llm-agent-libs/src/builder.ts`): `withDagCoordinator(deps)` accepts
  `reviewer?` and threads it into the `DagCoordinatorHandler` deps.
- **Config** (`llm-agent-server/src/smart-agent/config.ts`): add `reviewer` to
  `DAG_ONLY` (linear configs reject it). In `assertCoordinatorConfigShape`, when a
  reviewer is present, validate it the same way as the planner: must be an object;
  `type`, if set, must be `'llm'`; `plannerLlm`, if set, must be one of
  `main | planner | helper`.
- **smart-server DAG branch** (`smart-server.ts`): if `coordCfg.reviewer` is
  present, resolve the reviewer LLM with the same logic as the planner
  (`reviewer.plannerLlm` → main/helper) and build a `LlmReviewStrategy`, then pass
  it to `withDagCoordinator`. Absent reviewer → no gate (unchanged behavior).

YAML shape (additive, optional):

```yaml
coordinator:
  planner:  { type: llm }
  reviewer: { type: llm }     # presence => plan reviewer gate ON
```

## Error handling

| Situation | Handler outcome |
|-----------|-----------------|
| reviewer not configured | gate skipped; plan goes straight to interpret |
| `review()` returns `{ pass: true }` | proceed to interpret |
| `review()` returns `{ pass: false, feedback }` | `ctx.error = COORDINATOR_PLAN_REJECTED(feedback)`, return false (terminal) |
| `review()` throws | `ctx.error = COORDINATOR_REVIEW_FAILED`, return false |
| critic output malformed JSON / bad shape | `LlmReviewStrategy` throws → maps to `COORDINATOR_REVIEW_FAILED` |

## Testing

- **Planner parity** — `LlmDagPlanner` after the refactor still parses the same
  fixtures into the same `DagPlan` (single-node, dependsOn, malformed-JSON throw,
  node-field-type rejects, objective/rationale rejects). Behavior unchanged.
- **`LlmReviewStrategy`** — pass verdict; fail verdict with feedback; malformed
  JSON throws; non-boolean `pass` / missing `feedback` on fail throws.
- **`NoopReviewStrategy`** — always `{ pass: true }`.
- **Handler gate** — pass → interpreter runs and output streams; fail →
  `COORDINATOR_PLAN_REJECTED` and interpreter NOT called; reviewer throw →
  `COORDINATOR_REVIEW_FAILED`; no-reviewer → interpreter runs (slice-1 behavior).
- **Config** — reviewer `{type:llm}` accepted; unknown `reviewer.type` rejected;
  bad `reviewer.plannerLlm` rejected; `reviewer` in a linear coordinator rejected.
- **Backward-compat guard** — existing example YAMLs still validate as linear and
  load unchanged.

## Out of scope (slice 2)

- Resume / ask-and-resume on a failed review (dialog coordinator — slice 4).
- Result-side review (output ≡ prompt; a separate concern, see epic).
- Reviewer as a named entry from the `subagents:` catalog (only `{type: llm}` for
  now).
- Replan-on-reject (the reviewer's reject is terminal here; replan-by-signal is
  slice 3 territory).
- Renaming `ISubAgent` → another noun (terminology is locked at the concept level;
  no code rename in this slice).
