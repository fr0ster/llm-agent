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

export function assertNonEmptyFilter(
  filter: RagScanFilter,
): Result<void, RagError> {
  if (FILTER_FIELDS.every((f) => filter[f] === undefined)) {
    return {
      ok: false,
      error: new RagError(
        'deleteWhere requires a non-empty filter',
        INVALID_ARGUMENT,
      ),
    };
  }
  return { ok: true, value: undefined };
}
