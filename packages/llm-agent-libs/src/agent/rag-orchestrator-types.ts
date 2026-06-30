import type {
  CallOptions,
  IContextAssembler,
  IEmbedder,
  ILlm,
  IMcpClient,
  IQueryExpander,
  IRag,
  IRequestLogger,
  ISkillManager,
  ISubpromptClassifier,
  LlmTool,
  McpTool,
  Message,
  OrchestratorError,
  RagResult,
  Result,
  Subprompt,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgentConfig } from '../agent.js';
import type { IMcpToolRegistry } from '../mcp/tool-registry.js';
import type { IMetrics } from '../metrics/types.js';
import type { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import type { IReranker } from '../reranker/types.js';
import type { ISessionManager } from '../session/types.js';
import type { ISpan, ITracer } from '../tracer/types.js';
import type { summarizeHistory, toEnglishForRag } from './rag-helpers.js';

export interface RagOrchestratorDeps {
  mainLlm: ILlm;
  helperLlm: ILlm | undefined;
  classifier: ISubpromptClassifier;
  config: SmartAgentConfig;
  tracer: ITracer;
  metrics: IMetrics;
  reranker: IReranker;
  queryExpander: IQueryExpander;
  sessionManager: ISessionManager;
  toolAvailabilityRegistry: ToolAvailabilityRegistry;
  mcpToolRegistry: IMcpToolRegistry;
  requestLogger: IRequestLogger;
  ragStores: Record<string, IRag>;
  embedder: IEmbedder | undefined;
  assembler: IContextAssembler;
  skillManager: ISkillManager | undefined;
  translateQueryStores: Set<string> | undefined;
  /** Optional strategy overrides (default to the module-scope impls). */
  toEnglishForRag?: typeof toEnglishForRag;
  summarizeHistory?: typeof summarizeHistory;
}

export interface OrchestrateOptions {
  opts: CallOptions | undefined;
  rootSpan: ISpan;
  sessionId: string;
  mode: 'hard' | 'pass' | 'smart';
  externalTools: LlmTool[];
}

export interface OrchestratedContext {
  retrieved: { ragResults: Record<string, RagResult[]>; tools: McpTool[] };
  finalTools: LlmTool[];
  skillContent: string;
  assembledMessages: Message[];
  mainAction: Subprompt;
  toolClientMap: Map<string, IMcpClient>;
}

export interface IRagOrchestrator {
  orchestrate(
    input: string | Message[],
    options: OrchestrateOptions,
  ): Promise<Result<OrchestratedContext, OrchestratorError>>;
}
