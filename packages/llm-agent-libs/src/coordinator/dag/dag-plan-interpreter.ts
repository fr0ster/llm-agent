import type {
  DagPlan,
  IInterpreter,
  InterpretContext,
  InterpretResult,
  ISubAgent,
  NodeResult,
  PlanNode,
} from '@mcp-abap-adt/llm-agent';
import { composeNodeTask } from './compose-node-task.js';
import { spliceSubPlan } from './splice-sub-plan.js';

class PlanInvalidError extends Error {
  readonly code = 'COORDINATOR_PLAN_INVALID';
}

export class DagPlanInterpreter
  implements IInterpreter<DagPlan, InterpretResult>
{
  readonly name = 'dag';

  async interpret(
    plan: DagPlan,
    ctx: InterpretContext,
  ): Promise<InterpretResult> {
    this.validate(plan, ctx);

    const results: Record<string, NodeResult> = {};
    const done = new Set<string>();
    let currentPlan = plan;
    const maxReplans = ctx.errorStrategy.maxReplans ?? 4;
    let replansUsed = 0;

    for (;;) {
      const ready = currentPlan.nodes.filter(
        (n) =>
          !(n.id in results) && (n.dependsOn ?? []).every((d) => done.has(d)),
      );
      if (ready.length === 0) break;

      type Outcome =
        | { node: PlanNode; kind: 'done'; output: string; durationMs: number }
        | {
            node: PlanNode;
            kind: 'failed';
            error: unknown;
            task: string;
            durationMs: number;
          };
      const planForWave = currentPlan;
      const outcomes = await Promise.all(
        ready.map(async (n): Promise<Outcome> => {
          const depOutputs: Record<string, string> = {};
          for (const d of n.dependsOn ?? []) depOutputs[d] = results[d].output;
          const task = composeNodeTask(
            n,
            planForWave,
            ctx.inputText,
            depOutputs,
            ctx.ancestorContext,
          );
          const started = Date.now();
          try {
            const res = await this.resolveWorker(n, ctx).run({
              task,
              sessionId: ctx.sessionId,
              signal: ctx.signal,
              trace: ctx.trace,
              sessionLogger: ctx.sessionLogger,
            });
            if (res.errorClass === 'epicfail') {
              return {
                node: n,
                kind: 'failed',
                error: new Error('epicfail'),
                task,
                durationMs: Date.now() - started,
              };
            }
            return {
              node: n,
              kind: 'done',
              output: res.output,
              durationMs: Date.now() - started,
            };
          } catch (error) {
            return {
              node: n,
              kind: 'failed',
              error,
              task,
              durationMs: Date.now() - started,
            };
          }
        }),
      );

      let splicedThisWave = false;
      // Record successes first, then process failures in plan-node order.
      for (const o of outcomes) {
        if (o.kind !== 'done') continue;
        results[o.node.id] = {
          nodeId: o.node.id,
          output: o.output,
          status: 'done',
          durationMs: o.durationMs,
        };
        done.add(o.node.id);
      }
      const failures = outcomes.filter(
        (o): o is Extract<Outcome, { kind: 'failed' }> => o.kind === 'failed',
      );
      for (const o of failures) {
        const remainingReplans = maxReplans - replansUsed;
        const reaction = await ctx.errorStrategy.onNodeFailure(
          o.node,
          o.error,
          {
            task: o.task,
            remainingReplans,
            agents: [...ctx.workers.values()].map((w) => ({
              name: w.name,
              description: w.description,
            })),
            sessionId: ctx.sessionId,
            signal: ctx.signal,
          },
        );
        if (reaction.action === 'replan' && remainingReplans > 0) {
          if (reaction.subPlan.nodes.length === 0) {
            throw new PlanInvalidError(
              `COORDINATOR_PLAN_INVALID: replan for node '${o.node.id}' produced an empty sub-plan`,
            );
          }
          currentPlan = spliceSubPlan(currentPlan, o.node.id, reaction.subPlan);
          replansUsed++;
          splicedThisWave = true;
        } else {
          results[o.node.id] = {
            nodeId: o.node.id,
            output: '',
            status: 'failed',
            error: o.error instanceof Error ? o.error.message : String(o.error),
            durationMs: o.durationMs,
          };
        }
      }

      if (splicedThisWave) this.validate(currentPlan, ctx);
    }

    for (const n of currentPlan.nodes) {
      if (!(n.id in results)) {
        results[n.id] = {
          nodeId: n.id,
          output: '',
          status: 'skipped',
          durationMs: 0,
        };
      }
    }

    const failed = currentPlan.nodes.filter(
      (n) => results[n.id].status !== 'done',
    );
    if (failed.length > 0) {
      const firstFailed = currentPlan.nodes.find(
        (n) => results[n.id].status === 'failed',
      );
      return {
        nodeResults: results,
        ok: false,
        error: firstFailed
          ? `node '${firstFailed.id}' failed: ${results[firstFailed.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
        failedNodeId: firstFailed?.id,
        executedPlan: currentPlan,
      };
    }

    const depended = new Set(
      currentPlan.nodes.flatMap((n) => n.dependsOn ?? []),
    );
    const terminals = currentPlan.nodes.filter((n) => !depended.has(n.id));
    const output = terminals.map((n) => results[n.id].output).join('\n\n');
    return { nodeResults: results, ok: true, output };
  }

  private resolveWorker(node: PlanNode, ctx: InterpretContext): ISubAgent {
    if (node.agent) {
      const w = ctx.workers.get(node.agent);
      if (!w)
        throw new PlanInvalidError(
          `COORDINATOR_PLAN_INVALID: node '${node.id}' targets unknown worker '${node.agent}'`,
        );
      return w;
    }
    if (ctx.workers.size === 1) return [...ctx.workers.values()][0];
    throw new PlanInvalidError(
      `COORDINATOR_PLAN_INVALID: node '${node.id}' omits 'agent' but there are ${ctx.workers.size} workers`,
    );
  }

  private validate(plan: DagPlan, ctx: InterpretContext): void {
    if (plan.nodes.length === 0) {
      throw new PlanInvalidError(
        'COORDINATOR_PLAN_INVALID: empty plan (no nodes)',
      );
    }
    const ids = new Set<string>();
    for (const n of plan.nodes) {
      if (ids.has(n.id))
        throw new PlanInvalidError(
          `COORDINATOR_PLAN_INVALID: duplicate node id '${n.id}'`,
        );
      ids.add(n.id);
    }
    for (const n of plan.nodes) {
      for (const d of n.dependsOn ?? []) {
        if (!ids.has(d))
          throw new PlanInvalidError(
            `COORDINATOR_PLAN_INVALID: node '${n.id}' depends on unknown '${d}'`,
          );
      }
      const worker = this.resolveWorker(n, ctx);
      // The interpreter feeds node data (dependency outputs + user input) through
      // the composed task text, never the ISubAgentInput.context field. A worker
      // with contextPolicy='required' would fail opaquely inside run(); reject the
      // whole plan up front instead. (DagCoordinatorHandler also guards this at
      // startup, but the interpreter enforces its own contract for direct callers.)
      if (worker.capabilities?.contextPolicy === 'required') {
        throw new PlanInvalidError(
          `COORDINATOR_PLAN_INVALID: node '${n.id}' targets worker '${worker.name}' with ` +
            "contextPolicy='required', but the DAG interpreter supplies node data via the " +
            'composed task text, not the context field',
        );
      }
    }
    this.assertAcyclic(plan);
  }

  private assertAcyclic(plan: DagPlan): void {
    const state = new Map<string, 0 | 1 | 2>();
    const byId = new Map(plan.nodes.map((n) => [n.id, n]));
    const visit = (id: string): void => {
      const s = state.get(id) ?? 0;
      if (s === 1)
        throw new PlanInvalidError(
          `COORDINATOR_PLAN_INVALID: cycle at '${id}'`,
        );
      if (s === 2) return;
      state.set(id, 1);
      for (const d of byId.get(id)?.dependsOn ?? []) visit(d);
      state.set(id, 2);
    };
    for (const n of plan.nodes) visit(n.id);
  }
}
