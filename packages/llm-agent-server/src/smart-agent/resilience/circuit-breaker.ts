/**
 * Generic Circuit Breaker — three-state pattern (closed → open → half-open).
 *
 * - **Closed**: requests pass through; failures are counted.
 * - **Open**: requests are rejected immediately; after `recoveryWindowMs` the
 *   breaker transitions to half-open.
 * - **Half-Open**: a single probe request is allowed. If it succeeds the
 *   breaker closes; if it fails it re-opens.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening. Default: 5 */
  failureThreshold?: number;
  /** Time (ms) to wait before probing again. Default: 30 000 */
  recoveryWindowMs?: number;
  /** Optional callback on state changes. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failureCount = 0;
  private openedAt = 0;

  readonly failureThreshold: number;
  readonly recoveryWindowMs: number;
  private readonly onStateChange?: (
    from: CircuitState,
    to: CircuitState,
  ) => void;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.recoveryWindowMs = config.recoveryWindowMs ?? 30_000;
    this.onStateChange = config.onStateChange;
  }

  get state(): CircuitState {
    if (
      this._state === 'open' &&
      Date.now() - this.openedAt >= this.recoveryWindowMs
    ) {
      this._transition('half-open');
    }
    return this._state;
  }

  /** Record a successful call — resets the breaker to closed. */
  recordSuccess(): void {
    if (this._state !== 'closed') {
      this._transition('closed');
    }
    this.failureCount = 0;
  }

  /** Record a failed call — may trip the breaker open. */
  recordFailure(): void {
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
  get isCallPermitted(): boolean {
    const s = this.state; // triggers half-open check
    return s === 'closed' || s === 'half-open';
  }

  private _transition(to: CircuitState): void {
    if (this._state === to) return;
    const from = this._state;
    this._state = to;
    if (to === 'closed') this.failureCount = 0;
    this.onStateChange?.(from, to);
  }
}
