/**
 * Core Agent Orchestrator
 * 
 * Coordinates between LLM provider and MCP tools
 */

import type { LLMProvider } from './llm-providers/base.js';
import { MCPClientWrapper } from './mcp/client.js';
import type { Message, AgentResponse, ToolCall } from './types.js';

export interface AgentConfig {
  llmProvider: LLMProvider;
  mcpClient: MCPClientWrapper;
  maxIterations?: number;
}

export class Agent {
  private llmProvider: LLMProvider;
  private mcpClient: MCPClientWrapper;
  private maxIterations: number;
  private conversationHistory: Message[] = [];

  constructor(config: AgentConfig) {
    this.llmProvider = config.llmProvider;
    this.mcpClient = config.mcpClient;
    this.maxIterations = config.maxIterations || 5;
  }

  /**
   * Process a user message and return agent response
   */
  async process(userMessage: string): Promise<AgentResponse> {
    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Get available tools from MCP
      const tools = await this.mcpClient.listTools();
      
      // Build system message with tool definitions
      const systemMessage = this.buildSystemMessage(tools);
      
      // Prepare messages for LLM
      const messages: Message[] = [
        { role: 'system', content: systemMessage },
        ...this.conversationHistory,
      ];

      // Get LLM response
      const llmResponse = await this.llmProvider.chat(messages);
      
      // For now, return simple response
      // TODO: Parse tool calls from LLM response when function calling is implemented
      
      // Add assistant response to history
      this.conversationHistory.push({
        role: 'assistant',
        content: llmResponse.content,
      });

      return {
        message: llmResponse.content,
      };
    } catch (error: any) {
      return {
        message: '',
        error: error.message || 'Agent processing failed',
      };
    }
  }

  /**
   * Build system message with tool definitions
   */
  private buildSystemMessage(tools: any[]): string {
    const toolDescriptions = tools.map(tool => {
      return `- ${tool.name}: ${tool.description || 'No description'}`;
    }).join('\n');

    return `You are a helpful assistant with access to the following tools:

${toolDescriptions}

When you need to use a tool, respond with the tool name and required parameters.
For now, provide helpful responses based on the user's questions.`;
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory(): Message[] {
    return [...this.conversationHistory];
  }
}

