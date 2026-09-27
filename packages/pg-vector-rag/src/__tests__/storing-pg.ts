import type { PgClient } from '../pg-vector-rag.js';

/**
 * A pg client that stores the vector table's rows and answers PgVectorRag's
 * search SELECT the way Postgres would: the WHERE conditions on the jsonb
 * metadata are evaluated with SQL semantics (`->>` of a missing key is NULL,
 * and NULL = $n is not true), rows are ordered by cosine distance and cut at
 * LIMIT. It understands exactly the condition shapes PgVectorRag emits and
 * throws on any other, so a store change that emits new SQL fails loudly here
 * instead of being silently mis-evaluated.
 */
export type StoringPg = PgClient & {
  searches: Array<{ sql: string; params: readonly unknown[] }>;
};

type Row = {
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

const EQ = /^metadata->>'([A-Za-z_]+)' = \$(\d+)$/;
const TTL =
  /^COALESCE\(CASE WHEN jsonb_typeof\(metadata->'ttl'\) = 'number' THEN \(metadata->>'ttl'\)::float8 END, 'infinity'::float8\) >= \$(\d+)$/;

function evaluate(cond: string, row: Row, params: readonly unknown[]): boolean {
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
  throw new Error(`storing-pg: unsupported condition: ${cond}`);
}

export function storingPg(): StoringPg {
  const rows = new Map<string, Row>();
  const searches: StoringPg['searches'] = [];
  return {
    searches,
    async query(sql, params = []) {
      if (sql.startsWith('CREATE ')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT INTO')) {
        const [id, text, meta] = params as string[];
        rows.set(id, {
          id,
          text,
          vector: parseVector(sql),
          metadata: JSON.parse(meta),
        });
        return { rows: [], rowCount: 1 };
      }
      const m = sql.match(
        /^SELECT id, text, metadata, vector <=> .*? AS score FROM "[^"]+"(?: WHERE (.*))? ORDER BY vector <=> .* LIMIT (\d+)$/,
      );
      if (m) {
        searches.push({ sql, params });
        const conditions = m[1] ? m[1].split(' AND ') : [];
        const q = parseVector(sql);
        const hits = [...rows.values()]
          .filter((r) => conditions.every((c) => evaluate(c, r, params)))
          .map((r) => ({
            id: r.id,
            text: r.text,
            metadata: r.metadata,
            score: cosineDistance(q, r.vector),
          }))
          .sort((a, b) => a.score - b.score)
          .slice(0, Number(m[2]));
        return { rows: hits, rowCount: hits.length };
      }
      throw new Error(`storing-pg: unsupported statement: ${sql.slice(0, 80)}`);
    },
    async end() {},
  };
}
