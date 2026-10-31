import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentPrompts,
  IPlanAuthor,
  McpError,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { DIALOGUE_COORDINATOR_SYSTEM } from '../coordinator-prompt.js';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { composePlannerPrompt } from '../planner-prompt.js';
import { profileHost } from './profile-test-host.js';

const author: IPlanAuthor = {
  async create() {
    return {
      ok: true,
      value: {
        version: 1,
        status: 'active',
        steps: [
          {
            id: 's1',
            goal: 'read',
            worker: 'executor',
            state: 'pending',
            taskIds: [],
            dependsOn: [],
          },
        ],
      },
    };
  },
  async revise({ plan }) {
    return { ok: true, value: plan };
  },
};
function text(result: Result<McpToolResult, McpError>): string {
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.value.content));
  return result.value.content
    .flatMap((c) => (c.type === 'text' ? [c.text] : []))
    .join('\n');
}
for (const [name, prompts, planAuthor, expected] of [
  [
    'coordinator mode uses the coordinator prompt',
    { coordinator: 'C' },
    author,
    'C',
  ],
  [
    'coordinator mode falls back to DIALOGUE_COORDINATOR_SYSTEM, never the planner prompt',
    { planner: 'PLANNER ONLY' },
    author,
    DIALOGUE_COORDINATOR_SYSTEM,
  ],
  [
    'without planAuthor the planner prompt is unchanged',
    { planner: 'P' },
    undefined,
    'P',
  ],
] satisfies [string, AgentPrompts, IPlanAuthor | undefined, string][]) {
  test(name, async () => {
    const host = profileHost(new Map());
    let system = '';
    host.profileSource.getPrompts = async () => ({ ok: true, value: prompts });
    host.profileRunner.preparePlanner = async ({ systemPrompt }) => {
      system = systemPrompt;
      return {
        ok: true,
        value: {
          async process() {
            return {
              ok: true,
              value: {
                content: 'reply',
                iterations: 1,
                toolCallCount: 0,
                stopReason: 'stop',
              },
            };
          },
          async *streamProcess() {},
        },
      };
    };
    const session = await DialogueSession.open({
      id: name,
      board: {},
      ...host,
      planAuthor,
    });
    try {
      await session.send('hello');
      assert.equal(system, composePlannerPrompt(expected));
      if (expected === DIALOGUE_COORDINATOR_SYSTEM)
        assert.ok(!system.includes('PLANNER ONLY'));
    } finally {
      await session.close();
    }
  });
}

test('callTool plan_create then delegate_task runs a task and get_task returns it', async () => {
  const store = new InMemoryDialogueStateStore();
  const signals: string[] = [];
  const session = await DialogueSession.open({
    id: 'external',
    planAuthor: author,
    store,
    signals: {
      emit(name) {
        signals.push(name);
      },
      retire() {},
    },
    board: {
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              return { output: 'read result' };
            },
          },
        ],
      ]),
    },
  });
  try {
    assert.match(
      text(await session.callTool('plan_create', { goal: 'read' })),
      /s1/,
    );
    const savedPlan = (await store.load('external'))?.plan;
    assert.ok(savedPlan && typeof savedPlan === 'object');
    assert.equal(savedPlan.status, 'active');
    assert.ok(signals.includes('dialogue.plan.changed'));
    const delegated = await session.callTool('delegate_task', {
      step_id: 's1',
      worker: 'executor',
      goal: 'read',
    });
    assert.ok(delegated.ok && !delegated.value.isError, text(delegated));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const task = session.snapshot().tasks[0];
    assert.ok(task);
    assert.match(
      text(await session.callTool('get_task', { task_id: task.id })),
      /read result/,
    );
    const plan = session.snapshot().plan;
    assert.ok(plan && typeof plan === 'object');
    assert.equal(plan.steps[0].state, 'done');
    assert.equal((await store.load('external'))?.tasks[0].state, 'done');
    assert.ok(!signals.includes('dialogue.turn.started'));
  } finally {
    await session.close();
  }
});

test('callTool is refused during a turn', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const session = await DialogueSession.open({
    id: 'busy',
    board: {},
    planAuthor: author,
    planner: {
      async process() {
        entered();
        await gate;
        return { ok: true, value: { content: 'reply' } };
      },
    },
  });
  const send = session.send('hello');
  await started;
  try {
    const before = session.snapshot();
    assert.match(
      text(await session.callTool('plan_create', { goal: 'read' })),
      /session is busy with a coordinator turn/,
    );
    assert.deepEqual(session.snapshot(), before);
  } finally {
    release();
    await send;
    await session.close();
  }
});

