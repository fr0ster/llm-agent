/**
 * A `setTimeout`-based delay that REJECTS on `signal` abort (before or during),
 * clearing its timer on settle/abort. It does NOT swallow abort — the rejection
 * must propagate so the controller's per-step abort discriminator handles it.
 */
export function cancelableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abortError = (): Error =>
      (signal?.reason as Error | undefined) ??
      new DOMException('Aborted', 'AbortError');

    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
