import type { ContextPath } from './context-path.js';
import type { OnPartial } from './streaming.js';
import type { LlmUsage } from './types.js';

export interface FinalizerInput {
  prompt: string;
  objective: string;
  ancestorContext?: ContextPath;
  interpreterOutput: string;
  /** True when the coordinator already forwarded at least one non-ephemeral
   *  interpreter content delta to the client for this run. Only possible when
   *  the finalizer set streamsInterpreterContent. */
  interpreterContentStreamed?: boolean;
  executionTrace: ReadonlyArray<{
    nodeId: string;
    goal: string;
    output: string;
  }>;
  sessionId?: string;
  signal?: AbortSignal;
  trace?: { traceId: string };
  /** Optional streaming sink for finalizer-produced content.
   *  LlmFinalizer streams synthesis deltas; Passthrough/Template
   *  emit one chunk equal to their full output. */
  onPartial?: OnPartial;
}

export interface FinalizerResult {
  output: string;
  usage?: LlmUsage;
}

export interface IFinalizer {
  readonly name: string;
  readonly model?: string;
  /** When true, the DAG coordinator forwards interpreter content deltas to the
   *  client live, as the plain tool-loop does. The finalizer must not re-emit
   *  content already streamed; it may emit trailing content (e.g. a notice)
   *  through onPartial. Content is live: when a failed step is revised and the
   *  plan runs again, the client has already seen the failed attempt's text,
   *  as with a mid-stream retry in the plain tool-loop. */
  readonly streamsInterpreterContent?: boolean;
  finalize(input: FinalizerInput): Promise<FinalizerResult>;
}
