/**
 * OpenAI Agent - Uses OpenAI function calling for tool integration
 * 
 * OpenAI supports function calling via the `tools` parameter in chat completions.
 * Tools are passed as JSON schema, and LLM returns function calls in response.
 */

import { BaseAgent, type BaseAgentConfig } from './base.js';
import { OpenAIProvider, type OpenAIConfig } from '../llm-providers/openai.js';
import type { Message, ToolCall } from '../types.js';

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
    tools: any[]
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
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
      temperature: config.temperature || 0.7,
      max_tokens: config.maxTokens || 2000,
    });

    const choice = response.data.choices[0];
    const message = choice.message;
    
    // Extract tool calls if present
    const toolCalls: ToolCall[] = [];
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        toolCalls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments || '{}'),
        });
      }
    }

    return {
      content: message.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Convert MCP tools to OpenAI function format
   */
  private convertToolsToOpenAIFunctions(tools: any[]): any[] {
    return tools.map(tool => ({
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
    return messages.map(msg => {
      const formatted: any = {
        role: msg.role,
        content: msg.content,
      };
      
      // Add tool calls if present
      if (msg.toolCalls) {
        formatted.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }
      
      // Add tool call ID if present (for tool result messages)
      if (msg.toolCallId) {
        formatted.role = 'tool';
        formatted.tool_call_id = msg.toolCallId;
      }
      
      return formatted;
    });
  }
}

