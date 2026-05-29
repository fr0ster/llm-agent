import type {
  ExecutionReviewResult,
  IReviewStrategy,
  ReviewResult,
} from '@mcp-abap-adt/llm-agent';

/** Always-pass reviewer; always-abort recovery. Explicit opt-out / test double. */
export class NoopReviewStrategy implements IReviewStrategy {
  readonly name = 'noop-review';
  async review(): Promise<ReviewResult> {
    return { verdict: { pass: true } };
  }
  async reviewExecutionFailure(): Promise<ExecutionReviewResult> {
    return { decision: { action: 'abort' } };
  }
}
