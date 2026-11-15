/** Normalize either loop limit; YAML boundaries also accept integer strings. */
export function normalizeLoopLimit<T>(
  value: T,
  field: 'maxIterations' | 'maxToolCalls',
  options?: { allowNumericStrings?: boolean },
): number | undefined {
  if (value == null) return undefined;
  const limit =
    options?.allowNumericStrings &&
    typeof value === 'string' &&
    /^\s*-?\d+\s*$/.test(value)
      ? Number(value)
      : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new TypeError(
      `agent.${field}: must be a positive integer or null (unlimited)`,
    );
  }
  return limit;
}

/** Preserve the numeric-only contract of runtime iteration limit updates. */
export function normalizeMaxIterations<T>(value: T): number | undefined {
  return normalizeLoopLimit(value, 'maxIterations');
}
