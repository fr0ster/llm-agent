import { OrchestratorError } from '../interfaces/agent-contracts.js';
import { SmartAgentError } from '../interfaces/types.js';
import {
  errorUsage,
  originalUsageError,
  withUsageAttribution,
} from './error-usage.js';

/** Recognize a signal's reason through usage copies and cause wrappers. */
export function isAbortReason<T>(error: T, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const suppliedReason = signal.reason;
  const reason =
    typeof suppliedReason === 'object' && suppliedReason !== null
      ? originalUsageError(suppliedReason)
      : suppliedReason;
  if (Object.is(error, reason)) return true;
  if (typeof error !== 'object' || error === null) return false;

  const seen = new Set<object>();
  let current: object = error;
  while (!seen.has(current)) {
    if (originalUsageError(current) === reason) return true;
    seen.add(current);
    const cause = 'cause' in current ? current.cause : undefined;
    if (Object.is(cause, reason)) return true;
    if (typeof cause !== 'object' || cause === null) break;
    current = cause;
  }
  return false;
}

export function isTypedAbort<T>(
  error: T,
): error is T & SmartAgentError & { readonly code: 'ABORTED' } {
  return error instanceof SmartAgentError && error.code === 'ABORTED';
}

export function abortRunError<T, U>(reason: T, error?: U): SmartAgentError {
  if (isTypedAbort(reason))
    return withUsageAttribution(reason, errorUsage(error));
  const message =
    typeof reason === 'object' &&
    reason !== null &&
    'message' in reason &&
    typeof reason.message === 'string'
      ? reason.message
      : String(reason);
  return Object.assign(new OrchestratorError(message, 'ABORTED'), {
    ...errorUsage(reason),
    ...errorUsage(error),
  });
}
