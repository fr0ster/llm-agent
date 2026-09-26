import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type IEmbedder, staticLogin } from '@mcp-abap-adt/llm-agent';
import { makeRag } from '@mcp-abap-adt/llm-agent-rag';

/**
 * HanaVectorRag and PgVectorRag create a `clientPromise` in their constructor
 * that imports the native driver; in a test environment that rejects in the
 * background. Only the sync shape (`ensureSchema` is a function) is verified,
 * so those expected background rejections are absorbed for this block.
 */
function suppressDriverInitErrors(_reason: unknown) {
  /* intentionally absorbed — background driver-init failure is expected */
}

const embedder: IEmbedder = {
  async embed() {
    return { vector: [0, 0, 0] };
  },
};

describe('hana-vector / pg-vector server integration', () => {
  before(() => {
    process.on('unhandledRejection', suppressDriverInitErrors);
  });
  after(() => {
    process.off('unhandledRejection', suppressDriverInitErrors);
  });

  it('makeRag exposes ensureSchema() for hana-vector', async () => {
    const rag = (await makeRag({
      type: 'hana-vector',
      embedder,
      host: 'h',
      credential: staticLogin('u', 'p'),
      collectionName: 'direct_docs',
      dimension: 3,
      autoCreateSchema: true,
    })) as unknown as { ensureSchema: () => Promise<void> };
    assert.equal(typeof rag.ensureSchema, 'function');
  });

  it('makeRag exposes ensureSchema() for pg-vector', async () => {
    const rag = (await makeRag({
      type: 'pg-vector',
      embedder,
      host: 'h',
      database: 'd',
      credential: staticLogin('u', 'p'),
      collectionName: 'direct_docs',
      dimension: 3,
      autoCreateSchema: true,
    })) as unknown as { ensureSchema: () => Promise<void> };
    assert.equal(typeof rag.ensureSchema, 'function');
  });
});
