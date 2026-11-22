import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  IRequestLogger,
  LlmCallEntry,
  LlmCallRecord,
} from '@mcp-abap-adt/llm-agent';

interface RequestCallScope {
  capture?: {
    loggers: ReadonlySet<IRequestLogger>;
    requestId?: string;
    calls: Map<string, LlmCallRecord>;
  };
  parent?: RequestCallScope;
}

const requestCalls = new AsyncLocalStorage<RequestCallScope>();

/** Follow a dispatch through awaits, including workers that close over the shared logger. */
export async function observeRequestCalls<T>(
  loggers: ReadonlySet<IRequestLogger>,
  requestId: string | undefined,
  calls: Map<string, LlmCallRecord>,
  run: () => Promise<T>,
): Promise<T> {
  const scope: RequestCallScope = {
    capture: { loggers, requestId, calls },
    parent: requestCalls.getStore(),
  };
  try {
    return await requestCalls.run(scope, run);
  } finally {
    scope.capture = undefined;
  }
}

export function identifyRequestCall(
  logger: IRequestLogger,
  entry: LlmCallEntry,
): LlmCallEntry {
  if (entry.scope === 'initialization') return entry;
  let record: LlmCallRecord | undefined;
  for (let scope = requestCalls.getStore(); scope; scope = scope.parent) {
    const capture = scope.capture;
    if (
      !capture?.loggers.has(logger) ||
      (entry.requestId !== undefined && entry.requestId !== capture.requestId)
    )
      continue;
    record ??= {
      ...entry,
      callId: entry.callId ?? randomUUID(),
      requestId: entry.requestId ?? capture.requestId,
    };
    if (!capture.calls.has(record.callId))
      capture.calls.set(record.callId, record);
  }
  return record ?? entry;
}
