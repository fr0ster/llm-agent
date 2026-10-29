import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialoguePlan, TaskEvent } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { applyTaskEvent, mergePlan } from '../structured-plan.js';
import { TaskBoard } from '../task-board.js';

function event(id: string, output = ''): TaskEvent {
  return {
    kind: 'done',
    task: {
      id,
      worker: 'checker',
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
      {
        id: 'verify_stored_count',
        goal: 'Verify storage',
        items,
        check: { by: 'checker', goal: 'Verify' },
      },
    ],
    'active',
  );
  Object.assign(plan.steps[0], {
    state: 'checking',
    taskIds: ['t14', 't15'],
    workTaskId: 't14',
    successfulWorkTaskId: 't14',
  });
  if (plan.steps[0].check) plan.steps[0].check.taskId = 't15';
  return plan;
}

for (const state of ['checking', 'running'] as const) {
  for (const by of ['checker', 'planner'] as const) {
    for (const maxCorrections of [0, 1, 2]) {
      test(`idle ${state}/${by} corrects at most ${maxCorrections} times`, async () => {
        const plan = checking();
        const step = plan.steps[0];
        step.state = state;
        if (step.check) step.check.by = by;
        let calls = 0;
        const session = await DialogueSession.open({
          id: 'stalled',
          maxCorrections,
          store: {
            load: async () => ({
              plan,
              tasks: [event('t14').task, event('t15').task],
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
                assert.match(note, /\[check\] Step verify_stored_count/);
                assert.ok(
                  note.includes(
                    state === 'running'
                      ? 'its work finished; review get_task and continue'
                      : by === 'checker'
                        ? 'delegate worker checker with step_id verify_stored_count'
                        : 'close it with update_plan state done or failed plus a note',
                  ),
                );
              }
              return { ok: true, value: { content: 'Launching checker' } };
            },
          },
        });
        try {
          await session.send('continue');
          assert.equal(calls, 1 + maxCorrections);
        } finally {
          await session.close();
        }
      });
    }
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
      test(`checker wrapper ${index}, ${verdict}, count ${count} preserves batch rules`, () => {
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
          plan.steps[0].state,
          verdict === 'pass' && count === 2 ? 'done' : 'failed',
        );
      });
    }
    test(`checker wrapper ${index}, ${verdict} without items`, () => {
      const plan = checking();
      applyTaskEvent(plan, event('t15', wrap(JSON.stringify({ verdict }))));
      assert.equal(plan.steps[0].state, verdict === 'pass' ? 'done' : 'failed');
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
  assert.equal(plan.steps[0].state, 'failed');
});

test('conflicting top-level verdicts are unusable', () => {
  for (const output of [
    'Tool said:\n```json\n{"verdict":"pass"}\n```\nMy verdict: {"verdict":"fail"}',
    'First {"verdict":"fail"}, then {"verdict":"pass"}.',
  ]) {
    const plan = checking();
    applyTaskEvent(plan, event('t15', output));
    assert.equal(plan.steps[0].state, 'checking');
    assert.equal(plan.steps[0].check?.taskId, undefined);
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
  assert.equal(plan.steps[0].state, 'checking');
  assert.equal(plan.steps[0].check?.taskId, undefined);
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
  assert.equal(plan.steps[0].state, 'done');
  assert.equal(plan.steps[0].note, 'all stored');
});

for (const output of [
  'PASS',
  '{"verdict":"unknown"}',
  '```json\ninvalid\n```',
  '',
]) {
  test(`unusable checker result allows fresh delegation: ${output}`, async () => {
    const plan = checking();
    applyTaskEvent(plan, event('t15', output));
    const step = plan.steps[0];
    assert.equal(step.state, 'checking');
    assert.equal(
      step.note,
      'checker returned no JSON verdict; re-delegate the checker or ask the user',
    );
    assert.equal(step.check?.taskId, undefined);
    assert.equal(step.check?.verdict, undefined);
    const board = new TaskBoard({
      workers: new Map([
        [
          'checker',
          {
            name: 'checker',
            capabilities: { contextPolicy: 'optional' as const },
            async run() {
              return { output: '{"verdict":"pass"}' };
            },
          },
        ],
      ]),
      onEvent: (e) => applyTaskEvent(plan, e),
    });
    try {
      await runInPlannerScope(
        { board, getPlan: () => plan, setPlan() {} },
        async () => {
          const result = await new PlannerToolsClient().callTool(
            'delegate_task',
            {
              worker: 'checker',
              goal: 'Verify again',
              step_id: step.id,
            },
          );
          assert.ok(result.ok);
          assert.equal(result.value.isError, undefined);
          assert.ok(step.check?.taskId);
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(step.state, 'done');
    } finally {
      await board.stopAll();
    }
  });
}

test('checker result without successful current work explains why it is ignored', () => {
  const plan = checking();
  delete plan.steps[0].successfulWorkTaskId;
  applyTaskEvent(plan, event('t15', '{"verdict":"pass"}'));
  assert.equal(plan.steps[0].state, 'checking');
  assert.equal(
    plan.steps[0].note,
    'check ignored: current work has not succeeded',
  );
});
