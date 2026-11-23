import type { Result, SmartAgentError } from '../interfaces/types.js';
import { contextExceededError } from './terminal-run-error.js';

/** Scan the entire batch for overflow, preserving the first rejection in settlement order otherwise. */
export async function collectWithContextOverflow<T>(
  operations: readonly Promise<T>[],
  failureOf?: (value: T) => Error | undefined,
): Promise<Result<T[], SmartAgentError>> {
  const [settled, [combined]] = await Promise.all([
    Promise.allSettled(operations),
    Promise.allSettled([Promise.all(operations)]),
  ]);
  const overflow = contextOverflowInSettled(settled, failureOf);
  if (overflow) return { ok: false, error: overflow };
  if (combined.status === 'rejected') throw combined.reason;
  return { ok: true, value: combined.value };
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
