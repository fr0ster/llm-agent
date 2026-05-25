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

- **The Coordinator generates each subagent's `task`** and forwards `context`
  (RAG + MCP-RAG). The subagent never receives the raw client request as its
  controlling instruction.
- A subagent is given two things so the subagents act as a **team, not a crowd**:
  its **specific task** (what this step does) and the **overall objective**
  (why, within the shared goal).
- **We build context ourselves.** Consumers give us external tools + the
  request; the Coordinator decides what each executor sees.
- The Coordinator is accountable to the consumer for the result (it already
  collects results and propagates epicfail traces upward).
- No silent defaults (v16.0.0 discipline): client material reaches an executor
  only when the planner marks the step as needing it.
- Ad-hoc client material (a blob to summarize) is **not** in any RAG/MCP-RAG
  store, so it cannot arrive via `context`. It reaches the subagent only by
  being embedded — verbatim, as delimited data — inside the Coordinator-generated
  `task`.

## Data model

- `Plan.objective?: string` — the **overall objective** shared across the whole
  plan, authored by the planner once. Optional (non-breaking). Forwarded into
  every dispatched step's `task` as orientation.
- `PlanStep.goal` — kept, with sharpened semantics: the **specific task** of the
  step (work-order), not the "why".
- `PlanStep.needsInput?: boolean` — when `true`, the composed `task` embeds the
  client request (`{{inputText}}`) as delimited data. Default `false` → no
  material is forwarded (no silent default).
- `PlanStep.inputTemplate?: string` — retained as an advanced override; when set
  it wins over `needsInput` and is resolved as-is.
- `Plan.clarification?: string` — set by the initial planner when it cannot form
  an unambiguous plan; short-circuits dispatch (see §3).

## Design

### 1. Coordinator-generated task: objective + specific task + material-as-data

A single shared helper composes the executor `task`, used by **both**
`SelfDispatch` and `SubAgentDispatch` so they behave identically:

- if `step.inputTemplate` → `resolveTemplate(step.inputTemplate, renderCtx)`
  (advanced override).
- else compose from parts:
  ```
  Task: {{goal}}

  Overall objective: {{objective}}        # included only when objective is set

  Input (user-provided data):             # included only when needsInput === true
  ---
  {{inputText}}
  ---
  ```
  rendered via `resolveTemplate` with `renderCtx = { goal, objective, inputText,
  stepResults, step }`. Placeholders use the `{{path}}` syntax that
  `util/template.ts` actually expands (NOT `{path}`).
- if neither `objective`, `needsInput`, nor `inputTemplate` apply → `task`
  reduces to `step.goal` (current behavior, no regression).

`SelfDispatch` switches from its ad-hoc `userMsg` to the composed `task` while
keeping its "Results so far" block. `context` (RAG + MCP-RAG) is unchanged; the
`DefaultSubAgentContextBuilder` is not touched.

### 2. Planner authors objective + specific tasks + needsInput

`one-shot.ts` and `replan-on-error.ts`:

- Tell the planner that the dispatched executor sees **only** the step the
  planner authors (its specific `goal` + the composed `objective`/input). The
  raw user request never reaches the executor as a controlling instruction — it
  appears only as delimited data, and only when the step sets `needsInput: true`.
  So the planner must set `needsInput: true` on steps that act on provided
  material.
- Emit a plan-level `objective` (the shared "why") so subagents stay aligned.
- `goal` is the per-step specific task, not the overall purpose.

Output schema becomes (sample):
```json
{
  "objective": "Ship the release checklist",
  "steps": [
    { "id": "step-1", "goal": "Summarize into a tight checklist", "agent": "summarizer", "needsInput": true }
  ],
  "rationale": "Single summarization step over the provided release tasks"
}
```
`agent` and `needsInput` are optional per step.
`needsInput` parsing applies to both initial and replan output;
`objective` is parsed on both paths (replan re-states it).

