/**
 * Composition of the embedder resilience chain, and the metadata that travels
 * with it.
 *
 *   wrapEmbedder( BatchChunkingEmbedder( RetryBatchEmbedder( provider ) ) )
 *
 * Retry sits INSIDE chunking so each chunk retries independently: a failure on
 * chunk 20 must not re-issue chunks 1-19.
 *
 * The metadata is keyed by a registered symbol, not a string property: a string
 * key could be matched structurally by an unrelated consumer embedder, and the
 * guard would then read a foreign object as ours.
 */

import type { IEmbedder } from '../interfaces/rag.js';
import { isBatchEmbedder, isBatchSizeLimited } from '../interfaces/rag.js';
import type { ILogger } from '../logger/types.js';
import {
  BatchChunkingEmbedder,
  DEFAULT_MAX_BATCH_SIZE,
} from './batch-chunking-embedder.js';
import type { EmbedderRetryOptions } from './retry-embedder.js';
import { withRetry } from './retry-embedder.js';

export const RESILIENCE_META = Symbol.for('@mcp-abap-adt/embedder-resilience');

export interface EmbedderResilienceMetadata {
  /** Absent for a non-batch embedder: retry applies, chunking does not. */
  maxBatchSize?: number;
}

/** Undefined iff the embedder has no resilience layer. */
export function getResilienceMetadata(
  e: IEmbedder,
): EmbedderResilienceMetadata | undefined {
  return (e as { [RESILIENCE_META]?: EmbedderResilienceMetadata })[
    RESILIENCE_META
  ];
}

/**
 * Attach metadata to an instance without making it enumerable.
 *
 * Also used by `wrapEmbedder` (llm-agent-libs) to propagate the metadata onto
 * its own wrapper: that decorator's `inner` is `protected`, so a caller holding
 * the wrapper could not otherwise see a brand sitting on a layer below, and
 * re-resolution would compose the decorators a second time.
 */
export function brandResilient(
  e: IEmbedder,
  meta: EmbedderResilienceMetadata,
): void {
  Object.defineProperty(e, RESILIENCE_META, {
    value: meta,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export interface ComposeResilienceOptions {
  /** A cap a human configured. ONLY this may trigger the conflict check. */
  explicitMaxBatchSize?: number;
  /** Provider-derived or default cap; never triggers the conflict check. */
  fallbackMaxBatchSize?: number;
  retry?: Partial<EmbedderRetryOptions>;
  logger?: ILogger;
}

export function composeResilientEmbedder(
  inner: IEmbedder,
  options?: ComposeResilienceOptions,
): IEmbedder {
  const existing = getResilienceMetadata(inner);
  if (existing) {
    const requested = options?.explicitMaxBatchSize;
    // Re-deriving the cap here would fire on every normal boot: wrapEmbedder
    // hides the provider, so a derived value falls to the default and would
    // look like a conflict nobody configured. Only an explicit request counts.
    if (requested !== undefined && requested !== existing.maxBatchSize) {
      options?.logger?.log({
        type: 'warning',
        traceId: 'embedder-resolution',
        message:
          `Embedder is already composed with maxBatchSize ${String(existing.maxBatchSize)}; ` +
          `ignoring the requested ${requested}. One shared embedder has one cap.`,
      });
    }
    return inner;
  }

  const cap =
    options?.explicitMaxBatchSize ??
    options?.fallbackMaxBatchSize ??
    (isBatchSizeLimited(inner) ? inner.maxBatchSize : DEFAULT_MAX_BATCH_SIZE);

  const retried = withRetry(inner, options?.retry);
  const batchCapable = isBatchEmbedder(retried);
  const composed = batchCapable
    ? new BatchChunkingEmbedder(retried, cap)
    : retried;

  brandResilient(composed, batchCapable ? { maxBatchSize: cap } : {});
  return composed;
}
