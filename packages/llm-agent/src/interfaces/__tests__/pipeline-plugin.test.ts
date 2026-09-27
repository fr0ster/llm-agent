import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPipelineContext,
  IPipelineInstance,
  IPipelinePlugin,
  IReconfigurableSmartAgent,
  MaybePromise,
} from '../pipeline-plugin.js';
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
  it('names itself and builds an instance from the context alone', async () => {
    const depth = 3; // a typed setting, closed over at construction
    const plugin: IPipelinePlugin = {
      name: 'demo',
      build: async (_ctx: IPipelineContext) => ({
        agent: {
          process: async () => ({ ok: true, value: { depth } }) as never,
          streamProcess: async function* () {},
        },
        close: async () => {},
      }),
    };
    assert.equal(plugin.name, 'demo');
    const inst = await plugin.build({} as IPipelineContext);
    assert.equal(typeof inst.close, 'function');
  });
});

describe('PluginExports / LoadedPlugins carry pipeline plugins', () => {
  it('PluginExports.pipelinePlugins and pipelinePluginFactories are optional records', () => {
    const p: IPipelinePlugin = {
      name: 'x',
      build: async () => ({ agent: {} as never, close: async () => {} }),
    };
    const exports: PluginExports = {
      pipelinePlugins: { x: p },
      pipelinePluginFactories: { y: () => ({ ...p, name: 'y' }) },
    };
    assert.equal(exports.pipelinePlugins?.x.name, 'x');
    assert.equal(exports.pipelinePluginFactories?.y({}).name, 'y');
  });

  it('LoadedPlugins has pipelinePlugins + pipelinePluginSources maps', () => {
    const loaded: Pick<
      LoadedPlugins,
      'pipelinePlugins' | 'pipelinePluginSources'
    > = {
      pipelinePlugins: new Map(),
      pipelinePluginSources: new Map(),
    };
    assert.ok(loaded.pipelinePlugins instanceof Map);
    assert.ok(loaded.pipelinePluginSources instanceof Map);
  });
});
