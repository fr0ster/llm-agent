import {
  type IKnowledgeRagHandle,
  type ILlm,
  type IStepper,
  type IToolsRagHandle,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import {
  CyclicReActExecutor,
  LlmStepperPlanner,
  RootFinalizer,
  Stepper,
  StepperInterpreter,
} from '@mcp-abap-adt/llm-agent-libs';
import { parseStepperCoordinatorConfig } from './config.js';
import type { SmartServerLlmConfig } from './smart-server.js';

export interface BuildStepperRootInput {
  /** Raw coordinator config object (e.g. the `coordinator:` YAML block). */
  coordCfg: Record<string, unknown>;
  /** Named registry of subagent Steppers — used only for deep-stepper mode. */
  registry: ReadonlyMap<string, IStepper>;
  /** Factory to build an ILlm from a config; used for planner + finalizer. */
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>;
  /** Per-sessionId knowledge RAG factory. */
  knowledgeRagFor: (sessionId: string) => IKnowledgeRagHandle;
  /** Shared tools RAG handle. */
  toolsRag: IToolsRagHandle;
  /** MCP tool invoker. */
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Monotonically-unique stepper-ID minter. */
  mintStepperId: () => string;
  /** Optional LLM config to use for planner + finalizer (defaults to a stub). */
  llmConfig?: SmartServerLlmConfig;
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

/**
 * Assemble the root Stepper + finalizer from a coordinator config block.
 *
 * Three modes:
 *  - `cyclic-react`   → trivial single-node planner + CyclicReActExecutor leaf; depthRemaining=0.
 *  - `planned-react`  → LlmStepperPlanner + CyclicReActExecutor leaves; depthRemaining=1.
 *  - `deep-stepper`   → LlmStepperPlanner + registry child Steppers; depthRemaining=config.maxDepth.
 */
export async function buildStepperRoot(
  input: BuildStepperRootInput,
): Promise<BuiltStepperRoot> {
  const { coordCfg, registry, makeLlm, callMcp, mintStepperId, llmConfig } =
    input;

  const config = parseStepperCoordinatorConfig(coordCfg);

  // Build a placeholder LLM for planner/finalizer. When a real llmConfig is
  // provided, use it; otherwise fall back to the stub shape (callers in tests
  // pass makeLlm that returns a stub regardless of the config argument).
  const plannerLlm = await makeLlm(
    llmConfig ?? ({ provider: 'openai', apiKey: '', model: 'stub' } as never),
  );

  // One shared executor (the ReAct leaf for all modes).
  const executor = new CyclicReActExecutor({
    llm: plannerLlm,
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
    reviewerAtDepths: config.reviewerAtDepths,
    depth: 0,
    maxParallelSteps: config.maxParallelSteps,
    mintStepperId,
  });

  const finalizer = new RootFinalizer(plannerLlm);

  return {
    rootStepper,
    finalizer,
    budget: { depthRemaining, tokens },
    maxParallelSteps: config.maxParallelSteps,
    toolSafety: config.toolSafety,
  };
}
