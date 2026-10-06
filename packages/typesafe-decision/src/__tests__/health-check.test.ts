/**
 * Spec §17.43 D97: the provider's cheapest real check. The TypeSafe SDK
 * documents `models.list()` (GET /v1/models, "the models available to the
 * account") — reachable and authenticated, no inference.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { blockingFetch, fakeFetch } from './fake-fetch.js';

const models = {
  models: [{ name: 'jev-1.13.0', description: 'Jev', release_date: 'x' }],
};

describe('TypeSafeDecisionModel.healthCheck', () => {
  it('GET /v1/models answers → true; no /v1/systemone (no inference)', async () => {
    const f = fakeFetch(() => ({ status: 200, body: models }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      baseUrl: 'https://proxy.example/typesafe/',
      fetch: f.fetch,
    });
    assert.deepEqual(await m.healthCheck(), { ok: true, value: true });
    assert.deepEqual(
      f.calls.map((c) => c.url),
      ['https://proxy.example/typesafe/v1/models'],
    );
    assert.equal(f.calls[0].headers.authorization, 'Bearer k');
  });

  it('401 → ok:false DECISION_AUTH', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: 'bad key' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: f.fetch,
    });
    const r = await m.healthCheck();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_AUTH');
  });

  it('500 → ok:false DECISION_UNAVAILABLE', async () => {
    const f = fakeFetch(() => ({ status: 500, body: { error: 'x' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: f.fetch,
    });
    const r = await m.healthCheck();
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_UNAVAILABLE');
  });

  it('the signal aborts the probe → ok:false DECISION_ABORTED', async () => {
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: b.fetch,
    });
    const controller = new AbortController();
    const pending = m.healthCheck({ signal: controller.signal });
    await b.entered;
    controller.abort();
    const r = await pending;
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ABORTED');
  });

  it('a credential that throws → ok:false, never a throw', async () => {
    const m = new TypeSafeDecisionModel({
      credential: {
        secret: async () => {
          throw new Error('vault down');
        },
      } as never,
      fetch: fakeFetch(() => ({ status: 200, body: models })).fetch,
    });
    const r = await m.healthCheck();
    assert.equal(r.ok, false);
  });
});
