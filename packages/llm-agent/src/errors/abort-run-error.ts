import { OrchestratorError } from '../interfaces/agent-contracts.js';
import { SmartAgentError } from '../interfaces/types.js';
import { errorCauseChain } from './error-details.js';
import { copyErrorUsage, originalUsageError } from './error-usage.js';

const abortCodes = new Set<string>(['ABORTED', 'ABORT_ERR', 'ERR_CANCELED']);
const abortNames = new Set<string>(['AbortError', 'CanceledError']);

/** Find cancellation through cause wrappers and copies carrying telemetry. */
export function findAbort<T>(
  error: T,
  signal?: AbortSignal,
): { fromSignal: true } | { fromSignal: false; reason: object } | undefined {
  const signalReason = signal?.aborted ? signal.reason : undefined;
  const originalReason =
    typeof signalReason === 'object' && signalReason !== null
      ? originalUsageError(signalReason)
      : signalReason;
  if (signal?.aborted && Object.is(error, originalReason))
    return { fromSignal: true };
  let reason: object | undefined;
  for (const current of errorCauseChain(error)) {
    if (
      signal?.aborted &&
      (originalUsageError(current) === originalReason ||
        ('cause' in current && Object.is(current.cause, originalReason)))
    )
      return { fromSignal: true };
    if (
      !reason &&
      (('code' in current &&
        typeof current.code === 'string' &&
        abortCodes.has(current.code)) ||
        ('name' in current &&
          typeof current.name === 'string' &&
          abortNames.has(current.name)))
    )
      reason = current;
  }
  return reason && { reason, fromSignal: false };
}

/** Normalize a recognized abort, keeping the reason and error telemetry. */
export function toAbortError<T>(
  error: T,
  signal?: AbortSignal,
): SmartAgentError | undefined {
  const abort = findAbort(error, signal);
  return (
    abort &&
    abortRunError(abort.fromSignal ? signal?.reason : abort.reason, error)
  );
}

export function abortRunError<T, U>(reason: T, error?: U): SmartAgentError {
  if (reason instanceof SmartAgentError && reason.code === 'ABORTED')
    return copyErrorUsage(reason, error);
  const message =
    typeof reason === 'object' &&
    reason !== null &&
    'message' in reason &&
    typeof reason.message === 'string'
      ? reason.message
      : String(reason);
  return copyErrorUsage(
    new OrchestratorError(message, 'ABORTED', { cause: error ?? reason }),
    error,
    reason,
  );
}
