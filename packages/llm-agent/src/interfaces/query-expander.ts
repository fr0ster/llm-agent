// packages/llm-agent/src/interfaces/query-expander.ts
import type { CallOptions, RagError, Result } from './types.js';

/** Rewrites one query into one query, once per request (pipeline stage). Contract of the
 *  query expanders; moved here from `rag/query-expander.ts` (spec §11.3) — same name, same export. */
export interface IQueryExpander {
  expand(
    query: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}
