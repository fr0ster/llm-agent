import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { DeepSeekProvider } from '../deepseek-provider.js';

// ---------------------------------------------------------------------------
// DeepSeekProvider extends OpenAIProvider and forwards its config verbatim
// through `super({ ...config })` (see deepseek-provider.ts), so it puts the
// secret on the wire exactly the way OpenAIProvider does: its own header
// assembly on an axios instance, resolved per request — no SDK client, no
// per-request hook of its own to find or forward.
// ---------------------------------------------------------------------------

describe('DeepSeekProvider credential', () => {
  it('presents a freshly asked secret on EVERY request', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-deep-${++n}`,
    };
    const p = new DeepSeekProvider({
      credential: rotating,
      model: 'deepseek-chat',
    });
    // @ts-expect-error — stub axios for test
    p.client.post = async (
      _url: string,
      _body: unknown,
      config?: { headers?: Record<string, string> },
    ) => {
      seen.push(config?.headers?.Authorization);
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await p.chat([{ role: 'user', content: 'a' }]);
    await p.chat([{ role: 'user', content: 'b' }]);
    assert.deepEqual(
      seen,
      ['Bearer sk-deep-1', 'Bearer sk-deep-2'],
      'a secret resolved once at construction would be identical here',
    );
  });

  it('accepts a static key through the conversion, so a call site is one line', async () => {
    const p = new DeepSeekProvider({
      credential: staticApiKey('sk-deep-static'),
      model: 'deepseek-chat',
    });
    assert.ok(p);
  });

  it('refuses to construct with no credential at all', () => {
    assert.throws(
      // @ts-expect-error a provider that cannot authenticate is not constructible
      () => new DeepSeekProvider({ model: 'deepseek-chat' }),
    );
  });
});
