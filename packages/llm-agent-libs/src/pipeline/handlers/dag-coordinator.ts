import type {
  ClarifySignal as ClarifySignalType,
  ContextPath,
  DagPlan,
  ExecutionReviewResult,
  IActivationStrategy,
  IErrorStrategy,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IReviewStrategy,
  IStateOracle,
  ISubAgent,
  LlmComponent,
  LlmUsage,
  OnPartial,
  PlannerResult,
  ReviewResult,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import { PassthroughFinalizer } from '../../coordinator/dag/passthrough-finalizer.js';
import { AbortErrorStrategy } from '../../coordinator/index.js';
import { summaryToUsage } from '../../logger/session-request-logger.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

/**
 * Marker prefixed onto a coordinator-emitted clarification question. `Message`
 * has no metadata field, so the marker lives in the assistant content — but it is
 * zero-width (invisible): the user/API sees only the question. On the next turn
 * `buildAncestorContext` reconstructs the clarification Q/A ONLY from the marked
 * tail turn. This is a coordinator-internal protocol detail (emit + reconstruct
 * are both here), NOT a public contract — hence it lives in llm-agent-libs, not in
 * the contracts package. Zero-width: U+2063 INVISIBLE SEPARATOR x3.
 */
export const CLARIFY_MARKER = '⁣⁣⁣';

export interface DagCoordinatorHandlerDeps {
  planner: IPlanner;
  interpreter: IInterpreter<DagPlan, InterpretResult>;
  workers: ReadonlyMap<string, ISubAgent>;
  /** Activation strategy (shared concept with the linear coordinator). When
   *  omitted, the pipeline defaults to ExplicitActivation. The handler itself
   *  does not read this; the pipeline uses it to wire `coordinator-activate`. */
  activation?: IActivationStrategy;
  /** Optional plan reviewer. When present, the coordinator runs it as a gate
   *  between planning and execution; a non-pass verdict triggers a replan loop.
   *  Absent → no gate. */
  reviewer?: IReviewStrategy;
  /** Error strategy for DAG node failures. Defaults to AbortErrorStrategy. */
  errorStrategy?: IErrorStrategy;
  /** Optional inspection-only state oracle answering "real state" queries
   *  (git / FS / ABAP) via NeedInfoSignal round-trips. Wrapped by the
   *  server from a raw ISubAgent automatically; never a DAG worker. */
  stateOracle?: IStateOracle;
  /** Optional response synthesizer. Defaults to PassthroughFinalizer
   *  (which returns interpreter.output verbatim), so omitting it
   *  preserves the legacy DAG coordinator behaviour. */
  finalizer?: IFinalizer;
  /** Bounds planner/reviewer/oracle round-trips + re-interprets per turn. Default 6. */
  maxRoundTrips?: number;
}

export class DagCoordinatorHandler implements IStageHandler {
  private readonly finalizer: IFinalizer;

  constructor(private readonly deps: DagCoordinatorHandlerDeps) {
    this.finalizer = deps.finalizer ?? new PassthroughFinalizer();
    // The DAG interpreter passes data-flow (dependency outputs + user input)
    // through the composed task text, never through the ISubAgentInput.context
    // field. A worker with contextPolicy='required' (the DirectLlmSubAgent
    // default) would therefore always fail at dispatch. Reject it at startup
    // with a clear message instead of failing per-request.
    for (const [name, w] of deps.workers) {
      if (w.capabilities?.contextPolicy === 'required') {
        throw new Error(
          `DagCoordinatorHandler: worker '${name}' has contextPolicy='required', ` +
            'but the DAG interpreter supplies node data via the composed task text, ' +
            "not the context field. Use a worker with contextPolicy 'optional' or 'forbidden'.",
        );
      }
    }
  }

  async execute(
    ctx: PipelineContext,
    _rawConfig: Record<string, unknown>,
    _span: ISpan,
  ): Promise<boolean> {
    const maxRoundTrips = Math.max(1, this.deps.maxRoundTrips ?? 6);
    const ancestorContext = buildAncestorContext(ctx);
    const agents = [...this.deps.workers.values()].map((w) => ({
      name: w.name,
      description: w.description,
    }));
    let roundTrips = 0;

    // HIGH finding: planner+reviewer LLM spend was escaping both
    // /v1/usage and response.usage. The role return types now carry an
    // optional `usage` field; we forward it into the session requestLogger
    // here, keyed by the current traceId so it lands in the per-request
    // delta AND in the session-cumulative buckets (categorized as
    // 'auxiliary' via CATEGORY_MAP). Non-LLM strategies omit `usage`, so
    // this is a no-op for them.
    const logRoleUsage = (
      component: LlmComponent,
      model: string | undefined,
      usage: LlmUsage | undefined,
      durationMs: number,
    ): void => {
      if (!usage) return;
      ctx.requestLogger.logLlmCall({
        component,
        model: model ?? 'unknown',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        durationMs,
        requestId: ctx.options?.trace?.traceId,
      });
    };

    // Generic role runner. Owns logging for BOTH happy path AND signal paths
    // (HIGH finding: a role that throws ClarifySignal/NeedInfoSignal still
    // consumed LLM tokens — discarding them was invisible spend). Per-role
    // adapters set `signal.usage` on the signal before throwing; `runRole`
    // reads it here and routes it through the same `logRoleUsage`.
    const runRole = async <T extends { usage?: LlmUsage }>(
      component: LlmComponent,
      model: string | undefined,
      thunk: () => Promise<T>,
    ): Promise<{ value: T } | { ended: true }> => {
      for (;;) {
        const start = Date.now();
        try {
          const value = await thunk();
          logRoleUsage(component, model, value.usage, Date.now() - start);
          return { value };
        } catch (err) {
          if (err instanceof ClarifySignal) {
            logRoleUsage(component, model, err.usage, Date.now() - start);
            ctx.options?.sessionLogger?.logStep('coordinator_clarify', {
              question: (err as ClarifySignalType).question,
            });
            ctx.yield({
              ok: true,
              value: {
                content: CLARIFY_MARKER + (err as ClarifySignalType).question,
              },
            });
            // Attach per-request usage to the TERMINAL yield only — mirrors the
            // success-path pattern below (around the result.ok branch). The
            // response-assembler in agent.process sums chunk-level usage, so
            // putting usage on the content yield as well would double-count.
            // Without this, response.usage was zero on clarify paths even though
            // /v1/usage saw the spend (Fix #10 logged it into requestLogger).
            const traceIdClarify = ctx.options?.trace?.traceId;
            const usageClarify = traceIdClarify
              ? summaryToUsage(ctx.requestLogger.getSummary(traceIdClarify))
              : undefined;
            ctx.yield({
              ok: true,
              value: {
                content: '',
                finishReason: 'stop',
                ...(usageClarify ? { usage: usageClarify } : {}),
              },
            });
            return { ended: true };
          }
          if (err instanceof NeedInfoSignal) {
            logRoleUsage(component, model, err.usage, Date.now() - start);
            if (!this.deps.stateOracle) {
              throw new OrchestratorError(
                `coordinator: role requested info but no stateOracle is configured: ${(err as NeedInfoSignal).query}`,
                'COORDINATOR_NEEDINFO_UNRESOLVED',
              );
            }
            if (++roundTrips > maxRoundTrips) {
              throw new OrchestratorError(
                'coordinator: round-trip budget exhausted',
                'COORDINATOR_BUDGET_EXHAUSTED',
              );
            }
            const oracleStart = Date.now();
            const ans = await this.deps.stateOracle.query({
              query: (err as NeedInfoSignal).query,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
              trace: ctx.options?.trace,
              sessionLogger: ctx.options?.sessionLogger,
            });
            logRoleUsage(
              'oracle',
              this.deps.stateOracle.model,
              ans.usage,
              Date.now() - oracleStart,
            );
            ancestorContext.oracleObservations.push({
              query: (err as NeedInfoSignal).query,
              answer: ans.answer,
            });
            continue;
          }
          // MEDIUM finding: a role that throws a plain Error (parse-/shape-error
          // from LlmDagPlanner / LlmReviewStrategy) ALSO consumed LLM tokens;
          // those adapters now attach `res.usage` onto the Error via withUsage.
          // Bill it here before rethrowing so the failed call is still visible
          // in /v1/usage and the per-request delta (otherwise: real spend,
          // invisible).
          const failedUsage = (err as { usage?: LlmUsage }).usage;
          if (failedUsage) {
            logRoleUsage(component, model, failedUsage, Date.now() - start);
          }
          throw err;
        }
      }
    };

    let planRes: { value: PlannerResult } | { ended: true };
    const plannerModel = this.deps.planner.model;
    try {
      planRes = await runRole('planner', plannerModel, () =>
        this.deps.planner.plan({
          prompt: ctx.inputText,
          agents,
          ancestorContext,
          sessionId: ctx.sessionId,
          signal: ctx.options?.signal,
        }),
      );
    } catch (err) {
      ctx.error =
        err instanceof OrchestratorError
          ? err
          : new OrchestratorError(errMsg(err), 'COORDINATOR_PLAN_FAILED');
      return false;
    }
    if ('ended' in planRes) return true;
    let plan = planRes.value.plan;

    try {
      for (;;) {
        if (++roundTrips > maxRoundTrips) {
          ctx.error = new OrchestratorError(
            'coordinator: round-trip budget exhausted',
            'COORDINATOR_BUDGET_EXHAUSTED',
          );
          return false;
        }

        const reviewer = this.deps.reviewer;
        if (reviewer) {
          let gate: { value: ReviewResult } | { ended: true };
          const reviewerModel = reviewer.model;
          try {
            gate = await runRole('reviewer', reviewerModel, () =>
              reviewer.review({
                prompt: ctx.inputText,
                plan,
                agents,
                ancestorContext,
                sessionId: ctx.sessionId,
                signal: ctx.options?.signal,
              }),
            );
          } catch (err) {
            // A generic reviewer-gate failure keeps the slice-2 error code
            // (COORDINATOR_REVIEW_FAILED), not the loop's default STEP_FAILED.
            // OrchestratorError from runRole (needInfo-no-oracle / budget) is
            // preserved as-is.
            ctx.error =
              err instanceof OrchestratorError
                ? err
                : new OrchestratorError(
                    errMsg(err),
                    'COORDINATOR_REVIEW_FAILED',
                  );
            return false;
          }
          if ('ended' in gate) return true;
          const verdict = gate.value.verdict;
          if (!verdict.pass) {
            const replanned = await runRole('planner', plannerModel, () =>
              this.deps.planner.plan({
                prompt: ctx.inputText,
                agents,
                ancestorContext,
                reviewerFeedback: verdict.feedback,
                sessionId: ctx.sessionId,
                signal: ctx.options?.signal,
              }),
            );
            if ('ended' in replanned) return true;
            plan = replanned.value.plan;
            continue;
          }
        }

        const onPartial: OnPartial = (chunk) => {
          if (chunk.kind === 'content') {
            ctx.yield({ ok: true, value: { content: chunk.delta } });
          }
          // node-start / node-end / tool-call → session log only (NOT yielded to client)
          ctx.options?.sessionLogger?.logStep('dag_stream', chunk);
        };

        let result: InterpretResult;
        try {
          result = await this.deps.interpreter.interpret(plan, {
            inputText: ctx.inputText,
            workers: this.deps.workers,
            sessionId: ctx.sessionId,
            signal: ctx.options?.signal,
            errorStrategy: this.deps.errorStrategy ?? new AbortErrorStrategy(),
            ancestorContext,
            trace: ctx.options?.trace,
            sessionLogger: ctx.options?.sessionLogger,
            onPartial,
            // Issue #167: thread the client's external tools into worker dispatch.
            externalTools: ctx.externalTools,
          });
        } catch (err) {
          ctx.error =
            err instanceof OrchestratorError
              ? err
              : new OrchestratorError(
                  errMsg(err),
                  codeOf(err) ?? 'COORDINATOR_PLAN_INVALID',
                );
          return false;
        }

        if (result.ok) {
          ctx.options?.sessionLogger?.logStep('dag_coordinator_final', {
            nodeCount: plan.nodes.length,
            outputLength: result.output.length,
          });
          const executedPlan = result.executedPlan ?? plan;
          const nodeIndex = new Map(
            executedPlan.nodes?.map((n) => [n.id, n]) ?? [],
          );
          const executionTrace = (result.executionOrder ?? []).map((id) => ({
            nodeId: id,
            goal: nodeIndex.get(id)?.goal ?? '',
            output: result.nodeResults[id]?.output ?? '',
          }));
          const finalRes = await runRole(
            'finalizer',
            this.finalizer.model,
            () =>
              this.finalizer.finalize({
                prompt: ctx.inputText,
                objective: executedPlan.objective ?? ctx.inputText,
                ancestorContext,
                interpreterOutput: result.output,
                executionTrace,
                sessionId: ctx.sessionId,
                signal: ctx.options?.signal,
                trace: ctx.options?.trace,
                onPartial,
              }),
          );
          if ('ended' in finalRes) return true;
          // Attach usage ONLY to the terminal `finishReason:'stop'` chunk.
          // The agent's response assembler accumulates usage across yielded
          // chunks; including usage on both yields would double-count.
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

        const reviewExecutionFailure =
          reviewer?.reviewExecutionFailure?.bind(reviewer);
        if (!reviewExecutionFailure) {
          ctx.error = new OrchestratorError(
            `coordinator: ${result.error ?? 'plan execution failed'}`,
            'COORDINATOR_STEP_FAILED',
          );
          return false;
        }

        const execPlan = result.executedPlan ?? plan;
        const trace = execPlan.nodes
          .map((n) => result.nodeResults[n.id])
          .filter((r): r is NonNullable<typeof r> => Boolean(r));
        const failedId = result.failedNodeId ?? execPlan.nodes[0]?.id ?? '';

        const recovery: { value: ExecutionReviewResult } | { ended: true } =
          await runRole('reviewer', reviewer?.model, () =>
            reviewExecutionFailure({
              objective: execPlan.objective,
              plan: execPlan,
              trace,
              failedNodeId: failedId,
              error:
                result.nodeResults[failedId]?.error ??
                result.error ??
                'unknown',
              agents,
              ancestorContext,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
            }),
          );
        if ('ended' in recovery) return true;
        const decision = recovery.value.decision;
        if (decision.action === 'revise') {
          if (decision.revisedPlan.nodes.length === 0) {
            ctx.error = new OrchestratorError(
              'coordinator: reviewer returned an empty revised plan',
              'COORDINATOR_PLAN_INVALID',
            );
            return false;
          }
          plan = decision.revisedPlan;
          continue;
        }
        ctx.error = new OrchestratorError(
          `coordinator: recovery aborted: ${result.error ?? 'unknown'}`,
          'COORDINATOR_STEP_FAILED',
        );
        return false;
      }
    } catch (err) {
      ctx.error =
        err instanceof OrchestratorError
          ? err
          : new OrchestratorError(errMsg(err), 'COORDINATOR_STEP_FAILED');
      return false;
    }
  }
}

export function buildAncestorContext(ctx: PipelineContext): ContextPath {
  const h = ctx.history ?? [];
  const n = h.length;
  const isMarked = (m?: { role: string; content: string | null }) =>
    m?.role === 'assistant' &&
    typeof m.content === 'string' &&
    m.content.startsWith(CLARIFY_MARKER);
  let mi = -1;
  if (isMarked(h[n - 1])) mi = n - 1;
  else if (h[n - 1]?.role === 'user' && isMarked(h[n - 2])) mi = n - 2;

  if (mi >= 0) {
    const question = (h[mi].content as string)
      .slice(CLARIFY_MARKER.length)
      .trim();
    const parent = h[mi - 1];
    const objective =
      parent?.role === 'user' && typeof parent.content === 'string'
        ? parent.content
        : ctx.inputText;
    return {
      objective,
      clarifications: [{ question, answer: ctx.inputText }],
      oracleObservations: [],
    };
  }
  return {
    objective: ctx.inputText,
    clarifications: [],
    oracleObservations: [],
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
