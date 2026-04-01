// src/smart-agent/interfaces/agent-contracts.ts
import type { CallOptions } from './types.js';
import { SmartAgentError } from './types.js';

export class OrchestratorError extends SmartAgentError {
  constructor(message: string, code = 'ORCHESTRATOR_ERROR') {
    super(message, code);
    this.name = 'OrchestratorError';
  }
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
    function: { name: string; arguments: string };
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AgentCallOptions extends CallOptions {
  externalTools?: unknown[];
}
