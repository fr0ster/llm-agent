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
If the request needs no decomposition (it can be answered directly without breaking it into steps), return an empty steps array: {"steps":[]}.
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

    // A clarification must stand alone. Combined with any steps array (incl. [])
    // it is ambiguous mixed output → fail loud, keeping a clean three-way union:
    // {clarification} | {steps:[...]} | {steps:[]} (answer-directly).
    if (parsed.clarification) {
      if (Array.isArray(parsed.steps)) {
        throw new Error(
          `Planner returned both a clarification and a steps array (ambiguous): ${jsonText.slice(0, 200)}`,
        );
      }
      return {
        steps: [],
        clarification: parsed.clarification,
        createdAt: Date.now(),
        source: 'planner-llm',
      };
    }

    // A missing / non-array `steps` is malformed → fail loud
    // (→ COORDINATOR_PLAN_FAILED). An explicit empty array `steps: []` is the
    // answer-directly signal and is allowed through (the for-loop below is a
    // no-op for it). The empty plan is consumed by the CoordinatorHandler
    // answer-directly branch (#155 Task 2), which self-dispatches the original
    // request; this planner only produces the signal.
    if (!Array.isArray(parsed.steps)) {
      throw new Error(
        `Planner returned no steps array and no clarification: ${jsonText.slice(0, 200)}`,
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
