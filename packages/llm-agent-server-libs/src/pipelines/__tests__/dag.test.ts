import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
});
