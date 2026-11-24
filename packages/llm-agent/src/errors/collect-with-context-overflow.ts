import type { Result, SmartAgentError } from '../interfaces/types.js';
import { contextExceededError } from './terminal-run-error.js';

/** Settle on the first overflow, or preserve the batch's values or first ordinary rejection. */
export async function collectWithContextOverflow<T>(
  operations: readonly Promise<T>[],
  failureOf?: (value: T) => Error | undefined,
  options?: { rejectImmediately: boolean },
): Promise<Result<T[], SmartAgentError>> {
  return new Promise((resolve, reject) => {
    const reportOverflow = <E>(error: E) => {
      const failure = contextExceededError(error);
      if (failure) resolve({ ok: false, error: failure });
    };
    const watched = operations.map((operation) =>
      operation.then(
        (value) => {
          reportOverflow(failureOf?.(value));
          return value;
        },
        (error) => {
          reportOverflow(error);
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
    const overflow = contextExceededError(
      result.status === 'rejected' ? result.reason : failureOf?.(result.value),
    );
    if (overflow) return overflow;
  }
  return undefined;
}
