import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DialogueState, ISubAgentInput } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { InMemoryDialogueStateStore } from '../in-memory-dialogue-state-store.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { TaskBoard } from '../task-board.js';

const tools = new PlannerToolsClient();

test('planner exposes exactly the semantic-only tools and rejects removed arguments and tools', async () => {
  const board = new TaskBoard({ workers: new Map(), onEvent() {} });
  await runInPlannerScope(
    { board, getPlan: () => undefined, setPlan() {} },
    async () => {
      const listed = await tools.listTools();
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.map((tool) => tool.name),
        [
          'new_request',
          'delegate_task',
          'search_knowledge',
          'stop_task',
          'get_task',
          'list_tasks',
          'get_plan',
          'update_plan',
        ],
      );
      const delegate = listed.value.find(
        (tool) => tool.name === 'delegate_task',
      );
      assert.ok(delegate);
      assert.doesNotMatch(
        JSON.stringify(delegate.inputSchema),
        /"(?:inputs|history)"/,
      );
      for (const name of ['inputs', 'history']) {
        const result = await tools.callTool('delegate_task', {
          worker: 'w',
          goal: 'g',
          [name]: [],
        });
        assert.ok(result.ok && result.value.isError);
        assert.equal(
          JSON.stringify(result.value.content).includes(
            `${name} is not supported; put what the step needs in context`,
          ),
          true,
        );
      }
      for (const name of ['get_message', 'get_request']) {
        const result = await tools.callTool(name, { id: 'r1' });
        assert.ok(result.ok && result.value.isError);
      }
    },
  );
});

for (const plannerContext of ['prepared', 'conversation'] as const) {
  test(`delegation sends the brief without history in ${plannerContext} mode`, async () => {
    const received: ISubAgentInput[] = [];
    const session = await DialogueSession.open({
      id: plannerContext,
      plannerContext,
      maxCorrections: 0,
      board: {
        workers: new Map([
          [
            'w',
            {
              name: 'w',
              capabilities: { contextPolicy: 'optional' },
              async run(input) {
                received.push(input);
                return { output: 'ok' };
              },
            },
          ],
        ]),
      },
      planner: {
        async process() {
          await tools.callTool('delegate_task', {
            worker: 'w',
            goal: 'result',
            context: 'brief',
          });
          return { ok: true, value: { content: 'delegated' } };
        },
      },
    });
    try {
      await session.send('request');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(received[0].task, 'result');
      assert.equal(received[0].context, 'brief');
      assert.equal(received[0].history, undefined);
    } finally {
      await session.close();
    }
  });
}

test('old archive fields are dropped on restore and save; boundaries keep only closed metadata', async () => {
  const store = new InMemoryDialogueStateStore();
  const legacy = {
    plan: { version: 1, steps: [], status: 'active', note: 'current plan' },
    conversation: [],
    tasks: [],
    pending: [],
    savedAt: 1,
    messages: [{ id: 'm', text: 'old archive', createdAt: 1, trigger: 'user' }],
    requests: [
      {
        id: 'r1',
        openedAt: 1,
        closedAt: 2,
        text: 'old',
        replies: ['m'],
        transcript: [{ role: 'user', content: 'closed transcript' }],
        closedPlan: { version: 1, steps: [], status: 'done' },
        transcriptExpired: true,
      },
      {
        id: 'r2',
        openedAt: 3,
        text: 'current',
        replies: ['m'],
        transcript: [{ role: 'user', content: 'current' }],
        lastTurnOk: true,
      },
    ],
  } satisfies DialogueState & {
    messages: {
      id: string;
      text: string;
      createdAt: number;
      trigger: string;
    }[];
    requests: Array<
      NonNullable<DialogueState['requests']>[number] & {
        replies: string[];
        closedPlan?: { version: number; steps: never[]; status: string };
        transcriptExpired?: boolean;
      }
    >;
  };
  await store.save('legacy', legacy);
  let calls = 0;
  const session = await DialogueSession.open({
    id: 'legacy',
    store,
    board: { workers: new Map() },
    maxCorrections: 0,
    planner: {
      async process() {
        if (++calls === 1) {
          const result = await tools.callTool('new_request', {});
          assert.ok(result.ok && !result.value.isError);
        }
        return { ok: true, value: { content: 'done' } };
      },
    },
  });
  try {
    const restored = session.snapshot();
    assert.ok(!Object.hasOwn(restored, 'messages'));
    assert.equal(restored.requests?.[0].transcript, undefined);
    assert.equal(restored.requests?.[1].transcript?.[0].content, 'current');
    await session.send('next');
    const saved = await store.load('legacy');
    assert.ok(saved);
    assert.ok(!Object.hasOwn(saved, 'messages'));
    for (const request of saved.requests ?? []) {
      for (const field of ['replies', 'closedPlan', 'transcriptExpired'])
        assert.ok(!Object.hasOwn(request, field));
      if (request.closedAt !== undefined)
        assert.ok(!Object.hasOwn(request, 'transcript'));
    }
    assert.equal(saved.requests?.length, 3);
    assert.equal(saved.requests?.[1].closedAt !== undefined, true);
    assert.equal(saved.requests?.at(-1)?.transcript?.[0].content, 'next');
  } finally {
    await session.close();
  }
});
