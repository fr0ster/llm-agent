import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import {
  asymmetricEmbedder,
  CircuitBreaker,
  type IUsageRecorder,
  RagError,
  type RagResult,
  type UsageInput,
  withCircuitBreaker,
} from '@mcp-abap-adt/llm-agent';
import { VoyageEmbedder, VoyageReranker } from './index.js';

const credential = { kind: 'api-key' as const, secret: async () => 'fixture' };
const embeddingConfig = { credential, model: 'voyage-4-large' };
const rerankingConfig = { credential, model: 'rerank-3' };

interface EmbedBody {
  input: string[];
  input_type: 'document' | 'query';
  truncation: boolean;
  model: string;
}

function embedBody(init?: RequestInit): EmbedBody {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(String(init?.body)) as EmbedBody;
}

function embeddingReply(
  input: string[],
  model = embeddingConfig.model,
  totalTokens = input.length,
) {
  return Response.json({
    data: input
      .map((value, index) => ({ embedding: [value.length], index }))
      .reverse(),
    model,
    usage: { total_tokens: totalTokens },
  });
}

function recording(records: UsageInput[]): IUsageRecorder {
  return {
    record: (record) => records.push(record),
    with(context) {
      return {
        ...this,
        record: (record) =>
          records.push({
            ...record,
            context: { ...record.context, ...context },
          }),
      };
    },
  };
}

test('asymmetric retrieval sends the model, role and complete inputs', async (t) => {
  const bodies: EmbedBody[] = [];
  const authorizations: Array<string | null> = [];
  let lookups = 0;
  const config = {
    ...embeddingConfig,
    baseURL: 'https://api.example.test/v1/',
    credential: { ...credential, secret: async () => `fixture-${++lookups}` },
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init?: RequestInit) => {
      assert.equal(url, 'https://api.example.test/v1/embeddings');
      assert.equal(init?.method, 'POST');
      authorizations.push(new Headers(init?.headers).get('Authorization'));
      const body = embedBody(init);
      bodies.push(body);
      return embeddingReply(body.input);
    },
  );
  const document = new VoyageEmbedder(config);
  const retrieval = asymmetricEmbedder({
    document,
    query: new VoyageEmbedder({ ...config, inputType: 'query' }),
  });
  assert.equal('getMaxInputChars' in document, false);
  assert.equal(retrieval.getMaxInputChars, undefined);
  assert.deepEqual((await retrieval.embedDocument('stored')).vector, [6]);
  assert.deepEqual((await retrieval.embedQuery('seek')).vector, [4]);
  assert.deepEqual(await retrieval.embedDocuments?.([]), []);
  assert.deepEqual(bodies, [
    {
      input: ['stored'],
      input_type: 'document',
      truncation: false,
      model: config.model,
    },
    {
      input: ['seek'],
      input_type: 'query',
      truncation: false,
      model: config.model,
    },
  ]);
  assert.deepEqual(authorizations, ['Bearer fixture-1', 'Bearer fixture-2']);
});

test('requires both model names', () => {
  assert.throws(
    () => new VoyageEmbedder({ ...embeddingConfig, model: '' }),
    /model is required/,
  );
  assert.throws(
    () => new VoyageReranker({ ...rerankingConfig, model: ' ' }),
    /model is required/,
  );
});

test('splits at the API count boundary and restores embedding order', async (t) => {
  const sizes: number[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const { input } = embedBody(init);
      sizes.push(input.length);
      return embeddingReply(input);
    },
  );
  const input = Array.from({ length: 2_003 }, (_, i) => `${i}`);
  const result = await new VoyageEmbedder(embeddingConfig).embedBatch(input);
  assert.deepEqual(sizes, [1_000, 1_000, 3]);
  assert.deepEqual(
    result.map(({ vector }) => vector[0]),
    input.map((text) => text.length),
  );
});

