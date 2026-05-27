import type {
  ErrorContext,
  ErrorReaction,
  IErrorStrategy,
  IReviewStrategy,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';

/**
 * Error strategy that delegates recovery to the reviewer: on a node failure it
 * asks the reviewer to replan the REMAINING objective against current state
 * (`reviewExecutionFailure`), returning a `revise` reaction (whole-remainder
 * swap) or `abort`. Stateless — the interpreter owns the per-run budget.
 */
export class ReviewerErrorStrategy implements IErrorStrategy {
  readonly name = 'reviewer';
  constructor(
    private readonly reviewer: IReviewStrategy,
    readonly maxReplans = 4,
  ) {}

  async onNodeFailure(
    node: PlanNode,
    error: unknown,
    ctx: ErrorContext,
  ): Promise<ErrorReaction> {
    if (
      ctx.remainingReplans <= 0 ||
      !this.reviewer.reviewExecutionFailure ||
      !ctx.plan ||
      !ctx.completedResults
    ) {
      return { action: 'abort' };
    }
    const decision = await this.reviewer.reviewExecutionFailure({
      objective: ctx.plan.objective,
      plan: ctx.plan,
      trace: ctx.completedResults,
      failedNodeId: node.id,
      error: error instanceof Error ? error.message : String(error),
      agents: ctx.agents,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
    });
    if (decision.action === 'revise') {
      return { action: 'revise', revisedPlan: decision.revisedPlan };
    }
    return { action: 'abort' };
  }
}
