import type {
  ICoordinatorContext,
  IDispatchStrategy,
  ILlm,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { formatBriefing } from '../../subagent/format-briefing.js';
import { buildBriefingFromContext } from '../briefing.js';

/**
 * Execute the step via the agent's own LLM (no subagent dispatched).
 * Useful when the registry is empty but the planner has produced steps.
 *
 * Uses the same `formatBriefing` formatter as `SmartAgentSubAgent` so the
 * structure (Goal/Known/Tried/Constraints/Task) is identical between
 * self-dispatched and subagent-dispatched steps.
 */
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
    const briefing = buildBriefingFromContext(step, ctx);
    const userMsg = formatBriefing(step.goal, briefing);

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
