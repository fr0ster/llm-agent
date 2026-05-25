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
The dispatched executor sees ONLY the step you author (its "goal" plus the shared
"objective", and the user's input as delimited data when you set "needsInput").
It never sees the raw user request as an instruction. So set "needsInput": true on
any step that must act on the user's provided material (text to summarize, code to
review, etc.).
Emit a plan-level "objective" (the shared purpose) so all steps stay aligned.
For each step, choose the best agent from the list (or omit "agent" if no specialist fits).
If the request is too ambiguous to plan, respond with ONLY {"clarification":"<your question>"}.
Otherwise respond with ONLY a JSON object of shape:
{"objective":"...","steps":[{"id":"step-1","goal":"...","agent":"optional-name","needsInput":false}],"rationale":"..."}

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
      objective?: string;
      clarification?: string;
      steps?: Array<{
        id?: string;
        goal: string;
        agent?: string;
        needsInput?: boolean;
      }>;
      rationale?: string;
    };

    if (parsed.clarification) {
      if ((parsed.steps?.length ?? 0) > 0) {
        throw new Error(
          `Planner returned both a clarification and steps (ambiguous): ${jsonText.slice(0, 200)}`,
        );
      }
      return {
        steps: [],
        clarification: parsed.clarification,
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    }

    // Without a clarification, a usable plan must carry at least one valid step.
    // An empty/malformed plan must fail loud (→ COORDINATOR_PLAN_FAILED) rather
    // than silently produce blank coordinator output.
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(
        `Planner returned neither steps nor a clarification: ${jsonText.slice(0, 200)}`,
      );
    }
    for (const s of parsed.steps) {
      if (typeof s.goal !== 'string' || s.goal.trim() === '') {
        throw new Error(`Planner step is missing a goal: ${JSON.stringify(s)}`);
      }
    }

    const steps: PlanStep[] = parsed.steps.map((s, i) => ({
      id: s.id ?? `step-${i + 1}`,
      goal: s.goal,
      agent: s.agent,
      needsInput: s.needsInput,
      status: 'pending',
    }));

    return {
      steps,
      objective: parsed.objective,
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
