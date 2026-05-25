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
"No decomposition needed" is a valid planner result, not an error.

The signal is a **parseable LLM-planner plan with an empty `steps` array and no
`clarification`**. This matches the actual #155 repro: the planner returned
parseable JSON (so `extractJson` succeeded) but with no steps and no
clarification, which #145's post-parse validation then rejected. Answer-directly
replaces that rejection.

**Boundary (acknowledged):** the trigger requires parseable plan JSON. If a
mis-instructed planner emits non-JSON prose (e.g. the literal text "42"),
`extractJson` still throws `COORDINATOR_PLAN_FAILED` — that remains a malformed
case, mitigated by the planner prompt's "respond with ONLY a JSON object"
instruction, not by this fix. We do not treat unparseable planner output as an
implicit answer-directly (that would erase fail-loud entirely and could surface
a planner's stray prose as the user's answer).

## Design

### 1. One-shot planner (`coordinator/planning/one-shot.ts`)

- **Narrow the empty-output throw to an explicit empty array (F2).** The signal
  is specifically `Array.isArray(parsed.steps) && parsed.steps.length === 0` — an
  explicit empty `steps: []`, which the planner emits when it deliberately
  decides no decomposition is needed. The validation splits the #145 single
  throw into two:
  - `!Array.isArray(parsed.steps)` (steps key missing / not an array, e.g.
    `{"objective":"x"}`) → **still throws** `COORDINATOR_PLAN_FAILED` — that is
    incomplete/malformed output, not a deliberate "answer directly".
  - `parsed.steps.length === 0` (explicit `[]`) → **no throw**: return a `Plan`
    with `steps: []` and no clarification. This is the answer-directly signal.
- **Keep fail-loud for the other malformed cases (unchanged from #145):**
  - invalid JSON (existing `extractJson` throw),
  - a step present but missing a non-empty `goal` (existing throw),
  - both `clarification` and `steps` set — ambiguous (existing throw).
- **Prompt:** add an instruction — "If the request needs no decomposition (it can
  be answered directly without breaking it into steps), return an empty `steps`
  array and no `clarification`."

### 2. Replan planner (`coordinator/planning/replan-on-error.ts`)

**Unchanged.** A replan that yields no steps is a real failure
(`COORDINATOR_REPLAN_FAILED`); answer-directly applies only to initial planning.

### 3. Default dispatch → `hybrid` for one-shot/replan (F1)

Answer-directly synthesizes an **agentless** step, which only self-answers when
the dispatch strategy has a self fallback. The current default coordinator
dispatch for one-shot/replan is `SubAgentDispatch` (smart-server.ts:~637,
builder.ts:~1233), under which an agentless step fails — so without this change
the default #155 case would merely turn `(no response)` into
`COORDINATOR_STEP_FAILED`, not "42".

Change the **default** dispatch for one-shot/replan from `subagent` to `hybrid`
(`HybridDispatch(SubAgentDispatch, SelfDispatch)`) in both wiring sites. This is
exactly the precedent already in place for `skill-steps` (which defaults to
`hybrid` because "steps without an explicit `agent:` need a self-LLM fallback" —
see the existing comment in smart-server.ts). Answer-directly introduces the same
"agentless step" situation to one-shot/replan, so the same default applies.

- `smart-server.ts`: `dispatchKind = coordCfg.dispatch ?? 'hybrid'` (drop the
  `planningKind === 'skill-steps' ? 'hybrid' : 'subagent'` split — hybrid for all).
  The hybrid's self leg uses the already-resolved planner/main LLM.
- `builder.ts`: default `this._coordinator.dispatch ?? new HybridDispatch(new SubAgentDispatch(defaultContextBuilder), new SelfDispatch(plannerLlm))`.
  Use the **already-resolved `plannerLlm`** (`this._coordinator.plannerLlm ?? wrappedMainLlm`,
  guaranteed non-null at this point — the builder throws otherwise) — NOT
  `mainLlm`, which can be undefined in a valid `plannerLlm`-only configuration (F1).
- Users who require strict subagent routing can still pin `dispatch: subagent`
  explicitly; for such a config a trivial prompt surfaces a visible
  `COORDINATOR_STEP_FAILED` (never a silent `(no response)`) — a deliberate,
  documented edge of an opt-in strict config.

### 4. CoordinatorHandler (`pipeline/handlers/coordinator.ts`)

Place the **answer-directly short-circuit AFTER `validatePlan`** (it dispatches a
step, so it must respect layer rules) and after the existing `plan.clarification`
short-circuit. The clarification short-circuit stays where #145 put it (before
`validatePlan`) — it only streams a question, never dispatches.

