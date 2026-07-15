# Controller Step/Run Execution Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the controller a consumer-swappable per-step execution control (wall-clock budget cancelling the whole step — LLM or MCP — plus a prospective count gate → cut→replan), and a sibling run-level control seam, to fix the executor livelock.

**Architecture:** Two ISP interfaces (`IStepExecutionControl` + `IRunExecutionControl`) in `@mcp-abap-adt/llm-agent`; default impls in `llm-agent-server-libs`; the controller composition injects them (consumer-swappable). A per-step `AbortSignal` is threaded into `executor.send` (LLM) and `callMcp`→`buildMcpBridge` (MCP) via the existing `CallOptions.signal`/`withAbort` cancellation seam.

**Tech Stack:** TypeScript (ESM `.js`), `node:test` + `tsx`, Biome, Node ≥22.

**Design spec:** `docs/superpowers/specs/2026-07-14-controller-step-run-execution-control-design.md` (authoritative — read it).

## Global Constraints

- Interfaces + DI + strategies; consumer swaps any impl. Defaults are OUR examples only. NO pipeline-group split.
- ISP: two focused interfaces (step + run), independent seams. Consumer composes run-as-run / run-as-steps / both / neither.
- Timeout ownership: a per-step timeout cancels the CONTROLLER's OWN op via `withAbort(signal)` — NOT imposing a timeout on MCP (MCP self-governs its `callTool` timeout #222). No forbidden implicit-SDK-timeout stack.
- Fail-loud preserved: a budget cut = `control-failure → replan` (typed reason), never silent. 20.4.0 MCP-unavailable escalate/abortTerminal unchanged, fires before budget handling.
- Backward-compat: no control injected + no `perStepTimeoutMs` → byte-identical (time signal never fires; count semantics preserved; run control no-op). Existing controller suites green.
- NO YAML/`SmartServerConfig` change (one additive optional `budgets.perStepTimeoutMs`).
- `CallOptions` (`packages/llm-agent/src/interfaces/types.ts:25`) already has `signal?: AbortSignal`.
- ESM `.js` imports; Biome (2-space, single quotes, semicolons). Run one test: `node --import tsx/esm --test --test-reporter=spec <path>`. Build: `npm run build`.

---

### Task 1: Interfaces + types (`@mcp-abap-adt/llm-agent`)

**Files:**
- Create: `packages/llm-agent/src/interfaces/step-execution-control.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (barrel)
- Test: `packages/llm-agent/src/__tests__/step-execution-control.types.test.ts`

**Interfaces (Produces):** `IStepExecutionControl`, `IStepBudget`, `IRunExecutionControl`, `IRunBudget`, `StepControlContext`, `StepBudgetsView`, `StepRoundState`, `StepControlDecision`, `RunControlContext`, `RunState`.

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IStepBudget,
  IStepExecutionControl,
  StepControlDecision,
} from '@mcp-abap-adt/llm-agent';

test('IStepExecutionControl / IStepBudget shape compiles', () => {
  const ctrl = new AbortController();
  const budget: IStepBudget = {
    signal: ctrl.signal,
    shouldContinueRound: () => ({ continue: true }),
    canExecuteTool: (s) =>
      s.toolCallCount + 1 > 3
        ? { continue: false, reason: 'maxToolCalls' }
        : { continue: true },
    dispose: () => {},
  };
  const control: IStepExecutionControl = { beginStep: () => budget };
  const d: StepControlDecision = budget.canExecuteTool({ round: 0, toolCallCount: 3, elapsedMs: 0 });
  assert.equal(d.continue, false);
  assert.equal(typeof control.beginStep, 'function');
});
```

- [ ] **Step 2: Run → FAIL** (module not exported).

- [ ] **Step 3: Create the interface file** (verbatim from spec "Section 3 — Interfaces"):

