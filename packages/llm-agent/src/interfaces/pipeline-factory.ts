import type { ILlm } from './llm.js';
import type { IStageHandler } from './plugin.js';

export type PipelineFactoryKind =
  | 'linear'
  | 'dag'
  | 'cyclic'
  | 'planned'
  | 'deep-stepper';

/** The built, ready-to-register `coordinator` stage handler for one pipeline. */
export interface BuiltCoordinator {
  handler: IStageHandler<unknown>;
}

/** Deps shared by every pipeline factory. */
export interface PipelineFactoryDepsBase {
  /** Resolve+construct the LLM for a logical role ('planner'|'executor'|...). */
  makeRoleLlm: (role: string) => Promise<ILlm>;
  /** Invoke an MCP tool by name; returns its textual result. */
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<string>;
}

/** A factory builds one pipeline variant's coordinator from a typed config. */
export interface IPipelineFactory<TConfig = unknown> {
  readonly kind: PipelineFactoryKind;
  build(
    config: TConfig,
    deps: PipelineFactoryDepsBase,
  ): Promise<BuiltCoordinator>;
}
