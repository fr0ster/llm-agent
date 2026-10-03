import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { blockingFetch, fakeFetch } from './fake-fetch.js';

async function codeFor(status: number) {
  const f = fakeFetch(() => ({ status, body: { error: 'nope' } }));
  const m = new TypeSafeDecisionModel({
    credential: staticApiKey('k'),
    maxRetries: 0,
    fetch: f.fetch,
  });
  const r = await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
  assert.ok(!r.ok);
  return r.error;
}

describe('HTTP status → DecisionErrorCode', () => {
  for (const [status, code] of [
    [400, 'DECISION_INVALID_REQUEST'],
    [404, 'DECISION_INVALID_REQUEST'],
    [422, 'DECISION_INVALID_REQUEST'],
    [401, 'DECISION_AUTH'],
    [403, 'DECISION_AUTH'],
    [429, 'DECISION_RATE_LIMITED'],
    [500, 'DECISION_UNAVAILABLE'],
    [503, 'DECISION_UNAVAILABLE'],
    [409, 'DECISION_ERROR'],
  ] as const) {
    it(`${status} → ${code}`, async () => {
      const e = await codeFor(status);
      assert.equal(e.code, code);
      assert.equal(e.name, 'DecisionError');
    });
  }
});

describe('non-HTTP failures', () => {
  it('a connection failure → DECISION_UNAVAILABLE', async () => {
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_UNAVAILABLE');
  });

  it('a timeout → DECISION_UNAVAILABLE', async () => {
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      timeoutMs: 20,
      fetch: b.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_UNAVAILABLE');
  });

  it('a signal aborted before the request → DECISION_ABORTED', async () => {
    // decide() awaits credential.secret() first, so the SDK hands fetch an
    // ALREADY-aborted signal; a real fetch rejects at once, and so must the fake.
    const ac = new AbortController();
    ac.abort();
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: b.fetch,
    });
    const r = await m.decide(
      { state: 's', questions: { a: { type: 'noul' } } },
      { signal: ac.signal },
    );
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ABORTED');
  });

  it('an abort while the request is in flight → DECISION_ABORTED', async () => {
    const ac = new AbortController();
    const b = blockingFetch();
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: b.fetch,
    });
    const p = m.decide(
      { state: 's', questions: { a: { type: 'noul' } } },
      { signal: ac.signal },
    );
    await b.entered; // the request is inside fetch now
    ac.abort();
    const r = await p;
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ABORTED');
  });

  it('an SDK pre-request rejection (empty questions) → DECISION_INVALID_REQUEST', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({ state: 's', questions: {} });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_INVALID_REQUEST');
    assert.equal(f.calls.length, 0, 'rejected before any request');
  });

  it('a score rubric with fewer than two levels → DECISION_INVALID_REQUEST', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'score', criteria: ['only'] } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_INVALID_REQUEST');
  });
});

describe('messages', () => {
  for (const status of [401, 500, 409]) {
    it(`never contain the key or the request body (HTTP ${status})`, async () => {
      // The response itself echoes both secrets, as a hostile or sloppy server
      // might; the SDK puts that into its own message, mapError must not.
      const f = fakeFetch(() => ({
        status,
        body: { error: 'echo sk-SECRET-123 PRIVATE-STATE-TEXT' },
      }));
      const m = new TypeSafeDecisionModel({
        credential: staticApiKey('sk-SECRET-123'),
        maxRetries: 0,
        fetch: f.fetch,
      });
      const r = await m.decide({
        state: 'PRIVATE-STATE-TEXT',
        questions: { a: { type: 'noul' } },
      });
      assert.ok(!r.ok);
      assert.doesNotMatch(r.error.message, /sk-SECRET-123/);
      assert.doesNotMatch(r.error.message, /PRIVATE-STATE-TEXT/);
    });
  }

  it('carries the request id', async () => {
    const f = fakeFetch(() => ({
      status: 500,
      body: { error: 'x' },
      headers: { 'x-typesafe-request-id': 'req-123' },
    }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.match(r.error.message, /req-123/);
  });
});
