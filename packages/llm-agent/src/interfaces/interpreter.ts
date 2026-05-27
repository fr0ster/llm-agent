import type { IErrorStrategy } from './error-strategy.js';
import type { ISubAgent } from './subagent.js';

export interface IInterpreter<TInput, TOutput> {
  readonly name: string;
  interpret(input: TInput, ctx: InterpretContext): Promise<TOutput>;
}

export interface InterpretContext {
  inputText: string;
  workers: ReadonlyMap<string, ISubAgent>;
  sessionId: string;
  signal?: AbortSignal;
  /** Reaction to a node failure (abort | replan). Always populated by the
   *  caller; defaults to AbortErrorStrategy. */
  errorStrategy: IErrorStrategy;
}

export interface NodeResult {
  nodeId: string;
  output: string;
  status: 'done' | 'failed' | 'skipped';
  /** Populated by convention when `status === 'failed'` (the failure reason). */
  error?: string;
  durationMs: number;
}

export interface InterpretResult {
  nodeResults: Record<string, NodeResult>;
  ok: boolean;
  error?: string;
  output: string;
}
