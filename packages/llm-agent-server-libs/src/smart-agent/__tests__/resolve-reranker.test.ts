import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IDecisionModel, IReranker } from '@mcp-abap-adt/llm-agent';
import { DecisionReranker } from '@mcp-abap-adt/llm-agent-libs';
import { resolveReranker } from '../resolve-reranker.js';

const fakeModel: IDecisionModel = {
  decide: async () => ({
    ok: true,
    value: { model: 'f', answers: { r0: { type: 'noul', probability: 1 } } },
  }),
};
const plugin: IReranker = { rerank: async (_q, r) => ({ ok: true, value: r }) };

describe('resolveReranker', () => {
  it('neither → undefined', async () => {
    assert.equal(await resolveReranker({}), undefined);
  });

  it('only a plugin reranker → it', async () => {
    assert.equal(await resolveReranker({ pluginReranker: plugin }), plugin);
  });

  it('reranker.type: decision → a DecisionReranker over the seam, built once', async () => {
    const seen: unknown[] = [];
    const r = await resolveReranker({
      rerankerCfg: { type: 'decision' },
      decisionCfg: { provider: 'typesafe', model: 'jev-latest' },
      makeDecisionModel: async (cfg) => {
        seen.push(cfg);
        return fakeModel;
      },
    });
    assert.ok(r instanceof DecisionReranker);
    assert.deepEqual(seen, [{ provider: 'typesafe', model: 'jev-latest' }]);
  });

  it('YAML reranker and a plugin reranker → error', async () => {
    await assert.rejects(
      resolveReranker({
        rerankerCfg: { type: 'decision' },
        decisionCfg: { provider: 'typesafe' },
        makeDecisionModel: async () => fakeModel,
        pluginReranker: plugin,
      }),
      /reranker: .* and a plugin reranker/,
    );
  });

  it('decision configured but no seam → error naming the seam', async () => {
    await assert.rejects(
      resolveReranker({
        rerankerCfg: { type: 'decision' },
        decisionCfg: { provider: 'typesafe' },
      }),
      /BuildAgentDeps\.makeDecisionModel/,
    );
  });

  it('a decision: section alone builds nothing', async () => {
    let built = false;
    const r = await resolveReranker({
      decisionCfg: { provider: 'typesafe' },
      makeDecisionModel: async () => {
        built = true;
        return fakeModel;
      },
    });
    assert.equal(r, undefined);
    assert.equal(built, false);
  });
});
