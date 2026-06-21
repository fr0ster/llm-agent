# Controller Planner — Phase 3: Capability-Tuned Planners (clean break) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `planner: incremental | adaptive` config enum with two **preset-encoded** capability-tuned planners — `smart-executor` (coarse, plan-first; the new default `controller` preset) and `weak-executor` (fine-grained steps; the new `controller-weak` preset) — selected by the pipeline composition code, never by a user YAML toggle.

**Architecture:** §C of the controller-planner design (`docs/superpowers/specs/2026-06-14-controller-planner-design.md`). The plan-first engine shipped in Phase 2 (the `AdaptivePlanner`: create full plan → emit steps → replan on failure, against the live digest board) becomes the **`SmartExecutorPlanner`** (coarse steps; the executor self-expands a coarse step in its tool-loop). A **`WeakExecutorPlanner`** subclass reuses the same engine but overrides the create-plan/replan system prompts to demand the **finest grain** (exactly one concrete action per step; never bundle actions) — for weaker executor models that cannot be trusted with multi-action steps. The legacy per-step `IncrementalPlanner` and the `planner:` config field are removed **fail-loud** (matching the v19 `coordinator:` clean-break precedent — no silent alias). Capability is a property of the **preset**: `controller` wires `smart-executor`, the new `controller-weak` wires `weak-executor`; the kind flows preset → factory → handler. Deferred expansion (§D) — the discovery fan-out that makes `weak-executor` structurally different — is **Phase 4**; in Phase 3 the two planners differ only by prompt granularity.

**Tech Stack:** TypeScript (ESM, strict), Node ≥22 `node:test` (co-located `__tests__/*.test.ts`, run via `npm run -w @mcp-abap-adt/llm-agent-server-libs test`), Biome lint/format. Package: `@mcp-abap-adt/llm-agent-server-libs`. Plus repo-root `pipelines/*.yaml` + `docs/PIPELINES.md`.

**Out of scope (Phase 4 / deferred — do NOT implement here):** §D deferred expansion (discovery `DiscoveryDigest`, `expand`/`page` plan-decisions, `settle-envelope`, `expanding`/`expanded` board states, `chain-outcome`, windowed fan-out, tool-pagination). The `weak-executor` planner ships in Phase 3 as plan-first-with-fine-grained-prompt only; Phase 4 adds the deferred-expansion control flow to it. Also deferred: `declaredCapability` validation (the shipped presets are executor-pinned, so no such field yet — §C "weak guarantee").

---

## File Structure

| File | Phase-3 responsibility |
|------|------------------------|
| `src/smart-agent/controller/types.ts` | `PlannerKind = 'smart-executor' \| 'weak-executor'`; REMOVE `ControllerConfig.planner`; ADD `plannerKind?: PlannerKind` to `ControllerHandlerDeps`. |
| `src/smart-agent/controller/planner.ts` | DELETE `IncrementalPlanner`; rename `AdaptivePlanner` → `SmartExecutorPlanner`; ADD `WeakExecutorPlanner` (subclass; fine-grained prompts); `makePlanner` → `makeControllerPlanner(kind, ...)`. |
| `src/smart-agent/controller/controller-coordinator-handler.ts` | Call `makeControllerPlanner(deps.plannerKind ?? 'smart-executor', ...)` (drop `deps.config.planner`). |
| `src/factories/controller-factory.ts` | `build(config, deps, plannerKind = 'smart-executor')`; thread `plannerKind` into the handler deps. |
| `src/pipelines/controller.ts` | `ControllerPipelinePlugin` parameterized by `(name, plannerKind)`; `parseConfig` REJECTS a `planner:` key fail-loud; pass `plannerKind` to the factory. |
| `src/smart-agent/smart-server.ts` | Register BOTH `controller` (smart) and `controller-weak` (weak) built-ins. |
| `src/smart-agent/config.ts` | Update the built-in pipeline-name diagnostic to list `controller` / `controller-weak`. |
| `src/pipelines/__tests__/conformance.test.ts` | Add `controller-weak` to the built-in conformance set. |
| `pipelines/controller.yaml`, `pipelines/controller-mixed.yaml` | Remove the `planner:` line; `controller-mixed` → `name: controller-weak`. |
| `docs/PIPELINES.md` | Replace the `planner: incremental\|adaptive` doc with the preset model. |
| `src/smart-agent/controller/plan-analysis.ts` | Eval harness: update to the new kinds (it imports `makePlanner`). |

---

## Task 1: PlannerKind values + remove `ControllerConfig.planner` + handler dep (types.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/types.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/types.test.ts`

