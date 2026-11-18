import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composeResilientEmbedder,
  type IUsageRecorder,
  isBatchEmbedder,
  RagError,
  resetQuotaGates,
  type UsageInput,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import { OllamaEmbedder } from './ollama.js';

for (const batch of [false, true]) {
  const mode = batch ? 'batch' : 'single';
  for (const status of [400, 429, 500, 503]) {
    test(`single attempt preserves HTTP metadata on first ${mode} call (${status})`, async (t) => {
      let calls = 0;
      t.mock.method(
        globalThis,
        'fetch',
        async (url: URL | Request | string) => {
          if (String(url).endsWith('/api/show')) return Response.json({});
          calls++;
          return new Response('failure', {
            status,
            headers: { 'Retry-After': '1.25' },
          });
        },
      );
      const records: Extract<UsageInput, { kind: 'embedding.call' }>[] = [];
      const usage: IUsageRecorder = {
        record: (r) => {
          if (r.kind === 'embedding.call') records.push(r);
        },
        with: () => usage,
      };
      const provider = new OllamaEmbedder({
        model: 'test',
        usage,
      });
      await assert.rejects(
        batch ? provider.embedBatch(['q']) : provider.embed('q'),
        (error) => {
          assert.ok(error instanceof RagError);
          assert.ok('status' in error);
          assert.equal(error.status, status);
          assert.ok('retryAfterSeconds' in error);
          assert.equal(error.retryAfterSeconds, 1.25);
          assert.ok('headers' in error && error.headers instanceof Headers);
          assert.equal(error.headers.get('retry-after'), '1.25');
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.equal(records.length, 1);
      assert.equal(records[0].outcome, 'error');
    });
  }
  test(`single attempt preserves network error identity for ${mode}`, async (t) => {
    let calls = 0;
    const error = new TypeError('network failure');
    t.mock.method(globalThis, 'fetch', async (url: URL | Request | string) => {
      if (String(url).endsWith('/api/show')) return Response.json({});
      calls++;
      throw error;
    });
    const provider = new OllamaEmbedder({ model: 'test' });
    await assert.rejects(
      batch ? provider.embedBatch(['q']) : provider.embed('q'),
      (actual) => actual === error,
    );
    assert.equal(calls, 1);
  });
  test(`single attempt rejects invalid responses immediately for ${mode}`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url: URL | Request | string) => {
      if (String(url).endsWith('/api/show')) return Response.json({});
      calls++;
      return Response.json({});
    });
    const provider = new OllamaEmbedder({ model: 'test' });
    await assert.rejects(
      batch ? provider.embedBatch(['q']) : provider.embed('q'),
    );
    assert.equal(calls, 1);
  });
  test(`composed ${mode} provider handles 429 beyond legacy retry limits`, async (t) => {
    t.after(resetQuotaGates);
    let calls = 0;
    const records: Extract<UsageInput, { kind: 'embedding.call' }>[] = [];
    const usage: IUsageRecorder = {
      record: (r) => {
        if (r.kind === 'embedding.call') records.push(r);
      },
      with: () => usage,
    };
    t.mock.method(globalThis, 'fetch', async (url: URL | Request | string) => {
      if (String(url).endsWith('/api/show')) return Response.json({});
      if (++calls <= 12)
        return new Response('quota', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      return Response.json({ embeddings: [[1]] });
    });
    const embedder = composeResilientEmbedder(
      new OllamaEmbedder({ model: 'test', usage }),
      {
        retry: false,
        throttle: {
          key: `ollama-${mode}`,
          strategy: new WaitAsTold({ fallbackBackoffMs: 2000 }),
        },
      },
    );
    assert.ok(isBatchEmbedder(embedder));
    const result = batch
      ? await embedder.embedBatch(['q'])
      : [await embedder.embed('q')];
    assert.deepEqual(
      result.map((r) => r.vector),
      [[1]],
    );
    assert.equal(calls, 13);
    assert.equal(records.length, 13);
    assert.equal(new Set(records.map((r) => r.operationId)).size, 1);
    assert.deepEqual(
      records.map((r) => r.outerAttempt),
      Array.from({ length: 13 }, (_, i) => i),
    );
    assert.ok(records.every((r) => r.providerAttempt === 0));
  });
}

test('provider parses HTTP-date and missing Retry-After', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  for (const raw of ['Thu, 01 Jan 2026 00:00:03 GMT', '', 'invalid']) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('', { status: 429, headers: { 'Retry-After': raw } }),
    );
    const provider = new OllamaEmbedder({ model: 'test' });
    await assert.rejects(provider.embed('q'), (error) => {
      assert.ok(error instanceof RagError && 'retryAfterSeconds' in error);
      assert.equal(
        error.retryAfterSeconds,
        raw.startsWith('Thu') ? 3 : undefined,
      );
      return true;
    });
  }
});
