/**
 * Shared test-double factories for SmartAgent integration testing.
 *
 * Consumers can import from '@mcp-abap-adt/llm-agent/testing' to build
 * deterministic stubs for all SmartAgent interfaces without duplicating
 * factory code.
 *
 * @example
 * ```typescript
 * import { makeLlm, makeRag, makeDefaultDeps } from '@mcp-abap-adt/llm-agent/testing';
 * ```
 */

import type { Message } from '../../types.js';
import type { SmartAgent } from '../agent.js';
import type { IContextAssembler } from '../interfaces/assembler.js';
import type { ISubpromptClassifier } from '../interfaces/classifier.js';
import type { ILlm } from '../interfaces/llm.js';
import type { IMcpClient } from '../interfaces/mcp-client.js';
import type { IRag } from '../interfaces/rag.js';
import {
  AssemblerError,
  type CallOptions,
  ClassifierError,
  LlmError,
  type LlmFinishReason,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmToolCall,
  McpError,
  type McpTool,
  type McpToolResult,
  RagError,
  type RagMetadata,
  type RagResult,
  type Result,
  type Subprompt,
} from '../interfaces/types.js';
import type { ILogger, LogEvent } from '../logger/types.js';
import { InMemoryMetrics } from '../metrics/in-memory-metrics.js';
import type { IMetrics } from '../metrics/types.js';
import type { IPromptInjectionDetector, IToolPolicy } from '../policy/types.js';
import type { ISpan, ITracer, SpanStatus } from '../tracer/types.js';

// ---------------------------------------------------------------------------
// LLM stub
// ---------------------------------------------------------------------------

export function makeLlm(
  responses: Array<
    | {
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
      }
    | Error
  >,
): ILlm & { callCount: number } {
  let callCount = 0;
  const queue = [...responses];
  return {
    get callCount() {
      return callCount;
    },
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      callCount++;
      const next = queue.shift();
      if (!next) {
        return {
          ok: true,
          value: { content: 'default', finishReason: 'stop' },
        };
      }
      if (next instanceof Error) {
        return { ok: false, error: new LlmError(next.message) };
      }
      return {
        ok: true,
        value: {
          content: next.content,
          toolCalls: next.toolCalls,
          finishReason: next.finishReason ?? 'stop',
        },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      callCount++;
      const next = queue.shift();
      if (!next) {
        yield {
          ok: true,
          value: { content: 'default', finishReason: 'stop' },
        };
        return;
      }
      if (next instanceof Error) {
        yield { ok: false, error: new LlmError(next.message) };
        return;
      }
      yield {
        ok: true,
        value: {
          content: next.content,
          toolCalls: next.toolCalls,
          finishReason: next.finishReason ?? 'stop',
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// RAG stubs
// ---------------------------------------------------------------------------

export function makeRag(
  queryResults: RagResult[] = [],
): IRag & { upsertCalls: string[] } {
  const upsertCalls: string[] = [];
  return {
    upsertCalls,
    async upsert(text: string): Promise<Result<void, RagError>> {
      upsertCalls.push(text);
      return { ok: true, value: undefined };
    },
    async query(): Promise<Result<RagResult[], RagError>> {
      return { ok: true, value: queryResults };
    },
    async healthCheck(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
  };
}

export function makeFailingRag(): IRag & { upsertCalls: string[] } {
  const upsertCalls: string[] = [];
  return {
    upsertCalls,
    async upsert(text: string): Promise<Result<void, RagError>> {
      upsertCalls.push(text);
      return { ok: false, error: new RagError('Upsert failed') };
    },
    async query(): Promise<Result<RagResult[], RagError>> {
      return { ok: false, error: new RagError('Query failed') };
    },
    async healthCheck(): Promise<Result<void, RagError>> {
      return { ok: false, error: new RagError('Health check failed') };
    },
  };
}

/** RAG stub that records metadata passed to upsert (for session-policy tests). */
export function makeMetadataRag(queryResults: RagResult[] = []): IRag & {
  upsertCalls: string[];
  upsertMetadata: RagMetadata[];
  queryCalls: Array<{ text: string; k: number }>;
} {
  const upsertCalls: string[] = [];
  const upsertMetadata: RagMetadata[] = [];
  const queryCalls: Array<{ text: string; k: number }> = [];
  return {
    upsertCalls,
    upsertMetadata,
    queryCalls,
    async upsert(
      text: string,
      metadata: RagMetadata,
    ): Promise<Result<void, RagError>> {
      upsertCalls.push(text);
      upsertMetadata.push(metadata);
      return { ok: true, value: undefined };
    },
    async query(
      text: string,
      k: number,
    ): Promise<Result<RagResult[], RagError>> {
      queryCalls.push({ text, k });
      return { ok: true, value: queryResults };
    },
    async healthCheck(): Promise<Result<void, RagError>> {
      return { ok: true, value: undefined };
    },
  };
}

// ---------------------------------------------------------------------------
// MCP client stub
// ---------------------------------------------------------------------------

export function makeMcpClient(
  tools: McpTool[],
  callResults?: Map<string, McpToolResult | Error>,
): IMcpClient & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: tools };
    },
    async callTool(name: string): Promise<Result<McpToolResult, McpError>> {
      callCount++;
      const result = callResults?.get(name);
      if (result instanceof Error) {
        return { ok: false, error: new McpError(result.message) };
      }
      if (result) {
        return { ok: true, value: result };
      }
      return { ok: true, value: { content: `result of ${name}` } };
    },
  };
}

// ---------------------------------------------------------------------------
// Classifier stub
// ---------------------------------------------------------------------------

export function makeClassifier(
  result: Subprompt[] | Error,
  onCall?: () => void,
): ISubpromptClassifier {
  return {
    async classify(): Promise<Result<Subprompt[], ClassifierError>> {
      onCall?.();
      if (result instanceof Error) {
        const code =
          result.message === 'ABORTED' ? 'ABORTED' : 'CLASSIFIER_ERROR';
        return { ok: false, error: new ClassifierError(result.message, code) };
      }
      return { ok: true, value: result };
    },
  };
}

// ---------------------------------------------------------------------------
// Assembler stub
// ---------------------------------------------------------------------------

export function makeAssembler(result?: Message[] | Error): IContextAssembler {
  const defaultMessages: Message[] = [{ role: 'user', content: 'action text' }];
  return {
    async assemble(
      _action: Subprompt,
      _retrieved: {
        facts: RagResult[];
        feedback: RagResult[];
        state: RagResult[];
        tools: McpTool[];
      },
      _history: Message[],
      _opts?: CallOptions,
    ): Promise<Result<Message[], AssemblerError>> {
      const r = result ?? defaultMessages;
      if (r instanceof Error) {
        const code = r.message === 'ABORTED' ? 'ABORTED' : 'ASSEMBLER_ERROR';
        return { ok: false, error: new AssemblerError(r.message, code) };
      }
      return { ok: true, value: r };
    },
  };
}

// ---------------------------------------------------------------------------
// Capturing logger
// ---------------------------------------------------------------------------

export function makeCapturingLogger(): ILogger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  return {
    events,
    log(event: LogEvent): void {
      events.push(event);
    },
  };
}

// ---------------------------------------------------------------------------
// Capturing tracer
// ---------------------------------------------------------------------------

export interface CapturedSpan {
  name: string;
  parentName?: string;
  attributes: Record<string, string | number | boolean>;
  events: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }>;
  status?: { status: SpanStatus; message?: string };
  ended: boolean;
}

