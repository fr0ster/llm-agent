import type { PgClient } from '../pg-vector-rag.js';

/**
 * A pg client that stores the vector table's rows and answers PgVectorRag's
 * statements the way Postgres would: the WHERE conditions on the jsonb
 * metadata are evaluated with SQL semantics (`->>` of a missing key is NULL,
 * and NULL = $n is not true), rows are ordered by cosine distance and cut at
 * LIMIT. Both table layouts are understood: per-collection tables, and the
 * shared documents table told apart by its `"collection"` column, with the
 * provider's catalog statements on the shared catalog table. It knows
 * exactly the statement and condition shapes PgVectorRag emits and throws on
 * any other, so a store change that emits new SQL fails loudly here instead of
 * being silently mis-evaluated.
 */
export type StoringPg = PgClient & {
  searches: Array<{ sql: string; params: readonly unknown[] }>;
  /** Every statement received, in order. */
  statements: string[];
  /** Orphan setup: a row of the shared documents table, written past the store. */
  insertSharedRow(row: Omit<Row, 'table'> & { table?: string }): void;
};

type Row = {
  table: string;
  /** `shared` only: the collection of the documents table the row belongs to. */
  collection?: string;
  id: string;
  text: string;
  vector: number[];
  metadata: Record<string, unknown>;
};

