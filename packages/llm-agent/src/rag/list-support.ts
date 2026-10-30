import { z } from 'zod';
import type {
  RagListMetadata,
  RagListPage,
  RagListParams,
} from '../interfaces/rag.js';
import {
  assertScanOptions,
  matchesScanFilter,
  type RagScanFilter,
} from '../interfaces/rag-scan.js';
import {
  type CallOptions,
  RagError,
  type RagMetadata,
  type Result,
} from '../interfaces/types.js';
import type { KeyedScanEntry } from './scan-support.js';

const fields = ['userId', 'sessionId', 'namespace'] as const;
const invalid = (): RagError =>
  new RagError('Invalid list parameters or cursor', 'INVALID_ARGUMENT');

export function prepareList(
  params: RagListParams = {},
  options?: CallOptions,
): { filter: RagScanFilter; conflict: boolean; limit: number } {
  if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    throw invalid();
  const valid = assertScanOptions({ ...params, pageSize: params.limit });
  if (!valid.ok) throw valid.error;
  const scopeValid = assertScanOptions({ filter: options?.ragFilter });
  if (!scopeValid.ok) throw scopeValid.error;
  const limit = params.limit ?? 100;
  if (
    limit > 1000 ||
    (params.includeText !== undefined &&
      typeof params.includeText !== 'boolean')
  )
    throw invalid();
  const filter: RagScanFilter = {};
  let conflict = false;
  for (const key of fields) {
    const requested = params.filter?.[key];
    const scope = options?.ragFilter?.[key];
    if (requested !== undefined && scope !== undefined && requested !== scope)
      conflict = true;
    filter[key] = scope ?? requested;
  }
  return { filter, conflict, limit };
}

export function listCursorScope(
  store: string,
  filter: RagScanFilter,
  conflict = false,
): string {
  return `list:v1:${JSON.stringify([store, ...fields.map((key) => filter[key] ?? null), conflict])}:`;
}
export function encodeListCursor(scope: string, offset: string): string {
  return Buffer.from(scope + offset).toString('base64url');
}
export function decodeListCursor(scope: string, cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    !raw.startsWith(scope) ||
    encodeListCursor(scope, raw.slice(scope.length)) !== cursor
  )
    throw invalid();
  return raw.slice(scope.length);
}

/** Validate and detach legacy metadata without carrying its unrestricted index into listing. */
export function listMetadata(metadata: RagMetadata): RagListMetadata {
  const result: RagListMetadata = {};
  const schema = z.json();
  try {
    for (const key of Object.keys(metadata)) {
      if (metadata[key] === undefined) continue;
      const parsed = schema.safeParse(metadata[key]);
      if (!parsed.success)
        throw new RagError(
          'Stored metadata is not finite JSON',
          'RAG_INVALID_METADATA',
        );
      Object.defineProperty(result, key, {
        value: parsed.data,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (
      (result.id !== undefined && typeof result.id !== 'string') ||
      (result.ttl !== undefined && typeof result.ttl !== 'number') ||
      (result.namespace !== undefined && typeof result.namespace !== 'string')
    )
      throw new Error('Invalid metadata fields');
    return result;
  } catch (error) {
    if (error instanceof RagError) throw error;
    throw new RagError(
      'Stored metadata is not finite JSON',
      'RAG_INVALID_METADATA',
    );
  }
}

export function listKeyedPage(
  entries: Iterable<KeyedScanEntry & { id: string }>,
  inStore: (metadata: RagMetadata) => boolean,
  store: string,
  params: RagListParams = {},
  options?: CallOptions,
): Result<RagListPage, RagError> {
  try {
    const { filter, conflict, limit } = prepareList(params, options);
    const scope = listCursorScope(store, filter, conflict);
    const offset =
      params.cursor === undefined
        ? '-1'
        : decodeListCursor(scope, params.cursor);
    const after = Number(offset);
    if (!Number.isSafeInteger(after) || after < -1 || String(after) !== offset)
      throw invalid();
    const records: RagListPage['records'] = [];
    let examined = 0;
    let last = after;
    let more = false;
    if (!conflict)
      for (const entry of entries) {
        if (entry.key <= after) continue;
        if (examined === limit) {
          more = true;
          break;
        }
        examined++;
        last = entry.key;
        if (
          !inStore(entry.metadata) ||
          !matchesScanFilter(entry.metadata, filter)
        )
          continue;
        records.push({
          id: entry.metadata.id ?? entry.id,
          metadata: listMetadata(entry.metadata),
          ...(params.includeText ? { text: entry.text } : {}),
        });
      }
    if (options?.signal?.aborted) throw new RagError('Aborted', 'ABORTED');
    return {
      ok: true,
      value: {
        records,
        ...(more ? { cursor: encodeListCursor(scope, String(last)) } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RagError
          ? error
          : new RagError(String(error), 'QUERY_ERROR'),
    };
  }
}
