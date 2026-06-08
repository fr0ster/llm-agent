import type { CallOptions, IRequestLogger } from '@mcp-abap-adt/llm-agent';

/**
 * Normalize per-request options at the top of a turn: write the (possibly
 * generated) `traceId` into `opts.trace` and attach the agent's per-request
 * logger.
 *
 * MUST be called AFTER any timeout-merge that rebuilds `opts` from the original
 * `options` — otherwise the merge would clobber the normalized trace. The
 * embedder-boundary wrapper and every downstream `logLlmCall` rely on
 * `opts.trace.traceId` + `opts.requestLogger` to attribute spend to this request.
 *
 * `requestLogger` is set to the agent's logger UNCONDITIONALLY (it overrides any
 * caller-supplied one): the embedder wrapper, the LLM logging, and the terminal
 * `getSummary` MUST all read the SAME logger, or embedding usage would land in a
 * different logger than the rest of the turn's usage.
 */
export function normalizeRequestOptions(
  opts: CallOptions | undefined,
  traceId: string,
  requestLogger: IRequestLogger,
): CallOptions {
  return {
    ...opts,
    trace: { ...opts?.trace, traceId },
    requestLogger,
  };
}
