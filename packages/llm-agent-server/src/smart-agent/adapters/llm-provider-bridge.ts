/**
 * LlmProviderBridge — wraps a legacy LLMProvider as BaseAgentLlmBridge.
 *
 * This adapter bridges the old LLMProvider interface (returns LLMResponse directly)
 * to the BaseAgentLlmBridge interface expected by LlmAdapter (returns Result<LlmResponse>).
 *
 * It handles OpenAI-style tool format conversion (MCP tools → { type: 'function', function: {...} }).
 */

import type {
  AgentStreamChunk,
  LLMProvider,
  Message,
} from '@mcp-abap-adt/llm-agent';
import type { AgentCallOptions, BaseAgentLlmBridge } from './llm-adapter.js';

/**
 * Convert MCP-style tools to OpenAI function-call format.
 * This is the same conversion that OpenAIAgent/DeepSeekAgent used to do.
 */
function convertToolsToFunctions(
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

/**
 * Wraps a LLMProvider as a BaseAgentLlmBridge, enabling LlmAdapter to use it.
 *
 * Usage:
 *   const provider = new OpenAIProvider({ ... });
 *   const bridge = new LlmProviderBridge(provider);
 *   const llm = new LlmAdapter(bridge, { model: provider.model });
 */
export class LlmProviderBridge implements BaseAgentLlmBridge {
  constructor(private readonly provider: LLMProvider) {}

  async callWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    const functions = convertToolsToFunctions(tools);
    const response = await this.provider.chat(
      messages,
      functions.length > 0 ? functions : undefined,
      options,
    );
    return { content: response.content, raw: response.raw };
  }

  async *streamWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<
    { content: string; raw?: unknown } | AgentStreamChunk,
    void,
    unknown
  > {
    const functions = convertToolsToFunctions(tools);

    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

    for await (const chunk of this.provider.streamChat(
      messages,
      functions.length > 0 ? functions : undefined,
      options,
    )) {
      // Yield text deltas
      if (chunk.content) {
        yield { type: 'text', delta: chunk.content } as AgentStreamChunk;
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
          } as AgentStreamChunk;
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
      yield { type: 'tool_calls', toolCalls } as AgentStreamChunk;
    }

    yield { type: 'done', finishReason } as AgentStreamChunk;
  }
}
