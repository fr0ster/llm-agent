import type {
  IEmbedder,
  ILlm,
  IPipelineContext,
  ISubAgent,
  IToolsRagHandle,
  LlmTool,
} from '@mcp-abap-adt/llm-agent';
import type {
  KnowledgeBackend,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import type { NormalizedLlmMap } from '../smart-agent/config.js';
import type { SmartServerLlmConfig } from '../smart-agent/smart-server.js';

/**
 * Server-side pipeline context. Extends the portable core IPipelineContext with
 * the SmartAgentBuilder factory (host owns agent assembly) and the raw materials
 * the DAG/linear coordinator builders need. Built-ins downcast IPipelineContext
 * to this; the stepper variant uses only the core surface.
 */
export interface IServerPipelineContext extends IPipelineContext {
  /** Builder pre-wired with all shared infra EXCEPT the coordinator. */
  createAgentBuilder(): Promise<SmartAgentBuilder>;
  // Raw materials for buildDagCoordinatorDeps / linear strategy resolution.
  makeLlm(cfg: SmartServerLlmConfig): Promise<ILlm>;
  llmMap?: NormalizedLlmMap;
  pipelineFallback?: SmartServerLlmConfig;
  mainLlm: ILlm;
  helperLlm?: ILlm;
  mainTemp: number;
  /** Session-scoped worker registry (DAG workers / linear subagents). */
  workerRegistry: ReadonlyMap<string, ISubAgent>;
  warn(msg: string): void;
}

/**
 * Controller-pipeline extension of the server context. Adds the durable
 * knowledge backend, the session-memory embedder, and the consumer-supplied
 * external tools the {@link ControllerCoordinatorHandler} needs.
 *
 * TODO(Task 9): the host (smart-server.ts → createServerPipelineContext) must
 * populate these three fields on the context it hands to the controller plugin:
 *   - `stepperKnowledgeBackend` — the durable KnowledgeBackend (JSONL/in-memory)
 *   - `embedder`                — the session-memory embedder (rag.embedder)
 *   - `externalTools`           — consumer-supplied tool descriptors (LlmTool[])
 * (`knowledgeRagFor` and `mcpClients` already live on the core context.)
 */
export interface IControllerServerPipelineContext
  extends IServerPipelineContext {
  /** Durable knowledge backend (session-bundle persistence + artifacts). */
  stepperKnowledgeBackend: KnowledgeBackend;
  /** Session-memory embedder (target-state semantic distance). */
  embedder?: IEmbedder;
  /** Consumer-supplied external tools that must round-trip to the client. */
  externalTools?: readonly LlmTool[];
}

/** Always-present empty handle for no-RAG/no-MCP deployments. */
export const EMPTY_TOOLS_RAG: IToolsRagHandle = {
  query: async () => [],
  lookup: () => undefined,
};

/** Deps = the full context minus toolsRag (which the factory defaults). */
export type ServerPipelineContextDeps = Omit<
  IServerPipelineContext,
  'toolsRag'
> & {
  toolsRag?: IToolsRagHandle;
};

export function createServerPipelineContext(
  deps: ServerPipelineContextDeps,
): IServerPipelineContext {
  return { ...deps, toolsRag: deps.toolsRag ?? EMPTY_TOOLS_RAG };
}
