import type { IActivationStrategy } from '@mcp-abap-adt/llm-agent';

/**
 * Activate the coordinator when EITHER the registry has subagents OR the
 * selected skill has explicit `steps` declared.
 */
export class AutoActivation implements IActivationStrategy {
  readonly name = 'auto';

  shouldActivate(ctx: {
    hasSubAgents: boolean;
    hasStructuredSkill: boolean;
  }): boolean {
    return ctx.hasSubAgents || ctx.hasStructuredSkill;
  }
}
