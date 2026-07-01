import { randomUUID } from 'node:crypto';
import type {
  CallOptions,
  IClientAdapter,
  IContextAssembler,
  IEmbedder,
  IHistoryMemory,
  IHistorySummarizer,
  ILlm,
  ILlmCallStrategy,
  IMcpClient,
  IRag,
  IRagProviderRegistry,
  IRagRegistry,
  IRequestLogger,
  ISkillManager,
  ISubpromptClassifier,
  IToolCache,
  LlmFinishReason,
  LlmStreamChunk,
  LlmTool,
  McpTool,
  Message,
  ModelUsageEntry,
  RagResult,
  Result,
  StreamHookContext,
  Subprompt,
  TimingEntry,
} from '@mcp-abap-adt/llm-agent';
import {
  type AgentCallOptions,
  getStreamToolCallName,
  type IQueryExpander,
  isReadinessReporter,
  NoopQueryExpander,
  NoopToolCache,
  normalizeExternalTools,
  OrchestratorError,
  QueryEmbedding,
  type SmartAgentResponse,
  type StopReason,
  StreamingLlmCallStrategy,
  TextOnlyEmbedding,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from './adapters/usage-logging-embedder.js';
import { RagOrchestrator } from './agent/rag-orchestrator.js';
import { normalizeRequestOptions } from './agent-request-options.js';
import type { LlmClassifierConfig } from './classifier/llm-classifier.js';
import { LlmClassifier } from './classifier/llm-classifier.js';
import { buildAgentHealthSnapshot } from './health/agent-health.js';
import type { IMcpConnectionStrategy } from './interfaces/mcp-connection-strategy.js';

export {
  type AgentCallOptions,
  OrchestratorError,
  type SmartAgentResponse,
  type StopReason,
} from '@mcp-abap-adt/llm-agent';

import type { IPipeline } from './interfaces/pipeline.js';
import type { ILogger } from './logger/index.js';
import { NoopRequestLogger } from './logger/noop-request-logger.js';
import { summaryToUsage } from './logger/session-request-logger.js';
import { type IMcpToolRegistry, McpToolRegistry } from './mcp/tool-registry.js';
import { NoopMetrics } from './metrics/noop-metrics.js';
import type { IMetrics } from './metrics/types.js';
import { classifyToolResult } from './pipeline/handlers/escalate-if-unavailable.js';
import { runPassThrough } from './pipeline/handlers/pass-through.js';
import {
  buildBlockedToolMessages,
  buildHallucinatedToolMessages,
  classifyToolCalls,
  filterAvailableTools,
  injectPendingResults,
  injectToolPriority,
} from './pipeline/handlers/tool-loop-core.js';
import { pipelineToStream } from './pipeline/pipeline-to-stream.js';
import { fireInternalToolsAsync } from './policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from './policy/pending-tool-results-registry.js';
import {
  isToolContextUnavailableError,
  ToolAvailabilityRegistry,
} from './policy/tool-availability-registry.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';
import { NoopReranker } from './reranker/noop-reranker.js';
import type { IReranker } from './reranker/types.js';
import { NoopSessionManager } from './session/noop-session-manager.js';
import type { ISessionManager } from './session/types.js';
import { NoopTracer } from './tracer/noop-tracer.js';
import type { ISpan, ITracer } from './tracer/types.js';
import { NoopValidator } from './validator/noop-validator.js';
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

  // -- Pipeline stage toggles -----------------------------------------------

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
  onBeforeStream?: (
    content: string,
    ctx: StreamHookContext,
  ) => AsyncIterable<string>;
}
function mergeSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortController {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl;
}

function createTimeoutSignal(ms: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('Timeout')), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

export interface SmartAgentReconfigureOptions {
  mainLlm?: ILlm;
  classifierLlm?: ILlm;
  helperLlm?: ILlm;
}

export class SmartAgent {
  private readonly toolAvailabilityRegistry: ToolAvailabilityRegistry;
  private readonly tracer: ITracer;
  private readonly metrics: IMetrics;
  private readonly reranker: IReranker;
  private readonly queryExpander: IQueryExpander;
  private readonly toolCache: IToolCache;
  private readonly outputValidator: IOutputValidator;
  private readonly sessionManager: ISessionManager;
  private readonly pendingToolResults: PendingToolResultsRegistry;
  private readonly requestLogger: IRequestLogger;
  private readonly defaultLlmCallStrategy: ILlmCallStrategy;
  private readonly mcpToolRegistry: IMcpToolRegistry;
  private _mainLlm: ILlm;
  private _classifierLlm: ILlm | undefined;
  private _helperLlm: ILlm | undefined;
  private _classifier: ISubpromptClassifier;

