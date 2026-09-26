import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ControllerSkillPipelineBuilder } from '../../builders/controller-skill-pipeline-builder.js';
import { resolveSmartServerConfig, YAML_TEMPLATE } from '../config.js';
import {
  SmartServer,
  type SmartServerConfig,
  type SmartServerLlmConfig,
} from '../smart-server.js';
import { constructionSeams, stubLlm } from './construction-seams.js';

describe('serializable LLM configuration carries a reference, never a secret', () => {
  it('passes credentialRef through the flat form and the map form', () => {
    const flat = resolveSmartServerConfig(
      {},
      {
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          credentialRef: 'PRIMARY',
        },
      },
      {},
    );
    assert.equal((flat.llm as SmartServerLlmConfig).credentialRef, 'PRIMARY');

    const map = resolveSmartServerConfig(
      {},
      {
        llm: {
          main: { provider: 'deepseek', model: 'deepseek-chat' },
          classifier: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            credentialRef: 'OPENAI_KEY_CHEAP',
          },
        },
      },
      {},
    );
    const roles = map.llm as Record<string, SmartServerLlmConfig>;
    assert.equal(roles.classifier?.credentialRef, 'OPENAI_KEY_CHEAP');
    assert.equal(roles.main?.credentialRef, undefined);
  });

  it('refuses a flat llm.apiKey, naming credentialRef', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-live' } },
          {},
        ),
      /llm\.apiKey[\s\S]*credentialRef/,
      'a silently ignored apiKey would leave an operator believing it was used',
    );
  });

  it('refuses llm.<role>.apiKey in the map form, naming that role', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          {
            llm: {
              main: { provider: 'deepseek', model: 'deepseek-chat' },
              classifier: {
                provider: 'openai',
                model: 'gpt-4o-mini',
                apiKey: 'sk-live',
              },
            },
          },
          {},
        ),
      /llm\.classifier\.apiKey[\s\S]*llm\.classifier\.credentialRef/,
    );
  });

  it('refuses an empty credentialRef — a ${VAR} that resolved to nothing is not "the default"', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          { llm: { provider: 'openai', model: 'gpt-4o', credentialRef: '' } },
          {},
        ),
      /llm\.credentialRef: must be a non-empty string/,
    );
  });

  it('asks for no key the library cannot see', () => {
    // Only the composition root knows whether it holds a credential (§4.6.2).
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        { llm: { provider: 'openai', model: 'gpt-4o' } },
        {},
      ),
    );
    assert.doesNotThrow(() =>
      resolveSmartServerConfig(
        {},
        { llm: { provider: 'sap-ai-sdk', model: 'gpt-4o' } },
        {}, // no AICORE_SERVICE_KEY in this env
      ),
    );
  });

  it('the first-run template carries no secret and validates as written', () => {
    assert.doesNotMatch(YAML_TEMPLATE, /apiKey/);
    const cfg = resolveSmartServerConfig({}, parse(YAML_TEMPLATE), {});
    assert.equal((cfg.llm as SmartServerLlmConfig).provider, 'deepseek');
  });
});

describe('the construction seams are required', () => {
  const cfg = {} as SmartServerConfig;

  it('refuses a SmartServer with no seams, naming each one', () => {
    assert.throws(
      () => new SmartServer(cfg, {} as never),
      (err: Error) =>
        /BuildAgentDeps\.makeLlm/.test(err.message) &&
        /BuildAgentDeps\.resolveEmbedder/.test(err.message),
    );
  });

  it('names only the seam that is missing', () => {
    assert.throws(
      () =>
        new SmartServer(cfg, {
          makeLlm: constructionSeams.makeLlm,
        } as never),
      (err: Error) =>
        /BuildAgentDeps\.resolveEmbedder/.test(err.message) &&
        !/BuildAgentDeps\.makeLlm/.test(err.message),
    );
  });

  it('hands each role its config, credentialRef included, through the injected makeLlm', async () => {
    const seen: SmartServerLlmConfig[] = [];
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        llm: {
          main: {
            provider: 'openai',
            model: 'gpt-4o',
            credentialRef: 'PRIMARY',
          },
          helper: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            credentialRef: 'CHEAP',
          },
        },
      },
      {
        ...constructionSeams,
        makeLlm: async (lc) => {
          seen.push(lc);
          return stubLlm(lc.model);
        },
      },
    );
    const handle = await server.start();
    try {
      assert.ok(seen.some((c) => c.credentialRef === 'PRIMARY'));
      assert.ok(seen.some((c) => c.credentialRef === 'CHEAP'));
      assert.ok(seen.every((c) => !('apiKey' in c)));
    } finally {
      await handle.close();
    }
  });

  it('the controller builder reads no key from the environment', () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-from-env';
    try {
      const out = new ControllerSkillPipelineBuilder()
        .withLlm({
          provider: 'openai',
          model: 'gpt-4o',
          credentialRef: 'OPENAI',
        })
        .withSkillSource({ github: 'a/b', enabled: ['x'] })
        .withEmbedder({ provider: 'ollama', model: 'bge-m3' })
        .toConfig();
      const main = (out.llm as Record<string, SmartServerLlmConfig>).main;
      assert.equal(main?.credentialRef, 'OPENAI');
      assert.equal(
        (main as unknown as Record<string, unknown>).apiKey,
        undefined,
      );
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
