# Nested Subagent Dispatch — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll back the briefing API, add typed subagent capabilities + layer plumbing + plan validation, introduce the context-builder and DirectLlmSubAgent, propagate layers across nested dispatch, and add the minimal epicfail primitive — producing a working nested-dispatch substrate at depth 0→1 with depth 0→1→2 opt-in.

**Architecture:** Spec at `docs/superpowers/specs/2026-05-22-nested-subagent-dispatch-design.md` is authoritative. Five phases (rollback → capabilities → context-builder+DirectLlmSubAgent → nested propagation → epicfail). Tasks proceed phase-by-phase; each is TDD-shaped (failing test → minimal impl → green → commit).

**Tech Stack:** TypeScript (ESM, strict), `node:test`, `node:assert/strict`, Biome for lint/format. No new runtime dependencies. Monorepo packages affected: `@mcp-abap-adt/llm-agent` (contracts), `@mcp-abap-adt/llm-agent-libs` (composition).

---

## File Structure

**Created:**
- `packages/llm-agent/src/interfaces/subagent-context.ts` — `ISubAgentContextBuilder`, request/result types.
- `packages/llm-agent-libs/src/subagent/default-context-builder.ts` — Reference impl of the context builder.
- `packages/llm-agent-libs/src/subagent/__tests__/default-context-builder.test.ts`
- `packages/llm-agent-libs/src/subagent/direct-llm-subagent.ts` — Constrained leaf-node subagent.
- `packages/llm-agent-libs/src/subagent/__tests__/direct-llm-subagent.test.ts`
- `packages/llm-agent-libs/src/coordinator/__tests__/plan-validation.test.ts`
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-layer-validation.test.ts`
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-epicfail.test.ts`

**Modified:**
- `packages/llm-agent/src/interfaces/subagent.ts` — Remove IBriefing/IBriefingArtifact and `briefing?`; add `SubAgentKind`, `SubAgentCapabilities`, `capabilities` on ISubAgent; add `layer`, `context?` on ISubAgentInput; add `errorClass?`, `epicFailTrace?` on ISubAgentResult.
- `packages/llm-agent/src/interfaces/index.ts` — Update exports.
- `packages/llm-agent/src/interfaces/coordinator.ts` — Add `layer?` to ICoordinatorContext; add `maxLayer?` to ICoordinatorConfig; add `EpicFailTrace`.
- `packages/llm-agent/src/interfaces/types.ts` — Add `layer?` to CallOptions.
- `packages/llm-agent-libs/src/pipeline/context.ts` — Add `layer?` to PipelineContext.
- `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts` — Read layer from ctx; pass to ICoordinatorContext; add validation gate; add `maxLayer` to CoordinatorHandlerDeps; emit epicfail trace when child step result has epicfail.
- `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts` — Remove briefing wiring; call context-builder; pass `layer + 1`; propagate epicfail.
- `packages/llm-agent-libs/src/coordinator/dispatch/self.ts` — Restore inline preamble (rollback of formatBriefing usage).
- `packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts` — Propagate epicfail without transformation.
- `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` — Remove formatBriefing usage; pass `input.layer` to `agent.process({ layer })`; emit `epicFailTrace` on caught errors at depth ≥ 1.
- `packages/llm-agent-libs/src/agent.ts` — `SmartAgent.process()` reads `options.layer` and threads into PipelineContext.
- `packages/llm-agent-libs/src/index.ts` — Remove `formatBriefing`/`buildBriefingFromContext` exports; add `DirectLlmSubAgent`, `DefaultSubAgentContextBuilder`.
- `docs/INTEGRATION.md` — Remove "Subagent briefing" subsection; add "Nested dispatch and DirectLlmSubAgent" subsection.
- `CHANGELOG.md` — Replace briefing-related Unreleased entries with nested-dispatch entries.

**Deleted:**
- `packages/llm-agent-libs/src/subagent/format-briefing.ts`
- `packages/llm-agent-libs/src/subagent/__tests__/format-briefing.test.ts`
- `packages/llm-agent-libs/src/coordinator/briefing.ts`
- `packages/llm-agent-libs/src/coordinator/__tests__/briefing.test.ts`
- `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/subagent-briefing.test.ts`
- `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/self-briefing.test.ts`
- `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-briefing-deadend.test.ts`

---

## Phase 1: Rollback PR #132

### Task 1: Delete briefing files

**Files:**
- Delete: `packages/llm-agent-libs/src/subagent/format-briefing.ts`
- Delete: `packages/llm-agent-libs/src/subagent/__tests__/format-briefing.test.ts`
- Delete: `packages/llm-agent-libs/src/coordinator/briefing.ts`
- Delete: `packages/llm-agent-libs/src/coordinator/__tests__/briefing.test.ts`
- Delete: `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/subagent-briefing.test.ts`
- Delete: `packages/llm-agent-libs/src/coordinator/dispatch/__tests__/self-briefing.test.ts`
- Delete: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-briefing-deadend.test.ts`

- [ ] **Step 1: Remove the 7 files**

```bash
cd /home/okyslytsia/prj/llm-agent/.claude/worktrees/subagent-briefing
git rm \
  packages/llm-agent-libs/src/subagent/format-briefing.ts \
  packages/llm-agent-libs/src/subagent/__tests__/format-briefing.test.ts \
  packages/llm-agent-libs/src/coordinator/briefing.ts \
  packages/llm-agent-libs/src/coordinator/__tests__/briefing.test.ts \
  packages/llm-agent-libs/src/coordinator/dispatch/__tests__/subagent-briefing.test.ts \
  packages/llm-agent-libs/src/coordinator/dispatch/__tests__/self-briefing.test.ts \
  packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-briefing-deadend.test.ts
```

- [ ] **Step 2: Verify deletion**

Run: `git status --short | head`
Expected: 7 `D` lines for the deleted files.

- [ ] **Step 3: Do NOT commit yet** — Task 2 will revert briefing references in non-deleted files; combined commit at the end of Task 2 keeps the rollback atomic.

---

### Task 2: Revert briefing references in remaining files

**Files:**
- Modify: `packages/llm-agent/src/interfaces/subagent.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`
- Modify: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/self.ts`
- Modify: `packages/llm-agent-libs/src/index.ts`
- Modify: `docs/INTEGRATION.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Restore `packages/llm-agent/src/interfaces/subagent.ts`**

Replace the file contents EXACTLY with the pre-briefing version:

```typescript
import type { LlmToolCall, LlmUsage } from './types.js';

export interface ISubAgentInput {
  task: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ISubAgentResult {
  output: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
  metadata?: Record<string, unknown>;
}

export interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
```

Removes `IBriefing`, `IBriefingArtifact`, the `briefing?` field, and their JSDoc. (Phase 2 will reintroduce a different `context?: string` field and `capabilities`; this revert restores the pre-briefing baseline first.)

- [ ] **Step 2: Restore `packages/llm-agent/src/interfaces/index.ts`**

Find the subagent re-export block and remove `IBriefing`, `IBriefingArtifact` entries:

```typescript
export type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentRegistry,
} from './subagent.js';
```

- [ ] **Step 3: Restore `SmartAgentSubAgent.run`**

Replace `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts` EXACTLY with:

```typescript
import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  LlmToolCall,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';

export class SmartAgentSubAgent implements ISubAgent {
  public readonly description?: string;

  constructor(
    public readonly name: string,
    private readonly agent: SmartAgent,
    opts?: { description?: string },
  ) {
    this.description = opts?.description;
  }

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const res = await this.agent.process(input.task, {
      sessionId: input.sessionId,
      signal: input.signal,
    });

    if (!res.ok) {
      throw res.error;
    }

    const { content, toolCalls, usage } = res.value;

    const mappedToolCalls: LlmToolCall[] | undefined = toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      output: content,
      toolCalls: mappedToolCalls,
      usage: usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
    };
  }
}
```

- [ ] **Step 4: Restore `SubAgentDispatch`**

Replace `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts` EXACTLY with:

```typescript
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { resolveTemplate } from '../../util/template.js';

