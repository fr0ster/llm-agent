/**
 * Core types for LLM Proxy
 */

export interface Message {
  /**
   * Message role
   * - 'user': User input
   * - 'assistant': LLM response
   * - 'system': System instructions
   * - 'tool': Tool/function result (reserved for external consumers)
   */
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
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
  raw?: unknown;
  error?: string;
}

export interface LLMResponse {
  content: string;
  raw?: unknown;
  finishReason?: string;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
