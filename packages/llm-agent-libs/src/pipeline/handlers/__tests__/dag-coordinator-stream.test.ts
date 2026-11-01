import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  IFinalizer,
  IInterpreter,
  InterpretResult,
  IPlanner,
  ISubAgent,
  LlmStreamChunk,
  StreamChunk,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { DagPlanInterpreter } from '../../../coordinator/dag/dag-plan-interpreter.js';
import { SessionRequestLogger } from '../../../logger/session-request-logger.js';
import { pipelineToStream } from '../../pipeline-to-stream.js';
import { DagCoordinatorHandler } from '../dag-coordinator.js';

for (const mode of ['single', 'multi', 'disabled'] as const) {
  test(`DAG worker iteration boundaries preserve outer response ownership: ${mode}`, async () => {
    const chunks: LlmStreamChunk[] = [];
    const worker: ISubAgent = {
      name: 'w',
      description: 'worker',
      async run(input) {
        input.onPartial?.({ kind: 'content', delta: 'Checking…' });
        input.onPartial?.({ kind: 'iteration-end', outcome: 'tool_calls' });
        input.onPartial?.({ kind: 'content', delta: 'Failed attempt' });
        input.onPartial?.({ kind: 'iteration-end', outcome: 'retry' });
        input.onPartial?.({ kind: 'content', delta: 'Answer' });
        input.onPartial?.({ kind: 'iteration-end', outcome: 'final' });
        return { output: 'Answer' };
      },
    };
    const handler = new DagCoordinatorHandler({
      planner: {
        name: 'p',
        async plan() {
          return {
            plan: {
              objective: 'o',
              nodes:
                mode === 'multi'
                  ? [
                      { id: 'a', goal: 'first' },
                      { id: 'b', goal: 'last', dependsOn: ['a'] },
                    ]
                  : [{ id: 'a', goal: 'answer' }],
              createdAt: 0,
            },
          };
        },
      },
      interpreter: new DagPlanInterpreter(),
      workers: new Map([['w', worker]]),
      finalizer: {
        name: 'notice',
        streamsInterpreterContent: mode !== 'disabled',
        async finalize(input) {
          assert.ok(!chunks.some((chunk) => chunk.iterationEnd === 'final'));
          assert.equal(
            input.interpreterContentStreamed,
            mode === 'single' ? true : mode === 'multi' ? false : undefined,
          );
          const output = `${input.interpreterContentStreamed ? '' : input.interpreterOutput}NOTICE`;
          input.onPartial?.({ kind: 'content', delta: output });
          return { output };
        },
      },
    });
    const agent: SmartAgent = Object.create(SmartAgent.prototype);
    agent.streamProcess = async function* () {
      const handled = await handler.execute(
        {
          inputText: 'do',
          sessionId: 's',
          history: [],
          requestLogger: new SessionRequestLogger(),
          yield(chunk) {
            assert.ok(chunk.ok);
            chunks.push(chunk.value);
          },
        } as Parameters<DagCoordinatorHandler['execute']>[0],
        {},
        {} as never,
      );
      assert.equal(handled, true);
      for (const value of chunks) yield { ok: true, value };
    };
    const response = await agent.process('do');
    assert.ok(response.ok);
    assert.equal(response.value.content, 'AnswerNOTICE');
    assert.deepEqual(
      chunks.flatMap((chunk) =>
        chunk.iterationEnd ? [chunk.iterationEnd] : [],
      ),
      mode === 'single' ? ['tool_calls', 'retry', 'final'] : [],
    );
    assert.equal(chunks.at(-1)?.finishReason, 'stop');
    if (mode === 'single') {
      assert.equal(chunks.at(-1)?.iterationEnd, 'final');
      assert.equal(chunks.at(-2)?.content, 'NOTICE');
    }
  });
}

