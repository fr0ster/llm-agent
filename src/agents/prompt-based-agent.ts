/**
 * Prompt-Based Agent - Uses prompt description for tools (fallback for LLMs without function calling)
 * 
 * For LLMs that don't support function calling, tools are described in the system prompt.
 * The LLM responds with text that needs to be parsed to extract tool calls.
 */

import { BaseAgent, type BaseAgentConfig } from './base.js';
import type { LLMProvider } from '../llm-providers/base.js';
import type { Message, ToolCall, ToolResult } from '../types.js';

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
   * 
   * IMPORTANT: Explains that tool results will be provided as separate messages,
   * not as part of user input. LLM should use tool_result data to answer.
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

**How to use tools:**
When you need to use a tool, respond in JSON format:
{"tool": "tool_name", "args": {"param1": "value1", "param2": "value2"}}

Or in text format:
TOOL_CALL: tool_name
ARGUMENTS: {"param1": "value1", "param2": "value2"}

**How tool results work:**
After tool execution, you will receive a separate message with tool results in this format:
{"tool_result": {"tool": "tool_name", "data": {...}}}

This tool_result message is NOT from the user - it's the actual result from the tool.
Use the data from tool_result to answer the user's question. Do not make up data that isn't in tool_result.
Only use information that is explicitly provided in tool_result messages.`;
  }

  /**
   * Add tool results to conversation history
   * 
   * For prompt-based models, tool results are added as assistant messages
   * with JSON format: {"tool_result": {"tool": "...", "data": {...}}}
   * 
   * This allows LLM to clearly see tool results as separate from user input.
   */
  protected addToolResultsToHistory(toolResults: ToolResult[], toolCalls: ToolCall[]): void {
    for (const result of toolResults) {
      const toolCall = toolCalls.find(tc => tc.id === result.toolCallId);
      if (toolCall) {
        // Add as assistant message with JSON tool_result format
        // This is NOT a user message - it's a tool result that LLM should process
        const toolResultJson = {
          tool_result: {
            tool: result.name,
            data: result.error ? { error: result.error } : result.result,
          },
        };
        
        this.conversationHistory.push({
          role: 'assistant',
          content: JSON.stringify(toolResultJson),
        });
      }
    }
  }

  /**
   * Parse tool calls from LLM response
   * 
   * Supports two formats:
   * 1. JSON format: {"tool": "name", "args": {...}}
   * 2. Text format: TOOL_CALL: name\nARGUMENTS: {...}
   */
  private parseToolCallsFromResponse(content: string, tools: any[]): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const toolNames = tools.map(t => t.name);
    
    // Try JSON format first (preferred)
    try {
      const jsonMatch = content.match(/\{[\s\S]*"tool"[\s\S]*"args"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.tool && toolNames.includes(parsed.tool)) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            name: parsed.tool,
            arguments: parsed.args || {},
          });
          return toolCalls;
        }
      }
    } catch (e) {
      // Not JSON, try text format
    }
    
    // Fallback to text format: TOOL_CALL: name\nARGUMENTS: {...}
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

