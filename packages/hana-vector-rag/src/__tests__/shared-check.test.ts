import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HanaClient } from '../hana-vector-rag.js';
import { checkSharedTables } from '../shared-check.js';

type Recorded = Array<{ sql: string; params: readonly unknown[] }>;

function client(opts: {
  tables: string[];
  dim?: number;
  sqls?: Recorded;
}): HanaClient {
  return {
    exec: async () => ({ rowCount: 0 }),
    close: async () => {},
    query: async (sql, params = []) => {
      opts.sqls?.push({ sql, params });
      if (sql.includes('SYS.TABLES')) {
        const table = String(params[params.length - 1]);
        return [{ n: opts.tables.includes(table) ? 1 : 0 }];
      }
      if (sql.includes('SYS.TABLE_COLUMNS'))
        return opts.dim === undefined ? [] : [{ dim: opts.dim }];
      throw new Error(`unexpected: ${sql}`);
    },
  };
}

const base = { documentsTable: 'RAG_DOCUMENTS', dimension: 1536 };

describe('checkSharedTables', () => {
  it('passes when the tables exist with the configured dimension', async () => {
    const r = await checkSharedTables(
      client({ tables: ['RAG_DOCUMENTS'], dim: 1536 }),
      { ...base, tables: ['RAG_DOCUMENTS'] },
    );
    assert.equal(r.ok, true);
  });

  it('a missing table is SHARED_LAYOUT_NOT_DEPLOYED and names it', async () => {
    const r = await checkSharedTables(
      client({ tables: ['RAG_DOCUMENTS'], dim: 1536 }),
      { ...base, tables: ['RAG_DOCUMENTS', 'RAG_COLLECTIONS'] },
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.match(r.error.message, /RAG_COLLECTIONS/);
    assert.match(r.error.message, /ddl\/|sharedLayoutSql/);
  });

  it('a dimension mismatch names both dimensions', async () => {
    const r = await checkSharedTables(
      client({ tables: ['RAG_DOCUMENTS'], dim: 768 }),
      { ...base, tables: ['RAG_DOCUMENTS'] },
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.match(r.error.message, /768/);
    assert.match(r.error.message, /1536/);
  });

  it('uses the explicit schema, else CURRENT_SCHEMA; sends only SELECTs', async () => {
    const sqls: Recorded = [];
    await checkSharedTables(
      client({ tables: ['RAG_DOCUMENTS'], dim: 1536, sqls }),
      { ...base, tables: ['RAG_DOCUMENTS'], schema: 'S1' },
    );
    assert.deepEqual(sqls[0].params, ['S1', 'RAG_DOCUMENTS']);
    assert.ok(sqls.every((s) => /^SELECT/.test(s.sql)));
    const sqls2: Recorded = [];
    await checkSharedTables(
      client({ tables: ['RAG_DOCUMENTS'], dim: 1536, sqls: sqls2 }),
      { ...base, tables: ['RAG_DOCUMENTS'] },
    );
    assert.ok(sqls2.every((s) => s.sql.includes('CURRENT_SCHEMA')));
    assert.deepEqual(sqls2[0].params, ['RAG_DOCUMENTS']);
  });
});
