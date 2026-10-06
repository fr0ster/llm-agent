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
      { llm: { provider: 'openai', model: 'gpt-4o' } },
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
      { llm: { provider: 'openai', model: 'gpt-4o', credentialRef: 'OPENAI' } },
      {
        DEEPSEEK_API_KEY: 'env-key',
        OLLAMA_URL: 'http://env-host:11434',
        MCP_ENDPOINT: 'http://env-mcp/mcp',
      } as NodeJS.ProcessEnv,
    );
    assert.equal(
      (cfg.llm as { credentialRef?: string }).credentialRef,
      'OPENAI',
    ); // not an env value
    assert.equal(cfg.rag, undefined); // no rag block in YAML
    assert.equal(cfg.mcp?.url, undefined); // no mcp block in YAML → env ignored
  });
});

describe('config validation — fail loud, human-readable', () => {
  const base = (llm: Record<string, unknown>) => ({ llm });

  it('flat schema requires explicit provider', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, base({ model: 'm' }), {}),
      // Spec D83 (12): without a provider the block is read as a map of roles,
      // and its `model` role is not a mapping.
      /llm\.model must be a mapping, got "m"/,
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

  it('openai needs no key in configuration', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        base({ provider: 'openai', model: 'gpt-4o' }),
        {},
      ),
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

  it('sap-ai-sdk needs no AICORE_SERVICE_KEY here — only the composition root reads it', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        base({ provider: 'sap-ai-sdk', model: 'gpt-4o' }),
        {},
      ),
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
      /mcp\.type must be one of http, stdio, none, got "grpc"/,
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

  it('rag block requires rag.store', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { store: { url: 'http://x' } },
          },
          {},
        ),
      /rag\.store\.type.*required/i,
    );
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { embedder: { provider: 'ollama', model: 'm' } },
          },
          {},
        ),
      /rag\.store: required/,
    );
  });

  it('rag.store.type ollama is rejected with a migration hint', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { store: { type: 'ollama' } },
          },
          {},
        ),
      /rag\.store\.type.*embedder, not a store/i,
    );
  });

  it('rag.store.type qdrant requires url', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { store: { type: 'qdrant' } },
          },
          {},
        ),
      /rag\.store\.url.*required.*qdrant/i,
    );
  });

  it('rag.store.type in-memory needs nothing', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm: { provider: 'ollama', model: 'm' },
        rag: { store: { type: 'in-memory' } },
      },
      {},
    );
    assert.equal(cfg.rag?.store.type, 'in-memory');
  });

  it('rag.embedder.provider deepseek is rejected (no embedder)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: {
              store: { type: 'in-memory' },
              embedder: { provider: 'deepseek' },
            },
          },
          {},
        ),
      /rag\.embedder\.provider.*no embedder/i,
    );
  });

  it('rag.store.type hana-vector requires collectionName', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { store: { type: 'hana-vector' } },
          },
          {},
        ),
      /rag\.store\.collectionName.*required.*(hana|pg)-vector/i,
    );
  });

  it('rag.store.type pg-vector requires collectionName', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: { store: { type: 'pg-vector' } },
          },
          {},
        ),
      /rag\.store\.collectionName.*required.*(hana|pg)-vector/i,
    );
  });

  it('rag.embedder.provider anthropic is rejected (no embedder)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: {
              store: { type: 'in-memory' },
              embedder: { provider: 'anthropic' },
            },
          },
          {},
        ),
      /rag\.embedder\.provider.*no embedder/i,
    );
  });

  // Pipeline selection migrated to `pipeline: { name, config }`. The legacy
  // `pipeline.llm.*` / `pipeline.rag.*` overrides were removed; LLM/RAG now
  // derive solely from the top-level `llm:` / `rag:` blocks. The pipeline
  // plugin validates its own `config` dialect at build time, not here.

  it('accepts a string pipeline name (shorthand)', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm: { provider: 'openai', model: 'gpt-4o' },
        pipeline: 'stepper',
      },
      {},
    );
    assert.deepEqual(cfg.pipeline, { name: 'stepper' });
  });

  it('accepts a { name, config } pipeline object', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm: { provider: 'openai', model: 'gpt-4o' },
        pipeline: { name: 'dag', config: { planner: { type: 'dag' } } },
      },
      {},
    );
    assert.equal(cfg.pipeline?.name, 'dag');
    assert.deepEqual(cfg.pipeline?.config, { planner: { type: 'dag' } });
  });

  it('pipeline object without a name is rejected', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'openai', model: 'gpt-4o' },
            pipeline: { config: { foo: 1 } },
          },
          {},
        ),
      /pipeline: requires a 'name'/i,
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
      {
        llm: { provider: 'ollama', model: 'm' },
        rag: { store: { type: 'in-memory' } },
      },
      {},
    );
    assert.equal(cfg.rag?.store.type, 'in-memory');
  });

  it('rag block with embedder but no model is rejected', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: {
              store: { type: 'in-memory' },
              embedder: { provider: 'ollama' },
            },
          },
          {},
        ),
      /rag\.embedder\.model.*required/i,
    );
  });

  it('rag block with embedder and model passes', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm: { provider: 'ollama', model: 'm' },
        rag: {
          store: { type: 'in-memory' },
          embedder: { provider: 'ollama', model: 'bge-m3' },
        },
      },
      {},
    );
    assert.equal(cfg.rag?.store.type, 'in-memory');
  });

  it('bare in-memory rag (no embedder, no model) still passes (BM25)', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm: { provider: 'ollama', model: 'm' },
        rag: { store: { type: 'in-memory' } },
      },
      {},
    );
    assert.equal(cfg.rag?.store.type, 'in-memory');
  });

  it('qdrant rag without model is rejected', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: { provider: 'ollama', model: 'm' },
            rag: {
              store: {
                type: 'qdrant',
                url: 'http://localhost:6333',
                collectionName: 'test',
              },
            },
          },
          {},
        ),
      /rag\.embedder\.model.*required/i,
    );
  });
});

