// packages/llm-agent/src/rag/catalog/validation.ts
import type {
  RagCatalogDescription,
  RagCollectionOwner,
  RagCollectionRecord,
  RagJsonValue,
} from '../../interfaces/rag.js';
import type { Result } from '../../interfaces/types.js';
import {
  InvalidAttributesError,
  InvalidOwnerError,
} from '../corrections/errors.js';

/**
 * Attributes as a catalog can return them: JSON with finite numbers, no cycle,
 * plain objects and arrays only. Called by both createCollection contracts
 * BEFORE anything is created, and on every catalog row read back.
 */
export function validateRagAttributes(
  value: unknown,
): Result<RagJsonValue | undefined, InvalidAttributesError> {
  if (value === undefined) return { ok: true, value: undefined };
  const problem = findNonJson(value, '$', new Set<object>());
  return problem === undefined
    ? { ok: true, value: value as RagJsonValue }
    : { ok: false, error: new InvalidAttributesError(problem) };
}

function findNonJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string | undefined {
  if (value === null) return undefined;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return undefined;
    case 'number':
      return Number.isFinite(value)
        ? undefined
        : `${path} is ${String(value)}, which JSON turns into null`;
    case 'undefined':
      return `${path} is undefined, which JSON drops`;
    case 'object':
      break;
    default:
      return `${path} is a ${typeof value}, which has no JSON form`;
  }
  const obj = value as object;
  if (ancestors.has(obj)) return `${path} is a cycle`;
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const found = findNonJson(obj[i], `${path}[${i}]`, ancestors);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (proto as { constructor?: { name?: string } }).constructor;
      return `${path} is a ${ctor?.name ?? 'class'} instance, which JSON would not return as it is`;
    }
    for (const [key, child] of Object.entries(obj)) {
      const found = findNonJson(child, `${path}.${key}`, ancestors);
      if (found !== undefined) return found;
    }
    return undefined;
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * The owner as the union demands it, for input no compiler checked: the scope,
 * and only the key that scope selects, non-empty. Called by both
 * createCollection contracts before any backend access, and on every catalog
 * row read back.
 */
export function validateRagOwner(
  input: unknown,
): Result<RagCollectionOwner, InvalidOwnerError> {
  const o = (typeof input === 'object' && input !== null ? input : {}) as {
    scope?: unknown;
    userId?: unknown;
    sessionId?: unknown;
  };
  switch (o.scope) {
    case 'global':
      return { ok: true, value: { scope: 'global' } };
    case 'user':
      return typeof o.userId === 'string' && o.userId !== ''
        ? { ok: true, value: { scope: 'user', userId: o.userId } }
        : {
            ok: false,
            error: new InvalidOwnerError(
              'a user collection needs a non-empty userId',
            ),
          };
    case 'session':
      return typeof o.sessionId === 'string' && o.sessionId !== ''
        ? { ok: true, value: { scope: 'session', sessionId: o.sessionId } }
        : {
            ok: false,
            error: new InvalidOwnerError(
              'a session collection needs a non-empty sessionId',
            ),
          };
    case undefined:
      return { ok: false, error: new InvalidOwnerError('no scope') };
    default:
      return {
        ok: false,
        error: new InvalidOwnerError(`unknown scope '${String(o.scope)}'`),
      };
  }
}

/** The owner's key in the flat shape RagCollectionMeta carries. */
export function ragOwnerKeys(owner: RagCollectionOwner): {
  sessionId?: string;
  userId?: string;
} {
  if (owner.scope === 'session') return { sessionId: owner.sessionId };
  if (owner.scope === 'user') return { userId: owner.userId };
  return {};
}

/**
 * The stored form of attributes: JSON text, or null for none. Text rather than a
 * backend's JSON type, so `null` and absent stay apart and nothing is normalized.
 */
export function encodeRagAttributes(
  value: RagJsonValue | undefined,
): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** One catalog row as a provider read it, before anything is trusted. */
export type RagCatalogRow = {
  readonly storeName?: unknown;
  readonly name?: unknown;
  readonly scope?: unknown;
  readonly userId?: unknown;
  readonly sessionId?: unknown;
  /** What encodeRagAttributes produced; null or absent → no attributes. */
  readonly attributesJson?: unknown;
};

export type RagCatalogRowParse =
  | { readonly ok: true; readonly record: RagCollectionRecord }
  | {
      readonly ok: false;
      readonly rejected: {
        readonly storeName?: string;
        readonly reason: string;
      };
    };

/**
 * A catalog row is storage outside any compiler, so it is checked at this
 * boundary: no store name, no logical name, no or an unknown scope, a missing
 * owner key, or attributes that are not JSON text make it a rejection, never a
 * record (§6.3).
 */
export function parseRagCollectionRecord(
  row: RagCatalogRow,
): RagCatalogRowParse {
  const storeName =
    typeof row.storeName === 'string' && row.storeName !== ''
      ? row.storeName
      : undefined;
  const reject = (reason: string): RagCatalogRowParse => ({
    ok: false,
    rejected: storeName === undefined ? { reason } : { storeName, reason },
  });
  if (storeName === undefined) return reject('no store name');
  const name = row.name;
  if (typeof name !== 'string' || name === '') return reject('no logical name');
  const owner = validateRagOwner(row);
  if (!owner.ok) return reject(owner.error.reason);
  const json = row.attributesJson;
  if (json === null || json === undefined) {
    return { ok: true, record: { ...owner.value, storeName, name } };
  }
  if (typeof json !== 'string') {
    return reject(`attributes are stored as ${typeof json}, not as JSON text`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return reject(
      `attributes are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const attributes = validateRagAttributes(parsed);
  if (!attributes.ok) return reject(attributes.error.reason);
  return {
    ok: true,
    record: { ...owner.value, storeName, name, attributes: attributes.value },
  };
}

/** Sorts rows into records and rejections; one bad row fails nothing. */
export function describeRagCatalogRows(
  rows: readonly RagCatalogRow[],
): RagCatalogDescription {
  const records: RagCollectionRecord[] = [];
  const rejected: Array<{ storeName?: string; reason: string }> = [];
  for (const row of rows) {
    const parsed = parseRagCollectionRecord(row);
    if (parsed.ok) records.push(parsed.record);
    else rejected.push(parsed.rejected);
  }
  return { records, rejected };
}
