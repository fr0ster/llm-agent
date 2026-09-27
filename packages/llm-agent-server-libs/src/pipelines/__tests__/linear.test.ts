import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLinearSettings } from '../../smart-agent/pipeline-settings.js';
import { LinearPipelinePlugin } from '../linear.js';
import { fakeServerCtx } from './fixtures.js';

describe('LinearPipelinePlugin', () => {
  it('parses config, builds an instance, streams, and closes', async () => {
    const plugin = new LinearPipelinePlugin(
      parseLinearSettings({ planning: 'one-shot', dispatch: 'self' }),
    );
    const inst = await plugin.build(fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });
});
