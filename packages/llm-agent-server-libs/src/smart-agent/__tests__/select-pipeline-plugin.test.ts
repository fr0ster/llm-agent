import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPipelinePlugin,
  PipelinePluginFactory,
} from '@mcp-abap-adt/llm-agent';
import { selectPipelinePlugin } from '../select-pipeline-plugin.js';

const plugin = (name: string): IPipelinePlugin => ({
  name,
  build: async () => ({ agent: {} as never, close: async () => {} }),
});

function registry(entries: Record<string, PipelinePluginFactory>) {
  const factories = new Map(Object.entries(entries));
  const sources = new Map(
    [...factories.keys()].map((k) => [k, `mod-${k}`] as const),
  );
  return { factories, sources };
}

describe('selectPipelinePlugin', () => {
  it('calls only the selected factory, once, with the section', () => {
    const calls: Array<[string, unknown]> = [];
    const { factories, sources } = registry({
      a: (s) => {
        calls.push(['a', s]);
        return plugin('a');
      },
      b: (s) => {
        calls.push(['b', s]);
        return plugin('b');
      },
    });
    const p = selectPipelinePlugin(factories, sources, 'a', { depth: 1 });
    assert.equal(p.name, 'a');
    assert.deepEqual(calls, [['a', { depth: 1 }]]);
  });
  it('names the available pipelines for an unknown name', () => {
    const { factories, sources } = registry({ a: () => plugin('a') });
    assert.throws(
      () => selectPipelinePlugin(factories, sources, 'z', {}),
      /unknown pipeline 'z'; available: a/,
    );
  });
  it('reports a throwing factory with module, key and its own error attached', () => {
    const boom = new Error('bad section');
    const { factories, sources } = registry({
      a: () => {
        throw boom;
      },
    });
    assert.throws(
      () => selectPipelinePlugin(factories, sources, 'a', {}),
      (e: Error) =>
        /pipeline plugin 'a' from 'mod-a' failed to construct: bad section/.test(
          e.message,
        ) && e.cause === boom,
    );
  });
  it('refuses a result without build, and one whose name differs from the key', () => {
    const { factories, sources } = registry({
      a: () => ({ name: 'a' }) as unknown as IPipelinePlugin,
      b: () => plugin('not-b'),
    });
    assert.throws(
      () => selectPipelinePlugin(factories, sources, 'a', {}),
      /'a' from 'mod-a' refused: 'build' must be a function/,
    );
    assert.throws(
      () => selectPipelinePlugin(factories, sources, 'b', {}),
      /name 'not-b' differs from the key 'b'/,
    );
  });
});
