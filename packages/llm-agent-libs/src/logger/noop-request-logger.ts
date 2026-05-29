import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';

const EMPTY_SUMMARY: RequestSummary = {
  totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 },
  byModel: {},
  byComponent: {},
  byCategory: {},
  ragQueries: 0,
  toolCalls: 0,
  totalDurationMs: 0,
};

export class NoopRequestLogger implements IRequestLogger {
  logLlmCall(_entry: LlmCallEntry): void {}
  logRagQuery(_entry: RagQueryEntry & { requestId?: string }): void {}
  logToolCall(_entry: ToolCallEntry & { requestId?: string }): void {}
  startRequest(_requestId?: string): void {}
  endRequest(_requestId?: string): void {}
  dropRequest(_requestId?: string): void {}
  getSummary(_requestId?: string): RequestSummary {
    return { ...EMPTY_SUMMARY, byModel: {}, byComponent: {}, byCategory: {} };
  }
  reset(): void {}
}
