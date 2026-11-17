import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ICoordinatorContext,
  ILlm,
  IMcpClient,
  LlmToolCall,
  Message,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import {
  externalToolCallId,
  McpError,
  NoopToolCache,
  TokenLedger,
} from '@mcp-abap-adt/llm-agent';
import { type AgentCallOptions, SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { SelfDispatch } from '../coordinator/dispatch/self.js';
import { CyclicReActExecutor } from '../coordinator/stepper/cyclic-react-executor.js';
import { LegacyAccumulateContextStrategy } from '../pipeline/context/tool-loop-context/index.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { ToolResponseRound } from '../pipeline/handlers/tool-response-round.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import {
  makeAssembler,
  makeDefaultDeps,
  testCallOptions,
} from '../testing/index.js';
import { assertUniqueToolHistory } from './tool-history-assertions.js';

const callOptions = (options: AgentCallOptions): AgentCallOptions => ({
  ...testCallOptions(options),
  ...options,
});

const categories = [
  'Blocked',
  'Ghost',
  'RejectedExternal',
  'CachedExternal',
  'Work',
  'OtherWork',
] as const;
const externalTools = ['RejectedExternal', 'CachedExternal'].map((name) => ({
  name,
  description: name,
  inputSchema: {},
}));

for (const pipeline of [false, true]) {
  for (let mask = 1; mask < 1 << categories.length; mask++) {
    test(`${pipeline ? 'pipeline' : 'direct'}: complete ordered response, category mask ${mask}`, async () => {
      const selected = categories.filter((_, index) => mask & (1 << index));
      // Alternate order to expose category concatenation and early-continue bugs.
      if (mask % 2) selected.reverse();
      const calls = selected.map((name, index) => ({
        index,
        id: `call-${index}`,
        name,
        arguments:
          index % 2
            ? '{ "sentinel": "ARGUMENT", "n": 1 }'
            : '{invalid-json-SENTINEL',
      }));
      const inputs: Message[][] = [];
      const recorded: ToolRound[] = [];
      const executed: string[] = [];
      const strategy = new LegacyAccumulateContextStrategy();
      const originalRecord = strategy.record.bind(strategy);
      strategy.record = async (round) => {
        recorded.push(structuredClone(round));
        await originalRecord(round);
      };
      let completeOther = () => {};
      const otherDone = new Promise<void>((resolve) => {
        completeOther = resolve;
      });
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: ['Work', 'OtherWork', 'Blocked'].map((name) => ({
              name,
              description: name,
              inputSchema: {},
            })),
          };
        },
        async callTool(name) {
          executed.push(name);
          // Deliberately reverse completion order.
          if (
            name === 'Work' &&
            calls.some(
              (call, index) => call.name === 'OtherWork' && index % 2 === 1,
            ) &&
            mask % 3 !== 0
          )
            await otherDone;
          if (name === 'OtherWork') completeOther();
          return { ok: true, value: { content: `RESULT-${name}` } };
        },
      };
      const { deps } = makeDefaultDeps({
        assembler: makeAssembler([{ role: 'user', content: 'go' }]),
        mcpClients: [client],
        outputValidator: {
          async validate(content) {
            return {
              ok: true,
              value: {
                valid: content !== 'REJECTED_REPLY',
                reason: 'CORRECTION_SENTINEL',
              },
            };
          },
        },
      });
      deps.mainLlm = {
        async chat() {
          throw new Error('Expected streaming');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          assert.ok(inputs.length <= 3);
          yield {
            ok: true,
            value:
              inputs.length === 2
                ? // A complete tool response preserves declaration order, including invalid arguments.
                  {
                    content: 'MIXED_ASSISTANT_SENTINEL',
                    toolCalls: calls,
                    finishReason: 'tool_calls' as const,
                  }
                : {
                    content: inputs.length === 1 ? 'REJECTED_REPLY' : 'DONE',
                    finishReason: 'stop' as const,
                  },
          };
        },
      };
      deps.toolCache = new NoopToolCache();
      deps.toolLoopContextStrategyFactory = () => strategy;
      const registry = new ToolAvailabilityRegistry();
      registry.block(
        JSON.stringify(['test-user', 'invariant']),
        'Blocked',
        'blocked',
      );
      deps.toolAvailabilityRegistry = registry;
      const config = {
        refreshToolsPerIteration: false,
        maxToolCalls: mask % 3 === 0 ? 1 : undefined,
      };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const agent = new SmartAgent(deps, config);
      const options = callOptions({
        sessionId: 'invariant',
        toolAvailability: registry,
        externalTools,
        externalResults: new Map(
          calls
            .filter((call) => call.name === 'CachedExternal')
            .map((call) => {
              let args = {};
              try {
                args = JSON.parse(call.arguments);
              } catch {
                /* Invalid calls produce error results instead of using cached results. */
              }
              return [externalToolCallId(call.name, args), 'CACHED_RESULT'];
            }),
        ),
        toolRoundGuard: (round) =>
          new Map(
            round.flatMap((call, index) =>
              call.name === 'RejectedExternal'
                ? [[index, 'REJECTION_SENTINEL'] as const]
                : [],
            ),
          ),
      });
      const first = await agent.process('go', options);
      assert.ok(first.ok);
      if (first.value.stopReason === 'tool_calls') {
        const resumed = await agent.process([], {
          ...options,
          externalResults: new Map(
            (first.value.toolCalls ?? []).map((call) => [
              call.id,
              'CACHED_RESULT',
            ]),
          ),
        });
        assert.ok(resumed.ok);
      }
      assert.equal(inputs.length, 3);
      assert.equal(
        recorded.length,
        calls.some(
          (call, index) => call.name === 'CachedExternal' && index % 2 === 1,
        )
          ? 0
          : 1,
        'local rounds are recorded atomically; suspended rounds resume from stored messages',
      );
      const history = inputs[2];
      const index = history.findIndex(
        (message) => message.content === 'MIXED_ASSISTANT_SENTINEL',
      );
      assert.ok(
        index >
          history.findIndex((message) =>
            String(message.content).includes('CORRECTION_SENTINEL'),
          ),
      );
      assert.equal(
        history.filter(
          (message) => message.content === 'MIXED_ASSISTANT_SENTINEL',
        ).length,
        1,
      );
      assertUniqueToolHistory(history.slice(index));
      const recordedCalls = history[index].tool_calls ?? [];
      assert.deepEqual(history[index], {
        role: 'assistant',
        content: 'MIXED_ASSISTANT_SENTINEL',
        tool_calls: calls.map((call, ordinal) => ({
          id: recordedCalls[ordinal].id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      const results = history.slice(index + 1);
      assert.equal(results.length, calls.length);
      calls.forEach((call, ordinal) => {
        assert.equal(results[ordinal].role, 'tool');
        assert.equal(results[ordinal].tool_call_id, recordedCalls[ordinal].id);
        const text = String(results[ordinal].content);
        if (ordinal % 2 === 0) assert.match(text, /Invalid tool arguments/);
        else if (call.name === 'Blocked')
          assert.match(text, /temporarily unavailable/);
        else if (call.name === 'Ghost') assert.match(text, /not found/);
        else if (call.name === 'RejectedExternal')
          assert.match(text, /REJECTION_SENTINEL/);
        else if (call.name === 'CachedExternal')
          assert.equal(text, 'CACHED_RESULT');
        else if (executed.includes(call.name))
          assert.equal(text, `RESULT-${call.name}`);
        else assert.match(text, /budget.*exhausted/);
      });
      assert.equal(
        executed.length,
        Math.min(
          calls.filter(
            (call, index) => call.name.endsWith('Work') && index % 2 === 1,
          ).length,
          config.maxToolCalls ?? Infinity,
        ),
      );
    });
  }
}

for (const pipeline of [false, true]) {
  for (const includeProjection of [false, true]) {
    for (const historyRecencyWindow of [undefined, 1]) {
      test(`${pipeline ? 'pipeline' : 'direct'}: typed external continuation preserves chronology (projection=${includeProjection}, window=${historyRecencyWindow})`, async () => {
        const initial: Message[] = [
          { role: 'user', content: 'ORIGINAL_USER_SENTINEL' },
        ];
        const mixedArgs: LlmToolCall['arguments'] = {
          sentinel: 'MIXED',
          payload: { enabled: true, ids: [1, 2] },
        };
        const rawArgs =
          '{ "sentinel": "MIXED", "payload": { "enabled": true, "ids": [1, 2] } }';
        const inputs: Message[][] = [];
        const calls = [
          'Blocked',
          'Work',
          'Ghost',
          'Pending',
          'CachedExternal',
          'RejectedExternal',
        ].map((name, index) => ({
          index,
          id: `mixed-${index}`,
          name,
          arguments: rawArgs,
        }));
        const { deps } = makeDefaultDeps({
          assembler: new ContextAssembler({ historyRecencyWindow }),
          mcpClients: [
            {
              async listTools() {
                return {
                  ok: true,
                  value: [{ name: 'Work', description: '', inputSchema: {} }],
                };
              },
              async callTool() {
                return { ok: true, value: { content: 'WORK_RESULT' } };
              },
            },
          ],
          outputValidator: {
            async validate(content) {
              return {
                ok: true,
                value: { valid: content !== 'BAD_REPLY', reason: 'CORRECTION' },
              };
            },
          },
        });
        const registry = new ToolAvailabilityRegistry();
        deps.toolAvailabilityRegistry = registry;
        deps.mainLlm = {
          async chat() {
            assert.fail('streaming expected');
          },
          async *streamChat(messages) {
            inputs.push(structuredClone(messages));
            const turn = inputs.length;
            assert.ok(turn <= 5);
            yield {
              ok: true,
              value:
                turn === 1
                  ? { content: 'BAD_REPLY', finishReason: 'stop' }
                  : turn === 2
                    ? {
                        content: 'EARLIER_ASSISTANT',
                        toolCalls: [
                          {
                            index: 0,
                            id: 'mixed-1',
                            name: 'Work',
                            arguments: '{}',
                          },
                        ],
                        finishReason: 'tool_calls',
                      }
                    : turn === 3
                      ? {
                          content: 'MIXED_ASSISTANT_SENTINEL',
                          toolCalls: calls,
                          finishReason: 'tool_calls',
                        }
                      : turn === 4
                        ? {
                            content: 'LATER_ASSISTANT',
                            toolCalls: [
                              {
                                index: 0,
                                id: 'later',
                                name: 'Work',
                                arguments: '{}',
                              },
                            ],
                            finishReason: 'tool_calls',
                          }
                        : { content: 'DONE', finishReason: 'stop' },
            };
          },
        };
        deps.toolCache = new NoopToolCache();
        const config = { refreshToolsPerIteration: false };
        if (pipeline) {
          const flow = new DefaultPipeline();
          flow.initialize({ ...deps, agentConfig: config });
          deps.pipeline = flow;
        }
        const agent = new SmartAgent(deps, config);
        const sessionId = `mixed-resume-${pipeline}-${includeProjection}`;
        registry.block(
          JSON.stringify(['test-user', sessionId]),
          'Blocked',
          'blocked',
        );
        let pendingId: string | undefined;
        let cachedId: string | undefined;
        const options = callOptions({
          sessionId,
          requestStartedAt: 1700000000000,
          externalTools: [
            ...externalTools,
            { name: 'Pending', description: '', inputSchema: {} },
          ],
          externalResults: new Map([
            [externalToolCallId('CachedExternal', mixedArgs), 'CACHED_RESULT'],
          ]),
          toolRoundGuard: (round) =>
            new Map(
              round.flatMap((call, index) =>
                call.name === 'RejectedExternal'
                  ? [[index, 'REJECTION_SENTINEL'] as const]
                  : [],
              ),
            ),
        });
        if (includeProjection) {
          let surfaced = false;
          for await (const chunk of agent.streamProcess(initial, options)) {
            assert.ok(chunk.ok);
            if (
              chunk.value.toolCalls?.some((call) => call.name === 'Pending')
            ) {
              surfaced = true;
              cachedId = chunk.value.toolCalls.find(
                (call) => call.name === 'CachedExternal',
              )?.id;
              pendingId = chunk.value.toolCalls.find(
                (call) => call.name === 'Pending',
              )?.id;
              break; // Consumers can close immediately after an external call.
            }
          }
          assert.equal(surfaced, true);
        } else {
          const first = await agent.process(initial, options);
          assert.ok(first.ok);
          assert.equal(first.value.stopReason, 'tool_calls');
          cachedId = first.value.toolCalls?.find(
            (call) => call.function.name === 'CachedExternal',
          )?.id;
          pendingId = first.value.toolCalls?.find(
            (call) => call.function.name === 'Pending',
          )?.id;
        }
        assert.ok(pendingId);
        assert.ok(cachedId);
        const roundId = pendingId.split(':')[1];
        const resumedCallId = (call: (typeof calls)[number]): string => {
          if (call.name === 'Pending') return pendingId;
          if (call.name === 'CachedExternal') return cachedId;
          if (call.name === 'RejectedExternal') return `ext:${roundId}:2`;
          return `tc:${roundId}:${calls.indexOf(call)}`;
        };
        assert.equal(inputs.length, 3);
        assert.ok(
          inputs[0].some(
            (message) =>
              String(message.content).includes('[request time]') &&
              String(message.content).includes('ORIGINAL_USER_SENTINEL'),
          ),
        );
        const assembled: Message[] = includeProjection
          ? [
              ...inputs[2].filter((message) => message.role !== 'system'),
              {
                role: 'assistant',
                content: 'MIXED_ASSISTANT_SENTINEL',
                tool_calls: calls.map((call) => ({
                  id: resumedCallId(call),
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                })),
              },
              ...[
                'Error: Tool "Blocked" is temporarily unavailable in this session.',
                'WORK_RESULT',
                'Error: Tool "Ghost" not found.',
                'EXTERNAL_RESULT',
                'CACHED_RESULT',
                'Error: REJECTION_SENTINEL',
              ].map(
                (content, index): Message => ({
                  role: 'tool',
                  tool_call_id: resumedCallId(calls[index]),
                  content,
                }),
              ),
              { role: 'user', content: 'CONTINUE_SENTINEL' },
            ]
          : [{ role: 'user', content: 'CONTINUE_SENTINEL' }];
        const resumed = await agent.process(assembled, {
          ...options,
          externalResults: new Map([
            [pendingId, 'EXTERNAL_RESULT'],
            [cachedId, 'CACHED_RESULT'],
          ]),
        });
        assert.ok(resumed.ok);
        assert.equal(inputs.length, 5);
        for (const messages of inputs.slice(3)) {
          const index = messages.findIndex(
            (message) => message.content === 'MIXED_ASSISTANT_SENTINEL',
          );
          assert.equal(
            messages.filter(
              (message) => message.content === 'MIXED_ASSISTANT_SENTINEL',
            ).length,
            1,
          );
          assert.equal(
            messages.filter(
              (message) => message.content === 'EARLIER_ASSISTANT',
            ).length,
            historyRecencyWindow === 1 ? 0 : 1,
            'only the explicit history window may remove earlier responses',
          );
          assertUniqueToolHistory(
            messages.filter(
              (message) =>
                message.role === 'tool' || message.tool_calls?.length,
            ),
          );
          assert.deepEqual(
            messages[index].tool_calls,
            calls.map((call) => ({
              id: resumedCallId(call),
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          );
          assert.deepEqual(
            messages
              .slice(index + 1, index + 1 + calls.length)
              .map((message) => message.tool_call_id),
            calls.map(resumedCallId),
          );
          assert.equal(messages[index + 4].content, 'EXTERNAL_RESULT');
          assert.equal(messages[index + 5].content, 'CACHED_RESULT');
          assert.match(
            String(messages[index + 6].content),
            /REJECTION_SENTINEL/,
          );
          assert.match(
            String(messages[index + 7].content),
            /CONTINUE_SENTINEL/,
          );
          assert.equal(
            messages.filter((message) =>
              String(message.content).includes('ORIGINAL_USER_SENTINEL'),
            ).length,
            historyRecencyWindow === 1 ? 0 : 1,
          );
          const correction = messages.findIndex((message) =>
            String(message.content).includes('rejected by validation'),
          );
          const earlier = messages.findIndex(
            (message) => message.content === 'EARLIER_ASSISTANT',
          );
          if (historyRecencyWindow === 1) {
            assert.equal(correction, -1);
            assert.equal(earlier, -1);
          } else {
            assert.ok(
              correction >= 0 && correction < earlier && earlier < index,
            );
          }
        }
      });
    }
  }
}

for (const pipeline of [false, true]) {
  for (const failure of ['unavailable'] as const) {
    test(`${pipeline ? 'pipeline' : 'direct'}: record all results before exposing ${failure}`, async () => {
      const recorded: ToolRound[] = [];
      const strategy = new LegacyAccumulateContextStrategy();
      const record = strategy.record.bind(strategy);
      strategy.record = async (round) => {
        recorded.push(structuredClone(round));
        await record(round);
      };
      const { deps } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        mcpClients: [
          {
            async listTools() {
              return {
                ok: true,
                value: ['Fail', 'Work'].map((name) => ({
                  name,
                  description: name,
                  inputSchema: {},
                })),
              };
            },
            async callTool(name) {
              if (name === 'Fail') {
                return {
                  ok: false,
                  error: new McpError(
                    'UNAVAILABLE_SENTINEL',
                    'MCP_NOT_CONNECTED',
                  ),
                };
              }
              await Promise.resolve();
              return { ok: true, value: { content: 'LATER_RESULT_SENTINEL' } };
            },
          },
        ],
      });
      deps.toolLoopContextStrategyFactory = () => strategy;
      let turns = 0;
      deps.mainLlm = {
        async chat() {
          assert.fail('stream expected');
        },
        async *streamChat() {
          assert.ok(++turns <= 2);
          yield {
            ok: true,
            value:
              turns === 1
                ? {
                    content: 'FAILURE_ASSISTANT',
                    finishReason: 'tool_calls',
                    toolCalls: ['Fail', 'Work', 'Ghost'].map((name, index) => ({
                      index,
                      id: `failure-${index}`,
                      name,
                      arguments: '{}',
                    })),
                  }
                : { content: 'DONE', finishReason: 'stop' },
          };
        },
      };
      const config = { refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const agent = new SmartAgent(deps, config);
      const run = async () => {
        let errors = 0;
        for await (const chunk of agent.streamProcess(
          'go',
          testCallOptions(),
        )) {
          if (!chunk.ok) {
            errors++;
            assert.equal(
              recorded.length,
              1,
              'commit the round before terminal failure',
            );
            break;
          }
        }
        return errors;
      };
      assert.equal(await run(), 1);
      assert.equal(turns, 1);
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].assistant.content, 'FAILURE_ASSISTANT');
      assertUniqueToolHistory([recorded[0].assistant, ...recorded[0].results]);
      assert.equal(recorded[0].assistant.tool_calls?.length, 3);
      assert.deepEqual(
        recorded[0].results.map((message) => message.tool_call_id),
        recorded[0].assistant.tool_calls?.map((call) => call.id),
      );
      assert.match(
        String(recorded[0].results[0].content),
        /UNAVAILABLE_SENTINEL/,
      );
      assert.equal(recorded[0].results[1].content, 'LATER_RESULT_SENTINEL');
      assert.match(String(recorded[0].results[2].content), /not found/);
    });
  }
}

for (const loop of ['self', 'cyclic'] as const) {
  test(`${loop}: tool failure and repeated call retain complete ordered history`, async () => {
    const inputs: Message[][] = [];
    const calls = ['Fail', 'Work', 'Work'].map((name, index) => ({
      id: `other-${index}`,
      name,
      arguments: { sentinel: index ? 'WORK' : 'FAIL' },
    }));
    const llm: ILlm = {
      async chat(messages) {
        inputs.push(structuredClone(messages));
        assert.ok(inputs.length <= 2);
        return {
          ok: true,
          value:
            inputs.length === 1
              ? {
                  content: 'OTHER_LOOP_ASSISTANT',
                  toolCalls: calls,
                  finishReason: 'tool_calls',
                }
              : { content: 'DONE', finishReason: 'stop' },
        };
      },
      async *streamChat() {},
    };
    const tools = ['Fail', 'Work'].map((name) => ({
      name,
      description: '',
      inputSchema: {},
    }));
    const callTool = async (name: string) => {
      if (name === 'Fail') {
        return 'Error: TOOL_FAILURE_SENTINEL';
      }
      return 'WORK_RESULT';
    };
    if (loop === 'self') {
      const options = testCallOptions();
      const ctx: ICoordinatorContext = {
        caller: options.caller,
        sessionId: options.sessionId,
        inputText: 'work',
        registry: new Map(),
        stepResults: {},
        selectedTools: tools,
        callTool,
      };
      const result = await new SelfDispatch(llm).dispatch(
        { id: 's1', goal: 'work', status: 'pending' },
        ctx,
      );
      assert.equal(result.ok, true);
    } else {
      const result = await new CyclicReActExecutor({
        llm,
        callMcp: callTool,
        component: 'tool-loop',
      }).execute({
        prompt: 'work',
        tools,
        toolsRag: {
          query: async () => tools,
          lookup: (name) => tools.find((tool) => tool.name === name),
        },
        knowledgeRag: {
          query: async () => [],
          list: async () => [],
          write: async () => {},
          fingerprint: () => 'empty',
        },
        budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
        identity: {
          traceId: 't',
          turnId: 'u',
          sessionId: 's',
          stepperId: 'n1',
        },
      });
      assert.equal(result.status, 'ok');
    }
    const messages = inputs[1].filter(
      (message) => message.role === 'assistant' || message.role === 'tool',
    );
    assert.equal(messages.length, 4);
    assertUniqueToolHistory(messages);
    const recordedCalls = messages[0].tool_calls ?? [];
    assert.deepEqual(messages[0], {
      role: 'assistant',
      content: 'OTHER_LOOP_ASSISTANT',
      tool_calls: calls.map((call, index) => ({
        id: recordedCalls[index].id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    });
    assert.deepEqual(
      messages.slice(1).map((message) => message.tool_call_id),
      recordedCalls.map((call) => call.id),
    );
    assert.match(String(messages[1].content), /TOOL_FAILURE_SENTINEL/);
    assert.equal(messages[2].content, 'WORK_RESULT');
    if (loop === 'self') assert.equal(messages[3].content, 'WORK_RESULT');
    else
      assert.match(
        String(messages[3].content),
        /Error: not executed:.*Already retrieved/,
      );
  });
}

test('response rounds own globally unique IDs even for duplicate or missing model IDs', () => {
  const modelCalls = ['local', 'local', '', 'remote'].map((id, index) => ({
    id,
    name: index % 2 ? 'External' : 'Internal',
    arguments: '{}',
  }));
  const snapshot = structuredClone(modelCalls);
  const history: Message[] = [];
  for (let index = 0; index < 3; index++) {
    const round = new ToolResponseRound(
      'ROUND',
      modelCalls,
      (name) => name === 'External',
    );
    for (const call of [...round.calls].reverse())
      round.resolve(call, call.name);
    const finished = round.finish();
    assert.deepEqual(
      finished.assistant.tool_calls?.map((call) => call.id),
      round.calls.map((call) => call.id),
    );
    assert.deepEqual(
      round.calls.map((call) => call.id.split(':')[0]),
      ['tc', 'ext', 'tc', 'ext'],
    );
    history.push(finished.assistant, ...finished.results);
  }
  assertUniqueToolHistory(history);
  assert.deepEqual(modelCalls, snapshot);
});
