import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  externalToolCallId,
  type ISubAgentInput,
  type LlmTool,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../../agent.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

function makeAgent(value: unknown): SmartAgent {
  return {
    async process() {
      return { ok: true, value };
    },
  } as unknown as SmartAgent;
}

const ragAdd: LlmTool = {
  name: 'rag_add',
  description: 'add to rag',
  inputSchema: { type: 'object', properties: {} },
};

describe('SmartAgentSubAgent external-tool mapping', () => {
  it('maps a tool_calls stop on an external tool to awaiting-external with rewritten ext id', async () => {
    const agent = makeAgent({
      content: '',
      iterations: 1,
      toolCallCount: 1,
      stopReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'rag_add', arguments: '{"collection":"context"}' },
        },
      ],
    });
    const sub = new SmartAgentSubAgent('worker', agent);
    const input: ISubAgentInput = {
      task: 'do it',
      externalTools: [ragAdd],
    };

    const res = await sub.run(input);

    assert.equal(res.status, 'awaiting-external');
    assert.deepEqual(res.pendingExternalToolCalls, [
      {
        id: externalToolCallId('rag_add', { collection: 'context' }),
        name: 'rag_add',
        arguments: { collection: 'context' },
      },
    ]);
  });

  it('returns complete when the worker stops normally with no tool calls', async () => {
    const agent = makeAgent({
      content: 'done',
      iterations: 1,
      toolCallCount: 0,
      stopReason: 'stop',
    });
    const sub = new SmartAgentSubAgent('worker', agent);

    const res = await sub.run({ task: 'do it' });

    assert.notEqual(res.status, 'awaiting-external');
    assert.equal(res.pendingExternalToolCalls, undefined);
    assert.equal(res.output, 'done');
  });
});
