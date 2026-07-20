import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { LlmFinalizer } from '../finalizer.js';
import { makeControllerPlanner } from '../planner.js';
import { LlmReviewer } from '../reviewer.js';
import {
  diagnosticCallOptions,
  makeSubagentClient,
} from '../subagent-client.js';
import { establishTargetState } from '../target-state.js';
import type { SessionBundle } from '../types.js';

function fakeLlm(): ILlm {
  return {
    async chat() {
      return {
        ok: true as const,
        value: {
          content: 'hello',
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        },
      };
    },
  } as unknown as ILlm;
}

test('send emits llm_request + llm_response tagged "llm" with content', async () => {
  const steps: Array<{ name: string; data: unknown; area?: string }> = [];
  const sessionLogger = {
    logStep: (name: string, data: unknown, area?: string) =>
      steps.push({ name, data, area }),
  };
  const client = makeSubagentClient(fakeLlm());
  await client.send([{ role: 'user', content: 'hi' }], undefined, {
    sessionLogger,
  } as never);
  const req = steps.find((s) => s.name.includes('llm_request'));
  const res = steps.find((s) => s.name.includes('llm_response'));
  assert.ok(req && req.area === 'llm', 'request record tagged llm');
  assert.ok(res && res.area === 'llm', 'response record tagged llm');
  assert.deepEqual((req?.data as { messages: unknown[] }).messages, [
    { role: 'user', content: 'hi' },
  ]);
  assert.equal((res?.data as { content: string }).content, 'hello');
});

test('no sessionLogger → send still works, no throw', async () => {
  const client = makeSubagentClient(fakeLlm());
  const r = await client.send([{ role: 'user', content: 'hi' }]);
  assert.equal(r.kind, 'content');
});

test('reviewer threads callOptions.sessionLogger to send', async () => {
  let seenOptions: unknown;
  const client = {
    async send(_m: unknown, _t: unknown, o: unknown) {
      seenOptions = o;
      return { kind: 'content' as const, content: '{"verdict":"pass"}' };
    },
  };
  const sessionLogger = { logStep() {} };
  const reviewer = new LlmReviewer(client as never);
  await reviewer.review(
    { name: 's', instructions: 'i' } as never,
    [] as never,
    'result',
    { callOptions: { sessionLogger } } as never,
  );
  assert.equal(
    (seenOptions as { sessionLogger?: unknown })?.sessionLogger,
    sessionLogger,
  );
});

test('reviewer does NOT receive callOptions.model — narrowed to diagnostic-only subset', async () => {
  let seenOptions: unknown;
  const client = {
    async send(_m: unknown, _t: unknown, o: unknown) {
      seenOptions = o;
      return { kind: 'content' as const, content: '{"verdict":"pass"}' };
    },
  };
  const sessionLogger = { logStep() {} };
  const reviewer = new LlmReviewer(client as never);
  // Mirrors the handler call site: `callOptions: diagnosticCallOptions(ctx.options)`.
  // A client-supplied `model`/generation override must NOT leak into the
  // reviewer's structured-output call — only the diagnostic subset does.
  await reviewer.review(
    { name: 's', instructions: 'i' } as never,
    [] as never,
    'result',
    {
      callOptions: diagnosticCallOptions({
        model: 'req-model',
        temperature: 0.9,
        sessionLogger,
      } as never),
    } as never,
  );
  assert.equal((seenOptions as { model?: unknown })?.model, undefined);
  assert.equal(
    (seenOptions as { temperature?: unknown })?.temperature,
    undefined,
  );
  assert.equal(
    (seenOptions as { sessionLogger?: unknown })?.sessionLogger,
    sessionLogger,
  );
});

test('finalizer threads callOptions.sessionLogger to send', async () => {
  let seenOptions: unknown;
  const client = {
    async send(_m: unknown, _t: unknown, o: unknown) {
      seenOptions = o;
      return { kind: 'content' as const, content: 'final answer' };
    },
  };
  const sessionLogger = { logStep() {} };
  const finalizer = new LlmFinalizer(client as never, {
    budget: 1000,
    perResultCap: 200,
  });
  await finalizer.finalize('goal', 'request', [], {
    callOptions: { sessionLogger },
  } as never);
  assert.equal(
    (seenOptions as { sessionLogger?: unknown })?.sessionLogger,
    sessionLogger,
  );
});

test('establishTargetState threads options.sessionLogger to send', async () => {
  let seenOptions: unknown;
  const evaluator = {
    async send(_m: unknown, _t: unknown, o: unknown) {
      seenOptions = o;
      return { kind: 'content' as const, content: 'the target state' };
    },
  };
  const sessionLogger = { logStep() {} };
  await establishTargetState(
    { evaluator: evaluator as never },
    'do something',
    { strategy: 'consumer-confirm', distanceThreshold: 0.5 },
    { sessionLogger } as never,
  );
  assert.equal(
    (seenOptions as { sessionLogger?: unknown })?.sessionLogger,
    sessionLogger,
  );
});

test('planner stepAtCursor (finalize path) threads options.sessionLogger to send', async () => {
  let seenOptions: unknown;
  const client = {
    async send(_m: unknown, _t: unknown, o: unknown) {
      seenOptions = o;
      return { kind: 'content' as const, content: 'the final answer' };
    },
  };
  const sessionLogger = { logStep() {} };
  const planner = makeControllerPlanner('smart-executor', client as never);
  const bundle: SessionBundle = {
    goal: 'g',
    plannerPrivate: '',
    budgets: { stepsUsed: 0, rewindsUsed: 0 },
    plan: [{ name: 's1', instructions: 'i1' }],
    planCursor: 1, // cursor past the end → stepAtCursor finalizes
  };
  const result = await planner.next({
    bundle,
    prompt: 'req',
    retrying: false,
    options: { sessionLogger } as never,
  });
  assert.equal(result?.kind, 'done');
  assert.equal(
    (seenOptions as { sessionLogger?: unknown })?.sessionLogger,
    sessionLogger,
  );
});
