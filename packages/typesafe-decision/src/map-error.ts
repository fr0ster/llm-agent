import { DecisionError, type DecisionErrorCode } from '@mcp-abap-adt/llm-agent';
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeError,
  UnprocessableEntityError,
} from '@typesafe-ai/sdk';

function codeOf(err: unknown): DecisionErrorCode {
  // Order matters: every SDK error extends TypeSafeError, and APITimeoutError
  // extends APIConnectionError.
  if (err instanceof APIUserAbortError) return 'DECISION_ABORTED';
  if (
    err instanceof BadRequestError ||
    err instanceof UnprocessableEntityError ||
    err instanceof NotFoundError
  ) {
    return 'DECISION_INVALID_REQUEST';
  }
  if (
    err instanceof AuthenticationError ||
    err instanceof PermissionDeniedError
  ) {
    return 'DECISION_AUTH';
  }
  if (err instanceof RateLimitError) return 'DECISION_RATE_LIMITED';
  if (err instanceof InternalServerError || err instanceof APIConnectionError) {
    return 'DECISION_UNAVAILABLE';
  }
  if (err instanceof APIError) return 'DECISION_ERROR';
  // A TypeSafeError that is not an API/connection/abort error is thrown before
  // any request (empty questions, score rubric shorter than two).
  if (err instanceof TypeSafeError) return 'DECISION_INVALID_REQUEST';
  return 'DECISION_ERROR';
}

/** Map anything the SDK throws to a DecisionError. Never echoes key or body. */
export function mapError(err: unknown): DecisionError {
  const code = codeOf(err);
  const status = err instanceof APIError ? ` (HTTP ${err.status})` : '';
  const requestId =
    err instanceof APIError && err.requestId
      ? ` [request ${err.requestId}]`
      : '';
  const name = err instanceof Error ? err.name : 'Error';
  return new DecisionError(`TypeSafe ${name}${status}${requestId}`, code);
}
