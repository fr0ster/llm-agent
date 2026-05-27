# Slice 4b: Coordinator loop + state-oracle + clarify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the DAG coordinator into a thin sequencer loop over role subagents (planner / reviewer / plan-interpreter / new state-oracle) that recovers via reviewer-driven replan, consults the oracle for reality (autonomous), and surfaces clarification questions to the user (ending the turn), with hierarchical (node + ancestors) context.

**Architecture:** The coordinator owns the recovery loop (moved up from the slice-4a interpreter): the interpreter returns failures up (with `failedNodeId` + `executedPlan`); the coordinator calls `reviewer.reviewExecutionFailure` → revise | clarify | needInfo | abort. `needInfo`/`clarify` are **thrown signals** (`NeedInfoSignal`/`ClarifySignal`) any role may raise, caught by the coordinator's `run-role` helper (oracle round-trip / end-turn). No resumption store — world-state + conversation-derived `ancestorContext` (objective + clarifications + oracleObservations) make resume emergent.

**Tech Stack:** TypeScript (ESM, strict), `node:test` via `tsx`, Biome, monorepo workspaces.

**Spec:** `docs/superpowers/specs/2026-05-27-slice4b-dialog-coordinator-design.md`

> **Plan-level refinement (vs spec contract shape):** the spec sketched
> needInfo/clarify as widened return unions (`PlannerOutput`, `ReviewVerdict +=`).
> Widening `IPlanner.plan(): Promise<DagPlan>` breaks all callers. This plan
> realizes the SAME intent with **thrown typed signals** (`NeedInfoSignal`,
> `ClarifySignal`) — non-breaking, and consistent with `NeedsDecompositionError`
> (slice 3). `reviewExecutionFailure` keeps its union and gains `needInfo`/`clarify`
> members there (that union has no external callers but the coordinator).

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

- [ ] **Step 3: Thread `ancestorContext` into role inputs** — in `planner.ts`, `review.ts`, add `ancestorContext?: ContextPath` to `PlannerInput`, `ReviewInput`, and `ExecutionFailureInput`. Add `import type { ContextPath } from './context-path.js';` to each. Add `needInfo` + `clarify` members to `ExecutionReviewDecision` in `review.ts`:

```ts
export type ExecutionReviewDecision =
  | { action: 'abort' }
  | { action: 'revise'; revisedPlan: DagPlan }
  | { action: 'needInfo'; query: string }
  | { action: 'clarify'; question: string };
```

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

- [ ] **Step 5: Barrels** — `interfaces/index.ts`: export `ContextPath` (from `./context-path.js`) and the (already-exported) review/planner/interpreter types. `src/index.ts`: value-export the signals: `export { NeedInfoSignal, ClarifySignal } from './coordinator-signals.js';`.

- [ ] **Step 6: Build + lint + commit**

```bash
npm run build && npm run lint && npm run lint:check
git add packages/llm-agent/src
git commit -m "feat(slice4b): contracts — NeedInfo/Clarify signals, ContextPath, ancestorContext, InterpretResult.failedNodeId/executedPlan"
```

(All additive/optional → existing impls compile. `ExecutionReviewDecision` widening only affects the coordinator, updated in Task 5.)

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
  - `review()`: the gate may also throw `NeedInfoSignal`/`ClarifySignal` (parse `{"needInfo"}`/`{"clarify"}` from the critic). Keep `{pass:true}`/`{pass:false,feedback}`.
  - `reviewExecutionFailure()`: extend the parser to also return `{ action: 'needInfo', query }` and `{ action: 'clarify', question }` (alongside `abort`/`revise`).
  - Both methods render `input.ancestorContext` (when present) into the critic task.

