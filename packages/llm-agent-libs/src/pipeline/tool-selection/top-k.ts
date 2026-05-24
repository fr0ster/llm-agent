import type {
  IToolSelectionStrategy,
  RagResult,
} from '@mcp-abap-adt/llm-agent';

/**
 * Default strategy: passthrough. The top-K cap is already applied at the RAG
 * store query, so keeping all results reproduces the historical behavior.
 */
export class TopKToolSelection implements IToolSelectionStrategy {
  readonly name = 'top-k';
  select(results: RagResult[]): RagResult[] {
    return results;
  }
}
