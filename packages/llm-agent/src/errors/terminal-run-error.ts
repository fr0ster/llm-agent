import {
  EMBEDDING_CONTEXT_EXCEEDED,
  MODEL_CONTEXT_EXCEEDED,
  SmartAgentError,
} from '../interfaces/types.js';
import { findAbort, toAbortError } from './abort-run-error.js';
import {
  errorCauseChain,
  httpStatusOf,
  isAuthenticationFailure,
} from './error-details.js';
import { copyErrorUsage } from './error-usage.js';

const terminalCodes = new Set([
  'DECISION_ABORTED',
  'LLM_OUTPUT_TRUNCATED',
  'LLM_HTTP_ERROR',
  // The worker and check protocols require an answer or a verdict.
  'EMPTY_WORKER_OUTPUT',
  'VERDICT_RETRIEVAL_FAILED',
  // These require a change to the deployment or its configuration.
  'CONFIG_ERROR',
  'INVALID_CONFIG',
  'MISSING_PROVIDER',
  'MODEL_NOT_ALLOWED',
  'SUBAGENT_CONFIG_ERROR',
]);

/** Return the typed failure that must bypass retries, recovery, and fallback. */
export function terminalRunError<T>(
  error: T,
  signal?: AbortSignal,
): SmartAgentError | undefined {
  const abort = toAbortError(error, signal);
  if (abort) return abort;
  const overflow = findOverflow(error);
  if (overflow) return overflow;
  const details =
    typeof error === 'object' && error !== null ? error : undefined;
  for (const current of errorCauseChain(details)) {
    const code = 'code' in current ? current.code : undefined;
    if (typeof code === 'string' && terminalCodes.has(code))
      return typedFailure(current, code, details);
  }
  if (details && isAuthenticationFailure(details))
    return typedFailure(details, 'CREDENTIALS_REJECTED');
  const status = httpStatusOf(details);
  if (
    details &&
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  ) {
    return typedFailure(details, errorCode(details) ?? 'LLM_HTTP_ERROR');
  }
  return undefined;
}

function errorCode(error: object | undefined): string | undefined {
  return error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Preserve component metadata while giving untyped failures a stable code. */
export function toRunError<T>(
  error: T,
  fallbackCode: string,
  signal?: AbortSignal,
): SmartAgentError {
  const terminal = terminalRunError(error, signal);
  if (terminal) return terminal;
  if (typeof error === 'object' && error !== null) {
    for (const current of errorCauseChain(error)) {
      const code = errorCode(current);
      if (code) return typedFailure(error, code);
    }
    return typedFailure(error, fallbackCode);
  }
  return new SmartAgentError(String(error), fallbackCode, { cause: error });
}

function typedFailure(
  error: object,
  code: string,
  source = error,
): SmartAgentError {
  if (error instanceof SmartAgentError)
    return copyErrorUsage(error, source, error);
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : code;
  return copyErrorUsage(
    new SmartAgentError(message, code, {
      cause: source,
      status: httpStatusOf(source),
    }),
    source,
    error,
  );
}

/** The terminal error only when it is a model context overflow. */
export function contextExceededError<T>(error: T): SmartAgentError | undefined {
  return findAbort(error) ? undefined : findOverflow(error, true);
}

/** Find either terminal overflow, preserving the failure and its telemetry. */
export function overflowError<T>(
  error: T,
  signal?: AbortSignal,
): SmartAgentError | undefined {
  return findAbort(error, signal) ? undefined : findOverflow(error);
}

function findOverflow<T>(
  error: T,
  modelOnly = false,
): SmartAgentError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  let embedding: object | undefined;
  for (const current of errorCauseChain(error)) {
    const code = errorCode(current);
    if (code === MODEL_CONTEXT_EXCEEDED)
      return typedFailure(current, code, error);
    if (code === EMBEDDING_CONTEXT_EXCEEDED && !modelOnly)
      embedding ??= current;
  }
  return (
    embedding && typedFailure(embedding, EMBEDDING_CONTEXT_EXCEEDED, error)
  );
}
