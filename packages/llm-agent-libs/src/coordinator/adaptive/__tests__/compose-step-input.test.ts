import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CheckStep,
  Message,
  StepRecord,
  WorkStep,
} from '@mcp-abap-adt/llm-agent';
import { renderTaskSpec } from '@mcp-abap-adt/llm-agent';
import {
  composeStepInput,
  HISTORY_MESSAGE_LIMIT,
  RESULT_CHAR_LIMIT,
} from '../compose-step-input.js';

const step: WorkStep = {
  id: 'w',
  kind: 'work',
  goal: 'goal',
  worker: 'executor',
};
const record = (
  stepId: string,
  output = stepId,
  status: StepRecord['status'] = 'done',
): StepRecord => ({
  stepId,
  kind: 'work',
  run: 1,
  status,
  output,
  durationMs: 0,
});
const latest = new Map([
  ['a', record('a')],
  ['b', record('b', 'broken', 'failed')],
]);
const args = { request: 'request', step, latest, history: [] as Message[] };

test('request and step always present', () => {
  assert.equal(composeStepInput(args).task, 'Request:\nrequest\n\nStep:\ngoal');
});
test('spec rendered when present and not disabled', () => {
  const spec = { objective: 'objective', raw: 'request' };
  assert.equal(
    composeStepInput({ ...args, spec }).task,
    `Request:\nrequest\n\nSpec:\n${renderTaskSpec(spec)}\n\nStep:\ngoal`,
  );
  assert.ok(
    !composeStepInput({
      ...args,
      spec,
      step: { ...step, context: { spec: false } },
    }).task.includes('Spec:'),
  );
});
test('results in plan order with status', () => {
  const result = composeStepInput({
    ...args,
    step: { ...step, context: { results: ['b', 'a', 'b'] } },
  });
  assert.equal(
    result.task,
    'Request:\nrequest\n\nStep:\ngoal\n\nResult of a (done):\n---\na\n---\n\nResult of b (failed):\n---\nbroken\n---',
  );
});
test('long result is cut with a note', () => {
  assert.equal(RESULT_CHAR_LIMIT, 8000);
  const result = composeStepInput({
    ...args,
    latest: new Map([['a', record('a', 'x'.repeat(8100))]]),
    step: { ...step, context: { results: ['a'] } },
  });
  assert.ok(
    result.task.includes(`${'x'.repeat(8000)}\n[cut: 100 characters omitted]`),
  );
  assert.ok(!result.task.includes('x'.repeat(8001)));
});
test('check step includes targets and the JSON instruction', () => {
  const check: CheckStep = {
    id: 'c',
    kind: 'check',
    goal: 'check',
    worker: 'executor',
    targets: ['a', 'b'],
    context: { results: ['b'] },
    onPass: 'next',
    onFail: 'end',
  };
  const result = composeStepInput({ ...args, step: check });
  assert.equal(result.task.match(/Result of b/g)?.length, 1);
  assert.ok(
    result.task.indexOf('Result of a') < result.task.indexOf('Result of b'),
  );
  assert.ok(
    result.task.endsWith(
      'Return ONLY JSON: {"verdict":"pass|fail|partial","reason":"<one line>"}',
    ),
  );
  assert.ok(
    !composeStepInput({
      ...args,
      step: { ...check, worker: 'self' },
    }).task.includes('Return ONLY JSON'),
  );
});
test('previous check reason included', () => {
  const result = composeStepInput({
    ...args,
    step: { ...step, context: { note: 'note' } },
    checkReason: { checkId: 'c', reason: 'broken' },
  });
  assert.ok(
    result.task.endsWith('Previous check c said:\nbroken\n\nNote:\nnote'),
  );
});
test('history none / last-turn / all', () => {
  const history: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'last' },
    { role: 'assistant', content: 'last reply' },
  ];
  assert.deepEqual(composeStepInput({ ...args, history }).history, history);
  assert.deepEqual(
    composeStepInput({
      ...args,
      history,
      step: { ...step, context: { history: 'none' } },
    }).history,
    [],
  );
  assert.deepEqual(
    composeStepInput({
      ...args,
      history,
      step: { ...step, context: { history: 'last-turn' } },
    }).history,
    history.slice(-2),
  );
  assert.deepEqual(
    composeStepInput({
      ...args,
      history: history.slice(0, -1),
      step: { ...step, context: { history: 'last-turn' } },
    }).history,
    [],
  );
});
test('history cut adds a note', () => {
  assert.equal(HISTORY_MESSAGE_LIMIT, 20);
  const history: Message[] = Array.from({ length: 25 }, (_, i) => ({
    role: 'user',
    content: String(i),
  }));
  const result = composeStepInput({ ...args, history });
  assert.deepEqual(result.history, history.slice(5));
  assert.ok(
    result.task.includes('[conversation cut: 5 earlier messages omitted]'),
  );
});
