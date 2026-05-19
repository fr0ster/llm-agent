import type {
  ICoordinatorContext,
  ILlm,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
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

    const response = await this.plannerLlm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: ctx.inputText },
      ],
      [],
      { signal: ctx.signal, sessionId: ctx.sessionId },
    );
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

  async rebuildPlan(
    _ctx: ICoordinatorContext,
    remaining: PlanStep[],
  ): Promise<Plan> {
    return {
      steps: remaining,
      createdAt: Date.now(),
      source: 'planner-llm',
    };
  }
}

function extractJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      `Planner output did not contain a JSON object: ${text.slice(0, 200)}`,
    );
  }
  return match[0];
}