function parseVector(sql: string): number[] {
  const m = sql.match(/'\[([^\]]*)\]'::vector/);
  if (!m) throw new Error(`no vector literal in: ${sql}`);
  return m[1].split(',').map(Number);
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const COLLECTION = /^"collection" = \$(\d+)$/;
const EQ = /^metadata->>'([A-Za-z_]+)' = \$(\d+)$/;
// Shared layout: the key matches only a JSON string (NULL otherwise).
const EQ_STRING =
  /^CASE WHEN jsonb_typeof\(metadata->'([A-Za-z_]+)'\) = 'string' THEN metadata->>'\1' END = \$(\d+)$/;
const TTL =
  /^COALESCE\(CASE WHEN jsonb_typeof\(metadata->'ttl'\) = 'number' THEN \(metadata->>'ttl'\)::float8 END, 'infinity'::float8\) >= \$(\d+)$/;

function evaluate(
  rawCond: string,
  row: Row,
  params: readonly unknown[],
): boolean {
  const shared = row.collection !== undefined;
  const coll = rawCond.match(COLLECTION);
  if (coll) return row.collection === params[Number(coll[1]) - 1];
  // The shared layout quotes the column; the semantics are the same.
  const cond = shared ? rawCond.replaceAll('"metadata"', 'metadata') : rawCond;
  const eq = cond.match(EQ);
  if (eq) {
    const v = row.metadata[eq[1]];
    // `->>` yields the text of a scalar; a missing key is NULL (not true).
    if (v === undefined || v === null) return false;
    return String(v) === String(params[Number(eq[2]) - 1]);
  }
  const eqString = cond.match(EQ_STRING);
  if (eqString) {
    const v = row.metadata[eqString[1]];
    // Not a JSON string: the CASE is NULL, and NULL = $n is not true.
    return (
      typeof v === 'string' && v === String(params[Number(eqString[2]) - 1])
    );
  }
  const ttl = cond.match(TTL);
  if (ttl) {
    const v = row.metadata.ttl;
    const t = typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
    return t >= Number(params[Number(ttl[1]) - 1]);
  }
  throw new Error(`storing-pg: unsupported condition: ${rawCond}`);
}

const SHARED_INSERT =
  /^INSERT INTO ((?:"[^"]+"[.])?"[^"]+") \("collection", "id", "text", "vector", "metadata"\) VALUES \(\$1, \$2, \$3, .*, \$4::jsonb\) ON CONFLICT \("collection", "id"\) DO UPDATE SET /;
const OWN_INSERT = /^INSERT INTO ("[^"]+") \(id, text, vector, metadata\)/;
const OWN_BY_ID = /^SELECT id, text, metadata FROM ("[^"]+") WHERE id = \$1$/;
const OWN_DELETE = /^DELETE FROM ("[^"]+") WHERE id = \$1$/;
const SHARED_BY_ID =
  /^SELECT "id", "text", "metadata" FROM ((?:"[^"]+"[.])?"[^"]+") WHERE "collection" = \$1 AND "id" = \$2$/;
const SHARED_DELETE =
  /^DELETE FROM ((?:"[^"]+"[.])?"[^"]+") WHERE "collection" = \$1(?: AND "id" = \$2)?$/;
const COUNT_SHARED =
  /^SELECT COUNT\(\*\) AS n FROM ((?:"[^"]+"[.])?"[^"]+") WHERE "collection" = \$1$/;
const DISTINCT_COLLECTIONS =
  /^SELECT DISTINCT "collection" AS "c" FROM ((?:"[^"]+"[.])?"[^"]+")$/;
const RECORD_EXISTS =
  /^SELECT 1 AS present FROM ((?:"[^"]+"[.])?"[^"]+") WHERE store_name = \$1$/;
const RECORD_INSERT =
  /^INSERT INTO ((?:"[^"]+"[.])?"[^"]+") \(store_name, collection_name, scope, user_id, session_id, attributes_json\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6\)$/;
const RECORD_SELECT =
  /^SELECT store_name AS "storeName", collection_name AS "name", scope AS "scope", user_id AS "userId", session_id AS "sessionId", attributes_json AS "attributesJson" FROM ((?:"[^"]+"[.])?"[^"]+") ORDER BY store_name$/;
const RECORD_UPDATE =
  /^UPDATE ((?:"[^"]+"[.])?"[^"]+") SET collection_name = COALESCE\(\$1, collection_name\), attributes_json = COALESCE\(\$2, attributes_json\) WHERE store_name = \$3$/;
const RECORD_NAMES = /^SELECT store_name AS "s" FROM ((?:"[^"]+"[.])?"[^"]+")$/;
const RECORD_DELETE =
  /^DELETE FROM ((?:"[^"]+"[.])?"[^"]+") WHERE store_name = \$1$/;

// scan/deleteWhere: strict string conditions, binary key-set cursor on the id.
const SCAN =
  /^SELECT "id", "text", "metadata" FROM ((?:"[^"]+"[.])?"[^"]+")(?: WHERE (.*))? ORDER BY "id" LIMIT (\d+)$/;
const DELETE_WHERE =
  /^DELETE FROM ((?:"[^"]+"[.])?"[^"]+") WHERE (.*) RETURNING "id"$/;
const AFTER_KEY = /^"id" > \$(\d+)$/;

/** One total order on the key, shared by ORDER BY and the cursor comparison. */
const byteCompare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

const SEARCH =
  /^SELECT (?:id, text, metadata|"id", "text", "metadata"), (?:vector|"vector") <=> .*? AS score FROM ((?:"[^"]+"[.])?"[^"]+")(?: WHERE (.*))? ORDER BY (?:vector|"vector") <=> .* LIMIT (\d+)$/;

/** `sharedDimension`: what the startup check of a shared table finds (default: none, the check is not answered). */
export function storingPg(
  opts: { sharedDimension?: number; schema?: string; database?: string } = {},
): StoringPg {
  const rows = new Map<string, Row>();
  /** Catalog rows per table, keyed by store_name, in column order. */
  const records = new Map<string, Map<string, unknown[]>>();
  const recordsOf = (table: string): Map<string, unknown[]> => {
    let r = records.get(table);
    if (!r) {
      r = new Map();
      records.set(table, r);
    }
    return r;
  };
  const searches: StoringPg['searches'] = [];
  const statements: string[] = [];
  const keyOf = (r: Pick<Row, 'table' | 'collection' | 'id'>): string =>
    JSON.stringify([r.table, r.collection ?? null, r.id]);
  const sharedRows = (table: string): Row[] =>
    [...rows.values()].filter(
      (r) => r.table === table && r.collection !== undefined,
    );
  return {
    searches,
    statements,
    insertSharedRow(row) {
      const full: Row = { ...row, table: row.table ?? '"rag_documents"' };
      rows.set(keyOf(full), full);
    },
    async query(sql, params = []) {
      statements.push(sql);
      if (sql.includes('AS "listDatabase"'))
        return {
          rows: [
            {
              listDatabase: opts.database ?? 'catalog_a',
              listSchema: opts.schema ?? 'tenant_a',
              listHost: 'localhost',
              listPort: 5432,
            },
          ],
          rowCount: 1,
        };
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))
        return { rows: [], rowCount: 0 };
      sql = sql
        .replaceAll(' COLLATE "C"', '')
        .replace(
          'SELECT "id", "metadata", "text"',
          'SELECT "id", "text", "metadata"',
        )
        .replace('SELECT "id", "metadata"', 'SELECT "id", "text", "metadata"');
      const matching = (table: string, where: string | undefined): Row[] => {
        const conditions = where
          ? where.replaceAll('"metadata"', 'metadata').split(' AND ')
          : [];
        return [...rows.values()]
          .filter((r) => r.table === table)
          .filter((r) =>
            conditions.every((c) => {
              const array = c.match(/^"id" = ANY\(\$(\d+)::varchar\[\]\)$/);
              if (array) {
                const ids = params[Number(array[1]) - 1];
                return Array.isArray(ids) && ids.includes(r.id);
              }
              const inside = c.match(/^"id" IN \((.*)\)$/);
              if (inside)
                return inside[1]
                  .split(', ')
                  .some(
                    (placeholder) =>
                      r.id === params[Number(placeholder.slice(1)) - 1],
                  );
              const after = c.match(AFTER_KEY);
              if (after)
                return (
                  byteCompare(r.id, String(params[Number(after[1]) - 1])) > 0
                );
              return evaluate(c, r, params);
            }),
          );
      };
      const clearTable = sql.match(
        /^(?:TRUNCATE |DROP TABLE IF EXISTS )("[^"]+")$/,
      );
      if (clearTable) {
        for (const [key, row] of rows)
          if (row.table === clearTable[1]) rows.delete(key);
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('CREATE ')) return { rows: [], rowCount: 0 };
      if (opts.sharedDimension !== undefined) {
        if (sql.includes('pg_attribute'))
          return { rows: [{ dim: opts.sharedDimension }], rowCount: 1 };
        if (sql.startsWith('SELECT to_regclass'))
          return { rows: [{ present: true }], rowCount: 1 };
      }
      const shared = sql.match(SHARED_INSERT);
      if (shared) {
        const [collection, id, text, meta] = params as string[];
        const row: Row = {
          table: shared[1],
          collection,
          id,
          text,
          vector: parseVector(sql),
          metadata: JSON.parse(meta),
        };
        rows.set(keyOf(row), row);
        return { rows: [], rowCount: 1 };
      }
      const own = sql.match(OWN_INSERT);
      if (own) {
        const [id, text, meta] = params as string[];
        const row: Row = {
          table: own[1],
          id,
          text,
          vector: parseVector(sql),
          metadata: JSON.parse(meta),
        };
        rows.set(keyOf(row), row);
        return { rows: [], rowCount: 1 };
      }
      const ownById = sql.match(OWN_BY_ID);
      if (ownById) {
        const hit = rows.get(
          keyOf({ table: ownById[1], id: String(params[0]) }),
        );
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      const ownDelete = sql.match(OWN_DELETE);
      if (ownDelete) {
        const gone = rows.delete(
          keyOf({ table: ownDelete[1], id: String(params[0]) }),
        );
        return { rows: [], rowCount: gone ? 1 : 0 };
      }
      const byId = sql.match(SHARED_BY_ID);
      if (byId) {
        const hit = rows.get(
          keyOf({
            table: byId[1],
            collection: String(params[0]),
            id: String(params[1]),
          }),
        );
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      const selection = sql.match(
        /^SELECT "id" FROM ((?:"[^"]+"[.])?"[^"]+") WHERE (.*) FOR UPDATE$/,
      );
      if (selection) {
        const out = matching(selection[1], selection[2]).map((row) => ({
          id: row.id,
        }));
        return { rows: out, rowCount: out.length };
      }
      const scan = sql.match(SCAN);
      if (scan) {
        const out = matching(scan[1], scan[2])
          .sort((a, b) => byteCompare(a.id, b.id))
          .slice(0, Number(scan[3]))
          .map((r) => ({ id: r.id, text: r.text, metadata: r.metadata }));
        return { rows: out, rowCount: out.length };
      }
      const delWhere = sql.match(DELETE_WHERE);
      if (delWhere) {
        const hit = matching(delWhere[1], delWhere[2]);
        for (const r of hit) rows.delete(keyOf(r));
        return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
      }
      const del = sql.match(SHARED_DELETE);
      if (del) {
        let n = 0;
        for (const [k, r] of rows) {
          if (
            r.table === del[1] &&
            r.collection === params[0] &&
            (params.length < 2 || r.id === params[1])
          ) {
            rows.delete(k);
            n++;
          }
        }
        return { rows: [], rowCount: n };
      }
      const count = sql.match(COUNT_SHARED);
      if (count) {
        const n = sharedRows(count[1]).filter(
          (r) => r.collection === params[0],
        ).length;
        // pg hands a COUNT back as a bigint string.
        return { rows: [{ n: String(n) }], rowCount: 1 };
      }
      const distinct = sql.match(DISTINCT_COLLECTIONS);
      if (distinct) {
        const names = new Set(sharedRows(distinct[1]).map((r) => r.collection));
        const out = [...names].map((c) => ({ c }));
        return { rows: out, rowCount: out.length };
      }
      const exists = sql.match(RECORD_EXISTS);
      if (exists) {
        const hit = recordsOf(exists[1]).has(String(params[0]));
        return { rows: hit ? [{ present: 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      const insert = sql.match(RECORD_INSERT);
      if (insert) {
        const table = recordsOf(insert[1]);
        const key = String(params[0]);
        if (table.has(key))
          throw new Error(
            'duplicate key value violates unique constraint (store_name)',
          );
        table.set(key, [...params]);
        return { rows: [], rowCount: 1 };
      }
      const select = sql.match(RECORD_SELECT);
      if (select) {
        const out = [...recordsOf(select[1]).values()]
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          .map((p) => ({
            storeName: p[0],
            name: p[1],
            scope: p[2],
            userId: p[3],
            sessionId: p[4],
            attributesJson: p[5],
          }));
        return { rows: out, rowCount: out.length };
      }
      const update = sql.match(RECORD_UPDATE);
      if (update) {
        // Columns: store_name, collection_name, scope, user_id, session_id, attributes_json.
        const row = recordsOf(update[1]).get(String(params[2]));
        if (!row) return { rows: [], rowCount: 0 };
        // COALESCE: a NULL parameter keeps the column.
        if (params[0] !== null) row[1] = params[0];
        if (params[1] !== null) row[5] = params[1];
        return { rows: [], rowCount: 1 };
      }
      const names = sql.match(RECORD_NAMES);
      if (names) {
        const out = [...recordsOf(names[1]).keys()].map((s) => ({ s }));
        return { rows: out, rowCount: out.length };
      }
      const delRecord = sql.match(RECORD_DELETE);
      if (delRecord) {
        const gone = recordsOf(delRecord[1]).delete(String(params[0]));
        return { rows: [], rowCount: gone ? 1 : 0 };
      }
      const m = sql.match(SEARCH);
      if (m) {
        searches.push({ sql, params });
        const conditions = m[2] ? m[2].split(' AND ') : [];
        const q = parseVector(sql);
        const hits = [...rows.values()]
          .filter((r) => r.table === m[1])
          .filter((r) => conditions.every((c) => evaluate(c, r, params)))
          .map((r) => ({
            id: r.id,
            text: r.text,
            metadata: r.metadata,
            score: cosineDistance(q, r.vector),
          }))
          .sort((a, b) => a.score - b.score)
          .slice(0, Number(m[3]));
        return { rows: hits, rowCount: hits.length };
      }
      throw new Error(`storing-pg: unsupported statement: ${sql.slice(0, 80)}`);
    },
    async end() {},
  };
}
