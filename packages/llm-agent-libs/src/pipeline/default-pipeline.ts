/**
 * DefaultPipeline — IPipeline implementation backed by PipelineExecutor + stage handlers.
 *
 * This is the standard pipeline used by SmartAgent when no custom pipeline is
 * configured. It runs one of two stage sequences, selected by
 * {@link SmartAgentConfig.enrichedToolSearch}:
 *
 * **Single-phase (default):**
 * ```text
 * classify → summarize → parallel(rag-query tools, rag-query history, rag-query <custom>…) →
 * rerank → skill-select → tool-select → assemble → tool-loop → history-upsert
 * ```
 *
 * **Enriched (`enrichedToolSearch: true`):** the tools RAG store is queried in
 * a second phase driven by context from prior retrieval + selected skills:
 * ```text
 * classify → summarize → parallel(rag-query history, rag-query <custom>…) →
 * rerank → skill-select → build-tool-query → rag-query tools (enriched) →
 * tool-select → assemble → tool-loop → history-upsert
 * ```
 *
 * Built-in RAG stores (`tools`, `history`) are wired from `toolsRag`/`historyRag` deps.
 * Additional custom stores can be passed via `ragStores` and are queried in parallel
 * with built-ins. Stores can be added/removed at runtime via `rebuildStages()`.
 */

