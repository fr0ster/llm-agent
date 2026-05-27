import type {
  ExecutionReviewDecision,
  IReviewStrategy,
  ReviewVerdict,
} from '@mcp-abap-adt/llm-agent';

/** Always-pass reviewer; always-abort recovery. Explicit opt-out / test double. */
export class NoopReviewStrategy implements IReviewStrategy {
  readonly name = 'noop-review';
  async review(): Promise<ReviewVerdict> {
    return { pass: true };
  }
  async reviewExecutionFailure(): Promise<ExecutionReviewDecision> {
    return { action: 'abort' };
  }
}
