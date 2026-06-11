import {
  type CallOptions,
  externalToolCallId,
  type IEmbedder,
  type IKnowledgeRagHandle,
  type IRequestLogger,
  type IStageHandler,
  type KnowledgeEntryMetadata,
  type LlmComponent,
  type LlmTool,
  type LlmToolCall,
  type LlmUsage,
  type Message,
  type ModelUsageEntry,
  type StreamToolCall,
} from '@mcp-abap-adt/llm-agent';
import {
  type KnowledgeBackend,
  type PipelineContext,
  summaryToUsage,
} from '@mcp-abap-adt/llm-agent-libs';
import type { IFinalizer } from './finalizer.js';
import { writeArtifact } from './memorizer.js';
import { resolveNeed } from './need-resolver.js';
import type { Outcome } from './outcome.js';
import { resolveByPrecedence } from './outcome.js';
import { makePlanner } from './planner.js';
import { appendHint } from './prompts.js';
import type { IReviewer, ReviewResult } from './reviewer.js';
import type { RunIdMinter } from './run-scope.js';
import { classifyRequest, readTerminal, writeTerminal } from './run-scope.js';
import { hydrateBundle, persistBundle, resetRun } from './session-bundle.js';
import type { ISubagentClient } from './subagent-client.js';
import { establishTargetState } from './target-state.js';
import type {
  ControllerConfig,
  NextStep,
  SessionBundle,
  Step,
} from './types.js';

// ---------------------------------------------------------------------------
// Debug logging — gated behind DEBUG_CONTROLLER (e.g. DEBUG_CONTROLLER=1).
// Surfaces the steps the planner delegates and per-role/total token usage to
// stderr, for tuning step granularity and watching token spend. Off by default.
// ---------------------------------------------------------------------------

function dlog(msg: string): void {
  if (process.env.DEBUG_CONTROLLER) console.error(`[controller] ${msg}`);
}

/** Flat usage triple + per-model breakdown — the canonical terminal-chunk shape. */
export type TerminalUsage = LlmUsage & {
  models?: Record<string, ModelUsageEntry>;
};

/**
 * Build a request-time `logUsage(role, usage)` that writes each subagent call
 * into the per-request `IRequestLogger` (the single aggregator), attributing the
 * role's configured model. The role is explicit at the call site, so the shared
 * planner/finalizer client is attributed correctly. `durationMs: 0` — the seam
 * carries no timing (matches the rag-query precedent).
 */
