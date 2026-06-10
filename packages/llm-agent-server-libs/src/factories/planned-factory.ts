import type {
  BuiltCoordinator,
  IPipelineFactory,
} from '@mcp-abap-adt/llm-agent';
import {
  buildStepperCoordinator,
  type StepperFactoryConfig,
  type StepperFactoryDeps,
} from './cyclic-factory.js';

/**
 * Planned Stepper variant: an LLM planner decomposes the goal, then a
 * cyclic-ReAct executor runs each step.
 * Preset: `{ planner: 'llm', executor: 'cyclic-react' }`.
 */
export class PlannedFactory
  implements IPipelineFactory<StepperFactoryConfig, StepperFactoryDeps>
{
  readonly kind = 'planned' as const;

  build(
    config: StepperFactoryConfig,
    deps: StepperFactoryDeps,
  ): Promise<BuiltCoordinator> {
    return buildStepperCoordinator(
      { ...config, planner: 'llm', executor: 'cyclic-react' },
      deps,
    );
  }
}
