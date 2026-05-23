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

  it('rag.type ollama is rejected with a migration hint', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, rag: { type: 'ollama' } },
          {},
        ),
      /rag\.type.*embedder, not a store/i,
    );
  });

  it('rag.type qdrant requires url', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'ollama', model: 'm' }, rag: { type: 'qdrant' } },
          {},
        ),
      /rag\.url.*required.*qdrant/i,
    );
  });

  it('rag.type in-memory needs nothing', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'ollama', model: 'm' }, rag: { type: 'in-memory' } },
      {},
    );
    assert.equal(cfg.rag?.type, 'in-memory');
  });

  it('rag.embedder deepseek is rejected (no embedder)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { type: 'in-memory', embedder: 'deepseek' },
          },
          {},
        ),
      /rag\.embedder.*no embedder/i,
    );
  });

  it('rag.type hana-vector requires collectionName', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { type: 'hana-vector' },
          },
          {},
        ),
      /rag\.collectionName.*required.*hana-vector/i,
    );
  });

  it('rag.type pg-vector requires collectionName', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { type: 'pg-vector' },
          },
          {},
        ),
      /rag\.collectionName.*required.*pg-vector/i,
    );
  });

  it('rag.embedder anthropic is rejected (no embedder)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { type: 'in-memory', embedder: 'anthropic' },
          },
          {},
        ),
      /rag\.embedder.*no embedder/i,
    );
  });

  it('pipeline.rag store with type ollama is rejected with path + hint', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            pipeline: {
              llm: {
                main: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' },
              },
              rag: { tools: { type: 'ollama' } },
            },
          },
          {},
        ),
      /pipeline\.rag\.tools\.type.*embedder, not a store/i,
    );
  });

  it('pipeline.rag qdrant store without url is rejected with path', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            pipeline: {
              llm: {
                main: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' },
              },
              rag: { tools: { type: 'qdrant' } },
            },
          },
          {},
        ),
      /pipeline\.rag\.tools\.url.*required/i,
    );
  });

  it('accepts a valid pipeline.rag store', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        pipeline: {
          llm: {
            main: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' },
          },
          rag: { tools: { type: 'in-memory' } },
        },
      },
      {},
    );
    assert.ok(cfg);
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

  it('omitted rag block leaves rag undefined (RAG disabled)', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'ollama', model: 'm' } },
      {},
    );
    assert.equal(cfg.rag, undefined);
  });

  it('a present rag block is still resolved', () => {
    const cfg = resolveSmartServerConfig(
      {},
      { llm: { provider: 'ollama', model: 'm' }, rag: { type: 'in-memory' } },
      {},
    );
    assert.equal(cfg.rag?.type, 'in-memory');
  });

  it('pipeline main openai without apiKey is rejected even if a flat llm.apiKey exists', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: {
              provider: 'deepseek',
              apiKey: 'flat-key',
              model: 'deepseek-chat',
            },
            pipeline: {
              llm: { main: { provider: 'openai', model: 'gpt-4o' } },
            },
          },
          {},
        ),
      /openai requires pipeline\.llm\.main\.apiKey/i,
    );
  });

  it('pipeline classifier with an invalid provider is rejected', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            pipeline: {
              llm: {
                main: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' },
                classifier: { provider: 'cohere', model: 'c' },
              },
            },
          },
          {},
        ),
      /pipeline\.llm\.classifier\.provider.*invalid/i,
    );
  });

  it('pipeline helper missing its apiKey is rejected', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            pipeline: {
              llm: {
                main: { provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o' },
                helper: { provider: 'anthropic', model: 'claude' },
              },
            },
          },
          {},
        ),
      /anthropic requires pipeline\.llm\.helper\.apiKey/i,
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
