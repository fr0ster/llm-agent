import { isToolContextUnavailableError } from './tool-availability-registry.js';

/**
 * Decides whether a failed internal tool call hides that tool from the session
 * (spec §10.5.12 U8). None injected → nothing is blocked.
 */
export interface IToolAvailabilityPolicy {
  /** The block for `toolName` after its call failed with `errorText`, or `undefined` to block nothing. */
  onToolError(
    toolName: string,
    errorText: string,
  ): { readonly ttlMs: number } | undefined;
}

/**
 * 30.1.0's heuristic (`isToolContextUnavailableError`: "not found",
 * "permission", …), opt-in: a matching error blocks the tool for `ttlMs`.
 */
export class HeuristicToolAvailabilityPolicy
  implements IToolAvailabilityPolicy
{
  private readonly ttlMs: number;

  constructor(options: { readonly ttlMs: number }) {
    // A NaN / Infinity TTL would block a tool for the whole session, silently.
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
      throw new RangeError(
        `HeuristicToolAvailabilityPolicy: ttlMs must be a finite number >= 0, got ${options.ttlMs}`,
      );
    }
    this.ttlMs = options.ttlMs;
  }

  onToolError(
    _toolName: string,
    errorText: string,
  ): { readonly ttlMs: number } | undefined {
    return isToolContextUnavailableError(errorText)
      ? { ttlMs: this.ttlMs }
      : undefined;
  }
}
