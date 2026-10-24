# Structured planner plan — design (draft)

Date: 2026-10-23. Status: draft; decisions in "Decisions" taken 2026-10-23. Scope: llm-agent dialogue planner (`DialogueSession`, `PlannerToolsClient`,
`DIALOGUE_PLANNER_SYSTEM`) and the cloud-llm-hub dialogue coordinator + WebUI.

## Problem

The planner writes its plan as free text (`update_plan(plan: string, status?)`). Nothing can compare "what the plan
says" with "what runs". In live tests the planner updated the plan, saw the task board (`list_tasks`), and still
ended turns saying it was doing the next step without calling `delegate_task`. The 30.7.0 end-of-turn check could
not tell a stall from a legitimate pause: it depends on a status the planner sets itself and runs on event turns
only. The planner does not control its own plan because the plan is not something a machine can check.

## Idea

The plan becomes a list of **steps with state**. The planner still decides everything (steps, order, granularity,
re-planning); the library keeps the step states consistent with the task board and checks the planner against its
own plan.

## Plan model

```ts
interface PlanStep {
  id: string;            // planner-chosen, stable: "s1", "list-dumps", ...
  goal: string;          // the result to produce (not the way)
  dependsOn?: string[];  // step ids that must be done first
  worker?: string;       // intended worker (executor | checker | …), optional
  state: 'pending' | 'running' | 'checking' | 'done' | 'failed' | 'skipped' | 'blocked';
  check?: { by: 'planner' | 'checker'; goal: string; verdict?: 'pass' | 'fail'; taskId?: string };
  taskIds: string[];     // tasks delegated for this step (retries keep history)
  note?: string;         // short outcome / reason (failed, skipped, blocked)
}
interface Plan {
  steps: PlanStep[];
  status: 'active' | 'waiting_user' | 'done';  // derived where possible, see below
  question?: string;     // set with waiting_user: what the planner asked the user
}
```

## Tools (PlannerToolsClient)

- `update_plan({ steps, status?, question? })` — replaces the step list (add, re-order, re-goal, skip). Existing
  step ids keep their state and task links; new ids start `pending`. The free-text form stays accepted for one
  release and is stored as a single note (backward compatible).
- `delegate_task({ step_id, worker, goal, context, history? })` — `step_id` required when a plan exists; the step
  moves to `running` and gets the task id. Delegating a step whose dependencies are not `done` is refused with a
  clear error.
- Step state follows the task automatically: task done → step `done` (or stays `running` if the planner sent a
  check task for the step and it is still open), task failed/stopped → step `failed`. The planner may override with
  `update_plan` (e.g. mark `skipped`, re-open a failed step for a retry).

## What the planner sees every turn

Replaces the separate `[plan]` + `[tasks]` notes with one `[plan]` view:

```
[plan] status: active
s1 done     Identifiers of all dumps, 20 per page         (t2)
s2 running  Analysis of dump 20261023… stored in dump_analysis   (t3)
s3 ready    Analysis of dump 20261022…                    
s4 pending  Count check (depends on s2, s3)
```

`ready` = pending with all dependencies done. Task output stays available via `get_task`.

## End-of-turn check (replaces the 30.7.0 idle rule)

After every turn — user or event:
- if the plan has `ready` steps, nothing is running, nothing was delegated in this turn, and the plan status is not
  `waiting_user` → corrective turn: "[check] Steps s3 are ready and nothing runs. Delegate them, skip them with a
  reason, or ask the user (status waiting_user)."
- if all steps are `done`/`skipped` and status is not `done` → the session sets status `done` itself (no
  correction needed).
- `waiting_user` requires `question`; a new user message clears it back to `active`.
- Bounded by `maxCorrections` (default 2); only the accepted reply is streamed (as in 30.7.0).
No reply-text parsing.

## Hub and WebUI

- The hub's plan event (planned in `feat/webui-plan-view` for the text form) carries the structured plan; the WebUI
  shows steps with state badges and their task ids, next to the task list.
- The persisted dialogue state (`h_dialogue`) stores the structured plan; restore keeps step ↔ task links.
- Lessons/agents (separate design) can later learn from plan shapes: which step patterns failed.

## Prompt changes

`DIALOGUE_PLANNER_SYSTEM`: plan as steps (result per step, smallest checkable result, dependencies), always
`delegate_task` with `step_id`, use `skipped` with a reason instead of silently dropping a step, ask with
`waiting_user` + `question`. The hub's bulk pattern (identifiers page by page → one step per item → count check)
becomes a step shape; for very large item lists the planner adds steps in batches (e.g. 20 at a time) rather than
hundreds of steps at once.

## Compatibility

- Library: `update_plan` accepts the string form for one minor release; `DialogueState.plan` gains a structured
  form with a version marker; old states restore as a single-note plan.
- Hub: wire the new options, store/restore, UI. Consumers that do not use the dialogue planner are unaffected.

## Step checks

- A step may carry a check. The checker is either **the planner itself** (it reads the result with `get_task` /
  `rag_list` and decides) or **a separate process like the executor** (a delegated `checker` task).
- A step with a check moves `running` → `checking` when its work task is done, and closes only on the check verdict:
  PASS → `done`; FAIL → `failed` with the verdict as `note` (the planner re-plans or retries).
- Planner-as-checker records the verdict with `update_plan` (`state: done | failed`, `note`); a delegated checker's
  verdict closes the step automatically when its task ends.
- A step without a check closes when its work task is done.

## Decisions (2026-10-23)

1. **Plan size per turn:** up to 40 steps are shown; older `done`/`skipped` steps are collapsed into a count.
2. **Who checks:** both — the planner itself or a separate checker process; the step closes on the check verdict.

## Attempt invalidation and budget outcomes

- Batch membership changes are refused while any linked attempt is queued or running, even with scope consent or an explicit pending state. After attempts settle, a membership change clears work/check links and verdicts; previous outcomes cannot complete the replacement batch.
- Changing check ownership clears the previous checker task and verdict. The same update cannot close the step; a fresh verdict is required in a later update or check attempt.
- Budget exhaustion sends completed non-item work to verification. Failed or stopped non-item work remains failed with its original error.
- Subagent results carry budgetExhausted, toolCallCount and maxToolCalls for both complete and awaiting-external results.
