import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IPipelineContext, SmartAgentHandle } from '../../index.js';

test('SmartAgentHandle accepts optional namespace fields (additive)', () => {
  const withoutNs = {} as SmartAgentHandle;
  assert.equal(withoutNs.namespacedTools, undefined);
  assert.equal(withoutNs.toolProvenance, undefined);
  assert.equal(withoutNs.mcpClientDescriptors, undefined);
  assert.equal(withoutNs.configuredSlotCount, undefined);

  const withNs: SmartAgentHandle = {
    ...withoutNs,
    namespacedTools: [],
    toolProvenance: new Map([
      ['tool_1__foo', { slotIndex: 1, originalName: 'foo' }],
    ]),
    mcpClientDescriptors: [],
    configuredSlotCount: 0,
  };
  assert.deepEqual(withNs.namespacedTools, []);
  assert.equal(withNs.toolProvenance?.get('tool_1__foo')?.originalName, 'foo');

  const ctx = {} as IPipelineContext;
  assert.equal(ctx.toolClientMap, undefined);

  const ctxWithMap: IPipelineContext = {
    ...ctx,
    toolClientMap: new Map(),
  };
  assert.ok(ctxWithMap.toolClientMap instanceof Map);
});
