/**
 * Generic Circuit Breaker — three-state pattern (closed → open → half-open).
 *
 * - **Closed**: requests pass through; failures are counted.
 * - **Open**: requests are rejected immediately; after `recoveryWindowMs` the
 *   breaker transitions to half-open.
 * - **Half-Open**: a single probe request is allowed. If it succeeds the
 *   breaker closes; if it fails it re-opens.
 */
export class CircuitBreaker {
  _state = 'closed';
  failureCount = 0;
  openedAt = 0;
  failureThreshold;
  recoveryWindowMs;
  onStateChange;
  constructor(config = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.recoveryWindowMs = config.recoveryWindowMs ?? 30_000;
    this.onStateChange = config.onStateChange;
  }
  get state() {
    if (
      this._state === 'open' &&
      Date.now() - this.openedAt >= this.recoveryWindowMs
    ) {
      this._transition('half-open');
    }
    return this._state;
  }
  /** Record a successful call — resets the breaker to closed. */
  recordSuccess() {
    if (this._state !== 'closed') {
      this._transition('closed');
    }
    this.failureCount = 0;
  }
  /** Record a failed call — may trip the breaker open. */
  recordFailure() {
    this.failureCount++;
    if (
      this._state === 'half-open' ||
      this.failureCount >= this.failureThreshold
    ) {
      this._transition('open');
      this.openedAt = Date.now();
    }
  }
  /** Whether the circuit allows requests through. */
  get isCallPermitted() {
    const s = this.state; // triggers half-open check
    return s === 'closed' || s === 'half-open';
  }
  _transition(to) {
    if (this._state === to) return;
    const from = this._state;
    this._state = to;
    if (to === 'closed') this.failureCount = 0;
    this.onStateChange?.(from, to);
  }
}
//# sourceMappingURL=circuit-breaker.js.map
