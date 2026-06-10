import type {
  CallOptions,
  IPipelineInstance,
  IPipelinePlugin,
} from '@mcp-abap-adt/llm-agent';
import {
  ControllerFactory,
  type ControllerFactoryDeps,
} from '../factories/controller-factory.js';
import type { ControllerConfig } from '../smart-agent/controller/types.js';
import { buildMcpBridge } from '../smart-agent/smart-server.js';
import type { IControllerServerPipelineContext } from './server-context.js';

// Re-export the controller building blocks so embedders (no-YAML) can compose
// the coordinator in code — preferably via the `ControllerFactory`
// (`const { handler } = await new ControllerFactory().build(config, deps)` then
// `builder.withStepperCoordinator(handler)`), or directly with the handler.
export {
  ControllerFactory,
  type ControllerFactoryDeps,
} from '../factories/controller-factory.js';
export {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../smart-agent/controller/controller-coordinator-handler.js';
export {
  type ISubagentClient,
  makeSubagentClient,
} from '../smart-agent/controller/subagent-client.js';
export type {
  ControllerConfig,
  SessionBundle,
} from '../smart-agent/controller/types.js';

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
      planner: (cfg.planner === 'adaptive'
        ? 'adaptive'
        : 'incremental') as ControllerConfig['planner'],
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
    const mcpClients = ctx.mcpClients ?? [];
    const mcpBridge = buildMcpBridge(mcpClients);

    // INTERNAL tools reach the executor/planner via SEMANTIC selection over the
    // vectorized MCP catalog (toolsRag) — relevant top-K per query, not a full
    // dump. The server vectorizes every MCP `tool:<name>` into toolsRag at
    // startup. When no toolsRag is wired (MCP-less / no embedder) selection
    // yields [] and the loop runs with external tools only.
    const toolsRag = ctx.toolsRag;
    const selectTools = (query: string, k?: number, options?: CallOptions) =>
      toolsRag ? toolsRag.query(query, k, options) : Promise.resolve([]);

    // The factory resolves the three role LLMs via makeRoleLlm, wraps them as
    // subagent clients, validates the embedder requirement, and builds the
    // handler. external-tool routing is decided PER-REQUEST inside the handler
    // from `ctx.externalTools`, so we do NOT wire `isExternalTool` here.
    const deps: ControllerFactoryDeps = {
      makeRoleLlm: (role) =>
        ctx.makeLlm(
          cfg.subagents[role as 'evaluator' | 'planner' | 'executor'],
        ),
      callMcp: (name, args) => mcpBridge(name, args),
      backend: ctx.stepperKnowledgeBackend,
      knowledgeRagFor: (sessionId) => ctx.knowledgeRagFor(sessionId),
      embedder: ctx.embedder,
      selectTools,
    };

    const { handler } = await new ControllerFactory().build(cfg, deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
