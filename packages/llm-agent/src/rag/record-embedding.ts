import { setImmediate } from 'node:timers/promises';
import { findAbort } from '../errors/abort-run-error.js';
import { withEmbeddingError } from '../errors/rag-error.js';
import { overflowError } from '../errors/terminal-run-error.js';
import {
  type IDocumentEmbedder,
  type IEmbedResult,
  isBatchSizeLimited,
  type RagDocumentVectors,
} from '../interfaces/rag.js';
import { type CallOptions, RagError } from '../interfaces/types.js';
import {
  DefaultWaitStrategy,
  exponentialBackoffMs,
} from '../interfaces/wait-strategy.js';
import { httpStatusOf, retryAfterSecondsOf } from '../llm/throttle.js';

export const DEFAULT_FRAGMENT_SIZE_CHARS = 2048;
const waitStrategy = new DefaultWaitStrategy();

export interface RecordEmbeddingConfig {
  /** Unicode code points per fragment when no capacity is declared. Default: 2048. */
  fragmentSizeChars?: number;
}

function splitDocument(text: string, size: number): string[] {
  const fragments: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let characters = 0;
    let lineEnd = start;
    let paragraphEnd = start;
    while (end < text.length && characters < size) {
      const point = text.codePointAt(end) ?? 0;
      characters++;
      end += point <= 0xffff ? 1 : 2;
      if (point === 10) {
        if (
          lineEnd === end - 1 ||
          (lineEnd === end - 2 && text[end - 2] === '\r')
        )
          paragraphEnd = end;
        lineEnd = end;
      }
    }
    if (end < text.length) {
      if (paragraphEnd > start) end = paragraphEnd;
      else if (lineEnd > start) end = lineEnd;
      else if (size >= 2 && text[end - 1] === '\r' && text[end] === '\n') {
        end--;
      }
    }
    fragments.push(text.slice(start, end));
    start = end;
  }
  return fragments.length === 0 ? [text] : fragments;
}

/** Retry a throttled RAG operation for as long as the caller allows it to run. */
export async function retryRagThrottle<T>(
  call: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      const overflow = overflowError(error, signal);
      if (overflow) throw overflow;
      if (findAbort(error, signal)) throw error;
      signal?.throwIfAborted();
      const response =
        error !== null && typeof error === 'object' ? error : undefined;
      if (httpStatusOf(response) !== 429) throw error;
      const retryAfter = retryAfterSecondsOf(response);
      if (retryAfter === 0) {
        await setImmediate();
        continue;
      }
      await waitStrategy.wait(
        retryAfter === undefined
          ? exponentialBackoffMs(2000, attempt)
          : retryAfter * 1000,
        signal,
      );
    }
  }
}

export async function embedRecord(
  embedder: IDocumentEmbedder,
  text: string,
  fragmentSizeChars = DEFAULT_FRAGMENT_SIZE_CHARS,
  options?: CallOptions,
): Promise<number[][]> {
  const [results] = await embedDocumentRecords(
    embedder,
    [text],
    fragmentSizeChars,
    options,
  );
  return results.map(({ vector }) => vector);
}

/** Embed complete records in provider-sized requests, preserving record and fragment order. */
export async function embedDocumentRecords(
  embedder: IDocumentEmbedder,
  texts: readonly string[],
  fragmentSizeChars = DEFAULT_FRAGMENT_SIZE_CHARS,
  options?: CallOptions,
): Promise<IEmbedResult[][]> {
  if (texts.length === 0) return [];
  const callOptions = {
    ...options,
    preserveEmbeddingInput: true,
    usage: options?.usage?.with({ role: 'embedding' }),
  };
  const run = <T>(request: () => Promise<T>) =>
    retryRagThrottle(
      () => withEmbeddingError(request, callOptions.signal),
      callOptions.signal,
    );
  const getCapacity = embedder.getMaxInputChars?.bind(embedder);
  const size =
    (getCapacity && (await run(() => getCapacity(callOptions)))) ??
    fragmentSizeChars;
  if (!Number.isSafeInteger(size) || size < 1)
    throw new RangeError(
      'Embedding fragment size must be a positive safe integer',
    );
  const documents = texts.map((text) => splitDocument(text, size));
  const fragments = documents.flat();
  const results: IEmbedResult[] = [];
  const embedDocuments = embedder.embedDocuments?.bind(embedder);
  if (embedDocuments && fragments.length > 1) {
    const batchSize = isBatchSizeLimited(embedder)
      ? embedder.maxBatchSize
      : fragments.length;
    for (let start = 0; start < fragments.length; start += batchSize) {
      const batch = fragments.slice(start, start + batchSize);
      const embedded = await run(() => embedDocuments(batch, callOptions));
      if (embedded.length !== batch.length)
        throw new RagError(
          'Embedding batch returned the wrong number of vectors',
          'UPSERT_ERROR',
        );
      for (const result of embedded) results.push(result);
    }
  } else {
    for (const fragment of fragments) {
      results.push(
        await run(() => embedder.embedDocument(fragment, callOptions)),
      );
    }
  }
  validateDocumentVectors(results.map(({ vector }) => vector));
  let offset = 0;
  return documents.map(({ length }) => {
    const record = results.slice(offset, offset + length);
    offset += length;
    return record;
  });
}

function isFragmentSet(vectors: RagDocumentVectors): vectors is number[][] {
  return Array.isArray(vectors[0]);
}

/** Normalize legacy single vectors and validate the entire precomputed record. */
export function recordVectors(input: RagDocumentVectors): number[][] {
  const vectors = isFragmentSet(input) ? input : [input];
  validateDocumentVectors(vectors);
  return vectors;
}

function validateDocumentVectors(vectors: number[][]): void {
  const dimension = vectors[0]?.length;
  if (!dimension || vectors.some((vector) => vector.length !== dimension))
    throw new RagError(
      'Document fragments returned incompatible vectors',
      'UPSERT_ERROR',
    );
  for (const [fragment, vector] of vectors.entries()) {
    const invalid = vector.findIndex((value) => !Number.isFinite(value));
    if (invalid !== -1)
      throw new RagError(
        `Non-finite vector component at index ${invalid} in fragment ${fragment}`,
        'UPSERT_ERROR',
      );
  }
}
