import {
  copyErrorUsage,
  httpStatusOf,
  isAuthenticationFailure,
  LlmError,
  overflowError,
  retryAfterSecondsOf,
  toAbortError,
} from '@mcp-abap-adt/llm-agent';

export const aborted = () => new LlmError('Aborted', 'ABORTED');

export const credentialsRejected = () =>
  new LlmError(
    'Copilot token rejected — log in again and send a fresh token',
    'CREDENTIALS_REJECTED',
  );

export class CopilotThrottleError extends LlmError {
  readonly status = 429;

  constructor(public readonly retryAfterSeconds?: number) {
    super('Copilot quota or rate limit reached', 'RATE_LIMITED');
  }
}

const sdkCodes = new Set([
  'ENOENT',
  'EACCES',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_MODULE_NOT_FOUND',
  'ERR_CONNECTION_CLOSED',
  'ERR_STREAM_DESTROYED',
  'context_limit',
  'query',
  'policy',
  'internal_error',
  'invalid_request',
]);
const sdkClasses = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ResponseError',
  'CancellationError',
  'AbortError',
  'AuthenticationError',
  'TimeoutError',
]);

/** Retain structured transport facts and withhold SDK messages and causes. */
export function sdkError<T>(error: T, signal?: AbortSignal): LlmError {
  const interruption = toAbortError(error, signal) ?? overflowError(error);
  if (interruption) {
    if (error instanceof LlmError && interruption.code === error.code)
      return copyErrorUsage(error, interruption);
    return copyErrorUsage(
      new LlmError(
        interruption.code === 'ABORTED'
          ? 'Aborted'
          : 'Copilot SDK context exceeded',
        interruption.code,
      ),
      interruption,
    );
  }
  if (signal?.aborted) return copyErrorUsage(aborted(), error, signal.reason);
  if (error instanceof LlmError) return copyErrorUsage(error, error);
  const details = typeof error === 'object' && error !== null ? error : {};
  const data =
    'data' in details &&
    typeof details.data === 'object' &&
    details.data !== null
      ? details.data
      : details;
  const status = httpStatusOf(details) ?? httpStatusOf(data);
  const type = 'errorType' in data ? data.errorType : undefined;
  const code =
    'code' in details
      ? details.code
      : 'errorCode' in data
        ? data.errorCode
        : type;
  const className = error instanceof Error ? error.constructor.name : 'Error';
  const message =
    'message' in details && typeof details.message === 'string'
      ? details.message
      : '';
  if (
    status === 401 ||
    status === 403 ||
    isAuthenticationFailure(details) ||
    isAuthenticationFailure({ code }) ||
    isAuthenticationFailure({ code: type }) ||
    (status === undefined &&
      /authenticat|unauthori[sz]ed|bad credentials|invalid credentials|(?:invalid|expired|failed to get).*token|token.*(?:invalid|expired)/i.test(
        message,
      ))
  ) {
    return Object.assign(credentialsRejected(), { status });
  }
  if (
    status === 429 ||
    (status === undefined && (type === 'quota' || type === 'rate_limit'))
  ) {
    return new CopilotThrottleError(
      retryAfterSecondsOf(details) ?? retryAfterSecondsOf(data),
    );
  }
  const safeClass = sdkClasses.has(className) ? className : 'Error';
  const safeCode =
    typeof code === 'number' || (typeof code === 'string' && sdkCodes.has(code))
      ? ` (${code})`
      : '';
  return copyErrorUsage(
    Object.assign(
      new LlmError(`Copilot SDK ${safeClass}${safeCode}`, 'COPILOT_ERROR'),
      { status },
    ),
    error,
  );
}
