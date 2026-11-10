import type { CallOptions, RagMetadata } from '../interfaces/types.js';

/** The identity part of `CallOptions.ragFilter` every `IRag` store honours. */
export interface RagIdentityFilter {
  sessionId?: string;
  userId?: string;
  roleId?: string;
  owner?: { readonly scope: 'global' };
}

/**
 * The identity tags or explicit global owner predicate a query is scoped to.
 * Returns `undefined` for an unrestricted internal query. Only string values count, so an absent key and an
 * explicit `undefined` both mean "not filtered".
 */
export function ragIdentityFilter(
  options?: CallOptions,
): RagIdentityFilter | undefined {
  const f = options?.ragFilter;
  const sessionId = typeof f?.sessionId === 'string' ? f.sessionId : undefined;
  const userId = typeof f?.userId === 'string' ? f.userId : undefined;
  const roleId = typeof f?.roleId === 'string' ? f.roleId : undefined;
  const owner = f?.owner;
  if (
    sessionId === undefined &&
    userId === undefined &&
    roleId === undefined &&
    owner === undefined
  )
    return undefined;
  return {
    ...(roleId !== undefined ? { roleId } : {}),
    ...(owner !== undefined ? { owner } : {}),
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
  if (
    filter.owner?.scope === 'global' &&
    ['sessionId', 'userId', 'roleId'].some((key) => key in metadata)
  )
    return false;
  if (filter.roleId !== undefined && metadata.roleId !== filter.roleId)
    return false;
  if (filter.sessionId !== undefined && metadata.sessionId !== filter.sessionId)
    return false;
  if (filter.userId !== undefined && metadata.userId !== filter.userId)
    return false;
  return true;
}
