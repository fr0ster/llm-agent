import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RelevanceRequest } from '@mcp-abap-adt/llm-agent';
import {
  type FetchLike,
  type SapAiCoreRelevanceConfig,
  SapAiCoreRelevanceDecision,
} from '../index.js';
import { blockingFetch, fakeFetch, type Recorded } from './fake-fetch.js';

const TOKEN = 'SECRET-TOKEN';
let tokenCalls = 0;
const credential = {
  kind: 'bearer' as const,
  token: async () => {
    tokenCalls++;
    return TOKEN;
  },
};
const make = (
  fetch: FetchLike,
  extra: Partial<SapAiCoreRelevanceConfig> = {},
) =>
  new SapAiCoreRelevanceDecision({
    deploymentId: 'd1',
    model: 'cohere-rerank',
    apiBaseUrl: 'https://api.example/',
    credential,
    fetch,
    ...extra,
  });
const req = (...passages: string[]): RelevanceRequest => ({
  query: 'read a file',
  passages,
});
const scored = (scores: number[]) => (rec: Recorded) => ({
  status: 200,
  body: {
    results: (rec.body.documents ?? []).map((_, index) => ({
      index,
      relevance_score: scores[index],
    })),
  },
});
const codeOf = async (p: ReturnType<SapAiCoreRelevanceDecision['score']>) => {
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(
    !r.ok && !r.error.message.includes(TOKEN),
    'the token never appears in an error',
  );
  return !r.ok ? r.error.code : undefined;
};

describe('SapAiCoreRelevanceDecision — wire (spec §5.3)', () => {
  it('ONE POST per score: URL, headers, body with the passages in order', async () => {
    const { fetch, calls } = fakeFetch(scored([0.1, 0.9]));
    await make(fetch).score(
      req('read_file — read a file', 'list_issues — list issues'),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://api.example/v2/inference/deployments/d1/rerank',
    );
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['ai-resource-group'], 'default');
    assert.equal(calls[0].headers['content-type'], 'application/json');
    assert.deepEqual(calls[0].body, {
      model: 'cohere-rerank',
      query: 'read a file',
      documents: ['read_file — read a file', 'list_issues — list issues'],
      top_n: 2,
    });
  });
  it('resourceGroup is sent; the bearer is asked on every call', async () => {
    const { fetch, calls } = fakeFetch(scored([0.5]));
    const m = make(fetch, { resourceGroup: 'rg1' });
    const before = tokenCalls;
    await m.score(req('a'));
    await m.score(req('a'));
    assert.equal(calls[0].headers['ai-resource-group'], 'rg1');
    assert.equal(tokenCalls - before, 2);
  });
});

describe('SapAiCoreRelevanceDecision — mapping (not a probability)', () => {
  it('scores = results as {index, score}; model = the configured one; no usage', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: {
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
      },
    }));
    const r = await make(fetch).score(req('a', 'b'));
    assert.ok(r.ok);
    assert.deepEqual(r.value.scores, [
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
    assert.equal(r.value.model, 'cohere-rerank');
    assert.equal(r.value.usage, undefined);
  });
  it('a score outside [0, 1] is accepted — a relevance score is not a probability', async () => {
    const { fetch } = fakeFetch(scored([1.7, -0.3]));
    const r = await make(fetch).score(req('a', 'b'));
    assert.ok(r.ok);
    assert.deepEqual(
      r.value.scores.map((s) => s.score),
      [1.7, -0.3],
    );
  });
});

describe('SapAiCoreRelevanceDecision — invalid requests', () => {
  for (const [name, request] of [
    ['an empty query', { query: ' ', passages: ['a'] }],
    ['no passages', { query: 'q', passages: [] }],
    ['an empty passage', { query: 'q', passages: ['a', ''] }],
  ] as const) {
    it(`${name} → DECISION_INVALID_REQUEST, nothing sent`, async () => {
      const { fetch, calls } = fakeFetch(scored([1]));
      assert.equal(
        await codeOf(make(fetch).score(request)),
        'DECISION_INVALID_REQUEST',
      );
      assert.equal(calls.length, 0);
    });
  }
});

