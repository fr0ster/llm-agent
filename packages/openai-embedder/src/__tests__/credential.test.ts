import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OpenAiEmbedder } from '../openai-embedder.js';

// ---------------------------------------------------------------------------
// Task B4 replaced `OpenAiEmbedderConfig.apiKey` with a required `credential`
// (`IApiKeyCredential`), asked for fresh on every request rather than held
// for the object's lifetime. Unlike the four LLM providers, this class talks
// to `fetch` directly (no axios instance to stub), so these tests mock
// `globalThis.fetch` and read the `Authorization` header off each captured
// call, the way `openai-embedder-timeout.test.ts` already does for `signal`.
// ---------------------------------------------------------------------------

describe('OpenAiEmbedder credential', () => {
  it('asks per request, so a rotated secret rotates', async () => {
    const seen: Array<string | null> = [];
    let n = 0;
    const credential: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-${++n}`,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(JSON.stringify({ data: [{ embedding: [0, 0] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const e = new OpenAiEmbedder({
        model: 'text-embedding-3-small',
        credential,
      });
      await e.embed('a');
      await e.embed('b');
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2']);
  });

  it('asks per request on embedBatch() too', async () => {
    const seen: Array<string | null> = [];
    let n = 0;
    const credential: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-${++n}`,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(
        JSON.stringify({ data: [{ embedding: [0, 0], index: 0 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const e = new OpenAiEmbedder({
        model: 'text-embedding-3-small',
        credential,
      });
      await e.embedBatch(['a']);
      await e.embedBatch(['b']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2']);
  });

  it('accepts a static key through the conversion, so a call site is one line', async () => {
    const e = new OpenAiEmbedder({
      model: 'text-embedding-3-small',
      credential: staticApiKey('sk-static'),
    });
    assert.ok(e);
  });

  it('still throws when it has no credential, with the message its existing test asserts', () => {
    assert.throws(
      // @ts-expect-error no credential configured
      () => new OpenAiEmbedder({ model: 'm' }),
      /API key is required/,
    );
  });
});
