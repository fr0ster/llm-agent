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
 * worker → Stepper → coordinator path.
 *
 * `content` carries an LLM-output delta. The 18.0 progress-event variants
 * (`stepper-spawned`, `stepper-done`, `mcp-call`, `mcp-result`,
 * `tokens-used`, `llm-call-start`, `llm-call-end`) each carry
 * `source: StepperRef` for precise attribution in nested execution trees.
 *
 * BREAKING (18.0 / Task 19e): the 17.0 `tool-call`, `node-start`, and
 * `node-end` variants have been removed. SSE clients must migrate to
 * `mcp-call` / `mcp-result` / `stepper-spawned` / `stepper-done`.
 */
export type StreamChunk =
  | { kind: 'content'; nodeId?: string; delta: string }
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
