import {
  type IEmbedder,
  type IRetrievalEmbedder,
  isBatchEmbedder,
} from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';

/** `embedDocuments` when — and only when — `embedder` batches. */
function documentBatch(
  embedder: IEmbedder,
): Pick<IRetrievalEmbedder, 'embedDocuments'> {
  return isBatchEmbedder(embedder)
    ? {
        embedDocuments: (texts: string[], options?: CallOptions) =>
          embedder.embedBatch(texts, options),
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
    embedDocument: (text, options) => embedder.embed(text, options),
    ...documentBatch(embedder),
    embedQuery: (text, options) => embedder.embed(text, options),
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
    embedDocument: (text, options) => halves.document.embed(text, options),
    ...documentBatch(halves.document),
    embedQuery: (text, options) => halves.query.embed(text, options),
  };
}