The enum flips to capability kinds; the user-facing `planner` config field is removed (its replacement is the preset); the handler learns its kind from a new dep.

- [ ] **Step 1: Change `PlannerKind` (types.ts ~line 209)**

```ts
export type PlannerKind = 'smart-executor' | 'weak-executor';
```

- [ ] **Step 2: Remove `planner?` from `ControllerConfig` (types.ts ~line 181)**

Delete this line from the `ControllerConfig` interface:
```ts
  planner?: 'incremental' | 'adaptive';
```

- [ ] **Step 3: Add `plannerKind?` to `ControllerHandlerDeps` (types.ts; the interface at ~line 117 is in controller-coordinator-handler.ts — see note)**

> NOTE: `ControllerHandlerDeps` is declared in `controller-coordinator-handler.ts` (line ~117), NOT types.ts. Add the field THERE, importing `PlannerKind` from `./types.js` (already imported). Inside the `ControllerHandlerDeps` interface, after `planner: ISubagentClient;`:
```ts
  /** Capability kind chosen by the PRESET (composition code), not user config.
   *  Selects the planner implementation. Defaults to 'smart-executor' when absent
   *  (a consumer building the handler directly without a preset). */
  plannerKind?: PlannerKind;
```

- [ ] **Step 4: Fix the type test (types.test.ts ~lines 52-61)**

The existing test sets `cfg.planner = 'adaptive'` — that field is gone. Replace the test body that referenced it:

```ts
  it('ControllerConfig has no user planner field; PlannerKind is capability-tuned', () => {
    // planner selection is preset-encoded, not a config field (§C clean break).
    const cfg: Partial<ControllerConfig> = {
      subagents: {
        evaluator: { provider: 'openai', apiKey: 'k' },
        planner: { provider: 'openai', apiKey: 'k' },
        executor: { provider: 'openai', apiKey: 'k' },
      },
    } as Partial<ControllerConfig>;
    // @ts-expect-error — `planner` is no longer a ControllerConfig field
    cfg.planner;
    const kind: PlannerKind = 'weak-executor';
    assert.equal(kind, 'weak-executor');
  });
```
(Import `PlannerKind` from `../types.js` at the top of the test if not already imported.)

> If other assertions in this `it` block referenced `cfg.planner`, remove them. Keep the `SessionBundle.plan/planCursor` type assertions that surround it intact.

- [ ] **Step 5: Build to verify the type surface compiles in isolation**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Expected: FAIL — downstream references (`planner.ts` `makePlanner`, handler `deps.config.planner`, `controller.ts` parser) still use the old enum/field. This is EXPECTED; Tasks 2-4 fix them. (Do not try to fix them here.)

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/types.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/types.test.ts
git commit -m "feat(controller): PlannerKind = smart-executor|weak-executor; drop ControllerConfig.planner (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> The build is intentionally red after this task (clean-break in progress). Tasks 2-4 restore green. Implement Tasks 1-4 as a contiguous group before expecting a green build.

---

## Task 2: Two planners — delete Incremental, SmartExecutor + WeakExecutor, makeControllerPlanner (planner.ts)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts`

`AdaptivePlanner` (the Phase-2 plan-first engine) is renamed `SmartExecutorPlanner` — its control flow is unchanged, but its create/replan prompts gain a COARSE granularity clause (a capable executor self-expands a coarse step in its tool-loop). `WeakExecutorPlanner` subclasses it and overrides the prompt seam with the ATOMIC granularity clause (one action per step; never coarse, never self-expansion). So the two planners differ MATERIALLY in granularity, not just by a near-identical prompt. `IncrementalPlanner` and `PLANNER_SYSTEM`/`RETRY_HINT` (incremental-only) are deleted. `makePlanner` → `makeControllerPlanner`.

- [ ] **Step 1: Add SMART + WEAK granularity prompt variants + a protected prompt seam (planner.ts)**

The Phase-2 `CREATE_PLAN_SYSTEM` / `REPLAN_SYSTEM` / `EXTERNAL_RESULT_REPLAN_SYSTEM` constants are the **shared agnostic base** (kept + still exported — the `planner prompt contract` test iterates them). §C needs the two planners to differ in GRANULARITY, so neither uses the base verbatim: each EXTENDS the base with an OPPOSITE granularity clause. `smart-executor` allows coarse, self-expanding steps; `weak-executor` forces atomic, one-action steps. Append to planner.ts (after the existing `EXTERNAL_RESULT_REPLAN_SYSTEM` constant):

