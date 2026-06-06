import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeArtifact } from '../memorizer.js';

describe('writeArtifact', () => {
  it('writes content with artifact metadata to the rag handle', async () => {
    const writes: unknown[] = [];
    const rag = {
      write: async (e: unknown) => {
        writes.push(e);
      },
      query: async () => [],
    } as never;

    await writeArtifact(rag, {
      traceId: 'trace-1',
      turnId: 'turn-1',
      stepperId: 'stepper-1',
      task: 'ZTEST',
      artifactType: 'code',
      toolName: 'GetProgram',
      createdAt: '2026-06-06T00:00:00.000Z',
      content: 'REPORT ztest.',
    });

    assert.equal(writes.length, 1);
    assert.deepEqual((writes[0] as { metadata: unknown }).metadata, {
      traceId: 'trace-1',
      turnId: 'turn-1',
      stepperId: 'stepper-1',
      task: 'ZTEST',
      artifactType: 'code',
      toolName: 'GetProgram',
      createdAt: '2026-06-06T00:00:00.000Z',
    });
    assert.equal((writes[0] as { content: string }).content, 'REPORT ztest.');
  });
});
