import type { ContextPath } from './context-path.js';
import type { OnPartial } from './streaming.js';
import type { LlmUsage } from './types.js';

export interface FinalizerInput {
  prompt: string;
  objective: string;
  ancestorContext?: ContextPath;
  interpreterOutput: string;
  /** True only when the non-ephemeral streamed text ends with the complete
   *  interpreter output (trimmed and non-empty; trailing stream whitespace ignored).
   *  Only possible with streamsInterpreterContent and a single-node plan in the
   *  current interpretation attempt. False means the finalizer must re-emit the
   *  output, even if a partial answer was already shown. */
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
   *  client live for single-node plans only, as the plain tool-loop does. The
   *  finalizer may skip re-emission only when interpreterContentStreamed is true:
   *  the streamed text ends with the complete interpreter output. Multi-node
   *  plans do not forward content live and receive false. The finalizer may emit
   *  trailing content (e.g. a notice)
   *  through onPartial. Content is live: when a failed step is revised and the
   *  plan runs again, the client has already seen the failed attempt's text,
   *  as with a mid-stream retry in the plain tool-loop. On a turn ending with
   *  pending external (client-executed) tool calls, the finalizer does not run:
   *  content may already have streamed and no trailing notice is added. */
  readonly streamsInterpreterContent?: boolean;
  finalize(input: FinalizerInput): Promise<FinalizerResult>;
}
