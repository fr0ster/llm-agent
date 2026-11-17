import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallOptions, Message } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { HistoryMemory } from '../history/history-memory.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { callerIdentityKey } from '../policy/caller-identity.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { makeDefaultDeps } from '../testing/index.js';

const alice = {
  userId: 'alice',
  sessionId: 'session:["quoted"]',
  isAdmin: false,
};
const bob = { ...alice, userId: 'bob' };
const other = { ...alice, sessionId: `${alice.sessionId}:other` };
const key = (caller: typeof alice): string => {
  const value = callerIdentityKey(caller);
  assert.ok(value);
  return value;
};

for (const customMemory of [false, true]) {
  test(
    'closeSession clears all caller summaries before the next request (custom=' +
      customMemory +
      ')',
    async () => {
      const memory = new HistoryMemory();
      const historyMemory = customMemory
        ? {
            pushRecent: memory.pushRecent.bind(memory),
            getRecent: memory.getRecent.bind(memory),
            clear: memory.clear.bind(memory),
          }
        : memory;
      const inputs: Message[][] = [];
      const { deps } = makeDefaultDeps({ assembler: new ContextAssembler() });
      deps.historyMemory = historyMemory;
      deps.mainLlm = {
        async chat() {
          assert.fail('stream expected');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          yield { ok: true, value: { content: 'DONE', finishReason: 'stop' } };
        },
      };
      const config = {
        semanticHistoryEnabled: true,
        refreshToolsPerIteration: false,
      };
      const pipeline = new DefaultPipeline();
      pipeline.initialize({ ...deps, agentConfig: config });
      deps.pipeline = pipeline;
      const agent = new SmartAgent(deps, config);
      for (const caller of [alice, bob, other]) {
        memory.pushRecent(key(caller), `PRIVATE_SUMMARY:${caller.userId}`);
        assert.ok((await agent.process('before', { caller })).ok);
        assert.match(JSON.stringify(inputs.at(-1)), /PRIVATE_SUMMARY/);
      }
      await agent.closeSession(alice.sessionId);
      for (const caller of [alice, bob]) {
        assert.deepEqual(memory.getRecent(key(caller), 10), []);
        assert.ok((await agent.process('after', { caller })).ok);
        assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /PRIVATE_SUMMARY/);
      }
      assert.deepEqual(memory.getRecent(key(other), 10), [
        'PRIVATE_SUMMARY:alice',
      ]);
    },
  );
}

test('closeSession clears preloaded summaries and blocks across all exact caller pairs', async () => {
  const memory = new HistoryMemory();
  const availability = new ToolAvailabilityRegistry();
  const { deps } = makeDefaultDeps();
  deps.historyMemory = memory;
  deps.toolAvailabilityRegistry = availability;
  const agent = new SmartAgent(deps, {});
  for (const caller of [alice, bob, other]) {
    memory.pushRecent(key(caller), 'PRIVATE_SUMMARY');
    availability.block(key(caller), 'Work', 'forbidden');
  }
  memory.pushRecent(alice.sessionId, 'legacy summary');
  await agent.closeSession(alice.sessionId, { caller: alice });
  assert.deepEqual(memory.getRecent(key(alice), 10), []);
  assert.equal(availability.isBlocked(key(alice), 'Work'), false);
  assert.equal(availability.isBlocked(key(bob), 'Work'), true);
  assert.deepEqual(memory.getRecent(key(bob), 10), ['PRIVATE_SUMMARY']);
  await agent.closeSession(alice.sessionId);
  for (const caller of [alice, bob]) {
    assert.deepEqual(memory.getRecent(key(caller), 10), []);
    assert.equal(availability.isBlocked(key(caller), 'Work'), false);
  }
  assert.deepEqual(memory.getRecent(alice.sessionId, 10), []);
  assert.equal(availability.isBlocked(key(other), 'Work'), true);
  assert.deepEqual(memory.getRecent(key(other), 10), ['PRIVATE_SUMMARY']);
});

