import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type LlmTool, TokenLedger } from '@mcp-abap-adt/llm-agent';
import { makeLlm } from '../../../testing/index.js';
import { CyclicReActExecutor } from '../cyclic-react-executor.js';

for (const maxIterations of [undefined, 3]) {
  test(`CyclicReActExecutor limit: ${maxIterations ?? 'unlimited'}`, async () => {
    const llm = makeLlm([
      ...Array.from({ length: 12 }, (_, round) => ({
        content: '',
        toolCalls: [{ id: `c${round}`, name: 'Work', arguments: { round } }],
      })),
      { content: 'done' },
    ]);
    let toolCalls = 0;
    const executor = new CyclicReActExecutor({
      llm,
      component: 'tool-loop',
      maxIterations,
      async callMcp() {
        toolCalls++;
        return 'completed';
      },
    });
    const tool: LlmTool = {
      name: 'Work',
      description: 'Work',
      inputSchema: {},
    };
    const result = await executor.execute({
      prompt: 'complete the work',
      tools: [tool],
      toolsRag: { query: async () => [tool], lookup: () => tool },
      knowledgeRag: {
        query: async () => [],
        list: async () => [],
        write: async () => {},
        fingerprint: () => 'empty',
      },
      budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
      identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'n1' },
    });
    assert.equal(
      result.status,
      maxIterations === undefined ? 'ok' : 'incomplete',
    );
    assert.equal(llm.callCount, maxIterations ?? 13);
    assert.equal(toolCalls, maxIterations ?? 12);
  });
}
