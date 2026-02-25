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
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to DeepSeek function format (same as OpenAI)
    const functions = this.convertToolsToFunctions(tools);

    // Format messages for DeepSeek
    const formattedMessages = this.formatMessagesForDeepSeek(messages);

    // Access DeepSeek client and config
    const deepseekProvider = this.llmProvider as unknown as {
      client: {
        post(
          path: string,
          body: Record<string, unknown>,
        ): Promise<{ data: Record<string, unknown> }>;
      };
      model: string;
      config: {
        temperature?: number;
        maxTokens?: number;
      };
    };
    const client = deepseekProvider.client;
    const model = deepseekProvider.model;
    const config = deepseekProvider.config;

    // Call DeepSeek API with tools
    const response = await client.post('/chat/completions', {
      model,
      messages: formattedMessages,
      tools: functions.length > 0 ? functions : undefined,
      tool_choice: functions.length > 0 ? 'auto' : undefined,
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2000,
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
    _options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const functions = this.convertToolsToFunctions(tools);

    const provider = this.llmProvider as unknown as {
      model: string;
      config: {
        apiKey: string;
        baseURL?: string;
        temperature?: number;
        maxTokens?: number;
      };
    };
    const baseURL: string =
      provider.config.baseURL || 'https://api.deepseek.com/v1';

    yield* this.streamOpenAICompatible(
      `${baseURL}/chat/completions`,
      { Authorization: `Bearer ${provider.config.apiKey as string}` },
      {
        model: provider.model as string,
        messages: this.formatMessagesForDeepSeek(messages),
        tools: functions.length > 0 ? functions : undefined,
        tool_choice: functions.length > 0 ? 'auto' : undefined,
        temperature: provider.config.temperature || 0.7,
        max_tokens: provider.config.maxTokens || 2000,
        stream: true,
        stream_options: { include_usage: true },
      },
    );
  }
}
