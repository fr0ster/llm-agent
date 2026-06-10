import type {
  BuiltCoordinator,
  IKnowledgeRagHandle,
  IPipelineFactory,
  IStepper,
  IToolsRagHandle,
  LlmCallEntry,
  PipelineFactoryDepsBase,
} from '@mcp-abap-adt/llm-agent';
import {
  buildFromComposition,
  type StepperCompositionSpec,
} from '../smart-agent/build-stepper-root.js';
import { StepperCoordinatorHandler } from '../smart-agent/stepper-coordinator-handler.js';

/**
 * Runtime dependencies for the Stepper builder-factories. Richer than
 * {@link PipelineFactoryDepsBase}: the Stepper coordinator handler also needs the
 * per-session knowledge RAG factory, the shared tools RAG handle, ID minters,
 * and (optionally) a subagent catalog / pre-built child Stepper registry and a
 * per-call usage logger.
 */
export interface StepperFactoryDeps extends PipelineFactoryDepsBase {
  /** Per-sessionId knowledge RAG factory (run-time handler dep). */
  knowledgeRagFor: (sessionId: string) => Promise<IKnowledgeRagHandle>;
  /** Shared tools RAG handle (run-time handler dep). */
  toolsRag: IToolsRagHandle;
  /** Monotonically-unique stepper-ID minter. */
  mintStepperId: () => string;
  /** Per-request turn-ID minter. */
  mintTurnId: () => string;
  /** Declared subagents (name + description) for deep-stepper recursion. */
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  /** Pre-built named registry of child Steppers (DI/test override). */
  registry?: ReadonlyMap<string, IStepper>;
  /** Optional per-role LLM usage logger. */
  logLlmCall?: (entry: LlmCallEntry) => void;
}

/**
 * The caller supplies everything in the spec EXCEPT the {planner,executor}
 * preset, which each factory bakes in.
 */
export type StepperFactoryConfig = Omit<
  StepperCompositionSpec,
  'planner' | 'executor'
>;

/**
 * Shared builder: wires a {@link StepperCoordinatorHandler} whose `buildBuilt`
 * defers to {@link buildFromComposition} with the role-LLM resolution path.
 * `knowledgeRagFor`/`toolsRag` are HANDLER deps used at run time, not build deps.
 */
export async function buildStepperCoordinator(
  spec: StepperCompositionSpec,
  deps: StepperFactoryDeps,
): Promise<BuiltCoordinator> {
  const handler = new StepperCoordinatorHandler({
    buildBuilt: async (_ctx, logLlmCall) =>
      buildFromComposition(spec, {
        makeRoleLlm: deps.makeRoleLlm,
        callMcp: deps.callMcp,
        mintStepperId: deps.mintStepperId,
        registry: deps.registry ?? new Map(),
        logLlmCall,
        ...(deps.subagents ? { subagents: deps.subagents } : {}),
      }),
    knowledgeRagFor: deps.knowledgeRagFor,
    toolsRag: deps.toolsRag,
    mintStepperId: deps.mintStepperId,
    mintTurnId: deps.mintTurnId,
  });
  return { handler };
}

/**
 * Cyclic Stepper variant: no planner, a single cyclic-ReAct executor loop.
 * Preset: `{ planner: 'none', executor: 'cyclic-react' }`.
 */
export class CyclicFactory
  implements IPipelineFactory<StepperFactoryConfig, StepperFactoryDeps>
{
  readonly kind = 'cyclic' as const;

  build(
    config: StepperFactoryConfig,
    deps: StepperFactoryDeps,
  ): Promise<BuiltCoordinator> {
    return buildStepperCoordinator(
      { ...config, planner: 'none', executor: 'cyclic-react' },
      deps,
    );
  }
}