```ts
/** Smart-executor granularity clause (§C). A capable executor can self-expand a
 *  coarse step inside its own tool-loop, so the planner MAY plan coarse. Clarifies
 *  that the base's "one concrete action" means one INTENT — a coarse batch step is
 *  one intent, not a planner-side per-item fan-out. AGNOSTIC: no tool names. */
const SMART_GRANULARITY =
  ' GRANULARITY (smart executor): a step MAY be COARSE — a single intent that ' +
  'covers a set of related items (e.g. "read every item referenced by the prior ' +
  'result"); a capable executor enumerates and processes each item WITHIN ITS OWN ' +
  'tool-loop, and control returns to the reviewer after the coarse step. This does ' +
  'NOT violate "one concrete action": a coarse batch is ONE intent. PREFER fewer ' +
  'coarse steps over enumerating items yourself.';

/** Weak-executor granularity clause (§C). A weak executor cannot be trusted to
 *  self-expand, so every step is exactly one atomic action. (Deferred discovery
 *  fan-out for plan-time-unknowable batches — §D — is Phase 4; in Phase 3 the weak
 *  planner just plans the finest grain it can.) AGNOSTIC: no tool names. */
const WEAK_GRANULARITY =
  ' GRANULARITY (weak executor): each step is EXACTLY ONE ATOMIC action the ' +
  'executor performs in a SINGLE tool use. NEVER emit a coarse/batch step and ' +
  'NEVER rely on the executor to self-expand a step — the executor handles one ' +
  'action at a time; if work spans several actions, emit that many steps.';

export const SMART_CREATE_PLAN_SYSTEM = CREATE_PLAN_SYSTEM + SMART_GRANULARITY;
export const SMART_REPLAN_SYSTEM = REPLAN_SYSTEM + SMART_GRANULARITY;
export const SMART_EXTERNAL_RESULT_REPLAN_SYSTEM =
  EXTERNAL_RESULT_REPLAN_SYSTEM + SMART_GRANULARITY;

export const WEAK_CREATE_PLAN_SYSTEM = CREATE_PLAN_SYSTEM + WEAK_GRANULARITY;
export const WEAK_REPLAN_SYSTEM = REPLAN_SYSTEM + WEAK_GRANULARITY;
export const WEAK_EXTERNAL_RESULT_REPLAN_SYSTEM =
  EXTERNAL_RESULT_REPLAN_SYSTEM + WEAK_GRANULARITY;
```

> The smart variants carry a genuine COARSE instruction the base lacks — so `smart-executor` is materially coarser than `weak-executor`, realizing §C (not a near-identical pair). The base constants stay exported as the shared contract.

- [ ] **Step 2: Rename `AdaptivePlanner` → `SmartExecutorPlanner` + introduce protected prompt seam**

In planner.ts, rename `export class AdaptivePlanner` (line ~221) to `export class SmartExecutorPlanner`. Inside it, add three protected accessors that default to the SMART (coarse) prompts, and make `callPlan`/`next` use them instead of the module constants directly:

```ts
  /** Prompt seam — overridden by WeakExecutorPlanner for atomic granularity (§C). */
  protected get createPlanSystem(): string {
    return SMART_CREATE_PLAN_SYSTEM;
  }
  protected get replanSystem(): string {
    return SMART_REPLAN_SYSTEM;
  }
  protected get externalResultReplanSystem(): string {
    return SMART_EXTERNAL_RESULT_REPLAN_SYSTEM;
  }
```

Then in `next()` and `callPlan()`, replace the direct use of the constants:
- The create branch currently calls `this.callPlan(CREATE_PLAN_SYSTEM, ...)` → `this.callPlan(this.createPlanSystem, ...)`.
- The replan branch currently selects `const system = resumedExternal ? EXTERNAL_RESULT_REPLAN_SYSTEM : REPLAN_SYSTEM;` → `const system = resumedExternal ? this.externalResultReplanSystem : this.replanSystem;`.

(Leave `FINALIZE_SYSTEM` usage as-is; `PLANNER_SYSTEM` is removed in Step 4 with `IncrementalPlanner`. The base `CREATE_PLAN_SYSTEM`/`REPLAN_SYSTEM`/`EXTERNAL_RESULT_REPLAN_SYSTEM` constants remain exported — they back the SMART/WEAK variants and the prompt-contract test.)

- [ ] **Step 3: Add `WeakExecutorPlanner` (subclass)**

After the `SmartExecutorPlanner` class, add:

