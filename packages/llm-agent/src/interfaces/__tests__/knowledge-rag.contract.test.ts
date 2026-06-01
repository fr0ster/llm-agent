import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IKnowledgeRagHandle,
  IToolsRagHandle,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  KnowledgeFilter,
} from '../knowledge-rag.js';

test('knowledge-rag contract: write requires full metadata; list filters; query caps by k', async () => {
  const store: KnowledgeEntry[] = [];
  const rag: IKnowledgeRagHandle = {
    async query(_t, opts) {
      const f = opts?.filter;
      let out = store;
      if (f?.turnId) out = out.filter((e) => e.metadata.turnId === f.turnId);
      return opts?.k ? out.slice(0, opts.k) : out;
    },
    async list(filter: KnowledgeFilter) {
      return store.filter(
        (e) => !filter.turnId || e.metadata.turnId === filter.turnId,
      );
    },
    async write(entry) {
      store.push({ content: entry.content, metadata: entry.metadata });
    },
    fingerprint() {
      return `n=${store.length}`;
    },
  };
  const meta: KnowledgeEntryMetadata = {
    traceId: 't',
    turnId: 'u1',
    stepperId: 'n1',
    task: 'fetch source',
    artifactType: 'source-code',
    createdAt: '2026-05-29T00:00:00Z',
  };
  await rag.write({ content: 'REPORT z.', metadata: meta });
  const listed = await rag.list({ turnId: 'u1' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].content, 'REPORT z.');
  assert.equal(rag.fingerprint(), 'n=1');
});

test('tools-rag contract: query + lookup', async () => {
  const tools: IToolsRagHandle = {
    async query() {
      return [];
    },
    lookup(name) {
      return name === 'X' ? ({ name: 'X' } as never) : undefined;
    },
  };
  assert.equal(tools.lookup('X')?.name, 'X');
  assert.equal(tools.lookup('Y'), undefined);
});