test('splits by the model-specific request token limit and records exact per-model usage', async (t) => {
  const bodies: EmbedBody[] = [];
  const records: UsageInput[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const body = embedBody(init);
      bodies.push(body);
      return embeddingReply(body.input, body.model, body.input.length * 19 + 1);
    },
  );
  const usage = recording(records);
  const input = Array.from({ length: 4 }, () => 'é'.repeat(15_000));
  const large = await new VoyageEmbedder({
    ...embeddingConfig,
    usage,
  }).embedBatch(input);
  await new VoyageEmbedder({
    ...embeddingConfig,
    model: 'voyage-4',
    usage,
  }).embedBatch(input);
  assert.deepEqual(
    bodies.map((body) => body.input.length),
    [3, 1, 4],
  );
  assert.ok(bodies.every(({ truncation }) => truncation === false));
  assert.deepEqual(
    large.map((item) => item.usage?.promptTokens),
    [20, 19, 19, 20],
  );
  assert.deepEqual(
    records.map((record) => {
      assert.equal(record.kind, 'embedding.call');
      return [
        record.provider,
        record.model,
        record.inputTokens,
        record.chunkPath,
      ];
    }),
    [
      ['voyage', 'voyage-4-large', 58, '1/2'],
      ['voyage', 'voyage-4-large', 20, '2/2'],
      ['voyage', 'voyage-4', 77, ''],
    ],
  );
});

test('subdivides server-reported aggregate token violations and preserves a context-length error', async (t) => {
  const batches: string[][] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const { input, truncation } = embedBody(init);
      assert.equal(truncation, false);
      batches.push(input);
      if (input.includes('long')) {
        return Response.json(
          {
            detail: 'Number of tokens in an example exceeds the context length',
          },
          { status: 400 },
        );
      }
      if (input.length > 2) {
        return Response.json(
          { detail: 'Total number of tokens in the batch exceeds the limit' },
          { status: 400 },
        );
      }
      return embeddingReply(input);
    },
  );
  const embedder = new VoyageEmbedder({
    ...embeddingConfig,
    model: 'model-with-unlisted-token-limit',
  });
  const result = await embedder.embedBatch(['a', 'aa', 'aaa']);
  assert.deepEqual(
    result.map((item) => item.vector),
    [[1], [2], [3]],
  );
  await assert.rejects(embedder.embedBatch(['long', 'a']), {
    code: 'EMBED_ERROR',
    status: 400,
  });
  assert.deepEqual(batches, [
    ['a', 'aa', 'aaa'],
    ['a', 'aa'],
    ['aaa'],
    ['long', 'a'],
  ]);
});

test('429 honors Retry-After through repeated refusals without tripping the circuit breaker', async (t) => {
  const records: UsageInput[] = [];
  const attempts: number[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      assert.equal(init?.signal, undefined);
      attempts.push(performance.now());
      return attempts.length <= 12
        ? new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': attempts.length <= 3 ? '0.025' : '0' },
          })
        : embeddingReply(['a']);
    },
  );
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const embedder = withCircuitBreaker(
    new VoyageEmbedder({ ...embeddingConfig, usage: recording(records) }),
    breaker,
  );
  assert.deepEqual((await embedder.embed('a')).vector, [1]);
  assert.equal(attempts.length, 13);
  for (let i = 1; i <= 3; i++) assert.ok(attempts[i] - attempts[i - 1] >= 20);
  assert.equal(breaker.isCallPermitted, true);
  assert.deepEqual(
    records.map((record) => record.outcome),
    [...Array.from({ length: 12 }, () => 'error'), 'ok'],
  );
  const operations = records.filter(
    (record) => record.kind === 'embedding.call',
  );
  assert.equal(new Set(operations.map((record) => record.operationId)).size, 1);
  assert.deepEqual(
    operations.map((record) => record.providerAttempt),
    Array.from({ length: 13 }, (_, i) => i),
  );
});

