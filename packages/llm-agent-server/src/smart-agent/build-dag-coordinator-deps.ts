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
import {
  buildFinalizer,
  type NormalizedLlmMap,
  resolveCoordinatorActivation,
  resolveLlmConfig,
  resolveReviewerLlmName,
} from './config.js';
import type { SmartServerLlmConfig } from './smart-server.js';

export interface BuildDagCoordinatorDepsInput {
  coordCfg: Record<string, unknown> | undefined;
  llmMap: NormalizedLlmMap | undefined;
  /** Adapted from `pipeline.llm.main` (already shape-normalized to
   *  SmartServerLlmConfig: `{ provider, apiKey, url: baseURL, model,
   *  temperature }`). When set, used as the final fallback in the
   *  role-resolution chain map[name] → map.main → pipelineFallback. */
  pipelineFallback: SmartServerLlmConfig | undefined;
  mainLlm: ILlm;
  helperLlm: ILlm | undefined;
  mainTemp: number;
  registry: ReadonlyMap<string, ISubAgent>;
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>;
  warn: (msg: string) => void;
}

export type BuiltDagCoordinatorDeps = Omit<
  DagCoordinatorHandlerDeps,
  'workers'
> & {
  workers: Map<string, ISubAgent>;
  oracleName?: string;
};

/**
 * Assemble the full deps record for `withDagCoordinator`. Returns
 * `undefined` when the YAML does not declare a DAG coordinator (no
 * `planner` block), so the caller can branch.
 *
 * Roles resolve their LLM via the chain:
 *   resolveLlmConfig(llmMap, name, pipelineFallback)
 *   → top-level llm.<name> → llm.main → pipelineFallback (pipeline.llm.main)
 */
export async function buildDagCoordinatorDeps(
  input: BuildDagCoordinatorDepsInput,
): Promise<BuiltDagCoordinatorDeps | undefined> {
  const {
    coordCfg,
    llmMap,
    pipelineFallback,
    mainLlm,
    helperLlm,
    mainTemp,
    registry,
    makeLlm,
    warn,
  } = input;

  if (!coordCfg || coordCfg.planner === undefined) return undefined;

  // ---- Planner ----------------------------------------------------------
  const plannerBlock = coordCfg.planner as {
    type?: string;
    plannerLlm?: string;
  };
  const plannerLlmCfg = resolveLlmConfig(
    llmMap,
    plannerBlock?.plannerLlm,
    pipelineFallback,
  );
  const plannerLlm = plannerLlmCfg
    ? await makeLlm({
        ...plannerLlmCfg,
        temperature: Number(plannerLlmCfg.temperature ?? mainTemp),
      })
    : mainLlm;
  const planner = new LlmDagPlanner(plannerLlm);

  // ---- Reviewer (optional) ---------------------------------------------
  let reviewer: IReviewStrategy | undefined;
  if (coordCfg.reviewer !== undefined) {
    const reviewerBlock = coordCfg.reviewer as {
      reviewerLlm?: string;
      plannerLlm?: string;
    };
    const reviewerName = resolveReviewerLlmName(reviewerBlock, warn);
    const reviewerCfg = resolveLlmConfig(
      llmMap,
      reviewerName,
      pipelineFallback,
    );
    const reviewerLlm = reviewerCfg
      ? await makeLlm({
          ...reviewerCfg,
          temperature: Number(reviewerCfg.temperature ?? mainTemp),
        })
      : mainLlm;
    reviewer = new LlmReviewStrategy(reviewerLlm);
  }

  // ---- Interpreter, workers, oracle, activation, error strategy --------
  const interpreter = new DagPlanInterpreter();

  const oracleName = coordCfg.stateOracle as string | undefined;
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
  const activation = resolveCoordinatorActivation(
    (coordCfg.activation ?? 'explicit') as string,
  );

  let errorStrategy: IErrorStrategy | undefined;
  const esCfg = coordCfg.errorStrategy as
    | { type?: string; maxReplans?: number }
    | undefined;
  if (esCfg?.type === 'replan') {
    errorStrategy = new ReplanErrorStrategy(planner, esCfg.maxReplans);
  } else if (esCfg?.type === 'abort') {
    errorStrategy = new AbortErrorStrategy();
  }

  // ---- Finalizer --------------------------------------------------------
  const finalizer = await buildFinalizer(
    coordCfg.finalizer as never,
    llmMap,
    pipelineFallback,
    async (lc) =>
      makeLlm({
        ...lc,
        temperature: Number(lc.temperature ?? mainTemp),
      }),
  );

  // ---- Oracle wrap ------------------------------------------------------
  const stateOracle = rawOracle
    ? new SubAgentStateOracle(rawOracle)
    : undefined;

  void mainLlm;
  void helperLlm;

  return {
    planner,
    interpreter,
    workers,
    activation,
    reviewer,
    errorStrategy,
    stateOracle,
    finalizer,
    maxRoundTrips: coordCfg.maxRoundTrips as number | undefined,
    oracleName,
  };
}
