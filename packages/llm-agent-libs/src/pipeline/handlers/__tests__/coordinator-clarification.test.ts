import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IDispatchStrategy,
  IPlanningStrategy,
  Plan,
} from '@mcp-abap-adt/llm-agent';
import { CoordinatorHandler } from '../coordinator.js';

const clarifyPlanning: IPlanningStrategy = {
  name: 'clarify',
  buildInitialPlan: async (): Promise<Plan> => ({
    steps: [],
    clarification: 'What should I summarize?',
    createdAt: 0,
    source: 'planner-llm',
  }),
  shouldReplan: () => false,
  rebuildPlan: async () => ({ steps: [], createdAt: 0, source: 'planner-llm' }),
};

const throwingDispatch: IDispatchStrategy = {
  name: 'never',
  dispatch: async () => {
    throw new Error('dispatch must not be called on clarification');
  },
};

describe('CoordinatorHandler clarification gate', () => {
  it('streams the clarification and dispatches nothing', async () => {
    const yields: Array<{
      ok: boolean;
      value: { content: string; finishReason?: string };
    }> = [];
    const ctx = {
      inputText: 'ambiguous',
      sessionId: 't',
      yield: (c: {
        ok: boolean;
        value: { content: string; finishReason?: string };
      }) => {
        yields.push(c);
      },
    } as unknown as Parameters<CoordinatorHandler['execute']>[0];

    const handler = new CoordinatorHandler({
      planning: clarifyPlanning,
      dispatch: throwingDispatch,
      maxSteps: 10,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
    });

    const ok = await handler.execute(ctx, {}, {} as never);

    assert.equal(ok, true);
    assert.equal(yields[0].value.content, 'What should I summarize?');
    assert.equal(yields[1].value.finishReason, 'stop');
  });
});
