import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WaitAsTold } from '@mcp-abap-adt/llm-agent';
import { type MakeLlmConfig, makeLlm } from '../providers.js';

/**
 * 22.2.0 shipped a per-provider rate-limit policy and no way to set it through
 * the composition root (#285): `MakeLlmConfig` had no `whenThrottled`, so every
 * consumer on this path silently ran the defaults. These tests assert the field
 * actually arrives at the provider, which is the part that was missing.
 *
 * Reaching the provider means going through the bridge the adapter holds.
 * `private` is compile-time only, and the alternative — asserting on timing
 * through a stubbed transport — would test the policy rather than the wiring.
 */
function policyOf(llm: unknown): { name?: string } | undefined {
  const bridge = (llm as { agent?: unknown }).agent as
    | { provider?: { config?: { whenThrottled?: { name?: string } } } }
    | undefined;
  return bridge?.provider?.config?.whenThrottled;
}

const POLICY = new WaitAsTold({ maxAttempts: 2 });

const CASES: Array<{ name: string; cfg: MakeLlmConfig }> = [
  {
    name: 'openai',
    cfg: { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' },
  },
  {
    name: 'deepseek',
    cfg: { provider: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' },
  },
  {
    name: 'ollama',
    cfg: { provider: 'ollama', model: 'llama3' },
  },
  {
    name: 'anthropic',
    cfg: {
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: 'claude-3-5-sonnet-20241022',
    },
  },
  {
    name: 'sap-ai-sdk',
    cfg: { provider: 'sap-ai-sdk', model: 'anthropic--claude-4.5-sonnet' },
  },
];

describe('makeLlm — the rate-limit policy reaches the provider', () => {
  for (const { name, cfg } of CASES) {
    it(`forwards it for ${name}`, async () => {
      const llm = await makeLlm({ ...cfg, whenThrottled: POLICY }, 0.1);
      assert.equal(
        policyOf(llm)?.name,
        'wait-as-told',
        `${name} built a provider without the configured strategy`,
      );
    });

    it(`leaves ${name} on the documented defaults when omitted`, async () => {
      const llm = await makeLlm(cfg, 0.1);
      assert.equal(policyOf(llm), undefined);
    });
  }
});
