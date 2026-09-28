import type { IEmbedder, StoreEmbedders } from '../interfaces/rag.js';

/**
 * A store's embedders from an embedder and an optional query half: the pair
 * when both are given, the embedder alone (it must then be symmetric) when not.
 */
export function storeEmbedders(
  embedder: IEmbedder,
  queryEmbedder?: IEmbedder,
): StoreEmbedders {
  return queryEmbedder ? { embedder, queryEmbedder } : { embedder };
}
