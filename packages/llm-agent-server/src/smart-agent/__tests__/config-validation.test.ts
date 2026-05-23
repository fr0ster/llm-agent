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

describe('resolveSmartServerConfig — no silent env/default fallbacks', () => {
  it('does not read DEEPSEEK_API_KEY / OLLAMA_URL / MCP_ENDPOINT from env', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' } },
      {
        DEEPSEEK_API_KEY: 'env-key',
        OLLAMA_URL: 'http://env-host:11434',
        MCP_ENDPOINT: 'http://env-mcp/mcp',
      } as NodeJS.ProcessEnv,
    );
    assert.equal(cfg.llm.apiKey, 'sk-x'); // not 'env-key'
    assert.equal(cfg.rag?.url, undefined); // not the env value
    assert.equal(cfg.mcp?.url, undefined); // no mcp block in YAML → env ignored
  });
});
