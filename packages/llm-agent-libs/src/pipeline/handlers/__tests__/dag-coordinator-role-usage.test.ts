import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ExecutionReviewResult,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IReviewStrategy,
  LlmUsage,
  PlannerResult,
  ReviewResult,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

/**
 * HIGH finding tests: planner+reviewer LLM usage must NOT escape the
 * session requestLogger. The coordinator handler logs `result.usage`
 * returned by each role into `ctx.requestLogger` under the request's
 * traceId, categorized as 'planner' or 'reviewer'.
 *
 * MEDIUM finding: usage is carried on the WRAPPER returned by each role
 * (PlannerResult / ReviewResult / ExecutionReviewResult), not on the
 * inner domain type (DagPlan / ReviewVerdict / ExecutionReviewDecision).
 */

const interpAlwaysOk = (
  output = 'ok',
): IInterpreter<DagPlan, InterpretResult> => ({
  name: 'i',
  interpret: async () => ({ nodeResults: {}, ok: true, output }),
});

function makeCtxWithLogger(traceId: string) {
  const logger = new SessionRequestLogger();
  logger.startRequest(traceId);
  const yields: Array<{
    ok: boolean;
    value: {
      content: string;
      finishReason?: string;
      usage?: LlmUsage;
    };
  }> = [];
  const ctx = {
    inputText: 'hi',
    sessionId: 't',
    requestLogger: logger,
    options: { trace: { traceId } },
    yield: (c: {
      ok: boolean;
      value: {
        content: string;
        finishReason?: string;
        usage?: LlmUsage;
      };
    }) => yields.push(c),
  } as unknown as Parameters<DagCoordinatorHandler['execute']>[0];
  return { ctx, yields, logger };
}

