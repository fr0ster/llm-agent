import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DialogueSignals,
  ISubAgent,
  Message,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import { ToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { makeAssembler, makeDefaultDeps } from '../../../testing/index.js';
import {
  DialogueSession,
  type DialogueSessionOptions,
} from '../dialogue-session.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { applyTaskEvent } from '../structured-plan.js';

const tools = new PlannerToolsClient();
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function work() {
  let finish!: (result: { output: string }) => void;
  const promise = new Promise<{ output: string }>((resolve) => {
    finish = resolve;
  });
  const worker: ISubAgent = {
    name: 'executor',
    capabilities: { contextPolicy: 'optional' },
    run(input) {
      input.stopSignal?.addEventListener(
        'abort',
        () => finish({ output: 'stopped' }),
        { once: true },
      );
      return promise;
    },
  };
  return { worker, finish };
}
class Clock {
  time = 0;
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule = (callback: () => void, delay: number): (() => void) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delay, callback });
    return () => {
      this.timers.delete(id);
    };
  };
  get size(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

for (const streamMode of ['full', 'final'] as const) {
  for (const { content, adapterEnabled } of [
    { content: '', adapterEnabled: false },
    { content: 'Work started.', adapterEnabled: false },
    { content: '', adapterEnabled: true },
  ]) {
    for (const poll of ['get_task', 'list_tasks']) {
      test(`real SmartAgent (${streamMode}, adapter=${adapterEnabled}) stops after second ${poll}, preserving ${content ? 'text' : 'waiting note'}`, async () => {
        const task = work();
        const reads: string[] = [];
        const client = new PlannerToolsClient();
        const callTool = client.callTool.bind(client);
        client.callTool = async (name, args) => {
          const result = await callTool(name, args);
          if (name === poll && result.ok)
            reads.push(JSON.stringify(result.value.content));
          return result;
        };
        const { deps, llm } = makeDefaultDeps({
          assembler: makeAssembler([{ role: 'user', content: 'go' }]),
          mcpClients: [client],
          toolCache: new ToolCache(),
          llmResponses: [
            {
              content,
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'd',
                  name: 'delegate_task',
                  arguments: { worker: 'executor', goal: 'job' },
                },
              ],
            },
            {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                { id: 'p1', name: poll, arguments: { task_id: 't1' } },
              ],
            },
            {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                { id: 'p2', name: poll, arguments: { task_id: 't1' } },
              ],
            },
            {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                { id: 'p3', name: poll, arguments: { task_id: 't1' } },
              ],
            },
            { content: 'Task finished.' },
          ],
        });
        let adapterDetected = false;
        if (adapterEnabled) {
          deps.clientAdapters = [
            {
              name: 'test',
              detect(prompt: string) {
                adapterDetected = prompt === 'test adapter';
                return adapterDetected;
              },
              wrapResponse(text: string) {
                return `<response><result>${text}</result></response>`;
              },
            },
          ];
        }
        const planner = new SmartAgent(deps, {
          maxIterations: 10,
          heartbeatIntervalMs: 0,
          streamMode,
        });
        const settled: DialogueSignals['dialogue.turn.settled'][] = [];
        const session = await DialogueSession.open({
          id: 'real',
          planner: {
            process(messages, opts) {
              // Adapter detection reads the incoming system prompt, before assembly.
              return planner.process(
                adapterEnabled
                  ? [{ role: 'system', content: 'test adapter' }, ...messages]
                  : messages,
                opts,
              );
            },
          },
          maxCorrections: 3,
          signals: {
            emit(
              name: string,
              payload: DialogueSignals[keyof DialogueSignals],
            ) {
              if (name === 'dialogue.turn.settled' && 'outcome' in payload)
                settled.push(payload);
            },
            retire() {},
          },
          board: { workers: new Map([['executor', task.worker]]) },
        });
        try {
          const reply = await session.send('go');
          assert.equal(llm.callCount, 3);
          assert.equal(adapterDetected, adapterEnabled);
          assert.equal(reply.text, content || 'Waiting for t1 (executor).');
          assert.equal(settled[0]?.outcome, 'ok');
          assert.equal(reads.length, 2);
          assert.match(reads[0], /running/);
          assert.equal(reads[1], reads[0]);
          assert.match(
            String(session.snapshot().conversation.at(-1)?.content),
            /wait \(turn ended: tasks running\)/,
          );
          task.finish({ output: 'done' });
          await flush();
          assert.equal(llm.callCount, 5);
          assert.equal(reads.length, 3);
          assert.match(reads[2], /done/);
        } finally {
          await session.close();
        }
      });
    }
  }
}

