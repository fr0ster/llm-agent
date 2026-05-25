# Coordinator answer-directly for non-decomposable prompts (#155)

Status: design (minimal patch within the current coordinator architecture)
Date: 2026-05-25
Issue: #155
Epic: staged-pipeline coordinator — sub-project 1 of 3 (1: answer-directly · 2: result reviewer · 3: thin-coordinator refactor)

## Problem

With `coordinator.activation: auto` and ≥1 subagent registered, the Coordinator
engages on every request. For a trivial, non-decomposable prompt (e.g. "What is
17 + 25?") the planner LLM returns neither valid `steps` nor a `clarification` —
it just wants to answer. The #145 fail-loud validation then throws
`Planner returned neither steps nor a clarification` → `COORDINATOR_PLAN_FAILED`,
and with `failPolicy: abort` the user gets `(no response)` instead of "42".

This is a regression sharpened by #145: the validation correctly rejects
*malformed* planner output but conflates it with the legitimate "this request
needs no decomposition — just answer it" case.

## Principle

`COORDINATOR_PLAN_FAILED` is reserved for genuinely malformed planner output.
"No decomposition needed" is a valid planner result, not an error. The signal
is an **empty `steps` array with no `clarification`** — which is exactly what a
planner LLM naturally emits for a trivial prompt, so the fix is robust even when
the LLM ignores prompt instructions.

## Design

### 1. One-shot planner (`coordinator/planning/one-shot.ts`)

- **Remove the throw on "no steps and no clarification."** An empty `steps`
  array with no `clarification` is now a valid result: the planner returns a
  `Plan` with `steps: []` (no clarification). This is the answer-directly signal.
- **Keep fail-loud for genuinely malformed output:**
  - invalid JSON (existing `extractJson` throw),
  - a step present but missing a non-empty `goal` (existing throw),
  - both `clarification` and `steps` set — ambiguous (existing throw).
- **Prompt:** add an instruction — "If the request needs no decomposition (it can
  be answered directly without breaking it into steps), return an empty `steps`
  array and no `clarification`."

### 2. Replan planner (`coordinator/planning/replan-on-error.ts`)

**Unchanged.** A replan that yields no steps is a real failure
(`COORDINATOR_REPLAN_FAILED`); answer-directly applies only to initial planning.

### 3. CoordinatorHandler (`pipeline/handlers/coordinator.ts`)

After `buildInitialPlan` and the existing `plan.clarification` short-circuit,
add an **answer-directly short-circuit** before the dispatch loop:

- If `plan.steps.length === 0` (and no clarification):
  - synthesize a single agentless step
    `{ id: 'direct-1', goal: ctx.inputText, status: 'pending' }`,
  - dispatch it once via the configured `this.deps.dispatch` strategy
    (`hybrid`/`self` → `SelfDispatch` answers with the agent's own LLM; an
    agentless step routes to self under `HybridDispatch`),
  - stream the step's output **raw** — `ctx.yield({ content: result.output })`
    then the empty finish chunk `finishReason: 'stop'` — with **no**
    `### direct-1` header (a direct answer must be clean, e.g. "42", not wrapped
    in multi-step formatting),
  - log a `coordinator_answer_direct` step event (no raw user material — log the
    step id / output length only),
  - return `true`.
- If that single dispatch returns `ok: false` (e.g. a pure-`SubAgentDispatch`
  config with no self fallback cannot self-answer an agentless step), surface a
  real `OrchestratorError('COORDINATOR_STEP_FAILED', ...)` — never a silent
  `(no response)`.

The synthesized step's `task` is composed by the existing `composeTask`: with no
objective and no `needsInput`, it reduces to the bare `goal` (= `ctx.inputText`),
so `SelfDispatch` sends the original request to the LLM unchanged.

## Data flow

trivial prompt → planner returns `steps: []` → handler synthesizes
`direct-1 { goal: inputText }` → configured dispatch → `SelfDispatch` (agent LLM)
→ answer → streamed raw → `stop`.

## Error handling

- Malformed planner output (invalid JSON / missing-goal / clarification+steps) →
  still throws (`COORDINATOR_PLAN_FAILED`). Unchanged from #145.
- Direct-step dispatch failure → `COORDINATOR_STEP_FAILED` (real error, visible),
  not a silent empty response.

## Files touched

- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — drop the
  empty-output throw (empty = valid answer-directly); prompt instruction.
- `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts` —
  revise the #145 "throws when output has neither steps nor clarification" test
  to assert it now returns an empty-steps plan (no throw); keep the missing-goal
  and clarification+steps throw tests.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — add the
  answer-directly short-circuit.
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts`
  (new) — empty plan → synthesizes `direct-1` with `goal === inputText`,
  dispatches once, streams raw output (no `###` header), `finishReason: 'stop'`;
  dispatch-failure → `COORDINATOR_STEP_FAILED`.

## Out of scope

- Result reviewer / `IReviewStrategy` (sub-project 2).
- Thin-coordinator staged refactor (sub-project 3).
- Activation-strategy changes — `activation: auto` stays as-is; this fixes the
  behavior under it.
- Tool-capable direct answers: answer-directly uses `SelfDispatch` (the agent's
  own LLM, no MCP tools). A request that genuinely needs a tool should yield a
  1-step plan from the planner, not an empty plan.

## Backward compatibility

- Multi-step and clarification flows are unchanged.
- The only behavior change is that an empty planner result now answers directly
  instead of throwing — strictly better UX (no more `(no response)`), and it
  reverts exactly the over-strict half of the #145 validation.
