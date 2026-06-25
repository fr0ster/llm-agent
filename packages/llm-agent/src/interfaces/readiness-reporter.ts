/**
 * A component that can report its own aggregate readiness — `true` iff every
 * resource it manages is currently healthy/usable.
 *
 * Deliberately TINY and SEPARATE from any lifecycle interface (e.g.
 * `IMcpConnectionStrategy`): a strategy that tracks health implements BOTH; one
 * that does not stays a plain strategy. Consumers depend on this small interface
 * (Interface Segregation) and detect it via {@link isReadinessReporter}.
 *
 * Readiness POLICY (what counts as ready, probe cadence) lives in the implementor,
 * so a consumer can leave the decision to a swapped-in strategy.
 */
export interface IReadinessReporter {
  /** `true` iff every managed resource is currently healthy. */
  isReady(): boolean;
}

/** Type guard: does `x` report readiness? */
export function isReadinessReporter(x: unknown): x is IReadinessReporter {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as IReadinessReporter).isReady === 'function'
  );
}
