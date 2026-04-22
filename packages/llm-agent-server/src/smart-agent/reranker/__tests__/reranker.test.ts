import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RagResult } from '@mcp-abap-adt/llm-agent';
import { makeLlm } from '../../testing/index.js';
import { LlmReranker } from '../llm-reranker.js';
import { NoopReranker } from '../noop-reranker.js';

const sampleResults: RagResult[] = [
  { text: 'ABAP syntax for SELECT', metadata: {}, score: 0.8 },
  { text: 'JavaScript array methods', metadata: {}, score: 0.7 },
  { text: 'ABAP internal tables LOOP', metadata: {}, score: 0.6 },
];

describe('NoopReranker', () => {
  it('returns results unchanged', async () => {
    const reranker = new NoopReranker();
    const result = await reranker.rerank('ABAP query', sampleResults);
    assert.ok(result.ok);
    assert.deepEqual(result.value, sampleResults);
  });

  it('handles empty results', async () => {
    const reranker = new NoopReranker();
    const result = await reranker.rerank('test', []);
    assert.ok(result.ok);
    assert.equal(result.value.length, 0);
  });
});

describe('LlmReranker', () => {
  it('reranks results based on LLM scores', async () => {
    const llm = makeLlm([{ content: '[3, 1, 9]' }]);
    const reranker = new LlmReranker(llm);
    const result = await reranker.rerank('ABAP internal tables', sampleResults);
    assert.ok(result.ok);
    assert.equal(result.value.length, 3);
    // Highest score (9/10 = 0.9) should be first
    assert.equal(result.value[0].text, 'ABAP internal tables LOOP');
    assert.equal(result.value[0].score, 0.9);
    // Second (3/10 = 0.3)
    assert.equal(result.value[1].text, 'ABAP syntax for SELECT');
    assert.equal(result.value[1].score, 0.3);
    // Lowest (1/10 = 0.1)
    assert.equal(result.value[2].text, 'JavaScript array methods');
    assert.equal(result.value[2].score, 0.1);
  });

  it('handles empty results without calling LLM', async () => {
    const llm = makeLlm([]);
    const reranker = new LlmReranker(llm);
    const result = await reranker.rerank('test', []);
    assert.ok(result.ok);
    assert.equal(result.value.length, 0);
    assert.equal(llm.callCount, 0);
  });

  it('falls back to original order on unparseable LLM response', async () => {
    const llm = makeLlm([{ content: 'I cannot score these passages.' }]);
    const reranker = new LlmReranker(llm);
    const result = await reranker.rerank('test', sampleResults);
    assert.ok(result.ok);
    assert.equal(result.value.length, 3);
    // Fallback preserves descending index-based order
    assert.equal(result.value[0].text, 'ABAP syntax for SELECT');
  });

  it('returns error when LLM call fails', async () => {
    const llm = makeLlm([new Error('LLM unavailable')]);
    const reranker = new LlmReranker(llm);
    const result = await reranker.rerank('test', sampleResults);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'RERANK_ERROR');
  });

  it('clamps scores to valid range', async () => {
    const llm = makeLlm([{ content: '[15, -2, 5]' }]);
    const reranker = new LlmReranker(llm);
    const result = await reranker.rerank('test', sampleResults);
    assert.ok(result.ok);
    // 15 clamped to 10 → 1.0, -2 clamped to 0 → 0.0, 5 → 0.5
    assert.equal(result.value[0].score, 1.0);
    assert.equal(result.value[1].score, 0.5);
    assert.equal(result.value[2].score, 0.0);
  });
});
