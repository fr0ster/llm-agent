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

/** Plain timer. Honouring `signal` is part of the contract, not an extra. */
export class DefaultWaitStrategy implements IWaitStrategy {
  readonly name = 'default-wait';

  wait(ms: number, signal?: AbortSignal): Promise<'elapsed' | 'aborted'> {
    if (signal?.aborted) return Promise.resolve('aborted');
    if (ms <= 0) return Promise.resolve('elapsed');
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
}
