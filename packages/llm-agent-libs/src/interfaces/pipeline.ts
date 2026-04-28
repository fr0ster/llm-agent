/**
 * IPipeline interface and supporting types.
 *
 * A pipeline encapsulates the full request-processing lifecycle for a single
 * SmartAgent invocation. Callers construct a pipeline once (via initialize) and
 * then invoke execute() per request.
 *
 * The two-level architecture separates:
 *   - Builder  — global DI of long-lived dependencies
 *   - IPipeline — per-request orchestration
 */

import type {
  CallOptions,
  IContextAssembler,
  IEmbedder,
  IHistoryMemory,
  IHistorySummarizer,
  ILlm,
  ILlmCallStrategy,
  ILogger,
  IMcpClient,
  IQueryExpander,
  IRag,
  IRagProviderRegistry,
  IRagRegistry,
  IRequestLogger,
  ISkillManager,
  ISubpromptClassifier,
  IToolCache,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
  TimingEntry,
} from '@mcp-abap-adt/llm-agent';
import type { OrchestratorError, SmartAgentConfig } from '../agent.js';
import type { IMetrics } from '../metrics/types.js';
import type { IPromptInjectionDetector, IToolPolicy } from '../policy/types.js';
import type { IReranker } from '../reranker/types.js';
import type { ISessionManager } from '../session/types.js';
import type { ITracer } from '../tracer/types.js';
import type { IOutputValidator } from '../validator/types.js';

// ---------------------------------------------------------------------------
// Pipeline dependencies
// ---------------------------------------------------------------------------

/**
 * All dependencies a pipeline needs to process requests.
 * Passed once to IPipeline.initialize() during startup.
 */
export interface PipelineDeps {
  /** Primary LLM used for generation. */
  mainLlm: ILlm;
  /** Optional secondary LLM for helper tasks (translation, rewriting, etc.). */
  helperLlm?: ILlm;
  /** LLM used exclusively for intent classification. */
  classifierLlm?: ILlm;
  /** Subprompt classifier that routes requests to RAG stores. */
  classifier?: ISubpromptClassifier;
  /** Context assembler that formats messages for the LLM. */
  assembler?: IContextAssembler;
  /** Connected MCP clients. */
  mcpClients: IMcpClient[];
  /** Reranker applied to RAG results. */
  reranker?: IReranker;
  /** Query expander for multi-query RAG retrieval. */
  queryExpander?: IQueryExpander;
  /** Cache for tool call results. */
  toolCache?: IToolCache;
  /** Validates LLM output before returning it to the consumer. */
  outputValidator?: IOutputValidator;
  /** Manages per-session conversation state. */
  sessionManager?: ISessionManager;
  /** Distributed tracing provider. */
  tracer?: ITracer;
  /** Metrics provider for instrumentation. */
  metrics?: IMetrics;
  /** Optional structured logger. */
  logger?: ILogger;
  /** Logs all LLM calls and RAG queries for the request. */
  requestLogger?: IRequestLogger;
  /** Optional tool access policy. */
  toolPolicy?: IToolPolicy;
  /** Optional prompt injection detector. */
  injectionDetector?: IPromptInjectionDetector;
  /** Optional skill manager for slash-command resolution. */
  skillManager?: ISkillManager;
  /** Optional embedder for on-the-fly embedding operations. */
  embedder?: IEmbedder;
  /** Optional persistent history memory across sessions. */
  historyMemory?: IHistoryMemory;
  /** Optional history summarizer to compress long conversations. */
  historySummarizer?: IHistorySummarizer;
  /** Strategy controlling whether to use streaming or non-streaming LLM calls. */
  llmCallStrategy?: ILlmCallStrategy;
  /** Agent config snapshot — forwarded to pipeline context for stage handlers. */
  agentConfig?: SmartAgentConfig;
  /** RAG store used for tool retrieval. */
  toolsRag?: IRag;
  /** RAG store used for history retrieval. */
  historyRag?: IRag;
  /** Full record of RAG stores (tools, history, and any custom stores). */
  ragStores?: Record<string, IRag>;
  /** Registry of RAG collections (v9.1+). When present, ragStores is a live projection. */
  ragRegistry?: IRagRegistry;
  /** Registry of RAG providers for dynamic collection creation (v9.1+). */
  ragProviderRegistry?: IRagProviderRegistry;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/**
 * Outcome of a single pipeline execution.
 */
export interface PipelineResult {
  /** Per-phase timing breakdown collected during execution. */
  timing: TimingEntry[];
  /** Set when a stage aborted the pipeline with an error. */
  error?: OrchestratorError;
}

// ---------------------------------------------------------------------------
// IPipeline interface
// ---------------------------------------------------------------------------

/**
 * Contract for request-processing pipelines.
 *
 * Implementations orchestrate the full lifecycle of a SmartAgent request:
 * classification → RAG retrieval → context assembly → LLM call → tool loop.
 *
 * DefaultPipeline (Task 5) implements this interface and replaces the current
 * PipelineExecutor + YAML stage tree.
 */
export interface IPipeline {
  /**
   * Inject dependencies into the pipeline.
   * Called once after construction, before the first execute() call.
   */
  initialize(deps: PipelineDeps): void;

  /**
   * Process a single request end-to-end and stream results to the caller.
   *
   * @param input         - User input as a string or pre-built message array.
   * @param history       - Conversation history to include in the request.
   * @param options       - Per-request call options (session, signal, model, etc.).
   * @param yieldChunk    - Callback invoked for each streamed result chunk.
   * @param externalTools - Normalized external tools to include alongside MCP tools.
   * @returns Final PipelineResult with timing and optional error.
   */
  execute(
    input: string | Message[],
    history: Message[],
    options: CallOptions | undefined,
    yieldChunk: (chunk: Result<LlmStreamChunk, OrchestratorError>) => void,
    externalTools?: LlmTool[],
  ): Promise<PipelineResult>;

  /**
   * Rebuild internal stage definitions.
   * Called when RAG stores are added/removed at runtime.
   */
  rebuildStages?(): void;
}
