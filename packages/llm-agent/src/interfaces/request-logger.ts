export type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'tool-definer'
  | 'helper'
  | 'translate'
  | 'query-expander'
  | 'embedding'
  | 'planner'
  | 'reviewer'
  | 'finalizer'
  | 'oracle';

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
  /** Request correlation id (the server's traceId). Routes the entry to the
   *  per-request delta; absent → session-cumulative only. */
  requestId?: string;
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
  /** Faithful sum across all byComponent entries (promptTokens, completionTokens,
   *  totalTokens, requests). Equal to reducing byComponent values; never null. */
  totals: TokenBucket;
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
  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void;
  logToolCall(entry: ToolCallEntry & { requestId?: string }): void;
  /** Enter a request scope. Nested-safe: depth-counted, bucket created if absent,
   *  NEVER clears an existing bucket. */
  startRequest(requestId?: string): void;
  /** Leave a request scope. Depth-counted; NEVER deletes the bucket. */
  endRequest(requestId?: string): void;
  /** Explicitly free a request delta. The top-level owner (server) calls this
   *  AFTER reading getSummary(requestId) for the response usage. */
  dropRequest(requestId?: string): void;
  getSummary(requestId?: string): RequestSummary;
  reset(): void;
}
