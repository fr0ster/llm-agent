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
 *     .withRag({ facts: myRag, feedback: myRag })
 *     .build();
 */

import { MCPClientWrapper } from '../mcp/client.js';
import { McpClientAdapter } from './adapters/mcp-client-adapter.js';
import {
  SmartAgent,
  type SmartAgentConfig,
  type SmartAgentRagStores,
} from './agent.js';
import type { IToolCache } from './cache/types.js';
import {
  LlmClassifier,
  type LlmClassifierConfig,
} from './classifier/llm-classifier.js';
import {
  ContextAssembler,
  type ContextAssemblerConfig,
} from './context/context-assembler.js';
import type { ILlmApiAdapter } from './interfaces/api-adapter.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { IClientAdapter } from './interfaces/client-adapter.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IMcpConnectionStrategy } from './interfaces/mcp-connection-strategy.js';
import type { IModelProvider } from './interfaces/model-provider.js';
import type { IEmbedder } from './interfaces/rag.js';
import type { IRequestLogger } from './interfaces/request-logger.js';
import type { ISkillManager } from './interfaces/skill.js';
import { DefaultRequestLogger } from './logger/default-request-logger.js';
import type { ILogger } from './logger/types.js';
import type { IMetrics } from './metrics/types.js';
import { PipelineExecutor } from './pipeline/executor.js';
import type { IStageHandler } from './pipeline/stage-handler.js';
import type {
  StageDefinition,
  StructuredPipelineDefinition,
} from './pipeline/types.js';
import type { IPluginLoader } from './plugins/types.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import type { IQueryExpander } from './rag/query-expander.js';
import type { IReranker } from './reranker/types.js';
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
} from './resilience/circuit-breaker.js';
import { CircuitBreakerLlm } from './resilience/circuit-breaker-llm.js';
import { FallbackRag } from './resilience/fallback-rag.js';
import { RetryLlm } from './resilience/retry-llm.js';
import type { ISessionManager } from './session/types.js';
import type { ITracer } from './tracer/types.js';
import type { IOutputValidator } from './validator/types.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface BuilderMcpConfig {
  type: 'http' | 'stdio';
  /** HTTP: MCP endpoint URL */
  url?: string;
  /** stdio: command to spawn */
  command?: string;
  /** stdio: command arguments */
  args?: string[];
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
}

// ---------------------------------------------------------------------------
// Handle returned by build()
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SmartAgentBuilder
// ---------------------------------------------------------------------------

function isModelProvider(obj: unknown): obj is IModelProvider {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as IModelProvider).getModels === 'function' &&
    typeof (obj as IModelProvider).getModel === 'function'
  );
}

export class SmartAgentBuilder {
  private readonly cfg: SmartAgentBuilderConfig;

  // All components injected via fluent setters
  private _mainLlm?: ILlm;
  private _helperLlm?: ILlm;
  private _classifierLlm?: ILlm;
  private _onBeforeStream?: SmartAgentConfig['onBeforeStream'];
  private _ragStores: SmartAgentRagStores = {};
  private _mcpClients?: IMcpClient[];
  private _classifier?: ISubpromptClassifier;
  private _assembler?: IContextAssembler;
  private _logger?: ILogger;
  private _toolPolicy?: IToolPolicy;
  private _injectionDetector?: IPromptInjectionDetector;
  private _tracer?: ITracer;
  private _metrics?: IMetrics;
  private _reranker?: IReranker;
  private _queryExpander?: IQueryExpander;
  private _toolCache?: IToolCache;
  private _outputValidator?: IOutputValidator;
  private _sessionManager?: ISessionManager;
  private _circuitBreakerConfig?: CircuitBreakerConfig;
  private _requestLogger?: IRequestLogger;
  private _agentOverrides: Partial<SmartAgentConfig> = {};
  private _pluginLoader?: IPluginLoader;
  private _skillManager?: ISkillManager;
  private _pipelineDefinition?: StructuredPipelineDefinition;
  private _clientAdapters: IClientAdapter[] = [];
  private _apiAdapters: Map<string, ILlmApiAdapter> = new Map();
  private _customStageHandlers = new Map<string, IStageHandler>();
  private _modelProvider?: IModelProvider;
  private _embedder?: IEmbedder;
  private _connectionStrategy?: IMcpConnectionStrategy;

