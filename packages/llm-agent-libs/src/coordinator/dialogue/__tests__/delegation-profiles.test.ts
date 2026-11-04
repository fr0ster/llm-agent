import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, ISubAgent } from '@mcp-abap-adt/llm-agent';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { ProfilePlanAuthor } from '../profile-plan-author.js';
import { applyTaskEvent, mergePlan } from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';
import { profileHost } from './profile-test-host.js';

for (const mode of [
  'retry',
  'author',
  'update',
  'legacy-change',
  'legacy-checker',
] as const) {
  test(`${mode}: delegation uses the attempt profile and preserves legacy compatibility`, async () => {
    const workers = new Map<string, ISubAgent>(
      ['first', 'second', 'audit'].map((name) => [
        name,
        {
          name,
          capabilities: { contextPolicy: 'optional' },
          async run() {
            if (name === 'first') throw new Error('first attempt failed');
            return { output: name === 'audit' ? 'PASS' : 'report' };
          },
        },
      ]),
    );
    const host = profileHost(workers);
    let plan: DialoguePlan = mergePlan(
      undefined,
      [{ id: 's', goal: 'Produce result', result: 'report' }],
      'active',
    );
    if (mode === 'author') {
      host.profileRunner.preparePlanAuthor = async () => ({
        ok: true,
        value: {
          async process() {
            return {
              ok: true,
              value: {
                content: JSON.stringify({
                  steps: [
                    {
                      id: 's',
                      goal: 'Produce result',
                      result: 'report',
                      worker: 'ghost',
                    },
                  ],
                }),
                iterations: 1,
                toolCallCount: 0,
                stopReason: 'stop',
              },
            };
          },
          async *streamProcess() {},
        },
      });
      const authored = await new ProfilePlanAuthor({
        source: host.profileSource,
        runner: host.profileRunner,
      }).create({ goal: 'Produce result' });
      assert.ok(authored.ok);
      plan = authored.value;
      assert.equal(plan.steps[0].worker, undefined);
    }
    const board = new TaskBoard({
      ...host,
      onEvent: (event) => applyTaskEvent(plan, event),
    });
    const client = new PlannerToolsClient();
    const call = async (
      name: string,
      args: Parameters<PlannerToolsClient['callTool']>[1],
    ) => {
      const response = await client.callTool(name, args);
      assert.ok(response.ok);
      assert.equal(
        response.value.isError,
        undefined,
        JSON.stringify(response.value),
      );
    };
    try {
      await runInPlannerScope(
        {
          board,
          getPlan: () => plan,
          setPlan(next) {
            assert.equal(typeof next, 'object');
            if (typeof next === 'object') plan = next;
          },
        },
        async () => {
          if (mode === 'update') {
            await call('plan_update', {
              steps: [
                {
                  id: 's',
                  goal: 'Produce result',
                  result: 'report',
                  worker: 'ghost',
                },
              ],
            });
            assert.equal(plan.steps[0].worker, undefined);
          }
          if (mode.startsWith('legacy')) {
            plan.steps[0].worker =
              mode === 'legacy-checker' ? 'checker' : 'first';
            if (mode === 'legacy-checker') delete plan.steps[0].result;
            const source = {
              id: 'source',
              goal: 'Source',
              result: 'report' as const,
              state: 'done' as const,
              taskIds: ['source-task'],
              workTaskId: 'source-task',
              successfulWorkTaskId: 'source-task',
            };
            plan.steps.unshift(source);
            board.restore([
              {
                id: 'source-task',
                worker: 'second',
                result: 'report',
                goal: 'Source',
                state: 'done',
                output: 'evidence',
                createdAt: 0,
              },
            ]);
            if (mode === 'legacy-checker') {
              // The stored checker name supplies the verdict fallback and remains assigned.
              plan.steps[1].dependsOn = ['source'];
              const list = host.profileSource.list;
              host.profileSource.list = async (options) => {
                const result = await list(options);
                return result.ok
                  ? {
                      ok: true,
                      value: [
                        ...result.value,
                        {
                          name: 'checker',
                          description: 'Legacy checker',
                          result: 'verdict',
                          systemPrompt: '',
                          tools: 'all',
                        },
                      ],
                    }
                  : result;
              };
              const summary = host.profileSource.get;
              host.profileSource.get = async (name, options) =>
                name === 'checker'
                  ? {
                      ok: true,
                      value: {
                        name,
                        description: name,
                        result: 'verdict',
                        systemPrompt: '',
                        tools: 'all',
                      },
                    }
                  : summary(name, options);
              workers.set('checker', {
                name: 'checker',
                async run() {
                  return { output: 'PASS' };
                },
              });
            } else {
              await call('plan_update', {
                steps: [
                  source,
                  {
                    id: 's',
                    goal: 'Verify',
                    result: 'verdict',
                    state: 'pending',
                    dependsOn: ['source'],
                  },
                ],
              });
              assert.equal(plan.steps[1].worker, undefined);
            }
          }
          if (mode === 'retry') {
            await call('delegate_task', {
              step_id: 's',
              worker: 'first',
              goal: 'Produce result',
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(plan.steps[0].state, 'failed');
            assert.equal(plan.steps[0].worker, undefined);
          }
          const worker =
            mode === 'legacy-checker'
              ? 'checker'
              : mode === 'legacy-change'
                ? 'audit'
                : 'second';
          await call('delegate_task', {
            step_id: 's',
            worker,
            goal: 'Complete result',
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          const step = plan.steps.find((step) => step.id === 's');
          assert.equal(step?.state, 'done');
          assert.equal(board.get(step?.workTaskId ?? '')?.worker, worker);
        },
      );
    } finally {
      await board.stopAll();
    }
  });
}
