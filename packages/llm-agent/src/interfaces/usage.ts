import type { TaskState } from './dialogue.js';

export const USAGE_SCHEMA_VERSION = 1;

/** Who and where. Identifiers and labels only, never content. */
export interface UsageContext {
  sessionId?: string;
  userId?: string;
  turnId?: string;
  taskId?: string;
  requestId?: string;
  traceId?: string;
  role?: string; // the existing LlmComponent names where they apply: planner, executor, classifier, …
  destination?: string;
  [label: string]: string | undefined; // additional consumer labels
}

interface Base {
  schema: typeof USAGE_SCHEMA_VERSION;
  id: string; // unique; stable across retries of delivery
  at: number; // ms since epoch, end of the operation
  context: UsageContext;
  outcome: 'ok' | 'error' | 'aborted';
  errorCode?: string; // a code, never a provider body
}

type LlmCall = Base & {
  kind: 'llm.call';
  operationId: string;
  physicalSeq: number; // 0,1,2… unique per physical request within the operation
  outerAttempt: number;
  providerAttempt: number; // library retry attempt, provider-internal retry attempt
  granularity: 'request' | 'sdk-call';
  retriesVisible: boolean; // sdk-call: one SDK call that may hide retries
  provider: string;
  model: string;
  stream: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  tokensSource: 'provider' | 'estimate' | 'unknown';
  durationMs: number;
  firstTokenMs?: number;
  throttledMs?: number;
  // Sizes of the messages and tool definitions actually sent; never content.
  inputMessages?: number;
  systemMessages?: number;
  userMessages?: number;
  assistantMessages?: number;
  toolMessages?: number;
  inputChars?: number;
  systemChars?: number;
  userChars?: number;
  assistantChars?: number;
  toolChars?: number;
  toolDefs?: number;
  toolDefsChars?: number;
  closedEarly?: boolean;
}; // stream consumer stopped before the end
type EmbeddingCall = Base & {
  kind: 'embedding.call';
  operationId: string;
  physicalSeq: number;
  outerAttempt: number;
  providerAttempt: number;
  chunkPath: string; // e.g. '2/3>1/4': outer chunk 2 of 3, provider chunk 1 of 4
  granularity: 'request' | 'sdk-call';
  retriesVisible: boolean;
  provider: string;
  model: string;
  inputs: number;
  inputChars: number;
  inputTokens?: number;
  tokensSource: 'provider' | 'estimate' | 'unknown'; // exact provider total of this request
  durationMs: number;
};
type ToolCall = Base & {
  kind: 'tool.call';
  server?: string;
  tool: string;
  dispatched: boolean; // false: served from cache, no MCP request
  embedded: boolean; // true: an embedded handler, no network request
  transportOutcome: 'ok' | 'error' | 'aborted'; // the MCP request
  toolOutcome?: 'ok' | 'error'; // isError of the tool result
  durationMs: number;
  requestBytes?: number;
  responseBytes?: number;
};
type TaskEnd = Base & {
  kind: 'task';
  taskId: string;
  worker: string;
  state: TaskState;
  queuedMs?: number;
  runMs?: number;
  endKnown: boolean; // false: interrupted by a crash, end time unknown
  toolCalls?: number;
  budgetExhausted?: boolean;
};
type Extension = Base & {
  kind: `x.${string}`;
  values: Record<string, number | string | boolean>;
};

export type UsageRecord =
  | LlmCall
  | EmbeddingCall
  | ToolCall
  | TaskEnd
  | Extension;

/** Distributive: each variant keeps its own required fields. */
export type UsageInput = UsageRecord extends infer R
  ? R extends UsageRecord
    ? Omit<R, 'schema' | 'id' | 'at'> & Partial<Pick<R, 'id' | 'at'>>
    : never
  : never;

/** Producer side. */
export interface IUsageRecorder {
  record(input: UsageInput): void; // never throws, never awaits
  with(context: UsageContext): IUsageRecorder;
}

/** Delivery between recorder and sink. `send` resolves only when the sink has written the batch. */
export interface IUsageTransport {
  send(batch: readonly UsageRecord[]): Promise<void>;
  close(): Promise<void>;
}

/**
 * A failed send or write rejects with this error when it knows whether the batch may have
 * reached storage. Any other rejection is treated conservatively as `possiblyDelivered: true`.
 */
export class UsageDeliveryError extends Error {
  constructor(
    message: string,
    readonly possiblyDelivered: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Storage. `write` is idempotent by `id`: writing a record twice stores it once. */
export interface IUsageSink {
  write(batch: readonly UsageRecord[]): Promise<void>;
  close?(): Promise<void>;
}

/** Lifecycle and health of a running recorder implementation (not needed by producers). */
export interface IUsageControl {
  flush(timeoutMs: number): Promise<void>;
  close(
    timeoutMs: number,
  ): Promise<{ delivered: number; lost: number; unconfirmed: number }>;
  stats(): {
    buffered: number;
    delivered: number;
    lost: Record<string, number>;
    /** Delivery is ambiguous right now: buffered after a possibly-delivered failure, or given up while ambiguous. */
    unconfirmed?: number;
    lastErrorCode?: string;
  };
}

export interface UsageOperation {
  operationId: string;
  seq: { next(): number }; // shared by reference across copies; allocates physicalSeq
  outerAttempt: number; // 0 unless a library retry wrapper set it
  providerAttempt: number; // 0 unless a provider loop set it
  chunkPath: string; // '' at the top
}
