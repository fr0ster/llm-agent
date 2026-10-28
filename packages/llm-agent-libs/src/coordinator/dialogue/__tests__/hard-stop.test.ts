import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
  TaskEvent,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { SmartAgentSubAgent } from '../../../subagent/smart-agent-subagent.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import { TaskBoard, type TaskBoardOptions } from '../task-board.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(
  run: (input: ISubAgentInput) => Promise<ISubAgentResult>,
  options: Partial<TaskBoardOptions> = {},
) {
  let fire = () => {};
  let delay = -1;
  let cancelled = false;
  const events: TaskEvent[] = [];
  const worker: ISubAgent = {
    name: 'w',
    capabilities: { contextPolicy: 'optional' },
    run,
  };
  const board = new TaskBoard({
    workers: new Map([['w', worker]]),
    onEvent: (event) => events.push(event),
    scheduleTimer(callback, ms) {
      fire = callback;
      delay = ms;
      return () => {
        cancelled = true;
      };
    },
    ...options,
  });
  const result = board.start({ worker: 'w', goal: 'work' });
  assert.ok(result.ok);
  return {
    board,
    id: result.value.id,
    events,
    fire: () => fire(),
    delay: () => delay,
    cancelled: () => cancelled,
  };
}

for (const grace of [25, 0, -1, Number.NaN]) {
  test(`hard stop aborts in-flight work with grace ${grace}`, async () => {
    let signal: AbortSignal | undefined;
    const f = setup(
      async (input) => {
        signal = input.signal;
        assert.ok(signal);
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
        return { output: 'late' };
      },
      { hardStopAfterMs: grace },
    );
    await tick();
    assert.equal(f.board.stop(f.id), true);
    if (grace !== 0) {
      assert.equal(f.board.get(f.id)?.state, 'running');
      assert.equal(signal?.aborted, false);
      assert.equal(f.delay(), grace === 25 ? 25 : 60_000);
      f.fire();
    }
    await f.board.stopAll();
    assert.equal(signal?.aborted, true);
    assert.equal(f.board.get(f.id)?.state, 'stopped');
    assert.match(
      f.board.get(f.id)?.error ?? '',
      /stopped: in-flight work aborted after/,
    );
    assert.deepEqual(
      f.events.map((event) => event.kind),
      ['started', 'stopped'],
    );
    if (grace !== 0) assert.equal(f.cancelled(), true);
  });
}

test('cooperative completion cancels the hard timer', async () => {
  let signal: AbortSignal | undefined;
  const f = setup(async (input) => {
    signal = input.signal;
    await new Promise<void>((resolve) =>
      input.stopSignal?.addEventListener('abort', () => resolve(), {
        once: true,
      }),
    );
    return { output: 'partial', stopped: true };
  });
  await tick();
  await f.board.stopAll();
  assert.equal(f.cancelled(), true);
  f.fire();
  assert.equal(signal?.aborted, false);
  assert.equal(f.board.get(f.id)?.state, 'stopped');
  assert.equal(f.board.get(f.id)?.output, 'partial');
});

test('hard stop releases an uncooperative worker and ignores late results', async () => {
  let finish: ((result: ISubAgentResult) => void) | undefined;
  const f = setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await tick();
  f.board.stop(f.id);
  f.fire();
  await f.board.stopAll();
  const stopped = f.board.get(f.id);
  finish?.({ output: 'late' });
  await tick();
  assert.deepEqual(f.board.get(f.id), stopped);
  assert.deepEqual(
    f.events.map((event) => event.kind),
    ['started', 'stopped'],
  );
});

test('hard stop prevents worker start after a delayed wrapRun resumes', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wrapped = false;
  let workerCalls = 0;
  const f = setup(
    async () => {
      workerCalls++;
      return { output: 'late' };
    },
    {
      hardStopAfterMs: 0,
      wrapRun: async (_task, run) => {
        wrapped = true;
        await gate;
        return run();
      },
    },
  );
  await tick();
  assert.equal(wrapped, true);
  await f.board.stopAll();
  assert.equal(f.board.get(f.id)?.state, 'stopped');
  const stopped = f.board.get(f.id);
  release();
  await tick();
  assert.equal(workerCalls, 0);
  assert.deepEqual(f.board.get(f.id), stopped);
  assert.deepEqual(
    f.events.map((event) => event.kind),
    ['started', 'stopped'],
  );
});

test('base input cancellation remains connected', async () => {
  const base = new AbortController();
  let signal: AbortSignal | undefined;
  const f = setup(
    async (input) => {
      signal = input.signal;
      return { output: 'ok' };
    },
    {
      baseInput: () => ({ signal: base.signal }),
    },
  );
  await tick();
  base.abort();
  assert.equal(signal?.aborted, true);
  assert.equal(f.board.get(f.id)?.state, 'done');
});

test('board hard signal reaches MCP through SmartAgentSubAgent and SmartAgent', async () => {
  let mcpSignal: AbortSignal | undefined;
  let entered: (() => void) | undefined;
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { deps } = makeDefaultDeps({
    mcpClients: [
      {
        async listTools() {
          return {
            ok: true,
            value: [{ name: 'Read', description: 'read', inputSchema: {} }],
          };
        },
        async callTool(_name, _args, options) {
          mcpSignal = options?.signal;
          assert.ok(mcpSignal);
          entered?.();
          await new Promise<void>((_resolve, reject) => {
            mcpSignal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
          return { ok: true, value: { content: [] } };
        },
      },
    ],
    llmResponses: [
      {
        content: '',
        toolCalls: [{ id: 'one', name: 'Read', arguments: {} }],
        finishReason: 'tool_calls',
      },
    ],
  });
  let streamSignal: AbortSignal | undefined;
  const llm = deps.mainLlm;
  deps.mainLlm = {
    chat: (messages, tools, options) => llm.chat(messages, tools, options),
    async *streamChat(messages, tools, options) {
      streamSignal = options?.signal;
      yield* llm.streamChat(messages, tools, options);
    },
  };
  const worker = new SmartAgentSubAgent(
    'w',
    new SmartAgent(deps, { mode: 'hard', maxIterations: 3 }),
  );
  const f = setup((input) => worker.run(input), { hardStopAfterMs: 0 });
  await called;
  await f.board.stopAll();
  assert.equal(mcpSignal?.aborted, true);
  assert.ok(streamSignal);
  assert.equal(streamSignal.aborted, true);
  assert.equal(f.board.get(f.id)?.state, 'stopped');
});
