# Coordinator Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `coordinator` pipeline stage that autonomously decomposes a user request into a multi-step plan and executes each step via a chosen subagent (or self-LLM call), with planning, dispatch, and activation behavior pluggable via three orthogonal strategy interfaces.

**Architecture:** One new stage handler (`CoordinatorHandler`) consumes three strategies — `IPlanningStrategy` (how to build/replan), `IDispatchStrategy` (how to execute a step), `IActivationStrategy` (when to activate at all). Strategies are injected via builder (`withCoordinator({...})`) or selected by string name from YAML. `DefaultPipeline._buildStages()` conditionally swaps `tool-loop` for `coordinator` when activation strategy says yes. Builds on top of the already-landed subagent infrastructure (`SubAgentRegistry`, `SmartAgentSubAgent`, `SubAgentHandler`). Does **not** require a custom `IPipeline` — the existing `DefaultPipeline` is extended in-place via a single conditional.

**Tech Stack:** TypeScript ESM, Biome lint/format, Node ≥18. No new runtime deps. Built-in strategies use existing `ILlm` for planning, existing `SubAgentRegistry` for dispatch, existing `ISkillManager` for skill-driven planning input.

---

## Background — what is already in place

The branch `worktree-feat-subagent-orchestration` (commits `a3dc3ef` → `2fdbe06`) added:
- `ISubAgent`, `ISubAgentInput`, `ISubAgentResult`, `SubAgentRegistry` contracts in `@mcp-abap-adt/llm-agent`.
- `SubAgentHandler` (`packages/llm-agent-libs/src/pipeline/handlers/subagent.ts`) — invokes a named subagent with `{{path}}`-rendered task. Registered in handler registry when registry is non-empty.
- `SmartAgentSubAgent` adapter (`packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`) — wraps any `SmartAgent` as an `ISubAgent`.
- `SmartAgentBuilder.withSubAgents(registry)` + `DefaultPipeline({ subAgents })` constructor — registry flows through builder to pipeline.
- YAML loader for `subagents:` block (`packages/llm-agent-server/src/smart-agent/config.ts`) — parses parent YAML, recursively builds each sub-agent's `SmartAgent`, populates registry, rejects nested subagents and unsupported features loudly.
- Template helpers (`packages/llm-agent-libs/src/util/template.ts`) — `resolveTemplate`, `getPath`, `setPath`.

What is **missing** today (problem statement this plan solves): there is no stage that *uses* the registry autonomously. The `subagent` stage exists but only fires one fixed step per pipeline invocation. Multi-step processes (e.g., from a skill body) are not walked end-to-end — the LLM stops after one tool-loop iteration with `finishReason: stop`, and the pipeline exits even though the requested process has remaining steps. Also, `DefaultPipeline._buildStages()` hardcodes its stage list and does **not** read `pipeline.stages` from YAML, so adding a `repeat`+`subagent` block to YAML has no runtime effect.

This plan fixes that by adding an autonomous coordinator that lives **inside** `DefaultPipeline` (no new pipeline class), with pluggable strategies for planning, dispatch, and activation.

---

## File Structure

**New files (contracts — `packages/llm-agent`):**
- `packages/llm-agent/src/interfaces/coordinator.ts` — `Plan`, `PlanStep`, `StepResult`, `IPlanningStrategy`, `IDispatchStrategy`, `IActivationStrategy`, `ICoordinatorConfig`.

**New files (implementations — `packages/llm-agent-libs`):**
- `packages/llm-agent-libs/src/coordinator/index.ts` — barrel re-export.
- `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts` — `OneShotPlanning`.
- `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts` — `SkillStepsPlanning`.
- `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts` — `ReplanOnErrorPlanning`.
- `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts` — `SubAgentDispatch`.
- `packages/llm-agent-libs/src/coordinator/dispatch/self.ts` — `SelfDispatch`.
- `packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts` — `HybridDispatch`.
- `packages/llm-agent-libs/src/coordinator/activation/auto.ts` — `AutoActivation`.
- `packages/llm-agent-libs/src/coordinator/activation/explicit.ts` — `ExplicitActivation`.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — `CoordinatorHandler` (consumes the three strategies).

**Modified files:**
- `packages/llm-agent/src/interfaces/subagent.ts` — add optional `description?: string` on `ISubAgent`.
- `packages/llm-agent/src/interfaces/skill.ts` — add optional `steps?: ProcessStep[]` on `ISkillMeta`.
- `packages/llm-agent/src/interfaces/pipeline.ts` — add `'coordinator'` literal to `BuiltInStageType`.
- `packages/llm-agent/src/interfaces/index.ts` — re-export coordinator types.
- `packages/llm-agent-libs/src/pipeline/context.ts` — add `plan?: Plan`, `currentStepIdx?: number`, `stepResults?: Record<string, StepResult>` to `PipelineContext`.
- `packages/llm-agent-libs/src/pipeline/handlers/index.ts` — register `CoordinatorHandler` when activation strategy can fire.
- `packages/llm-agent-libs/src/pipeline/default-pipeline.ts` — conditional swap `tool-loop` ↔ `coordinator` in `_buildStages()`, plumb strategies through constructor options.
- `packages/llm-agent-libs/src/builder.ts` — add `withCoordinator(cfg)` fluent setter and `withSubAgent(name, agent, opts)` sugar.
- `packages/llm-agent-libs/src/index.ts` — re-export coordinator strategies and `CoordinatorHandler`.
- `packages/llm-agent-server/src/smart-agent/config.ts` — parse top-level `coordinator:` YAML block, resolve named strategies, thread into builder.

**Example/docs:**
- `docs/examples/coordinator-orchestration.yaml` — end-to-end YAML showing all three strategies in action.
- `docs/ARCHITECTURE.md` — append "Coordinator orchestration" subsection.

**Responsibility split:**
- Contracts (`llm-agent`): interfaces, plain types. Zero runtime.
- Strategies + handler (`llm-agent-libs`): everything execution-related. Each strategy class is one file, one responsibility.
- Binary (`llm-agent-server`): YAML→builder translation only; named-strategy lookup table.

---

## Task 1: Coordinator contracts in `@mcp-abap-adt/llm-agent`

**Files:**
- Create: `packages/llm-agent/src/interfaces/coordinator.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts` (re-export)
- Modify: `packages/llm-agent/src/interfaces/pipeline.ts` (add literal to union)

- [ ] **Step 1: Create the contracts file**

Create `packages/llm-agent/src/interfaces/coordinator.ts`:

