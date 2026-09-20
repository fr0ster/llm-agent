import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OpenAIProvider } from '../openai-provider.js';

// ---------------------------------------------------------------------------
// Task B1 removed `apiKey` from `LLMProviderConfig`; each provider now
// declares its own `credential`, resolved in the request path rather than the
// constructor. `OpenAIProvider` puts the secret on the wire through its own
// header assembly on an axios instance (not through a per-request hook on an
// SDK client) — Step 1 found no OpenAI SDK here, only `axios.create()` with a
// header object. axios's Node adapter is `http`, not `fetch` (confirmed by
// reading `node_modules/axios/lib/adapters/adapters.js`: the default order is
// `['xhr', 'http', 'fetch']` and only `http` reports itself supported under
// Node), so — unlike the plan's sketch, which mocks `globalThis.fetch` —
// these tests stub `client.post` the same way every other test in this
// package's suite already does, and read the `Authorization` header off the
// captured request config.
// ---------------------------------------------------------------------------

describe('OpenAIProvider credential', () => {
  it('presents a freshly asked secret on EVERY request', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-${++n}`,
    };
    const p = new OpenAIProvider({
      credential: rotating,
      model: 'gpt-4o-mini',
    });
    // @ts-expect-error — stub axios for test
    p.client.post = async (
      _url: string,
      _body: unknown,
      config?: { headers?: Record<string, string> },
    ) => {
      seen.push(config?.headers?.Authorization);
      return {
        data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
      };
    };
    await p.chat([{ role: 'user', content: 'a' }]);
    await p.chat([{ role: 'user', content: 'b' }]);
    assert.deepEqual(
      seen,
      ['Bearer sk-1', 'Bearer sk-2'],
      'a secret resolved once at construction would be identical here',
    );
  });

  it('accepts a static key through the conversion, so a call site is one line', async () => {
    const p = new OpenAIProvider({
      credential: staticApiKey('sk-static'),
      model: 'm',
    });
    assert.ok(p);
  });

  it('refuses to construct with no credential at all', () => {
    // @ts-expect-error a provider that cannot authenticate is not constructible
    assert.throws(() => new OpenAIProvider({ model: 'm' }));
  });

  // Fix round 1, review finding 6: `chat()` was the only call site with an
  // auth assertion. `authHeader()` is awaited into `streamChat()`,
  // `getModels()` and `getEmbeddingModels()` too — this pins the two the
  // review named.

  it('presents a freshly asked secret on EVERY streamChat() call too', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-${++n}`,
    };
    const p = new OpenAIProvider({
      credential: rotating,
      model: 'gpt-4o-mini',
    });
    // @ts-expect-error — stub axios for test
    p.client.post = async (
      _url: string,
      _body: unknown,
      config?: { headers?: Record<string, string> },
    ) => {
      seen.push(config?.headers?.Authorization);
      return { data: (async function* () {})() };
    };
    for await (const _c of p.streamChat([{ role: 'user', content: 'a' }])) {
      // drain
    }
    for await (const _c of p.streamChat([{ role: 'user', content: 'b' }])) {
      // drain
    }
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2']);
  });

  it('presents a freshly asked secret on EVERY getModels() call too', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-${++n}`,
    };
    const p = new OpenAIProvider({
      credential: rotating,
      model: 'gpt-4o-mini',
    });
    // @ts-expect-error — stub axios for test
    p.client.get = async (
      _url: string,
      config?: { headers?: Record<string, string> },
    ) => {
      seen.push(config?.headers?.Authorization);
      return { data: { data: [] } };
    };
    await p.getModels();
    await p.getModels();
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2']);
  });
});
