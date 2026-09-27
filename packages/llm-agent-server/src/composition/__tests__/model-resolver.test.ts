import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import type {
  SmartServerConfig,
  SmartServerLlmConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { buildCompositionDeps } from '../index.js';
import { createModelResolver } from '../model-resolver.js';

describe('createModelResolver (PUT /v1/config)', () => {
  it('keeps the role entry, swaps the model, and picks the root own temperature per role', async () => {
    const seen: SmartServerLlmConfig[] = [];
    const makeLlm = async (cfg: SmartServerLlmConfig) => {
      seen.push(cfg);
      return { model: cfg.model } as unknown as ILlm;
    };
    const llm = {
      main: {
        provider: 'openai',
        model: 'a',
        temperature: 0.6,
        classifierTemperature: 0.05,
        credentialRef: 'OPENAI',
      },
      helper: { provider: 'deepseek', model: 'h', temperature: 0.3 },
    } as unknown as SmartServerConfig['llm'];
    const resolver = createModelResolver(makeLlm, llm);
    assert.ok(resolver);
    await resolver.resolve('gpt-x', 'main');
    await resolver.resolve('gpt-y', 'classifier');
    await resolver.resolve('ds-z', 'helper');
    assert.deepEqual(
      seen.map((c) => [c.provider, c.model, c.temperature, c.credentialRef]),
      [
        ['openai', 'gpt-x', 0.6, 'OPENAI'],
        ['openai', 'gpt-y', 0.05, 'OPENAI'],
        ['deepseek', 'ds-z', 0.3, undefined],
      ],
    );
  });

  it("a declared classifier entry is the classifier role's own, on its own account", async () => {
    const seen: SmartServerLlmConfig[] = [];
    const makeLlm = async (cfg: SmartServerLlmConfig) => {
      seen.push(cfg);
      return { model: cfg.model } as unknown as ILlm;
    };
    const llm = {
      main: { provider: 'openai', model: 'a', credentialRef: 'OPENAI' },
      classifier: {
        provider: 'openai',
        model: 'c',
        temperature: 0.2,
        credentialRef: 'OPENAI_KEY_CHEAP',
      },
    } as unknown as SmartServerConfig['llm'];
    const resolver = createModelResolver(makeLlm, llm);
    assert.ok(resolver);
    await resolver.resolve('gpt-mini', 'classifier');
    assert.deepEqual(
      seen.map((c) => [c.model, c.temperature, c.credentialRef]),
      [['gpt-mini', 0.2, 'OPENAI_KEY_CHEAP']],
    );
  });

  it('a declared classifier without a temperature keeps none after a swap, as at startup', async () => {
    const seen: SmartServerLlmConfig[] = [];
    const makeLlm = async (cfg: SmartServerLlmConfig) => {
      seen.push(cfg);
      return { model: cfg.model } as unknown as ILlm;
    };
    const llm = {
      main: { provider: 'openai', model: 'a' },
      classifier: { provider: 'openai', model: 'c' },
    } as unknown as SmartServerConfig['llm'];
    const resolver = createModelResolver(makeLlm, llm);
    assert.ok(resolver);
    await resolver.resolve('gpt-mini', 'classifier');
    assert.equal(
      seen[0]?.temperature,
      undefined,
      'not 0.1 — B12 builds it as written',
    );
  });

  it('no llm: section → no resolver, so model updates stay refused', () => {
    assert.equal(
      createModelResolver(async () => ({}) as ILlm, undefined),
      undefined,
    );
  });
});

describe('buildCompositionDeps against the REAL constructors', () => {
  it('builds an OpenAI LLM from the env convention without a network call', async () => {
    const deps = buildCompositionDeps({ LLM_API_KEY: 'k' });
    const llm = await deps.makeLlm({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    assert.equal(llm.model, 'gpt-4o-mini');
  });

  it('hands out all four seams, the skill-store wrapper included', () => {
    const deps = buildCompositionDeps({});
    for (const seam of [
      'makeLlm',
      'resolveEmbedder',
      'makeRag',
      'buildSkillHost',
    ] as const) {
      assert.equal(typeof deps[seam], 'function', seam);
    }
  });

  it('an omitted ref with nothing in the environment fails naming the default ref', async () => {
    const deps = buildCompositionDeps({});
    await assert.rejects(
      () => deps.makeLlm({ provider: 'openai', model: 'm' }),
      /credentialRef 'LLM' must hold a api-key credential for openai, got none/,
    );
  });
});
