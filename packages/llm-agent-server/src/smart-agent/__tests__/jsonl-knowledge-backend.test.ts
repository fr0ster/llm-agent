import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { KnowledgeEntry } from '@mcp-abap-adt/llm-agent';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';

const TEST_DIR = join(tmpdir(), `stepper-jsonl-test-${process.pid}`);

function makeEntry(id: string, content: string): KnowledgeEntry {
  return {
    content,
    metadata: {
      traceId: 'trace1',
      turnId: `turn-${id}`,
      stepperId: 'stepper1',
      task: 'test-task',
      artifactType: 'tool-result',
      createdAt: '2026-05-29T00:00:00Z',
    },
  };
}

test('put persists entries; fresh instance scan() returns them (cross-restart durability)', async () => {
  await rm(TEST_DIR, { recursive: true, force: true });

  const backend1 = new JsonlKnowledgeBackend(TEST_DIR);
  await backend1.put('sess1', makeEntry('e1', 'hello world'));
  await backend1.put('sess1', makeEntry('e2', 'foo bar'));

  // Fresh instance over same directory — simulates process restart
  const backend2 = new JsonlKnowledgeBackend(TEST_DIR);
  const entries = await backend2.scan('sess1');

  assert.equal(entries.length, 2);
  assert.equal(entries[0].content, 'hello world');
  assert.equal(entries[0].metadata.turnId, 'turn-e1');
  assert.equal(entries[1].content, 'foo bar');
  assert.equal(entries[1].metadata.turnId, 'turn-e2');
});

test('scan returns [] for unknown session (ENOENT)', async () => {
  const backend = new JsonlKnowledgeBackend(TEST_DIR);
  const entries = await backend.scan('no-such-session');
  assert.deepEqual(entries, []);
});

test('semanticQuery falls back to recency when no semantic index', async () => {
  await rm(TEST_DIR, { recursive: true, force: true });

  const backend = new JsonlKnowledgeBackend(TEST_DIR);
  for (let i = 0; i < 5; i++) {
    await backend.put('sess2', makeEntry(`e${i}`, `entry ${i}`));
  }

  const result = await backend.semanticQuery('sess2', 'some text', 3);
  assert.equal(result.length, 3);
  // recency = last k entries
  assert.equal(result[0].content, 'entry 2');
  assert.equal(result[1].content, 'entry 3');
  assert.equal(result[2].content, 'entry 4');
});

test('deleteSession removes the session directory; scan() then returns [] and other sessions survive', async () => {
  await rm(TEST_DIR, { recursive: true, force: true });

  const backend = new JsonlKnowledgeBackend(TEST_DIR);
  await backend.put('sess-del', makeEntry('a', 'to be deleted'));
  await backend.put('sess-keep', makeEntry('b', 'keep me'));
  assert.equal((await backend.scan('sess-del')).length, 1);

  await backend.deleteSession('sess-del');

  // Deleted session is gone — a fresh instance (cross-restart) also sees nothing.
  assert.deepEqual(await backend.scan('sess-del'), []);
  assert.deepEqual(
    await new JsonlKnowledgeBackend(TEST_DIR).scan('sess-del'),
    [],
  );
  // Sibling session is untouched.
  assert.equal((await backend.scan('sess-keep')).length, 1);
});

test('deleteSession on an unknown session is a no-op (no throw)', async () => {
  const backend = new JsonlKnowledgeBackend(TEST_DIR);
  await backend.deleteSession('never-existed'); // must not throw (force: true)
});

test('cleanup temp dir', async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});
