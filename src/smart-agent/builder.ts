/**
 * SmartAgentBuilder — fluent builder for SmartAgent.
 *
 * Wires together default implementations (DeepSeek LLM, Ollama/InMemory RAG,
 * MCP via HTTP or stdio) and allows overriding any component with a custom
 * implementation that satisfies the corresponding interface.
 *
 * Usage — all defaults:
 *   const { agent, getUsage, close } = await new SmartAgentBuilder({ llm: { apiKey } }).build();
 *
 * Usage — swap RAG and logger:
 *   const handle = await new SmartAgentBuilder({ llm: { apiKey } })
 *     .withRag({ facts: myRag, feedback: myRag, state: myRag })
 *     .withLogger(myLogger)
 *     .build();
 */

import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { DeepSeekProvider } from '../llm-providers/deepseek.js';
import { MCPClientWrapper } from '../mcp/client.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
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
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { EmbedderFactory, IEmbedder, IRag } from './interfaces/rag.js';
import { TokenCountingLlm, type TokenUsage } from './llm/token-counting-llm.js';
import type { ILogger } from './logger/types.js';
import type { IMetrics } from './metrics/types.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';
import { builtInEmbedderFactories } from './rag/embedder-factories.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { OllamaRag } from './rag/ollama-rag.js';
import { QdrantRag } from './rag/qdrant-rag.js';
import type { IQueryExpander } from './rag/query-expander.js';
import { VectorRag } from './rag/vector-rag.js';
import type { IReranker } from './reranker/types.js';
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
} from './resilience/circuit-breaker.js';
import { CircuitBreakerLlm } from './resilience/circuit-breaker-llm.js';
import { FallbackRag } from './resilience/fallback-rag.js';
import type { ISessionManager } from './session/types.js';
import type { ITracer } from './tracer/types.js';
import type { IOutputValidator } from './validator/types.js';

// ---------------------------------------------------------------------------
// Config types (builder-owned — no dependency on SmartServerConfig)
// ---------------------------------------------------------------------------

export interface BuilderLlmConfig {
  /** DeepSeek API key (required for default LLM) */
  apiKey: string;
  /** Default: 'deepseek-chat' */
  model?: string;
  /** Main LLM temperature. Default: 0.7 */
  temperature?: number;
  /** Classifier LLM temperature. Default: 0.1 */
  classifierTemperature?: number;
}

export interface BuilderRagConfig {
  /** 'ollama' | 'openai' | 'in-memory' | 'qdrant'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant';
  /**
   * Embedder name — resolved from the embedder factory registry.
   * Built-in: 'ollama', 'openai'. Consumers can register custom factories.
   * When omitted, defaults to 'ollama'.
   */
  embedder?: string;
  /** Base URL for embedding service or Qdrant server */
  url?: string;
  /** API key (for openai type or Qdrant auth) */
  apiKey?: string;
  /** Embedding model name */
  model?: string;
  /** Qdrant collection name (required for qdrant type) */
  collectionName?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Per-request timeout for embedding calls in milliseconds. Default: 30 000 */
  timeoutMs?: number;
  /** Semantic similarity weight 0..1. Default: 0.7 */
  vectorWeight?: number;
  /** Lexical matching weight 0..1. Default: 0.3 */
  keywordWeight?: number;
}

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
  /** LLM credentials (required for default LLM factory). */
  llm: BuilderLlmConfig;
  /** RAG store config for default Ollama/InMemory stores. */
  rag?: BuilderRagConfig;
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
  /**
   * Returns accumulated LLM token usage (prompt + completion + total + requests).
   * Only counts calls made through the default DeepSeek LLM.
   * Returns zeroes if both mainLlm and classifierLlm were overridden.
   */
  getUsage(): TokenUsage;
  /** Gracefully close MCP connections. Call on shutdown. */
  close(): Promise<void>;
  /** Circuit breakers (empty when not configured). */
  circuitBreakers: CircuitBreaker[];
  /** RAG stores (for config hot-reload weight updates). */
  ragStores: SmartAgentRagStores;
}

// ---------------------------------------------------------------------------
// SmartAgentBuilder
// ---------------------------------------------------------------------------

export class SmartAgentBuilder {
  private readonly cfg: SmartAgentBuilderConfig;

