import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import { registerSkillSources } from './register-skill-sources.js';
import type { IServerPipelineContext } from './server-context.js';

/**
 * Built-in `flat` pipeline plugin. No coordinator and no settings — a plain
 * SmartAgent with the base tool loop.
 */
export class FlatPipelinePlugin implements IPipelinePlugin {
  readonly name = 'flat';

  async build(ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const builder = registerSkillSources(await ctx.createAgentBuilder(), ctx);
    const handle = await builder.build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
