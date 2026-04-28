import type { CallOptions, IClientAdapter, IContextAssembler, IEmbedder, IHistoryMemory, IHistorySummarizer, ILlm, ILlmCallStrategy, IMcpClient, IRag, IRagProviderRegistry, IRagRegistry, IRequestLogger, ISkillManager, ISubpromptClassifier, IToolCache, LlmStreamChunk, Message, Result, StreamHookContext } from '@mcp-abap-adt/llm-agent';
import { type AgentCallOptions, type IQueryExpander, OrchestratorError, type SmartAgentResponse } from '@mcp-abap-adt/llm-agent';
import type { LlmClassifierConfig } from './classifier/llm-classifier.js';
import type { IMcpConnectionStrategy } from './interfaces/mcp-connection-strategy.js';
export { type AgentCallOptions, OrchestratorError, type SmartAgentResponse, type StopReason, } from '@mcp-abap-adt/llm-agent';
import type { IPipeline } from './interfaces/pipeline.js';
import type { ILogger } from './logger/index.js';
import type { IMetrics } from './metrics/types.js';
import type { IPromptInjectionDetector, IToolPolicy, SessionPolicy } from './policy/types.js';
import type { IReranker } from './reranker/types.js';
import type { ISessionManager } from './session/types.js';
import type { ITracer } from './tracer/types.js';
import type { IOutputValidator } from './validator/types.js';
export type SmartAgentRagStores<K extends string = string> = Record<K, IRag>;
export interface SmartAgentDeps {
    mainLlm: ILlm;
    helperLlm?: ILlm;
    mcpClients: IMcpClient[];
    ragStores: SmartAgentRagStores;
    classifier: ISubpromptClassifier;
    classifierLlm?: ILlm;
    classifierConfig?: LlmClassifierConfig;
    assembler: IContextAssembler;
    reranker?: IReranker;
    queryExpander?: IQueryExpander;
    logger?: ILogger;
    requestLogger?: IRequestLogger;
    toolPolicy?: IToolPolicy;
    injectionDetector?: IPromptInjectionDetector;
    tracer?: ITracer;
    metrics?: IMetrics;
    toolCache?: IToolCache;
    outputValidator?: IOutputValidator;
    sessionManager?: ISessionManager;
    skillManager?: ISkillManager;
    clientAdapters?: IClientAdapter[];
    /** Shared embedder for RAG queries. When set, creates memoized IQueryEmbedding per request. */
    embedder?: IEmbedder;
    connectionStrategy?: IMcpConnectionStrategy;
    historyMemory?: IHistoryMemory;
    historySummarizer?: IHistorySummarizer;
    llmCallStrategy?: ILlmCallStrategy;
    pipeline?: IPipeline;
    /**
     * Names of RAG stores whose content is English-only (e.g. MCP tool descriptions).
     * The pipeline translates the query to English before searching these stores.
     */
    translateQueryStores?: Set<string>;
    /** Registry of RAG collections (v9.1+). When present, ragStores is a live projection. */
    ragRegistry?: IRagRegistry;
    /** Registry of RAG providers for dynamic collection creation (v9.1+). */
    ragProviderRegistry?: IRagProviderRegistry;
}
export interface SmartAgentConfig {
    maxIterations: number;
    maxToolCalls?: number;
    toolUnavailableTtlMs?: number;
    timeoutMs?: number;
    tokenLimit?: number;
    ragQueryK?: number;
    contextBudgetTokens?: number;
    semanticHistoryEnabled?: boolean;
    historyRecencyWindow?: number;
    historyTurnSummaryPrompt?: string;
    smartAgentEnabled?: boolean;
    sessionPolicy?: SessionPolicy;
    showReasoning?: boolean;
    ragTranslatePrompt?: string;
    historySummaryPrompt?: string;
    historyAutoSummarizeLimit?: number;
    mode?: 'hard' | 'pass' | 'smart';
    queryExpansionEnabled?: boolean;
    toolResultCacheTtlMs?: number;
    sessionTokenBudget?: number;
    /** Interval (ms) for SSE heartbeat comments during MCP tool execution. Default: 5000. */
    heartbeatIntervalMs?: number;
    /** Timeout (ms) for health-check probes (LLM, RAG, MCP). Default: 5000. */
    healthTimeoutMs?: number;
    /**
     * Whether classification stage runs. Default: false.
     * When false, input is treated as a single action — LLM handles
     * multi-step requests via the tool loop.
     * Enable when using custom pipeline with multi-store routing.
     */
    classificationEnabled?: boolean;
    /** Whether to inject matched skills into the system prompt. Default: true (when skillManager is configured). */
    skillInjectionEnabled?: boolean;
    /**
     * Whether to re-fetch MCP tool list on each tool-loop iteration. Default: true.
     * @deprecated No-op since 2.15.0 — tool lists are cached in McpClientAdapter.
     */
    refreshToolsPerIteration?: boolean;
    /** Re-select tools via RAG on each tool-loop iteration. Default: false. */
    toolReselectPerIteration?: boolean;
    /** Whether to translate non-ASCII RAG queries to English before retrieval. Default: true. */
    ragTranslateEnabled?: boolean;
    /**
     * Enable two-phase tool retrieval: other RAG stores are queried first, then
     * `build-tool-query` composes an enriched query from RAG snippets and
     * selected skills, which drives a second `rag-query` against the tools
     * store (and the `tool-select` fallback). Lets skills and domain facts
     * steer MCP tool discovery. Default: false (single-phase tool retrieval).
     */
    enrichedToolSearch?: boolean;
    /** Retry options for transient LLM failures (429, 5xx). When set, wraps LLM with RetryLlm. */
    retry?: {
        maxAttempts?: number;
        backoffMs?: number;
        retryOn?: number[];
        retryOnMidStream?: string[];
    };
    /**
     * Streaming behavior for multi-iteration tool loops.
     * - `'full'` (default): stream all chunks immediately, including intermediate iterations.
     * - `'final'`: buffer intermediate iterations; only stream the final response.
     * External tool calls and heartbeats are always streamed regardless of mode.
     */
    streamMode?: 'full' | 'final';
    /** Called before streaming the final response. Consumer can transform or pass through. */
    onBeforeStream?: (content: string, ctx: StreamHookContext) => AsyncIterable<string>;
}
export interface SmartAgentReconfigureOptions {
    mainLlm?: ILlm;
    classifierLlm?: ILlm;
    helperLlm?: ILlm;
}
export declare class SmartAgent {
    private readonly deps;
    private config;
    private readonly toolAvailabilityRegistry;
    private readonly tracer;
    private readonly metrics;
    private readonly reranker;
    private readonly queryExpander;
    private readonly toolCache;
    private readonly outputValidator;
    private readonly sessionManager;
    private readonly pendingToolResults;
    private readonly requestLogger;
    private readonly defaultLlmCallStrategy;
    private _activeClients;
    private _mainLlm;
    private _classifierLlm;
    private _helperLlm;
    private _classifier;
    constructor(deps: SmartAgentDeps, config: SmartAgentConfig);
    /** Current main LLM instance. Use this for direct LLM calls that should respect hot-swap. */
    get currentMainLlm(): ILlm;
    private _resolveActiveClients;
    private _revectorizeTools;
    /** Apply a partial config update at runtime (hot-reload). */
    applyConfigUpdate(update: Partial<SmartAgentConfig>): void;
    /**
     * Replace active LLM instances at runtime.
     * Changes apply to new requests only — in-flight requests continue
     * using the dependency snapshot captured at request start.
     * Reconfigured LLMs do not inherit builder-time wrappers (retry, circuit breaker, rate limiter).
     *
     * **Important:** This is the only supported way to hot-swap LLMs.
     * Direct mutation of `deps` fields has no effect — SmartAgent copies
     * deps into private fields at construction time.
     *
     * @example
     * ```typescript
     * const newLlm = makeLlm({ provider: 'openai', model: 'gpt-5.4-pro', ... });
     * handle.agent.reconfigure({ mainLlm: newLlm });
     * // handle.chat() and handle.streamChat() now use the new LLM
     * ```
     */
    reconfigure(update: SmartAgentReconfigureOptions): void;
    /**
     * Add a custom RAG store at runtime. Takes effect on the next request.
     * Built-in store names ('tools', 'history') cannot be overwritten.
     *
     * @param options.translateQuery — when true, the pipeline translates the
     *   query to English before searching this store (useful for stores with
     *   English-only content like MCP tool descriptions).
     */
    addRagStore(name: string, store: IRag, options?: {
        translateQuery?: boolean;
    }): void;
    /**
     * Remove a custom RAG store at runtime. Takes effect on the next request.
     * Built-in store names ('tools', 'history') cannot be removed.
     */
    removeRagStore(name: string): void;
    /**
     * Close a session: remove session-scoped RAG collections for the given
     * sessionId and flush session-scoped history memory.
     * Errors from registry cleanup are logged but not thrown — best-effort.
     */
    closeSession(sessionId: string): Promise<void>;
    /** Returns the model identifiers of the currently active LLM instances. */
    getActiveConfig(): {
        mainModel?: string;
        classifierModel?: string;
        helperModel?: string;
    };
    /** Returns whitelisted runtime-safe agent config fields (for HTTP DTO). */
    getAgentConfig(): {
        maxIterations: number;
        maxToolCalls?: number;
        ragQueryK?: number;
        toolUnavailableTtlMs?: number;
        showReasoning?: boolean;
        historyAutoSummarizeLimit?: number;
        classificationEnabled?: boolean;
    };
    healthCheck(options?: CallOptions): Promise<Result<{
        llm: boolean;
        rag: boolean;
        mcp: {
            name: string;
            ok: boolean;
            error?: string;
        }[];
    }, OrchestratorError>>;
    process(textOrMessages: string | Message[], options?: AgentCallOptions): Promise<Result<SmartAgentResponse, OrchestratorError>>;
    streamProcess(textOrMessages: string | Message[], options?: AgentCallOptions): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>;
    private _preparePipeline;
    private _runStreamingToolLoop;
    private _listAllTools;
    private _toEnglishForRag;
    private _summarizeHistory;
    private _runStructuredPipeline;
}
//# sourceMappingURL=agent.d.ts.map