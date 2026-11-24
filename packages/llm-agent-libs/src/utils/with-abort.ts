import type { SmartAgentError } from '@mcp-abap-adt/llm-agent';
import { originalUsageError } from '../logger/llm-call-usage.js';

/** Recognize a signal's reason through usage copies and cause wrappers. */
export function isAbortReason<T>(error: T, signal?: AbortSignal): boolean {
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
