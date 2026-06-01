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
  PlanStep,
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
}

export class CoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: CoordinatorHandlerDeps) {}

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
      // #157: thread the per-request RAG-selected tools + an MCP executor so a
      // self-dispatched step runs a real tool-loop instead of a toolless chat.
      selectedTools: ctx.activeTools ?? ctx.selectedTools,
      callTool: buildCallTool(ctx),
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

    // Answer-directly: the LLM planner returned an explicit empty step list
    // (no decomposition needed). Synthesize a single agentless step carrying the
    // original request and self-answer it instead of running an empty plan.
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
      coordCtx.stepResults[directStep.id] = result;
      ctx.options?.sessionLogger?.logStep('coordinator_answer_direct', {
        stepId: directStep.id,
        outputLength: result.output.length,
      });
      ctx.yield({ ok: true, value: { content: result.output } });
      ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
      return true;
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
 * Build a tool executor for self-dispatched coordinator steps (#157): resolve
 * the owning MCP client from `toolClientMap` and call it, returning the textual
 * result (mirrors the default tool-loop's extraction). Returns undefined when no
 * MCP clients are connected, so SelfDispatch keeps its toolless behaviour.
 */
function buildCallTool(
  ctx: PipelineContext,
): ICoordinatorContext['callTool'] | undefined {
  const map = ctx.toolClientMap;
  if (!map || map.size === 0) return undefined;
  return async (name: string, args: unknown) => {
    const client = map.get(name);
    if (!client) return `Tool not found: ${name}`;
    const r = await client.callTool(
      name,
      (args ?? {}) as Record<string, unknown>,
      ctx.options,
    );
    if (!r.ok) return r.error.message;
    return typeof r.value.content === 'string'
      ? r.value.content
      : JSON.stringify(r.value.content);
  };
}

/**
 * Helper used by DefaultPipeline / activation strategies to detect whether
 * the active skill carries a structured `steps` block — a strong signal for
 * Coordinator activation.
 */
export function activeSkillHasSteps(ctx: PipelineContext): boolean {
  return !!ctx.selectedSkills?.some((s) => (s.meta?.steps?.length ?? 0) > 0);
}
