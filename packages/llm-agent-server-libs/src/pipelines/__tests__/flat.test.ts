import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FlatPipelinePlugin } from '../flat.js';
import { fakeServerCtx } from './fixtures.js';

describe('FlatPipelinePlugin', () => {
  it('builds an instance with no coordinator, streams, and closes', async () => {
    const plugin = new FlatPipelinePlugin();
    const cfg = plugin.parseConfig({});
    const inst = await plugin.build(cfg, fakeServerCtx());
    assert.equal(typeof inst.agent.streamProcess, 'function');
    await inst.close();
  });
});