```ts
import type { CallOptions } from './types.js';

export interface IStepExecutionControl {
  beginStep(ctx: StepControlContext): IStepBudget;
}
export interface StepControlContext {
  readonly stepName: string;
  readonly seq: number;
  readonly attempt: number;
  readonly budgets: StepBudgetsView;
  readonly options?: CallOptions;
}
export interface StepBudgetsView {
  readonly maxToolCalls?: number;
  readonly perStepTimeoutMs?: number;
}
export interface IStepBudget {
  readonly signal: AbortSignal;
  shouldContinueRound(state: StepRoundState): StepControlDecision;
  canExecuteTool(state: StepRoundState): StepControlDecision;
  dispose(): void;
}
export interface StepRoundState {
  readonly round: number;
  readonly toolCallCount: number;
  readonly elapsedMs: number;
}
export type StepControlDecision =
  | { continue: true }
  | { continue: false; reason: string };

export interface IRunExecutionControl {
  beginRun(ctx: RunControlContext): IRunBudget;
}
export interface RunControlContext {
  readonly runId: string;
  readonly options?: CallOptions;
}
export interface IRunBudget {
  readonly signal: AbortSignal;
  shouldContinue(state: RunState): StepControlDecision;
  dispose(): void;
}
export interface RunState {
  readonly stepsUsed: number;
  readonly elapsedMs: number;
}
```

- [ ] **Step 4: Barrel** — in `packages/llm-agent/src/interfaces/index.ts`, after the `step-execution-control` alphabetical slot (near `task-spec.js`), add:

```ts
export type {
  IRunBudget,
  IRunExecutionControl,
  IStepBudget,
  IStepExecutionControl,
  RunControlContext,
  RunState,
  StepBudgetsView,
  StepControlContext,
  StepControlDecision,
  StepRoundState,
} from './step-execution-control.js';
```

- [ ] **Step 5: Build (`npm run build`) + test → PASS.**
- [ ] **Step 6: Commit** — `feat(llm-agent): IStepExecutionControl + IRunExecutionControl interfaces`.

---

### Task 2: `DefaultStepExecutionControl`

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/default-step-execution-control.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/default-step-execution-control.test.ts`

**Interfaces:**
- Consumes: `IStepExecutionControl`, `IStepBudget`, `StepControlContext`, `StepRoundState` (Task 1, from `@mcp-abap-adt/llm-agent`).
- Produces: `class DefaultStepExecutionControl implements IStepExecutionControl`.

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultStepExecutionControl } from '../default-step-execution-control.js';

const ctx = (maxToolCalls?: number, perStepTimeoutMs?: number) => ({
  stepName: 's1', seq: 0, attempt: 0, budgets: { maxToolCalls, perStepTimeoutMs },
});

test('canExecuteTool: prospective +1 count', () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3));
  assert.deepEqual(b.canExecuteTool({ round: 0, toolCallCount: 2, elapsedMs: 0 }), { continue: true });
  assert.deepEqual(b.canExecuteTool({ round: 0, toolCallCount: 3, elapsedMs: 0 }), { continue: false, reason: 'maxToolCalls' });
  b.dispose();
});

test('shouldContinueRound: time only, no count cut at ==max', () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3));
  // at exactly max, a round may still finish with content → NOT cut
  assert.deepEqual(b.shouldContinueRound({ round: 5, toolCallCount: 3, elapsedMs: 0 }), { continue: true });
  b.dispose();
});

test('time budget: shouldContinueRound cuts after elapsed >= perStepTimeoutMs; signal fires', async () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3, 20));
  assert.deepEqual(b.shouldContinueRound({ round: 0, toolCallCount: 0, elapsedMs: 25 }), { continue: false, reason: 'step-timeout' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.signal.aborted, true);
  b.dispose();
});

test('no perStepTimeoutMs → never-firing signal, round never time-cut', async () => {
  const b = new DefaultStepExecutionControl().beginStep(ctx(3));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(b.signal.aborted, false);
  assert.deepEqual(b.shouldContinueRound({ round: 100, toolCallCount: 0, elapsedMs: 10_000 }), { continue: true });
  b.dispose();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**

```ts
import type {
  IStepBudget,
  IStepExecutionControl,
  StepControlContext,
  StepControlDecision,
  StepRoundState,
} from '@mcp-abap-adt/llm-agent';

/** OUR example step control: wall-clock time budget + prospective maxToolCalls.
 *  Consumer-swappable. */