export function makeCapturingTracer(): ITracer & { spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];
  return {
    spans,
    startSpan(
      name: string,
      options?: {
        parent?: ISpan;
        attributes?: Record<string, string | number | boolean>;
        traceId?: string;
      },
    ): ISpan {
      const captured: CapturedSpan = {
        name,
        parentName: options?.parent?.name,
        attributes: { ...options?.attributes },
        events: [],
        ended: false,
      };
      if (options?.traceId) {
        captured.attributes['smart_agent.trace_id'] = options.traceId;
      }
      spans.push(captured);
      return {
        get name() {
          return captured.name;
        },
        setAttribute(key: string, value: string | number | boolean): void {
          captured.attributes[key] = value;
        },
        addEvent(
          eventName: string,
          attributes?: Record<string, string | number | boolean>,
        ): void {
          captured.events.push({ name: eventName, attributes });
        },
        setStatus(status: SpanStatus, message?: string): void {
          captured.status = { status, message };
        },
        end(): void {
          captured.ended = true;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Capturing metrics
// ---------------------------------------------------------------------------

/** Returns an InMemoryMetrics instance for test assertions. */
export function makeCapturingMetrics(): InMemoryMetrics {
  return new InMemoryMetrics();
}

// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------

export function makeDefaultDeps(overrides?: {
  llmResponses?: Array<
    | {
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
      }
    | Error
  >;
  classifier?: ISubpromptClassifier;
  assembler?: IContextAssembler;
  mcpClients?: IMcpClient[];
  ragStores?: { facts?: IRag; feedback?: IRag; state?: IRag };
  logger?: ILogger;
  toolPolicy?: IToolPolicy;
  injectionDetector?: IPromptInjectionDetector;
  tracer?: ITracer;
  metrics?: IMetrics;
}): {
  llm: ILlm & { callCount: number };
  deps: ConstructorParameters<typeof SmartAgent>[0];
} {
  const llm = makeLlm(
    overrides?.llmResponses ?? [{ content: 'hello', finishReason: 'stop' }],
  );
  return {
    llm,
    deps: {
      mainLlm: llm,
      mcpClients: overrides?.mcpClients ?? [],
      ragStores: {
        facts: overrides?.ragStores?.facts ?? makeRag(),
        feedback: overrides?.ragStores?.feedback ?? makeRag(),
        state: overrides?.ragStores?.state ?? makeRag(),
      },
      classifier:
        overrides?.classifier ??
        makeClassifier([{ type: 'action', text: 'do something' }]),
      assembler: overrides?.assembler ?? makeAssembler(),
      logger: overrides?.logger,
      toolPolicy: overrides?.toolPolicy,
      injectionDetector: overrides?.injectionDetector,
      tracer: overrides?.tracer,
      metrics: overrides?.metrics,
    },
  };
}
