# Coordinator authors complete step prompts + clarification gate (#145)

Status: design (minimal patch within the current coordinator architecture)
Date: 2026-05-25
Issue: #145

## Problem

When the Coordinator dispatches a plan step, the executor receives only the
planner's paraphrased `goal`. The original client material (the text to
summarize, the code to review) never reaches it, so any "process THIS blob"
task runs on material it was never given.

Verified against the current branch:

- `SubAgentDispatch` sets `task = step.inputTemplate ? resolveTemplate(...) : step.goal`
  (`dispatch/subagent.ts`). With no template, the subagent gets the paraphrase.
- `SelfDispatch` builds `userMsg = "Current step: {goal}\n\nResults so far:..."`
  (`dispatch/self.ts`) — it **also** drops `ctx.inputText`. The issue only
  reported the subagent path; the self path has the identical defect.
- The planner (`one-shot.ts` / `replan-on-error.ts`) sees the full `inputText`
  but emits only `{steps:[{id,goal,agent}],rationale}` — no channel to carry
  material into a step, and the prompt never tells it the executor sees only
  the step it authors.

The issue's "suggested fix" (make the planner inline material into `goal`) is
rejected: it turns the planner into a content pipe and is lossy on long input.
We keep what is valid (the bug fact + two of three root causes) and fix it on
the Coordinator side, consistent with our architecture.

## Principles (held)

- The Coordinator is the **sole author** of each executor's prompt. The raw
  client prompt is never forwarded wholesale to a subagent.
- **We build context ourselves.** Consumers give us external tools + the
  request; the Coordinator decides what each executor sees.
- The Coordinator is accountable to the consumer for the result (it already
  collects results and propagates epicfail traces upward).
- No silent defaults (v16.0.0 discipline): material reaches an executor only
  when the planner decides it should.

## Design

### 1. Material goes into `task`, not `context`

The planner authors `task` = instruction + material. `context` stays exactly
what it is today: the RAG/project preamble built by
`DefaultSubAgentContextBuilder`. This dissolves the `contextPolicy` problem
(material reaches even a `forbidden`-context agent and self-dispatch uniformly,
because it travels in `task`) and means **the context-builder is not touched**.

### 2. Per-step input signal + shared task composition

- Add `PlanStep.needsInput?: boolean` (default false). The planner sets it for
  steps that operate on provided client material.
- Keep the existing `PlanStep.inputTemplate?: string` as an advanced override.
- A single shared helper composes the executor task, used by **both**
  `SelfDispatch` and `SubAgentDispatch` so they behave identically:
  - if `step.inputTemplate` → `resolveTemplate(step.inputTemplate, ctx)`
  - else if `step.needsInput` → `resolveTemplate(DEFAULT_INPUT_TEMPLATE, ctx)`
    where `DEFAULT_INPUT_TEMPLATE = "{goal}\n\nInput:\n{inputText}"`
  - else → `step.goal` (current behavior, no regression)
- `SelfDispatch` switches from its ad-hoc `userMsg` to the composed task while
  keeping its "Results so far" block.

### 3. Clarification gate (lightweight, no reviewer LLM)

- Add `Plan.clarification?: string`.
- The planner may return `{"clarification":"..."}` instead of `{"steps":[...]}`
  when the request is ambiguous/underspecified. `buildInitialPlan` maps this to
  a `Plan` with empty `steps` and `clarification` set.
- `CoordinatorHandler`: after `buildInitialPlan`, if `plan.clarification` is set,
  yield it as the assistant response (`finishReason: 'stop'`) and return
  **without dispatching any step**. This is a valid, successful response to the
  consumer — the Coordinator deciding to ask back, not a subagent failing on
  empty material.
- Scope: clarification is produced at initial planning only. Replan
  (`rebuildPlan`) is about step failures and does not emit clarification in this
  patch.

### 4. Planner prompt changes (`one-shot.ts`, `replan-on-error.ts`)

- Tell the planner that the dispatched executor sees **only** the step it
  authors (its `goal` plus any input we compose), never the raw user request —
  so it must set `needsInput: true` on steps that act on provided material.
- Allow the initial planner to emit `{"clarification":"..."}` instead of steps
  when it cannot form an unambiguous plan.
- `needsInput` parsing applies to both initial and replan step output;
  `clarification` parsing applies to initial only.

## Out of scope (separate strategic epic)

- Reviewer stage / `IReviewStrategy` and the generator/critic split.
- Redesigning the Coordinator into a staged, fully pluggable
  plan→review→execute pipeline with a thin orchestrator.
- A second, specialized Coordinator implementation (e.g. SAP-ABAP vs generic
  MCP). Only the existing seam is kept; no new implementation.
- Any change to `DefaultSubAgentContextBuilder` or `req.inputText` usage.

## Files touched

- `packages/llm-agent/src/interfaces/coordinator.ts` — add `PlanStep.needsInput?`,
  `Plan.clarification?`.
- `packages/llm-agent-libs/src/coordinator/dispatch/compose-task.ts` (new) —
  shared task-composition helper + `DEFAULT_INPUT_TEMPLATE`.
- `packages/llm-agent-libs/src/coordinator/dispatch/self.ts` — use composed task.
- `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts` — use composed task.
- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — prompt +
  `clarification` + `needsInput` parsing.
- `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts` — prompt +
  `needsInput` parsing.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — handle
  `plan.clarification` (yield + stop, no dispatch).

## Testing

- Unit (existing `node --test` convention, `__tests__` dirs): task-composition
  helper covers all three branches (template / needsInput / plain goal); a
  `needsInput` step embeds `inputText` verbatim; clarification short-circuits
  the handler without dispatching.
- Smoke: reproduce the #145 case (summarize-this-blob) and confirm the executor
  now receives the material; confirm an ambiguous request returns a clarification
  instead of a hollow subagent answer.

## Backward compatibility

- `PlanStep.needsInput` and `Plan.clarification` are optional → non-breaking.
- Steps without `needsInput`/`inputTemplate` keep `task = goal` (no regression).
- `ISubAgent` contract (`{task, context}`) is unchanged.