for (const scenario of [
  {
    name: 'full answer',
    deltas: ['Hel', 'lo'],
    flag: true,
    content: 'HelloNOTICE',
  },
  {
    name: 'partial answer',
    deltas: ['Hel'],
    flag: false,
    content: 'HelHelloNOTICE',
  },
  {
    name: 'missing node ID',
    deltas: ['Hello'],
    flag: false,
    content: 'HelloNOTICE',
  },
  {
    name: 'other node ID',
    deltas: ['Hello'],
    flag: false,
    content: 'HelloNOTICE',
  },
  { name: 'no content', deltas: [], flag: false, content: 'HelloNOTICE' },
  {
    name: 'earlier tool-loop text',
    deltas: ['Research', 'Hello  '],
    flag: true,
    content: 'ResearchHello  NOTICE',
  },
  {
    name: 'empty output',
    deltas: ['Research'],
    output: '  ',
    flag: false,
    content: 'Research  NOTICE',
  },
  {
    name: 'two nodes',
    deltas: ['Research'],
    multi: true,
    output: 'Answer',
    flag: false,
    content: 'AnswerNOTICE',
  },
  {
    name: 'revised attempt',
    deltas: ['Hello'],
    revise: true,
    flag: true,
    content: 'FailedHelloNOTICE',
  },
  {
    name: 'revised partial attempt',
    deltas: ['Hel'],
    revise: true,
    flag: false,
    content: 'FailedHelloHelHelloNOTICE',
  },
  {
    name: 'revised silent attempt',
    deltas: [],
    revise: true,
    flag: false,
    content: 'FailedHelloHelloNOTICE',
  },
  {
    name: 'revised multi-node attempt',
    deltas: ['Research'],
    revise: true,
    multi: true,
    output: 'Answer',
    flag: false,
    content: 'FailedAnswerNOTICE',
  },
  {
    name: 'pending external calls',
    deltas: ['Hello'],
    external: true,
    flag: true,
    content: 'Hello',
  },
]) {
  test(`opt-in pipeline stream: ${scenario.name}`, async () => {
    const plan: DagPlan = {
      objective: 'o',
      nodes: [{ id: 'a', goal: 'ga' }],
      createdAt: 0,
    };
    const revisedPlan: DagPlan = {
      ...plan,
      nodes: scenario.multi
        ? [...plan.nodes, { id: 'b', goal: 'gb', dependsOn: ['a'] }]
        : plan.nodes,
    };
    let attempts = 0;
    let finalized = 0;
    const live: string[] = [];
    const handler = new DagCoordinatorHandler({
      planner: {
        name: 'p',
        async plan() {
          return { plan: scenario.revise ? plan : revisedPlan };
        },
      },
      workers: new Map(),
      interpreter: {
        name: 'i',
        async interpret(currentPlan, ctx) {
          attempts++;
          const failed = scenario.revise && attempts === 1;
          const before = [...live];
          const deltas = failed
            ? [
                scenario.name === 'revised partial attempt' ||
                scenario.name === 'revised silent attempt'
                  ? 'FailedHello'
                  : 'Failed',
              ]
            : scenario.deltas;
          for (const delta of deltas) {
            ctx.onPartial?.({
              kind: 'content',
              nodeId:
                scenario.name === 'missing node ID'
                  ? undefined
                  : scenario.name === 'other node ID'
                    ? 'other'
                    : 'a',
              delta,
            });
          }
          assert.deepEqual(
            live,
            currentPlan.nodes.length === 1 &&
              scenario.name !== 'missing node ID' &&
              scenario.name !== 'other node ID'
              ? [...before, ...deltas]
              : before,
          );
          return {
            ok: !failed,
            output: scenario.output ?? 'Hello',
            error: failed ? 'failed' : undefined,
            nodeResults: {},
            executedPlan: currentPlan,
            executionOrder: [],
            ...(scenario.external
              ? {
                  pendingExternalToolCalls: [
                    { id: 'ext:1', name: 'lookup', arguments: { query: 'q' } },
                  ],
                }
              : {}),
          };
        },
      },
      reviewer: {
        name: 'r',
        async review() {
          return { verdict: { pass: true } };
        },
        async reviewExecutionFailure() {
          return { decision: { action: 'revise', revisedPlan } };
        },
      },
      finalizer: {
        name: 'notice',
        streamsInterpreterContent: true,
        async finalize(input) {
          finalized++;
          assert.equal(input.interpreterContentStreamed, scenario.flag);
          const output = `${input.interpreterContentStreamed ? '' : input.interpreterOutput}NOTICE`;
          input.onPartial?.({ kind: 'content', delta: output });
          return { output };
        },
      },
    });
    const chunks: LlmStreamChunk[] = [];
    const stream = pipelineToStream(
      {
        initialize() {},
        async execute(_input, history, options, yieldChunk) {
          const handled = await handler.execute(
            {
              inputText: 'do',
              sessionId: 's',
              history,
              options,
              requestLogger: new SessionRequestLogger(),
              yield(chunk) {
                if (chunk.ok && chunk.value.content)
                  live.push(chunk.value.content);
                yieldChunk(chunk);
              },
            } as Parameters<DagCoordinatorHandler['execute']>[0],
            {},
            {} as never,
          );
          assert.equal(handled, true);
          return { timing: [] };
        },
      },
      'do',
      [],
      undefined,
    );
    for await (const chunk of stream) {
      assert.equal(chunk.ok, true);
      if (chunk.ok) chunks.push(chunk.value);
    }
    assert.equal(
      chunks
        .filter((c) => !c.ephemeral)
        .map((c) => c.content ?? '')
        .join(''),
      scenario.content,
    );
    assert.equal(finalized, scenario.external ? 0 : 1);
    assert.equal(
      chunks.at(-1)?.finishReason,
      scenario.external ? 'tool_calls' : 'stop',
    );
    if (scenario.external) {
      assert.deepEqual(chunks.find((c) => c.toolCalls)?.toolCalls, [
        { index: 0, id: 'ext:1', name: 'lookup', arguments: '{"query":"q"}' },
      ]);
    }
  });
}

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