```ts
import type { LlmUsage } from './types.js';
import type { ISubAgent, ISubAgentResult, SubAgentRegistry } from './subagent.js';
import type { ILlm } from './llm.js';

export interface PlanStep {
  id: string;
  goal: string;
  agent?: string;
  inputTemplate?: string;
  expectedTools?: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed';
}

export interface Plan {
  steps: PlanStep[];
  rationale?: string;
  createdAt: number;
  source: 'planner-llm' | 'skill-steps' | 'manual';
}

export interface StepResult {
  stepId: string;
  output: string;
  toolCalls?: ISubAgentResult['toolCalls'];
  usage?: LlmUsage;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ICoordinatorContext {
  inputText: string;
  systemPrompt?: string;
  skillContent?: string;
  registry: SubAgentRegistry;
  plan?: Plan;
  stepResults: Record<string, StepResult>;
  signal?: AbortSignal;
  sessionId: string;
}

export interface IPlanningStrategy {
  readonly name: string;
  buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan>;
  shouldReplan(ctx: ICoordinatorContext, lastResult: StepResult): boolean;
  rebuildPlan(ctx: ICoordinatorContext, remaining: PlanStep[]): Promise<Plan>;
}

export interface IDispatchStrategy {
  readonly name: string;
  dispatch(step: PlanStep, ctx: ICoordinatorContext): Promise<StepResult>;
}

export interface IActivationStrategy {
  readonly name: string;
  shouldActivate(ctx: { hasSubAgents: boolean; hasStructuredSkill: boolean }): boolean;
}

export interface ICoordinatorConfig {
  planning?: IPlanningStrategy;
  dispatch?: IDispatchStrategy;
  activation?: IActivationStrategy;
  plannerLlm?: ILlm;
  maxSteps?: number;
  maxRetriesPerStep?: number;
  failPolicy?: 'abort' | 'continue';
}

export type SubAgentWithDescription = ISubAgent & { description: string };
```

- [ ] **Step 2: Re-export from interfaces/index.ts**

Open `packages/llm-agent/src/interfaces/index.ts` and append (alongside other re-exports):

```ts
export type {
  Plan,
  PlanStep,
  StepResult,
  ICoordinatorContext,
  IPlanningStrategy,
  IDispatchStrategy,
  IActivationStrategy,
  ICoordinatorConfig,
  SubAgentWithDescription,
} from './coordinator.js';
```

- [ ] **Step 3: Add `'coordinator'` to BuiltInStageType union**

In `packages/llm-agent/src/interfaces/pipeline.ts` find the `BuiltInStageType` union (it already contains `'subagent'` from the previous feature) and append:

```ts
  | 'coordinator';
```

(Append before the closing semicolon — preserve all existing members.)

- [ ] **Step 4: Verify imports resolve**

Run: `grep -E "export (type|interface) (LlmUsage|ILlm)" packages/llm-agent/src/interfaces/llm.ts packages/llm-agent/src/interfaces/types.ts`
Expected: both names appear. If `LlmUsage` lives elsewhere or has a different name (e.g. `ITokenUsage`), update the import in `coordinator.ts` accordingly — do not invent a new type.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS, exit code 0.

- [ ] **Step 6: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/interfaces/coordinator.ts packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/interfaces/pipeline.ts
git commit -m "feat(llm-agent): add Coordinator strategy interfaces and Plan/PlanStep types"
```

---

## Task 2: Extend ISubAgent with optional `description` and ISkillMeta with optional `steps`

**Files:**
- Modify: `packages/llm-agent/src/interfaces/subagent.ts`
- Modify: `packages/llm-agent/src/interfaces/skill.ts`

- [ ] **Step 1: Add description to ISubAgent**

In `packages/llm-agent/src/interfaces/subagent.ts`, locate `export interface ISubAgent`. Add an optional readonly field after `name`:

```ts
export interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}
```

(Just add the one `description?` line. Do not change `run` signature.)

- [ ] **Step 2: Add steps to ISkillMeta**

In `packages/llm-agent/src/interfaces/skill.ts`, locate `export interface ISkillMeta`. Add the optional `steps` field at the end (before the vendor-extensions index signature, if present):

```ts
  steps?: Array<{
    id: string;
    goal: string;
    expectedTools?: string[];
  }>;
```

So the interface becomes (with existing fields preserved exactly):

```ts
export interface ISkillMeta {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  model?: string;
  context?: 'inline' | 'fork';
  argumentHint?: string;
  steps?: Array<{
    id: string;
    goal: string;
    expectedTools?: string[];
  }>;
  [key: string]: unknown;
}
```

- [ ] **Step 3: Update existing SmartAgentSubAgent to surface description**

In `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`, extend the constructor to accept an optional description and store it:

```ts
export class SmartAgentSubAgent implements ISubAgent {
  public readonly description?: string;

  constructor(
    public readonly name: string,
    private readonly agent: SmartAgent,
    opts?: { description?: string },
  ) {
    this.description = opts?.description;
  }

  // ... existing async run() unchanged
}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/subagent.ts packages/llm-agent/src/interfaces/skill.ts packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts
git commit -m "feat(llm-agent): add optional ISubAgent.description and ISkillMeta.steps for coordinator"
```

---

## Task 3: Extend PipelineContext with Plan fields

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/context.ts`

- [ ] **Step 1: Inspect existing PipelineContext shape**

Run: `grep -n "interface PipelineContext\|subResults\|currentStepIdx" packages/llm-agent-libs/src/pipeline/context.ts | head -10`
Note where `subResults?: Record<string, unknown>` was added by the previous feature (it should be present already — if not, we will add it here too).

- [ ] **Step 2: Add coordinator context fields**

In `packages/llm-agent-libs/src/pipeline/context.ts`, add an import at the top alongside other contract imports:

```ts
import type { Plan, StepResult } from '@mcp-abap-adt/llm-agent';
```

Inside the `PipelineContext` interface (find it — typically large; locate the place where `subResults` lives), append (preserve existing fields exactly):

```ts
  /** Coordinator plan, if a coordinator stage ran. */
  plan?: Plan;
  /** Index of the step currently being executed by the coordinator. */
  currentStepIdx?: number;
  /** Per-step results captured by the coordinator, keyed by stepId. */
  stepResults?: Record<string, StepResult>;
```

If `subResults` is not yet declared on `PipelineContext` (some checkouts may have it added ad-hoc), add it as well:

```ts
  /** Subagent stage outputs, written by SubAgentHandler. Keyed by output path. */
  subResults?: Record<string, unknown>;
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/context.ts
git commit -m "feat(llm-agent-libs): add plan/currentStepIdx/stepResults fields to PipelineContext"
```

---

## Task 4: `OneShotPlanning` and `SkillStepsPlanning` strategies

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts`
- Create: `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts`

- [ ] **Step 1: Create OneShotPlanning**

Create `packages/llm-agent-libs/src/coordinator/planning/one-shot.ts`:

```ts
import type {
  ICoordinatorContext,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
  ILlm,
} from '@mcp-abap-adt/llm-agent';

/**
 * Plan once at the start by asking a planner LLM. Never replans.
 * Use as the default for cheap, deterministic flows.
 */
export class OneShotPlanning implements IPlanningStrategy {
  readonly name = 'one-shot';

  constructor(private readonly plannerLlm: ILlm) {}

