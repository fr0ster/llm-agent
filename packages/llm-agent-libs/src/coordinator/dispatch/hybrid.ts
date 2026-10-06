import type {
  ICoordinatorContext,
  IDispatchStrategy,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Try a primary dispatch strategy when the step names a registered subagent;
 * a step that names no agent goes to a secondary (e.g. SelfDispatch).
 * A step that NAMES an agent the registry lacks is a failed step — it is never
 * run by the secondary in its place (spec §10.5.12 U5, §13 B13).
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
    if (!step.agent) return this.fallback.dispatch(step, ctx);
    if (!ctx.registry.has(step.agent))
      return {
        stepId: step.id,
        output: '',
        durationMs: 0,
        ok: false,
        error: `HybridDispatch: agent '${step.agent}' not in registry (registered: ${[...ctx.registry.keys()].join(', ') || 'none'})`,
      };
    // Epicfail from primary is terminal — never fall through to fallback.
    // The shape itself (epicFailTrace marker on StepResult) is sufficient;
    // since we only invoke primary here (no chained on-failure fallback),
    // the result — including any epicfail — propagates unchanged.
    return this.primary.dispatch(step, ctx);
  }
}
