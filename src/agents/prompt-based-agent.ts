/**
 * Prompt-Based Agent - Uses prompt description for tools (fallback for LLMs without function calling)
 * 
 * For LLMs that don't support function calling, tools are described in the system prompt.
 * The LLM responds with text that needs to be parsed to extract tool calls.
 */

import { BaseAgent, type BaseAgentConfig } from './base.js';
import type { LLMProvider } from '../llm-providers/base.js';
import type { Message, ToolCall } from '../types.js';

export interface PromptBasedAgentConfig extends BaseAgentConfig {
  llmProvider: LLMProvider;
}

export class PromptBasedAgent extends BaseAgent {
  private llmProvider: LLMProvider;

  constructor(config: PromptBasedAgentConfig) {
    super(config);
    this.llmProvider = config.llmProvider;
  }

  /**
   * Call LLM with tools described in prompt
   */
  protected async callLLMWithTools(
    messages: Message[],
    tools: any[]
  ): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    // Build system message with tool descriptions
    const systemMessage = this.buildSystemMessageWithTools(tools);
    
    // Prepare messages with system message
    const messagesWithSystem: Message[] = [
      { role: 'system', content: systemMessage },
      ...messages.filter(m => m.role !== 'system'),
    ];

    // Call LLM
    const response = await this.llmProvider.chat(messagesWithSystem);
    
    // Try to parse tool calls from response (simple pattern matching)
    const toolCalls = this.parseToolCallsFromResponse(response.content, tools);

    return {
      content: response.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Build system message with tool descriptions
   */
  private buildSystemMessageWithTools(tools: any[]): string {
    const toolDescriptions = tools.map(tool => {
      const params = tool.inputSchema?.properties 
        ? Object.entries(tool.inputSchema.properties)
            .map(([name, prop]: [string, any]) => `  - ${name}: ${prop.description || prop.type || 'any'}`)
            .join('\n')
        : '';
      
      return `- ${tool.name}: ${tool.description || 'No description'}
${params ? `  Parameters:\n${params}` : ''}`;
    }).join('\n\n');

    return `You are a helpful assistant with access to the following tools:

${toolDescriptions}

When you need to use a tool, respond in the following format:
TOOL_CALL: tool_name
ARGUMENTS: {"param1": "value1", "param2": "value2"}

After tool execution, you will receive the result and should continue the conversation.`;
  }

  /**
   * Parse tool calls from LLM response (simple pattern matching)
   * This is a basic implementation - can be improved with better parsing
   */
  private parseToolCallsFromResponse(content: string, tools: any[]): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const toolNames = tools.map(t => t.name);
    
    // Look for TOOL_CALL: pattern
    const toolCallRegex = /TOOL_CALL:\s*(\w+)\s*\nARGUMENTS:\s*({[^}]+})/g;
    let match;
    
    while ((match = toolCallRegex.exec(content)) !== null) {
      const toolName = match[1];
      if (toolNames.includes(toolName)) {
        try {
          const argumentsStr = match[2];
          const args = JSON.parse(argumentsStr);
          toolCalls.push({
            id: `call_${toolCalls.length}_${Date.now()}`,
            name: toolName,
            arguments: args,
          });
        } catch (e) {
          // Failed to parse arguments, skip
        }
      }
    }
    
    return toolCalls;
  }
}

