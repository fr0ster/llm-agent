import type { EpicFailTrace } from './coordinator.js';
import type { LlmToolCall, LlmUsage } from './types.js';

/**
 * Typed metadata that the planner/validator can read without invoking the
 * agent. Used to decide whether to call the context builder before dispatch.
 */
export interface SubAgentCapabilities {
  /**
   * Context handling expectations:
   * - 'required': dispatch must populate `input.context`; missing context is an error.
   * - 'optional': context is treated as preamble if present.
   * - 'forbidden': context must be omitted; the agent ignores any value passed.
   */
  contextPolicy: 'required' | 'optional' | 'forbidden';
}

export interface ISubAgentInput {
  task: string;
  /**
   * Assembled context preamble (required when capabilities.contextPolicy === 'required').
   *
   * **Breaking change:** previously `Record<string, unknown>` (structured key-value
   * bag); now a plain string preamble injected by `ISubAgentContextBuilder` (or by
   * the dispatcher directly). Callers that previously passed structured data must
   * either (a) serialize it themselves and pass the result, or (b) implement an
   * `ISubAgentContextBuilder` and configure the dispatcher to use it.
   */
  context?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /**
   * Dispatch depth. Root is 0; each dispatch increments by 1.
   *
   * **Breaking change in the nested-dispatch foundation:** previously absent;
   * now required on every `sub.run()` call. Callers must pass `(ctx.layer ?? 0) + 1`
   * (or `0` for direct test invocations).
   */
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
  epicFailTrace?: EpicFailTrace;
}

/**
 * The runtime contract for any subagent the coordinator can dispatch.
 *
 * Implementations must declare a `capabilities` field describing their
 * context-handling policy.
 */
export interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  readonly capabilities: SubAgentCapabilities;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
