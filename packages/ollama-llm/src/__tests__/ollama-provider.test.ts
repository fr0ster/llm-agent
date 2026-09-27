import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { OllamaProvider } from '../ollama-provider.js';

describe('OllamaProvider', () => {
  it('constructs without an apiKey (Ollama ignores it)', () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.equal(p.model, 'qwen2.5:14b');
  });

  it('accepts an explicit baseURL', () => {
    const p = new OllamaProvider({
      model: 'llama3',
      baseURL: 'http://ollama.internal:11434/v1',
    });
    assert.equal(p.model, 'llama3');
  });

  it('uses default baseURL when none is provided', () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.equal(p.client.defaults.baseURL, 'http://localhost:11434/v1');
  });

  it('reports no embedding models', async () => {
    const p = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.deepEqual(await p.getEmbeddingModels(), []);
  });
});

// ---------------------------------------------------------------------------
// Behaviour change (fix round 1, review finding 4): before this task, a
// provider with no configured key still sent a header — a dummy
// `Authorization: Bearer ollama`, needed only because the OpenAI SDK this
// class no longer goes through demanded a non-empty value. Now the header is
// present only when a credential is actually configured. These two pin that
// contract directly (credential.test.ts covers the per-request-freshness
// angle; this is the plain "is the header there or not" regression guard the
// gateway case in the CHANGELOG depends on).
// ---------------------------------------------------------------------------

describe('OllamaProvider — Authorization header depends on whether a credential is configured', () => {
  it('with a credential: the header carries the resolved secret', async () => {
    const p = new OllamaProvider({
      credential: staticApiKey('sk-ollama'),
      model: 'qwen2.5:14b',
    });
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
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(sentHeaders?.Authorization, 'Bearer sk-ollama');
  });

  it('without a credential: no Authorization header is sent — NOT a dummy value', async () => {
    // Before this task this sent `Authorization: Bearer ollama`
    // unconditionally. It no longer does, which is a real behaviour change
    // for an Ollama instance behind a gateway that checks auth — see the
    // CHANGELOG.
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
    await p.chat([{ role: 'user', content: 'hi' }]);
    assert.equal('Authorization' in (sentHeaders ?? {}), false);
  });
});

// ---------------------------------------------------------------------------
// Quota isolation (fix round 1, review finding 5): same rationale as
// deepseek-llm's equivalent block — OllamaProvider has no quotaCredential()
// override of its own, only the inherited one, reached by forwarding
// `credential` through `super({ ...config })`. Nothing pinned that
// forwarding before; this does.
// ---------------------------------------------------------------------------

describe('OllamaProvider — quota isolation is per credential (inherited from OpenAIProvider)', () => {
  it('two distinct credentials are two distinct quota buckets', () => {
    // @ts-expect-error — protected hook, read for test
    const keyOf = (p: OllamaProvider) => p.quotaKey() as string;
    const a = new OllamaProvider({
      credential: staticApiKey('sk-ollama-a'),
      model: 'qwen2.5:14b',
    });
    const b = new OllamaProvider({
      credential: staticApiKey('sk-ollama-b'),
      model: 'qwen2.5:14b',
    });
    assert.notEqual(keyOf(a), keyOf(b));
  });

  it('the same credential object is one shared quota bucket', () => {
    // @ts-expect-error — protected hook, read for test
    const keyOf = (p: OllamaProvider) => p.quotaKey() as string;
    const cred = staticApiKey('sk-ollama-shared');
    const a = new OllamaProvider({ credential: cred, model: 'qwen2.5:14b' });
    const b = new OllamaProvider({ credential: cred, model: 'qwen2.5:14b' });
    assert.equal(keyOf(a), keyOf(b));
  });

  it('no credential at all is its own (shared, "anonymous") bucket', () => {
    // @ts-expect-error — protected hook, read for test
    const keyOf = (p: OllamaProvider) => p.quotaKey() as string;
    const a = new OllamaProvider({ model: 'qwen2.5:14b' });
    const b = new OllamaProvider({ model: 'qwen2.5:14b' });
    assert.equal(keyOf(a), keyOf(b));
  });
});
