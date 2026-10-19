import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  INVALID_CONFIG,
  INVALID_VECTOR,
  SHARED_LAYOUT_NOT_DEPLOYED,
} from '../index.js';
import type { PgClient } from '../pg-vector-rag.js';
import { PgVectorRag } from '../pg-vector-rag.js';
import { checkSharedTables } from '../shared-check.js';
import { pgVectorLiteral } from '../vector-literal.js';

const client: PgClient = {
  end: async () => {},
  query: async () => ({ rows: [{ present: false }], rowCount: 1 }),
};

describe('exported error codes (pg)', () => {
  it('have the documented values', () => {
    assert.equal(SHARED_LAYOUT_NOT_DEPLOYED, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.equal(INVALID_CONFIG, 'INVALID_CONFIG');
    assert.equal(INVALID_VECTOR, 'INVALID_VECTOR');
  });

  it('SHARED_LAYOUT_NOT_DEPLOYED is the code of a failed shared check', async () => {
    const r = await checkSharedTables(client, {
      tables: ['rag_documents'],
      documentsTable: 'rag_documents',
      dimension: 3,
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, SHARED_LAYOUT_NOT_DEPLOYED);
  });

  it('INVALID_CONFIG is the code of a refused configuration', () => {
    assert.throws(
      () =>
        new PgVectorRag(
          {
            collectionName: 'c',

            credential: staticLogin('u', 'p'),
            embedder: symmetricEmbedder({
              embed: async () => ({ vector: [0] }),
            }),
            layout: 'nope' as never,
          },
          client,
        ),
      (e: { code?: string }) => e.code === INVALID_CONFIG,
    );
  });

  it('INVALID_VECTOR is the code of a refused vector', () => {
    assert.throws(
      () => pgVectorLiteral([1, 2], 3),
      (e: { code?: string }) => e.code === INVALID_VECTOR,
    );
    assert.throws(
      () => pgVectorLiteral([Number.NaN]),
      (e: { code?: string }) => e.code === INVALID_VECTOR,
    );
  });
});
