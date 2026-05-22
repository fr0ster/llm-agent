import type { LlmToolCall, LlmUsage } from './types.js';

/**
 * A reference to a known artifact the subagent should be aware of (a file
 * path, an URL, a vector store key, a previous step output id, etc.). The
 * `summary` is a one-liner so the briefing stays compact.
 */
export interface IBriefingArtifact {
  ref: string;
  summary: string;
}

/**
 * Structured briefing passed alongside the task. Each field is optional;
 * the formatter renders only the sections that are populated. Treat fields
 * as semantic, not stylistic — the formatter owns the wire shape.
 */
export interface IBriefing {
  /** Why this work is being done — motivation, end-goal of the larger plan. */
  goal?: string;
  /** Distilled facts already established by upstream work. One bullet per item. */
  known?: string[];
  /**
   * Approaches already attempted that did not pan out. The subagent should
   * NOT retry them. Each entry should describe the attempt and why it failed
   * (e.g. "Step s2: ran grep for 'foo' in src/ — no matches").
   */
  tried?: string[];
  /** Hard constraints (output shape, length, must/must-not). */
  constraints?: string[];
  /** Specific files, URLs, or store keys the subagent should consult. */
  artifacts?: IBriefingArtifact[];
}

export interface ISubAgentInput {
  task: string;
  /** Optional structured briefing. When absent, only `task` is sent. */
  briefing?: IBriefing;
  context?: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ISubAgentResult {
  output: string;
  toolCalls?: LlmToolCall[];
  usage?: LlmUsage;
  metadata?: Record<string, unknown>;
}

export interface ISubAgent {
  readonly name: string;
  readonly description?: string;
  run(input: ISubAgentInput): Promise<ISubAgentResult>;
}

export type SubAgentRegistry = Map<string, ISubAgent>;
