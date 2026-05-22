import type { PlanStep } from './coordinator.js';
import type { ISubAgent } from './subagent.js';

/**
 * Inputs to a single context-build invocation. Provided by the dispatcher
 * before it calls `ISubAgent.run()`.
 */
export interface SubAgentContextRequest {
  task: string;
  step: PlanStep;
  agent: ISubAgent;
  layer: number;
  inputText: string;
  sessionId: string;
  signal?: AbortSignal;
}

/**
 * Output of a context-build invocation. `context` is the bounded textual
 * preamble injected as `ISubAgentInput.context`. `sources` lists where each
 * fragment came from for observability/debugging.
 */
export interface SubAgentContextResult {
  context: string;
  sources: Array<{ kind: 'rag' | 'tool-rag' | 'artifact'; ref: string }>;
}

/**
 * Builds the `context` string passed to a subagent.
 *
 * Implementations should:
 * - Query relevant RAG stores using the current task.
 * - Query MCP-RAG/tool-description stores if available.
 * - Fetch exact artifacts only when the planner emitted refs.
 * - Bound the final context by token budget.
 * - NOT include arbitrary prior `stepResults`.
 */
export interface ISubAgentContextBuilder {
  build(req: SubAgentContextRequest): Promise<SubAgentContextResult>;
}