describe('DagCoordinatorHandler role-usage logging', () => {
  it('logs planner usage under byComponent["planner"]', async () => {
    const usage: LlmUsage = {
      promptTokens: 111,
      completionTokens: 22,
      totalTokens: 133,
    };
    const planner: IPlanner = {
      name: 'p',
      model: 'planner-model',
      plan: async (): Promise<PlannerResult> => ({
        plan: { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 },
        usage,
      }),
    };
    const { ctx, logger } = makeCtxWithLogger('trace-planner');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    const summary = logger.getSummary('trace-planner');
    assert.equal(summary.byComponent.planner?.promptTokens, 111);
    assert.equal(summary.byComponent.planner?.completionTokens, 22);
    assert.equal(summary.byComponent.planner?.totalTokens, 133);
    assert.equal(summary.byComponent.planner?.requests, 1);
    assert.equal(summary.byModel['planner-model']?.totalTokens, 133);
    // CATEGORY_MAP: planner -> 'auxiliary'
    assert.equal(summary.byCategory.auxiliary?.totalTokens, 133);
  });

  it('logs reviewer.review usage under byComponent["reviewer"]', async () => {
    const plan: DagPlan = { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 };
    const planner: IPlanner = {
      name: 'p',
      plan: async () => ({ plan }),
    };
    const reviewerUsage: LlmUsage = {
      promptTokens: 50,
      completionTokens: 5,
      totalTokens: 55,
    };
    const reviewer: IReviewStrategy = {
      name: 'r',
      model: 'reviewer-model',
      review: async (): Promise<ReviewResult> => ({
        verdict: { pass: true },
        usage: reviewerUsage,
      }),
    };
    const { ctx, logger } = makeCtxWithLogger('trace-reviewer');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
      reviewer,
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    const summary = logger.getSummary('trace-reviewer');
    assert.equal(summary.byComponent.reviewer?.totalTokens, 55);
    assert.equal(summary.byComponent.reviewer?.requests, 1);
    assert.equal(summary.byModel['reviewer-model']?.totalTokens, 55);
    assert.equal(summary.byCategory.auxiliary?.totalTokens, 55);
  });

  it('logs reviewExecutionFailure usage under byComponent["reviewer"]', async () => {
    const plan: DagPlan = { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 };
    let planCalls = 0;
    const planner: IPlanner = {
      name: 'p',
      plan: async () => {
        planCalls++;
        return { plan };
      },
    };
    const recoveryUsage: LlmUsage = {
      promptTokens: 80,
      completionTokens: 8,
      totalTokens: 88,
    };
    let interpCalls = 0;
    const interpreter: IInterpreter<DagPlan, InterpretResult> = {
      name: 'i',
      interpret: async () => {
        interpCalls++;
        if (interpCalls === 1) {
          return {
            nodeResults: {
              n1: { nodeId: 'n1', status: 'failed', error: 'boom' },
            },
            ok: false,
            error: 'boom',
            output: '',
            failedNodeId: 'n1',
            executedPlan: { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 },
          };
        }
        return { nodeResults: {}, ok: true, output: 'done' };
      },
    };
    const reviewer: IReviewStrategy = {
      name: 'r',
      model: 'recovery-model',
      review: async () => ({ verdict: { pass: true } }),
      reviewExecutionFailure: async (): Promise<ExecutionReviewResult> => ({
        decision: {
          action: 'revise',
          revisedPlan: { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 },
        },
        usage: recoveryUsage,
      }),
    };
    const { ctx, logger } = makeCtxWithLogger('trace-recovery');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter,
      workers: new Map(),
      reviewer,
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(planCalls, 1);
    const summary = logger.getSummary('trace-recovery');
    assert.equal(summary.byComponent.reviewer?.totalTokens, 88);
    assert.equal(summary.byModel['recovery-model']?.totalTokens, 88);
    assert.equal(summary.byCategory.auxiliary?.totalTokens, 88);
  });

  it('does not log when role omits usage (non-LLM strategies)', async () => {
    const planner: IPlanner = {
      name: 'p',
      plan: async () => ({
        plan: { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 },
      }),
    };
    const { ctx, logger } = makeCtxWithLogger('trace-nousage');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    const summary = logger.getSummary('trace-nousage');
    assert.equal(summary.byComponent.planner, undefined);
  });

  it('logs planner usage on ClarifySignal path (signal-path spend not lost)', async () => {
    const usage: LlmUsage = {
      promptTokens: 33,
      completionTokens: 3,
      totalTokens: 36,
    };
    const planner: IPlanner = {
      name: 'p',
      model: 'planner-model',
      plan: async () => {
        throw new ClarifySignal('overwrite ok?', usage);
      },
    };
    const { ctx, yields, logger } = makeCtxWithLogger('trace-clarify');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.ok(yields.length >= 2);
    const summary = logger.getSummary('trace-clarify');
    assert.equal(summary.byComponent.planner?.totalTokens, 36);
    assert.equal(summary.byModel['planner-model']?.totalTokens, 36);
    // Fix #12: the terminal `finishReason:'stop'` yield carries `usage`
    // (mirrors the success-path pattern). Without this, agent.process's
    // response-assembler returns response.usage = zero on clarify paths
    // even though /v1/usage is correct.
    const terminal = yields[yields.length - 1];
    assert.equal(terminal.value.finishReason, 'stop');
    assert.equal(terminal.value.content, '');
    assert.equal(terminal.value.usage?.promptTokens, 33);
    assert.equal(terminal.value.usage?.completionTokens, 3);
    assert.equal(terminal.value.usage?.totalTokens, 36);
    // And NOT on the content yield (would double-count via the assembler).
    const content = yields[yields.length - 2];
    assert.equal(content.value.usage, undefined);
  });

  it('logs reviewer usage on NeedInfoSignal path (signal-path spend not lost)', async () => {
    const usage: LlmUsage = {
      promptTokens: 21,
      completionTokens: 2,
      totalTokens: 23,
    };
    const plan: DagPlan = { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 };
    const planner: IPlanner = { name: 'p', plan: async () => ({ plan }) };
    let reviewCalls = 0;
    const reviewer: IReviewStrategy = {
      name: 'r',
      model: 'reviewer-model',
      review: async () => {
        reviewCalls++;
        if (reviewCalls === 1) {
          throw new NeedInfoSignal('which table?', usage);
        }
        return { verdict: { pass: true } };
      },
    };
    const oracle = {
      name: 'o',
      capabilities: { contextPolicy: 'optional' as const },
      run: async () => ({ output: 'ZCUST' }),
    } as unknown as import('@mcp-abap-adt/llm-agent').ISubAgent;
    const { ctx, logger } = makeCtxWithLogger('trace-needinfo');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
      reviewer,
      stateOracle: oracle,
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, true);
    assert.equal(reviewCalls, 2);
    const summary = logger.getSummary('trace-needinfo');
    assert.equal(summary.byComponent.reviewer?.totalTokens, 23);
    assert.equal(summary.byModel['reviewer-model']?.totalTokens, 23);
  });

  it('logs planner usage on parse-error path (failed-call spend not lost)', async () => {
    // MEDIUM finding: a parse-/shape-error path through the planner adapter
    // still consumed LLM tokens. The adapter attaches `res.usage` onto the
    // thrown Error via withUsage; runRole's outer catch reads `.usage` from
    // the Error and bills it via logRoleUsage before rethrowing.
    const usage: LlmUsage = {
      promptTokens: 17,
      completionTokens: 5,
      totalTokens: 22,
    };
    const planner: IPlanner = {
      name: 'p',
      model: 'planner-model',
      plan: async () => {
        const err = new Error('Planner output contained malformed JSON: ...');
        (err as Error & { usage?: LlmUsage }).usage = usage;
        throw err;
      },
    };
    const { ctx, logger } = makeCtxWithLogger('trace-planner-parse');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false); // handler bails with COORDINATOR_PLAN_FAILED
    const summary = logger.getSummary('trace-planner-parse');
    assert.equal(summary.byComponent.planner?.totalTokens, 22);
    assert.equal(summary.byComponent.planner?.requests, 1);
    assert.equal(summary.byModel['planner-model']?.totalTokens, 22);
    assert.equal(summary.byCategory.auxiliary?.totalTokens, 22);
  });

  it('logs reviewer usage on parse-error path', async () => {
    const usage: LlmUsage = {
      promptTokens: 30,
      completionTokens: 6,
      totalTokens: 36,
    };
    const plan: DagPlan = { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 };
    const planner: IPlanner = { name: 'p', plan: async () => ({ plan }) };
    const reviewer: IReviewStrategy = {
      name: 'r',
      model: 'reviewer-model',
      review: async () => {
        const err = new Error("Reviewer verdict must have a boolean 'pass'");
        (err as Error & { usage?: LlmUsage }).usage = usage;
        throw err;
      },
    };
    const { ctx, logger } = makeCtxWithLogger('trace-reviewer-parse');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
      reviewer,
    });
    const ok = await h.execute(ctx, {}, {} as never);
    assert.equal(ok, false);
    const summary = logger.getSummary('trace-reviewer-parse');
    assert.equal(summary.byComponent.reviewer?.totalTokens, 36);
    assert.equal(summary.byModel['reviewer-model']?.totalTokens, 36);
  });

  it('falls back to model="unknown" when planner does not expose model', async () => {
    const usage: LlmUsage = {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    };
    const planner: IPlanner = {
      // model intentionally omitted
      name: 'p',
      plan: async () => ({
        plan: { nodes: [{ id: 'n1', goal: 'g' }], createdAt: 0 },
        usage,
      }),
    };
    const { ctx, logger } = makeCtxWithLogger('trace-unknown-model');
    const h = new DagCoordinatorHandler({
      planner,
      interpreter: interpAlwaysOk(),
      workers: new Map(),
    });
    await h.execute(ctx, {}, {} as never);
    const summary = logger.getSummary('trace-unknown-model');
    assert.equal(summary.byModel.unknown?.totalTokens, 12);
  });
});
