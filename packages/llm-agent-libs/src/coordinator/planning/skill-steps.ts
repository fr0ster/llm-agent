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
 *
 * Reads `ctx.activeSkillMeta` — populated by `CoordinatorHandler` from the
 * first selected skill that declares structured `steps:`. Throws if no
 * structured skill is active so callers can wrap this strategy with a
 * fallback (e.g. `OneShotPlanning`) when graceful degradation is needed.
 *
 * For YAML users: `coordinator.planning: skill-steps` activates this
 * strategy directly — no resolver argument required.
 *
 * For programmatic users that need a custom resolver (e.g. reading the
 * skill meta from a non-default source), pass a function via the
 * constructor — it takes precedence over `ctx.activeSkillMeta`.
 */
export class SkillStepsPlanning implements IPlanningStrategy {
  readonly name = 'skill-steps';

  constructor(
    private readonly resolveSkillMeta: (
      ctx: ICoordinatorContext,
    ) => ISkillMeta | undefined = (ctx) => ctx.activeSkillMeta,
  ) {}

  async buildInitialPlan(ctx: ICoordinatorContext): Promise<Plan> {
    const meta = this.resolveSkillMeta(ctx);
    if (!meta?.steps?.length) {
      throw new Error(
        `SkillStepsPlanning: no active skill with structured 'steps:' found. ` +
          `Chain this strategy with a fallback (e.g. OneShotPlanning) or ensure ` +
          `the active skill declares 'steps:' in its frontmatter.`,
      );
    }
    const steps: PlanStep[] = meta.steps.map((s) => ({
      id: s.id,
      goal: s.goal,
      agent: s.agent,
      expectedTools: s.expectedTools,
      needsInput: s.needsInput,
      inputTemplate: s.inputTemplate,
      status: 'pending',
    }));
    return {
      steps,
      objective: meta.objective,
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
