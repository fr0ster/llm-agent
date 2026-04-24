import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertCollectionName,
  createTableSql,
  dropTableSql,
  quoteIdent,
} from '../schema.js';

describe('hana schema', () => {
  it('accepts a safe collection name', () => {
    assertCollectionName('llm_agent_docs_2');
  });
  it('rejects collection name starting with digit', () => {
    assert.throws(
      () => assertCollectionName('1bad'),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_COLLECTION_NAME',
    );
  });
  it('rejects collection name with special chars', () => {
    assert.throws(
      () => assertCollectionName("x'); DROP"),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_COLLECTION_NAME',
    );
  });
  it('rejects names longer than 63 chars', () => {
    assert.throws(
      () => assertCollectionName('a'.repeat(64)),
      (err: Error & { code?: string }) =>
        err.code === 'INVALID_COLLECTION_NAME',
    );
  });

  it('quotes HANA identifiers', () => {
    assert.equal(quoteIdent('llm_docs'), '"llm_docs"');
  });

  it('emits CREATE TABLE DDL with REAL_VECTOR and NCLOB', () => {
    const sql = createTableSql('llm_docs', 1536);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "llm_docs"/);
    assert.match(sql, /REAL_VECTOR\(1536\)/);
    assert.match(sql, /metadata NCLOB/);
  });

  it('emits DROP TABLE DDL', () => {
    assert.equal(dropTableSql('llm_docs'), 'DROP TABLE "llm_docs"');
  });
});
