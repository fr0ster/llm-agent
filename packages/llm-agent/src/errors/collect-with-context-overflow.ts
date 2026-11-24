import type { Result, SmartAgentError } from '../interfaces/types.js';
import { toAbortError } from './abort-run-error.js';
import { overflowError } from './terminal-run-error.js';

/** Settle on the first interruption, or preserve the batch's values or first ordinary rejection. */
export async function collectWithContextOverflow<T>(
  operations: readonly Promise<T>[],
  failureOf?: (value: T) => Error | undefined,
  options?: { rejectImmediately: boolean },
): Promise<Result<T[], SmartAgentError>> {
  return new Promise((resolve, reject) => {
    const reportInterruption = <E>(error: E) => {
      const failure = toAbortError(error) ?? overflowError(error);
      if (failure) resolve({ ok: false, error: failure });
    };
    const watched = operations.map((operation) =>
      operation.then(
        (value) => {
          reportInterruption(failureOf?.(value));
          return value;
        },
        (error) => {
          reportInterruption(error);
          throw error;
        },
      ),
    );
    void Promise.all(watched).then(
      (value) => resolve({ ok: true, value }),
      async (error) => {
        if (!options?.rejectImmediately) await Promise.allSettled(watched);
        reject(error);
      },
    );
  });
}

export function contextOverflowInSettled<T>(
  settled: readonly PromiseSettledResult<T>[],
  failureOf?: (value: T) => Error | undefined,
): SmartAgentError | undefined {
  for (const result of settled) {
    const overflow = overflowError(
      result.status === 'rejected' ? result.reason : failureOf?.(result.value),
    );
    if (overflow) return overflow;
  }
  return undefined;
}
