import type { LlmUsage } from './types.js';
import type { IUsageRecorder } from './usage.js';

export interface StateOracleInput {
  query: string;
  sessionId?: string;
  usage?: IUsageRecorder;
  signal?: AbortSignal;
  trace?: { traceId: string };
  sessionLogger?: { logStep(name: string, data: unknown, area?: string): void };
}

export interface StateOracleResult {
  answer: string;
  usage?: LlmUsage;
}

export interface IStateOracle {
  readonly name: string;
  readonly model?: string;
  query(input: StateOracleInput): Promise<StateOracleResult>;
}
