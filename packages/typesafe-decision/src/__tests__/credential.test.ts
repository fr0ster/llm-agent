import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { fakeFetch, okBody } from './fake-fetch.js';

const ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'TYPESAFE_BASE_URL',
  'TYPESAFE_DEFAULT_MODEL',
  'TYPESAFE_LOG_LEVEL',
] as const;

describe('TypeSafeDecisionModel credential', () => {
  it('presents a freshly asked secret on EVERY call', async () => {
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-ts-${++n}`,
    };
    const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.5 } }));
    const m = new TypeSafeDecisionModel({
      credential: rotating,
      fetch: f.fetch,
    });
    const req = { state: 's', questions: { a: { type: 'noul' as const } } };
    await m.decide(req);
    await m.decide(req);
    assert.deepEqual(
      f.calls.map((c) => c.headers.authorization),
      ['Bearer sk-ts-1', 'Bearer sk-ts-2'],
      'a key resolved once at construction would be identical here',
    );
  });

  describe('environment isolation', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.TYPESAFE_API_KEY = 'ENV-KEY-SENTINEL';
      process.env.TYPESAFE_BASE_URL = 'https://env-sentinel.invalid';
      process.env.TYPESAFE_DEFAULT_MODEL = 'env-model-sentinel';
      process.env.TYPESAFE_LOG_LEVEL = 'debug';
    });
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('never lets TYPESAFE_* reach the request or turn on logging', async () => {
      const logged: unknown[] = [];
      const origDebug = console.debug;
      const origInfo = console.info;
      console.debug = (...a: unknown[]) => logged.push(a);
      console.info = (...a: unknown[]) => logged.push(a);
      try {
        const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.5 } }));
        const m = new TypeSafeDecisionModel({
          credential: { kind: 'api-key', secret: async () => 'cfg-key' },
          fetch: f.fetch,
        });
        const r = await m.decide({
          state: 's',
          questions: { a: { type: 'noul' } },
        });
        assert.ok(r.ok);
        const call = f.calls[0];
        assert.equal(call.headers.authorization, 'Bearer cfg-key');
        assert.ok(call.url.startsWith('https://api.typesafe.ai/'));
        assert.equal(call.body.model, 'jev-latest');
        assert.equal(logged.length, 0, 'the SDK must not log request bodies');
      } finally {
        console.debug = origDebug;
        console.info = origInfo;
      }
    });
  });
});
