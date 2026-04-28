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
  content: string | null;
  /** For role='tool': ID of the tool call this result corresponds to (OpenAI/DeepSeek protocol) */
  tool_call_id?: string;
  /** For role='assistant': tool calls requested by the LLM (OpenAI/DeepSeek protocol) */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
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
  /**
   * Streaming tool-call deltas emitted by the underlying provider, normalized
   * across providers (SAP AI SDK, OpenAI/DeepSeek, Anthropic). Populated only
   * by `streamChat()`. Consumers (e.g. LlmProviderBridge) should accumulate
   * these by `index` to reconstruct full tool calls.
   */
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
export interface LLMProviderConfig {
  /** API key for authentication. Optional for providers with custom auth (e.g. SAP AI Core). */
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
export interface LLMCallOptions {
  /** Per-request model override. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
}
export type AgentStreamChunk =
  | {
      type: 'text';
      delta: string;
    }
  | {
      type: 'tool_calls';
      toolCalls: ToolCall[];
    }
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
    }
  | {
      type: 'done';
      finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    };
//# sourceMappingURL=types.d.ts.map
