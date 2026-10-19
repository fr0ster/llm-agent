import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type Result,
} from './types.js';

/** Error code: the catalog record for the given store name does not exist. */
export const RAG_COLLECTION_NOT_FOUND = 'RAG_COLLECTION_NOT_FOUND';
/** Error code: the caller passed an invalid argument (e.g. an empty filter). */
export const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
/** Default page size for {@link IRagScanner.scan}. */
export const DEFAULT_SCAN_PAGE_SIZE = 500;

/** Strict string-equality filter on record metadata. Unset fields match all. */
export interface RagScanFilter {
  userId?: string;
  sessionId?: string;
  namespace?: string;
}

export interface RagScanRecord {
  id: string;
  text: string;
  metadata: RagMetadata;
}

export interface RagScanPage {
  records: RagScanRecord[];
  /** Absent only when the scan is complete. Pages may be short or empty. */
  cursor?: string;
}

/** Enumerates records of one collection (includes expired, never vectors). */
export interface IRagScanner {
  scan(
    opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
    options?: CallOptions,
  ): Promise<Result<RagScanPage, RagError>>;
}

/** Deletes every record of one collection that matches a non-empty filter. */
export interface IRagFilteredDeleter {
  deleteWhere(
    filter: RagScanFilter,
    options?: CallOptions,
  ): Promise<Result<{ deleted: number }, RagError>>;
}

export interface RagCatalogPatch {
  collectionName?: string;
  /** Replaces the stored attributes. */
  attributes?: Record<string, unknown>;
}

/** Updates a catalog record in place. */
export interface IRagCatalogUpdater {
  updateCollection(
    storeName: string,
    patch: RagCatalogPatch,
  ): Promise<Result<void, RagError>>;
}

function hasMethod(x: unknown, name: string): boolean {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Record<string, unknown>)[name] === 'function'
  );
}

export function isRagScanner(x: unknown): x is IRagScanner {
  return hasMethod(x, 'scan');
}

export function isRagFilteredDeleter(x: unknown): x is IRagFilteredDeleter {
  return hasMethod(x, 'deleteWhere');
}

export function isRagCatalogUpdater(x: unknown): x is IRagCatalogUpdater {
  return hasMethod(x, 'updateCollection');
}

const FILTER_FIELDS = ['userId', 'sessionId', 'namespace'] as const;

/** Strict string equality on each set filter field. */
export function matchesScanFilter(
  metadata: RagMetadata,
  filter: RagScanFilter | undefined,
): boolean {
  if (!filter) return true;
  for (const f of FILTER_FIELDS) {
    const want = filter[f];
    if (want !== undefined && metadata[f] !== want) return false;
  }
  return true;
}

const invalid = (message: string): { ok: false; error: RagError } => ({
  ok: false,
  error: new RagError(message, INVALID_ARGUMENT),
});

/**
 * Each filter field that is set must be a string: `null`, a number or a
 * boolean is `INVALID_ARGUMENT`, so a JS caller gets the same refusal from
 * every backend instead of backend-specific matching.
 */
export function assertScanFilter(
  filter: RagScanFilter | undefined,
): Result<void, RagError> {
  if (filter === undefined) return { ok: true, value: undefined };
  if (typeof filter !== 'object' || filter === null) {
    return invalid('the scan filter must be an object');
  }
  for (const f of FILTER_FIELDS) {
    const value: unknown = filter[f];
    if (value !== undefined && typeof value !== 'string') {
      return invalid(`the scan filter field '${f}' must be a string`);
    }
  }
  return { ok: true, value: undefined };
}

/**
 * The checks `scan` runs before any backend call, after the abort check:
 * `pageSize` is a positive integer when set, then {@link assertScanFilter}.
 */
export function assertScanOptions(opts?: {
  filter?: RagScanFilter;
  pageSize?: number;
}): Result<void, RagError> {
  const size = opts?.pageSize;
  if (size !== undefined && !(Number.isInteger(size) && size > 0)) {
    return invalid('scan pageSize must be a positive integer');
  }
  return assertScanFilter(opts?.filter);
}

/**
 * The checks `deleteWhere` runs before any backend call, after the abort
 * check: at least one filter field is set, then {@link assertScanFilter}.
 */
export function assertNonEmptyFilter(
  filter: RagScanFilter,
): Result<void, RagError> {
  if (typeof filter !== 'object' || filter === null) {
    return invalid('deleteWhere requires a non-empty filter');
  }
  if (FILTER_FIELDS.every((f) => filter[f] === undefined)) {
    return invalid('deleteWhere requires a non-empty filter');
  }
  return assertScanFilter(filter);
}

const ID_CURSOR_PREFIX = 'i:';

/**
 * The scan cursor of a store keyed by a string id (HANA, PG): the last id of
 * the page, prefixed and base64url-encoded, so a cursor the store did not
 * issue is recognised.
 */
export function encodeIdScanCursor(id: string): string {
  return Buffer.from(`${ID_CURSOR_PREFIX}${id}`, 'utf8').toString('base64url');
}

/** The id inside a cursor from {@link encodeIdScanCursor}; `undefined` when malformed. */
export function decodeIdScanCursor(cursor: unknown): string | undefined {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    return undefined;
  }
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!raw.startsWith(ID_CURSOR_PREFIX)) return undefined;
  // Only the canonical encoding is a cursor this module issued.
  if (encodeIdScanCursor(raw.slice(ID_CURSOR_PREFIX.length)) !== cursor) {
    return undefined;
  }
  return raw.slice(ID_CURSOR_PREFIX.length);
}
