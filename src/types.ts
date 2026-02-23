/**
 * Core types for LLM Proxy
 */

export interface Message {
  /**
   * Message role
   * - 'user': User input
   * - 'assistant': LLM response
   * - 'system': System instructions
   * - 'tool': Tool/function result
   */
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** For role='tool': ID of the tool call this result corresponds to (OpenAI/DeepSeek protocol) */
  tool_call_id?: string;
  /** For role='assistant': tool calls requested by the LLM (OpenAI/DeepSeek protocol) */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
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
