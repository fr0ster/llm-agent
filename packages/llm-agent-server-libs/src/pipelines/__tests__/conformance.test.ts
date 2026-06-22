import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emptyLoadedPlugins,
  mergePluginExports,
} from '@mcp-abap-adt/llm-agent-libs';
import { ControllerPipelinePlugin } from '../controller.js';
import { DagPipelinePlugin } from '../dag.js';
import { FlatPipelinePlugin } from '../flat.js';
import { LinearPipelinePlugin } from '../linear.js';
import { StepperPipelinePlugin } from '../stepper.js';
import { fakeControllerServerCtx, fakeServerCtx } from './fixtures.js';

const BUILTINS: Array<{
  plugin: {
    name: string;
    parseConfig(r: unknown): unknown;
    build(
      c: unknown,
      x: unknown,
    ): Promise<{ agent: { streamProcess: unknown }; close(): unknown }>;
  };
  ctx(): unknown;
}> = [
  { plugin: new FlatPipelinePlugin(), ctx: fakeServerCtx },
  { plugin: new LinearPipelinePlugin(), ctx: fakeServerCtx },
  { plugin: new DagPipelinePlugin(), ctx: fakeServerCtx },
  { plugin: new StepperPipelinePlugin(), ctx: fakeServerCtx },
  {
    plugin: new ControllerPipelinePlugin('controller', 'smart-executor'),
    ctx: fakeControllerServerCtx,
  },
  {
    plugin: new ControllerPipelinePlugin('controller-weak', 'weak-executor'),
    ctx: fakeControllerServerCtx,
  },
];
const MIN_CFG: Record<string, unknown> = {
  flat: {},
  linear: { planning: 'one-shot', dispatch: 'self' },
  dag: { planner: { type: 'llm' } },
  stepper: { mode: 'planned-react' },
  controller: {
    subagents: {
      evaluator: { provider: 'openai' },
      planner: { provider: 'openai' },
      executor: { provider: 'openai' },
    },
  },
  'controller-weak': {
    subagents: {
      evaluator: { provider: 'openai' },
      planner: { provider: 'openai' },
      executor: { provider: 'openai' },
    },
  },
};

describe('built-in pipeline conformance', () => {
  for (const { plugin: p, ctx } of BUILTINS) {
    it(`${p.name}: parseConfig → build → stream → close`, async () => {
      const cfg = p.parseConfig(MIN_CFG[p.name]);
      const inst = await p.build(cfg, ctx());
      assert.equal(typeof inst.agent.streamProcess, 'function');
      await inst.close();
    });
  }

  it('duplicate pipeline name across sources fails fast (stable contract)', () => {
    const r = emptyLoadedPlugins();
    const mk = (n: string) => ({
      pipelinePlugins: { [n]: new DagPipelinePlugin() },
    });
    mergePluginExports(r, mk('dag'), 'pkg-a');
    mergePluginExports(r, mk('dag'), 'pkg-b');
    const dupe = r.errors.find(
      (e) =>
        e.error.includes("'dag'") &&
        e.error.includes('pkg-a') &&
        e.error.includes('pkg-b'),
    );
    assert.ok(
      dupe,
      'expected a duplicate error naming the pipeline and both sources',
    );
  });
});
