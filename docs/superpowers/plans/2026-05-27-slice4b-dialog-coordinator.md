# Slice 4b: Coordinator loop + state-oracle + clarify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the DAG coordinator into a thin sequencer loop over role subagents (planner / reviewer / plan-interpreter / new state-oracle) that recovers via reviewer-driven replan, consults the oracle for reality (autonomous), and surfaces clarification questions to the user (ending the turn), with hierarchical (node + ancestors) context.

**Architecture:** The coordinator owns the recovery loop (moved up from the slice-4a interpreter): the interpreter returns failures up (with `failedNodeId` + `executedPlan`); the coordinator calls `reviewer.reviewExecutionFailure` → revise | clarify | needInfo | abort. `needInfo`/`clarify` are **thrown signals** (`NeedInfoSignal`/`ClarifySignal`) any role may raise, caught by the coordinator's `run-role` helper (oracle round-trip / end-turn). No resumption store — world-state + conversation-derived `ancestorContext` (objective + clarifications + oracleObservations) make resume emergent.

**Tech Stack:** TypeScript (ESM, strict), `node:test` via `tsx`, Biome, monorepo workspaces.

**Spec:** `docs/superpowers/specs/2026-05-27-slice4b-dialog-coordinator-design.md`

> **Plan-level refinement (vs spec contract shape):** the spec sketched
> needInfo/clarify as widened return unions (`PlannerOutput`, `ReviewVerdict +=`,
> `ExecutionReviewDecision +=`). Widening `IPlanner.plan(): Promise<DagPlan>` breaks
> all callers, and split mechanisms (some thrown, some returned) make the
> coordinator handle two paths. This plan realizes the SAME intent with **thrown
> typed signals** (`NeedInfoSignal`, `ClarifySignal`) from **every** role — planner,
> `review()`, and `reviewExecutionFailure()` — caught uniformly by the coordinator's
> `runRole`. Non-breaking and consistent with `NeedsDecompositionError` (slice 3).
> Return unions stay as-is: `ReviewVerdict` = `{pass}|{pass:false,feedback}`,
> `ExecutionReviewDecision` = `abort|revise`. The only return-shape change is the
> additive `PlannerInput.reviewerFeedback?` (pre-execution correction loop).

**Conventions:** ESM `.js` imports; interfaces `I`-prefixed; tests in `__tests__/` (`node:test`); `npm run test --workspace <pkg>`; `npm run build`; `npm run lint` then `npm run lint:check`. Husky hook hint is harmless. Each task ends build-green.

---

## PART A — Contracts + interpreter failure surface

### Task 1: Contracts (signals, ContextPath, ancestorContext, InterpretResult fields)

**Files:**
- Create: `packages/llm-agent/src/coordinator-signals.ts`
- Create: `packages/llm-agent/src/interfaces/context-path.ts`
- Modify: `packages/llm-agent/src/interfaces/{planner,review,interpreter}.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`, `packages/llm-agent/src/index.ts`

- [ ] **Step 1: Signals** — create `packages/llm-agent/src/coordinator-signals.ts`:

```ts
/** A role (planner/reviewer) needs a REALITY fact; the coordinator routes the
 *  query to the state-oracle and re-invokes the role (autonomous, same turn). */
export class NeedInfoSignal extends Error {
  readonly query: string;
  constructor(query: string) {
    super(`needs info: ${query}`);
    this.name = 'NeedInfoSignal';
    this.query = query;
  }
}

/** A role needs a HUMAN decision; the coordinator emits the question and ends
 *  the turn (the next turn replans fresh from current state). */
export class ClarifySignal extends Error {
  readonly question: string;
  constructor(question: string) {
    super(`needs clarification: ${question}`);
    this.name = 'ClarifySignal';
    this.question = question;
  }
}

/**
 * Marker prefixed onto a coordinator-emitted clarification question. `Message`
 * exposes no metadata field, so the marker lives in the assistant content — but
 * it is **zero-width (invisible)**: the user/API sees only the question, never a
 * `[needs-clarification]`-style prefix. On the NEXT turn the coordinator
 * reconstructs the clarification Q/A ONLY from the immediately-preceding assistant
 * turn IF its content starts with this marker — a reliable, narrow signal (last
 * turn only) that never pulls unrelated/sibling history.
 *
 * Zero-width chars: U+2063 INVISIBLE SEPARATOR ×3. (A cleaner structured
 * metadata channel — and resilience if a transport strips zero-width chars — is
 * a documented follow-up; the invisible content-prefix is the MVP.)
 */
export const CLARIFY_MARKER = '\u2063\u2063\u2063'; // 3× U+2063, invisible
```