  // Custom overrides — when set, the corresponding default is not created
  private _mainLlm?: ILlm;
  private _helperLlm?: ILlm;
  private _classifierLlm?: ILlm;
  private _ragStores?: Partial<SmartAgentRagStores>;
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
  private _embedder?: IEmbedder;
  private _embedderFactories: Record<string, EmbedderFactory> = {};

  constructor(cfg: SmartAgentBuilderConfig) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Fluent setters
  // -------------------------------------------------------------------------

  /** Override the main LLM used in the tool loop. */
  withMainLlm(llm: ILlm): this {
    this._mainLlm = llm;
    return this;
  }

  /** Override the helper LLM used for summarization and translation. */
  withHelperLlm(llm: ILlm): this {
    this._helperLlm = llm;
    return this;
  }

  /** Override the LLM used by the intent classifier. */
  withClassifierLlm(llm: ILlm): this {
    this._classifierLlm = llm;
    return this;
  }

  /**
   * Override individual RAG stores. Unspecified stores use the default.
   * Pass the same instance for all three to share a single store.
   */
  withRag(stores: Partial<SmartAgentRagStores>): this {
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

  /** Enable circuit breakers for LLM and embedder calls. */
  withCircuitBreaker(config: CircuitBreakerConfig = {}): this {
    this._circuitBreakerConfig = config;
    return this;
  }

  /**
   * Inject a ready-made IEmbedder used by default RAG stores.
   * Takes precedence over config-driven embedder selection.
   */
  withEmbedder(embedder: IEmbedder): this {
    this._embedder = embedder;
    return this;
  }

  /**
   * Register a named embedder factory for config-driven (YAML) selection.
   * When `rag.embedder` matches `name`, this factory is used to create the embedder.
   */
  withEmbedderFactory(name: string, factory: EmbedderFactory): this {
    this._embedderFactories[name] = factory;
    return this;
  }

  // -------------------------------------------------------------------------
  // build()
  // -------------------------------------------------------------------------

  async build(): Promise<SmartAgentHandle> {
    const log = this._logger;

    // ---- Default LLM factory ---------------------------------------------
    const makeDefaultLlm = (temperature: number): TokenCountingLlm => {
      const provider = new DeepSeekProvider({
        apiKey: this.cfg.llm.apiKey,
        model: this.cfg.llm.model ?? 'deepseek-chat',
        temperature,
      });
      const dummyMcp = new MCPClientWrapper({
        transport: 'embedded',
        listToolsHandler: async () => [],
      });
      const agent = new DeepSeekAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      return new TokenCountingLlm(new LlmAdapter(agent));
    };

    const defaultMainLlm = this._mainLlm
      ? null
      : makeDefaultLlm(this.cfg.llm.temperature ?? 0.7);
    const defaultClassifierLlm = this._classifierLlm
      ? null
      : makeDefaultLlm(this.cfg.llm.classifierTemperature ?? 0.1);

    const mainLlmCandidate = this._mainLlm ?? defaultMainLlm;
    const classifierLlmCandidate = this._classifierLlm ?? defaultClassifierLlm;
    if (!mainLlmCandidate || !classifierLlmCandidate) {
      throw new Error('Failed to initialize default LLM dependencies');
    }
    let mainLlm: ILlm = mainLlmCandidate;
    const classifierLlm: ILlm = classifierLlmCandidate;

    // ---- Embedder resolution ------------------------------------------------
    const resolveEmbedder = (): IEmbedder => {
      if (this._embedder) return this._embedder;
      const r = this.cfg.rag;
      const name = r?.embedder ?? 'ollama';
      const factories = {
        ...builtInEmbedderFactories,
        ...this._embedderFactories,
      };
      const factory = factories[name];
      if (!factory) {
        throw new Error(
          `Unknown embedder "${name}". Register via withEmbedderFactory() or use: ${Object.keys(factories).join(', ')}`,
        );
      }
      return factory({
        url: r?.url,
        apiKey: r?.apiKey,
        model: r?.model,
        timeoutMs: r?.timeoutMs,
      });
    };

    // ---- Default RAG factory ---------------------------------------------
    const makeDefaultRag = (): IRag => {
      const r = this.cfg.rag;
      if (r?.type === 'in-memory') {
        return new InMemoryRag({ dedupThreshold: r.dedupThreshold });
      }
      if (r?.type === 'qdrant') {
        if (!r.url) throw new Error('Qdrant URL is required');
        return new QdrantRag({
          url: r.url,
          collectionName: r.collectionName ?? 'llm-agent',
          embedder: resolveEmbedder(),
          apiKey: r.apiKey,
          timeoutMs: r.timeoutMs,
        });
      }
      // For 'openai' type, resolve via embedder name or fall back to type
      if (r?.type === 'openai') {
        const embedder = resolveEmbedder();
        return new VectorRag(embedder, {
          dedupThreshold: r.dedupThreshold,
          vectorWeight: r.vectorWeight,
          keywordWeight: r.keywordWeight,
        });
      }
      // Default: ollama — use OllamaRag when no custom embedder is set
      if (!this._embedder && !this.cfg.rag?.embedder) {
        return new OllamaRag({
          ollamaUrl: r?.url,
          model: r?.model,
          timeoutMs: r?.timeoutMs,
          dedupThreshold: r?.dedupThreshold,
          vectorWeight: r?.vectorWeight,
          keywordWeight: r?.keywordWeight,
        });
      }
      return new VectorRag(resolveEmbedder(), {
        dedupThreshold: r?.dedupThreshold,
        vectorWeight: r?.vectorWeight,
        keywordWeight: r?.keywordWeight,
      });
    };

    let factsRag: IRag = this._ragStores?.facts ?? makeDefaultRag();
    let feedbackRag: IRag = this._ragStores?.feedback ?? makeDefaultRag();
    let stateRag: IRag = this._ragStores?.state ?? makeDefaultRag();

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
      mainLlm = new CircuitBreakerLlm(mainLlm, llmBreaker);
      circuitBreakers.push(llmBreaker);

      // Wrap RAG stores with FallbackRag using InMemoryRag fallback
      const embedderBreaker = new CircuitBreaker({
        ...cbCfg,
        onStateChange: cbCfg.onStateChange ?? makeOnStateChange('embedder'),
      });
      circuitBreakers.push(embedderBreaker);
      factsRag = new FallbackRag(factsRag, new InMemoryRag(), embedderBreaker);
      feedbackRag = new FallbackRag(
        feedbackRag,
        new InMemoryRag(),
        embedderBreaker,
      );
      stateRag = new FallbackRag(stateRag, new InMemoryRag(), embedderBreaker);
    }

    // ---- MCP clients + tool vectorization --------------------------------
    let mcpClients: IMcpClient[];
    const closeFns: Array<() => Promise<void>> = [];

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

          // Vectorize tools into factsRag for RAG-based tool selection
          const toolsResult = await adapter.listTools();
          if (toolsResult.ok) {
            for (const t of toolsResult.value) {
              await factsRag.upsert(
                `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema)}`,
                { id: `tool:${t.name}` },
              );
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

    // ---- SmartAgent Config (needed for assembler) ------------------------
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
    };

    // ---- Classifier -------------------------------------------------------
    const classifierCfg: LlmClassifierConfig = {};
    if (this.cfg.prompts?.classifier)
      classifierCfg.systemPrompt = this.cfg.prompts.classifier;
    const classifier: ISubpromptClassifier =
      this._classifier ?? new LlmClassifier(classifierLlm, classifierCfg);

    // ---- Assembler --------------------------------------------------------
    const assemblerCfg: ContextAssemblerConfig = {
      showReasoning: agentCfg.showReasoning,
      reasoningInstruction: this.cfg.prompts?.reasoning,
    };
    if (this.cfg.prompts?.system)
      assemblerCfg.systemPromptPreamble = this.cfg.prompts.system;
    const assembler: IContextAssembler =
      this._assembler ?? new ContextAssembler(assemblerCfg);

    const agent = new SmartAgent(
      {
        mainLlm,
        helperLlm: this._helperLlm,
        mcpClients,
        ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
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
      },
      agentCfg,
    );

    return {
      agent,
      chat: (messages, tools, options) =>
        mainLlm.chat(messages, tools, options),
      streamChat: (messages, tools, options) =>
        mainLlm.streamChat(messages, tools, options),
      getUsage: () => {
        const main = defaultMainLlm?.getUsage() ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          requests: 0,
        };
        const classifier = defaultClassifierLlm?.getUsage() ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          requests: 0,
        };
        return {
          prompt_tokens: main.prompt_tokens + classifier.prompt_tokens,
          completion_tokens:
            main.completion_tokens + classifier.completion_tokens,
          total_tokens: main.total_tokens + classifier.total_tokens,
          requests: main.requests + classifier.requests,
        };
      },
      close: async () => {
        for (const fn of closeFns) await fn();
      },
      circuitBreakers,
      ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
    };
  }
}
