import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import type { HanaClient } from '../hana-vector-rag.js';
import { HanaVectorRag } from '../hana-vector-rag.js';
import {
  INVALID_CONFIG,
  INVALID_VECTOR,
  SHARED_LAYOUT_NOT_DEPLOYED,
} from '../index.js';
import { checkSharedTables } from '../shared-check.js';
import { hanaVectorLiteral } from '../vector-literal.js';

const client: HanaClient = {
  exec: async () => ({ rowCount: 0 }),
  close: async () => {},
  query: async () => [{ n: 0 }],
};

describe('exported error codes (hana)', () => {
  it('have the documented values', () => {
    assert.equal(SHARED_LAYOUT_NOT_DEPLOYED, 'SHARED_LAYOUT_NOT_DEPLOYED');
    assert.equal(INVALID_CONFIG, 'INVALID_CONFIG');
    assert.equal(INVALID_VECTOR, 'INVALID_VECTOR');
  });

  it('SHARED_LAYOUT_NOT_DEPLOYED is the code of a failed shared check', async () => {
    const r = await checkSharedTables(client, {
      tables: ['RAG_DOCUMENTS'],
      documentsTable: 'RAG_DOCUMENTS',
      dimension: 3,
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, SHARED_LAYOUT_NOT_DEPLOYED);
  });

  it('INVALID_CONFIG is the code of a refused configuration', () => {
    assert.throws(
      () =>
        new HanaVectorRag(
          {
            collectionName: 'c',
            host: 'h',
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
      () => hanaVectorLiteral([1, 2], 3),
      (e: { code?: string }) => e.code === INVALID_VECTOR,
    );
    assert.throws(
      () => hanaVectorLiteral([Number.NaN]),
      (e: { code?: string }) => e.code === INVALID_VECTOR,
    );
  });
});
