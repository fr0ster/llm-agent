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
    // Convert MCP tools to Anthropic tool format
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    // Format messages for Anthropic
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const formattedMessages =
      this.formatMessagesForAnthropic(conversationMessages);

    const { client, model, config } = this.llmProvider;

    // Call Anthropic API with tools
    const requestBody: Record<string, unknown> = {
      model: options?.model ?? model,
      messages: formattedMessages,
      max_tokens: config.maxTokens || 4096,
      temperature: config.temperature || 0.7,
    };

    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

    if (anthropicTools.length > 0) {
      requestBody.tools = anthropicTools;
    }

    const response = await client.post('/messages', requestBody);

    const content = response.data.content as Array<{
      type?: string;
      text?: string;
    }>;
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

  /**
   * Format messages for Anthropic API
   */
  private formatMessagesForAnthropic(
    messages: Message[],
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      };
    });
  }

  /**
   * Stream Anthropic response via real SSE streaming.
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const formattedMessages =
      this.formatMessagesForAnthropic(conversationMessages);

    const { model, config } = this.llmProvider;

    const baseURL = config.baseURL || 'https://api.anthropic.com/v1';
    const headers: Record<string, string> = {
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };

    const requestBody: Record<string, unknown> = {
      model: options?.model ?? model,
      messages: formattedMessages,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
      temperature: options?.temperature ?? config.temperature ?? 0.7,
      stream: true,
    };

    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }

    if (anthropicTools.length > 0) {
      requestBody.tools = anthropicTools;
    }

    if (options?.topP !== undefined) {
      requestBody.top_p = options.topP;
    }

    if (options?.stop) {
      requestBody.stop_sequences = options.stop;
    }

    yield* this.streamAnthropicSSE(`${baseURL}/messages`, headers, requestBody);
  }
}
