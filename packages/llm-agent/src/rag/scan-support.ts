import {
  assertScanOptions,
  DEFAULT_SCAN_PAGE_SIZE,
  INVALID_ARGUMENT,
  matchesScanFilter,
  type RagScanFilter,
  type RagScanPage,
} from '../interfaces/rag-scan.js';
import {
  RagError,
  type RagMetadata,
  type Result,
} from '../interfaces/types.js';

/** A record of an in-process store, keyed by a stable, ascending number. */
export interface KeyedScanEntry {
  key: number;
  text: string;
  metadata: RagMetadata;
}

const CURSOR_PREFIX = 'k:';

export function encodeScanCursor(key: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${key}`, 'utf8').toString('base64url');
}

function decodeScanCursor(cursor: string): number | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!raw.startsWith(CURSOR_PREFIX)) return undefined;
  const digits = raw.slice(CURSOR_PREFIX.length);
  if (!/^\d+$/.test(digits)) return undefined;
  const n = Number(digits);
  // Only the canonical encoding is a cursor this module issued.
  if (!Number.isSafeInteger(n) || encodeScanCursor(n) !== cursor) {
    return undefined;
  }
  return n;
}

/**
 * One page of a key-set scan over entries sorted by ascending `key`.
 * `inStore` is the store's own namespace boundary; expired records are kept.
 * The cursor is the last key returned; it is omitted only on the last page.
 * `pageSize` and the filter are checked first, as every backend checks them.
 */
export function scanKeyedPage(
  entries: Iterable<KeyedScanEntry>,
  inStore: (metadata: RagMetadata) => boolean,
  opts?: { filter?: RagScanFilter; pageSize?: number; cursor?: string },
): Result<RagScanPage, RagError> {
  const valid = assertScanOptions(opts);
  if (!valid.ok) return valid;
  let after = -1;
  if (opts?.cursor !== undefined) {
    const decoded = decodeScanCursor(opts.cursor);
    if (decoded === undefined) {
      return {
        ok: false,
        error: new RagError('Invalid scan cursor', INVALID_ARGUMENT),
      };
    }
    after = decoded;
  }
  const pageSize = opts?.pageSize ?? DEFAULT_SCAN_PAGE_SIZE;

  const records: RagScanPage['records'] = [];
  let lastKey = -1;
  let more = false;
  for (const e of entries) {
    if (e.key <= after) continue;
    if (!inStore(e.metadata) || !matchesScanFilter(e.metadata, opts?.filter)) {
      continue;
    }
    if (records.length === pageSize) {
      more = true;
      break;
    }
    records.push({
      id: e.metadata.id ?? String(e.key),
      text: e.text,
      metadata: { ...e.metadata },
    });
    lastKey = e.key;
  }
  return {
    ok: true,
    value: more ? { records, cursor: encodeScanCursor(lastKey) } : { records },
  };
}
