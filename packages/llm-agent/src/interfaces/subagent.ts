import type { LlmToolCall, LlmUsage } from './types.js';

/**
 * High-level subagent execution model.
 *
 * - `autonomous`: runs the full SmartAgent pipeline (own RAG, MCP, skills,
 *   classifier, optional CoordinatorHandler). At layer 0 it may dispatch
 *   children; at deeper layers it must not.
 * - `constrained`: a leaf-node subagent that performs a single LLM call
 *   over injected context. Never dispatches children.
 */
export type SubAgentKind = 'autonomous' | 'constrained';

/**
 * Typed metadata that the planner/validator can read without invoking the
 * agent. Used to enforce layer rules and to decide whether to call the
 * context builder before dispatch.
 */
export interface SubAgentCapabilities {
  kind: SubAgentKind;
  /** Whether this agent is allowed to dispatch child subagents from inside its own plan. */
  canDispatchChildren: boolean;
  /**
   * Context handling expectations:
   * - 'required': dispatch must populate `input.context`; missing context is an error.
   * - 'optional': context is treated as preamble if present.
   * - 'forbidden': context must be omitted; the agent ignores any value passed.
   */
  contextPolicy: 'required' | 'optional' | 'forbidden';
}

/**
 * Minimal epicfail trace surfaced from a child subagent. The full Phase 2
 * trace shape (with class-based attempts) lives in @mcp-abap-adt/llm-agent
 * coordinator interfaces; see `EpicFailTrace`.
 */
export interface ISubAgentInput {
  task: string;
  /** Assembled context preamble (required when capabilities.contextPolicy === 'required'). */
  context?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Dispatch depth. Root is 0; each dispatch increments by 1. */
  layer: number;
}

export interface ISubAgentResult {
  output: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
  metadata?: Record<string, unknown>;
  /**
   * When set to 'epicfail', the parent coordinator must not retry/replan.
   * It propagates the trace upward unchanged (appending its own frame).
   */
  errorClass?: 'epicfail';
  /** Diagnostic trace populated when errorClass === 'epicfail'. */
  epicFailTrace?: import('./coordinator.js').EpicFailTrace;
}

export interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  readonly capabilities: SubAgentCapabilities;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
