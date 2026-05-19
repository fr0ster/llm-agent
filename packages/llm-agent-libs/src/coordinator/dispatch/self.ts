import type {
  ICoordinatorContext,
  IDispatchStrategy,
  ILlm,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Execute the step via the agent's own LLM (no subagent dispatched).
 * Useful when the registry is empty but the planner has produced steps.
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
