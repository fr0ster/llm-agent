import type { LlmComponent } from './request-logger.js';
import type { LlmUsage } from './types.js';

/**
 * Stable reference to a Stepper execution. Minted at dispatch (for recursive
 * Stepper construction) or synthesized for terminal executor invocations.
 * Unique across the whole run.
 */
export interface StepperRef {
  /** Stable UUID minted at each dispatch. */
  stepperId: string;
  /** Parent Stepper ID (undefined at root or for terminal executors). */
  parentStepperId?: string;
  /** Human-readable name (goal name or executor type). */
  name: string;
}

/**
 * Per-event chunk type emitted by `onPartial` callbacks along the
 * worker → interpreter → coordinator path.
 *
 * `content` carries an LLM-output delta; `tool-call` flags a tool
 * invocation; `node-start` / `node-end` wrap a DAG node execution at
 * the interpreter layer. `nodeId` is supplied by the interpreter when
 * forwarding worker-emitted chunks (workers don't know their node id).
 *
 * 18.0 adds progress-event variants (`stepper-spawned`, `stepper-done`, etc.)
 * that carry `source: StepperRef` instead of `nodeId`.
 */
export type StreamChunk =
  | { kind: 'content'; nodeId?: string; delta: string }
  // --- 17.0 legacy variants — REMOVED in Task 19e once all emitters migrate ---
  | { kind: 'tool-call'; nodeId?: string; name: string; args?: unknown }
  | { kind: 'node-start'; nodeId: string; goal: string }
  | { kind: 'node-end'; nodeId: string; ok: boolean }
  // --- 18.0 Stepper progress events ---
  | { kind: 'stepper-spawned'; source: StepperRef; goal: string }
  | { kind: 'stepper-done'; source: StepperRef; ok: boolean }
  | { kind: 'mcp-call'; source: StepperRef; tool: string; args?: unknown }
  | {
      kind: 'mcp-result';
      source: StepperRef;
      tool: string;
      durationMs: number;
      bytes?: number;
    }
  | {
      kind: 'tokens-used';
      source: StepperRef;
      component: LlmComponent;
      delta: LlmUsage;
    }
  | {
      kind: 'llm-call-start';
      source: StepperRef;
      component: LlmComponent;
      model: string;
    }
  | {
      kind: 'llm-call-end';
      source: StepperRef;
      component: LlmComponent;
      durationMs: number;
    };

export type OnPartial = (chunk: StreamChunk) => void;
