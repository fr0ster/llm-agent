import type { BuiltCoordinator } from '@mcp-abap-adt/llm-agent';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../smart-agent/controller/controller-coordinator-handler.js';
import type { ControllerConfig } from '../smart-agent/controller/types.js';

/**
 * Runtime dependencies for {@link ControllerFactory} — everything the
 * {@link ControllerCoordinatorHandler} needs EXCEPT the `config` (that is the
 * factory's `config` argument). Unlike the Stepper factories (which resolve role
 * LLMs lazily via `makeRoleLlm`), the controller is wired with already-built
 * subagent clients, so these deps do NOT extend `PipelineFactoryDepsBase`.
 */
export type ControllerFactoryDeps = Omit<ControllerHandlerDeps, 'config'>;

/**
 * Builder-factory for the `controller` pipeline — the code-level (no-YAML)
 * counterpart to the Stepper `*Factory` classes. It assembles a
 * {@link ControllerCoordinatorHandler} from the controller config + runtime
 * deps and returns a {@link BuiltCoordinator} (`{ handler }`) ready to attach via
 * `builder.withStepperCoordinator(handler)`.
 *
 * @example
 * ```ts
 * import { ControllerFactory } from '@mcp-abap-adt/llm-agent-server-libs/controller';
 * const { handler } = await new ControllerFactory().build(config, deps);
 * const handle = await builder.withStepperCoordinator(handler).build();
 * ```
 */
export class ControllerFactory {
  readonly kind = 'controller' as const;

  async build(
    config: ControllerConfig,
    deps: ControllerFactoryDeps,
  ): Promise<BuiltCoordinator> {
    const handler = new ControllerCoordinatorHandler({ ...deps, config });
    return { handler };
  }
}
