/**
 * SmartAgentBuilder — fluent builder for SmartAgent.
 *
 * Assembles a SmartAgent from interface-based components.
 * The builder itself has NO knowledge of concrete providers —
 * all dependencies must be injected via `withXxx()` methods or
 * resolved externally by the composition root (SmartServer, CLI).
 *
 * Usage:
 *   const handle = await new SmartAgentBuilder()
 *     .withMainLlm(myLlm)
 *     .setToolsRag(myRag)
 *     .build();
 */
import type { IClientAdapter, IContextAssembler, IHistoryMemory, IHistorySummarizer, ILlm, ILlmApiAdapter, ILlmCallStrategy, ILlmRateLimiter, ILogger, IMcpClient, IModelProvider, IQueryExpander, IRequestLogger, ISkillManager, ISubpromptClassifier, IToolCache, SmartAgentRagStores } from '@mcp-abap-adt/llm-agent';
import { CircuitBreaker, type CircuitBreakerConfig, type IEmbedder, type IRag, type IRagEditor, type IRagProvider, type IRagProviderRegistry, type IRagRegistry, type RagCollectionMeta, type RagCollectionScope } from '@mcp-abap-adt/llm-agent';
import { SmartAgent, type SmartAgentConfig } from './agent.js';
import type { IMcpConnectionStrategy } from './interfaces/mcp-connection-strategy.js';
import type { IPipeline } from './interfaces/pipeline.js';
import type { IMetrics } from './metrics/types.js';
import type { IPluginLoader } from './plugins/types.js';
import type { IPromptInjectionDetector, IToolPolicy, SessionPolicy } from './policy/types.js';
import type { IReranker } from './reranker/types.js';
import type { ISessionManager } from './session/types.js';
import type { ITracer } from './tracer/types.js';
import type { IOutputValidator } from './validator/types.js';
export interface BuilderMcpConfig {
    type: 'http' | 'stdio';
    /** HTTP: MCP endpoint URL */
    url?: string;
    /** stdio: command to spawn */
    command?: string;
    /** stdio: command arguments */
    args?: string[];
    /** HTTP headers (e.g. x-sap-destination for reverse proxy routing) */
    headers?: Record<string, string>;
}
export interface BuilderPromptsConfig {
    /** Preamble prepended to the ContextAssembler system message. */
    system?: string;
    /** Override the intent-classifier system prompt. */
    classifier?: string;
    /** Instruction for the reasoning/strategy block. */
    reasoning?: string;
    /** Prompt for query translation for RAG. */
    ragTranslate?: string;
    /** Prompt for history summarization. */
    historySummary?: string;
}
export interface SmartAgentBuilderConfig {
    /** MCP connection(s). Pass an array to connect multiple servers simultaneously. */
    mcp?: BuilderMcpConfig | BuilderMcpConfig[];
    /** SmartAgent orchestration limits. */
    agent?: Partial<SmartAgentConfig>;
    /** System / classifier prompt overrides. */
    prompts?: BuilderPromptsConfig;
    /** Data governance policy for RAG records. */
    sessionPolicy?: SessionPolicy;
    /** Skip startup model validation (useful for testing). Default: false. */
    skipModelValidation?: boolean;
}
export interface SmartAgentHandle {
    /** The built and wired SmartAgent, ready to call .process(). */
    agent: SmartAgent;
    /**
     * Direct LLM chat — bypasses SmartAgent pipeline.
     * Used by SmartServer passthrough mode to forward the full message history.
     */
    chat: ILlm['chat'];
    /** Direct LLM streaming chat. */
    streamChat: ILlm['streamChat'];
    /** Request logger for per-model usage tracking. */
    requestLogger: IRequestLogger;
    /** Gracefully close MCP connections. Call on shutdown. */
    close(): Promise<void>;
    /** Circuit breakers (empty when not configured). */
    circuitBreakers: CircuitBreaker[];
    /** RAG stores (for config hot-reload weight updates). */
    ragStores: SmartAgentRagStores;
    /** Model provider for discovery. Undefined when not available. */
    modelProvider?: IModelProvider;
    /** Look up a registered API adapter by name. */
    getApiAdapter(name: string): ILlmApiAdapter | undefined;
    /** List all registered API adapter names. */
    listApiAdapters(): string[];
}
export declare class SmartAgentBuilder {
    private readonly cfg;
    private _mainLlm?;
    private _helperLlm?;
    private _classifierLlm?;
    private _onBeforeStream?;
    private _toolsRag?;
    private _historyRag?;
    private _pipeline?;
    private _mcpClients?;
    private _classifier?;
    private _assembler?;
    private _logger?;
    private _toolPolicy?;
    private _injectionDetector?;
    private _tracer?;
    private _metrics?;
    private _reranker?;
    private _queryExpander?;
    private _toolCache?;
    private _outputValidator?;
    private _sessionManager?;
    private _circuitBreakerConfig?;
    private _requestLogger?;
    private _agentOverrides;
    private _pluginLoader?;
    private _skillManager?;
    private _clientAdapters;
    private _apiAdapters;
    private _modelProvider?;
    private _embedder?;
    private _connectionStrategy?;
    private _historySummarizer?;
    private _historyMemory?;
    private _llmCallStrategy?;
    private _rateLimiter?;
    private _providers;
    private _staticCollections;
    private _pendingDynamicCollections;
    private _ragRegistry?;
    private _ragProviderRegistry?;
    constructor(cfg?: SmartAgentBuilderConfig);
    /** Set the main LLM used in the tool loop (required). */
    withMainLlm(llm: ILlm): this;
    /** Set a model provider for model discovery and metadata. */
    withModelProvider(provider: IModelProvider): this;
    /** Set the helper LLM used for summarization and translation. */
    withHelperLlm(llm: ILlm): this;
    /** Set the LLM used by the intent classifier. If not set, mainLlm is used. */
    withClassifierLlm(llm: ILlm): this;
    /** Register a hook called before streaming the final response to the client. */
    withOnBeforeStream(hook: SmartAgentConfig['onBeforeStream']): this;
    /** Inject a custom RAG store for MCP tool selection. Overrides auto-created in-memory store. */
    setToolsRag(rag: IRag): this;
    /** Inject a custom RAG store for conversation history. Overrides auto-created in-memory store. */
    setHistoryRag(rag: IRag): this;
    /** Register an IRagProvider for dynamic collection creation. */
    addRagProvider(provider: IRagProvider): this;
    /** Register a static (pre-built) RAG collection by name. */
    addRagCollection(params: {
        name: string;
        rag: IRag;
        editor?: IRagEditor;
        meta?: Omit<RagCollectionMeta, 'name' | 'editable'>;
    }): this;
    /** Queue a dynamic collection to be created via a provider during build(). */
    createRagCollection(params: {
        providerName: string;
        collectionName: string;
        scope: RagCollectionScope;
        sessionId?: string;
        userId?: string;
        displayName?: string;
        description?: string;
        tags?: readonly string[];
    }): this;
    /** Provide a custom IRagRegistry. Defaults to SimpleRagRegistry if not set. */
    setRagRegistry(registry: IRagRegistry): this;
    /** Provide a custom IRagProviderRegistry. Defaults to SimpleRagProviderRegistry if not set. */
    setRagProviderRegistry(registry: IRagProviderRegistry): this;
    /** Inject a pipeline implementation. Defaults to DefaultPipeline if not set. */
    setPipeline(pipeline: IPipeline): this;
    /**
     * Override MCP clients. When set, auto-connect and tool vectorization
     * are skipped — the caller is responsible for connecting clients.
     */
    withMcpClients(clients: IMcpClient[]): this;
    /** Override the intent classifier. */
    withClassifier(classifier: ISubpromptClassifier): this;
    /** Override the context assembler. */
    withAssembler(assembler: IContextAssembler): this;
    /** Set a logger for internal pipeline events. */
    withLogger(logger: ILogger): this;
    /** Set a tool execution policy (allow/deny list). */
    withToolPolicy(policy: IToolPolicy): this;
    /** Set a prompt-injection detector. */
    withInjectionDetector(detector: IPromptInjectionDetector): this;
    /** Set a tracer for pipeline span instrumentation. */
    withTracer(tracer: ITracer): this;
    /** Set a metrics collector for pipeline instrumentation. */
    withMetrics(metrics: IMetrics): this;
    /** Set a reranker to re-score RAG results before context assembly. */
    withReranker(reranker: IReranker): this;
    /** Set a query expander to broaden RAG queries with synonyms/related terms. */
    withQueryExpander(expander: IQueryExpander): this;
    /** Set a tool result cache for MCP call deduplication. */
    withToolCache(cache: IToolCache): this;
    /** Set an output validator for post-LLM response validation. */
    withOutputValidator(validator: IOutputValidator): this;
    /** Set a session manager for multi-turn token budget tracking. */
    withSessionManager(manager: ISessionManager): this;
    /** Set a skill manager for discovering and loading agent skills. */
    withSkillManager(manager: ISkillManager): this;
    /** Register a client adapter for auto-detecting prompt-based clients. */
    withClientAdapter(adapter: IClientAdapter): this;
    /** Register an API adapter. When called multiple times with the same name, the last one wins. */
    withApiAdapter(adapter: ILlmApiAdapter): this;
    /** Enable circuit breakers for LLM and embedder calls. */
    withCircuitBreaker(config?: CircuitBreakerConfig): this;
    /** Set the shared embedder for RAG queries. When set, queries embed once and share the vector. */
    withEmbedder(embedder: IEmbedder): this;
    /** Set a request logger for per-model usage tracking. */
    withRequestLogger(logger: IRequestLogger): this;
    /** Set an MCP connection strategy for dynamic client management. */
    withMcpConnectionStrategy(strategy: IMcpConnectionStrategy): this;
    /** Override the history summarizer used for semantic history compression. */
    withHistorySummarizer(summarizer: IHistorySummarizer): this;
    /** Set a rate limiter to throttle outbound LLM requests. */
    withRateLimiter(limiter: ILlmRateLimiter): this;
    /** Set the LLM call strategy for tool-loop (streaming, non-streaming, or fallback). */
    withLlmCallStrategy(strategy: ILlmCallStrategy): this;
    /** Override the history memory store used for semantic history retrieval. */
    withHistoryMemory(memory: IHistoryMemory): this;
    /** Set the execution mode: 'smart' (full pipeline), 'hard' (MCP-only), 'pass' (direct LLM). */
    withMode(mode: 'hard' | 'pass' | 'smart'): this;
    /** Set the maximum number of tool-loop iterations. */
    withMaxIterations(n: number): this;
    /** Set the maximum number of tool calls per request. */
    withMaxToolCalls(n: number): this;
    /** Set the request timeout in milliseconds. */
    withTimeout(ms: number): this;
    /** Set the number of RAG results to retrieve per store. */
    withRagQueryK(k: number): this;
    /** Enable or disable query expansion for RAG queries. */
    withQueryExpansion(enabled: boolean): this;
    /** Enable or disable reasoning/strategy blocks in the response. */
    withShowReasoning(enabled: boolean): this;
    /** Set the SSE heartbeat interval in milliseconds during tool execution. */
    withHeartbeatInterval(ms: number): this;
    /** Set the health check probe timeout in milliseconds. Default: 5000. */
    withHealthTimeout(ms: number): this;
    /** Enable or disable the classification pipeline stage. When disabled, input is treated as a single action. */
    withClassification(enabled: boolean): this;
    /** Enable per-iteration RAG-based tool re-selection in the tool loop. */
    withToolReselection(enabled: boolean): this;
    /** Set the history message count threshold for auto-summarization. */
    withHistorySummarization(limit: number): this;
    /** Set the session token budget for multi-turn conversations. */
    withSessionTokenBudget(budget: number): this;
    /**
     * Set a plugin loader for automatic plugin discovery.
     *
     * During `build()`, the loader's `load()` method is called and all
     * discovered registrations are applied to the builder (stage handlers,
     * embedder factories, reranker, query expander, output validator).
     *
     * The library ships {@link FileSystemPluginLoader} as the default.
     * Consumers can provide their own `IPluginLoader` implementation to
     * load plugins from npm packages, remote registries, or any other source.
     *
     * Explicit `withReranker()`, etc. calls take
     * precedence over plugin-loaded registrations.
     *
     * @example Filesystem (default)
     * ```ts
     * import { FileSystemPluginLoader, getDefaultPluginDirs } from '@mcp-abap-adt/llm-agent';
     * builder.withPluginLoader(new FileSystemPluginLoader({
     *   dirs: getDefaultPluginDirs(),
     * }));
     * ```
     *
     * @example Custom npm loader
     * ```ts
     * builder.withPluginLoader(new NpmPluginLoader(['my-plugin-a']));
     * ```
     */
    withPluginLoader(loader: IPluginLoader): this;
    build(): Promise<SmartAgentHandle>;
}
//# sourceMappingURL=builder.d.ts.map