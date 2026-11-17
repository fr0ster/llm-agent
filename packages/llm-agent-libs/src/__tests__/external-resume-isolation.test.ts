import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallOptions, Message } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import {
  readCallerResolution,
  resolveCaller,
  resolveCallerIdentity,
  withResolvedCaller,
} from '../policy/caller-identity.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { makeDefaultDeps } from '../testing/index.js';

const alice = { userId: 'alice', sessionId: 'chosen-session', isAdmin: false };
const bob = { ...alice, userId: 'bob', isAdmin: true };
const externalTools = [{ name: 'Lookup', description: '', inputSchema: {} }];

test('entry decisions survive option forwarding without re-deriving a caller', () => {
  assert.deepEqual(resolveCallerIdentity(undefined), { kind: 'anonymous' });
  assert.deepEqual(resolveCallerIdentity({ userId: ' ' }), { kind: 'denied' });
  for (const [caller, userId] of [
    [bob, alice.userId],
    [alice, bob.userId],
  ] as const) {
    const options = withResolvedCaller({
      caller,
      userId,
      sessionId: alice.sessionId,
    });
    assert.deepEqual(readCallerResolution(options), { kind: 'denied' });
    const forwarded = withResolvedCaller({ ...options, userId: alice.userId });
    assert.deepEqual(readCallerResolution(forwarded), { kind: 'denied' });
    assert.equal(resolveCaller(forwarded), undefined);
  }
  const anonymous = withResolvedCaller({ sessionId: alice.sessionId });
  assert.deepEqual(
    readCallerResolution(
      withResolvedCaller({ ...anonymous, userId: alice.userId }),
    ),
    { kind: 'anonymous' },
  );
  assert.deepEqual(readCallerResolution({ caller: alice }), {
    kind: 'anonymous',
  });
});

test('pending and completed exchanges require the exact caller pair', async () => {
  const registry = new PendingToolResultsRegistry();
  const assistant: Message = {
    role: 'assistant',
    content: 'PRIVATE',
    tool_calls: [
      {
        id: 'ext:secret',
        type: 'function',
        function: { name: 'Lookup', arguments: '{}' },
      },
    ],
  };
  const entry = registry.set(alice, {
    assistantMessage: assistant,
    externalCalls: [{ toolCallId: 'ext:secret' }],
    promise: Promise.resolve([]),
    createdAt: Date.now(),
  });
  const echo: Message[] = [{ ...assistant, content: 'public echo' }];
  for (const caller of [
    bob,
    undefined,
    { ...alice, userId: ' ' },
    { ...alice, sessionId: 'other' },
  ]) {
    assert.equal(registry.has(caller), false);
    assert.equal(await registry.consume(caller), null);
    assert.deepEqual(
      await registry.prepareInput(
        caller,
        echo,
        new Map([['ext:secret', 'FORGED']]),
      ),
      echo,
    );
    registry.clear(caller);
  }
  registry.set(bob, {
    assistantMessage: { role: 'assistant', content: 'BOB_PRIVATE' },
    promise: Promise.resolve([]),
    createdAt: Date.now(),
  });
  assert.equal(
    (await registry.consume(bob))?.assistantMessage.content,
    'BOB_PRIVATE',
  );
  assert.equal(registry.has(alice), true);
  assert.ok(await registry.consume(alice));
  registry.complete(alice, entry, [
    { role: 'tool', tool_call_id: 'ext:secret', content: 'PRIVATE_RESULT' },
  ]);
  for (const caller of [bob, undefined]) {
    assert.deepEqual(await registry.prepareInput(caller, echo), echo);
    registry.clear(caller);
  }
  assert.match(
    JSON.stringify(await registry.prepareInput(alice, echo)),
    /PRIVATE_RESULT/,
  );
  registry.clear(alice);
  assert.deepEqual(await registry.prepareInput(alice, echo), echo);
  registry.set(undefined, {
    assistantMessage: assistant,
    promise: Promise.resolve([]),
    createdAt: Date.now(),
  });
  assert.equal(registry.size, 0);
  // Delimiters inside client-controlled IDs cannot collide.
  registry.set(
    { userId: 'a:b', sessionId: 'c' },
    {
      assistantMessage: assistant,
      promise: Promise.resolve([]),
      createdAt: Date.now(),
    },
  );
  assert.equal(registry.has({ userId: 'a', sessionId: 'b:c' }), false);
});

