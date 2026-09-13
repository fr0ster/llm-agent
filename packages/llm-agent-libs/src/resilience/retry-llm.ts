/**
 * RetryLlm — ILlm decorator that retries a failed call, as far as the
 * consumer's strategy says to.
 *
 * Composition order: RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Retry sits outside the circuit breaker so that retry attempts are not
 * counted as separate failures.
 *
 * It used to carry its own numbers — three attempts, a two-second doubling
 * backoff, four statuses — and the builder installed it on everyone whether or
 * not they had asked. Those were guesses about somebody else's provider and
 * somebody else's caller, of exactly the kind `IThrottleStrategy` removed from
 * the throttling path. Now the decision belongs to an `IFailureStrategy`, and
 * `RetryWithBackoff` is how a consumer asks for the old behaviour in its own
 * words.
 */

import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  extractStatusCode,
  type FailureContext,
  findThrottled,
  type IFailureStrategy,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  ReportFailure,
  type Result,
} from '@mcp-abap-adt/llm-agent';

export class RetryLlm implements ILlm {
  private readonly strategy: IFailureStrategy;
  healthCheck?: ILlm['healthCheck'];

  constructor(
    private readonly inner: ILlm,
    strategy: IFailureStrategy = new ReportFailure(),
  ) {
    this.strategy = strategy;
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
    let waitedMs = 0;
    for (let attempt = 1; ; attempt++) {
      if (options?.signal?.aborted) {
        return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
      }

      const result = await this.inner.chat(messages, tools, options);
      if (result.ok) return result;

      const decision = this.decide(result.error, attempt, waitedMs, false);
      if (!decision.retry) return result;

      waitedMs += await this.wait(decision.waitMs, options?.signal);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    let waitedMs = 0;
    for (let attempt = 1; ; attempt++) {
      if (options?.signal?.aborted) {
        yield { ok: false, error: new LlmError('Aborted', 'ABORTED') };
        return;
      }

      let chunksYielded = 0;
      let waitMs: number | undefined;

      for await (const chunk of this.inner.streamChat(
        messages,
        tools,
        options,
      )) {
        if (chunk.ok) {
          chunksYielded++;
          yield chunk;
          continue;
        }

        const midStream = chunksYielded > 0;
        const decision = this.decide(chunk.error, attempt, waitedMs, midStream);
        if (!decision.retry) {
          yield chunk;
          return;
        }
        // Replaying a stream that already yielded means the consumer must drop
        // what it has: the reset chunk says so before anything new arrives.
        if (midStream) {
          yield { ok: true, value: { content: '', reset: true } };
        }
        waitMs = decision.waitMs;
        break;
      }

      if (waitMs === undefined) return;
      waitedMs += await this.wait(waitMs, options?.signal);
    }
  }

  /**
   * A throttled error is the throttling seam's business and never this one's.
   *
   * The provider marks it when its own `IThrottleStrategy` is spent: it has
   * already seen the `429`, read `Retry-After` and decided. Retrying here would
   * spend more requests against a quota that is demonstrably closed, and would
   * do it without the interval the server named.
   */
  private decide(
    error: LlmError,
    attempt: number,
    waitedMs: number,
    midStream: boolean,
  ): { retry: boolean; waitMs: number } {
    if (findThrottled(error)) return { retry: false, waitMs: 0 };
    const ctx: FailureContext = {
      status: extractStatusCode(error),
      attempt,
      waitedMs,
      midStream,
      error,
    };
    const decision = this.strategy.decide(ctx);
    return { retry: decision.retry, waitMs: Math.max(0, decision.waitMs) };
  }

  /** Sleep, returning what was actually spent so the strategy can count it. */
  private wait(ms: number, signal?: AbortSignal): Promise<number> {
    if (ms <= 0) return Promise.resolve(0);
    const started = Date.now();
    return new Promise((resolve) => {
      const done = () => resolve(Date.now() - started);
      const timer = setTimeout(done, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
    });
  }
}
