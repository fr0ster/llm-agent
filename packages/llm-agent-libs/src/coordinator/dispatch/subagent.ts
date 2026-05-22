import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { buildBriefingFromContext } from '../briefing.js';
import { resolveTemplate } from '../../util/template.js';

/**
 * Dispatch the step to a named subagent from the registry.
 * If step.agent is unset or absent from registry, returns ok=false StepResult —
 * chain with HybridDispatch for fallback behavior.
 */
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
    const briefing = buildBriefingFromContext(step, ctx);

    const started = Date.now();
    try {
      const res = await sub.run({
        task,
        briefing,
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
