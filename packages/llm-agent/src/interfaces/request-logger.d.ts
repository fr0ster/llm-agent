export type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'helper'
  | 'translate'
  | 'query-expander'
  | 'embedding';
export type TokenCategory = 'initialization' | 'auxiliary' | 'request';
export interface TokenBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  items?: number;
}
export interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated?: boolean;
  scope?: 'initialization' | 'request';
  detail?: string;
}
export interface RagQueryEntry {
  store: string;
  query: string;
  resultCount: number;
  durationMs: number;
}
export interface ToolCallEntry {
  toolName: string;
  success: boolean;
  durationMs: number;
  cached: boolean;
}
export interface RequestSummary {
  /** Per-model aggregated token usage. */
  byModel: Record<string, TokenBucket>;
  /** Per-component aggregated token usage. */
  byComponent: Record<string, TokenBucket>;
  /** Per-category aggregated token usage. */
  byCategory: Record<string, TokenBucket>;
  ragQueries: number;
  toolCalls: number;
  /** Wall-clock time for the entire request. */
  totalDurationMs: number;
}
export interface IRequestLogger {
  logLlmCall(entry: LlmCallEntry): void;
  logRagQuery(entry: RagQueryEntry): void;
  logToolCall(entry: ToolCallEntry): void;
  /** Mark the start of a request for wall-clock duration tracking. */
  startRequest(): void;
  /** Mark the end of a request for wall-clock duration tracking. */
  endRequest(): void;
  getSummary(): RequestSummary;
  reset(): void;
}
//# sourceMappingURL=request-logger.d.ts.map
