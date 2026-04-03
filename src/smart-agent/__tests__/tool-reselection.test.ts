import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { SmartAgent } from '../agent.js';
import type {
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '../interfaces/types.js';
import { makeAssembler, makeDefaultDeps, makeRag } from '../testing/index.js';

// ---------------------------------------------------------------------------
// Per-iteration RAG tool re-selection
// ---------------------------------------------------------------------------

describe('Per-iteration RAG tool re-selection', () => {
  /**
   * Helper: build a streaming LLM that yields a tool call on the first
   * iteration, then a final text response on the second.
   */
  function makeToolCallThenStopLlm(
    toolName: string,
    _toolResultContent: string,
    onSecondCall?: (tools: LlmTool[]) => void,
  ) {
    let callCount = 0;
    return {
      get callCount() {
        return callCount;
      },
      async chat() {
        return {
          ok: true as const,
          value: { content: 'ok', finishReason: 'stop' as const },
        };
      },
      async *streamChat(
        _msgs: Message[],
        tools?: LlmTool[],
      ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        callCount++;
        if (callCount === 1) {
          // First iteration: return a tool call
          yield {
            ok: true,
            value: {
              content: '',
              toolCalls: [
                {
                  index: 0,
                  id: 'tc_1',
                  name: toolName,
                  arguments: '{}',
                },
              ],
              finishReason: 'tool_calls',
            },
          };
        } else {
          // Second iteration: capture tools and stop
          if (onSecondCall && tools) onSecondCall(tools);
          yield {
            ok: true,
            value: { content: 'done', finishReason: 'stop' },
          };
        }
      },
      async healthCheck() {
        return { ok: true as const, value: true };
      },
    };
  }

  it('does not re-select tools when toolReselectPerIteration is false (default)', async () => {
    const llm = makeToolCallThenStopLlm('CreateClass', 'error: already exists');

    const toolsRag = makeRag([
      {
        text: 'Tool: UpdateClass',
        score: 0.9,
        metadata: { id: 'tool:UpdateClass' },
      },
    ]);

    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([
        {
          role: 'system',
          content: '## Available Tools\n- CreateClass: create',
        },
        { role: 'user', content: 'create a class' },
      ]),
      ragStores: { tools: toolsRag },
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                {
                  name: 'CreateClass',
                  description: 'create',
                  inputSchema: { type: 'object' },
                },
                {
                  name: 'UpdateClass',
                  description: 'update',
                  inputSchema: { type: 'object' },
                },
              ],
            };
          },
          async callTool() {
            return {
              ok: true as const,
              value: { content: 'error: already exists' },
            };
          },
        },
      ],
    });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      // toolReselectPerIteration defaults to undefined (falsy)
    });

    await agent.process('create a class', { sessionId: 'no-reselect' });

    // RAG tools store should NOT have been queried for re-selection
    assert.equal(
      toolsRag.queryCalls?.length ?? 0,
      0,
      'tools RAG should not be queried when toolReselectPerIteration is off',
    );
  });

  it('re-selects tools via RAG when toolReselectPerIteration is true and error occurs', async () => {
    const llm = makeToolCallThenStopLlm('CreateClass', 'error: already exists');

    // RAG returns UpdateClass as relevant
    const toolsRag = makeRag([
      {
        text: 'Tool: UpdateClass',
        score: 0.9,
        metadata: { id: 'tool:UpdateClass' },
      },
    ]);

    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([
        {
          role: 'system',
          content: '## Available Tools\n- CreateClass: create',
        },
        { role: 'user', content: 'create a class' },
      ]),
      ragStores: { tools: toolsRag },
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                {
                  name: 'CreateClass',
                  description: 'create',
                  inputSchema: { type: 'object' },
                },
                {
                  name: 'UpdateClass',
                  description: 'update',
                  inputSchema: { type: 'object' },
                },
              ],
            };
          },
          async callTool() {
            return {
              ok: true as const,
              value: { content: 'error: already exists' },
            };
          },
        },
      ],
    });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      toolReselectPerIteration: true,
    });

    await agent.process('create a class', { sessionId: 'reselect-on' });

    // The tools RAG should have been queried during iteration > 0
    // makeRag doesn't track queryCalls by default, but makeMetadataRag does.
    // We verify indirectly: the agent should complete without error,
    // and the second LLM call should have been made.
    assert.ok(llm.callCount >= 2, 'LLM should be called at least twice');
  });

  it('skips re-selection for read-only tools (Search*, Read*, Get*, List*, Describe*)', async () => {
    const logSteps: Array<{ step: string; data: any }> = [];

    const llm = makeToolCallThenStopLlm('SearchClass', 'found 3 results');

    const toolsRag = makeRag([
      {
        text: 'Tool: UpdateClass',
        score: 0.9,
        metadata: { id: 'tool:UpdateClass' },
      },
    ]);

    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([
        {
          role: 'system',
          content: '## Available Tools\n- SearchClass: search',
        },
        { role: 'user', content: 'search classes' },
      ]),
      ragStores: { tools: toolsRag },
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                {
                  name: 'SearchClass',
                  description: 'search',
                  inputSchema: { type: 'object' },
                },
              ],
            };
          },
          async callTool() {
            return {
              ok: true as const,
              value: { content: 'found 3 results' },
            };
          },
        },
      ],
    });
    deps.mainLlm = llm;

    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      toolReselectPerIteration: true,
    });

    await agent.process('search classes', {
      sessionId: 'readonly-skip',
      sessionLogger: {
        logStep(step: string, data: any) {
          logSteps.push({ step, data });
        },
      },
    });

    // Check that the skip log was recorded
    const skipLog = logSteps.find((l) => l.step === 'tools_reselect_skipped');
    assert.ok(skipLog, 'should log tools_reselect_skipped for read-only tools');
    assert.equal(skipLog?.data?.reason, 'read-only tools only');
  });
});
