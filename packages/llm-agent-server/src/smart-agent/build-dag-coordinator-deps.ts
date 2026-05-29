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
  resolveLlmConfigStrict,
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

  // ---- Role LLM resolver -----------------------------------------------
  // Priority chain:
  //   1. map[name] — explicit named entry in the top-level llm: block
  //   2. 'helper' | 'planner' alias — route to the prebuilt helperLlm
  //   3. pipelineFallback (pipeline.llm.main) — last resort
  //   4. fallbackPrebuilt (mainLlm) — when nothing else resolves
  const resolveRoleLlm = async (
    name: string | undefined,
    fallbackPrebuilt: ILlm = mainLlm,
  ): Promise<ILlm> => {
    // 1. Explicit map[name] — use it (strict: no main fallback here).
    const strict = resolveLlmConfigStrict(llmMap, name);
    if (strict) {
      return makeLlm({
        ...strict,
        temperature: Number(strict.temperature ?? mainTemp),
      });
    }
    // 2. 'helper' | 'planner' alias → reuse prebuilt helperLlm.
    if (name === 'helper' || name === 'planner') {
      return helperLlm ?? fallbackPrebuilt;
    }
    // 3. Unknown name → final fallback chain via resolveLlmConfig (map.main → pipelineFallback).
    if (name) {
      const fb = resolveLlmConfig(llmMap, name, pipelineFallback);
      if (fb) {
        return makeLlm({
          ...fb,
          temperature: Number(fb.temperature ?? mainTemp),
        });
      }
    }
    // 4. No name at all → fallbackPrebuilt (mainLlm by default).
    return fallbackPrebuilt;
  };

  // ---- Planner ----------------------------------------------------------
  const plannerBlock = coordCfg.planner as {
    type?: string;
    plannerLlm?: string;
  };
  const plannerLlm = await resolveRoleLlm(plannerBlock?.plannerLlm);
  const planner = new LlmDagPlanner(plannerLlm);

  // ---- Reviewer (optional) ---------------------------------------------
  let reviewer: IReviewStrategy | undefined;
  if (coordCfg.reviewer !== undefined) {
    const reviewerBlock = coordCfg.reviewer as {
      reviewerLlm?: string;
      plannerLlm?: string;
    };
    const reviewerName = resolveReviewerLlmName(reviewerBlock, warn);
    const reviewerLlm = await resolveRoleLlm(reviewerName);
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