test('caller abort cancels a waiting 429 with no additional request', {
  timeout: 2_000,
}, async (t) => {
  const controller = new AbortController();
  const reason = new Error('cancelled by caller');
  const events = new EventEmitter();
  const waiting = once(events, 'waiting', { signal: t.signal });
  t.after(() => controller.abort(reason));
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      assert.equal(init?.signal, controller.signal);
      calls++;
      return new Response('', {
        status: 429,
        headers: { 'Retry-After': '7200' },
      });
    },
  );
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: () => void, delay: number) => {
      if (delay === 7_200_000) events.emit('waiting');
      return originalSetTimeout(callback, delay);
    },
  );
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  const embedder = withCircuitBreaker(
    new VoyageEmbedder(embeddingConfig),
    breaker,
  );
  const embedding = embedder.embed('a', { signal: controller.signal });
  await waiting;
  controller.abort(reason);
  await assert.rejects(embedding, (error) => error === reason);
  assert.equal(calls, 1);
  assert.equal(breaker.isCallPermitted, true);
});

test('raw providers surface 5xx immediately with HTTP metadata', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('service unavailable', {
      status: 503,
      headers: { 'Retry-After': '2' },
    });
  });
  const embedder = new VoyageEmbedder(embeddingConfig);
  await assert.rejects(embedder.embed('a'), {
    code: 'EMBED_ERROR',
    status: 503,
    retryAfterSeconds: 2,
  });
  await assert.rejects(embedder.embedBatch(['a', 'b']), {
    code: 'EMBED_ERROR',
    status: 503,
  });
  const reranked = await new VoyageReranker(rerankingConfig).rerank('q', [
    first,
  ]);
  assert.equal(reranked.ok, false);
  if (reranked.ok) assert.fail('Expected an HTTP error');
  assert.ok(reranked.error instanceof RagError);
  assert.equal(reranked.error.code, 'RERANK_ERROR');
  assert.ok('status' in reranked.error);
  assert.equal(reranked.error.status, 503);
  assert.equal(calls, 3);
});

const first: RagResult = {
  text: 'first',
  score: 0.5,
  metadata: { id: 'first' },
};
const second: RagResult = {
  text: 'second',
  score: 0.1,
  metadata: { id: 'second' },
};

interface RerankBody {
  query: string;
  documents: string[];
  model: string;
  truncation: boolean;
  top_k?: number;
}

function rerankBody(init?: RequestInit): RerankBody {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(String(init?.body)) as RerankBody;
}

function numberedCandidates(count: number): RagResult[] {
  return Array.from({ length: count }, (_, index) => ({
    text: String(index),
    score: 0,
    metadata: { id: `candidate-${index}` },
  }));
}

function numberedRerankReply(body: RerankBody, totalTokens?: number): Response {
  return Response.json({
    data: body.documents
      .map((text, index) => ({ index, relevance_score: Number(text) / 1_000 }))
      .reverse(),
    model: body.model,
    usage: { total_tokens: totalTokens ?? body.documents.length },
  });
}

test('reranking sends every candidate and bills provider token usage', async (t) => {
  const bodies: RerankBody[] = [];
  const bound: UsageInput[] = [];
  const records: UsageInput[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init?: RequestInit) => {
      assert.equal(url, 'https://api.voyageai.com/v1/rerank');
      const body = rerankBody(init);
      bodies.push(body);
      return Response.json({
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
        model: rerankingConfig.model,
        usage: { total_tokens: 42 },
      });
    },
  );
  const reranker = new VoyageReranker({
    ...rerankingConfig,
    usage: recording(bound),
  });
  const request = {
    query: 'q',
    documents: ['first', 'second'],
    model: rerankingConfig.model,
    truncation: false,
  };
  assert.deepEqual(
    await reranker.rerank('q', [first, second], { usage: recording(records) }),
    {
      ok: true,
      value: [
        { ...second, score: 0.9 },
        { ...first, score: 0.2 },
      ],
    },
  );
  assert.deepEqual(await reranker.rerank('q', [first, second], { topK: 1 }), {
    ok: true,
    value: [{ ...second, score: 0.9 }],
  });
  assert.deepEqual(bodies, [request, request]);
  assert.equal(first.score, 0.5);
  for (const [record] of [records, bound]) {
    assert.equal(record.kind, 'llm.call');
    assert.equal(record.context.role, 'rerank');
    assert.equal(record.model, 'rerank-3');
    assert.equal(record.inputTokens, 42);
    assert.equal(record.tokensSource, 'provider');
  }
});

