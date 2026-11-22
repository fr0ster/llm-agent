import type {
  IRequestLogger,
  LlmCallEntry,
  RagQueryEntry,
  ToolCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { DefaultRequestLogger } from './default-request-logger.js';

/** Keeps a worker's response usage local while forwarding each call to its ancestors. */
export class WorkerRequestLogger implements IRequestLogger {
  private readonly local = new DefaultRequestLogger();
  private readonly targets: ReadonlySet<IRequestLogger>;
  private readonly owned?: IRequestLogger;

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
    this.local.startRequest(requestId);
    this.owned?.startRequest(requestId);
  }

  endRequest(requestId?: string): void {
    this.local.endRequest(requestId);
    this.owned?.endRequest(requestId);
  }

  dropRequest(requestId?: string): void {
    this.local.dropRequest(requestId);
    this.owned?.dropRequest(requestId);
  }

  logLlmCall(entry: LlmCallEntry): void {
    for (const logger of this.targets) logger.logLlmCall(entry);
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
