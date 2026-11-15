/** Normalize a config boundary value before storing or comparing a loop limit. */
export function normalizeMaxIterations<T>(value: T): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError('maxIterations must be a positive integer or null');
  }
  return value;
}
