import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { AnthropicProvider } from '../anthropic-provider.js';

// ---------------------------------------------------------------------------
// Same contract as openai-llm's credential.test.ts. `AnthropicProvider` also
// puts the secret on the wire through its own header assembly, not an SDK
// client: `chat()` runs on an axios instance (headers built here, per
// request); `streamChat()` already ran on raw `fetch()` before this task, for
// the reason recorded in that method's own comment (the shared throttle
// policy needs a `Headers`-shaped `response.headers` to read `Retry-After`
// from, which fetch's `Response` gives it directly). This file exercises the
// axios path with the same `client.post` stub every other test in this
// package's suite uses.
//
// Fix round 1, review finding 6: this comment previously claimed
// `anthropic-provider.test.ts` covers the fetch path's auth header. It does
// not — its `globalThis.fetch` mocks exist for retry/abort-signal behaviour
// and never read `init.headers['x-api-key']`. `streamChat()`'s fetch call is
// also the one place the resolution's SHAPE changed (`this.config.apiKey ??
// ''`, synchronous, became `await this.config.credential.secret()`), so it
// gets its own per-request-freshness test below, the same shape as the
// `chat()` one above.
// ---------------------------------------------------------------------------

describe('AnthropicProvider credential', () => {
  it('presents a freshly asked secret on EVERY request', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-ant-${++n}`,
    };
    const p = new AnthropicProvider({
      credential: rotating,
      model: 'claude-3-5-sonnet-20241022',
    });
    // @ts-expect-error — stub axios for test
    p.client.post = async (
      _url: string,
      _body: unknown,
      config?: { headers?: Record<string, string> },
    ) => {
      seen.push(config?.headers?.['x-api-key']);
      return {
        data: {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        },
      };
    };
    await p.chat([{ role: 'user', content: 'a' }]);
    await p.chat([{ role: 'user', content: 'b' }]);
    assert.deepEqual(
      seen,
      ['sk-ant-1', 'sk-ant-2'],
      'a secret resolved once at construction would be identical here',
    );
  });

  it('accepts a static key through the conversion, so a call site is one line', async () => {
    const p = new AnthropicProvider({
      credential: staticApiKey('sk-ant-static'),
      model: 'claude-3-5-sonnet-20241022',
    });
    assert.ok(p);
  });

  it('refuses to construct with no credential at all', () => {
    assert.throws(
      () =>
        // @ts-expect-error a provider that cannot authenticate is not constructible
        new AnthropicProvider({ model: 'claude-3-5-sonnet-20241022' }),
    );
  });

  it('presents a freshly asked secret on EVERY streamChat() call — the fetch path', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-ant-${++n}`,
    };
    const p = new AnthropicProvider({
      credential: rotating,
      model: 'claude-3-5-sonnet-20241022',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push(headers?.['x-api-key']);
      // Anthropic's own end of stream: `data: [DONE]` is OpenAI's marker, and
      // a data line that is not JSON is now an error (spec §10.5.6 L6).
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      for await (const _c of p.streamChat([{ role: 'user', content: 'a' }])) {
        // drain
      }
      for await (const _c of p.streamChat([{ role: 'user', content: 'b' }])) {
        // drain
      }
      assert.deepEqual(
        seen,
        ['sk-ant-1', 'sk-ant-2'],
        'a secret resolved once at construction would be identical here',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('presents a freshly asked secret on EVERY getModels() call too', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-ant-${++n}`,
    };
    const p = new AnthropicProvider({
      credential: rotating,
      model: 'claude-3-5-sonnet-20241022',
    });
    // @ts-expect-error — stub axios for test
    p.client.get = async (
      _url: string,
      config?: { headers?: Record<string, string> },
    ) => {
      seen.push(config?.headers?.['x-api-key']);
      return { data: { data: [] } };
    };
    await p.getModels();
    await p.getModels();
    assert.deepEqual(seen, ['sk-ant-1', 'sk-ant-2']);
  });
});
