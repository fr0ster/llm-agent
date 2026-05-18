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
}

export class CoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: CoordinatorHandlerDeps) {}

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    if (!ctx.subAgents) {
      ctx.error = new OrchestratorError(
        'CoordinatorHandler: ctx.subAgents is undefined; pipeline must be built with withSubAgents() or coordinator activation',
        'COORDINATOR_NO_REGISTRY',
      );
      return false;
    }

    const coordCtx: ICoordinatorContext = {
      inputText: ctx.inputText,
      systemPrompt: collectSystemPrompt(ctx),
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

    if (totalSteps >= this.deps.maxSteps) {
      ctx.options?.sessionLogger?.logStep('coordinator_max_steps', {
        maxSteps: this.deps.maxSteps,
      });
    }

    const finalOutput = Object.values(coordCtx.stepResults)
      .map((r) => `### ${r.stepId}\n${r.output}`)
      .join('\n\n');

    ctx.options?.sessionLogger?.logStep('coordinator_final', {
      stepCount: Object.keys(coordCtx.stepResults).length,
      outputLength: finalOutput.length,
    });

    // Stream the final output as a single content chunk followed by a stop
    // chunk, mirroring the contract used by tool-loop so SSE consumers see
    // a normal assistant response.
    ctx.yield({ ok: true, value: { content: finalOutput } });
    ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });

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
