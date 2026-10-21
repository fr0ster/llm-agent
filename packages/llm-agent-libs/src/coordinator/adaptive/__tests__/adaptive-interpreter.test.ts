import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AdaptiveStep,
  CheckStep,
  IAdaptiveController,
  ISubAgentInput,
  ISubAgentResult,
  StepStatus,
  WorkStep,
} from '@mcp-abap-adt/llm-agent';
import {
  type AdaptiveRunInput,
  DEFAULT_BUDGET,
  runAdaptivePlan,
} from '../adaptive-interpreter.js';

const work: WorkStep = {
  id: 'a',
  kind: 'work',
  goal: 'do work',
  worker: 'executor',
};
const answer: AdaptiveStep = { id: 'z', kind: 'answer', from: 'a' };
const check: CheckStep = {
  id: 'c',
  kind: 'check',
  goal: 'check',
  worker: 'executor',
  targets: ['a'],
  onPass: 'z',
  onFail: 'end',
};
const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
type Script =
  | string
  | Error
  | ISubAgentResult
  | ((input: ISubAgentInput) => ISubAgentResult);
function setup(
  steps: AdaptiveStep[] = [work, answer],
  script: Script[] = ['Hello'],
) {
  const calls: ISubAgentInput[] = [];
  const controller: IAdaptiveController = {
    name: 'controller',
    plan: async () => {
      throw new Error('not used');
    },
    check: async () => ({ verdict: { verdict: 'pass', reason: 'ok' }, usage }),
    revise: async () => ({
      steps: [{ id: 'new', kind: 'answer', text: 'revised' }],
      usage,
    }),
    report: async () => ({ text: 'report', usage }),
  };
  const input: AdaptiveRunInput = {
    request: 'request',
    history: [{ role: 'user', content: 'old' }],
    plan: { steps, createdAt: 0 },
    controller,
    budget: { ...DEFAULT_BUDGET },
    workers: new Map([
      [
        'executor',
        {
          name: 'executor',
          capabilities: { contextPolicy: 'optional' },
          async run(input: ISubAgentInput) {
            const item = script[calls.length];
            calls.push(input);
            if (item instanceof Error) throw item;
            if (typeof item === 'function') return item(input);
            return typeof item === 'string'
              ? { output: item, usage }
              : (item ?? { output: 'Hello', usage });
          },
        },
      ],
    ]),
  };
  return { input, calls, controller };
}
const verdict = (value = 'pass', reason = 'ok') =>
  JSON.stringify({ verdict: value, reason });

