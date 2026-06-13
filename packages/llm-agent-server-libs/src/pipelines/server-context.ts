import type {
  IEmbedder,
  ILlm,
  IPipelineContext,
  ISkillPluginHost,
  ISubAgent,
  IToolsRagHandle,
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
  /**
   * Durable knowledge backend (session-bundle persistence + artifacts). The
   * server always builds exactly one (`buildKnowledgeBackend`): JSONL when a
   * `logDir` is set, else in-memory. Shared across sessions; consumed by the
   * stepper/controller coordinators.
   */
  stepperKnowledgeBackend: KnowledgeBackend;
  /**
   * The embedder resolved once at startup from `rag.embedder` (or the configured
   * embedder), shared with makeRag and the subagent context-builder. Used by the
   * controller pipeline for target-state semantic distance. Undefined when no
   * embedder is configured.
   */
  embedder?: IEmbedder;
  /**
   * The live skill plugin-host, built once at startup from `skillPlugins:` config
   * and `await host.load()`-ed before serving. Consumed by the implicit
   * assembler wiring (B3) and the controller recall hook (B4). Undefined when no
   * `skillPlugins:` config is present.
   */
  skillHost?: ISkillPluginHost;
  /**
   * Skills recall knobs (`skillPlugins.k` / `skillPlugins.threshold`) threaded
   * from the host config so the implicit assembler wiring (B3) can size each
   * registered skills RAG source. Present iff `skillHost` is present.
   */
  skillRecall?: { k: number; threshold?: number };
}

/**
 * Controller-pipeline view of the server context. With the durable knowledge
 * backend and embedder now folded into the base {@link IServerPipelineContext}
 * (external tools are routed per-REQUEST via `PipelineContext.externalTools`,
 * not the build-time ctx), this is a transparent alias retained for the
 * controller plugin / fixtures that reference it by name.
 */
export type IControllerServerPipelineContext = IServerPipelineContext;

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