  constructor(
    private readonly deps: SmartAgentDeps,
    private config: SmartAgentConfig,
  ) {
    this.toolAvailabilityRegistry = new ToolAvailabilityRegistry(
      this.config.toolUnavailableTtlMs,
    );
    this.tracer = deps.tracer ?? new NoopTracer();
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.reranker = deps.reranker ?? new NoopReranker();
    this.queryExpander = deps.queryExpander ?? new NoopQueryExpander();
    this.toolCache = deps.toolCache ?? new NoopToolCache();
    this.outputValidator = deps.outputValidator ?? new NoopValidator();
    this.sessionManager = deps.sessionManager ?? new NoopSessionManager();
    this.pendingToolResults = new PendingToolResultsRegistry();
    this.requestLogger = deps.requestLogger ?? new NoopRequestLogger();
    // Meter embedding usage even for direct `new SmartAgent(deps)` construction
    // (the builder/resolveAgentEmbedder also wrap; wrapEmbedder is idempotent).
    if (deps.embedder) deps.embedder = wrapEmbedder(deps.embedder);
    this.defaultLlmCallStrategy =
      deps.llmCallStrategy ?? new StreamingLlmCallStrategy();
    this.mcpToolRegistry = new McpToolRegistry(
      deps.mcpClients,
      deps.connectionStrategy,
      deps.ragStores,
    );
    this._mainLlm = deps.mainLlm;
    this._helperLlm = deps.helperLlm;
    this._classifier = deps.classifier;
    this._classifierLlm = deps.classifierLlm;
  }

  /** Current main LLM instance. Use this for direct LLM calls that should respect hot-swap. */
  get currentMainLlm(): ILlm {
    return this._mainLlm;
  }

  /** Apply a partial config update at runtime (hot-reload). */
  applyConfigUpdate(update: Partial<SmartAgentConfig>): void {
    this.config = { ...this.config, ...update };
  }

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
  reconfigure(update: SmartAgentReconfigureOptions): void {
    if (update.mainLlm) {
      this._mainLlm = update.mainLlm;
    }
    if (update.helperLlm) {
      this._helperLlm = update.helperLlm;
    }
    if (update.classifierLlm) {
      this._classifierLlm = update.classifierLlm;
      this._classifier = new LlmClassifier(
        update.classifierLlm,
        this.deps.classifierConfig,
        this.requestLogger,
      );
    }
    // Propagate the swap into the structured pipeline (when configured via the
    // Builder). The pipeline keeps its own deps snapshot and derives the usage
    // `byModel` key from `ctx.mainLlm.model`; without this, post-swap requests
    // would keep being logged under the INITIAL model (issue #164).
    this.deps.pipeline?.reconfigure?.({
      mainLlm: update.mainLlm,
      helperLlm: update.helperLlm,
      classifierLlm: update.classifierLlm,
    });
  }

  /**
   * Add a custom RAG store at runtime. Takes effect on the next request.
   * Built-in store names ('tools', 'history') cannot be overwritten.
   *
   * @param options.translateQuery — when true, the pipeline translates the
   *   query to English before searching this store (useful for stores with
   *   English-only content like MCP tool descriptions).
   */
  addRagStore(
    name: string,
    store: IRag,
    options?: { translateQuery?: boolean },
  ): void {
    if (name === 'tools' || name === 'history') {
      throw new Error(
        `Cannot overwrite built-in RAG store "${name}" via addRagStore()`,
      );
    }
    if (this.deps.ragRegistry) {
      // Route through registry so the ragStores projection (and any listeners)
      // see the change.
      if (this.deps.ragRegistry.get(name)) {
        this.deps.ragRegistry.unregister(name);
      }
      this.deps.ragRegistry.register(name, store, undefined, {
        displayName: name,
        scope: 'global',
      });
    } else {
      // Fallback for consumers that built SmartAgentDeps without a registry.
      this.deps.ragStores[name] = store;
    }
    if (options?.translateQuery) {
      if (!this.deps.translateQueryStores) {
        this.deps.translateQueryStores = new Set();
      }
      this.deps.translateQueryStores.add(name);
    }
    this.deps.pipeline?.rebuildStages?.();
  }

  /**
   * Remove a custom RAG store at runtime. Takes effect on the next request.
   * Built-in store names ('tools', 'history') cannot be removed.
   */
  removeRagStore(name: string): void {
    if (name === 'tools' || name === 'history') {
      throw new Error(
        `Cannot remove built-in RAG store "${name}" via removeRagStore()`,
      );
    }
    if (this.deps.ragRegistry) {
      this.deps.ragRegistry.unregister(name);
    } else {
      delete this.deps.ragStores[name];
    }
    this.deps.translateQueryStores?.delete(name);
    this.deps.pipeline?.rebuildStages?.();
  }

