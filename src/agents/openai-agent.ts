/**
 * OpenAI Agent - Uses OpenAI function calling for tool integration
 *
 * OpenAI supports function calling via the `tools` parameter in chat completions.
 * Tools are passed as JSON schema, and LLM returns function calls in response.
 */

import type { OpenAIProvider } from '../llm-providers/openai.js';
import type { AgentStreamChunk, Message } from '../types.js';
import {
  type AgentCallOptions,
  BaseAgent,
  type BaseAgentConfig,
} from './base.js';

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
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    // Convert MCP tools to OpenAI function format
    const functions = this.convertToolsToOpenAIFunctions(tools);

    // Format messages for OpenAI
    const formattedMessages = this.formatMessagesForOpenAI(messages);

    const { client, model, config } = this.llmProvider;

    // Call OpenAI API with tools
    const response = await client.post('/chat/completions', {
      model: options?.model ?? model,
      messages: formattedMessages,
      tools: functions.length > 0 ? functions : undefined,
      tool_choice: functions.length > 0 ? 'auto' : undefined,
      temperature: options?.temperature ?? config.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
      top_p: options?.topP,
      stop: options?.stop,
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
   * Stream OpenAI response
   */
  protected async *streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const functions = this.convertToolsToOpenAIFunctions(tools);

    const { model, config } = this.llmProvider;
    const baseURL = config.baseURL || 'https://api.openai.com/v1';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
    };
    if (config.organization) {
      headers['OpenAI-Organization'] = config.organization;
    }
    if (config.project) {
      headers['OpenAI-Project'] = config.project;
    }

    yield* this.streamOpenAICompatible(`${baseURL}/chat/completions`, headers, {
      model: options?.model ?? model,
      messages: this.formatMessagesForOpenAI(messages),
      tools: functions.length > 0 ? functions : undefined,
      tool_choice: functions.length > 0 ? 'auto' : undefined,
      temperature: options?.temperature ?? config.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 4096,
      top_p: options?.topP,
      stop: options?.stop,
      stream: true,
      stream_options: { include_usage: true },
    });
  }

  /**
   * Convert MCP tools to OpenAI function format
   */
  private convertToolsToOpenAIFunctions(
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
   * Format messages for OpenAI API
   */
  private formatMessagesForOpenAI(
    messages: Message[],
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content || null, // OpenAI requires null if empty
      tool_calls: msg.tool_calls,
      tool_call_id: msg.tool_call_id,
    }));
  }
}
