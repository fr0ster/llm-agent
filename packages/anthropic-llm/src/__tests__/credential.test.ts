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
// package's suite uses; `anthropic-provider.test.ts` covers the fetch path.
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
});
