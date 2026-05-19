import type {
  ICoordinatorContext,
  ILlm,
  IPlanningStrategy,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { OneShotPlanning } from './one-shot.js';

/**
 * Plan once at the start. If a step fails (StepResult.ok === false), build a
 * fresh plan for the remaining work, taking the failure into account.
 */
export class ReplanOnErrorPlanning implements IPlanningStrategy {
  readonly name = 'replan-on-error';
  private readonly delegate: OneShotPlanning;

  constructor(private readonly plannerLlm: ILlm) {
    this.delegate = new OneShotPlanning(plannerLlm);
  }

  buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan> {
    return this.delegate.buildInitialPlan(ctx);
  }

  shouldReplan(_ctx: ICoordinatorContext, lastResult: StepResult): boolean {
    return !lastResult.ok;
  }

  async rebuildPlan(
    ctx: ICoordinatorContext,
    remaining: PlanStep[],
  ): Promise<Plan> {
    const agentsBlock = [...ctx.registry.entries()]
      .map(([name, a]) => `- ${name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const resultsBlock = Object.values(ctx.stepResults)
      .map(
        (r) =>
          `- ${r.stepId}: ${r.ok ? 'OK' : 'FAILED'} — ${r.output.slice(0, 200)}`,
      )
      .join('\n');
    const remainingBlock = remaining
      .map((s) => `- ${s.id}: ${s.goal}`)
      .join('\n');

    const systemPrompt = `You are a planner. The previous plan stalled. Build a NEW plan
for the remaining work, considering what has happened so far. Skip already-done work.

Original user request: ${ctx.inputText}

Results so far:
${resultsBlock}

Previously remaining steps:
${remainingBlock}

Available agents:
${agentsBlock || '(none — use self-dispatch)'}

Respond with ONLY a JSON object:
{"steps":[{"id":"...","goal":"...","agent":"optional"}],"rationale":"..."}`;

    // Use the same ILlm.chat(messages, tools, options) signature as one-shot.ts.
    const response = await this.plannerLlm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Build the revised plan now.' },
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
    return {
      steps: parsed.steps.map((s, i) => ({
        id: s.id ?? `replan-${i + 1}`,
        goal: s.goal,
        agent: s.agent,
        status: 'pending',
      })),
      rationale: parsed.rationale,
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
