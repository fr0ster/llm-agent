import type { CallOptions, IRequestLogger } from '@mcp-abap-adt/llm-agent';

/**
 * Normalize per-request options at the top of a turn: write the (possibly
 * generated) `traceId` into `opts.trace` and attach the per-request logger.
 *
 * MUST be called AFTER any timeout-merge that rebuilds `opts` from the original
 * `options` — otherwise the merge would clobber the normalized trace. The
 * embedder-boundary wrapper and every downstream `logLlmCall` rely on
 * `opts.trace.traceId` + `opts.requestLogger` to attribute spend to this request.
 */
export function normalizeRequestOptions(
  opts: CallOptions | undefined,
  traceId: string,
  requestLogger: IRequestLogger,
): CallOptions {
  return {
    ...opts,
    trace: { ...opts?.trace, traceId },
    requestLogger: opts?.requestLogger ?? requestLogger,
  };
}