test('runs work then answer and forwards worker context', async () => {
  const { input, calls } = setup();
  input.sessionId = 'session';
  input.trace = { traceId: 'trace' };
  input.sessionLogger = { logStep() {} };
  input.externalTools = [];
  input.externalResults = new Map();
  const result = await runAdaptivePlan(input);
  assert.equal(result.outcome, 'answered');
  assert.equal(result.output, 'Hello');
  assert.deepEqual(result.usage, [usage]);
  assert.deepEqual(calls[0]?.history, input.history);
  for (const key of [
    'sessionId',
    'trace',
    'sessionLogger',
    'externalTools',
    'externalResults',
  ] as const)
    assert.equal(calls[0]?.[key], input[key]);
  assert.deepEqual(DEFAULT_BUDGET, {
    maxSteps: 20,
    maxRevisions: 3,
    maxDurationMs: 300000,
  });
});
test('check pass follows onPass', async () => {
  const { input } = setup(
    [work, check, { id: 'skip', kind: 'ask', question: 'bad' }, answer],
    ['Hello', verdict()],
  );
  assert.equal((await runAdaptivePlan(input)).output, 'Hello');
});
test('check fail jumps to fix step and passes reason only once', async () => {
  const fix = { ...work, id: 'fix' };
  const { input, calls } = setup(
    [work, { ...check, onFail: 'fix' }, fix, { ...work, id: 'after' }, answer],
    ['Hello', verdict('fail', 'broken'), 'fixed', 'after'],
  );
  await runAdaptivePlan(input);
  assert.ok(calls[2]?.task.includes('Previous check c said:\nbroken'));
  assert.ok(!calls[3]?.task.includes('Previous check'));
});
test('fix-check loop stops at check maxRuns', async () => {
  const back: CheckStep = {
    ...check,
    id: 'back',
    targets: ['fix'],
    onPass: 'c',
    onFail: 'c',
    maxRuns: 5,
  };
  const { input } = setup(
    [
      work,
      { ...check, onFail: 'fix' },
      { ...work, id: 'fix', maxRuns: 5 },
      back,
      answer,
    ],
    [
      'a',
      verdict('fail'),
      'fix',
      verdict(),
      verdict('fail'),
      'fix',
      verdict(),
      verdict('fail'),
      'fix',
      verdict(),
    ],
  );
  const result = await runAdaptivePlan(input);
  assert.equal(result.stopReason, 'step c exceeded 3 runs');
  assert.equal(result.output, 'report');
  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(
    result.records.filter((r) => r.stepId === 'c').map((r) => r.run),
    [1, 2, 3],
  );
});
test('unparsable verdict counts as fail', async () => {
  const { input } = setup(
    [work, { ...check, onFail: 'z' }, answer],
    ['Hello', 'no json'],
  );
  assert.deepEqual((await runAdaptivePlan(input)).records[1]?.verdict, {
    verdict: 'fail',
    reason: 'unparsable verdict',
  });
});
test('partial uses onPartial or falls back to onFail', async () => {
  for (const onPartial of ['z', undefined]) {
    const { input } = setup(
      [work, { ...check, onFail: 'z', onPartial }, answer],
      ['Hello', verdict('partial')],
    );
    assert.equal((await runAdaptivePlan(input)).outcome, 'answered');
  }
});
test('worker check receives composed results targets and history', async () => {
  const { input, calls } = setup(
    [
      work,
      { ...work, id: 'b' },
      { ...check, context: { results: ['b'], history: 'none' } },
      answer,
    ],
    ['a', 'b', verdict()],
  );
  await runAdaptivePlan(input);
  assert.ok(calls[2]?.task.includes('Result of a (done)'));
  assert.ok(calls[2]?.task.includes('Result of b (done)'));
  assert.deepEqual(calls[2]?.history, []);
});
test('self check uses controller.check and collects usage', async () => {
  const { input, controller } = setup([
    work,
    { ...check, worker: 'self' },
    answer,
  ]);
  controller.check = async (args) => {
    assert.equal(args.targets[0]?.output, 'Hello');
    assert.equal(args.request, 'request');
    return { verdict: { verdict: 'pass', reason: 'ok' }, usage };
  };
  assert.deepEqual((await runAdaptivePlan(input)).usage, [usage, usage]);
});
test('self check throw becomes fail', async () => {
  const { input, controller } = setup([
    work,
    { ...check, worker: 'self', onFail: 'z' },
    answer,
  ]);
  controller.check = async () => {
    throw new Error('oops');
  };
  assert.deepEqual((await runAdaptivePlan(input)).records[1]?.verdict, {
    verdict: 'fail',
    reason: 'controller check failed: oops',
  });
});
test('failed work without later check stops', async () => {
  const { input } = setup(undefined, [
    (i) => {
      i.onPartial?.({ kind: 'content', delta: 'partial' });
      throw new Error('oops');
    },
  ]);
  const result = await runAdaptivePlan(input);
  assert.equal(result.stopReason, 'step a failed: oops');
  assert.equal(result.output, 'report');
  assert.equal(result.records[0]?.status, 'failed');
  assert.equal(result.records[0]?.output, '');
  assert.equal(result.records[0]?.error, 'oops');
});
test('failed work with later check continues to the check', async () => {
  const { input, calls } = setup(
    [work, check, answer],
    [new Error('oops'), verdict()],
  );
  const result = await runAdaptivePlan(input);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.task.includes('Result of a (failed)'));
  assert.equal(result.stopReason, 'answer source a has no result');
});
test('ask ends the run with the question', async () => {
  const { input, calls } = setup([
    { id: 'q', kind: 'ask', question: 'Why?' },
    work,
  ]);
  const result = await runAdaptivePlan(input);
  assert.equal(result.outcome, 'asked');
  assert.equal(result.output, 'Why?');
  assert.equal(calls.length, 0);
});
const revise: AdaptiveStep = { id: 'r', kind: 'revise', reason: 'change' };
test('revise replaces the remainder without mutating original plan', async () => {
  const { input } = setup([revise, work, answer]);
  const result = await runAdaptivePlan(input);
  assert.equal(result.output, 'revised');
  assert.deepEqual(
    result.plan.steps.map((s) => s.id),
    ['r', 'new'],
  );
  assert.deepEqual(
    input.plan.steps.map((s) => s.id),
    ['r', 'a', 'z'],
  );
  assert.deepEqual(result.usage, [usage]);
});
test('revision can refer to executed ids', async () => {
  const { input, controller } = setup([work, revise, answer]);
  controller.revise = async () => ({
    steps: [{ id: 'new', kind: 'answer', from: 'a' }],
  });
  assert.equal((await runAdaptivePlan(input)).output, 'Hello');
});
test('revise over budget stops', async () => {
  const { input } = setup([revise]);
  input.budget.maxRevisions = 0;
  assert.equal((await runAdaptivePlan(input)).stopReason, 'budget: revisions');
});
test('revise with taken id stops', async () => {
  const { input, controller } = setup([revise]);
  controller.revise = async () => ({ steps: [revise] });
  assert.match(
    (await runAdaptivePlan(input)).stopReason ?? '',
    /^revise failed: step r:/,
  );
});
test('revise throw stops', async () => {
  const { input, controller } = setup([revise]);
  controller.revise = async () => {
    throw new Error('oops');
  };
  assert.equal(
    (await runAdaptivePlan(input)).stopReason,
    'revise failed: oops',
  );
});
test('answer text answers directly', async () => {
  const { input, calls } = setup([{ id: 'z', kind: 'answer', text: 'Hi' }]);
  assert.equal((await runAdaptivePlan(input)).output, 'Hi');
  assert.equal(calls.length, 0);
});
test('missing answer source stops', async () => {
  assert.equal(
    (await runAdaptivePlan(setup([answer]).input)).stopReason,
    'answer source a has no result',
  );
});
test('plan without answer stops', async () => {
  assert.equal(
    (await runAdaptivePlan(setup([work]).input)).stopReason,
    'plan ended without an answer',
  );
});
test('budget steps stops', async () => {
  const { input } = setup([work, { ...work, id: 'b' }, answer]);
  input.budget.maxSteps = 2;
  assert.equal((await runAdaptivePlan(input)).stopReason, 'budget: steps');
});
test('budget time stops', async () => {
  const { input } = setup();
  let clock = 0;
  input.now = () => clock++;
  input.budget.maxDurationMs = 1;
  assert.equal((await runAdaptivePlan(input)).stopReason, 'budget: time');
});
test('report throw gives deterministic text', async () => {
  const { input, controller } = setup(
    [work, check],
    ['Hello', verdict('fail', 'broken')],
  );
  controller.report = async () => {
    throw new Error('oops');
  };
  assert.equal(
    (await runAdaptivePlan(input)).output,
    'Stopped: plan ended without an answer\n- a (work) done\n- c (check) done: fail — broken',
  );
});
test('status events in order', async () => {
  const { input } = setup([work, check, answer], ['Hello', verdict()]);
  const statuses: StepStatus[] = [];
  input.onStatus = (s) => statuses.push(s);
  await runAdaptivePlan(input);
  assert.deepEqual(
    statuses.map((s) => [s.stepId, s.state, s.verdict]),
    [
      ['a', 'started', undefined],
      ['a', 'done', undefined],
      ['c', 'started', undefined],
      ['c', 'done', 'pass'],
      ['z', 'started', undefined],
      ['z', 'done', undefined],
    ],
  );
});
test('answer source streams live on first run only and latest result wins', async () => {
  const { input } = setup(
    [{ ...work, maxRuns: 2 }, { ...check, onFail: 'a' }, answer],
    [
      (i) => {
        i.onPartial?.({ kind: 'content', delta: 'Hel' });
        i.onPartial?.({ kind: 'content', delta: 'lo' });
        return { output: 'Hello' };
      },
      verdict('fail'),
      (i) => {
        i.onPartial?.({ kind: 'content', delta: 'Fixed' });
        return { output: 'Fixed' };
      },
      verdict(),
    ],
  );
  const chunks: string[] = [];
  input.onContent = (d) => chunks.push(d);
  const result = await runAdaptivePlan(input);
  assert.deepEqual(chunks, ['Hel', 'lo']);
  assert.equal(result.answerStreamed, false);
  assert.equal(result.output, 'Fixed');
  assert.deepEqual(
    result.records.map((r) => [r.stepId, r.run]),
    [
      ['a', 1],
      ['c', 1],
      ['a', 2],
      ['c', 2],
      ['z', 1],
    ],
  );
});
test('answerStreamed true when the full answer streamed; ephemeral chunks excluded', async () => {
  for (const ephemeral of [false, true]) {
    const { input } = setup(undefined, [
      (i) => {
        i.onPartial?.({ kind: 'content', delta: '' });
        i.onPartial?.({ kind: 'content', delta: 'Hello  ', ephemeral });
        return { output: 'Hello' };
      },
    ]);
    const chunks: [string, boolean][] = [];
    input.onContent = (d, e) => chunks.push([d, e]);
    assert.equal((await runAdaptivePlan(input)).answerStreamed, !ephemeral);
    assert.deepEqual(chunks, [['Hello  ', ephemeral]]);
  }
});
test('non-answer worker content does not stream', async () => {
  const { input } = setup(
    [work, { id: 'z', kind: 'answer', text: 'Hi' }],
    [
      (i) => {
        i.onPartial?.({ kind: 'content', delta: 'Hello' });
        return { output: 'Hello' };
      },
    ],
  );
  input.onContent = () => assert.fail('unexpected content');
  assert.equal((await runAdaptivePlan(input)).answerStreamed, false);
});
test('awaiting-external ends the run', async () => {
  const pending = [{ id: 'ext:1', name: 'external', arguments: '{}' }];
  const { input } = setup(undefined, [
    {
      output: '',
      status: 'awaiting-external',
      pendingExternalToolCalls: pending,
      usage,
    },
  ]);
  const result = await runAdaptivePlan(input);
  assert.equal(result.outcome, 'awaiting-external');
  assert.deepEqual(result.pendingExternalToolCalls, pending);
  assert.deepEqual(result.usage, [usage]);
  assert.equal(result.records.length, 1);
});
test('abort before step throws reason without reporting', async () => {
  const { input, controller } = setup();
  const abort = new AbortController();
  const reason = new Error('cancel');
  abort.abort(reason);
  input.signal = abort.signal;
  controller.report = async () => {
    assert.fail('must not report');
  };
  await assert.rejects(runAdaptivePlan(input), (error) => error === reason);
});
test('work default run cap is one', async () => {
  const { input } = setup(
    [work, { ...check, onFail: 'a' }, answer],
    ['Hello', verdict('fail')],
  );
  assert.equal(
    (await runAdaptivePlan(input)).stopReason,
    'step a exceeded 1 runs',
  );
});

