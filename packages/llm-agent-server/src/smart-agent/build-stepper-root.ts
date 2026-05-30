import {
  type IKnowledgeRagHandle,
  type ILlm,
  type IReviewStrategy,
  type IStepper,
  type LlmCallEntry,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import {
  CyclicReActExecutor,
  LlmNeedResolver,
  LlmReviewStrategy,
  LlmStepperPlanner,
  LoggingLlm,
  RootFinalizer,
  Stepper,
  StepperInterpreter,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  type NormalizedLlmMap,
  parseStepperCoordinatorConfig,
  resolveLlmConfig,
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
}

const STUB_LLM_CFG: SmartServerLlmConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'stub',
} as never;

/**
 * Assemble the root Stepper + finalizer from a coordinator config block.
 *
 * Three modes:
 *  - `cyclic-react`   → trivial single-node planner + CyclicReActExecutor leaf; depthRemaining=0.
 *  - `planned-react`  → LlmStepperPlanner + CyclicReActExecutor leaves; depthRemaining=1.
 *  - `deep-stepper`   → LlmStepperPlanner + registry child Steppers; depthRemaining=config.maxDepth.
 *
 * Each role (planner, executor, reviewer, finalizer) is resolved from the
 * per-role LLM map via the chain: llmMap[role] → llmMap.main → pipelineFallback.
 * This mirrors the 17.0 buildDagCoordinatorDeps resolution chain exactly.
 */
export async function buildStepperRoot(
  input: BuildStepperRootInput,
): Promise<BuiltStepperRoot> {
  const {
    coordCfg,
    registry,
    makeLlm,
    callMcp,
    mintStepperId,
    llmMap,
    pipelineFallback,
    logLlmCall,
  } = input;

  const config = parseStepperCoordinatorConfig(coordCfg);

  // Shared token ledger — ONE instance per run (review R2-F1). Created up-front
  // so every role's LLM decorator can spend on it (see resolveRoleLlm).
  const tokens = new TokenLedger(config.tokenBudget);

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

  // ---- Executor (the ReAct leaf for all modes) ------------------------------
  const executor = new CyclicReActExecutor({
    llm: executorLlm,
    callMcp,
    component: 'tool-loop',
    maxIterations: 10,
    // Always-on context-augmenting ReAct: on a no-tool-call answer the executor
    // asks this classifier whether the model expressed an unmet-tool need; if so
    // it re-queries toolsRag and retries with the augmented tool set.
    needResolver: new LlmNeedResolver(toolDefinerLlm),
  });

  // One shared interpreter.
  const interpreter = new StepperInterpreter();

  // Planner: trivial single-node plan for cyclic-react; LlmStepperPlanner
  // otherwise. Built BEFORE the mode switch so deep-stepper can reuse the SAME
  // planner instance for its child Steppers.
  const planner =
    config.mode === 'cyclic-react'
      ? {
          name: 'trivial' as const,
          async plan(inp: { prompt: string }) {
            return {
              objective: inp.prompt,
              nodes: [{ id: 'root', goal: inp.prompt }],
              createdAt: 0,
            };
          },
        }
      : new LlmStepperPlanner(plannerLlm);

  // Depth budget + child Steppers depend on mode.
  let depthRemaining: number;
  let childSteppers: ReadonlyMap<string, IStepper>;
  // Worker catalog the ROOT planner advertises (deep-stepper only).
  let rootCatalog: ReadonlyArray<{ name: string; description?: string }> = [];

  switch (config.mode) {
    case 'cyclic-react': {
      // No recursion at all: depth=0 → interpreter always routes to executor leaf.
      depthRemaining = 0;
      childSteppers = new Map();
      break;
    }
    case 'planned-react': {
      // One level of planning; leaves execute via CyclicReActExecutor.
      depthRemaining = 1;
      childSteppers = new Map();
      break;
    }
    case 'deep-stepper': {
      depthRemaining = config.maxDepth;
      const catalog = (input.subagents ?? []).map((s) => ({
        name: s.name,
        description: s.description,
      }));
      rootCatalog = catalog;
      if (registry.size > 0) {
        // DI/test override: use the supplied registry verbatim.
        childSteppers = registry;
      } else {
        // Build one recursive child Stepper per declared subagent, sharing this
        // run's planner / interpreter / executor / reviewer and — crucially —
        // the SAME role LLMs, so every child charges the ONE shared token ledger
        // (review Finding 2). Each child's childSteppers points back to the SAME
        // map so recursion continues, bounded by depthRemaining (decremented at
        // each dispatch in the interpreter).
        const childMap = new Map<string, IStepper>();
        for (const s of catalog) {
          childMap.set(
            s.name,
            new Stepper({
              name: s.name,
              planner,
              interpreter,
              executor,
              childSteppers: childMap,
              reviewer,
              reviewerAtDepths: config.reviewerAtDepths,
              depth: 1,
              maxParallelSteps: config.maxParallelSteps,
              mintStepperId,
              childAgentCatalog: catalog,
            }),
          );
        }
        childSteppers = childMap;
      }
      break;
    }
    default: {
      // Exhaustive — parseStepperCoordinatorConfig already throws on unknown modes.
      depthRemaining = 1;
      childSteppers = new Map();
    }
  }

  const rootStepper = new Stepper({
    name: 'root',
    planner,
    interpreter,
    executor,
    childSteppers,
    reviewer,
    reviewerAtDepths: config.reviewerAtDepths,
    depth: 0,
    maxParallelSteps: config.maxParallelSteps,
    mintStepperId,
    childAgentCatalog: rootCatalog,
  });

  const finalizer = new RootFinalizer(finalizerLlm);

  return {
    rootStepper,
    finalizer,
    budget: { depthRemaining, tokens },
    maxParallelSteps: config.maxParallelSteps,
    toolSafety: config.toolSafety,
  };
}