describe('validateResolvedConfig — llm map shape', () => {
  it('flat llm config still validates (backward-compat)', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        {
          llm: { provider: 'deepseek', model: 'm' },
          mode: 'smart',
        },
        {},
      ),
    );
  });

  it('map shape with main validates', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        {
          llm: {
            main: { provider: 'deepseek', model: 'm' },
            planner: { provider: 'openai', model: 'gpt' },
          },
          mode: 'smart',
        },
        {},
      ),
    );
  });

  it('map shape without main fails with a clear error', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: {
              planner: { provider: 'openai', model: 'gpt' },
            },
            mode: 'smart',
          },
          {},
        ),
      /llm\.main.*required/i,
    );
  });

  it("map's named entry with missing provider fails", () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: {
              main: { provider: 'deepseek', model: 'm' },
              planner: { model: 'gpt' },
            },
            mode: 'smart',
          },
          {},
        ),
      /llm\.planner\.provider.*required/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: top-level mcp: array form (the bug that caused Stepper server
// to get zero MCP tools — resolveSmartServerConfig was dropping array mcp).
// ---------------------------------------------------------------------------

describe('resolveSmartServerConfig — top-level mcp: array form', () => {
  const base = {
    llm: { provider: 'ollama', model: 'qwen2' },
  };

  it('preserves array mcp: as cfg.mcp (not silently undefined)', () => {
    const yaml = {
      ...base,
      mcp: [{ type: 'http', url: 'http://localhost:3003/mcp/stream/http' }],
    };
    const cfg = resolveSmartServerConfig({}, yaml, {});
    assert.ok(
      cfg.mcp !== undefined,
      'cfg.mcp must not be undefined when mcp: is an array in YAML',
    );
    assert.ok(
      Array.isArray(cfg.mcp),
      'cfg.mcp must be an array when YAML mcp: is an array',
    );
    const arr = cfg.mcp as Array<{ type: string; url?: string }>;
    assert.equal(arr.length, 1);
    assert.equal(arr[0].type, 'http');
    assert.equal(arr[0].url, 'http://localhost:3003/mcp/stream/http');
  });

  it('preserves multiple entries in array mcp:', () => {
    const yaml = {
      ...base,
      mcp: [
        { type: 'http', url: 'http://server1/mcp' },
        { type: 'http', url: 'http://server2/mcp' },
      ],
    };
    const cfg = resolveSmartServerConfig({}, yaml, {});
    assert.ok(Array.isArray(cfg.mcp));
    const arr = cfg.mcp as Array<{ url?: string }>;
    assert.equal(arr.length, 2);
    assert.equal(arr[0].url, 'http://server1/mcp');
    assert.equal(arr[1].url, 'http://server2/mcp');
  });

  it('still resolves single-object mcp: (backward compat)', () => {
    const yaml = {
      ...base,
      mcp: { type: 'http', url: 'http://localhost:3001/mcp' },
    };
    const cfg = resolveSmartServerConfig({}, yaml, {});
    assert.ok(cfg.mcp !== undefined);
    assert.ok(!Array.isArray(cfg.mcp));
    assert.equal(
      (cfg.mcp as { url?: string }).url,
      'http://localhost:3001/mcp',
    );
  });
});

describe('legacy coordinator:/pipeline: migration guard (clean break)', () => {
  const goodLlm = {
    provider: 'ollama',
    model: 'm',
    url: 'http://h',
  };

  it('throws on a legacy coordinator: block', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: goodLlm, coordinator: { mode: 'planned-react' } },
          {},
        ),
      /Legacy 'coordinator:' \/ 'pipeline:' config is no longer supported/,
    );
  });

  it('throws on a legacy pipeline: block (llm/rag/stages, no name)', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: goodLlm, pipeline: { llm: { main: goodLlm } } },
          {},
        ),
      /Migrate to: pipeline: \{ name:/,
    );
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: goodLlm, pipeline: { stages: [] } },
          {},
        ),
      /no longer supported/,
    );
  });

  it('accepts the new pipeline: { name, config } shape', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        {
          llm: goodLlm,
          pipeline: { name: 'stepper', config: { mode: 'planned-react' } },
        },
        {},
      ),
    );
  });

  it('accepts the bare-string pipeline shorthand', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig({}, { llm: goodLlm, pipeline: 'flat' }, {}),
    );
  });

  it('accepts no pipeline: block at all (defaults to flat)', () => {
    assert.doesNotThrow(() =>
      resolveSmartServerConfig({}, { llm: goodLlm }, {}),
    );
  });
});

