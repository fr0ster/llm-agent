/**
 * DefaultPipeline — IPipeline implementation backed by PipelineExecutor + stage handlers.
 *
 * This is the standard pipeline used by SmartAgent when no custom pipeline is
 * configured. It runs a fixed stage sequence:
 *
 * ```text
 * classify → summarize → parallel(rag-query tools, rag-query history, rag-query <custom>…) →
 * rerank → skill-select → tool-select → assemble → tool-loop → history-upsert
 * ```
 *
 * Built-in RAG stores (`tools`, `history`) are wired from `toolsRag`/`historyRag` deps.
 * Additional custom stores can be passed via `ragStores` and are queried in parallel
 * with built-ins. Stores can be added/removed at runtime via `rebuildStages()`.
 */

import type { Message } from '../../types.js';
import type {
  OrchestratorError,
  SmartAgentConfig,
  SmartAgentRagStores,
} from '../agent.js';
import { NoopToolCache } from '../cache/noop-tool-cache.js';
import { LlmClassifier } from '../classifier/llm-classifier.js';
import { ContextAssembler } from '../context/context-assembler.js';
import type {
  CallOptions,
  IPipeline,
  LlmStreamChunk,
  LlmTool,
  PipelineDeps,
  PipelineResult,
  Result,
} from '../interfaces/index.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { StreamingLlmCallStrategy } from '../policy/streaming-llm-call-strategy.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { NoopQueryExpander } from '../rag/query-expander.js';
import { NoopReranker } from '../reranker/noop-reranker.js';
import { NoopSessionManager } from '../session/noop-session-manager.js';
import { NoopTracer } from '../tracer/noop-tracer.js';
import { NoopValidator } from '../validator/noop-validator.js';
import type { PipelineContext } from './context.js';
import { PipelineExecutor } from './executor.js';
import { buildDefaultHandlerRegistry } from './handlers/index.js';
import type { StageDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Default SmartAgentConfig for standalone use
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SmartAgentConfig = {
  maxIterations: 10,
  classificationEnabled: false,
  skillInjectionEnabled: true,
  mode: 'smart',
  ragQueryK: 10,
};

// ---------------------------------------------------------------------------
// DefaultPipeline
// ---------------------------------------------------------------------------

/**
 * Standard IPipeline implementation that orchestrates the default SmartAgent
 * request lifecycle via PipelineExecutor and built-in stage handlers.
 *
 * Usage:
 * ```ts
 * const pipeline = new DefaultPipeline();
 * pipeline.initialize(deps);
 * const result = await pipeline.execute(input, history, options, yieldChunk);
 * ```
 */
export class DefaultPipeline implements IPipeline {
  private deps!: PipelineDeps;
  private executor!: PipelineExecutor;
  private stages!: StageDefinition[];

  // Cached defaults (created once in initialize, reused per request)
  private resolvedTracer!: PipelineContext['tracer'];
  private resolvedClassifier!: PipelineContext['classifier'];
  private resolvedAssembler!: PipelineContext['assembler'];
  private resolvedReranker!: PipelineContext['reranker'];
  private resolvedQueryExpander!: PipelineContext['queryExpander'];
  private resolvedToolCache!: PipelineContext['toolCache'];
  private resolvedOutputValidator!: PipelineContext['outputValidator'];
  private resolvedSessionManager!: PipelineContext['sessionManager'];
  private resolvedMetrics!: PipelineContext['metrics'];
  private resolvedRequestLogger!: PipelineContext['requestLogger'];
  private resolvedLlmCallStrategy!: PipelineContext['llmCallStrategy'];

  // -------------------------------------------------------------------------
  // IPipeline
  // -------------------------------------------------------------------------

  initialize(deps: PipelineDeps): void {
    this.deps = deps;

    // Resolve all optional deps once
    this.resolvedTracer = deps.tracer ?? new NoopTracer();
    this.resolvedClassifier =
      deps.classifier ?? new LlmClassifier(deps.classifierLlm ?? deps.mainLlm);
    this.resolvedAssembler = deps.assembler ?? new ContextAssembler();
    this.resolvedReranker = deps.reranker ?? new NoopReranker();
    this.resolvedQueryExpander = deps.queryExpander ?? new NoopQueryExpander();
    this.resolvedToolCache = deps.toolCache ?? new NoopToolCache();
    this.resolvedOutputValidator = deps.outputValidator ?? new NoopValidator();
    this.resolvedSessionManager =
      deps.sessionManager ?? new NoopSessionManager();
    this.resolvedMetrics = deps.metrics ?? new NoopMetrics();
    this.resolvedRequestLogger = deps.requestLogger ?? new NoopRequestLogger();
    this.resolvedLlmCallStrategy =
      deps.llmCallStrategy ?? new StreamingLlmCallStrategy();

    const registry = buildDefaultHandlerRegistry();
    this.executor = new PipelineExecutor(registry, this.resolvedTracer);

    // Fixed stage list — only tools + history RAG stores
    this.stages = this._buildStages();
  }

  async execute(
    input: string | Message[],
    history: Message[],
    options: CallOptions | undefined,
    yieldChunk: (chunk: Result<LlmStreamChunk, OrchestratorError>) => void,
    externalTools?: LlmTool[],
  ): Promise<PipelineResult> {
    const rootSpan = this.resolvedTracer.startSpan('pipeline.execute');

    const ctx = this._buildContext(
      input,
      history,
      options,
      yieldChunk,
      externalTools,
    );

    try {
      await this.executor.executeStages(this.stages, ctx, rootSpan);
    } catch (err) {
      rootSpan.setStatus('error', String(err));
    } finally {
      rootSpan.end();
    }

    return {
      timing: ctx.timing,
      error: ctx.error,
    };
  }

  rebuildStages(): void {
    this.stages = this._buildStages();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Build the fixed stage list. RAG parallel block only includes stores
   * that were provided in deps.
   */
  private _buildStages(): StageDefinition[] {
    const ragChildren: StageDefinition[] = [];
    if (this.deps.toolsRag) {
      ragChildren.push({
        id: 'rag-tools',
        type: 'rag-query',
        config: { store: 'tools' },
      });
    }
    if (this.deps.historyRag) {
      ragChildren.push({
        id: 'rag-history',
        type: 'rag-query',
        config: { store: 'history', scope: 'session' },
      });
    }

    // Custom stores — appended after built-in, same parallel block
    if (this.deps.ragStores) {
      for (const name of Object.keys(this.deps.ragStores)) {
        if (name === 'tools' || name === 'history') continue;
        ragChildren.push({
          id: `rag-${name}`,
          type: 'rag-query',
          config: { store: name },
        });
      }
    }

    const stages: StageDefinition[] = [
      { id: 'classify', type: 'classify' },
      { id: 'summarize', type: 'summarize' },
    ];

    // Only add rag-retrieval block when there are stores to query
    if (ragChildren.length > 0) {
      // Translate non-ASCII RAG query before retrieval (enabled by default)
      stages.push({
        id: 'translate',
        type: 'translate',
        when: 'config.ragTranslateEnabled != false',
      });
      stages.push({
        id: 'rag-retrieval',
        type: 'parallel',
        stages: ragChildren,
        after: [{ id: 'rerank', type: 'rerank' }],
      });
    }

    stages.push(
      { id: 'skill-select', type: 'skill-select' },
      { id: 'tool-select', type: 'tool-select' },
      { id: 'assemble', type: 'assemble' },
      { id: 'tool-loop', type: 'tool-loop' },
      { id: 'history-upsert', type: 'history-upsert' },
    );

    return stages;
  }

  /**
   * Create a PipelineContext from deps + per-request input.
   * Mirrors the pattern in SmartAgent._runStructuredPipeline().
   */
  private _buildContext(
    input: string | Message[],
    history: Message[],
    options: CallOptions | undefined,
    yieldChunk: (chunk: Result<LlmStreamChunk, OrchestratorError>) => void,
    externalTools?: LlmTool[],
  ): PipelineContext {
    const text =
      typeof input === 'string'
        ? input
        : (input.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '');

    // Build ragStores record — custom stores first, built-ins override by name
    const ragStores: SmartAgentRagStores = {
      ...(this.deps.ragStores ?? {}),
    };
    if (this.deps.toolsRag) ragStores.tools = this.deps.toolsRag;
    if (this.deps.historyRag) ragStores.history = this.deps.historyRag;

    return {
      // Immutable input
      textOrMessages: input,
      options,
      config: { ...DEFAULT_CONFIG, ...this.deps.agentConfig },
      sessionId: options?.sessionId ?? 'default',

      // Dependencies (resolved once in initialize)
      mainLlm: this.deps.mainLlm,
      helperLlm: this.deps.helperLlm,
      classifierLlm: this.deps.classifierLlm ?? this.deps.mainLlm,
      classifier: this.resolvedClassifier,
      assembler: this.resolvedAssembler,
      ragStores,
      mcpClients: this.deps.mcpClients,
      reranker: this.resolvedReranker,
      queryExpander: this.resolvedQueryExpander,
      toolCache: this.resolvedToolCache,
      outputValidator: this.resolvedOutputValidator,
      sessionManager: this.resolvedSessionManager,
      tracer: this.resolvedTracer,
      metrics: this.resolvedMetrics,
      logger: this.deps.logger,
      requestLogger: this.resolvedRequestLogger,
      toolPolicy: this.deps.toolPolicy,
      injectionDetector: this.deps.injectionDetector,
      toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
      pendingToolResults: new PendingToolResultsRegistry(),
      skillManager: this.deps.skillManager,
      embedder: this.deps.embedder,
      historyMemory: this.deps.historyMemory,
      historySummarizer: this.deps.historySummarizer,
      llmCallStrategy: this.resolvedLlmCallStrategy,

      // Mutable state
      inputText: text,
      history: [...history],
      subprompts: [],
      toolClientMap: new Map(),
      ragText: '',
      ragResults: Object.fromEntries(
        Object.keys(ragStores).map((k) => [k, []]),
      ),
      mcpTools: [],
      selectedTools: [],
      externalTools: externalTools ?? [],
      assembledMessages: [],
      activeTools: [],
      selectedSkills: [],
      skillContent: '',
      skillArgs: '',
      queryEmbedding: undefined,

      // Control flags — DefaultPipeline always retrieves when stores exist
      shouldRetrieve: true,
      isAscii: true,
      isSapRequired: false,

      // Output
      timing: [],

      // Streaming callback
      yield: yieldChunk,
    };
  }
}
