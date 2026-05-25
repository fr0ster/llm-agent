# Coordinator answer-directly (#155) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-decomposable prompt under `coordinator.activation: auto` is answered directly (single self-dispatched step) instead of failing with `(no response)` / `COORDINATOR_PLAN_FAILED`.

**Architecture:** The one-shot LLM planner may return an explicit empty `steps: []` (= "no decomposition needed"); the planner no longer throws on that. `CoordinatorHandler`, after layer validation, detects an empty `planner-llm` plan and self-dispatches the original request as a single agentless `direct-1` step, streaming the answer raw. The coordinator's default dispatch becomes `hybrid` so an agentless step routes to `SelfDispatch`.

**Tech Stack:** TypeScript (ESM, strict), Biome, `node --test` via `tsx/esm`. Packages: `@mcp-abap-adt/llm-agent-libs` (coordinator + handler + builder), `@mcp-abap-adt/llm-agent-server` (YAML wiring).

Spec: `docs/superpowers/specs/2026-05-25-coordinator-answer-directly-155-design.md`

---

## File Structure

- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — split the empty-output throw (explicit `[]` = answer-directly, missing/non-array still throws); tighten the clarification union; prompt instruction.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — answer-directly short-circuit (after `validatePlan`, gated on `source === 'planner-llm'` + empty steps).
- `packages/llm-agent-libs/src/builder.ts` — default coordinator dispatch → `HybridDispatch(SubAgentDispatch, SelfDispatch(plannerLlm))`.
- `packages/llm-agent-server/src/smart-agent/smart-server.ts` — default `dispatchKind` → `'hybrid'`.

Tests:
- `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts` — extend.
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts` — new.
- `packages/llm-agent-libs/src/__tests__/builder-coordinator-dispatch-default.test.ts` — new (default dispatch = HybridDispatch).
- `packages/llm-agent-server/src/smart-agent/__tests__/coordinator-dispatch-resolver.test.ts` — new (factory contract lock).

---

## Task 1: One-shot planner — empty `steps:[]` = answer-directly (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts`
- Test: `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts`

- [ ] **Step 1: Update the existing tests + add new ones**

In `packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts`:

Edit the two existing tests' regexes (the messages change in Step 3) — these
existing cases stay valid (the `{"objective":"x"}` case still throws, now as the
missing-steps-array case):
- `throws when output has neither steps nor clarification` (input `{"objective":"x"}`):
  change its `assert.rejects` regex from `/neither steps nor a clarification/` to
  `/no steps array/`.
- `throws when output has both clarification and steps` (input
  `{"clarification":"huh?","steps":[{...}]}`): change its regex from
  `/both a clarification and steps/` to `/both a clarification and a steps array/`.

Then add two new tests inside the existing `describe('OneShotPlanning parsing', ...)`
(reuse the existing `makeCtx` / `llmReturning` helpers):

```ts
  it('returns an empty-steps plan for explicit steps:[] (answer-directly signal)', async () => {
    const llm = llmReturning('{"steps":[]}');
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.steps.length, 0);
    assert.equal(plan.clarification, undefined);
    assert.equal(plan.source, 'planner-llm');
  });

  it('returns an empty-steps plan even when an objective is present (steps:[] wins)', async () => {
    const llm = llmReturning('{"objective":"Answer directly","steps":[]}');
    const plan = await new OneShotPlanning(llm).buildInitialPlan(makeCtx());
    assert.equal(plan.steps.length, 0);
    assert.equal(plan.clarification, undefined);
    // objective may be retained here; the handler clears it for the direct
    // dispatch (see coordinator-answer-direct.test.ts) so the answer stays clean.
  });

  it('throws when clarification is combined with an empty steps array', async () => {
    const llm = llmReturning('{"clarification":"huh?","steps":[]}');
    await assert.rejects(
      () => new OneShotPlanning(llm).buildInitialPlan(makeCtx()),
      /both a clarification and a steps array/,
    );
  });
```

