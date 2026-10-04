import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IReranker } from '@mcp-abap-adt/llm-agent';
import { resolveReranker } from '../resolve-reranker.js';

const plugin: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };

describe('resolveReranker', () => {
  it('no plugin → undefined', async () => {
    assert.equal(await resolveReranker({}), undefined);
  });

  it('a plugin reranker → it', async () => {
    assert.equal(await resolveReranker({ pluginReranker: plugin }), plugin);
  });
});
