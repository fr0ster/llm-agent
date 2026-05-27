import type {
  ClarifySignal as ClarifySignalType,
  ContextPath,
  DagPlan,
  IActivationStrategy,
  IErrorStrategy,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IReviewStrategy,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import { AbortErrorStrategy } from '../../coordinator/index.js';
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
  /** Optional inspection-only subagent answering "real state" queries (git/FS/ABAP).
   *  Reachable only via NeedInfoSignal round-trips; never a DAG worker. */
  stateOracle?: ISubAgent;
  /** Bounds planner/reviewer/oracle round-trips + re-interprets per turn. Default 6. */
  maxRoundTrips?: number;
}

export class DagCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: DagCoordinatorHandlerDeps) {
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

    const runRole = async <T>(
      thunk: () => Promise<T>,
    ): Promise<{ value: T } | { ended: true }> => {
      for (;;) {
        try {
          return { value: await thunk() };
        } catch (err) {
          if (err instanceof ClarifySignal) {
            ctx.options?.sessionLogger?.logStep('coordinator_clarify', {
              question: (err as ClarifySignalType).question,
            });
            ctx.yield({
              ok: true,
              value: {
                content: CLARIFY_MARKER + (err as ClarifySignalType).question,
              },
            });
            ctx.yield({
              ok: true,
              value: { content: '', finishReason: 'stop' },
            });
            return { ended: true };
          }
          if (err instanceof NeedInfoSignal) {
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
            const ans = await this.deps.stateOracle.run({
              task: (err as NeedInfoSignal).query,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
            });
            ancestorContext.oracleObservations.push({
              query: (err as NeedInfoSignal).query,
              answer: ans.output,
            });
            continue;
          }
          throw err;
        }
      }
    };

    let planRes: { value: DagPlan } | { ended: true };
    try {
      planRes = await runRole(() =>
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
    let plan = planRes.value;

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
          const gate = await runRole(() =>
            reviewer.review({
              prompt: ctx.inputText,
              plan,
              agents,
              ancestorContext,
              sessionId: ctx.sessionId,
              signal: ctx.options?.signal,
            }),
          );
          if ('ended' in gate) return true;
          const verdict = gate.value;
          if (!verdict.pass) {
            const replanned = await runRole(() =>
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
            plan = replanned.value;
            continue;
          }
        }

        let result: InterpretResult;
        try {
          result = await this.deps.interpreter.interpret(plan, {
            inputText: ctx.inputText,
            workers: this.deps.workers,
            sessionId: ctx.sessionId,
            signal: ctx.options?.signal,
            errorStrategy: this.deps.errorStrategy ?? new AbortErrorStrategy(),
            ancestorContext,
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
          ctx.yield({ ok: true, value: { content: result.output } });
          ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
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

        const recovery = await runRole(() =>
          reviewExecutionFailure({
            objective: execPlan.objective,
            plan: execPlan,
            trace,
            failedNodeId: failedId,
            error:
              result.nodeResults[failedId]?.error ?? result.error ?? 'unknown',
            agents,
            ancestorContext,
            sessionId: ctx.sessionId,
            signal: ctx.options?.signal,
          }),
        );
        if ('ended' in recovery) return true;
        const decision = recovery.value;
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
