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
    if (needsFallback) return this.fallback.dispatch(step, ctx);
    // Epicfail from primary is terminal — never fall through to fallback.
    // The shape itself (epicFailTrace marker on StepResult) is sufficient;
    // since we only invoke primary here (no chained on-failure fallback),
    // the result — including any epicfail — propagates unchanged.
    return this.primary.dispatch(step, ctx);
  }
}
