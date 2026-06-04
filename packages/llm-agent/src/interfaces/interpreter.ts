import type { ContextPath } from './context-path.js';
import type { DagPlan } from './dag-plan.js';
import type { IErrorStrategy } from './error-strategy.js';
import type { OnPartial } from './streaming.js';
import type { ISubAgent } from './subagent.js';
import type { LlmTool, LlmToolCall } from './types.js';

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
  /** Request correlation, threaded into each worker dispatch. */
  trace?: { traceId: string };
  /** Per-request session debugger logger, threaded into each worker dispatch
   *  so worker stages write to the parent's per-request session-log directory. */
  sessionLogger?: {
    logStep(name: string, data: unknown): void;
  };
  /** Forwarded into each `worker.run({ ..., onPartial })`; the
   *  interpreter annotates `nodeId` before calling and emits
   *  `node-start` / `node-end` itself. */
  onPartial?: OnPartial;
  /** Client external (consumer-executed) tools, threaded into each worker
   *  dispatch so a worker can emit a tool call the client fulfils (issue #167).
   *  Absent → workers see only their own MCP tools. */
  externalTools?: readonly LlmTool[];
  /** Validated `extId → result` map from the incoming history (#171,
   *  review#7). Threaded into each worker dispatch so a re-surfaced external
   *  call resolves from history on stateless resume. */
  externalResults?: Map<string, string>;
}

export interface NodeResult {
  nodeId: string;
  output: string;
  status: 'done' | 'failed' | 'skipped' | 'awaiting-external';
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
  /** The final plan after any in-run local splices. Populated on BOTH success and failure. */
  executedPlan?: DagPlan;
  /** Topological execution order of node ids in actual run order. */
  executionOrder: readonly string[];
  /** The external tool calls surfaced during the run (deterministic `ext:` ids).
   *  Present iff at least one node reached status 'awaiting-external' (#171). */
  pendingExternalToolCalls?: LlmToolCall[];
}
