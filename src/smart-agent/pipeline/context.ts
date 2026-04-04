/**
 * PipelineContext — mutable state bag threaded through all pipeline stages.
 *
 * Each stage reads its inputs from the context and writes its outputs back.
 * The context is created fresh per request and is never shared across requests.
 *
 * ## Data ownership
 *
 * Stages must write to non-overlapping fields. For parallel execution, this
 * means each `rag-query` handler writes to its own store slot
 * in `ragResults`, avoiding data races.
 *
 * ## Streaming
 *
 * The `tool-loop` stage streams. It uses `ctx.yield()` to push
 * SSE chunks back to the caller. All other stages are batch operations.
 */

import type { Message } from '../../types.js';
import type {
  OrchestratorError,
  SmartAgentConfig,
  SmartAgentRagStores,
} from '../agent.js';
import type { IToolCache } from '../cache/types.js';
import type { IContextAssembler } from '../interfaces/assembler.js';
import type { ISubpromptClassifier } from '../interfaces/classifier.js';
import type { ILlm } from '../interfaces/llm.js';
import type { IMcpClient } from '../interfaces/mcp-client.js';
import type { IQueryEmbedding } from '../interfaces/query-embedding.js';
import type { IEmbedder } from '../interfaces/rag.js';
import type { ISkill, ISkillManager } from '../interfaces/skill.js';
import type {
  CallOptions,
  LlmStreamChunk,
  LlmTool,
  McpTool,
  RagResult,
  Result,
  Subprompt,
  TimingEntry,
} from '../interfaces/types.js';
import type { ILogger } from '../logger/types.js';
import type { IMetrics } from '../metrics/types.js';
import type { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import type { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import type { IPromptInjectionDetector, IToolPolicy } from '../policy/types.js';
import type { IQueryExpander } from '../rag/query-expander.js';
import type { IReranker } from '../reranker/types.js';
import type { ISessionManager } from '../session/types.js';
import type { ITracer } from '../tracer/types.js';
import type { IOutputValidator } from '../validator/types.js';

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export interface PipelineContext {
  // -- Immutable input (set once at creation, never modified) ----------------

  /** Original user input (string or message array). */
  readonly textOrMessages: string | Message[];
  /** Call options including signal, sessionId, logger, trace. */
  readonly options: CallOptions | undefined;
  /** SmartAgent config snapshot for this request. */
  readonly config: SmartAgentConfig;
  /** Session ID (from options or 'default'). */
  readonly sessionId: string;

  // -- Dependencies (injected at creation, read-only) -----------------------

  readonly mainLlm: ILlm;
  readonly helperLlm: ILlm | undefined;
  readonly classifierLlm: ILlm;
  readonly classifier: ISubpromptClassifier;
  readonly assembler: IContextAssembler;
  readonly ragStores: SmartAgentRagStores;
  readonly mcpClients: IMcpClient[];
  readonly reranker: IReranker;
  readonly queryExpander: IQueryExpander;
  readonly toolCache: IToolCache;
  readonly outputValidator: IOutputValidator;
  readonly sessionManager: ISessionManager;
  readonly tracer: ITracer;
  readonly metrics: IMetrics;
  readonly logger: ILogger | undefined;
  readonly toolPolicy: IToolPolicy | undefined;
  readonly injectionDetector: IPromptInjectionDetector | undefined;
  readonly toolAvailabilityRegistry: ToolAvailabilityRegistry;
  readonly pendingToolResults: PendingToolResultsRegistry;
  readonly skillManager: ISkillManager | undefined;
  readonly embedder: IEmbedder | undefined;

  // -- Mutable state (populated by stages) ----------------------------------

  /** Extracted user text from the last user message. */
  inputText: string;
  /** Conversation history (may be summarized). */
  history: Message[];
  /** Classified subprompts (set by classify stage). */
  subprompts: Subprompt[];
  /** Map of tool name → owning MCP client. */
  toolClientMap: Map<string, IMcpClient>;
  /** Text used for RAG queries (may be translated/expanded). */
  ragText: string;
  /** Memoized query embedding, shared across all rag-query stages. */
  queryEmbedding: IQueryEmbedding | undefined;
  /** RAG query results per store. */
  ragResults: Record<string, RagResult[]>;
  /** All MCP tools from all connected servers. */
  mcpTools: McpTool[];
  /** Tools selected for the current request (MCP + external). */
  selectedTools: LlmTool[];
  /** External tools provided by the client. */
  externalTools: LlmTool[];
  /** Final assembled messages for LLM input. */
  assembledMessages: Message[];
  /** Currently active tools (after availability filtering). */
  activeTools: LlmTool[];
  /** Skills selected for the current request. */
  selectedSkills: ISkill[];
  /** Rendered skill content to inject into the system prompt. */
  skillContent: string;
  /** Arguments passed to skills (e.g. from slash-command invocation). */
  skillArgs: string;

  // -- Control flags (computed by stages, read by conditions) ---------------

  /** Whether RAG retrieval should run (set by classify or condition logic). */
  shouldRetrieve: boolean;
  /** Whether input text is ASCII-only (affects translation decision). */
  isAscii: boolean;
  /** Whether SAP/ABAP context was detected. */
  isSapRequired: boolean;

  // -- Output ---------------------------------------------------------------

  /** Timing entries collected from all stages. */
  timing: TimingEntry[];
  /** Error set by a stage to abort the pipeline. */
  error?: OrchestratorError;

  // -- Streaming callback ---------------------------------------------------

  /**
   * Yield a chunk to the consumer. Used by the tool-loop stage to push
   * streaming content and heartbeats back through the SSE connection.
   */
  yield(chunk: Result<LlmStreamChunk, OrchestratorError>): void;
}
