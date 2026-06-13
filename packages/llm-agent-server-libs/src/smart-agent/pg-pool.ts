/**
 * Real `pg.Pool` provider for the skill plugin-host's `postgres` catalog.
 *
 * The catalog store ({@link makePgCatalogStore} in `@mcp-abap-adt/llm-agent-libs`)
 * speaks to the database through the minimal {@link IPgPool} seam
 * (`query(sql, params?) → { rows, rowCount }`) so it carries NO `pg` dependency.
 * That store does INSERT/SELECT/UPDATE on a single-row table but never CREATEs it,
 * so production deployments need (a) a real connection and (b) the catalog table
 * to exist. This module provides BOTH.
 *
 * `pg` is imported DYNAMICALLY (mirroring `@mcp-abap-adt/pg-vector-rag`) so it
 * stays a soft dependency: the module imports with zero I/O, the Pool is created
 * lazily on first `query()`, and unit tests inject a fake pool instead (the
 * factory never touches a real DB).
 *
 * The DDL matches the columns {@link makePgCatalogStore} reads/writes exactly:
 *   `id text PRIMARY KEY, revision text NOT NULL, snapshot jsonb NOT NULL`.
 */

import type { IPgPool } from '@mcp-abap-adt/llm-agent-libs';

/** Default catalog table — agrees with `makePgCatalogStore`'s default. */
const DEFAULT_TABLE = 'skills_catalog';

/** Minimal shape of the `pg.Pool` we consume (a subset of the real driver). */
interface RawPgPool {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Lazily resolve the `pg` driver and construct a real Pool. */
async function createRawPool(connectionString: string): Promise<RawPgPool> {
  const mod = (await import('pg')) as unknown as {
    default?: { Pool?: new (a: unknown) => RawPgPool };
    Pool?: new (a: unknown) => RawPgPool;
  };
  const PoolCtor = mod.Pool ?? mod.default?.Pool;
  if (!PoolCtor) throw new Error('pg module did not expose Pool');
  return new PoolCtor({ connectionString });
}

/**
 * Build an {@link IPgPool} backed by a real `pg.Pool`. The Pool is created on
 * first use (lazy dynamic import) and the catalog table is ensured exactly once
 * before the first query reaches the catalog store.
 *
 * @param connectionString libpq connection string.
 * @param table catalog table name (defaults to `skills_catalog`, matching the
 *   catalog store default; pass the SAME value configured on `catalog.table`).
 */
export function makePgPool(
  connectionString: string,
  table: string = DEFAULT_TABLE,
): IPgPool {
  let poolPromise: Promise<RawPgPool> | undefined;
  let ensured: Promise<void> | undefined;

  const getPool = (): Promise<RawPgPool> => {
    if (!poolPromise) poolPromise = createRawPool(connectionString);
    return poolPromise;
  };

  const ensureTable = (pool: RawPgPool): Promise<void> => {
    if (!ensured) {
      ensured = pool
        .query(
          `CREATE TABLE IF NOT EXISTS ${table} (` +
            'id text PRIMARY KEY, ' +
            'revision text NOT NULL, ' +
            'snapshot jsonb NOT NULL)',
        )
        .then(() => undefined);
    }
    return ensured;
  };

  return {
    async query(sql: string, params?: unknown[]) {
      const pool = await getPool();
      await ensureTable(pool);
      const res = await pool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
  };
}
