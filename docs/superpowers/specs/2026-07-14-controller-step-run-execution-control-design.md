# Controller Step/Run Execution Control — Design

**Status:** Design (approved framing via brainstorming dialogue 2026-07-14; Section 1 confirmed).

**Goal:** Give a controller (planner+executor) pipeline a consumer-swappable **per-step execution control** — a wall-clock/budget bound covering the *whole step* (whatever consumed the time inside, LLM or MCP) that cuts a non-converging step → replan — plus a sibling **run-level** control seam. This fixes the executor livelock observed live (bounded per-round context reduced per-round cost but let some steps loop to the outer 900s HTTP timeout because the controller has only *count* budgets, no *time* budget).

**Architecture:** Two small, independent, consumer-swappable interfaces (ISP): `IStepExecutionControl` (per-step budget → cancellation signal + between-round gate) and `IRunExecutionControl` (per-run budget). The controller composition consumes the step control now (default impl = wall-clock + the existing `maxToolCalls`); the run control ships as a defined seam with a **no-op default**, its full realization deferred. A per-step `AbortSignal` is threaded into every inner op (executor LLM call **and** `callMcp`) via the existing `withAbort` cancellation seam. When the budget is hit (mid-call via signal, or between rounds via the gate), the step is cut through the existing **control-failure → replan** path.

**Tech Stack:** TypeScript (ESM `.js`), `node:test` + `tsx`, Biome, Node ≥22. Packages: `@mcp-abap-adt/llm-agent` (interfaces), `@mcp-abap-adt/llm-agent-server-libs` (controller default impl + wiring + subagent/callMcp signal plumbing).

**Builds on:** the tool-loop context strategy branch (`IToolLoopContextStrategy`) — this is a SEPARATE, complementary control (that branch bounds per-round *context*; this bounds per-step *time*). See `feedback_controller_not_simple_pipeline_per_step_controls`, `feedback_mcp_timeout_ownership`, `feedback_consumer_chooses_seams_rag_examples`.

## Global Constraints

- **Interfaces + DI + strategies; we never decide the consumer's implementation.** Both controls are injectable and swappable (a consumer may replace the impl with their own — even hardcoded budgets). We ship default impls only as OUR examples.
- **Do NOT split pipelines into hardcoded groups.** The consumer chooses which control(s) to compose for their pipeline and defines *when/what/how* to control. A pipeline may control the run-as-run, the run-as-steps, both, or neither.
- **ISP — two focused interfaces**, not one grown control object. Step and run controls are independent seams.
- **Timeout ownership** (`feedback_mcp_timeout_ownership`): a per-step timeout bounds the CONTROLLER's OWN operation (the step). On budget exhaustion the controller CANCELS its own in-flight call via `withAbort(signal)` — this is cancellation, NOT imposing a timeout on MCP. MCP still self-governs its own `callTool` timeout (#222); whichever fires first wins. Do NOT reintroduce the forbidden implicit-SDK-timeout stack.
- **Fail-loud preserved:** a budget cut is a `control-failure → replan` (a step outcome the planner recovers from), never a silent empty response. The 20.4.0 MCP-unavailable escalate/abortTerminal is unchanged and still fires before any budget handling.
- **Backward-compat:** when NO step/run control is injected, behavior is byte-identical to today (default step-control reproduces the current count-budget semantics + an *unbounded* time budget = never cuts on time; default run-control = no-op). Library/embedding consumers see no change unless they opt in.
- **No YAML / `SmartServerConfig` change** for the strategy seams (code strategies). The default impl MAY read a `perStepTimeoutMs` from the controller budgets config (additive, optional) — see Section 4.
- ESM `.js` imports; Biome (2-space, single quotes, semicolons).

---

## Section 2 — Per-step cancellation plumbing (signal into LLM + MCP)

Today neither inner call accepts a controller-owned signal:
- `ISubagentClient.send(messages, tools?)` (`controller/subagent-client.ts`) — no options/signal; `makeSubagentClient` calls `llm.chat(messages, tools)` (drops options).
- `ControllerHandlerDeps.callMcp(name, args)` (`controller-coordinator-handler.ts:94`) — no signal.