- If `plan.source === 'planner-llm'` AND `plan.steps.length === 0` (and no
  clarification):
  - synthesize a single agentless step
    `{ id: 'direct-1', goal: ctx.inputText, status: 'pending' }`,
  - dispatch it once via the configured `this.deps.dispatch` (now `hybrid` by
    default → routes the agentless step to `SelfDispatch`, the agent's own LLM),
  - stream the step's output **raw** — `ctx.yield({ content: result.output })`
    then the empty finish chunk `finishReason: 'stop'` — with **no**
    `### direct-1` header (a direct answer must be clean, e.g. "42"),
  - log a `coordinator_answer_direct` event (step id / output length only — no
    raw user material),
  - return `true`.
- The `plan.source === 'planner-llm'` gate (F3) ensures this applies only to the
  LLM planner's empty result — `manual` / `skill-steps` empty plans keep their
  current semantics (skill-steps already throws on no steps).
- Layer rule (F4): at `layer >= maxLayer`, `validatePlan` already errors
  (`COORDINATOR_LAYER_VIOLATION`) before this branch is reached, so a nested
  coordinator at max depth does not answer-directly — conservative and safe.
- If the dispatch returns `ok: false`, surface a real
  `OrchestratorError('COORDINATOR_STEP_FAILED', ...)` — never a silent
  `(no response)`.

The synthesized step's `task` is composed by the existing `composeTask`: with no
objective and no `needsInput` it reduces to the bare `goal` (= `ctx.inputText`).
Note (F5): `SelfDispatch` then wraps it into a user message of the form
`"<inputText>\n\nResults so far:\n(none)"` — so the LLM receives the original
request plus the (empty) prior-results block. Tests assert the user message
contains `ctx.inputText`, not that it is byte-identical.

## Data flow

trivial prompt → LLM planner returns parseable `{ steps: [] }` (source
`planner-llm`) → `validatePlan` passes (empty steps, layer ok) → handler
synthesizes `direct-1 { goal: inputText }` → configured dispatch (`hybrid` by
default) routes the agentless step to `SelfDispatch` (agent's main LLM) → answer
→ streamed raw → `stop`.

## Error handling

- Malformed planner output (invalid JSON / missing-goal / clarification+steps) →
  still throws (`COORDINATOR_PLAN_FAILED`). Unchanged from #145.
- Direct-step dispatch failure → `COORDINATOR_STEP_FAILED` (real error, visible),
  not a silent empty response.

## Files touched

- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — split the
  #145 empty-output throw: `!Array.isArray(steps)` keeps throwing; explicit
  `steps: []` returns an empty-steps plan (answer-directly signal); prompt
  instruction to emit an empty `steps` array when no decomposition is needed.
- `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts` —
  **keep** the existing `{"objective":"x"}` (no steps array) → throws test
  (now the malformed/missing-array case); **add** a `{"steps":[]}` → returns a
  plan with `steps.length === 0` and no throw test; keep the missing-goal and
  clarification+steps throw tests.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — add the
  answer-directly short-circuit (after `validatePlan`, gated on
  `source === 'planner-llm'` + empty steps).
- `packages/llm-agent-libs/src/builder.ts` — default coordinator `dispatch` to
  `HybridDispatch(SubAgentDispatch, SelfDispatch(mainLlm))` (was bare
  `SubAgentDispatch`).
- `packages/llm-agent-server/src/smart-agent/smart-server.ts` — default
  `dispatchKind` to `'hybrid'` for all planning kinds (was `subagent` except
  `skill-steps`).
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts`
  (new) — `planner-llm` empty plan → synthesizes `direct-1` with
  `goal === inputText`, routes through the dispatch strategy (fake hybrid/self
  captures the step task, asserts it contains `inputText`), streams raw output
  (no `###` header), `finishReason: 'stop'`; dispatch returning `ok:false` →
  `COORDINATOR_STEP_FAILED`; a `manual`/non-`planner-llm` empty plan does NOT
  trigger answer-directly.

## Out of scope

- Result reviewer / `IReviewStrategy` (sub-project 2).
- Thin-coordinator staged refactor (sub-project 3).
- Activation-strategy changes — `activation: auto` stays as-is; this fixes the
  behavior under it.
- Tool-capable direct answers: answer-directly uses `SelfDispatch` (the agent's
  own LLM, no MCP tools). A request that genuinely needs a tool should yield a
  1-step plan from the planner, not an empty plan.

## Backward compatibility & behavior changes

- Multi-step and clarification flows are unchanged.
- An empty LLM-planner result now answers directly instead of throwing —
  strictly better UX (no more `(no response)`), reverting exactly the over-strict
  half of the #145 validation.
- **Default dispatch change:** the coordinator default dispatch for
  one-shot/replan changes from `subagent` to `hybrid`. Consequence: a regular
  plan step that omits `agent` now self-dispatches (agent's own LLM) instead of
  failing — strictly more graceful, and consistent with the existing
  `skill-steps` default. Configs that require strict subagent routing can pin
  `dispatch: subagent` explicitly. Documented as an intentional default change.
