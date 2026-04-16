/**
 * Anthropic Agent - Uses Anthropic tools API for tool integration
 *
 * Anthropic (Claude) supports tools via the `tools` parameter and returns
 * tool use blocks in the response content.
 */

import type { AnthropicProvider } from '../llm-providers/anthropic.js';
import type { AgentStreamChunk, Message } from '../types.js';
import {
  type AgentCallOptions,
  BaseAgent,
  type BaseAgentConfig,
} from './base.js';

export interface AnthropicAgentConfig extends BaseAgentConfig {
  llmProvider: AnthropicProvider;
}

export class AnthropicAgent extends BaseAgent {
  private llmProvider: AnthropicProvider;

  constructor(config: AnthropicAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call Anthropic with tools using tools API
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    // Pass all messages (including system) — provider handles system message separation
    const response = await this.llmProvider.chat(
      messages,
      anthropicTools.length > 0 ? anthropicTools : undefined,
      options,
    );

    return {
      content: response.content,
      raw: response.raw,
    };
  }

  /**
   * Stream Anthropic response via real SSE streaming.
   * Delegates to provider.streamChat() and parses raw chunks for tool calls.
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    const toolCallMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    let blockIndex = 0;

    for await (const chunk of this.llmProvider.streamChat(
      messages,
      anthropicTools.length > 0 ? anthropicTools : undefined,
      options,
    )) {
      // Yield text deltas
      if (chunk.content) {
        yield { type: 'text', delta: chunk.content };
      }

      if (chunk.raw && typeof chunk.raw === 'object') {
        const raw = chunk.raw as Record<string, unknown>;

        // content_block_start — detect tool_use blocks
        if (raw.type === 'content_block_start' && raw.content_block) {
          const block = raw.content_block as Record<string, unknown>;
          if (block.type === 'tool_use') {
            toolCallMap.set(blockIndex, {
              id: (block.id as string) ?? '',
              name: (block.name as string) ?? '',
              arguments: '',
            });
          }
          blockIndex++;
        }

        // content_block_delta — accumulate tool input JSON
        if (raw.type === 'content_block_delta' && raw.delta) {
          const delta = raw.delta as Record<string, unknown>;
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            const current = toolCallMap.get(blockIndex - 1);
            if (current) current.arguments += delta.partial_json as string;
          }
        }

        // message_delta — finish reason
        if (raw.type === 'message_delta' && raw.delta) {
          const delta = raw.delta as Record<string, unknown>;
          const reason = delta.stop_reason as string | undefined;
          if (reason === 'tool_use') finishReason = 'tool_calls';
          else if (reason === 'max_tokens') finishReason = 'length';
          else if (reason === 'end_turn' || reason === 'stop_sequence')
            finishReason = 'stop';
        }

        // message_start — usage
        if (raw.type === 'message_start' && raw.message) {
          const msg = raw.message as Record<string, unknown>;
          const usage = msg.usage as Record<string, number> | undefined;
          if (usage) {
            yield {
              type: 'usage',
              promptTokens: usage.input_tokens ?? 0,
              completionTokens: usage.output_tokens ?? 0,
            };
          }
        }
      }

      // Track finish reason from provider
      if (chunk.finishReason) {
        if (chunk.finishReason === 'tool_use') finishReason = 'tool_calls';
        else if (chunk.finishReason === 'max_tokens') finishReason = 'length';
        else finishReason = 'stop';
      }
    }

    // Emit accumulated tool calls
    if (toolCallMap.size > 0) {
      const toolCalls = [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, tc]) => tc.name)
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
      if (toolCalls.length > 0) {
        yield { type: 'tool_calls', toolCalls };
        finishReason = 'tool_calls';
      }
    }

    yield { type: 'done', finishReason };
  }

  /**
   * Convert MCP tools to Anthropic tool format
   */
  private convertToolsToAnthropicTools(
    tools: unknown[],
  ): Array<Record<string, unknown>> {
    return tools.map((rawTool) => {
      const tool = rawTool as {
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      };
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      };
    });
  }
}
