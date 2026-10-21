import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ILlm, LlmError, type RunRecord } from '@mcp-abap-adt/llm-agent';
import {
  ADAPTIVE_CONTROLLER_SYSTEM,
  LlmAdaptiveController,
} from '../llm-adaptive-controller.js';

const steps = [
  { id: 'a', kind: 'work', goal: 'g', worker: 'executor' },
  { id: 'z', kind: 'answer', from: 'a' },
];
const plan = { steps, createdAt: 1 } as RunRecord['plan'];
const record: RunRecord['steps'][number] = {
  stepId: 'a',
  kind: 'work',
  run: 1,
  status: 'done',
  output: 'x'.repeat(501),
  durationMs: 1,
  verdict: { verdict: 'partial', reason: 'unfinished' },
};
const previousRun: RunRecord = {
  runId: 'old',
  request: 'old request',
  plan,
  steps: [record],
  outcome: 'stopped',
  stopReason: 'budget: steps',
  finishedAt: 2,
};
const input = {
  request: 'current request',
  history: [],
  workers: [{ name: 'executor', description: 'Executes tasks' }],
};
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
function fake(content: string | Error) {
  const calls: Parameters<ILlm['chat']>[] = [];
  const llm: ILlm = {
    model: 'test-model',
    async chat(...args) {
      calls.push(args);
      if (content instanceof Error)
        return { ok: false, error: new LlmError(content.message) };
      return { ok: true, value: { content, usage, finishReason: 'stop' } };
    },
    async *streamChat() {
      yield { ok: false, error: new LlmError('Unexpected stream') };
    },
  };
  return { controller: new LlmAdaptiveController(llm), calls, llm };
}

