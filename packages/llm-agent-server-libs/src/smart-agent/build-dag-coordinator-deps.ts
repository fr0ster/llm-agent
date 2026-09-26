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
  type FinalizerYaml,
  resolveCoordinatorActivation,
  resolveReviewerLlmName,
} from './config.js';

export interface BuildDagCoordinatorDepsInput {
  coordCfg: Record<string, unknown> | undefined;
  registry: ReadonlyMap<string, ISubAgent>;
  /** The role's default — asked when the section names no key for it. */
  resolveLlm: (role: string) => Promise<ILlm>;
  /** Strict — asked for a key the section named; rejects naming a key with no entry. */
  resolveNamedLlm: (key: string) => Promise<ILlm>;
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
 * Assemble the deps record for `withDagCoordinator`. Returns `undefined` when the
 * section declares no DAG coordinator (no `planner` block).
 *
 * Each role's LLM is ASKED for, never built: a key the section names goes to
 * `resolveNamedLlm`, an omitted one to `resolveLlm(<role>)` (§4.6.6, §4.6.7).
 */
export async function buildDagCoordinatorDeps(
  input: BuildDagCoordinatorDepsInput,
): Promise<BuiltDagCoordinatorDeps | undefined> {
  const { coordCfg, registry, resolveLlm, resolveNamedLlm, warn } = input;
  if (!coordCfg || coordCfg.planner === undefined) return undefined;

  const llmFor = (key: string | undefined, role: string): Promise<ILlm> =>
    key ? resolveNamedLlm(key) : resolveLlm(role);

  // ---- Planner ----------------------------------------------------------
  const plannerBlock = coordCfg.planner as { plannerLlm?: string } | undefined;
  const planner = new LlmDagPlanner(
    await llmFor(plannerBlock?.plannerLlm, 'planner'),
  );

  // ---- Reviewer (optional) ---------------------------------------------
  let reviewer: IReviewStrategy | undefined;
  if (coordCfg.reviewer !== undefined) {
    const reviewerBlock = coordCfg.reviewer as {
      reviewerLlm?: string;
      plannerLlm?: string;
    };
    const reviewerName = resolveReviewerLlmName(reviewerBlock, warn);
    reviewer = new LlmReviewStrategy(await llmFor(reviewerName, 'reviewer'));
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
  const finalizerBlock = coordCfg.finalizer as FinalizerYaml | undefined;
  const finalizer = await buildFinalizer(finalizerBlock, () =>
    llmFor(finalizerBlock?.finalizerLlm, 'finalizer'),
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
    maxRoundTrips: coordCfg.maxRoundTrips as number | undefined,
    oracleName,
  };
}