test('outcomes between status reads reset the guard; finished reads never count', async () => {
  const first = work();
  const second = work();
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'reset',
    board: {
      workers: new Map([
        ['executor', first.worker],
        ['other', second.worker],
      ]),
    },
    planner: {
      async process(_messages, opts) {
        if (++calls > 1) return { ok: true, value: { content: 'NO_MESSAGE' } };
        await tools.callTool('delegate_task', {
          worker: 'executor',
          goal: 'first',
        });
        await tools.callTool('delegate_task', {
          worker: 'other',
          goal: 'second',
        });
        await flush();
        await tools.callTool('get_task', { task_id: 't2' });
        assert.equal(opts.stopSignal?.aborted, false);
        first.finish({ output: 'done' });
        await flush();
        for (let i = 0; i < 3; i++)
          await tools.callTool('get_task', { task_id: 't1' });
        await tools.callTool('get_task', { task_id: 't2' });
        assert.equal(opts.stopSignal?.aborted, false);
        return { ok: true, value: { content: 'continuing' } };
      },
    },
  });
  try {
    assert.equal((await session.send('go')).text, 'continuing');
  } finally {
    await session.close();
  }
});

for (const mode of ['result', 'throw'] as const) {
  test(`wait abort ${mode} preserves partial text without a caller callback`, async () => {
    const task = work();
    const session = await DialogueSession.open({
      id: mode,
      board: { workers: new Map([['executor', task.worker]]) },
      planner: {
        async process(_messages, opts) {
          await tools.callTool('delegate_task', {
            worker: 'executor',
            goal: 'job',
          });
          opts.onPartial?.({ kind: 'content', delta: 'Started.' });
          await tools.callTool('get_task', { task_id: 't1' });
          await tools.callTool('list_tasks', {});
          assert.equal(opts.stopSignal?.aborted, true);
          if (mode === 'throw') throw new Error('Aborted');
          return { ok: false, error: new Error('Aborted') };
        },
      },
    });
    try {
      assert.equal((await session.send('go')).text, 'Started.');
    } finally {
      await session.close();
    }
  });
}

test('caller cancellation remains an error even when the wait guard fires', async () => {
  const task = work();
  const caller = new AbortController();
  const session = await DialogueSession.open({
    id: 'caller',
    board: { workers: new Map([['executor', task.worker]]) },
    planner: {
      async process(_messages, opts) {
        await tools.callTool('delegate_task', {
          worker: 'executor',
          goal: 'job',
        });
        await tools.callTool('list_tasks', {});
        await tools.callTool('list_tasks', {});
        caller.abort();
        assert.equal(opts.stopSignal?.aborted, true);
        return { ok: false, error: new Error('caller aborted') };
      },
    },
  });
  try {
    await assert.rejects(
      session.send('go', { signal: caller.signal }),
      /caller aborted/,
    );
  } finally {
    await session.close();
  }
});

async function clockSession(options: Partial<DialogueSessionOptions> = {}) {
  const clock = new Clock();
  const task = work();
  const inputs: Message[][] = [];
  const waits: DialogueSignals['dialogue.wait'][] = [];
  const messages: import('@mcp-abap-adt/llm-agent').PlannerMessage[] = [];
  const session = await DialogueSession.open({
    id: 'clock',
    now: clock.now,
    scheduleTimer: clock.schedule,
    onMessage: (message) => {
      messages.push(message);
    },
    signals: {
      emit(name: string, payload: DialogueSignals[keyof DialogueSignals]) {
        if (name === 'dialogue.wait' && 'tasks' in payload)
          waits.push(structuredClone(payload));
      },
      retire() {},
    },
    board: { workers: new Map([['executor', task.worker]]), now: clock.now },
    planner: {
      async process(input) {
        inputs.push(input);
        if (inputs.length === 1)
          await tools.callTool('delegate_task', {
            worker: 'executor',
            goal: 'job',
          });
        return { ok: true, value: { content: 'NO_MESSAGE' } };
      },
    },
    ...options,
  });
  await session.send('go');
  await flush();
  return { clock, task, inputs, waits, messages, session };
}

