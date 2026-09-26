import type {
  IErrorStrategy,
  ILlm,
  IReviewStrategy,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import type { DagCoordinatorHandlerDeps } from '@mcp-abap-adt/llm-agent-libs';
import {
  AbortErrorStrategy,
  DagPlanInterpreter,
  LlmDagPlanner,
  LlmReviewStrategy,
  ReplanErrorStrategy,
  SubAgentStateOracle,
} from '@mcp-abap-adt/llm-agent-libs';
import { buildFinalizer, resolveCoordinatorActivation } from './config.js';
import type { DagPipelineSettings } from './pipeline-settings.js';

export interface BuildDagCoordinatorDepsInput {
  /** Parsed by the server (`parseDagSettings`); the plugin received it at construction. */
  settings: DagPipelineSettings;
  registry: ReadonlyMap<string, ISubAgent>;
  /** The role's default — asked when the settings name no key for it. */
  resolveLlm: (role: string) => Promise<ILlm>;
  /** Strict — asked for a key the settings named. */
  resolveNamedLlm: (key: string) => Promise<ILlm>;
}

export type BuiltDagCoordinatorDeps = Omit<
  DagCoordinatorHandlerDeps,
  'workers'
> & {
  workers: Map<string, ISubAgent>;
  oracleName?: string;
};

/**
 * Assemble the deps record for `withDagCoordinator`, per session. Each role's LLM is
 * ASKED for, never built: a named key goes to `resolveNamedLlm`, an omitted one to
 * `resolveLlm(<role>)` (§4.6.6, §4.6.7).
 */
export async function buildDagCoordinatorDeps(
  input: BuildDagCoordinatorDepsInput,
): Promise<BuiltDagCoordinatorDeps> {
  const { settings, registry, resolveLlm, resolveNamedLlm } = input;
  const llmFor = (key: string | undefined, role: string): Promise<ILlm> =>
    key ? resolveNamedLlm(key) : resolveLlm(role);

  const planner = new LlmDagPlanner(
    await llmFor(settings.plannerLlm, 'planner'),
  );
  const reviewer: IReviewStrategy | undefined = settings.reviewer
    ? new LlmReviewStrategy(
        await llmFor(settings.reviewer.reviewerLlm, 'reviewer'),
      )
    : undefined;
  const interpreter = new DagPlanInterpreter();

  const oracleName = settings.stateOracle;
  let rawOracle: ISubAgent | undefined;
  if (oracleName) {
    rawOracle = registry.get(oracleName);
    if (!rawOracle) {
      throw new Error(
        `coordinator.stateOracle '${oracleName}' is not a declared subagent`,
      );
    }
  }
  const workers: Map<string, ISubAgent> = new Map(
    [...registry].filter(([name]) => name !== oracleName),
  );
  if (workers.size === 0) {
    throw new Error(
      'coordinator.planner is set (DAG mode) but no workers are configured. ' +
        'Add at least one entry under the top-level `subagents:` block.',
    );
  }
  const activation = resolveCoordinatorActivation(settings.activation);

  const es = settings.errorStrategy;
  const errorStrategy: IErrorStrategy | undefined =
    es?.type === 'replan'
      ? new ReplanErrorStrategy(planner, es.maxReplans)
      : es?.type === 'abort'
        ? new AbortErrorStrategy()
        : undefined;

  const finalizer = await buildFinalizer(settings.finalizer, () =>
    llmFor(settings.finalizer?.finalizerLlm, 'finalizer'),
  );

  return {
    planner,
    interpreter,
    workers,
    activation,
    reviewer,
    errorStrategy,
    stateOracle: rawOracle ? new SubAgentStateOracle(rawOracle) : undefined,
    finalizer,
    maxRoundTrips: settings.maxRoundTrips,
    oracleName,
  };
}