  async buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan> {
    const agentsBlock = [...ctx.registry.entries()]
      .map(([name, a]) => `- ${name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const skillBlock = ctx.skillContent
      ? `\n\nApplicable skill instructions:\n${ctx.skillContent}\n`
      : '';

    const systemPrompt = `You are a planner. Decompose the user request into ordered steps.
For each step, choose the best agent from the list (or omit "agent" if no specialist fits).
Respond with ONLY a JSON object of shape:
{"steps":[{"id":"step-1","goal":"...","agent":"optional-name"}],"rationale":"..."}

Available agents:
${agentsBlock || '(none — use self-dispatch)'}${skillBlock}`;

    const userPrompt = ctx.inputText;
    const response = await this.plannerLlm.call({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [],
    });
    if (!response.ok) throw response.error;

    const jsonText = extractJson(response.value.content);
    const parsed = JSON.parse(jsonText) as {
      steps: Array<{ id?: string; goal: string; agent?: string }>;
      rationale?: string;
    };
    const steps: PlanStep[] = parsed.steps.map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      goal: s.goal,
      agent: s.agent,
      status: 'pending',
    }));

    return {
      steps,
      rationale: parsed.rationale,
      createdAt: Date.now(),
      source: 'planner-llm',
    };
  }

  shouldReplan(_ctx: ICoordinatorContext, _lastResult: StepResult): boolean {
    return false;
  }

  async rebuildPlan(ctx: ICoordinatorContext, remaining: PlanStep[]): Promise<Plan> {
    return {
      steps: remaining,
      createdAt: Date.now(),
      source: 'planner-llm',
    };
  }
}

function extractJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Planner output did not contain a JSON object: ${text.slice(0, 200)}`);
  return match[0];
}
```

- [ ] **Step 2: Create SkillStepsPlanning**

Create `packages/llm-agent-libs/src/coordinator/planning/skill-steps.ts`:

```ts
import type {
  ICoordinatorContext,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
  ISkillMeta,
} from '@mcp-abap-adt/llm-agent';

/**
 * Use explicit `steps:` from the active skill's frontmatter when present.
 * Falls back to throwing so a caller can chain to another planner.
 */
export class SkillStepsPlanning implements IPlanningStrategy {
  readonly name = 'skill-steps';

  constructor(private readonly resolveSkillMeta: (ctx: ICoordinatorContext) => ISkillMeta | undefined) {}

  async buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan> {
    const meta = this.resolveSkillMeta(ctx);
    if (!meta?.steps?.length) {
      throw new Error(
        `SkillStepsPlanning: no explicit 'steps' in active skill. ` +
          `Chain this strategy with a fallback (e.g. OneShotPlanning).`,
      );
    }
    const steps: PlanStep[] = meta.steps.map((s) => ({
      id: s.id,
      goal: s.goal,
      expectedTools: s.expectedTools,
      status: 'pending',
    }));
    return {
      steps,
      rationale: `Steps declared by skill '${meta.name}'`,
      createdAt: Date.now(),
      source: 'skill-steps',
    };
  }

  shouldReplan(_ctx: ICoordinatorContext, _lastResult: StepResult): boolean {
    return false;
  }

  async rebuildPlan(_ctx: ICoordinatorContext, remaining: PlanStep[]): Promise<Plan> {
    return {
      steps: remaining,
      createdAt: Date.now(),
      source: 'skill-steps',
    };
  }
}
```

- [ ] **Step 3: Verify ILlm interface**

Run: `grep -nE "^(export )?(interface|type) ILlm\b" packages/llm-agent/src/interfaces/llm.ts`
Then run: `grep -nE "(call|generate|complete)\s*\(" packages/llm-agent/src/interfaces/llm.ts | head`
Confirm `ILlm.call(...)` exists and returns `Promise<Result<...>>`. If the actual method name is different (e.g. `generate`, `chat`), adjust the call in `one-shot.ts` accordingly. The return shape used in the implementation must match what `ILlm` actually returns — verify `response.ok`, `response.error`, `response.value.content` are correct property names; if not, fix.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/planning/
git commit -m "feat(llm-agent-libs): add OneShotPlanning and SkillStepsPlanning strategies"
```

---

## Task 5: `ReplanOnErrorPlanning` strategy

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts`

- [ ] **Step 1: Create the file**

Create `packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts`:

```ts
import type {
  ICoordinatorContext,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
  ILlm,
} from '@mcp-abap-adt/llm-agent';
import { OneShotPlanning } from './one-shot.js';

/**
 * Plan once at the start. If a step fails (StepResult.ok === false), build a
 * fresh plan for the remaining work, taking the failure into account.
 */
export class ReplanOnErrorPlanning implements IPlanningStrategy {
  readonly name = 'replan-on-error';
  private readonly delegate: OneShotPlanning;

  constructor(private readonly plannerLlm: ILlm) {
    this.delegate = new OneShotPlanning(plannerLlm);
  }

  buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan> {
    return this.delegate.buildInitialPlan(ctx);
  }

  shouldReplan(_ctx: ICoordinatorContext, lastResult: StepResult): boolean {
    return !lastResult.ok;
  }

  async rebuildPlan(ctx: ICoordinatorContext, remaining: PlanStep[]): Promise<Plan> {
    const agentsBlock = [...ctx.registry.entries()]
      .map(([name, a]) => `- ${name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const resultsBlock = Object.values(ctx.stepResults)
      .map((r) => `- ${r.stepId}: ${r.ok ? 'OK' : 'FAILED'} — ${r.output.slice(0, 200)}`)
      .join('\n');
    const remainingBlock = remaining
      .map((s) => `- ${s.id}: ${s.goal}`)
      .join('\n');

    const systemPrompt = `You are a planner. The previous plan stalled. Build a NEW plan
for the remaining work, considering what has happened so far. Skip already-done work.

Original user request: ${ctx.inputText}

Results so far:
${resultsBlock}

Previously remaining steps:
${remainingBlock}

Available agents:
${agentsBlock || '(none — use self-dispatch)'}

Respond with ONLY a JSON object:
{"steps":[{"id":"...","goal":"...","agent":"optional"}],"rationale":"..."}`;

    const response = await this.plannerLlm.call({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Build the revised plan now.' },
      ],
      tools: [],
    });
    if (!response.ok) throw response.error;

    const jsonText = extractJson(response.value.content);
    const parsed = JSON.parse(jsonText) as {
      steps: Array<{ id?: string; goal: string; agent?: string }>;
      rationale?: string;
    };
    return {
      steps: parsed.steps.map((s, i) => ({
        id: s.id ?? `replan-${i + 1}`,
        goal: s.goal,
        agent: s.agent,
        status: 'pending',
      })),
      rationale: parsed.rationale,
      createdAt: Date.now(),
      source: 'planner-llm',
    };
  }
}

function extractJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Planner output did not contain a JSON object: ${text.slice(0, 200)}`);
  return match[0];
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/planning/replan-on-error.ts
git commit -m "feat(llm-agent-libs): add ReplanOnErrorPlanning strategy"
```

---

## Task 6: `SubAgentDispatch` strategy

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`

- [ ] **Step 1: Create the strategy**

Create `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`:

```ts
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { resolveTemplate } from '../../util/template.js';

/**
 * Dispatch the step to a named subagent from the registry.
 * If step.agent is unset or not in the registry, throws — chain with HybridDispatch for a fallback.
 */
export class SubAgentDispatch implements IDispatchStrategy {
  readonly name = 'subagent';

  async dispatch(step: PlanStep, ctx: ICoordinatorContext): Promise<StepResult> {
    const agentName = step.agent;
    if (!agentName) {
      return {
        stepId: step.id,
        output: '',
        durationMs: 0,
        ok: false,
        error: `SubAgentDispatch: step '${step.id}' has no agent and no fallback is configured`,
      };
    }
    const sub = ctx.registry.get(agentName);
    if (!sub) {
      return {
        stepId: step.id,
        output: '',
        durationMs: 0,
        ok: false,
        error: `SubAgentDispatch: agent '${agentName}' not in registry (registered: ${
          [...ctx.registry.keys()].join(', ') || 'none'
        })`,
      };
    }
    const renderCtx: Record<string, unknown> = {
      inputText: ctx.inputText,
      stepResults: ctx.stepResults,
      step: step,
      goal: step.goal,
    };
    const task = step.inputTemplate
      ? resolveTemplate(step.inputTemplate, renderCtx)
      : step.goal;

    const started = Date.now();
    try {
      const res = await sub.run({
        task,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
      return {
        stepId: step.id,
        output: res.output,
        toolCalls: res.toolCalls,
        usage: res.usage,
        durationMs: Date.now() - started,
        ok: true,
      };
    } catch (err) {
      return {
        stepId: step.id,
        output: '',
        durationMs: Date.now() - started,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts
git commit -m "feat(llm-agent-libs): add SubAgentDispatch strategy"
```

---

## Task 7: `SelfDispatch` and `HybridDispatch` strategies

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/dispatch/self.ts`
- Create: `packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts`

- [ ] **Step 1: Create SelfDispatch**

Create `packages/llm-agent-libs/src/coordinator/dispatch/self.ts`:

```ts
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
  ILlm,
} from '@mcp-abap-adt/llm-agent';

/**
 * Execute the step via the agent's own LLM (no subagent). Useful when the
 * registry is empty but the planner has decomposed the request into steps.
 */
export class SelfDispatch implements IDispatchStrategy {
  readonly name = 'self';