test('ticks have elapsed times and no LLM calls, long wakes repeat and stay silent without task usage', async () => {
  const h = await clockSession();
  try {
    await h.clock.advance(30_000);
    assert.deepEqual(h.waits, [
      {
        tasks: [
          {
            id: 't1',
            worker: 'executor',
            goal: 'job',
            state: 'running',
            elapsedMs: 30_000,
          },
        ],
      },
    ]);
    assert.equal(h.inputs.length, 1);
    await h.clock.advance(270_000);
    assert.equal(h.inputs.length, 2);
    assert.match(
      String(h.inputs[1].at(-1)?.content),
      /t1 \(executor\) is still running after 5:00: check it and decide: keep waiting, stop_task, or re-delegate/,
    );
    assert.deepEqual(h.session.takePending(), []);
    assert.equal(h.messages.length, 0);
    await h.clock.advance(299_999);
    assert.equal(h.inputs.length, 2);
    await h.clock.advance(1);
    assert.equal(h.inputs.length, 3);
    h.task.finish({ output: 'done' });
    await flush();
    assert.equal(h.clock.size, 0);
    const calls = h.inputs.length;
    await h.clock.advance(600_000);
    assert.equal(h.inputs.length, calls);
  } finally {
    await h.session.close();
  }
});

test('close cancels timer while task is running', async () => {
  const h = await clockSession();
  assert.equal(h.clock.size, 1);
  await h.session.close();
  assert.equal(h.clock.size, 0);
  await h.clock.advance(600_000);
  assert.equal(h.inputs.length, 1);
  assert.equal(h.waits.length, 0);
});

for (const option of ['waitTickMs', 'longTaskMs'] as const) {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`${option} rejects ${value}`, async () => {
      await assert.rejects(
        DialogueSession.open({
          id: 'bad',
          [option]: value,
          planner: {
            async process() {
              return { ok: true, value: { content: '' } };
            },
          },
          board: { workers: new Map() },
        }),
        new RegExp(option),
      );
    });
  }
  test(`zero disables ${option} independently`, async () => {
    const h = await clockSession({ [option]: 0 });
    try {
      await h.clock.advance(300_000);
      assert.equal(h.waits.length, option === 'waitTickMs' ? 0 : 10);
      assert.equal(h.inputs.length, option === 'longTaskMs' ? 1 : 2);
    } finally {
      await h.session.close();
    }
  });
}

test('both clock features disabled schedule nothing', async () => {
  const h = await clockSession({ waitTickMs: 0, longTaskMs: 0 });
  try {
    assert.equal(h.clock.size, 0);
  } finally {
    await h.session.close();
  }
});

test('long_running never changes a structured plan', () => {
  const plan: import('@mcp-abap-adt/llm-agent').DialoguePlan = {
    version: 1,
    status: 'active',
    steps: [
      {
        id: 's',
        goal: 'job',
        state: 'running',
        taskIds: ['t1'],
        workTaskId: 't1',
      },
    ],
  };
  const before = structuredClone(plan);
  const event: TaskEvent = {
    kind: 'long_running',
    task: {
      id: 't1',
      worker: 'executor',
      goal: 'job',
      state: 'running',
      createdAt: 0,
    },
  };
  applyTaskEvent(plan, event);
  assert.deepEqual(plan, before);
});

test('queued tasks use createdAt for wait elapsed time', async () => {
  const clock = new Clock();
  const task = work();
  const waits: DialogueSignals['dialogue.wait'][] = [];
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'queue',
    now: clock.now,
    scheduleTimer: clock.schedule,
    waitTickMs: 10,
    longTaskMs: 0,
    signals: {
      emit(name: string, payload: DialogueSignals[keyof DialogueSignals]) {
        if (name === 'dialogue.wait' && 'tasks' in payload) waits.push(payload);
      },
      retire() {},
    },
    board: {
      workers: new Map([['executor', task.worker]]),
      now: clock.now,
      maxConcurrent: 1,
    },
    planner: {
      async process() {
        calls++;
        await tools.callTool('delegate_task', {
          worker: 'executor',
          goal: 'first',
        });
        await tools.callTool('delegate_task', {
          worker: 'executor',
          goal: 'queued',
        });
        return { ok: true, value: { content: 'started' } };
      },
    },
  });
  try {
    await session.send('go');
    await clock.advance(10);
    assert.equal(calls, 1);
    assert.deepEqual(
      waits[0]?.tasks.map(({ state, elapsedMs }) => ({ state, elapsedMs })),
      [
        { state: 'running', elapsedMs: 10 },
        { state: 'queued', elapsedMs: 10 },
      ],
    );
  } finally {
    await session.close();
  }
});

