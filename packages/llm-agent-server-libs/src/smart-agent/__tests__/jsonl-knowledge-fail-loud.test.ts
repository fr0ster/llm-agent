/**
 * Spec §10.5.4 R10 — JsonlKnowledgeBackend fails loud: an embedding failure
 * rejects `build()` (via the call that triggers it) and `put()` with
 * UPSERT_ERROR, and the session is not marked built — never a skipped entry.
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { KnowledgeEntry } from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import { JsonlKnowledgeBackend } from '../jsonl-knowledge-backend.js';

const TEST_DIR = join(tmpdir(), `jsonl-fail-loud-${process.pid}`);

function entry(id: string, content: string): KnowledgeEntry {
  return {
    content,
    metadata: {
      traceId: 't',
      turnId: `turn-${id}`,
      stepperId: 's',
      task: 'task',
      artifactType: 'tool-result',
      createdAt: '2026-10-06T00:00:00Z',
    },
  };
}

/** A semantic index whose upsert throws for content `BOOM`, or always when `down`. */
function semanticIndex() {
  const state = { down: false, indexed: [] as string[], deletes: 0 };
  const index = {
    async upsert(_sid: string, e: KnowledgeEntry) {
      if (state.down || e.content === 'BOOM') throw new Error('embed rejected');
      state.indexed.push(e.content);
    },
    async query() {
      return [] as readonly KnowledgeEntry[];
    },
    deleteSession() {
      state.deletes++;
      state.indexed.length = 0;
    },
  };
  return { state, index };
}

function isUpsertError(re: RegExp) {
  return (e: unknown) => {
    assert.ok(e instanceof RagError);
    assert.equal(e.code, 'UPSERT_ERROR');
    assert.match(e.message, re);
    return true;
  };
}

after(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('R10 JsonlKnowledgeBackend — an embedding failure is UPSERT_ERROR', () => {
  it('the lazy rebuild rejects on the first failing entry; the session is not marked built', async () => {
    const sid = 'rebuild';
    const seed = new JsonlKnowledgeBackend(TEST_DIR);
    await seed.put(sid, entry('a', 'alpha'));
    await seed.put(sid, entry('bad', 'BOOM'));
    await seed.put(sid, entry('b', 'beta'));

    const { state, index } = semanticIndex();
    const backend = new JsonlKnowledgeBackend(TEST_DIR, index as never);
    await assert.rejects(
      backend.semanticQuery(sid, 'q'),
      isUpsertError(/rebuild failed: .*embed rejected/),
    );
    // Not marked built: the next touch rebuilds again (and fails again).
    await assert.rejects(
      backend.semanticQuery(sid, 'q'),
      isUpsertError(/rebuild failed/),
    );
    assert.equal(state.deletes, 2, 'the rebuild ran again');
  });

  it('put() rejects when the new entry cannot be indexed; it is durably written; the next touch rebuilds', async () => {
    const sid = 'put';
    const { state, index } = semanticIndex();
    const backend = new JsonlKnowledgeBackend(TEST_DIR, index as never);
    await backend.put(sid, entry('a', 'alpha'));
    assert.equal(state.deletes, 1, 'first touch built the (empty) session');

    state.down = true;
    await assert.rejects(
      backend.put(sid, entry('b', 'beta')),
      isUpsertError(/written but not indexed: .*embed rejected/),
    );
    const durable = await backend.scan(sid);
    assert.deepEqual(
      durable.map((e) => e.content),
      ['alpha', 'beta'],
    );

    // Not built any more: once the embedder works, the next touch re-syncs.
    state.down = false;
    await backend.semanticQuery(sid, 'q');
    assert.equal(state.deletes, 2, 'rebuilt from the durable JSONL');
    assert.deepEqual(state.indexed, ['alpha', 'beta']);
  });

  it('put() rejects when the rebuild before it fails (the entry is not appended)', async () => {
    const sid = 'put-after-bad-rebuild';
    const seed = new JsonlKnowledgeBackend(TEST_DIR);
    await seed.put(sid, entry('bad', 'BOOM'));
    const { index } = semanticIndex();
    const backend = new JsonlKnowledgeBackend(TEST_DIR, index as never);
    await assert.rejects(
      backend.put(sid, entry('c', 'gamma')),
      isUpsertError(/rebuild failed/),
    );
    assert.deepEqual(
      (await backend.scan(sid)).map((e) => e.content),
      ['BOOM'],
    );
  });
});