export function makeLogUsage(
  requestLogger: IRequestLogger,
  requestId: string | undefined,
  models: { evaluator: string; planner: string; executor: string },
): (role: string, u?: LlmUsage) => void {
  return (role, u) => {
    if (!u) return;
    const model =
      role === 'finalizer'
        ? models.planner
        : role === 'embedding'
          ? 'embedder'
          : ((models as Record<string, string>)[role] ?? 'unknown');
    requestLogger.logLlmCall({
      component: role as LlmComponent,
      model,
      promptTokens: u.promptTokens ?? 0,
      completionTokens: u.completionTokens ?? 0,
      totalTokens: u.totalTokens ?? 0,
      durationMs: 0,
      requestId,
    });
    dlog(
      `tokens ${role}: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`,
    );
  };
}

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
  /** Resolved model id per subagent role, for usage attribution (finalizer uses
   *  the planner model). */
  models: { evaluator: string; planner: string; executor: string };
  /** Judge role. Optional; when absent the handler uses a built-in
   *  approve-content reviewer (legacy behaviour — every content result is 'ok')
   *  so pre-reviewer callers keep working. The factory injects LlmReviewer. */
  reviewer?: IReviewer;
  /** Finalizer role. Optional; when absent the adaptive planner's own finalize is
   *  used and the incremental planner's `done.result` is the answer (legacy). */
  finalizer?: IFinalizer;
  /** Injectable runId minter (tests pass a deterministic counter). */
  runIdMinter?: RunIdMinter;
  /** Clock seam (ISO now). Defaults to () => new Date().toISOString(). */
  now?: () => string;
  /** Terminal-store TTL in ms (default 24h). */
  terminalTtlMs?: number;
}

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
    // result (the result is now in plannerPrivate) → the adaptive planner replans
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
    // external-resume adopt below calls planner.commit() to keep the adaptive
    // planCursor in lockstep with nextSeq. Stateless construction; the main loop
    // reuses this same instance.
    const planner = makePlanner(
      deps.config.planner ?? 'incremental',
      deps.planner,
      deps.config.subagents.planner?.hint,
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
          // adaptive planCursor advances with nextSeq.
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
        await writeArtifact(rag, {
          ...meta,
          artifactType: 'mcp-result',
          toolName,
          task: bundle.pending.position,
          content: result,
        });
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
          // Legacy path (no inFlightStep — e.g. a seeded adaptive bundle): feed the
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
        const proposed = bundle.pending.proposedTarget;
        bundle.goal = proposed && isAffirmation(answer) ? proposed : answer;
      }
      bundle.plannerPrivate += `\n[clarify answer] ${prompt}`;
      bundle.pending = undefined;
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
    let planParseRetries = 0;
    // bundle.lastOutcome is the SINGLE source of truth for the last step's
    // outcome — durable, so a resume after a FAILED step replans instead of
    // repeating it. runStep.settle() sets it; the adaptive replan branch clears it
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
          // settle(), including planner.commit() so the adaptive planCursor advances
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
          now,
          terminalTtlMs,
          logUsage,
          usageNow,
          (o) => planner.commit?.(bundle, o),
        );
        if (completed === 'suspended' || completed === 'aborted') return true;
        continue;
      }

      // Planner crash-guard: a prior crash mid-call left plannerCallInFlight set →
      // charge plannerResumeCount; exhausting maxPlannerResumes is a TERMINAL abort
      // (store-first). The adaptive replan runs through planner.next too, so this one
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
      const next = await planner.next({
        bundle,
        prompt,
        lastOutcome: bundle.lastOutcome,
        resumedExternal,
        retrying: planParseRetries > 0,
        logUsage,
      });
      // The call completed → clear the in-flight marker + reset the resume counter
      // (a malformed reply is still a completed call; parse-retry is handled below).
      bundle.plannerCallInFlight = false;
      bundle.plannerResumeCount = 0;
      // NB: do NOT reset resumedExternal here — if this replan reply was malformed
      // (next === null), the parse-retry below must keep replanning. It is reset
      // only after a VALID decision (beside planParseRetries = 0;).
      // The adaptive planner mutates bundle.plan/planCursor in next(); persist so
      // a stateless resume continues from the same point. (No-op for incremental.)
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
        // injected (3-role config) — the adaptive planner already composed it.
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
        now,
        terminalTtlMs,
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
   *  tool-call budget exhausted; the failure note is in plannerPrivate so the
   *  planner can replan), 'partial' (reviewer approved part, remainder replans),
   *  'suspended' (external round-trip surfaced — caller must return true), or
   *  'aborted' (judge-failure exhausted — run terminated). */
  private async runStep(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    rag: IKnowledgeRagHandle,
    meta: KnowledgeEntryMetadata,
    step: Step,
    isExternalTool: (name: string) => boolean,
    now: () => string,
    terminalTtlMs: number,
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
    // Unrecoverable abort: store-first terminal ERROR, flip the bundle terminal,
    // surface the error, signal the caller to stop. Returns 'aborted'.
    const abortRun = async (error: string): Promise<'aborted'> => {
      await this.abortTerminal(
        ctx,
        sessionId,
        bundle,
        error,
        now,
        terminalTtlMs,
        usageNow?.(),
      );
      return 'aborted';
    };
    const messages: Message[] = [
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

    // Episodic recall: pull prior artifacts relevant to this step from
    // session-memory and inject them as context. The session-memory rag shares
    // the bundle backend, so restrict to artifact types (excludes the
    // 'controller-bundle' infrastructure record). Bounded by k and length.
    const recallText = step.instructions || step.name;
    const recalled = await resolveNeed(rag, recallText, RECALL_K, {
      artifactType: RECALL_ARTIFACT_TYPES,
    });
    const recallBlock = buildRecallBlock(recalled);
    if (recallBlock) {
      messages.push({ role: 'user', content: recallBlock });
    }

    // Durable transcript = static prefix (system/user/recall) + the dynamic
    // executor/tool turns. On a resume/continuation the dynamic tail is rebuilt
    // from inFlightStep.transcript so the executor sees the FULL exchange it had
    // (prior tool rounds + the injected external result), not just a fragment.
    const staticLen = messages.length;
    if (inFlight && inFlight.transcript.length > 0) {
      messages.push(...inFlight.transcript);
    }
    // Persist the dynamic tail after every executor/tool exchange so a suspend or
    // crash never rebuilds with a shorter conversation than the executor saw.
    const syncTranscript = async (): Promise<void> => {
      if (inFlight) {
        inFlight.transcript = messages.slice(staticLen);
        await persistBundle(deps.backend, sessionId, bundle);
      }
    };

    // Evidence for the reviewer: whether the step's recall surfaced anything. The
    // per-reference manifest (step.requires) is Task 16; for now one whole-step entry.
    const evidence = [{ ref: recallText, hit: recalled.length > 0 }];

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

    // Inner loop handles tool routing / error retries until the executor
    // produces content for this step (or the step suspends on an external tool).
    while (true) {
      const res = await deps.executor.send(messages, offeredTools);
      logUsage?.('executor', res.usage);

      if (res.kind === 'content') {
        // Hold the executor's result; the reviewer (NOT the executor) decides the
        // outcome. Default reviewer (no deps.reviewer) approves as 'ok' (legacy).
        let review: ReviewResult = deps.reviewer
          ? await deps.reviewer.review(step, evidence, res.content, {
              hint: deps.config.subagents.reviewer?.hint,
              logUsage,
            })
          : {
              kind: 'outcome',
              outcome: {
                status: 'ok',
                approved: res.content,
                remainder: '',
                note: '',
              },
            };

        // Judge failure (provider error / malformed / contradictory ok-with-empty)
        // is NOT a step failure: re-ask within maxReviewRetries, then ABORT (the
        // outcome is unverifiable). Never mapped to settle('failed')/replan.
        let reviewRetries = 0;
        while (review.kind === 'judge-failure') {
          reviewRetries++;
          if (reviewRetries > (cfg.maxReviewRetries ?? 2)) {
            return abortRun(
              `step ${step.name} outcome unverifiable: ${review.reason}`,
            );
          }
          review = await deps.reviewer!.review(step, evidence, res.content, {
            hint: deps.config.subagents.reviewer?.hint,
            logUsage,
          });
        }

        const outcome = review.outcome;
        const seq = bundle.inFlightStep?.seq ?? bundle.nextSeq ?? 0;
        const attempt = bundle.inFlightStep?.attempt ?? 0;
        // ONE post-review write carrying the COMPLETE Outcome + identity.
        await writeArtifact(rag, {
          ...meta,
          artifactType: 'step-result',
          task: step.name,
          runId: bundle.runId,
          seq,
          attempt,
          status: outcome.status,
          note: outcome.note,
          remainder: outcome.remainder,
          content: outcome.approved,
        });
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
          messages.push({
            role: 'user',
            content: `The previous attempt failed: ${res.error}. Retry the step.`,
          });
          await syncTranscript();
          continue;
        }
        // Retries exhausted — feed the error back as the step result so the
        // planner can replan on the next iteration.
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name} failed] ${res.error}`;
        return settle('failed');
      }

      // res.kind === 'tool_call' → route the FIRST tool call.
      const firstCall = res.toolCalls[0];
      if (firstCall === undefined) {
        // Empty tool-call array → treat as an executor error (retry/replan).
        retries++;
        if (retries <= cfg.maxRetries) {
          messages.push({
            role: 'user',
            content:
              'The previous attempt produced an empty tool call. Retry the step.',
          });
          await syncTranscript();
          continue;
        }
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name} failed] empty tool call`;
        return settle('failed');
      }
      const call = toLlmToolCall(firstCall);
      const name = call.name;
      const args = call.arguments;

      if (isExternalTool(name)) {
        // External round-trips share the SAME durable toolCallCount/maxToolCalls
        // bound as internal calls; check BEFORE surfacing so an external tool
        // cannot exceed the cap. Exhausted → control-failed replan at the same seq.
        if (inFlight && inFlight.toolCallCount + 1 > maxToolCalls) {
          bundle.budgets.stepsUsed++;
          bundle.plannerPrivate += `\n[seq ${inFlight.seq} ${step.name} control-failed] tool-call budget exhausted (maxToolCalls)`;
          inFlight.phase = 'awaiting-replan';
          inFlight.controlFailure = {
            reason: 'maxToolCalls',
            seq: inFlight.seq,
          };
          return settle('failed');
        }
        // Sync the executor turns SO FAR into the durable transcript before we
        // suspend (the resume injection appends the external assistant/tool pair).
        await syncTranscript();
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
          messages.push({
            role: 'user',
            content: `Tool "${name}" is not available for this step. Use only the tools provided to you.`,
          });
          await syncTranscript();
          continue;
        }
        bundle.budgets.stepsUsed++;
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
      const result = await deps.callMcp(name, args);
      await writeArtifact(rag, {
        ...meta,
        artifactType: 'mcp-result',
        toolName: name,
        task: step.name,
        content: result,
      });
      // Feed the result back as a coherent assistant→tool turn (OpenAI protocol)
      // so the executor LLM continues from its own tool call rather than seeing a
      // bare user message. The assistant message carries the tool_call it made;
      // the tool message carries the result keyed by the same id.
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
      // The executor saw these turns → make them durable before the next round.
      await syncTranscript();
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
    /** Used ONLY when no finalizer is injected (3-role config): the adaptive
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
      // Legacy: the adaptive planner already composed the answer in done.result.
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
// Episodic recall tuning
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

/** Top-K tools surfaced from toolsRag per planner/step query. */
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

