import type { ILlm, IPipelineContext, ISubAgent } from '@mcp-abap-adt/llm-agent';
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
