import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartAgent } from '../agent.js';
import {
  makeAssembler,
  makeDefaultDeps,
  makeMcpClient,
} from '../testing/index.js';

for (const throws of [false, true]) {
  test(`reports executed counts across two rounds (throwing observer: ${throws})`, async () => {
    const counts: Array<[number, number | undefined]> = [];
    const mcp = makeMcpClient([
      { name: 'Read', description: 'read', inputSchema: { type: 'object' } },
    ]);
    const { deps } = makeDefaultDeps({
      mcpClients: [mcp],
      assembler: makeAssembler([
        { role: 'system', content: '## Available Tools\n- Read: read' },
        { role: 'user', content: 'read twice' },
      ]),
      llmResponses: [
        ...['one', 'two'].map((id) => ({
          content: '',
          toolCalls: [{ id, name: 'Read', arguments: {} }],
          finishReason: 'tool_calls' as const,
        })),
        { content: 'done', finishReason: 'stop' },
      ],
    });
    const result = await new SmartAgent(deps, {
      maxIterations: 5,
      maxToolCalls: 40,
    }).process('read twice', {
      onToolCallCount(count, max) {
        counts.push([count, max]);
        if (throws) throw new Error('observer failed');
      },
    });
    assert.ok(result.ok);
    assert.deepEqual(counts, [
      [1, 40],
      [2, 40],
    ]);
    assert.equal(result.value.toolCallCount, 2);
    assert.equal(mcp.callCount, 2);
  });
}
