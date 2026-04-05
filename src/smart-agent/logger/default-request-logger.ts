import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
} from '../interfaces/request-logger.js';

export class DefaultRequestLogger implements IRequestLogger {
  private llmCalls: LlmCallEntry[] = [];
  private ragQueryEntries: RagQueryEntry[] = [];
  private toolCallEntries: ToolCallEntry[] = [];
  private requestStartMs = 0;
  private requestDurationMs = 0;

  startRequest(): void {
    this.requestStartMs = Date.now();
  }

  endRequest(): void {
    this.requestDurationMs = this.requestStartMs
      ? Date.now() - this.requestStartMs
      : 0;
  }

  logLlmCall(entry: LlmCallEntry): void {
    this.llmCalls.push(entry);
  }

  logRagQuery(entry: RagQueryEntry): void {
    this.ragQueryEntries.push(entry);
  }

  logToolCall(entry: ToolCallEntry): void {
    this.toolCallEntries.push(entry);
  }

  getSummary(): RequestSummary {
    const byModel: RequestSummary['byModel'] = {};
    const byComponent: RequestSummary['byComponent'] = {};

    for (const call of this.llmCalls) {
      if (!byModel[call.model]) {
        byModel[call.model] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requests: 0,
        };
      }
      const m = byModel[call.model];
      m.promptTokens += call.promptTokens;
      m.completionTokens += call.completionTokens;
      m.totalTokens += call.totalTokens;
      m.requests++;

      if (!byComponent[call.component]) {
        byComponent[call.component] = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          requests: 0,
        };
      }
      const c = byComponent[call.component];
      c.promptTokens += call.promptTokens;
      c.completionTokens += call.completionTokens;
      c.totalTokens += call.totalTokens;
      c.requests++;
    }

    return {
      byModel,
      byComponent,
      ragQueries: this.ragQueryEntries.length,
      toolCalls: this.toolCallEntries.length,
      totalDurationMs: this.requestDurationMs,
    };
  }

  reset(): void {
    this.llmCalls = [];
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestStartMs = 0;
    this.requestDurationMs = 0;
  }
}
