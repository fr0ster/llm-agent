import type { Message } from '../types.js';
import type { CallOptions } from './types.js';

export interface ToolRound {
  assistant: Message;
  results: Message[];
  meta?: Array<{ identityKey?: string; isError?: boolean }>;
  ordinal?: number;
  roundId?: string;
}

export interface ToolLoopContextBase {
  prefix: Message[];
  queryText?: string;
}

export interface IToolLoopContextStrategy {
  record(round: ToolRound, options?: CallOptions): Promise<void>;
  form(base: ToolLoopContextBase, options?: CallOptions): Promise<Message[]>;
  snapshot(): SerializableStrategyState;
  restore(state: SerializableStrategyState): void;
}

export type ToolLoopContextStrategyFactory = (
  deps: ToolLoopContextStrategyDeps,
) => IToolLoopContextStrategy;

export interface ToolLoopContextStrategyDeps {
  readonly run?: unknown;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface SerializableStrategyState {
  readonly version: number;
  readonly [k: string]: JsonValue;
}
