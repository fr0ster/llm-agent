import type {
  BuiltCoordinator,
  IPipelineFactory,
  PipelineFactoryDepsBase,
} from '@mcp-abap-adt/llm-agent';
import {
  CoordinatorHandler,
  type CoordinatorHandlerDeps,
} from '@mcp-abap-adt/llm-agent-libs';

/**
 * Builder-factory that wraps the existing linear {@link CoordinatorHandler}.
 * The `config` parameter IS the fully-formed handler deps — the factory
 * simply constructs the handler and returns it.  The base pipeline deps
 * (`_deps`) are unused because linear wiring is captured entirely in `config`.
 */
export class LinearFactory implements IPipelineFactory<CoordinatorHandlerDeps> {
  readonly kind = 'linear' as const;

  async build(
    config: CoordinatorHandlerDeps,
    _deps: PipelineFactoryDepsBase,
  ): Promise<BuiltCoordinator> {
    return { handler: new CoordinatorHandler(config) };
  }
}
