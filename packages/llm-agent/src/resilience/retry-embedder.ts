/**
 * RetryEmbedder — IEmbedder decorators that retry transient failures with
 * exponential backoff. Ported from RetryLlm (llm-agent-libs) onto IEmbedder,
 * which throws instead of returning a Result.
 *
 * Two classes behind a factory, following wrapEmbedder: a single class exposing
 * embedBatch unconditionally would make every non-batch embedder look
 * batch-capable to isBatchEmbedder.
 */

import type {
  IEmbedder,
  IEmbedderBatch,
  IEmbedResult,
} from '../interfaces/rag.js';
import { isBatchEmbedder } from '../interfaces/rag.js';
// CallOptions lives in types.ts and is NOT re-exported by rag.ts.
import type { CallOptions } from '../interfaces/types.js';
import { RagError } from '../interfaces/types.js';
import type { IWaitStrategy } from '../interfaces/wait-strategy.js';
import { DefaultWaitStrategy } from '../interfaces/wait-strategy.js';

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
   */
  waitStrategy: IWaitStrategy;
}

const DEFAULT_OPTIONS: EmbedderRetryOptions = {
  maxAttempts: 3,
  backoffMs: 2000,
  retryOn: [429, 500, 502, 503],
  // Stateless, so one shared instance is safe.
  waitStrategy: new DefaultWaitStrategy(),
};

const MAX_CAUSE_DEPTH = 5;

/**
 * Resolve an HTTP status from an unknown thrown value: own status/statusCode,
 * then the same walking `cause`, bounded by depth and a visited set so a cyclic
 * chain cannot hang. Returns undefined when no numeric status is present.
 */
export function extractStatusCode(err: unknown): number | undefined {
  const visited = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || visited.has(cur)) return;
    visited.add(cur);
    const rec = cur as {
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    if (typeof rec.status === 'number') return rec.status;
    if (typeof rec.statusCode === 'number') return rec.statusCode;
    cur = rec.cause;
  }
  return undefined;
}

export class RetryEmbedder implements IEmbedder {
  protected readonly opts: EmbedderRetryOptions;

  constructor(
    protected readonly inner: IEmbedder,
    options?: Partial<EmbedderRetryOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  async embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.run(() => this.inner.embed(text, options), options);
  }

  protected async run<T>(
    call: () => Promise<T>,
    options?: CallOptions,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (options?.signal?.aborted) {
        throw new RagError('Aborted', 'ABORTED');
      }
      try {
        return await call();
      } catch (err) {
        if (attempt >= this.opts.maxAttempts || !this.isRetryable(err))
          throw err;
        await this.backoff(attempt, options?.signal);
      }
    }
  }

  protected isRetryable(err: unknown): boolean {
    const status = extractStatusCode(err);
    if (status !== undefined) return this.opts.retryOn.includes(status);
    // Last resort: some adapters report the status only in the message. Match
    // on word boundaries rather than a bare substring, so an id or a byte count
    // containing "429" does not trigger a retry.
    const msg = err instanceof Error ? err.message : String(err);
    return this.opts.retryOn.some((code) =>
      new RegExp(`\\b${code}\\b`).test(msg),
    );
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
    const delay = this.opts.backoffMs * 2 ** attempt;
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
    return this.run(() => this.inner.embedBatch(texts, options), options);
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
