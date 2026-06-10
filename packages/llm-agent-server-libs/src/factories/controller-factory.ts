import type {
  BuiltCoordinator,
  CallOptions,
  IEmbedder,
  IKnowledgeRagHandle,
  IPipelineFactory,
  LlmTool,
  PipelineFactoryDepsBase,
} from '@mcp-abap-adt/llm-agent';
import type { KnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import { ControllerCoordinatorHandler } from '../smart-agent/controller/controller-coordinator-handler.js';
import { makeSubagentClient } from '../smart-agent/controller/subagent-client.js';
import type { ControllerConfig } from '../smart-agent/controller/types.js';

/**
 * Runtime dependencies for {@link ControllerFactory}. Like the Stepper factory
 * deps, it extends {@link PipelineFactoryDepsBase} — the three controller roles
 * ('evaluator' | 'planner' | 'executor') are resolved lazily via `makeRoleLlm`
 * and wrapped into subagent clients by the factory — and adds the handler's
 * run-time deps (knowledge backend/RAG, optional embedder, tool selection).
 */
export interface ControllerFactoryDeps extends PipelineFactoryDepsBase {
  /** Durable knowledge backend (session bundle + episodic artifacts). */
  backend: KnowledgeBackend;
  /** Per-sessionId knowledge RAG factory. */
  knowledgeRagFor: (
    sessionId: string,
  ) => IKnowledgeRagHandle | Promise<IKnowledgeRagHandle>;
  /** Required ONLY for distance-based target-state strategies
   *  (semantic-distance/auto); unused by consumer-confirm. */
  embedder?: IEmbedder;
  /** Semantic top-K tool selection over the vectorized MCP catalog. */
  selectTools: (
    query: string,
    k?: number,
    options?: CallOptions,
  ) => Promise<readonly LlmTool[]>;
  /** Optional override marking a tool as consumer-supplied (test-only). */
  isExternalTool?: (toolName: string) => boolean;
}

/**
 * Builder-factory for the `controller` pipeline — the code-level (no-YAML)
 * counterpart to the Stepper `*Factory` classes. Implements
 * {@link IPipelineFactory} (`kind: 'controller'`): it resolves the three role
 * LLMs via `makeRoleLlm`, wraps them as subagent clients, and assembles a
 * {@link ControllerCoordinatorHandler}, returning a {@link BuiltCoordinator}
 * (`{ handler }`) ready to attach via `builder.withStepperCoordinator(handler)`.
 *
 * @example
 * ```ts
 * import { ControllerFactory } from '@mcp-abap-adt/llm-agent-server-libs/controller';
 * const { handler } = await new ControllerFactory().build(config, {
 *   // role is typed as string by the base deps — resolve it explicitly.
 *   makeRoleLlm: (role) =>
 *     makeLlm(config.subagents[role as 'evaluator' | 'planner' | 'executor']),
 *   callMcp, backend, knowledgeRagFor, embedder, selectTools,
 * });
 * const handle = await builder.withStepperCoordinator(handler).build();
 * ```
 */
export class ControllerFactory
  implements IPipelineFactory<ControllerConfig, ControllerFactoryDeps>
{
  readonly kind = 'controller' as const;

  async build(
    config: ControllerConfig,
    deps: ControllerFactoryDeps,
  ): Promise<BuiltCoordinator> {
    // Distance-based target-state needs an embedder; fail loud at build time
    // rather than handing back a handler that dies on the first request.
    const { strategy } = config.targetState;
    if (
      (strategy === 'semantic-distance' || strategy === 'auto') &&
      !deps.embedder
    ) {
      throw new Error(
        `pipeline 'controller' targetState.strategy '${strategy}' requires an ` +
          'embedder (semantic distance); provide deps.embedder or use ' +
          'strategy: consumer-confirm',
      );
    }

    const [evaluatorLlm, plannerLlm, executorLlm] = await Promise.all([
      deps.makeRoleLlm('evaluator'),
      deps.makeRoleLlm('planner'),
      deps.makeRoleLlm('executor'),
    ]);

    const handler = new ControllerCoordinatorHandler({
      evaluator: makeSubagentClient(evaluatorLlm),
      planner: makeSubagentClient(plannerLlm),
      executor: makeSubagentClient(executorLlm),
      backend: deps.backend,
      knowledgeRagFor: deps.knowledgeRagFor,
      embedder: deps.embedder,
      callMcp: (name, args) => deps.callMcp(name, args),
      selectTools: deps.selectTools,
      ...(deps.isExternalTool ? { isExternalTool: deps.isExternalTool } : {}),
      config,
      models: {
        evaluator: evaluatorLlm.model ?? 'unknown',
        planner: plannerLlm.model ?? 'unknown',
        executor: executorLlm.model ?? 'unknown',
      },
    });
    return { handler };
  }
}