export class SubAgentDispatch implements IDispatchStrategy {
  readonly name = 'subagent';

  async dispatch(
    step: PlanStep,
    ctx: ICoordinatorContext,
  ): Promise<StepResult> {
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

- [ ] **Step 5: Restore `SelfDispatch`**

Replace `packages/llm-agent-libs/src/coordinator/dispatch/self.ts` EXACTLY with the pre-formatBriefing version:

```typescript
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  ILlm,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

export class SelfDispatch implements IDispatchStrategy {
  readonly name = 'self';

  constructor(
    private readonly llm: ILlm,
    private readonly systemPrompt?: string,
  ) {}

  async dispatch(
    step: PlanStep,
    ctx: ICoordinatorContext,
  ): Promise<StepResult> {
    const sys =
      this.systemPrompt ??
      ctx.systemPrompt ??
      'You are an autonomous agent. Complete the user-assigned step concisely.';
    const priorBlock =
      Object.values(ctx.stepResults)
        .map((r) => `- ${r.stepId}: ${r.output.slice(0, 300)}`)
        .join('\n') || '(none)';
    const userMsg = `Current step: ${step.goal}\n\nResults so far:\n${priorBlock}`;

    const started = Date.now();
    try {
      const res = await this.llm.chat(
        [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg },
        ],
        [],
        { signal: ctx.signal, sessionId: ctx.sessionId },
      );
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

- [ ] **Step 6: Remove briefing exports from `packages/llm-agent-libs/src/index.ts`**

Find and DELETE these two lines (search for them):
```typescript
export { buildBriefingFromContext } from './coordinator/briefing.js';
export { formatBriefing } from './subagent/format-briefing.js';
```

Leave the rest of the file untouched.

- [ ] **Step 7: Remove briefing subsection from `docs/INTEGRATION.md`**

Open `docs/INTEGRATION.md`, locate the `### Subagent briefing` subsection (under `## Subagent orchestration & Coordinator`), and DELETE the entire subsection — from the `### Subagent briefing` heading down to (but not including) the next `### ` heading. The whole removed block was added in commit `5fdbe58` and is the canonical-briefing-format documentation.

- [ ] **Step 8: Remove briefing entries from `CHANGELOG.md`**

Open `CHANGELOG.md`, find the `## [Unreleased]` section (added in commit `5fdbe58`), and DELETE the entire Unreleased section (heading, `### Added` block, `### Changed` block, and the trailing `---` separator). Leave `## [12.1.1]` and below untouched.

- [ ] **Step 9: Build to verify type integrity**

Run: `npm run clean && npm run build`
Expected: clean across all 15 packages. No TS errors.

- [ ] **Step 10: Run tests**

Run: `npm --prefix packages/llm-agent-libs test` and `npm --prefix packages/llm-agent-server test`
Expected: `llm-agent-libs` returns to **342 pass / 0 fail** (the pre-briefing baseline). `llm-agent-server` remains **40 pass / 0 fail**.

If any test fails because it referenced briefing types or formatBriefing — that test belongs to the rolled-back work and should also be deleted as part of this rollback. Re-run after deletion.

- [ ] **Step 11: Lint**

Run: `npm run lint:check`
Expected: clean.

- [ ] **Step 12: Commit the entire rollback as ONE atomic commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
revert: roll back PR #132 briefing implementation

Removes IBriefing/IBriefingArtifact interfaces, briefing field on
ISubAgentInput, formatBriefing/buildBriefingFromContext helpers, and all
associated wiring in SmartAgentSubAgent / SubAgentDispatch / SelfDispatch,
along with the related tests and documentation entries.

Briefing as a structured context channel is superseded by the nested
subagent dispatch design at docs/superpowers/specs/2026-05-22-nested-
subagent-dispatch-design.md, which uses an explicit context builder and
the IDispatchStrategy/context-as-string contract instead.

This is a clean rollback to the pre-briefing baseline; subsequent commits
in this branch introduce the new design.
EOF
)"
```

---

## Phase 2: Capabilities + Layer Plumbing + Plan Validation

### Task 3: Add SubAgentKind and SubAgentCapabilities types

**Files:**
- Modify: `packages/llm-agent/src/interfaces/subagent.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`

- [ ] **Step 1: Extend `subagent.ts` with capability types and contract changes**

Replace the file contents EXACTLY with:

```typescript
import type { LlmToolCall, LlmUsage } from './types.js';

/**
 * High-level subagent execution model.
 *
 * - `autonomous`: runs the full SmartAgent pipeline (own RAG, MCP, skills,
 *   classifier, optional CoordinatorHandler). At layer 0 it may dispatch
 *   children; at deeper layers it must not.
 * - `constrained`: a leaf-node subagent that performs a single LLM call
 *   over injected context. Never dispatches children.
 */
export type SubAgentKind = 'autonomous' | 'constrained';

/**
 * Typed metadata that the planner/validator can read without invoking the
 * agent. Used to enforce layer rules and to decide whether to call the
 * context builder before dispatch.
 */
export interface SubAgentCapabilities {
  kind: SubAgentKind;
  /** Whether this agent is allowed to dispatch child subagents from inside its own plan. */
  canDispatchChildren: boolean;
  /**
   * Context handling expectations:
   * - 'required': dispatch must populate `input.context`; missing context is an error.
   * - 'optional': context is treated as preamble if present.
   * - 'forbidden': context must be omitted; the agent ignores any value passed.
   */
  contextPolicy: 'required' | 'optional' | 'forbidden';
}

/**
 * Minimal epicfail trace surfaced from a child subagent. The full Phase 2
 * trace shape (with class-based attempts) lives in @mcp-abap-adt/llm-agent
 * coordinator interfaces; see `EpicFailTrace`.
 */
export interface ISubAgentInput {
  task: string;
  /** Assembled context preamble (required when capabilities.contextPolicy === 'required'). */
  context?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Dispatch depth. Root is 0; each dispatch increments by 1. */
  layer: number;
}

export interface ISubAgentResult {
  output: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
  metadata?: Record<string, unknown>;
  /**
   * When set to 'epicfail', the parent coordinator must not retry/replan.
   * It propagates the trace upward unchanged (appending its own frame).
   */
  errorClass?: 'epicfail';
  /** Diagnostic trace populated when errorClass === 'epicfail'. */
  epicFailTrace?: import('./coordinator.js').EpicFailTrace;
}

export interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  readonly capabilities: SubAgentCapabilities;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
```

- [ ] **Step 2: Update `interfaces/index.ts`**

Add `SubAgentKind`, `SubAgentCapabilities` to the subagent re-export block:

```typescript
export type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  SubAgentCapabilities,
  SubAgentKind,
  SubAgentRegistry,
} from './subagent.js';
```

- [ ] **Step 3: Add `capabilities` to existing implementations**

In `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`, add a `capabilities` field after `description`:

```typescript
export class SmartAgentSubAgent implements ISubAgent {
  public readonly description?: string;
  public readonly capabilities: SubAgentCapabilities = {
    kind: 'autonomous',
    canDispatchChildren: true,
    contextPolicy: 'optional',
  };

