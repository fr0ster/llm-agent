import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPipelineInstance,
  IReconfigurableSmartAgent,
  MaybePromise,
} from '../pipeline-plugin.js';
import type { IPipelineContext, IPipelinePlugin } from '../pipeline-plugin.js';
import type { LoadedPlugins, PluginExports } from '../plugin.js';

describe('pipeline-plugin runnable contracts', () => {
  it('IPipelineInstance exposes agent + close()', async () => {
    const instance: IPipelineInstance = {
      agent: {
        process: async () => ({ ok: true, value: {} }) as never,
        streamProcess: async function* () {},
      },
      close: async () => {},
    };
    assert.equal(typeof instance.agent.streamProcess, 'function');
    assert.equal(typeof instance.close, 'function');
    await instance.close();
  });

  it('IReconfigurableSmartAgent adds reconfigure() and is detectable', () => {
    const agent: IReconfigurableSmartAgent = {
      process: async () => ({ ok: true, value: {} }) as never,
      streamProcess: async function* () {},
      reconfigure: () => {},
    };
    assert.equal('reconfigure' in agent, true);
    assert.equal(typeof agent.reconfigure, 'function');
  });

  it('MaybePromise<T> accepts both sync and async', async () => {
    const sync: MaybePromise<number> = 1;
    const async: MaybePromise<number> = Promise.resolve(2);
    assert.equal(await sync, 1);
    assert.equal(await async, 2);
  });
});

describe('IPipelinePlugin', () => {
  it('names itself, parses config, and builds an instance', async () => {
    const plugin: IPipelinePlugin<{ depth: number }> = {
      name: 'demo',
      parseConfig: (raw) => ({ depth: (raw as { depth?: number }).depth ?? 1 }),
      build: async (config, _ctx: IPipelineContext) => ({
        agent: { process: async () => ({ ok: true, value: config }) as never, streamProcess: async function* () {} },
        close: async () => {},
      }),
    };
    assert.equal(plugin.name, 'demo');
    assert.deepEqual(plugin.parseConfig({ depth: 3 }), { depth: 3 });
    const inst = await plugin.build({ depth: 3 }, {} as IPipelineContext);
    assert.equal(typeof inst.close, 'function');
  });
});

describe('PluginExports / LoadedPlugins carry pipeline plugins', () => {
  it('PluginExports.pipelinePlugins is an optional record', () => {
    const p: IPipelinePlugin = {
      name: 'x',
      parseConfig: (r) => r,
      build: async () => ({ agent: {} as never, close: async () => {} }),
    };
    const exports: PluginExports = { pipelinePlugins: { x: p } };
    assert.equal(exports.pipelinePlugins?.x.name, 'x');
  });

  it('LoadedPlugins has pipelinePlugins + pipelinePluginSources maps', () => {
    const loaded: Pick<LoadedPlugins, 'pipelinePlugins' | 'pipelinePluginSources'> = {
      pipelinePlugins: new Map(),
      pipelinePluginSources: new Map(),
    };
    assert.ok(loaded.pipelinePlugins instanceof Map);
    assert.ok(loaded.pipelinePluginSources instanceof Map);
  });
});