- [ ] **Step 3: Tests** — add to `llm-review-strategy.test.ts` and `llm-dag-planner.test.ts`:
  - planner `{"needInfo":"which table?"}` → rejects with `NeedInfoSignal`; `{"clarify":"confirm?"}` → `ClarifySignal`.
  - reviewExecutionFailure `{"action":"needInfo","query":"x"}` → `{action:'needInfo',query:'x'}`; `{"action":"clarify","question":"y"}` → `{action:'clarify',question:'y'}`.
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
            ctx.yield({ ok: true, value: { content: err.question } });
            ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
            return { ended: true };
          }
          if (err instanceof NeedInfoSignal) {
            if (!this.deps.stateOracle || ++roundTrips > maxRoundTrips) {
              throw new OrchestratorError(
                this.deps.stateOracle
                  ? 'coordinator: round-trip budget exhausted'
                  : `coordinator: role requested info but no stateOracle is configured: ${err.query}`,
                'COORDINATOR_NEEDINFO_UNRESOLVED',
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

    // Loop: review-gate → interpret → recovery.
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
          ctx.error = new OrchestratorError(
            gate.value.feedback,
            'COORDINATOR_PLAN_REJECTED',
          );
          return false;
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
      const decision = recovery.value;
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
      // needInfo here means the reviewer asked for info but runRole already
      // resolved it (oracle) or ended/threw; a bare needInfo decision is treated
      // as abort to avoid a silent stall.
      ctx.error = new OrchestratorError(
        `coordinator: recovery aborted: ${result.error ?? 'unknown'}`,
        'COORDINATOR_STEP_FAILED',
      );
      return false;
    }
  }
```

Add imports: `NeedInfoSignal`, `ClarifySignal` (value) from `@mcp-abap-adt/llm-agent`; `NodeResult` type if needed. Add a module-level `buildAncestorContext(ctx)` helper (Task 7 fills it; for this task a minimal version returning `{ objective: undefined, clarifications: [], oracleObservations: [] }` is enough to compile + pass Task-5 tests — Task 7 enriches it from history).

- [ ] **Step 3: Tests** — in `dag-coordinator.test.ts` (helpers `planner`, `interp`, `makeCtx` exist), add:
  - **no reviewer, interpret fails → COORDINATOR_STEP_FAILED** (batch).
  - **reviewExecutionFailure revise → re-interpret → done** (interp returns failed once with `failedNodeId`/`executedPlan`, then ok; reviewer returns revise; assert final output).
  - **clarify → turn ends** (reviewer throws... no: reviewExecutionFailure returns `{action:'clarify',question}`; assert the question is yielded and execute returns true, no error).
  - **needInfo with oracle → round-trip** (reviewExecutionFailure returns `{action:'needInfo',query}` once then `revise`; provide a `stateOracle` stub; assert it was called and the run proceeds).
  - **needInfo, no oracle → COORDINATOR_NEEDINFO_UNRESOLVED**.
  - **budget exhausted → COORDINATOR_BUDGET_EXHAUSTED**.
  - Existing slice-1/2 handler tests (pass-through, plan-rejected, gate) still pass.

  Use stub reviewers implementing `review` + `reviewExecutionFailure`, and a stub `stateOracle: ISubAgent` (`run` returns `{ output: 'oracle says X' }`).

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

- [ ] **Step 1: `buildAncestorContext(ctx)`** — implement the helper in `dag-coordinator.ts`: derive `objective` from `ctx.inputText` (the current request) and reconstruct `clarifications` from the conversation history available on `ctx` (pair a prior assistant clarification question with the following user answer). If history isn't accessible, return `{ objective: ctx.inputText, clarifications: [], oracleObservations: [] }`. (Inspect `PipelineContext` for the history field — e.g. `ctx.assembledMessages` / client history; pair `assistant`→`user` turns where the assistant turn looks like a question. Keep it conservative: only include clear Q/A pairs.)

- [ ] **Step 2: composeNodeTask ancestor path** — in `compose-node-task.ts`, accept the ancestor objective/clarifications and prepend them (objective already partly present via `plan.objective`; add the clarifications/oracleObservations text). Keep dependency outputs (dependsOn) and exclude siblings (already the case). Update the interpreter call site to pass the ancestor info (thread `ctx.ancestorContext` if added to `InterpretContext`, or pass via the plan objective). Minimal: add `ancestorContext?: ContextPath` to `InterpretContext`, set it from the coordinator, and have `composeNodeTask` render it.

- [ ] **Step 3: Tests** — `compose-node-task.test.ts`: a node task includes the objective + a clarification Q/A when `ancestorContext` is provided, includes dependency outputs, and excludes a non-dependency sibling's output. `dag-coordinator.test.ts`: after an oracle round-trip, `ancestorContext.oracleObservations` reaches the next role call (spy).

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