  constructor(
    public readonly name: string,
    private readonly agent: SmartAgent,
    opts?: { description?: string },
  ) {
    this.description = opts?.description;
  }

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const prompt =
      input.context && input.context.length > 0
        ? `${input.context}\n\n${input.task}`
        : input.task;
    const res = await this.agent.process(prompt, {
      sessionId: input.sessionId,
      signal: input.signal,
    });
    // … rest unchanged from Task 2 Step 3
  }
}
```

Add the `SubAgentCapabilities` import to the file:

```typescript
import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  LlmToolCall,
  SubAgentCapabilities,
} from '@mcp-abap-adt/llm-agent';
```

- [ ] **Step 4: Update tests that construct subagents**

Search test files for `new SmartAgentSubAgent(`:

```bash
grep -rn "new SmartAgentSubAgent\|implements ISubAgent" packages/llm-agent-libs/src --include='*.ts'
```

For each in-test `ISubAgent`-implementing class (e.g. `CapturingSubAgent`, `ScriptedSubAgent`, etc. — they were used in PR #128 / #129 tests which remain after rollback), add a `capabilities` field:

```typescript
readonly capabilities: SubAgentCapabilities = {
  kind: 'autonomous',
  canDispatchChildren: false,
  contextPolicy: 'optional',
};
```

(Test fixtures don't need full SmartAgent wrap, so `canDispatchChildren: false` is fine — the planner won't actually dispatch from them.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean. (TypeScript will catch missing `capabilities` on any ISubAgent implementation; fix each as it surfaces.)

- [ ] **Step 6: Test**

Run: `npm --prefix packages/llm-agent-libs test`
Expected: all tests pass (no behavioral change yet; capabilities is metadata-only at this point).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(llm-agent): add SubAgentKind, SubAgentCapabilities, and required capabilities on ISubAgent"
```

---

### Task 4: Add `layer` plumbing through CallOptions and PipelineContext

**Files:**
- Modify: `packages/llm-agent/src/interfaces/types.ts`
- Modify: `packages/llm-agent/src/interfaces/coordinator.ts`
- Modify: `packages/llm-agent-libs/src/pipeline/context.ts`
- Modify: `packages/llm-agent-libs/src/agent.ts`

- [ ] **Step 1: Add `layer?` to CallOptions**

In `packages/llm-agent/src/interfaces/types.ts`, locate the `CallOptions` interface (around line 23) and add a `layer` field:

```typescript
export interface CallOptions {
  trace?: TraceContext;
  sessionId?: string;
  userId?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  model?: string;
  ragFilter?: {
    namespace?: string;
    userId?: string;
    sessionId?: string;
    [key: string]: unknown;
  };
  sessionLogger?: {
    logStep(name: string, data: unknown): void;
  };
  /**
   * Dispatch depth for nested subagent execution. Root consumer-facing
   * calls default to 0. SmartAgentSubAgent passes `input.layer + 1` when
   * forwarding to a child SmartAgent.
   */
  layer?: number;
}
```

- [ ] **Step 2: Add `layer?` to ICoordinatorContext**

In `packages/llm-agent/src/interfaces/coordinator.ts`, add `layer?` to `ICoordinatorContext`:

```typescript
export interface ICoordinatorContext {
  inputText: string;
  systemPrompt?: string;
  skillContent?: string;
  activeSkillMeta?: ISkillMeta;
  registry: SubAgentRegistry;
  plan?: Plan;
  stepResults: Record<string, StepResult>;
  signal?: AbortSignal;
  sessionId: string;
  /** Dispatch depth: 0 at the root, +1 per nested dispatch. */
  layer?: number;
}
```

- [ ] **Step 3: Add `maxLayer?` to ICoordinatorConfig**

In the same file, add `maxLayer?` to `ICoordinatorConfig`:

```typescript
export interface ICoordinatorConfig {
  planning?: IPlanningStrategy;
  dispatch?: IDispatchStrategy;
  activation?: IActivationStrategy;
  plannerLlm?: ILlm;
  maxSteps?: number;
  maxRetriesPerStep?: number;
  failPolicy?: 'abort' | 'continue';
  /**
   * Maximum dispatch depth from this coordinator. Default 1: the
   * coordinator may dispatch children (layer 1), but those children
   * may not dispatch further unless they raise maxLayer themselves.
   */
  maxLayer?: number;
}
```

- [ ] **Step 4: Add `EpicFailTrace` to coordinator interfaces**

In the same `coordinator.ts`, add at the end:

```typescript
/**
 * Trace frame for nested-dispatch failures. The parent appends its own
 * frame and passes the result upward without other transformation.
 */
export interface EpicFailTrace {
  layer: number;
  stepId: string;
  agentName: string;
  attempts: Array<{
    kind: 'transient' | 'replan' | 'hint';
    error: string;
    durationMs: number;
  }>;
  originalError: string;
  childTrace?: EpicFailTrace;
}
```

Add `EpicFailTrace` to `interfaces/index.ts` re-exports (subagent.ts already references `EpicFailTrace` from coordinator via the relative `./coordinator.js` import).

- [ ] **Step 5: Add `layer?` to PipelineContext**

In `packages/llm-agent-libs/src/pipeline/context.ts`, locate the "Coordinator / subagent orchestration" section near the end and add `layer?`:

```typescript
  // -- Coordinator / subagent orchestration ----------------------------------

  /** Dispatch depth. 0 at root; +1 each nested SmartAgent.process() call. */
  layer?: number;
  subResults?: Record<string, unknown>;
  subAgents?: SubAgentRegistry;
  coordinatorActive?: boolean;
  plan?: Plan;
  currentStepIdx?: number;
  stepResults?: Record<string, StepResult>;
}
```

- [ ] **Step 6: Read `options.layer` in `SmartAgent.process()`**

In `packages/llm-agent-libs/src/agent.ts`, find where the `PipelineContext` is constructed (search for `assembledMessages: []` or `inputText`). At that construction site, add:

```typescript
const ctx: PipelineContext = {
  // ... existing fields ...
  layer: options?.layer ?? 0,
  // ... rest ...
};
```

If there are multiple construction sites (`process` and `stream`), update both.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Test**

Run: `npm --prefix packages/llm-agent-libs test`
Expected: 342 pass / 0 fail. No behavior change yet — layer is plumbed but no validator consumes it.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(llm-agent): plumb layer through CallOptions, ICoordinatorContext, PipelineContext"
```

---

### Task 5: Plan validation gate in CoordinatorHandler

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`
- Create: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-layer-validation.test.ts`

- [ ] **Step 1: Write failing test for layer validation**

Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-layer-validation.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  ISubAgent,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import {
  CoordinatorHandler,
  type CoordinatorHandlerDeps,
} from '../coordinator.js';

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeSubAgent(
  name: string,
  kind: 'autonomous' | 'constrained',
): ISubAgent {
  return {
    name,
    capabilities: {
      kind,
      canDispatchChildren: kind === 'autonomous',
      contextPolicy: kind === 'constrained' ? 'required' : 'optional',
    },
    async run() {
      return { output: 'ok' };
    },
  };
}

function makePlanning(steps: PlanStep[]): IPlanningStrategy {
  return {
    name: 'fake',
    async buildInitialPlan() {
      return {
        steps: steps.map((s) => ({ ...s })),
        rationale: 'test',
        createdAt: 0,
        source: 'manual',
      } as Plan;
    },
    shouldReplan() {
      return false;
    },
    async rebuildPlan() {
      return { steps: [], rationale: '', createdAt: 0, source: 'manual' };
    },
  };
}

function makeDispatch(): IDispatchStrategy {
  return {
    name: 'fake-dispatch',
    async dispatch(step: PlanStep): Promise<StepResult> {
      return {
        stepId: step.id,
        output: `out-${step.id}`,
        ok: true,
        durationMs: 1,
      };
    },
  };
}

function makeCtx(opts: {
  layer: number;
  subAgents: Map<string, ISubAgent>;
}): { ctx: PipelineContext; chunks: Array<{ content?: string }> } {
  const chunks: Array<{ content?: string }> = [];
  const ctx = {
    inputText: 'do',
    sessionId: 't',
    layer: opts.layer,
    assembledMessages: [],
    options: { signal: undefined },
    subAgents: opts.subAgents,
    yield(chunk: { ok: boolean; value?: { content?: string } }) {
      if (chunk.ok && chunk.value) chunks.push(chunk.value);
    },
  } as unknown as PipelineContext;
  return { ctx, chunks };
}

function makeDeps(
  planning: IPlanningStrategy,
  dispatch: IDispatchStrategy,
  maxLayer: number,
): CoordinatorHandlerDeps {
  return {
    planning,
    dispatch,
    maxSteps: 8,
    maxRetriesPerStep: 0,
    failPolicy: 'abort',
    maxLayer,
  };
}

describe('CoordinatorHandler layer validation', () => {
  it('allows autonomous subagents at layer 0', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['auto', makeSubAgent('auto', 'autonomous')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'auto', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 0, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 1),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.equal(ctx.error, undefined);
  });

  it('rejects a plan that targets an autonomous subagent at layer >= 1', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['auto', makeSubAgent('auto', 'autonomous')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'auto', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 1, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 2),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, false);
    assert.ok(ctx.error);
    assert.match(
      String(ctx.error?.message ?? ''),
      /layer 1.*autonomous|autonomous.*layer 1/i,
    );
  });

  it('allows constrained subagents at any layer below maxLayer', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['c', makeSubAgent('c', 'constrained')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'c', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 1, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 2),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.equal(ctx.error, undefined);
  });

  it('rejects any dispatch when layer >= maxLayer', async () => {
    const subAgents = new Map<string, ISubAgent>([
      ['c', makeSubAgent('c', 'constrained')],
    ]);
    const planning = makePlanning([
      { id: 's1', goal: 'g', agent: 'c', status: 'pending' },
    ]);
    const { ctx } = makeCtx({ layer: 2, subAgents });
    const handler = new CoordinatorHandler(
      makeDeps(planning, makeDispatch(), 2),
    );
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, false);
    assert.ok(ctx.error);
    assert.match(
      String(ctx.error?.message ?? ''),
      /maxLayer|depth limit|cannot dispatch/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern="layer validation"`
Expected: FAIL — `CoordinatorHandlerDeps` does not yet have `maxLayer`, OR validation isn't enforced.

- [ ] **Step 3: Add `maxLayer` to `CoordinatorHandlerDeps` and implement validation**

In `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`:

a) Extend `CoordinatorHandlerDeps`:
```typescript
export interface CoordinatorHandlerDeps {
  planning: IPlanningStrategy;
  dispatch: IDispatchStrategy;
  maxSteps: number;
  maxRetriesPerStep: number;
  failPolicy: 'abort' | 'continue';
  /** Maximum dispatch depth. Default 1. */
  maxLayer: number;
}
```

