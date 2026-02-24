/**
 * Anthropic Agent - Uses Anthropic tools API for tool integration
 *
 * Anthropic (Claude) supports tools via the `tools` parameter and returns
 * tool use blocks in the response content.
 */

import type {
  AnthropicConfig,
  AnthropicProvider,
} from '../llm-providers/anthropic.js';
import type { Message } from '../types.js';
import { BaseAgent, type BaseAgentConfig } from './base.js';

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
    tools: any[],
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to Anthropic tool format
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    // Format messages for Anthropic
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const formattedMessages =
      this.formatMessagesForAnthropic(conversationMessages);

    // Access Anthropic client and config
    const anthropicProvider = this.llmProvider as any;
    const client = anthropicProvider.client;
    const model = anthropicProvider.model;
    const config = anthropicProvider.config;

    // Call Anthropic API with tools
    const requestBody: any = {
      model,
      messages: formattedMessages,
      max_tokens: config.maxTokens || 2000,
      temperature: config.temperature || 0.7,
    };

    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

    if (anthropicTools.length > 0) {
      requestBody.tools = anthropicTools;
    }

    const response = await client.post('/messages', requestBody);

    const content = response.data.content;
    let textContent = '';

    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      }
    }

    return {
      content: textContent,
      raw: response.data,
    };
  }

  /**
   * Convert MCP tools to Anthropic tool format
   */
  private convertToolsToAnthropicTools(tools: any[]): any[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.inputSchema || {
        type: 'object',
        properties: {},
      },
    }));
  }

  /**
   * Format messages for Anthropic API
   */
  private formatMessagesForAnthropic(messages: Message[]): any[] {
    return messages.map((msg) => {
      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      };
    });
  }

  protected async *streamLLMWithTools(
    _messages: Message[],
    _tools: any[],
    _options?: any,
  ): AsyncIterable<{ content: string; raw?: unknown }> {
    throw new Error('Streaming is not implemented for AnthropicAgent');
  }
}
