import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-libs';
import { buildDagCoordinatorDeps } from '../smart-agent/build-dag-coordinator-deps.js';
import type { DagPipelineSettings } from '../smart-agent/pipeline-settings.js';
import { registerSkillSources } from './register-skill-sources.js';
import type { IServerPipelineContext } from './server-context.js';

/**
 * Built-in `dag` pipeline plugin. Assembles the coordinator deps via the shared
 * `buildDagCoordinatorDeps` from the settings the server parsed
 * (`parseDagSettings`), registers a `DagCoordinatorHandler` on a fresh agent
 * builder, and returns the runnable agent plus a disposal hook.
 *
 * @deprecated Legacy pipeline. `dag` runs on its own legacy coordinator/step
 * interpreter and stays selectable only for backward compatibility — it is not
 * the active development path. The newer `controller` pipeline (smart-executor /
 * controller-weak presets) is the maintained interpreter; new deployments should use
 * it. The controller interpreter was not designed to drive the legacy DAG flow,
 * so do not migrate a `dag` config onto it. May be removed in a future major.
 */
export class DagPipelinePlugin implements IPipelinePlugin {
  readonly name = 'dag';

  constructor(private readonly settings: DagPipelineSettings) {}

  async build(ctx: IServerPipelineContext): Promise<IPipelineInstance> {
    const deps = await buildDagCoordinatorDeps({
      settings: this.settings,
      registry: ctx.workerRegistry,
      resolveLlm: (role) => ctx.resolveLlm(role),
      resolveNamedLlm: (key) => ctx.resolveNamedLlm(key),
    });
    const handler = new DagCoordinatorHandler(deps);
    const builder = registerSkillSources(await ctx.createAgentBuilder(), ctx);
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
