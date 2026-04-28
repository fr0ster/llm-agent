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
export declare class CircuitBreaker {
  private _state;
  private failureCount;
  private openedAt;
  readonly failureThreshold: number;
  readonly recoveryWindowMs: number;
  private readonly onStateChange?;
  constructor(config?: CircuitBreakerConfig);
  get state(): CircuitState;
  /** Record a successful call — resets the breaker to closed. */
  recordSuccess(): void;
  /** Record a failed call — may trip the breaker open. */
  recordFailure(): void;
  /** Whether the circuit allows requests through. */
  get isCallPermitted(): boolean;
  private _transition;
}
//# sourceMappingURL=circuit-breaker.d.ts.map
