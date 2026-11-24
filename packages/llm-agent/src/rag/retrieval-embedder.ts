import { withEmbeddingError } from '../errors/rag-error.js';
import {
  type IEmbedder,
  type IRetrievalEmbedder,
  isBatchEmbedder,
  isBatchSizeLimited,
} from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';

/** `embedDocuments` when — and only when — `embedder` batches. */
function documentBatch(
  embedder: IEmbedder,
): Pick<IRetrievalEmbedder, 'embedDocuments'> & { maxBatchSize?: number } {
  return isBatchEmbedder(embedder)
    ? {
        maxBatchSize: isBatchSizeLimited(embedder)
          ? embedder.maxBatchSize
          : undefined,
        embedDocuments: (texts: string[], options?: CallOptions) =>
          withEmbeddingError(
            () =>
              embedder.embedBatch(texts, {
                ...options,
                usage: options?.usage?.with({ role: 'embedding' }),
              }),
            options?.signal,
            'preserve-rejection',
          ),
      }
    : {};
}

/**
 * A retrieval embedder over a SYMMETRIC model — one that embeds stored text
 * and search text the same way (`text-embedding-3-*`, `gemini-embedding`, …):
 * documents and queries both go through `embedder.embed`.
 */
export function symmetricEmbedder(embedder: IEmbedder): IRetrievalEmbedder {
  return {
    embedDocument: (text, options) =>
      withEmbeddingError(
        () =>
          embedder.embed(text, {
            ...options,
            usage: options?.usage?.with({ role: 'embedding' }),
          }),
        options?.signal,
        'preserve-rejection',
      ),
    ...documentBatch(embedder),
    getMaxInputChars: embedder.getMaxInputChars?.bind(embedder),
    embedQuery: (text, options) =>
      withEmbeddingError(
        () =>
          embedder.embed(text, {
            ...options,
            usage: options?.usage?.with({ role: 'embedding' }),
          }),
        options?.signal,
        'preserve-rejection',
      ),
  };
}

/**
 * A retrieval embedder over an ASYMMETRIC model — one that embeds stored text
 * and search text differently (`nvidia--llama-3.2-nv-embedqa-1b`): the same
 * model twice, each instance set up for its job (for SAP AI Core,
 * `inputType: 'document'` / `'query'`).
 */
export function asymmetricEmbedder(halves: {
  document: IEmbedder;
  query: IEmbedder;
}): IRetrievalEmbedder {
  return {
    embedDocument: (text, options) =>
      withEmbeddingError(
        () =>
          halves.document.embed(text, {
            ...options,
            usage: options?.usage?.with({ role: 'embedding' }),
          }),
        options?.signal,
        'preserve-rejection',
      ),
    ...documentBatch(halves.document),
    getMaxInputChars: halves.document.getMaxInputChars?.bind(halves.document),
    embedQuery: (text, options) =>
      withEmbeddingError(
        () =>
          halves.query.embed(text, {
            ...options,
            usage: options?.usage?.with({ role: 'embedding' }),
          }),
        options?.signal,
        'preserve-rejection',
      ),
  };
}
