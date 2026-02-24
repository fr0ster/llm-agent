/**
 * DeepSeek Agent - Uses DeepSeek function calling (similar to OpenAI)
 *
 * DeepSeek supports function calling similar to OpenAI via the `tools` parameter.
 */

import type {
  DeepSeekConfig,
  DeepSeekProvider,
} from '../llm-providers/deepseek.js';
import type { Message } from '../types.js';
import { BaseAgent, type BaseAgentConfig } from './base.js';

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
    tools: any[],
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to DeepSeek function format (same as OpenAI)
    const functions = this.convertToolsToFunctions(tools);

    // Format messages for DeepSeek
    const formattedMessages = this.formatMessagesForDeepSeek(messages);

    // Access DeepSeek client and config
    const deepseekProvider = this.llmProvider as any;
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

    const choice = response.data.choices[0];
    const message = choice.message;

    return {
      content: message.content || '',
      raw: response.data,
    };
  }

  /**
   * Convert MCP tools to DeepSeek function format
   */
  private convertToolsToFunctions(tools: any[]): any[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema || {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  /**
   * Format messages for DeepSeek API (same as OpenAI)
   */
  private formatMessagesForDeepSeek(messages: Message[]): any[] {
    return messages.map((msg) => {
      const formatted: any = {
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

  protected async *streamLLMWithTools(
    _messages: Message[],
    _tools: any[],
    _options?: any,
  ): AsyncIterable<{ content: string; raw?: unknown }> {
    throw new Error('Streaming is not implemented for DeepSeekAgent');
  }
}
