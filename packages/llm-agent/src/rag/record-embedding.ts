import {
  type IDocumentEmbedder,
  isBatchSizeLimited,
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
    }
    fragments.push(text.slice(start, end));
    start = end;
  }
  return fragments.length === 0 ? [text] : fragments;
}

async function waitForEmbedding<T>(
  call: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await call();
    } catch (error) {
      signal?.throwIfAborted();
      const response =
        error !== null && typeof error === 'object' ? error : undefined;
      if (httpStatusOf(response) !== 429) throw error;
      const retryAfter = retryAfterSecondsOf(response);
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
  const callOptions = {
    ...options,
    preserveEmbeddingInput: true,
    usage: options?.usage?.with({ role: 'embedding' }),
  };
  const run = <T>(request: () => Promise<T>) =>
    waitForEmbedding(request, options?.signal);
  const getCapacity = embedder.getMaxInputChars?.bind(embedder);
  const size =
    (getCapacity && (await run(() => getCapacity(callOptions)))) ??
    fragmentSizeChars;
  if (!Number.isSafeInteger(size) || size < 1)
    throw new RangeError(
      'Embedding fragment size must be a positive safe integer',
    );
  const fragments = splitDocument(text, size);
  const embedDocument = (fragment: string) =>
    run(() => embedder.embedDocument(fragment, callOptions));
  if (fragments.length === 1) return [(await embedDocument(text)).vector];

  const vectors: number[][] = [];
  const embedDocuments = embedder.embedDocuments?.bind(embedder);
  if (embedDocuments) {
    const batchSize = isBatchSizeLimited(embedder)
      ? embedder.maxBatchSize
      : fragments.length;
    for (let start = 0; start < fragments.length; start += batchSize) {
      const batch = fragments.slice(start, start + batchSize);
      const results = await run(() => embedDocuments(batch, callOptions));
      if (results.length !== batch.length)
        throw new RagError(
          'Embedding batch returned the wrong number of vectors',
          'UPSERT_ERROR',
        );
      for (const { vector } of results) vectors.push(vector);
    }
  } else {
    for (const fragment of fragments) {
      vectors.push((await embedDocument(fragment)).vector);
    }
  }
  const dimension = vectors[0].length;
  if (
    vectors.some(
      (v) =>
        v.length !== dimension || v.some((value) => !Number.isFinite(value)),
    )
  )
    throw new RagError(
      'Document fragments returned incompatible vectors',
      'UPSERT_ERROR',
    );
  return vectors;
}
