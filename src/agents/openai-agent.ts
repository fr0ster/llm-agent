/**
 * OpenAI Agent - Uses OpenAI function calling for tool integration
 *
 * OpenAI supports function calling via the `tools` parameter in chat completions.
 * Tools are passed as JSON schema, and LLM returns function calls in response.
 */

import type { OpenAIProvider } from '../llm-providers/openai.js';
import type { Message, ToolDefinition } from '../types.js';
import { BaseAgent, type BaseAgentConfig } from './base.js';

export interface OpenAIAgentConfig extends BaseAgentConfig {
  llmProvider: OpenAIProvider;
}

export class OpenAIAgent extends BaseAgent {
  private llmProvider: OpenAIProvider;

  constructor(config: OpenAIAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call OpenAI with tools using function calling
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to OpenAI function format
    const functions = this.convertToolsToOpenAIFunctions(tools);

    // Format messages for OpenAI
    const formattedMessages = this.formatMessagesForOpenAI(messages);

    // Access OpenAI client and config
    const client = this.llmProvider.getClient();
    const model = this.llmProvider.getModel();
    const config = this.llmProvider.getProviderConfig();

    // Call OpenAI API with tools
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
   * Convert MCP tools to OpenAI function format
   */
  private convertToolsToOpenAIFunctions(tools: ToolDefinition[]): Array<{
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
   * Format messages for OpenAI API
   */
  private formatMessagesForOpenAI(
    messages: Message[],
  ): Array<{ role: Message['role']; content: string | null }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content || null, // OpenAI requires null if empty
    }));
  }
}
