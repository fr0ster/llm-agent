import type { IReviewStrategy, ReviewVerdict } from '@mcp-abap-adt/llm-agent';

/** Always-pass reviewer. Explicit opt-out / test double. */
export class NoopReviewStrategy implements IReviewStrategy {
  readonly name = 'noop-review';
  async review(): Promise<ReviewVerdict> {
    return { pass: true };
  }
}
