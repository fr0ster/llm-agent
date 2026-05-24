/**
 * SmartAgentBuilder.withToolSelectionStrategy — wiring test.
 *
 * Builds a minimal agent via the builder, injects a recording
 * IToolSelectionStrategy, dispatches one query, and asserts that
 * the strategy's `select` method was invoked by the pipeline.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
  ILlm,
  IToolSelectionStrategy,
  LlmStreamChunk,
  LlmTool,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

// ---------------------------------------------------------------------------
// Minimal stubs (same pattern as builder-context-builder-wiring.test.ts)
// ---------------------------------------------------------------------------

function stubLlm(): ILlm {
  return {
    async chat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ) {
      return {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
    async *streamChat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

function stubEmbedder(): IEmbedder {
  return {
    async embed(_text: string, _options?: CallOptions): Promise<IEmbedResult> {
      return { vector: [0.1, 0.2, 0.3] };
    },
  };
}

// ---------------------------------------------------------------------------

describe('SmartAgentBuilder.withToolSelectionStrategy', () => {
  it('threads the injected strategy into tool selection (select is invoked during dispatch)', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');

    let selectCalled = false;
    const recording: IToolSelectionStrategy = {
      name: 'recording',
      select(results: RagResult[]): RagResult[] {
        selectCalled = true;
        return results;
      },
    };

    // Build a minimal agent with an embedder (so tool RAG query path fires),
    // an MCP client with one tool, and a tools RAG that returns a tool: result.
    const handle = await new SmartAgentBuilder({
      skipModelValidation: true,
    })
      .withMainLlm(stubLlm())
      .withEmbedder(stubEmbedder())
      .withMcpClients([
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                {
                  name: 'DoSomething',
                  description: 'does something',
                  inputSchema: { type: 'object' },
                },
              ],
            };
          },
          async callTool() {
            return { ok: true as const, value: { content: 'done' } };
          },
        },
      ])
      .setToolsRag({
        async query(): Promise<
          Result<RagResult[], import('@mcp-abap-adt/llm-agent').RagError>
        > {
          return {
            ok: true,
            value: [
              {
                text: 'DoSomething',
                score: 0.9,
                metadata: { id: 'tool:DoSomething' },
              },
              {
                text: 'AnotherTool',
                score: 0.2,
                metadata: { id: 'tool:AnotherTool' },
              },
            ],
          };
        },
        async healthCheck() {
          return { ok: true as const, value: undefined };
        },
        async getById() {
          return { ok: true as const, value: null };
        },
      })
      .withToolSelectionStrategy(recording)
      .build();

    try {
      await handle.agent.process('do something', {
        sessionId: 'test-strategy',
      });
      assert.ok(
        selectCalled,
        'injected tool-selection strategy should be invoked during dispatch',
      );
    } finally {
      await handle.close();
    }
  });
});