  constructor(cfg: SmartAgentBuilderConfig = {}) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Fluent setters
  // -------------------------------------------------------------------------

  /** Set the main LLM used in the tool loop (required). */
  withMainLlm(llm: ILlm): this {
    this._mainLlm = llm;
    return this;
  }

  /** Set a model provider for model discovery and metadata. */
  withModelProvider(provider: IModelProvider): this {
    this._modelProvider = provider;
    return this;
  }

  /** Set the helper LLM used for summarization and translation. */
  withHelperLlm(llm: ILlm): this {
    this._helperLlm = llm;
    return this;
  }

  /** Set the LLM used by the intent classifier. If not set, mainLlm is used. */
  withClassifierLlm(llm: ILlm): this {
    this._classifierLlm = llm;
    return this;
  }

  /** Register a hook called before streaming the final response to the client. */
  withOnBeforeStream(hook: SmartAgentConfig['onBeforeStream']): this {
    this._onBeforeStream = hook;
    return this;
  }

  /**
   * Set RAG stores. The consumer defines the store keys and instances.
   * Stores are merged with previously set stores.
   */
  withRag(stores: SmartAgentRagStores): this {
    this._ragStores = { ...this._ragStores, ...stores };
    return this;
  }

  /**
   * Override MCP clients. When set, auto-connect and tool vectorization
   * are skipped — the caller is responsible for connecting clients.
   */
  withMcpClients(clients: IMcpClient[]): this {
    this._mcpClients = clients;
    return this;
  }

  /** Override the intent classifier. */
  withClassifier(classifier: ISubpromptClassifier): this {
    this._classifier = classifier;
    return this;
  }

  /** Override the context assembler. */
  withAssembler(assembler: IContextAssembler): this {
    this._assembler = assembler;
    return this;
  }

  /** Set a logger for internal pipeline events. */
  withLogger(logger: ILogger): this {
    this._logger = logger;
    return this;
  }

  /** Set a tool execution policy (allow/deny list). */
  withToolPolicy(policy: IToolPolicy): this {
    this._toolPolicy = policy;
    return this;
  }

  /** Set a prompt-injection detector. */
  withInjectionDetector(detector: IPromptInjectionDetector): this {
    this._injectionDetector = detector;
    return this;
  }

  /** Set a tracer for pipeline span instrumentation. */
  withTracer(tracer: ITracer): this {
    this._tracer = tracer;
    return this;
  }

  /** Set a metrics collector for pipeline instrumentation. */
  withMetrics(metrics: IMetrics): this {
    this._metrics = metrics;
    return this;
  }

  /** Set a reranker to re-score RAG results before context assembly. */
  withReranker(reranker: IReranker): this {
    this._reranker = reranker;
    return this;
  }

  /** Set a query expander to broaden RAG queries with synonyms/related terms. */
  withQueryExpander(expander: IQueryExpander): this {
    this._queryExpander = expander;
    return this;
  }

  /** Set a tool result cache for MCP call deduplication. */
  withToolCache(cache: IToolCache): this {
    this._toolCache = cache;
    return this;
  }

  /** Set an output validator for post-LLM response validation. */
  withOutputValidator(validator: IOutputValidator): this {
    this._outputValidator = validator;
    return this;
  }

  /** Set a session manager for multi-turn token budget tracking. */
  withSessionManager(manager: ISessionManager): this {
    this._sessionManager = manager;
    return this;
  }

  /** Set a skill manager for discovering and loading agent skills. */
  withSkillManager(manager: ISkillManager): this {
    this._skillManager = manager;
    return this;
  }

  /** Register a client adapter for auto-detecting prompt-based clients. */
  withClientAdapter(adapter: IClientAdapter): this {
    this._clientAdapters.push(adapter);
    return this;
  }

  /** Register an API adapter. When called multiple times with the same name, the last one wins. */
  withApiAdapter(adapter: ILlmApiAdapter): this {
    this._apiAdapters.set(adapter.name, adapter);
    return this;
  }

  /** Enable circuit breakers for LLM and embedder calls. */
  withCircuitBreaker(config: CircuitBreakerConfig = {}): this {
    this._circuitBreakerConfig = config;
    return this;
  }

  /** Set the shared embedder for RAG queries. When set, queries embed once and share the vector. */
  withEmbedder(embedder: IEmbedder): this {
    this._embedder = embedder;
    return this;
  }

