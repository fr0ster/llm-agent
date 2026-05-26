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

    for (;;) {
      const ready = plan.nodes.filter(
        (n) =>
          !(n.id in results) && (n.dependsOn ?? []).every((d) => done.has(d)),
      );
      if (ready.length === 0) break;

      await Promise.all(
        ready.map(async (n) => {
          const depOutputs: Record<string, string> = {};
          for (const d of n.dependsOn ?? []) depOutputs[d] = results[d].output;
          const task = composeNodeTask(n, plan, ctx.inputText, depOutputs);
          const worker = this.resolveWorker(n, ctx);
          const started = Date.now();
          try {
            const res = await worker.run({
              task,
              sessionId: ctx.sessionId,
              signal: ctx.signal,
              layer: ctx.layer + 1,
            });
            // Slice 1 records an epicfail worker result as a plain node failure.
            // Cross-DAG epicfail-trace propagation (res.epicFailTrace) is
            // intentionally out of scope here (see slice-1 spec) — deferred.
            if (res.errorClass === 'epicfail') {
              results[n.id] = {
                nodeId: n.id,
                output: '',
                status: 'failed',
                error: 'epicfail',
                durationMs: Date.now() - started,
              };
            } else {
              results[n.id] = {
                nodeId: n.id,
                output: res.output,
                status: 'done',
                durationMs: Date.now() - started,
              };
              done.add(n.id);
            }
          } catch (err) {
            results[n.id] = {
              nodeId: n.id,
              output: '',
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - started,
            };
          }
        }),
      );
    }

    for (const n of plan.nodes) {
      if (!(n.id in results)) {
        results[n.id] = {
          nodeId: n.id,
          output: '',
          status: 'skipped',
          durationMs: 0,
        };
      }
    }

    const failed = plan.nodes.filter((n) => results[n.id].status !== 'done');
    if (failed.length > 0) {
      const first = plan.nodes.find((n) => results[n.id].status === 'failed');
      return {
        nodeResults: results,
        ok: false,
        error: first
          ? `node '${first.id}' failed: ${results[first.id].error ?? 'unknown'}`
          : 'plan did not complete',
        output: '',
      };
    }

    const depended = new Set(plan.nodes.flatMap((n) => n.dependsOn ?? []));
    const terminals = plan.nodes.filter((n) => !depended.has(n.id));
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
      this.resolveWorker(n, ctx);
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
