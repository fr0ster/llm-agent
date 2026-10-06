/** Spec §9.3, D71: a failed rerank fails the request — stage and legacy orchestrator. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRag,
  type IReranker,
  RagError,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { makeDefaultDeps, makeReranker } from '../../../testing/index.js';
import { DefaultPipeline } from '../../default-pipeline.js';

const hit: RagResult = { text: 'alpha', metadata: { id: 'a' }, score: 0.9 };
const kb = {
  async query() {
    return { ok: true as const, value: [hit] };
  },
  async healthCheck() {
    return { ok: true as const, value: undefined };
  },
} as unknown as IRag;
const failing: IReranker = {
  rerank: async () => ({
    ok: false,
    error: new RagError('HTTP 401', 'DECISION_AUTH'),
  }),
};

describe('rerank failure at the consumer', () => {
  it('the rerank stage (DefaultPipeline) → RERANK_ERROR; the rerank_error step stays', async () => {
    const steps: string[] = [];
    const { deps } = makeDefaultDeps({
      ragStores: { kb },
      reranker: makeReranker(failing),
    });
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      ...deps,
      agentConfig: { maxIterations: 3 },
    } as never);
    const agent = new SmartAgent({ ...deps, pipeline }, { maxIterations: 3 });
    const r = await agent.process('what is alpha?', {
      sessionLogger: { logStep: (n: string) => steps.push(n) },
    } as never);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
    assert.ok(steps.includes('rerank_error'));
  });

  it('the legacy orchestrator (no pipeline) → RERANK_ERROR', async () => {
    const { deps } = makeDefaultDeps({
      ragStores: { kb },
      reranker: makeReranker(failing),
    });
    const r = await new SmartAgent(deps, { maxIterations: 3 }).process(
      'what is alpha?',
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
  });
});
