import {
  abortRunError,
  contextExceededError,
  embeddingContextExceededError,
  isAbortReason,
  SmartAgentError,
} from '@mcp-abap-adt/llm-agent';

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
