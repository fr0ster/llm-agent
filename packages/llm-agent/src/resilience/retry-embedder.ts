/**
 * RetryEmbedder — IEmbedder decorators that retry transient failures with
 * exponential backoff. Ported from RetryLlm (llm-agent-libs) onto IEmbedder,
 * which throws instead of returning a Result.
 *
 * Two classes behind a factory, following wrapEmbedder: a single class exposing
 * embedBatch unconditionally would make every non-batch embedder look
 * batch-capable to isBatchEmbedder.
 */

import { findAbort } from '../errors/abort-run-error.js';
import { withEmbeddingError } from '../errors/rag-error.js';
import { overflowError } from '../errors/terminal-run-error.js';
import type {
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '../interfaces/rag.js';
import { isBatchEmbedder, isBatchSizeLimited } from '../interfaces/rag.js';
// CallOptions lives in types.ts and is NOT re-exported by rag.ts.
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';
import type { IWaitStrategy } from '../interfaces/wait-strategy.js';
import {
  DefaultWaitStrategy,
  exponentialBackoffMs,
} from '../interfaces/wait-strategy.js';
import {
  httpStatusOf,
  retryAfterSecondsOf,
  runWithThrottleRetry,
  type ThrottleRetryOptions,
} from '../llm/throttle.js';
import { startOperation, withOuterAttempt } from '../usage/hooks.js';

export interface EmbedderRetryOptions {
  /** Maximum number of retries (total calls = maxAttempts + 1). Default: 3. */
  maxAttempts: number;
  /** Initial backoff delay in ms. Doubles each attempt. Default: 2000. */
  backoffMs: number;
  /** HTTP status codes that trigger a retry. Default: [429, 500, 502, 503]. */
  retryOn: number[];
  /**
   * Mechanism for the backoff sleep. Default: `DefaultWaitStrategy`.
   *
   * The same seam the controller's `wait` step uses: a deployment can replace
   * a blocking timer with jitter, its own scheduler, or suspend/resume.
   *
   * Optional, unlike the scalar knobs beside it: this is a collaborator, not a
   * setting. A consumer assembling a full options literal should not have to
   * name an internal mechanism, and the type stays expressible as plain data.
   */
  waitStrategy?: IWaitStrategy;
  /** Reactive 429 policy; independent of the ordinary retry attempt limit. */
  throttle?: Pick<ThrottleRetryOptions, 'key' | 'strategy'>;
}

/** Internal shape after defaults are applied — every field is present. */
type ResolvedRetryOptions = Omit<EmbedderRetryOptions, 'waitStrategy'> & {
  waitStrategy: IWaitStrategy;
};

const DEFAULT_OPTIONS: ResolvedRetryOptions = {
  maxAttempts: 3,
  backoffMs: 2000,
  retryOn: [429, 500, 502, 503],
  // Stateless, so one shared instance is safe.
  waitStrategy: new DefaultWaitStrategy(),
};

/** Resolve structured HTTP status through the shared transport reader. */
export function extractStatusCode(err: unknown): number | undefined {
  return httpStatusOf(
    typeof err === 'object' && err !== null ? err : undefined,
  );
}

/**
 * Whether a thrown value should be retried against a set of HTTP status codes.
 *
 * A structured status (`response.status`, `status`/`statusCode`, including `cause`) is
 * authoritative. Only when none is present does it fall back to the message,
 * and there it matches on **word boundaries** — a bare `includes('429')` also
 * fires on `4290`, an id, or a byte count, turning a hard error into a
 * multi-second backoff stall.
 *
 * The message fallback supports legacy embedding errors.
 */
export function isRetryableStatus(err: unknown, retryOn: number[]): boolean {
  const status = extractStatusCode(err);
  if (status !== undefined) return retryOn.includes(status);
  const msg = err instanceof Error ? err.message : String(err);
  return retryOn.some((code) => new RegExp(`\\b${code}\\b`).test(msg));
}

export class RetryEmbedder implements IEmbedder {
  protected readonly opts: ResolvedRetryOptions;

  constructor(
    protected readonly inner: IEmbedder,
    options?: Partial<EmbedderRetryOptions>,
  ) {
    // waitStrategy is re-applied after the spread: an explicit
    // `{ waitStrategy: undefined }` would otherwise overwrite the default with
    // undefined and crash on the first backoff.
    this.opts = {
      ...DEFAULT_OPTIONS,
      ...options,
      waitStrategy: options?.waitStrategy ?? DEFAULT_OPTIONS.waitStrategy,
    };
  }

  get getMaxInputChars() {
    const getCapacity = this.inner.getMaxInputChars?.bind(this.inner);
    return (
      getCapacity && ((options?: CallOptions) => this.run(getCapacity, options))
    );
  }

  get maxBatchSize() {
    return isBatchSizeLimited(this.inner) ? this.inner.maxBatchSize : undefined;
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.run(
      (attemptOptions) => this.inner.embed(text, attemptOptions),
      options,
    );
  }

  protected async run<T>(
    call: (options: CallOptions) => Promise<T>,
    options?: CallOptions,
  ): Promise<T> {
    const op = startOperation(options);
    if (this.opts.throttle) {
      let physicalAttempt = 0;
      let transientAttempt = 0;
      return runWithThrottleRetry(
        async () => {
          options?.signal?.throwIfAborted();
          try {
            return await withEmbeddingError(
              () =>
                call({
                  ...options,
                  usageOp: withOuterAttempt(op, physicalAttempt++),
                }),
              options?.signal,
              'preserve-rejection',
            );
          } catch (error) {
            if (findAbort(error, options?.signal) || overflowError(error))
              throw error;
            // The ordinary retry loop reaches its abort check after a retryable
            // failure with attempts left. Keep that outcome and the caller reason.
            if (
              options?.signal?.aborted &&
              transientAttempt < this.opts.maxAttempts &&
              this.isRetryable(error)
            ) {
              options.signal.throwIfAborted();
            }
            throw error;
          }
        },
        {
          ...this.opts.throttle,
          signal: options?.signal,
          isThrottled: (error) =>
            !options?.signal?.aborted &&
            httpStatusOf(
              typeof error === 'object' && error !== null ? error : undefined,
            ) === 429,
          retryAfterSeconds: (error) =>
            retryAfterSecondsOf(
              typeof error === 'object' && error !== null ? error : undefined,
            ),
          transient: {
            maxRetries: this.opts.maxAttempts,
            isTransient: (error) => this.isRetryable(error),
            delayMs: () =>
              exponentialBackoffMs(this.opts.backoffMs, transientAttempt++),
            waitStrategy: this.opts.waitStrategy,
          },
        },
      );
    }
    for (let attempt = 0; ; attempt++) {
      if (options?.signal?.aborted) {
        throw new RagError('Aborted', 'ABORTED');
      }
      try {
        return await withEmbeddingError(
          () =>
            call({
              ...options,
              usageOp: withOuterAttempt(op, attempt),
            }),
          options?.signal,
          'preserve-rejection',
        );
      } catch (err) {
        if (findAbort(err, options?.signal) || overflowError(err)) throw err;
        // The store waits out 429s for record fragments when no explicit
        // throttle strategy handled the request.
        if (
          (options?.preserveEmbeddingInput && extractStatusCode(err) === 429) ||
          attempt >= this.opts.maxAttempts ||
          !this.isRetryable(err)
        )
          throw err;
        await this.backoff(attempt, options?.signal);
      }
    }
  }

  protected isRetryable(err: unknown): boolean {
    const seen = new Set<object>();
    let current = err;
    while (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      const message = 'message' in current ? String(current.message) : '';
      if (
        /input.{0,30}(?:too long|too large|exceed)|maximum context length|context_length_exceeded|too many tokens|max(?:imum)?[_ ](?:input[_ ])?(?:tokens|length)/i.test(
          message,
        )
      )
        return false;
      current = 'cause' in current ? current.cause : undefined;
    }
    return isRetryableStatus(err, this.opts.retryOn);
  }

  /**
   * Delegated to IWaitStrategy rather than hand-rolled: honouring the signal is
   * part of that contract — an already-aborted signal returns immediately
   * (addEventListener never fires for an event that already dispatched), and
   * the listener is removed when the timer wins so a request- or session-scoped
   * signal does not accumulate one per retry.
   */
  protected async backoff(
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const delay = exponentialBackoffMs(this.opts.backoffMs, attempt);
    await this.opts.waitStrategy.wait(delay, signal);
  }
}

export class RetryBatchEmbedder
  extends RetryEmbedder
  implements IEmbedderBatch
{
  constructor(
    protected readonly inner: IEmbedderBatch,
    options?: Partial<EmbedderRetryOptions>,
  ) {
    super(inner, options);
  }

  async embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    return this.run(
      (attemptOptions) => this.inner.embedBatch(texts, attemptOptions),
      options,
    );
  }
}

/** Preserves batch capability: never turns a non-batch embedder into one. */
export function withRetry(
  inner: IEmbedder,
  options?: Partial<EmbedderRetryOptions>,
): IEmbedder {
  return isBatchEmbedder(inner)
    ? new RetryBatchEmbedder(inner, options)
    : new RetryEmbedder(inner, options);
}
