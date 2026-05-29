import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryKnowledgeBackend,
  KnowledgeRag,
  ToolsRag,
} from '../knowledge-rag.js';

const META = {
  traceId: 't',
  turnId: 'u1',
  stepperId: 'n1',
  task: 'fetch',
  artifactType: 'source-code',
  createdAt: '2026-05-29T00:00:00Z',
};

test('write persists with metadata; list filters by turnId exhaustively', async () => {
  const backend = new InMemoryKnowledgeBackend();
  const kr = new KnowledgeRag(backend, 'session-1');
  await kr.write({ content: 'A', metadata: { ...META, turnId: 'u1' } });
  await kr.write({ content: 'B', metadata: { ...META, turnId: 'u2' } });
  const u1 = await kr.list({ turnId: 'u1' });
  assert.equal(u1.length, 1);
  assert.equal(u1[0].content, 'A');
});

test('query caps by k', async () => {
  const backend = new InMemoryKnowledgeBackend();
  const kr = new KnowledgeRag(backend, 'session-1');
  await kr.write({ content: 'A', metadata: META });
  await kr.write({ content: 'B', metadata: META });
  const r = await kr.query('anything', { k: 1 });
  assert.equal(r.length, 1);
});

test('fingerprint changes on write', async () => {
  const backend = new InMemoryKnowledgeBackend();
  const kr = new KnowledgeRag(backend, 'session-1');
  const f0 = kr.fingerprint();
  await kr.write({ content: 'A', metadata: META });
  assert.notEqual(kr.fingerprint(), f0);
});

test('RESUME: a second KnowledgeRag over the SAME backend rehydrates prior entries (H.8 substrate)', async () => {
  // The backend is the persistence boundary; a fresh KnowledgeRag bound to
  // the same session over the same backend must see everything written
  // before "restart". This is what makes session resume work.
  const backend = new InMemoryKnowledgeBackend();
  const first = new KnowledgeRag(backend, 'session-1');
  await first.write({
    content: 'prior source',
    metadata: { ...META, turnId: 'u1' },
  });

  const resumed = new KnowledgeRag(backend, 'session-1'); // simulates server restart
  await resumed.init(); // rehydrate from backend
  const got = await resumed.list({ turnId: 'u1' });
  assert.equal(got.length, 1);
  assert.equal(got[0].content, 'prior source');
});

test('a different session over the same backend does NOT see other session entries', async () => {
  const backend = new InMemoryKnowledgeBackend();
  const a = new KnowledgeRag(backend, 'session-A');
  await a.write({ content: 'A-only', metadata: META });
  const b = new KnowledgeRag(backend, 'session-B');
  await b.init();
  assert.equal((await b.list({})).length, 0);
});

test('ToolsRag delegates query and lookup', async () => {
  const toolsStore = {
    query: async (_text: string, _k?: number) => {
      return [{ name: 'Tool1', description: 'desc' }];
    },
    lookup: (name: string) => {
      return name === 'Tool1'
        ? ({ name: 'Tool1', description: 'desc' } as never)
        : undefined;
    },
  };
  const tr = new ToolsRag(toolsStore);
  const queryResult = await tr.query('test query');
  assert.equal(queryResult.length, 1);
  assert.equal(queryResult[0].name, 'Tool1');
  const lookupResult = tr.lookup('Tool1');
  assert.ok(lookupResult);
  assert.equal(lookupResult.name, 'Tool1');
  const notFound = tr.lookup('NotExist');
  assert.equal(notFound, undefined);
});
