import type {
  EpicFailTrace,
  ICoordinatorContext,
  IDispatchStrategy,
  ISubAgentContextBuilder,
  LlmTool,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { terminalRunError } from '@mcp-abap-adt/llm-agent';
import { composeTask } from './compose-task.js';

export interface SubAgentDispatchContext extends ICoordinatorContext {
  retrievedTools?: readonly LlmTool[];
}

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

  constructor(
    private readonly contextBuilder?: ISubAgentContextBuilder,
    private readonly useRetrievedTools = false,
  ) {}

  async dispatch(
    step: PlanStep,
    ctx: SubAgentDispatchContext,
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

    let context: string | undefined;
    if (this.useRetrievedTools) {
      if (sub.capabilities.contextPolicy !== 'forbidden') {
        context =
          ctx.retrievedTools
            ?.map(({ name, description }) => `${name}: ${description}`)
            .join('\n\n') || undefined;
      }
    } else if (this.contextBuilder) {
      const built = await this.contextBuilder.build({
        caller: ctx.caller,
        task,
        step,
        agent: sub,
        inputText: ctx.inputText,
        sessionId: ctx.sessionId,
        usage: ctx.usage,
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
        caller: ctx.caller,
        task,
        context,
        sessionId: ctx.sessionId,
        usage: ctx.usage,
        signal: ctx.signal,
      });

      // Epicfail propagation: do NOT retry, do NOT transform — surface the
      // flat trace upward in StepResult unchanged (or build one if absent).
      if (res.errorClass === 'epicfail') {
        const trace: EpicFailTrace = res.epicFailTrace ?? {
          stepId: step.id,
          agentName,
          attempts: [],
          originalError: `epicfail from '${agentName}'`,
        };
        return {
          stepId: step.id,
          output: '',
          durationMs: Date.now() - started,
          ok: false,
          error: `epicfail from '${agentName}': ${trace.originalError}`,
          epicFailTrace: trace,
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
      const terminalError = terminalRunError(err);
      return {
        stepId: step.id,
        output: '',
        durationMs: Date.now() - started,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(terminalError ? { terminalError } : {}),
      };
    }
  }
}
