import type {
  IRequestLogger,
  LlmCallEntry,
  LlmComponent,
  RagQueryEntry,
  RequestSummary,
  TokenBucket,
  TokenCategory,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';

const CATEGORY_MAP: Record<LlmComponent, TokenCategory> = {
  'tool-loop': 'request',
  classifier: 'auxiliary',
  translate: 'auxiliary',
  'query-expander': 'auxiliary',
  helper: 'auxiliary',
  embedding: 'initialization',
};

function emptyBucket(): TokenBucket {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

function addToBucket(bucket: TokenBucket, entry: LlmCallEntry): void {
  bucket.promptTokens += entry.promptTokens;
  bucket.completionTokens += entry.completionTokens;
  bucket.totalTokens += entry.totalTokens;
  bucket.requests++;
}

export class DefaultRequestLogger implements IRequestLogger {
  private initLlmCalls: LlmCallEntry[] = [];
  private requestLlmCalls: LlmCallEntry[] = [];
  private ragQueryEntries: RagQueryEntry[] = [];
  private toolCallEntries: ToolCallEntry[] = [];
  private requestStartMs = 0;
  private requestDurationMs = 0;

  startRequest(): void {
    this.requestLlmCalls = [];
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestDurationMs = 0;
    this.requestStartMs = Date.now();
  }

  endRequest(): void {
    this.requestDurationMs = this.requestStartMs
      ? Date.now() - this.requestStartMs
      : 0;
  }

  logLlmCall(entry: LlmCallEntry): void {
    if (entry.scope === 'initialization') {
      this.initLlmCalls.push(entry);
    } else {
      this.requestLlmCalls.push(entry);
    }
  }

  logRagQuery(entry: RagQueryEntry): void {
    this.ragQueryEntries.push(entry);
  }

  logToolCall(entry: ToolCallEntry): void {
    this.toolCallEntries.push(entry);
  }

  getSummary(): RequestSummary {
    const byModel: Record<string, TokenBucket> = {};
    const byComponent: Record<string, TokenBucket> = {};
    const byCategory: Record<string, TokenBucket> = {};

    const allCalls = [...this.initLlmCalls, ...this.requestLlmCalls];

    for (const call of allCalls) {
      if (!byModel[call.model]) byModel[call.model] = emptyBucket();
      addToBucket(byModel[call.model], call);

      if (!byComponent[call.component])
        byComponent[call.component] = emptyBucket();
      addToBucket(byComponent[call.component], call);

      const cat = CATEGORY_MAP[call.component] ?? 'request';
      if (!byCategory[cat]) byCategory[cat] = emptyBucket();
      addToBucket(byCategory[cat], call);
    }

    return {
      byModel,
      byComponent,
      byCategory,
      ragQueries: this.ragQueryEntries.length,
      toolCalls: this.toolCallEntries.length,
      totalDurationMs: this.requestDurationMs,
    };
  }

  reset(): void {
    this.requestLlmCalls = [];
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestStartMs = 0;
    this.requestDurationMs = 0;
    // NOTE: initLlmCalls is intentionally NOT reset
  }
}
