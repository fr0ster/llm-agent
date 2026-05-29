import {
  type IKnowledgeRagHandle,
  InsufficientSignal,
  type ISpan,
  type IStageHandler,
  type IStepperResult,
  type IToolsRagHandle,
  type LlmUsage,
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
  /** Build the root Stepper + finalizer from the coordinator config + ctx. */
  buildBuilt(ctx: PipelineContext): Promise<BuiltStepperRoot>;
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
    const identity: RunIdentity = {
      traceId: ctx.options?.trace?.traceId ?? '',
      turnId: mintTurnId(),
      sessionId: ctx.sessionId,
      stepperId: mintStepperId(),
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

    const built = await buildBuilt(ctx);

    // Run the root Stepper.
    let result: IStepperResult;
    try {
      result = await built.rootStepper.run({
        prompt: ctx.inputText,
        knowledgeRag,
        toolsRag,
        budget: built.budget,
        identity,
        toolSafety: built.toolSafety,
        onProgress: (c) => {
          if (c.kind === 'content') {
            ctx.yield({ ok: true, value: { content: c.delta } });
          }
          ctx.options?.sessionLogger?.logStep('stepper_progress', c);
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
      const traceIdBudget = ctx.options?.trace?.traceId;
      const usageBudget = traceIdBudget
        ? summaryToUsage(ctx.requestLogger.getSummary(traceIdBudget))
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
    const traceId = ctx.options?.trace?.traceId;
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