### 3. Clarification gate (lightweight, no reviewer LLM)

- The initial planner may return `{"clarification":"..."}` instead of
  `{"steps":[...]}` when the request is ambiguous/underspecified.
  `buildInitialPlan` maps this to a `Plan` with empty `steps` and `clarification`
  set.
- `CoordinatorHandler`: after `buildInitialPlan`, if `plan.clarification` is set,
  yield it as the assistant response (`finishReason: 'stop'`) and return
  **without dispatching any step** — the Coordinator deciding to ask back, not a
  subagent failing on empty material.
- Scope: clarification is produced at initial planning only. Replan
  (`rebuildPlan`) is about step failures and does not emit clarification here.

### 4. SkillStepsPlanning parity

Structured skill steps bypass the planner-LLM entirely, so they must carry the
same fields or they keep the #145 defect:

- Add `needsInput?: boolean` and `inputTemplate?: string` to `ISkillMeta.steps`
  (`interfaces/skill.ts`).
- Add an optional `objective?: string` to `ISkillMeta` for the shared goal.
- `SkillStepsPlanning` maps these into `PlanStep.needsInput` / `inputTemplate`
  and `Plan.objective`. No fallback: when `ISkillMeta.objective` is unset, the
  plan carries no objective and existing skill-driven steps keep `task = goal`
  (preserves backward compatibility — no silent behavior change).

## Out of scope (separate strategic epic)

- Reviewer stage / `IReviewStrategy` and the generator/critic split.
- Redesigning the Coordinator into a staged, fully pluggable
  plan→review→execute pipeline with a thin orchestrator.
- A second, specialized Coordinator implementation (e.g. SAP-ABAP vs generic
  MCP). Only the existing seam is kept; no new implementation.
- Any change to `DefaultSubAgentContextBuilder` or `req.inputText` usage.
- Extracting a separate "material" sub-string from the request: in this patch
  `needsInput` embeds the whole request as delimited data. True material
  extraction (without lossy LLM rewriting) is deferred to the strategic epic.

## Files touched

- `packages/llm-agent/src/interfaces/coordinator.ts` — add `Plan.objective?`,
  `Plan.clarification?`, `PlanStep.needsInput?`.
- `packages/llm-agent/src/interfaces/skill.ts` — add `ISkillMeta.objective?` and
  `needsInput?` / `inputTemplate?` to `ISkillMeta.steps`.
- `packages/llm-agent-libs/src/coordinator/dispatch/compose-task.ts` (new) —
  shared task-composition helper using `{{...}}` placeholders.
- `packages/llm-agent-libs/src/coordinator/dispatch/self.ts` — use composed task.
- `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts` — use composed task.
- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — prompt,
  `objective`, `clarification`, `needsInput` parsing.
- `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts` — prompt,
  `objective`, `needsInput` parsing.
- `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts` — map
  `objective` / `needsInput` / `inputTemplate`.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — handle
  `plan.clarification` (yield + stop, no dispatch).

## Testing

- Unit (existing `node --test` convention, `__tests__` dirs):
  - task-composition helper: all branches (inputTemplate override / objective+goal /
    needsInput embeds `{{inputText}}` verbatim with delimiters / plain goal);
  - verifies `{{...}}` placeholders are expanded, not passed literally;
  - clarification short-circuits the handler without dispatching;
  - skill-steps map `needsInput`/`inputTemplate`/`objective`.
- Smoke: reproduce the #145 case (summarize-this-blob) and confirm the executor
  now receives the material; confirm an ambiguous request returns a clarification.

## Backward compatibility

- `Plan.objective`, `Plan.clarification`, `PlanStep.needsInput`, and the new
  skill-meta fields are all optional → non-breaking.
- Steps without `needsInput`/`inputTemplate` and plans without `objective` keep
  `task = goal` (no regression).
- `ISubAgent` contract (`{task, context}`) is unchanged.