  /**
   * Close a session: remove session-scoped RAG collections for the given
   * sessionId and flush session-scoped history memory.
   * Errors from registry cleanup are logged but not thrown — best-effort.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (this.deps.ragRegistry) {
      const res = await this.deps.ragRegistry.closeSession(sessionId);
      if (!res.ok) {
        this.deps.logger?.log({
          type: 'warning',
          traceId: 'close_session',
          message: `closeSession(${sessionId}) failed: ${res.error.message}`,
        });
      }
    }
    this.deps.historyMemory?.clear(sessionId);
  }

  /** Returns the model identifiers of the currently active LLM instances. */
  getActiveConfig(): {
    mainModel?: string;
    classifierModel?: string;
    helperModel?: string;
  } {
    return {
      mainModel: this._mainLlm.model,
      classifierModel: this._classifierLlm?.model,
      helperModel: this._helperLlm?.model,
    };
  }

  /** Returns whitelisted runtime-safe agent config fields (for HTTP DTO). */
  getAgentConfig(): {
    maxIterations: number;
    maxToolCalls?: number;
    ragQueryK?: number;
    toolUnavailableTtlMs?: number;
    showReasoning?: boolean;
    historyAutoSummarizeLimit?: number;
    classificationEnabled?: boolean;
  } {
    return {
      maxIterations: this.config.maxIterations,
      maxToolCalls: this.config.maxToolCalls,
      ragQueryK: this.config.ragQueryK,
      toolUnavailableTtlMs: this.config.toolUnavailableTtlMs,
      showReasoning: this.config.showReasoning,
      historyAutoSummarizeLimit: this.config.historyAutoSummarizeLimit,
      classificationEnabled: this.config.classificationEnabled,
    };
  }

  /**
   * Readiness (implements `IReadinessReporter`): delegate to the MCP connection
   * strategy when it reports readiness, else `true` (no strategy / non-reporting ⇒
   * readiness unknown → ready). Consumers (e.g. a server's `/health` + request
   * gate) detect this via `isReadinessReporter(agent)` — no growth of `ISmartAgent`.
   */
  isReady(): boolean {
    const strategy = this.deps.connectionStrategy;
    return isReadinessReporter(strategy) ? strategy.isReady() : true;
  }

  async healthCheck(options?: CallOptions): Promise<
    Result<
      {
        llm: boolean;
        rag: boolean;
        mcp: { name: string; ok: boolean; error?: string }[];
      },
      OrchestratorError
    >
  > {
    const HEALTH_TIMEOUT_MS = this.config.healthTimeoutMs ?? 5_000;
    const { signal: timeoutSignal, clear: clearTimeout_ } =
      createTimeoutSignal(HEALTH_TIMEOUT_MS);
    const merged = mergeSignals(timeoutSignal, options?.signal);
    const healthOptions: CallOptions = {
      ...options,
      signal: merged.signal,
      maxTokens: 1,
    };

    try {
      const snapshot = await buildAgentHealthSnapshot(
        this._mainLlm,
        this.deps.ragStores,
        this.mcpToolRegistry.getActiveClients(),
        healthOptions,
      );
      return { ok: true, value: snapshot };
    } finally {
      clearTimeout_();
    }
  }