**Changes (additive):**
- `ISubagentClient.send(messages, tools?, options?: CallOptions)` — add optional `options`. `makeSubagentClient` passes it: `llm.chat(messages, tools, options)`. `CallOptions` carries the signal the LLM adapter honors via `withAbort`.
- `ControllerHandlerDeps.callMcp(name, args, signal?: AbortSignal)` — add optional `signal`. The controller composition wires `callMcp` to `buildMcpBridge(clients, classifier)(name, args, signal)` (the bridge already accepts a 3rd `signal` arg → `withAbort`).
- In `runStep`, the per-step `IStepBudget.signal` is passed into BOTH: `deps.executor.send(messages, offeredTools, { ...ctx.options, signal })` and `deps.callMcp(name, args, signal)`. So whichever inner op is running when the budget elapses is cancelled.
- A cancelled LLM/MCP call surfaces as an error/rejection; the handler maps a budget-cut cancellation to a `control-failure(reason='step-timeout') → replan` (Section 4), distinct from an MCP-unavailable escalate.

> The signal is the controller cancelling its OWN op — consistent with timeout ownership. MCP's own request timeout still applies independently.

---

## Section 3 — Interfaces, default impls, DI, composition

### Interfaces (`@mcp-abap-adt/llm-agent`, I-prefixed, barrel-exported)

```ts
import type { CallOptions } from './types.js';

/** Per-STEP execution control. beginStep() is called at each step entry (fresh
 *  or resume) and returns a budget handle for that step pass. */
export interface IStepExecutionControl {
  beginStep(ctx: StepControlContext): IStepBudget;
}
export interface StepControlContext {
  readonly stepName: string;
  readonly seq: number;
  readonly attempt: number;
  /** The controller's resolved budgets (maxToolCalls, etc.) so an impl can honor them. */
  readonly budgets: StepBudgetsView;
  readonly options?: CallOptions;
}
export interface StepBudgetsView {
  readonly maxToolCalls?: number;
  readonly perStepTimeoutMs?: number;
}
export interface IStepBudget {
  /** Fires when the step budget is exhausted; threaded into every inner op
   *  (executor LLM + callMcp) so whatever consumed the time is cancelled. A
   *  never-firing signal (default, no time budget) is valid. */
  readonly signal: AbortSignal;
  /** Between-round gate consulted BEFORE each executor round. false → cut. */
  shouldContinue(state: StepRoundState): StepControlDecision;
  /** Release timers/resources when the step ends (settled or cut). */
  dispose(): void;
}
export interface StepRoundState {
  readonly round: number;        // executor rounds so far this step
  readonly toolCallCount: number;
  readonly elapsedMs: number;    // since beginStep()
}
export type StepControlDecision = { continue: true } | { continue: false; reason: string };

/** Per-RUN execution control (sibling seam). Same shape; default = no-op. */
export interface IRunExecutionControl {
  beginRun(ctx: RunControlContext): IRunBudget;
}
export interface RunControlContext { readonly runId: string; readonly options?: CallOptions; }
export interface IRunBudget {
  readonly signal: AbortSignal;
  shouldContinue(state: RunState): StepControlDecision;
  dispose(): void;
}
export interface RunState { readonly stepsUsed: number; readonly elapsedMs: number; }
```

### Default implementations (`@mcp-abap-adt/llm-agent-server-libs`, swappable)

- `DefaultStepExecutionControl` — `beginStep(ctx)` returns a budget where:
  - `signal` = `AbortSignal.timeout(perStepTimeoutMs)` when `ctx.budgets.perStepTimeoutMs` is set, else a **never-firing** signal (`new AbortController().signal`, never aborted) — so with no time budget the default never cuts on time (backward-compat).
  - `shouldContinue(state)` = `{ continue:false, reason:'tool-call budget exhausted (maxToolCalls)' }` when `toolCallCount > maxToolCalls` (this ABSORBS the current handler `maxToolCalls` gate); else `{ continue:false, reason:'step-timeout' }` when `elapsedMs >= perStepTimeoutMs` (belt-and-suspenders with the signal); else `{ continue:true }`.
  - `dispose()` clears any timer.