test('reranking scores all 1,001 candidates and applies topK after merging batches', async (t) => {
  const candidates = numberedCandidates(1_001);
  const bodies: RerankBody[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const body = rerankBody(init);
      bodies.push(body);
      if (body.documents.length > 1_000) {
        return Response.json({ detail: 'Too many documents' }, { status: 400 });
      }
      return numberedRerankReply(body);
    },
  );

  const reranker = new VoyageReranker(rerankingConfig);
  const query = 'same query for every batch';
  assert.deepEqual(await reranker.rerank(query, candidates, { topK: 1 }), {
    ok: true,
    value: [{ ...candidates[1_000], score: 1 }],
  });
  const expected = [candidates.slice(0, 1_000), candidates.slice(1_000)].map(
    (batch) => ({
      query,
      documents: batch.map(({ text }) => text),
      model: rerankingConfig.model,
      truncation: false,
    }),
  );
  assert.deepEqual(bodies, expected);
  assert.deepEqual(await reranker.rerank(query, candidates), {
    ok: true,
    value: candidates
      .map((candidate, index) => ({ ...candidate, score: index / 1_000 }))
      .reverse(),
  });
  assert.deepEqual(bodies, [...expected, ...expected]);
});

test('reranking budgets UTF-8 bytes including the query per document and sums usage per model', async (t) => {
  const sizes: number[] = [];
  const records: UsageInput[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const body = rerankBody(init);
      sizes.push(body.documents.length);
      return Response.json({
        data: body.documents.map((_, index) => ({
          index,
          relevance_score: 0.5,
        })),
        model: body.model,
        usage: { total_tokens: body.documents.length * 19 + 1 },
      });
    },
  );

  const query = '\u00e9'.repeat(500);
  const text = '\u00e9'.repeat(3_500);
  const candidates = numberedCandidates(76).map((candidate) => ({
    ...candidate,
    text,
  }));
  const totals = new Map<string, number>();
  const usage = recording(records);
  for (const model of ['rerank-1', 'rerank-3']) {
    assert.deepEqual(
      await new VoyageReranker({ credential, model, usage }).rerank(
        query,
        candidates,
      ),
      {
        ok: true,
        value: candidates.map((candidate) => ({ ...candidate, score: 0.5 })),
      },
    );
  }
  assert.deepEqual(sizes, [37, 37, 2, 75, 1]);
  for (const record of records) {
    assert.equal(record.kind, 'llm.call');
    assert.equal(record.context.role, 'rerank');
    assert.equal(record.outcome, 'ok');
    assert.equal(record.tokensSource, 'provider');
    totals.set(
      record.model,
      (totals.get(record.model) ?? 0) + (record.inputTokens ?? 0),
    );
  }
  assert.deepEqual(
    [...totals],
    [
      ['rerank-1', 1_447],
      ['rerank-3', 1_446],
    ],
  );
});

test('reranking bisects a server-rejected batch and maps each local index back to its candidate', async (t) => {
  const batches: string[][] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const body = rerankBody(init);
      const { documents } = body;
      batches.push(documents);
      if (documents.length > 2) {
        return Response.json(
          {
            detail:
              documents.length === 5
                ? 'The max allowed tokens per submitted batch is 100000.'
                : 'Token budget exceeded',
          },
          { status: 400 },
        );
      }
      return numberedRerankReply(body);
    },
  );

  const candidates = numberedCandidates(5);
  assert.deepEqual(
    await new VoyageReranker(rerankingConfig).rerank('q', candidates),
    {
      ok: true,
      value: candidates
        .map((candidate, index) => ({ ...candidate, score: index / 1_000 }))
        .reverse(),
    },
  );
  assert.deepEqual(batches, [
    ['0', '1', '2', '3', '4'],
    ['0', '1', '2'],
    ['0', '1'],
    ['2'],
    ['3', '4'],
  ]);
});

test('reranking names a candidate that alone exceeds the estimated request budget', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response());
  const text = '\u00e9'.repeat(150_000);
  assert.equal(Buffer.byteLength(text), 300_000);
  const result = await new VoyageReranker({
    credential,
    model: 'rerank-1',
  }).rerank('q', [first, { ...second, text }], { topK: 1 });
  if (result.ok) assert.fail('Expected an oversized candidate error');
  assert.equal(result.error.code, 'RERANK_ERROR');
  assert.match(result.error.message, /candidate.*index 1.*second.*300000/i);
  assert.equal(fetch.mock.callCount(), 0);
});

