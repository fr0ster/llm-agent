import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type IRag, RagError, type RagResult } from '@mcp-abap-adt/llm-agent';
import {
  makeRag,
  ownedTestStores,
  testCallOptions,
  testRequestAccess,
} from '../../../testing/index.js';
import { RagSkillRetriever } from '../rag-skill-retriever.js';

const request = {
  text: 'Read the record',
  candidates: [
    { name: 'review', description: 'Review records' },
    { name: 'read', description: 'Read records' },
  ],
};

function record(id: string): RagResult {
  return { text: id, metadata: { id, ownerScope: 'global' }, score: 1 };
}

test('uses skill IDs from all preloaded stores and keeps catalogue order', async () => {
  const store = makeRag();
  const retriever = new RagSkillRetriever({
    ragStores: ownedTestStores({ tools: store }),
  });
  const result = await retriever.retrieve({
    ...request,
    ragResults: {
      tools: [record('tool:review'), record('skill:read')],
      knowledge: [
        record('skill:missing'),
        record('skill:review'),
        record('skill:read'),
      ],
    },
  });
  assert.deepEqual(result, { ok: true, value: { names: ['review', 'read'] } });
  assert.equal(store.queryCount, 0);
});

test('queries every store when preloaded records have no skill IDs, with the same k, text and diagnostics', async () => {
  const calls: Array<{ store: string; text: string; k: number }> = [];
  function spyStore(name: string, ids: string[]): IRag {
    return {
      ...makeRag(),
      async query({ text }, k = 0) {
        calls.push({ store: name, text, k });
        return { ok: true, value: ids.map(record) };
      },
    };
  }
  const log: object[] = [];
  const ragStores = ownedTestStores({
    tools: spyStore('tools', ['tool:review', 'skill:missing']),
    knowledge: spyStore('knowledge', ['skill:read']),
  });
  const retriever = new RagSkillRetriever({
    ragStores,
    ragAccess: testRequestAccess,
    k: 7,
  });
  const result = await retriever.retrieve(
    {
      ...request,
      ragResults: { tools: [record('tool:review')] },
    },
    testCallOptions({
      sessionLogger: {
        logStep(name, data) {
          if (name === 'skill_select_rag_fallback') log.push({ name, data });
        },
      },
    }),
  );
  assert.deepEqual(result, { ok: true, value: { names: ['read'] } });
  assert.deepEqual(calls.map(({ store }) => store).sort(), [
    'knowledge',
    'tools',
  ]);
  for (const call of calls) {
    assert.equal(call.text, request.text);
    assert.equal(call.k, 7);
  }
  assert.deepEqual(log, [
    {
      name: 'skill_select_rag_fallback',
      data: { query: request.text, k: 7, matchedSkills: ['missing', 'read'] },
    },
  ]);
});

test('a stale preloaded match suppresses fallback and an empty search offers no skills', async () => {
  const tools = makeRag();
  const retriever = new RagSkillRetriever({
    ragStores: ownedTestStores({ tools }),
    ragAccess: testRequestAccess,
  });
  const options = testCallOptions();
  const none = { ok: true, value: { names: [] } };
  assert.deepEqual(
    await retriever.retrieve(
      { ...request, ragResults: { tools: [record('skill:stale')] } },
      options,
    ),
    none,
  );
  assert.equal(tools.queryCount, 0);
  assert.deepEqual(await retriever.retrieve(request, options), none);
  assert.equal(tools.queryCount, 1);
});

test('returns the fallback query failure unchanged', async () => {
  const error = new RagError('Query failed');
  const store: IRag = {
    ...makeRag(),
    async query() {
      return { ok: false, error };
    },
  };
  const retriever = new RagSkillRetriever({
    ragStores: ownedTestStores({ tools: store }),
    ragAccess: testRequestAccess,
  });
  const result = await retriever.retrieve(request, testCallOptions());
  assert.equal(result.ok, false);
  assert.equal(result.error, error);
});
