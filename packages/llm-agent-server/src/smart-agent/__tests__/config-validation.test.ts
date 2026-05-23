import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { resolveSmartServerConfig, YAML_TEMPLATE } from '../config.js';

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

    // absent model must be a hard error — not silently defaulted to 'deepseek-chat'
    assert.throws(
      () => resolveSmartServerConfig({}, { llm: { provider: 'ollama' } }, {}),
      /llm\.model.*required/i,
    );
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

describe('config validation — fail loud, human-readable', () => {
  const base = (llm: Record<string, unknown>) => ({ llm });

  it('flat schema requires explicit provider', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, base({ apiKey: 'k', model: 'm' }), {}),
      /provider.*required|one of: openai, anthropic, deepseek, sap-ai-sdk, ollama/i,
    );
  });

  it('rejects an unknown provider value', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          base({ provider: 'cohere', model: 'm' }),
          {},
        ),
      /provider.*(invalid|one of: openai, anthropic, deepseek, sap-ai-sdk, ollama)/i,
    );
  });

  it('openai requires a resolvable apiKey', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          base({ provider: 'openai', model: 'gpt-4o' }),
          {},
        ),
      /openai requires.*apiKey/i,
    );
  });

  it('ollama needs no apiKey', () => {
    const cfg = resolveSmartServerConfig(
      {},
      base({ provider: 'ollama', model: 'qwen2.5:14b' }),
      {},
    );
    assert.equal(cfg.llm.provider, 'ollama');
  });

  it('sap-ai-sdk requires AICORE_SERVICE_KEY', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          base({ provider: 'sap-ai-sdk', model: 'gpt-4o' }),
          {},
        ),
      /sap-ai-sdk requires.*AICORE_SERVICE_KEY/i,
    );
  });

  it('mcp.type: http requires mcp.url', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, mcp: { type: 'http' } },
          {},
        ),
      /mcp\.url.*required/i,
    );
  });

  it('rejects an invalid mcp.type', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, mcp: { type: 'grpc' } },
          {},
        ),
      /mcp\.type.*invalid/i,
    );
  });

  it('mcp.type: stdio requires mcp.command', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, mcp: { type: 'stdio' } },
          {},
        ),
      /mcp\.command.*required/i,
    );
  });

  it('rag block requires rag.type', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, rag: { url: 'http://x' } },
          {},
        ),
      /rag\.type.*required/i,
    );
  });

  it('rag.type ollama requires url and model', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, rag: { type: 'ollama' } },
          {},
        ),
      /rag\.(url|model).*required/i,
    );
  });

  it('accepts a valid pipeline schema config', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        pipeline: {
          llm: {
            main: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' },
          },
        },
      },
      {},
    );
    assert.ok(cfg);
  });

  it('pipeline schema: missing provider reports the pipeline path', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { pipeline: { llm: { main: { apiKey: 'sk-x', model: 'gpt-4o' } } } },
          {},
        ),
      /pipeline\.llm\.main\.provider.*required/i,
    );
  });
});

describe('first-run YAML template', () => {
  it('passes validation once the apiKey env is filled', () => {
    // Mirrors first-run UX: template is generated, user fills DEEPSEEK_API_KEY.
    const filled = YAML_TEMPLATE.replace(/\$\{DEEPSEEK_API_KEY\}/g, 'sk-test');
    const cfg = resolveSmartServerConfig({}, parse(filled), {});
    assert.equal(cfg.llm.provider, 'deepseek');
    assert.ok(cfg.llm.apiKey);
  });
});
