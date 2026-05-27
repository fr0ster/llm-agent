/**
 * Thrown by a worker when its node cannot be done as-is and needs to be broken
 * into a finer sub-graph. An abnormal/exceptional outcome (the node produced no
 * usable output) — handled by the interpreter's IErrorStrategy.
 */
export class NeedsDecompositionError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`needs decomposition: ${reason}`);
    this.name = 'NeedsDecompositionError';
    this.reason = reason;
  }
}
