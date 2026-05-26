import type {
  DagPlan,
  IActivationStrategy,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export interface DagCoordinatorHandlerDeps {
  planner: IPlanner;
  interpreter: IInterpreter<DagPlan, InterpretResult>;
  workers: ReadonlyMap<string, ISubAgent>;
  /** Activation strategy (shared concept with the linear coordinator). When
   *  omitted, the pipeline defaults to ExplicitActivation. The handler itself
   *  does not read this; the pipeline uses it to wire `coordinator-activate`. */
  activation?: IActivationStrategy;
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
    let plan: DagPlan;
    try {
      plan = await this.deps.planner.plan({
        prompt: ctx.inputText,
        agents: [...this.deps.workers.values()].map((w) => ({
          name: w.name,
          description: w.description,
        })),
        sessionId: ctx.sessionId,
        signal: ctx.options?.signal,
      });
    } catch (err) {
      ctx.error = new OrchestratorError(errMsg(err), 'COORDINATOR_PLAN_FAILED');
      return false;
    }

    let result: InterpretResult;
    try {
      result = await this.deps.interpreter.interpret(plan, {
        inputText: ctx.inputText,
        workers: this.deps.workers,
        sessionId: ctx.sessionId,
        signal: ctx.options?.signal,
        layer: ctx.layer ?? 0,
      });
    } catch (err) {
      // Structural plan errors: preserve a COORDINATOR_PLAN_INVALID code the
      // interpreter set; otherwise default to it.
      ctx.error =
        err instanceof OrchestratorError
          ? err
          : new OrchestratorError(
              errMsg(err),
              codeOf(err) ?? 'COORDINATOR_PLAN_INVALID',
            );
      return false;
    }

    if (!result.ok) {
      ctx.error = new OrchestratorError(
        `coordinator: ${result.error ?? 'plan execution failed'}`,
        'COORDINATOR_STEP_FAILED',
      );
      return false;
    }

    ctx.options?.sessionLogger?.logStep('dag_coordinator_final', {
      nodeCount: plan.nodes.length,
      outputLength: result.output.length,
    });
    ctx.yield({ ok: true, value: { content: result.output } });
    ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
    return true;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
