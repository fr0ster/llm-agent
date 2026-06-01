import {
  type IKnowledgeRagHandle,
  InsufficientSignal,
  type ISpan,
  type IStageHandler,
  type IStepperResult,
  type IToolsRagHandle,
  type LlmCallEntry,
  type LlmUsage,
  NeedInfoSignal,
  type RequestSummary,
  type RunIdentity,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import type { BuiltStepperRoot } from './build-stepper-root.js';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Mirror of llm-agent-libs summaryToUsage — sums byComponent into a flat triple. */
function summaryToUsage(s: RequestSummary): LlmUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const v of Object.values(s.byComponent ?? {})) {
    promptTokens += v.promptTokens;
    completionTokens += v.completionTokens;
    totalTokens += v.totalTokens;
  }
  return { promptTokens, completionTokens, totalTokens };
}

// ---------------------------------------------------------------------------
// Dep-injection surface
// ---------------------------------------------------------------------------

export interface StepperCoordinatorHandlerDeps {
  /** Build the root Stepper + finalizer from the coordinator config + ctx.
   *  The optional logLlmCall is bound to the request's traceId by the handler
   *  and passed to buildStepperRoot so per-role usage lands in byComponent. */
  buildBuilt(
    ctx: PipelineContext,
    logLlmCall: (entry: LlmCallEntry) => void,
  ): Promise<BuiltStepperRoot>;
  /** Factory that returns (and, if needed, hydrates) a session-scoped KnowledgeRag. */
  knowledgeRagFor(sessionId: string): Promise<IKnowledgeRagHandle>;
  /** Shared tools RAG handle (read-only; wraps the embedder-powered toolsRag). */
  toolsRag: IToolsRagHandle;
  /** Mint a fresh, unique stepper ID. */
  mintStepperId(): string;
  /** Mint a fresh turn ID for this request. */
  mintTurnId(): string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Coordinator boundary for the 18.0 Stepper runtime (spec §F).
 *
 * Responsibilities:
 * - Mint root RunIdentity (traceId/turnId/sessionId/stepperId).
 * - Own knowledgeRag resolution (R1-F3): obtains the per-session KnowledgeRag
 *   and passes the SAME instance to both rootStepper.run and finalizer.finalize,
 *   so the finalizer reads exactly what the run wrote.
 * - On `budget-exhausted`: surface a budget-extension clarify to the consumer
 *   (spec §F; mirrors 17.0 DagCoordinatorHandler ClarifySignal mechanism).
 * - On success: stream finalizer content via ctx.yield; emit terminal stop.
 * - Catch InsufficientSignal: yield the missing-list to the consumer.
 */
export class StepperCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: StepperCoordinatorHandlerDeps) {}

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    const { buildBuilt, knowledgeRagFor, toolsRag, mintStepperId, mintTurnId } =
      this.deps;

    // Mint root identity (coordinator boundary owns minting — spec §F).
    const traceId = ctx.options?.trace?.traceId ?? '';
    const identity: RunIdentity = {
      traceId,
      turnId: mintTurnId(),
      sessionId: ctx.sessionId,
      stepperId: mintStepperId(),
    };

    // Bind a logLlmCall callback that routes per-role usage to the per-request
    // byComponent bucket. The requestId (= traceId) routes entries to the
    // request delta so getSummary(traceId).byComponent is populated.
    const logLlmCall = (entry: LlmCallEntry): void => {
      ctx.requestLogger.logLlmCall({
        ...entry,
        requestId: traceId || undefined,
      });
    };

    // R1-F3: handler owns the knowledgeRag source; the SAME instance flows to
    // both rootStepper.run and finalizer.finalize.
    const knowledgeRag = await knowledgeRagFor(ctx.sessionId);
    // init() rehydrates a resumed session's entries (Task 5). The contract
    // interface does not mandate it (the KnowledgeRag class exposes it), so
    // call it only when present — tests and real KnowledgeRag instances both
    // supply it.
    await (
      knowledgeRag as IKnowledgeRagHandle & { init?(): Promise<void> }
    ).init?.();

    const built = await buildBuilt(ctx, logLlmCall);

    // Formalize the overall task ONCE (opt-in via coordinator.formalizeTask).
    // Derived from the ORIGINAL request; stays constant across needInfo retries
    // and is threaded into rootStepper.run as a compact anchor.
    const taskSpec = built.taskFormalizer
      ? await built.taskFormalizer.formalize({
          prompt: ctx.inputText,
          signal: ctx.options?.signal,
        })
      : undefined;
    if (taskSpec)
      ctx.options?.sessionLogger?.logStep('task_formalized', { taskSpec });

    // Run the root Stepper.
    // NeedInfoSignal from the planner is caught here and handled with a
    // retry-with-guidance strategy (bounded to ONE retry):
    //   1st occurrence: re-run with an augmented prompt that tells the planner
    //     to plan a fetch step instead of asking for the info.
    //   2nd occurrence: surface as a clarify to the consumer (do NOT throw a
    //     stage error).
    // If a stateOracle is configured in future, it would be routed there instead
    // of the retry-with-guidance path.
    const runOnce = async (prompt: string): Promise<IStepperResult> =>
      built.rootStepper.run({
        prompt,
        knowledgeRag,
        toolsRag,
        budget: built.budget,
        identity,
        taskSpec,
        // Issue #167: thread the client's external (consumer-executed) tools so
        // executors can emit tool calls the client fulfils. Empty → MCP-only.
        externalTools: ctx.externalTools,
        // Thread the client abort signal so cancelling the request actually
        // stops the planner/executor/child-Stepper path, and the sessionLogger
        // so per-step logging (executor_tool_seed, etc.) reaches the request log.
        signal: ctx.options?.signal,
        sessionLogger: ctx.options?.sessionLogger,
        onProgress: (c) => {
          if (c.kind === 'content') {
            ctx.yield({ ok: true, value: { content: c.delta } });
          }
          ctx.options?.sessionLogger?.logStep('stepper_progress', c);
        },
      });

    let result: IStepperResult;
    try {
      result = await runOnce(ctx.inputText);
    } catch (firstErr) {
      if (!(firstErr instanceof NeedInfoSignal)) throw firstErr;

      // First NeedInfoSignal: retry with guidance so planner plans a fetch step.
      const guidedPrompt = `${ctx.inputText}\n\n[Planner guidance: do NOT ask for "${firstErr.query}" — instead plan a step that fetches it using the available tools.]`;
      try {
        result = await runOnce(guidedPrompt);
      } catch (secondErr) {
        if (!(secondErr instanceof NeedInfoSignal)) throw secondErr;

        // Second NeedInfoSignal: surface as clarify content to the consumer.
        ctx.options?.sessionLogger?.logStep('coordinator_clarify', {
          question: secondErr.query,
        });
        ctx.yield({
          ok: true,
          value: { content: `To proceed, please provide: ${secondErr.query}` },
        });
        const usageNeed = traceId
          ? summaryToUsage(ctx.requestLogger.getSummary(traceId))
          : undefined;
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'stop',
            ...(usageNeed ? { usage: usageNeed } : {}),
          },
        });
        return true;
      }
    }

    // budget-exhausted → coordinator surfaces a budget-extension clarify (spec §F).
    // Mirror 17.0 DagCoordinatorHandler: yield content chunk containing the question,
    // then yield the terminal stop chunk with usage.
    if (result.status === 'budget-exhausted') {
      ctx.options?.sessionLogger?.logStep('coordinator_clarify', {
        question:
          'Budget exhausted — how many additional tokens should be allocated?',
      });
      ctx.yield({
        ok: true,
        value: {
          content:
            'The token budget for this run has been exhausted. ' +
            'How many additional tokens should be allocated to continue?',
        },
      });
      const usageBudget = traceId
        ? summaryToUsage(ctx.requestLogger.getSummary(traceId))
        : undefined;
      ctx.yield({
        ok: true,
        value: {
          content: '',
          finishReason: 'stop',
          ...(usageBudget ? { usage: usageBudget } : {}),
        },
      });
      return true;
    }

    // Success path — run finalizer with the SAME knowledgeRag.
    try {
      await built.finalizer.finalize({
        prompt: ctx.inputText,
        knowledgeRag,
        turnId: identity.turnId,
        signal: ctx.options?.signal,
        onProgress: (c) => {
          if (c.kind === 'content') {
            ctx.yield({ ok: true, value: { content: c.delta } });
          }
        },
      });
    } catch (err) {
      if (err instanceof InsufficientSignal) {
        ctx.yield({
          ok: true,
          value: {
            content: `Missing required information: ${err.missing.join(', ')}`,
          },
        });
        ctx.yield({
          ok: true,
          value: { content: '', finishReason: 'stop' },
        });
        return true;
      }
      throw err;
    }

    // Terminal stop yield with usage (mirror 17.0 pattern).
    const usage = traceId
      ? summaryToUsage(ctx.requestLogger.getSummary(traceId))
      : undefined;
    ctx.yield({
      ok: true,
      value: {
        content: '',
        finishReason: 'stop',
        ...(usage ? { usage } : {}),
      },
    });
    return true;
  }
}
