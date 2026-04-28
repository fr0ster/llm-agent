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
import type { IContextAssembler, ILlm, ILogger, IMcpClient, IRag, IRagProviderRegistry, IRagRegistry, ISubpromptClassifier, IToolCache, LogEvent, Message } from '@mcp-abap-adt/llm-agent';
import { CircuitBreaker, type CircuitBreakerConfig, type IQueryExpander, type LlmFinishReason, type LlmToolCall, type McpTool, type McpToolResult, type RagMetadata, type RagResult, type Subprompt } from '@mcp-abap-adt/llm-agent';
import type { SmartAgent } from '../agent.js';
import type { IMcpConnectionStrategy } from '../interfaces/mcp-connection-strategy.js';
import { InMemoryMetrics } from '../metrics/in-memory-metrics.js';
import type { IMetrics } from '../metrics/types.js';
import type { IPromptInjectionDetector, IToolPolicy } from '../policy/types.js';
import type { IReranker } from '../reranker/types.js';
import type { ISessionManager } from '../session/types.js';
import type { ITracer, SpanStatus } from '../tracer/types.js';
import type { IOutputValidator } from '../validator/types.js';
export declare function makeLlm(responses: Array<{
    content: string;
    toolCalls?: LlmToolCall[];
    finishReason?: LlmFinishReason;
} | Error>): ILlm & {
    callCount: number;
};
export declare function makeRag(queryResults?: RagResult[]): IRag & {
    upsertCalls: string[];
};
export declare function makeFailingRag(): IRag & {
    upsertCalls: string[];
};
/** RAG stub that records metadata passed to writer().upsertRaw (for session-policy tests). */
export declare function makeMetadataRag(queryResults?: RagResult[]): IRag & {
    upsertCalls: string[];
    upsertMetadata: RagMetadata[];
    queryCalls: Array<{
        text: string;
        k: number;
    }>;
};
export declare function makeMcpClient(tools: McpTool[], callResults?: Map<string, McpToolResult | Error>): IMcpClient & {
    callCount: number;
};
export declare function makeClassifier(result: Subprompt[] | Error, onCall?: () => void): ISubpromptClassifier;
export declare function makeAssembler(result?: Message[] | Error): IContextAssembler;
export declare function makeCapturingLogger(): ILogger & {
    events: LogEvent[];
};
export interface CapturedSpan {
    name: string;
    parentName?: string;
    attributes: Record<string, string | number | boolean>;
    events: Array<{
        name: string;
        attributes?: Record<string, string | number | boolean>;
    }>;
    status?: {
        status: SpanStatus;
        message?: string;
    };
    ended: boolean;
}
export declare function makeCapturingTracer(): ITracer & {
    spans: CapturedSpan[];
};
/** Returns an InMemoryMetrics instance for test assertions. */
export declare function makeCapturingMetrics(): InMemoryMetrics;
/** Returns a CircuitBreaker for testing. */
export declare function makeCircuitBreaker(config?: CircuitBreakerConfig): CircuitBreaker;
/** Returns a NoopReranker (pass-through) or a custom IReranker for testing. */
export declare function makeReranker(custom?: IReranker): IReranker;
/** Returns a NoopQueryExpander (pass-through) or a custom IQueryExpander for testing. */
export declare function makeQueryExpander(custom?: IQueryExpander): IQueryExpander;
/** Returns a ToolCache or NoopToolCache for testing. */
export declare function makeToolCache(opts?: {
    ttlMs?: number;
} | IToolCache): IToolCache;
/** Returns a NoopValidator (pass-through) or a custom IOutputValidator for testing. */
export declare function makeOutputValidator(custom?: IOutputValidator): IOutputValidator;
/** Returns a SessionManager or NoopSessionManager for testing. */
export declare function makeSessionManager(opts?: {
    tokenBudget?: number;
} | ISessionManager): ISessionManager;
export declare function makeDefaultDeps(overrides?: {
    llmResponses?: Array<{
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
    } | Error>;
    classifier?: ISubpromptClassifier;
    assembler?: IContextAssembler;
    mcpClients?: IMcpClient[];
    ragStores?: Record<string, IRag>;
    ragRegistry?: IRagRegistry;
    ragProviderRegistry?: IRagProviderRegistry;
    reranker?: IReranker;
    queryExpander?: IQueryExpander;
    logger?: ILogger;
    toolPolicy?: IToolPolicy;
    injectionDetector?: IPromptInjectionDetector;
    toolCache?: IToolCache;
    outputValidator?: IOutputValidator;
    sessionManager?: ISessionManager;
    tracer?: ITracer;
    metrics?: IMetrics;
    connectionStrategy?: IMcpConnectionStrategy;
}): {
    llm: ILlm & {
        callCount: number;
    };
    deps: ConstructorParameters<typeof SmartAgent>[0];
};
//# sourceMappingURL=index.d.ts.map