for (const replan of [false, true]) {
  test(`opt-in Agent.process accumulation and terminal usage: replan=${replan}`, async () => {
    const logger = new SessionRequestLogger();
    logger.startRequest('opt-in');
    const chunks: LlmStreamChunk[] = [];
    const worker: ISubAgent = {
      name: 'w',
      description: 'worker',
      async run(input) {
        if (input.task.includes('original') && replan) {
          input.onPartial?.({ kind: 'content', delta: 'FAILED ' });
          throw new Error('replace original');
        }
        const output = input.task.startsWith('Task: research')
          ? 'INTERNAL RESEARCH'
          : 'ANSWER';
        input.onPartial?.({ kind: 'content', delta: output });
        return { output };
      },
    };
    const handler = new DagCoordinatorHandler({
      planner: {
        name: 'p',
        async plan() {
          return {
            plan: {
              objective: 'o',
              nodes: [{ id: 'a', goal: 'original' }],
              createdAt: 0,
            },
          };
        },
      },
      interpreter: new DagPlanInterpreter(),
      workers: new Map([['w', worker]]),
      errorStrategy: {
        name: 'replan',
        async onNodeFailure() {
          return {
            action: 'replan',
            subPlan: {
              objective: 'recover',
              nodes: [
                { id: 'research', goal: 'research' },
                { id: 'answer', goal: 'answer', dependsOn: ['research'] },
              ],
              createdAt: 0,
            },
          };
        },
      },
      finalizer: {
        name: 'notice',
        streamsInterpreterContent: true,
        async finalize(input) {
          assert.equal(input.interpreterOutput, 'ANSWER');
          assert.equal(input.interpreterContentStreamed, !replan);
          const output = `${input.interpreterContentStreamed ? '' : input.interpreterOutput}NOTICE`;
          input.onPartial?.({ kind: 'content', delta: output });
          return {
            output,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
          };
        },
      },
    });
    const agent: SmartAgent = Object.create(SmartAgent.prototype);
    agent.streamProcess = async function* () {
      const handled = await handler.execute(
        {
          inputText: 'do',
          sessionId: 's',
          history: [],
          requestLogger: logger,
          options: { trace: { traceId: 'opt-in' } },
          yield(chunk) {
            assert.equal(chunk.ok, true);
            if (chunk.ok) chunks.push(chunk.value);
          },
        } as Parameters<DagCoordinatorHandler['execute']>[0],
        {},
        {} as never,
      );
      assert.equal(handled, true);
      for (const value of chunks) yield { ok: true, value };
    };
    const response = await agent.process('do');
    assert.equal(response.ok, true);
    if (!response.ok) return;
    assert.equal(
      response.value.content,
      `${replan ? 'FAILED ' : ''}ANSWERNOTICE`,
    );
    assert.ok(
      !chunks.some((chunk) => chunk.content?.includes('INTERNAL RESEARCH')),
    );
    if (replan)
      assert.ok(chunks.some((chunk) => chunk.content === 'ANSWERNOTICE'));
    assert.equal(chunks.filter((chunk) => chunk.usage).length, 1);
    assert.equal(chunks.at(-1)?.finishReason, 'stop');
    assert.equal(chunks.at(-1)?.usage?.totalTokens, 5);
    assert.equal(response.value.usage?.totalTokens, 5);
  });
}
