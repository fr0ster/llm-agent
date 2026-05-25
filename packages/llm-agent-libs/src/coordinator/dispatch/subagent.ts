import type {
  EpicFailTrace,
  ICoordinatorContext,
  IDispatchStrategy,
  ISubAgentContextBuilder,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { composeTask } from './compose-task.js';

/**
 * Dispatch the step to a named subagent from the registry.
 * If step.agent is unset or absent from registry, returns ok=false StepResult.
 *
 * When constructed with an `ISubAgentContextBuilder`, the builder is invoked
 * before `sub.run()` to assemble the `context` preamble. If the subagent's
 * `contextPolicy === 'required'` and the builder returns empty context,
 * dispatch returns a clean error instead of invoking the subagent.
 */
export class SubAgentDispatch implements IDispatchStrategy {
  readonly name = 'subagent';

  constructor(private readonly contextBuilder?: ISubAgentContextBuilder) {}

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
    const task = composeTask(step, ctx);

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

      // Epicfail propagation: do NOT retry, do NOT transform — preserve trace
      // by attaching this layer's frame and passing it upward in StepResult.
      if (res.errorClass === 'epicfail') {
        const childTrace = res.epicFailTrace;
        const wrappedTrace: EpicFailTrace = {
          layer: ctx.layer ?? 0,
          stepId: step.id,
          agentName,
          attempts: [],
          originalError:
            childTrace?.originalError ?? `epicfail from '${agentName}'`,
          childTrace,
        };
        return {
          stepId: step.id,
          output: '',
          durationMs: Date.now() - started,
          ok: false,
          error: `epicfail from '${agentName}': ${childTrace?.originalError ?? 'unknown'}`,
          epicFailTrace: wrappedTrace,
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
