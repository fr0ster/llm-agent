import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PgClient } from '../pg-vector-rag.js';
import { checkSharedTables } from '../shared-check.js';

type Recorded = Array<{ sql: string; params: readonly unknown[] }>;

function client(opts: {
  tables: string[];
  dim?: number;
  sqls?: Recorded;
}): PgClient {
  return {
    end: async () => {},
    query: async (sql, params = []) => {
      opts.sqls?.push({ sql, params });
      if (sql.includes('pg_attribute')) {
        const rows = opts.dim === undefined ? [] : [{ dim: opts.dim }];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('to_regclass')) {
        const name = String(params[0]).split('.').pop()?.replace(/"/g, '');
        return {
          rows: [{ present: opts.tables.includes(String(name)) }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected: ${sql}`);
    },
  };
}

const base = { documentsTable: 'rag_documents', dimension: 1536 };

describe('checkSharedTables', () => {
  it('passes when the tables exist with the configured dimension', async () => {
    const r = await checkSharedTables(
      client({ tables: ['rag_documents'], dim: 1536 }),
      { ...base, tables: ['rag_documents'] },
    );
    assert.equal(r.ok, true);
  });

  it('a missing table is SHARED_LAYOUT_NOT_DEPLOYED and names it', async () => {
    const r = await checkSharedTables(
      client({ tables: ['rag_documents'], dim: 1536 }),
      { ...base, tables: ['rag_documents', 'rag_collections'] },
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.match(r.error.message, /rag_collections/);
    assert.match(r.error.message, /ddl\/|sharedLayoutSql/);
  });

  it('a dimension mismatch names both dimensions', async () => {
    const r = await checkSharedTables(
      client({ tables: ['rag_documents'], dim: 768 }),
      { ...base, tables: ['rag_documents'] },
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.match(r.error.message, /768/);
    assert.match(r.error.message, /1536/);
  });

  it('a documents table without a vector column is a finding', async () => {
    const r = await checkSharedTables(client({ tables: ['rag_documents'] }), {
      ...base,
      tables: ['rag_documents'],
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SHARED_LAYOUT_NOT_DEPLOYED');
  });

  it('a driver exception is HEALTH_CHECK_ERROR, not a layout finding', async () => {
    const broken: PgClient = {
      end: async () => {},
      query: async () => {
        throw new Error('connection reset');
      },
    };
    const r = await checkSharedTables(broken, {
      ...base,
      tables: ['rag_documents'],
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'HEALTH_CHECK_ERROR');
  });

  it('passes the quoted (schema-qualified) name; sends only SELECTs', async () => {
    const sqls: Recorded = [];
    await checkSharedTables(
      client({ tables: ['rag_documents'], dim: 1536, sqls }),
      { ...base, tables: ['rag_documents'], schema: 'S1' },
    );
    assert.deepEqual(sqls[0].params, ['"S1"."rag_documents"']);
    assert.equal(
      sqls[1].sql,
      `SELECT a.atttypmod AS "dim" FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attname = 'vector' AND NOT a.attisdropped`,
    );
    assert.deepEqual(sqls[1].params, ['"S1"."rag_documents"']);
    assert.ok(sqls.every((s) => /^SELECT/.test(s.sql)));
    const sqls2: Recorded = [];
    await checkSharedTables(
      client({ tables: ['rag_documents'], dim: 1536, sqls: sqls2 }),
      { ...base, tables: ['rag_documents'] },
    );
    assert.deepEqual(sqls2[0].params, ['"rag_documents"']);
  });
});
