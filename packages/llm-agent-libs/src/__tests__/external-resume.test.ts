import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildExternalResults,
  type IMcpClient,
  type Message,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { SmartAgentSubAgent } from '../subagent/smart-agent-subagent.js';
import { makeDefaultDeps, makeRag, testCallOptions } from '../testing/index.js';

import {
  assertUniqueToolHistory,
  normalizeRoundIds,
} from './tool-history-assertions.js';

const initial: Message[] = [{ role: 'user', content: 'CONTINUE' }];
const externalTools = [{ name: 'Lookup', description: '', inputSchema: {} }];
const providerAssistant: Message = {
  role: 'assistant',
  content: 'ASSISTANT',
  tool_calls: [
    {
      id: 'repeated',
      type: 'function',
      function: { name: 'Lookup', arguments: '{ "key": "NEW" }' },
    },
  ],
};

for (const pipeline of [false, true]) {
  for (const suspensions of [2, 3]) {
    for (const precedingRound of [false, true]) {
      test(`${pipeline ? 'pipeline' : 'direct'}: ${suspensions} mixed suspensions preserve every exchange across cumulative and delta resumes (preceding=${precedingRound})`, async () => {
        const runs: Message[][][] = [];
        for (const cumulative of [false, true]) {
          const inputs: Message[][] = [];
          let executions = 0;
          let mixedRounds = 0;
          let needsPrecedingRound = false;
          const client: IMcpClient = {
            async listTools() {
              return {
                ok: true,
                value: [{ name: 'Internal', description: '', inputSchema: {} }],
              };
            },
            async callTool(_name, args) {
              if (args.prior) {
                return {
                  ok: true,
                  value: {
                    content: `PRIOR_RESULT_${mixedRounds + 1}_${args.prior}`,
                  },
                };
              }
              executions++;
              return {
                ok: true,
                value: { content: `INTERNAL_RESULT_${executions}` },
              };
            },
          };
          const { deps } = makeDefaultDeps({
            assembler: new ContextAssembler(),
            mcpClients: [client],
          });
          deps.mainLlm = {
            async chat() {
              assert.fail('Streaming expected');
            },
            async *streamChat(messages) {
              inputs.push(structuredClone(messages));
              assert.ok(inputs.length <= suspensions * 2 + 4);
              if (mixedRounds < suspensions && needsPrecedingRound) {
                needsPrecedingRound = false;
                yield {
                  ok: true,
                  value: {
                    content: `PRIOR_ASSISTANT_${mixedRounds + 1}`,
                    toolCalls: [
                      {
                        index: 0,
                        id: 'local',
                        name: 'Internal',
                        arguments: '{"prior":1}',
                      },
                      {
                        index: 1,
                        id: 'remote',
                        name: 'Internal',
                        arguments: '{"prior":2}',
                      },
                    ],
                    finishReason: 'tool_calls',
                  },
                };
                return;
              }
              if (mixedRounds < suspensions) {
                mixedRounds++;
                needsPrecedingRound = precedingRound;
                yield {
                  ok: true,
                  value: {
                    content: `FULL_ASSISTANT_${mixedRounds}`,
                    // Reuse model IDs and arguments; only returned IDs identify
                    // the suspension in the client's reduced history.
                    toolCalls: [
                      {
                        index: 0,
                        id: 'local',
                        name: 'Internal',
                        arguments: '{}',
                      },
                      {
                        index: 1,
                        id: 'remote',
                        name: 'Lookup',
                        arguments: '{}',
                      },
                    ],
                    finishReason: 'tool_calls',
                  },
                };
                return;
              }
              yield {
                ok: true,
                value: { content: 'DONE', finishReason: 'stop' },
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
          const options = { ...testCallOptions(), externalTools };
          const history = structuredClone(initial);
          let response = await agent.process(history, options);
          const returnedIds = new Set<string>();
          for (let round = 1; round <= suspensions; round++) {
            assert.ok(response.ok);
            assert.equal(response.value.stopReason, 'tool_calls');
            assert.equal(response.value.toolCalls?.length, 1);
            const call = response.value.toolCalls?.[0];
            assert.ok(call);
            assert.match(call.id, /^ext:[0-9a-f-]{36}:0$/);
            assert.ok(!returnedIds.has(call.id));
            returnedIds.add(call.id);
            history.push(
              {
                role: 'assistant',
                content: response.value.content,
                tool_calls: response.value.toolCalls,
              },
              {
                role: 'tool',
                tool_call_id: call.id,
                content: `EXTERNAL_RESULT_${round}`,
              },
            );
            response = await agent.process(cumulative ? history : [], {
              ...options,
              externalResults: cumulative
                ? undefined
                : new Map([[call.id, `EXTERNAL_RESULT_${round}`]]),
            });
            const messages = inputs.at(-1);
            assert.ok(messages);
            assertUniqueToolHistory(messages);
            for (let previous = 1; previous <= round; previous++) {
              for (const content of [
                `INTERNAL_RESULT_${previous}`,
                `EXTERNAL_RESULT_${previous}`,
                ...(precedingRound && previous > 1
                  ? [`PRIOR_RESULT_${previous}_1`, `PRIOR_RESULT_${previous}_2`]
                  : []),
              ]) {
                assert.equal(
                  messages.filter((message) => message.content === content)
                    .length,
                  1,
                  content,
                );
              }
              for (const assistantContent of [
                `FULL_ASSISTANT_${previous}`,
                ...(precedingRound && previous > 1
                  ? [`PRIOR_ASSISTANT_${previous}`]
                  : []),
              ]) {
                assert.equal(
                  messages.filter(
                    (message) =>
                      message.role === 'assistant' &&
                      message.content === assistantContent,
                  ).length,
                  1,
                  assistantContent,
                );
              }
              const index = messages.findIndex(
                (message) =>
                  message.role === 'assistant' &&
                  message.content === `FULL_ASSISTANT_${previous}`,
              );
              assert.ok(index >= 0);
              assert.deepEqual(
                messages[index].tool_calls?.map((tool) => tool.function.name),
                ['Internal', 'Lookup'],
              );
              assert.deepEqual(messages.slice(index + 1, index + 3), [
                {
                  role: 'tool',
                  tool_call_id: messages[index].tool_calls?.[0].id,
                  content: `INTERNAL_RESULT_${previous}`,
                },
                {
                  role: 'tool',
                  tool_call_id: messages[index].tool_calls?.[1].id,
                  content: `EXTERNAL_RESULT_${previous}`,
                },
              ]);
            }
          }
          assert.ok(response.ok);
          assert.equal(response.value.content, 'DONE');
          assert.equal(executions, suspensions);
          runs.push(structuredClone(inputs));

          // A foreign session sees only the supplied client history, including
          // when it knows every returned ID from the original session.
          const foreign = await agent.process(history, {
            ...testCallOptions(),
            externalTools,
          });
          assert.ok(foreign.ok);
          assert.ok(
            !inputs
              .at(-1)
              ?.some((message) =>
                message.content?.startsWith('INTERNAL_RESULT_'),
              ),
          );
          // Completed exchanges must still expand after the pending entry has
          // been consumed, and the foreign request must not remove them.
          const replay = await agent.process(history, options);
          assert.ok(replay.ok);
          assert.deepEqual(inputs.at(-1), runs.at(-1)?.at(-1));
        }
        assert.deepEqual(
          normalizeRoundIds(runs[0]),
          normalizeRoundIds(runs[1]),
        );
      });
    }
  }
}

for (const pipeline of [false, true]) {
  for (const historyRecencyWindow of [undefined, 1, 3, 5]) {
    for (const precedingRound of [false, true]) {
      test(`${pipeline ? 'pipeline' : 'direct'}: mixed cumulative and delta resume share assembled context (window=${historyRecencyWindow}, preceding=${precedingRound})`, async () => {
        const resumed: Message[][] = [];
        for (const cumulative of [false, true]) {
          const inputs: Message[][] = [];
          let executions = 0;
          const client: IMcpClient = {
            async listTools() {
              return {
                ok: true,
                value: [{ name: 'Internal', description: '', inputSchema: {} }],
              };
            },
            async callTool(_name, args) {
              executions++;
              return {
                ok: true,
                value: {
                  content: args.prior
                    ? 'PRIOR_RESULT'
                    : 'INTERNAL_RESULT_SENTINEL',
                },
              };
            },
          };
          const { deps } = makeDefaultDeps({
            assembler: new ContextAssembler({
              systemPromptPreamble: 'HOST_PREAMBLE_SENTINEL',
              historyRecencyWindow,
            }),
            mcpClients: [client],
            ragStores: {
              facts: makeRag([
                {
                  text: 'RAG_CONTEXT_SENTINEL',
                  score: 1,
                  metadata: {},
                },
              ]),
            },
          });
          deps.mainLlm = {
            async chat() {
              assert.fail('Streaming expected');
            },
            async *streamChat(messages) {
              inputs.push(structuredClone(messages));
              assert.ok(inputs.length <= (precedingRound ? 3 : 2));
              if (precedingRound && inputs.length === 1) {
                yield {
                  ok: true,
                  value: {
                    content: '',
                    toolCalls: [
                      {
                        index: 0,
                        id: 'prior',
                        name: 'Internal',
                        arguments: '{"prior":true}',
                      },
                    ],
                    finishReason: 'tool_calls',
                  },
                };
                return;
              }
              yield {
                ok: true,
                value:
                  inputs.length === (precedingRound ? 2 : 1)
                    ? {
                        content: 'FULL_ASSISTANT_TEXT',
                        toolCalls: [
                          {
                            index: 0,
                            id: 'internal',
                            name: 'Internal',
                            arguments: '{}',
                          },
                          {
                            index: 1,
                            id: 'external',
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
          const config = { refreshToolsPerIteration: false };
          if (pipeline) {
            const flow = new DefaultPipeline();
            flow.initialize({ ...deps, agentConfig: config });
            deps.pipeline = flow;
          }
          const agent = new SmartAgent(deps, config);
          const history: Message[] = [
            { role: 'user', content: 'OLD_HISTORY_SENTINEL' },
            {
              role: 'assistant',
              content: 'OLD_ANSWER_SENTINEL',
              ...(precedingRound
                ? {
                    tool_calls: [
                      {
                        id: 'prior',
                        type: 'function' as const,
                        function: { name: 'Internal', arguments: '{}' },
                      },
                    ],
                  }
                : {}),
            },
            ...(precedingRound
              ? [
                  {
                    role: 'tool' as const,
                    tool_call_id: 'prior',
                    content: 'OLD_INTERNAL_RESULT',
                  },
                ]
              : []),
            { role: 'user', content: 'REQUEST' },
          ];
          const options = { ...testCallOptions(), externalTools };
          const suspended = await agent.process(history, options);
          assert.ok(suspended.ok);
          assert.equal(suspended.value.stopReason, 'tool_calls');
          assert.equal(suspended.value.toolCalls?.length, 1);
          const call = suspended.value.toolCalls?.[0];
          assert.ok(call);
          const tail: Message[] = [
            { role: 'user', content: 'NEXT_INSTRUCTION' },
          ];
          const input: Message[] = cumulative
            ? [
                ...history,
                {
                  role: 'assistant',
                  content: suspended.value.content,
                  tool_calls: suspended.value.toolCalls,
                },
                {
                  role: 'tool',
                  tool_call_id: call.id,
                  content: 'EXTERNAL_RESULT_SENTINEL',
                },
                ...tail,
              ]
            : tail;
          const result = await agent.process(input, {
            ...options,
            // Exercise input-only results for cumulative and map-only for delta.
            externalResults: cumulative
              ? undefined
              : new Map([[call.id, 'EXTERNAL_RESULT_SENTINEL']]),
          });
          assert.ok(result.ok);
          assert.equal(result.value.content, 'DONE');
          assert.equal(executions, precedingRound ? 2 : 1);
          const messages = inputs.at(-1);
          assert.ok(messages);
          resumed.push(messages);
          for (const sentinel of [
            'INTERNAL_RESULT_SENTINEL',
            'EXTERNAL_RESULT_SENTINEL',
            'HOST_PREAMBLE_SENTINEL',
            'RAG_CONTEXT_SENTINEL',
          ]) {
            assert.equal(
              JSON.stringify(messages).split(sentinel).length - 1,
              1,
              sentinel,
            );
          }
          const assistantIndex = messages.findIndex(
            (message) =>
              message.role === 'assistant' &&
              message.content === 'FULL_ASSISTANT_TEXT',
          );
          const recordedCalls = messages[assistantIndex].tool_calls;
          assert.ok(recordedCalls);
          assert.deepEqual(
            recordedCalls.map((tool) => tool.function.name),
            ['Internal', 'Lookup'],
          );
          assert.match(recordedCalls[0].id, /^tc:[0-9a-f-]{36}:0$/);
          assert.equal(recordedCalls[1].id, call.id);
          assert.equal(messages[assistantIndex].content, 'FULL_ASSISTANT_TEXT');
          assert.deepEqual(
            messages.slice(assistantIndex + 1, assistantIndex + 3),
            [
              {
                role: 'tool',
                tool_call_id: recordedCalls[0].id,
                content: 'INTERNAL_RESULT_SENTINEL',
              },
              {
                role: 'tool',
                tool_call_id: recordedCalls[1].id,
                content: 'EXTERNAL_RESULT_SENTINEL',
              },
            ],
          );
          assert.ok(messages.at(-1)?.content?.endsWith('NEXT_INSTRUCTION'));
          if (historyRecencyWindow === 1) {
            assert.ok(
              !JSON.stringify(messages).includes('OLD_HISTORY_SENTINEL'),
            );
            assert.ok(
              !JSON.stringify(messages).includes('OLD_ANSWER_SENTINEL'),
            );
            assert.ok(
              !messages.some((message) => message.content === 'REQUEST'),
            );
          }
          if (precedingRound && historyRecencyWindow === undefined) {
            assert.equal(
              messages.filter((message) => message.content === 'PRIOR_RESULT')
                .length,
              1,
            );
          }
        }
        assert.deepEqual(
          normalizeRoundIds(resumed[0]),
          normalizeRoundIds(resumed[1]),
        );
      });
    }
  }
}

async function fixture(
  pipeline: boolean | 'pass',
  history: Message[] = initial,
  historyRecencyWindow?: number,
  callCount = 1,
) {
  const inputs: Message[][] = [];
  const { deps } = makeDefaultDeps({
    assembler: new ContextAssembler({ historyRecencyWindow }),
  });
  deps.mainLlm = {
    async chat() {
      assert.fail('Streaming expected');
    },
    async *streamChat(messages) {
      inputs.push(messages);
      assert.ok(inputs.length <= 2);
      yield {
        ok: true,
        value:
          inputs.length === 1
            ? {
                content: 'ASSISTANT',
                toolCalls: Array.from({ length: callCount }, (_, index) => ({
                  index,
                  id: index === 0 ? 'repeated' : `model-${index}`,
                  name: 'Lookup',
                  arguments: '{ "key": "NEW" }',
                })),
                finishReason: 'tool_calls',
              }
            : { content: 'DONE', finishReason: 'stop' },
      };
    },
  };
  const config = {
    refreshToolsPerIteration: false,
    mode: pipeline === 'pass' ? ('pass' as const) : undefined,
  };
  if (pipeline === true) {
    const flow = new DefaultPipeline();
    flow.initialize({ ...deps, agentConfig: config });
    deps.pipeline = flow;
  }
  const agent = new SmartAgent(deps, config);
  const options = { ...testCallOptions(), externalTools };
  const first = await agent.process(history, options);
  assert.ok(first.ok);
  assert.equal(first.value.stopReason, 'tool_calls');
  assert.equal(first.value.toolCalls?.length, callCount);
  const returnedAssistant: Message = {
    role: 'assistant',
    content: first.value.content,
    tool_calls: first.value.toolCalls,
  };
  const ids = (returnedAssistant.tool_calls ?? []).map((call) => call.id);
  assert.equal(new Set(ids).size, callCount);
  for (const [index, id] of ids.entries()) {
    assert.match(id, new RegExp(`^ext:[0-9a-f-]{36}:${index}$`));
    assert.notEqual(id, 'repeated');
  }
  const template = providerAssistant.tool_calls?.[0];
  assert.ok(template);
  return {
    inputs,
    returnedAssistant,
    recordedAssistant: {
      ...providerAssistant,
      tool_calls: ids.map((id) => ({
        ...template,
        id,
      })),
    },
    ids,
    async resume(
      messages: string | Message[],
      externalResults = new Map(ids.map((id) => [id, 'NEW_RESULT'])),
    ) {
      const result = await agent.process(messages, {
        ...options,
        externalResults,
      });
      assert.ok(result.ok);
      assert.equal(inputs.length, 2);
      assert.ok(
        inputs[1].every(
          (message) =>
            !message.content?.includes('external tool result was not provided'),
        ),
      );
      return inputs[1];
    },
  };
}

for (const pipeline of [false, true, 'pass'] as const) {
  const label = pipeline === 'pass' ? 'pass' : pipeline ? 'pipeline' : 'direct';
  test(`${label}: streamed external calls never expose provider IDs or partial arguments`, async () => {
    const { deps } = makeDefaultDeps();
    deps.mainLlm = {
      async chat() {
        assert.fail('Streaming expected');
      },
      async *streamChat() {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              {
                index: 0,
                id: 'MODEL_ID',
                name: 'Lookup',
                arguments: '{"key":',
              },
            ],
          },
        };
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [{ index: 0, arguments: '"NEW"}' }],
            finishReason: 'tool_calls',
          },
        };
      },
    };
    const config = {
      refreshToolsPerIteration: false,
      mode: pipeline === 'pass' ? ('pass' as const) : undefined,
    };
    if (pipeline === true) {
      const flow = new DefaultPipeline();
      flow.initialize({ ...deps, agentConfig: config });
      deps.pipeline = flow;
    }
    const agent = new SmartAgent(deps, config);
    let returnedCalls = 0;
    for await (const chunk of agent.streamProcess(initial, {
      ...testCallOptions(),
      externalTools,
    })) {
      assert.ok(chunk.ok);
      for (const call of chunk.value.toolCalls ?? []) {
        returnedCalls++;
        assert.match(call.id ?? '', /^ext:[0-9a-f-]{36}:0$/);
        assert.equal(call.arguments, '{"key":"NEW"}');
      }
    }
    assert.equal(returnedCalls, 1);
  });

  test(`${label}: delta retains conversation messages through assembly, even an exact stored prefix`, async () => {
    const run = await fixture(pipeline);
    const delta: Message[] = [
      ...initial,
      { role: 'assistant', content: 'NEW_CONTROL' },
      { role: 'user', content: 'NEW_INSTRUCTION' },
      { role: 'system', content: 'NEW_SYSTEM' },
    ];
    assert.deepEqual(await run.resume(delta), [
      ...run.inputs[0],
      run.recordedAssistant,
      { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
      ...delta.filter(
        (message) => pipeline === 'pass' || message.role !== 'system',
      ),
    ]);
  });

  test(`${label}: delta repeating the string CONTINUE reaches the model`, async () => {
    const run = await fixture(pipeline);
    const messages = await run.resume('CONTINUE');
    assert.equal(messages.at(-1)?.role, 'user');
    assert.ok(messages.at(-1)?.content?.endsWith('CONTINUE'));
    assert.equal(
      messages.filter((message) => message.content?.endsWith('CONTINUE'))
        .length,
      2,
    );
  });

  for (const window of [undefined, 1]) {
    test(`${label}: cumulative uses assembled context and the stored assistant (window=${window})`, async () => {
      const run = await fixture(pipeline, initial, window);
      const cumulative: Message[] = [
        { role: 'system', content: 'CHANGED_SYSTEM' },
        ...initial,
        run.returnedAssistant,
        { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
        { role: 'user', content: 'NEXT' },
      ];
      const { results, sanitizedMessages } = buildExternalResults(cumulative);
      assert.equal(results.get(run.ids[0]), 'NEW_RESULT');
      const messages = await run.resume(sanitizedMessages, results);
      assert.deepEqual(
        messages.filter((message) => message.role !== 'system'),
        [
          ...(window === 1 && pipeline !== 'pass' ? [] : initial),
          run.recordedAssistant,
          { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
          { role: 'user', content: 'NEXT' },
        ],
      );
      assert.ok(
        messages[0].content?.includes(
          pipeline === 'pass' ? 'CHANGED_SYSTEM' : 'Use available tools',
        ),
      );
      assert.equal(
        messages.filter((message) => message.role === 'assistant').length,
        1,
      );
      assert.equal(
        messages.filter((message) => message.role === 'tool').length,
        1,
      );
    });
  }

  test(`${label}: cumulative restores results once in stored call order`, async () => {
    const run = await fixture(pipeline, initial, undefined, 3);
    const provided: Message = {
      role: 'tool',
      tool_call_id: run.ids[1],
      content: 'INPUT_RESULT',
    };
    const next: Message = { role: 'user', content: 'NEXT' };
    const cumulative: Message[] = [
      ...initial,
      run.returnedAssistant,
      provided,
      next,
    ];
    assert.deepEqual(
      (await run.resume(cumulative)).filter(
        (message) => message.role !== 'system',
      ),
      [
        ...initial,
        {
          ...providerAssistant,
          tool_calls: Array.from({ length: 3 }, (_, index) => ({
            ...providerAssistant.tool_calls?.[0],
            id: run.ids[index],
            type: 'function' as const,
            function: { name: 'Lookup', arguments: '{ "key": "NEW" }' },
          })),
        },
        { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
        { role: 'tool', tool_call_id: run.ids[1], content: 'INPUT_RESULT' },
        { role: 'tool', tool_call_id: run.ids[2], content: 'NEW_RESULT' },
        next,
      ],
    );
    assert.equal(cumulative.length, 4);
  });

  test(`${label}: identical model assistants with changed system use NEW_RESULT and retain OLD once`, async () => {
    const old = await fixture(pipeline);
    const history: Message[] = [
      { role: 'system', content: 'ORIGINAL_SYSTEM' },
      ...initial,
      old.returnedAssistant,
      { role: 'tool', tool_call_id: old.ids[0], content: 'OLD_RESULT' },
      { role: 'user', content: 'CONTINUE' },
    ];
    const run = await fixture(pipeline, history);
    assert.notEqual(run.ids[0], old.ids[0]);
    assert.equal(run.returnedAssistant.content, old.returnedAssistant.content);
    assert.deepEqual(
      run.returnedAssistant.tool_calls?.map((call) => call.function),
      old.returnedAssistant.tool_calls?.map((call) => call.function),
    );
    const cumulative: Message[] = [
      { role: 'system', content: 'CHANGED_SYSTEM' },
      ...history.slice(1),
      run.returnedAssistant,
      { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
    ];
    const { results } = buildExternalResults(cumulative);
    const messages = await run.resume(cumulative, results);
    assert.deepEqual(
      messages.filter((message) => message.role !== 'system'),
      [
        ...history.slice(1),
        run.recordedAssistant,
        { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
      ],
    );
    assert.equal(
      messages.filter((message) => message.content === 'OLD_RESULT').length,
      1,
    );
    assert.equal(
      messages.filter((message) => message.content === 'NEW_RESULT').length,
      1,
    );
  });

  test(`${label}: an identical old model assistant is a delta without returned pending IDs`, async () => {
    const old: Message[] = [
      providerAssistant,
      { role: 'tool', tool_call_id: 'repeated', content: 'OLD_RESULT' },
    ];
    const run = await fixture(pipeline, [
      { role: 'system', content: 'ORIGINAL_SYSTEM' },
      ...initial,
    ]);
    const delta: Message[] = [
      { role: 'system', content: 'CHANGED_SYSTEM' },
      ...old,
    ];
    assert.deepEqual(await run.resume(delta), [
      ...run.inputs[0],
      run.recordedAssistant,
      { role: 'tool', tool_call_id: run.ids[0], content: 'NEW_RESULT' },
      ...delta.filter(
        (message) => pipeline === 'pass' || message.role !== 'system',
      ),
    ]);
  });
}

for (const pipeline of [false, true, 'pass'] as const) {
  for (const cumulative of [false, true]) {
    test(`wrapper ${pipeline}: repeated calls resume by returned ID (cumulative=${cumulative})`, async () => {
      const inputs: Message[][] = [];
      const { deps } = makeDefaultDeps({ assembler: new ContextAssembler() });
      deps.mainLlm = {
        async chat() {
          assert.fail('Streaming expected');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          assert.ok(inputs.length <= 3);
          yield {
            ok: true,
            value:
              inputs.length <= 2
                ? {
                    content: 'SAME_ASSISTANT',
                    toolCalls: [
                      {
                        index: 0,
                        id: 'same-model-id',
                        name: 'Lookup',
                        arguments: '{"key":"SAME"}',
                      },
                    ],
                    finishReason: 'tool_calls',
                  }
                : { content: 'DONE', finishReason: 'stop' },
          };
        },
      };
      const config = {
        refreshToolsPerIteration: false,
        mode: pipeline === 'pass' ? ('pass' as const) : undefined,
      };
      if (pipeline === true) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const sub = new SmartAgentSubAgent(
        'worker',
        new SmartAgent(deps, config),
      );
      const input = {
        task: 'work',
        caller: testCallOptions().caller,
        externalTools,
      };
      let history: Message[] = [{ role: 'user', content: 'work' }];
      const results = new Map<string, string>();
      const ids: string[] = [];
      for (const resultText of ['OLD_RESULT', 'NEW_RESULT']) {
        const suspended = await sub.run({
          ...input,
          ...(cumulative ? { history } : {}),
          externalResults: results,
        });
        assert.equal(suspended.status, 'awaiting-external');
        const call = suspended.pendingExternalToolCalls?.[0];
        assert.ok(call);
        assert.match(call.id, /^ext:[0-9a-f-]{36}:0$/);
        assert.ok(!ids.includes(call.id));
        ids.push(call.id);
        results.set(call.id, resultText);
        history = [
          ...history,
          {
            role: 'assistant',
            content: 'SAME_ASSISTANT',
            tool_calls: [
              {
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: call.id, content: resultText },
        ];
      }
      const completed = await sub.run({
        ...input,
        ...(cumulative ? { history } : {}),
        externalResults: results,
      });
      assert.equal(completed.status, 'complete');
      assert.equal(inputs.length, 3);
      assert.equal(
        inputs[1].filter((message) => message.content === 'OLD_RESULT').length,
        1,
      );
      assert.equal(
        inputs[2].filter((message) => message.content === 'OLD_RESULT').length,
        1,
      );
      assert.equal(
        inputs[2].filter((message) => message.content === 'NEW_RESULT').length,
        1,
      );
      assert.ok(
        inputs[2].every(
          (message) =>
            !message.content?.includes('external tool result was not provided'),
        ),
      );
    });
  }
}
