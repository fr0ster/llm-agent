import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '@mcp-abap-adt/llm-agent-libs';
import { buildDagCoordinatorDeps } from '../smart-agent/build-dag-coordinator-deps.js';
import type { IServerPipelineContext } from './server-context.js';

/** Config = the raw `coordinator:` (DAG) YAML block, validated by parseConfig. */
export type DagPipelineConfig = Record<string, unknown>;

/**
 * Built-in `dag` pipeline plugin. Validates the raw DAG coordinator config
 * (requires a `planner`), assembles the coordinator deps via the shared
 * `buildDagCoordinatorDeps`, registers a `DagCoordinatorHandler` on a fresh
 * agent builder, and returns the runnable agent plus a disposal hook.
 *
 * @deprecated Legacy pipeline. `dag` runs on its own legacy coordinator/step
 * interpreter and stays selectable only for backward compatibility — it is not
 * the active development path. The newer `controller` pipeline (incremental /
 * adaptive planner) is the maintained interpreter; new deployments should use
 * it. The controller interpreter was not designed to drive the legacy DAG flow,
 * so do not migrate a `dag` config onto it. May be removed in a future major.
 */
export class DagPipelinePlugin implements IPipelinePlugin<DagPipelineConfig> {
  readonly name = 'dag';

  parseConfig(raw: unknown): DagPipelineConfig {
    const cfg = (raw ?? {}) as Record<string, unknown>;
    if (cfg.planner === undefined) {
      throw new Error("pipeline 'dag' requires a 'planner' in its config");
    }
    return cfg;
  }

  async build(
    cfg: DagPipelineConfig,
    ctx: IServerPipelineContext,
  ): Promise<IPipelineInstance> {
    const deps = await buildDagCoordinatorDeps({
      coordCfg: cfg,
      llmMap: ctx.llmMap,
      pipelineFallback: ctx.pipelineFallback,
      mainLlm: ctx.mainLlm,
      helperLlm: ctx.helperLlm,
      mainTemp: ctx.mainTemp,
      registry: ctx.workerRegistry,
      makeLlm: (c) => ctx.makeLlm(c),
      warn: (m) => ctx.warn(m),
    });
    if (!deps) {
      throw new Error(
        "pipeline 'dag': buildDagCoordinatorDeps returned undefined",
      );
    }
    const handler = new DagCoordinatorHandler(deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
