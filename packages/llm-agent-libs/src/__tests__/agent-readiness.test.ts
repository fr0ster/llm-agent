import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpConnectionStrategy } from '@mcp-abap-adt/llm-agent';
import { isReadinessReporter } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { makeLlm } from '../testing/index.js';

/** A connection strategy that also reports readiness via IReadinessReporter. */
function strategyReporting(ready: boolean): IMcpConnectionStrategy {
  return {
    async resolve() {
      return { clients: [], toolsChanged: false };
    },
    isReady() {
      return ready;
    },
  } as IMcpConnectionStrategy;
}

test('agent implements IReadinessReporter (detectable via the guard)', async () => {
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'x' }]))
    .build();
  assert.equal(isReadinessReporter(handle.agent), true);
  await handle.close();
});

test('agent.isReady() reflects the connection strategy (down ⇒ not ready)', async () => {
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'x' }]))
    .withMcpConnectionStrategy(strategyReporting(false))
    .build();
  assert.equal((handle.agent as SmartAgent).isReady(), false);
  await handle.close();
});

test('agent.isReady() is true with no strategy (readiness unknown ⇒ ready)', async () => {
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'x' }]))
    .build();
  assert.equal((handle.agent as SmartAgent).isReady(), true);
  await handle.close();
});