```ts
/** Weak-executor planner (§C): the same plan-first engine as SmartExecutorPlanner,
 *  but with the finest-grain create/replan prompts (one action per step). Phase 4
 *  adds deferred discovery expansion to this class; Phase 3 differs only by prompt. */
export class WeakExecutorPlanner extends SmartExecutorPlanner {
  protected override get createPlanSystem(): string {
    return WEAK_CREATE_PLAN_SYSTEM;
  }
  protected override get replanSystem(): string {
    return WEAK_REPLAN_SYSTEM;
  }
  protected override get externalResultReplanSystem(): string {
    return WEAK_EXTERNAL_RESULT_REPLAN_SYSTEM;
  }
}
```

- [ ] **Step 4: Delete `IncrementalPlanner` + its incremental-only constants**

Remove the entire `export class IncrementalPlanner` (line ~91) and the module constants used ONLY by it: `PLANNER_SYSTEM` (line ~35) and `RETRY_HINT` (line ~54). (Confirm via grep — `grep -n "PLANNER_SYSTEM\|RETRY_HINT\|IncrementalPlanner" packages/llm-agent-server-libs/src` — the remaining references are: the `planner prompt contract` test in `planner.test.ts` (imports `PLANNER_SYSTEM` in its iteration list — fixed in Step 6) and `plan-analysis.ts` (Task 7). No PRODUCT code should reference them after this step.)

- [ ] **Step 5: `makePlanner` → `makeControllerPlanner`**

Replace the `makePlanner` function (line ~417):

```ts
export function makeControllerPlanner(
  kind: PlannerKind,
  planner: ISubagentClient,
  hint?: string,
  skillsRecall?: SkillsRecall,
): IControllerPlanner {
  return kind === 'weak-executor'
    ? new WeakExecutorPlanner(planner, hint, skillsRecall)
    : new SmartExecutorPlanner(planner, hint, skillsRecall);
}
```

- [ ] **Step 6: Update planner.test.ts references**

Open `planner.test.ts`. Replace every `AdaptivePlanner` with `SmartExecutorPlanner` and every `new AdaptivePlanner(` accordingly (the Phase-2 tests `AdaptivePlanner mints…`, `AdaptivePlanner prompt…` etc.). Delete any `IncrementalPlanner` import + tests (the incremental planner is gone). Add a focused weak-executor test:

```ts
import {
  SmartExecutorPlanner,
  WeakExecutorPlanner,
  makeControllerPlanner,
} from '../planner.js';

test('makeControllerPlanner returns the kind-matched implementation', () => {
  const client = fakeClient([]);
  assert.ok(makeControllerPlanner('smart-executor', client) instanceof SmartExecutorPlanner);
  assert.ok(makeControllerPlanner('weak-executor', client) instanceof WeakExecutorPlanner);
});

test('WeakExecutorPlanner create-plan prompt demands ONE ATOMIC action per step (coarse forbidden)', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner = new WeakExecutorPlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '' });
  await planner.next({ bundle, prompt: 'g', retrying: false });
  const sys = client.lastSystemContent();
  assert.match(sys, /EXACTLY ONE ATOMIC action/); // weak granularity clause present
  assert.doesNotMatch(sys, /a step MAY be COARSE/); // NOT the smart clause
});

test('SmartExecutorPlanner create-plan prompt PERMITS coarse, self-expanding steps', async () => {
  const client = recordingFakeClient([
    JSON.stringify({ plan: [{ name: 'a', instructions: 'fetch a' }] }),
  ]);
  const planner = new SmartExecutorPlanner(client);
  const bundle = newBundle({ runId: 'run-1', goal: 'g', plannerPrivate: '' });
  await planner.next({ bundle, prompt: 'g', retrying: false });
  const sys = client.lastSystemContent();
  assert.match(sys, /a step MAY be COARSE/); // smart granularity clause present
  assert.doesNotMatch(sys, /EXACTLY ONE ATOMIC action/); // NOT the weak clause
});
```

Also fix the existing `planner prompt contract` test (it iterates `PLANNER_SYSTEM`, which is deleted): drop `PLANNER_SYSTEM` from the import + the iteration list, and add the four new variants so the English-invariant is still asserted across all live planner prompts:

```ts
// in `describe('planner prompt contract')` — the English-invariant iteration list:
    for (const p of [
      CREATE_PLAN_SYSTEM,
      REPLAN_SYSTEM,
      EXTERNAL_RESULT_REPLAN_SYSTEM,
      SMART_CREATE_PLAN_SYSTEM,
      WEAK_CREATE_PLAN_SYSTEM,
      WEAK_REPLAN_SYSTEM,
      WEAK_EXTERNAL_RESULT_REPLAN_SYSTEM,
    ]) {
```
(Update the import at the top of `planner.test.ts`: remove `PLANNER_SYSTEM`, add `SMART_CREATE_PLAN_SYSTEM`, `WEAK_CREATE_PLAN_SYSTEM`, `WEAK_REPLAN_SYSTEM`, `WEAK_EXTERNAL_RESULT_REPLAN_SYSTEM`. The base `CREATE_PLAN_SYSTEM`/`REPLAN_SYSTEM`/`EXTERNAL_RESULT_REPLAN_SYSTEM` imports stay.)

> Reuse / extend the existing `fakeClient`/`recordingFakeClient`/`newBundle` helpers from Task-4/7 of Phase 2 in this file. If `recordingFakeClient` exposes only `lastUserContent()`, add a `lastSystemContent()` accessor (the content of the last message with role `'system'`) the same way.

- [ ] **Step 7: Run the planner suite**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="Planner|planner|makeControllerPlanner|WeakExecutor|SmartExecutor"`
Expected: the new tests pass; renamed Phase-2 tests still pass. (Full-package build stays red until Task 4 — the handler still calls `makePlanner`.)

- [ ] **Step 8: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/planner.ts \
        packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/planner.test.ts
git commit -m "feat(controller): SmartExecutor/WeakExecutor planners; retire IncrementalPlanner; makeControllerPlanner (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Thread `plannerKind` through handler + factory + plugin

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts`
- Modify: `packages/llm-agent-server-libs/src/factories/controller-factory.ts`
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts`

The kind flows preset (plugin) → factory → handler. The handler picks the planner from `deps.plannerKind` instead of the removed `deps.config.planner`.

- [ ] **Step 1: Handler uses `makeControllerPlanner(deps.plannerKind)` (controller-coordinator-handler.ts ~line 352)**

Replace the import + call. Change the import:
```ts
import { makeControllerPlanner } from './planner.js';
```
Change the call (line ~352-356):
```ts
    const planner = makeControllerPlanner(
      deps.plannerKind ?? 'smart-executor',
      deps.planner,
      deps.config.subagents.planner?.hint,
      deps.skillsRecall,
    );
