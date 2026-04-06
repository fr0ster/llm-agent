/**
 * RetryLlm — ILlm decorator that retries transient failures with exponential backoff.
 *
 * Composition order: RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Retry sits outside the circuit breaker so that retry attempts are not
 * counted as separate failures.
 */

import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import {
  type CallOptions,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type Result,
} from '../interfaces/types.js';

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

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  backoffMs: 2000,
  retryOn: [429, 500, 502, 503],
  retryOnMidStream: [],
};

export class RetryLlm implements ILlm {
  private readonly opts: RetryOptions;

  constructor(
    private readonly inner: ILlm,
    options?: Partial<RetryOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    for (let attempt = 0; ; attempt++) {
      if (options?.signal?.aborted) {
        return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
      }

      const result = await this.inner.chat(messages, tools, options);

      if (
        result.ok ||
        attempt >= this.opts.maxAttempts ||
        !this.isRetryable(result.error)
      ) {
        return result;
      }

      await this.backoff(attempt, options?.signal);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    for (let attempt = 0; ; attempt++) {
      if (options?.signal?.aborted) {
        yield { ok: false, error: new LlmError('Aborted', 'ABORTED') };
        return;
      }

      let chunksYielded = 0;
      let shouldRetry = false;

      for await (const chunk of this.inner.streamChat(
        messages,
        tools,
        options,
      )) {
        if (chunk.ok) {
          chunksYielded++;
          yield chunk;
        } else {
          const canRetry = attempt < this.opts.maxAttempts;

          // Pre-stream failure: retry on HTTP status codes (existing behavior)
          if (
            chunksYielded === 0 &&
            canRetry &&
            this.isRetryable(chunk.error)
          ) {
            shouldRetry = true;
            break;
          }

          // Mid-stream failure: retry on configured substrings
          if (
            chunksYielded > 0 &&
            canRetry &&
            this.isMidStreamRetryable(chunk.error)
          ) {
            yield { ok: true, value: { content: '', reset: true } };
            shouldRetry = true;
            break;
          }

          yield chunk;
          return;
        }
      }

      if (!shouldRetry) return;

      await this.backoff(attempt, options?.signal);
    }
  }

  private isRetryable(error: LlmError): boolean {
    const msg = error.message;
    return this.opts.retryOn.some((code) => msg.includes(String(code)));
  }

  private isMidStreamRetryable(error: LlmError): boolean {
    if (this.opts.retryOnMidStream.length === 0) return false;
    const msg = error.message;
    return this.opts.retryOnMidStream.some((sub) => msg.includes(sub));
  }

  private backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const delay = this.opts.backoffMs * 2 ** attempt;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
