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
 *     .withRag({ facts: myRag, feedback: myRag, state: myRag })
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
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import type { TokenUsage } from './llm/token-counting-llm.js';
import type { ILogger } from './logger/types.js';
import type { IMetrics } from './metrics/types.js';
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
  /**
   * Returns accumulated LLM token usage (prompt + completion + total + requests).
   * Returns zeroes if usage tracking is not available on the injected LLM.
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

  // All components injected via fluent setters
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
  private _getUsage?: () => TokenUsage;

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

  /**
   * Set individual RAG stores. Unspecified stores default to InMemoryRag.
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

  /** Set a custom token usage provider. */
  withUsageProvider(getUsage: () => TokenUsage): this {
    this._getUsage = getUsage;
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

    // RAG stores default to InMemoryRag if not provided
    let factsRag: IRag = this._ragStores?.facts ?? new InMemoryRag();
    let feedbackRag: IRag = this._ragStores?.feedback ?? new InMemoryRag();
    let stateRag: IRag = this._ragStores?.state ?? new InMemoryRag();

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
        mainLlm: wrappedMainLlm,
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

    const zeroUsage: TokenUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      requests: 0,
    };

    return {
      agent,
      chat: (messages, tools, options) =>
        wrappedMainLlm.chat(messages, tools, options),
      streamChat: (messages, tools, options) =>
        wrappedMainLlm.streamChat(messages, tools, options),
      getUsage: this._getUsage ?? (() => zeroUsage),
      close: async () => {
        for (const fn of closeFns) await fn();
      },
      circuitBreakers,
      ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
    };
  }
}
