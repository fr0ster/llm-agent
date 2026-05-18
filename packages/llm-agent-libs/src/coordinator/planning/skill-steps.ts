import type {
  ICoordinatorContext,
  IPlanningStrategy,
  ISkillMeta,
  Plan,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Use explicit `steps:` from the active skill's frontmatter when present.
 * Throws if no steps are declared — chain with another planner as fallback.
 */
export class SkillStepsPlanning implements IPlanningStrategy {
  readonly name = 'skill-steps';

  constructor(
    private readonly resolveSkillMeta: (
      ctx: ICoordinatorContext,
    ) => ISkillMeta | undefined,
  ) {}

  async buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan> {
    const meta = this.resolveSkillMeta(ctx);
    if (!meta?.steps?.length) {
      throw new Error(
        `SkillStepsPlanning: no explicit 'steps' in active skill. ` +
          `Chain this strategy with a fallback (e.g. OneShotPlanning).`,
      );
    }
    const steps: PlanStep[] = meta.steps.map((s) => ({
      id: s.id,
      goal: s.goal,
      expectedTools: s.expectedTools,
      status: 'pending',
    }));
    return {
      steps,
      rationale: `Steps declared by skill '${meta.name}'`,
      createdAt: Date.now(),
      source: 'skill-steps',
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
      source: 'skill-steps',
    };
  }
}
