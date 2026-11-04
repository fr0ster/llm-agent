import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DialoguePlan,
  ISubAgent,
  TaskRecord,
} from '@mcp-abap-adt/llm-agent';
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

for (const mode of [
  'references',
  'check',
  'legacy',
  'mixed-cap',
  'overflow',
  'no-dependencies',
] as const) {
  test(`dependency hand-off: ${mode}`, async () => {
    const contexts: string[] = [];
    const worker = mode === 'check' ? 'audit' : 'reader';
    const board = new TaskBoard({
      taskOutputChars: 130_000,
      ...profileHost(
        new Map<string, ISubAgent>([
          [
            worker,
            {
              name: worker,
              capabilities: { contextPolicy: 'optional' },
              async run(input) {
                contexts.push(input.context ?? '');
                return { output: worker === 'audit' ? 'PASS' : 'report' };
              },
            },
          ],
        ]),
      ),
      onEvent() {},
    });
    const hasRef =
      mode === 'references' || mode === 'check' || mode === 'mixed-cap';
    const source: TaskRecord = {
      id: 'source-task',
      worker: 'writer',
      result: 'report',
      goal: 'Source',
      state: 'done',
      createdAt: 0,
      output: 'PRIVATE OUTPUT MUST NOT TRAVEL',
      ...(hasRef
        ? {
            resultRef: {
              collection: 'task-results',
              record: 'source-task',
              chars: 900000,
            },
            summary:
              mode === 'mixed-cap' ? 's'.repeat(120000) : 'Stored summary',
          }
        : {}),
      toolTrace: { complete: true, entries: [], omittedCount: 0 },
    };
    const legacy: TaskRecord = {
      id: 'legacy-task',
      worker: 'writer',
      result: 'report',
      goal: 'Legacy',
      state: 'done',
      createdAt: 0,
      output: 'x'.repeat(mode === 'overflow' ? 120000 : 119900),
    };
    const sources =
      mode === 'mixed-cap' || mode === 'overflow' ? [source, legacy] : [source];
    const plan = mergePlan(
      undefined,
      [
        ...sources.map((task) => ({
          id: task.id,
          goal: task.goal,
          result: 'report' as const,
          items: ['item-a'],
        })),
        ...['first', 'second'].map((id) => ({
          id,
          goal: 'Read result',
          result: mode === 'check' ? ('verdict' as const) : ('report' as const),
          dependsOn:
            mode === 'no-dependencies' ? [] : sources.map((task) => task.id),
        })),
      ],
      'active',
    );
    for (const step of plan.steps.slice(0, sources.length)) {
      step.state = 'done';
      step.taskIds = [step.id];
      step.workTaskId = step.id;
      step.successfulWorkTaskId = step.id;
    }
    board.restore(sources);
    try {
      await runInPlannerScope(
        { board, getPlan: () => plan, setPlan() {} },
        async () => {
          for (const step_id of ['first', 'second']) {
            const response = await new PlannerToolsClient().callTool(
              'delegate_task',
              {
                step_id,
                worker,
                goal: 'Read result',
                context: 'Worker brief',
              },
            );
            assert.ok(response.ok);
            assert.equal(
              response.value.isError,
              mode === 'overflow' ? true : undefined,
              JSON.stringify(response.value),
            );
            if (mode === 'overflow')
              assert.match(
                JSON.stringify(response.value.content),
                /exceeds 120000/,
              );
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      );
      if (mode === 'overflow') {
        assert.equal(contexts.length, 0);
        return;
      }
      assert.equal(contexts.length, 2);
      for (const context of contexts) {
        assert.ok(context.startsWith('Worker brief'));
        assert.equal(
          context.includes('rag_read by id / collection_records'),
          hasRef,
        );
        if (hasRef) {
          const label =
            mode === 'check' ? 'result to check: step' : 'result of step';
          assert.ok(
            context.includes(
              `[${label} source-task (task source-task)] record task-results/source-task, 900000 chars. Summary: ${source.summary}`,
            ),
          );
          assert.ok(!context.includes(source.output ?? ''));
        } else if (mode === 'legacy') {
          assert.ok(
            context.includes(
              '[result of step source-task (task source-task)]\nPRIVATE OUTPUT MUST NOT TRAVEL',
            ),
          );
        } else {
          assert.ok(!context.includes('source-task'));
        }
        if (mode === 'mixed-cap') {
          assert.ok(context.length > 120000);
          assert.ok(context.includes(legacy.output ?? ''));
        }
        if (mode === 'check') {
          assert.match(
            context,
            /\[tools used by task source-task\]\nno tools were called/,
          );
          assert.ok(
            context.includes(
              'Expected items for step source-task: ["item-a"]; expected count: 1.',
            ),
          );
          assert.deepEqual(plan.steps[sources.length].checkedTaskIds, {
            'source-task': 'source-task',
          });
        }
      }
    } finally {
      await board.stopAll();
    }
  });
}
