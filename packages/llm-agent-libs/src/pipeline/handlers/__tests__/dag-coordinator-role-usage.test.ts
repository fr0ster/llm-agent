import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  ExecutionReviewDecision,
  IInterpreter,
  InterpretResult,
  IPlanner,
  IReviewStrategy,
  LlmUsage,
  ReviewVerdict,
} from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

/**
 * HIGH finding tests: planner+reviewer LLM usage must NOT escape the
 * session requestLogger. The coordinator handler logs `result.usage`
 * returned by each role into `ctx.requestLogger` under the request's
 * traceId, categorized as 'planner' or 'reviewer'.
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
    value: { content: string; finishReason?: string };
  }> = [];
  const ctx = {
    inputText: 'hi',
    sessionId: 't',
    requestLogger: logger,
    options: { trace: { traceId } },
    yield: (c: {
      ok: boolean;
      value: { content: string; finishReason?: string };
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
      plan: async (): Promise<DagPlan> => ({
        nodes: [{ id: 'n1', goal: 'g' }],
        createdAt: 0,
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
      plan: async () => plan,
    };
    const reviewerUsage: LlmUsage = {
      promptTokens: 50,
      completionTokens: 5,
      totalTokens: 55,
    };
    const reviewer: IReviewStrategy = {
      name: 'r',
      model: 'reviewer-model',
      review: async (): Promise<ReviewVerdict> => ({
        pass: true,
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
        return plan;
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
      review: async () => ({ pass: true }),
      reviewExecutionFailure: async (): Promise<ExecutionReviewDecision> => ({
        action: 'revise',
        revisedPlan: { nodes: [{ id: 'r1', goal: 'fix' }], createdAt: 0 },
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
        nodes: [{ id: 'n1', goal: 'g' }],
        createdAt: 0,
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
        nodes: [{ id: 'n1', goal: 'g' }],
        createdAt: 0,
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
