import type {
  IMcpClient,
  IPipelineInstance,
  IPipelinePlugin,
  LlmTool,
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

    // Enumerate the INTERNAL (MCP) tool schemas once at build time. MCP tools are
    // stable post-connect (mirroring how the stepper/agent treat them), so we
    // gather them here and hand the executor a stable LlmTool[] — without this the
    // executor LLM never sees any tool schema and can never emit an internal call.
    const internalTools = await enumerateInternalTools(mcpClients, ctx.warn);

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
      internalTools,
      config: cfg,
    };

    const handler = new ControllerCoordinatorHandler(deps);
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}

/**
 * Enumerate the MCP tool schemas across every connected client and convert each
 * {@link McpTool} into an {@link LlmTool}. The two shapes are structurally
 * identical (`{ name, description, inputSchema }`), so the conversion is a plain
 * field copy. A client whose `listTools()` fails is logged and skipped — one bad
 * client must not abort the whole pipeline build.
 */
async function enumerateInternalTools(
  clients: IMcpClient[],
  warn: (msg: string) => void,
): Promise<LlmTool[]> {
  const tools: LlmTool[] = [];
  for (const client of clients) {
    const listed = await client.listTools();
    if (!listed.ok) {
      warn(
        `pipeline 'controller': skipping a client whose listTools() failed: ${listed.error.message}`,
      );
      continue;
    }
    for (const t of listed.value) {
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      });
    }
  }
  return tools;
}
