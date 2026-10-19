import type { PgClient } from '../pg-vector-rag.js';

/**
 * A pg client that stores the vector table's rows and answers PgVectorRag's
 * statements the way Postgres would: the WHERE conditions on the jsonb
 * metadata are evaluated with SQL semantics (`->>` of a missing key is NULL,
 * and NULL = $n is not true), rows are ordered by cosine distance and cut at
 * LIMIT. Both table layouts are understood: per-collection tables, and the
 * shared documents table told apart by its `"collection"` column. It knows
 * exactly the statement and condition shapes PgVectorRag emits and throws on
 * any other, so a store change that emits new SQL fails loudly here instead of
 * being silently mis-evaluated.
 */
export type StoringPg = PgClient & {
  searches: Array<{ sql: string; params: readonly unknown[] }>;
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
const TTL =
  /^COALESCE\(CASE WHEN jsonb_typeof\(metadata->'ttl'\) = 'number' THEN \(metadata->>'ttl'\)::float8 END, 'infinity'::float8\) >= \$(\d+)$/;

function evaluate(
  rawCond: string,
  row: Row,
  params: readonly unknown[],
): boolean {
  const coll = rawCond.match(COLLECTION);
  if (coll) return row.collection === params[Number(coll[1]) - 1];
  // The shared layout quotes the column; the semantics are the same.
  const cond = rawCond.replaceAll('"metadata"', 'metadata');
  const eq = cond.match(EQ);
  if (eq) {
    const v = row.metadata[eq[1]];
    // `->>` yields the text of a scalar; a missing key is NULL (not true).
    if (v === undefined || v === null) return false;
    return String(v) === String(params[Number(eq[2]) - 1]);
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
  /^INSERT INTO "([^"]+)" \("collection", "id", "text", "vector", "metadata"\) VALUES \(\$1, \$2, \$3, .*, \$4::jsonb\) ON CONFLICT \("collection", "id"\) DO UPDATE SET /;
const OWN_INSERT = /^INSERT INTO "([^"]+)" \(id, text, vector, metadata\)/;
const SHARED_BY_ID =
  /^SELECT "id", "text", "metadata" FROM "([^"]+)" WHERE "collection" = \$1 AND "id" = \$2$/;
const SHARED_DELETE =
  /^DELETE FROM "([^"]+)" WHERE "collection" = \$1(?: AND "id" = \$2)?$/;
const SEARCH =
  /^SELECT (?:id, text, metadata|"id", "text", "metadata"), (?:vector|"vector") <=> .*? AS score FROM "([^"]+)"(?: WHERE (.*))? ORDER BY (?:vector|"vector") <=> .* LIMIT (\d+)$/;

/** `sharedDimension`: what the startup check of a shared table finds (default: none, the check is not answered). */
export function storingPg(opts: { sharedDimension?: number } = {}): StoringPg {
  const rows = new Map<string, Row>();
  const searches: StoringPg['searches'] = [];
  const keyOf = (r: Pick<Row, 'table' | 'collection' | 'id'>): string =>
    JSON.stringify([r.table, r.collection ?? null, r.id]);
  return {
    searches,
    async query(sql, params = []) {
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