b) Add a validation method after `execute` (before `// helpers` block, or right at the bottom of the class):

```typescript
private validatePlan(
  plan: Plan,
  layer: number,
  registry: SubAgentRegistry,
  maxLayer: number,
): string | undefined {
  if (layer >= maxLayer) {
    return `Coordinator at layer ${layer} cannot dispatch (maxLayer=${maxLayer}).`;
  }
  for (const step of plan.steps) {
    if (!step.agent) continue;
    const sub = registry.get(step.agent);
    if (!sub) continue; // dispatcher reports a clean StepResult later
    if (layer >= 1 && sub.capabilities.kind === 'autonomous') {
      return `Step '${step.id}' targets autonomous subagent '${step.agent}' but layer ${layer} only allows constrained subagents.`;
    }
  }
  return undefined;
}
```

c) Call the validator immediately after planning succeeds, inside `execute`:

```typescript
coordCtx.plan = plan;
ctx.plan = plan;
ctx.stepResults = coordCtx.stepResults;

// Validate plan against layer rules BEFORE executing any step.
const validationError = this.validatePlan(
  plan,
  ctx.layer ?? 0,
  registry,
  this.deps.maxLayer,
);
if (validationError) {
  ctx.error = wrapError(new Error(validationError), 'COORDINATOR_LAYER_VIOLATION');
  return false;
}
```

d) Thread the layer into `coordCtx`:

```typescript
const coordCtx: ICoordinatorContext = {
  inputText: ctx.inputText,
  systemPrompt: collectSystemPrompt(ctx),
  skillContent: collectSkillContent(ctx),
  activeSkillMeta: collectActiveSkillMeta(ctx),
  registry,
  stepResults: {},
  signal: ctx.options?.signal,
  sessionId: ctx.sessionId,
  layer: ctx.layer ?? 0,
};
```

- [ ] **Step 4: Update other places that construct `CoordinatorHandlerDeps`**

Search for `new CoordinatorHandler(`:
```bash
grep -rn "new CoordinatorHandler\|CoordinatorHandlerDeps" packages/llm-agent-libs/src --include='*.ts'
```

For each call site (including `DefaultPipeline._buildStages` and existing tests), ensure `maxLayer` is provided. Default it to `1` when reading from `ICoordinatorConfig.maxLayer ?? 1`.

- [ ] **Step 5: Run the failing test**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern="layer validation"`
Expected: all 4 cases PASS.

- [ ] **Step 6: Run full suite**

Run: `npm --prefix packages/llm-agent-libs test`
Expected: 346 pass / 0 fail (was 342; +4 from this task).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(llm-agent-libs): plan validation gate enforces layer/capability rules in CoordinatorHandler"
```

---

## Phase 3: Context Builder + DirectLlmSubAgent

### Task 6: Define `ISubAgentContextBuilder` interface in `@mcp-abap-adt/llm-agent`

**Files:**
- Create: `packages/llm-agent/src/interfaces/subagent-context.ts`
- Modify: `packages/llm-agent/src/interfaces/index.ts`

- [ ] **Step 1: Create the interface file**

Create `packages/llm-agent/src/interfaces/subagent-context.ts` with:

```typescript
import type { PlanStep } from './coordinator.js';
import type { ISubAgent } from './subagent.js';

/**
 * Inputs to a single context-build invocation. Provided by the dispatcher
 * before it calls `ISubAgent.run()`.
 */
export interface SubAgentContextRequest {
  task: string;
  step: PlanStep;
  agent: ISubAgent;
  layer: number;
  inputText: string;
  sessionId: string;
  signal?: AbortSignal;
}

/**
 * Output of a context-build invocation. `context` is the bounded textual
 * preamble injected as `ISubAgentInput.context`. `sources` lists where each
 * fragment came from for observability/debugging.
 */
export interface SubAgentContextResult {
  context: string;
  sources: Array<{ kind: 'rag' | 'tool-rag' | 'artifact'; ref: string }>;
}

/**
 * Builds the `context` string passed to a subagent.
 *
 * Implementations should:
 * - Query relevant RAG stores using the current task.
 * - Query MCP-RAG/tool-description stores if available.
 * - Fetch exact artifacts only when the planner emitted refs.
 * - Bound the final context by token budget.
 * - NOT include arbitrary prior `stepResults`.
 */
export interface ISubAgentContextBuilder {
  build(req: SubAgentContextRequest): Promise<SubAgentContextResult>;
}
```

- [ ] **Step 2: Re-export from `interfaces/index.ts`**

Add to `interfaces/index.ts`:

```typescript
export type {
  ISubAgentContextBuilder,
  SubAgentContextRequest,
  SubAgentContextResult,
} from './subagent-context.js';
```

- [ ] **Step 3: Build**

Run: `npm --prefix packages/llm-agent run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/llm-agent/src/interfaces/subagent-context.ts packages/llm-agent/src/interfaces/index.ts
git commit -m "feat(llm-agent): add ISubAgentContextBuilder interface and request/result types"
```

---

