/**
 * Spec §17.43 D97: the provider's cheapest real check — the AI Core
 * deployment's status (`GET /v2/lm/deployments/{id}`), no inference.
 * `RUNNING` → true, any other status → false; a failure → ok:false with the
 * code mapped as for scoring; never a rejection.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type FetchLike,
  type SapAiCoreRelevanceConfig,
  SapAiCoreRelevanceDecision,
} from '../index.js';
import { blockingFetch, fakeFetch } from './fake-fetch.js';

const TOKEN = 'SECRET-TOKEN';
const credential = { kind: 'bearer' as const, token: async () => TOKEN };
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
const deployment = (status: unknown) => () => ({
  status: 200,
  body: { id: 'd1', status, targetStatus: 'RUNNING' },
});
const failure = async (
  p: ReturnType<SapAiCoreRelevanceDecision['healthCheck']>,
) => {
  const r = await p;
  assert.equal(r.ok, false);
  assert.ok(
    !r.ok && !r.error.message.includes(TOKEN),
    'the token never appears in an error',
  );
  return !r.ok ? r.error.code : undefined;
};

describe('SapAiCoreRelevanceDecision.healthCheck — the deployment status', () => {
  it('RUNNING → ok(true): ONE GET of the deployment, its headers, no /rerank', async () => {
    const { fetch, calls } = fakeFetch(deployment('RUNNING'));
    assert.deepEqual(await make(fetch).healthCheck(), {
      ok: true,
      value: true,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example/v2/lm/deployments/d1');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].headers['ai-resource-group'], 'default');
    assert.ok(
      !calls.some((c) => c.url.includes('/rerank')),
      'no inference call',
    );
    assert.ok(
      !calls.some((c) => c.url.includes('/inference/')),
      'no inference call',
    );
  });
  it('the configured resource group is sent', async () => {
    const { fetch, calls } = fakeFetch(deployment('RUNNING'));
    await make(fetch, { resourceGroup: 'rg1' }).healthCheck();
    assert.equal(calls[0].headers['ai-resource-group'], 'rg1');
  });
  for (const status of ['STOPPED', 'PENDING', 'DEAD', 'UNKNOWN']) {
    it(`${status} → ok(false)`, async () => {
      const { fetch } = fakeFetch(deployment(status));
      assert.deepEqual(await make(fetch).healthCheck(), {
        ok: true,
        value: false,
      });
    });
  }
  it('a body without a status → ok:false DECISION_ERROR (never a guess)', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { id: 'd1' } }));
    assert.equal(await failure(make(fetch).healthCheck()), 'DECISION_ERROR');
  });
  it('a body that is not JSON → ok:false DECISION_ERROR', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: 'not json' }));
    assert.equal(await failure(make(fetch).healthCheck()), 'DECISION_ERROR');
  });
});

describe('SapAiCoreRelevanceDecision.healthCheck — failures are ok:false, codes as for score', () => {
  const statuses: Array<[number, string]> = [
    [401, 'DECISION_AUTH'],
    [403, 'DECISION_AUTH'],
    [404, 'DECISION_INVALID_REQUEST'],
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
      const r = await make(fetch).healthCheck();
      assert.ok(!r.ok);
      assert.equal(r.error.code, code);
      assert.match(r.error.message, new RegExp(String(status)));
      assert.ok(!r.error.message.includes('leak'));
    });
  }
  it('a network failure → ok:false DECISION_UNAVAILABLE', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    assert.equal(
      await failure(make(fetch).healthCheck()),
      'DECISION_UNAVAILABLE',
    );
  });
  it('a fetch that throws synchronously → ok:false, never a rejection', async () => {
    const fetch: FetchLike = () => {
      throw new Error('boom');
    };
    assert.equal(
      await failure(make(fetch).healthCheck()),
      'DECISION_UNAVAILABLE',
    );
  });
  it('a credential that gives no token → ok:false DECISION_AUTH, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(deployment('RUNNING'));
    const broken = {
      kind: 'bearer' as const,
      token: async () => {
        throw new Error(`no ${TOKEN}`);
      },
    };
    assert.equal(
      await failure(make(fetch, { credential: broken }).healthCheck()),
      'DECISION_AUTH',
    );
    assert.equal(calls.length, 0);
  });
  it('an already-aborted signal → ok:false DECISION_ABORTED, nothing sent', async () => {
    const { fetch, calls } = fakeFetch(deployment('RUNNING'));
    const ac = new AbortController();
    ac.abort();
    assert.equal(
      await failure(make(fetch).healthCheck({ signal: ac.signal })),
      'DECISION_ABORTED',
    );
    assert.equal(calls.length, 0);
  });
  it('the signal aborts the probe in flight → ok:false DECISION_ABORTED', async () => {
    const { fetch, entered } = blockingFetch();
    const ac = new AbortController();
    const pending = make(fetch).healthCheck({ signal: ac.signal });
    await entered;
    ac.abort();
    assert.equal(await failure(pending), 'DECISION_ABORTED');
  });
});
