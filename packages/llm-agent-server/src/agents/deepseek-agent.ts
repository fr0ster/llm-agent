/**
 * DeepSeek Agent - Uses DeepSeek function calling (similar to OpenAI)
 *
 * DeepSeek supports function calling similar to OpenAI via the `tools` parameter.
 */

import type { DeepSeekProvider } from '@mcp-abap-adt/deepseek-llm';
import type { AgentStreamChunk, Message } from '@mcp-abap-adt/llm-agent';
import {
  type AgentCallOptions,
  BaseAgent,
  type BaseAgentConfig,
} from './base.js';

export interface DeepSeekAgentConfig extends BaseAgentConfig {
  llmProvider: DeepSeekProvider;
}

export class DeepSeekAgent extends BaseAgent {
  private llmProvider: DeepSeekProvider;

  constructor(config: DeepSeekAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call DeepSeek with tools using function calling (similar to OpenAI)
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    const functions = this.convertToolsToFunctions(tools);

    const response = await this.llmProvider.chat(
      messages,
      functions.length > 0 ? functions : undefined,
      options,
    );

    return {
      content: response.content,
      raw: response.raw,
    };
  }

  /**
   * Stream DeepSeek response
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const functions = this.convertToolsToFunctions(tools);

    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    for await (const chunk of this.llmProvider.streamChat(
      messages,
      functions.length > 0 ? functions : undefined,
      options,
    )) {
      // Yield text deltas
      if (chunk.content) {
        yield { type: 'text', delta: chunk.content };
      }

      // Extract usage and tool calls from raw
      const raw = chunk.raw as Record<string, unknown> | undefined;
      if (raw) {
        const usage = raw.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage) {
          yield {
            type: 'usage',
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
          };
        }

        // Accumulate tool calls from raw delta
        const choices = raw.choices as
          | Array<{
              delta?: {
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>
          | undefined;
        const delta = choices?.[0]?.delta;
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!toolCallMap.has(index)) {
              toolCallMap.set(index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                arguments: '',
              });
            }
            if (tc.function?.arguments) {
              const accumulated = toolCallMap.get(index);
              if (accumulated) {
                accumulated.arguments += tc.function.arguments;
              }
            }
          }
        }
      }

      // Track finish reason
      if (chunk.finishReason) {
        finishReason =
          chunk.finishReason === 'tool_calls'
            ? 'tool_calls'
            : chunk.finishReason === 'length'
              ? 'length'
              : chunk.finishReason === 'error'
                ? 'error'
                : 'stop';
      }
    }

    // Emit accumulated tool calls
    if (toolCallMap.size > 0) {
      const toolCalls = [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          name: tc.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.arguments) as Record<string, unknown>;
            } catch {
              return {};
            }
          })(),
        }));
      yield { type: 'tool_calls', toolCalls };
    }

    yield { type: 'done', finishReason };
  }

  /**
   * Convert MCP tools to DeepSeek function format
   */
  private convertToolsToFunctions(
    tools: unknown[],
  ): Array<Record<string, unknown>> {
    return tools.map((rawTool) => {
      const tool = rawTool as {
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      };
      return {
        type: 'function',
        function: {
          name: tool.name ?? '',
          description: tool.description || '',
          parameters: tool.inputSchema || {
            type: 'object',
            properties: {},
          },
        },
      };
    });
  }
}
