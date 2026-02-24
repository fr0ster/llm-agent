/**
 * Shared types for Smart Orchestrated Agent contracts.
 */

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Trace & call options
// ---------------------------------------------------------------------------

export interface TraceContext {
  traceId: string;
  spanId?: string;
  baggage?: Record<string, string>;
}

export interface CallOptions {
  trace?: TraceContext;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class SmartAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SmartAgentError';
  }
}

export class LlmError extends SmartAgentError {
  constructor(message: string, code = 'LLM_ERROR') {
    super(message, code);
    this.name = 'LlmError';
  }
}

export class McpError extends SmartAgentError {
  constructor(message: string, code = 'MCP_ERROR') {
    super(message, code);
    this.name = 'McpError';
  }
}

export class RagError extends SmartAgentError {
  constructor(message: string, code = 'RAG_ERROR') {
    super(message, code);
    this.name = 'RagError';
  }
}

export class ClassifierError extends SmartAgentError {
  constructor(message: string, code = 'CLASSIFIER_ERROR') {
    super(message, code);
    this.name = 'ClassifierError';
  }
}

export class AssemblerError extends SmartAgentError {
  constructor(message: string, code = 'ASSEMBLER_ERROR') {
    super(message, code);
    this.name = 'AssemblerError';
  }
}

// ---------------------------------------------------------------------------
// Subprompt
// ---------------------------------------------------------------------------

export type SubpromptType = 'fact' | 'feedback' | 'state' | 'action';

export interface Subprompt {
  type: SubpromptType;
  text: string;
}

// ---------------------------------------------------------------------------
// LLM types
// ---------------------------------------------------------------------------

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  finishReason: LlmFinishReason;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Streaming types
// ---------------------------------------------------------------------------

export type LlmStreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; toolCalls: LlmToolCall[] }
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'done'; finishReason: LlmFinishReason };

// ---------------------------------------------------------------------------
// MCP types
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: string | Record<string, unknown>;
  isError?: boolean;
}

export interface ToolCallRecord {
  call: LlmToolCall;
  result: McpToolResult;
}

// ---------------------------------------------------------------------------
// RAG types
// ---------------------------------------------------------------------------

export interface RagMetadata {
  id?: string;
  /** Unix timestamp (seconds) after which this record is considered expired. */
  ttl?: number;
  /** Logical namespace, e.g. "tenant/user/session". */
  namespace?: string;
  [key: string]: unknown;
}

export interface RagResult {
  text: string;
  metadata: RagMetadata;
  /** Cosine similarity score in [0, 1]. */
  score: number;
}

// ---------------------------------------------------------------------------
// Context frame
// ---------------------------------------------------------------------------

export interface ContextFrame {
  action: Subprompt;
  facts: RagResult[];
  feedback: RagResult[];
  state: RagResult[];
  tools: McpTool[];
  toolResults: ToolCallRecord[];
  constraints: {
    maxIterations: number;
    tokenLimit?: number;
    timeoutMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Agent config
// ---------------------------------------------------------------------------

export interface AgentConfig {
  maxIterations: number;
  timeoutMs?: number;
  maxToolCalls?: number;
  tokenLimit?: number;
}