test('stale long-running events are dropped before the event turn; only outcomes contribute usage', async () => {
  const clock = new Clock();
  let finish!: (value: {
    output: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }) => void;
  const result = new Promise<{
    output: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }>((resolve) => {
    finish = resolve;
  });
  const inputs: Message[][] = [];
  const delivered: import('@mcp-abap-adt/llm-agent').PlannerMessage[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = await DialogueSession.open({
    id: 'stale',
    now: clock.now,
    scheduleTimer: clock.schedule,
    waitTickMs: 0,
    longTaskMs: 10,
    onMessage: (message) => {
      delivered.push(message);
    },
    board: {
      now: clock.now,
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            capabilities: { contextPolicy: 'optional' },
            run: () => result,
          },
        ],
      ]),
    },
    planner: {
      async process(messages) {
        inputs.push(messages);
        if (inputs.length === 1) {
          await tools.callTool('delegate_task', {
            worker: 'executor',
            goal: 'job',
          });
          return { ok: true, value: { content: 'started' } };
        }
        if (inputs.length === 2) await blocked;
        return { ok: true, value: { content: 'update' } };
      },
    },
  });
  await session.send('go');
  // A long-running event by itself has no task usage in its reply.
  await clock.advance(10);
  // The second planner turn is blocked while further events queue.
  await clock.advance(10);
  finish({
    output: 'done',
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  });
  await flush();
  release();
  await flush();
  await flush();
  assert.equal(inputs.length, 3);
  assert.match(String(inputs[1].at(-1)?.content), /still running after/);
  assert.doesNotMatch(String(inputs[2].at(-1)?.content), /still running after/);
  assert.match(String(inputs[2].at(-1)?.content), /done: job/);
  assert.equal(delivered[0]?.usage?.tasks, undefined);
  assert.deepEqual(delivered[1]?.usage?.tasks, [
    {
      id: 't1',
      worker: 'executor',
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      durationMs: 20,
    },
  ]);
  assert.equal(clock.size, 0);
  await session.close();
});

test('restore interrupts active tasks and schedules no timer', async () => {
  const clock = new Clock();
  const session = await DialogueSession.open({
    id: 'restore-clock',
    now: clock.now,
    scheduleTimer: clock.schedule,
    board: { workers: new Map(), now: clock.now },
    planner: {
      async process() {
        throw new Error('restore must not call planner');
      },
    },
    store: {
      async load() {
        return {
          conversation: [],
          pending: [],
          savedAt: 0,
          tasks: [
            {
              id: 't1',
              worker: 'executor',
              goal: 'job',
              state: 'running' as const,
              createdAt: 0,
            },
          ],
        };
      },
      async save() {},
      async delete() {},
    },
  });
  assert.equal(session.snapshot().tasks[0].state, 'interrupted');
  assert.equal(clock.size, 0);
  await clock.advance(600_000);
  await session.close();
});

test('wait signal and logger exceptions cannot stop ticks or task execution', async () => {
  let signals = 0;
  const h = await clockSession({
    waitTickMs: 10,
    longTaskMs: 0,
    signals: {
      emit(name) {
        if (name === 'dialogue.wait') {
          signals++;
          throw new Error('offline');
        }
      },
      retire() {},
    },
    logger: {
      warn() {
        throw new Error('logger offline');
      },
    },
  });
  try {
    await h.clock.advance(30);
    assert.equal(signals, 3);
    assert.equal(h.inputs.length, 1);
    assert.equal(h.clock.size, 1);
    h.task.finish({ output: 'done' });
    await flush();
    assert.equal(h.inputs.length, 2);
    assert.equal(h.clock.size, 0);
  } finally {
    await h.session.close();
  }
});

for (const option of ['waitTickMs', 'longTaskMs'] as const) {
  test(`${option} caps timeouts and preserves the absolute deadline`, async () => {
    const clock = new Clock();
    const delays: number[] = [];
    const interval = 2_147_483_647 + 100;
    const h = await clockSession({
      now: clock.now,
      scheduleTimer(callback, delay) {
        assert.ok(delay > 0 && delay <= 2_147_483_647);
        delays.push(delay);
        return clock.schedule(callback, delay);
      },
      waitTickMs: 0,
      longTaskMs: 0,
      [option]: interval,
    });
    try {
      await clock.advance(2_147_483_647);
      assert.equal(h.waits.length, 0);
      assert.equal(h.inputs.length, 1);
      assert.equal(delays.at(-1), 100);
      await clock.advance(100);
      assert.equal(h.waits.length, option === 'waitTickMs' ? 1 : 0);
      assert.equal(h.inputs.length, option === 'longTaskMs' ? 2 : 1);
      assert.equal(clock.size, 1);
    } finally {
      await h.session.close();
    }
  });
}
