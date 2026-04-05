export type LlmComponent =
  | 'tool-loop'
  | 'classifier'
  | 'helper'
  | 'translate'
  | 'query-expander';

export interface LlmCallEntry {
  component: LlmComponent;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
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
  byModel: Record<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      requests: number;
    }
  >;
  /** Per-component aggregated token usage. */
  byComponent: Record<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      requests: number;
    }
  >;
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
