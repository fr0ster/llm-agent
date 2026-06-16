import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import { registerSkillSources } from './register-skill-sources.js';
import type { IServerPipelineContext } from './server-context.js';

/**
 * Built-in `flat` pipeline plugin. No coordinator — just builds a plain
 * {@link SmartAgent} with the base tool loop (no decomposition, planning, or
 * multi-worker orchestration). Used for simple single-turn or stateless
 * deployments.
 */
export class FlatPipelinePlugin
  implements IPipelinePlugin<Record<string, never>>
{
  readonly name = 'flat';

  parseConfig(): Record<string, never> {
    return {};
  }

  async build(
    _cfg: Record<string, never>,
    ctx: IServerPipelineContext,
  ): Promise<IPipelineInstance> {
    const builder = registerSkillSources(await ctx.createAgentBuilder(), ctx);
    const handle = await builder.build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
