// Facade: re-exports the pure stepper parser from stepper-config.ts and the
// coordinator resolvers from coordinator-resolvers.ts. parseLinearConfig
// (below) is the only logic that lives here.
export {
  parseStepperCoordinatorConfig,
  type StepperCoordinatorConfig,
} from '../smart-agent/stepper-config.js';

import type { CoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';
import {
  resolveCoordinatorDispatch,
  resolveCoordinatorDispatchKind,
  resolveCoordinatorPlanning,
} from './coordinator-resolvers.js';
import type { IServerPipelineContext } from './server-context.js';

export async function parseLinearConfig(
  cfg: Record<string, unknown>,
  ctx: IServerPipelineContext,
): Promise<CoordinatorHandlerDeps> {
  const plannerLlm = await ctx.resolveLlm('planner');
  const planningKind =
    (cfg.planning as 'one-shot' | 'replan-on-error' | 'skill-steps') ??
    'one-shot';
  // resolveCoordinatorDispatchKind accepts only the dispatch union; cast after
  // the YAML schema has constrained it.
  const dispatchKind = resolveCoordinatorDispatchKind(
    cfg.dispatch as 'subagent' | 'self' | 'hybrid' | undefined,
  );
  return {
    planning: resolveCoordinatorPlanning(planningKind, plannerLlm),
    dispatch: resolveCoordinatorDispatch(dispatchKind, plannerLlm, undefined),
    maxSteps: (cfg.maxSteps as number) ?? 10,
    maxRetriesPerStep: (cfg.maxRetriesPerStep as number) ?? 1,
    failPolicy: (cfg.failPolicy as 'abort' | 'continue') ?? 'abort',
  };
}
