/**
 * Core types for LLM Agent
 */

export interface Message {
  /**
   * Message role
   * - 'user': User input
   * - 'assistant': LLM response (may include tool calls or tool results)
   * - 'system': System instructions
   * - 'tool': Tool/function result (for OpenAI-style models)
   */
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /**
   * Tool calls made by assistant (if any)
   */
  toolCalls?: ToolCall[];
  /**
   * Tool call ID (for tool result messages)
   */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: any;
  error?: string;
}

export interface AgentResponse {
  message: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  error?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

