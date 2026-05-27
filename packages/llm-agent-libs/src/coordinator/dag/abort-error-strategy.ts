import type { ErrorReaction, IErrorStrategy } from '@mcp-abap-adt/llm-agent';

/** Default reaction: a failed node fails the plan (slice-1/2 behavior). */
export class AbortErrorStrategy implements IErrorStrategy {
  readonly name = 'abort';
  async onNodeFailure(): Promise<ErrorReaction> {
    return { action: 'abort' };
  }
}