for (const rejects of [false, true]) {
  test(`abort while report pending rejects: rejects=${rejects}`, async () => {
    const { input, controller } = setup([work]);
    const abort = new AbortController();
    input.signal = abort.signal;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reporting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    controller.report = async () => {
      entered();
      await pending;
      if (rejects) throw new Error('report failed');
      return { text: 'report' };
    };
    const running = runAdaptivePlan(input);
    await reporting;
    abort.abort();
    release();
    await assert.rejects(
      running,
      (error: Error) => error.name === 'AbortError',
    );
  });
}

test('self check receives selected results outside targets and selected history', async () => {
  const { input, controller } = setup(
    [
      work,
      { ...work, id: 'b' },
      {
        ...check,
        worker: 'self',
        context: { results: ['b'], spec: false, history: 'none' },
      },
      answer,
    ],
    ['target', 'selected evidence'],
  );
  input.plan.spec = { objective: 'hidden spec', raw: 'request' };
  controller.check = async (args) => {
    assert.ok(
      args.task?.includes('Result of b (done):\n---\nselected evidence'),
    );
    assert.ok(!args.task?.includes('hidden spec'));
    assert.equal(args.spec, undefined);
    assert.deepEqual(args.history, []);
    return { verdict: { verdict: 'pass', reason: 'ok' } };
  };
  const result = await runAdaptivePlan(input);
  assert.equal(result.records[2]?.verdict?.verdict, 'pass');
});

for (const method of ['check', 'revise'] as const) {
  test(`${method} thrown usage is collected`, async () => {
    const { input, controller } = setup(
      method === 'check'
        ? [
            { ...check, worker: 'self', targets: [], onFail: 'z' },
            { id: 'z', kind: 'answer', text: 'done' },
          ]
        : [revise],
    );
    controller[method] = async () => {
      throw Object.assign(new Error('parse'), { usage });
    };
    const result = await runAdaptivePlan(input);
    assert.equal(
      result.usage.filter((item) => item === usage).length,
      method === 'revise' ? 2 : 1,
    );
  });
}
