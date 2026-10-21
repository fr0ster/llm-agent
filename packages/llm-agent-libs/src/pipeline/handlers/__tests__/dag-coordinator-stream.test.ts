import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
  StreamChunk,
} from '@mcp-abap-adt/llm-agent';
import { DagPlanInterpreter } from '../../../coordinator/dag/dag-plan-interpreter.js';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

for (const mode of [
  'live',
  'ephemeral',
  'empty',
  'default',
  'disabled',
] as const) {
  test(`interpreter content streaming: ${mode}`, async () => {
    const enabled = mode !== 'default' && mode !== 'disabled';
    const yielded: { content?: string; ephemeral?: boolean }[] = [];
    const logged: StreamChunk[] = [];
    const expected =
      mode === 'live'
        ? [{ content: 'Hel' }, { content: 'lo' }]
        : mode === 'ephemeral'
          ? [{ content: 'thinking', ephemeral: true }]
          : [];
    const worker: ISubAgent = {
      name: 'w',
      description: 'd',
      capabilities: { contextPolicy: 'optional' },
      async run(input) {
        input.onPartial?.({
          kind: 'mcp-call',
          source: { stepperId: 'a', name: 'a' },
          tool: 'lookup',
        });
        input.onPartial?.({ kind: 'content', delta: '' });
        if (mode === 'ephemeral') {
          input.onPartial?.({
            kind: 'content',
            delta: 'thinking',
            ephemeral: true,
          });
        } else if (mode !== 'empty') {
          input.onPartial?.({ kind: 'content', delta: 'Hel' });
          assert.deepEqual(yielded, enabled ? [{ content: 'Hel' }] : []);
          input.onPartial?.({ kind: 'content', delta: 'lo' });
        }
        return { output: 'Hello' };
      },
    };
    const finalizer: IFinalizer = {
      name: 'notice',
      ...(mode === 'default' ? {} : { streamsInterpreterContent: enabled }),
      async finalize(input) {
        assert.deepEqual(yielded, expected, 'deltas arrive before finalize');
        assert.equal(
          input.interpreterContentStreamed,
          enabled ? mode === 'live' : undefined,
        );
        assert.equal('interpreterContentStreamed' in input, enabled);
        const output = input.interpreterContentStreamed
          ? 'NOTICE'
          : `${input.interpreterOutput}NOTICE`;
        input.onPartial?.({ kind: 'content', delta: output });
        return { output };
      },
    };
    const logger = new SessionRequestLogger();
    logger.startRequest('stream-test');
    const handler = new DagCoordinatorHandler({
      planner: {
        name: 'p',
        async plan() {
          return {
            plan: {
              objective: 'o',
              nodes: [{ id: 'a', goal: 'ga' }],
              createdAt: 0,
            },
          };
        },
      },
      interpreter: new DagPlanInterpreter(),
      workers: new Map([['w', worker]]),
      finalizer,
    });
    const handled = await handler.execute(
      {
        inputText: 'do',
        sessionId: 's',
        history: [],
        requestLogger: logger,
        yield(chunk: { value?: { content?: string; ephemeral?: boolean } }) {
          if (chunk.value?.content) yielded.push(chunk.value);
        },
        options: {
          sessionLogger: {
            logStep(_event: string, chunk: StreamChunk) {
              logged.push(chunk);
            },
          },
        },
      } as never,
      {},
      {} as never,
    );
    assert.equal(handled, true);
    assert.deepEqual(yielded, [
      ...expected,
      { content: mode === 'live' ? 'NOTICE' : 'HelloNOTICE' },
    ]);
    assert.equal(
      yielded
        .filter((chunk) => !chunk.ephemeral)
        .map((chunk) => chunk.content)
        .join(''),
      'HelloNOTICE',
    );
    assert.ok(logged.some((chunk) => chunk.kind === 'mcp-call'));
    assert.ok(logged.some((chunk) => chunk.kind === 'stepper-spawned'));
  });
}

test('#166: the answer reaches the client once (finalizer only); interpreter node content is not double-emitted', async () => {
  const planner: IPlanner = {
    name: 'p',
    async plan() {
      return {
        plan: {
          objective: 'o',
          nodes: [{ id: 'a', goal: 'ga' }],
          createdAt: 0,
        },
      };
    },
  };
  const worker: ISubAgent = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'X' };
    },
  };
  const interpreter: IInterpreter<DagPlan, InterpretResult> = {
    name: 'i',
    async interpret(plan, ictx) {
      ictx.onPartial?.({
        kind: 'stepper-spawned',
        source: { stepperId: 'a', name: 'a' },
        goal: 'ga',
      });
      ictx.onPartial?.({ kind: 'content', nodeId: 'a', delta: 'foo' });
      ictx.onPartial?.({ kind: 'content', nodeId: 'a', delta: 'bar' });
      ictx.onPartial?.({
        kind: 'stepper-done',
        source: { stepperId: 'a', name: 'a' },
        ok: true,
      });
      return {
        ok: true,
        nodeResults: {
          a: { nodeId: 'a', output: 'foobar', status: 'done', durationMs: 1 },
        },
        output: 'foobar',
        executedPlan: plan,
        executionOrder: ['a'],
      };
    },
  };
  const yielded: { content?: string; finishReason?: string }[] = [];
  const ctx = {
    inputText: 'do',
    sessionId: 's',
    history: [],
    requestLogger: {
      startRequest() {},
      getSummary() {
        return { byComponent: {}, byModel: {}, byCategory: {} };
      },
      logLlmCall() {},
      logStep() {},
    },
    yield(c: {
      ok?: boolean;
      value?: { content?: string; finishReason?: string };
    }) {
      if (c.value)
        yielded.push({
          content: c.value.content,
          finishReason: c.value.finishReason,
        });
    },
    options: { trace: { traceId: 't1' } },
  } as never;
  const h = new DagCoordinatorHandler({
    planner,
    interpreter,
    workers: new Map([['w', worker]]),
  });
  await h.execute(ctx, {}, {} as never);

  // #166 regression guard: the answer must reach the client EXACTLY ONCE — from
  // the finalizer. The interpreter's node-content deltas ('foo','bar') go to the
  // session log only, NOT to the client (previously they were ALSO yielded, so a
  // non-streaming client got the answer twice: 'foo'+'bar' + 'foobar').
  const contentYields = yielded.filter(
    (y) => (y.content ?? '') !== '' && !y.finishReason,
  );
  assert.deepEqual(
    contentYields.map((y) => y.content),
    ['foobar'],
    'only the finalizer emits client content — no interpreter double-emit',
  );

  // Final stop yield still present (with empty content, finishReason='stop'):
  const stop = yielded.find((y) => y.finishReason === 'stop');
  assert.ok(stop, 'final stop yield must be present');
});
