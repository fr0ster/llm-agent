/**
 * CoordinatorActivateHandler — runtime activation decision for the
 * coordinator stage.
 *
 * Built-time stage selection cannot see runtime ctx (selectedSkills are
 * populated only after `skill-select` runs). This handler evaluates the
 * configured `IActivationStrategy` against REAL ctx state and writes
 * `ctx.coordinatorActive`. Coordinator and tool-loop stages gate on this
 * flag via `when:` predicates so the activation decision honours runtime
 * skill selection.
 *
 * Reads:  `ctx.subAgents`, `ctx.selectedSkills`.
 * Writes: `ctx.coordinatorActive`.
 */

import type { IActivationStrategy } from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class CoordinatorActivateHandler implements IStageHandler {
  constructor(private readonly activation: IActivationStrategy) {}

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    const hasSubAgents = (ctx.subAgents?.size ?? 0) > 0;
    const hasStructuredSkill = ctx.selectedSkills.some(
      (s) => (s.meta?.steps?.length ?? 0) > 0,
    );
    const active = this.activation.shouldActivate({
      hasSubAgents,
      hasStructuredSkill,
    });
    ctx.coordinatorActive = active;
    ctx.options?.sessionLogger?.logStep('coordinator_activate', {
      strategy: this.activation.name,
      active,
      hasSubAgents,
      hasStructuredSkill,
    });
    return true;
  }
}
