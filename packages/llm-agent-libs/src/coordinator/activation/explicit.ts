import type { IActivationStrategy } from '@mcp-abap-adt/llm-agent';

/**
 * Activate only when explicitly enabled via withCoordinator(). The presence of
 * this strategy in the builder is the opt-in signal — its shouldActivate()
 * always returns true.
 */
export class ExplicitActivation implements IActivationStrategy {
  readonly name = 'explicit';

  shouldActivate(_ctx: {
    hasSubAgents: boolean;
    hasStructuredSkill: boolean;
  }): boolean {
    return true;
  }
}
