/**
 * Identity context for a session. `sessionId` is always present (server-issued
 * cookie, RFC 6265). `userId` is populated only by authorization-enabled builds;
 * the default server leaves it undefined. Extensible for future identity facets.
 */
export interface SessionIdentity {
  readonly sessionId: string;
  readonly userId?: string;
}