const TOOL_SELECT_K = 20;

/** Top-k recalled artifacts injected into the executor context per step. */
const RECALL_K = 5;
/** Artifact types eligible for recall (excludes the 'controller-bundle' record
 *  that shares the same backend). */
const RECALL_ARTIFACT_TYPES = ['step-result', 'mcp-result'] as const;
/** Hard cap on the total injected recall length (chars). */
const RECALL_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build a bounded "Relevant prior context" block from recalled artifacts, or
 *  undefined when there is nothing to inject. */
function buildRecallBlock(
  hits: readonly { content: string }[],
): string | undefined {
  if (hits.length === 0) return undefined;
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const c = h.content ?? '';
    if (c.length === 0) continue;
    if (used + c.length > RECALL_MAX_CHARS) {
      parts.push(c.slice(0, RECALL_MAX_CHARS - used));
      break;
    }
    parts.push(c);
    used += c.length;
  }
  if (parts.length === 0) return undefined;
  return `Relevant prior context:\n${parts.join('\n')}`;
}

/** Extract the user prompt from the request's textOrMessages. */
function extractPrompt(textOrMessages: string | Message[]): string {
  if (typeof textOrMessages === 'string') return textOrMessages;
  for (let i = textOrMessages.length - 1; i >= 0; i--) {
    if (textOrMessages[i].role === 'user')
      return textOrMessages[i].content ?? '';
  }
  return '';
}

