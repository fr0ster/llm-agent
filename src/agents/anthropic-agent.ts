/**
 * Anthropic Agent - Uses Anthropic tools API for tool integration
 *
 * Anthropic (Claude) supports tools via the `tools` parameter and returns
 * tool use blocks in the response content.
 */

import type { AnthropicProvider } from '../llm-providers/anthropic.js';
import type { Message, ToolDefinition } from '../types.js';
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
    tools: ToolDefinition[],
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to Anthropic tool format
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    // Format messages for Anthropic
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const formattedMessages =
      this.formatMessagesForAnthropic(conversationMessages);

    // Access Anthropic client and config
    const client = this.llmProvider.getClient();
    const model = this.llmProvider.getModel();
    const config = this.llmProvider.getProviderConfig();

    // Call Anthropic API with tools
    const requestBody: {
      model: string;
      messages: Array<{ role: 'assistant' | 'user'; content: string }>;
      max_tokens: number;
      temperature: number;
      system?: string;
      tools?: Array<{
        name: string;
        description: string;
        input_schema: unknown;
      }>;
    } = {
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
  private convertToolsToAnthropicTools(tools: ToolDefinition[]): Array<{
    name: string;
    description: string;
    input_schema: unknown;
  }> {
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
  private formatMessagesForAnthropic(
    messages: Message[],
  ): Array<{ role: 'assistant' | 'user'; content: string }> {
    return messages.map((msg) => {
      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      };
    });
  }
}
