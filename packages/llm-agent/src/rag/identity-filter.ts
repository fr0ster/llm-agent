import type { CallOptions, RagMetadata } from '../interfaces/types.js';

/** The identity part of `CallOptions.ragFilter` every `IRag` store honours. */
export interface RagIdentityFilter {
  sessionId?: string;
  userId?: string;
}

/**
 * The `sessionId` / `userId` a query is scoped to, or `undefined` when it is
 * scoped to neither. Only string values count, so an absent key and an
 * explicit `undefined` both mean "not filtered".
 */
export function ragIdentityFilter(
  options?: CallOptions,
): RagIdentityFilter | undefined {
  const f = options?.ragFilter;
  const sessionId = typeof f?.sessionId === 'string' ? f.sessionId : undefined;
  const userId = typeof f?.userId === 'string' ? f.userId : undefined;
  if (sessionId === undefined && userId === undefined) return undefined;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(userId !== undefined ? { userId } : {}),
  };
}

/**
 * Whether a record belongs to the scope of `filter`. A record without the
 * filtered key does not match — an unowned record is never shown to a scoped
 * query. Stores apply this BEFORE top-k.
 */
export function matchesRagIdentity(
  metadata: RagMetadata,
  filter: RagIdentityFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && metadata.sessionId !== filter.sessionId)
    return false;
  if (filter.userId !== undefined && metadata.userId !== filter.userId)
    return false;
  return true;
}
