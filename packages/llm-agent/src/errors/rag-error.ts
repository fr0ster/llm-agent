import {
  EMBEDDING_CONTEXT_EXCEEDED,
  RagError,
  type SmartAgentError,
} from '../interfaces/types.js';
import { findAbort, toAbortError } from './abort-run-error.js';
import { errorCauseChain, httpStatusOf } from './error-details.js';
import { copyErrorUsage } from './error-usage.js';
import { componentRunError, overflowError } from './terminal-run-error.js';

const inputSizeRejections = [
  /\bcontext_length_exceeded\b/i,
  /\binput(?: text)? (?:is )?too (?:long|large)\b|\btoo many tokens\b/i,
  /\bexceed(?:s|ed|ing)?\b[^.\n]*\b(?:context (?:length|window)|(?:maximum|allowed) (?:input )?(?:number of )?tokens|token limit)\b/i,
  /\b(?:context (?:length|window)|total (?:number of )?tokens|token (?:count|limit))\b[^.\n]*\bexceed(?:s|ed|ing)?\b/i,
];

const requestedContextLength =
  /\bmaximum context length is (\d+) tokens?\b[\s\S]*?\brequested (\d+) tokens?\b/i;

/** Classify provider rejections at the embedding boundary. */
export function embeddingErrorCode(
  status: number | undefined,
  detail: string,
  fallbackCode = 'EMBED_ERROR',
): string {
  if (status === 413) return EMBEDDING_CONTEXT_EXCEEDED;
  if (status !== undefined && status !== 400 && status !== 422)
    return fallbackCode;

  const counts = requestedContextLength.exec(detail);
  return inputSizeRejections.some((pattern) => pattern.test(detail)) ||
    (counts && Number(counts[2]) > Number(counts[1]))
    ? EMBEDDING_CONTEXT_EXCEEDED
    : fallbackCode;
}

/** Classify an input-size rejection without changing other provider errors. */
export function embeddingOverflowError<T>(
  error: T,
  signal?: AbortSignal,
): RagError | undefined {
  if (findAbort(error, signal)) return undefined;
  const terminal = overflowError(error);
  if (terminal) return asRagError(terminal, error);
  const source =
    typeof error === 'object' && error !== null ? error : undefined;
  const status = httpStatusOf(source);
  for (const current of errorCauseChain(source)) {
    const response = 'response' in current ? current.response : undefined;
    const data =
      response && typeof response === 'object' && 'data' in response
        ? response.data
        : undefined;
    const detail =
      data && typeof data === 'object' && 'error' in data ? data.error : data;
    const fields = [
      typeof detail === 'string' ? detail : undefined,
      'message' in current ? current.message : undefined,
      'code' in current ? current.code : undefined,
      detail && typeof detail === 'object' && 'message' in detail
        ? detail.message
        : undefined,
      detail && typeof detail === 'object' && 'code' in detail
        ? detail.code
        : undefined,
    ];
    if (
      status === 413 ||
      fields.some(
        (field) =>
          typeof field === 'string' &&
          embeddingErrorCode(status, field) === EMBEDDING_CONTEXT_EXCEEDED,
      )
    ) {
      return copyErrorUsage(
        new RagError(
          error instanceof Error
            ? error.message
            : 'Embedding input exceeds the context length',
          EMBEDDING_CONTEXT_EXCEEDED,
          { cause: error, status },
        ),
        error,
      );
    }
  }
  return undefined;
}

/** Recognize SDK or custom embedder interruptions. */
export function toEmbeddingError<T>(
  error: T,
  signal?: AbortSignal,
): RagError | undefined {
  const abort = toAbortError(error, signal);
  return abort ? asRagError(abort, error) : embeddingOverflowError(error);
}

/** Normalize embedding interruptions while preserving ordinary rejections. */
export async function withEmbeddingError<T>(
  embed: () => Promise<T>,
  signal?: AbortSignal,
  mode?: 'preserve-rejection',
): Promise<T> {
  try {
    return await embed();
  } catch (error) {
    // Delegating decorators preserve the original rejection for their callers.
    if (
      mode === 'preserve-rejection' &&
      (findAbort(error, signal) || overflowError(error))
    )
      throw error;
    throw toEmbeddingError(error, signal) ?? error;
  }
}

/** Keep interruptions and RAG errors across boundaries with a released fallback code. */
export function toRagError<T>(
  error: T,
  fallbackCode: string,
  signal?: AbortSignal,
): RagError {
  const interruption = componentRunError(error, signal);
  if (interruption) return asRagError(interruption, error);
  return error instanceof RagError
    ? copyErrorUsage(error, error)
    : copyErrorUsage(
        new RagError(String(error), fallbackCode, { cause: error }),
        error,
      );
}

function asRagError<T>(failure: SmartAgentError, error: T): RagError {
  if (error instanceof RagError && error.code === failure.code)
    return copyErrorUsage(error, failure);
  if (failure instanceof RagError) return copyErrorUsage(failure, error);
  return copyErrorUsage(
    new RagError(failure.message, failure.code, {
      cause: error,
      status: httpStatusOf(failure),
    }),
    failure,
    error,
  );
}
