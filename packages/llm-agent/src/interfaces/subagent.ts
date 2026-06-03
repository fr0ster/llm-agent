import type { EpicFailTrace } from './coordinator.js';
import type { OnPartial } from './streaming.js';
import type { LlmTool, LlmToolCall, LlmUsage } from './types.js';

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
  /** Request correlation, threaded from the coordinator so worker token-log
   *  entries attribute to the same request delta (traceId). */
  trace?: { traceId: string };
  /** Per-request session debugger logger, threaded from the coordinator so
   *  worker stages (tool-loop, LLM dumps, MCP calls) write to the parent's
   *  `.run/sessions/<sid>/<req>/` directory. Shape mirrors
   *  `CallOptions.sessionLogger` (structural to avoid import cycle). */
  sessionLogger?: {
    logStep(name: string, data: unknown): void;
  };
  /** Optional per-event callback for streaming worker output upstream.
   *  Fire-and-forget — implementations must never let the callback throw
   *  break the run. Absence preserves today's silent behaviour. */
  onPartial?: OnPartial;
  /** Client-provided external (consumer-executed) tools from the request, e.g.
   *  create_file / rag_add. Threaded from the coordinator into the worker's
   *  nested pipeline so the worker can emit a tool call the client fulfils
   *  (issue #167). Absent → the worker sees only its own MCP tools. */
  externalTools?: readonly LlmTool[];
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
  /** Set to 'awaiting-external' when the worker emitted a client-provided
   *  (consumer-executed) external tool call and is waiting for its result
   *  (#171). Default/absent = 'complete'. */
  status?: 'complete' | 'awaiting-external';
  /** The external tool calls the worker surfaced (deterministic `ext:` ids).
   *  Present iff status === 'awaiting-external'. */
  pendingExternalToolCalls?: LlmToolCall[];
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
