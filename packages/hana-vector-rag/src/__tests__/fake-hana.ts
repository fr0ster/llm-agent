import type { HanaClient } from '../hana-vector-rag.js';

export type FakeCatalogRow = {
  storeName: string;
  name: unknown;
  scope: unknown;
  userId: unknown;
  sessionId: unknown;
  attributesJson: unknown;
};

export type FakeHana = {
  readonly client: HanaClient;
  readonly tables: Set<string>;
  readonly records: Map<string, FakeCatalogRow>;
  readonly statements: string[];
  failOn?: RegExp;
  beforeInsertRecord?: () => void;
};

type Rows = Array<Record<string, unknown>>;

export function fakeHana(catalog = 'rag_collection_catalog'): FakeHana {
  const fake: FakeHana = {
    tables: new Set<string>(),
    records: new Map<string, FakeCatalogRow>(),
    statements: [],
    client: {
      exec: async (sql, params = []) => ({
        rowCount: answer(fake, catalog, sql, params).length,
      }),
      query: async (sql, params = []) => answer(fake, catalog, sql, params),
      close: async () => {},
    },
  };
  return fake;
}

function requireTable(fake: FakeHana, table: string): void {
  if (!fake.tables.has(table)) throw new Error(`invalid table name: ${table}`);
}

function answer(
  fake: FakeHana,
  catalog: string,
  sql: string,
  params: readonly unknown[],
): Rows {
  fake.statements.push(sql);
  if (fake.failOn?.test(sql))
    throw new Error(`refused by the test: ${sql.slice(0, 60)}`);
  const q = `"${catalog}"`;
  if (sql.startsWith('SELECT COUNT(*) AS "n" FROM SYS.TABLES')) {
    return [{ n: fake.tables.has(String(params[params.length - 1])) ? 1 : 0 }];
  }
  const create = sql.match(/^CREATE TABLE (IF NOT EXISTS )?"([^"]+)"/);
  if (create) {
    const [, ifNotExists, table] = create;
    if (fake.tables.has(table)) {
      if (ifNotExists) return [];
      throw new Error(`cannot use duplicate table name: ${table}`);
    }
    fake.tables.add(table);
    return [];
  }
  const probe = sql.match(
    /^SELECT COUNT\(\*\) AS "n" FROM "([^"]+)" WHERE 1 = 0$/,
  );
  if (probe) {
    requireTable(fake, probe[1]);
    return [{ n: 0 }];
  }
  if (sql.startsWith(`SELECT 1 AS "present" FROM ${q}`)) {
    requireTable(fake, catalog);
    return fake.records.has(String(params[0])) ? [{ present: 1 }] : [];
  }
  if (sql.startsWith(`INSERT INTO ${q}`)) {
    requireTable(fake, catalog);
    fake.beforeInsertRecord?.();
    const storeName = String(params[0]);
    if (fake.records.has(storeName))
      throw new Error('unique constraint violated');
    fake.records.set(storeName, {
      storeName,
      name: params[1],
      scope: params[2],
      userId: params[3],
      sessionId: params[4],
      attributesJson: params[5],
    });
    return [{}];
  }
  if (sql.startsWith('SELECT store_name AS "storeName"')) {
    requireTable(fake, catalog);
    return [...fake.records.values()];
  }
  if (sql.startsWith(`DELETE FROM ${q}`)) {
    requireTable(fake, catalog);
    return fake.records.delete(String(params[0])) ? [{}] : [];
  }
  const drop = sql.match(/^DROP TABLE IF EXISTS "([^"]+)"$/);
  if (drop) {
    fake.tables.delete(drop[1]);
    return [];
  }
  const write = sql.match(/^UPSERT "([^"]+)" \(id, text, vector, metadata\)/);
  if (write) {
    requireTable(fake, write[1]);
    return [{}];
  }
  if (sql.startsWith('SELECT TABLE_NAME FROM SYS.TABLES')) {
    return [...fake.tables].map((t) => ({ TABLE_NAME: t }));
  }
  throw new Error(`fake hana: unhandled statement: ${sql}`);
}
