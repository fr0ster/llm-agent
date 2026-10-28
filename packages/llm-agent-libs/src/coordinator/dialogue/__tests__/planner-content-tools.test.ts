import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ISubAgentInput,
  PlannerMessage,
  PlannerRequestRecord,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { DialogueSession } from '../dialogue-session.js';
import { type PlannerScope, runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { TaskBoard } from '../task-board.js';

const tools = new PlannerToolsClient();
const pageResult = z.object({ text: z.string() });
const requestResult = z.object({
  text: z.string(),
  replies: z.array(z.string()),
  note: z.string().optional(),
  transcript: z
    .object({
      offset: z.number(),
      total: z.number(),
      next: z.number().optional(),
      text: z.string(),
    })
    .optional(),
});
async function call(
  name: string,
  args: Parameters<PlannerToolsClient['callTool']>[1] = {},
) {
  const result = await tools.callTool(name, args);
  assert.ok(result.ok);
  const content = result.value.content;
  assert.ok(Array.isArray(content));
  const block = content[0];
  assert.ok(block && block.type === 'text');
  return { error: result.value.isError, text: block.text ?? '' };
}
function fixture() {
  const received: ISubAgentInput[] = [];
  const messages: PlannerMessage[] = [
    { id: 'a', createdAt: 1, text: 'A'.repeat(50_000), trigger: 'user' },
    { id: 'b', createdAt: 2, text: 'second', trigger: 'user' },
  ];
  const request: PlannerRequestRecord = {
    id: 'r1',
    openedAt: 1,
    text: 'q'.repeat(3_000),
    replies: Array.from({ length: 30 }, (_, i) => String(i)),
    transcript: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ],
  };
  let reads = 0;
  const board = new TaskBoard({
    workers: new Map([
      [
        'w',
        {
          name: 'w',
          capabilities: { contextPolicy: 'optional' as const },
          async run(input) {
            received.push(input);
            return { output: 'ok' };
          },
        },
      ],
    ]),
    onEvent() {},
  });
  const scope: PlannerScope = {
    board,
    getPlan: () => undefined,
    setPlan() {},
    history: () => [{ role: 'user', content: 'raw' }],
    getMessage: (id) => messages.find((message) => message.id === id),
    getRequest: (id) => (id === request.id ? request : undefined),
    statusRead: () => {
      reads++;
    },
  };
  return { scope, request, messages, received, reads: () => reads };
}

test('archive pages have defaults, capped limits, stable transcript rendering and bounded metadata without status reads', async () => {
  const f = fixture();
  await runInPlannerScope(f.scope, async () => {
    assert.deepEqual(
      JSON.parse((await call('get_message', { id: 'a' })).text),
      {
        id: 'a',
        createdAt: 1,
        offset: 0,
        total: 50_000,
        next: 8_000,
        text: 'A'.repeat(8_000),
      },
    );
    assert.equal(
      pageResult.parse(
        JSON.parse(
          (await call('get_message', { id: 'a', limit: 100_000 })).text,
        ),
      ).text.length,
      32_000,
    );
    assert.deepEqual(
      JSON.parse((await call('get_message', { id: 'b', offset: 2 })).text),
      { id: 'b', createdAt: 2, offset: 2, total: 6, text: 'cond' },
    );
    const result = requestResult.parse(
      JSON.parse(
        (await call('get_request', { id: 'r1', offset: 6, limit: 8 })).text,
      ),
    );
    assert.equal(result.text.length, 2_000);
    assert.equal(result.replies.length, 20);
    assert.deepEqual(result.transcript, {
      offset: 6,
      total: 33,
      next: 14,
      text: 'question',
    });
    f.request.transcriptExpired = true;
    const expired = requestResult.parse(
      JSON.parse((await call('get_request', { id: 'r1' })).text),
    );
    assert.equal(expired.note, 'transcript expired');
    assert.equal(expired.transcript, undefined);
    for (const name of ['get_message', 'get_request']) {
      for (const args of [
        { id: 'missing' },
        { id: name === 'get_message' ? 'a' : 'r1', offset: -1 },
        { id: name === 'get_message' ? 'a' : 'r1', offset: 0.5 },
        { id: name === 'get_message' ? 'a' : 'r1', limit: 0 },
      ])
        assert.equal((await call(name, args)).error, true);
    }
  });
  assert.equal(f.reads(), 0);
});

