/**
 * RetryLlm — ILlm decorator that retries transient failures with exponential backoff.
 *
 * Composition order: CircuitBreakerLlm → RetryLlm → LlmAdapter
 * Retry sits INSIDE the circuit breaker, so the breaker records one result per
 * logical call (after the retries), not one per attempt. A rate limiter, when
 * used, sits outermost.
 */

import { setImmediate } from 'node:timers/promises';
import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  CircuitBreakerLlm,
  DefaultWaitStrategy,
  exponentialBackoffMs,
  findThrottled,
  isRetryableStatus,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type Result,
  retryAfterSecondsOf,
  startOperation,
  withOuterAttempt,
} from '@mcp-abap-adt/llm-agent';

export interface RetryOptions {
  /** Maximum number of non-429 retries. Unlimited when omitted. */
  maxAttempts?: number;
  /** Initial backoff delay in ms. Doubles each attempt. Default: 2000. */
  backoffMs: number;
  /** HTTP status codes that trigger retry. Default: [500, 502, 503]. 429 always retries. */
  retryOn: number[];
  /** Substrings in error message that trigger mid-stream retry (replays entire stream). Default: []. */
  retryOnMidStream: string[];
}

const DEFAULT_OPTIONS: RetryOptions = {
  backoffMs: 2000,
  retryOn: [500, 502, 503],
  retryOnMidStream: [],
};

function toLlmError<T>(cause: T): LlmError {
  return cause instanceof LlmError
    ? cause
    : Object.assign(new LlmError(String(cause), 'LLM_ERROR'), { cause });
}

function abortError(signal: AbortSignal): LlmError {
  return Object.assign(new LlmError('Aborted', 'ABORTED'), {
    cause: signal.reason,
  });
}

export class RetryLlm implements ILlm {
  private readonly wait = new DefaultWaitStrategy();
  private readonly opts: RetryOptions;
  healthCheck?: ILlm['healthCheck'];

  constructor(
    private readonly inner: ILlm,
    options?: Partial<RetryOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    const op = startOperation(options);
    const signal = options?.signal;
    let transientRetries = 0;
    let quotaRetries = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        return { ok: false, error: abortError(signal) };
      }

      let result: Result<LlmResponse, LlmError>;
      try {
        result = await this.inner.chat(messages, tools, {
          ...options,
          usageOp: withOuterAttempt(op, attempt),
        });
      } catch (error) {
        result = { ok: false, error: toLlmError(error) };
      }

      if (signal?.aborted) return { ok: false, error: abortError(signal) };
      if (result.ok || result.error.code === 'ABORTED') return result;
      if (this.isThrottled(result.error)) {
        await this.waitForRetry(
          this.retryDelay(quotaRetries++, result.error),
          signal,
        );
        continue;
      }
      if (
        !this.canRetry(transientRetries) ||
        !isRetryableStatus(result.error, this.opts.retryOn)
      )
        return result;

      await this.waitForRetry(this.retryDelay(transientRetries++), signal);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    const op = startOperation(options);
    const signal = options?.signal;
    let transientRetries = 0;
    let quotaRetries = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        yield { ok: false, error: abortError(signal) };
        return;
      }

      let chunksYielded = 0;
      let retryDelay: number | undefined;

      for await (const chunk of this.attemptStream(messages, tools, {
        ...options,
        usageOp: withOuterAttempt(op, attempt),
      })) {
        if (signal?.aborted) {
          yield { ok: false, error: abortError(signal) };
          return;
        }
        if (chunk.ok) {
          chunksYielded++;
          yield chunk;
        } else {
          if (chunk.error.code === 'ABORTED') {
            yield chunk;
            return;
          }
          if (this.isThrottled(chunk.error)) {
            retryDelay = this.retryDelay(quotaRetries++, chunk.error);
          } else if (
            this.canRetry(transientRetries) &&
            (chunksYielded === 0
              ? isRetryableStatus(chunk.error, this.opts.retryOn)
              : this.isMidStreamRetryable(chunk.error))
          ) {
            retryDelay = this.retryDelay(transientRetries++);
          } else {
            yield chunk;
            return;
          }
          break;
        }
      }

      if (retryDelay === undefined) return;
      if (chunksYielded > 0)
        yield { ok: true, value: { content: '', reset: true } };
      await this.waitForRetry(retryDelay, signal);
    }
  }

  /**
   * One attempt's stream, with a thrown exception (before or during iteration)
   * turned into an error chunk — the same shape CircuitBreakerLlm gives it — so
   * a throwing provider goes through the same retry rules as an error chunk.
   */
  private async *attemptStream(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    try {
      yield* this.inner.streamChat(messages, tools, options);
    } catch (err) {
      yield { ok: false, error: toLlmError(err) };
    }
  }

  private isThrottled(error: LlmError): boolean {
    return !!findThrottled(error) || isRetryableStatus(error, [429]);
  }

  private canRetry(retries: number): boolean {
    return (
      this.opts.maxAttempts === undefined || retries < this.opts.maxAttempts
    );
  }

  private isMidStreamRetryable(error: LlmError): boolean {
    if (this.opts.retryOnMidStream.length === 0) return false;
    const msg = error.message;
    return this.opts.retryOnMidStream.some((sub) => msg.includes(sub));
  }

  private retryDelay(attempt: number, error?: LlmError): number {
    const seconds = retryAfterSecondsOf(error);
    return seconds === undefined
      ? exponentialBackoffMs(this.opts.backoffMs, attempt)
      : seconds * 1000;
  }

  private async waitForRetry(
    delay: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.wait.wait(delay, signal);
    // Immediate failures and a zero delay must still let a caller's abort run.
    if (delay === 0 && !signal?.aborted) await setImmediate();
  }
}

/**
 * Wraps `llm` in a RetryLlm placed UNDER any CircuitBreakerLlm layers it
 * already has: each breaker wrapper is rebuilt on its own (possibly shared)
 * breaker around the retry, so every breaker counts one result per logical
 * call. Without a breaker this is plain `new RetryLlm(llm, options)`.
 */
export function retryInsideBreakers(
  llm: ILlm,
  options?: Partial<RetryOptions>,
): ILlm {
  if (llm instanceof CircuitBreakerLlm) {
    return new CircuitBreakerLlm(
      retryInsideBreakers(llm.inner, options),
      llm.breaker,
    );
  }
  return new RetryLlm(llm, options);
}