```
(`deps.plannerKind` was added to `ControllerHandlerDeps` in Task 1 Step 3.)

- [ ] **Step 2: Factory accepts + threads `plannerKind` (controller-factory.ts)**

In `ControllerFactory.build`, add a third parameter and pass it into the handler deps. Change the signature:
```ts
  async build(
    config: ControllerConfig,
    deps: ControllerFactoryDeps,
    plannerKind: PlannerKind = 'smart-executor',
  ): Promise<BuiltCoordinator> {
```
(Import `PlannerKind` from `../smart-agent/controller/types.js` at the top.)
In the `new ControllerCoordinatorHandler({ ... })` literal, add:
```ts
      plannerKind,
```
(alongside `config,` / `models,`).

- [ ] **Step 3: Plugin parameterized by `(name, plannerKind)` (controller.ts)**

Change `ControllerPipelinePlugin` so its name + kind are constructor args. Replace `readonly name = 'controller';` with:
```ts
  readonly name: string;
  private readonly plannerKind: PlannerKind;
  constructor(
    name = 'controller',
    plannerKind: PlannerKind = 'smart-executor',
  ) {
    this.name = name;
    this.plannerKind = plannerKind;
  }
```
(Import `PlannerKind` from `../smart-agent/controller/types.js`.)
Then pass the kind into the factory call (the `await new ControllerFactory().build(cfg, deps)` line ~163):
```ts
    const { handler } = await new ControllerFactory().build(
      cfg,
      deps,
      this.plannerKind,
    );
```

> If `ControllerPipelinePlugin` already has a constructor or class fields initialized inline, fold these into it consistently — read the current class head before editing.

- [ ] **Step 4: Build the whole package — should now be GREEN**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Expected: SUCCESS. The clean break (Tasks 1-3) is now type-complete: no references to `makePlanner`, `AdaptivePlanner`, `IncrementalPlanner`, `ControllerConfig.planner`, or `PlannerKind = incremental|adaptive` remain in product code. If the build still fails, the error names the last stale reference — fix it (it belongs to this task's threading).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/controller/controller-coordinator-handler.ts \
        packages/llm-agent-server-libs/src/factories/controller-factory.ts \
        packages/llm-agent-server-libs/src/pipelines/controller.ts
git commit -m "feat(controller): thread plannerKind preset→factory→handler (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Fail-loud removal of the `planner:` config key (controller.ts parser)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts`
- Test: `packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts`

`parseConfig` currently MAPS `cfg.planner` (`'adaptive'`/`'incremental'`) into the config. The clean break: a present **`planner` key on the controller config** THROWS at parse with a migration message — no silent alias.

> SCOPE (deviation from the spec's loose "or incremental/adaptive anywhere" wording — deliberate): reject ONLY the `planner` key. A value-scan "anywhere in the controller block" would false-positive on legitimate string values in unrelated fields (a hint, a collection name, a model id containing "adaptive"), so it is intentionally NOT done. The `planner` key is the only live migration surface; rejecting it is the complete, safe break.

- [ ] **Step 1: Write the failing test (controller.test.ts)**

```ts
test('parseConfig rejects a removed planner: key with a migration message', () => {
  assert.throws(
    () => parseConfig({ subagents: { /* minimal valid subagents */ }, planner: 'adaptive' }),
    /planner:.*removed|capability is preset-encoded|controller-weak/,
  );
});

test('parseConfig accepts a controller config with no planner key', () => {
  const cfg = parseConfig({ subagents: { /* minimal valid subagents */ } });
  // no throw; planner selection is preset-encoded (not on the parsed config)
  assert.ok(!('planner' in cfg));
});
```
(Reuse the file's existing minimal `subagents` fixture + `parseConfig` access.)

- [ ] **Step 2: Run — verify FAIL**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="removed planner|no planner key"`
Expected: FAIL — `parseConfig` currently maps `planner` instead of rejecting it.

- [ ] **Step 3: Reject `planner:` in `parseConfig` (controller.ts)**

In `parseConfig`, REMOVE the `planner: (cfg.planner === 'adaptive' ? 'adaptive' : 'incremental') as ...` mapping (lines ~67-69). BEFORE building the returned object, add the fail-loud guard:
```ts
    if ('planner' in (cfg as Record<string, unknown>)) {
      throw new Error(
        "controller: `planner:` removed — capability is preset-encoded. Select " +
          "pipeline: { name: controller } (smart-executor) or " +
          "{ name: controller-weak } (weak-executor), or pass `kind` to " +
          'makeControllerPlanner. No `planner:` alias exists.',
      );
    }
```
(The returned config object no longer has a `planner` field — it was removed from `ControllerConfig` in Task 1.)

- [ ] **Step 4: Run — verify PASS**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="removed planner|no planner key"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/pipelines/controller.ts \
        packages/llm-agent-server-libs/src/pipelines/__tests__/controller.test.ts
git commit -m "feat(controller): fail-loud removal of the planner: config key (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Register the `controller-weak` pipeline name (smart-server + config + conformance)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config.ts`
- Modify: `packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts`

A config-parser change alone does not create a pipeline name — names resolve from the built-in registry in `SmartServer`. Register both kinds.

- [ ] **Step 1: Register both built-ins (smart-server.ts ~line 1182)**

In the built-in pipeline array (currently `new ControllerPipelinePlugin()`), replace that single entry with the two parameterized instances:
```ts
      new ControllerPipelinePlugin('controller', 'smart-executor'),
      new ControllerPipelinePlugin('controller-weak', 'weak-executor'),
```
(`PlannerKind` is a string literal here — the plugin constructor signature from Task 3 Step 3.)

- [ ] **Step 2: Update the built-in name diagnostic (config.ts ~line 721)**

The shape-error message lists built-ins as `flat, linear, dag, stepper`. Append the controller presets so an unknown-name diagnostic is accurate:
```ts
        "pipeline: requires a 'name' (string, or { name, config }); built-ins: flat, linear, dag, stepper, controller, controller-weak",
```
(Also update the comment at config.ts ~line 419 `# flat (default) | linear | dag | stepper | <plugin>` → add `| controller | controller-weak`.)

- [ ] **Step 3: Add `controller-weak` to the conformance test (conformance.test.ts)**

Open `conformance.test.ts`. It imports the built-in plugins and drives each through a minimal config (the `BUILTINS` array + the per-name config map at lines ~32-35). Add `controller-weak`:
- Construct it the same way the test constructs `controller` (likely `new ControllerPipelinePlugin()` — change to the parameterized form for both: `new ControllerPipelinePlugin('controller', 'smart-executor')` and `new ControllerPipelinePlugin('controller-weak', 'weak-executor')`).
- Add a config-map entry for `controller-weak` mirroring the `controller` entry (the same minimal `subagents`).

> Read the file first to match its exact `BUILTINS` shape + how it asserts `plugin.name`. The conformance assertions (name is a non-empty string, `build` is callable, etc.) apply unchanged to the weak preset.

- [ ] **Step 4: Build + run conformance + name resolution**

Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs build`
Run: `npm run -w @mcp-abap-adt/llm-agent-server-libs test -- --test-name-pattern="conformance|controller-weak|pipeline name"`
Expected: PASS — both `controller` and `controller-weak` resolve and conform.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts \
        packages/llm-agent-server-libs/src/smart-agent/config.ts \
        packages/llm-agent-server-libs/src/pipelines/__tests__/conformance.test.ts
git commit -m "feat(controller): register controller-weak built-in pipeline name (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Config examples + docs (YAMLs + PIPELINES.md)

**Files:**
- Modify: `pipelines/controller.yaml`
- Modify: `pipelines/controller-mixed.yaml`
- Modify: `docs/PIPELINES.md`

- [ ] **Step 1: `pipelines/controller.yaml` — remove the `planner:` line (~line 51)**

Delete the line `    planner: ${PLANNER:-incremental}`. The preset (`name: controller`) now implies `smart-executor`. Add a brief comment in its place:
```yaml
    # planner selection is preset-encoded: `name: controller` = smart-executor.
    # (Removed `planner:` — use `name: controller-weak` for the weak-executor preset.)
```

- [ ] **Step 2: `pipelines/controller-mixed.yaml` — switch to the weak preset (~lines 28, 59)**

This example pairs a heavy planner with a LIGHT executor — exactly the weak-executor case. Change `name: controller` (~line 28) to:
```yaml
  name: controller-weak
```
Delete the `    planner: ${PLANNER:-adaptive}` line (~line 59) and the now-stale comment above it (~lines 57-58 about adaptive vs incremental); replace with:
```yaml
    # The controller-weak preset wires the weak-executor planner (fine-grained
    # steps) — the right pairing for a light executor model.
```

- [ ] **Step 3: `docs/PIPELINES.md` — replace the planner enum doc with the preset model**

Find the controller config section (it documents `planner: incremental | adaptive`). Replace that description with:
```markdown
**Capability is preset-encoded — there is no `planner:` config key.** Select the
pairing by pipeline name:

- `pipeline: { name: controller }` → **smart-executor** planner (coarse steps; the
  capable executor self-expands a step in its tool-loop, control returns to the
  reviewer after each coarse step). The default controller preset.
- `pipeline: { name: controller-weak }` → **weak-executor** planner (fine-grained
  steps — exactly one action per step; for smaller executor models that cannot be
  trusted to self-expand).

A `planner:` key in the controller config is rejected fail-loud (migration: use the
preset name, or pass `kind` to `makeControllerPlanner` when composing in code).
```
(If the surrounding table lists `planner` as a row, remove that row.)

- [ ] **Step 4: Commit**

```bash
git add pipelines/controller.yaml pipelines/controller-mixed.yaml docs/PIPELINES.md
git commit -m "docs(controller): preset-encoded capability; drop planner: from examples + PIPELINES.md (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Sweep remaining references + green gate

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/plan-analysis.ts`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/controller/__tests__/controller-coordinator-handler.test.ts`
- Modify: `packages/llm-agent-server-libs/src/factories/__tests__/controller-factory.skills.test.ts`
- (any other file the sweep finds)

- [ ] **Step 1: Find every remaining reference**

Run:
```bash
grep -rn "makePlanner\|AdaptivePlanner\|IncrementalPlanner\|'incremental'\|'adaptive'\|PLANNER_SYSTEM\|RETRY_HINT\|config.planner\|planner: 'incremental'\|planner: 'adaptive'" packages/llm-agent-server-libs/src --include='*.ts' | grep -v node_modules
```
Each hit must be updated:
- **`plan-analysis.ts`** (eval harness): it imports `makePlanner` and drives `incremental`+`adaptive`. Change the import to `makeControllerPlanner`, and replace the driven kinds with `'smart-executor'` and `'weak-executor'`. Update the file's header comment ("incremental + adaptive" → "smart-executor + weak-executor") and any stub-prompt comment that named `PLANNER_SYSTEM (incremental)`. If a stub branch keyed on the incremental single-step `{"kind":"next"}` shape, keep it only if a planner still emits that shape — both planners are plan-first (`{"plan":[...]}`), so a `next`-shape stub branch is dead and should be removed.
- **`controller-coordinator-handler.test.ts`**: any fixture setting `config.planner` or asserting the incremental path — switch to `plannerKind` on the handler deps (e.g. `plannerKind: 'smart-executor'`), or drop if it tested the removed incremental planner.
- **`controller-factory.skills.test.ts`**: if it passed `planner:` in a config or expected a planner kind, update to pass `plannerKind` as the 3rd `build()` arg (or rely on the default) and assert via the handler's behavior.

> For each test file, READ it first; convert `planner`/enum usage to the new surface minimally — do not rewrite unrelated assertions.

- [ ] **Step 2: Full green gate**

```bash
npm run -w @mcp-abap-adt/llm-agent build
npm run -w @mcp-abap-adt/llm-agent-libs build
npm run -w @mcp-abap-adt/llm-agent-server-libs build
npm run -w @mcp-abap-adt/llm-agent-server-libs test
npm run lint:check
```
Expected: all builds succeed; full server-libs suite green (report counts); lint 0 errors. Confirm the sweep is clean:
```bash
grep -rn "makePlanner\|AdaptivePlanner\|IncrementalPlanner\|config.planner" packages/llm-agent-server-libs/src --include='*.ts' | grep -v node_modules && echo "STALE REFS REMAIN" || echo "CLEAN"
```
And no NUL bytes:
```bash
grep -rlP '\x00' packages/llm-agent-server-libs/src/smart-agent/controller/ && echo "NUL FOUND" || echo "NO NUL"
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(controller): sweep residual planner-enum references to capability kinds (Phase 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§C):**
- Retire `IncrementalPlanner`/`AdaptivePlanner` + the enum → Task 1 (enum), Task 2 (classes). ✓
- Two implementations, each with its own system prompt, selected by composition → Task 2 (`SmartExecutorPlanner` = base + COARSE clause / `WeakExecutorPlanner` = base + ATOMIC clause via the prompt seam — materially different granularity, tested by the coarse-vs-atomic prompt assertions), Task 3 (preset→factory→handler threading). ✓ (review P1: smart is genuinely coarse, not a verbatim rename of the already-fine-grained base.)
- `PlannerKind = 'smart-executor' | 'weak-executor'`, `makePlanner`→`makeControllerPlanner` → Task 1, Task 2. ✓
- Fail-loud removal of `planner:` (no alias) → Task 4. ✓ (review P2: rejects the `planner` KEY only; the spec's "anywhere" value-scan is intentionally dropped — false-positive risk on legit values; noted in Task 4 scope.)
- Files the spec lists (types, planner, controller.ts parser, controller.yaml + controller-mixed.yaml, factory, tests/examples, PIPELINES.md) → Tasks 1-7. ✓
- Register `controller-weak` NAME in the built-in registry + name parsing/diagnostics + conformance test → Task 5. ✓
- Strong guarantee (preset-pinned executor); `declaredCapability` DEFERRED → honored (no such field added; out-of-scope note). ✓
- Incidental `server-context.ts` comment cleanup → already DONE (PR #186); not re-opened. ✓

**Deferred (Phase 4, NOT gaps):** §D deferred expansion (the structural difference for weak-executor) — Phase 3 ships weak-executor as plan-first + fine-grained prompt only. The `WeakExecutorPlanner` subclass + prompt seam are the seam Phase 4 extends.

**Placeholder scan:** Every code step shows concrete code. The "minimal valid subagents" / "read the file first" notes (Tasks 4/5/7) delegate ONLY to reusing the EXISTING test fixtures + matching the current class head — the production code is given in full. No TBD/"handle edge cases"/"similar to".

**Type consistency:** `PlannerKind` (Task 1) is consumed by `makeControllerPlanner` (Task 2), `ControllerHandlerDeps.plannerKind` (Task 1/handler), `ControllerFactory.build`'s 3rd param (Task 3), and the `ControllerPipelinePlugin` constructor (Task 3). `makeControllerPlanner` replaces `makePlanner` everywhere (Task 2 def, Task 3 handler call, Task 7 sweep). `SmartExecutorPlanner`/`WeakExecutorPlanner` names are used consistently in Task 2 (def), Task 2 Step 6 (tests), Task 5 (registry via the plugin, not the class). The build is intentionally red across Tasks 1-2 and green from Task 3 Step 4 onward — noted in each task.

**Ordering note:** Tasks 1→2→3 are a contiguous clean-break group (build red until Task 3 Step 4). Implement them in order before the green gate. Tasks 4-7 are independently green.
