import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { IEmbedder, ILlm } from '@mcp-abap-adt/llm-agent';
import { loadYamlConfig, resolveSmartServerConfig } from '../config.js';
import { normalizeLlmConfig } from '../llm-config-map.js';
import {
  type BuildAgentDeps,
  SmartServer,
  type SmartServerConfig,
  type SmartServerLlmConfig,
} from '../smart-server.js';
import { assertWorkerLlmConfig, parseWorkerLlm } from '../worker-llm.js';
import { constructionSeams } from './construction-seams.js';

describe('parseWorkerLlm (§4.6.7)', () => {
  it('reads a string as the main key, a map as role keys, absence as nothing named', () => {
    assert.deepEqual(parseWorkerLlm('w', 'cheap'), { main: 'cheap' });
    assert.deepEqual(
      parseWorkerLlm('w', { main: 'a', helper: 'b', classifier: 'c' }),
      {
        main: 'a',
        helper: 'b',
        classifier: 'c',
      },
    );
    assert.deepEqual(parseWorkerLlm('w', undefined), {});
  });

  it('refuses an inline LLM configuration — flat or per role — naming the main map', () => {
    for (const raw of [
      { provider: 'openai', model: 'gpt-4o-mini' },
      { main: { provider: 'sap-ai-sdk', model: 'x' } },
    ]) {
      assert.throws(
        () => parseWorkerLlm('sap-reader', raw),
        (err: Error) =>
          /subagent 'sap-reader'/.test(err.message) &&
          /inline LLM configuration/.test(err.message) &&
          /main file's llm: map/.test(err.message),
      );
    }
  });

  it('refuses an unknown role and an empty key', () => {
    assert.throws(
      () => parseWorkerLlm('w', { planner: 'x' }),
      /unknown role 'planner'/,
    );
    assert.throws(() => parseWorkerLlm('w', ''), /non-empty/);
  });
});

describe('assertWorkerLlmConfig', () => {
  const map = normalizeLlmConfig({
    main: { provider: 'ollama', model: 'm' },
    cheap: { provider: 'ollama', model: 'c' },
  } as unknown as Record<string, SmartServerLlmConfig>);

  it('passes named keys that exist and omitted ones', () => {
    assert.doesNotThrow(() =>
      assertWorkerLlmConfig(
        [
          { name: 'a', config: { llm: 'cheap' } },
          { name: 'b', config: {} },
        ],
        map,
      ),
    );
  });

  it('refuses a named key with no entry, naming the worker, the role and the key', () => {
    assert.throws(
      () =>
        assertWorkerLlmConfig(
          [{ name: 'a', config: { llm: { helper: 'cheep' } } }],
          map,
        ),
      /subagent 'a': llm\.helper names 'cheep', which has no entry in the main file's llm: map \(entries: main, cheap\)/,
    );
  });
});

describe('a worker file resolves with the main file llm: map in scope', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-llm-'));
  const write = (name: string, text: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const main = (workerFile: string) =>
    write(
      `main-${workerFile}`,
      [
        'llm:',
        '  main: { provider: ollama, model: m }',
        '  cheap: { provider: ollama, model: c }',
        'subagents:',
        '  - name: w',
        `    config: ./${workerFile}`,
      ].join('\n'),
    );
  const resolve = (mainPath: string) =>
    resolveSmartServerConfig(
      {},
      loadYamlConfig(mainPath, {}),
      {},
      { configPath: mainPath },
    );

  it('a key names an entry of the MAIN file', () => {
    write('w-key.yaml', 'llm: cheap\n');
    const cfg = resolve(main('w-key.yaml'));
    assert.deepEqual(cfg.subAgentConfigs?.[0]?.config.llm, { main: 'cheap' });
  });

  it('a worker file needs no llm: section of its own', () => {
    write('w-none.yaml', 'mode: smart\n');
    const cfg = resolve(main('w-none.yaml'));
    assert.deepEqual(cfg.subAgentConfigs?.[0]?.config.llm, {});
  });

  it('an inline LLM configuration in a worker file is refused', () => {
    write(
      'w-inline.yaml',
      'llm:\n  main: { provider: openai, model: gpt-4o-mini }\n',
    );
    assert.throws(
      () => resolve(main('w-inline.yaml')),
      /inline LLM configuration/,
    );
  });

  it('a misspelled key is a config error, not main', () => {
    write('w-typo.yaml', 'llm: cheep\n');
    assert.throws(() => resolve(main('w-typo.yaml')), /'cheep'.*no entry/);
  });
});

describe('worker LLMs come from the server resolver', () => {
  const stubLlm = (model: string): ILlm =>
    ({
      model,
      chat: async () => ({ ok: true, value: { content: '', toolCalls: [] } }),
      streamChat: async function* () {},
    }) as unknown as ILlm;
  const stubEmbedder = {
    embed: async () => ({ vector: [0] }),
  } as unknown as IEmbedder;
  // Every SmartServer in the suite spreads B9's fixture (all three required seams);
  // these tests override makeLlm to count builds and embedder to skip resolution.
  const deps = (built: string[]): BuildAgentDeps => ({
    ...constructionSeams,
    makeLlm: async (cfg: SmartServerLlmConfig) => {
      built.push(cfg.model ?? '');
      return stubLlm(cfg.model ?? '');
    },
    embedder: stubEmbedder,
  });
  const llm = {
    main: { provider: 'ollama', model: 'main-model' },
    cheap: { provider: 'ollama', model: 'cheap-model' },
  } as unknown as SmartServerConfig['llm'];
  const sessionParts = {
    mcpClients: [],
    ragRegistry: {
      get: () => undefined,
      set: () => {},
      list: () => [],
      register: () => {},
      unregister: () => {},
    },
    toolsRag: undefined,
    logger: { trackUsage: () => {}, logToolCall: () => {} },
  };

  it('start() refuses a programmatic worker naming a key with no entry', async () => {
    const server = new SmartServer(
      {
        port: 0,
        llm,
        skipModelValidation: true,
        subAgentConfigs: [
          { name: 'w', config: { llm: 'cheep', skipModelValidation: true } },
        ],
      },
      deps([]),
    );
    await assert.rejects(
      () => server.start(),
      /subagent 'w': llm\.main names 'cheep'/,
    );
  });

  it('two workers naming one key share ONE instance, across the primary build and a session', async () => {
    const built: string[] = [];
    const server = new SmartServer(
      {
        port: 0,
        llm,
        skipModelValidation: true,
        subAgentConfigs: [
          { name: 'w1', config: { llm: 'cheap', skipModelValidation: true } },
          {
            name: 'w2',
            config: { llm: { main: 'cheap' }, skipModelValidation: true },
          },
        ],
      },
      deps(built),
    );
    const handle = await server.start();
    try {
      await (
        server as unknown as {
          buildSessionAgent: (p: unknown) => Promise<unknown>;
        }
      ).buildSessionAgent(sessionParts);
      assert.equal(built.filter((m) => m === 'cheap-model').length, 1);
    } finally {
      await handle.close();
    }
  });

  it('a worker naming nothing builds nothing: it takes the held instances', async () => {
    const control: string[] = [];
    const bare = await new SmartServer(
      { port: 0, llm, skipModelValidation: true },
      deps(control),
    ).start();
    await bare.close();

    const built: string[] = [];
    const handle = await new SmartServer(
      {
        port: 0,
        llm,
        skipModelValidation: true,
        subAgentConfigs: [{ name: 'w', config: { skipModelValidation: true } }],
      },
      deps(built),
    ).start();
    try {
      assert.deepEqual(built, control);
    } finally {
      await handle.close();
    }
  });
});
