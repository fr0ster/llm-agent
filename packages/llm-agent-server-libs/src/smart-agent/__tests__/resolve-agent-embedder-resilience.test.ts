import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedResult, LogEvent } from '@mcp-abap-adt/llm-agent';
import { getResilienceMetadata } from '@mcp-abap-adt/llm-agent';
import {
  resolveAgentEmbedder,
  resolveToolsStoreEmbedder,
} from '../resolve-agent-embedder.js';

class GeminiLike {
  readonly maxBatchSize = 250;
  async embed(): Promise<IEmbedResult> {
    return { vector: [0] };
  }
  async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
    return texts.map(() => ({ vector: [0] }));
  }
}

describe('SmartServer embedder resilience threading', () => {
  it('keeps the cap through wrapEmbedder and reports no conflict', async () => {
    const events: LogEvent[] = [];
    const logger = { log: (e: LogEvent) => events.push(e) };
    const agentEmbedder = await resolveAgentEmbedder(
      { type: 'qdrant', embedder: 'sap-ai-core' },
      new GeminiLike(),
      {},
      logger,
    );
    assert.ok(agentEmbedder);
    assert.equal(getResilienceMetadata(agentEmbedder)?.maxBatchSize, 250);
    assert.deepEqual(events, []);
  });

  it('warns once when a second store asks for a different cap', async () => {
    const events: LogEvent[] = [];
    const logger = { log: (e: LogEvent) => events.push(e) };
    const shared = await resolveAgentEmbedder(
      { type: 'qdrant', embedder: 'sap-ai-core' },
      new GeminiLike(),
      {},
      logger,
    );
    const reused = await resolveToolsStoreEmbedder(
      shared,
      { type: 'qdrant', embedder: 'sap-ai-core', maxBatchSize: 64 },
      undefined,
      {},
      logger,
    );
    assert.equal(reused, shared);
    assert.ok(reused);
    assert.equal(getResilienceMetadata(reused)?.maxBatchSize, 250);
    // The assertion that actually proves threading: without it the test passes
    // even when the conflict never reaches the resolver.
    assert.equal(events.length, 1);
    assert.match(String((events[0] as { message: string }).message), /250.*64/);
  });
});
