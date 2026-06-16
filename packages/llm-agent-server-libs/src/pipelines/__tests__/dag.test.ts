import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ISkillPluginHost,
  ISkillsRagHandle,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { DagPipelinePlugin } from '../dag.js';
import { fakeServerCtx } from './fixtures.js';

describe('DagPipelinePlugin', () => {
  it('parses config, builds an instance, streams, and closes', async () => {
    const plugin = new DagPipelinePlugin();
    const cfg = plugin.parseConfig({ planner: { type: 'llm' } });
    const inst = await plugin.build(cfg, fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });

  it('parseConfig rejects config without a planner', () => {
    const plugin = new DagPipelinePlugin();
    assert.throws(() => plugin.parseConfig({}), /planner/);
  });

  it('registers implicit skill plugin-host RAG sources', async () => {
    const plugin = new DagPipelinePlugin();
    const cfg = plugin.parseConfig({ planner: { type: 'llm' } });
    const ctx = fakeServerCtx();
    const registered: string[] = [];
    const originalCreateBuilder = ctx.createAgentBuilder;
    ctx.createAgentBuilder = async () => {
      const builder = await originalCreateBuilder();
      const originalAdd = builder.addRagCollection.bind(builder);
      builder.addRagCollection = ((params) => {
        registered.push(params.name);
        return originalAdd(params);
      }) as SmartAgentBuilder['addRagCollection'];
      return builder;
    };
    ctx.skillHost = {
      load: async () => ({
        committed: ['abap'],
        omitted: [],
        tombstoned: [],
        ok: true,
      }),
      groups: () => [
        { group: 'abap', description: 'ABAP', collection: 'abap' },
      ],
      rag: () =>
        ({
          query: async () => [],
          activeManifest: async () => null,
        }) as unknown as ISkillsRagHandle,
    } as ISkillPluginHost;
    ctx.skillRecall = { k: 3, threshold: 0.4, serveCollections: ['abap'] };

    const inst = await plugin.build(cfg, ctx);

    assert.deepEqual(registered, ['relevant-skills:abap']);
    await inst.close();
  });
});
