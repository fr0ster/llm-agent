import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmError,
  LlmStreamChunk,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps, makeMcpClient } from '../testing/index.js';

const DEFAULT_CONFIG = { maxIterations: 5 };

describe('Mixed internal + external tool calls', () => {
  it('executes internal tools and returns external tool calls to client', async () => {
    let capturedMessages: Message[] = [];

    const streamLlm = {
      callCount: 0,
      async chat() {
        return {
          ok: true as const,
          value: { content: '', finishReason: 'stop' as const },
        };
      },
      async *streamChat(
        msgs: Message[],
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        streamLlm.callCount++;
        capturedMessages = msgs;
        if (streamLlm.callCount === 1) {
          yield {
            ok: true,
            value: {
              content: 'I will read the class and write the file.',
              toolCalls: [
                {
                  id: 'call_1',
                  name: 'ReadClass',
                  arguments: { class: 'ZCL_TEST' },
                },
                {
                  id: 'call_2',
                  name: 'write_file',
                  arguments: { path: 'hello.md', content: 'Hello' },
                },
              ],
              finishReason: 'tool_calls',
            },
          };
        } else {
          yield {
            ok: true,
            value: { content: 'Done!', finishReason: 'stop' },
          };
        }
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const mcpClient = makeMcpClient(
      [{ name: 'ReadClass', description: 'Read ABAP class', inputSchema: {} }],
      new Map([['ReadClass', { content: 'class ZCL_TEST { method1() {} }' }]]),
    );

    const { deps } = makeDefaultDeps({
      llmResponses: [{ content: 'unused' }],
      mcpClients: [mcpClient],
    });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    const externalTools = [
      {
        name: 'write_file',
        description: 'Write file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
        },
      },
    ];

    // Request 1: LLM returns mixed calls
    const chunks: LlmStreamChunk[] = [];
    for await (const chunk of agent.streamProcess('Create file hello.md', {
      externalTools,
      sessionId: 'test-mixed',
    })) {
      if (chunk.ok) chunks.push(chunk.value);
    }

    // External tool call should be returned to client
    const toolChunks = chunks.filter(
      (c) => c.toolCalls && c.toolCalls.length > 0,
    );
    assert.ok(toolChunks.length > 0, 'should stream external tool call deltas');
    const finishChunk = chunks.find((c) => c.finishReason === 'tool_calls');
    assert.ok(finishChunk, 'should return finishReason: tool_calls');

    // Wait for internal tool promise to settle
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mcpClient.callCount, 1, 'internal tool should be called');

    // Request 2: Client sends external tool result
    const messages2: Message[] = [
      { role: 'user', content: 'Create file hello.md' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_2',
            type: 'function' as const,
            function: {
              name: 'write_file',
              arguments: '{"path":"hello.md","content":"Hello"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'File written successfully',
        tool_call_id: 'call_2',
      },
    ];

    const r2 = await agent.process(messages2, {
      externalTools,
      sessionId: 'test-mixed',
    });

    assert.ok(r2.ok, 'second request should succeed');
    assert.equal(r2.value.content, 'Done!');
    assert.equal(streamLlm.callCount, 2, 'LLM should be called twice total');

    // Verify internal tool result was injected into context
    const toolMsg = capturedMessages.find(
      (m) => m.role === 'tool' && m.tool_call_id === 'call_1',
    );
    assert.ok(toolMsg, 'internal tool result should be in context');
    assert.ok(
      toolMsg.content?.includes('ZCL_TEST'),
      'ReadClass result should contain class content',
    );
  });

  it('external-only calls still work (no pending results)', async () => {
    const streamLlm = {
      async chat() {
        return {
          ok: true as const,
          value: { content: '', finishReason: 'tool_calls' as const },
        };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'write_file',
                arguments: { path: 'a.md', content: 'A' },
              },
            ],
            finishReason: 'tool_calls',
          },
        };
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };

    const { deps } = makeDefaultDeps({ llmResponses: [{ content: 'unused' }] });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    const r = await agent.process('write a file', {
      externalTools: [
        {
          name: 'write_file',
          description: 'Write',
          inputSchema: { type: 'object' },
        },
      ],
      sessionId: 'test-ext-only',
    });

    assert.ok(r.ok);
    assert.equal(r.value.stopReason, 'tool_calls');
    assert.ok(r.value.toolCalls);
    assert.equal(r.value.toolCalls?.length, 1);
  });

  it('internal-only calls execute normally (no external)', async () => {
    const mcpClient = makeMcpClient(
      [{ name: 'ReadClass', description: 'Read', inputSchema: {} }],
      new Map([['ReadClass', { content: 'class content' }]]),
    );
    const { deps } = makeDefaultDeps({
      llmResponses: [
        {
          content: 'reading',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'ReadClass', arguments: {} }],
        },
        { content: 'done', finishReason: 'stop' },
      ],
      mcpClients: [mcpClient],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);

    const r = await agent.process('read class', { sessionId: 'test-int-only' });
    assert.ok(r.ok);
    assert.ok(
      r.value.content.includes('done'),
      'response should contain final content',
    );
    assert.equal(mcpClient.callCount, 1);
  });
});
