import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IEmbedder, IEmbedResult } from '../interfaces/rag.js';
import type { CallOptions } from '../interfaces/types.js';
/**
 * Lazy, memoized query embedding.
 *
 * First `toVector()` call triggers the real embed; all subsequent
 * (or concurrent) calls return the same promise.
 */
export declare class QueryEmbedding implements IQueryEmbedding {
    private readonly embedder;
    private readonly options?;
    readonly text: string;
    private _result;
    constructor(text: string, embedder: IEmbedder, options?: CallOptions | undefined);
    private _getResult;
    toVector(): Promise<number[]>;
    getUsage(): Promise<IEmbedResult['usage']>;
}
/**
 * Text-only embedding for stores that don't need vectors (e.g. InMemoryRag).
 * Throws on `toVector()` — only `.text` is usable.
 */
export declare class TextOnlyEmbedding implements IQueryEmbedding {
    readonly text: string;
    constructor(text: string);
    toVector(): Promise<number[]>;
}
/**
 * Decorator: tries the inner embedding first; on failure falls back
 * to the supplied embedder.  Result is memoized so concurrent callers
 * share one promise — same contract as {@link QueryEmbedding}.
 */
export declare class FallbackQueryEmbedding implements IQueryEmbedding {
    private readonly inner;
    private readonly fallback;
    private _vector;
    constructor(inner: IQueryEmbedding, fallback: IEmbedder);
    get text(): string;
    toVector(): Promise<number[]>;
}
//# sourceMappingURL=query-embedding.d.ts.map