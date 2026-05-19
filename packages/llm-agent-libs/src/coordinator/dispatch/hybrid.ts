import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Try a primary dispatch strategy when the step names a known subagent;
 * otherwise fall back to a secondary (e.g. SelfDispatch).
 */
export class HybridDispatch implements IDispatchStrategy {
  readonly name = 'hybrid';

  constructor(
    private readonly primary: IDispatchStrategy,
    private readonly fallback: IDispatchStrategy,
  ) {}

  async dispatch(
    step: PlanStep,
    ctx: ICoordinatorContext,
  ): Promise<StepResult> {
    const needsFallback = !step.agent || !ctx.registry.has(step.agent);
    return needsFallback
      ? this.fallback.dispatch(step, ctx)
      : this.primary.dispatch(step, ctx);
  }
}