test('callTool rejects new_request and deliver', async () => {
  const session = await DialogueSession.open({ id: 'rejected', board: {} });
  try {
    const before = session.snapshot();
    for (const name of ['new_request', 'deliver']) {
      const result = await session.callTool(name, {});
      assert.ok(result.ok && result.value.isError);
      assert.match(text(result), /not available outside a coordinator turn/);
    }
    assert.deepEqual(session.snapshot(), before);
  } finally {
    await session.close();
  }
});

test('callTool persists to the store and emits a plan signal', async () => {
  const store = new InMemoryDialogueStateStore();
  const signals: string[] = [];
  const session = await DialogueSession.open({
    id: 'persist',
    board: {},
    planAuthor: author,
    store,
    signals: {
      emit(name) {
        signals.push(name);
      },
      retire() {},
    },
  });
  try {
    await session.callTool('plan_create', { goal: 'read' });
    assert.deepEqual(
      (await store.load('persist'))?.plan,
      session.snapshot().plan,
    );
    assert.ok(signals.includes('dialogue.plan.changed'));
  } finally {
    await session.close();
  }
});

for (const tool of ['plan_update', 'delegate_task']) {
  test(`pre-aborted ${tool} leaves session and store unchanged`, async () => {
    const store = new InMemoryDialogueStateStore();
    let runs = 0;
    const session = await DialogueSession.open({
      id: tool,
      store,
      planAuthor: author,
      board: {
        workers: new Map([
          [
            'executor',
            {
              name: 'executor',
              capabilities: { contextPolicy: 'optional' },
              async run() {
                runs++;
                return { output: 'result' };
              },
            },
          ],
        ]),
      },
    });
    try {
      await session.callTool('plan_create', { goal: 'read' });
      const before = session.snapshot();
      const saved = await store.load(tool);
      const result = await session.callTool(
        tool,
        tool === 'plan_update'
          ? { plan: 'changed' }
          : { step_id: 's1', worker: 'executor', goal: 'read' },
        { signal: AbortSignal.abort() },
      );
      assert.ok(result.ok && result.value.isError);
      assert.match(text(result), /aborted/);
      assert.deepEqual(session.snapshot(), before);
      assert.deepEqual(await store.load(tool), saved);
      assert.equal(runs, 0);
    } finally {
      await session.close();
    }
  });
}

test('abort during plan_create authoring stores nothing', async () => {
  const store = new InMemoryDialogueStateStore();
  const controller = new AbortController();
  const session = await DialogueSession.open({
    id: 'abort-author',
    store,
    board: {},
    planAuthor: {
      ...author,
      async create(brief, options) {
        await Promise.resolve();
        controller.abort();
        return author.create(brief, options);
      },
    },
  });
  try {
    const before = session.snapshot();
    const result = await session.callTool(
      'plan_create',
      { goal: 'read' },
      { signal: controller.signal },
    );
    assert.ok(result.ok && result.value.isError);
    assert.match(text(result), /aborted/);
    assert.deepEqual(session.snapshot(), before);
    assert.equal(await store.load('abort-author'), undefined);
  } finally {
    await session.close();
  }
});

test('headless task outcome survives restore and is delivered exactly once', async () => {
  const store = new InMemoryDialogueStateStore();
  const session = await DialogueSession.open({
    id: 'outcome',
    store,
    board: {
      workers: new Map([
        [
          'executor',
          {
            name: 'executor',
            capabilities: { contextPolicy: 'optional' },
            async run() {
              return { output: 'UNIQUE_OUTCOME' };
            },
          },
        ],
      ]),
    },
  });
  let restored: DialogueSession | undefined;
  try {
    await session.callTool('delegate_task', {
      worker: 'executor',
      goal: 'read',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshot = session.snapshot();
    assert.equal(snapshot.pendingEvents?.length, 1);
    assert.deepEqual(
      (await store.load('outcome'))?.pendingEvents,
      snapshot.pendingEvents,
    );
    await store.save('restored-outcome', snapshot);
    const inputs: string[] = [];
    restored = await DialogueSession.open({
      id: 'restored-outcome',
      store,
      board: {},
      maxCorrections: 0,
      planner: {
        async process(messages) {
          inputs.push(messages.map((message) => message.content).join('\n'));
          return { ok: true, value: { content: 'reply' } };
        },
      },
    });
    await restored.send('review');
    assert.equal(inputs[0].split('UNIQUE_OUTCOME').length - 1, 1);
    assert.deepEqual(restored.snapshot().pendingEvents, []);
    assert.deepEqual((await store.load('restored-outcome'))?.pendingEvents, []);
    await restored.send('continue');
    assert.ok(!inputs[1].includes('UNIQUE_OUTCOME'));
  } finally {
    await restored?.close();
    await session.close();
  }
});
