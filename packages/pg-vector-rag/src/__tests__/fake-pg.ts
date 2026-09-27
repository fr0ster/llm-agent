import type { PgClient } from '../pg-vector-rag.js';

export type FakeCatalogRow = {
  storeName: string;
  name: unknown;
  scope: unknown;
  userId: unknown;
  sessionId: unknown;
  attributesJson: unknown;
};

export type FakePg = {
  readonly client: PgClient;
  readonly tables: Set<string>;
  readonly records: Map<string, FakeCatalogRow>;
  readonly statements: string[];
  /** A statement matching this throws, as a refusing server would. */
  failOn?: RegExp;
  /** Runs inside the catalog INSERT, before its key check — another writer racing. */
  beforeInsertRecord?: () => void;
};

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };
const NONE: QueryResult = { rows: [], rowCount: 0 };
const one = (row: Record<string, unknown>): QueryResult => ({
  rows: [row],
  rowCount: 1,
});

export function fakePg(catalog = 'rag_collection_catalog'): FakePg {
  const fake: FakePg = {
    tables: new Set<string>(),
    records: new Map<string, FakeCatalogRow>(),
    statements: [],
    client: {
      query: async (sql, params = []) => answer(fake, catalog, sql, params),
      end: async () => {},
    },
  };
  return fake;
}

function requireTable(fake: FakePg, table: string): void {
  if (!fake.tables.has(table))
    throw new Error(`relation "${table}" does not exist`);
}

function answer(
  fake: FakePg,
  catalog: string,
  sql: string,
  params: readonly unknown[],
): QueryResult {
  fake.statements.push(sql);
  if (fake.failOn?.test(sql))
    throw new Error(`refused by the test: ${sql.slice(0, 60)}`);
  const q = `"${catalog}"`;
  if (sql.startsWith('SELECT to_regclass')) {
    return one({
      present: fake.tables.has(String(params[0]).replace(/^"|"$/g, '')),
    });
  }
  if (sql.startsWith('CREATE EXTENSION')) return NONE;
  const create = sql.match(/^CREATE TABLE (IF NOT EXISTS )?"([^"]+)"/);
  if (create) {
    const [, ifNotExists, table] = create;
    if (fake.tables.has(table)) {
      if (ifNotExists) return NONE;
      throw new Error(`relation "${table}" already exists`);
    }
    fake.tables.add(table);
    return NONE;
  }
  const probe = sql.match(
    /^SELECT COUNT\(\*\) AS n FROM "([^"]+)" WHERE 1 = 0$/,
  );
  if (probe) {
    requireTable(fake, probe[1]);
    return one({ n: 0 });
  }
  if (sql.startsWith(`SELECT 1 AS present FROM ${q}`)) {
    requireTable(fake, catalog);
    return fake.records.has(String(params[0])) ? one({ present: 1 }) : NONE;
  }
  if (sql.startsWith(`INSERT INTO ${q}`)) {
    requireTable(fake, catalog);
    fake.beforeInsertRecord?.();
    const storeName = String(params[0]);
    if (fake.records.has(storeName)) {
      throw new Error(
        `duplicate key value violates unique constraint (store_name)=(${storeName})`,
      );
    }
    fake.records.set(storeName, {
      storeName,
      name: params[1],
      scope: params[2],
      userId: params[3],
      sessionId: params[4],
      attributesJson: params[5],
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('SELECT store_name AS "storeName"')) {
    requireTable(fake, catalog);
    return { rows: [...fake.records.values()], rowCount: fake.records.size };
  }
  if (sql.startsWith(`DELETE FROM ${q}`)) {
    requireTable(fake, catalog);
    return {
      rows: [],
      rowCount: fake.records.delete(String(params[0])) ? 1 : 0,
    };
  }
  const drop = sql.match(/^DROP TABLE IF EXISTS "([^"]+)"$/);
  if (drop) {
    fake.tables.delete(drop[1]);
    return NONE;
  }
  const write = sql.match(
    /^INSERT INTO "([^"]+)" \(id, text, vector, metadata\)/,
  );
  if (write) {
    requireTable(fake, write[1]);
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('SELECT table_name FROM information_schema.tables')) {
    return {
      rows: [...fake.tables].map((t) => ({ table_name: t })),
      rowCount: fake.tables.size,
    };
  }
  throw new Error(`fake pg: unhandled statement: ${sql}`);
}
