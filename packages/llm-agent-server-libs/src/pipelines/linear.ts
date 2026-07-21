import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import { LinearFactory } from '../factories/index.js';
import { parseLinearConfig } from './parsers.js';
import { registerSkillSources } from './register-skill-sources.js';
import type { IServerPipelineContext } from './server-context.js';

/** Config = the raw `coordinator:` (linear) YAML block. */
export type LinearPipelineConfig = Record<string, unknown>;

/**
 * Built-in `linear` pipeline plugin. The raw config is resolved into
 * {@link CoordinatorHandlerDeps} (via {@link parseLinearConfig}) at build time
 * (it needs `ctx` to resolve LLMs), wrapped by {@link LinearFactory} into a
 * {@link CoordinatorHandler}, registered on a fresh agent builder, and returned
 * as a runnable agent plus a disposal hook.
 */
export class LinearPipelinePlugin
  implements IPipelinePlugin<LinearPipelineConfig>
{
  readonly name = 'linear';

  parseConfig(raw: unknown): LinearPipelineConfig {
    return (raw ?? {}) as Record<string, unknown>;
  }

  async build(
    cfg: LinearPipelineConfig,
    ctx: IServerPipelineContext,
  ): Promise<IPipelineInstance> {
    const deps = await parseLinearConfig(cfg, ctx);
    const { handler } = await new LinearFactory().build(deps, {
      makeRoleLlm: (role) => ctx.resolveLlm(role),
      callMcp: (n, a, s) => ctx.callMcp(n, a, s),
    });
    const builder = registerSkillSources(await ctx.createAgentBuilder(), ctx);
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
