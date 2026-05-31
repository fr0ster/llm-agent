import {
  type IKnowledgeRagHandle,
  type ILlm,
  type IReviewStrategy,
  type IStepper,
  type IStepperPlanner,
  type ITaskFormalizer,
  type LlmCallEntry,
  type PlanNode,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import {
  CyclicReActExecutor,
  LlmNeedResolver,
  LlmReviewStrategy,
  LlmStepperPlanner,
  LlmTaskFormalizer,
  LoggingLlm,
  RootFinalizer,
  StaticPlanner,
  Stepper,
  StepperInterpreter,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  type NormalizedLlmMap,
  parseStepperCoordinatorConfig,
  resolveLlmConfig,
  type StepperCompositionSpec,
  type StepperCoordinatorConfig,
} from './config.js';
import type { SmartServerLlmConfig } from './smart-server.js';

export interface BuildStepperRootInput {
  /** Raw coordinator config object (e.g. the `coordinator:` YAML block). */
  coordCfg: Record<string, unknown>;
  /**
   * Pre-built named registry of subagent Steppers — DI/test override for
   * deep-stepper mode. When non-empty it is used as childSteppers verbatim;
   * when empty, child Steppers are built from `subagents` (the normal path).
   */
  registry: ReadonlyMap<string, IStepper>;
  /**
   * Declared subagents (name + description) from the `subagents:` YAML block.
   * In deep-stepper mode each becomes a recursive child Stepper sharing this
   * run's planner/executor/reviewer/ledger, and is advertised to the planner so
   * it can delegate sub-goals via a node's `agent`. Ignored in other modes.
   */
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  /** Factory to build an ILlm from a config; used for all roles. */
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>;
  /** Per-sessionId knowledge RAG factory. */
  knowledgeRagFor: (sessionId: string) => IKnowledgeRagHandle;
  /** Shared tools RAG handle. */
  toolsRag: import('@mcp-abap-adt/llm-agent').IToolsRagHandle;
  /** MCP tool invoker. */
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Monotonically-unique stepper-ID minter. */
  mintStepperId: () => string;
  /**
   * Normalized per-role LLM map (top-level `llm:` block after normalization).
   * Roles resolve via: llmMap[role] → llmMap.main → pipelineFallback.
   * When both are undefined, roles fall back to a stub (test path).
   */
  llmMap?: NormalizedLlmMap;
  /**
   * Pipeline fallback config (`pipeline.llm.main`). Used as last resort when
   * a role is absent from llmMap.
   */
  pipelineFallback?: SmartServerLlmConfig;
  /**
   * Optional usage logger. When supplied, every per-role LLM call is logged
   * via a LoggingLlm decorator so byComponent is populated in requestLogger.
   * Matches IRequestLogger.logLlmCall(entry) — pass a bound wrapper that
   * injects the traceId as requestId.
   */
  logLlmCall?: (entry: LlmCallEntry) => void;
}

export interface BuiltStepperRoot {
  rootStepper: Stepper;
  finalizer: RootFinalizer;
  budget: { depthRemaining: number; tokens: TokenLedger };
  maxParallelSteps: number;
  toolSafety: {
    mutationPolicy: 'confirm' | 'trusted';
    knownReadOnlyTools: ReadonlySet<string>;
  };
  /**
   * Present only when `coordinator.formalizeTask` is enabled. The handler calls
   * it ONCE on the raw prompt and threads the resulting TaskSpec into
   * rootStepper.run. Absent → no formalization (behaves as before).
   */
  taskFormalizer?: ITaskFormalizer;
}

const STUB_LLM_CFG: SmartServerLlmConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'stub',
} as never;

// StepperCompositionSpec + CompositionNode are defined in config.ts (so the
// yaml parser can produce them without a circular import) and re-exported here
// as the build-time public surface.
export type { CompositionNode, StepperCompositionSpec } from './config.js';

/** Build-time dependencies (everything not part of the composition itself). */
export interface BuildFromCompositionDeps {
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>;
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<string>;
  mintStepperId: () => string;
  llmMap?: NormalizedLlmMap;
  pipelineFallback?: SmartServerLlmConfig;
  logLlmCall?: (entry: LlmCallEntry) => void;
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  registry: ReadonlyMap<string, IStepper>;
}

/** Map a parsed coordinator config to the front-end-agnostic composition spec. */
export function toCompositionSpec(
  config: StepperCoordinatorConfig,
): StepperCompositionSpec {
  return {
    planner: config.flow.planner,
    granularity: config.flow.granularity,
    ...(config.flow.plan ? { plan: config.flow.plan } : {}),
    ...(config.flow.nodes ? { nodes: config.flow.nodes } : {}),
    executor: config.flow.executor,
    finalizer: config.flow.finalizer,
    reviewerAtDepths: config.reviewerAtDepths,
    maxParallelSteps: config.maxParallelSteps,
    maxDepth: config.maxDepth,
    tokenBudget: config.tokenBudget,
    toolSafety: config.toolSafety,
    formalizeTask: config.formalizeTask,
  };
}