  async process(
    textOrMessages: string | Message[],
    options?: AgentCallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    let content = '';
    const totalUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      models?: Record<string, ModelUsageEntry>;
    } = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let stopReason: StopReason = 'stop';
    const collectedToolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    // Map streaming index → position in collectedToolCalls for delta correlation
    const indexToPosition = new Map<number, number>();
    for await (const chunk of this.streamProcess(textOrMessages, options)) {
      if (!chunk.ok) return chunk;
      if (chunk.value.content && !chunk.value.ephemeral)
        content += chunk.value.content;
      if (chunk.value.toolCalls) {
        for (const tc of chunk.value.toolCalls) {
          const delta = toToolCallDelta(tc, collectedToolCalls.length);
          // Try to find existing entry by index first (streaming deltas),
          // then by id (non-streaming / first delta with id).
          const posByIndex = indexToPosition.get(delta.index);
          const existing =
            posByIndex !== undefined
              ? collectedToolCalls[posByIndex]
              : delta.id
                ? collectedToolCalls.find((c) => c.id === delta.id)
                : undefined;
          if (existing) {
            if (delta.arguments) existing.function.arguments += delta.arguments;
          } else if (delta.name) {
            const pos = collectedToolCalls.length;
            collectedToolCalls.push({
              id: delta.id || '',
              type: 'function',
              function: {
                name: delta.name,
                arguments: delta.arguments || '',
              },
            });
            indexToPosition.set(delta.index, pos);
          }
        }
      }
      if (chunk.value.finishReason === 'tool_calls') {
        stopReason = 'tool_calls';
      }
      if (chunk.value.usage) {
        totalUsage.promptTokens += chunk.value.usage.promptTokens;
        totalUsage.completionTokens += chunk.value.usage.completionTokens;
        totalUsage.totalTokens += chunk.value.usage.totalTokens;
        if (chunk.value.usage.models) {
          totalUsage.models = chunk.value.usage.models;
        }
      }
    }
    return {
      ok: true,
      value: {
        content,
        iterations: 1,
        toolCallCount: collectedToolCalls.length,
        stopReason,
        ...(collectedToolCalls.length > 0
          ? { toolCalls: collectedToolCalls }
          : {}),
        usage: totalUsage,
      },
    };
  }

  async *streamProcess(
    textOrMessages: string | Message[],
    options?: AgentCallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (this.config.smartAgentEnabled === false) {
      yield {
        ok: false,
        error: new OrchestratorError('SmartAgent is disabled', 'DISABLED'),
      };
      return;
    }
    this.metrics.requestCount.add();
    const requestStart = Date.now();
    const traceId = options?.trace?.traceId ?? randomUUID();
    const rootSpan = this.tracer.startSpan('smart_agent.process', {
      traceId,
      attributes: { 'smart_agent.mode': this.config.mode || 'smart' },
    });
    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;
    if (this.config.timeoutMs) {
      const { signal, clear } = createTimeoutSignal(this.config.timeoutMs);
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, signal);
      opts = { ...options, signal: merged.signal };
    }
    // Normalize AFTER the timeout-merge (which rebuilds opts from the original
    // options): write the generated traceId into opts.trace and attach the
    // per-request logger, so every downstream logLlmCall is request-scoped and
    // the embedder-boundary wrapper can attribute embedding spend.
    opts = normalizeRequestOptions(opts, traceId, this.requestLogger);

    const mode = this.config.mode || 'smart';

    // Per-request client adapter detection from system prompt
    let detectedAdapter: IClientAdapter | undefined;
    const messages =
      typeof textOrMessages === 'string' ? undefined : textOrMessages;
    if (messages && this.deps.clientAdapters?.length) {
      const systemMsg = messages.find((m) => m.role === 'system');
      if (systemMsg?.content) {
        detectedAdapter = this.deps.clientAdapters.find((a) =>
          a.detect(
            typeof systemMsg.content === 'string' ? systemMsg.content : '',
          ),
        );
      }
    }
    const sessionId = options?.sessionId ?? 'default';
    const externalTools = normalizeExternalTools(options?.externalTools);
    opts?.sessionLogger?.logStep('external_tools_normalized', {
      rawCount: options?.externalTools?.length ?? 0,
      normalizedCount: externalTools.length,
      normalizedNames: externalTools.map((t) => t.name),
    });
    opts?.sessionLogger?.logStep('pipeline_start', { mode, textOrMessages });
    this.requestLogger.startRequest(traceId);

    try {
      if (mode === 'pass') {
        const passMessages: Message[] =
          typeof textOrMessages === 'string'
            ? [{ role: 'user' as const, content: textOrMessages }]
            : textOrMessages;
        opts?.sessionLogger?.logStep('client_request', { textOrMessages });
        for await (const chunk of runPassThrough(
          this._mainLlm,
          this.requestLogger,
          passMessages,
          externalTools,
          opts,
        )) {
          yield chunk;
        }
        rootSpan.setStatus('ok');
        rootSpan.end();
        return;
      }

      // Pipeline path (when configured via Builder)
      if (this.deps.pipeline) {
        const stream = pipelineToStream(
          this.deps.pipeline,
          textOrMessages,
          externalTools,
          opts,
        );
        for await (const chunk of stream) yield chunk;
        rootSpan.setStatus('ok');
        rootSpan.end();
        return;
      }

      // Default hardcoded flow: RAG fan-out + context assembly. The orchestrator
      // is constructed PER REQUEST so it reads the LIVE _mainLlm/_helperLlm/
      // _classifier (hot-swap via reconfigure() keeps working — see issue #164).
      const orchestrator = new RagOrchestrator({
        mainLlm: this._mainLlm,
        helperLlm: this._helperLlm,
        classifier: this._classifier,
        config: this.config,
        tracer: this.tracer,
        metrics: this.metrics,
        reranker: this.reranker,
        queryExpander: this.queryExpander,
        sessionManager: this.sessionManager,
        toolAvailabilityRegistry: this.toolAvailabilityRegistry,
        mcpToolRegistry: this.mcpToolRegistry,
        requestLogger: this.requestLogger,
        ragStores: this.deps.ragStores,
        embedder: this.deps.embedder,
        assembler: this.deps.assembler,
        skillManager: this.deps.skillManager,
        translateQueryStores: this.deps.translateQueryStores,
      });
      const orchResult = await orchestrator.orchestrate(textOrMessages, {
        opts,
        rootSpan,
        sessionId,
        mode,
        externalTools,
      });
      if (!orchResult.ok) {
        rootSpan.setStatus('error', orchResult.error.message);
        rootSpan.end();
        yield orchResult;
        return;
      }
      // skillContent is NOT destructured — the caller doesn't use it; it is
      // already baked into assembledMessages inside orchestrate(). Destructuring
      // it unused would trip noUnusedLocals.
      const {
        retrieved,
        finalTools,
        assembledMessages,
        mainAction,
        toolClientMap,
      } = orchResult.value;

      // 4. Single Streaming Loop
      const stream = this._runStreamingToolLoop(
        mainAction,
        retrieved,
        assembledMessages,
        toolClientMap,
        opts,
        rootSpan,
        sessionId,
        externalTools,
        finalTools,
        detectedAdapter,
      );
      for await (const chunk of stream) yield chunk;
      rootSpan.setStatus('ok');
    } finally {
      this.requestLogger.endRequest(traceId);
      rootSpan.end();
      timeoutCleanup?.();
      this.metrics.requestLatency.record(Date.now() - requestStart);
    }
  }

  private async *_runStreamingToolLoop(
    _action: Subprompt,
    _retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
    },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
    parentSpan: ISpan,
    sessionId: string,
    externalTools: LlmTool[],
    activeTools: LlmTool[],
    clientAdapter?: IClientAdapter,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    const toolLoopSpan = this.tracer.startSpan('smart_agent.tool_loop', {
      parent: parentSpan,
    });
    let toolCallCount = 0;
    let messages = initialMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const externalToolNames = new Set(externalTools.map((t) => t.name));
    const timingLog: TimingEntry[] = [];
    const loopStart = Date.now();
    let currentTools = activeTools;

    messages = injectToolPriority(messages, externalTools);
    messages = await injectPendingResults(
      messages,
      this.pendingToolResults,
      sessionId,
      opts,
    );

    for (let iteration = 0; ; iteration++) {
      let iterationBuffer = '';
      if (opts?.signal?.aborted) {
        toolLoopSpan.setStatus('error', 'Aborted');
        toolLoopSpan.end();
        yield { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
        return;
      }
      if (iteration >= this.config.maxIterations) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.addEvent('iteration_limit_reached');
        toolLoopSpan.end();
        {
          const summary = this.requestLogger.getSummary(opts?.trace?.traceId);
          yield {
            ok: true,
            value: {
              content: '',
              finishReason: 'length',
              usage: {
                ...summaryToUsage(summary),
                models: summary.byModel,
              },
              timing: timingLog,
            },
          };
        }
        return;
      }
      // Refresh MCP tools on each iteration (when enabled)
      if (iteration > 0 && this.config.refreshToolsPerIteration !== false) {
        const refreshSpan = this.tracer.startSpan('smart_agent.refresh_tools', {
          parent: toolLoopSpan,
          attributes: { 'llm.iteration': iteration + 1 },
        });
        const refreshed = await this.mcpToolRegistry.resolve(opts);
        const prevNames = [...toolClientMap.keys()];
        toolClientMap.clear();
        for (const [name, client] of refreshed.toolClientMap) {
          toolClientMap.set(name, client);
        }
        currentTools = [...(refreshed.tools as LlmTool[]), ...externalTools];
        opts?.sessionLogger?.logStep('tools_refreshed', {
          iteration: iteration + 1,
          previous: prevNames,
          current: currentTools.map((t) => t.name),
        });
        refreshSpan.end();
      }

      // Per-iteration RAG tool re-selection (when enabled)
      if (
        iteration > 0 &&
        this.config.toolReselectPerIteration &&
        this.deps.ragStores?.tools
      ) {
        const reselectSpan = this.tracer.startSpan(
          'smart_agent.tool_reselect',
          {
            parent: toolLoopSpan,
            attributes: { 'llm.iteration': iteration + 1 },
          },
        );

        try {
          // Extract last tool calls
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.role === 'assistant');
          const toolCallNames: string[] = [];
          if (lastAssistant && 'tool_calls' in lastAssistant) {
            const tcs = lastAssistant.tool_calls;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                const name = tc?.function?.name || '';
                if (name) toolCallNames.push(name);
              }
            }
          }

          // Skip for read-only tools — they rarely need different tools on retry
          const readOnlyPrefixes = [
            'Search',
            'Read',
            'Get',
            'List',
            'Describe',
          ];
          const allReadOnly =
            toolCallNames.length > 0 &&
            toolCallNames.every((n) =>
              readOnlyPrefixes.some((p) => n.startsWith(p)),
            );

          if (!allReadOnly) {
            // Build context-aware query from error/result context
            const lastToolMsg = [...messages]
              .reverse()
              .find((m) => m.role === 'tool');
            const toolResult =
              typeof lastToolMsg?.content === 'string'
                ? lastToolMsg.content.slice(0, 200)
                : '';
            const isError =
              toolResult.toLowerCase().includes('error') ||
              toolResult.toLowerCase().includes('already exist') ||
              toolResult.toLowerCase().includes('failed');

            const inputText = _action.text;
            let reSelectQuery: string;
            if (toolCallNames.length > 0 && isError) {
              const updateHints = toolCallNames
                .filter((n) => n.startsWith('Create'))
                .map((n) => n.replace(/^Create/, 'Update'))
                .join(', ');
              const hints = updateHints ? ` Need ${updateHints}.` : '';
              reSelectQuery = `${toolCallNames.join(', ')} failed: ${toolResult.slice(0, 150)}.${hints} ${inputText.slice(0, 200)}`;
            } else if (toolCallNames.length > 0) {
              reSelectQuery = `After ${toolCallNames.join(', ')}: ${toolResult}\n${inputText.slice(0, 200)}`;
            } else {
              reSelectQuery = inputText;
            }

            // Query tools RAG
            const embedding = this.deps.embedder
              ? new QueryEmbedding(reSelectQuery, this.deps.embedder, opts)
              : new TextOnlyEmbedding(reSelectQuery);

            const ragK = this.config.ragQueryK ?? 20;
            const ragResult = await this.deps.ragStores.tools.query(
              embedding,
              ragK,
              opts,
            );

            if (ragResult.ok && ragResult.value.length > 0) {
              const newToolNames = new Set(
                ragResult.value
                  .map((r) => (r.metadata?.id as string) || '')
                  .filter((id) => id.startsWith('tool:'))
                  .map((id) => id.slice(5).replace(/:.*$/, '')),
              );

              if (newToolNames.size > 0) {
                const refreshed = await this.mcpToolRegistry.resolve(opts);
                const newMcpTools = refreshed.tools.filter((t) =>
                  newToolNames.has(t.name),
                );
                currentTools = [
                  ...(newMcpTools as LlmTool[]),
                  ...externalTools,
                ];

                opts?.sessionLogger?.logStep('tools_reselected', {
                  iteration: iteration + 1,
                  query: reSelectQuery.slice(0, 100),
                  previousTools: toolCallNames,
                  newTools: [...newToolNames],
                });
              }
            }
          } else {
            opts?.sessionLogger?.logStep('tools_reselect_skipped', {
              iteration: iteration + 1,
              reason: 'read-only tools only',
              tools: toolCallNames,
            });
          }
        } finally {
          reselectSpan.end();
        }
      }

      currentTools = filterAvailableTools(
        this.toolAvailabilityRegistry,
        sessionId,
        currentTools,
        iteration,
        opts,
      );
      opts?.sessionLogger?.logStep(`llm_request_iter_${iteration + 1}`, {
        messages,
        tools: currentTools,
      });
      const llmSpan = this.tracer.startSpan('smart_agent.llm_call', {
        parent: toolLoopSpan,
        attributes: { 'llm.iteration': iteration + 1 },
      });
      this.metrics.llmCallCount.add();
      const llmCallStart = Date.now();
      const stream = this.defaultLlmCallStrategy.call(
        this._mainLlm,
        messages,
        currentTools,
        opts,
      );
      let content = '';
      let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      // Track which streaming indices belong to external tools so that
      // argument-only continuation deltas (no name field) are forwarded too.
      const externalToolIndices = new Set<number>();
      for await (const chunkResult of stream) {
        if (!chunkResult.ok) {
          llmSpan.setStatus('error', chunkResult.error.message);
          llmSpan.end();
          toolLoopSpan.setStatus('error', chunkResult.error.message);
          toolLoopSpan.end();
          yield {
            ok: false,
            error: new OrchestratorError(
              chunkResult.error.message,
              'LLM_ERROR',
            ),
          };
          return;
        }
        const chunk = chunkResult.value;
        // Mid-stream retry: discard accumulated state and restart accumulation
        if (chunk.reset) {
          content = '';
          iterationBuffer = '';
          toolCallsMap.clear();
          externalToolIndices.clear();
          finishReason = undefined;
          continue;
        }
        if (chunk.content) {
          content += chunk.content;
          // When a client adapter is detected, buffer content — it will be wrapped after the stream completes
          if (!clientAdapter) {
            if (this.config.streamMode === 'final') {
              iterationBuffer += chunk.content;
            } else {
              yield { ok: true, value: { content: chunk.content } };
            }
          }
        }
        if (chunk.toolCalls) {
          // Register newly seen external tool indices
          for (const tc of chunk.toolCalls) {
            const name = getStreamToolCallName(tc);
            if (name && externalToolNames.has(name)) {
              const delta = toToolCallDelta(tc, 0);
              externalToolIndices.add(delta.index);
            }
          }
          const externalDeltas = chunk.toolCalls.filter((tc) => {
            const delta = toToolCallDelta(tc, 0);
            return externalToolIndices.has(delta.index);
          });
          if (externalDeltas.length > 0) {
            yield {
              ok: true,
              value: { content: '', toolCalls: externalDeltas },
            };
          }
          for (const [
            fallbackIndex,
            rawToolCall,
          ] of chunk.toolCalls.entries()) {
            const tc = toToolCallDelta(rawToolCall, fallbackIndex);
            if (!toolCallsMap.has(tc.index)) {
              toolCallsMap.set(tc.index, {
                id: tc.id || '',
                name: tc.name || '',
                arguments: tc.arguments || '',
              });
            } else {
              const ex = toolCallsMap.get(tc.index);
              if (ex) {
                if (tc.id) ex.id = tc.id;
                if (tc.name) ex.name = tc.name;
                if (tc.arguments) ex.arguments += tc.arguments;
              }
            }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) {
          usage.promptTokens += chunk.usage.promptTokens;
          usage.completionTokens += chunk.usage.completionTokens;
          usage.totalTokens += chunk.usage.totalTokens;
          this.sessionManager.addTokens(chunk.usage.totalTokens);
        }
      }
      llmSpan.setStatus('ok');
      llmSpan.end();
      const llmCallDuration = Date.now() - llmCallStart;
      this.metrics.llmCallLatency.record(llmCallDuration);
      timingLog.push({
        phase: `llm_call_${iteration + 1}`,
        duration: llmCallDuration,
      });
      // In 'final' mode: yield buffered content only if this is the last iteration
      if (this.config.streamMode === 'final' && iterationBuffer) {
        if (finishReason !== 'tool_calls') {
          // Final iteration — stream the buffered content
          yield { ok: true, value: { content: iterationBuffer } };
        }
        iterationBuffer = '';
      }
      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.name, arguments: args };
      });
      opts?.sessionLogger?.logStep(`llm_response_iter_${iteration + 1}`, {
        content,
        toolCalls,
        finishReason,
      });
      if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
        // Output validation
        const valResult = await this.outputValidator.validate(
          content,
          { messages, tools: currentTools },
          opts,
        );
        if (valResult.ok && !valResult.value.valid) {
          const correction =
            valResult.value.correctedContent ?? valResult.value.reason;
          messages = [
            ...messages,
            { role: 'assistant' as const, content },
            {
              role: 'user' as const,
              content: `Your previous response was rejected by validation: ${correction}. Please try again.`,
            },
          ];
          continue;
        }
        opts?.sessionLogger?.logStep('final_response', { content, usage });

        // onBeforeStream hook — consumer transforms content before streaming
        if (this.config.onBeforeStream) {
          const hookCtx: StreamHookContext = { messages };
          for await (const chunk of this.config.onBeforeStream(
            content,
            hookCtx,
          )) {
            if (clientAdapter) {
              yield {
                ok: true,
                value: { content: clientAdapter.wrapResponse(chunk) },
              };
            } else {
              yield { ok: true, value: { content: chunk } };
            }
          }
        } else if (clientAdapter && content) {
          yield {
            ok: true,
            value: { content: clientAdapter.wrapResponse(content) },
          };
        }

        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.setStatus('ok');
        toolLoopSpan.end();
        const summary = this.requestLogger.getSummary(opts?.trace?.traceId);
        yield {
          ok: true,
          value: {
            content: '',
            finishReason: finishReason || 'stop',
            usage: {
              ...summaryToUsage(summary),
              models: summary.byModel,
            },
            timing: timingLog,
          },
        };
        return;
      }
      const {
        internalCalls,
        validExternalCalls,
        blockedCalls,
        hallucinations,
      } = classifyToolCalls(
        toolCalls,
        toolClientMap,
        externalToolNames,
        this.toolAvailabilityRegistry,
        sessionId,
      );
      if (blockedCalls.length > 0) {
        messages = buildBlockedToolMessages(
          messages,
          content,
          blockedCalls,
          opts,
        );
        continue;
      }
      if (hallucinations.length > 0) {
        messages = buildHallucinatedToolMessages(
          messages,
          content,
          toolCalls,
          hallucinations,
        );
        continue;
      }
      if (validExternalCalls.length > 0) {
        // Mixed calls: fire internal tools async, store pending results
        if (internalCalls.length > 0) {
          fireInternalToolsAsync(
            content,
            internalCalls,
            this.pendingToolResults,
            sessionId,
            {
              toolClientMap,
              toolCache: this.toolCache,
              metrics: this.metrics,
              options: opts,
            },
          );
          opts?.sessionLogger?.logStep('mixed_tool_calls', {
            internal: internalCalls.map((tc) => tc.name),
            external: validExternalCalls.map((tc) => tc.name),
          });
        }

        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.setStatus('ok');
        toolLoopSpan.end();
        {
          const summary = this.requestLogger.getSummary(opts?.trace?.traceId);
          yield {
            ok: true,
            value: {
              content: '',
              finishReason: 'tool_calls',
              usage: {
                ...summaryToUsage(summary),
                models: summary.byModel,
              },
              timing: timingLog,
            },
          };
        }
        return;
      }
      if (content || internalCalls.length > 0)
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: internalCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
      // Truncate batch to remaining budget
      const remaining =
        this.config.maxToolCalls !== undefined
          ? this.config.maxToolCalls - toolCallCount
          : internalCalls.length;
      if (remaining <= 0) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.addEvent('tool_call_limit_reached');
        toolLoopSpan.end();
        {
          const summary = this.requestLogger.getSummary(opts?.trace?.traceId);
          yield {
            ok: true,
            value: {
              content: '',
              finishReason: 'length',
              usage: {
                ...summaryToUsage(summary),
                models: summary.byModel,
              },
              timing: timingLog,
            },
          };
        }
        return;
      }
      const batch = internalCalls.slice(0, remaining);
      const heartbeatMs = this.config.heartbeatIntervalMs ?? 5000;

      // Yield all progress messages before execution
      for (const tc of batch) {
        yield {
          ok: true,
          value: {
            content: `\n\n[SmartAgent: Executing ${tc.name}...]\n`,
            ephemeral: true,
          },
        };
      }

      // Execute all tool calls concurrently with heartbeat
      type ToolExecResult = {
        tc: { id: string; name: string; arguments: Record<string, unknown> };
        text: string;
        res: Result<
          { content: string | Record<string, unknown>; isError?: boolean },
          { message: string }
        > | null;
        duration: number;
      };

      const toolExecPromises = batch.map(
        async (tc): Promise<ToolExecResult> => {
          const toolStart = Date.now();
          opts?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
            arguments: tc.arguments,
          });
          const client = toolClientMap.get(tc.name);
          if (!client) return { tc, text: '', res: null, duration: 0 };
          const toolSpan = this.tracer.startSpan('smart_agent.tool_call', {
            parent: toolLoopSpan,
            attributes: { 'tool.name': tc.name },
          });
          const cached = this.toolCache.get(tc.name, tc.arguments);
          const res = cached
            ? (() => {
                this.metrics.toolCacheHitCount.add();
                toolSpan.setAttribute('cache', 'hit');
                return { ok: true as const, value: cached };
              })()
            : await (async () => {
                const r = await client.callTool(tc.name, tc.arguments, opts);
                if (r.ok) this.toolCache.set(tc.name, tc.arguments, r.value);
                return r;
              })();
          const text = !res.ok
            ? res.error.message
            : typeof res.value.content === 'string'
              ? res.value.content
              : JSON.stringify(res.value.content);
          toolSpan.setStatus(
            res.ok ? 'ok' : 'error',
            res.ok ? undefined : text,
          );
          toolSpan.end();
          return { tc, text, res, duration: Date.now() - toolStart };
        },
      );

      // Race: tool execution vs periodic heartbeat
      const allDone = Promise.all(toolExecPromises);
      const pendingTools = new Set(batch.map((tc) => tc.name));
      const toolStartTime = Date.now();
      let results: ToolExecResult[] = [];
      let settled = false;

      // Mark individual tools as done when they resolve
      for (const [i, p] of toolExecPromises.entries()) {
        p.then(() => pendingTools.delete(batch[i].name));
      }

      while (!settled) {
        const winner = await Promise.race([
          allDone.then((r) => ({ tag: 'done' as const, results: r })),
          new Promise<{ tag: 'tick' }>((resolve) =>
            setTimeout(() => resolve({ tag: 'tick' }), heartbeatMs),
          ),
        ]);
        if (winner.tag === 'done') {
          results = winner.results;
          settled = true;
        } else {
          // Yield heartbeat for each still-pending tool
          for (const tool of pendingTools) {
            yield {
              ok: true,
              value: {
                content: '',
                heartbeat: {
                  tool,
                  elapsed: Date.now() - toolStartTime,
                },
              },
            };
          }
        }
      }

      // Collect per-tool timing into the shared timing log
      for (const r of results) {
        timingLog.push({
          phase: `tool_${r.tc.name}`,
          duration: r.duration,
        });
      }

      // Process results: update availability, metrics, messages
      const toolMessages: Message[] = [];
      for (const { tc, text, res } of results) {
        if (!res) continue;
        // FAIL LOUD on an MCP availability failure (transport down / 403 / timeout
        // after reconnect) — do NOT feed "MCP error" back to the LLM as tool text.
        // Yield an error chunk (not throw) so process() returns ok:false (a real
        // error to the consumer) instead of a silent "(no response)" or an uncaught
        // exception escaping the generator. classifyToolResult is the shared decision.
        const decision = classifyToolResult(res);
        if (decision.escalate) {
          yield {
            ok: false,
            error: new OrchestratorError(
              decision.escalate.message,
              'MCP_UNAVAILABLE',
            ),
          };
          return;
        }
        if (
          !res.ok &&
          isToolContextUnavailableError(text) &&
          !externalToolNames.has(tc.name)
        ) {
          const entry = this.toolAvailabilityRegistry.block(
            sessionId,
            tc.name,
            text,
          );
          currentTools = currentTools.filter((t) => t.name !== tc.name);
          opts?.sessionLogger?.logStep(`tool_blacklisted_${tc.name}`, {
            reason: text,
            blockedUntil: entry.blockedUntil,
          });
        }
        opts?.sessionLogger?.logStep(`mcp_result_${tc.name}`, {
          result: text,
        });
        toolCallCount++;
        this.metrics.toolCallCount.add();
        toolMessages.push({
          role: 'tool' as const,
          content: text,
          tool_call_id: tc.id,
        });
      }
      messages = [...messages, ...toolMessages];
    }
  }
}
