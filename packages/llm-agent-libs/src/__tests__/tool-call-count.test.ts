import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import {
  makeAssembler,
  makeDefaultDeps,
  makeMcpClient,
} from '../testing/index.js';

for (const throws of [false, true]) {
  test(`reports executed count before escalation (throwing observer: ${throws})`, async () => {
    const counts: Array<[number, number | undefined]> = [];
    const { deps } = makeDefaultDeps({
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true,
              value: [{ name: 'Read', description: 'read', inputSchema: {} }],
            };
          },
          async callTool() {
            return {
              ok: false,
              error: new McpError('unavailable', 'MCP_ERROR'),
            };
          },
        },
      ],
      llmResponses: [
        {
          content: '',
          toolCalls: [
            { id: 'one', name: 'Read', arguments: {} },
            { id: 'two', name: 'Read', arguments: {} },
          ],
          finishReason: 'tool_calls',
        },
      ],
    });
    deps.mcpFailureClassifier = { classify: async () => 'unavailable' };
    const result = await new SmartAgent(deps, {
      mode: 'hard',
      maxToolCalls: 40,
    }).process('read', {
      onToolCallCount(count, max) {
        counts.push([count, max]);
        if (throws) throw new Error('observer failed');
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(counts, [[2, 40]]);
  });
}

test('external-only request reports the number of surfaced tool calls', async () => {
  const { deps } = makeDefaultDeps({
    llmResponses: [
      {
        content: '',
        toolCalls: [{ id: 'one', name: 'External', arguments: {} }],
        finishReason: 'tool_calls',
      },
    ],
  });
  const counts: number[] = [];
  const result = await new SmartAgent(deps, { mode: 'hard' }).process(
    'external',
    {
      externalTools: [
        { name: 'External', description: 'external', inputSchema: {} },
      ],
      onToolCallCount(count) {
        counts.push(count);
      },
    },
  );
  assert.ok(result.ok);
  assert.equal(result.value.toolCallCount, 1);
  assert.equal(result.value.toolCalls?.length, 1);
  assert.deepEqual(counts, []);
});

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
