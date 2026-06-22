import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import {
  CyclicFactory,
  DeepStepperFactory,
  PlannedFactory,
  type StepperFactoryConfig,
  type StepperFactoryDeps,
} from '../factories/index.js';
import {
  parseStepperCoordinatorConfig,
  type StepperCoordinatorConfig,
} from './parsers.js';
import type { IServerPipelineContext } from './server-context.js';

/**
 * Built-in `stepper` pipeline plugin. Parses the coordinator config dialect,
 * picks the matching builder-factory by `mode`, builds the coordinator stage
 * handler, registers it on a fresh agent builder, and returns the runnable
 * agent plus a disposal hook.
 *
 * @deprecated Legacy pipeline. `stepper` runs on its own legacy composition
 * step-interpreter and stays selectable only for backward compatibility — it is
 * not the active development path. The newer `controller` pipeline (smart-executor
 * / controller-weak presets) is the maintained interpreter; new deployments should use
 * it. The controller interpreter was not designed to drive the legacy stepper
 * flow, so do not migrate a `stepper` config onto it. May be removed in a future
 * major.
 */
export class StepperPipelinePlugin
  implements IPipelinePlugin<StepperCoordinatorConfig>
{
  readonly name = 'stepper';

  parseConfig(raw: unknown): StepperCoordinatorConfig {
    return parseStepperCoordinatorConfig(
      (raw ?? {}) as Record<string, unknown>,
    );
  }

  async build(
    cfg: StepperCoordinatorConfig,
    ctx: IServerPipelineContext,
  ): Promise<IPipelineInstance> {
    const spec: StepperFactoryConfig = {
      granularity: cfg.flow.granularity,
      finalizer: cfg.flow.finalizer,
      plannerSystemPrompt: cfg.flow.plannerSystemPrompt,
      executorSystemPrompt: cfg.flow.executorSystemPrompt,
      evaluatorEnabled: cfg.flow.evaluatorEnabled,
      evaluatorAtDepths: cfg.flow.evaluatorAtDepths,
      evaluatorSystemPrompt: cfg.flow.evaluatorSystemPrompt,
      reviewerAtDepths: cfg.reviewerAtDepths,
      maxParallelSteps: cfg.maxParallelSteps,
      maxDepth: cfg.maxDepth,
      tokenBudget: cfg.tokenBudget,
      formalizeTask: cfg.formalizeTask,
      plan: cfg.flow.plan,
      nodes: cfg.flow.nodes,
    };
    const deps: StepperFactoryDeps = {
      makeRoleLlm: (role) => ctx.resolveLlm(role),
      callMcp: (n, a, s) => ctx.callMcp(n, a, s).then(String),
      // ctx.knowledgeRagFor is MaybePromise; StepperFactoryDeps wants Promise.
      knowledgeRagFor: async (sid) => ctx.knowledgeRagFor(sid),
      toolsRag: ctx.toolsRag,
      mintStepperId: () => ctx.mintStepperId(),
      mintTurnId: () => ctx.mintTurnId(),
      subagents: ctx.subagents,
    };
    const factory =
      cfg.mode === 'cyclic-react'
        ? new CyclicFactory()
        : cfg.mode === 'deep-stepper'
          ? new DeepStepperFactory()
          : new PlannedFactory();
    const { handler } = await factory.build(spec, deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
