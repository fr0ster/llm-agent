import {
  EMBEDDING_CONTEXT_EXCEEDED,
  MODEL_CONTEXT_EXCEEDED,
  SmartAgentError,
} from '../interfaces/types.js';
import {
  errorCauseChain,
  httpStatusOf,
  isAuthenticationFailure,
} from '../llm/throttle.js';

const terminalCodes = new Set([
  'ABORTED',
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
export function terminalRunError<T>(error: T): SmartAgentError | undefined {
  const overflow =
    contextExceededError(error) ?? embeddingContextExceededError(error);
  if (overflow) return overflow;
  const details =
    typeof error === 'object' && error !== null ? error : undefined;
  for (const current of errorCauseChain(details)) {
    const code = 'code' in current ? current.code : undefined;
    if (typeof code === 'string' && terminalCodes.has(code))
      return typedFailure(current, code, details);
    if ('name' in current && current.name === 'AbortError')
      return typedFailure(current, 'ABORTED');
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
    if (details instanceof SmartAgentError) return details;
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
export function toRunError<T>(error: T, fallbackCode: string): SmartAgentError {
  const terminal = terminalRunError(error);
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
  if (error instanceof SmartAgentError) return error;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : code;
  return new SmartAgentError(message, code, {
    cause: source,
    status: httpStatusOf(source),
  });
}

/** The terminal error only when it is a model context overflow. */
export function contextExceededError<T>(error: T): SmartAgentError | undefined {
  return findRunError(error, MODEL_CONTEXT_EXCEEDED);
}

/** The terminal error only when an embedder rejected oversized input. */
export function embeddingContextExceededError<T>(
  error: T,
): SmartAgentError | undefined {
  return findRunError(error, EMBEDDING_CONTEXT_EXCEEDED);
}

function findRunError<T>(error: T, code: string): SmartAgentError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const seen = new Set<object>();
  let current: object = error;
  while (!seen.has(current)) {
    if (errorCode(current) === code) return typedFailure(current, code, error);
    seen.add(current);
    const cause = 'cause' in current ? current.cause : undefined;
    if (typeof cause !== 'object' || cause === null) break;
    current = cause;
  }
  return undefined;
}