/** Parse a planner content string into a NextStep, defensively. */
/** Parse the planner's reply into a NextStep, tolerating ```json fences and
 *  surrounding prose. Returns null when no valid decision can be extracted — the
 *  caller treats that as a FORMAT error (re-ask the planner), NOT a rewind, so a
 *  badly-formatted reply never silently burns the rewind budget. */
export function parseNextStep(content: string): NextStep | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as Partial<NextStep>;
    if (obj.kind === 'done' && typeof obj.result === 'string')
      return { kind: 'done', result: obj.result };
    if (obj.kind === 'rewind' && typeof obj.reason === 'string')
      return { kind: 'rewind', reason: obj.reason };
    if (obj.kind === 'next' && obj.step && typeof obj.step.name === 'string')
      return { kind: 'next', step: obj.step };
  } catch {
    // fall through
  }
  return null;
}

/** Extract the first balanced JSON object from a planner reply, ignoring ```json
 *  fences and prose around it. String-aware (braces inside strings don't count).
 *  Returns null if no balanced object is present. */
export function extractJsonObject(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/** Normalize a StreamToolCall (full or delta) into an LlmToolCall. */
function toLlmToolCall(c: StreamToolCall): LlmToolCall {
  if (
    'arguments' in c &&
    typeof c.arguments === 'object' &&
    c.arguments !== null
  ) {
    // Full LlmToolCall: arguments is already a parsed object.
    return {
      id: ('id' in c && c.id) || 'call',
      name: ('name' in c && c.name) || '',
      arguments: c.arguments as Record<string, unknown>,
    };
  }
  // Delta: arguments is a (possibly partial) JSON string.
  let args: Record<string, unknown> = {};
  const raw = 'arguments' in c ? c.arguments : undefined;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      args = {};
    }
  }
  return {
    id: ('id' in c && c.id) || 'call',
    name: ('name' in c && c.name) || '',
    arguments: args,
  };
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

/** Gather the run's approved results, one per seq, resolved by outcome precedence
 *  (ok/exists > partial > failed), ordered by seq. Reconstructs the complete
 *  Outcome from artifact metadata (status/note/remainder) + content. */
async function collectApproved(
  rag: IKnowledgeRagHandle,
  runId: string,
): Promise<{ seq: number; content: string }[]> {
  const all = await rag.list({ runId, artifactType: 'step-result' });
  const bySeq = new Map<number, Outcome[]>();
  for (const e of all) {
    const seq = e.metadata.seq ?? 0;
    const o: Outcome = {
      status: (e.metadata.status ?? 'failed') as Outcome['status'],
      approved: e.content,
      remainder: e.metadata.remainder ?? '',
      note: e.metadata.note ?? '',
    };
    const arr = bySeq.get(seq);
    if (arr) arr.push(o);
    else bySeq.set(seq, [o]);
  }
  const out: { seq: number; content: string }[] = [];
  for (const [seq, outcomes] of [...bySeq.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const resolved = resolveByPrecedence(outcomes);
    if (resolved && resolved.status !== 'failed')
      out.push({ seq, content: resolved.approved });
  }
  return out;
}
