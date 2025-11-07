/**
 * Base Agent - Abstract class for LLM-specific agent implementations
 * 
 * Each LLM provider has different ways of handling tools:
 * - OpenAI: function calling via tools parameter
 * - Anthropic: tools in messages
 * - DeepSeek: function calling or prompt-based
 * 
 * This base class provides common logic, subclasses implement LLM-specific tool handling.
 */

import { MCPClientWrapper, type MCPClientConfig } from '../mcp/client.js';
import type { Message, AgentResponse, ToolCall, ToolResult } from '../types.js';
import type { LLMProvider } from '../llm-providers/base.js';

export interface BaseAgentConfig {
  /**
   * MCP client instance (if provided, will be used directly)
   * If not provided, will be created from mcpConfig
   */
  mcpClient?: MCPClientWrapper;
  /**
   * Direct MCP configuration (used if mcpClient is not provided)
   */
  mcpConfig?: MCPClientConfig;
  maxIterations?: number;
}

/**
 * Base Agent class - provides common logic for all agent implementations
 */
export abstract class BaseAgent {
  protected mcpClient: MCPClientWrapper;
  protected maxIterations: number;
  protected conversationHistory: Message[] = [];
  protected tools: any[] = [];

  constructor(config: BaseAgentConfig) {
    this.maxIterations = config.maxIterations || 5;
    
    // Initialize MCP client
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
    } else if (config.mcpConfig) {
      this.mcpClient = new MCPClientWrapper(config.mcpConfig);
    } else {
      throw new Error(
        'MCP client configuration required. Provide either mcpClient or mcpConfig.'
      );
    }
  }

  /**
   * Initialize MCP client connection (call this before using the agent)
   * If connection fails, agent will work in LLM-only mode (no tools)
   */
  async connect(): Promise<void> {
    try {
      await this.mcpClient.connect();
      // Load tools once connected
      this.tools = await this.mcpClient.listTools();
    } catch (error: any) {
      // If connection fails, agent will work without tools (LLM-only mode)
      // Set empty tools array to ensure agent can still process messages
      this.tools = [];
      // Re-throw to let caller know connection failed
      // Caller can decide whether to continue or fail
      throw error;
    }
  }

  /**
   * Process a user message and return agent response
   * Template method - subclasses implement LLM-specific logic
   */
  async process(userMessage: string): Promise<AgentResponse> {
    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Get LLM response with tools (LLM-specific implementation)
      const llmResponse = await this.callLLMWithTools(this.conversationHistory, this.tools);
      
      // Handle tool calls if present
      if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
        return await this.handleToolCalls(llmResponse.toolCalls);
      }

      // No tool calls - return text response
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
   * Call LLM with tools - LLM-specific implementation
   * Subclasses must implement this to handle their specific tool format
   */
  protected abstract callLLMWithTools(
    messages: Message[],
    tools: any[]
  ): Promise<{ content: string; toolCalls?: ToolCall[] }>;

  /**
   * Handle tool calls - execute tools and get response
   * 
   * IMPORTANT: Tool results are NOT added as user messages.
   * They are added as separate tool/function result messages.
   * 
   * For OpenAI-style models: role='tool' with tool_call_id
   * For prompt-based models: role='assistant' with JSON tool_result
   */
  protected async handleToolCalls(toolCalls: ToolCall[]): Promise<AgentResponse> {
    // Execute all tool calls
    const toolResults = await this.mcpClient.callTools(toolCalls);
    
    // Add assistant message with tool calls to history
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      toolCalls,
    };
    this.conversationHistory.push(assistantMessage);

    // Add tool results using LLM-specific format
    // This method is overridden by subclasses to use correct format
    this.addToolResultsToHistory(toolResults, toolCalls);

    // Get final response from LLM (with tool results in context)
    const finalResponse = await this.callLLMWithTools(this.conversationHistory, this.tools);
    
    // If LLM made more tool calls, handle them recursively
    if (finalResponse.toolCalls && finalResponse.toolCalls.length > 0) {
      // Check iteration limit
      const currentIterations = this.conversationHistory.filter(m => m.toolCalls).length;
      if (currentIterations >= this.maxIterations) {
        return {
          message: finalResponse.content || 'Maximum iterations reached',
          toolCalls,
          toolResults,
        };
      }
      // Recursively handle new tool calls
      return await this.handleToolCalls(finalResponse.toolCalls);
    }
    
    // No more tool calls - add final response
    this.conversationHistory.push({
      role: 'assistant',
      content: finalResponse.content,
    });

    return {
      message: finalResponse.content,
      toolCalls,
      toolResults,
    };
  }

  /**
   * Add tool results to conversation history
   * 
   * This method is overridden by subclasses to use LLM-specific format:
   * - OpenAI-style: role='tool' with tool_call_id
   * - Prompt-based: role='assistant' with JSON tool_result
   */
  protected addToolResultsToHistory(toolResults: ToolResult[], toolCalls: ToolCall[]): void {
    // Default implementation: add as tool messages (OpenAI-style)
    // Subclasses can override for different formats
    for (const result of toolResults) {
      const toolCall = toolCalls.find(tc => tc.id === result.toolCallId);
      if (toolCall) {
        this.conversationHistory.push({
          role: 'tool',
          content: result.error 
            ? JSON.stringify({ error: result.error })
            : JSON.stringify(result.result),
          toolCallId: result.toolCallId,
        });
      }
    }
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

