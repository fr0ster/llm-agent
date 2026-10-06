/**
 * Throw unless `v` is a finite positive integer (NaN, Infinity, 0, negatives
 * and fractions are refused). Used by constructors whose numeric options size
 * loops: `Math.max(1, NaN)` is NaN, and a NaN loop bound runs nothing.
 */
export function assertPositiveInteger(
  cls: string,
  field: string,
  v: number,
): void {
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`${cls}: ${field} must be a positive integer (got ${v})`);
  }
}
