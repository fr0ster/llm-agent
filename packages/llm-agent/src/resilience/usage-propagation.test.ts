import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '../interfaces/llm.js';
import { type CallOptions, LlmError } from '../interfaces/types.js';
import type { IUsageRecorder, UsageOperation } from '../interfaces/usage.js';
import { FallbackLlmCallStrategy } from '../policy/fallback-llm-call-strategy.js';
import {
  ExpandPreprocessor,
  IntentEnricher,
  TranslatePreprocessor,
} from '../rag/preprocessor.js';
import { TextOnlyEmbedding } from '../rag/query-embedding.js';
import { LlmQueryExpander } from '../rag/query-expander.js';
import { IntentToolIndexing } from '../rag/tool-indexing-strategy.js';
import { VectorRag } from '../rag/vector-rag.js';
import { BatchChunkingEmbedder } from './batch-chunking-embedder.js';
import { RetryBatchEmbedder, RetryEmbedder } from './retry-embedder.js';

test('chunk and retry coordinates share the caller recorder and sequence', async () => {
  const seen: UsageOperation[] = [];
  const usage: IUsageRecorder = {
    record() {},
    with() {
      return this;
    },
  };
  const inner = {
    async embed(_text: string, options?: CallOptions) {
      assert.equal(options?.usage, usage);
      assert.ok(options?.usageOp);
      seen.push(options.usageOp);
      if (options.usageOp.outerAttempt === 0)
        throw Object.assign(new Error('retry'), { status: 429 });
      return { vector: [1] };
    },
    async embedBatch(texts: string[], options?: CallOptions) {
      await this.embed(texts[0], options);
      return texts.map(() => ({ vector: [1] }));
    },
  };
  const retry = new RetryBatchEmbedder(inner, { maxAttempts: 1, backoffMs: 0 });
  const chunked = new BatchChunkingEmbedder(retry, 2);
  await chunked.embedBatch(['a', 'b', 'c', 'd', 'e', 'f'], { usage });
  assert.deepEqual(
    seen.map((op) => [op.chunkPath, op.outerAttempt]),
    [
      ['1/3', 0],
      ['1/3', 1],
      ['2/3', 0],
      ['2/3', 1],
      ['3/3', 0],
      ['3/3', 1],
    ],
  );
  assert.equal(new Set(seen.map((op) => op.operationId)).size, 1);
  assert.equal(new Set(seen.map((op) => op.seq)).size, 1);
  assert.deepEqual(
    seen.map((op) => op.seq.next()),
    [0, 1, 2, 3, 4, 5],
  );
});

test('single embed retries copy coordinates without mutating caller operation', async () => {
  const seen: UsageOperation[] = [];
  const op: UsageOperation = {
    operationId: 'operation',
    seq: { next: () => 0 },
    outerAttempt: 9,
    providerAttempt: 0,
    chunkPath: '2/4',
  };
  const retry = new RetryEmbedder(
    {
      async embed(_text, options) {
        assert.ok(options?.usageOp);
        seen.push(options.usageOp);
        if (seen.length === 1)
          throw Object.assign(new Error('retry'), { status: 429 });
        return { vector: [1] };
      },
    },
    { maxAttempts: 1, backoffMs: 0 },
  );
  await retry.embed('text', { usageOp: op });
  assert.deepEqual(
    seen.map((value) => value.outerAttempt),
    [0, 1],
  );
  assert.ok(
    seen.every(
      (value) =>
        value !== op && value.seq === op.seq && value.chunkPath === '2/4',
    ),
  );
  assert.equal(op.outerAttempt, 9);
});

test('query helpers preserve operation and narrow recorder to their component', async () => {
  const roles: string[] = [];
  const usage: IUsageRecorder = {
    record() {},
    with(context) {
      roles.push(context.role ?? '');
      return this;
    },
  };
  const options: CallOptions = {
    usage,
    usageOp: {
      operationId: 'helpers',
      seq: { next: () => 0 },
      outerAttempt: 0,
      providerAttempt: 0,
      chunkPath: '',
    },
  };
  let calls = 0;
  const llm: ILlm = {
    async chat(_messages, _tools, opts) {
      calls++;
      assert.equal(opts?.usage, usage);
      assert.equal(opts?.usageOp, options.usageOp);
      return { ok: true, value: { content: 'expanded', finishReason: 'stop' } };
    },
    async *streamChat() {},
  };
  await new TranslatePreprocessor(llm).process(
    '\u00e9 non-ASCII query text',
    options,
  );
  await new ExpandPreprocessor(llm).process('query', options);
  await new IntentEnricher(llm).enrich('document', options);
  await new LlmQueryExpander(llm).expand('query', options);
  await new IntentToolIndexing(llm).prepare(
    { name: 'tool', description: 'description' },
    options,
  );
  assert.equal(calls, 5);
  assert.deepEqual(roles, [
    'translate',
    'query-expander',
    'helper',
    'query-expander',
    'helper',
  ]);
});

test('VectorRag preserves recorder and operation in document, fallback query and health embedding', async () => {
  const roles: string[] = [];
  const usage: IUsageRecorder = {
    record() {},
    with(context) {
      roles.push(context.role ?? '');
      return this;
    },
  };
  const options: CallOptions = {
    usage,
    usageOp: {
      operationId: 'rag',
      seq: { next: () => 0 },
      outerAttempt: 0,
      providerAttempt: 0,
      chunkPath: '',
    },
  };
  const seen: string[] = [];
  const embed = async (text: string, opts?: CallOptions) => {
    seen.push(text);
    assert.equal(opts?.usage, usage);
    assert.equal(opts?.usageOp, options.usageOp);
    return { vector: [1, 0] };
  };
  const rag = new VectorRag({ embedDocument: embed, embedQuery: embed });
  assert.equal((await rag.upsert('document', { id: 'doc' }, options)).ok, true);
  assert.equal(
    (await rag.query(new TextOnlyEmbedding('query'), 1, options)).ok,
    true,
  );
  assert.equal((await rag.healthCheck(options)).ok, true);
  assert.deepEqual(seen, ['document', 'query', 'ping']);
  assert.deepEqual(roles, ['embedding', 'embedding', 'embedding']);
});

test('stream fallback shares operation and advances the outer attempt', async () => {
  const seen: UsageOperation[] = [];
  const llm: ILlm = {
    async *streamChat(_messages, _tools, options) {
      assert.ok(options?.usageOp);
      seen.push(options.usageOp);
      yield {
        ok: false as const,
        error: new LlmError('stream failed', 'LLM_ERROR'),
      };
    },
    async chat(_messages, _tools, options) {
      assert.ok(options?.usageOp);
      seen.push(options.usageOp);
      return { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
  };
  const strategy = new FallbackLlmCallStrategy();
  for await (const _chunk of strategy.call(llm, [], [])) {
    /* consume fallback */
  }
  assert.deepEqual(
    seen.map((op) => op.outerAttempt),
    [0, 1],
  );
  assert.equal(seen[0].operationId, seen[1].operationId);
  assert.equal(seen[0].seq, seen[1].seq);
});