### Task 7: Implement `DefaultSubAgentContextBuilder` (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/subagent/default-context-builder.ts`
- Create: `packages/llm-agent-libs/src/subagent/__tests__/default-context-builder.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/llm-agent-libs/src/subagent/__tests__/default-context-builder.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IRag,
  ISubAgent,
  PlanStep,
  RagResult,
  Result,
  SubAgentContextRequest,
} from '@mcp-abap-adt/llm-agent';
import { DefaultSubAgentContextBuilder } from '../default-context-builder.js';

function makeRag(results: RagResult[]): IRag {
  return {
    name: 'fake',
    async retrieve(_query: string): Promise<Result<RagResult[], Error>> {
      return { ok: true, value: results };
    },
    async upsert() {
      return { ok: true, value: undefined } as Result<void, Error>;
    },
  } as unknown as IRag;
}

function makeAgent(): ISubAgent {
  return {
    name: 'worker',
    capabilities: {
      kind: 'constrained',
      canDispatchChildren: false,
      contextPolicy: 'required',
    },
    async run() {
      return { output: 'ok' };
    },
  };
}

function makeReq(overrides: Partial<SubAgentContextRequest> = {}): SubAgentContextRequest {
  const step: PlanStep = { id: 's1', goal: 'do the thing', status: 'pending' };
  return {
    task: 'do the thing',
    step,
    agent: makeAgent(),
    layer: 1,
    inputText: 'user request',
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('DefaultSubAgentContextBuilder', () => {
  it('returns empty context and empty sources when no RAGs are configured', async () => {
    const builder = new DefaultSubAgentContextBuilder({});
    const res = await builder.build(makeReq());
    assert.equal(res.context, '');
    assert.deepEqual(res.sources, []);
  });

  it('includes project RAG snippets when projectRag is provided', async () => {
    const builder = new DefaultSubAgentContextBuilder({
      projectRag: makeRag([
        {
          content: 'TokenManager handles JWT refresh',
          score: 0.9,
          metadata: { path: 'src/auth/token.ts' },
        },
      ]),
    });
    const res = await builder.build(makeReq());
    assert.match(res.context, /TokenManager handles JWT refresh/);
    assert.deepEqual(res.sources, [
      { kind: 'rag', ref: 'src/auth/token.ts' },
    ]);
  });

  it('includes tool-RAG snippets after project RAG', async () => {
    const builder = new DefaultSubAgentContextBuilder({
      projectRag: makeRag([
        { content: 'project fact', score: 0.9, metadata: { path: 'a.ts' } },
      ]),
      toolRag: makeRag([
        {
          content: 'get_artifact(name) → string',
          score: 0.8,
          metadata: { tool: 'get_artifact' },
        },
      ]),
    });
    const res = await builder.build(makeReq());
    assert.match(res.context, /project fact[\s\S]+get_artifact/);
    assert.deepEqual(res.sources, [
      { kind: 'rag', ref: 'a.ts' },
      { kind: 'tool-rag', ref: 'get_artifact' },
    ]);
  });

  it('bounds context by maxContextChars', async () => {
    const longContent = 'x'.repeat(2000);
    const builder = new DefaultSubAgentContextBuilder({
      projectRag: makeRag([
        { content: longContent, score: 0.9, metadata: { path: 'big.ts' } },
      ]),
      maxContextChars: 500,
    });
    const res = await builder.build(makeReq());
    assert.ok(res.context.length <= 500 + 32);
  });

  it('skips RAG calls when the agent has contextPolicy=forbidden', async () => {
    const agent: ISubAgent = {
      ...makeAgent(),
      capabilities: {
        kind: 'autonomous',
        canDispatchChildren: false,
        contextPolicy: 'forbidden',
      },
    };
    const builder = new DefaultSubAgentContextBuilder({
      projectRag: makeRag([
        { content: 'should not appear', score: 0.9, metadata: { path: 'x.ts' } },
      ]),
    });
    const res = await builder.build(makeReq({ agent }));
    assert.equal(res.context, '');
    assert.deepEqual(res.sources, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern=DefaultSubAgentContextBuilder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DefaultSubAgentContextBuilder`**

Create `packages/llm-agent-libs/src/subagent/default-context-builder.ts`:

```typescript
import type {
  IRag,
  ISubAgentContextBuilder,
  RagResult,
  SubAgentContextRequest,
  SubAgentContextResult,
} from '@mcp-abap-adt/llm-agent';

export interface DefaultSubAgentContextBuilderConfig {
  projectRag?: IRag;
  toolRag?: IRag;
  topKProject?: number;
  topKTool?: number;
  maxContextChars?: number;
}

const DEFAULT_TOP_K_PROJECT = 3;
const DEFAULT_TOP_K_TOOL = 3;
const DEFAULT_MAX_CHARS = 4000;

/**
 * Builds subagent context by querying project RAG, then tool-RAG. Skips
 * RAG queries entirely when the agent's contextPolicy is 'forbidden'.
 * Bounds the final context by character budget (cheap proxy for tokens).
 */
export class DefaultSubAgentContextBuilder implements ISubAgentContextBuilder {
  constructor(private readonly config: DefaultSubAgentContextBuilderConfig) {}

  async build(req: SubAgentContextRequest): Promise<SubAgentContextResult> {
    if (req.agent.capabilities.contextPolicy === 'forbidden') {
      return { context: '', sources: [] };
    }

    const sources: SubAgentContextResult['sources'] = [];
    const parts: string[] = [];

    const topKProject = this.config.topKProject ?? DEFAULT_TOP_K_PROJECT;
    const topKTool = this.config.topKTool ?? DEFAULT_TOP_K_TOOL;
    const maxChars = this.config.maxContextChars ?? DEFAULT_MAX_CHARS;

    if (this.config.projectRag) {
      const res = await this.config.projectRag.retrieve(req.task);
      if (res.ok) {
        const top = res.value.slice(0, topKProject);
        for (const r of top) {
          parts.push(r.content);
          sources.push({
            kind: 'rag',
            ref: this.refOf(r, 'path') ?? 'unknown',
          });
        }
      }
    }

    if (this.config.toolRag) {
      const res = await this.config.toolRag.retrieve(req.task);
      if (res.ok) {
        const top = res.value.slice(0, topKTool);
        for (const r of top) {
          parts.push(r.content);
          sources.push({
            kind: 'tool-rag',
            ref: this.refOf(r, 'tool') ?? 'unknown',
          });
        }
      }
    }

    let context = parts.join('\n\n');
    if (context.length > maxChars) {
      context = `${context.slice(0, maxChars)}…`;
    }

    return { context, sources };
  }

  private refOf(r: RagResult, key: string): string | undefined {
    const meta = r.metadata as Record<string, unknown> | undefined;
    const value = meta?.[key];
    return typeof value === 'string' ? value : undefined;
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern=DefaultSubAgentContextBuilder`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/subagent/default-context-builder.ts packages/llm-agent-libs/src/subagent/__tests__/default-context-builder.test.ts
git commit -m "feat(llm-agent-libs): add DefaultSubAgentContextBuilder querying project RAG and tool-RAG"
```

---

### Task 8: Implement `DirectLlmSubAgent` (TDD)

**Files:**
- Create: `packages/llm-agent-libs/src/subagent/direct-llm-subagent.ts`
- Create: `packages/llm-agent-libs/src/subagent/__tests__/direct-llm-subagent.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/llm-agent-libs/src/subagent/__tests__/direct-llm-subagent.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, Message, Result } from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../direct-llm-subagent.js';

class CapturingLlm {
  capturedMessages?: Message[];
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  async chat(messages: Message[]): Promise<Result<any, Error>> {
    this.capturedMessages = messages;
    return {
      ok: true,
      value: { content: 'response', usage: undefined, toolCalls: [] },
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  async *stream(): AsyncGenerator<any> {}
}

describe('DirectLlmSubAgent', () => {
  it('declares constrained capabilities', () => {
    const llm = new CapturingLlm() as unknown as ILlm;
    const sub = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: 'You are a code reviewer.',
    });
    assert.equal(sub.capabilities.kind, 'constrained');
    assert.equal(sub.capabilities.canDispatchChildren, false);
    assert.equal(sub.capabilities.contextPolicy, 'required');
  });

  it('uses systemPrompt + context + task as messages', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('reviewer', llm as unknown as ILlm, {
      systemPrompt: 'You are a code reviewer.',
    });

    const res = await sub.run({
      task: 'Review this snippet',
      context: 'function foo() { return 42; }',
      sessionId: 'sess-1',
      layer: 2,
    });

    assert.equal(res.output, 'response');
    assert.ok(llm.capturedMessages);
    assert.equal(llm.capturedMessages?.length, 2);
    assert.equal(llm.capturedMessages?.[0].role, 'system');
    assert.match(
      String(llm.capturedMessages?.[0].content),
      /You are a code reviewer/,
    );
    assert.equal(llm.capturedMessages?.[1].role, 'user');
    assert.match(
      String(llm.capturedMessages?.[1].content),
      /function foo[\s\S]+Review this snippet/,
    );
  });

