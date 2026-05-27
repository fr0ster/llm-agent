import {
  type ErrorContext,
  type ErrorReaction,
  type IErrorStrategy,
  type IPlanner,
  NeedsDecompositionError,
  type PlanNode,
} from '@mcp-abap-adt/llm-agent';

/**
 * Replans a node ONLY for NeedsDecompositionError (the explicit "decompose me"
 * signal). Any other error → abort (a transient MCP/LLM failure is not fixed by
 * decomposition). Stateless: holds the maxReplans ceiling but never counts — the
 * interpreter owns the per-run counter and passes `remainingReplans`.
 */
export class ReplanErrorStrategy implements IErrorStrategy {
  readonly name = 'replan';
  constructor(
    private readonly planner: IPlanner,
    readonly maxReplans = 4,
  ) {}

  async onNodeFailure(
    _node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction> {
    if (!(error instanceof NeedsDecompositionError)) {
      return { action: 'abort' };
    }
    if (ctx.remainingReplans <= 0) {
      return { action: 'abort' };
    }
    const subPlan = await this.planner.plan({
      prompt: `${ctx.task}\n\nThis task needs decomposition: ${error.reason}`,
      agents: ctx.agents,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    });
    return { action: 'replan', subPlan };
  }
}
