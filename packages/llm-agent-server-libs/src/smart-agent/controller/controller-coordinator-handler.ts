import {
  type CallOptions,
  externalToolCallId,
  type IEmbedder,
  type IKnowledgeRagHandle,
  type IStageHandler,
  type KnowledgeEntryMetadata,
  type LlmTool,
  type LlmToolCall,
  type LlmUsage,
  McpError,
  type Message,
  type ModelUsageEntry,
  type ToolLoopContextStrategyFactory,
  type ToolRound,
} from '@mcp-abap-adt/llm-agent';
import {
  type KnowledgeBackend,
  LegacyAccumulateContextStrategy,
  type PipelineContext,
  summaryToUsage,
} from '@mcp-abap-adt/llm-agent-libs';
import { writePlanDecision } from './artifacts.js';
import {
  type BoardBudget,
  BoardOverBudgetError,
  renderLiveBoard,
} from './board.js';
import type { IFinalizer } from './finalizer.js';
import { writeArtifact } from './memorizer.js';
import type { Outcome } from './outcome.js';
import { resolveByPrecedence } from './outcome.js';
import { makeControllerPlanner } from './planner.js';
import { appendHint } from './prompts.js';
import {
  buildRecallBlock,
  collectApproved,
  RECALL_ARTIFACT_TYPES,
  RECALL_EVIDENCE_CHARS,
  RECALL_K_STEP,
  RECALL_MAX_CHARS_STEP,
  relevantExtract,
  runScopedRecall,
} from './recall.js';
import type { Evidence, IReviewer, ReviewResult } from './reviewer.js';
import type { RunIdMinter } from './run-scope.js';
import { classifyRequest, readTerminal, writeTerminal } from './run-scope.js';
import { hydrateBundle, persistBundle, resetRun } from './session-bundle.js';
import type { ISubagentClient } from './subagent-client.js';
import { establishTargetState } from './target-state.js';
import type {
  ControllerConfig,
  IControllerPlanner,
  PlannerKind,
  SessionBundle,
  Step,
} from './types.js';
import { makeLogUsage } from './usage-logging.js';

// ---------------------------------------------------------------------------
// Debug logging — gated behind DEBUG_CONTROLLER (e.g. DEBUG_CONTROLLER=1).
// Surfaces the steps the planner delegates and per-role/total token usage to
// stderr, for tuning step granularity and watching token spend. Off by default.
// (Also in usage-logging.ts — intentional small duplication; no 3rd copy exists.)
// ---------------------------------------------------------------------------

function dlog(msg: string): void {
  if (process.env.DEBUG_CONTROLLER) console.error(`[controller] ${msg}`);
}

/** Flat usage triple + per-model breakdown — the canonical terminal-chunk shape. */
export type TerminalUsage = LlmUsage & {
  models?: Record<string, ModelUsageEntry>;
};

// ---------------------------------------------------------------------------
// Dep-injection surface
// ---------------------------------------------------------------------------

export interface ControllerHandlerDeps {
  evaluator: ISubagentClient;
  planner: ISubagentClient;
  executor: ISubagentClient;
  backend: KnowledgeBackend;
  knowledgeRagFor: (
    sessionId: string,
  ) => IKnowledgeRagHandle | Promise<IKnowledgeRagHandle>;
  /** Required only for distance-based target-state strategies
   *  (semantic-distance/auto); unused by consumer-confirm. */
  embedder?: IEmbedder;
  /** Executes an INTERNAL (MCP) tool and returns its textual result. */
  callMcp: (toolName: string, args: unknown) => Promise<string>;
  /**
   * Semantic tool selection over the vectorized MCP catalog (toolsRag): returns
   * the top-K tools relevant to `query`. This is how INTERNAL tools reach the
   * executor — relevant, bounded, NOT a full dump. MCP-less deployments wire a
   * stub returning `[]`.
   */
  selectTools: (
    query: string,
    k?: number,
    options?: CallOptions,
  ) => Promise<readonly LlmTool[]>;
  /**
   * Optional override marking a tool as consumer-supplied (must round-trip to
   * the client). Production truth is the per-request `ctx.externalTools`; this
   * override is retained ONLY so unit tests can force external routing. The
   * effective predicate OR-combines both.
   */
  isExternalTool?: (toolName: string) => boolean;
  config: ControllerConfig;
  /** Resolved model id per subagent role, for usage attribution. reviewer/finalizer
   *  fall back to the planner model when their subagent config is absent. */
  models: {
    evaluator: string;
    planner: string;
    executor: string;
    reviewer?: string;
    finalizer?: string;
  };
  /** Judge role. Optional; when absent the handler uses a built-in
   *  approve-content reviewer (legacy behaviour — every content result is 'ok')
   *  so pre-reviewer callers keep working. The factory injects LlmReviewer. */
  reviewer?: IReviewer;
  /** Finalizer role. Optional; when absent the plan-first planner's own finalize is
   *  used and a planner without finalize support uses the planner's `done.result` as the answer (legacy). */
  finalizer?: IFinalizer;
  /** Injectable runId minter (tests pass a deterministic counter). */
  runIdMinter?: RunIdMinter;
  /** Clock seam (ISO now). Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Terminal-store TTL in ms (default 24h). */
  terminalTtlMs?: number;
  /**
   * Optional controller-own skills recall hook. When present it is threaded into
   * the planner, which queries it before each create-plan/replan and injects a
   * bounded "Relevant skills" block into the prompt. Absent → the planner prompt
   * is byte-identical to the agnostic path.
   */
  skillsRecall?: (goal: string, options?: CallOptions) => Promise<string>;
  /** Capability kind chosen by the PRESET (composition code), not user config.
   *  Selects the planner implementation. Defaults to 'smart-executor' when absent
   *  (a consumer building the handler directly without a preset). */
  plannerKind?: PlannerKind;
  /** Test/composition seam: a pre-built planner used verbatim instead of
   *  makeControllerPlanner(...). Lets a test/consumer supply an IControllerPlanner
   *  that emits behaviours the default smart/weak planners do not (e.g. rewind). */
  controllerPlanner?: IControllerPlanner;
  /** Per-step tool-loop context strategy factory (record/form). Called ONCE per
   *  step with the per-step run context (`{ rag, runId, meta, stepName }`); the
   *  returned strategy owns the executor messages sent each round so the loop never
   *  grows a raw transcript. Absent → `LegacyAccumulateContextStrategy` (byte-
   *  identical to the historical growing-transcript behaviour). */
  toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
}

// ---------------------------------------------------------------------------
// Re-exported for import-path stability (helpers moved to sibling modules).
// ---------------------------------------------------------------------------
export { renderLiveBoard } from './board.js';
export { parseNextStep } from './parser.js';
export { relevantExtract, runScopedRecall } from './recall.js';
export { makeLogUsage } from './usage-logging.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Controller coordinator boundary. Runs a deterministic loop delegating to
 * three opaque subagent roles (evaluator / planner / executor):
 *
 *   hydrate bundle → (resume if pending) → establish goal (evaluator) →
 *   LOOP[ planner.nextStep →
 *     done: finalize | rewind: bump+continue |
 *     next: executor.executeStep → route tool calls (internal MCP vs external
 *           round-trip) / retry on error / memorize content + advance ] →
 *   finalize / escalate.
 *
 * Suspend/resume is stateless: all state lives in the persisted SessionBundle
 * (KnowledgeBackend) + `ctx.externalResults`.
 *
 * Escalation mirrors StepperCoordinatorHandler: a ClarifySignal is NOT thrown
 * upward — it is surfaced to the consumer via `ctx.yield` (a content chunk with
 * the question, then a terminal `finishReason:'stop'` chunk), and `execute`
 * returns true. The pending marker is persisted first so a stateless resume can
 * pick up the human's answer.
 */
