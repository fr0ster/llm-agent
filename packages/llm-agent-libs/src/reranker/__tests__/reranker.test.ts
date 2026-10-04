import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, RagResult } from '@mcp-abap-adt/llm-agent';
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
  it("uses the model's [0,1] scores and sorts by them", async () => {
    const llm = makeLlm([{ content: '[0.3, 0.1, 0.9]' }]);
    const r = await new LlmReranker(llm).rerank(
      'ABAP internal tables',
      sampleResults,
    );
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.map((x) => x.score),
      [0.9, 0.3, 0.1],
    );
    assert.equal(r.value[0].text, 'ABAP internal tables LOOP');
  });

  it('accepts the array inside one ```json fence', async () => {
    const r = await new LlmReranker(
      makeLlm([{ content: '```json\n[0.3, 0.1, 0.9]\n```' }]),
    ).rerank('q', sampleResults);
    assert.ok(r.ok);
    assert.equal(r.value[0].score, 0.9);
  });

  it('handles empty results without calling LLM', async () => {
    const llm = makeLlm([]);
    const r = await new LlmReranker(llm).rerank('test', []);
    assert.ok(r.ok);
    assert.equal(llm.callCount, 0);
  });

  it('returns error when LLM call fails', async () => {
    const r = await new LlmReranker(
      makeLlm([new Error('LLM unavailable')]),
    ).rerank('test', sampleResults);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'RERANK_ERROR');
  });

  for (const [content, why] of [
    ['I cannot score these passages.', 'prose'],
    ['[0.3, 0.1]', 'wrong length'],
    ['[0.3, 1.2, 0.1]', 'out of range'],
    ['[0.3, "0.5", 0.1]', 'string value'],
    ['[0.3, null, 0.1]', 'null value'],
    [
      'Example: [0.1, 0.2, 0.3]. Actual scores: [0.3, 0.1, 0.9]',
      'prose around arrays',
    ],
    ['[0.3, 0.1, 0.9] [0.1, 0.2, 0.3]', 'two arrays'],
    ['Scores: [0.3, 0.1, 0.9]', 'prose before the array'],
  ] as const) {
    it(`out-of-contract output (${why}) is RERANK_ERROR, never zero-filled`, async () => {
      const r = await new LlmReranker(makeLlm([{ content }])).rerank(
        'q',
        sampleResults,
      );
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'RERANK_ERROR');
    });
  }

  it('the custom question reaches the prompt', async () => {
    // makeLlm only counts calls, so spy on the messages with a minimal ILlm.
    const seen: unknown[] = [];
    const llm = {
      chat: async (messages: unknown) => {
        seen.push(messages);
        return {
          ok: true,
          value: { content: '[0.5, 0.5, 0.5]', toolCalls: [] },
        };
      },
      streamChat: async function* () {},
    } as unknown as ILlm;
    await new LlmReranker(llm, {
      question: { task: 'Will this tool help?' },
    }).rerank('q', sampleResults);
    assert.match(JSON.stringify(seen[0]), /Will this tool help\?/);
  });

  it('logs usage per batch under component "rerank" when a requestLogger is present', async () => {
    const entries: Array<{ component: string }> = [];
    const llm = makeLlm([{ content: '[0.3, 0.1, 0.9]' }]);
    await new LlmReranker(llm).rerank('q', sampleResults, {
      requestLogger: {
        logLlmCall: (e: { component: string }) => entries.push(e),
      },
    } as never);
    assert.deepEqual(
      entries.map((e) => e.component),
      ['rerank'],
    );
  });

  it('batches by batchSize and merges', async () => {
    const llm = makeLlm([{ content: '[0.1, 0.9]' }, { content: '[0.5]' }]);
    const r = await new LlmReranker(llm, {
      batchSize: 2,
      concurrency: 1,
    }).rerank('q', sampleResults);
    assert.ok(r.ok);
    assert.equal(llm.callCount, 2);
    assert.deepEqual(
      r.value.map((x) => x.score),
      [0.9, 0.5, 0.1],
    );
  });
});