- [ ] **Step 2: ContextPath** — create `packages/llm-agent/src/interfaces/context-path.ts`:

```ts
/** The hierarchical context unit: the current node/request + its ancestor intent
 *  path. NOT the whole chat, NOT just the last prompt. Travels into role inputs. */
export interface ContextPath {
  /** Root/parent intent. */
  objective?: string;
  /** Intent-shaping dialogue along the path. */
  clarifications: Array<{ question: string; answer: string }>;
  /** Reality facts gathered for THIS path via the oracle (needInfo round-trips). */
  oracleObservations: Array<{ query: string; answer: string }>;
}
```

- [ ] **Step 3: Thread `ancestorContext` into role inputs** — in `planner.ts`, `review.ts`, add `ancestorContext?: ContextPath` to `PlannerInput`, `ReviewInput`, and `ExecutionFailureInput`. Add `import type { ContextPath } from './context-path.js';` to each. Also add `reviewerFeedback?: string` to `PlannerInput` (the gate's reject feedback fed back into a re-plan — see Task 5 pre-execution correction loop).

**`ExecutionReviewDecision` stays `abort | revise` only** (do NOT add needInfo/clarify members). needInfo/clarify are **thrown signals** (`NeedInfoSignal`/`ClarifySignal`) from EVERY role — planner, `review()`, AND `reviewExecutionFailure()` — caught uniformly by the coordinator's `runRole`. Keeping the decision union at `abort | revise` is what makes the single signal-based mechanism consistent (Finding-1 fix).

- [ ] **Step 4: InterpretResult failure surface** — in `interpreter.ts`, add to `InterpretResult`:

```ts
  /** Set when ok === false: the node whose failure stopped the run (first
   *  plan-node-order node with status 'failed'). */
  failedNodeId?: string;
  /** The final plan after any in-run local splices — the coordinator orders the
   *  trace and re-plans against this. */
  executedPlan?: DagPlan;
```

(Add `import type { DagPlan } from './dag-plan.js';` if not present.)

- [ ] **Step 5: Barrels** — `interfaces/index.ts`: export `ContextPath` (from `./context-path.js`) and the (already-exported) review/planner/interpreter types. `src/index.ts`: value-export the signals + marker: `export { NeedInfoSignal, ClarifySignal, CLARIFY_MARKER } from './coordinator-signals.js';`.

- [ ] **Step 6: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent/src
git commit -m "feat(slice4b): contracts — NeedInfo/Clarify signals, ContextPath, ancestorContext, InterpretResult.failedNodeId/executedPlan"
```

(All additive/optional → existing impls compile. `ExecutionReviewDecision` stays
`abort | revise` — needInfo/clarify are thrown signals, not union members — so no
return-type widening; only the additive `PlannerInput.reviewerFeedback?` changes a
shape, and it's optional.)

---

### Task 2: Interpreter returns failures up (revert 4a in-interpreter revise; set failedNodeId/executedPlan)

**Files:** `packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts`; test `__tests__/dag-plan-interpreter.test.ts`.

Recovery moves to the coordinator (Task 5), so the interpreter no longer handles the `revise` reaction and no longer passes `plan`/`completedResults` into `ErrorContext`. It keeps slice-3 autonomous local replan (`replan` on `NeedsDecompositionError`) and now reports `failedNodeId` + `executedPlan`.

- [ ] **Step 1: Remove the `revise` branch and the 4a ErrorContext fields.** In `interpret()`:
  - In the `onNodeFailure` call object, delete `plan: currentPlan,` and `completedResults: Object.values(results),`.
  - Delete the entire `else if (reaction.action === 'revise' && remainingReplans > 0) { ... }` branch (the whole-remainder swap + `revised`/`break`). Keep the `replan` branch and the final `else` (record failed). Remove the now-unused `revised`/`break` mechanics — a wave only does local `replan` splices (slice-3 behavior).

- [ ] **Step 2: Set `failedNodeId` + `executedPlan` on the failed return.** Replace the failed-return block:

```ts
    const failed = currentPlan.nodes.filter(
      (n) => results[n.id].status !== 'done',
    );
    if (failed.length > 0) {
      const firstFailed = currentPlan.nodes.find(
        (n) => results[n.id].status === 'failed',
      );
      return {
        nodeResults: results,
        ok: false,
        error: firstFailed
          ? `node '${firstFailed.id}' failed: ${results[firstFailed.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
        failedNodeId: firstFailed?.id,
        executedPlan: currentPlan,
      };
    }
```

(The success return may also set `executedPlan: currentPlan` for symmetry; optional.)

- [ ] **Step 3: Update tests.** Remove the two slice-4a interpreter tests that exercised the in-interpreter `revise` (`'revises the whole remaining plan ...'`, `'revise with an empty plan ...'`) — that behavior moves to the coordinator (tested in Task 5). Add:

```ts
  it('reports failedNodeId and executedPlan on failure', async () => {
    const w = worker('w', async (i) =>
      i.task.includes('boom') ? Promise.reject(new Error('boom')) : { output: 'ok' },
    );
    const r = await I().interpret(
      dag([{ id: 'a', goal: 'boom', agent: 'w' }]),
      ctx([['w', w]]),
    );
    assert.equal(r.ok, false);
    assert.equal(r.failedNodeId, 'a');
    assert.equal(r.executedPlan?.nodes[0].id, 'a');
  });
```

The slice-3 replan/budget/concurrent-wave tests stay and must pass.

- [ ] **Step 4: Build + test + lint + commit**

```bash
npm run build && npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"
npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag/dag-plan-interpreter.ts packages/llm-agent-libs/src/coordinator/dag/__tests__/dag-plan-interpreter.test.ts
git commit -m "refactor(slice4b): interpreter returns failures up (failedNodeId/executedPlan); drop in-interpreter revise"
```

Expected: `ℹ fail 0`. (`ErrorReaction.revise` / `ErrorContext.plan` still exist in the interface; the interpreter just stops using them — removed in Task 3.)

---

### Task 3: Remove the slice-4a interpreter-recovery plumbing

The reviewer's `reviewExecutionFailure` method is KEPT (reused by the coordinator). Only its interpreter-internal plumbing is removed.

**Files:** delete `reviewer-error-strategy.ts` + its test; modify `error-strategy.ts` (interface), coordinator barrels, `config.ts`, `smart-server.ts`.

- [ ] **Step 1:** Delete `packages/llm-agent-libs/src/coordinator/dag/reviewer-error-strategy.ts` and `__tests__/reviewer-error-strategy.test.ts`. Remove `ReviewerErrorStrategy` from `coordinator/index.ts` and `src/index.ts` barrels.

- [ ] **Step 2:** In `packages/llm-agent/src/interfaces/error-strategy.ts`: remove the `{ action: 'revise'; revisedPlan: DagPlan }` member from `ErrorReaction`; remove the optional `plan?`/`completedResults?` fields from `ErrorContext`. (`ErrorReaction` is back to `abort | replan`; `ErrorContext` back to slice-3 shape.)

- [ ] **Step 3:** In `config.ts` `assertErrorStrategyShape`: remove `'reviewer'` from the allowed `type` set (back to `'abort' | 'replan'`), update the message. In `smart-server.ts`: delete the `else if (esCfg?.type === 'reviewer') { ... }` arm and the `ReviewerErrorStrategy` import.

- [ ] **Step 4:** `npm run build` — fix any remaining references (grep `grep -rn "ReviewerErrorStrategy\|action: 'revise'\|\.completedResults\|ErrorContext" packages --include='*.ts' | grep -v dist`). Update/remove the 4a config test asserting `errorStrategy: reviewer` accepted (replace with a test that `reviewer` type is now rejected, OR delete it).

- [ ] **Step 5:** `npm run build && npm run test && npm run lint:check`. Expected: NO FAILURES. Commit:

```bash
git add -A
git commit -m "refactor(slice4b): remove ReviewerErrorStrategy + ErrorReaction.revise (recovery moves to coordinator); keep reviewExecutionFailure"
```

---

## PART B — Roles: signals + ancestorContext + recovery decision

### Task 4: Role adapters — signals, ancestorContext, reviewExecutionFailure needInfo/clarify

**Files:** `llm-dag-planner.ts`, `llm-review-strategy.ts`; tests.

- [ ] **Step 1: Planner — throw signals + use ancestorContext.** In `llm-dag-planner.ts`:
  - Import `NeedInfoSignal`, `ClarifySignal` from `@mcp-abap-adt/llm-agent`.
  - Extend `PLANNER_SYSTEM` so the model may instead emit `{"needInfo":"<query>"}` or `{"clarify":"<question>"}`.
  - In `plan()`, after parsing JSON: if `parsed.needInfo` is a non-empty string → `throw new NeedInfoSignal(parsed.needInfo)`; if `parsed.clarify` is a non-empty string → `throw new ClarifySignal(parsed.clarify)`; else parse the DagPlan as today.
  - Prepend `ancestorContext` to the task when present (objective + clarifications + oracleObservations rendered as text).

- [ ] **Step 2: Reviewer — needInfo/clarify in both methods + ancestorContext.** In `llm-review-strategy.ts`:
  - `review()`: the gate may **throw** `NeedInfoSignal`/`ClarifySignal` (parse `{"needInfo":"…"}`/`{"clarify":"…"}` from the critic) before returning a verdict. Keep `{pass:true}`/`{pass:false,feedback}` otherwise.
  - `reviewExecutionFailure()`: likewise **throws** `NeedInfoSignal`/`ClarifySignal` when the critic emits `{"needInfo"}`/`{"clarify"}`; otherwise returns `{action:'abort'}` | `{action:'revise',revisedPlan}` (the union is unchanged — needInfo/clarify are signals, not decision members).
  - Both methods render `input.ancestorContext` (when present) into the critic task.
  - The planner also renders `input.reviewerFeedback` (when present) so a re-plan after a gate reject incorporates the reviewer's correction.

- [ ] **Step 3: Tests** — add to `llm-review-strategy.test.ts` and `llm-dag-planner.test.ts`:
  - planner `{"needInfo":"which table?"}` → rejects with `NeedInfoSignal`; `{"clarify":"confirm?"}` → `ClarifySignal`.
  - reviewExecutionFailure `{"needInfo":"x"}` → rejects with `NeedInfoSignal`; `{"clarify":"y"}` → `ClarifySignal`; `{"action":"revise","plan":{…}}` → `{action:'revise',…}`; `{"action":"abort"}` → `{action:'abort'}`.
  - ancestorContext rendered: when `ancestorContext.clarifications` is set, the captured task (via a spy llm) contains the Q/A text.

- [ ] **Step 4: Build + test + lint + commit**

```bash
npm run build && npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"
npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/coordinator/dag
git commit -m "feat(slice4b): roles throw NeedInfo/Clarify signals + reviewExecutionFailure needInfo/clarify + ancestorContext"
```

---

## PART C — Coordinator loop + oracle + config + ancestorContext wiring

### Task 5: Coordinator loop (the heart)

**Files:** `packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts`; tests `__tests__/dag-coordinator.test.ts`.

Deps gain `stateOracle?: ISubAgent` and `maxRoundTrips?: number`. The handler becomes the sequencer loop.

- [ ] **Step 1: Deps** — add to `DagCoordinatorHandlerDeps`:

```ts
  /** Optional inspection-only subagent answering "real state" queries (git/FS/ABAP).
   *  Reachable only via NeedInfoSignal round-trips; never a DAG worker. */
  stateOracle?: ISubAgent;
  /** Bounds planner/reviewer/oracle round-trips + re-interprets per turn. Default 6. */
  maxRoundTrips?: number;
```

- [ ] **Step 2: Rewrite `execute()` as the loop.** Replace the body with the sequencer (full code):

```ts
  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    const maxRoundTrips = this.deps.maxRoundTrips ?? 6;
    const ancestorContext = buildAncestorContext(ctx); // objective+clarifications from history
    const agents = [...this.deps.workers.values()].map((w) => ({
      name: w.name,
      description: w.description,
    }));
    let roundTrips = 0;

    // run-role: execute a role thunk; on NeedInfoSignal consult the oracle and
    // retry; on ClarifySignal emit the question and end the turn. Returns
    // { ended: true } when the turn was ended by a clarification.
    const runRole = async <T>(
      thunk: () => Promise<T>,
    ): Promise<{ value: T } | { ended: true }> => {
      for (;;) {
        try {
          return { value: await thunk() };
        } catch (err) {
          if (err instanceof ClarifySignal) {
            ctx.options?.sessionLogger?.logStep('coordinator_clarify', {
              question: err.question,
            });
            // Prefix the marker so the NEXT turn can reconstruct this exact Q/A
            // from the immediately-preceding assistant turn (see buildAncestorContext).
            ctx.yield({
              ok: true,
              value: { content: CLARIFY_MARKER + err.question },
            });
            ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
            return { ended: true };
          }
          if (err instanceof NeedInfoSignal) {
            if (!this.deps.stateOracle) {
              throw new OrchestratorError(
                `coordinator: role requested info but no stateOracle is configured: ${err.query}`,
                'COORDINATOR_NEEDINFO_UNRESOLVED',
              );
            }
            if (++roundTrips > maxRoundTrips) {
              throw new OrchestratorError(
                'coordinator: round-trip budget exhausted',
                'COORDINATOR_BUDGET_EXHAUSTED',
              );
            }
            const ans = await this.deps.stateOracle.run({
              task: err.query,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
            });
            ancestorContext.oracleObservations.push({
              query: err.query,
              answer: ans.output,
            });
            continue; // retry the role with the enriched ancestorContext
          }
          throw err;
        }
      }
    };

    // 1. Plan.
    let planRes: { value: DagPlan } | { ended: true };
    try {
      planRes = await runRole(() =>
        this.deps.planner.plan({
          prompt: ctx.inputText,
          agents,
          ancestorContext,
          sessionId: ctx.sessionId,
          signal: ctx.options?.signal,
        }),
      );
    } catch (err) {
      ctx.error =
        err instanceof OrchestratorError
          ? err
          : new OrchestratorError(errMsg(err), 'COORDINATOR_PLAN_FAILED');
      return false;
    }
    if ('ended' in planRes) return true;
    let plan = planRes.value;

    // Loop: review-gate → interpret → recovery. Wrapped so runRole's thrown
    // OrchestratorError (no-oracle needInfo / budget) and any generic role error
    // become ctx.error + return false, never a rejected promise (Finding-3).
    try {
      for (;;) {
      if (++roundTrips > maxRoundTrips) {
        ctx.error = new OrchestratorError(
          'coordinator: round-trip budget exhausted',
          'COORDINATOR_BUDGET_EXHAUSTED',
        );
        return false;
      }

      // 2. Reviewer gate (optional).
      if (this.deps.reviewer) {
        const gate = await runRole(() =>
          this.deps.reviewer!.review({
            prompt: ctx.inputText,
            plan,
            agents,
            ancestorContext,
            sessionId: ctx.sessionId,
            signal: ctx.options?.signal,
          }),
        );
        if ('ended' in gate) return true;
        if (!gate.value.pass) {
          // Pre-execution correction loop (spec): re-plan WITH the reviewer's
          // feedback instead of failing. Bounded by maxRoundTrips (incremented at
          // loop top). Budget exhaustion → COORDINATOR_BUDGET_EXHAUSTED.
          const replanned = await runRole(() =>
            this.deps.planner.plan({
              prompt: ctx.inputText,
              agents,
              ancestorContext,
              reviewerFeedback: gate.value.feedback,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
            }),
          );
          if ('ended' in replanned) return true;
          plan = replanned.value;
          continue; // re-gate the corrected plan
        }
      }

      // 3. Interpret.
      let result: InterpretResult;
      try {
        result = await this.deps.interpreter.interpret(plan, {
          inputText: ctx.inputText,
          workers: this.deps.workers,
          sessionId: ctx.sessionId,
          signal: ctx.options?.signal,
          errorStrategy: this.deps.errorStrategy ?? new AbortErrorStrategy(),
        });
      } catch (err) {
        ctx.error =
          err instanceof OrchestratorError
            ? err
            : new OrchestratorError(
                errMsg(err),
                codeOf(err) ?? 'COORDINATOR_PLAN_INVALID',
              );
        return false;
      }

      if (result.ok) {
        ctx.options?.sessionLogger?.logStep('dag_coordinator_final', {
          nodeCount: plan.nodes.length,
          outputLength: result.output.length,
        });
        ctx.yield({ ok: true, value: { content: result.output } });
        ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
        return true;
      }

      // 4. Failed. No reviewer ⇒ terminal batch failure.
      if (!this.deps.reviewer || !this.deps.reviewer.reviewExecutionFailure) {
        ctx.error = new OrchestratorError(
          `coordinator: ${result.error ?? 'plan execution failed'}`,
          'COORDINATOR_STEP_FAILED',
        );
        return false;
      }

      const execPlan = result.executedPlan ?? plan;
      const trace = execPlan.nodes
        .map((n) => result.nodeResults[n.id])
        .filter((r): r is NonNullable<typeof r> => Boolean(r));
      const failedId = result.failedNodeId ?? execPlan.nodes[0]?.id ?? '';

      const recovery = await runRole(() =>
        this.deps.reviewer!.reviewExecutionFailure!({
          objective: execPlan.objective,
          plan: execPlan,
          trace,
          failedNodeId: failedId,
          error: result.nodeResults[failedId]?.error ?? result.error ?? 'unknown',
          agents,
          ancestorContext,
          sessionId: ctx.sessionId,
          signal: ctx.options?.signal,
        }),
      );
      if ('ended' in recovery) return true;
      const decision = recovery.value; // abort | revise — needInfo/clarify were
                                        // signals already handled inside runRole.
      if (decision.action === 'revise') {
        if (decision.revisedPlan.nodes.length === 0) {
          ctx.error = new OrchestratorError(
            'coordinator: reviewer returned an empty revised plan',
            'COORDINATOR_PLAN_INVALID',
          );
          return false;
        }
        plan = decision.revisedPlan;
        continue; // re-interpret
      }
      // decision.action === 'abort'
      ctx.error = new OrchestratorError(
        `coordinator: recovery aborted: ${result.error ?? 'unknown'}`,
        'COORDINATOR_STEP_FAILED',
      );
      return false;
    }
    } catch (err) {
      // runRole throws OrchestratorError for unresolved-needInfo (no oracle) and
      // round-trip budget exhaustion; a role may throw a generic error. Convert to
      // ctx.error + return false (never reject execute()'s promise) — Finding-3 fix.
      ctx.error =
        err instanceof OrchestratorError
          ? err
          : new OrchestratorError(errMsg(err), 'COORDINATOR_STEP_FAILED');
      return false;
    }
  }
```

Add imports: `NeedInfoSignal`, `ClarifySignal`, `CLARIFY_MARKER` (value) from `@mcp-abap-adt/llm-agent`; `NodeResult` type if needed. Add a module-level `buildAncestorContext(ctx)` helper (Task 7 implements it; for this task a minimal version returning `{ objective: ctx.inputText, clarifications: [], oracleObservations: [] }` is enough to compile + pass Task-5 tests — Task 7 adds the marker-based clarification reconstruction).

- [ ] **Step 3: Tests** — in `dag-coordinator.test.ts` (helpers `planner`, `interp`, `makeCtx` exist), add:
  - **no reviewer, interpret fails → COORDINATOR_STEP_FAILED** (batch).
  - **reviewExecutionFailure revise → re-interpret → done** (interp returns failed once with `failedNodeId`/`executedPlan`, then ok; reviewer returns `{action:'revise',revisedPlan}`; assert final output).
  - **clarify → turn ends** (reviewExecutionFailure **throws `ClarifySignal('q')`**; assert the yielded content is `CLARIFY_MARKER + 'q'` — i.e. it ends with the visible question `'q'` and starts with the invisible marker — followed by a finishReason-stop chunk; `execute` returns `true`, `ctx.error` unset).
  - **needInfo with oracle → round-trip** (reviewExecutionFailure **throws `NeedInfoSignal('q')` once** then returns `{action:'revise',...}`; provide a `stateOracle` stub; assert the oracle was called and the run proceeds to done).
  - **needInfo, no oracle → ctx.error COORDINATOR_NEEDINFO_UNRESOLVED, return false** (reviewExecutionFailure throws `NeedInfoSignal`, no `stateOracle` dep; assert `execute` resolves `false` with that code — NOT a rejected promise; this is the Finding-3 guard).
  - **gate reject → replan-with-feedback → re-gate → pass → done** (reviewer `review` returns `{pass:false,feedback}` on the first plan, `{pass:true}` on the second; the planner stub returns plan B when `reviewerFeedback` is set; assert it ran plan B and completed).
  - **budget exhausted → COORDINATOR_BUDGET_EXHAUSTED** (reviewer keeps returning revise/reject past `maxRoundTrips`).
  - Existing slice-1/2 handler tests (pass-through, plan-rejected→now replan, gate) updated where the old terminal-reject assertion changed to the replan loop.

  Use stub reviewers implementing `review` + `reviewExecutionFailure` (which may throw the signals), a planner stub keyed on `reviewerFeedback`, and a stub `stateOracle: ISubAgent` (`run` returns `{ output: 'oracle says X' }`).

- [ ] **Step 4: Build + test + lint + commit**

```bash
npm run build && npm run test --workspace @mcp-abap-adt/llm-agent-libs 2>&1 | grep -iE "fail"
npm run lint && npm run lint:check
git add packages/llm-agent-libs/src/pipeline/handlers/dag-coordinator.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/dag-coordinator.test.ts
git commit -m "feat(slice4b): coordinator loop — reviewer recovery, needInfo/oracle, clarify-ends-turn, bounded"
```

---

### Task 6: State-oracle wiring + config + worker-catalog exclusion

**Files:** `config.ts`, `smart-server.ts`; tests `dag-coordinator-config.test.ts`.

- [ ] **Step 1: Config validation** — in `config.ts`: add `stateOracle?: string` and `maxRoundTrips?: number` to `YamlCoordinator`; add `'stateOracle'`, `'maxRoundTrips'` to `DAG_ONLY`. In `assertCoordinatorConfigShape` (DAG branch) validate: if `coord.stateOracle` is present it must be a non-empty string; if `coord.maxRoundTrips` present it must be a non-negative number. Add config tests (accept `stateOracle: 'oracle'`; reject non-string; reject in linear coordinator).

- [ ] **Step 2: smart-server wiring** — in the DAG branch of `smart-server.ts`:
  - resolve the oracle: `const oracleName = (coordCfg.stateOracle as string | undefined); let stateOracle: ISubAgent | undefined; if (oracleName) { stateOracle = registry.get(oracleName); if (!stateOracle) throw new Error(\`coordinator.stateOracle '${oracleName}' is not a declared subagent\`); }`.
  - **Exclude the oracle from the worker catalog**: `const workers = new Map([...registry].filter(([name]) => name !== oracleName));` (replace the `const workers = registry;` line). Keep the empty-registry guard against `workers` (after exclusion).
  - pass `stateOracle` and `maxRoundTrips: coordCfg.maxRoundTrips as number | undefined` into `builder.withDagCoordinator({...})`.

- [ ] **Step 3: Build + test + lint + commit**

```bash
npm run build && npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"
npm run lint && npm run lint:check
git add packages/llm-agent-server/src/smart-agent
git commit -m "feat(slice4b): wire coordinator.stateOracle (excluded from worker catalog) + maxRoundTrips"
```

---

### Task 7: Hierarchical ancestorContext from history + composeNodeTask

**Files:** `dag-coordinator.ts` (`buildAncestorContext`), `compose-node-task.ts`; tests.

- [ ] **Step 1: `buildAncestorContext(ctx)`** — implement the helper in
  `dag-coordinator.ts`. It uses the **`CLARIFY_MARKER`** marker (Task 1), NOT a loose
  history scan. Reconstruct the clarification Q/A ONLY from the **immediately-preceding
  assistant turn** when it carries the marker — narrow (last turn only) so it never
  pulls unrelated/sibling questions from deeper history:

  **Reality of `ctx.history`:** the pipeline passes the FULL message array
  INCLUDING the current user turn at the tail (see `agent.ts` /
  `default-pipeline.ts` — history = all `textOrMessages`). So on a clarification
  resume the tail is `… user(parent), assistant(CLARIFY_MARKER+Q), user(current
  answer)` and `h[len-1]` is the user answer, NOT the marked assistant. Locate the
  marked assistant robustly (handles both history-includes-current and
  history-excludes-current):

  ```ts
  function buildAncestorContext(ctx: PipelineContext): ContextPath {
    const h = ctx.history;
    const n = h.length;
    const isMarked = (m?: { role: string; content: string | null }) =>
      m?.role === 'assistant' &&
      typeof m.content === 'string' &&
      m.content.startsWith(CLARIFY_MARKER);
    // The marked clarify turn is the most recent assistant turn at the tail:
    // h[n-1] when history EXCLUDES the current user turn, else h[n-2] (the usual
    // case — history INCLUDES the current user answer as h[n-1]).
    let mi = -1;
    if (isMarked(h[n - 1])) mi = n - 1;
    else if (h[n - 1]?.role === 'user' && isMarked(h[n - 2])) mi = n - 2;

    if (mi >= 0) {
      const question = (h[mi].content as string).slice(CLARIFY_MARKER.length).trim();
      const parent = h[mi - 1]; // the user request the question was about
      const objective =
        parent?.role === 'user' && typeof parent.content === 'string'
          ? parent.content
          : ctx.inputText;
      return {
        objective,
        clarifications: [{ question, answer: ctx.inputText }], // inputText = current answer (robust)
        oracleObservations: [],
      };
    }
    // Fresh request (no marked clarification at the tail).
    return { objective: ctx.inputText, clarifications: [], oracleObservations: [] };
  }
  ```

  This restores full clarify-to-user resume (node + ancestors): after "Which table?"
  the next turn's planner receives `objective: "<original request>"` AND
  `clarifications: [{question: "Which table?", answer: "ZCUSTOMERS"}]` — so a short
  answer like `ZCUSTOMERS` has both the original goal and the question it answers.
  `ctx.inputText` is used for the answer (robust regardless of whether the current
  turn is also in `h`). Only `h[n-1]` / `h[n-2]` / `h[n-3]` are read — no deep scan,
  no sibling leakage. Multi-round chains are a documented follow-up.
  `import { CLARIFY_MARKER } from '@mcp-abap-adt/llm-agent';`.

- [ ] **Step 2: composeNodeTask ancestor path** — in `compose-node-task.ts`, accept the ancestor objective/clarifications and prepend them (objective already partly present via `plan.objective`; add the clarifications/oracleObservations text). Keep dependency outputs (dependsOn) and exclude siblings (already the case). Update the interpreter call site to pass the ancestor info (thread `ctx.ancestorContext` if added to `InterpretContext`, or pass via the plan objective). Minimal: add `ancestorContext?: ContextPath` to `InterpretContext`, set it from the coordinator, and have `composeNodeTask` render it.

- [ ] **Step 3: Tests** —
  - `compose-node-task.test.ts`: a node task includes the objective + a clarification
    Q/A when `ancestorContext` is provided, includes dependency outputs, and excludes
    a non-dependency sibling's output.
  - `buildAncestorContext`: realistic history (current answer at the tail)
    `[{user:'create RAP BO for orders'}, {assistant: CLARIFY_MARKER+'Which table?'},
    {user:'ZCUSTOMERS'}]` + `inputText:'ZCUSTOMERS'` → `objective:'create RAP BO for
    orders'` (parent) AND `clarifications:[{question:'Which table?', answer:'ZCUSTOMERS'}]`.
    Also cover: history-EXCLUDES-current form `[{user:'…'},{assistant:CLARIFY_MARKER+'Q'}]`
    + `inputText:'A'` → same result. A plain fresh request (last turn user, prior
    turn NOT a marked assistant) → `objective: inputText`, `clarifications:[]`. A
    marked turn deeper than `h[n-2]` → `[]` (only the tail is read).
  - `dag-coordinator.test.ts`: after an oracle round-trip, `ancestorContext.oracleObservations`
    reaches the next role call (spy); a clarify emits `CLARIFY_MARKER + question` as
    the assistant content.

- [ ] **Step 4: Build + test + lint + commit**

```bash
npm run build && npm run test 2>&1 | grep -iE "ℹ fail [1-9]" || echo "NO FAILURES"
npm run lint && npm run lint:check
git add packages/llm-agent-libs/src
git commit -m "feat(slice4b): hierarchical ancestorContext (objective+clarifications+oracleObservations) into roles + composeNodeTask"
```

---

### Task 8: Full verification

- [ ] **Step 1: Backward-compat** — `npm run test --workspace @mcp-abap-adt/llm-agent-server 2>&1 | grep -iE "fail"` → `ℹ fail 0`; existing example YAMLs validate; a DAG config without `reviewer`/`stateOracle` behaves as batch.
- [ ] **Step 2: Full suite** — `npm run test 2>&1 | grep -iE "ℹ fail [1-9]" || echo "NO FAILURES"` → `NO FAILURES`.
- [ ] **Step 3: No stale 4a recovery surface** — `grep -rn "ReviewerErrorStrategy\|action: 'revise'\|completedResults" packages --include='*.ts' | grep -v dist | grep -v __tests__` → no matches in src.
- [ ] **Step 4: Build + lint:check** clean (0 warnings). Commit any formatting.
