/**
 * OpenAI Agent - Uses OpenAI function calling for tool integration
 *
 * OpenAI supports function calling via the `tools` parameter in chat completions.
 * Tools are passed as JSON schema, and LLM returns function calls in response.
 */

import type { OpenAIConfig, OpenAIProvider } from '../llm-providers/openai.js';
import type { Message } from '../types.js';
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
    tools: any[],
    options?: any,
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to OpenAI function format
    const functions = this.convertToolsToOpenAIFunctions(tools);

    // Format messages for OpenAI
    const formattedMessages = this.formatMessagesForOpenAI(messages);

    // Access OpenAI client and config
    const openaiProvider = this.llmProvider as any;
    const client = openaiProvider.client;
    const model = openaiProvider.model;
    const config = openaiProvider.config;

    // Call OpenAI API with tools
    const response = await client.post('/chat/completions', {
      model,
      messages: formattedMessages,
      tools: functions.length > 0 ? functions : undefined,
      tool_choice: functions.length > 0 ? 'auto' : undefined,
      temperature: options?.temperature ?? config.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 2000,
      top_p: options?.topP,
      stop: options?.stop,
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
  private convertToolsToOpenAIFunctions(tools: any[]): any[] {
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
  private formatMessagesForOpenAI(messages: Message[]): any[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content || null, // OpenAI requires null if empty
      tool_calls: msg.tool_calls,
      tool_call_id: msg.tool_call_id,
    }));
  }
}