- [ ] **Step 2: Run the tests to verify the new/edited ones fail**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/one-shot.test.ts`
Expected: FAIL — `{"steps":[]}` currently throws (so the "returns an empty-steps plan" test fails), and the message-regex changes don't match yet.

- [ ] **Step 3: Update the validation in `one-shot.ts`**

In `buildInitialPlan`, replace the clarification block and the empty-output throw:

```ts
    if (parsed.clarification) {
      if ((parsed.steps?.length ?? 0) > 0) {
        throw new Error(
          `Planner returned both a clarification and steps (ambiguous): ${jsonText.slice(0, 200)}`,
        );
      }
      return {
        steps: [],
        clarification: parsed.clarification,
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    }

    // Without a clarification, a usable plan must carry at least one valid step.
    // An empty/malformed plan must fail loud (→ COORDINATOR_PLAN_FAILED) rather
    // than silently produce blank coordinator output.
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(
        `Planner returned neither steps nor a clarification: ${jsonText.slice(0, 200)}`,
      );
    }
```

with:

```ts
    // A clarification must stand alone. Combined with any steps array (incl. [])
    // it is ambiguous mixed output → fail loud, keeping a clean three-way union:
    // {clarification} | {steps:[...]} | {steps:[]} (answer-directly).
    if (parsed.clarification) {
      if (Array.isArray(parsed.steps)) {
        throw new Error(
          `Planner returned both a clarification and a steps array (ambiguous): ${jsonText.slice(0, 200)}`,
        );
      }
      return {
        steps: [],
        clarification: parsed.clarification,
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    }

    // A missing / non-array `steps` is malformed → fail loud
    // (→ COORDINATOR_PLAN_FAILED). An explicit empty array `steps: []` is the
    // answer-directly signal and is allowed through (the for-loop below is a
    // no-op for it, and the empty plan is returned for the handler to self-answer).
    if (!Array.isArray(parsed.steps)) {
      throw new Error(
        `Planner returned no steps array and no clarification: ${jsonText.slice(0, 200)}`,
      );
    }
```

(Leave the subsequent per-step `goal` validation `for` loop, the `steps` map, and the final `return` exactly as they are. For `steps: []` the loop is skipped, the map yields `[]`, and the plan is returned with `steps: []`.)

- [ ] **Step 4: Add the planner prompt instruction**

In the `systemPrompt` template in `buildInitialPlan`, find the line:

```
If the request is too ambiguous to plan, respond with ONLY {"clarification":"<your question>"}.
```

Insert immediately after it:

```
If the request needs no decomposition (it can be answered directly without breaking it into steps), return an empty steps array: {"steps":[]}.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/llm-agent-libs && npx tsx --test src/coordinator/planning/__tests__/one-shot.test.ts`
Expected: PASS — all tests (the empty-`[]` plan, the missing-array throw, both clarification-union throws, plus the prior parses/needsInput tests).

- [ ] **Step 6: Build + commit**

Run: `npm run build` (clean), then:

```bash
git add packages/llm-agent-libs/src/coordinator/planning/one-shot.ts packages/llm-agent-libs/src/coordinator/planning/__tests__/one-shot.test.ts
git commit -m "feat(libs): #155 one-shot planner treats explicit steps:[] as answer-directly; tighten clarification union"
```

---

## Task 2: CoordinatorHandler — answer-directly short-circuit (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { CoordinatorHandler } from '../coordinator.js';

function emptyPlanPlanning(
  source: Plan['source'],
  objective?: string,
): IPlanningStrategy {
  return {
    name: 'empty',
    buildInitialPlan: async (): Promise<Plan> => ({
      steps: [],
      objective,
      createdAt: 0,
      source,
    }),
    shouldReplan: () => false,
    rebuildPlan: async () => ({ steps: [], createdAt: 0, source }),
  };
}

function capturingDispatch(result: StepResult): {
  strategy: IDispatchStrategy;
  calls: Array<{ step: PlanStep; objective: string | undefined }>;
} {
  const calls: Array<{ step: PlanStep; objective: string | undefined }> = [];
  return {
    calls,
    strategy: {
      name: 'capture',
      dispatch: async (step: PlanStep, ctx: { plan?: Plan }) => {
        calls.push({ step, objective: ctx.plan?.objective });
        return result;
      },
    },
  };
}

function makeCtx(inputText: string) {
  const yields: Array<{
    ok: boolean;
    value: { content: string; finishReason?: string };
  }> = [];
  const ctx = {
    inputText,
    sessionId: 't',
    yield: (c: { ok: boolean; value: { content: string; finishReason?: string } }) => {
      yields.push(c);
    },
  } as unknown as Parameters<CoordinatorHandler['execute']>[0];
  return { ctx, yields };
}

describe('CoordinatorHandler answer-directly', () => {
  it('self-dispatches the original request and streams the answer raw', async () => {
    const { ctx, yields } = makeCtx('What is 17 + 25?');
    const dispatch = capturingDispatch({
      stepId: 'direct-1',
      output: '42',
      ok: true,
      durationMs: 1,
    });
    const handler = new CoordinatorHandler({
      planning: emptyPlanPlanning('planner-llm', 'Some objective'),
      dispatch: dispatch.strategy,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
      maxLayer: 1,
    });

    const ok = await handler.execute(ctx, {}, {} as never);

    assert.equal(ok, true);
    assert.equal(dispatch.calls.length, 1);
    assert.equal(dispatch.calls[0].step.id, 'direct-1');
    assert.equal(dispatch.calls[0].step.goal, 'What is 17 + 25?');
    assert.equal(dispatch.calls[0].step.status, 'pending');
    // objective is cleared for the direct dispatch → composeTask yields bare goal
    assert.equal(dispatch.calls[0].objective, undefined);
    assert.equal(yields[0].value.content, '42'); // raw, no "### direct-1"
    assert.equal(yields[1].value.finishReason, 'stop');
  });

  it('surfaces COORDINATOR_STEP_FAILED when the direct dispatch fails', async () => {
    const { ctx } = makeCtx('hi');
    const dispatch = capturingDispatch({
      stepId: 'direct-1',
      output: '',
      ok: false,
      durationMs: 1,
      error: 'no agent and no fallback',
    });
    const handler = new CoordinatorHandler({
      planning: emptyPlanPlanning('planner-llm'),
      dispatch: dispatch.strategy,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
      maxLayer: 1,
    });

    const ok = await handler.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    assert.equal((ctx as unknown as { error?: { code?: string } }).error?.code, 'COORDINATOR_STEP_FAILED');
  });

  it('does NOT answer-directly for a non-planner-llm empty plan', async () => {
    const { ctx } = makeCtx('hi');
    const dispatch = capturingDispatch({
      stepId: 'x',
      output: 'should not run',
      ok: true,
      durationMs: 1,
    });
    const handler = new CoordinatorHandler({
      planning: emptyPlanPlanning('manual'),
      dispatch: dispatch.strategy,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
      maxLayer: 1,
    });

    await handler.execute(ctx, {}, {} as never);
    assert.equal(dispatch.calls.length, 0); // manual empty plan → no direct dispatch
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts`
Expected: FAIL — with no answer-directly branch the empty `planner-llm` plan falls through the dispatch loop (no pending steps), so nothing is dispatched and no answer is yielded; `dispatch.calls.length` is 0 and `yields[0]` is undefined.

- [ ] **Step 3: Add `PlanStep` to the handler imports**

In `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`, add `PlanStep` to the existing type import from `@mcp-abap-adt/llm-agent`:

```ts
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 4: Insert the answer-directly short-circuit**

In `execute`, immediately AFTER the `validatePlan` block (the `if (validationError) { ... return false; }` that ends around the layer-violation check) and BEFORE the `ctx.options?.sessionLogger?.logStep('coordinator_plan', ...)` call, insert:

```ts
    // Answer-directly: the LLM planner returned an explicit empty step list
    // (no decomposition needed). Synthesize a single agentless step carrying the
    // original request and self-answer it instead of running an empty plan.
    // Placed AFTER validatePlan so layer rules still apply (a nested coordinator
    // at layer >= maxLayer is blocked by validatePlan before reaching here).
    // Gated on source 'planner-llm' so manual/skill-steps empty plans keep their
    // current semantics.
    if (plan.source === 'planner-llm' && plan.steps.length === 0) {
      const directStep: PlanStep = {
        id: 'direct-1',
        goal: ctx.inputText,
        status: 'pending',
      };
      // Dispatch with a context whose plan carries NO objective, so composeTask
      // yields the bare original request (a clean direct answer) instead of
      // "Task: <input>\n\nOverall objective: ...". An empty plan (no
      // decomposition) has no shared objective to align around, even if the
      // planner emitted one alongside the empty steps array.
      const directCtx: ICoordinatorContext = {
        ...coordCtx,
        plan: { ...plan, objective: undefined },
      };
      const result = await this.deps.dispatch.dispatch(directStep, directCtx);
      if (!result.ok) {
        ctx.error = new OrchestratorError(
          `coordinator: answer-directly dispatch failed: ${result.error ?? 'unknown'}`,
          'COORDINATOR_STEP_FAILED',
        );
        return false;
      }
      ctx.options?.sessionLogger?.logStep('coordinator_answer_direct', {
        outputLength: result.output.length,
      });
      ctx.yield({ ok: true, value: { content: result.output } });
      ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
      return true;
    }
```

(`OrchestratorError` is already imported in this file — it's used by the existing layer-violation and step-failed paths.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/llm-agent-libs && npx tsx --test src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Build + commit**

Run: `npm run build` (clean), then:

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-answer-direct.test.ts
git commit -m "feat(libs): #155 CoordinatorHandler self-answers an empty planner-llm plan (answer-directly)"
```

---

## Task 3: Builder default dispatch → hybrid (TDD)

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts`
- Test: `packages/llm-agent-libs/src/__tests__/builder-coordinator-dispatch-default.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/__tests__/builder-coordinator-dispatch-default.test.ts` (introspection pattern mirrors the existing `builder-context-builder-wiring.test.ts`):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { HybridDispatch } from '../coordinator/dispatch/hybrid.js';

function stubLlm(): ILlm {
  return {
    async chat(_m: unknown[], _t?: LlmTool[], _o?: CallOptions) {
      return {
        ok: true as const,
        value: { content: 'ok', toolCalls: [], finishReason: 'stop' as const },
      };
    },
    async *streamChat(
      _m: unknown[],
      _t?: LlmTool[],
      _o?: CallOptions,
    ): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

describe('SmartAgentBuilder — default coordinator dispatch', () => {
  it('defaults coordinator dispatch to HybridDispatch when not specified', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm(stubLlm())
      .withCoordinator({})
      .build();
    try {
      const pipeline = (
        handle.agent as unknown as { deps: { pipeline: unknown } }
      ).deps.pipeline;
      const coordinator = (
        pipeline as unknown as { coordinator?: { dispatch?: unknown } }
      ).coordinator;
      assert.ok(coordinator, 'expected pipeline.coordinator to be set');
      assert.ok(
        coordinator.dispatch instanceof HybridDispatch,
        'expected default coordinator dispatch to be HybridDispatch',
      );
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/llm-agent-libs && npx tsx --test src/__tests__/builder-coordinator-dispatch-default.test.ts`
Expected: FAIL — the current default is `new SubAgentDispatch(...)`, not a `HybridDispatch`.

- [ ] **Step 3: Add `HybridDispatch` and `SelfDispatch` to the imports**

Find the import block that currently brings in `OneShotPlanning` and `SubAgentDispatch` (around line 74) and add `HybridDispatch` and `SelfDispatch` to it (same `@mcp-abap-adt/llm-agent-libs` coordinator export source as `SubAgentDispatch`):

```ts
  HybridDispatch,
  OneShotPlanning,
  SelfDispatch,
  SubAgentDispatch,
```

(Keep alphabetical/existing ordering as the file uses; the key point is all four are imported from the same module `SubAgentDispatch` currently comes from.)

- [ ] **Step 4: Default the coordinator dispatch to hybrid**

In the `resolvedCoordinator` construction, replace:

```ts
        dispatch:
          this._coordinator.dispatch ??
          new SubAgentDispatch(defaultContextBuilder),
```

with:

```ts
        dispatch:
          this._coordinator.dispatch ??
          new HybridDispatch(
            new SubAgentDispatch(defaultContextBuilder),
            new SelfDispatch(plannerLlm),
          ),
```

`plannerLlm` is already resolved just above (`this._coordinator.plannerLlm ?? wrappedMainLlm`, guaranteed non-null — the builder throws otherwise). An agentless step (including the synthesized `direct-1`) now falls back to `SelfDispatch`.

- [ ] **Step 5: Build, then run the test to verify it passes**

Run: `npm run build` (clean), then:
`cd packages/llm-agent-libs && npx tsx --test src/__tests__/builder-coordinator-dispatch-default.test.ts`
Expected: PASS — default coordinator dispatch is now a `HybridDispatch`.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/__tests__/builder-coordinator-dispatch-default.test.ts
git commit -m "feat(libs): #155 default coordinator dispatch to hybrid (agentless steps self-answer)"
```

---

## Task 4: Smart-server default dispatchKind → hybrid

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/smart-server.ts`
- Test: `packages/llm-agent-server/src/smart-agent/__tests__/coordinator-dispatch-resolver.test.ts`

- [ ] **Step 1: Lock the dispatch factory the default relies on**

Create `packages/llm-agent-server/src/smart-agent/__tests__/coordinator-dispatch-resolver.test.ts` (characterization test — `resolveCoordinatorDispatch` already behaves this way; the test locks the `'hybrid'` contract that the new default selects):

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  HybridDispatch,
  SelfDispatch,
  SubAgentDispatch,
} from '@mcp-abap-adt/llm-agent-libs';
import { resolveCoordinatorDispatch } from '../config.js';

