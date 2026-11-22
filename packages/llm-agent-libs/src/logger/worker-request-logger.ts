import { randomUUID } from 'node:crypto';
import type {
  IRequestLogger,
  LlmCallEntry,
  LlmCallRecord,
  RagQueryEntry,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { DefaultRequestLogger } from './default-request-logger.js';
import { observeRequestCalls } from './request-call-scope.js';

// Parallel workers may own overlapping scopes in the same configured logger.
const activeOwnedRequests = new WeakMap<
  IRequestLogger,
  Map<string | undefined, number>
>();

/** Keeps a worker's response usage local while forwarding each call to its ancestors. */
export class WorkerRequestLogger implements IRequestLogger {
  private readonly local = new DefaultRequestLogger();
  private readonly targets: ReadonlySet<IRequestLogger>;
  private readonly owned?: IRequestLogger;
  private requestId?: string;

  constructor(
    private readonly configured: IRequestLogger,
    parent: IRequestLogger,
  ) {
    const upstream =
      parent instanceof WorkerRequestLogger
        ? parent.targets
        : new Set([parent]);
    const configuredTargets =
      configured instanceof WorkerRequestLogger
        ? configured.targets
        : [configured];
    this.targets = new Set([this.local, ...configuredTargets, ...upstream]);
    // The parent owns a shared logger's request scope. In particular, a nested
    // startRequest would reset a shared DefaultRequestLogger.
    const configuredScope =
      configured instanceof WorkerRequestLogger ? configured.local : configured;
    if (!upstream.has(configuredScope)) this.owned = configured;
  }

  startRequest(requestId?: string): void {
    this.requestId = requestId;
    this.local.startRequest(requestId);
    if (this.owned) {
      this.owned.startRequest(requestId);
      let requests = activeOwnedRequests.get(this.owned);
      if (!requests) {
        requests = new Map();
        activeOwnedRequests.set(this.owned, requests);
      }
      requests.set(requestId, (requests.get(requestId) ?? 0) + 1);
    }
  }

  endRequest(requestId?: string): void {
    this.local.endRequest(requestId);
    if (this.owned) {
      this.owned.endRequest(requestId);
      const requests = activeOwnedRequests.get(this.owned);
      const count = requests?.get(requestId) ?? 0;
      if (count > 1) requests?.set(requestId, count - 1);
      else requests?.delete(requestId);
    }
  }

  dropRequest(requestId?: string): void {
    this.local.dropRequest(requestId);
    if (this.owned && !activeOwnedRequests.get(this.owned)?.has(requestId)) {
      this.owned.dropRequest(requestId);
    }
  }

  observeCalls<T>(
    requestId: string | undefined,
    calls: Map<string, LlmCallRecord>,
    run: () => Promise<T>,
  ): Promise<T> {
    return observeRequestCalls(this.targets, requestId, calls, run);
  }

  logLlmCall(entry: LlmCallEntry): void {
    const callId = entry.callId ?? randomUUID();
    if (this.local.hasCall(callId)) return;
    const call = {
      ...entry,
      callId,
      requestId: entry.requestId ?? this.requestId,
    };
    for (const logger of this.targets) logger.logLlmCall(call);
  }

  get usageCalls(): readonly LlmCallRecord[] {
    return this.local.usageCalls;
  }

  logRagQuery(entry: RagQueryEntry & { requestId?: string }): void {
    this.local.logRagQuery(entry);
    this.configured.logRagQuery(entry);
  }

  logToolCall(entry: ToolCallEntry & { requestId?: string }): void {
    this.local.logToolCall(entry);
    this.configured.logToolCall(entry);
  }

  getSummary(requestId?: string) {
    return this.local.getSummary(requestId);
  }

  reset(): void {
    this.local.reset();
    this.owned?.reset();
  }
}
