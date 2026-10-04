import type { SmartAgentError } from '@mcp-abap-adt/llm-agent';

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