describe('resolveSmartServerConfig — skillPlugins block', () => {
  const llm = { provider: 'ollama', model: 'm' };

  it('parses a minimal skillPlugins block into the normalized config', () => {
    const cfg = resolveSmartServerConfig(
      {},
      {
        llm,
        skillPlugins: {
          mode: 'implicit',
          store: { type: 'in-memory' },
          catalog: { type: 'in-process' },
          sources: [
            {
              id: 'src',
              records: [
                {
                  id: 'r1',
                  group: 'g1',
                  content: 'do A',
                  retrievalText: 'how to A',
                },
              ],
            },
          ],
        },
      },
      {},
    );
    assert.ok(cfg.skillPlugins);
    assert.equal(cfg.skillPlugins.mode, 'implicit');
    assert.equal(cfg.skillPlugins.store.type, 'in-memory');
    assert.equal(cfg.skillPlugins.catalog.type, 'in-process');
    // Defaults applied by the normalizer.
    assert.equal(cfg.skillPlugins.k, 4);
    assert.equal(cfg.skillPlugins.sources?.length, 1);
  });

  it('leaves skillPlugins undefined when the block is absent', () => {
    const cfg = resolveSmartServerConfig({}, { llm }, {});
    assert.equal(cfg.skillPlugins, undefined);
  });

  it('fail-loud propagates a skillPlugins parse error', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm, skillPlugins: { mode: 'explicit' } },
          {},
        ),
      /explicit.*not yet implemented/i,
    );
  });
});

describe('resolveSmartServerConfig — skipProviderRuntimeChecks option', () => {
  it('sap-ai-sdk with no AICORE_SERVICE_KEY + no models does not throw', () => {
    const yaml = {
      llm: { main: { provider: 'sap-ai-sdk' } },
      pipeline: {
        name: 'controller',
        config: {
          subagents: { evaluator: {}, planner: {}, executor: {} },
        },
      },
      rag: {
        store: { type: 'in-memory' },
        embedder: { provider: 'sap-ai-core' },
      },
    };
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        yaml,
        {},
        {
          skipProviderRuntimeChecks: true,
        },
      ),
    );
  });

  it('WITHOUT the flag, the same config throws (server path unchanged)', () => {
    const yaml = {
      llm: { main: { provider: 'sap-ai-sdk' } },
      rag: {
        store: { type: 'in-memory' },
        embedder: { provider: 'sap-ai-core' },
      },
    };
    assert.throws(() => resolveSmartServerConfig({}, yaml, {}, {}), /model/);
  });

  it('still enforces STRUCTURAL validation', () => {
    const yaml = {
      llm: { main: { provider: 'bogus-provider' } },
      rag: { store: { type: 'in-memory' } },
    };
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          yaml,
          {},
          {
            skipProviderRuntimeChecks: true,
          },
        ),
      /provider.*invalid|invalid.*provider/i,
    );
  });
});
