import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';
import { makeKnowledgeBackend } from '../knowledge/make-knowledge-backend.js';

test('no logDir → InMemoryKnowledgeBackend', () => {
  const backend = makeKnowledgeBackend({
    logDir: undefined,
    embedder: undefined,
  });
  assert.ok(backend instanceof InMemoryKnowledgeBackend);
});

test('logDir set → JsonlKnowledgeBackend', () => {
  const backend = makeKnowledgeBackend({
    logDir: '/tmp/kb-test',
    embedder: undefined,
  });
  assert.ok(backend instanceof JsonlKnowledgeBackend);
});

test('embedder present → semantic index attached (in-memory path stays in-memory)', () => {
  const fakeEmbedder = {
    embed: async () => ({ ok: true as const, value: [0] }),
    dimensions: 1,
  } as unknown as Parameters<typeof makeKnowledgeBackend>[0]['embedder'];
  const backend = makeKnowledgeBackend({
    logDir: undefined,
    embedder: fakeEmbedder,
  });
  assert.ok(backend instanceof InMemoryKnowledgeBackend);
});