test('a session ID equal to another caller key does not erase that caller', async () => {
  const memory = new HistoryMemory();
  const availability = new ToolAvailabilityRegistry();
  const { deps } = makeDefaultDeps();
  deps.historyMemory = memory;
  deps.toolAvailabilityRegistry = availability;
  const agent = new SmartAgent(deps, {});
  const encodedSession = { ...alice, sessionId: key(other) };
  for (const caller of [other, encodedSession]) {
    memory.pushRecent(key(caller), 'PRIVATE_SUMMARY');
    availability.block(key(caller), 'Work', 'forbidden');
  }
  await agent.closeSession(encodedSession.sessionId);
  assert.deepEqual(memory.getRecent(key(encodedSession), 10), []);
  assert.equal(availability.isBlocked(key(encodedSession), 'Work'), false);
  assert.deepEqual(memory.getRecent(key(other), 10), ['PRIVATE_SUMMARY']);
  assert.equal(availability.isBlocked(key(other), 'Work'), true);
});

for (const mode of ['direct', 'pipeline', 'pass'] as const) {
  test(
    mode +
      ': closeSession releases pending and completed exchanges for every caller',
    async () => {
      const inputs: Message[][] = [];
      let suspend = false;
      const { deps } = makeDefaultDeps({ assembler: new ContextAssembler() });
      deps.mainLlm = {
        async chat() {
          assert.fail('stream expected');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          const start = suspend;
          yield {
            ok: true,
            value: start
              ? {
                  content: 'PRIVATE_ASSISTANT',
                  finishReason: 'tool_calls',
                  toolCalls: [
                    {
                      index: 0,
                      id: 'model-id',
                      name: 'Lookup',
                      arguments: '{}',
                    },
                  ],
                }
              : { content: 'DONE', finishReason: 'stop' },
          };
        },
      };
      const config = { refreshToolsPerIteration: false };
      if (mode === 'pipeline') {
        const pipeline = new DefaultPipeline();
        pipeline.initialize({ ...deps, agentConfig: config });
        deps.pipeline = pipeline;
      }
      const agent = new SmartAgent(deps, {
        ...config,
        mode: mode === 'pass' ? 'pass' : 'smart',
      });
      const pending = new PendingToolResultsRegistry();
      const availability = new ToolAvailabilityRegistry();
      const options: CallOptions =
        mode === 'pipeline'
          ? { pendingToolResults: pending, toolAvailability: availability }
          : {};
      const externalTools = [
        { name: 'Lookup', description: '', inputSchema: {} },
      ];
      let completedEcho: Message[] = [];
      for (const caller of [bob, alice, other]) {
        suspend = true;
        const first = await agent.process('START', {
          ...options,
          caller,
          externalTools,
        });
        suspend = false;
        assert.ok(first.ok);
        const id = first.value.toolCalls?.[0].id;
        assert.ok(id);
        if (caller === bob) {
          assert.ok(
            (
              await agent.process('CONTINUE', {
                ...options,
                caller,
                externalResults: new Map([[id, 'PRIVATE_RESULT']]),
              })
            ).ok,
          );
          assert.match(JSON.stringify(inputs.at(-1)), /PRIVATE_RESULT/);
          completedEcho = [
            {
              role: 'assistant',
              content: 'public',
              tool_calls: [
                {
                  id,
                  type: 'function',
                  function: { name: 'Lookup', arguments: '{}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: id, content: 'public' },
          ];
        }
      }
      availability.block(key(alice), 'Work', 'forbidden');
      availability.block(key(bob), 'Work', 'forbidden');
      availability.block(key(other), 'Work', 'forbidden');
      await agent.closeSession(alice.sessionId);
      assert.ok(
        (await agent.process('AFTER', { ...options, caller: alice })).ok,
      );
      assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /PRIVATE_/);
      assert.ok(
        (await agent.process(completedEcho, { ...options, caller: bob })).ok,
      );
      assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /PRIVATE_/);
      assert.ok(
        (await agent.process('CONTINUE', { ...options, caller: other })).ok,
      );
      assert.match(JSON.stringify(inputs.at(-1)), /PRIVATE_ASSISTANT/);
      if (mode === 'pipeline') {
        assert.equal(availability.isBlocked(key(alice), 'Work'), false);
        assert.equal(availability.isBlocked(key(bob), 'Work'), false);
        assert.equal(availability.isBlocked(key(other), 'Work'), true);
      }
    },
  );
}
