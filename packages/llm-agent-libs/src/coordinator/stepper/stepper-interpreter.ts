import type {
  DagPlan,
  IStepperInterpreter,
  IStepperResult,
  LlmUsage,
  RunIdentity,
} from '@mcp-abap-adt/llm-agent';

const ZERO: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  totalTokens: a.totalTokens + b.totalTokens,
});
const WORST = { ok: 0, incomplete: 1, 'budget-exhausted': 2 } as const;

export class StepperInterpreter implements IStepperInterpreter {
  readonly name = 'stepper';

  async interpret(
    plan: DagPlan,
    ctx: Parameters<IStepperInterpreter['interpret']>[1],
  ): Promise<IStepperResult> {
    const done = new Set<string>();
    const results = new Map<string, IStepperResult>();
    let usage = ZERO;
    let worst: IStepperResult['status'] = 'ok';

    const ready = () =>
      plan.nodes.filter(
        (n) => !done.has(n.id) && (n.dependsOn ?? []).every((d) => done.has(d)),
      );

    const runNode = async (node: DagPlan['nodes'][number]): Promise<void> => {
      const childId = ctx.mintStepperId();
      const childIdentity: RunIdentity = {
        ...ctx.identity,
        stepperId: childId,
        parentStepperId: ctx.identity.stepperId,
      };
      const subagent = node.agent
        ? ctx.childSteppers.get(node.agent)
        : undefined;
      // Decide the route FIRST, then build the ref name accordingly (review R6-F2):
      // a node with agent 'w' that is below the depth floor routes to the executor,
      // so its spawned event must say 'executor', not 'w'.
      const willRecurse = Boolean(
        node.agent && subagent && ctx.budget.depthRemaining > 0,
      );
      const refName = willRecurse ? (node.agent as string) : 'executor';
      const ref = {
        stepperId: childId,
        parentStepperId: ctx.identity.stepperId,
        name: refName,
      };
      ctx.onProgress?.({
        kind: 'stepper-spawned',
        source: ref,
        goal: node.goal,
      });

      let result: IStepperResult;

      if (willRecurse && subagent) {
        // Case 1 — recursive child Stepper. depthRemaining is a per-branch
        // value (decremented), but tokens is the SAME shared ledger reference
        // (review R2-F1) so spend is accounted across all branches (soft cap,
        // bounded overshoot under parallelism — review R3-F2).
        result = await subagent.run({
          prompt: composeTask(node, plan),
          knowledgeRag: ctx.knowledgeRag,
          toolsRag: ctx.toolsRag,
          budget: {
            depthRemaining: ctx.budget.depthRemaining - 1,
            tokens: ctx.budget.tokens,
          },
          identity: childIdentity,
          taskSpec: ctx.taskSpec,
          signal: ctx.signal,
          sessionLogger: ctx.sessionLogger,
          onProgress: ctx.onProgress,
        });
      } else if (ctx.executor) {
        // Case 2 (depth floor) + Case 3 (no agent) — terminal executor leaf
        const r = await ctx.executor.execute({
          prompt: composeTask(node, plan),
          tools: [],
          knowledgeRag: ctx.knowledgeRag,
          toolsRag: ctx.toolsRag,
          budget: ctx.budget,
          identity: childIdentity,
          taskSpec: ctx.taskSpec,
          signal: ctx.signal,
          sessionLogger: ctx.sessionLogger,
          onProgress: ctx.onProgress,
        });
        result = { status: r.status, missing: r.missing, usage: r.usage };
      } else {
        // Case 4 — nothing can execute this node
        result = {
          status: 'incomplete',
          missing: [
            `node '${node.id}' references unknown agent '${node.agent}' and no executor is available`,
          ],
          usage: ZERO,
        };
      }

      ctx.onProgress?.({
        kind: 'stepper-done',
        source: ref,
        ok: result.status === 'ok',
      });
      results.set(node.id, result);
      done.add(node.id);
      usage = addUsage(usage, result.usage);
      if (WORST[result.status] > WORST[worst]) worst = result.status;
    };

    // Wave scheduler with a maxParallelSteps pool.
    // Each wave: collect all ready nodes, then execute them in batches of `cap`
    // to ensure peak concurrency never exceeds the cap.
    while (done.size < plan.nodes.length) {
      const batch = ready();
      if (batch.length === 0) break; // dependency deadlock — shouldn't happen with valid plans
      const cap = Math.max(1, ctx.maxParallelSteps || 1);
      for (let i = 0; i < batch.length; i += cap) {
        await Promise.all(batch.slice(i, i + cap).map(runNode));
      }
    }

    return {
      status: worst,
      usage,
      ...(worst !== 'ok' ? { missing: collectMissing(results) } : {}),
    };
  }
}

function composeTask(node: DagPlan['nodes'][number], plan: DagPlan): string {
  return plan.objective
    ? `Objective: ${plan.objective}\nTask: ${node.goal}`
    : node.goal;
}

function collectMissing(results: Map<string, IStepperResult>): string[] {
  const out: string[] = [];
  for (const r of results.values()) if (r.missing) out.push(...r.missing);
  return out;
}
