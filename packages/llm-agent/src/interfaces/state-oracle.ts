import type { IRequestLogger } from './request-logger.js';
import type { LlmUsageAttribution } from './types.js';
import type { IUsageRecorder } from './usage.js';

export interface StateOracleInput {
  caller: import('./rag-access.js').RagCaller;
  query: string;
  sessionId?: string;
  usage?: IUsageRecorder;
  requestLogger?: IRequestLogger;
  signal?: AbortSignal;
  trace?: { traceId: string };
  sessionLogger?: { logStep(name: string, data: unknown, area?: string): void };
}

export interface StateOracleResult extends LlmUsageAttribution {
  answer: string;
}

export interface IStateOracle {
  readonly name: string;
  readonly model?: string;
  query(input: StateOracleInput): Promise<StateOracleResult>;
}