  /** Set a request logger for per-model usage tracking. */
  withRequestLogger(logger: IRequestLogger): this {
    this._requestLogger = logger;
    return this;
  }

  /** Set an MCP connection strategy for dynamic client management. */
  withMcpConnectionStrategy(strategy: IMcpConnectionStrategy): this {
    this._connectionStrategy = strategy;
    return this;
  }

  // -------------------------------------------------------------------------
  // Pipeline configuration (SmartAgentConfig parameters)
  // -------------------------------------------------------------------------

  /** Set the execution mode: 'smart' (full pipeline), 'hard' (MCP-only), 'pass' (direct LLM). */
  withMode(mode: 'hard' | 'pass' | 'smart'): this {
    this._agentOverrides.mode = mode;
    return this;
  }

  /** Set the maximum number of tool-loop iterations. */
  withMaxIterations(n: number): this {
    this._agentOverrides.maxIterations = n;
    return this;
  }

  /** Set the maximum number of tool calls per request. */
  withMaxToolCalls(n: number): this {
    this._agentOverrides.maxToolCalls = n;
    return this;
  }

  /** Set the request timeout in milliseconds. */
  withTimeout(ms: number): this {
    this._agentOverrides.timeoutMs = ms;
    return this;
  }

  /** Set the number of RAG results to retrieve per store. */
  withRagQueryK(k: number): this {
    this._agentOverrides.ragQueryK = k;
    return this;
  }

  /** Enable or disable query expansion for RAG queries. */
  withQueryExpansion(enabled: boolean): this {
    this._agentOverrides.queryExpansionEnabled = enabled;
    return this;
  }

  /** Enable or disable reasoning/strategy blocks in the response. */
  withShowReasoning(enabled: boolean): this {
    this._agentOverrides.showReasoning = enabled;
    return this;
  }

  /** Set the SSE heartbeat interval in milliseconds during tool execution. */
  withHeartbeatInterval(ms: number): this {
    this._agentOverrides.heartbeatIntervalMs = ms;
    return this;
  }

  /** Enable or disable the classification pipeline stage. When disabled, input is treated as a single action. */
  withClassification(enabled: boolean): this {
    this._agentOverrides.classificationEnabled = enabled;
    return this;
  }

  /** Set RAG retrieval mode: 'auto' (SAP context), 'always', or 'never'. */
  withRagRetrieval(mode: 'auto' | 'always' | 'never'): this {
    this._agentOverrides.ragRetrievalMode = mode;
    return this;
  }

  /** Enable or disable translation of non-ASCII RAG queries to English. */
  withRagTranslation(enabled: boolean): this {
    this._agentOverrides.ragTranslationEnabled = enabled;
    return this;
  }

  /** Enable or disable upserting classified subprompts to RAG stores. */
  withRagUpsert(enabled: boolean): this {
    this._agentOverrides.ragUpsertEnabled = enabled;
    return this;
  }

  /** Enable per-iteration RAG-based tool re-selection in the tool loop. */
  withToolReselection(enabled: boolean): this {
    this._agentOverrides.toolReselectPerIteration = enabled;
    return this;
  }

  /** Set the history message count threshold for auto-summarization. */
  withHistorySummarization(limit: number): this {
    this._agentOverrides.historyAutoSummarizeLimit = limit;
    return this;
  }