  it('errors when context is missing and contextPolicy is required', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('reviewer', llm as unknown as ILlm, {
      systemPrompt: 'sys',
    });

    await assert.rejects(
      () =>
        sub.run({
          task: 'do',
          sessionId: 's',
          layer: 1,
        }),
      /context.*required/i,
    );
  });

  it('allows missing context when contextPolicy is optional', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('flex', llm as unknown as ILlm, {
      systemPrompt: 'sys',
      contextPolicy: 'optional',
    });

    const res = await sub.run({
      task: 'do the thing',
      sessionId: 's',
      layer: 1,
    });

    assert.equal(res.output, 'response');
    assert.equal(llm.capturedMessages?.[1].role, 'user');
    assert.equal(llm.capturedMessages?.[1].content, 'do the thing');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern=DirectLlmSubAgent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DirectLlmSubAgent`**

Create `packages/llm-agent-libs/src/subagent/direct-llm-subagent.ts`:

```typescript
import type {
  ILlm,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  Message,
  SubAgentCapabilities,
} from '@mcp-abap-adt/llm-agent';

export interface DirectLlmSubAgentOptions {
  systemPrompt: string;
  description?: string;
  contextPolicy?: 'required' | 'optional' | 'forbidden';
}

/**
 * A leaf-node subagent that performs one LLM chat call over the provided
 * (system prompt + context + task). No RAG, no MCP, no tool-loop, no skills.
 *
 * `contextPolicy` defaults to 'required' — most use cases for the constrained
 * type expect the orchestrator to inject relevant material. Set 'optional'
 * for cases where the task is self-contained.
 */
export class DirectLlmSubAgent implements ISubAgent {
  public readonly description?: string;
  public readonly capabilities: SubAgentCapabilities;
  private readonly systemPrompt: string;

  constructor(
    public readonly name: string,
    private readonly llm: ILlm,
    opts: DirectLlmSubAgentOptions,
  ) {
    this.description = opts.description;
    this.systemPrompt = opts.systemPrompt;
    this.capabilities = {
      kind: 'constrained',
      canDispatchChildren: false,
      contextPolicy: opts.contextPolicy ?? 'required',
    };
  }

  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    if (
      this.capabilities.contextPolicy === 'required' &&
      (!input.context || input.context.length === 0)
    ) {
      throw new Error(
        `DirectLlmSubAgent '${this.name}': context is required but was not provided`,
      );
    }

    const userContent =
      input.context && input.context.length > 0
        ? `${input.context}\n\n${input.task}`
        : input.task;

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userContent },
    ];

    const res = await this.llm.chat(messages, [], {
      signal: input.signal,
      sessionId: input.sessionId,
    });
    if (!res.ok) {
      throw res.error;
    }

    return {
      output: res.value.content,
      usage: res.value.usage,
    };
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern=DirectLlmSubAgent`
Expected: 4/4 PASS.

- [ ] **Step 5: Re-export from package**

Add to `packages/llm-agent-libs/src/index.ts`:

```typescript
export {
  DefaultSubAgentContextBuilder,
  type DefaultSubAgentContextBuilderConfig,
} from './subagent/default-context-builder.js';
export {
  DirectLlmSubAgent,
  type DirectLlmSubAgentOptions,
} from './subagent/direct-llm-subagent.js';
```

(Place these in the existing SubAgent adapters block.)

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(llm-agent-libs): add DirectLlmSubAgent constrained leaf subagent and re-export"
```

---

