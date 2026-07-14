import type {
  CallOptions,
  IKnowledgeRagHandle,
  IPipelineInstance,
  IPipelinePlugin,
  KnowledgeEntryMetadata,
  ToolLoopContextStrategyFactory,
} from '@mcp-abap-adt/llm-agent';
import { RagRecallContextStrategy } from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerFactory,
  type ControllerFactoryDeps,
} from '../factories/controller-factory.js';
import { writeArtifact } from '../smart-agent/controller/memorizer.js';
import {
  buildRecallBlock,
  RECALL_K_MCP,
  RECALL_MAX_CHARS_MCP,
  runScopedRecall,
} from '../smart-agent/controller/recall.js';
import type {
  ControllerConfig,
  PlannerKind,
} from '../smart-agent/controller/types.js';
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
  readonly name: string;
  private readonly plannerKind: PlannerKind;
  constructor(
    name = 'controller',
    plannerKind: PlannerKind = 'smart-executor',
  ) {
    this.name = name;
    this.plannerKind = plannerKind;
  }

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

    if ('planner' in (cfg as Record<string, unknown>)) {
      throw new Error(
        'controller: `planner:` removed — capability is preset-encoded. Select ' +
          'pipeline: { name: controller } (smart-executor) or ' +
          '{ name: controller-weak } (weak-executor), or pass the kind to ' +
          '`new ControllerFactory().build(config, deps, "weak-executor")` when ' +
          'composing in code. No `planner:` alias exists.',
      );
    }

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
        maxDigestChars: 500,
        maxIntentChars: 120,
        maxActiveSteps: 16,
        maxBoardChars: 12000,
        keepRecentDigests: 8,
        ...budgetsRaw,
      } as ControllerConfig['budgets'],
    };
  }

  async build(
    cfg: ControllerConfig,
    ctx: IControllerServerPipelineContext,
  ): Promise<IPipelineInstance> {
    const mcpClients = ctx.mcpClients ?? [];
    // Honor the consumer-injected MCP failure classifier on the `pipeline: controller`
    // path (ctx carries it from SmartServer/builder DI). Without this the bridge would
    // silently fall back to DefaultMcpFailureClassifier and a custom policy (e.g. mapping
    // an otherwise-tool-level code to 'unavailable') would be lost for the controller.
    const mcpBridge = buildMcpBridge(mcpClients, ctx.mcpFailureClassifier);

    // INTERNAL tools reach the executor/planner via SEMANTIC selection over the
    // vectorized MCP catalog (toolsRag) — relevant top-K per query, not a full
    // dump. The server vectorizes every MCP `tool:<name>` into toolsRag at
    // startup. When no toolsRag is wired (MCP-less / no embedder) selection
    // yields [] and the loop runs with external tools only.
    const toolsRag = ctx.toolsRag;
    const selectTools = (query: string, k?: number, options?: CallOptions) =>
      toolsRag ? toolsRag.query(query, k, options) : Promise.resolve([]);

    // Controller-OWN skills recall hook (B4). The controller pipeline builds its
    // subagent prompts itself (it does NOT use the context-assembler), so it needs
    // its own recall: query the configured controller skill group and format a
    // bounded "Relevant skills" block the planner injects into create-plan/replan.
    // Wired ONLY when a host AND a controller group are present; otherwise left
    // undefined so the planner prompt stays byte-identical to the agnostic path.
    // `controllerSkillGroup` is an INDEPENDENT channel from `serveCollections`
    // (assembler pipelines); the group's existence is validated at startup, so we
    // gate purely on host + group presence and do NOT couple to serveCollections.
    const skillHost = ctx.skillHost;
    const group = ctx.skillRecall?.controllerSkillGroup;
    // Resolve the recall handle ONCE (the host memoises it anyway; this is the
    // correct shape — no per-recall rag(group) lookup, and the wrapper's dimension/
    // verdict cache is shared across recalls).
    const skillRagHandle =
      skillHost && group ? skillHost.rag(group) : undefined;
    const skillsRecall = skillRagHandle
      ? async (goal: string, options?: CallOptions): Promise<string> => {
          const k = ctx.skillRecall?.k ?? 4;
          const maxInjectChars = ctx.skillRecall?.maxInjectChars ?? 4000;
          const queryOpts =
            ctx.skillRecall?.threshold !== undefined
              ? { k, threshold: ctx.skillRecall.threshold }
              : { k };
          const hits = await skillRagHandle.query(goal, queryOpts, options);
          if (hits.length === 0) {
            // Make skill engagement verifiable: an empty recall means the planner
            // prompt is byte-identical to the agnostic path (no skills injected).
            if (process.env.DEBUG_CONTROLLER)
              console.error(
                `[controller] skills-recall group=${group} hits=0 injected=0 chars=0 (empty — no skills in plan)`,
              );
            return '';
          }
          let block = 'Relevant skills:\n';
          let injected = 0;
          for (const h of hits) {
            const next = `${block}- ${h.record.content}\n`;
            if (next.length > maxInjectChars) break;
            block = next;
            injected++;
          }
          const out = block.trimEnd();
          // The recall block is built in-memory and never persisted, so without
          // this line there is no way to confirm skills actually reached the plan.
          if (process.env.DEBUG_CONTROLLER)
            console.error(
              `[controller] skills-recall group=${group} hits=${hits.length} injected=${injected} chars=${out.length}`,
            );
          return out;
        }
      : undefined;

    // Per-step tool-loop context strategy: RagRecall. The handler calls this
    // factory ONCE PER STEP, passing the per-step run context
    // (`{ rag, runId, meta, stepName }`) — meta/stepName are only known inside
    // runStep. `record` persists the round as an `mcp-result` artifact (the write
    // the handler used to do inline); `recall` runs the run-scoped MCP recall and
    // formats a bounded "Relevant prior context" block, excluding the raw-tail
    // round (which form() re-injects verbatim) by roundId.
    //
    // Run-scoped over-fetch bound (kPrime): a generous derivation from the
    // controller budgets (steps × attempts × tool-calls) mirroring the prior
    // inline `maxSteps * maxAttempts * maxTool`. maxStepAttempts is not on the
    // pipeline budgets here, so `maxRetries + 1` stands in for per-step attempts.
    const b = cfg.budgets;
    const mcpBound =
      (b.maxSteps ?? 20) * ((b.maxRetries ?? 3) + 1) * (b.maxToolCalls ?? 10);
    const toolLoopContextStrategyFactory: ToolLoopContextStrategyFactory = ({
      run,
    }) => {
      const { rag, runId, meta, stepName } = run as {
        rag: IKnowledgeRagHandle;
        runId: string;
        meta: KnowledgeEntryMetadata;
        stepName: string;
      };
      return new RagRecallContextStrategy(
        {
          // Mirror the removed inline mcp-result write. Write `roundId` as its OWN
          // metadata field so recall can exclude the raw-tail round by roundId;
          // `identityKey` stays tool+args (fetch dedup) and is a DIFFERENT key.
          record: (round, options) =>
            writeArtifact(
              rag,
              {
                ...meta,
                artifactType: 'mcp-result',
                task: stepName,
                runId,
                identityKey: round.meta?.[0]?.identityKey ?? round.roundId,
                roundId: round.roundId,
                content: round.results
                  .map((r) => String(r.content ?? ''))
                  .join('\n'),
              },
              options,
            ),
          recall: async (queryText, excludeRoundIds, options) => {
            const rows = await runScopedRecall(
              rag,
              queryText,
              RECALL_K_MCP,
              runId,
              mcpBound,
              ['mcp-result'],
              options,
            );
            return (
              buildRecallBlock(
                rows.filter(
                  (r) => !excludeRoundIds.includes(String(r.metadata?.roundId)),
                ),
                RECALL_MAX_CHARS_MCP,
              ) ?? ''
            );
          },
        },
        { runId },
      );
    };

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
      ...(skillsRecall ? { skillsRecall } : {}),
      toolLoopContextStrategyFactory,
    };

    const { handler } = await new ControllerFactory().build(
      cfg,
      deps,
      this.plannerKind,
    );
    const builder = await ctx.createAgentBuilder();
    const handle = await builder.withStepperCoordinator(handler).build();
    return { agent: handle.agent, close: () => handle.close() };
  }
}
