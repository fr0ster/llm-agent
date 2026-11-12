import type { RagCollectionOwner } from '../interfaces/rag.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
} from '../interfaces/types.js';
import { stampRagOwner } from './registry/owner-bound-editor.js';

/** The identity part of `CallOptions.ragFilter` every `IRag` store honours. */
export type RagIdentityFilter = {
  owner?: RagCollectionOwner;
  sessionId?: string;
  userId?: string;
} & (
  | { ownerScope: 'session'; sessionId: string }
  | { ownerScope: 'user'; userId: string }
  | { ownerScope: 'global' }
);

/**
 * The positive owner scope and identity a query is scoped to.
 * Returns `undefined` for an unrestricted internal query. Only string values count, so an absent key and an
 * explicit `undefined` both mean "not filtered".
 */
export function ragIdentityFilter(
  options?: CallOptions,
): RagIdentityFilter | undefined {
  const f = options?.ragFilter;
  if (f && 'roleId' in f)
    throw new RagError(
      'roleId is no longer a record identity filter',
      'INVALID_ARGUMENT',
    );
  const sessionId =
    f?.owner?.scope === 'session'
      ? f.owner.sessionId
      : typeof f?.sessionId === 'string'
        ? f.sessionId
        : undefined;
  const userId =
    f?.owner?.scope === 'user'
      ? f.owner.userId
      : typeof f?.userId === 'string'
        ? f.userId
        : undefined;
  const owner = f?.owner;
  const ownerScope =
    owner?.scope ??
    (sessionId !== undefined
      ? 'session'
      : userId !== undefined
        ? 'user'
        : undefined);
  if (sessionId === undefined && userId === undefined && owner === undefined)
    return undefined;
  const ids = {
    sessionId,
    userId,
    ...(owner === undefined ? {} : { owner }),
  };
  if (ownerScope === 'session' && sessionId !== undefined)
    return { ...ids, ownerScope, sessionId };
  if (ownerScope === 'user' && userId !== undefined)
    return { ...ids, ownerScope, userId };
  if (ownerScope === 'global') return { ...ids, ownerScope };
  throw new RagError('Invalid owner filter', 'INVALID_ARGUMENT');
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
  const scope = filter.ownerScope;
  if (
    metadata.ownerScope !== scope ||
    tagRagMetadata(metadata).ownerScope === 'invalid'
  )
    return false;
  if (filter.owner) {
    const owner = filter.owner;
    if (owner.scope === 'session' && metadata.sessionId !== owner.sessionId)
      return false;
    if (owner.scope === 'user' && metadata.userId !== owner.userId)
      return false;
  }
  if (filter.sessionId !== undefined && metadata.sessionId !== filter.sessionId)
    return false;
  if (filter.userId !== undefined && metadata.userId !== filter.userId)
    return false;
  return true;
}

/** Derive a positive tag for new or migrated records; conflicting identities stay closed. */
export function tagRagMetadata(metadata: RagMetadata): RagMetadata {
  const keys = (['sessionId', 'userId', 'roleId'] as const).filter(
    (key) => key in metadata,
  );
  const key = keys[0];
  const scope =
    key === 'sessionId'
      ? 'session'
      : key === 'userId'
        ? 'user'
        : key === 'roleId'
          ? 'invalid'
          : 'global';
  const valid =
    keys.length <= 1 &&
    (!key ||
      (typeof metadata[key] === 'string' && metadata[key].trim().length > 0));
  if (
    !valid ||
    (metadata.ownerScope !== undefined && metadata.ownerScope !== scope)
  )
    return { ...metadata, ownerScope: 'invalid' };
  return { ...metadata, ownerScope: scope };
}

/** Refuse malformed caller writes; migration uses tagRagMetadata to quarantine instead. */
export function validateRagMetadata(metadata: RagMetadata): RagMetadata {
  const tagged = tagRagMetadata(metadata);
  if (tagged.ownerScope === 'invalid')
    throw new RagError(
      'Conflicting owner scope and identity keys',
      'INVALID_ARGUMENT',
    );
  return tagged;
}

/** Backfill from the catalog owner, quarantining conflicting record identities. */
export function migrateRagMetadata(
  metadata: RagMetadata,
  owner?: RagCollectionOwner,
): RagMetadata {
  if (!owner) return tagRagMetadata(metadata);
  try {
    return stampRagOwner(metadata, owner);
  } catch {
    return { ...metadata, ownerScope: 'invalid' };
  }
}