test('plan parses a valid plan and exposes identity', async () => {
  const { controller, calls } = fake(JSON.stringify({ steps }));
  const result = await controller.plan(input);
  assert.equal(result.plan.steps.length, 2);
  assert.equal(typeof result.plan.createdAt, 'number');
  assert.equal(controller.name, 'llm-adaptive');
  assert.equal(controller.model, 'test-model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0][0].content, ADAPTIVE_CONTROLLER_SYSTEM);
});
test('plan throws on invalid JSON and unknown workers', async () => {
  await assert.rejects(fake('not json').controller.plan(input));
  await assert.rejects(
    fake(JSON.stringify({ steps })).controller.plan({ ...input, workers: [] }),
    /unknown worker executor/,
  );
});
test('plan throws on LlmError result', async () => {
  await assert.rejects(
    fake(new Error('provider unavailable')).controller.plan(input),
    /provider unavailable/,
  );
});
test('plan prompt includes workers, request and previous run with bounded output', async () => {
  const { controller, calls } = fake(JSON.stringify({ steps }));
  await controller.plan({ ...input, previousRun });
  const prompt = String(calls[0][0][1].content);
  for (const value of [
    'executor: Executes tasks',
    'current request',
    'old request',
    'budget: steps',
    'stopped',
    'partial',
    'unfinished',
    'work',
    'done',
    'x'.repeat(500),
  ])
    assert.ok(prompt.includes(value), value);
  assert.ok(!prompt.includes('x'.repeat(501)));
  assert.ok(prompt.includes('createdAt')); // Earlier plan is available, not only its records.
});
test('plan limits history to last 20 messages and cuts each to 1000 chars', async () => {
  const { controller, calls } = fake(JSON.stringify({ steps }));
  const history = Array.from({ length: 21 }, (_, i) => ({
    role: 'user' as const,
    content: i === 0 ? 'OMITTED' : `${i}:${'h'.repeat(1100)}`,
  }));
  await controller.plan({ ...input, history });
  const prompt = JSON.parse(
    String(calls[0][0][1].content)
      .split('Conversation:\n')[1]
      .split('\n\nPrevious run:')[0],
  );
  assert.equal(prompt.length, 20);
  assert.equal(prompt[0].content, history[1].content.slice(0, 1000));
  assert.equal(prompt[19].content.length, 1000);
  assert.ok(!JSON.stringify(prompt).includes('OMITTED'));
});
const checkInput = {
  request: 'request',
  spec: { objective: 'objective', raw: 'request' },
  step: {
    id: 'c',
    kind: 'check' as const,
    goal: 'check goal',
    worker: 'self',
    targets: ['a'],
    onPass: 'next',
    onFail: 'end',
  },
  targets: [record],
};
test('check returns verdict with request, spec, goal and targets', async () => {
  const { controller, calls } = fake(
    '{"verdict":"partial","reason":"needs work"}',
  );
  assert.deepEqual((await controller.check(checkInput)).verdict, {
    verdict: 'partial',
    reason: 'needs work',
  });
  const prompt = JSON.stringify(calls[0][0]);
  for (const value of [
    'request',
    'objective',
    'check goal',
    'stepId',
    'pass|fail|partial',
  ])
    assert.ok(prompt.includes(value));
});
test('check throws on unparsable verdict', async () => {
  await assert.rejects(
    fake('no verdict').controller.check(checkInput),
    /verdict/i,
  );
});
const reviseInput = {
  request: 'request',
  plan,
  records: [record],
  reason: 'change direction',
};
test('revise returns steps array without validating the remainder', async () => {
  const rawSteps = [{ id: 'a', kind: 'answer', from: 'executed' }];
  const { controller, calls } = fake(JSON.stringify({ steps: rawSteps }));
  assert.deepEqual((await controller.revise(reviseInput)).steps, rawSteps);
  const prompt = JSON.stringify(calls[0][0]);
  for (const value of [
    'change direction',
    'executed ids',
    'remainder',
    'records',
  ])
    assert.ok(prompt.includes(value));
});
test('revise accepts steps JSON wrapped in prose or a code fence', async () => {
  const rawSteps = [{ id: 'a', kind: 'answer', text: 'x' }];
  const wrapped = `Here:
\`\`\`json
${JSON.stringify({ steps: rawSteps })}
\`\`\``;
  assert.deepEqual(
    (await fake(wrapped).controller.revise(reviseInput)).steps,
    rawSteps,
  );
});
test('revise throws on malformed JSON or missing steps array', async () => {
  for (const raw of ['not json', '{}', '{"steps":null}'])
    await assert.rejects(fake(raw).controller.revise(reviseInput));
});
test('report returns text and asks for an honest report in request language', async () => {
  const { controller, calls } = fake('Some work remains.');
  assert.equal(
    (await controller.report({ ...reviseInput, stopReason: 'budget: time' }))
      .text,
    'Some work remains.',
  );
  const prompt = JSON.stringify(calls[0][0]);
  for (const value of [
    'budget: time',
    'plain text',
    "request's language",
    'what was done',
    'what was not',
  ])
    assert.ok(prompt.includes(value));
});
test('all calls forward signal, omit tools, return usage and propagate LlmError', async () => {
  const signal = new AbortController().signal;
  for (const [method, args, content] of [
    ['plan', input, JSON.stringify({ steps })],
    ['check', checkInput, '{"verdict":"pass","reason":"ok"}'],
    ['revise', reviseInput, JSON.stringify({ steps })],
    ['report', { ...reviseInput, stopReason: 'stop' }, 'report'],
  ] as const) {
    const { controller, calls } = fake(content);
    // Each method receives its own typed argument through this common transport assertion.
    const invoke = controller[method].bind(controller) as (
      arg: typeof args,
    ) => Promise<{ usage?: typeof usage }>;
    assert.deepEqual((await invoke({ ...args, signal })).usage, usage);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], undefined);
    assert.equal(calls[0][2]?.signal, signal);
    const failed = fake(new Error('LLM failed')).controller;
    const invokeFailed = failed[method].bind(failed) as typeof invoke;
    await assert.rejects(invokeFailed(args), /LLM failed/);
  }
});
test('custom system prompt is used for planning', async () => {
  const { llm, calls } = fake(JSON.stringify({ steps }));
  await new LlmAdaptiveController(llm, { systemPrompt: 'Custom rules' }).plan(
    input,
  );
  assert.equal(calls[0][0][0].content, 'Custom rules');
});

test('controller parse errors preserve response usage', async () => {
  const controller = fake('invalid JSON').controller;
  for (const invoke of [
    () => controller.plan(input),
    () => controller.check(checkInput),
    () => controller.revise(reviseInput),
  ])
    await assert.rejects(invoke, (error: Error & { usage?: typeof usage }) => {
      assert.deepEqual(error.usage, usage);
      return true;
    });
});

test('check prompt includes composed task and history', async () => {
  const { controller, calls } = fake('{"verdict":"pass","reason":"ok"}');
  await controller.check({
    ...checkInput,
    task: 'selected evidence',
    history: [{ role: 'user', content: 'prior conversation' }],
  });
  const prompt = JSON.stringify(calls[0][0]);
  assert.ok(prompt.includes('selected evidence'));
  assert.ok(prompt.includes('prior conversation'));
});