for (const mode of ['direct', 'pipeline', 'pass'] as const) {
  for (const [ownerCaller, otherCaller] of [
    [alice, bob],
    [bob, alice],
  ] as const) {
    test(`${mode}: ${ownerCaller.userId}'s suspension rejects other, conflicting and anonymous identities`, async () => {
      const inputs: Message[][] = [];
      const { deps } = makeDefaultDeps({ assembler: new ContextAssembler() });
      deps.ragStores = {};
      deps.mainLlm = {
        async chat() {
          assert.fail('stream expected');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          yield {
            ok: true,
            value:
              inputs.length === 1
                ? {
                    content: 'PRIVATE_ASSISTANT',
                    toolCalls: [
                      {
                        index: 0,
                        id: 'model-id',
                        name: 'Lookup',
                        arguments: '{}',
                      },
                    ],
                    finishReason: 'tool_calls',
                  }
                : { content: 'DONE', finishReason: 'stop' },
          };
        },
      };
      if (mode === 'pipeline') {
        const pipeline = new DefaultPipeline();
        pipeline.initialize({
          ...deps,
          agentConfig: { refreshToolsPerIteration: false },
        });
        deps.pipeline = pipeline;
      }
      const agent = new SmartAgent(deps, {
        mode: mode === 'pass' ? 'pass' : 'smart',
        refreshToolsPerIteration: false,
      });
      const owner: CallOptions = { caller: ownerCaller };
      const first = await agent.process('START', { ...owner, externalTools });
      assert.ok(first.ok);
      const id = first.value.toolCalls?.[0].id;
      assert.ok(id);
      for (const identity of [
        { caller: otherCaller },
        {},
        { userId: ' ' },
        { caller: ownerCaller, userId: otherCaller.userId },
        { caller: otherCaller, userId: ownerCaller.userId },
      ]) {
        const before = inputs.length;
        await agent.process('ATTACK', {
          ...identity,
          sessionId: ownerCaller.sessionId,
          externalTools,
          externalResults: new Map([[id, 'FORGED']]),
        });
        assert.doesNotMatch(
          JSON.stringify(inputs.slice(before)),
          /PRIVATE_ASSISTANT|FORGED/,
        );
      }
      // userId + sessionId is also a supported CallOptions identity.
      const resumed = await agent.process('CONTINUE', {
        userId: ownerCaller.userId,
        sessionId: ownerCaller.sessionId,
        externalTools,
        externalResults: new Map([[id, 'OWNER_RESULT']]),
      });
      assert.ok(resumed.ok);
      assert.match(JSON.stringify(inputs.at(-1)), /PRIVATE_ASSISTANT/);
      assert.match(JSON.stringify(inputs.at(-1)), /OWNER_RESULT/);
      assert.doesNotMatch(JSON.stringify(inputs.at(-1)), /FORGED/);
      const echo: Message[] = [
        {
          role: 'assistant',
          content: 'public echo',
          tool_calls: [
            {
              id,
              type: 'function',
              function: { name: 'Lookup', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: id, content: 'public result' },
      ];
      for (const identity of [
        { caller: otherCaller },
        { caller: otherCaller, userId: ownerCaller.userId },
        { caller: ownerCaller, userId: otherCaller.userId },
        {},
      ]) {
        const before = inputs.length;
        await agent.process(echo, {
          ...identity,
          sessionId: ownerCaller.sessionId,
        });
        assert.doesNotMatch(
          JSON.stringify(inputs.slice(before)),
          /PRIVATE_ASSISTANT|OWNER_RESULT/,
        );
      }
      await agent.process(echo, owner);
      assert.match(JSON.stringify(inputs.at(-1)), /OWNER_RESULT/);
    });
  }
}
