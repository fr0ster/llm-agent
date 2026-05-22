import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent, SmartAgentResponse } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

class FakeAgent {
  capturedLayer?: number;
  async process(
    _prompt: string,
    options?: { layer?: number },
  ): Promise<Result<SmartAgentResponse, Error>> {
    this.capturedLayer = options?.layer;
    return {
      ok: true,
      value: {
        content: 'out',
        toolCalls: [],
        usage: undefined,
      } as unknown as SmartAgentResponse,
    };
  }
}

describe('SmartAgentSubAgent layer propagation', () => {
  it('forwards input.layer to the wrapped SmartAgent without incrementing', async () => {
    const inner = new FakeAgent();
    const sub = new SmartAgentSubAgent('w', inner as unknown as SmartAgent);
    await sub.run({ task: 't', layer: 1 });
    assert.equal(inner.capturedLayer, 1);
  });

  it('forwards layer=2 when dispatched at layer 2', async () => {
    const inner = new FakeAgent();
    const sub = new SmartAgentSubAgent('w', inner as unknown as SmartAgent);
    await sub.run({ task: 't', layer: 2 });
    assert.equal(inner.capturedLayer, 2);
  });
});
