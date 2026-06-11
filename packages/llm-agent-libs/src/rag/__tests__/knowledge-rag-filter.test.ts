import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KnowledgeEntryMetadata } from '@mcp-abap-adt/llm-agent';
import { InMemoryKnowledgeBackend, KnowledgeRag } from '../knowledge-rag.js';

const meta = (over: Partial<KnowledgeEntryMetadata>): KnowledgeEntryMetadata => ({
  traceId: 't',
  turnId: 't',
  stepperId: 'controller',
  task: 'x',
  artifactType: 'step-result',
  createdAt: '2026-06-10T00:00:00.000Z',
  ...over,
});

describe('knowledge filter by runId/seq/attempt/status', () => {
  it('list() matches on runId+seq+attempt+status equality', async () => {
    const be = new InMemoryKnowledgeBackend();
    const rag = new KnowledgeRag(be, 's1');
    await rag.write({
      content: 'a',
      metadata: meta({ runId: 'R1', seq: 0, attempt: 0, status: 'failed' }),
    });
    await rag.write({
      content: 'b',
      metadata: meta({ runId: 'R1', seq: 0, attempt: 1, status: 'ok' }),
    });
    await rag.write({
      content: 'c',
      metadata: meta({ runId: 'R2', seq: 0, attempt: 0, status: 'ok' }),
    });

    const r1seq0 = await rag.list({ runId: 'R1', seq: 0 });
    assert.equal(r1seq0.length, 2);
    const r1seq0att1 = await rag.list({ runId: 'R1', seq: 0, attempt: 1 });
    assert.equal(r1seq0att1.length, 1);
    assert.equal(r1seq0att1[0].content, 'b');
    const oks = await rag.list({ runId: 'R1', status: 'ok' });
    assert.equal(oks.length, 1);
    assert.equal(oks[0].content, 'b');
  });

  it('query() applies the runId filter pre-cap (foreign-run hits never crowd k)', async () => {
    const be = new InMemoryKnowledgeBackend();
    const rag = new KnowledgeRag(be, 's2');
    // k+2 foreign-run entries written first, then one target-run entry.
    for (let i = 0; i < 5; i++) {
      await rag.write({
        content: `other${i}`,
        metadata: meta({ runId: 'OTHER', seq: i }),
      });
    }
    await rag.write({
      content: 'target',
      metadata: meta({ runId: 'R-target', seq: 0 }),
    });
    const hits = await rag.query('x', { k: 3, filter: { runId: 'R-target' } });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, 'target');
  });
});