const fakeLlm = {} as unknown as ILlm;

describe('resolveCoordinatorDispatch', () => {
  it('builds a HybridDispatch (subagent + self fallback) for "hybrid"', () => {
    assert.ok(resolveCoordinatorDispatch('hybrid', fakeLlm) instanceof HybridDispatch);
  });

  it('builds a SubAgentDispatch for "subagent"', () => {
    assert.ok(resolveCoordinatorDispatch('subagent') instanceof SubAgentDispatch);
  });

  it('builds a SelfDispatch for "self"', () => {
    assert.ok(resolveCoordinatorDispatch('self', fakeLlm) instanceof SelfDispatch);
  });

  it('throws for "hybrid" without an LLM', () => {
    assert.throws(
      () => resolveCoordinatorDispatch('hybrid'),
      /requires a planner or main LLM/,
    );
  });
});
```

Run: `cd packages/llm-agent-server && npx tsx --test src/smart-agent/__tests__/coordinator-dispatch-resolver.test.ts`
Expected: PASS — 4 tests (the factory already builds these; this locks the contract).

- [ ] **Step 2: Default `dispatchKind` to `'hybrid'` for all planning kinds**

Replace:

```ts
      const planningKind = coordCfg.planning ?? 'one-shot';
      const dispatchKind =
        coordCfg.dispatch ??
        (planningKind === 'skill-steps' ? 'hybrid' : 'subagent');
