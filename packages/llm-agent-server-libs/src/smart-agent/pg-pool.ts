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

/**
 * Strict SQL-identifier regex for the catalog table — bare identifier or one
 * optional `schema.table` dot. The table name is interpolated into DDL/queries,
 * so it MUST NOT trust its caller (belt-and-suspenders with the config-layer
 * validation in `skill-plugins-config.ts`).
 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function assertSafeTable(table: string): void {
  if (!SQL_IDENTIFIER.test(table)) {
    throw new Error(
      `pg-pool: invalid catalog table identifier '${table}' (must match ${SQL_IDENTIFIER.source})`,
    );
  }
}

/** Minimal shape of the `pg.Pool` we consume (a subset of the real driver). */
interface RawPgPool {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  /** The real `pg.Pool` exposes this; closes all sockets in the pool. */
  end(): Promise<void>;
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
  deps: { createPool?: (cs: string) => Promise<RawPgPool> } = {},
): IPgPool & { end(): Promise<void> } {
  assertSafeTable(table);
  const create = deps.createPool ?? createRawPool;
  let poolPromise: Promise<RawPgPool> | undefined;
  let ensured: Promise<void> | undefined;
  // The real `pg.Pool` throws on a second `.end()`. Overlapping cleanup paths
  // (initSkillHost on failure + the start() finally + closeFns) may all reach
  // here, so guard so a second end() is a no-op rather than a throw.
  let ended = false;

  const getPool = (): Promise<RawPgPool> => {
    if (!poolPromise) poolPromise = create(connectionString);
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
      // A query after end() is a programming error: getPool() would lazily build a
      // BRAND-NEW pool that the (now no-op) end() can never close → socket leak.
      // Fail loud instead of silently reopening an unclosable pool.
      if (ended) throw new Error('pg pool is closed (query after end())');
      const pool = await getPool();
      await ensureTable(pool);
      const res = await pool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
    // Close the real pool so its sockets do not outlive server shutdown.
    // AWAIT `poolPromise` (not a `createdPool` snapshot): if creation is still
    // IN FLIGHT when end() is called, we wait for it and close the resulting
    // pool — otherwise a pool that finishes creating after end() would leak.
    // Idempotent: a second end() is a no-op (the raw pg.Pool throws on double-end).
    async end() {
      if (ended) return;
      ended = true;
      if (poolPromise) {
        const pool = await poolPromise.catch(() => undefined);
        if (pool) await pool.end();
      }
    },
  };
}

/**
 * Build a READ-ONLY {@link IPgPool} backed by a real `pg.Pool`. Identical lazy
 * dynamic-`import('pg')` Pool construction as {@link makePgPool}, but it NEVER
 * runs DDL (no `CREATE TABLE`). A recall-only process configured with READ-ONLY
 * pg credentials uses THIS pool so it does not crash attempting to create the
 * catalog table it only ever reads.
 *
 * @param connectionString libpq connection string.
 */
export function makePgReadPool(
  connectionString: string,
  deps: { createPool?: (cs: string) => Promise<RawPgPool> } = {},
): IPgPool & { end(): Promise<void> } {
  const create = deps.createPool ?? createRawPool;
  let poolPromise: Promise<RawPgPool> | undefined;
  // The real `pg.Pool` throws on a second `.end()`; guard for idempotency.
  let ended = false;

  const getPool = (): Promise<RawPgPool> => {
    if (!poolPromise) poolPromise = create(connectionString);
    return poolPromise;
  };

  return {
    async query(sql: string, params?: unknown[]) {
      // A query after end() is a programming error: getPool() would lazily build a
      // BRAND-NEW pool that the (now no-op) end() can never close → socket leak.
      // Fail loud instead of silently reopening an unclosable pool.
      if (ended) throw new Error('pg pool is closed (query after end())');
      const pool = await getPool();
      const res = await pool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    },
    // Close the pool, awaiting an IN-FLIGHT creation (see makePgPool.end). A pool
    // that finishes creating after end() must still be closed, not leaked.
    // Idempotent: a second end() is a no-op (the raw pg.Pool throws on double-end).
    async end() {
      if (ended) return;
      ended = true;
      if (poolPromise) {
        const pool = await poolPromise.catch(() => undefined);
        if (pool) await pool.end();
      }
    },
  };
}
