import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmStreamChunk,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../../../builder.js';
import { DialogueSession } from '../dialogue-session.js';
import { DIALOGUE_PLANNER_SYSTEM } from '../planner-prompt.js';
import { PlannerToolsClient } from '../planner-tools-client.js';

test('planner prompt requires result delegation and planned verification', () => {
  for (const rule of [
    'Plan the whole request up front',
    'done criterion',
    'plan a check by another subagent',
    'the worker that did the work never checks itself',
    'Plan checks in proportion to risk',
    'Do not add checks the plan did not foresee unless a result shows a concrete problem',
    'Delegate results, not tool calls',
    'one parallel wave',
    'Never redo delegated work',
    're-delegate only for a failure or a concrete gap',
    'then store once',
    'no extra rounds',
    'every expected identifier has its processed/stored result and the count matches',
    'A light check that only reads the result may be done by you',
    'check with the checker when the plan foresees it',
  ])
    assert.ok(DIALOGUE_PLANNER_SYSTEM.includes(rule), rule);
});

test('documented builder exposes exactly the six control tools and dispatches delegation inside a session', async () => {
  const expected = [
    'delegate_task',
    'stop_task',
    'get_plan',
    'get_task',
    'list_tasks',
    'update_plan',
  ].sort();
  let calls = 0;
  const llm: ILlm = {
    async chat() {
      throw new Error('expected streaming');
    },
    async *streamChat(
      messages,
      tools,
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      assert.deepEqual(tools?.map((t) => t.name).sort(), expected);
      calls++;
      if (calls === 1 || calls === 3) {
        const dialogue = messages.filter((m) => m.role !== 'system');
        for (let i = 1; i < dialogue.length; i++)
          assert.notEqual(dialogue[i].role, dialogue[i - 1].role);
        assert.equal(dialogue.at(-1)?.role, 'user');
        assert.match(String(dialogue.at(-1)?.content), /\[plan\] status:/);
        assert.doesNotMatch(String(dialogue.at(-1)?.content), /\[tasks\]/);
      }
      yield {
        ok: true,
        value:
          calls === 1
            ? {
                content: '',
                finishReason: 'tool_calls',
                toolCalls: [
                  {
                    id: 'delegate',
                    name: 'delegate_task',
                    arguments: { worker: 'w', goal: 'real builder goal' },
                  },
                ],
              }
            : { content: 'delegated', finishReason: 'stop' },
      };
    },
  };
  const handle = await new SmartAgentBuilder({
    skipModelValidation: true,
    prompts: { system: DIALOGUE_PLANNER_SYSTEM },
  })
    .withMode('hard')
    .withMainLlm(llm)
    .withMcpClients([new PlannerToolsClient()])
    .build();
  let resolveWork!: (result: { output: string }) => void;
  const work = new Promise<{ output: string }>((resolve) => {
    resolveWork = resolve;
  });
  const session = await DialogueSession.open({
    id: 'builder',
    planner: handle.agent,
    board: {
      workers: new Map([
        [
          'w',
          {
            name: 'w',
            capabilities: { contextPolicy: 'optional' },
            run: () => work,
          },
        ],
      ]),
    },
  });
  try {
    assert.equal((await session.send('delegate')).text, 'delegated');
    assert.equal(calls, 2, 'one process call executes the tool then answers');
    assert.equal((await session.send('progress?')).text, 'delegated');
    assert.equal(calls, 3);
    assert.equal(session.snapshot().tasks[0]?.goal, 'real builder goal');
  } finally {
    const closing = session.close();
    resolveWork({ output: 'settled' });
    await closing;
    await handle.close();
  }
});
