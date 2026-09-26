import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStepperSettings } from '../../smart-agent/pipeline-settings.js';
import { StepperPipelinePlugin } from '../stepper.js';
import { fakeServerCtx } from './fixtures.js';

describe('StepperPipelinePlugin', () => {
  it('parses config, builds an instance, streams, and closes', async () => {
    const settings = parseStepperSettings({ mode: 'planned-react' });
    assert.equal(settings.mode, 'planned-react');
    const plugin = new StepperPipelinePlugin(settings);
    const inst = await plugin.build(fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });
});