  constructor(private readonly llm: ILlm, private readonly systemPrompt?: string) {}

  async dispatch(step: PlanStep, ctx: ICoordinatorContext): Promise<StepResult> {
    const sys = this.systemPrompt
      ?? ctx.systemPrompt
      ?? 'You are an autonomous agent. Complete the user-assigned step concisely.';
    const userMsg = `Current step: ${step.goal}\n\nResults so far:\n${
      Object.values(ctx.stepResults)
        .map((r) => `- ${r.stepId}: ${r.output.slice(0, 300)}`)
        .join('\n') || '(none)'
    }`;
    const started = Date.now();
    try {
      const res = await this.llm.call({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        tools: [],
      });
      if (!res.ok) throw res.error;
      return {
        stepId: step.id,
        output: res.value.content,
        usage: res.value.usage,
        durationMs: Date.now() - started,
        ok: true,
      };
    } catch (err) {
      return {
        stepId: step.id,
        output: '',
        durationMs: Date.now() - started,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
```

- [ ] **Step 2: Create HybridDispatch**

Create `packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts`:

```ts
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Try a named subagent first; if no agent name was set or the named agent is
 * absent from the registry, fall back to a self-dispatch strategy.
 */
export class HybridDispatch implements IDispatchStrategy {
  readonly name = 'hybrid';

  constructor(
    private readonly primary: IDispatchStrategy,
    private readonly fallback: IDispatchStrategy,
  ) {}

  async dispatch(step: PlanStep, ctx: ICoordinatorContext): Promise<StepResult> {
    const needsFallback = !step.agent || !ctx.registry.has(step.agent);
    return needsFallback
      ? this.fallback.dispatch(step, ctx)
      : this.primary.dispatch(step, ctx);
  }
}
```

- [ ] **Step 3: Verify ILlm.call message/return shape**

Run: `grep -nE "interface ILlm\b|call\s*\(" packages/llm-agent/src/interfaces/llm.ts | head -10`
Confirm the `call` method's input shape (we use `{ messages, tools }`) and return shape (`Result<{ content, usage? }, ...>`). Adjust both `self.ts` and `one-shot.ts` if the real shape differs (e.g. if `tools` is required at minimum length 0, leave `[]`; if the method is `chat(messages, opts)`, change accordingly). Do not invent fields.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dispatch/self.ts packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts
git commit -m "feat(llm-agent-libs): add SelfDispatch and HybridDispatch strategies"
```

---

## Task 8: `AutoActivation` and `ExplicitActivation` strategies

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/activation/auto.ts`
- Create: `packages/llm-agent-libs/src/coordinator/activation/explicit.ts`

- [ ] **Step 1: Create AutoActivation**

Create `packages/llm-agent-libs/src/coordinator/activation/auto.ts`:

```ts
import type { IActivationStrategy } from '@mcp-abap-adt/llm-agent';

/**
 * Activate the coordinator when EITHER the registry has subagents OR the
 * selected skill has explicit `steps` declared. This is the default for users
 * who simply add subagents or annotated skills.
 */
export class AutoActivation implements IActivationStrategy {
  readonly name = 'auto';

  shouldActivate(ctx: { hasSubAgents: boolean; hasStructuredSkill: boolean }): boolean {
    return ctx.hasSubAgents || ctx.hasStructuredSkill;
  }
}
```

- [ ] **Step 2: Create ExplicitActivation**

Create `packages/llm-agent-libs/src/coordinator/activation/explicit.ts`:

```ts
import type { IActivationStrategy } from '@mcp-abap-adt/llm-agent';

/**
 * Activate only when explicitly enabled via `withCoordinator()`.
 * Useful for users who want predictable, opt-in behavior.
 */
export class ExplicitActivation implements IActivationStrategy {
  readonly name = 'explicit';
  private enabled = true;

  shouldActivate(_ctx: { hasSubAgents: boolean; hasStructuredSkill: boolean }): boolean {
    return this.enabled;
  }
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/activation/
git commit -m "feat(llm-agent-libs): add AutoActivation and ExplicitActivation strategies"
```

---

## Task 9: Coordinator barrel + main re-export

**Files:**
- Create: `packages/llm-agent-libs/src/coordinator/index.ts`
- Modify: `packages/llm-agent-libs/src/index.ts`

- [ ] **Step 1: Create the coordinator barrel**

Create `packages/llm-agent-libs/src/coordinator/index.ts`:

```ts
export { OneShotPlanning } from './planning/one-shot.js';
export { SkillStepsPlanning } from './planning/skill-steps.js';
export { ReplanOnErrorPlanning } from './planning/replan-on-error.js';
export { SubAgentDispatch } from './dispatch/subagent.js';
export { SelfDispatch } from './dispatch/self.js';
export { HybridDispatch } from './dispatch/hybrid.js';
export { AutoActivation } from './activation/auto.js';
export { ExplicitActivation } from './activation/explicit.js';
```

- [ ] **Step 2: Re-export from package root**

In `packages/llm-agent-libs/src/index.ts` append:

```ts
export * from './coordinator/index.js';
```

(Place alongside other folder-barrel re-exports.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/index.ts packages/llm-agent-libs/src/index.ts
git commit -m "feat(llm-agent-libs): re-export coordinator strategies from package root"
```

---

## Task 10: `CoordinatorHandler` — the glue

**Files:**
- Create: `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`

- [ ] **Step 1: Inspect handler conventions**

Run: `sed -n '1,60p' packages/llm-agent-libs/src/pipeline/handlers/subagent.ts`
Note: how `IStageHandler` is imported, how `PipelineContext` is imported, what `OrchestratorError` looks like, how `sessionLogger?.logStep` is used. The new handler must match this style.

- [ ] **Step 2: Create the handler**

Create `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`:

```ts
import type {
  ICoordinatorConfig,
  ICoordinatorContext,
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
  StepResult,
  ISkillMeta,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export interface CoordinatorHandlerDeps {
  planning: IPlanningStrategy;
  dispatch: IDispatchStrategy;
  maxSteps: number;
  maxRetriesPerStep: number;
  failPolicy: 'abort' | 'continue';
}

export class CoordinatorHandler implements IStageHandler<PipelineContext> {
  constructor(private readonly deps: CoordinatorHandlerDeps) {}

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: unknown,
  ): Promise<boolean> {
    if (!ctx.subAgents) {
      ctx.error = new OrchestratorError(
        'CoordinatorHandler: ctx.subAgents is undefined; pipeline must be built with withSubAgents()',
        'COORDINATOR_NO_REGISTRY',
      );
      return false;
    }
    const coordCtx: ICoordinatorContext = {
      inputText: ctx.inputText,
      systemPrompt: ctx.systemPrompt,
      skillContent: collectSkillContent(ctx),
      registry: ctx.subAgents,
      stepResults: {},
      signal: ctx.options?.signal,
      sessionId: ctx.sessionId,
    };

    let plan: Plan;
    try {
      plan = await this.deps.planning.buildInitialPlan(coordCtx);
    } catch (err) {
      ctx.error = wrapError(err, 'COORDINATOR_PLAN_FAILED');
      return false;
    }
    coordCtx.plan = plan;
    ctx.plan = plan;
    ctx.stepResults = coordCtx.stepResults;
    ctx.options?.sessionLogger?.logStep('coordinator_plan', {
      stepCount: plan.steps.length,
      source: plan.source,
      rationale: plan.rationale,
    });

    let totalSteps = 0;
    while (totalSteps < this.deps.maxSteps) {
      const idx = plan.steps.findIndex((s) => s.status === 'pending');
      if (idx === -1) break;
      const step = plan.steps[idx];
      step.status = 'in_progress';
      ctx.currentStepIdx = idx;
      ctx.options?.sessionLogger?.logStep('coordinator_step_start', {
        stepId: step.id,
        goal: step.goal,
        agent: step.agent,
      });

      let result: StepResult | undefined;
      for (let attempt = 0; attempt <= this.deps.maxRetriesPerStep; attempt++) {
        result = await this.deps.dispatch.dispatch(step, coordCtx);
        if (result.ok) break;
      }
      if (!result) {
        ctx.error = new OrchestratorError(
          `coordinator: dispatch returned no result for step ${step.id}`,
          'COORDINATOR_NO_RESULT',
        );
        return false;
      }
      coordCtx.stepResults[step.id] = result;
      step.status = result.ok ? 'done' : 'failed';
      ctx.options?.sessionLogger?.logStep('coordinator_step_done', {
        stepId: step.id,
        ok: result.ok,
        durationMs: result.durationMs,
        outputLength: result.output.length,
        error: result.error,
      });

      if (!result.ok) {
        if (this.deps.planning.shouldReplan(coordCtx, result)) {
          const remaining = plan.steps.filter((s) => s.status === 'pending');
          plan = await this.deps.planning.rebuildPlan(coordCtx, remaining);
          coordCtx.plan = plan;
          ctx.plan = plan;
          ctx.options?.sessionLogger?.logStep('coordinator_replan', {
            stepCount: plan.steps.length,
          });
        } else if (this.deps.failPolicy === 'abort') {
          ctx.error = new OrchestratorError(
            `coordinator: step ${step.id} failed and failPolicy=abort: ${result.error}`,
            'COORDINATOR_STEP_FAILED',
          );
          return false;
        }
      }

      totalSteps++;
    }

    if (totalSteps >= this.deps.maxSteps) {
      ctx.options?.sessionLogger?.logStep('coordinator_max_steps', {
        maxSteps: this.deps.maxSteps,
      });
    }

    const finalOutput = Object.values(coordCtx.stepResults)
      .map((r) => `### ${r.stepId}\n${r.output}`)
      .join('\n\n');
    ctx.assistantFinal = finalOutput;
    return true;
  }
}

function collectSkillContent(ctx: PipelineContext): string | undefined {
  const selected = (ctx as unknown as { selectedSkills?: Array<{ content?: string }> }).selectedSkills;
  if (!selected || selected.length === 0) return undefined;
  return selected.map((s) => s.content ?? '').join('\n\n');
}

function wrapError(err: unknown, code: string): OrchestratorError {
  if (err instanceof OrchestratorError) return err;
  return new OrchestratorError(err instanceof Error ? err.message : String(err), code);
}

export function activeSkillHasSteps(ctx: PipelineContext): boolean {
  const selected = (ctx as unknown as { selectedSkills?: Array<{ meta?: ISkillMeta }> }).selectedSkills;
  return !!selected?.some((s) => (s.meta?.steps?.length ?? 0) > 0);
}
```

- [ ] **Step 3: Verify ctx.subAgents shape**

Run: `grep -n "subAgents" packages/llm-agent-libs/src/pipeline/context.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts`
The `PipelineContext` may not yet expose `subAgents` directly — it is currently held by `DefaultPipeline` and used by `buildDefaultHandlerRegistry`. If `ctx.subAgents` does not exist, we MUST add it to context now so the handler can read the registry at runtime:

In `packages/llm-agent-libs/src/pipeline/context.ts`, add to `PipelineContext`:

```ts
  /** Subagent registry made available to runtime stages. */
  subAgents?: import('@mcp-abap-adt/llm-agent').SubAgentRegistry;
```

And in `default-pipeline.ts` `_buildContext()` (or wherever the context is constructed at start of `execute`), set:

```ts
  ctx.subAgents = this.subAgents;
```

(Where `this.subAgents` is the registry stored via the constructor in the prior feature.)

If the handler's `OrchestratorError` import path is wrong (the prior feature established it at `../../agent.js`), keep that path.

- [ ] **Step 4: Verify `ctx.assistantFinal` exists or pick the right field name**

Run: `grep -n "assistantFinal\|finalOutput\|response\.text" packages/llm-agent-libs/src/pipeline/context.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts`
The field that downstream stages and `history-upsert` read as the "final assistant message" might be `assistantFinal`, `finalAssistant`, `responseText`, or similar. Match the exact field name; if none exists, add `assistantFinal?: string` to `PipelineContext` and write it.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts packages/llm-agent-libs/src/pipeline/context.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts
git commit -m "feat(llm-agent-libs): add CoordinatorHandler driving plan-execute-replan loop"
```

---

## Task 11: Wire the handler + DefaultPipeline activation swap

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/index.ts`
- Modify: `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`

- [ ] **Step 1: Register `CoordinatorHandler` in the handler registry**

In `packages/llm-agent-libs/src/pipeline/handlers/index.ts`, extend `buildDefaultHandlerRegistry`:

```ts
import type { SubAgentRegistry, IPlanningStrategy, IDispatchStrategy } from '@mcp-abap-adt/llm-agent';
import { CoordinatorHandler, type CoordinatorHandlerDeps } from './coordinator.js';
import { SubAgentHandler } from './subagent.js';

export function buildDefaultHandlerRegistry(opts: {
  subAgents?: SubAgentRegistry;
  coordinator?: CoordinatorHandlerDeps;
} = {}): StageHandlerRegistry {
  const registry = new Map<string, IStageHandler>([
    // ... preserve all existing entries unchanged
    ['classify', new ClassifyHandler()],
    ['summarize', new SummarizeHandler()],
    ['translate', new TranslateHandler()],
    ['expand', new ExpandHandler()],
    ['rag-query', new RagQueryHandler()],
    ['rerank', new RerankHandler()],
    ['skill-select', new SkillSelectHandler()],
    ['build-tool-query', new BuildToolQueryHandler()],
    ['tool-select', new ToolSelectHandler()],
    ['assemble', new AssembleHandler()],
    ['tool-loop', new ToolLoopHandler()],
    ['history-upsert', new HistoryUpsertHandler()],
  ]);
  if (opts.subAgents && opts.subAgents.size > 0) {
    registry.set('subagent', new SubAgentHandler(opts.subAgents));
  }
  if (opts.coordinator) {
    registry.set('coordinator', new CoordinatorHandler(opts.coordinator));
  }
  return registry;
}
```

(The function signature changed from positional `subAgents?:` to an options object. Update the callers next.)

- [ ] **Step 2: Update `DefaultPipeline` constructor and `_buildStages`**

In `packages/llm-agent-libs/src/pipeline/default-pipeline.ts`:

(a) Extend `DefaultPipelineOptions`:

```ts
import type {
  SubAgentRegistry,
  IPlanningStrategy,
  IDispatchStrategy,
  IActivationStrategy,
  ICoordinatorConfig,
} from '@mcp-abap-adt/llm-agent';

export interface DefaultPipelineOptions {
  subAgents?: SubAgentRegistry;
  coordinator?: ICoordinatorConfig;
}
```

(b) In the constructor, change the call to `buildDefaultHandlerRegistry`:

```ts
const handlerRegistry = buildDefaultHandlerRegistry({
  subAgents: this.subAgents,
  coordinator: this.coordinator
    ? {
        planning: this.coordinator.planning!,
        dispatch: this.coordinator.dispatch!,
        maxSteps: this.coordinator.maxSteps ?? 12,
        maxRetriesPerStep: this.coordinator.maxRetriesPerStep ?? 1,
        failPolicy: this.coordinator.failPolicy ?? 'abort',
      }
    : undefined,
});
```

(`this.coordinator` is a new private field — store from `opts.coordinator` in the constructor; the `!` non-null assertions on `planning`/`dispatch` are valid because the activation logic below ensures these are populated before reaching this code — but to be safe, we can throw early if either is missing while coordinator is requested.)

(c) In `_buildStages()`, find the final `stages.push(...)` block that adds `tool-loop` and `history-upsert`. Replace the `tool-loop` entry with a conditional swap:

```ts
import { activeSkillHasSteps } from './handlers/coordinator.js';
// (top of file)

// inside _buildStages(), where tool-loop is currently pushed:
const wantsCoordinator = (() => {
  const hasSubs = !!this.subAgents && this.subAgents.size > 0;
  const activation = this.coordinator?.activation;
  if (!activation) return false;
  return activation.shouldActivate({
    hasSubAgents: hasSubs,
    hasStructuredSkill: false, // ctx-time check happens at runtime; treat as false at build time
  });
})();

stages.push(
  { id: 'tool-select', type: 'tool-select' },
  { id: 'assemble', type: 'assemble' },
  wantsCoordinator
    ? { id: 'coordinator', type: 'coordinator' }
    : { id: 'tool-loop', type: 'tool-loop' },
  { id: 'history-upsert', type: 'history-upsert' },
);
```

If you also want runtime skill-driven activation (a request whose skill has `steps:`), add a `when:` predicate using the existing condition-evaluator — but the evaluator only supports property reads, no method calls, so dynamic skill-step activation is best done by always-keeping-both-stages with `when` predicates. For MVP, build-time activation via `withCoordinator()` is sufficient. Document this trade-off briefly with a `// NOTE: ...` comment that explains the build-time vs. runtime split, no longer than one line.

(d) Update any tests or other callers that pass a positional `subAgents` argument to `buildDefaultHandlerRegistry` — they should now pass `{ subAgents }`. Grep:

Run: `grep -rn "buildDefaultHandlerRegistry" packages/`
Update every call site to pass an options object.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/pipeline/handlers/index.ts packages/llm-agent-libs/src/pipeline/default-pipeline.ts
git commit -m "feat(llm-agent-libs): register CoordinatorHandler and swap tool-loop ↔ coordinator on activation"
```

---

## Task 12: Builder additions — `withCoordinator` and `withSubAgent`

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts`

- [ ] **Step 1: Add fluent setters**

In `packages/llm-agent-libs/src/builder.ts`, alongside the existing `withSubAgents`:

```ts
import type {
  ICoordinatorConfig,
  IPlanningStrategy,
  IDispatchStrategy,
  IActivationStrategy,
  SubAgentRegistry,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentSubAgent } from './subagent/smart-agent-subagent.js';
import {
  AutoActivation,
  OneShotPlanning,
  SubAgentDispatch,
} from './coordinator/index.js';
import type { SmartAgent } from './agent.js';
```

Add private fields next to `_subAgents`:

```ts
  private _coordinator?: ICoordinatorConfig;
```

Add methods (anywhere with the other `with*` methods — preserve their style):

```ts
  withCoordinator(cfg: ICoordinatorConfig = {}): this {
    this._coordinator = {
      planning: cfg.planning,
      dispatch: cfg.dispatch,
      activation: cfg.activation ?? new AutoActivation(),
      plannerLlm: cfg.plannerLlm,
      maxSteps: cfg.maxSteps ?? 12,
      maxRetriesPerStep: cfg.maxRetriesPerStep ?? 1,
      failPolicy: cfg.failPolicy ?? 'abort',
    };
    return this;
  }

  withSubAgent(
    name: string,
    agent: SmartAgent | ISubAgent,
    opts?: { description?: string },
  ): this {
    if (!this._subAgents) this._subAgents = new Map();
    const sub: ISubAgent =
      'run' in agent
        ? agent
        : new SmartAgentSubAgent(name, agent as SmartAgent, { description: opts?.description });
    this._subAgents.set(name, sub);
    return this;
  }
```

In `build()`, when constructing `DefaultPipeline`, plumb both registry and coordinator. The current call (from prior feature) is `new DefaultPipeline({ subAgents: this._subAgents })`. Change to:

```ts
const defaults = this._coordinator
  ? {
      planning: this._coordinator.planning ?? new OneShotPlanning(this._coordinator.plannerLlm ?? this._mainLlm!),
      dispatch: this._coordinator.dispatch ?? new SubAgentDispatch(),
    }
  : undefined;

const pipeline =
  this._pipeline ??
  new DefaultPipeline({
    subAgents: this._subAgents,
    coordinator: this._coordinator
      ? { ...this._coordinator, planning: defaults!.planning, dispatch: defaults!.dispatch }
      : undefined,
  });
```

(Where `this._mainLlm` is whatever field already holds the main LLM in the builder — verify the name by `grep -n '_mainLlm\\|_llm' packages/llm-agent-libs/src/builder.ts`.)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent-libs/src/builder.ts
git commit -m "feat(llm-agent-libs): add SmartAgentBuilder.withCoordinator and withSubAgent sugar"
```

---

## Task 13: YAML loader for `coordinator:` block

**Files:**
- Modify: `packages/llm-agent-server/src/smart-agent/config.ts`

- [ ] **Step 1: Add named-strategy lookup table**

Near the top of `packages/llm-agent-server/src/smart-agent/config.ts` (or in a small new file `packages/llm-agent-server/src/smart-agent/coordinator-strategies.ts` re-exported from config), add:

```ts
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  OneShotPlanning,
  ReplanOnErrorPlanning,
  SubAgentDispatch,
  SelfDispatch,
  HybridDispatch,
  AutoActivation,
  ExplicitActivation,
} from '@mcp-abap-adt/llm-agent-libs';

export function resolvePlanning(name: string, plannerLlm: ILlm) {
  switch (name) {
    case 'one-shot':
      return new OneShotPlanning(plannerLlm);
    case 'replan-on-error':
      return new ReplanOnErrorPlanning(plannerLlm);
    default:
      throw new Error(`Unknown planning strategy: ${name}`);
  }
}

export function resolveDispatch(name: string, fallbackLlm?: ILlm) {
  switch (name) {
    case 'subagent':
      return new SubAgentDispatch();
    case 'self':
      if (!fallbackLlm) throw new Error("dispatch=self requires plannerLlm or mainLlm");
      return new SelfDispatch(fallbackLlm);
    case 'hybrid':
      if (!fallbackLlm) throw new Error("dispatch=hybrid requires plannerLlm or mainLlm");
      return new HybridDispatch(new SubAgentDispatch(), new SelfDispatch(fallbackLlm));
    default:
      throw new Error(`Unknown dispatch strategy: ${name}`);
  }
}

export function resolveActivation(name: string) {
  switch (name) {
    case 'auto':
      return new AutoActivation();
    case 'explicit':
      return new ExplicitActivation();
    default:
      throw new Error(`Unknown activation strategy: ${name}`);
  }
}
```

- [ ] **Step 2: Parse `coordinator:` block in `resolveSmartServerConfig`**

In `resolveSmartServerConfig`, after the `subagents:` block is parsed (so the parent registry is being built), look for `yaml.coordinator` and translate. Add:

```ts
interface YamlCoordinator {
  planning?: string;            // strategy name
  dispatch?: string;            // strategy name
  activation?: string;          // strategy name
  plannerLlm?: 'main' | 'planner';
  maxSteps?: number;
  maxRetriesPerStep?: number;
  failPolicy?: 'abort' | 'continue';
}

const coordCfg = (yaml as { coordinator?: YamlCoordinator }).coordinator;
let coordinatorConfig: ICoordinatorConfig | undefined;
if (coordCfg) {
  // The actual ILlm instances are not built at YAML-resolve time; we hand
  // back string names and let SmartServer.buildAgent() wire concrete LLMs.
  (resolved as unknown as { _coordinatorYaml?: YamlCoordinator })._coordinatorYaml = coordCfg;
}
```

(We stash the YAML coordinator config on the resolved config object under a private field for `smart-server.ts` to consume — that file already has access to the main+planner LLMs at build time, this file does not.)

- [ ] **Step 3: Wire builder in `smart-server.ts`**

In `packages/llm-agent-server/src/smart-agent/smart-server.ts`, where `SmartAgentBuilder` is composed and `withSubAgents(registry)` is already called (from the previous feature), add the coordinator wiring just before `builder.build()`:

```ts
import {
  resolvePlanning,
  resolveDispatch,
  resolveActivation,
} from './config.js';

// ... where the parent builder is composed:
const coordYaml = (config as unknown as { _coordinatorYaml?: YamlCoordinator })._coordinatorYaml;
if (coordYaml) {
  const plannerLlm = coordYaml.plannerLlm === 'main' ? mainLlm : (helperLlm ?? mainLlm);
  builder = builder.withCoordinator({
    planning: resolvePlanning(coordYaml.planning ?? 'one-shot', plannerLlm),
    dispatch: resolveDispatch(coordYaml.dispatch ?? 'subagent', plannerLlm),
    activation: resolveActivation(coordYaml.activation ?? 'auto'),
    plannerLlm,
    maxSteps: coordYaml.maxSteps,
    maxRetriesPerStep: coordYaml.maxRetriesPerStep,
    failPolicy: coordYaml.failPolicy,
  });
}
```

(`mainLlm`/`helperLlm` are local variables in `start()` or wherever the builder is composed — verify the exact identifier names by `grep -n 'mainLlm\|helperLlm\|plannerLlm' packages/llm-agent-server/src/smart-agent/smart-server.ts | head`. Adjust to actual names.)

- [ ] **Step 4: Document the YAML schema**

Find the `YAML_TEMPLATE` constant in `config.ts` and append (near the `subagents:` documentation block added by the prior feature):

```yaml
# coordinator:                         # Optional: enable autonomous plan-execute loop
#   planning: one-shot                 # one-shot | replan-on-error
#   dispatch: subagent                 # subagent | self | hybrid
#   activation: auto                   # auto | explicit
#   plannerLlm: main                   # main | planner — which LLM does the planning
#   maxSteps: 12
#   maxRetriesPerStep: 1
#   failPolicy: abort                  # abort | continue
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-server/src/smart-agent/config.ts packages/llm-agent-server/src/smart-agent/smart-server.ts
git commit -m "feat(llm-agent-server): parse 'coordinator:' YAML block and wire builder strategies"
```

---

## Task 14: End-to-end example + docs

**Files:**
- Create: `docs/examples/coordinator-orchestration.yaml`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Create the example**

Create `docs/examples/coordinator-orchestration.yaml`:

```yaml
# Coordinator orchestration — DeepSeek planner + SAP AI Core specialist agents.
# The coordinator (planner LLM) decomposes the request into steps; each step is
# dispatched to the best-matching subagent. Fails over to self-dispatch when
# no specialist fits.
#
# Prerequisites:
#   1. mcp-abap-adt-proxy on http://127.0.0.1:3001 (if any sub-agent uses MCP).
#   2. DEEPSEEK_API_KEY and AICORE_SERVICE_KEY env variables set.

port: 4004
mode: smart

pipeline:
  llm:
    main:
      provider: sap-ai-sdk
      model: ${SAP_AI_MODEL:-gpt-4o}
      resourceGroup: ${SAP_AI_RESOURCE_GROUP:-default}
      temperature: 0.7
    planner:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
      temperature: 0.1

  mcp:
    - type: http
      url: ${MCP_ENDPOINT:-http://127.0.0.1:3001/mcp/stream/http}

coordinator:
  planning: replan-on-error
  dispatch: hybrid
  activation: auto
  plannerLlm: planner
  maxSteps: 8
  maxRetriesPerStep: 1
  failPolicy: continue

subagents:
  - name: abap-coder
    config: ../../examples/subagents/abap-coder-sap-aicore.yaml
  - name: code-reviewer
    config: ../../examples/subagents/code-reviewer-sap-aicore.yaml
```

- [ ] **Step 2: Document in ARCHITECTURE.md**

In `docs/ARCHITECTURE.md`, locate the existing "Subagent orchestration" subsection (added by the prior feature) and append a new subsection beneath it:

```markdown
## Coordinator orchestration

The `coordinator` stage replaces `tool-loop` (in the same hardcoded
`DefaultPipeline` position) and autonomously walks a multi-step plan. Three
orthogonal strategies are pluggable:

- **`IPlanningStrategy`** — how the plan is built and re-built.
  - `OneShotPlanning` — call planner LLM once, never replan.
  - `SkillStepsPlanning` — use explicit `steps:` from the active skill's frontmatter.
  - `ReplanOnErrorPlanning` — replan when a step fails.
- **`IDispatchStrategy`** — how an individual step is executed.
  - `SubAgentDispatch` — route to a named subagent from the registry.
  - `SelfDispatch` — call the agent's own LLM (no subagent needed).
  - `HybridDispatch` — try a primary, fall back to a secondary.
- **`IActivationStrategy`** — when the coordinator activates at all.
  - `AutoActivation` — activate when subagents exist OR skill has steps.
  - `ExplicitActivation` — require `withCoordinator()` opt-in.

Embedded (programmatic) usage:

```ts
new SmartAgentBuilder()
  .withMainLlm(main)
  .withSubAgent('abap-coder', coderAgent, { description: 'Writes ABAP code.' })
  .withSubAgent('reviewer',   reviewerAgent, { description: 'Reviews code.' })
  .withCoordinator({
    planning: new ReplanOnErrorPlanning(plannerLlm),
    dispatch: new HybridDispatch(new SubAgentDispatch(), new SelfDispatch(main)),
    activation: new AutoActivation(),
  })
  .build();
```

YAML usage:

```yaml
coordinator:
  planning: replan-on-error
  dispatch: hybrid
  activation: auto
  plannerLlm: planner
```

The coordinator does NOT replace `DefaultPipeline`; it is one optional stage
inside it. All earlier stages (classify, rag, tool-select, assemble) still run
and feed the coordinator's planner context.
```

- [ ] **Step 3: Commit**

```bash
git add docs/examples/coordinator-orchestration.yaml docs/ARCHITECTURE.md
git commit -m "docs: coordinator orchestration example and architecture note"
```

---

## Task 15: Smoke verification

**Files:** none (manual run)

- [ ] **Step 1: Clean build**

Run: `npm run clean && npm run build`
Expected: PASS (exit 0).

- [ ] **Step 2: Lint**

Run: `npm run lint:check`
Expected: PASS.

- [ ] **Step 3: Static loader probe**

Without live LLM credentials, verify that the parent and sub-configs parse correctly and the coordinator wiring shows up on the resolved config. Run a one-off Node script (delete after):

```bash
cat > /tmp/coord-probe.mjs <<'EOF'
import {
  loadYamlConfig,
  resolveSmartServerConfig,
} from './packages/llm-agent-server/dist/smart-agent/config.js';
import path from 'node:path';

const cp = path.resolve('docs/examples/coordinator-orchestration.yaml');
const yaml = loadYamlConfig(cp);
const cfg = await resolveSmartServerConfig({}, yaml, process.env, { configPath: cp });
console.log('coordinator yaml:', cfg._coordinatorYaml);
console.log('subagents:', cfg.subAgentConfigs?.map((s) => s.name).join(', '));
EOF
node /tmp/coord-probe.mjs && rm /tmp/coord-probe.mjs
```

Expected: prints both the coordinator block (with `planning: 'replan-on-error'` etc.) and the two subagent names. If the loader rejects something, that is a real bug — fix it.

- [ ] **Step 4: Live run (if any LLM credentials are available)**

If `DEEPSEEK_API_KEY` is present in `.env`, start the agent:

```bash
cp /home/okyslytsia/prj/llm-agent/.env .   # if .env is not in worktree
npx tsx packages/llm-agent-server/src/smart-agent/cli.ts \
  --config docs/examples/coordinator-orchestration.yaml --port 4444 \
  > /tmp/coord-agent.log 2>&1 &
sleep 6
curl -s -X POST http://127.0.0.1:4444/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Create an ABAP report Z_HELLO_WORLD that prints Hello World, then review it."}],"stream":false}' \
  --max-time 180 | tee /tmp/coord-out.json
```

Expected:
- `smart-server.log` shows `coordinator_plan` event followed by `coordinator_step_start` and `coordinator_step_done` events — at least one per planned step.
- Final response body is a concatenation of step outputs (the coordinator's `assistantFinal`).
- If `subagents:` is non-empty and `dispatch: hybrid` is set, at least one step is dispatched to `abap-coder` (visible in `coordinator_step_done` event with `agent` field).

Stop the agent:

```bash
pkill -f 'cli.ts.*coordinator-orchestration' || true
rm -f /tmp/coord-agent.log /tmp/coord-out.json
```

- [ ] **Step 5: No commit unless changes were needed**

If a source-file fix was required during smoke, commit it with a `fix(coordinator): ...` message. Otherwise do not commit anything for this task.

---

## Testing Notes

This repo has no unit-test framework today (`npm run test` is `build + start`). The verifications above are therefore:

1. `npm run build` catches contract regressions across packages.
2. `npm run lint:check` catches style/unused-import regressions.
3. Task 15 Step 3 static loader probe verifies YAML→config translation.
4. Task 15 Step 4 live run (if creds available) verifies the full plan-execute path emits the expected session-log events.

When a test harness is added later, the highest-value tests for this feature are:
- `OneShotPlanning` against a stubbed `ILlm` that returns a canned JSON plan; assert step parsing and `source === 'planner-llm'`.
- `SkillStepsPlanning` against a stubbed skill-meta resolver; assert `steps` round-trip from frontmatter to `PlanStep[]`.
- `SubAgentDispatch` against a fake `ISubAgent`; assert error path when agent missing and OK path when present.
- `CoordinatorHandler.execute()` end-to-end with fake strategies; assert `ctx.plan` and `ctx.stepResults` populated, `assistantFinal` concatenated, log events emitted in order.

---

## Out of Scope (Future Work)

- **Replan-each-step** (`ReflectAndReplan` strategy) — implement once `ReplanOnErrorPlanning` is proven.
- **Plan visualization / streaming events** to the SSE response so clients see step-by-step progress in real time. Today the response is the final concatenation; intermediate `coordinator_step_done` events live only in `smart-server.log`.
- **Parallel step execution** when the planner declares non-dependent steps. Today execution is sequential.
- **Cross-step context filtering** — the `SelfDispatch` and `SubAgentDispatch` currently pass *all* prior `stepResults` as context. A future strategy may select only relevant prior results.
- **Skill-driven runtime activation** — `AutoActivation` currently checks for structured skills at build time only (the `_buildStages()` is invoked once at startup). A future enhancement could re-evaluate per request; this requires extending the condition-evaluator with method-call support OR introducing a runtime "select-stage" mechanism.
- **Stable plan IDs / replay** — assign plan IDs and store plans for replay/debugging.
- **Auth / quota per step** — currently subagents share parent credentials; later we may want per-step LLM budget limits.
