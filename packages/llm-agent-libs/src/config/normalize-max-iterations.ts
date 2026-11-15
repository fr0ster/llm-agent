/** Normalize either loop limit at every configuration boundary. */
export function normalizeLoopLimit<T>(
  value: T,
  field: 'maxIterations' | 'maxToolCalls',
): number | undefined {
  if (value == null || value === Infinity) return undefined;
  const limit =
    typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)
      ? Number(value)
      : value;
  const minimum = field === 'maxToolCalls' ? 0 : 1;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < minimum
  ) {
    throw new TypeError(
      `agent.${field}: must be a ${minimum === 0 ? 'non-negative' : 'positive'} integer, Infinity or null (unlimited)`,
    );
  }
  return limit;
}

/** Compatibility alias for the positive iteration limit. */
export function normalizeMaxIterations<T>(value: T): number | undefined {
  return normalizeLoopLimit(value, 'maxIterations');
}
