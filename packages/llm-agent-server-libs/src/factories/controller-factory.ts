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
import { LlmFinalizer } from '../smart-agent/controller/finalizer.js';
import { LlmReviewer } from '../smart-agent/controller/reviewer.js';
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
    // results-RAG recall is embedding-based in EVERY persistence mode → require an
    // embedder AND a semantic-recall-capable backend. The embedder alone is not
    // enough: a programmatic caller could pass an embedder PLUS a plain backend with
    // no index, and recall would silently degrade to insertion order. Assert BOTH at
    // the controller boundary, fail loud at build time.
    if (!deps.embedder) {
      throw new Error(
        "pipeline 'controller' requires an embedder: results-RAG recall ranks by " +
          'embedding similarity (and distance target-state, if used). Provide deps.embedder.',
      );
    }
    if (!deps.backend.semanticRecallCapable) {
      throw new Error(
        "pipeline 'controller' requires a semantic-recall-capable knowledge backend " +
          '(one built with an embedder-backed index); the injected backend reports ' +
          'semanticRecallCapable=false, so recall would degrade to insertion order. ' +
          'Build the backend via buildKnowledgeBackend (with a resolved embedder) or ' +
          'inject a semantic-capable one.',
      );
    }

    const [evaluatorLlm, plannerLlm, executorLlm] = await Promise.all([
      deps.makeRoleLlm('evaluator'),
      deps.makeRoleLlm('planner'),
      deps.makeRoleLlm('executor'),
    ]);
    // reviewer/finalizer default to the planner's LLM when their subagent config is
    // absent (3-role config); the factory only resolves a distinct role LLM when the
    // subagent block is present, so a 3-role config needs no resolver change.
    const reviewerLlm = config.subagents.reviewer
      ? await deps.makeRoleLlm('reviewer')
      : plannerLlm;
    const finalizerLlm = config.subagents.finalizer
      ? await deps.makeRoleLlm('finalizer')
      : plannerLlm;

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
      reviewer: new LlmReviewer(makeSubagentClient(reviewerLlm)),
      finalizer: new LlmFinalizer(makeSubagentClient(finalizerLlm), {
        budget: 12000,
        perResultCap: 4000,
      }),
      config,
      models: {
        evaluator: evaluatorLlm.model ?? 'unknown',
        planner: plannerLlm.model ?? 'unknown',
        executor: executorLlm.model ?? 'unknown',
        reviewer: reviewerLlm.model ?? 'unknown',
        finalizer: finalizerLlm.model ?? 'unknown',
      },
    });
    return { handler };
  }
}
