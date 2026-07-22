import type { ILlm } from './llm.js';
import type { IStageHandler } from './plugin.js';
import type { McpCallResult } from './types.js';

export type PipelineFactoryKind =
  | 'linear'
  | 'dag'
  | 'cyclic'
  | 'planned'
  | 'deep-stepper'
  | 'controller';

/** The built, ready-to-register `coordinator` stage handler for one pipeline. */
export interface BuiltCoordinator {
  handler: IStageHandler<unknown>;
}

/** Deps shared by every pipeline factory. */
export interface PipelineFactoryDepsBase {
  /** Resolve+construct the LLM for a logical role ('planner'|'executor'|...). */
  makeRoleLlm: (role: string) => Promise<ILlm>;
  /** Invoke an MCP tool by name; returns its textual result plus the
   *  tool-level `isError` (threaded from the bridge — never dropped, #213). */
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<McpCallResult>;
}

/**
 * A factory builds one pipeline variant's coordinator from a typed config.
 * `TDeps` lets a factory declare the concrete (super-base) deps shape it needs,
 * so callers pass exactly what `build` consumes instead of the bare base (which
 * would leave factory-specific deps `undefined`). Defaults to the base.
 */
export interface IPipelineFactory<
  TConfig = unknown,
  TDeps extends PipelineFactoryDepsBase = PipelineFactoryDepsBase,
> {
  readonly kind: PipelineFactoryKind;
  build(config: TConfig, deps: TDeps): Promise<BuiltCoordinator>;
}
