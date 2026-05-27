import type { ContextPath } from './context-path.js';
import type { DagPlan } from './dag-plan.js';
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
  /** Hierarchical ancestor context (parent objective + clarification Q/A +
   *  oracle observations). Threaded into node task composition. */
  ancestorContext?: ContextPath;
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
  /** Set when ok === false: the node whose failure stopped the run (first
   *  plan-node-order node with status 'failed'). */
  failedNodeId?: string;
  /** The final plan after any in-run local splices. */
  executedPlan?: DagPlan;
}
