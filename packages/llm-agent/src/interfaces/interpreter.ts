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
  /**
   * This coordinator's depth (root = 0); workers run at `layer + 1`. Required:
   * `InterpretContext` is constructed fresh by the coordinator (it derives this
   * from its own `ctx.layer ?? 0`), so it is always populated — it is NOT
   * derived from the optional `ICoordinatorContext.layer`.
   */
  layer: number;
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