  /** Set the session token budget for multi-turn conversations. */
  withSessionTokenBudget(budget: number): this {
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
   * Explicit `withStageHandler()`, `withReranker()`, etc. calls take
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
  withPluginLoader(loader: IPluginLoader): this {
    this._pluginLoader = loader;
    return this;
  }

  // -------------------------------------------------------------------------
  // Structured pipeline
  // -------------------------------------------------------------------------

  /**
   * Set a structured pipeline definition.
   *
   * When set, SmartAgent uses the {@link PipelineExecutor} to run the
   * defined stages instead of the default hardcoded flow.
   *
   * The pipeline can come from structured YAML or be built programmatically.
   *
   * @example
   * ```ts
   * builder.withPipeline({
   *   version: '1',
   *   stages: [
   *     { id: 'classify', type: 'classify' },
   *     { id: 'assemble', type: 'assemble' },
   *     { id: 'tool-loop', type: 'tool-loop' },
   *   ],
   * });
   * ```
   */
  withPipeline(pipeline: StructuredPipelineDefinition): this {
    this._pipelineDefinition = pipeline;
    return this;
  }

  /**
   * Register a custom stage handler for the structured pipeline.
   *
   * Custom handlers extend the pipeline with domain-specific operations.
   * The handler's `type` name can then be used in YAML stage definitions.
   *
   * @example
   * ```ts
   * builder.withStageHandler('custom-enrich', new MyEnrichHandler());
   * // Then in YAML: { id: 'enrich', type: 'custom-enrich' }
   * ```
   */
  withStageHandler(type: string, handler: IStageHandler): this {
    this._customStageHandlers.set(type, handler);
    return this;
  }

  // -------------------------------------------------------------------------
  // build()
  // -------------------------------------------------------------------------

  async build(): Promise<SmartAgentHandle> {
    const log = this._logger;

    // ---- Validate required dependencies -----------------------------------
    const mainLlm = this._mainLlm;
    if (!mainLlm) {
      throw new Error(
        'Main LLM is required. Call .withMainLlm(llm) before .build().',
      );
    }
    let wrappedMainLlm: ILlm = mainLlm;

    // Classifier defaults to main LLM if not provided
    const classifierLlm: ILlm = this._classifierLlm ?? mainLlm;

    // RAG stores — consumer defines which stores to use
    const ragStores: SmartAgentRagStores = { ...this._ragStores };

    // ---- Circuit breaker wrapping ----------------------------------------
    const circuitBreakers: CircuitBreaker[] = [];
    if (this._circuitBreakerConfig) {
      const cbCfg = this._circuitBreakerConfig;
      const metricsRef = this._metrics;
      const makeOnStateChange =
        (target: string) => (from: string, to: string) => {
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
        ragStores[key] = new FallbackRag(
          store,
          new InMemoryRag(),
          embedderBreaker,
        );
      }
    }

    // ---- MCP clients + tool vectorization --------------------------------
    let mcpClients: IMcpClient[];
    const closeFns: Array<() => Promise<void>> = [];
    const connectionStrategy = this._connectionStrategy;

    if (this._mcpClients) {
      // Caller-provided clients: skip auto-connect and vectorization
      mcpClients = this._mcpClients;
    } else {
      const mcpList = this.cfg.mcp
        ? Array.isArray(this.cfg.mcp)
          ? this.cfg.mcp
          : [this.cfg.mcp]
        : [];
      const connected: IMcpClient[] = [];
      for (const mcpCfg of mcpList) {
        try {
          let wrapper: MCPClientWrapper;
          if (mcpCfg.type === 'stdio') {
            wrapper = new MCPClientWrapper({
              transport: 'stdio',
              command: mcpCfg.command,
              args: mcpCfg.args ?? [],
            });
          } else {
            wrapper = new MCPClientWrapper({
              transport: 'auto',
              url: mcpCfg.url,
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

          // Vectorize tools into the first available RAG store
          const toolStore = ragStores.tools ?? Object.values(ragStores)[0];
          if (toolStore) {
            if (!ragStores.tools && Object.keys(ragStores).length > 1) {
              log?.log({
                type: 'warning',
                traceId: 'builder',
                message:
                  'No "tools" RAG store found, falling back to first available store',
              });
            }
            const toolsResult = await adapter.listTools();
            if (toolsResult.ok) {
              for (const t of toolsResult.value) {
                const result = await toolStore.upsert(
                  `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema)}`,
                  { id: `tool:${t.name}` },
                );
                if (!result.ok) {
                  log?.log({
                    type: 'warning',
                    traceId: 'builder',
                    message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                  });
                }
              }
            }
          }

          connected.push(adapter);
          closeFns.push(() => wrapper.disconnect?.() ?? Promise.resolve());
        } catch {
          // Skip failed MCP connections — agent continues without that server
        }
      }
      mcpClients = connected;
    }

    // ---- SmartAgent Config ------------------------------------------------
    const agentCfg: SmartAgentConfig = {
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
    if (agentCfg.retry) {
      wrappedMainLlm = new RetryLlm(wrappedMainLlm, agentCfg.retry);
    }

    // ---- Request logger ---------------------------------------------------
    const requestLogger = this._requestLogger ?? new DefaultRequestLogger();

    // ---- Classifier -------------------------------------------------------
    const classifierCfg: LlmClassifierConfig = {};
    if (this.cfg.prompts?.classifier)
      classifierCfg.systemPrompt = this.cfg.prompts.classifier;
    const classifier: ISubpromptClassifier =
      this._classifier ??
      new LlmClassifier(classifierLlm, classifierCfg, requestLogger);

    // ---- Assembler --------------------------------------------------------
    const assemblerCfg: ContextAssemblerConfig = {
      maxTokens: agentCfg.contextBudgetTokens ?? 4000,
      showReasoning: agentCfg.showReasoning,
      reasoningInstruction: this.cfg.prompts?.reasoning,
    };
    if (this.cfg.prompts?.system)
      assemblerCfg.systemPromptPreamble = this.cfg.prompts.system;
    const assembler: IContextAssembler =
      this._assembler ?? new ContextAssembler(assemblerCfg);

    // ---- Plugin loader (optional) -------------------------------------------
    let loadedPlugins: import('./plugins/types.js').LoadedPlugins | undefined;
    if (this._pluginLoader) {
      const plugins = await this._pluginLoader.load();
      loadedPlugins = plugins;
      // Plugin registrations act as defaults — explicit withXxx() wins
      for (const [type, handler] of plugins.stageHandlers) {
        if (!this._customStageHandlers.has(type)) {
          this._customStageHandlers.set(type, handler);
        }
      }
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
    const skillStore = ragStores.tools ?? Object.values(ragStores)[0];
    if (this._skillManager && skillStore) {
      const skillsResult = await this._skillManager.listSkills();
      if (skillsResult.ok) {
        for (const s of skillsResult.value) {
          const result = await skillStore.upsert(
            `Skill: ${s.name}\n${s.description}`,
            {
              id: `skill:${s.name}`,
            },
          );
          if (!result.ok) {
            log?.log({
              type: 'warning',
              traceId: 'builder',
              message: `Skill vectorization failed for "${s.name}": ${result.error.message}`,
            });
          }
        }
      }
    }

    // ---- Structured pipeline (optional) ------------------------------------
    let pipelineExecutor: PipelineExecutor | undefined;
    let pipelineStages: StageDefinition[] | undefined;

    if (this._pipelineDefinition) {
      const { buildDefaultHandlerRegistry } = await import(
        './pipeline/handlers/index.js'
      );
      const handlers = buildDefaultHandlerRegistry();
      // Merge custom handlers (override built-ins if same name)
      for (const [type, handler] of this._customStageHandlers) {
        handlers.set(type, handler);
      }
      const tracer =
        this._tracer ??
        new (await import('./tracer/noop-tracer.js')).NoopTracer();
      pipelineExecutor = new PipelineExecutor(handlers, tracer);
      pipelineStages = this._pipelineDefinition.stages;
    }

    const agent = new SmartAgent(
      {
        mainLlm: wrappedMainLlm,
        helperLlm: this._helperLlm,
        mcpClients,
        ragStores,
        classifier,
        assembler,
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
        requestLogger,
      },
      agentCfg,
      pipelineExecutor,
      pipelineStages,
    );

    // ---- Model provider auto-detection ------------------------------------
    let modelProvider: IModelProvider | undefined = this._modelProvider;
    if (!modelProvider) {
      const candidate = mainLlm;
      if (isModelProvider(candidate)) {
        modelProvider = candidate;
      }
    }

    // ---- API adapters: merge plugin adapters → builder adapters (builder wins) ---
    // plugins.apiAdapters does not exist yet (added in Task 4); safe future-compat check.
    const apiAdapters = new Map<string, ILlmApiAdapter>();
    const pluginApiAdapters = (
      loadedPlugins as { apiAdapters?: Map<string, ILlmApiAdapter> } | undefined
    )?.apiAdapters;
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
      chat: (messages, tools, options) =>
        wrappedMainLlm.chat(messages, tools, options),
      streamChat: (messages, tools, options) =>
        wrappedMainLlm.streamChat(messages, tools, options),
      requestLogger,
      close: async () => {
        await connectionStrategy?.dispose?.();
        for (const fn of closeFns) await fn();
      },
      circuitBreakers,
      ragStores,
      modelProvider,
      getApiAdapter: (name: string) => apiAdapters.get(name),
      listApiAdapters: () => [...apiAdapters.keys()],
    };
  }
}
