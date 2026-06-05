import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StepperPipelinePlugin } from '../stepper.js';
import { fakeServerCtx } from './fixtures.js';

describe('StepperPipelinePlugin', () => {
  it('parses config, builds an instance, streams, and closes', async () => {
    const plugin = new StepperPipelinePlugin();
    const cfg = plugin.parseConfig({ mode: 'planned-react' });
    assert.equal(cfg.mode, 'planned-react');
    const inst = await plugin.build(cfg, fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });
});
