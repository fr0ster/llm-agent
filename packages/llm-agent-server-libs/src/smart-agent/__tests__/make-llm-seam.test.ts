import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IEmbedder, ILlm } from '@mcp-abap-adt/llm-agent';
import { buildAgent, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const cannedLlm = {
  chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
  model: 'stub',
} as unknown as ILlm;
const stubEmbedder = {
  embed: async () => ({ vector: [0] }),
} as unknown as IEmbedder;

test('without an injected makeLlm the server refuses, naming the seam', async () => {
  await assert.rejects(
    () =>
      buildAgent(
        {
          skipModelValidation: true,
          llm: { main: { provider: 'openai', model: 'gpt-4o' } },
        } as unknown as SmartServerConfig,
        { embedder: stubEmbedder, mcpClients: [] },
      ),
    /BuildAgentDeps\.makeLlm/,
    'the library no longer constructs providers, so a missing seam must say so',
  );
});

test('a subagent worker names a key; its LLM is built once, through the injected makeLlm', async () => {
  const models: Array<string | undefined> = [];
  const { close } = await buildAgent(
    {
      skipModelValidation: true,
      llm: {
        main: { provider: 'openai', model: 'parent-model' },
        worker: { provider: 'openai', model: 'worker-model' },
      },
      subAgentConfigs: [{ name: 'worker', config: { llm: 'worker' } }],
    } as unknown as SmartServerConfig,
    {
      ...constructionSeams,
      makeLlm: async (cfg) => {
        models.push(cfg.model);
        return cannedLlm;
      },
      embedder: stubEmbedder,
      mcpClients: [],
    },
  );
  await close();
  assert.equal(
    models.filter((m) => m === 'worker-model').length,
    1,
    `the worker's entry is built once, through the seam, and held (§4.6.5); saw ${models.join(', ')}`,
  );
});
