/**
 * DeepSeek Agent - Uses DeepSeek function calling (similar to OpenAI)
 *
 * DeepSeek supports function calling similar to OpenAI via the `tools` parameter.
 */

import type { DeepSeekProvider } from '../llm-providers/deepseek.js';
import type { Message, ToolDefinition } from '../types.js';
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
    tools: ToolDefinition[],
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to DeepSeek function format (same as OpenAI)
    const functions = this.convertToolsToFunctions(tools);

    // Format messages for DeepSeek
    const formattedMessages = this.formatMessagesForDeepSeek(messages);

    // Access DeepSeek client and config
    const client = this.llmProvider.getClient();
    const model = this.llmProvider.getModel();
    const config = this.llmProvider.getProviderConfig();

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
  private convertToolsToFunctions(tools: ToolDefinition[]): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }> {
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
  private formatMessagesForDeepSeek(
    messages: Message[],
  ): Array<{ role: Message['role']; content: string }> {
    return messages.map((msg) => {
      const formatted = {
        role: msg.role,
        content: msg.content,
      };

      return formatted;
    });
  }
}
