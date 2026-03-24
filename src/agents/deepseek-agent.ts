/**
 * DeepSeek Agent - Uses DeepSeek function calling (similar to OpenAI)
 *
 * DeepSeek supports function calling similar to OpenAI via the `tools` parameter.
 */

import type { DeepSeekProvider } from '../llm-providers/deepseek.js';
import type { AgentStreamChunk, Message } from '../types.js';
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
    // Convert MCP tools to DeepSeek function format (same as OpenAI)
    const functions = this.convertToolsToFunctions(tools);

    // Format messages for DeepSeek
    const formattedMessages = this.formatMessagesForDeepSeek(messages);

    const { client, model, config } = this.llmProvider;

    // Call DeepSeek API with tools
    const response = await client.post('/chat/completions', {
      model: options?.model ?? model,
      messages: formattedMessages,
      tools: functions.length > 0 ? functions : undefined,
      tool_choice: functions.length > 0 ? 'auto' : undefined,
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 4096,
    });

    const choice = (
      response.data.choices as Array<Record<string, unknown>>
    )?.[0];
    const message = (choice?.message as Record<string, unknown>) ?? {};

    return {
      content: (message.content as string) || '',
      raw: response.data,
    };
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

  /**
   * Format messages for DeepSeek API (same as OpenAI)
   */
  private formatMessagesForDeepSeek(
    messages: Message[],
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      const formatted: Record<string, unknown> = {
        role: msg.role,
        // assistant messages with tool_calls must have content=null per OpenAI/DeepSeek protocol
        content: (msg.tool_calls?.length ? null : msg.content) ?? null,
      };
      if (msg.tool_call_id !== undefined)
        formatted.tool_call_id = msg.tool_call_id;
      if (msg.tool_calls !== undefined) formatted.tool_calls = msg.tool_calls;
      return formatted;
    });
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

    const { model, config } = this.llmProvider;
    const baseURL = config.baseURL || 'https://api.deepseek.com/v1';

    yield* this.streamOpenAICompatible(
      `${baseURL}/chat/completions`,
      { Authorization: `Bearer ${config.apiKey}` },
      {
        model: options?.model ?? model,
        messages: this.formatMessagesForDeepSeek(messages),
        tools: functions.length > 0 ? functions : undefined,
        tool_choice: functions.length > 0 ? 'auto' : undefined,
        temperature: config.temperature || 0.7,
        max_tokens: config.maxTokens || 4096,
        stream: true,
        stream_options: { include_usage: true },
      },
    );
  }
}