### Task 9: Wire context builder into `SubAgentDispatch`

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`

- [ ] **Step 1: Inject optional context builder**

Modify the `SubAgentDispatch` constructor to accept an optional `ISubAgentContextBuilder`:

```typescript
import type {
  ICoordinatorContext,
  IDispatchStrategy,
  ISubAgentContextBuilder,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { resolveTemplate } from '../../util/template.js';

export class SubAgentDispatch implements IDispatchStrategy {
  readonly name = 'subagent';

  constructor(
    private readonly contextBuilder?: ISubAgentContextBuilder,
  ) {}

  async dispatch(
    step: PlanStep,
    ctx: ICoordinatorContext,
  ): Promise<StepResult> {
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

    const childLayer = (ctx.layer ?? 0) + 1;

    let context: string | undefined;
    if (this.contextBuilder) {
      const built = await this.contextBuilder.build({
        task,
        step,
        agent: sub,
        layer: childLayer,
        inputText: ctx.inputText,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
      context = built.context.length > 0 ? built.context : undefined;
    }

    // Hard requirement: contextPolicy=required must have context populated.
    if (
      sub.capabilities.contextPolicy === 'required' &&
      (context === undefined || context.length === 0)
    ) {
      return {
        stepId: step.id,
        output: '',
        durationMs: 0,
        ok: false,
        error: `SubAgentDispatch: subagent '${agentName}' has contextPolicy=required but builder produced empty context`,
      };
    }

    const started = Date.now();
    try {
      const res = await sub.run({
        task,
        context,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        layer: childLayer,
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

- [ ] **Step 2: Build + run all tests**

Run: `npm run build && npm --prefix packages/llm-agent-libs test`
Expected: 350 pass / 0 fail (was 346; +4 from DefaultSubAgentContextBuilder).

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts
git commit -m "feat(llm-agent-libs): SubAgentDispatch calls ISubAgentContextBuilder and enforces contextPolicy"
```

---

## Phase 4: Nested Dispatch Propagation

### Task 10: Pass `layer + 1` from `SmartAgentSubAgent` into the child `SmartAgent`

**Files:**
- Modify: `packages/llm-agent-libs/src/subagent/smart-agent-subagent.ts`

- [ ] **Step 1: Update `SmartAgentSubAgent.run` to thread `input.layer + 1` through**

The current implementation (after Tasks 2+3) calls `this.agent.process(prompt, { sessionId, signal })`. Add `layer`:

```typescript
async run(input: ISubAgentInput): Promise<ISubAgentResult> {
  const prompt =
    input.context && input.context.length > 0
      ? `${input.context}\n\n${input.task}`
      : input.task;

  const res = await this.agent.process(prompt, {
    sessionId: input.sessionId,
    signal: input.signal,
    layer: input.layer + 1,
  });

  if (!res.ok) {
    throw res.error;
  }

  // ... rest unchanged
}
```

The child SmartAgent's `process` reads `options.layer` (added in Task 4 Step 6) and writes it into its PipelineContext, so the child's CoordinatorHandler (if any) will see the correct layer.

- [ ] **Step 2: Write a focused test for layer propagation**

Add a new test file `packages/llm-agent-libs/src/subagent/__tests__/smart-agent-subagent-layer.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent, SmartAgentResponse } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

class FakeAgent {
  capturedLayer?: number;
  async process(
    _prompt: string,
    options?: { layer?: number },
  ): Promise<Result<SmartAgentResponse, Error>> {
    this.capturedLayer = options?.layer;
    return {
      ok: true,
      value: { content: 'out', toolCalls: [], usage: undefined } as unknown as SmartAgentResponse,
    };
  }
}

describe('SmartAgentSubAgent layer propagation', () => {
  it('passes input.layer + 1 to the wrapped SmartAgent', async () => {
    const inner = new FakeAgent();
    const sub = new SmartAgentSubAgent('w', inner as unknown as SmartAgent);
    await sub.run({ task: 't', layer: 1 });
    assert.equal(inner.capturedLayer, 2);
  });

  it('starts at layer 1 for root dispatch (input.layer === 0)', async () => {
    const inner = new FakeAgent();
    const sub = new SmartAgentSubAgent('w', inner as unknown as SmartAgent);
    await sub.run({ task: 't', layer: 0 });
    assert.equal(inner.capturedLayer, 1);
  });
});
```

- [ ] **Step 3: Run targeted tests**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern="layer propagation"`
Expected: 2/2 PASS.

- [ ] **Step 4: Run full suite**

Run: `npm --prefix packages/llm-agent-libs test`
Expected: 352 pass / 0 fail (+2 from this task).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(llm-agent-libs): SmartAgentSubAgent propagates layer + 1 to wrapped SmartAgent.process"
```

---

## Phase 5: Epicfail Primitive

### Task 11: Propagate epicfail through dispatch strategies

**Files:**
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`
- Modify: `packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts`
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`
- Create: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-epicfail.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/llm-agent-libs/src/pipeline/handlers/__tests__/coordinator-epicfail.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  EpicFailTrace,
  IDispatchStrategy,
  IPlanningStrategy,
  ISubAgent,
  ISubAgentInput,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../../tracer/types.js';
import { SubAgentDispatch } from '../../../coordinator/dispatch/subagent.js';
import type { PipelineContext } from '../../context.js';
import {
  CoordinatorHandler,
  type CoordinatorHandlerDeps,
} from '../coordinator.js';

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

class EpicFailingSubAgent implements ISubAgent {
  readonly name = 'failer';
  readonly capabilities = {
    kind: 'autonomous' as const,
    canDispatchChildren: false,
    contextPolicy: 'optional' as const,
  };
  async run(input: ISubAgentInput) {
    const trace: EpicFailTrace = {
      layer: input.layer,
      stepId: 'inner-step',
      agentName: 'inner-failer',
      attempts: [],
      originalError: 'unrecoverable inner error',
    };
    return {
      output: '',
      errorClass: 'epicfail' as const,
      epicFailTrace: trace,
    };
  }
}

function makePlanning(steps: PlanStep[]): IPlanningStrategy {
  return {
    name: 'fake',
    async buildInitialPlan() {
      return {
        steps: steps.map((s) => ({ ...s })),
        rationale: 'test',
        createdAt: 0,
        source: 'manual',
      } as Plan;
    },
    shouldReplan() {
      return false;
    },
    async rebuildPlan() {
      return { steps: [], rationale: '', createdAt: 0, source: 'manual' };
    },
  };
}

function makeCtx(subAgents: Map<string, ISubAgent>): PipelineContext {
  return {
    inputText: 'top',
    sessionId: 's',
    layer: 0,
    assembledMessages: [],
    options: { signal: undefined },
    subAgents,
    yield() {},
  } as unknown as PipelineContext;
}

describe('Coordinator epicfail propagation', () => {
  it('marks the step ok=false with the child trace surfaced and stops the plan', async () => {
    const failer = new EpicFailingSubAgent();
    const subAgents = new Map<string, ISubAgent>([['failer', failer]]);
    const planning = makePlanning([
      { id: 's1', goal: 'attempt', agent: 'failer', status: 'pending' },
      { id: 's2', goal: 'after', agent: 'failer', status: 'pending' },
    ]);
    const dispatch: IDispatchStrategy = new SubAgentDispatch();
    const deps: CoordinatorHandlerDeps = {
      planning,
      dispatch,
      maxSteps: 5,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
      maxLayer: 2,
    };
    const handler = new CoordinatorHandler(deps);
    const ctx = makeCtx(subAgents);

    const ok = await handler.execute(ctx, {}, makeSpan());

    assert.equal(ok, false);
    const s1 = ctx.stepResults?.s1;
    assert.ok(s1);
    assert.equal(s1?.ok, false);
    assert.match(String(s1?.error ?? ''), /epicfail/i);
    // s2 must NOT have been dispatched (abort on epicfail)
    assert.equal(ctx.stepResults?.s2, undefined);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern="epicfail propagation"`
Expected: FAIL — current dispatch logic treats `errorClass: 'epicfail'` as a regular successful result with empty output.

- [ ] **Step 3: Update `SubAgentDispatch` to surface epicfail**

In `packages/llm-agent-libs/src/coordinator/dispatch/subagent.ts`, after the `sub.run` call:

```typescript
const res = await sub.run({
  task,
  context,
  sessionId: ctx.sessionId,
  signal: ctx.signal,
  layer: childLayer,
});

// Epicfail propagation: do NOT retry, do NOT transform.
if (res.errorClass === 'epicfail') {
  return {
    stepId: step.id,
    output: '',
    durationMs: Date.now() - started,
    ok: false,
    error: `epicfail from '${agentName}': ${res.epicFailTrace?.originalError ?? 'unknown'}`,
  };
}

return {
  stepId: step.id,
  output: res.output,
  toolCalls: res.toolCalls,
  usage: res.usage,
  durationMs: Date.now() - started,
  ok: true,
};
```

- [ ] **Step 4: Update `HybridDispatch` to pass-through epicfail**

In `packages/llm-agent-libs/src/coordinator/dispatch/hybrid.ts`, `HybridDispatch` already delegates to primary/fallback. Inspect each call's `StepResult.ok === false && error.startsWith('epicfail')`. If so, do NOT fall through to fallback. Add this guard:

```typescript
async dispatch(
  step: PlanStep,
  ctx: ICoordinatorContext,
): Promise<StepResult> {
  const needsFallback = !step.agent || !ctx.registry.has(step.agent);
  if (needsFallback) {
    return this.fallback.dispatch(step, ctx);
  }
  const result = await this.primary.dispatch(step, ctx);
  // Epicfail from primary is terminal — do not try fallback.
  if (!result.ok && typeof result.error === 'string' && result.error.startsWith('epicfail')) {
    return result;
  }
  return result;
}
```

(The `if (!result.ok ...)` block is a no-op behaviorally — both branches return `result` — but it's a documentation anchor; remove the redundant block if Biome complains, leaving only the comment as a top-of-method block-doc.)

- [ ] **Step 5: Update `CoordinatorHandler` to abort on epicfail regardless of failPolicy**

In `packages/llm-agent-libs/src/pipeline/handlers/coordinator.ts`, find the step-execution loop. After a step result is recorded, add:

```typescript
const stepResult = await this.deps.dispatch.dispatch(step, coordCtx);
coordCtx.stepResults[step.id] = stepResult;
// Epicfail short-circuits the entire plan, regardless of failPolicy.
if (
  !stepResult.ok &&
  typeof stepResult.error === 'string' &&
  stepResult.error.startsWith('epicfail')
) {
  ctx.error = wrapError(
    new Error(stepResult.error),
    'COORDINATOR_EPICFAIL',
  );
  return false;
}
// ... existing failPolicy handling continues
```

- [ ] **Step 6: Run targeted test**

Run: `npm --prefix packages/llm-agent-libs test -- --test-name-pattern="epicfail propagation"`
Expected: PASS.

- [ ] **Step 7: Run full suite**

Run: `npm --prefix packages/llm-agent-libs test`
Expected: 353 pass / 0 fail (+1 from this task).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(llm-agent-libs): propagate epicfail through dispatch strategies and abort plan on epicfail"
```

---

## Phase 6: Documentation + Final Verification

### Task 12: Documentation updates

**Files:**
- Modify: `docs/INTEGRATION.md` (add "Nested dispatch" subsection)
- Modify: `CHANGELOG.md` (re-add Unreleased with new entries)

- [ ] **Step 1: Add subsection to `docs/INTEGRATION.md`**

Locate the `## Subagent orchestration & Coordinator` section. After the existing `### ISubAgent contract` subsection (or equivalent input description), append:

````markdown
### Nested dispatch and DirectLlmSubAgent

`ISubAgent` now carries `capabilities: SubAgentCapabilities` declaring its
`kind` (`'autonomous'` or `'constrained'`), `canDispatchChildren`, and
`contextPolicy`. The Coordinator's plan validator uses these fields to
reject plans that violate layer rules.

**Layer rules (default `maxLayer: 1`):**

- Root coordinator (layer 0) may dispatch any subagent type.
- A subagent dispatched at layer >= 1 may target only `constrained`
  subagents — never `autonomous`.
- Coordinator at layer >= `maxLayer` cannot dispatch at all and must
  execute through its normal pipeline.

**Two subagent implementations ship in the box:**

- `SmartAgentSubAgent` (autonomous) wraps a full `SmartAgent`. It has
  `capabilities.kind = 'autonomous'`, `canDispatchChildren = true`,
  `contextPolicy = 'optional'`. Use it when the subagent needs its own
  RAG/MCP/skills/system prompt.
- `DirectLlmSubAgent` (constrained) performs one LLM call over injected
  context. `capabilities.kind = 'constrained'`, `canDispatchChildren =
  false`, `contextPolicy = 'required'` by default. Use it for judgment/
  synthesis steps where the orchestrator already has the materials.

**Context assembly**: `ISubAgentContextBuilder` is the orthogonal
component that produces the `context` string injected on each dispatch.
The default `DefaultSubAgentContextBuilder` queries project RAG, then
tool-RAG, with a bounded character budget. Custom builders can be
constructed and passed to `SubAgentDispatch`.

**Epicfail**: when a subagent returns `errorClass: 'epicfail'` (or
throws from inside a child layer), the Coordinator does NOT retry or
replan. It records the step as failed and aborts the plan immediately.
The `EpicFailTrace` on the result carries the chain for diagnostics.
````

- [ ] **Step 2: Re-add `CHANGELOG.md` Unreleased section**

Replace the (now empty) area above `## [12.1.1]` with:

```markdown
## [Unreleased]

### Added
- `SubAgentKind`, `SubAgentCapabilities` types in `@mcp-abap-adt/llm-agent`. Every `ISubAgent` must now declare `capabilities`.
- `ISubAgentContextBuilder` interface and `DefaultSubAgentContextBuilder` implementation. The dispatcher builds bounded `context` from project RAG + tool-RAG before each subagent invocation.
- `DirectLlmSubAgent` — a constrained leaf-node subagent that runs one LLM call over injected context. No RAG, MCP, or recursion.
- `layer: number` on `ISubAgentInput`, `CallOptions`, `PipelineContext`, and `ICoordinatorContext`. Threads dispatch depth through nested calls.
- `maxLayer?` on `ICoordinatorConfig` (default 1). Plan validation rejects plans that violate layer rules — autonomous subagents are forbidden at layer >= 1.
- Minimal epicfail primitive: `errorClass: 'epicfail'` + `EpicFailTrace` on `ISubAgentResult`. Coordinator aborts the plan on epicfail regardless of `failPolicy`.

### Changed
- `ISubAgent`, `ISubAgentInput`, `ISubAgentResult` shape: `capabilities` is required; `layer` is required on inputs; `context?: string` replaces the previous `briefing` mechanism (rolled back from PR #132).
- `SubAgentDispatch` constructor now accepts an optional `ISubAgentContextBuilder`. Dispatched subagents receive `layer = parent + 1`.
- `SmartAgentSubAgent.run` passes `layer + 1` into the wrapped `SmartAgent.process()` so nested coordinators see the right depth.

### Removed
- `IBriefing` / `IBriefingArtifact` interfaces (rolled back from PR #132).
- `formatBriefing`, `buildBriefingFromContext` helpers (rolled back from PR #132).
- All briefing wiring in dispatch strategies (rolled back from PR #132).

---
```

- [ ] **Step 3: Commit**

```bash
git add docs/INTEGRATION.md CHANGELOG.md
git commit -m "docs: nested subagent dispatch — INTEGRATION.md subsection and CHANGELOG Unreleased entries"
```

---

### Task 13: Final verification

- [ ] **Step 1: Clean build**

Run from repo root:
```bash
npm run clean && npm run build
```
Expected: clean across all 15 packages.

- [ ] **Step 2: Lint**

Run: `npm run lint:check`
Expected: clean.

- [ ] **Step 3: All tests across affected packages**

```bash
npm --prefix packages/llm-agent-libs test
npm --prefix packages/llm-agent-server test
```
Expected: `llm-agent-libs` ≥ 353 / 0 fail (was 342 baseline; +11 from Tasks 5, 7, 8, 10, 11). `llm-agent-server` ≥ 40 / 0 fail.

- [ ] **Step 4: Smoke CLI**

Run: `npm run dev:llm`
Type a trivial prompt. Expected: agent responds. The new code paths (capabilities, context builder, layer plumbing, epicfail) are dormant unless a coordinator is configured — backwards-compat verified.

- [ ] **Step 5: Self-review checklist**

Verify before declaring done:
- `SmartAgentSubAgent.capabilities.kind === 'autonomous'`, `canDispatchChildren === true`, `contextPolicy === 'optional'`.
- `DirectLlmSubAgent` default `capabilities` are constrained / no-dispatch / required-context.
- `layer` defaults to 0 in PipelineContext when not provided.
- `CoordinatorHandlerDeps.maxLayer` defaults to 1 at construction sites.
- Plan validation rejects autonomous subagents at layer >= 1 AND rejects ALL dispatch when layer >= maxLayer.
- `SubAgentDispatch` calls context builder when one is configured AND respects `contextPolicy: 'required'`.
- `DirectLlmSubAgent.run` throws when context required but missing.
- Epicfail short-circuits the plan and surfaces to `ctx.error` as `COORDINATOR_EPICFAIL`.
- No file still references `formatBriefing`, `buildBriefingFromContext`, `IBriefing`, `IBriefingArtifact`, or `briefing` on input — verify with grep:

  ```bash
  grep -rn "formatBriefing\|buildBriefingFromContext\|IBriefing\|IBriefingArtifact\|\\bbriefing\\b" packages docs CHANGELOG.md
  ```
  Expected: no hits (or only this checklist's own grep command).

- [ ] **Step 6: Delete this plan file per repo policy**

```bash
git rm docs/superpowers/plans/2026-05-22-nested-subagent-dispatch-foundation.md
git commit -m "chore(docs): remove implemented nested-subagent-dispatch-foundation plan"
```

---

## Self-Review

**Spec coverage:**
- ✅ Rollback of PR #132 — Task 1, 2.
- ✅ `SubAgentKind`, `SubAgentCapabilities` on `ISubAgent` — Task 3.
- ✅ `layer` on `ISubAgentInput`, `CallOptions`, `ICoordinatorContext`, `PipelineContext` — Task 4.
- ✅ `maxLayer` on `ICoordinatorConfig` / `CoordinatorHandlerDeps`, validation gate — Task 5.
- ✅ `ISubAgentContextBuilder` interface + default implementation — Task 6, 7.
- ✅ `DirectLlmSubAgent` — Task 8.
- ✅ `SubAgentDispatch` calls context builder + passes `layer + 1` — Task 9.
- ✅ `SmartAgentSubAgent` propagates layer to inner `SmartAgent.process()` — Task 10.
- ✅ Epicfail primitive: `errorClass`, `EpicFailTrace`, propagation through dispatch strategies, coordinator-level short-circuit — Task 11.
- ✅ Docs (INTEGRATION + CHANGELOG) — Task 12.
- ✅ Verification + cleanup — Task 13.

**Placeholder scan:** no TBDs. Every code block is complete. Every command is exact.

**Type consistency:**
- `SubAgentCapabilities` shape consistent across Tasks 3, 7, 8 — `kind`, `canDispatchChildren`, `contextPolicy`.
- `ISubAgentInput.layer` (number, required) consistent across Tasks 3, 8, 9, 10, 11.
- `EpicFailTrace.originalError` (string) consistent across Tasks 4, 11.
- `maxLayer` lives on both `ICoordinatorConfig` (Task 4) and `CoordinatorHandlerDeps` (Task 5) — caller code defaults from config to deps.

**Out of scope (separate plans, per spec):**
- Phase 6 of spec: Full error policy (ErrorClass enum with `transient`/`orchestrator-fault`/`consumer-fault`/`subagent-fault`/`configuration-fault`, retry budgets, LLM-judge).
- Phase 7 of spec: Parallel dispatch.
- Built-in artifact MCP package for thin clients.
