import type { LlmUsage, StreamToolCall } from '@mcp-abap-adt/llm-agent';
import type { SmartServerLlmConfig } from '../smart-server.js';

export type SubagentResult =
  | { kind: 'content'; content: string; usage?: LlmUsage }
  | { kind: 'tool_call'; toolCalls: StreamToolCall[]; usage?: LlmUsage }
  | { kind: 'error'; error: string; usage?: LlmUsage };

export interface Step {
  name: string;
  instructions: string;
  type?: string;
}

export type NextStep =
  | { kind: 'next'; step: Step }
  | { kind: 'done'; result: string }
  | { kind: 'rewind'; reason: string };

export type PendingMarker =
  | {
      kind: 'external-tool';
      extId: string;
      toolName: string;
      args: unknown;
      position: string;
    }
  | {
      kind: 'clarify';
      question: string;
      position: string;
      /** For goal-confirmation clarifies: the target the evaluator proposed, so
       *  a plain confirmation ("yes") commits IT rather than the literal answer. */
      proposedTarget?: string;
    };

export interface SessionBundle {
  goal: string;
  plannerPrivate: string;
  budgets: { stepsUsed: number; rewindsUsed: number };
  pending?: PendingMarker;
}

export interface ControllerConfig {
  subagents: {
    evaluator: SmartServerLlmConfig;
    planner: SmartServerLlmConfig;
    executor: SmartServerLlmConfig;
  };
  targetState: {
    strategy: 'consumer-confirm' | 'semantic-distance' | 'auto';
    distanceThreshold: number;
  };
  sessionMemory: { collection: string };
  budgets: {
    maxSteps: number;
    maxRetries: number;
    maxRewinds: number;
    maxToolCalls?: number;
  };
}
