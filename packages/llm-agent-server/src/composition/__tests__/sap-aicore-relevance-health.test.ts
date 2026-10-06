/**
 * Spec §17.43 D97, end to end through the published packages: a
 * `RelevanceReranker` over `SapAiCoreRelevanceDecision`, wrapped as the server
 * wraps a decision (`wrapRelevanceDecision`), checks its health with the AI
 * Core deployment's status — no `score`, no `/rerank` call.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapRelevanceDecision } from '@mcp-abap-adt/llm-agent-libs';
import { RelevanceReranker } from '@mcp-abap-adt/llm-agent-reranker';
import { SapAiCoreRelevanceDecision } from '@mcp-abap-adt/sap-aicore-decision';

function harness(status: string) {
  const urls: string[] = [];
  const decision = new SapAiCoreRelevanceDecision({
    deploymentId: 'd1',
    model: 'cohere-rerank',
    apiBaseUrl: 'https://api.example',
    credential: { kind: 'bearer', token: async () => 't' },
    fetch: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ id: 'd1', status }), {
        status: 200,
      });
    },
  });
  let scoreCalls = 0;
  const score = decision.score.bind(decision);
  decision.score = (...args) => {
    scoreCalls++;
    return score(...args);
  };
  const reranker = new RelevanceReranker(wrapRelevanceDecision(decision));
  return { reranker, urls, scoreCalls: () => scoreCalls };
}

describe('RelevanceReranker(wrapRelevanceDecision(SapAiCoreRelevanceDecision)).healthCheck', () => {
  it('RUNNING → ok(true) from the deployment GET; score is never called', async () => {
    const h = harness('RUNNING');
    assert.deepEqual(await h.reranker.healthCheck(), { ok: true, value: true });
    assert.deepEqual(h.urls, ['https://api.example/v2/lm/deployments/d1']);
    assert.equal(h.scoreCalls(), 0);
  });
  it('STOPPED → ok(false); still no score and no /rerank', async () => {
    const h = harness('STOPPED');
    assert.deepEqual(await h.reranker.healthCheck(), {
      ok: true,
      value: false,
    });
    assert.deepEqual(h.urls, ['https://api.example/v2/lm/deployments/d1']);
    assert.equal(h.scoreCalls(), 0);
  });
});