/**
 * yaml front-end: parse the raw coordinator config block → composition spec →
 * build. Thin wrapper over {@link buildFromComposition}; a code builder can call
 * buildFromComposition directly with a spec it constructs itself (parity).
 */
export async function buildStepperRoot(
  input: BuildStepperRootInput,
): Promise<BuiltStepperRoot> {
  const config = parseStepperCoordinatorConfig(input.coordCfg);
  return buildFromComposition(toCompositionSpec(config), {
    makeLlm: input.makeLlm,
    callMcp: input.callMcp,
    mintStepperId: input.mintStepperId,
    llmMap: input.llmMap,
    pipelineFallback: input.pipelineFallback,
    logLlmCall: input.logLlmCall,
    subagents: input.subagents,
    registry: input.registry,
  });
}

/**
 * Build the root Stepper + finalizer from a front-end-agnostic composition spec.
 * The yaml path reaches here via buildStepperRoot; a code builder can call this
 * directly. Each role LLM resolves via llmMap[role] → llmMap.main → fallback.
 */
export async function buildFromComposition(
  spec: StepperCompositionSpec,
  deps: BuildFromCompositionDeps,
): Promise<BuiltStepperRoot> {
  const {
    registry,
    makeLlm,
    callMcp,
    mintStepperId,
    llmMap,
    pipelineFallback,
    logLlmCall,
  } = deps;

  // Shared token ledger — ONE instance per run (review R2-F1). Created up-front
  // so every role's LLM decorator can spend on it (see resolveRoleLlm).
  const tokens = new TokenLedger(spec.tokenBudget);

  // ---- Per-role LLM resolver -----------------------------------------------
  // Priority chain: llmMap[role] → llmMap.main → pipelineFallback → STUB_LLM_CFG.
  // Mirrors the resolution chain used in buildDagCoordinatorDeps.
  //
  // `spendOnLedger` makes the role's LLM decrement the SHARED token ledger after
  // each call, so coordinator.stepper.tokenBudget bounds ALL stepper work — not
  // just the executor (review Finding 2). The executor passes `false`: it spends
  // on the same ledger itself (see CyclicReActExecutor) and double-counting must
  // be avoided. The decorator is now installed whenever EITHER logging or ledger
  // accounting is needed (previously it was skipped entirely without a logger).
  const resolveRoleLlm = async (
    role: string,
    component: import('@mcp-abap-adt/llm-agent').LlmComponent,
    spendOnLedger: boolean,
  ): Promise<ILlm> => {
    const cfg =
      resolveLlmConfig(llmMap, role, pipelineFallback) ?? STUB_LLM_CFG;
    const inner = await makeLlm(cfg);
    if (!logLlmCall && !spendOnLedger) return inner;
    // Wrap with LoggingLlm so every call to this role's LLM is (a) logged to
    // byComponent and (b) charged to the shared ledger. Fires once per call
    // (chat or streamChat) after usage is known.
    return new LoggingLlm(inner, (usage, durationMs) => {
      if (logLlmCall) {
        logLlmCall({
          component,
          model: inner.model ?? cfg.model ?? 'unknown',
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          durationMs,
        });
      }
      if (spendOnLedger) tokens.spend(usage);
    });
  };

  // ---- Build per-role LLMs --------------------------------------------------
  // Every non-executor role charges the shared ledger; the executor self-spends.
  const plannerLlm = await resolveRoleLlm('planner', 'planner', true);
  const executorLlm = await resolveRoleLlm('executor', 'tool-loop', false);
  const finalizerLlm = await resolveRoleLlm('finalizer', 'finalizer', true);
  const reviewerLlm = await resolveRoleLlm('reviewer', 'reviewer', true);
  // Tool-definer LLM: detects an unmet-tool-need ("I can't … no tool") in a
  // candidate final answer and yields the phrase to search toolsRag with before
  // the retry. Logged under its OWN component 'tool-definer' — NOT 'classifier'
  // — so its cost is distinct from the (skipped-in-stepper) request classifier
  // and the name reflects its actual job. Resolves via role 'classifier' (falls
  // back to main); point it at a small model via `llm.classifier` in YAML.
  const toolDefinerLlm = await resolveRoleLlm(
    'classifier',
    'tool-definer',
    true,
  );

  // ---- Reviewer (always built; Stepper only invokes at configured depths) ---
  const reviewer: IReviewStrategy = new LlmReviewStrategy(reviewerLlm);

  // One shared interpreter + need-resolver across the whole tree.
  const interpreter = new StepperInterpreter();
  const needResolver = new LlmNeedResolver(toolDefinerLlm);

  // Leaf executor per spec.executor profile (reuses the shared executor LLM +
  // need-resolver): 'simple' = single pass (maxIter 2); cyclic-react/recursive
  // run the full ReAct loop (maxIter 10).
  const makeExecutor = (execType: StepperCompositionSpec['executor']) =>
    new CyclicReActExecutor({
      llm: executorLlm,
      callMcp,
      component: 'tool-loop',
      maxIterations: execType === 'simple' ? 2 : 10,
      needResolver,
    });

  const trivialPlanner: IStepperPlanner = {
    name: 'trivial',
    async plan(inp) {
      return {
        objective: inp.prompt,
        nodes: [{ id: 'root', goal: inp.prompt }],
        createdAt: 0,
      };
    },
  };

  // Recursive composition builder. LLMs, token ledger, reviewer, interpreter are
  // SHARED across the whole tree (shared-ledger invariant); only the planner, the
  // executor profile and the childSteppers vary per (nested) spec.
  const buildNode = (s: StepperCompositionSpec, depth: number): Stepper => {
    const ex = makeExecutor(s.executor);
    const childMap = new Map<string, IStepper>();
    const nodes = s.nodes ?? [];

    // Planner selection. Declared `nodes` ⇒ static plan over them (nested nodes
    // carry agent=id so the interpreter routes them into their child Stepper).
    let planner: IStepperPlanner;
    if (nodes.length > 0) {
      const planNodes: PlanNode[] = nodes.map((n) => ({
        id: n.id,
        goal: n.goal,
        ...(n.dependsOn ? { dependsOn: n.dependsOn } : {}),
        ...(n.flow ? { agent: n.id } : {}),
      }));
      planner = new StaticPlanner(planNodes);
    } else if (s.planner === 'none') {
      planner = trivialPlanner;
    } else if (s.planner === 'static') {
      planner = new StaticPlanner(s.plan ?? []);
    } else {
      planner = new LlmStepperPlanner(plannerLlm, s.granularity);
    }

    // (a) Structural recursion: declared nested-flow nodes → child Steppers.
    for (const n of nodes) {
      if (n.flow) childMap.set(n.id, buildNode(n.flow, depth + 1));
    }

    // (b) Runtime subagent recursion (executor: recursive) — only when NO nested
    // nodes were declared; preserves the existing deep-stepper behaviour. Children
    // share this run's planner/executor/reviewer + role LLMs (shared ledger), and
    // point childSteppers back to the SAME map so recursion continues.
    let catalog: ReadonlyArray<{ name: string; description?: string }> = [];
    if (s.executor === 'recursive' && nodes.length === 0) {
      catalog = (deps.subagents ?? []).map((sa) => ({
        name: sa.name,
        description: sa.description,
      }));
      if (registry.size > 0) {
        for (const [k, v] of registry) childMap.set(k, v);
      } else {
        for (const sa of catalog) {
          childMap.set(
            sa.name,
            new Stepper({
              name: sa.name,
              planner,
              interpreter,
              executor: ex,
              childSteppers: childMap,
              reviewer,
              reviewerAtDepths: s.reviewerAtDepths,
              depth: depth + 1,
              maxParallelSteps: s.maxParallelSteps,
              mintStepperId,
              childAgentCatalog: catalog,
            }),
          );
        }
      }
    }

    return new Stepper({
      name: depth === 0 ? 'root' : `node-d${depth}`,
      planner,
      interpreter,
      executor: ex,
      childSteppers: childMap,
      reviewer,
      reviewerAtDepths: s.reviewerAtDepths,
      depth,
      maxParallelSteps: s.maxParallelSteps,
      mintStepperId,
      childAgentCatalog: catalog,
    });
  };

  const rootStepper = buildNode(spec, 0);

  // Depth budget covers BOTH declared nesting and runtime recursion.
  const nestingDepth = (s: StepperCompositionSpec): number => {
    const ds = (s.nodes ?? [])
      .filter((n) => n.flow)
      .map((n) => 1 + nestingDepth(n.flow as StepperCompositionSpec));
    return ds.length ? Math.max(...ds) : 0;
  };
  const anyRecursive = (s: StepperCompositionSpec): boolean =>
    s.executor === 'recursive' ||
    (s.nodes ?? []).some((n) => !!n.flow && anyRecursive(n.flow));
  const baseDepth =
    spec.executor === 'recursive'
      ? spec.maxDepth
      : spec.planner === 'none' && (spec.nodes?.length ?? 0) === 0
        ? 0
        : 1;
  const depthRemaining = Math.max(
    baseDepth,
    nestingDepth(spec),
    anyRecursive(spec) ? spec.maxDepth : 0,
  );

  const finalizer = new RootFinalizer(finalizerLlm);

  // Task formalizer (opt-in): uses the strong planner-tier LLM to produce a
  // compact TaskSpec once at the root. Built only when configured.
  const taskFormalizer = spec.formalizeTask
    ? new LlmTaskFormalizer(plannerLlm)
    : undefined;

  return {
    rootStepper,
    finalizer,
    budget: { depthRemaining, tokens },
    maxParallelSteps: spec.maxParallelSteps,
    toolSafety: spec.toolSafety,
    ...(taskFormalizer ? { taskFormalizer } : {}),
  };
}
