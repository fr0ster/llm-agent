import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import type { CoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';
import { LinearFactory } from '../factories/index.js';
import type { LinearPipelineSettings } from '../smart-agent/pipeline-settings.js';
import {
  resolveCoordinatorDispatch,
  resolveCoordinatorDispatchKind,
  resolveCoordinatorPlanning,
} from './coordinator-resolvers.js';
import { registerSkillSources } from './register-skill-sources.js';
import type { IServerPipelineContext } from './server-context.js';

/**
 * Built-in `linear` pipeline plugin. Constructed with settings the server parsed
 * (`parseLinearSettings`); the planner's LLM is a lookup, so it happens here, per
 * session, through `ctx`.
 */
export class LinearPipelinePlugin implements IPipelinePlugin {
  readonly name = 'linear';

  constructor(private readonly settings: LinearPipelineSettings) {}

  async build(ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const s = this.settings;
    const plannerLlm = await ctx.resolveLlm('planner');
    const deps: CoordinatorHandlerDeps = {
      planning: resolveCoordinatorPlanning(s.planning, plannerLlm),
      dispatch: resolveCoordinatorDispatch(
        resolveCoordinatorDispatchKind(s.dispatch),
        plannerLlm,
        undefined,
      ),
      maxSteps: s.maxSteps,
      maxRetriesPerStep: s.maxRetriesPerStep,
      failPolicy: s.failPolicy,
    };
    const { handler } = await new LinearFactory().build(deps, {
      makeRoleLlm: (role) => ctx.resolveLlm(role),
      callMcp: (n, a, sig) => ctx.callMcp(n, a, sig),
    });
    const builder = registerSkillSources(await ctx.createAgentBuilder(), ctx);
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
