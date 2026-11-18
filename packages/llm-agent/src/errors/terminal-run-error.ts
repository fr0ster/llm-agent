import { SmartAgentError } from '../interfaces/types.js';
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
  const details =
    typeof error === 'object' && error !== null ? error : undefined;
  for (const current of errorCauseChain(details)) {
    const code = 'code' in current ? current.code : undefined;
    if (typeof code === 'string' && terminalCodes.has(code))
      return typedFailure(current, code);
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
    return Object.assign(typedFailure(details, 'LLM_HTTP_ERROR'), { status });
  }
  return undefined;
}

function typedFailure(error: object, code: string): SmartAgentError {
  if (error instanceof SmartAgentError) return error;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : code;
  return new SmartAgentError(message, code);
}
