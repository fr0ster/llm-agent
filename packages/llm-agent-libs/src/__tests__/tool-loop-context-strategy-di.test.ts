import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolLoopContextStrategyFactory } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import { LegacyAccumulateContextStrategy } from '../pipeline/context/tool-loop-context/index.js';

test('builder.withToolLoopContextStrategyFactory stores the factory', () => {
  const factory: ToolLoopContextStrategyFactory = () =>
    new LegacyAccumulateContextStrategy();
  const b = new SmartAgentBuilder({}).withToolLoopContextStrategyFactory(
    factory,
  );
  // white-box: the private field is set (mirror the existing withMcpFailureClassifier test's approach)
  assert.equal(
    (b as unknown as { _toolLoopContextStrategyFactory?: unknown })
      ._toolLoopContextStrategyFactory,
    factory,
  );
});
