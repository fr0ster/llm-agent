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
 * Deep-stepper variant: an LLM planner decomposes the goal and the recursive
 * executor delegates sub-goals to child Steppers (subagents).
 * Preset: `{ planner: 'llm', executor: 'recursive' }`.
 */
export class DeepStepperFactory
  implements IPipelineFactory<StepperFactoryConfig, StepperFactoryDeps>
{
  readonly kind = 'deep-stepper' as const;

  build(
    config: StepperFactoryConfig,
    deps: StepperFactoryDeps,
  ): Promise<BuiltCoordinator> {
    return buildStepperCoordinator(
      { ...config, planner: 'llm', executor: 'recursive' },
      deps,
    );
  }
}
