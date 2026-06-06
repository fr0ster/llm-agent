import type {
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../smart-agent/controller/controller-coordinator-handler.js';
import { makeSubagentClient } from '../smart-agent/controller/subagent-client.js';
import type { ControllerConfig } from '../smart-agent/controller/types.js';
import { buildMcpBridge } from '../smart-agent/smart-server.js';
import type { IControllerServerPipelineContext } from './server-context.js';

/**
 * Built-in `controller` pipeline plugin. Validates the controller config
 * dialect (three required subagent roles + defaulted target-state / session
 * memory / budgets), wires the {@link ControllerCoordinatorHandler} from the
 * server pipeline context, registers it on a fresh agent builder, and returns
 * the runnable agent plus a disposal hook.
 */
export class ControllerPipelinePlugin
  implements IPipelinePlugin<ControllerConfig>
{
  readonly name = 'controller';

  parseConfig(raw: unknown): ControllerConfig {
    const cfg = (raw ?? {}) as Record<string, unknown>;
    const subagents = (cfg.subagents ?? {}) as Record<string, unknown>;
    for (const role of ['evaluator', 'planner', 'executor'] as const) {
      if (subagents[role] === undefined) {
        throw new Error(
          `pipeline 'controller' requires 'subagents.${role}' (each an LLM config with at least a 'provider')`,
        );
      }
    }

    const targetStateRaw = (cfg.targetState ?? {}) as Record<string, unknown>;
    const sessionMemoryRaw = (cfg.sessionMemory ?? {}) as Record<
      string,
      unknown
    >;
    const budgetsRaw = (cfg.budgets ?? {}) as Record<string, unknown>;

    return {
      subagents: subagents as ControllerConfig['subagents'],
      targetState: {
        strategy: 'auto',
        distanceThreshold: 0.25,
        ...targetStateRaw,
      } as ControllerConfig['targetState'],
      sessionMemory: {
        collection: 'session-memory',
        ...sessionMemoryRaw,
      } as ControllerConfig['sessionMemory'],
      budgets: {
        maxSteps: 20,
        maxRetries: 3,
        maxRewinds: 5,
        maxToolCalls: 10,
        ...budgetsRaw,
      } as ControllerConfig['budgets'],
    };
  }

  async build(
    cfg: ControllerConfig,
    ctx: IControllerServerPipelineContext,
  ): Promise<IPipelineInstance> {
    // Embedder is only needed for distance-based target-state strategies.
    // consumer-confirm needs none, so an embedder-less deployment can use it.
    const needsEmbedder =
      cfg.targetState.strategy === 'semantic-distance' ||
      cfg.targetState.strategy === 'auto';
    if (needsEmbedder && !ctx.embedder) {
      throw new Error(
        `pipeline 'controller' targetState.strategy '${cfg.targetState.strategy}' requires an embedder (semantic distance); configure rag.embedder or use strategy: consumer-confirm`,
      );
    }

    const [evaluatorLlm, plannerLlm, executorLlm] = await Promise.all([
      ctx.makeLlm(cfg.subagents.evaluator),
      ctx.makeLlm(cfg.subagents.planner),
      ctx.makeLlm(cfg.subagents.executor),
    ]);

    const mcpClients = ctx.mcpClients ?? [];
    const mcpBridge = buildMcpBridge(mcpClients);

    // INTERNAL tools reach the executor/planner via SEMANTIC selection over the
    // vectorized MCP catalog (toolsRag) — relevant top-K per query, not a full
    // dump. The server vectorizes every MCP `tool:<name>` into toolsRag at
    // startup. When no toolsRag is wired (MCP-less / no embedder) selection
    // yields [] and the loop runs with external tools only.
    const toolsRag = ctx.toolsRag;
    const selectTools = (query: string, k?: number) =>
      toolsRag ? toolsRag.query(query, k) : Promise.resolve([]);

    // NOTE: external-tool routing is decided PER-REQUEST inside the handler from
    // `ctx.externalTools` (the client-supplied tools for that request). We do NOT
    // wire `isExternalTool` here — the build-time server ctx never carries them.
    const deps: ControllerHandlerDeps = {
      evaluator: makeSubagentClient(evaluatorLlm),
      planner: makeSubagentClient(plannerLlm),
      executor: makeSubagentClient(executorLlm),
      backend: ctx.stepperKnowledgeBackend,
      knowledgeRagFor: (sessionId) => ctx.knowledgeRagFor(sessionId),
      embedder: ctx.embedder,
      callMcp: (name, args) => mcpBridge(name, args),
      selectTools,
      config: cfg,
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
