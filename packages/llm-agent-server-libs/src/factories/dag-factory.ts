import type {
  BuiltCoordinator,
  IPipelineFactory,
  PipelineFactoryDepsBase,
} from '@mcp-abap-adt/llm-agent';
import {
  DagCoordinatorHandler,
  type DagCoordinatorHandlerDeps,
} from '@mcp-abap-adt/llm-agent-libs';

/**
 * Builder-factory that wraps the existing {@link DagCoordinatorHandler}.
 * The `config` parameter IS the fully-formed handler deps — the factory
 * simply constructs the handler and returns it.  The base pipeline deps
 * (`_deps`) are unused because DAG wiring is captured entirely in `config`.
 */
export class DagFactory implements IPipelineFactory<DagCoordinatorHandlerDeps> {
  readonly kind = 'dag' as const;

  async build(
    config: DagCoordinatorHandlerDeps,
    _deps: PipelineFactoryDepsBase,
  ): Promise<BuiltCoordinator> {
    return { handler: new DagCoordinatorHandler(config) };
  }
}
