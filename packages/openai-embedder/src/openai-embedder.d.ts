import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions } from '@mcp-abap-adt/llm-agent';
export interface OpenAiEmbedderConfig {
  /** API key for OpenAI-compatible service */
  apiKey: string;
  /** API base URL. Default: 'https://api.openai.com/v1' */
  baseURL?: string;
  /** Embedding model. Default: 'text-embedding-3-small' */
  model?: string;
  /** Per-request timeout in milliseconds. Default: 30 000 */
  timeoutMs?: number;
}
export declare class OpenAiEmbedder implements IEmbedderBatch {
  private readonly baseURL;
  private readonly apiKey;
  private readonly model;
  private readonly timeoutMs;
  constructor(config: OpenAiEmbedderConfig);
  embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
  embedBatch(texts: string[], options?: CallOptions): Promise<IEmbedResult[]>;
}
//# sourceMappingURL=openai-embedder.d.ts.map
