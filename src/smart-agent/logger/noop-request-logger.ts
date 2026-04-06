import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
} from '../interfaces/request-logger.js';

const EMPTY_SUMMARY: RequestSummary = {
  byModel: {},
  byComponent: {},
  byCategory: {},
  ragQueries: 0,
  toolCalls: 0,
  totalDurationMs: 0,
};

export class NoopRequestLogger implements IRequestLogger {
  logLlmCall(_entry: LlmCallEntry): void {}
  logRagQuery(_entry: RagQueryEntry): void {}
  logToolCall(_entry: ToolCallEntry): void {}
  startRequest(): void {}
  endRequest(): void {}
  getSummary(): RequestSummary {
    return { ...EMPTY_SUMMARY, byModel: {}, byComponent: {}, byCategory: {} };
  }
  reset(): void {}
}
