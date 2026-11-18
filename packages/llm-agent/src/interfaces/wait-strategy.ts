/**
 * How a controller `wait` step is actually served.
 *
 * The engine owns WHETHER to wait and FOR HOW LONG (planner duration, engine
 * clamps). This interface owns only the MECHANISM, so a consumer can replace a
 * blocking sleep with something their deployment prefers — suspending and
 * resuming the run instead of holding an HTTP connection for minutes, adding
 * jitter, or yielding to their own scheduler — without forking the controller.
 */
export interface IWaitStrategy {
  readonly name: string;
  /** Wait `ms`, resolving early with 'aborted' if `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'>;
}

/** Exponential delay, saturating only arithmetic overflow (not retry attempts). */
export function exponentialBackoffMs(baseMs: number, attempt: number): number {
  if (baseMs === 0) return 0;
  return Math.min(baseMs * 2 ** Math.max(0, attempt), Number.MAX_VALUE);
}

/** Plain timer. Honouring `signal` is part of the contract, not an extra. */
export class DefaultWaitStrategy implements IWaitStrategy {
  readonly name = 'default-wait';

  async wait(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'> {
    // Node treats larger timer delays as 1 ms. Split the wait without shortening it.
    const maxTimerDelayMs = 2 ** 31 - 1;
    for (let remaining = ms; remaining > 0; ) {
      if (signal?.aborted) return 'aborted';
      const interval = Math.min(remaining, maxTimerDelayMs);
      if ((await waitInterval(interval, signal)) === 'aborted')
        return 'aborted';
      remaining -= interval;
    }
    return signal?.aborted ? 'aborted' : 'elapsed';
  }
}

function waitInterval(
  ms: number,
  signal?: AbortSignal,
): Promise<'elapsed' | 'aborted'> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(handle);
      resolve('aborted');
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve('elapsed');
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
