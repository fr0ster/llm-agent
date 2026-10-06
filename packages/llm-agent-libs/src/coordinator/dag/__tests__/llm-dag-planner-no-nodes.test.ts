/**
 * Spec §10.5.7 C8, §13 B6 (#171) — an LLM plan with no nodes is an invalid
 * plan, not a one-node plan made from the raw prompt.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type DagPlan,
  type IInterpreter,
  type ILlm,
  type InterpretResult,
  OrchestratorError,
  type PlannerInput,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { DefaultPipeline } from '../../../pipeline/default-pipeline.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import { LlmDagPlanner, parseDagPlan } from '../llm-dag-planner.js';

const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };

function llm(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content, usage } }),
  } as unknown as ILlm;
}

const input: PlannerInput = {
  prompt: 'call rag_add with collection=context and content=X',
  agents: [{ name: 'w', description: 'general worker' }],
  sessionId: 't',
};

describe('C8 LlmDagPlanner — no nodes', () => {
  for (const content of ['{"nodes":[]}', '{"objective":"O"}']) {
    it(`${content} → the plan rejects with COORDINATOR_PLAN_INVALID (usage kept)`, async () => {
      await assert.rejects(
        () => new LlmDagPlanner(llm(content)).plan(input),
        (e: unknown) =>
          e instanceof OrchestratorError &&
          e.code === 'COORDINATOR_PLAN_INVALID' &&
          /Planner returned no nodes/.test(e.message) &&
          (e as Error & { usage?: { totalTokens: number } }).usage
            ?.totalTokens === 5,
      );
    });
  }

  it('parseDagPlan takes no fallback goal: no nodes is always the error', () => {
    assert.throws(
      // @ts-expect-error — the fallbackGoal parameter is removed
      () => parseDagPlan('{"nodes":[]}', undefined, 'raw prompt'),
      (e: unknown) =>
        e instanceof OrchestratorError && e.code === 'COORDINATOR_PLAN_INVALID',
    );
  });

  it('through DagCoordinatorHandler (DefaultPipeline) the consumer receives COORDINATOR_PLAN_INVALID; no worker runs', async () => {
    let interpreted = 0;
    const interpreter: IInterpreter<DagPlan, InterpretResult> = {
      name: 'i',
      async interpret() {
        interpreted++;
        return { ok: true, nodeResults: {}, output: 'never' };
      },
    };
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      dagCoordinator: {
        planner: new LlmDagPlanner(llm('{"nodes":[]}')),
        interpreter,
        workers: new Map([
          [
            'w',
            {
              name: 'w',
              description: 'general worker',
              capabilities: { contextPolicy: 'optional' as const },
              async run() {
                return { output: 'never' };
              },
            },
          ],
        ]),
      },
    });
    pipeline.initialize({
      ...deps,
      agentConfig: { maxIterations: 3 },
    } as never);
    const agent = new SmartAgent(
      { ...deps, pipeline } as never,
      {
        maxIterations: 3,
      } as never,
    );
    const r = await agent.process(input.prompt);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'COORDINATOR_PLAN_INVALID');
    assert.match(r.error.message, /no nodes/);
    assert.equal(interpreted, 0);
  });
});
