import {
  DEFAULT_SCAN_PAGE_SIZE,
  INVALID_ARGUMENT,
  matchesScanFilter,
  RagError,
  type RagScanFilter,
  type RagScanPage,
  type RagScanRecord,
} from '@mcp-abap-adt/llm-agent';
import { splitPayload } from './payload-record.js';

/** Issues one request against the store's Qdrant (base URL, auth, timeout). */
export type QdrantCall = (
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
) => Promise<Response>;

/** One scroll page and one delete request are at most this many points. */
const BATCH = 1000;

const FILTER_FIELDS = ['userId', 'sessionId', 'namespace'] as const;

type Offset = string | number;
interface ScrollPoint {
  id: string | number;
  payload?: Record<string, unknown>;
}
interface ScrollBody {
  result?: { points?: ScrollPoint[]; next_page_offset?: Offset | null };
}

/**
 * Strict string equality on the payload keys the store writes. `match.value`
 * with a string matches only a string payload value, so a number never
 * matches. No ttl condition: expired records are scanned too.
 */
export function scrollFilter(
  filter: RagScanFilter | undefined,
): { must: unknown[] } | undefined {
  const must: unknown[] = [];
  for (const key of FILTER_FIELDS) {
    const value = filter?.[key];
    if (value !== undefined) must.push({ key, match: { value } });
  }
  return must.length > 0 ? { must } : undefined;
}

const encodeCursor = (offset: Offset): string => JSON.stringify(offset);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Qdrant point offset is an unsigned integer or a UUID. */
function decodeCursor(cursor: string): Offset {
  try {
    const v: unknown = JSON.parse(cursor);
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
    if (typeof v === 'string' && UUID.test(v)) return v;
  } catch {
    // fall through
  }
  throw new RagError('scan cursor is not valid', INVALID_ARGUMENT);
}

async function scroll(
  call: QdrantCall,
  collection: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  code: string,
): Promise<{ points: ScrollPoint[]; next?: Offset }> {
  const res = await call(
    `/collections/${collection}/points/scroll`,
    { method: 'POST', body: JSON.stringify({ ...body, with_vector: false }) },
    signal,
  );
  if (!res.ok) {
    throw new RagError(`Qdrant scroll failed: ${await res.text()}`, code);
  }
  const json = (await res.json()) as ScrollBody;
  const next = json.result?.next_page_offset;
  return {
    points: json.result?.points ?? [],
    next: next === null || next === undefined ? undefined : next,
  };
}

function strictMatch(
  point: ScrollPoint,
  filter: RagScanFilter | undefined,
): boolean {
  return matchesScanFilter(splitPayload(point.payload ?? {}).metadata, filter);
}

function toRecord(point: ScrollPoint): RagScanRecord {
  const { text, metadata } = splitPayload(point.payload ?? {});
  const stored = metadata.id;
  return {
    id: typeof stored === 'string' ? stored : String(point.id),
    text,
    metadata,
  };
}

/** One page of a scroll; the cursor is Qdrant's `next_page_offset`. */
export async function scanPage(
  call: QdrantCall,
  collection: string,
  opts: { filter?: RagScanFilter; pageSize?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<RagScanPage> {
  const filter = scrollFilter(opts.filter);
  // Validate before any request.
  const offset =
    opts.cursor !== undefined ? decodeCursor(opts.cursor) : undefined;
  const { points, next } = await scroll(
    call,
    collection,
    {
      limit: opts.pageSize ?? DEFAULT_SCAN_PAGE_SIZE,
      with_payload: true,
      ...(filter ? { filter } : {}),
      ...(offset !== undefined ? { offset } : {}),
    },
    signal,
    'QUERY_ERROR',
  );
  // The server-side match is a prefilter: Qdrant's match.value also matches
  // an element of an array payload value, so apply the strict matcher here.
  // A page may come back short or empty; only a missing cursor ends a scan.
  const records = points
    .filter((p) => strictMatch(p, opts.filter))
    .map(toRecord);
  return next === undefined
    ? { records }
    : { records, cursor: encodeCursor(next) };
}

const aborted = (deleted: number): RagError =>
  new RagError(`Aborted after deleting ${deleted} record(s)`, 'ABORTED');

/** The subset of `ids` that exists in the collection right now. */
async function retrievePresent(
  call: QdrantCall,
  collection: string,
  ids: Array<string | number>,
  signal: AbortSignal | undefined,
): Promise<Array<string | number>> {
  const res = await call(
    `/collections/${collection}/points`,
    {
      method: 'POST',
      body: JSON.stringify({ ids, with_payload: false, with_vector: false }),
    },
    signal,
  );
  if (!res.ok) {
    throw new RagError(
      `Qdrant retrieve failed: ${await res.text()}`,
      'DELETE_ERROR',
    );
  }
  const json = (await res.json()) as {
    result?: Array<{ id: string | number }>;
  };
  return (json.result ?? []).map((p) => p.id);
}

/**
 * Snapshot the matching point ids with a scroll loop, then delete them in
 * batches. Returns the exact number deleted; `ABORTED` between steps.
 */
export async function deleteWhere(
  call: QdrantCall,
  collection: string,
  filter: RagScanFilter,
  signal?: AbortSignal,
): Promise<number> {
  const ids: Array<string | number> = [];
  let offset: Offset | undefined;
  do {
    if (signal?.aborted) throw aborted(0);
    const page = await scroll(
      call,
      collection,
      {
        limit: BATCH,
        with_payload: true,
        filter: scrollFilter(filter),
        ...(offset !== undefined ? { offset } : {}),
      },
      signal,
      'DELETE_ERROR',
    );
    for (const p of page.points) if (strictMatch(p, filter)) ids.push(p.id);
    offset = page.next;
  } while (offset !== undefined);

  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    if (signal?.aborted) throw aborted(deleted);
    let batch: Array<string | number>;
    let res: Response;
    try {
      // Delete only the ids still present, so the count is what this call
      // removed. A concurrent delete of the same ids between the retrieve and
      // the delete is the one window left: Qdrant has no server-side count.
      batch = await retrievePresent(
        call,
        collection,
        ids.slice(i, i + BATCH),
        signal,
      );
      if (batch.length === 0) continue;
      res = await call(
        `/collections/${collection}/points/delete?wait=true`,
        { method: 'POST', body: JSON.stringify({ points: batch }) },
        signal,
      );
    } catch (err) {
      // An abort that lands inside a request still reports what was deleted.
      if (signal?.aborted) throw aborted(deleted);
      throw err;
    }
    if (!res.ok) {
      throw new RagError(
        `Qdrant delete failed after deleting ${deleted} record(s): ${await res.text()}`,
        'DELETE_ERROR',
      );
    }
    deleted += batch.length;
  }
  return deleted;
}
