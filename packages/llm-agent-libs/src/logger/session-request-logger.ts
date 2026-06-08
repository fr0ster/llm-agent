import type {
  IRequestLogger,
  LlmCallEntry,
  LlmUsage,
  RagQueryEntry,
  RequestSummary,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { CATEGORY_MAP } from './default-request-logger.js';

interface Bucket {
  llm: LlmCallEntry[];
  rag: number;
  tool: number;
}

function emptyBucket(): Bucket {
  return { llm: [], rag: 0, tool: 0 };
}

/** Shared aggregation (DRY with DefaultRequestLogger.getSummary). */
export function aggregate(b: Bucket): RequestSummary {
  const byModel: RequestSummary['byModel'] = {};
  const byComponent: RequestSummary['byComponent'] = {};
  const byCategory: RequestSummary['byCategory'] = {};
  let totalDurationMs = 0;
  const zeroBucket = () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requests: 0,
  });
  for (const c of b.llm) {
    totalDurationMs += c.durationMs;
    byModel[c.model] ??= zeroBucket();
    const m = byModel[c.model];
    m.promptTokens += c.promptTokens;
    m.completionTokens += c.completionTokens;
    m.totalTokens += c.totalTokens;
    m.requests++;
    byComponent[c.component] ??= zeroBucket();
    const comp = byComponent[c.component];
    comp.promptTokens += c.promptTokens;
    comp.completionTokens += c.completionTokens;
    comp.totalTokens += c.totalTokens;
    comp.requests++;
    // Use the component-keyed CATEGORY_MAP — same semantics as
    // DefaultRequestLogger.getSummary (review MEDIUM #4). Previously this
    // categorized via `c.scope ?? 'request'`, which dropped most aux calls
    // (classifier/translate/query-expander/helper have no `scope`) into
    // `request`, misreporting /v1/usage.byCategory.
    const catKey =
      c.component === 'embedding' && c.scope === 'request'
        ? 'request'
        : (CATEGORY_MAP[c.component] ?? 'request');
    byCategory[catKey] ??= zeroBucket();
    const cat = byCategory[catKey];
    cat.promptTokens += c.promptTokens;
    cat.completionTokens += c.completionTokens;
    cat.totalTokens += c.totalTokens;
    cat.requests++;
  }
  // Derive totals as the faithful sum of byComponent so that /v1/usage always
  // has a non-null rollup regardless of which path (DAG/Stepper/flat) was used.
  const totals = zeroBucket();
  for (const comp of Object.values(byComponent)) {
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
    ragQueries: b.rag,
    toolCalls: b.tool,
    totalDurationMs,
  };
}

/** Sum a summary's components into a flat usage triple for response.usage. */
export function summaryToUsage(s: RequestSummary): LlmUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const v of Object.values(s.byComponent)) {
    promptTokens += v.promptTokens;
    completionTokens += v.completionTokens;
    totalTokens += v.totalTokens;
  }
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * One logger per SessionGraph, shared by the coordinator AND its workers. Two
 * accounting axes (spec C.2):
 *  - session-cumulative (survives across requests, for /v1/usage),
 *  - per-traceId delta (for response.usage; keyed so concurrent requests never
 *    stomp each other).
 *
 * NESTED-SAFE: a worker's SmartAgent.process() runs startRequest(traceId) /
 * endRequest(traceId) under the SAME traceId as the coordinator. Therefore:
 *   - startRequest is depth-counted and creates the bucket ONLY if absent
 *     (never clears an existing one — a worker start must not wipe coordinator
 *     tokens already logged under that traceId),
 *   - endRequest is depth-counted and NEVER deletes the bucket (a worker end
 *     must not drop the delta before the server emits response.usage),
 *   - dropRequest is the explicit free, called by the top-level owner (the
 *     server) AFTER it has read getSummary(traceId).
 */
export class SessionRequestLogger implements IRequestLogger {
  private readonly cumulative = emptyBucket();
  private readonly deltas = new Map<string, Bucket>();
  private readonly depth = new Map<string, number>();

  startRequest(requestId?: string): void {
    if (!requestId) return;
    this.depth.set(requestId, (this.depth.get(requestId) ?? 0) + 1);
    if (!this.deltas.has(requestId)) this.deltas.set(requestId, emptyBucket());
  }

  endRequest(requestId?: string): void {
    if (!requestId) return;
    const d = this.depth.get(requestId);
    if (d === undefined) return;
    if (d <= 1) this.depth.delete(requestId);
    else this.depth.set(requestId, d - 1);
    // Intentionally does NOT delete the delta bucket: the server frees it via
    // dropRequest() after reading response.usage.
  }

  /** Explicit free of a request delta. Called once by the top-level owner. */
  dropRequest(requestId?: string): void {
    if (!requestId) return;
    this.deltas.delete(requestId);
    this.depth.delete(requestId);
  }

  logLlmCall(entry: LlmCallEntry): void {
    this.cumulative.llm.push(entry);
    if (entry.requestId) this.deltaFor(entry.requestId).llm.push(entry);
  }

  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void {
    this.cumulative.rag++;
    if (entry.requestId) this.deltaFor(entry.requestId).rag++;
  }

  logToolCall(entry: ToolCallEntry & { requestId?: string }): void {
    this.cumulative.tool++;
    if (entry.requestId) this.deltaFor(entry.requestId).tool++;
  }

  getSummary(requestId?: string): RequestSummary {
    if (requestId)
      return aggregate(this.deltas.get(requestId) ?? emptyBucket());
    return aggregate(this.cumulative);
  }

  reset(): void {
    this.cumulative.llm.length = 0;
    this.cumulative.rag = 0;
    this.cumulative.tool = 0;
    this.deltas.clear();
    this.depth.clear();
  }

  /** Get-or-create the delta bucket for a requestId (used by log* when a call
   *  arrives before startRequest, e.g. a deeply nested worker). */
  private deltaFor(requestId: string): Bucket {
    let b = this.deltas.get(requestId);
    if (!b) {
      b = emptyBucket();
      this.deltas.set(requestId, b);
    }
    return b;
  }
}
