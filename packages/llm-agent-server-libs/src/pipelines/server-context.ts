import type {
  ILlm,
  IPipelineContext,
  ISubAgent,
  IToolsRagHandle,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
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
