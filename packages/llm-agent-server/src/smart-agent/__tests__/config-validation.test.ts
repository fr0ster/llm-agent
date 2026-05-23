import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmartServerConfig } from '../config.js';

describe('resolveSmartServerConfig — flat llm provider/url', () => {
  it('reads provider and url from YAML', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm: {
          provider: 'ollama',
          model: 'qwen2.5:14b',
          url: 'http://h:11434/v1',
          // dummy apiKey so the legacy 'API key required' guard does not fire
          // (Task 6 replaces that guard with provider-aware validation).
          apiKey: 'x',
        },
      },
      {},
    );
    assert.equal(cfg.llm.provider, 'ollama');
    assert.equal(cfg.llm.url, 'http://h:11434/v1');
    assert.equal(cfg.llm.model, 'qwen2.5:14b');
  });

  it('does not invent a deepseek-chat model default', () => {
    const explicit = resolveSmartServerConfig(
      {},
      { llm: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' } },
      {},
    );
    assert.equal(explicit.llm.model, 'gpt-4o');

    const absent = resolveSmartServerConfig(
      {},
      { llm: { provider: 'ollama', apiKey: 'x' } },
      {},
    );
    assert.equal(absent.llm.model, undefined);
  });
});
