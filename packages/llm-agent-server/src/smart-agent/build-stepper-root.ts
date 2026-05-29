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
  /** Named registry of subagent Steppers — used only for deep-stepper mode. */
  registry: ReadonlyMap<string, IStepper>;
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

  // ---- Per-role LLM resolver -----------------------------------------------
  // Priority chain: llmMap[role] → llmMap.main → pipelineFallback → STUB_LLM_CFG.
  // Mirrors the resolution chain used in buildDagCoordinatorDeps.
  const resolveRoleLlm = async (
    role: string,
    component: import('@mcp-abap-adt/llm-agent').LlmComponent,
  ): Promise<ILlm> => {
    const cfg =
      resolveLlmConfig(llmMap, role, pipelineFallback) ?? STUB_LLM_CFG;
    const inner = await makeLlm(cfg);
    if (!logLlmCall) return inner;
    // Wrap with LoggingLlm so every call to this role's LLM is logged to
    // byComponent. The decorator logs once per call after usage is known.
    return new LoggingLlm(inner, (usage, durationMs) => {
      logLlmCall({
        component,
        model: inner.model ?? cfg.model ?? 'unknown',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        durationMs,
      });
    });
  };

  // ---- Build per-role LLMs --------------------------------------------------
  const plannerLlm = await resolveRoleLlm('planner', 'planner');
  const executorLlm = await resolveRoleLlm('executor', 'tool-loop');
  const finalizerLlm = await resolveRoleLlm('finalizer', 'finalizer');
  const reviewerLlm = await resolveRoleLlm('reviewer', 'reviewer');

  // ---- Reviewer (always built; Stepper only invokes at configured depths) ---
  const reviewer: IReviewStrategy = new LlmReviewStrategy(reviewerLlm);

  // ---- Executor (the ReAct leaf for all modes) ------------------------------
  const executor = new CyclicReActExecutor({
    llm: executorLlm,
    callMcp,
    component: 'tool-loop',
    maxIterations: 10,
  });

  // One shared interpreter.
  const interpreter = new StepperInterpreter();

  // Shared token ledger — ONE instance per run (review R2-F1).
  const tokens = new TokenLedger(config.tokenBudget);

  // Depth budget depends on mode.
  let depthRemaining: number;
  let childSteppers: ReadonlyMap<string, IStepper>;

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
      // Wrap registry IStepper entries as child Steppers if they are Stepper
      // instances already; otherwise pass them through (IStepper-compatible).
      childSteppers = registry;
      break;
    }
    default: {
      // Exhaustive — parseStepperCoordinatorConfig already throws on unknown modes.
      depthRemaining = 1;
      childSteppers = new Map();
    }
  }

  // Planner: trivial single-node plan for cyclic-react; LlmStepperPlanner otherwise.
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
