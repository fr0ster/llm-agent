import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import {
  type CredentialEntry,
  DEFAULT_LLM_REF,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';
import { createMakeLlm, type LlmProviderCtors } from '../make-llm.js';

const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };

function harness(entries: Record<string, CredentialEntry>) {
  const seen: Array<{ provider: string; cfg: Record<string, unknown> }> = [];
  const fake = (provider: string) =>
    class {
      readonly model: string;
      constructor(cfg: Record<string, unknown>) {
        seen.push({ provider, cfg });
        this.model = String(cfg.model ?? 'unset');
      }
      async chat() {
        return { content: '' };
      }
      async *streamChat() {}
    };
  const ctors = {
    openai: fake('openai'),
    anthropic: fake('anthropic'),
    deepseek: fake('deepseek'),
    ollama: fake('ollama'),
    'sap-ai-sdk': fake('sap-ai-sdk'),
  } as unknown as LlmProviderCtors;
  const makeLlm = createMakeLlm(
    createLookup(memoizeCredentials((r) => entries[r])),
    ctors,
  );
  return { seen, makeLlm };
}

describe('makeLlm (§8 item 4)', () => {
  it('each keyed provider gets an api-key credential, and the knobs arrive', async () => {
    const cred = staticApiKey('k');
    const { seen, makeLlm } = harness({
      [DEFAULT_LLM_REF]: { credential: cred },
    });
    for (const provider of ['openai', 'anthropic', 'deepseek'] as const) {
      const llm = await makeLlm({
        provider,
        model: 'm',
        url: 'https://gw',
        temperature: 0.2,
        maxTokens: 99,
      });
      assert.equal(llm.model, 'm');
    }
    for (const { cfg } of seen) {
      assert.equal(cfg.credential, cred);
      assert.equal(cfg.baseURL, 'https://gw');
      assert.equal(cfg.temperature, 0.2);
      assert.equal(cfg.maxTokens, 99);
    }
  });

  it('a bearer handed to an api-key provider is refused, naming the ref', async () => {
    const { makeLlm } = harness({
      AICORE: { credential: bearer, apiBaseUrl: 'https://a' },
    });
    await assert.rejects(
      () =>
        makeLlm({ provider: 'openai', model: 'm', credentialRef: 'AICORE' }),
      /credentialRef 'AICORE' must hold a api-key credential for openai, got bearer/,
    );
  });

  it('sap-ai-sdk takes BOTH halves from the entry: bearer and apiBaseUrl', async () => {
    const { seen, makeLlm } = harness({
      AICORE_A: { credential: bearer, apiBaseUrl: 'https://a' },
      NO_URL: { credential: bearer },
    });
    await makeLlm({
      provider: 'sap-ai-sdk',
      model: 'm',
      credentialRef: 'AICORE_A',
    });
    assert.equal(seen[0]?.cfg.credential, bearer);
    assert.equal(seen[0]?.cfg.apiBaseUrl, 'https://a');
    await assert.rejects(
      () =>
        makeLlm({
          provider: 'sap-ai-sdk',
          model: 'm',
          credentialRef: 'NO_URL',
        }),
      /must carry an apiBaseUrl/,
    );
  });

  it('ollama: no credential unless a ref NAMES one — the default key is never sent there', async () => {
    const def = staticApiKey('deployment-default');
    const gw = staticApiKey('gateway');
    const { seen, makeLlm } = harness({
      [DEFAULT_LLM_REF]: { credential: def },
      GATEWAY: { credential: gw },
    });
    await makeLlm({ provider: 'ollama', model: 'm' });
    await makeLlm({ provider: 'ollama', model: 'm', credentialRef: 'GATEWAY' });
    assert.equal('credential' in (seen[0]?.cfg ?? {}), false);
    assert.equal(seen[1]?.cfg.credential, gw);
  });

  it('the ref ends in the root: no provider config carries credentialRef', async () => {
    const { seen, makeLlm } = harness({
      K: { credential: staticApiKey('k') },
      S: { credential: bearer, apiBaseUrl: 'https://a' },
    });
    await makeLlm({ provider: 'openai', model: 'm', credentialRef: 'K' });
    await makeLlm({ provider: 'anthropic', model: 'm', credentialRef: 'K' });
    await makeLlm({ provider: 'deepseek', model: 'm', credentialRef: 'K' });
    await makeLlm({ provider: 'ollama', model: 'm', credentialRef: 'K' });
    await makeLlm({ provider: 'sap-ai-sdk', model: 'm', credentialRef: 'S' });
    assert.equal(seen.length, 5);
    for (const { provider, cfg } of seen) {
      assert.equal('credentialRef' in cfg, false, provider);
    }
  });
});
