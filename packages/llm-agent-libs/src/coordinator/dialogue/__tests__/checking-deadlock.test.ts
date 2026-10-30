import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, TaskEvent } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { applyTaskEvent, mergePlan } from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';
import { profileHost } from './profile-test-host.js';

function event(id: string, output = ''): TaskEvent {
  return {
    kind: 'done',
    task: {
      id,
      worker: 'audit',
      result: 'verdict',
      goal: 'verify',
      state: 'done',
      createdAt: 0,
      output,
    },
  };
}
function checking(items?: string[]): DialoguePlan {
  const plan = mergePlan(
    undefined,
    [
      { id: 'source', goal: 'work', items },
      {
        id: 'verify_stored_count',
        goal: 'Verify storage',
        worker: 'audit',
        result: 'verdict',
        dependsOn: ['source'],
      },
    ],
    'active',
    undefined,
    { resolveResult: (name) => (name === 'audit' ? 'verdict' : 'report') },
  );
  Object.assign(plan.steps[0], {
    state: 'done',
    taskIds: ['t14'],
    workTaskId: 't14',
    successfulWorkTaskId: 't14',
  });
  Object.assign(plan.steps[1], {
    state: 'running',
    taskIds: ['t15'],
    workTaskId: 't15',
    checkedTaskIds: { source: 't14' },
  });
  return plan;
}

for (const state of ['pending', 'running'] as const) {
  for (const maxCorrections of [0, 1, 2]) {
    test(`idle separate check ${state} corrects at most ${maxCorrections} times`, async () => {
      const plan = checking();
      plan.steps[1].state = state;
      let calls = 0;
      const session = await DialogueSession.open({
        id: 'stalled',
        maxCorrections,
        store: {
          load: async () => ({
            plan,
            tasks: [
              { ...event('t14').task, worker: 'w', result: 'report' },
              event('t15').task,
            ],
            conversation: [],
            pending: [],
            savedAt: 0,
          }),
          save: async () => {},
          delete: async () => {},
        },
        board: { workers: new Map() },
        planner: {
          async process(messages) {
            if (++calls > 1) {
              const note = String(messages.at(-1)?.content);
              assert.match(note, /\[check\] Step/);
              assert.match(
                note,
                state === 'running'
                  ? /its task finished; review get_task/
                  : /are ready.*Delegate them/,
              );
            }
            return { ok: true, value: { content: 'Launching audit' } };
          },
        },
      });
      await session.send('continue');
      assert.equal(calls, 1 + maxCorrections);
      await session.close();
    });
  }
}

const wrappers = [
  (json: string) => json,
  (json: string) => `I checked the results: ${json} End of report.`,
  (json: string) => `Results:\n\x60\x60\x60json\n${json}\n\x60\x60\x60\nDone.`,
];
for (const [index, wrap] of wrappers.entries()) {
  for (const verdict of ['pass', 'fail'] as const) {
    for (const count of [undefined, 1, 2]) {
      test(`audit wrapper ${index}, ${verdict}, count ${count} preserves batch rules`, () => {
        const plan = checking(['a', 'b']);
        applyTaskEvent(
          plan,
          event(
            't15',
            wrap(
              JSON.stringify({
                verdict,
                count,
                note: 'Verified {results} with "quotes"',
              }),
            ),
          ),
        );
        assert.equal(
          plan.steps[1].state,
          verdict === 'pass' && count === 2 ? 'done' : 'failed',
        );
      });
    }
    test(`audit wrapper ${index}, ${verdict} without items`, () => {
      const plan = checking();
      applyTaskEvent(plan, event('t15', wrap(JSON.stringify({ verdict }))));
      assert.equal(plan.steps[1].state, verdict === 'pass' ? 'done' : 'failed');
    });
  }
}

test('nested evidence never becomes the verdict', () => {
  const plan = checking();
  applyTaskEvent(
    plan,
    event(
      't15',
      'My verdict: {"verdict":"fail","note":"nested { text }","evidence":{"verdict":"pass"}}',
    ),
  );
  assert.equal(plan.steps[1].state, 'failed');
});

test('conflicting top-level verdicts are unusable', () => {
  for (const output of [
    'Tool said:\n```json\n{"verdict":"pass"}\n```\nMy verdict: {"verdict":"fail"}',
    'First {"verdict":"fail"}, then {"verdict":"pass"}.',
  ]) {
    const plan = checking();
    applyTaskEvent(plan, event('t15', output));
    assert.equal(plan.steps[1].state, 'failed');
    assert.equal(plan.steps[1].verdict, 'fail');
  }
});

test('conflicting counts are unusable even with equal verdicts', () => {
  const plan = checking(['a', 'b']);
  applyTaskEvent(
    plan,
    event(
      't15',
      'My verdict: {"verdict":"pass","count":1}\nEvidence:\n```json\n{"verdict":"pass","count":2}\n```',
    ),
  );
  assert.equal(plan.steps[1].state, 'failed');
  assert.equal(plan.steps[1].verdict, 'fail');
});

test('repeated consistent verdicts use the last one', () => {
  const plan = checking();
  applyTaskEvent(
    plan,
    event(
      't15',
      'Draft {"verdict":"pass"} final {"verdict":"pass","note":"all stored"}',
    ),
  );
  assert.equal(plan.steps[1].state, 'done');
  assert.equal(plan.steps[1].note, 'all stored');
});

for (const output of ['{"verdict":"unknown"}', '```json\ninvalid\n```', '']) {
  test(`unusable audit result allows fresh delegation: ${output}`, async () => {
    const plan = checking();
    applyTaskEvent(plan, event('t15', output));
    const step = plan.steps[1];
    assert.equal(step.state, 'failed');
    assert.equal(
      step.note,
      'Checker returned an unusable verdict; plan a fix step and a new check',
    );
    assert.equal(step.workTaskId, 't15');
    assert.equal(step.verdict, 'fail');
    const board = new TaskBoard({
      ...profileHost(
        new Map([
          [
            'audit',
            {
              name: 'audit',
              capabilities: { contextPolicy: 'optional' as const },
              async run() {
                return { output: '{"verdict":"pass"}' };
              },
            },
          ],
        ]),
      ),
      onEvent: (e) => applyTaskEvent(plan, e),
    });
    board.restore([
      { ...event('t14', 'source result').task, worker: 'w', result: 'report' },
    ]);
    try {
      await runInPlannerScope(
        { board, getPlan: () => plan, setPlan() {} },
        async () => {
          const result = await new PlannerToolsClient().callTool(
            'delegate_task',
            {
              worker: 'audit',
              result: 'verdict',
              goal: 'Verify again',
              step_id: step.id,
            },
          );
          assert.ok(result.ok);
          assert.equal(result.value.isError, undefined);
          assert.ok(step.workTaskId);
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(step.state, 'done');
    } finally {
      await board.stopAll();
    }
  });
}

test('audit outcome only changes its own step', () => {
  const plan = checking();
  const source = structuredClone(plan.steps[0]);
  applyTaskEvent(plan, event('t15', 'PASS'));
  assert.equal(plan.steps[1].state, 'done');
  assert.deepEqual(plan.steps[0], source);
});