describe('SapAiCoreRelevanceDecision — a bad answer is a DecisionError, never zero-filled', () => {
  const bad: Array<
    [string, (rec: Recorded) => { status: number; body: unknown }]
  > = [
    [
      'fewer results than passages',
      () => ({
        status: 200,
        body: { results: [{ index: 0, relevance_score: 1 }] },
      }),
    ],
    [
      'more results than passages',
      () => ({
        status: 200,
        body: {
          results: [0, 1, 1].map((index) => ({ index, relevance_score: 1 })),
        },
      }),
    ],
    [
      'a duplicate index',
      () => ({
        status: 200,
        body: {
          results: [
            { index: 0, relevance_score: 1 },
            { index: 0, relevance_score: 1 },
          ],
        },
      }),
    ],
    [
      'an out-of-range index',
      () => ({
        status: 200,
        body: {
          results: [
            { index: 0, relevance_score: 1 },
            { index: 5, relevance_score: 1 },
          ],
        },
      }),
    ],
    [
      'a non-integer index',
      () => ({
        status: 200,
        body: {
          results: [
            { index: 0, relevance_score: 1 },
            { index: 0.5, relevance_score: 1 },
          ],
        },
      }),
    ],
    [
      'a non-finite score',
      () => ({
        status: 200,
        body: {
          results: [
            { index: 0, relevance_score: 1 },
            { index: 1, relevance_score: 'x' },
          ],
        },
      }),
    ],
    ['no results array', () => ({ status: 200, body: {} })],
    ['a body that is not JSON', () => ({ status: 200, body: 'not json' })],
  ];
  for (const [name, respond] of bad) {
    it(`${name} → DECISION_ERROR`, async () => {
      const { fetch } = fakeFetch(respond);
      assert.equal(
        await codeOf(make(fetch).score(req('a', 'b'))),
        'DECISION_ERROR',
      );
    });
  }
});

describe('SapAiCoreRelevanceDecision — transport errors', () => {
  const statuses: Array<[number, string]> = [
    [400, 'DECISION_INVALID_REQUEST'],
    [401, 'DECISION_AUTH'],
    [403, 'DECISION_AUTH'],
    [404, 'DECISION_INVALID_REQUEST'],
    [422, 'DECISION_INVALID_REQUEST'],
    [429, 'DECISION_RATE_LIMITED'],
    [500, 'DECISION_UNAVAILABLE'],
    [503, 'DECISION_UNAVAILABLE'],
    [418, 'DECISION_ERROR'],
  ];
  for (const [status, code] of statuses) {
    it(`HTTP ${status} → ${code}, the status in the message, never the body`, async () => {
      const { fetch } = fakeFetch(() => ({
        status,
        body: { error: `leak ${TOKEN}` },
      }));
      const r = await make(fetch).score(req('a'));
      assert.ok(!r.ok);
      assert.equal(r.error.code, code);
      assert.match(r.error.message, new RegExp(String(status)));
      assert.ok(!r.error.message.includes('leak'));
    });
  }
  it('a network failure → DECISION_UNAVAILABLE', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    assert.equal(
      await codeOf(make(fetch).score(req('a'))),
      'DECISION_UNAVAILABLE',
    );
  });
  it('a credential that gives no token → DECISION_AUTH, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(scored([1]));
    const broken = {
      kind: 'bearer' as const,
      token: async () => {
        throw new Error(`no ${TOKEN}`);
      },
    };
    assert.equal(
      await codeOf(make(fetch, { credential: broken }).score(req('a'))),
      'DECISION_AUTH',
    );
    assert.equal(calls.length, 0);
  });
  it('an already-aborted signal → DECISION_ABORTED, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(scored([1]));
    const ac = new AbortController();
    ac.abort();
    assert.equal(
      await codeOf(make(fetch).score(req('a'), { signal: ac.signal })),
      'DECISION_ABORTED',
    );
    assert.equal(calls.length, 0);
  });
  it('an abort while the request is in flight → DECISION_ABORTED', async () => {
    const { fetch, entered } = blockingFetch();
    const ac = new AbortController();
    const pending = make(fetch).score(req('a'), { signal: ac.signal });
    await entered;
    ac.abort();
    assert.equal(await codeOf(pending), 'DECISION_ABORTED');
  });
  it('the constructor refuses a missing deployment, model, URL or credential', () => {
    const { fetch } = fakeFetch(scored([]));
    assert.throws(() => make(fetch, { deploymentId: '' }));
    assert.throws(() => make(fetch, { model: ' ' }));
    assert.throws(() => make(fetch, { apiBaseUrl: '' }));
    assert.throws(() => make(fetch, { credential: undefined as never }));
  });
});
