import type { ServerResponse } from 'node:http';

/**
 * One AbortController per HTTP request. It aborts (default `AbortError`
 * reason — never a `TimeoutError`, so breakers ignore it) when the client
 * connection closes before the response finished. A connection that closes
 * after the response completed (keep-alive, normal end) does not abort.
 */
export function createRequestAbort(res: ServerResponse): AbortController {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  return abort;
}

/** True while it is still safe to write to `res` for this request. */
export function canWrite(res: ServerResponse, signal: AbortSignal): boolean {
  return !signal.aborted && !res.destroyed && !res.writableEnded;
}
