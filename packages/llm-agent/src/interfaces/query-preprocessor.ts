// packages/llm-agent/src/interfaces/query-preprocessor.ts
import type { CallOptions, RagError, Result } from './types.js';

/**
 * Transforms query text before RAG search.
 * Used for translation, expansion, normalization, etc.
 * Runs inside IRag.query() before embedding.
 */
export interface IQueryPreprocessor {
  readonly name: string;
  process(
    text: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}

/**
 * Enriches document text before RAG storage.
 * Used for adding translations, synonyms, example queries, etc.
 * Runs inside IRag.upsert() before embedding.
 */
export interface IDocumentEnricher {
  readonly name: string;
  enrich(
    text: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}
