import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OllamaProvider } from '../ollama-provider.js';

// ---------------------------------------------------------------------------
// OllamaProvider extends OpenAIProvider the same way DeepSeekProvider does,
// but its credential is OPTIONAL (see ollama-provider.ts): a local Ollama
// server ignores auth entirely, though a gateway placed in front of it may
// still require a key. So its third case, unlike the other three providers',
// asserts that construction SUCCEEDS with no credential at all.
// ---------------------------------------------------------------------------

describe('OllamaProvider credential', () => {
  it('presents a freshly asked secret on EVERY request, when one is configured', async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const rotating: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => `sk-ollama-${++n}`,
    };
    const p = new OllamaProvider({
      credential: rotating,
      model: 'qwen2.5:14b',
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
      ['Bearer sk-ollama-1', 'Bearer sk-ollama-2'],
      'a secret resolved once at construction would be identical here',
    );
  });

  it('accepts a static key through the conversion, so a call site is one line', async () => {
    const p = new OllamaProvider({
      credential: staticApiKey('sk-ollama-static'),
      model: 'qwen2.5:14b',
    });
    assert.ok(p);
  });

  it('constructs with no credential at all — Ollama ignores it locally', async () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    let sentHeaders: Record<string, string> | undefined;
    // @ts-expect-error — stub axios for test
    p.client.post = async (
      _url: string,
      _body: unknown,
      config?: { headers?: Record<string, string> },
    ) => {
      sentHeaders = config?.headers;
      return {
        data: {
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        },
      };
    };
    await p.chat([{ role: 'user', content: 'a' }]);
    assert.equal(
      sentHeaders?.Authorization,
      undefined,
      'no credential configured means no Authorization header sent',
    );
  });
});