- `NoopRunExecutionControl` — `beginRun` returns a budget with a never-firing signal and `shouldContinue → { continue:true }`. The default; the full run-budget impl is a follow-up.

### DI seam (mirror the existing factory pattern; consumer-swappable, NO YAML)
Add optional `stepExecutionControl?: IStepExecutionControl` and `runExecutionControl?: IRunExecutionControl` to the seams the CONTROLLER path reads — `IPipelineContext`, `BuildAgentDeps`, `ControllerHandlerDeps` — plus `builder.withStepExecutionControl(...)` / `withRunExecutionControl(...)`. (NOT `SmartAgentDeps` / `PipelineDeps` — the direct SmartAgent and simple pipelines have no "steps", so they do not read these.) `smart-server` populates `ctx.stepExecutionControl` / `ctx.runExecutionControl` from `BuildAgentDeps` (undefined when not injected). The controller composition resolves `ctx.stepExecutionControl ?? new DefaultStepExecutionControl()` and `ctx.runExecutionControl ?? new NoopRunExecutionControl()` — consumer override wins, else our defaults. Bare consumers who inject nothing get the defaults (byte-identical: never-firing time signal + current count semantics + no-op run).

---

## Section 4 — Interaction with existing budgets, replan, resume, fail-loud

- **`maxToolCalls` moves into `DefaultStepExecutionControl.shouldContinue`.** The handler's inline `toolCallCount > maxToolCalls` gate (~controller-coordinator-handler.ts:1265-1287) is replaced by consulting `budget.shouldContinue(state)` at the top of each executor round; a `{continue:false, reason}` triggers the SAME `writeControlFailure(reason)` + `settle('failed')` + `phase='awaiting-replan'` path as today. Other count budgets (`maxStepAttempts`, `maxEvalResumes`, `maxReviewRetries`) and REACTIVE failures (executor error, reviewer-unverifiable, unavailable-tool) stay handler-side — they depend on subagent results, not the budget. (The step control owns the *budget/time* gate; reactive outcomes remain the handler's.)
- **Cut → replan.** A budget cut (gate `false` OR the signal aborting an inner call) becomes a `control-failure → replan` with a clear reason (`step-timeout` / `maxToolCalls`). The planner revises and continues — never a silent fail. `maxSteps` / `maxRewinds` remain the terminal backstop.
- **`perStepTimeoutMs` config (additive, optional).** Add `perStepTimeoutMs?: number` to `ControllerConfig.budgets` (default UNSET = never cut on time = backward-compat). When set, `DefaultStepExecutionControl` uses it. This is the ONE additive config field (the strategy itself is code/DI). Our eval config sets a sane value (e.g. 120000 ms) to prove convergence.
- **Resume-safety.** `beginStep` is called at EACH step entry — fresh on a new step, and again on RESUME of an in-flight step. Each entry gets a FRESH budget (fresh timer/signal). This is correct: livelock is a within-one-pass concern; a suspend/resume (external-tool round-trip) is a new pass and legitimately gets its own step budget. Cumulative-across-passes bounding is the RUN control's job (sibling seam). No new durable strategy state is persisted — the budget is transient per pass (resume-safe by construction).
- **Fail-loud unchanged.** The MCP-unavailable escalate/`abortTerminal` (20.4.0) runs BEFORE any budget mapping in the `callMcp` catch; a budget-cancellation of `callMcp` is distinguished from an MCP-unavailable `McpError` (the abort surfaces as an AbortError/cancellation, not an `McpError` classified unavailable) and maps to `control-failure(step-timeout) → replan`, not a terminal abort.

---

## Section 5 — Testing

