import type { ILlm } from '../interfaces/llm.js';
import type { IRequestLogger } from '../interfaces/request-logger.js';
import type { CallOptions, RagError, Result } from '../interfaces/types.js';
/**
 * Transforms query text before RAG search.
 * Used for translation, expansion, normalization, etc.
 * Runs inside IRag.query() before embedding.
 */
export interface IQueryPreprocessor {
    readonly name: string;
    process(text: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
/**
 * Enriches document text before RAG storage.
 * Used for adding translations, synonyms, example queries, etc.
 * Runs inside IRag.upsert() before embedding.
 */
export interface IDocumentEnricher {
    readonly name: string;
    enrich(text: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
export declare class NoopQueryPreprocessor implements IQueryPreprocessor {
    readonly name = "noop";
    process(text: string): Promise<Result<string, RagError>>;
}
export declare class NoopDocumentEnricher implements IDocumentEnricher {
    readonly name = "noop";
    enrich(text: string): Promise<Result<string, RagError>>;
}
/**
 * Translates non-ASCII queries to English via helper LLM.
 * Passes through ASCII-only text and short text (< 15 chars) without LLM call.
 * Falls back to original text on LLM failure.
 */
export declare class TranslatePreprocessor implements IQueryPreprocessor {
    private readonly llm;
    private readonly requestLogger?;
    private readonly systemPrompt?;
    readonly name = "translate";
    constructor(llm: ILlm, requestLogger?: IRequestLogger | undefined, systemPrompt?: string | undefined);
    process(text: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
/**
 * Expands queries with LLM-generated synonyms and related terms.
 * Concatenates original + expansion for broader recall.
 */
export declare class ExpandPreprocessor implements IQueryPreprocessor {
    private readonly llm;
    private readonly requestLogger?;
    private readonly systemPrompt?;
    readonly name = "expand";
    constructor(llm: ILlm, requestLogger?: IRequestLogger | undefined, systemPrompt?: string | undefined);
    process(text: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
/**
 * Generates concise intent-based descriptions via LLM.
 * Replaces verbose tool descriptions with short keyword phrases
 * that match how users actually search.
 *
 * Output format: "ToolName: original_description\nIntent: keyword1, keyword2, ..."
 * Both original and intent are stored — BM25 matches keywords, vector matches semantics.
 */
export declare class IntentEnricher implements IDocumentEnricher {
    private readonly llm;
    private readonly requestLogger?;
    private readonly systemPrompt?;
    readonly name = "intent";
    constructor(llm: ILlm, requestLogger?: IRequestLogger | undefined, systemPrompt?: string | undefined);
    enrich(text: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
/**
 * Runs multiple preprocessors in sequence.
 * Output of each becomes input of the next.
 * Stops and returns error on first failure.
 */
export declare class PreprocessorChain implements IQueryPreprocessor {
    private readonly preprocessors;
    readonly name: string;
    constructor(preprocessors: IQueryPreprocessor[]);
    process(text: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
//# sourceMappingURL=preprocessor.d.ts.map