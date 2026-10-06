/**
 * Collection profiles — how one kind of collection is filled and searched
 * (spec docs/superpowers/specs/2026-10-05-collection-profiles-design.md §3).
 * Additive contracts; IRag, IReranker, IRetrievalStrategy, IMetrics unchanged.
 */
import { createHash } from 'node:crypto';
import type { RagJsonValue } from './rag.js';

/**
 * Who owns a record and who may see it. `scope` IS the visibility.
 * Flattened by the framework into metadata: `visibility` + the owner key.
 */
export type RecordOwner =
  | { readonly scope: 'global' }
  /** A team or a role, as the consumer defines it. */
  | { readonly scope: 'group'; readonly groupId: string }
  | { readonly scope: 'user'; readonly userId: string }
  | {
      readonly scope: 'session';
      readonly sessionId: string;
      readonly userId?: string;
    };

/**
 * Keys the framework writes; a profile's or writer's extras can never set them.
 * `staleRecordIds` (canonical only): old ids a replacement must still delete; kept
 * until a delete succeeds (F3). No `serviceRecord` key: there is no service record in
 * a store (D54, spec §17.17).
 */
export type ReservedRecordKey =
  | 'id'
  | 'itemId'
  | 'recordKind'
  | 'itemText'
  | 'profile'
  | 'recordIds'
  | 'staleRecordIds'
  | 'visibility'
  | 'userId'
  | 'groupId'
  | 'sessionId'
  | 'ttl';

export interface IndexedRecord {
  /**
   * The PHYSICAL store id, assigned by the binding — never by the indexer:
   * `recordId(owner, itemId, recordKind, n)`, n = the record's position within its kind.
   */
  readonly id: string;
  /** The text that is embedded. */
  readonly text: string;
  /** The LOGICAL item id. Not unique in a store: two owners may use the same one. */
  readonly itemId: string;
  readonly recordKind: string;
  /** Required: no record without an owner. */
  readonly owner: RecordOwner;
  /** Non-canonical records in an items store: the item text, for the reranker. */
  readonly itemText?: string;
  /** Profile extras (e.g. `name` for tools). Reserved keys cannot be set here. */
  readonly metadata?: Readonly<Record<string, RagJsonValue>> & {
    readonly [K in ReservedRecordKey]?: never;
  };
}

/** What an indexer produces. The physical id is not the indexer's to choose. */
export type RecordDraft = Omit<IndexedRecord, 'id'>;

/** Addresses one item for get / remove. The owner selects the partition AND the record ids. */
export interface ItemRef {
  readonly itemId: string;
  readonly owner: RecordOwner;
}

const SCOPE_CODE: Readonly<Record<RecordOwner['scope'], string>> = {
  global: 'g',
  group: 'grp',
  user: 'u',
  session: 's',
};

/** The owner key that goes into a record id (`session`'s optional userId is not part of it). */
export function ownerKeyOf(owner: RecordOwner): string {
  switch (owner.scope) {
    case 'global':
      return '';
    case 'group':
      return owner.groupId;
    case 'user':
      return owner.userId;
    case 'session':
      return owner.sessionId;
  }
}

const MAX_READABLE_ID = 200;

/**
 * The one id function (spec §3.1). Pure and deterministic; exported so a
 * consumer's own profile uses it too. Ids longer than 200 characters become
 * `h:` + sha256 hex (66 characters) — pg-vector and HANA cap ids at 255.
 */
export function recordId(
  owner: RecordOwner,
  itemId: string,
  kind: string,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `recordId: n must be a non-negative integer (got ${n})`,
    );
  }
  const readable = `${SCOPE_CODE[owner.scope]}:${encodeURIComponent(
    ownerKeyOf(owner),
  )}/${encodeURIComponent(itemId)}#${encodeURIComponent(kind)}:${n}`;
  return readable.length <= MAX_READABLE_ID
    ? readable
    : `h:${createHash('sha256').update(readable).digest('hex')}`;
}