test('delegation resolves ranges in order after context, keeps history and rejects bounds, duplicates and expired excerpt ids', async () => {
  const f = fixture();
  await runInPlannerScope(f.scope, async () => {
    const base = { worker: 'w', goal: 'edit' };
    for (const inputs of [
      [{ id: 'a' }],
      [{ id: 'b' }, { id: 'b' }],
      [{ id: 'expired-excerpt' }],
      Array.from({ length: 6 }, (_, i) => ({ id: String(i) })),
      [{ id: 'b', offset: -1 }],
      [{ id: 'b', limit: 0 }],
      [{ id: 'b', offset: 20 }],
    ])
      assert.equal(
        (await call('delegate_task', { ...base, inputs })).error,
        true,
      );
    assert.match(
      (await call('delegate_task', { ...base, inputs: [{ id: 'a' }] })).text,
      /a.*50000.*40000/,
    );
    for (let i = 0; i < 3; i++)
      f.messages.push({
        id: `large${i}`,
        createdAt: 1,
        text: 'x'.repeat(40_000),
        trigger: 'user',
      });
    assert.match(
      (
        await call('delegate_task', {
          ...base,
          inputs: [0, 1, 2].map((i) => ({ id: `large${i}` })),
        })
      ).text,
      /large2.*40000.*allowed size/,
    );
    assert.equal(
      (
        await call('delegate_task', {
          ...base,
          context: 'constraints',
          history: 'all',
          inputs: [{ id: 'b' }, { id: 'a', offset: 4, limit: 3 }],
        })
      ).error,
      undefined,
    );
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    f.received[0].context,
    'constraints\n\n[input b 0-6 of 6]\nsecond\n\n[input a 4-7 of 50000]\nAAA',
  );
  assert.deepEqual(f.received[0].history, [{ role: 'user', content: 'raw' }]);
  await f.scope.board.stopAll();
});

for (const plannerContext of ['prepared', 'conversation'] as const) {
  test(`follow-up references first reply and retains raw history in ${plannerContext} mode`, async () => {
    let id = '';
    const received: ISubAgentInput[] = [];
    let calls = 0;
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
              capabilities: { contextPolicy: 'optional' as const },
              async run(input) {
                received.push(input);
                return { output: 'edited' };
              },
            },
          ],
        ]),
      },
      planner: {
        async process() {
          calls++;
          if (calls === 2) {
            assert.equal((await call('get_message', { id })).error, undefined);
            assert.equal(
              (await call('get_request', { id: 'r2' })).error,
              undefined,
            );
            assert.equal(
              (
                await call('delegate_task', {
                  worker: 'w',
                  goal: 'edit section',
                  inputs: [{ id }],
                  history: 'all',
                })
              ).error,
              undefined,
            );
          }
          return {
            ok: true,
            value: { content: calls === 1 ? 'original document' : 'delegated' },
          };
        },
      },
    });
    const first = await session.send('write document');
    id = first.id;
    assert.equal((await session.send('edit section')).text, 'delegated');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      received[0].context,
      `[input ${id} 0-17 of 17]\noriginal document`,
    );
    assert.ok(
      received[0].history?.some(
        (message) => message.content === 'original document',
      ),
    );
    await session.close();
  });
}

test('knowledge tool bounds queries, k, rendering and enforces collection validation and retrieval deadline', async () => {
  const seen: { text: string; k: number }[] = [];
  const session = await DialogueSession.open({
    id: 'knowledge-tools',
    retrievalTimeoutMs: 15,
    maxCorrections: 0,
    board: { workers: new Map() },
    plannerKnowledge: [
      {
        name: 'guidance',
        async search(query, k) {
          seen.push({ text: query.text, k });
          return [
            {
              collection: 'ignored',
              id: 'entry',
              text: '[data]'.repeat(10_000),
            },
          ];
        },
      },
      {
        name: 'slow',
        async search() {
          return new Promise(() => {});
        },
      },
    ],
    planner: {
      async process() {
        const result = await call('search_knowledge', {
          query: 'q'.repeat(3_000),
          k: 50,
          collection: 'guidance',
        });
        assert.equal(result.error, undefined);
        const rendered = z.string().parse(JSON.parse(result.text));
        assert.ok(rendered.length <= 12_000);
        assert.match(
          rendered,
          /\[planning knowledge\]\n\(guidance\/entry\) &#91;data&#93;/,
        );
        assert.deepEqual(seen.at(-1), { text: 'q'.repeat(2_000), k: 10 });
        assert.equal(
          (
            await call('search_knowledge', {
              query: 'q',
              collection: 'missing',
            })
          ).error,
          true,
        );
        assert.equal(
          (await call('search_knowledge', { query: 'q', k: 0 })).error,
          true,
        );
        assert.equal(
          (await call('search_knowledge', { query: 'q', k: 1.5 })).error,
          true,
        );
        assert.equal(
          JSON.parse(
            (await call('search_knowledge', { query: 'q', collection: 'slow' }))
              .text,
          ),
          '',
        );
        return { ok: true, value: { content: 'ok' } };
      },
    },
  });
  const result = await session.send('question');
  assert.equal(result.text, 'ok');
  await session.close();
});
