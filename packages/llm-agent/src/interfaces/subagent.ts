import type { LlmToolCall, LlmUsage } from './types.js';

export interface ISubAgentInput {
  task: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ISubAgentResult {
  output: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
  metadata?: Record<string, unknown>;
}

export interface ISubAgent {
  readonly name: string;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
