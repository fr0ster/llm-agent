import { RagError } from '../interfaces/types.js';
/**
 * Lazy, memoized query embedding.
 *
 * First `toVector()` call triggers the real embed; all subsequent
 * (or concurrent) calls return the same promise.
 */
export class QueryEmbedding {
    embedder;
    options;
    text;
    _result = null;
    constructor(text, embedder, options) {
        this.embedder = embedder;
        this.options = options;
        this.text = text;
    }
    _getResult() {
        this._result ??= this.embedder.embed(this.text, this.options);
        return this._result;
    }
    toVector() {
        return this._getResult().then((r) => r.vector);
    }
    getUsage() {
        return this._getResult().then((r) => r.usage);
    }
}
/**
 * Text-only embedding for stores that don't need vectors (e.g. InMemoryRag).
 * Throws on `toVector()` — only `.text` is usable.
 */
export class TextOnlyEmbedding {
    text;
    constructor(text) {
        this.text = text;
    }
    toVector() {
        return Promise.reject(new RagError('No embedder configured — cannot vectorize query', 'EMBED_ERROR'));
    }
}
/**
 * Decorator: tries the inner embedding first; on failure falls back
 * to the supplied embedder.  Result is memoized so concurrent callers
 * share one promise — same contract as {@link QueryEmbedding}.
 */
export class FallbackQueryEmbedding {
    inner;
    fallback;
    _vector = null;
    constructor(inner, fallback) {
        this.inner = inner;
        this.fallback = fallback;
    }
    get text() {
        return this.inner.text;
    }
    toVector() {
        this._vector ??= this.inner
            .toVector()
            .catch(() => this.fallback.embed(this.text).then((r) => r.vector));
        return this._vector;
    }
}
//# sourceMappingURL=query-embedding.js.map