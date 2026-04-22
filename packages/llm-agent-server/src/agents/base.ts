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

import type {
  AgentResponse,
  AgentStreamChunk,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { type MCPClientConfig, MCPClientWrapper } from '../mcp/client.js';

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
}

export interface AgentCallOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  model?: string;
}

export interface BaseAgentLlmBridge {
  callWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }>;
  streamWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown>;
}

/**
 * Base Agent class - provides common logic for all agent implementations
 */
export abstract class BaseAgent implements BaseAgentLlmBridge {
  protected mcpClient: MCPClientWrapper;
  protected conversationHistory: Message[] = [];
  protected tools: unknown[] = [];

  constructor(config: BaseAgentConfig) {
    // Initialize MCP client
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient;
    } else if (config.mcpConfig) {
      this.mcpClient = new MCPClientWrapper(config.mcpConfig);
    } else {
      throw new Error(
        'MCP client configuration required. Provide either mcpClient or mcpConfig.',
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
    } catch (error: unknown) {
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
   * Subclasses handle provider-specific tool formatting only.
   * Tool execution is left to the consumer of this library.
   */
  async process(userMessage: string): Promise<AgentResponse> {
    try {
      // Add user message to history
      this.conversationHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Get LLM response with tools (LLM-specific implementation)
      const llmResponse = await this.callLLMWithTools(
        this.conversationHistory,
        this.tools,
      );

      this.conversationHistory.push({
        role: 'assistant',
        content: llmResponse.content,
      });

      return {
        message: llmResponse.content,
        raw: llmResponse.raw,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        message: '',
        error: errorMessage || 'Agent processing failed',
      };
    }
  }

  /**
   * Call LLM with tools - LLM-specific implementation
   * Subclasses must implement this to handle their specific tool format
   */
  protected abstract callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }>;

  /**
   * Stream LLM with tools - LLM-specific implementation
   */
  protected abstract streamLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown>;

  /**
   * Public typed bridge for adapter layer. Keeps provider-specific logic in
   * protected methods while removing adapter-side `any` access.
   */
  async callWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
    return this.callLLMWithTools(messages, tools, options);
  }

  /**
   * Public typed bridge for streaming adapter layer.
   */
  streamWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    return this.streamLLMWithTools(messages, tools, options);
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
