import type { AgentStreamChunk, Message } from '../types.js';
import type { CallOptions, ModelUsageEntry } from './types.js';
import { SmartAgentError } from './types.js';
export declare class OrchestratorError extends SmartAgentError {
  constructor(message: string, code?: string);
}
export type StopReason =
  | 'stop'
  | 'tool_calls'
  | 'iteration_limit'
  | 'tool_call_limit';
export interface SmartAgentResponse {
  content: string;
  iterations: number;
  toolCallCount: number;
  stopReason: StopReason;
  /** External tool calls requested by the LLM (OpenAI wire format). */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    models?: Record<string, ModelUsageEntry>;
  };
}
export interface AgentCallOptions extends CallOptions {
  externalTools?: unknown[];
}
/**
 * Bridge interface for agent implementations that wrap LLM providers.
 * Used by LlmAdapter in llm-agent-server to wrap legacy BaseAgent subclasses.
 */
export interface BaseAgentLlmBridge {
  callWithTools(
    messages: Message[],
    tools: unknown[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stop?: string[];
    },
  ): Promise<{
    content: string;
    raw?: unknown;
  }>;
  streamWithTools(
    messages: Message[],
    tools: unknown[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stop?: string[];
    },
  ): AsyncGenerator<
    | {
        content: string;
        raw?: unknown;
      }
    | AgentStreamChunk,
    void,
    unknown
  >;
}
//# sourceMappingURL=agent-contracts.d.ts.map
