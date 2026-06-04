import type {
  DagPlan,
  IInterpreter,
  InterpretContext,
  InterpretResult,
  ISubAgent,
  LlmToolCall,
  NodeResult,
  PlanNode,
  StreamChunk,
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
    const executionOrder: string[] = [];
    // #171: collect-all-at-settle. Accumulate external tool calls surfaced by
    // awaiting-external nodes, preserving plan/topological wave order, deduped
    // by deterministic `ext:` id. An awaiting-external node is recorded in
    // `results` (so its wave excludes it) but NOT added to `done`, so its
    // dependents never become ready and fall through to the skipped-assignment
    // loop below — they re-run on resume once the client returns the result.
    const pendingExternalAccumulator: LlmToolCall[] = [];
    const seenExternalIds = new Set<string>();
    const collectExternal = (calls: readonly LlmToolCall[] | undefined) => {
      for (const call of calls ?? []) {
        if (seenExternalIds.has(call.id)) continue;
        seenExternalIds.add(call.id);
        pendingExternalAccumulator.push(call);
      }
    };
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
            kind: 'awaiting-external';
            pendingExternalToolCalls: LlmToolCall[];
            durationMs: number;
          }
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
          const outerOnPartial = ctx.onPartial;
          const workerOnPartial = outerOnPartial
            ? (c: StreamChunk) => {
                const annotated: StreamChunk = (() => {
                  if (c.kind === 'content') {
                    return { ...c, nodeId: c.nodeId ?? n.id };
                  }
                  return c;
                })();
                outerOnPartial(annotated);
              }
            : undefined;

          outerOnPartial?.({
            kind: 'stepper-spawned',
            source: { stepperId: n.id, name: n.id },
            goal: n.goal,
          });
          try {
            const res = await this.resolveWorker(n, ctx).run({
              task,
              sessionId: ctx.sessionId,
              signal: ctx.signal,
              trace: ctx.trace,
              sessionLogger: ctx.sessionLogger,
              onPartial: workerOnPartial,
              // Issue #167: thread client external tools into the worker.
              externalTools: ctx.externalTools,
              // #171 (review#7): thread the validated extId→result map so a
              // re-surfaced external call resolves from history on resume.
              externalResults: ctx.externalResults,
            });
            if (res.errorClass === 'epicfail') {
              outerOnPartial?.({
                kind: 'stepper-done',
                source: { stepperId: n.id, name: n.id },
                ok: false,
              });
              return {
                node: n,
                kind: 'failed',
                error: new Error('epicfail'),
                task,
                durationMs: Date.now() - started,
              };
            }
            if (res.status === 'awaiting-external') {
              // #171: the worker surfaced a client external tool call and is
              // waiting for its result. Not a failure — settle as awaiting.
              outerOnPartial?.({
                kind: 'stepper-done',
                source: { stepperId: n.id, name: n.id },
                ok: true,
              });
              return {
                node: n,
                kind: 'awaiting-external',
                pendingExternalToolCalls: res.pendingExternalToolCalls ?? [],
                durationMs: Date.now() - started,
              };
            }
            outerOnPartial?.({
              kind: 'stepper-done',
              source: { stepperId: n.id, name: n.id },
              ok: true,
            });
            return {
              node: n,
              kind: 'done',
              output: res.output,
              durationMs: Date.now() - started,
            };
          } catch (error) {
            outerOnPartial?.({
              kind: 'stepper-done',
              source: { stepperId: n.id, name: n.id },
              ok: false,
            });
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
        executionOrder.push(o.node.id);
      }
      // #171: record awaiting-external nodes in wave (plan/topo) order. They go
      // into `results` so the next wave's `ready` filter excludes them, but are
      // intentionally NOT added to `done` — so their dependents never become
      // ready this run and fall through to the skipped-assignment loop.
      for (const o of outcomes) {
        if (o.kind !== 'awaiting-external') continue;
        results[o.node.id] = {
          nodeId: o.node.id,
          output: '',
          status: 'awaiting-external',
          durationMs: o.durationMs,
        };
        executionOrder.push(o.node.id);
        collectExternal(o.pendingExternalToolCalls);
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

    // #171: an awaiting-external run is NOT a failure. If at least one node is
    // awaiting-external and no node actually failed, settle as ok=true and let
    // the coordinator branch on pendingExternalToolCalls (Task 6). Dependents of
    // awaiting nodes are 'skipped' this run and re-run on resume; they must not
    // be counted as failures here.
    const anyAwaiting = currentPlan.nodes.some(
      (n) => results[n.id].status === 'awaiting-external',
    );
    const anyFailed = currentPlan.nodes.some(
      (n) => results[n.id].status === 'failed',
    );
    if (anyAwaiting && !anyFailed) {
      return {
        nodeResults: results,
        ok: true,
        output: '',
        executedPlan: currentPlan,
        executionOrder,
        pendingExternalToolCalls: pendingExternalAccumulator,
      };
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
        executionOrder,
      };
    }

    const depended = new Set(
      currentPlan.nodes.flatMap((n) => n.dependsOn ?? []),
    );
    const terminals = currentPlan.nodes.filter((n) => !depended.has(n.id));
    const output = terminals.map((n) => results[n.id].output).join('\n\n');
    return {
      nodeResults: results,
      ok: true,
      output,
      executedPlan: currentPlan,
      executionOrder,
    };
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
