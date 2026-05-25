/**
 * CoordinatorHandler — plan-execute-replan loop driving autonomous
 * multi-step orchestration over the SubAgent registry.
 *
 * Reads:  `ctx.subAgents`, `ctx.inputText`, `ctx.selectedSkills`,
 *         `ctx.skillContent`, `ctx.assembledMessages` (for system prompt).
 * Writes: `ctx.plan`, `ctx.currentStepIdx`, `ctx.stepResults`, and emits the
 *         final concatenated output via `ctx.yield()` as the assistant
 *         response (followed by a `stop` chunk), since the pipeline streams
 *         results to consumers rather than buffering a final string field.
 *
 * NOTE: Coordinator replaces the tool-loop stage when activated. The
 * `ctx.yield`-based streaming contract is preserved so downstream SSE
 * consumers see the response as a normal stream.
 */

import type {
  ICoordinatorContext,
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
  StepResult,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export interface CoordinatorHandlerDeps {
  planning: IPlanningStrategy;
  dispatch: IDispatchStrategy;
  maxSteps: number;
  maxRetriesPerStep: number;
  failPolicy: 'abort' | 'continue';
  /** Maximum dispatch depth. Default 1. */
  maxLayer: number;
}

export class CoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: CoordinatorHandlerDeps) {}

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
      if (!sub) continue;
      if (layer >= 1 && sub.capabilities.kind === 'autonomous') {
        return `Step '${step.id}' targets autonomous subagent '${step.agent}' but layer ${layer} only allows constrained subagents.`;
      }
    }
    return undefined;
  }

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    // Normalise registry to an empty Map when no subagents are registered.
    // SelfDispatch and other registry-free strategies must still run; the
    // SubAgentDispatch strategy itself reports a clean StepResult when an
    // unknown agent is requested, so we don't need a global gate here.
    const registry: SubAgentRegistry = ctx.subAgents ?? new Map();

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

    // Clarification gate: the planner decided the request is too ambiguous to
    // plan. Stream the question and dispatch nothing — the Coordinator asking
    // back, not a subagent failing on empty material.
    if (plan.clarification) {
      ctx.options?.sessionLogger?.logStep('coordinator_clarification', {
        length: plan.clarification.length,
      });
      ctx.yield({ ok: true, value: { content: plan.clarification } });
      ctx.yield({
        ok: true,
        value: { content: '', finishReason: 'stop' },
      });
      return true;
    }

    // Validate plan against layer rules BEFORE executing any step.
    const validationError = this.validatePlan(
      plan,
      ctx.layer ?? 0,
      registry,
      this.deps.maxLayer,
    );
    if (validationError) {
      ctx.error = new OrchestratorError(
        validationError,
        'COORDINATOR_LAYER_VIOLATION',
      );
      return false;
    }

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
        // Epicfail is terminal — never retry it.
        if (result.epicFailTrace) break;
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

      // Epicfail short-circuits the entire plan, regardless of failPolicy.
      if (result.epicFailTrace) {
        ctx.error = new OrchestratorError(
          `coordinator: step ${step.id} returned epicfail: ${result.error ?? 'unknown'}`,
          'COORDINATOR_EPICFAIL',
        );
        return false;
      }

      if (!result.ok) {
        if (this.deps.planning.shouldReplan(coordCtx, result)) {
          const remaining = plan.steps.filter((s) => s.status === 'pending');
          try {
            plan = await this.deps.planning.rebuildPlan(coordCtx, remaining);
          } catch (err) {
            ctx.error = wrapError(err, 'COORDINATOR_REPLAN_FAILED');
            return false;
          }
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

    const hasPending = plan.steps.some((s) => s.status === 'pending');
    const truncatedByLimit = totalSteps >= this.deps.maxSteps && hasPending;
    const failedSteps = plan.steps.filter((s) => s.status === 'failed');

    if (truncatedByLimit) {
      ctx.options?.sessionLogger?.logStep('coordinator_max_steps', {
        maxSteps: this.deps.maxSteps,
        pendingCount: plan.steps.filter((s) => s.status === 'pending').length,
      });
    }

    const stepBlocks = Object.values(coordCtx.stepResults)
      .map((r) => `### ${r.stepId}\n${r.output}`)
      .join('\n\n');

    const completionNote = (() => {
      if (truncatedByLimit) {
        const pending = plan.steps.filter((s) => s.status === 'pending').length;
        return `\n\n_[Coordinator: max steps (${this.deps.maxSteps}) reached, ${pending} step(s) still pending.]_`;
      }
      if (failedSteps.length > 0 && this.deps.failPolicy === 'continue') {
        return `\n\n_[Coordinator: ${failedSteps.length} step(s) failed under failPolicy=continue.]_`;
      }
      return '';
    })();

    const finalOutput = stepBlocks + completionNote;

    ctx.options?.sessionLogger?.logStep('coordinator_final', {
      stepCount: Object.keys(coordCtx.stepResults).length,
      outputLength: finalOutput.length,
      truncated: truncatedByLimit,
      failedSteps: failedSteps.length,
    });

    // Stream the final output as a single content chunk followed by a finish
    // chunk. Mirrors tool-loop's contract so SSE consumers see a normal
    // assistant response, but uses finishReason: 'length' when the plan was
    // truncated by maxSteps — matching OpenAI's convention for limit-cut
    // responses so clients can detect incompleteness.
    ctx.yield({ ok: true, value: { content: finalOutput } });
    ctx.yield({
      ok: true,
      value: {
        content: '',
        finishReason: truncatedByLimit ? 'length' : 'stop',
      },
    });

    return true;
  }
}

function collectSystemPrompt(ctx: PipelineContext): string | undefined {
  const first = ctx.assembledMessages?.[0];
  if (first && first.role === 'system' && typeof first.content === 'string') {
    return first.content;
  }
  return undefined;
}

function collectSkillContent(ctx: PipelineContext): string | undefined {
  if (typeof ctx.skillContent === 'string' && ctx.skillContent.length > 0) {
    return ctx.skillContent;
  }
  return undefined;
}

function collectActiveSkillMeta(
  ctx: PipelineContext,
): ICoordinatorContext['activeSkillMeta'] {
  const withSteps = ctx.selectedSkills?.find(
    (s) => (s.meta?.steps?.length ?? 0) > 0,
  );
  return withSteps?.meta;
}

function wrapError(err: unknown, code: string): OrchestratorError {
  if (err instanceof OrchestratorError) return err;
  return new OrchestratorError(
    err instanceof Error ? err.message : String(err),
    code,
  );
}

/**
 * Helper used by DefaultPipeline / activation strategies to detect whether
 * the active skill carries a structured `steps` block — a strong signal for
 * Coordinator activation.
 */
export function activeSkillHasSteps(ctx: PipelineContext): boolean {
  return !!ctx.selectedSkills?.some((s) => (s.meta?.steps?.length ?? 0) > 0);
}