export class ControllerCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: ControllerHandlerDeps) {}

  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    _span: unknown,
  ): Promise<boolean> {
    const deps = this.deps;
    // Seams resolved once per execute(); consumed by Task 11+ (reviewer/finalizer/run-scope).
    const now = deps.now ?? (() => new Date().toISOString());
    const mintRunId =
      deps.runIdMinter ??
      (() => `run-${now()}-${Math.round(Math.random() * 1e9)}`);
    const terminalTtlMs = deps.terminalTtlMs ?? 24 * 60 * 60 * 1000;
    const sessionId = ctx.sessionId;
    const prompt = extractPrompt(ctx.textOrMessages);
    const rag = await deps.knowledgeRagFor(sessionId);
    const bundle = await hydrateBundle(deps.backend, sessionId);

    const meta = synthMeta(ctx, sessionId);

    // Token accounting: every subagent call is logged into the per-request
    // IRequestLogger (the single aggregator). The terminal chunk's usage is read
    // back from getSummary(traceId) — never a private accumulator — so it matches
    // /v1/usage and carries the per-model breakdown.
    const logUsage = makeLogUsage(ctx.requestLogger, meta.traceId, deps.models);
    const usageNow = (): TerminalUsage => {
      const s = ctx.requestLogger.getSummary(meta.traceId);
      return { ...summaryToUsage(s), models: s.byModel };
    };

    // Route external tools by the PER-REQUEST context (the client-supplied tools
    // for THIS request), OR-combined with the optional test-only override. The
    // build-time server ctx never carries external tools (they arrive per-request
    // via HTTP body.tools → ctx.externalTools), so this is the production truth.
    const externalNames = new Set((ctx.externalTools ?? []).map((t) => t.name));
    const isExternalTool = (name: string): boolean =>
      externalNames.has(name) || (deps.isExternalTool?.(name) ?? false);

    // True for the first planner.next of a turn that resumed an external-tool
    // result (the result is now in plannerPrivate) → the plan-first planner replans
    // with it rather than blindly re-running the suspended step. Set in the
    // external-tool resume branch below.
    let resumedExternal = false;
    // Marks a LIVE external-tool continuation (the result is injected into the
    // in-flight step's transcript and the step re-runs, bounded by toolCallCount —
    // NOT charged to resumeCount). Block (A) consumes it; Task 14 SETS it from the
    // artifact-first external-resume path. Until then it stays false and every
    // re-run of an in-flight executing step is charged as a crash-replay (correct).
    let externalContinuation = false;

    // -- Classification + three-stage recovery ------------------------------
    // Strict ordered classification (newRun > explicit-key strict > fingerprint of
    // an in-flight active run). STAGE 1 of recovery is the terminal-store check for
    // the resolved runId, run for ANY phase BEFORE consuming pending or routing by
    // runPhase — so a crash between the store-first terminal write and the bundle
    // flip can never re-run an already-finished run. A 'fresh' classification wipes
    // all run-scoped state and mints a new runId; a 'resume' keeps everything and
    // falls through to the pending/phase routing below.
    const explicitKey = (ctx.options as { runId?: string } | undefined)?.runId;
    const newRun =
      (ctx.options as { newRun?: boolean } | undefined)?.newRun ?? false;
    const keyForTerminal = explicitKey ?? bundle.runId;
    const terminalExists = keyForTerminal
      ? (await readTerminal(deps.backend, sessionId, keyForTerminal, now())) !==
        undefined
      : false;
    const cls = classifyRequest({
      bundle,
      incomingRequest: prompt,
      explicitKey,
      newRun,
      terminalExists,
    });

    if (cls.kind === 'replay') {
      const out = await readTerminal(deps.backend, sessionId, cls.runId, now());
      if (out) {
        if (out.kind === 'success')
          this.surfaceFinal(ctx, out.answer, usageNow());
        else this.surfaceFinal(ctx, `Error: ${out.error}`, usageNow());
        return true;
      }
      // Expired between classify and read → fall through to a fresh run.
      resetRun(bundle, prompt);
      bundle.runId = mintRunId();
      await persistBundle(deps.backend, sessionId, bundle);
    } else if (cls.kind === 'not-found') {
      return this.escalate(
        ctx,
        sessionId,
        bundle,
        'this run is no longer resumable — start a new request',
        usageNow(),
      );
    } else if (cls.kind === 'fresh') {
      resetRun(bundle, prompt);
      bundle.runId = mintRunId();
      await persistBundle(deps.backend, sessionId, bundle);
    } else if (cls.kind === 'resume' && bundle.runId) {
      // STAGE 1 (terminal-first, any phase): a stored terminal outcome wins over the
      // persisted runPhase — adopt it and STOP, never re-run the phase.
      const term = await readTerminal(
        deps.backend,
        sessionId,
        bundle.runId,
        now(),
      );
      if (term) {
        bundle.runState = 'terminal';
        await persistBundle(deps.backend, sessionId, bundle);
        if (term.kind === 'success')
          this.surfaceFinal(ctx, term.answer, usageNow());
        else this.surfaceFinal(ctx, `Error: ${term.error}`, usageNow());
        return true;
      }
      // No terminal → STAGE 2 (consume pending) / STAGE 3 (route by phase) are the
      // existing pending-resume block + the main loop's block (A) below.
    }

    // Finalizing-phase crash recovery: a resume in runPhase 'finalizing' with NO
    // terminal entry (stage-1 above already checked) means the finalizer never
    // completed → re-run it (finalize() charges finalizeAttempt under
    // finalizeCallInFlight, checks the cap, applies onFinalizeExhausted).
    if (
      cls.kind === 'resume' &&
      bundle.runState === 'active' &&
      bundle.runPhase === 'finalizing'
    ) {
      return this.finalize(
        ctx,
        sessionId,
        bundle,
        rag,
        prompt,
        logUsage,
        usageNow,
        now,
        terminalTtlMs,
      );
    }

    // -- Resume from a persisted pending marker -----------------------------
    // Planner is constructed BEFORE the resume preamble: the artifact-first
    // external-resume adopt below calls planner.commit() to keep the plan-first
    // planCursor in lockstep with nextSeq. Stateless construction; the main loop
    // reuses this same instance.
    const planner =
      deps.controllerPlanner ??
      makeControllerPlanner(
        deps.plannerKind ?? 'smart-executor',
        deps.planner,
        deps.config.subagents.planner?.hint,
        deps.skillsRecall,
      );

    if (bundle.pending?.kind === 'external-tool') {
      const { extId, toolName } = bundle.pending;
      const seq = bundle.inFlightStep?.seq;
      const attempt = bundle.inFlightStep?.attempt;
      // STAGE 1 — artifact-first: did THIS attempt already commit a result (e.g.
      // a crash AFTER the step finished but BEFORE the bundle flip)? Adopt it and
      // skip the re-call entirely.
      if (
        bundle.runId !== undefined &&
        seq !== undefined &&
        attempt !== undefined
      ) {
        const existing = await rag.list({
          runId: bundle.runId,
          seq,
          attempt,
          artifactType: 'step-result',
        });
        const resolved = resolveByPrecedence(
          existing.map((e) => ({
            status: (e.metadata.status ?? 'failed') as Outcome['status'],
            approved: e.content,
            remainder: e.metadata.remainder ?? '',
            note: e.metadata.note ?? '',
          })),
        );
        if (resolved) {
          bundle.pending = undefined;
          bundle.runState = 'active';
          // Same commit side effects as settle(), incl. planner.commit() so the
          // plan-first planCursor advances with nextSeq.
          const mapped = mapOutcome(resolved.status);
          bundle.lastOutcome = mapped;
          planner.commit?.(bundle, mapped);
          recordStepControl(bundle, {
            seq,
            name: bundle.inFlightStep?.step.name ?? 'step',
            status: resolved.status,
            note: resolved.note,
            remainder: resolved.remainder,
          });
          if (resolved.status === 'failed') {
            if (bundle.inFlightStep)
              bundle.inFlightStep.phase = 'awaiting-replan';
          } else {
            bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
            bundle.inFlightStep = undefined;
            bundle.runPhase = 'planning';
          }
          await persistBundle(deps.backend, sessionId, bundle);
        }
      }
      // STAGE 2 — no adopted artifact: route by the external result.
      if (bundle.pending?.kind === 'external-tool') {
        const result = ctx.externalResults?.get(extId);
        if (result === undefined) {
          // No result yet → re-surface the same external tool call and suspend.
          this.surfaceToolCall(
            ctx,
            {
              id: extId,
              name: toolName,
              arguments: (bundle.pending.args ?? {}) as Record<string, unknown>,
            },
            usageNow(),
          );
          return true;
        }
        bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
        await writeArtifact(
          rag,
          {
            ...meta,
            artifactType: 'mcp-result',
            toolName,
            task: bundle.pending.position,
            runId: bundle.runId,
            seq: bundle.inFlightStep?.seq,
            attempt: bundle.inFlightStep?.attempt,
            // Stable fetch identity (tool+args) so run-scoped recall dedups
            // duplicate fetches of the same object across attempts.
            identityKey: extId,
            writeOrdinal: bundle.writeOrdinal,
            content: result,
          },
          ctx.options,
        );
        if (bundle.inFlightStep) {
          // External CONTINUATION: inject the tool result into the durable
          // transcript so the loop RE-RUNS the in-flight step (the executor
          // continues from its own tool call). Bounded by toolCallCount, NOT a
          // crash-replay — externalContinuation tells block (A) not to charge
          // resumeCount when it re-runs the step this invocation.
          bundle.inFlightStep.transcript.push(
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: extId,
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(bundle.pending.args ?? {}),
                  },
                },
              ],
            },
            { role: 'tool', tool_call_id: extId, content: result },
          );
          bundle.pending = undefined;
          bundle.runState = 'active';
          externalContinuation = true;
        } else {
          // Legacy path (no inFlightStep — e.g. a seeded plan-first bundle): feed the
          // result via plannerPrivate and let the planner replan.
          bundle.plannerPrivate += `\n[external tool ${toolName} result] ${result}`;
          bundle.pending = undefined;
          resumedExternal = true;
        }
        await persistBundle(deps.backend, sessionId, bundle);
      }
    } else if (bundle.pending?.kind === 'clarify') {
      // The incoming prompt is the human's answer to the clarify question.
      // For a goal-confirmation clarify (position 'goal'), commit the goal so we
      // do NOT re-enter the confirm loop (the empty-goal check below would
      // otherwise re-run the evaluator and clarify forever). A plain affirmation
      // ("yes"/"так") confirms the evaluator's PROPOSED target; anything else is
      // treated as a refinement and becomes the goal verbatim.
      if (bundle.pending.position === 'goal') {
        const answer = prompt.trim();
        if (answer.length === 0) {
          // Empty/whitespace is not an established goal — stay suspended, re-ask
          // (deterministic clarify-resume: never commit an empty goal).
          this.surfaceClarify(ctx, bundle.pending.question, usageNow());
          return true;
        }
        const proposed = bundle.pending.proposedTarget;
        bundle.goal = proposed && isAffirmation(answer) ? proposed : answer;
        bundle.runState = 'active';
        bundle.runPhase = 'planning';
      }
      bundle.plannerPrivate += `\n[clarify answer] ${prompt}`;
      bundle.pending = undefined;
      await persistBundle(deps.backend, sessionId, bundle);
    }

    // -- Establish the goal (evaluator) -------------------------------------
    if (!bundle.goal) {
      // Evaluator crash-guard: a prior crash mid-call left evalCallInFlight set →
      // charge evalResumeCount; exhausting maxEvalResumes is a TERMINAL abort
      // (store-first), NOT an escalate — a durable resume budget, like the planner.
      if (bundle.evalCallInFlight) {
        bundle.evalResumeCount = (bundle.evalResumeCount ?? 0) + 1;
        if (
          bundle.evalResumeCount > (deps.config.budgets.maxEvalResumes ?? 3)
        ) {
          await this.abortTerminal(
            ctx,
            sessionId,
            bundle,
            'evaluator resume budget exhausted',
            now,
            terminalTtlMs,
            usageNow(),
          );
          return true;
        }
      }
      bundle.evalCallInFlight = true;
      bundle.runPhase = 'evaluating';
      await persistBundle(deps.backend, sessionId, bundle);
      const outcome = await establishTargetState(
        { evaluator: deps.evaluator, embedder: deps.embedder },
        prompt,
        deps.config.targetState,
        ctx.options,
        deps.config.subagents.evaluator?.hint,
      );
      // The call completed (a malformed/needs-confirmation result is still a
      // completed call) → clear the in-flight marker + reset the resume counter.
      bundle.evalCallInFlight = false;
      bundle.evalResumeCount = 0;
      logUsage('evaluator', outcome.usage);
      if (outcome.kind === 'needs-confirmation') {
        // Persist the proposed target with the pending marker so a confirmation
        // on resume commits IT (not a bare "yes"). See the clarify-resume above.
        bundle.pending = {
          kind: 'clarify',
          question: outcome.question,
          position: 'goal',
          proposedTarget: outcome.proposedTarget,
        };
        bundle.runState = 'suspended';
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceClarify(ctx, outcome.question, usageNow());
        return true;
      }
      bundle.goal = outcome.goal;
    }

    // (runId is guaranteed by the classification preamble: a fresh/expired-replay
    // run mints one, a resume already has one — so no separate mint guard here.)

    // -- Main loop ----------------------------------------------------------
    // The planner plans by INTENT — it is NOT shown a tool catalog. A prompt-level
    // catalog (selected once from goal+prompt) was too coarse: it mis-surfaced
    // tools, and the planner baked the wrong tool name into the step instructions,
    // which then poisoned the executor's own per-step selection. Tool relevance is
    // instead resolved PER STEP from the clean step instructions when the step
    // runs (see runStep → selectTools). The agnostic planner prompt already tells
    // it to plan fetch steps ("the executor picks the exact one").
    const cfg = deps.config.budgets;
    const boardBudget: BoardBudget = {
      maxDigestChars: cfg.maxDigestChars ?? 500,
      maxIntentChars: cfg.maxIntentChars ?? 120,
      maxActiveSteps: cfg.maxActiveSteps ?? 16,
      maxBoardChars: cfg.maxBoardChars ?? 12000,
      keepRecentDigests: cfg.keepRecentDigests ?? 8,
    };
    let planParseRetries = 0;
    // bundle.lastOutcome is the SINGLE source of truth for the last step's
    // outcome — durable, so a resume after a FAILED step replans instead of
    // repeating it. runStep.settle() sets it; the plan-first replan branch clears it
    // once the failure has been consumed into a new plan (so a crash after the
    // replan, or a finalizer retry after an empty replan, does NOT replan again).
    while (bundle.budgets.stepsUsed < cfg.maxSteps) {
      const inf = bundle.inFlightStep;
      if (inf && inf.phase === 'executing' && !resumedExternal) {
        // Reconcile by THIS attempt's resolved artifact first.
        const committed = await rag.list({
          runId: bundle.runId,
          seq: inf.seq,
          attempt: inf.attempt,
          artifactType: 'step-result',
        });
        const resolved = resolveByPrecedence(
          committed.map((e) => ({
            status: (e.metadata.status ?? 'failed') as Outcome['status'],
            approved: e.content,
            remainder: e.metadata.remainder ?? '',
            note: e.metadata.note ?? '',
          })),
        );
        if (resolved) {
          // Already committed → adopt, do NOT re-run. Same commit side effects as
          // settle(), including planner.commit() so the plan-first planCursor advances
          // in lockstep with nextSeq.
          const mapped = mapOutcome(resolved.status);
          bundle.lastOutcome = mapped;
          planner.commit?.(bundle, mapped);
          recordStepControl(bundle, {
            seq: inf.seq,
            name: inf.step.name,
            status: resolved.status,
            note: resolved.note,
            remainder: resolved.remainder,
          });
          if (resolved.status === 'failed') {
            inf.phase = 'awaiting-replan';
          } else {
            bundle.nextSeq = inf.seq + 1;
            bundle.inFlightStep = undefined;
            bundle.runPhase = 'planning';
          }
          await persistBundle(deps.backend, sessionId, bundle);
          continue;
        }
        // No artifact for this attempt → re-run the SAME step directly. Distinguish a
        // live external CONTINUATION (bounded by toolCallCount) from a crash-replay
        // (charged to resumeCount).
        if (externalContinuation) {
          externalContinuation = false;
        } else {
          inf.resumeCount += 1;
          if (inf.resumeCount > (cfg.maxStepResumes ?? 3)) {
            await this.abortTerminal(
              ctx,
              sessionId,
              bundle,
              `step "${inf.step.name}" exceeded maxStepResumes`,
              now,
              terminalTtlMs,
              usageNow(),
            );
            return true;
          }
        }
        await persistBundle(deps.backend, sessionId, bundle);
        // COORDINATOR OVERRIDE — use the ACTUAL runStep param order (now/terminalTtlMs
        // BEFORE logUsage). The plan example shows them last; that is WRONG.
        const completed = await this.runStep(
          ctx,
          sessionId,
          bundle,
          rag,
          meta,
          inf.step,
          isExternalTool,
          logUsage,
          usageNow,
          (o) => planner.commit?.(bundle, o),
        );
        if (completed === 'suspended' || completed === 'aborted') return true;
        continue;
      }

      // Planner crash-guard: a prior crash mid-call left plannerCallInFlight set →
      // charge plannerResumeCount; exhausting maxPlannerResumes is a TERMINAL abort
      // (store-first). The plan-first replan runs through planner.next too, so this one
      // guard covers the awaiting-replan replan with no separate site.
      if (bundle.plannerCallInFlight) {
        bundle.plannerResumeCount = (bundle.plannerResumeCount ?? 0) + 1;
        if (bundle.plannerResumeCount > (cfg.maxPlannerResumes ?? 3)) {
          await this.abortTerminal(
            ctx,
            sessionId,
            bundle,
            'planner resume budget exhausted',
            now,
            terminalTtlMs,
            usageNow(),
          );
          return true;
        }
      }
      bundle.plannerCallInFlight = true;
      // Reaching the planner guard means we are about to plan (block (A) handles
      // any in-flight executing step earlier and continues), so the phase is
      // 'planning' regardless of the prior 'evaluating'/'executing' value.
      bundle.runPhase = 'planning';
      await persistBundle(deps.backend, sessionId, bundle);
      // (B) Render the live board BEFORE the planner call (fail-loud on over-budget).
      let boardText: string;
      try {
        boardText = await renderLiveBoard(rag, bundle, boardBudget);
      } catch (err) {
        if (err instanceof BoardOverBudgetError) {
          bundle.plannerPrivate += `\n[board over budget] ${err.message}`;
          await this.abortTerminal(
            ctx,
            sessionId,
            bundle,
            `board exceeds maxBoardChars: ${err.message}`,
            now,
            terminalTtlMs,
            usageNow(),
          );
          return true;
        }
        throw err;
      }
      const next = await planner.next({
        bundle,
        prompt,
        lastOutcome: bundle.lastOutcome,
        resumedExternal,
        retrying: planParseRetries > 0,
        logUsage,
        // Same request CallOptions the handler threads into every other LLM/RAG
        // call (subagents, knowledgeRagFor, target-state) so the skills-recall
        // embedding is metered, cancellable, and joins the request trace.
        options: ctx.options,
        boardText,
      });
      // (A) Drain + persist plan decisions the planner queued during next().
      const drained = bundle.pendingPlanDecisions ?? [];
      bundle.pendingPlanDecisions = [];
      for (const decision of drained) {
        bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
        await writePlanDecision(
          deps.backend,
          sessionId,
          decision,
          JSON.stringify(decision.steps),
          now(),
          bundle.writeOrdinal,
        );
      }
      // The call completed → clear the in-flight marker + reset the resume counter
      // (a malformed reply is still a completed call; parse-retry is handled below).
      bundle.plannerCallInFlight = false;
      bundle.plannerResumeCount = 0;
      // NB: do NOT reset resumedExternal here — if this replan reply was malformed
      // (next === null), the parse-retry below must keep replanning. It is reset
      // only after a VALID decision (beside planParseRetries = 0;).
      // The plan-first planner mutates bundle.plan/planCursor in next(); persist so
      // a stateless resume continues from the same point. (No-op for a planner without plan-state.)
      await persistBundle(deps.backend, sessionId, bundle);

      // Format failure (not valid NextStep JSON) → re-ask the planner with a
      // stern reminder, bounded by maxRetries. This does NOT touch rewindsUsed:
      // a malformed reply is a formatting problem, not a decision to backtrack.
      if (next === null) {
        planParseRetries++;
        if (planParseRetries > cfg.maxRetries) {
          return this.escalate(
            ctx,
            sessionId,
            bundle,
            'the planner did not return a valid decision — please rephrase or retry',
            usageNow(),
          );
        }
        continue;
      }
      planParseRetries = 0;
      resumedExternal = false; // a valid decision consumed any external-resume replan

      if (next.kind === 'done') {
        // Pass next.result as the legacy answer: used only when no finalizer is
        // injected (3-role config) — the plan-first planner already composed it.
        return this.finalize(
          ctx,
          sessionId,
          bundle,
          rag,
          prompt,
          logUsage,
          usageNow,
          now,
          terminalTtlMs,
          next.result,
        );
      }

      if (next.kind === 'rewind') {
        bundle.budgets.rewindsUsed++;
        if (bundle.budgets.rewindsUsed > cfg.maxRewinds) {
          return this.escalate(
            ctx,
            sessionId,
            bundle,
            'too many rewinds — please confirm how to proceed',
            usageNow(),
          );
        }
        bundle.plannerPrivate += `\n[rewind] ${next.reason}`;
        bundle.lastOutcome = undefined;
        await persistBundle(deps.backend, sessionId, bundle);
        continue;
      }

      // next.kind === 'next' → open a fresh attempt and run it. Crash-replay/
      // continuation of an executing step is handled by block (A), so this site only
      // opens a NEW seq (attempt 0) or a revised step after awaiting-replan (attempt+1).
      dlog(
        `delegate step "${next.step.name}"${next.step.type ? ` (${next.step.type})` : ''}: ${next.step.instructions}`,
      );
      const seq = bundle.nextSeq ?? 0;
      // Usually phase 'awaiting-replan' (a revised step after a failed attempt);
      // on an external resume it may still be 'executing' (block (A) was skipped
      // while resumedExternal). Same-seq → attempt+1 either way.
      const prev = bundle.inFlightStep;
      const attempt = prev && prev.seq === seq ? prev.attempt + 1 : 0;
      if (attempt >= (cfg.maxStepAttempts ?? 5)) {
        await this.abortTerminal(
          ctx,
          sessionId,
          bundle,
          `step "${next.step.name}" exceeded maxStepAttempts`,
          now,
          terminalTtlMs,
          usageNow(),
        );
        return true;
      }
      bundle.inFlightStep = {
        seq,
        step: next.step,
        attempt,
        resumeCount: 0,
        phase: 'executing',
        transcript: [],
        toolCallCount: 0,
      };
      bundle.runPhase = 'executing';
      await persistBundle(deps.backend, sessionId, bundle);
      const completed = await this.runStep(
        ctx,
        sessionId,
        bundle,
        rag,
        meta,
        next.step,
        isExternalTool,
        logUsage,
        usageNow,
        (o) => planner.commit?.(bundle, o),
      );
      if (completed === 'suspended' || completed === 'aborted') return true;
      // runStep.settle() already persisted the outcome ATOMICALLY (bundle.lastOutcome
      // + cursor advance via onCommit + step result, in one persistBundle). The next
      // planner.next reads the fresh bundle.lastOutcome; a resume continues from the
      // next uncompleted step (or replans, if this step failed).
    }

    // -- Budget exhausted ---------------------------------------------------
    return this.escalate(
      ctx,
      sessionId,
      bundle,
      'step budget exhausted — please confirm how to proceed',
      usageNow(),
    );
  }

  // -- Step execution -----------------------------------------------------

  /** Returns 'advanced' (step succeeded — continue loop), 'failed' (retries/
   *  tool-call budget OR reviewer-unverifiable budget exhausted; the failure note
   *  is in plannerPrivate so the planner can replan), 'partial' (reviewer approved
   *  part, remainder replans), or 'suspended' (external round-trip surfaced — caller
   *  must return true). ('aborted' remains in the return union for the caller's
   *  guard but is no longer produced here — a judge-failure now degrades to 'failed'
   *  rather than aborting the run.) */
  private async runStep(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    rag: IKnowledgeRagHandle,
    meta: KnowledgeEntryMetadata,
    step: Step,
    isExternalTool: (name: string) => boolean,
    logUsage?: (role: string, u?: LlmUsage) => void,
    usageNow?: () => TerminalUsage,
    onCommit?: (outcome: 'advanced' | 'failed' | 'partial') => void,
  ): Promise<'advanced' | 'failed' | 'partial' | 'suspended' | 'aborted'> {
    const deps = this.deps;
    const cfg = deps.config.budgets;
    const maxToolCalls = cfg.maxToolCalls ?? 10;
    const inFlight = bundle.inFlightStep; // set by the caller (block A or B)
    // Persist the step outcome ATOMICALLY: record lastOutcome (durable, so a
    // resume after a failed step replans instead of repeating it) AND advance the
    // planner cursor (onCommit) in the SAME persistBundle that records the step
    // result — never in a separate write, so a crash cannot replay a completed step.
    const settle = async (
      outcome: 'advanced' | 'failed' | 'partial',
    ): Promise<'advanced' | 'failed' | 'partial'> => {
      bundle.lastOutcome = outcome;
      onCommit?.(outcome);
      if (outcome === 'advanced' || outcome === 'partial') {
        bundle.nextSeq = (bundle.nextSeq ?? 0) + 1;
        bundle.inFlightStep = undefined;
        bundle.runPhase = 'planning';
      } else {
        // 'failed' — keep the same seq, mark awaiting-replan in the SAME persist so
        // recovery routes by durable phase.
        if (bundle.inFlightStep) bundle.inFlightStep.phase = 'awaiting-replan';
        bundle.runPhase = 'executing';
      }
      await persistBundle(deps.backend, sessionId, bundle);
      return outcome;
    };
    // The IMMUTABLE per-round prefix: system + step user message + the step-result
    // recall block. Re-emitted verbatim every round via strategy.form(); the dynamic
    // tool rounds are owned by the injected context strategy, NOT accumulated here.
    const staticPrefix: Message[] = [
      {
        role: 'system',
        content: appendHint(
          EXECUTOR_SYSTEM,
          deps.config.subagents.executor?.hint,
        ),
      },
      {
        role: 'user',
        content: `Goal: ${bundle.goal}\nStep: ${step.name}\nInstructions: ${step.instructions}`,
      },
    ];

    // Episodic recall: pull prior STEP-RESULT artifacts relevant to this step from
    // session-memory and inject them as static context. The session-memory rag shares
    // the bundle backend, so restrict to 'step-result' (excludes the
    // 'controller-bundle' infrastructure record). Bounded by k and length. The
    // per-round MCP context is now the context strategy's job (its form() supplies
    // the mcp-result rounds — the Window keeps its own buffer, RagRecall recalls),
    // so it is NOT part of the handler-built static prefix.
    const recallText = step.instructions || step.name;
    const maxAttempts = cfg.maxStepAttempts ?? 5;
    const recalledSteps = await runScopedRecall(
      rag,
      recallText,
      RECALL_K_STEP,
      bundle.runId,
      RECALL_K_STEP * (maxAttempts + 1),
      ['step-result'],
      ctx.options,
    );
    const stepBlock = buildRecallBlock(recalledSteps, RECALL_MAX_CHARS_STEP);
    if (stepBlock) {
      staticPrefix.push({ role: 'user', content: stepBlock });
    }

    // Per-step tool-loop context strategy (record/form). FRESH path only (Task 11):
    // resume/migration selection is a later concern. Absent factory →
    // LegacyAccumulateContextStrategy (byte-identical to the historical growing
    // transcript).
    const makeStrategy = () =>
      (
        deps.toolLoopContextStrategyFactory ??
        (() => new LegacyAccumulateContextStrategy())
      )({
        run: { rag, runId: bundle.runId, meta, stepName: step.name },
      });
    const strategy = makeStrategy();

    // Durable, bounded control-message tail (retries only). Aliased IN PLACE so
    // push/prune mutate the persisted field; a legacy call with no inFlightStep gets
    // an ephemeral local (no durable tail to persist).
    let controlTail: Message[];
    if (inFlight) {
      inFlight.controlTail = inFlight.controlTail ?? [];
      controlTail = inFlight.controlTail;
    } else {
      controlTail = [];
    }

    // External CONTINUATION bridge: the resume preamble injected the external
    // assistant/tool pair(s) into inFlight.transcript. Record them as rounds so the
    // fresh strategy surfaces them to the executor via form(). (Task 12 generalizes
    // this via snapshot restore + LegacyTranscript migration.)
    if (inFlight && inFlight.transcript.length > 0) {
      const t = inFlight.transcript;
      let i = 0;
      while (i < t.length) {
        const assistant = t[i];
        i++;
        const results: Message[] = [];
        while (i < t.length && t[i]?.role === 'tool') {
          results.push(t[i]);
          i++;
        }
        if (assistant)
          await strategy.record({ assistant, results }, ctx.options);
      }
    }

    // Snapshot the strategy state + persist the bundle after every executor/tool
    // exchange so a suspend or crash resumes with the same context the executor saw.
    const persistExchange = async (): Promise<void> => {
      if (inFlight) {
        inFlight.contextStrategyState = strategy.snapshot();
        await persistBundle(deps.backend, sessionId, bundle);
      }
    };

    // Per-reference evidence: one recall per requires[] reference. A non-empty
    // top-K does NOT prove the dependency is present — semantic recall returns the
    // NEAREST artifact even at low relevance — so we hand the reviewer the TOP
    // artifact's relevant fragment (Evidence.topArtifact) and let IT (the judging
    // role) decide whether the ref is actually satisfied. `hit` is a coarse
    // any-candidate flag. Gathered SEQUENTIALLY (NOT Promise.all): each
    // relevantExtract is itself bounded-sequential, so the outer sequential loop
    // keeps at most ONE embed request in flight at a time (rate-limit-safe).
    const refs =
      step.requires && step.requires.length > 0 ? step.requires : [recallText];
    const evBound =
      RECALL_K_STEP * (maxAttempts + 1) +
      cfg.maxSteps * maxAttempts * (cfg.maxToolCalls ?? 10);
    const evidence: Evidence[] = [];
    for (const ref of refs) {
      const hits = await runScopedRecall(
        rag,
        ref,
        1,
        bundle.runId,
        evBound,
        RECALL_ARTIFACT_TYPES,
        ctx.options,
      );
      const topArtifact = hits[0]
        ? await relevantExtract(
            hits[0].content,
            ref,
            RECALL_EVIDENCE_CHARS,
            // biome-ignore lint/style/noNonNullAssertion: distance strategies require an embedder; the factory enforces it (Task 17).
            deps.embedder!,
            ctx.options,
          )
        : undefined;
      evidence.push({ ref, hit: hits.length > 0, topArtifact });
    }

    // Tools offered to the executor = the INTERNAL (MCP) tools semantically
    // relevant to THIS step (top-K from toolsRag) PLUS the per-request external
    // (consumer-supplied) tools. The executor decides which to call; internal
    // calls route through `callMcp`, external calls round-trip via `isExternalTool`.
    const relevant = await deps.selectTools(
      step.instructions || step.name,
      TOOL_SELECT_K,
      ctx.options,
    );
    const offeredTools: LlmTool[] = [...relevant, ...(ctx.externalTools ?? [])];
    // The executor may ONLY call a tool that was offered to it: an internal tool
    // selected for this step, or a per-request external tool. Any other name
    // (hallucinated / stale / not in the top-K) is rejected — never executed —
    // so the semantic exposure boundary actually bounds what runs.
    const offeredInternalNames = new Set(relevant.map((t) => t.name));

    let retries = 0;

    // (D) Persist a 'failed' step-result artifact for controller-level failures
    // (reviewer unverifiable, executor error exhausted, maxToolCalls, unavailable
    // tool) so the board can project the step's terminal state from artifacts alone.
    const writeControlFailure = async (reason: string): Promise<void> => {
      const seq = bundle.inFlightStep?.seq ?? bundle.nextSeq ?? 0;
      const attempt = bundle.inFlightStep?.attempt ?? 0;
      bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
      await writeArtifact(
        rag,
        {
          ...meta,
          artifactType: 'step-result',
          task: step.name,
          runId: bundle.runId,
          seq,
          attempt,
          status: 'failed',
          note: reason,
          remainder: '',
          stepId: step.stepId,
          digest: reason.slice(0, cfg.maxDigestChars ?? 500),
          writeOrdinal: bundle.writeOrdinal,
          content: '',
        },
        ctx.options,
      );
    };

    // Inner loop handles tool routing / error retries until the executor
    // produces content for this step (or the step suspends on an external tool).
    while (true) {
      // Form the per-round executor context: the immutable prefix + the strategy's
      // rounds, then the bounded control tail (retries). NEVER a growing raw array.
      const messages = (
        await strategy.form(
          { prefix: staticPrefix, queryText: step.instructions },
          ctx.options,
        )
      ).concat(controlTail);
      const res = await deps.executor.send(messages, offeredTools);
      logUsage?.('executor', res.usage);

      if (res.kind === 'content') {
        // Hold the executor's result; the reviewer (NOT the executor) decides the
        // outcome. Default reviewer (no deps.reviewer) approves as 'ok' (legacy).
        let review: ReviewResult = deps.reviewer
          ? await deps.reviewer.review(step, evidence, res.content, {
              hint: deps.config.subagents.reviewer?.hint,
              logUsage,
              maxDigestChars: cfg.maxDigestChars ?? 500,
            })
          : {
              kind: 'outcome',
              outcome: {
                status: 'ok',
                approved: res.content,
                remainder: '',
                note: '',
                digest: res.content.slice(0, cfg.maxDigestChars ?? 500),
              },
            };

        // Judge failure (provider error / malformed / contradictory ok-with-empty)
        // is NOT a step failure: re-ask within maxReviewRetries, then ABORT (the
        // outcome is unverifiable). Never mapped to settle('failed')/replan.
        let reviewRetries = 0;
        while (review.kind === 'judge-failure') {
          reviewRetries++;
          if (reviewRetries > (cfg.maxReviewRetries ?? 2)) {
            // The reviewer could not produce a usable verdict within the retry
            // budget (provider error / unparsable). DEGRADE to a failed step so the
            // planner replans, rather than aborting the whole run — the terminal
            // backstop is maxStepAttempts/maxSteps, not a single unverifiable verdict.
            bundle.budgets.stepsUsed++;
            await writeControlFailure(
              `reviewer unverifiable after ${cfg.maxReviewRetries ?? 2} retries: ${review.reason}`,
            );
            bundle.plannerPrivate += `\n[seq ${
              bundle.inFlightStep?.seq ?? bundle.nextSeq ?? 0
            } ${step.name} failed] reviewer unverifiable after ${
              cfg.maxReviewRetries ?? 2
            } retries: ${review.reason}`;
            return settle('failed');
          }
          review = await deps.reviewer!.review(step, evidence, res.content, {
            hint: deps.config.subagents.reviewer?.hint,
            logUsage,
            maxDigestChars: cfg.maxDigestChars ?? 500,
          });
        }

        const outcome = review.outcome;
        const seq = bundle.inFlightStep?.seq ?? bundle.nextSeq ?? 0;
        const attempt = bundle.inFlightStep?.attempt ?? 0;
        // ONE post-review write carrying the COMPLETE Outcome + identity.
        bundle.writeOrdinal = (bundle.writeOrdinal ?? 0) + 1;
        await writeArtifact(
          rag,
          {
            ...meta,
            artifactType: 'step-result',
            task: step.name,
            runId: bundle.runId,
            seq,
            attempt,
            status: outcome.status,
            note: outcome.note,
            remainder: outcome.remainder,
            stepId: step.stepId,
            digest: outcome.digest,
            writeOrdinal: bundle.writeOrdinal,
            content: outcome.approved,
          },
          ctx.options,
        );
        bundle.budgets.stepsUsed++;
        const mapped = mapOutcome(outcome.status);
        recordStepControl(bundle, {
          seq: bundle.inFlightStep?.seq ?? seq,
          name: step.name,
          status: outcome.status,
          note: outcome.note,
          remainder: outcome.remainder,
        });
        return settle(mapped);
      }

      if (res.kind === 'error') {
        retries++;
        if (retries <= cfg.maxRetries) {
          controlTail.push({
            role: 'user',
            content: `The previous attempt failed: ${res.error}. Retry the step.`,
          });
          await persistExchange();
          continue;
        }
        // Retries exhausted — feed the error back as the step result so the
        // planner can replan on the next iteration.
        bundle.budgets.stepsUsed++;
        await writeControlFailure(`executor error: ${res.error}`);
        bundle.plannerPrivate += `\n[step ${step.name} failed] ${res.error}`;
        return settle('failed');
      }

      // res.kind === 'tool_call' → route the FIRST tool call.
      const firstCall = res.toolCalls[0];
      if (firstCall === undefined) {
        // Empty tool-call array → treat as an executor error (retry/replan).
        retries++;
        if (retries <= cfg.maxRetries) {
          controlTail.push({
            role: 'user',
            content:
              'The previous attempt produced an empty tool call. Retry the step.',
          });
          await persistExchange();
          continue;
        }
        bundle.budgets.stepsUsed++;
        await writeControlFailure('empty tool call');
        bundle.plannerPrivate += `\n[step ${step.name} failed] empty tool call`;
        return settle('failed');
      }
      // Normalize the StreamToolCall (full or delta) into an LlmToolCall inline.
      const call: LlmToolCall =
        'arguments' in firstCall &&
        typeof firstCall.arguments === 'object' &&
        firstCall.arguments !== null
          ? {
              id: ('id' in firstCall && firstCall.id) || 'call',
              name: ('name' in firstCall && firstCall.name) || '',
              arguments: firstCall.arguments as Record<string, unknown>,
            }
          : (() => {
              let iArgs: Record<string, unknown> = {};
              const raw =
                'arguments' in firstCall ? firstCall.arguments : undefined;
              if (typeof raw === 'string' && raw.length > 0) {
                try {
                  iArgs = JSON.parse(raw) as Record<string, unknown>;
                } catch {
                  iArgs = {};
                }
              }
              return {
                id: ('id' in firstCall && firstCall.id) || 'call',
                name: ('name' in firstCall && firstCall.name) || '',
                arguments: iArgs,
              };
            })();
      const name = call.name;
      const args = call.arguments;

      if (isExternalTool(name)) {
        // External round-trips share the SAME durable toolCallCount/maxToolCalls
        // bound as internal calls; check BEFORE surfacing so an external tool
        // cannot exceed the cap. Exhausted → control-failed replan at the same seq.
        if (inFlight && inFlight.toolCallCount + 1 > maxToolCalls) {
          bundle.budgets.stepsUsed++;
          await writeControlFailure(
            'tool-call budget exhausted (maxToolCalls)',
          );
          bundle.plannerPrivate += `\n[seq ${inFlight.seq} ${step.name} control-failed] tool-call budget exhausted (maxToolCalls)`;
          inFlight.phase = 'awaiting-replan';
          inFlight.controlFailure = {
            reason: 'maxToolCalls',
            seq: inFlight.seq,
          };
          return settle('failed');
        }
        // Snapshot the strategy state SO FAR before we suspend (the resume injection
        // appends the external assistant/tool pair, recorded on the next invocation).
        if (inFlight) inFlight.contextStrategyState = strategy.snapshot();
        const extId = externalToolCallId(name, args);
        if (inFlight) inFlight.toolCallCount += 1;
        // The new marker REPLACES any prior pending (a fresh extId).
        bundle.pending = {
          kind: 'external-tool',
          extId,
          toolName: name,
          args,
          position: step.name,
        };
        bundle.runState = 'suspended';
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceToolCall(
          ctx,
          { id: extId, name, arguments: args },
          usageNow?.(),
        );
        return 'suspended';
      }

      // The executor may only call a tool that was OFFERED to it this step. A
      // name that is neither external nor in the internal top-K (hallucinated /
      // stale / out-of-scope) is rejected — NOT executed — and fed back as a
      // tool-not-available error so the executor retries with an offered tool.
      if (!offeredInternalNames.has(name)) {
        retries++;
        if (retries <= cfg.maxRetries) {
          controlTail.push({
            role: 'user',
            content: `Tool "${name}" is not available for this step. Use only the tools provided to you.`,
          });
          await persistExchange();
          continue;
        }
        bundle.budgets.stepsUsed++;
        await writeControlFailure(`requested unavailable tool ${name}`);
        bundle.plannerPrivate += `\n[step ${step.name} failed] requested unavailable tool ${name}`;
        return settle('failed');
      }

      // Durable round-trip count: ++ and persist BEFORE surfacing so it survives a
      // resume (never a per-resume local).
      if (inFlight) {
        inFlight.toolCallCount += 1;
        await persistBundle(deps.backend, sessionId, bundle);
      }
      if ((inFlight?.toolCallCount ?? 0) > maxToolCalls) {
        // Controller-level failure (NOT a reviewer status): record durably and replan.
        bundle.budgets.stepsUsed++;
        await writeControlFailure('tool-call budget exhausted (maxToolCalls)');
        bundle.plannerPrivate += `\n[seq ${inFlight?.seq ?? bundle.nextSeq ?? 0} ${step.name} control-failed] tool-call budget exhausted (maxToolCalls)`;
        if (inFlight) {
          inFlight.phase = 'awaiting-replan';
          inFlight.controlFailure = {
            reason: 'maxToolCalls',
            seq: inFlight.seq,
          };
        }
        return settle('failed');
      }

      // Execute locally, memorize, re-send to the executor.
      // FAIL LOUD: surface an MCP-unavailable failure as a terminal abort (not a
      // silent empty response). The bridge (buildMcpBridge) throws an McpError
      // IFF the injected classifier deemed it 'unavailable'; a tool-level error
      // is returned as TEXT, never thrown. So ANY McpError reaching this catch is
      // already a classifier-unavailable verdict — trust that throw-contract
      // rather than re-checking the code (which would drop a CUSTOM classifier's
      // decision → rethrow → outer catch swallow → (no response)). A non-McpError
      // is a genuine unexpected error and is re-thrown for the outer handler.
      let result: string;
      try {
        result = await deps.callMcp(name, args);
      } catch (mcpErr) {
        if (mcpErr instanceof McpError) {
          const now = deps.now ?? (() => new Date().toISOString());
          const terminalTtlMs = deps.terminalTtlMs ?? 24 * 60 * 60 * 1000;
          await this.abortTerminal(
            ctx,
            sessionId,
            bundle,
            `MCP server unavailable: ${mcpErr.message}`,
            now,
            terminalTtlMs,
            usageNow?.(),
          );
          return 'aborted';
        }
        throw mcpErr;
      }
      // Record this exchange as a coherent assistant→tool ROUND (OpenAI protocol)
      // via the context strategy so the executor LLM continues from its own tool
      // call. The strategy owns the per-round context (Window keeps a bounded
      // buffer; RagRecall (Task 13) persists the mcp-result + recalls it) — the
      // handler no longer writes the mcp-result artifact or grows a raw transcript.
      const round: ToolRound = {
        assistant: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        results: [
          {
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          },
        ],
        // Stable fetch identity (tool+args) for run-scoped recall dedup. The
        // controller has no tool-level error classifier here — an unavailable MCP
        // server aborts BEFORE record; a returned string is a delivered result.
        meta: [{ identityKey: externalToolCallId(name, args), isError: false }],
        roundId: undefined,
      };
      await strategy.record(round, ctx.options);
      // A recorded round supersedes any pending control retry → prune the tail.
      controlTail.length = 0;
      // The executor saw this round → make the strategy state durable before next.
      await persistExchange();
    }
  }

  // -- Escalation & surfacing (mirror StepperCoordinatorHandler) ----------

  private async escalate(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    question: string,
    usage?: TerminalUsage,
  ): Promise<boolean> {
    bundle.pending = { kind: 'clarify', question, position: 'loop' };
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceClarify(ctx, question, usage);
    return true;
  }

  /** Store-first terminal ERROR: write the terminal outcome to the TTL store
   *  FIRST (keyed by runId), THEN flip the bundle terminal and surface the error.
   *  Store-first makes the abort idempotent across a crash between the two writes. */
  private async abortTerminal(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    error: string,
    now: () => string,
    terminalTtlMs: number,
    usage?: TerminalUsage,
  ): Promise<void> {
    await writeTerminal(
      this.deps.backend,
      sessionId,
      bundle.runId ?? sessionId,
      { kind: 'error', error },
      terminalTtlMs,
      now(),
    );
    bundle.pending = undefined;
    bundle.inFlightStep = undefined;
    bundle.finalizeCallInFlight = false;
    bundle.runState = 'terminal';
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceFinal(ctx, `Error: ${error}`, usage);
  }

  private async finalize(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    rag: IKnowledgeRagHandle,
    prompt: string,
    logUsage: (role: string, u?: LlmUsage) => void,
    usageNow: () => TerminalUsage,
    now: () => string,
    terminalTtlMs: number,
    /** Used ONLY when no finalizer is injected (3-role config): the plan-first
     *  planner's already-composed done.result. */
    legacyAnswer?: string,
  ): Promise<boolean> {
    const deps = this.deps;
    const cfg = deps.config.budgets;
    const maxFinalizeRetries = cfg.maxFinalizeRetries ?? 2;

    // The finalizer reads the run's approved results + the DURABLE originalRequest
    // (the verbatim request that started the run), never the live resume prompt.
    const request = bundle.originalRequest ?? prompt;
    const approved =
      deps.finalizer && bundle.runId
        ? await collectApproved(rag, bundle.runId)
        : [];

    // Shared exhaustion handler (pre-call AND in-catch): apply onFinalizeExhausted.
    const onExhausted = async (reason: string): Promise<string | null> => {
      if ((deps.config.onFinalizeExhausted ?? 'error') === 'best-effort') {
        return (
          approved.map((a) => `[#${a.seq}] ${a.content}`).join('\n\n') +
          '\n\n[incomplete: the final answer could not be composed]'
        );
      }
      await this.abortTerminal(
        ctx,
        sessionId,
        bundle,
        reason,
        now,
        terminalTtlMs,
        usageNow(),
      );
      return null;
    };

    // Crash-replay charge: a prior finalize call in flight → this re-entry is a
    // replay; charge finalizeAttempt and CHECK the cap BEFORE re-invoking.
    if (bundle.finalizeCallInFlight) {
      bundle.finalizeAttempt = (bundle.finalizeAttempt ?? 0) + 1;
      if ((bundle.finalizeAttempt ?? 0) > maxFinalizeRetries) {
        const best = await onExhausted(
          'finalizer retry budget exhausted on recovery',
        );
        if (best === null) return true;
        await this.commitTerminalSuccess(
          ctx,
          sessionId,
          bundle,
          best,
          now,
          terminalTtlMs,
          usageNow(),
        );
        return true;
      }
    }
    // Legacy (no-finalizer) path: persist the planner's composed answer DURABLY in
    // the SAME write that enters 'finalizing', so a crash before the terminal write
    // can recover it rather than emitting empty.
    if (!deps.finalizer && legacyAnswer !== undefined) {
      bundle.legacyFinalAnswer = legacyAnswer;
    }
    bundle.runPhase = 'finalizing';
    bundle.finalizeCallInFlight = true;
    await persistBundle(deps.backend, sessionId, bundle);

    let answer: string | undefined;
    if (deps.finalizer && bundle.runId) {
      // Recall the skills block ONCE (not per finalize retry — re-embedding on
      // every attempt is wasteful; the recall is invariant across retries).
      const skillsBlock = deps.skillsRecall
        ? await deps.skillsRecall(bundle.goal, ctx.options)
        : undefined;
      while (answer === undefined) {
        try {
          const composed = await deps.finalizer.finalize(
            bundle.goal,
            request,
            approved,
            {
              hint: deps.config.subagents.finalizer?.hint,
              logUsage,
              log: (m) => dlog(m),
              skillsBlock,
            },
          );
          // Empty-but-ok finalizer output is a JUDGE failure (spec), not a valid
          // answer → throw so it retries within maxFinalizeRetries.
          if (composed.trim().length === 0) {
            throw new Error('finalizer returned an empty answer');
          }
          answer = composed;
        } catch (e) {
          bundle.finalizeAttempt = (bundle.finalizeAttempt ?? 0) + 1;
          await persistBundle(deps.backend, sessionId, bundle);
          if ((bundle.finalizeAttempt ?? 0) > maxFinalizeRetries) {
            const best = await onExhausted(
              `finalizer failed after ${maxFinalizeRetries} retries: ${String(e)}`,
            );
            if (best === null) return true; // 'error' policy aborted terminally
            answer = best; // 'best-effort'
            break;
          }
          // else: loop and retry the finalizer.
        }
      }
    } else {
      // Legacy: the plan-first planner already composed the answer in done.result.
      // Prefer the live param, else the durable copy persisted on finalizing-entry.
      answer = legacyAnswer ?? bundle.legacyFinalAnswer ?? '';
    }

    await this.commitTerminalSuccess(
      ctx,
      sessionId,
      bundle,
      answer ?? '',
      now,
      terminalTtlMs,
      usageNow(),
    );
    return true;
  }

  /** Store-first terminal SUCCESS: write the terminal store FIRST, then flip the
   *  bundle to terminal and surface the answer (mirror of abortTerminal). */
  private async commitTerminalSuccess(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    answer: string,
    now: () => string,
    terminalTtlMs: number,
    usage?: TerminalUsage,
  ): Promise<void> {
    await writeTerminal(
      this.deps.backend,
      sessionId,
      bundle.runId ?? sessionId,
      { kind: 'success', answer },
      terminalTtlMs,
      now(),
    );
    bundle.pending = undefined;
    bundle.finalizeCallInFlight = false;
    bundle.runState = 'terminal';
    bundle.inFlightStep = undefined;
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceFinal(ctx, answer, usage);
  }

  private surfaceClarify(
    ctx: PipelineContext,
    question: string,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: { content: `To proceed, please provide: ${question}` },
    });
    ctx.yield({
      ok: true,
      value: { content: '', finishReason: 'stop', ...(usage ? { usage } : {}) },
    });
  }

  private surfaceFinal(
    ctx: PipelineContext,
    content: string,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: { content, finishReason: 'stop', ...(usage ? { usage } : {}) },
    });
  }

  private surfaceToolCall(
    ctx: PipelineContext,
    call: LlmToolCall,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: {
        content: '',
        toolCalls: [call],
        finishReason: 'tool_calls',
        ...(usage ? { usage } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Goal-clarification helpers
// ---------------------------------------------------------------------------

/** Bare confirmations that, on a goal clarify, commit the evaluator's proposed
 *  target rather than the literal answer. Anything else = a refinement. */
const AFFIRMATIONS = new Set([
  'yes',
  'y',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'correct',
  'sure',
  'yep',
  'yeah',
  'так',
  'ок',
  'окей',
  'підтверджую',
  'вірно',
  'да',
  '+',
]);

/** True when the answer is a pure confirmation (short affirmative token). */
function isAffirmation(answer: string): boolean {
  const t = answer
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  return AFFIRMATIONS.has(t);
}

/** Agnostic executor system prompt. Domain specifics (e.g. SAP/ABAP fact kinds)
 *  are layered on via `subagents.executor.hint` (see {@link appendHint}). */
const EXECUTOR_SYSTEM =
  'You are the executor. You have tools that read the live target system. ' +
  'You MUST obtain any fact about the system (e.g. its structure, contents, ' +
  'status, or source — any current state) by CALLING the appropriate tool — ' +
  'never answer such facts from prior knowledge or memory. Emit a tool call ' +
  'when you need data; only return the step result as content once you have the ' +
  'tool results. ' +
  'Do EXACTLY what the step asks, at the granularity it asks — do NOT broaden it: ' +
  'if the step asks for a LIST or overview, return the list; do NOT then go and ' +
  'fetch the full details of every listed item unless the step explicitly asks ' +
  'for per-item details.';

/** Top-K tools surfaced from toolsRag per planner/step query. */
const TOOL_SELECT_K = 20;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Extract the user prompt from the request's textOrMessages. */
function extractPrompt(textOrMessages: string | Message[]): string {
  if (typeof textOrMessages === 'string') return textOrMessages;
  for (let i = textOrMessages.length - 1; i >= 0; i--) {
    if (textOrMessages[i].role === 'user')
      return textOrMessages[i].content ?? '';
  }
  return '';
}

/** Synthesize the strict KnowledgeEntryMetadata for controller artifacts. */
function synthMeta(
  ctx: PipelineContext,
  sessionId: string,
): KnowledgeEntryMetadata {
  const traceId = ctx.options?.trace?.traceId ?? sessionId;
  return {
    traceId,
    turnId: traceId,
    stepperId: 'controller',
    task: 'controller',
    artifactType: 'step-result',
    createdAt: new Date().toISOString(),
  };
}

/** Map a reviewer status to the planner transition. ok/exists advance; partial
 *  advances the accepted part AND forces a remainder replan; failed replans. */
function mapOutcome(
  status: Outcome['status'],
): 'advanced' | 'failed' | 'partial' {
  if (status === 'ok' || status === 'exists') return 'advanced';
  if (status === 'partial') return 'partial';
  return 'failed';
}

/** Append ONE payload-free control record to plannerPrivate (the cache holds
 *  {seq,status,note,remainder}, never the approved content). Used by both normal
 *  settle and crash/external reconciliation so plannerPrivate is identical
 *  whichever path committed the step. */
function recordStepControl(
  bundle: SessionBundle,
  rec: {
    seq: number;
    name: string;
    status: Outcome['status'];
    note?: string;
    remainder?: string;
  },
): void {
  bundle.plannerPrivate +=
    `\n[seq ${rec.seq} ${rec.name} ${rec.status}]` +
    (rec.note ? ` ${rec.note}` : '') +
    (rec.remainder ? ` remainder: ${rec.remainder}` : '');
}
