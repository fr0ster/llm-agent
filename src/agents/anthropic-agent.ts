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
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to Anthropic tool format
    const anthropicTools = this.convertToolsToAnthropicTools(tools);

    // Format messages for Anthropic
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const formattedMessages =
      this.formatMessagesForAnthropic(conversationMessages);

    // Access Anthropic client and config
    const anthropicProvider = this.llmProvider as unknown as {
      client: {
        post(
          path: string,
          body: Record<string, unknown>,
        ): Promise<{ data: Record<string, unknown> }>;
      };
      model: string;
      config: {
        maxTokens?: number;
        temperature?: number;
      };
    };
    const client = anthropicProvider.client;
    const model = anthropicProvider.model;
    const config = anthropicProvider.config;

    // Call Anthropic API with tools
    const requestBody: Record<string, unknown> = {
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
   * Stream by falling back to a non-streaming call and yielding the result
   * as text + usage + done chunks.  Native SSE streaming can be added later.
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    _options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const result = await this.callLLMWithTools(messages, tools);

    if (result.content) {
      yield { type: 'text', delta: result.content };
    }

    // Anthropic returns usage as { input_tokens, output_tokens }
    // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
    const raw = result.raw as any;
    if (raw?.usage) {
      yield {
        type: 'usage',
        promptTokens: (raw.usage.input_tokens as number) ?? 0,
        completionTokens: (raw.usage.output_tokens as number) ?? 0,
      };
    }

    // Detect tool_calls finish reason
    const hasToolUse =
      Array.isArray(raw?.content) &&
      raw.content.some((b: { type?: string }) => b.type === 'tool_use');
    const finishReason = hasToolUse ? 'tool_calls' : 'stop';

    if (hasToolUse) {
      const toolCalls = raw.content
        .filter((b: { type?: string }) => b.type === 'tool_use')
        .map(
          (b: {
            id: string;
            name: string;
            input: Record<string, unknown>;
          }) => ({
            id: b.id,
            name: b.name,
            arguments: b.input ?? {},
          }),
        );
      yield { type: 'tool_calls', toolCalls };
    }

    yield { type: 'done', finishReason };
  }
}