- **Livelock repro → cut→replan (the core fix).** A controller `runStep` (harness from `controller-mcp-failloud.test.ts`) with a scripted executor that never emits `content` (keeps issuing tool_calls) + `perStepTimeoutMs` small + a `DefaultStepExecutionControl`: assert the step is CUT with reason `step-timeout` (or `maxToolCalls`) and a `control-failure → awaiting-replan` is recorded — the run does NOT loop unboundedly. Discriminating: on the old handler (no step control) the loop runs to the harness's own limit; with the control it cuts.
- **Signal cancels the inner LLM call.** A scripted executor whose `send` hangs (never resolves until aborted) + a short `perStepTimeoutMs`: assert `send` receives the step `signal`, the budget fires it, the call rejects (aborted), and the handler maps it to `control-failure(step-timeout) → replan`.
- **Signal cancels the inner MCP call.** `callMcp` hangs until aborted; assert it receives the signal and the budget aborts it → `control-failure → replan` (NOT an MCP-unavailable terminal abort).
- **Count gate.** `shouldContinue` returns `{continue:false, reason:'…maxToolCalls'}` at `toolCallCount > maxToolCalls`; the handler control-fails identically to today.
- **Consumer override.** `builder.withStepExecutionControl(custom)` → the controller uses `custom`, not `DefaultStepExecutionControl`; `withRunExecutionControl(custom)` similarly. No injection → defaults.
- **Run-control no-op.** `NoopRunExecutionControl` never fires / always `continue:true` → no behavior change from it.
- **Resume gets a fresh budget.** A step that suspends (external tool) and resumes: `beginStep` is called again, the new budget's timer starts fresh (a resumed step is not instantly cut by a stale deadline).
- **Backward-compat.** No control injected + no `perStepTimeoutMs` → existing controller suites (`controller-mcp-failloud`, `controller-coordinator-handler`, migration, round-trip) byte-identical green (count semantics preserved, time signal never fires).
- **Live acceptance.** Re-run controller P2 + P4 on trial `:9001` (the two that livelocked at 900s) with `perStepTimeoutMs` set: assert both COMPLETE with a coherent answer (steps that stall are cut→replan), total wall-clock bounded, no silent `(no response)`, and P3's earlier token win preserved.

---

## File Structure

- **NEW** `packages/llm-agent/src/interfaces/step-execution-control.ts` — `IStepExecutionControl`, `IStepBudget`, `IRunExecutionControl`, `IRunBudget` + context/state/decision types; barrel export.
- **NEW** `packages/llm-agent-server-libs/src/smart-agent/controller/default-step-execution-control.ts` — `DefaultStepExecutionControl`.
- **NEW** `packages/llm-agent-server-libs/src/smart-agent/controller/noop-run-execution-control.ts` — `NoopRunExecutionControl`.
- **MODIFY** `controller/subagent-client.ts` (`send` gains `options?`; `makeSubagentClient` passes to `llm.chat`).
- **MODIFY** `controller/controller-coordinator-handler.ts` (`ControllerHandlerDeps.callMcp` gains `signal?`; runStep: `beginStep` at entry, thread `signal` into `executor.send` + `callMcp`, consult `shouldContinue` per round replacing the inline maxToolCalls gate, map cut→control-failure, `dispose()` on step end; `ControllerHandlerDeps` gains `stepExecutionControl?`/`runExecutionControl?`).
- **MODIFY** `controller/types.ts` (`ControllerConfig.budgets.perStepTimeoutMs?`).
- **MODIFY** `pipelines/controller.ts` (resolve `ctx.stepExecutionControl ?? Default`, `ctx.runExecutionControl ?? Noop`; wire `callMcp` with signal passthrough) + DI seams in `smart-server.ts` / `builder.ts` / `interfaces/pipeline-plugin.ts`.

## Architecture Principles Compliance

1. **Build ON components** — reuses `withAbort` cancellation, the existing control-failure→replan path, `buildMcpBridge(signal)`; no bespoke timeout stack.
2. **The app IS the example** — the controller composition injects the default step control; consumers swap.
3. **Around interfaces** — controller depends on `IStepExecutionControl`/`IRunExecutionControl`.
4. **ISP** — two small focused interfaces, not one grown control.
5. **Consumer variation → strategy + DI** — both controls fully swappable; consumer decides when/what/how; run-as-run vs run-as-steps vs both is the consumer's composition.
6. **No god-object growth** — new small modules; the handler's inline maxToolCalls gate moves OUT into the default control.
7. **Don't break components** — additive optional fields/params; defaults byte-identical; no YAML change (one additive optional budget field).
