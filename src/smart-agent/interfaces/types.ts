/**
 * Shared types for Smart Orchestrated Agent contracts.
 */

import type { Message } from '../../types.js';

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
  sessionId?: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  /** Per-request model override. Affects only the main LLM. */
  model?: string;
  /** Filter RAG results by namespace or other metadata. */
  ragFilter?: {
    namespace?: string;
  };
  /** Detailed session debugger logger. */
  sessionLogger?: {
    logStep(name: string, data: unknown): void;
  };
}

export interface ToolHeartbeat {
  /** Tool name currently being executed. */
  tool: string;
  /** Milliseconds elapsed since tool execution started. */
  elapsed: number;
}

export interface TimingEntry {
  /** Phase label, e.g. 'llm_call_1', 'tool_get_order'. */
  phase: string;
  /** Duration in milliseconds. */
  duration: number;
}

export interface LlmStreamChunk {
  content: string;
  toolCalls?: StreamToolCall[];
  finishReason?: LlmFinishReason;
  usage?: LlmUsage & {
    models?: Record<string, ModelUsageEntry>;
  };
  /** Periodic heartbeat emitted while an MCP tool is executing. */
  heartbeat?: ToolHeartbeat;
  /** End-of-request timing breakdown for all phases. */
  timing?: TimingEntry[];
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

export class SkillError extends SmartAgentError {
  constructor(message: string, code = 'SKILL_ERROR') {
    super(message, code);
    this.name = 'SkillError';
  }
}

// ---------------------------------------------------------------------------
// Subprompt
// ---------------------------------------------------------------------------

export type SubpromptType = 'fact' | 'feedback' | 'state' | 'action' | 'chat';

export interface Subprompt {
  type: SubpromptType;
  text: string;
  /** Semantic context: 'sap-abap', 'math', 'general', etc. */
  context?: string;
  /** ID of a subprompt this one depends on, or 'independent' / 'sequential'. */
  dependency?: string | 'independent' | 'sequential';
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

export interface LlmToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export type StreamToolCall = LlmToolCall | LlmToolCallDelta;

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelUsageEntry {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  finishReason: LlmFinishReason;
  usage?: LlmUsage;
  raw?: unknown;
}

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
// Stream hook
// ---------------------------------------------------------------------------

export interface StreamHookContext {
  messages: Message[];
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
