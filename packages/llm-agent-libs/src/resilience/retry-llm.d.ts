/**
 * RetryLlm — ILlm decorator that retries transient failures with exponential backoff.
 *
 * Composition order: RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Retry sits outside the circuit breaker so that retry attempts are not
 * counted as separate failures.
 */
import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type Result,
} from '@mcp-abap-adt/llm-agent';
export interface RetryOptions {
  /** Maximum number of retry attempts (total calls = maxAttempts + 1). Default: 3. */
  maxAttempts: number;
  /** Initial backoff delay in ms. Doubles each attempt. Default: 2000. */
  backoffMs: number;
  /** HTTP status codes that trigger retry. Default: [429, 500, 502, 503]. */
  retryOn: number[];
  /** Substrings in error message that trigger mid-stream retry (replays entire stream). Default: []. */
  retryOnMidStream: string[];
}
export declare class RetryLlm implements ILlm {
  private readonly inner;
  private readonly opts;
  healthCheck?: ILlm['healthCheck'];
  constructor(inner: ILlm, options?: Partial<RetryOptions>);
  get model(): string | undefined;
  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>>;
  streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
  private isRetryable;
  private isMidStreamRetryable;
  private backoff;
}
//# sourceMappingURL=retry-llm.d.ts.map
