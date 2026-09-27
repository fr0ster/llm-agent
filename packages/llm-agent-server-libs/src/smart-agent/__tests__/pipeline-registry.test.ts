import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IEmbedder, ILlm, IPipelinePlugin } from '@mcp-abap-adt/llm-agent';
import { emptyLoadedPlugins } from '@mcp-abap-adt/llm-agent-libs';
import { buildAgent, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const cannedLlm = {
  chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
  model: 'stub',
} as unknown as ILlm;
// B9's assertConstructionSeams runs when buildAgent constructs the SmartServer, so every required seam
// is named; this test overrides only makeLlm.
const DEPS = {
  ...constructionSeams,
  makeLlm: async () => cannedLlm,
  embedder: { embed: async () => ({ vector: [0] }) } as unknown as IEmbedder,
};
const LLM = { main: { provider: 'openai', model: 'm-main' } };

const stubPlugin = (name: string): IPipelinePlugin => ({
  name,
  build: async () => ({
    agent: {
      process: async () => ({ ok: true, value: { content: '' } }) as never,
      streamProcess: async function* () {},
    },
    close: async () => {},
  }),
});

function cfg(
  pipeline: SmartServerConfig['pipeline'],
  plugins = emptyLoadedPlugins(),
) {
  return {
    skipModelValidation: true,
    llm: LLM,
    pipeline,
    pluginLoader: { load: async () => plugins },
  } as unknown as SmartServerConfig;
}

test('a dynamic factory is called once, at startup, with its section; the others never', async () => {
  const calls: Array<{ key: string; section: unknown }> = [];
  const plugins = emptyLoadedPlugins();
  for (const key of ['ext', 'other']) {
    plugins.pipelinePluginFactories?.set(key, (section) => {
      calls.push({ key, section });
      return stubPlugin(key);
    });
    plugins.pipelinePluginSources.set(key, 'test-module');
  }
  const { close } = await buildAgent(
    cfg({ name: 'ext', config: { depth: 3 } }, plugins),
    DEPS,
  );
  await close();
  assert.deepEqual(calls, [{ key: 'ext', section: { depth: 3 } }]);
});

test("a factory's result is checked where it is called — module, key, what was wrong", async () => {
  const plugins = emptyLoadedPlugins();
  plugins.pipelinePluginFactories?.set('ext', () => stubPlugin('wrong'));
  plugins.pipelinePluginSources.set('ext', 'test-module');
  await assert.rejects(
    () => buildAgent(cfg({ name: 'ext' }, plugins), DEPS),
    /pipeline plugin 'ext' from 'test-module' refused: its name 'wrong' differs/,
  );
});

test('a dag key with no llm: entry is refused at startup, naming the key', async () => {
  await assert.rejects(
    () =>
      buildAgent(
        cfg({
          name: 'dag',
          config: { planner: { type: 'llm', plannerLlm: 'cheep' } },
        }),
        DEPS,
      ),
    /names llm: key 'cheep'/,
  );
});

test('an unknown pipeline name is refused at startup', async () => {
  await assert.rejects(
    () => buildAgent(cfg({ name: 'nope' }), DEPS),
    /unknown pipeline 'nope'/,
  );
});
