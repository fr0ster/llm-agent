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
import { CircuitBreaker, CircuitBreakerLlm, FallbackRag, InMemoryRag, isBatchEmbedder, SimpleRagProviderRegistry, SimpleRagRegistry, } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper } from '../mcp/client.js';
import { McpClientAdapter } from './adapters/mcp-client-adapter.js';
import { SmartAgent, } from './agent.js';
import { LlmClassifier, } from './classifier/llm-classifier.js';
import { ContextAssembler, } from './context/context-assembler.js';
import { HistoryMemory } from './history/history-memory.js';
import { HistorySummarizer } from './history/history-summarizer.js';
import { DefaultRequestLogger } from './logger/default-request-logger.js';
import { DefaultPipeline } from './pipeline/default-pipeline.js';
import { RateLimiterLlm } from './resilience/rate-limiter-llm.js';
import { RetryLlm } from './resilience/retry-llm.js';
// ---------------------------------------------------------------------------
// SmartAgentBuilder
// ---------------------------------------------------------------------------
function isModelProvider(obj) {
    return (obj !== null &&
        typeof obj === 'object' &&
        typeof obj.getModels === 'function' &&
        typeof obj.getModel === 'function');
}
export class SmartAgentBuilder {
    cfg;
    // All components injected via fluent setters
    _mainLlm;
    _helperLlm;
    _classifierLlm;
    _onBeforeStream;
    _toolsRag;
    _historyRag;
    _pipeline;
    _mcpClients;
    _classifier;
    _assembler;
    _logger;
    _toolPolicy;
    _injectionDetector;
    _tracer;
    _metrics;
    _reranker;
    _queryExpander;
    _toolCache;
    _outputValidator;
    _sessionManager;
    _circuitBreakerConfig;
    _requestLogger;
    _agentOverrides = {};
    _pluginLoader;
    _skillManager;
    _clientAdapters = [];
    _apiAdapters = new Map();
    _modelProvider;
    _embedder;
    _connectionStrategy;
    _historySummarizer;
    _historyMemory;
    _llmCallStrategy;
    _rateLimiter;
    _providers = [];
    _staticCollections = [];
    _pendingDynamicCollections = [];
    _ragRegistry;
    _ragProviderRegistry;
    constructor(cfg = {}) {
        this.cfg = cfg;
    }
    // -------------------------------------------------------------------------
    // Fluent setters
    // -------------------------------------------------------------------------
    /** Set the main LLM used in the tool loop (required). */
    withMainLlm(llm) {
        this._mainLlm = llm;
        return this;
    }
    /** Set a model provider for model discovery and metadata. */
    withModelProvider(provider) {
        this._modelProvider = provider;
        return this;
    }
    /** Set the helper LLM used for summarization and translation. */
    withHelperLlm(llm) {
        this._helperLlm = llm;
        return this;
    }
    /** Set the LLM used by the intent classifier. If not set, mainLlm is used. */
    withClassifierLlm(llm) {
        this._classifierLlm = llm;
        return this;
    }
    /** Register a hook called before streaming the final response to the client. */
    withOnBeforeStream(hook) {
        this._onBeforeStream = hook;
        return this;
    }
    /** Inject a custom RAG store for MCP tool selection. Overrides auto-created in-memory store. */
    setToolsRag(rag) {
        this._toolsRag = rag;
        return this;
    }
    /** Inject a custom RAG store for conversation history. Overrides auto-created in-memory store. */
    setHistoryRag(rag) {
        this._historyRag = rag;
        return this;
    }
    /** Register an IRagProvider for dynamic collection creation. */
    addRagProvider(provider) {
        this._providers.push(provider);
        return this;
    }
    /** Register a static (pre-built) RAG collection by name. */
    addRagCollection(params) {
        this._staticCollections.push(params);
        return this;
    }
    /** Queue a dynamic collection to be created via a provider during build(). */
    createRagCollection(params) {
        this._pendingDynamicCollections.push(params);
        return this;
    }
    /** Provide a custom IRagRegistry. Defaults to SimpleRagRegistry if not set. */
    setRagRegistry(registry) {
        this._ragRegistry = registry;
        return this;
    }
    /** Provide a custom IRagProviderRegistry. Defaults to SimpleRagProviderRegistry if not set. */
    setRagProviderRegistry(registry) {
        this._ragProviderRegistry = registry;
        return this;
    }
    /** Inject a pipeline implementation. Defaults to DefaultPipeline if not set. */
    setPipeline(pipeline) {
        this._pipeline = pipeline;
        return this;
    }
    /**
     * Override MCP clients. When set, auto-connect and tool vectorization
     * are skipped — the caller is responsible for connecting clients.
     */
    withMcpClients(clients) {
        this._mcpClients = clients;
        return this;
    }
    /** Override the intent classifier. */
    withClassifier(classifier) {
        this._classifier = classifier;
        return this;
    }
    /** Override the context assembler. */
    withAssembler(assembler) {
        this._assembler = assembler;
        return this;
    }
    /** Set a logger for internal pipeline events. */
    withLogger(logger) {
        this._logger = logger;
        return this;
    }
    /** Set a tool execution policy (allow/deny list). */
    withToolPolicy(policy) {
        this._toolPolicy = policy;
        return this;
    }
    /** Set a prompt-injection detector. */
    withInjectionDetector(detector) {
        this._injectionDetector = detector;
        return this;
    }
    /** Set a tracer for pipeline span instrumentation. */
    withTracer(tracer) {
        this._tracer = tracer;
        return this;
    }
    /** Set a metrics collector for pipeline instrumentation. */
    withMetrics(metrics) {
        this._metrics = metrics;
        return this;
    }
    /** Set a reranker to re-score RAG results before context assembly. */
    withReranker(reranker) {
        this._reranker = reranker;
        return this;
    }
    /** Set a query expander to broaden RAG queries with synonyms/related terms. */
    withQueryExpander(expander) {
        this._queryExpander = expander;
        return this;
    }
    /** Set a tool result cache for MCP call deduplication. */
    withToolCache(cache) {
        this._toolCache = cache;
        return this;
    }
    /** Set an output validator for post-LLM response validation. */
    withOutputValidator(validator) {
        this._outputValidator = validator;
        return this;
    }
    /** Set a session manager for multi-turn token budget tracking. */
    withSessionManager(manager) {
        this._sessionManager = manager;
        return this;
    }
    /** Set a skill manager for discovering and loading agent skills. */
    withSkillManager(manager) {
        this._skillManager = manager;
        return this;
    }
    /** Register a client adapter for auto-detecting prompt-based clients. */
    withClientAdapter(adapter) {
        this._clientAdapters.push(adapter);
        return this;
    }
    /** Register an API adapter. When called multiple times with the same name, the last one wins. */
    withApiAdapter(adapter) {
        this._apiAdapters.set(adapter.name, adapter);
        return this;
    }
    /** Enable circuit breakers for LLM and embedder calls. */
    withCircuitBreaker(config = {}) {
        this._circuitBreakerConfig = config;
        return this;
    }
    /** Set the shared embedder for RAG queries. When set, queries embed once and share the vector. */
    withEmbedder(embedder) {
        this._embedder = embedder;
        return this;
    }
    /** Set a request logger for per-model usage tracking. */
    withRequestLogger(logger) {
        this._requestLogger = logger;
        return this;
    }
    /** Set an MCP connection strategy for dynamic client management. */
    withMcpConnectionStrategy(strategy) {
        this._connectionStrategy = strategy;
        return this;
    }
    /** Override the history summarizer used for semantic history compression. */
    withHistorySummarizer(summarizer) {
        this._historySummarizer = summarizer;
        return this;
    }
    /** Set a rate limiter to throttle outbound LLM requests. */
    withRateLimiter(limiter) {
        this._rateLimiter = limiter;
        return this;
    }
    /** Set the LLM call strategy for tool-loop (streaming, non-streaming, or fallback). */
    withLlmCallStrategy(strategy) {
        this._llmCallStrategy = strategy;
        return this;
    }
    /** Override the history memory store used for semantic history retrieval. */
    withHistoryMemory(memory) {
        this._historyMemory = memory;
        return this;
    }
    // -------------------------------------------------------------------------
    // Pipeline configuration (SmartAgentConfig parameters)
    // -------------------------------------------------------------------------
    /** Set the execution mode: 'smart' (full pipeline), 'hard' (MCP-only), 'pass' (direct LLM). */
    withMode(mode) {
        this._agentOverrides.mode = mode;
        return this;
    }
    /** Set the maximum number of tool-loop iterations. */
    withMaxIterations(n) {
        this._agentOverrides.maxIterations = n;
        return this;
    }
    /** Set the maximum number of tool calls per request. */
    withMaxToolCalls(n) {
        this._agentOverrides.maxToolCalls = n;
        return this;
    }
    /** Set the request timeout in milliseconds. */
    withTimeout(ms) {
        this._agentOverrides.timeoutMs = ms;
        return this;
    }
    /** Set the number of RAG results to retrieve per store. */
    withRagQueryK(k) {
        this._agentOverrides.ragQueryK = k;
        return this;
    }
    /** Enable or disable query expansion for RAG queries. */
    withQueryExpansion(enabled) {
        this._agentOverrides.queryExpansionEnabled = enabled;
        return this;
    }
    /** Enable or disable reasoning/strategy blocks in the response. */
    withShowReasoning(enabled) {
        this._agentOverrides.showReasoning = enabled;
        return this;
    }
    /** Set the SSE heartbeat interval in milliseconds during tool execution. */
    withHeartbeatInterval(ms) {
        this._agentOverrides.heartbeatIntervalMs = ms;
        return this;
    }
    /** Set the health check probe timeout in milliseconds. Default: 5000. */
    withHealthTimeout(ms) {
        this._agentOverrides.healthTimeoutMs = ms;
        return this;
    }
    /** Enable or disable the classification pipeline stage. When disabled, input is treated as a single action. */
    withClassification(enabled) {
        this._agentOverrides.classificationEnabled = enabled;
        return this;
    }
    /** Enable per-iteration RAG-based tool re-selection in the tool loop. */
    withToolReselection(enabled) {
        this._agentOverrides.toolReselectPerIteration = enabled;
        return this;
    }
    /** Set the history message count threshold for auto-summarization. */
    withHistorySummarization(limit) {
        this._agentOverrides.historyAutoSummarizeLimit = limit;
        return this;
    }
    /** Set the session token budget for multi-turn conversations. */
    withSessionTokenBudget(budget) {
        this._agentOverrides.sessionTokenBudget = budget;
        return this;
    }
    // -------------------------------------------------------------------------
    // Plugin loader
    // -------------------------------------------------------------------------
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
    withPluginLoader(loader) {
        this._pluginLoader = loader;
        return this;
    }
    // -------------------------------------------------------------------------
    // build()
    // -------------------------------------------------------------------------
    async build() {
        const log = this._logger;
        // ---- Validate required dependencies -----------------------------------
        const mainLlm = this._mainLlm;
        if (!mainLlm) {
            throw new Error('Main LLM is required. Call .withMainLlm(llm) before .build().');
        }
        let wrappedMainLlm = mainLlm;
        // Classifier defaults to main LLM if not provided
        const classifierLlm = this._classifierLlm ?? mainLlm;
        const helperLlm = this._helperLlm;
        // ---- Startup model validation ------------------------------------------
        // Verify that configured models respond before starting the server.
        // Only checks unique models from the pipeline config (main, classifier, helper).
        if (!this.cfg.skipModelValidation) {
            const modelsToCheck = new Map();
            modelsToCheck.set(mainLlm.model ?? 'main', mainLlm);
            if (classifierLlm !== mainLlm) {
                modelsToCheck.set(classifierLlm.model ?? 'classifier', classifierLlm);
            }
            if (helperLlm && helperLlm !== mainLlm) {
                modelsToCheck.set(helperLlm.model ?? 'helper', helperLlm);
            }
            for (const [modelName, llm] of modelsToCheck) {
                const result = await llm.chat([{ role: 'user', content: 'Reply with OK' }], undefined, { maxTokens: 10 });
                if (!result.ok) {
                    const detail = result.error.message;
                    log?.log({
                        type: 'pipeline_error',
                        traceId: 'builder',
                        code: 'MODEL_UNAVAILABLE',
                        message: `Model "${modelName}" is not available: ${detail}`,
                        durationMs: 0,
                    });
                    throw new Error(`Startup aborted: model "${modelName}" is not available.\n${detail}`);
                }
            }
        } // end skipModelValidation guard
        // Auto-create tools RAG if MCP clients will be configured and embedder available
        const toolsRag = this._toolsRag ??
            ((this.cfg.mcp || this._mcpClients) && this._embedder
                ? new InMemoryRag()
                : undefined);
        // Auto-create history RAG if history summarization is enabled
        const historyRag = this._historyRag ??
            (this._agentOverrides.historyAutoSummarizeLimit ||
                this.cfg.agent?.historyAutoSummarizeLimit
                ? new InMemoryRag()
                : undefined);
        // Build provider registry and collection registry (v9.1 wiring).
        const ragProviderRegistry = this._ragProviderRegistry ?? new SimpleRagProviderRegistry();
        for (const p of this._providers)
            ragProviderRegistry.registerProvider(p);
        const ragRegistry = this._ragRegistry ?? new SimpleRagRegistry();
        // Wire providers into registry when the registry supports it (SimpleRagRegistry does).
        if (ragRegistry instanceof SimpleRagRegistry ||
            typeof ragRegistry
                .setProviderRegistry === 'function') {
            ragRegistry.setProviderRegistry(ragProviderRegistry);
        }
        // Register user-supplied static collections (from addRagCollection fluent calls).
        for (const c of this._staticCollections) {
            ragRegistry.register(c.name, c.rag, c.editor, c.meta);
        }
        // Mirror the built-in toolsRag / historyRag into the registry so the projection preserves
        // ragStores.tools / ragStores.history behavior that existing handlers rely on.
        if (toolsRag && !ragRegistry.get('tools')) {
            ragRegistry.register('tools', toolsRag, undefined, {
                displayName: 'tools',
                scope: 'global',
            });
        }
        if (historyRag && !ragRegistry.get('history')) {
            ragRegistry.register('history', historyRag, undefined, {
                displayName: 'history',
                scope: 'global',
            });
        }
        // Create any queued dynamic collections at startup.
        for (const c of this._pendingDynamicCollections) {
            const res = await ragRegistry.createCollection(c);
            if (!res.ok) {
                throw new Error(`Failed to create collection '${c.collectionName}': ${res.error.message}`);
            }
        }
        // Derive ragStores as a live projection of the registry; keep it in sync via the
        // registry's mutation listener so existing code paths (assembler, handlers,
        // addRagStore/removeRagStore) see the same shape.
        const ragStores = {};
        const rebuildProjection = () => {
            for (const k of Object.keys(ragStores))
                delete ragStores[k];
            for (const m of ragRegistry.list()) {
                const r = ragRegistry.get(m.name);
                if (r)
                    ragStores[m.name] = r;
            }
        };
        rebuildProjection();
        if (ragRegistry instanceof SimpleRagRegistry ||
            typeof ragRegistry
                .setMutationListener === 'function') {
            ragRegistry.setMutationListener(rebuildProjection);
        }
        const translateQueryStores = new Set();
        if (toolsRag)
            translateQueryStores.add('tools');
        // ---- Circuit breaker wrapping ----------------------------------------
        const circuitBreakers = [];
        if (this._circuitBreakerConfig) {
            const cbCfg = this._circuitBreakerConfig;
            const metricsRef = this._metrics;
            const makeOnStateChange = (target) => (from, to) => {
                metricsRef?.circuitBreakerTransition.add(1, { from, to, target });
            };
            // Wrap mainLlm
            const llmBreaker = new CircuitBreaker({
                ...cbCfg,
                onStateChange: cbCfg.onStateChange ?? makeOnStateChange('llm'),
            });
            wrappedMainLlm = new CircuitBreakerLlm(wrappedMainLlm, llmBreaker);
            circuitBreakers.push(llmBreaker);
            // Wrap RAG stores with FallbackRag using InMemoryRag fallback
            const embedderBreaker = new CircuitBreaker({
                ...cbCfg,
                onStateChange: cbCfg.onStateChange ?? makeOnStateChange('embedder'),
            });
            circuitBreakers.push(embedderBreaker);
            for (const [key, store] of Object.entries(ragStores)) {
                const wrapped = new FallbackRag(store, new InMemoryRag(), embedderBreaker);
                // Update both registry and projection so later lookups (and the mutation-listener
                // rebuild) see the wrapped store.
                const existingMeta = ragRegistry.list().find((m) => m.name === key);
                ragRegistry.unregister(key);
                ragRegistry.register(key, wrapped, undefined, {
                    displayName: existingMeta?.displayName ?? key,
                    scope: existingMeta?.scope ?? 'global',
                });
                // Projection gets rebuilt by the mutation listener; no direct write to ragStores needed.
            }
        }
        // ---- Request logger ---------------------------------------------------
        const requestLogger = this._requestLogger ?? new DefaultRequestLogger();
        // ---- MCP clients + tool vectorization --------------------------------
        let mcpClients;
        const closeFns = [];
        const connectionStrategy = this._connectionStrategy;
        if (this._mcpClients) {
            // Caller-provided clients: skip auto-connect and vectorization
            mcpClients = this._mcpClients;
        }
        else {
            const mcpList = this.cfg.mcp
                ? Array.isArray(this.cfg.mcp)
                    ? this.cfg.mcp
                    : [this.cfg.mcp]
                : [];
            const connected = [];
            for (const mcpCfg of mcpList) {
                try {
                    let wrapper;
                    if (mcpCfg.type === 'stdio') {
                        wrapper = new MCPClientWrapper({
                            transport: 'stdio',
                            command: mcpCfg.command,
                            args: mcpCfg.args ?? [],
                        });
                    }
                    else {
                        wrapper = new MCPClientWrapper({
                            transport: 'auto',
                            url: mcpCfg.url,
                            headers: mcpCfg.headers,
                        });
                    }
                    await wrapper.connect();
                    const adapter = new McpClientAdapter(wrapper);
                    log?.log({
                        type: 'pipeline_done',
                        traceId: 'builder',
                        stopReason: 'stop',
                        iterations: 0,
                        toolCallCount: 0,
                        durationMs: 0,
                    });
                    // Vectorize tools into the tools RAG store
                    if (toolsRag) {
                        const toolsResult = await adapter.listTools();
                        if (toolsResult.ok) {
                            const tools = toolsResult.value;
                            // Try to access the embedder from the store for batch embedding.
                            // VectorRag and QdrantRag store their embedder as a private field.
                            // biome-ignore lint/suspicious/noExplicitAny: accessing private embedder for batch optimization
                            const storeEmbedder = toolsRag.embedder;
                            if (storeEmbedder &&
                                isBatchEmbedder(storeEmbedder) &&
                                toolsRag.writer?.()?.upsertPrecomputedRaw !== undefined) {
                                // Batch path: single HTTP call for all tools
                                const texts = tools.map((t) => `Tool: ${t.name} — ${t.description}`);
                                const batchStart = Date.now();
                                try {
                                    const embedResults = await storeEmbedder.embedBatch(texts);
                                    const batchDuration = Date.now() - batchStart;
                                    for (let i = 0; i < tools.length; i++) {
                                        const toolWriter = toolsRag.writer?.();
                                        const result = toolWriter?.upsertPrecomputedRaw
                                            ? await toolWriter.upsertPrecomputedRaw(`tool:${tools[i].name}`, texts[i], embedResults[i].vector, {})
                                            : toolWriter
                                                ? await toolWriter.upsertRaw(`tool:${tools[i].name}`, texts[i], {})
                                                : { ok: true, value: undefined };
                                        if (!result.ok) {
                                            log?.log({
                                                type: 'warning',
                                                traceId: 'builder',
                                                message: `Tool vectorization failed for "${tools[i].name}": ${result.error.message}`,
                                            });
                                        }
                                    }
                                    const realUsage = embedResults.reduce((acc, r) => {
                                        if (!r.usage)
                                            return acc;
                                        return {
                                            promptTokens: (acc?.promptTokens ?? 0) + r.usage.promptTokens,
                                            totalTokens: (acc?.totalTokens ?? 0) + r.usage.totalTokens,
                                        };
                                    }, null);
                                    const totalEstTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
                                    requestLogger.logLlmCall({
                                        component: 'embedding',
                                        model: 'embedder',
                                        promptTokens: realUsage?.promptTokens ?? totalEstTokens,
                                        completionTokens: 0,
                                        totalTokens: realUsage?.totalTokens ?? totalEstTokens,
                                        durationMs: batchDuration,
                                        estimated: realUsage === null,
                                        scope: 'initialization',
                                        detail: 'tools',
                                    });
                                }
                                catch (err) {
                                    log?.log({
                                        type: 'warning',
                                        traceId: 'builder',
                                        message: `Batch embedding failed, falling back to sequential: ${String(err)}`,
                                    });
                                    // Fallback to sequential
                                    const batchSize = 5;
                                    const batchDelayMs = 500;
                                    for (let i = 0; i < tools.length; i++) {
                                        const t = tools[i];
                                        const text = `Tool: ${t.name} — ${t.description}`;
                                        const embedStart = Date.now();
                                        const result = await toolsRag
                                            .writer?.()
                                            ?.upsertRaw(`tool:${t.name}`, text, {});
                                        if (result && !result.ok) {
                                            log?.log({
                                                type: 'warning',
                                                traceId: 'builder',
                                                message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                                            });
                                        }
                                        else {
                                            requestLogger.logLlmCall({
                                                component: 'embedding',
                                                model: 'embedder',
                                                promptTokens: Math.ceil(text.length / 4),
                                                completionTokens: 0,
                                                totalTokens: Math.ceil(text.length / 4),
                                                durationMs: Date.now() - embedStart,
                                                estimated: true,
                                                scope: 'initialization',
                                                detail: 'tools',
                                            });
                                        }
                                        if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
                                            await new Promise((r) => setTimeout(r, batchDelayMs));
                                        }
                                    }
                                }
                            }
                            else {
                                // Sequential path (no batch support)
                                const batchSize = 5;
                                const batchDelayMs = 500;
                                for (let i = 0; i < tools.length; i++) {
                                    const t = tools[i];
                                    const text = `Tool: ${t.name} — ${t.description}`;
                                    const embedStart = Date.now();
                                    const result = await toolsRag
                                        .writer?.()
                                        ?.upsertRaw(`tool:${t.name}`, text, {});
                                    if (result && !result.ok) {
                                        log?.log({
                                            type: 'warning',
                                            traceId: 'builder',
                                            message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                                        });
                                    }
                                    else {
                                        requestLogger.logLlmCall({
                                            component: 'embedding',
                                            model: 'embedder',
                                            promptTokens: Math.ceil(text.length / 4),
                                            completionTokens: 0,
                                            totalTokens: Math.ceil(text.length / 4),
                                            durationMs: Date.now() - embedStart,
                                            estimated: true,
                                            scope: 'initialization',
                                            detail: 'tools',
                                        });
                                    }
                                    if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
                                        await new Promise((r) => setTimeout(r, batchDelayMs));
                                    }
                                }
                            }
                        }
                    }
                    connected.push(adapter);
                    closeFns.push(() => wrapper.disconnect?.() ?? Promise.resolve());
                }
                catch (err) {
                    // Skip failed MCP setup — agent continues without that server, but
                    // surface why: silently swallowing this leaves operators chasing
                    // "agent has no tools" with no log line to point at the cause
                    // (unreachable host, bad auth, container-network mismatch, etc.).
                    // Note: this try-block also covers tool/skill vectorization, so the
                    // failure could be either connect or post-connect setup.
                    const target = mcpCfg.type === 'stdio' ? mcpCfg.command : mcpCfg.url;
                    log?.log({
                        type: 'warning',
                        traceId: 'builder',
                        message: `MCP setup failed for ${target}: ${err instanceof Error ? err.message : String(err)}`,
                    });
                }
            }
            mcpClients = connected;
        }
        // ---- SmartAgent Config ------------------------------------------------
        const agentCfg = {
            maxIterations: 10,
            maxToolCalls: 30,
            ragQueryK: 10,
            ragTranslatePrompt: this.cfg.prompts?.ragTranslate,
            historySummaryPrompt: this.cfg.prompts?.historySummary,
            historyAutoSummarizeLimit: this.cfg.agent?.historyAutoSummarizeLimit,
            ...this.cfg.agent,
            ...(this.cfg.sessionPolicy
                ? { sessionPolicy: this.cfg.sessionPolicy }
                : {}),
            // Fluent overrides take precedence over cfg.agent
            ...this._agentOverrides,
            onBeforeStream: this._onBeforeStream,
        };
        // ---- Retry wrapping (outside circuit breaker) ----------------------------
        // Enable retry by default with sensible defaults; explicit config overrides.
        const retryOpts = agentCfg.retry ?? {
            maxAttempts: 3,
            backoffMs: 2000,
            retryOn: [429, 500, 502, 503],
            retryOnMidStream: [],
        };
        wrappedMainLlm = new RetryLlm(wrappedMainLlm, retryOpts);
        // ---- Rate limiter wrapping (outermost — retry attempts also throttled) ----
        if (this._rateLimiter) {
            wrappedMainLlm = new RateLimiterLlm(wrappedMainLlm, this._rateLimiter);
        }
        // ---- Classifier -------------------------------------------------------
        const classifierCfg = {};
        if (this.cfg.prompts?.classifier)
            classifierCfg.systemPrompt = this.cfg.prompts.classifier;
        const classifier = this._classifier ??
            new LlmClassifier(classifierLlm, classifierCfg, requestLogger);
        // ---- Assembler --------------------------------------------------------
        const assemblerCfg = {
            maxTokens: agentCfg.contextBudgetTokens,
            showReasoning: agentCfg.showReasoning,
            reasoningInstruction: this.cfg.prompts?.reasoning,
            historyRecencyWindow: agentCfg.historyRecencyWindow,
        };
        if (this.cfg.prompts?.system)
            assemblerCfg.systemPromptPreamble = this.cfg.prompts.system;
        const assembler = this._assembler ?? new ContextAssembler(assemblerCfg);
        // ---- History memory & summarizer ----------------------------------------
        let historyMemory;
        let historySummarizer;
        if (agentCfg.semanticHistoryEnabled) {
            historyMemory =
                this._historyMemory ??
                    new HistoryMemory({
                        maxSize: agentCfg.historyRecencyWindow ?? 3,
                    });
            const summarizerLlm = this._helperLlm ?? mainLlm;
            historySummarizer =
                this._historySummarizer ??
                    new HistorySummarizer(summarizerLlm, agentCfg.historyTurnSummaryPrompt
                        ? { prompt: agentCfg.historyTurnSummaryPrompt }
                        : undefined);
            if (historyRag && !ragRegistry.get('history')) {
                ragRegistry.register('history', historyRag, undefined, {
                    displayName: 'history',
                    scope: 'global',
                });
                // ragStores projection updates via mutation listener.
            }
        }
        // ---- Plugin loader (optional) -------------------------------------------
        let loadedPlugins;
        if (this._pluginLoader) {
            const plugins = await this._pluginLoader.load();
            loadedPlugins = plugins;
            if (plugins.reranker && !this._reranker) {
                this._reranker = plugins.reranker;
            }
            if (plugins.queryExpander && !this._queryExpander) {
                this._queryExpander = plugins.queryExpander;
            }
            if (plugins.outputValidator && !this._outputValidator) {
                this._outputValidator = plugins.outputValidator;
            }
            if (plugins.skillManager && !this._skillManager) {
                this._skillManager = plugins.skillManager;
            }
            if (plugins.clientAdapters.length > 0) {
                this._clientAdapters.push(...plugins.clientAdapters);
            }
        }
        // ---- Skill vectorization (optional) ------------------------------------
        if (this._skillManager && toolsRag) {
            const skillsResult = await this._skillManager.listSkills();
            if (skillsResult.ok) {
                for (const s of skillsResult.value) {
                    const text = `Skill: ${s.name}\n${s.description}`;
                    const embedStart = Date.now();
                    const result = await toolsRag
                        .writer?.()
                        ?.upsertRaw(`skill:${s.name}`, text, {});
                    if (result && !result.ok) {
                        log?.log({
                            type: 'warning',
                            traceId: 'builder',
                            message: `Skill vectorization failed for "${s.name}": ${result.error.message}`,
                        });
                    }
                    else {
                        requestLogger.logLlmCall({
                            component: 'embedding',
                            model: 'embedder',
                            promptTokens: Math.ceil(text.length / 4),
                            completionTokens: 0,
                            totalTokens: Math.ceil(text.length / 4),
                            durationMs: Date.now() - embedStart,
                            estimated: true,
                            scope: 'initialization',
                            detail: 'skills',
                        });
                    }
                }
            }
        }
        // ---- Pipeline initialization -------------------------------------------
        const pipeline = this._pipeline ?? new DefaultPipeline();
        pipeline.initialize({
            mainLlm: wrappedMainLlm,
            helperLlm,
            classifierLlm,
            classifier,
            assembler,
            mcpClients,
            toolsRag,
            historyRag,
            ragStores,
            ragRegistry,
            ragProviderRegistry,
            embedder: this._embedder,
            reranker: this._reranker,
            queryExpander: this._queryExpander,
            toolPolicy: this._toolPolicy,
            injectionDetector: this._injectionDetector,
            toolCache: this._toolCache,
            outputValidator: this._outputValidator,
            sessionManager: this._sessionManager,
            skillManager: this._skillManager,
            logger: log,
            requestLogger,
            tracer: this._tracer,
            metrics: this._metrics,
            historyMemory,
            historySummarizer,
            llmCallStrategy: this._llmCallStrategy,
            agentConfig: agentCfg,
        });
        const agent = new SmartAgent({
            mainLlm: wrappedMainLlm,
            helperLlm: this._helperLlm,
            mcpClients,
            ragStores,
            ragRegistry,
            ragProviderRegistry,
            classifier,
            classifierLlm,
            classifierConfig: classifierCfg,
            assembler,
            pipeline,
            ...(log ? { logger: log } : {}),
            ...(this._toolPolicy ? { toolPolicy: this._toolPolicy } : {}),
            ...(this._injectionDetector
                ? { injectionDetector: this._injectionDetector }
                : {}),
            ...(this._reranker ? { reranker: this._reranker } : {}),
            ...(this._queryExpander ? { queryExpander: this._queryExpander } : {}),
            ...(this._tracer ? { tracer: this._tracer } : {}),
            ...(this._metrics ? { metrics: this._metrics } : {}),
            ...(this._toolCache ? { toolCache: this._toolCache } : {}),
            ...(this._outputValidator
                ? { outputValidator: this._outputValidator }
                : {}),
            ...(this._sessionManager
                ? { sessionManager: this._sessionManager }
                : {}),
            ...(this._skillManager ? { skillManager: this._skillManager } : {}),
            ...(this._clientAdapters.length > 0
                ? { clientAdapters: this._clientAdapters }
                : {}),
            ...(this._embedder ? { embedder: this._embedder } : {}),
            ...(connectionStrategy ? { connectionStrategy } : {}),
            ...(historyMemory ? { historyMemory } : {}),
            ...(historySummarizer ? { historySummarizer } : {}),
            ...(this._llmCallStrategy
                ? { llmCallStrategy: this._llmCallStrategy }
                : {}),
            ...(translateQueryStores.size > 0 ? { translateQueryStores } : {}),
            requestLogger,
        }, agentCfg);
        // ---- Model provider auto-detection ------------------------------------
        let modelProvider = this._modelProvider;
        if (!modelProvider) {
            const candidate = mainLlm;
            if (isModelProvider(candidate)) {
                modelProvider = candidate;
            }
        }
        // ---- API adapters: merge plugin adapters → builder adapters (builder wins) ---
        // plugins.apiAdapters does not exist yet (added in Task 4); safe future-compat check.
        const apiAdapters = new Map();
        const pluginApiAdapters = loadedPlugins?.apiAdapters;
        if (pluginApiAdapters) {
            for (const [name, adapter] of pluginApiAdapters) {
                apiAdapters.set(name, adapter);
            }
        }
        for (const [name, adapter] of this._apiAdapters) {
            apiAdapters.set(name, adapter);
        }
        return {
            agent,
            chat: (messages, tools, options) => agent.currentMainLlm.chat(messages, tools, options),
            streamChat: (messages, tools, options) => agent.currentMainLlm.streamChat(messages, tools, options),
            requestLogger,
            close: async () => {
                await connectionStrategy?.dispose?.();
                for (const fn of closeFns)
                    await fn();
            },
            circuitBreakers,
            ragStores,
            modelProvider,
            getApiAdapter: (name) => apiAdapters.get(name),
            listApiAdapters: () => [...apiAdapters.keys()],
        };
    }
}
//# sourceMappingURL=builder.js.map