import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { SapCoreAIAgent } from '../sap-core-ai-agent.js';

// ---------------------------------------------------------------------------
// Helpers — minimal stubs
// ---------------------------------------------------------------------------

/**
 * Create a SapCoreAIAgent with a stub provider (no real SAP AI Core connection).
 */
function createAgent(): SapCoreAIAgent {
  // biome-ignore lint/suspicious/noExplicitAny: stub provider for testing
  const stubProvider = { model: 'gpt-4o' } as any;
  return new SapCoreAIAgent({
    // biome-ignore lint/suspicious/noExplicitAny: stub mcpClient for testing
    mcpClient: {} as any,
    llmProvider: stubProvider,
  });
}

// ---------------------------------------------------------------------------
// convertToolsToFunctions (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('SapCoreAIAgent — convertToolsToFunctions', () => {
  const agent = createAgent();
  const convert = (tools: unknown[]) =>
    // @ts-expect-error — access private method for testing
    agent.convertToolsToFunctions(tools);

  it('converts MCP tool to OpenAI function format', () => {
    const mcpTool = {
      name: 'get_weather',
      description: 'Get weather for a location',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
    };

    const result = convert([mcpTool]);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'function');
    assert.equal(result[0].function.name, 'get_weather');
    assert.equal(result[0].function.description, 'Get weather for a location');
    assert.deepEqual(result[0].function.parameters, mcpTool.inputSchema);
  });

  it('uses empty defaults for missing fields', () => {
    const result = convert([{}]);
    assert.equal(result[0].function.name, '');
    assert.equal(result[0].function.description, '');
    assert.deepEqual(result[0].function.parameters, {
      type: 'object',
      properties: {},
    });
  });

  it('handles multiple tools', () => {
    const tools = [
      { name: 'tool_a', description: 'A' },
      { name: 'tool_b', description: 'B' },
    ];
    const result = convert(tools);
    assert.equal(result.length, 2);
    assert.equal(result[0].function.name, 'tool_a');
    assert.equal(result[1].function.name, 'tool_b');
  });
});

// ---------------------------------------------------------------------------
// formatMessages (private — tested via casting to any)
// ---------------------------------------------------------------------------

describe('SapCoreAIAgent — formatMessages', () => {
  const agent = createAgent();
  // biome-ignore lint/suspicious/noExplicitAny: access private method for testing
  const fmt = (msgs: Message[]) => (agent as any).formatMessages(msgs);

  it('formats simple user message with content', () => {
    const result = fmt([{ role: 'user', content: 'Hello' }]);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Hello');
  });

  it('sets content to null when tool_calls present', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'fn', arguments: '{}' },
      },
    ];
    const result = fmt([
      { role: 'assistant', content: 'text', tool_calls: toolCalls },
    ]);
    assert.equal(result[0].content, null);
    assert.deepEqual(result[0].tool_calls, toolCalls);
  });

  it('preserves tool_call_id on tool messages', () => {
    const result = fmt([
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ]);
    assert.equal(result[0].tool_call_id, 'call_1');
  });

  it('does not include tool_calls key when not present', () => {
    const result = fmt([{ role: 'user', content: 'hi' }]);
    assert.equal(result[0].tool_calls, undefined);
  });

  it('does not include tool_call_id key when not present', () => {
    const result = fmt([{ role: 'user', content: 'hi' }]);
    assert.equal(result[0].tool_call_id, undefined);
  });

  it('handles null content as null', () => {
    const result = fmt([{ role: 'user', content: null }]);
    assert.equal(result[0].content, null);
  });
});