```

with:

```ts
      const planningKind = coordCfg.planning ?? 'one-shot';
      // Default to 'hybrid' for all planning kinds: agentless steps — including
      // the synthesized answer-directly step (#155) and skill steps without an
      // explicit `agent:` — need a self-LLM fallback. Pin `dispatch: subagent`
      // explicitly for strict subagent-only routing.
      const dispatchKind = coordCfg.dispatch ?? 'hybrid';
```

(`resolveCoordinatorDispatch('hybrid', plannerLlm, contextBuilder)` already builds `HybridDispatch(SubAgentDispatch, SelfDispatch(plannerLlm))` — `plannerLlm` is passed at the existing call site and is required by the `'hybrid'` branch.)

- [ ] **Step 3: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/smart-server.ts packages/llm-agent-server/src/smart-agent/__tests__/coordinator-dispatch-resolver.test.ts
git commit -m "feat(server): #155 default coordinator dispatchKind to hybrid (was subagent)"
```

---

## Task 5: Full gate + lint + smoke

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: all packages compile.

- [ ] **Step 2: Lint check**

Run: `npm run lint:check`
Expected: no errors. (If Biome flags formatting on touched files, run `npm run lint` and amend the relevant commit.)

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: 0 failures across workspaces; `llm-agent-libs` green (existing 385 + the new answer-direct tests + the extended one-shot tests).