test('reranking names a candidate whose query-document pair Voyage rejects for context length', async (t) => {
  const batches: string[][] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const body = rerankBody(init);
      batches.push(body.documents);
      assert.equal(body.truncation, false);
      if (body.documents.includes('long')) {
        return Response.json(
          {
            detail:
              'Number of tokens in the query and document exceeds the context length',
          },
          { status: 400 },
        );
      }
      return numberedRerankReply(body);
    },
  );
  const result = await new VoyageReranker(rerankingConfig).rerank('q', [
    ...numberedCandidates(2),
    { ...second, text: 'long' },
  ]);
  if (result.ok) assert.fail('Expected an oversized candidate error');
  assert.equal(result.error.code, 'RERANK_ERROR');
  assert.match(
    result.error.message,
    /candidate.*index 2.*second.*context length/i,
  );
  assert.ok('status' in result.error);
  assert.equal(result.error.status, 400);
  assert.deepEqual(batches, [['0', '1', 'long'], ['0', '1'], ['long']]);
});

test('reranking honors Retry-After without a retry cap in a later batch', async (t) => {
  const attempts: number[] = [];
  let firstBatchCalls = 0;
  const records: UsageInput[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      const body = rerankBody(init);
      if (body.documents[0] === '0') {
        firstBatchCalls++;
        return numberedRerankReply(body);
      }
      assert.deepEqual(body.documents, ['1000']);
      attempts.push(performance.now());
      if (attempts.length <= 12) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': attempts.length === 1 ? '0.025' : '0' },
        });
      }
      return numberedRerankReply(body);
    },
  );

  const candidates = numberedCandidates(1_001);
  const reranker = new VoyageReranker({
    ...rerankingConfig,
    usage: recording(records),
  });
  assert.deepEqual(await reranker.rerank('q', candidates, { topK: 1 }), {
    ok: true,
    value: [{ ...candidates[1_000], score: 1 }],
  });
  assert.equal(firstBatchCalls, 1);
  assert.equal(attempts.length, 13);
  assert.ok(attempts[1] - attempts[0] >= 20);
  const requests = records.filter((record) => record.kind === 'llm.call');
  assert.equal(requests.length, records.length);
  assert.equal(new Set(requests.map((record) => record.operationId)).size, 1);
  assert.equal(new Set(requests.map((record) => record.physicalSeq)).size, 14);
  assert.deepEqual(
    requests.map((record) => record.providerAttempt),
    [0, ...Array.from({ length: 13 }, (_, index) => index)],
  );
  assert.deepEqual(
    requests
      .filter((record) => record.outcome === 'ok')
      .map((record) => record.inputTokens),
    [1_000, 1],
  );
});

test('aborting a rerank during Retry-After skips the retry and remaining batches', {
  timeout: 2_000,
}, async (t) => {
  const controller = new AbortController();
  const events = new EventEmitter();
  const waiting = once(events, 'waiting', { signal: t.signal });
  t.after(() => controller.abort());
  const batches: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string, init?: RequestInit) => {
      assert.equal(init?.signal, controller.signal);
      const body = rerankBody(init);
      batches.push(body.documents[0]);
      return body.documents[0] === '1000'
        ? new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '7200' },
          })
        : numberedRerankReply(body);
    },
  );
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: () => void, delay: number) => {
      if (delay === 7_200_000) events.emit('waiting');
      return originalSetTimeout(callback, delay);
    },
  );

  const reranking = new VoyageReranker(rerankingConfig).rerank(
    'q',
    numberedCandidates(2_001),
    { signal: controller.signal },
  );
  await waiting;
  controller.abort();
  const result = await reranking;
  if (result.ok) assert.fail('Expected the rerank to be aborted');
  assert.equal(result.error.code, 'ABORTED');
  assert.deepEqual(batches, ['0', '1000']);
});
