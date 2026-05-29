import type { ContextPath } from './context-path.js';
import type { OnPartial } from './streaming.js';
import type { LlmUsage } from './types.js';

export interface FinalizerInput {
  prompt: string;
  objective: string;
  ancestorContext?: ContextPath;
  interpreterOutput: string;
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
  finalize(input: FinalizerInput): Promise<FinalizerResult>;
}