- [ ] **Step 4: Manual smoke against the #155 repro (optional, needs a running LLM)**

With a `smart-server.yaml` carrying a `summarizer` subagent + `coordinator: {planning: one-shot, activation: auto, plannerLlm: main}` (note: `dispatch` omitted → now defaults to `hybrid`), send:

```
What is 17 + 25?
```

Expected: a direct answer ("42"), not `(no response)`. A real multi-step task (e.g. "summarize this: ...") still plans and dispatches normally; an ambiguous request returns a clarification.

- [ ] **Step 5: Final commit (only if lint produced changes)**

```bash
git add -A
git commit -m "chore(libs): #155 lint/format pass"
```

---

## Notes for the implementer

- `npx tsx --test <file>` runs a single suite fast during TDD; `npm test` runs the whole workspace.
- Type-only imports from `@mcp-abap-adt/llm-agent` are erased at runtime, so the libs tests run without rebuilding the interfaces package first. `npm run build` (Task steps + Task 5) is what type-checks end to end.
- Do NOT add a new `selfDispatch` dependency or touch `ICoordinatorConfig` — the fix routes the direct step through the configured dispatch, which now defaults to `hybrid` (so it self-answers). This was a deliberate design decision (see spec §3).
- Do NOT treat unparseable/non-JSON planner output as answer-directly — only an explicit parsed `steps: []` triggers it (spec boundary). Missing/non-array `steps` still throws.
- `replan-on-error.ts` is intentionally NOT changed — answer-directly is initial-planning only.