import type {
  CallOptions,
  ICoordinatorConfig,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
  SubAgentRegistry,
} from '@mcp-abap-adt/llm-agent';
import {
  NoopQueryExpander,
  NoopToolCache,
  StreamingLlmCallStrategy,
} from '@mcp-abap-adt/llm-agent';
import type {
  OrchestratorError,
  SmartAgentConfig,
  SmartAgentRagStores,
} from '../agent.js';
import { LlmClassifier } from '../classifier/llm-classifier.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { ExplicitActivation } from '../coordinator/activation/explicit.js';
import type {
  IPipeline,
  PipelineDeps,
  PipelineResult,
} from '../interfaces/pipeline.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { NoopReranker } from '../reranker/noop-reranker.js';
import { NoopSessionManager } from '../session/noop-session-manager.js';
import { NoopTracer } from '../tracer/noop-tracer.js';
import { NoopValidator } from '../validator/noop-validator.js';
import type { PipelineContext } from './context.js';
import { PipelineExecutor } from './executor.js';
import type { DagCoordinatorHandlerDeps } from './handlers/dag-coordinator.js';
import { buildDefaultHandlerRegistry } from './handlers/index.js';
import type { IStageHandler } from './stage-handler.js';
import type { StageDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Session-scoped registry resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the per-session tool-availability / pending-tool-results registries
 * for a pipeline request. When the SessionGraph injects them via `CallOptions`,
 * the same instances are reused across requests sharing the sessionId; otherwise
 * fresh per-request instances are created (preserves embed-as-library behavior).
 */
export function resolveSessionRegistries(src: {
  toolAvailability?: ToolAvailabilityRegistry;
  pendingToolResults?: PendingToolResultsRegistry;
}): {
  toolAvailability: ToolAvailabilityRegistry;
  pendingToolResults: PendingToolResultsRegistry;
} {
  return {
    toolAvailability: src.toolAvailability ?? new ToolAvailabilityRegistry(),
    pendingToolResults:
      src.pendingToolResults ?? new PendingToolResultsRegistry(),
  };
}

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
/**
 * Optional construction options for {@link DefaultPipeline}.
 */
export interface DefaultPipelineOptions {
  /**
   * Sub-agent registry to expose as a `sub_agent_call` tool via the default
   * handler registry. When omitted or empty, no sub-agent handler is wired in.
   */
  subAgents?: SubAgentRegistry;
  /**
   * Optional coordinator configuration. When a coordinator (`planning`+`dispatch`,
   * or a `dagCoordinator`) is configured, a `coordinator-activate` runtime stage
   * decides per-request (via the activation strategy) whether the `coordinator`
   * stage runs in place of `tool-loop`.
   */
  coordinator?: ICoordinatorConfig;
  /**
   * DAG coordinator deps. When set, registers `DagCoordinatorHandler` under
   * the `coordinator` stage slot and wires `coordinator-activate`.
   * Mutually exclusive with `coordinator` — `dagCoordinator` takes precedence.
   */
  dagCoordinator?: DagCoordinatorHandlerDeps;
  /**
   * Pre-built stage handler to register under the `coordinator` slot.
   * Takes precedence over `dagCoordinator` and `coordinator`.
   * Used by the 18.0 Stepper runtime.
   */
  stepperCoordinator?: IStageHandler;
}

export class DefaultPipeline implements IPipeline {
  private deps!: PipelineDeps;
  private executor!: PipelineExecutor;
  private stages!: StageDefinition[];
  private readonly subAgents?: SubAgentRegistry;
  private readonly coordinator?: ICoordinatorConfig;
  private readonly dagCoordinator?: DagCoordinatorHandlerDeps;
  private readonly stepperCoordinator?: IStageHandler;

  constructor(options: DefaultPipelineOptions = {}) {
    this.subAgents = options.subAgents;
    this.coordinator = options.coordinator;
    this.dagCoordinator = options.dagCoordinator;
    this.stepperCoordinator = options.stepperCoordinator;
  }

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

    const coordPlanning = this.coordinator?.planning;
    const coordDispatch = this.coordinator?.dispatch;
    const coordinatorConfigured =
      coordPlanning != null && coordDispatch != null;
    const anyCoordinator =
      coordinatorConfigured ||
      this.dagCoordinator != null ||
      this.stepperCoordinator != null;
    const registry = buildDefaultHandlerRegistry({
      subAgents: this.subAgents,
      coordinator:
        coordinatorConfigured && coordPlanning && coordDispatch
          ? {
              planning: coordPlanning,
              dispatch: coordDispatch,
              maxSteps: this.coordinator?.maxSteps ?? 12,
              maxRetriesPerStep: this.coordinator?.maxRetriesPerStep ?? 1,
              failPolicy: this.coordinator?.failPolicy ?? 'abort',
            }
          : undefined,
      dagCoordinator: this.dagCoordinator,
      stepperCoordinator: this.stepperCoordinator,
      // Default to ExplicitActivation when caller passes a coordinator config
      // without an activation strategy. Matches SmartAgentBuilder.withCoordinator
      // semantics: presence of coordinator config IS the opt-in signal.
      // Without this default, `_buildStages()` would emit a `coordinator-activate`
      // stage whose handler is unregistered → unknown-stage runtime error.
      // DAG wins the handler slot when both are configured, so its activation
      // strategy takes precedence too — otherwise the DAG handler could be gated
      // by the linear coordinator's activation. (Matches handler precedence in
      // handlers/index.ts and SmartAgentBuilder.withDagCoordinator.)
      coordinatorActivation: anyCoordinator
        ? (this.dagCoordinator?.activation ??
          this.coordinator?.activation ??
          new ExplicitActivation())
        : undefined,
    });
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
    const enriched = this.deps.agentConfig?.enrichedToolSearch === true;
    const hasToolsRag = Boolean(this.deps.toolsRag);

    const ragChildren: StageDefinition[] = [];
    // In enriched mode, the tools store is queried separately AFTER
    // build-tool-query so the enriched query can drive tool discovery.
    if (hasToolsRag && !enriched) {
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

    const needsTranslate = ragChildren.length > 0 || (enriched && hasToolsRag);
    if (needsTranslate) {
      // Translate non-ASCII RAG query before retrieval (enabled by default)
      stages.push({
        id: 'translate',
        type: 'translate',
        when: 'config.ragTranslateEnabled != false',
      });
    }

    // First-phase retrieval: non-tool stores (enriched mode) or all stores (default).
    if (ragChildren.length > 0) {
      stages.push({
        id: 'rag-retrieval',
        type: 'parallel',
        stages: ragChildren,
        after: [{ id: 'rerank', type: 'rerank' }],
      });
    }

    stages.push({ id: 'skill-select', type: 'skill-select' });

    // Second-phase retrieval (enriched mode only): build the enriched
    // query, then hit the tools RAG store with it.
    if (enriched && hasToolsRag) {
      stages.push({ id: 'build-tool-query', type: 'build-tool-query' });
      stages.push({
        id: 'rag-tools',
        type: 'rag-query',
        config: { store: 'tools', queryText: 'toolQueryText' },
      });
    }

    const coordinatorConfigured =
      this.coordinator?.planning != null && this.coordinator?.dispatch != null;
    const anyCoordinatorStage =
      coordinatorConfigured || this.dagCoordinator != null;

    stages.push(
      { id: 'tool-select', type: 'tool-select' },
      { id: 'assemble', type: 'assemble' },
    );

    if (anyCoordinatorStage) {
      // Runtime activation: `coordinator-activate` evaluates the configured
      // IActivationStrategy AFTER skill-select has run, so it can see the
      // real `ctx.selectedSkills` state (which build-time stage selection
      // cannot). Coordinator and tool-loop are both in the list, gated by
      // `when:` predicates that the executor evaluates per-request.
      stages.push(
        { id: 'coordinator-activate', type: 'coordinator-activate' },
        {
          id: 'coordinator',
          type: 'coordinator',
          when: 'coordinatorActive',
        },
        {
          id: 'tool-loop',
          type: 'tool-loop',
          when: '!coordinatorActive',
        },
      );
    } else {
      stages.push({ id: 'tool-loop', type: 'tool-loop' });
    }

    stages.push({ id: 'history-upsert', type: 'history-upsert' });
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
      ragRegistry: this.deps.ragRegistry,
      ragProviderRegistry: this.deps.ragProviderRegistry,
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
      ...(() => {
        const r = resolveSessionRegistries({
          toolAvailability: options?.toolAvailability as
            | ToolAvailabilityRegistry
            | undefined,
          pendingToolResults: options?.pendingToolResults as
            | PendingToolResultsRegistry
            | undefined,
        });
        return {
          toolAvailabilityRegistry: r.toolAvailability,
          pendingToolResults: r.pendingToolResults,
        };
      })(),
      skillManager: this.deps.skillManager,
      embedder: this.deps.embedder,
      toolSelectionStrategy: this.deps.toolSelectionStrategy,
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

      // Partial-output callback (forwarded from ISubAgentInput.onPartial via
      // CallOptions.onPartial so the tool-loop can emit live deltas).
      onPartial: options?.onPartial,

      // Subagent registry for coordinator/subagent stages (read by handlers).
      subAgents: this.subAgents,
    };
  }
}
