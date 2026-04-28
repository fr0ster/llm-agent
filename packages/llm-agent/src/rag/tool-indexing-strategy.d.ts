import type { ILlm } from '../interfaces/llm.js';
import type { IRequestLogger } from '../interfaces/request-logger.js';
import type { CallOptions } from '../interfaces/types.js';
/**
 * A tool description to be indexed in RAG.
 */
export interface IToolDescriptor {
  name: string;
  description: string;
}
/**
 * A text variant to upsert into RAG. Each variant gets its own embedding.
 * Multiple variants per tool = broader recall.
 */
export interface IToolIndexEntry {
  /** RAG record id. Format: tool:<name>[:<suffix>] */
  id: string;
  /** Text to embed and store. */
  text: string;
}
/**
 * Generates text variants for tool indexing in RAG.
 * Each strategy produces one or more entries per tool.
 * Strategies can be combined — builder upserts all entries from all strategies.
 */
export interface IToolIndexingStrategy {
  readonly name: string;
  prepare(
    tool: IToolDescriptor,
    options?: CallOptions,
  ): Promise<IToolIndexEntry[]>;
}
/**
 * Indexes the raw tool description as-is.
 * This is the current default behavior.
 */
export declare class OriginalToolIndexing implements IToolIndexingStrategy {
  readonly name = 'original';
  prepare(tool: IToolDescriptor): Promise<IToolIndexEntry[]>;
}
/**
 * LLM generates concise intent keywords for the tool.
 * Indexed alongside the original for broader keyword coverage.
 */
export declare class IntentToolIndexing implements IToolIndexingStrategy {
  private readonly llm;
  private readonly requestLogger?;
  readonly name = 'intent';
  constructor(llm: ILlm, requestLogger?: IRequestLogger | undefined);
  prepare(
    tool: IToolDescriptor,
    options?: CallOptions,
  ): Promise<IToolIndexEntry[]>;
}
/**
 * Adds action verb synonyms to the tool description.
 * E.g. "ReadClass" → also indexed with "show class, display class, view class".
 * Purely deterministic — no LLM needed.
 */
export declare class SynonymToolIndexing implements IToolIndexingStrategy {
  readonly name = 'synonym';
  prepare(tool: IToolDescriptor): Promise<IToolIndexEntry[]>;
}
//# sourceMappingURL=tool-indexing-strategy.d.ts.map
