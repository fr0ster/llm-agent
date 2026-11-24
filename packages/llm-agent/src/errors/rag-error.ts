import {
  EMBEDDING_CONTEXT_EXCEEDED,
  RagError,
  type SmartAgentError,
} from '../interfaces/types.js';
import { errorCauseChain, httpStatusOf } from '../llm/throttle.js';
import {
  abortRunError,
  isAbortReason,
  isTypedAbort,
} from './abort-run-error.js';
import { errorUsage } from './error-usage.js';
import {
  contextExceededError,
  embeddingContextExceededError,
  toRunError,
} from './terminal-run-error.js';

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
export function embeddingOverflowError<T>(error: T): RagError | undefined {
  const terminal = embeddingContextExceededError(error);
  if (terminal) return toRagError(terminal, 'EMBED_ERROR');
  const source =
    typeof error === 'object' && error !== null ? error : undefined;
  const status = httpStatusOf(source);
  for (const current of errorCauseChain(source)) {
    if (isTypedAbort(current)) return undefined;
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
      return new RagError(
        error instanceof Error
          ? error.message
          : 'Embedding input exceeds the context length',
        EMBEDDING_CONTEXT_EXCEEDED,
        { cause: error, status },
      );
    }
  }
  return undefined;
}

/** Convert an SDK or custom embedder failure to a typed embedding error. */
export function toEmbeddingError<T>(error: T, signal?: AbortSignal): RagError {
  if (isAbortReason(error, signal)) {
    const aborted = abortRunError(signal?.reason, error);
    return asRagError(aborted, error);
  }
  if (isTypedAbort(error)) return asRagError(error, error);
  const modelOverflow = contextExceededError(error);
  if (modelOverflow) return toRagError(modelOverflow, 'EMBED_ERROR');
  return embeddingOverflowError(error) ?? toRagError(error, 'EMBED_ERROR');
}

/** Keep provider codes and metadata across RAG Result boundaries. */
export function toRagError<T>(error: T, fallbackCode: string): RagError {
  return asRagError(toRunError(error, fallbackCode), error);
}

function asRagError<T>(failure: SmartAgentError, error: T): RagError {
  if (failure instanceof RagError) return failure;
  return Object.assign(
    new RagError(failure.message, failure.code, {
      cause: error,
      status: httpStatusOf(failure),
    }),
    errorUsage(failure),
  );
}