export class DefaultStepExecutionControl implements IStepExecutionControl {
  beginStep(ctx: StepControlContext): IStepBudget {
    const { maxToolCalls, perStepTimeoutMs } = ctx.budgets;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (perStepTimeoutMs != null && perStepTimeoutMs > 0) {
      timer = setTimeout(
        () => controller.abort(new DOMException('step-timeout', 'TimeoutError')),
        perStepTimeoutMs,
      );
    }
    const timedOut = (s: StepRoundState): boolean =>
      perStepTimeoutMs != null && perStepTimeoutMs > 0 && s.elapsedMs >= perStepTimeoutMs;
    return {
      signal: controller.signal,
      shouldContinueRound(s: StepRoundState): StepControlDecision {
        return timedOut(s) ? { continue: false, reason: 'step-timeout' } : { continue: true };
      },
      canExecuteTool(s: StepRoundState): StepControlDecision {
        if (maxToolCalls != null && s.toolCallCount + 1 > maxToolCalls) {
          return { continue: false, reason: 'maxToolCalls' };
        }
        return timedOut(s) ? { continue: false, reason: 'step-timeout' } : { continue: true };
      },
      dispose(): void {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  }
}
```

- [ ] **Step 4: Build + test → PASS.**
- [ ] **Step 5: Commit** — `feat(controller): DefaultStepExecutionControl (time budget + prospective maxToolCalls)`.

---

### Task 3: `NoopRunExecutionControl`

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/controller/noop-run-execution-control.ts`
- Test: `.../__tests__/noop-run-execution-control.test.ts`

**Interfaces:**
- Produces: `class NoopRunExecutionControl implements IRunExecutionControl`.

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoopRunExecutionControl } from '../noop-run-execution-control.js';

test('noop run control never fires, always continue', async () => {
  const b = new NoopRunExecutionControl().beginRun({ runId: 'r1' });
  assert.deepEqual(b.shouldContinue({ stepsUsed: 999, elapsedMs: 10_000_000 }), { continue: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.signal.aborted, false);
  b.dispose();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**

```ts
import type {
  IRunBudget,
  IRunExecutionControl,
  RunControlContext,
  StepControlDecision,
} from '@mcp-abap-adt/llm-agent';

/** Default run control: no-op (never fires, always continue). Full run-budget impl is a follow-up. */
export class NoopRunExecutionControl implements IRunExecutionControl {
  beginRun(_ctx: RunControlContext): IRunBudget {
    const controller = new AbortController(); // never aborted
    return {
      signal: controller.signal,
      shouldContinue(): StepControlDecision {
        return { continue: true };
      },
      dispose(): void {},
    };
  }
}
```

- [ ] **Step 4: Build + test → PASS.**
- [ ] **Step 5: Commit** — `feat(controller): NoopRunExecutionControl (default no-op run seam)`.

---

### Task 4: `ISubagentClient.send` gains `options` (thread signal to LLM)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/subagent-client.ts`
- Test: `.../__tests__/subagent-client-signal.test.ts`

**Interfaces:**
- Produces: `ISubagentClient.send(messages, tools?, options?: CallOptions): Promise<SubagentResult>`; `makeSubagentClient` passes `options` to `llm.chat(messages, tools, options)`.

- [ ] **Step 1: Failing test:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallOptions, ILlm } from '@mcp-abap-adt/llm-agent';
import { makeSubagentClient } from '../subagent-client.js';

test('makeSubagentClient forwards options (signal) to llm.chat', async () => {
  let seen: CallOptions | undefined;
  const llm = {
    model: 'm',
    chat: async (_m: unknown, _t: unknown, opts?: CallOptions) => {
      seen = opts;
      return { ok: true, value: { content: 'ok', toolCalls: [] } };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
  const ctrl = new AbortController();
  await makeSubagentClient(llm).send([], [], { signal: ctrl.signal });
  assert.equal(seen?.signal, ctrl.signal);
});
```

- [ ] **Step 2: Run → FAIL** (send drops options).

- [ ] **Step 3: Implement** — change the interface + impl in `subagent-client.ts`:

```ts
import type { CallOptions, ILlm, LlmTool, Message } from '@mcp-abap-adt/llm-agent';
import type { SubagentResult } from './types.js';

export interface ISubagentClient {
  send(messages: Message[], tools?: LlmTool[], options?: CallOptions): Promise<SubagentResult>;
}

export function makeSubagentClient(llm: ILlm): ISubagentClient {
  return {
    async send(messages, tools, options) {
      const r = await llm.chat(messages, tools, options);
      // ...unchanged mapping (kind:'error' / 'tool_call' / 'content')...
    },
  };
}
```
(Keep the existing result-mapping body verbatim; only the signature + the `llm.chat` call gain `options`.)

- [ ] **Step 4: Build + test → PASS. Existing controller suites still green** (options is optional — no caller breaks).
- [ ] **Step 5: Commit** — `feat(controller): ISubagentClient.send accepts CallOptions (threads signal to llm.chat)`.

---

### Task 5: `buildMcpBridge` uses the signal (thread signal to MCP)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`buildMcpBridge`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/mcp-bridge-signal.test.ts`

**Interfaces:**
- Consumes: `IMcpClient.listTools(options?)` / `callTool(name, args, options?)` (both accept `CallOptions`).
- Produces: `buildMcpBridge(...)(name, args, signal)` passes `{ signal }` into `listTools` and `callTool`.

- [ ] **Step 1: Failing test** — a fake client records the options it receives:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge } from '../smart-server.js';

test('buildMcpBridge forwards the signal into listTools + callTool', async () => {
  const seen: { list?: AbortSignal; call?: AbortSignal } = {};
  const client = {
    listTools: async (opts?: { signal?: AbortSignal }) => { seen.list = opts?.signal; return { ok: true, value: [{ name: 'T', description: '', inputSchema: {} }] }; },
    callTool: async (_n: string, _a: unknown, opts?: { signal?: AbortSignal }) => { seen.call = opts?.signal; return { ok: true, value: { content: 'r' } }; },
  } as unknown as IMcpClient;
  const ctrl = new AbortController();
  await buildMcpBridge([client])('T', {}, ctrl.signal);
  assert.equal(seen.list, ctrl.signal);
  assert.equal(seen.call, ctrl.signal);
});
```

- [ ] **Step 2: Run → FAIL** (bridge ignores `_signal`).

- [ ] **Step 3: Implement** — in `buildMcpBridge` (`smart-server.ts`), rename `_signal` → `signal`, build `const opts = signal ? { signal } : undefined;`, and pass `opts` into both `client.listTools(opts)` and `client.callTool(name, safeArgs, opts)`. Nothing else changes (classifier / throw-contract unchanged).

- [ ] **Step 4: Build + test → PASS. Existing `mcp-bridge-failloud` + controller suites green** (signal optional).
- [ ] **Step 5: Commit** — `fix(mcp): buildMcpBridge threads the AbortSignal into listTools/callTool (cancellation)`.

---

### Task 6: `ControlFailure.reason` widen + `perStepTimeoutMs` config

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`
- Test: covered by Tasks 2/7 (type-only; build check).

**Interfaces:**
- Produces: `ControlFailure.reason: 'maxToolCalls' | 'step-timeout'`; `ControllerConfig.budgets.perStepTimeoutMs?: number`.

- [ ] **Step 1: Edit `types.ts`** — change `ControlFailure.reason` (line ~88) from `'maxToolCalls'` to `'maxToolCalls' | 'step-timeout'`. Add `perStepTimeoutMs?: number;` to the `ControllerConfig.budgets` shape (near `maxToolCalls?`). Both additive/optional.
- [ ] **Step 2: Build (whole workspace) → green.**
- [ ] **Step 3: Commit** — `feat(controller): ControlFailure.reason += step-timeout; budgets.perStepTimeoutMs?`.

---

### Task 7: Controller `runStep` integration (budget lifecycle, gates, abort mapping)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
- Test: `.../__tests__/controller-step-control.test.ts`

**Interfaces:**
- Consumes: `IStepExecutionControl` (via `ControllerHandlerDeps.stepExecutionControl?`), `DefaultStepExecutionControl`, `ISubagentClient.send(+options)` (Task 4), `callMcp(+signal)` (below).
- Produces: `ControllerHandlerDeps.callMcp(name, args, signal?)`; `ControllerHandlerDeps.stepExecutionControl?`/`runExecutionControl?`; runStep consults the budget.

Verified coordinates: `executor.send` @1124; external cap (prospective) @1283; internal cap (post-increment) @1342-1348; `callMcp` @1371 (already inside a try/catch from 20.4.0). `CallOptions.signal?` exists.

- [ ] **Step 1: Failing tests** (harness from `controller-mcp-failloud.test.ts`), a `DefaultStepExecutionControl` in deps:
  - (a) **Livelock cut:** scripted executor that never returns `content` (always `tool_call`) + `perStepTimeoutMs` small + `callMcp` returns quickly → assert the step is cut with a `control-failure` (reason `step-timeout` or `maxToolCalls`) and `awaiting-replan`, NOT an unbounded loop.
  - (b) **Signal aborts a hanging LLM (reject path):** `executor.send` returns a Promise that rejects only when its `options.signal` aborts + short `perStepTimeoutMs` → assert the run maps it to `control-failure('step-timeout')`, not the executor-error retry.
  - (c) **Signal aborts a hanging MCP:** `callMcp` rejects when its `signal` aborts + short timeout → `control-failure('step-timeout')`, NOT an MCP-unavailable terminal abort.
  - (d) **Count gate `+1`:** `maxToolCalls=2`, executor issues a 3rd tool call → cut `maxToolCalls`; a step that reaches exactly 2 then returns `content` SETTLES (not cut).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**
  - `ControllerHandlerDeps`: add `callMcp(name, args, signal?: AbortSignal)`, `stepExecutionControl?: IStepExecutionControl`, `runExecutionControl?: IRunExecutionControl`.
  - At step entry (where `maxToolCalls` is resolved ~878): create the budget — `const stepControl = deps.stepExecutionControl ?? new DefaultStepExecutionControl();` `const budget = stepControl.beginStep({ stepName: step.name, seq: inFlight?.seq ?? 0, attempt: inFlight?.attempt ?? 0, budgets: { maxToolCalls: cfg.maxToolCalls ?? 10, perStepTimeoutMs: cfg.perStepTimeoutMs } });` `const stepStartedAt = Date.now();` Ensure `budget.dispose()` is called on EVERY exit from the step (settle/cut/abort/return) — wrap the loop body in `try { … } finally { budget.dispose(); }`.
  - **Merged cancellation signal.** Do NOT overwrite `ctx.options.signal` — MERGE the caller's request/cancel signal with the step budget so an inner call is cancelled by EITHER: `const callSignal = ctx.options?.signal ? AbortSignal.any([ctx.options.signal, budget.signal]) : budget.signal;` (Node ≥22 has `AbortSignal.any`). Pass `callSignal` into both `executor.send` and `callMcp`. The step-timeout DISCRIMINATOR remains `budget.signal.aborted` specifically (a caller-cancel aborts `callSignal` but NOT `budget.signal`, so it is not mis-mapped to `step-timeout`).
  - **Typed reason vs human note (backward-compat).** A `StepControlDecision.reason` is a short code (`'maxToolCalls'` / `'step-timeout'`). The durable `ControlFailure.reason` takes the CODE (typed), but the existing `writeControlFailure(note)` + `plannerPrivate` write HUMAN text. Map it, preserving today's wording:
    `const noteFor = (r: string) => r === 'maxToolCalls' ? 'tool-call budget exhausted (maxToolCalls)' : r === 'step-timeout' ? 'step time budget exhausted (step-timeout)' : r;`
    Everywhere below, call `writeControlFailure(noteFor(reason))` + `plannerPrivate += … noteFor(reason)`, and set `inFlight.controlFailure = { reason: <code>, seq }` for the typed durable value (existing `'maxToolCalls'` note text unchanged).
  - Helper `const state = () => ({ round, toolCallCount: inFlight?.toolCallCount ?? 0, elapsedMs: Date.now() - stepStartedAt });` (track a local `round` counter incremented per loop iteration).
  - **Before each `executor.send` (top of round):** `const r = budget.shouldContinueRound(state()); if (!r.continue) { …writeControlFailure(noteFor(r.reason)) + controlFailure.reason=r.reason + settle('failed') + awaiting-replan… return settle('failed'); }`.
  - **executor.send with signal + abort mapping (BOTH shapes):** `let res; try { res = await deps.executor.send(messages, offeredTools, { ...ctx.options, signal: callSignal }); } catch (e) { if (budget.signal.aborted) { …writeControlFailure(noteFor('step-timeout')) + settle('failed')… return settle('failed'); } throw e; }` — then AFTER the return, `if (budget.signal.aborted) { …control-failure step-timeout… return settle('failed'); }` BEFORE the existing `res.kind==='error'` retry branch.
  - **Replace the external cap (@1283)** `if (inFlight && inFlight.toolCallCount + 1 > maxToolCalls)` with `const g = budget.canExecuteTool(state()); if (!g.continue) { …writeControlFailure(noteFor(g.reason)) + controlFailure.reason=g.reason… return settle('failed'); }` — consulted BEFORE the increment.
  - **Replace the internal cap (@1342-1348)** post-increment check: consult `budget.canExecuteTool(state())` BEFORE the `inFlight.toolCallCount += 1` increment; on `!continue` → `writeControlFailure(noteFor(g.reason))` + typed reason. (The increment happens only after `canExecuteTool` allows the call — matching the spec's before-increment model.)
  - **callMcp with signal:** `result = await deps.callMcp(name, args, callSignal);` — the existing catch already handles `McpError` (20.4.0). ADD, at the TOP of that catch: `if (budget.signal.aborted) { …writeControlFailure(noteFor('step-timeout')) + settle('failed')… return settle('failed'); }` BEFORE the `McpError instanceof` escalate — so a step-timeout cancellation is NOT treated as MCP-unavailable.

- [ ] **Step 4: Run tests → PASS. Existing controller suites (`controller-mcp-failloud`, `controller-coordinator-handler`, `controller-context-strategy`, migration, round-trip) green** (no control injected/no `perStepTimeoutMs` → time never fires, count `+1` semantics preserved).
- [ ] **Step 5: Commit** — `feat(controller): per-step execution control in runStep (budget lifecycle, two-mode gates, abort→control-failure)`.

---

### Task 8: DI seams + controller composition

**Files:**
- Modify: `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (`IPipelineContext.stepExecutionControl?`/`runExecutionControl?`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`BuildAgentDeps` fields + `buildServerCtx` population)
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts` (resolve defaults + wire `callMcp` signal passthrough)
- Modify: `packages/llm-agent-server-libs/src/factories/controller-factory.ts` (thread the two controls into the handler deps)
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/controller-step-control-wiring.test.ts`

**Interfaces:**
- Consumes: `IStepExecutionControl`/`IRunExecutionControl` (Task 1), `DefaultStepExecutionControl` (Task 2), `NoopRunExecutionControl` (Task 3).
- Produces: `ctx.stepExecutionControl`/`ctx.runExecutionControl` populated from `BuildAgentDeps`; controller uses `ctx.stepExecutionControl ?? new DefaultStepExecutionControl()`, `ctx.runExecutionControl ?? new NoopRunExecutionControl()`.

> **Programmatic seam = `BuildAgentDeps` (via `new SmartServer(cfg, deps)` / `buildAgent(deps)`), NOT a `SmartAgentBuilder` fluent method.** The controller reads these controls from `ctx` (populated by smart-server from `BuildAgentDeps`) — the same channel the controller reads `toolLoopContextStrategyFactory`. Do NOT add `withStepExecutionControl` to `SmartAgentBuilder`/`builder.ts`: the spec keeps these OFF `SmartAgentDeps`/`PipelineDeps` (the direct SmartAgent / simple pipelines have no steps), so a builder fluent method would have no deps slot to thread into (no-op / wrong-deps). These are shared stateless INSTANCES (not factories) — `beginStep`/`beginRun` produce the per-step/per-run state.

- [ ] **Step 1: Failing tests:**
  - (a) Programmatic injection — `new SmartServer(cfg, { stepExecutionControl: custom, runExecutionControl: customRun })` → the resolved pipeline ctx carries `custom`/`customRun` (assert `ctx.stepExecutionControl === custom`).
  - (b) Controller composition (mirror `controller-context-wiring.test.ts`): no injection → the handler receives a `DefaultStepExecutionControl` / `NoopRunExecutionControl` instance; injection → the consumer's instances. And the `callMcp` passed to the handler forwards the signal to `buildMcpBridge`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement:**
  - Add `stepExecutionControl?: IStepExecutionControl` + `runExecutionControl?: IRunExecutionControl` to `IPipelineContext` (pipeline-plugin.ts) and `BuildAgentDeps` (smart-server.ts). `smart-server` stores them from `BuildAgentDeps` and populates `ctx.stepExecutionControl`/`ctx.runExecutionControl` (via the same `buildServerCtx`/`createServerPipelineContext` conditional-spread the `toolLoopContextStrategyFactory` uses; undefined when not injected). **No `builder.ts` change.**
  - `controller.ts` `build()`: pass to `ControllerFactoryDeps` (→ handler): `stepExecutionControl: ctx.stepExecutionControl ?? new DefaultStepExecutionControl()`, `runExecutionControl: ctx.runExecutionControl ?? new NoopRunExecutionControl()`; and change the `callMcp` wire to forward the signal: `callMcp: (name, args, signal) => mcpBridge(name, args, signal)` (mcpBridge already takes signal after Task 5). Import the two default impls.
  - `controller-factory.ts`: thread `stepExecutionControl?`/`runExecutionControl?` from `ControllerFactoryDeps` into the handler deps (mirror the `toolLoopContextStrategyFactory` threading already there).

- [ ] **Step 4: Run tests → PASS. Whole-workspace build + controller/pipelines suites green.**
- [ ] **Step 5: Commit** — `feat(di): thread IStepExecutionControl/IRunExecutionControl; controller injects Default/Noop`.

---

### Task 9: Live acceptance (P2/P4 converge on trial :9001)

**Files:** none (verification only, no commit).

- [ ] **Step 1:** `npm run build`. Ensure mcp-abap-adt is up on `:9001` (relaunch if needed: `mcp-abap-adt --transport=streamable-http --host=127.0.0.1 --port=9001 --path=/mcp/stream/http --env=trial --system-type=cloud`).
- [ ] **Step 2:** In the controller eval config (`.run/eval/controller9001.yaml`), set `pipeline.config.budgets.perStepTimeoutMs` to a sane value (e.g. `120000`). Re-run P2 + P4 (the two that livelocked at 900s) via the `.run/eval/run.sh` pattern against `:9001`.
- [ ] **Step 3:** Assert: both P2 and P4 COMPLETE with a coherent answer (a stalled step is cut→replan, not hung), total wall-clock bounded (well under 900s), no silent `(no response)`, no HTTP `000`. Confirm P3's earlier ~134k token win is preserved. Aggregate executor tokens to confirm per-round context stays bounded.
- [ ] **Step 4:** Record before/after (livelock→converged) in the PR description.

---

## Notes for the implementer

- Grep the existing `toolLoopContextStrategyFactory` DI threading as the template for Task 8's `BuildAgentDeps → ctx → controller` channel (sites: pipeline-plugin.ts `IPipelineContext`, smart-server.ts `BuildAgentDeps`/`buildServerCtx`, controller-factory.ts, controller.ts). Do NOT touch `builder.ts`/`SmartAgentDeps` — these controls are controller-only (no builder fluent method).
- Task 7 is the risky one: keep the 20.4.0 fail-loud order (MCP-unavailable escalate stays; only ADD the `budget.signal.aborted` step-timeout branch AHEAD of it in the catch). The `budget.dispose()` must run on every step exit (`try/finally`).
- After every task: `npm run build` (whole workspace), `npm run format`, scoped Biome lint (exit 0), commit only that task's files.
