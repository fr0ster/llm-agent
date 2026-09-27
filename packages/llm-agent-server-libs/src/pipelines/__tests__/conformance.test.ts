import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPipelineContext,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import {
  emptyLoadedPlugins,
  mergePluginExports,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  parseDagSettings,
  parseLinearSettings,
  parseStepperSettings,
} from '../../smart-agent/pipeline-settings.js';
import { DagPipelinePlugin } from '../dag.js';
import { FlatPipelinePlugin } from '../flat.js';
import { LinearPipelinePlugin } from '../linear.js';
import { StepperPipelinePlugin } from '../stepper.js';
import {
  controllerPlugin,
  fakeControllerServerCtx,
  fakeServerCtx,
} from './fixtures.js';

const BUILTINS: Array<{
  name: string;
  make(): IPipelinePlugin;
  ctx(): unknown;
}> = [
  { name: 'flat', make: () => new FlatPipelinePlugin(), ctx: fakeServerCtx },
  {
    name: 'linear',
    make: () =>
      new LinearPipelinePlugin(
        parseLinearSettings({ planning: 'one-shot', dispatch: 'self' }),
      ),
    ctx: fakeServerCtx,
  },
  {
    name: 'dag',
    make: () =>
      new DagPipelinePlugin(
        parseDagSettings({ planner: { type: 'llm' } }, () => {}),
      ),
    ctx: fakeServerCtx,
  },
  {
    name: 'stepper',
    make: () =>
      new StepperPipelinePlugin(
        parseStepperSettings({ mode: 'planned-react' }),
      ),
    ctx: fakeServerCtx,
  },
  {
    name: 'controller',
    make: () => controllerPlugin('controller', 'smart-executor'),
    ctx: fakeControllerServerCtx,
  },
  {
    name: 'controller-weak',
    make: () => controllerPlugin('controller-weak', 'weak-executor'),
    ctx: fakeControllerServerCtx,
  },
];

describe('built-in pipeline conformance', () => {
  for (const b of BUILTINS) {
    it(`${b.name}: settings → construct → build → stream → close`, async () => {
      const p = b.make();
      assert.equal(
        p.name,
        b.name,
        'a plugin reports the key it is registered under',
      );
      const inst = await p.build(b.ctx() as IPipelineContext);
      assert.equal(typeof inst.agent.streamProcess, 'function');
      await inst.close();
    });
  }

  it('duplicate pipeline name across sources fails fast (stable contract)', () => {
    const r = emptyLoadedPlugins();
    const mk = (n: string) => ({
      pipelinePlugins: {
        [n]: new DagPipelinePlugin(parseDagSettings({ planner: {} }, () => {})),
      },
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
