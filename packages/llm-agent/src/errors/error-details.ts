/** Status of an axios-shaped error, or undefined when it is shaped otherwise. */
export function httpStatusOf(error: object | undefined): number | undefined {
  return httpStatusIn(errorCauseChain(error));
}

export function httpStatusIn(causes: Iterable<object>): number | undefined {
  for (const current of causes) {
    const status = ownHttpStatus(current);
    if (status !== undefined) return status;
  }
  return undefined;
}

function ownHttpStatus(error: object): number | undefined {
  const response = 'response' in error ? error.response : undefined;
  // Axios keeps it under response; several SDKs hoist it onto the error itself.
  return [
    response && typeof response === 'object' && 'status' in response
      ? response.status
      : undefined,
    'status' in error ? error.status : undefined,
    'statusCode' in error ? error.statusCode : undefined,
  ].find((value) => typeof value === 'number');
}

const authenticationCodes = new Set([
  'authentication',
  'authentication_error',
  'authentication_failed',
  'authorization',
  'bad_credentials',
  'credentials_rejected',
  'decision_auth',
  'forbidden',
  'invalid_api_key',
  'invalid_token',
  'permission_error',
  'token_expired',
  'unauthorized',
]);

/** Identify authentication failures from structured statuses, codes, and error names. */
export function isAuthenticationFailure(error: object | undefined): boolean {
  return authenticationFailureIn(errorCauseChain(error));
}

export function authenticationFailureIn(causes: Iterable<object>): boolean {
  for (const current of causes) {
    const code = 'code' in current ? current.code : undefined;
    const status = ownHttpStatus(current);
    if (
      status === 401 ||
      status === 403 ||
      (typeof code === 'string' &&
        authenticationCodes.has(code.toLowerCase())) ||
      (current instanceof Error &&
        (current.name === 'AuthenticationError' ||
          current.constructor.name === 'AuthenticationError'))
    ) {
      return true;
    }
  }
  return false;
}

/** Walk the cause chain from the outermost error, including cyclic chains. */
export function* errorCauseChain<T>(error: T): Generator<object> {
  const seen = new Set<object>();
  let current: object | undefined =
    typeof error === 'object' && error !== null ? error : undefined;
  while (current && !seen.has(current)) {
    seen.add(current);
    yield current;
    const cause = 'cause' in current ? current.cause : undefined;
    current = typeof cause === 'object' && cause !== null ? cause : undefined;
  }
}
