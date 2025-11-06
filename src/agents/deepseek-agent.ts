/**
 * DeepSeek Agent - Uses DeepSeek function calling (similar to OpenAI)
 * 
 * DeepSeek supports function calling similar to OpenAI via the `tools` parameter.
 */

import { BaseAgent, type BaseAgentConfig } from './base.js';
import { DeepSeekProvider, type DeepSeekConfig } from '../llm-providers/deepseek.js';
import type { Message, ToolCall } from '../types.js';

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
    tools: any[]
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
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
   * Convert MCP tools to DeepSeek function format
   */
  private convertToolsToFunctions(tools: any[]): any[] {
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
   * Format messages for DeepSeek API (same as OpenAI)
   */
  private formatMessagesForDeepSeek(messages: Message[]): any[] {
    return messages.map(msg => {
      const formatted: any = {
        role: msg.role,
        content: msg.content,
      };
      
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
      
      if (msg.toolCallId) {
        formatted.role = 'tool';
        formatted.tool_call_id = msg.toolCallId;
      }
      
      return formatted;
    });
  }
}

