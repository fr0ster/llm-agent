import {
  contextExceededError,
  embeddingContextExceededError,
  OrchestratorError,
  SmartAgentError,
} from '@mcp-abap-adt/llm-agent';
import {
  errorUsage,
  originalUsageError,
  withUsageAttribution,
} from '../logger/llm-call-usage.js';

/** Recognize a signal's reason through usage copies and cause wrappers. */
function isAbortReason<T>(error: T, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const suppliedReason = signal.reason;
  const reason =
    typeof suppliedReason === 'object' && suppliedReason !== null
      ? originalUsageError(suppliedReason)
      : suppliedReason;
  if (error === reason) return true;
  if (typeof error !== 'object' || error === null) return false;

  const seen = new Set<object>();
  let current: object = error;
  while (!seen.has(current)) {
    if (originalUsageError(current) === reason) return true;
    seen.add(current);
    const cause = 'cause' in current ? current.cause : undefined;
    if (cause === reason) return true;
    if (typeof cause !== 'object' || cause === null) break;
    current = cause;
  }
  return false;
}

/** Recognize cancellation before inspecting causes for independent overflows. */
export function runInterruption<T>(
  signal: AbortSignal | undefined,
  errors: readonly T[] = [],
  mode?: 'throw-signal-abort',
): SmartAgentError | undefined {
  let aborted: SmartAgentError | undefined;
  let rethrow: (() => never) | undefined;
  for (const error of errors) {
    if (isAbortReason(error, signal)) {
      aborted ??= abortRunError(signal?.reason, error);
      rethrow ??= () => {
        throw error;
      };
    } else if (error instanceof SmartAgentError && error.code === 'ABORTED') {
      aborted ??= error;
    } else if (error instanceof Error && error.name === 'AbortError') {
      aborted ??= abortRunError(error, error);
    } else {
      const overflow =
        contextExceededError(error) ?? embeddingContextExceededError(error);
      if (overflow) return overflow;
    }
  }
  if (mode === 'throw-signal-abort' && signal?.aborted) {
    if (rethrow) rethrow();
    signal.throwIfAborted();
  }
  return (
    aborted ?? (signal?.aborted ? abortRunError(signal.reason) : undefined)
  );
}

function abortRunError<T, U>(reason: T, error?: U): SmartAgentError {
  if (reason instanceof SmartAgentError && reason.code === 'ABORTED')
    return withUsageAttribution(reason, errorUsage(error));
  const message =
    typeof reason === 'object' &&
    reason !== null &&
    'message' in reason &&
    typeof reason.message === 'string'
      ? reason.message
      : String(reason);
  return withUsageAttribution(new OrchestratorError(message, 'ABORTED'), {
    ...errorUsage(reason),
    ...errorUsage(error),
  });
}

/**
 * Race `promise` against the caller's abort signal. The `abort` listener is
 * removed from the signal once the race settles (resolve, reject or abort), so
 * a long-lived signal does not accumulate one listener per call.
 */
export function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  makeError: () => SmartAgentError,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(makeError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
}
