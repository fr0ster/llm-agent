import type { IRag, IRetrievalEmbedder } from './rag.js';
import { isRagDecorator } from './retrieval-strategy.js';

/** Optional capability: a store that embeds its own documents exposes its embedder. */
export interface IRetrievalEmbedderOwner {
  readonly retrievalEmbedder: IRetrievalEmbedder;
}

export function isRetrievalEmbedderOwner(
  rag: IRag,
): rag is IRag & IRetrievalEmbedderOwner {
  const e = (rag as Partial<IRetrievalEmbedderOwner>).retrievalEmbedder;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.embedDocument === 'function' &&
    typeof e.embedQuery === 'function'
  );
}

/** The embedder of `rag` or of the first store it decorates (≤ 16 levels, like hasRetrievalStrategy). */
export function retrievalEmbedderOf(rag: IRag): IRetrievalEmbedder | undefined {
  let cur: IRag | undefined = rag;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (isRetrievalEmbedderOwner(cur)) return cur.retrievalEmbedder;
    cur = isRagDecorator(cur) ? cur.inner : undefined;
  }
  return undefined;
}
