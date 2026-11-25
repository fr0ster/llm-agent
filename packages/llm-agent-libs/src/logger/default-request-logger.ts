import type {
  IRequestLogger,
  LlmCallEntry,
  LlmCallRecord,
  LlmComponent,
  RagQueryEntry,
  RequestSummary,
  TokenBucket,
  TokenCategory,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { addCacheTokenUsage } from '@mcp-abap-adt/llm-agent';
import { identifyRequestCall } from './request-call-scope.js';

/**
 * Component → token category mapping (shared with SessionRequestLogger so
 * /v1/usage categorizes per-session entries the same way single-request
 * deployments do). See review MEDIUM #4.
 */
export const CATEGORY_MAP: Record<LlmComponent, TokenCategory> = {
  'tool-loop': 'request',
  classifier: 'auxiliary',
  'tool-definer': 'auxiliary',
  'tool-retriever': 'auxiliary',
  'skill-retriever': 'auxiliary',
  translate: 'auxiliary',
  'query-expander': 'auxiliary',
  helper: 'auxiliary',
  embedding: 'initialization',
  planner: 'auxiliary',
  evaluator: 'auxiliary',
  executor: 'request',
  reviewer: 'auxiliary',
  finalizer: 'auxiliary',
  oracle: 'auxiliary',
  decision: 'auxiliary',
  rerank: 'auxiliary',
};

function emptyBucket(): TokenBucket {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

function addToBucket(bucket: TokenBucket, entry: LlmCallEntry): void {
  Object.assign(bucket, addCacheTokenUsage(bucket, entry));
  bucket.promptTokens += entry.promptTokens;
  bucket.completionTokens += entry.completionTokens;
  bucket.totalTokens += entry.totalTokens;
  bucket.requests += entry.requests ?? 1;
}

export class DefaultRequestLogger implements IRequestLogger {
  private initLlmCalls: LlmCallEntry[] = [];
  private requestLlmCalls: LlmCallEntry[] = [];
  private readonly initCallIds = new Set<string>();
  private readonly requestCallIds = new Set<string>();
  private ragQueryEntries: RagQueryEntry[] = [];
  private toolCallEntries: ToolCallEntry[] = [];
  private requestStartMs = 0;
  private requestDurationMs = 0;
  private requestId?: string;

  startRequest(requestId?: string): void {
    this.requestId = requestId;
    this.requestLlmCalls = [];
    this.requestCallIds.clear();
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestDurationMs = 0;
    this.requestStartMs = Date.now();
  }

  endRequest(_requestId?: string): void {
    this.requestDurationMs = this.requestStartMs
      ? Date.now() - this.requestStartMs
      : 0;
  }

  dropRequest(requestId?: string): void {
    if (requestId === undefined || requestId === this.requestId) this.reset();
  }

  logLlmCall(entry: LlmCallEntry): void {
    entry = identifyRequestCall(this, entry);
    const { callId } = entry;
    if (callId !== undefined) {
      if (this.hasCall(callId)) return;
      const ids =
        entry.scope === 'initialization'
          ? this.initCallIds
          : this.requestCallIds;
      ids.add(callId);
    }
    if (entry.scope === 'initialization') {
      this.initLlmCalls.push(entry);
    } else {
      this.requestLlmCalls.push(entry);
    }
  }

  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void {
    this.ragQueryEntries.push(entry);
  }

  logToolCall(entry: ToolCallEntry & { requestId?: string }): void {
    this.toolCallEntries.push(entry);
  }

  hasCall(callId: string): boolean {
    return this.initCallIds.has(callId) || this.requestCallIds.has(callId);
  }

  get usageCalls(): readonly LlmCallRecord[] {
    return [...this.initLlmCalls, ...this.requestLlmCalls].filter(
      (entry): entry is LlmCallRecord => entry.callId !== undefined,
    );
  }

  getSummary(_requestId?: string): RequestSummary {
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

      const cat =
        call.component === 'embedding' && call.scope === 'request'
          ? 'request'
          : (CATEGORY_MAP[call.component] ?? 'request');
      if (!byCategory[cat]) byCategory[cat] = emptyBucket();
      addToBucket(byCategory[cat], call);
    }

    // Derive totals as the faithful sum of byComponent.
    const totals = emptyBucket();
    for (const comp of Object.values(byComponent)) {
      Object.assign(totals, addCacheTokenUsage(totals, comp));
      totals.promptTokens += comp.promptTokens;
      totals.completionTokens += comp.completionTokens;
      totals.totalTokens += comp.totalTokens;
      totals.requests += comp.requests;
    }
    return {
      totals,
      byModel,
      byComponent,
      byCategory,
      ragQueries: this.ragQueryEntries.length,
      toolCalls: this.toolCallEntries.length,
      totalDurationMs: this.requestDurationMs,
    };
  }

  reset(): void {
    this.requestId = undefined;
    this.requestLlmCalls = [];
    this.requestCallIds.clear();
    this.ragQueryEntries = [];
    this.toolCallEntries = [];
    this.requestStartMs = 0;
    this.requestDurationMs = 0;
    // NOTE: initLlmCalls is intentionally NOT reset
  }
}
