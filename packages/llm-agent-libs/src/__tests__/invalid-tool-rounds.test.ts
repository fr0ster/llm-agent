import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ICoordinatorContext,
  ILlm,
  LlmFinishReason,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { TokenLedger } from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../adapters/llm-adapter.js';
import { LlmProviderBridge } from '../adapters/llm-provider-bridge.js';
import { NonStreamingLlm } from '../adapters/non-streaming-llm.js';
import { SmartAgent } from '../agent.js';
import { SelfDispatch } from '../coordinator/dispatch/self.js';
import { CyclicReActExecutor } from '../coordinator/stepper/cyclic-react-executor.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { ToolResponseRound } from '../pipeline/handlers/tool-response-round.js';
import { clearCallerSessionEntries } from '../policy/caller-identity.js';
import {
  makeAssembler,
  makeDefaultDeps,
  makeMcpClient,
  testCallOptions,
} from '../testing/index.js';
import { assertUniqueToolHistory } from './tool-history-assertions.js';

const tool = { name: 'Work', description: '', inputSchema: {} };
const incomplete = '{"target":"incomplete';

for (const mode of ['direct', 'pipeline', 'pass'] as const) {
  for (const finishReason of ['length', 'stop', 'tool_calls'] as const) {
    test(`${mode}: ${finishReason} with incomplete JSON never executes or surfaces the call`, async () => {
      const inputs: Message[][] = [];
      const logs: string[] = [];
      let executions = 0;
      const { deps } = makeDefaultDeps({
        assembler: makeAssembler([{ role: 'user', content: 'go' }]),
        mcpClients:
          mode === 'pass'
            ? []
            : [
                {
                  async listTools() {
                    return { ok: true, value: [tool] };
                  },
                  async callTool() {
                    executions++;
                    return { ok: true, value: { content: 'BAD' } };
                  },
                },
              ],
      });
      deps.mainLlm = {
        async chat() {
          assert.fail('stream expected');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          assert.ok(inputs.length <= 2);
          yield {
            ok: true,
            value:
              inputs.length === 1
                ? {
                    content: 'PARTIAL',
                    finishReason,
                    toolCalls: [
                      { index: 0, name: tool.name, arguments: incomplete },
                    ],
                  }
                : { content: 'DONE', finishReason: 'stop' },
          };
        },
      };
      const config = {
        refreshToolsPerIteration: false,
        streamMode: 'final' as const,
      };
      if (mode === 'pipeline') {
        const pipeline = new DefaultPipeline();
        pipeline.initialize({ ...deps, agentConfig: config });
        deps.pipeline = pipeline;
      }
      const result = await new SmartAgent(deps, config).process('go', {
        ...testCallOptions(),
        externalTools: mode === 'pass' ? [tool] : undefined,
        sessionLogger: {
          logStep(name, data) {
            if (name.startsWith('llm_response_'))
              logs.push(JSON.stringify(data));
          },
        },
      });
      assert.equal(executions, 0);
      if (finishReason === 'length') {
        assert.equal(inputs.length, 1);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'LLM_OUTPUT_TRUNCATED');
        return;
      }
      assert.ok(result.ok);
      assert.equal(result.value.toolCalls?.length ?? 0, 0);
      if (finishReason !== 'tool_calls') {
        assert.equal(inputs.length, 1);
        assert.equal(result.value.content, 'PARTIAL');
        assert.equal(result.value.stopReason, 'stop');
      } else {
        assert.equal(inputs.length, 2);
        const diagnostic = logs[0] ?? '';
        assert.match(diagnostic, /"receivedToolCalls":\[\{/);
        assert.match(diagnostic, /"rejectedToolCalls":\[\{.*"name":"Work"/);
        assert.match(
          diagnostic,
          new RegExp(`"argumentLength":${incomplete.length}`),
        );
        assert.match(diagnostic, /Invalid tool arguments/);
        assert.match(diagnostic, /"executableToolCalls":\[\]/);
        assert.doesNotMatch(diagnostic, /incomplete/);
        const assistant = inputs[1].find(
          (message) => message.tool_calls?.length,
        );
        assert.equal(assistant?.content, 'PARTIAL');
        assert.equal(assistant?.tool_calls?.[0].function.arguments, incomplete);
        assert.match(JSON.stringify(inputs[1]), /Invalid tool arguments/);
        assertUniqueToolHistory(inputs[1]);
      }
    });
  }
}

test('a token-limit finish without text or tool calls fails explicitly', async () => {
  const { deps } = makeDefaultDeps({
    llmResponses: [{ content: '', finishReason: 'length' }],
  });
  const result = await new SmartAgent(deps, {}).process(
    'go',
    testCallOptions(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'LLM_OUTPUT_TRUNCATED');
});

for (const mode of ['direct', 'pipeline'] as const) {
  test(`${mode}: truncation stops before an output validator can request a retry`, async () => {
    let validations = 0;
    const { deps, llm } = makeDefaultDeps({
      mcpClients: [makeMcpClient([tool])],
      llmResponses: [
        { content: 'PARTIAL', finishReason: 'length' },
        { content: 'DONE', finishReason: 'stop' },
      ],
      outputValidator: {
        async validate(content) {
          validations++;
          return {
            ok: true,
            value: { valid: content !== 'PARTIAL', reason: 'retry' },
          };
        },
      },
    });
    const config = { refreshToolsPerIteration: false };
    if (mode === 'pipeline') {
      const pipeline = new DefaultPipeline();
      pipeline.initialize({ ...deps, agentConfig: config });
      deps.pipeline = pipeline;
    }
    const result = await new SmartAgent(deps, config).process(
      'go',
      testCallOptions(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'LLM_OUTPUT_TRUNCATED');
    assert.equal(llm.callCount, 1);
    assert.equal(validations, 0);
  });
}

for (const loop of ['self', 'cyclic'] as const) {
  for (const finishReason of ['length', 'stop', 'tool_calls'] as const) {
    test(`${loop}: adapter preserves ${finishReason} and rejects incomplete JSON`, async () => {
      const inputs: Message[][] = [];
      const llm: ILlm = new LlmAdapter({
        async callWithTools(messages) {
          inputs.push(structuredClone(messages));
          assert.ok(inputs.length <= 2);
          return {
            content: inputs.length === 1 ? 'PARTIAL' : 'DONE',
            raw: {
              choices: [
                {
                  finish_reason: inputs.length === 1 ? finishReason : 'stop',
                  message: {
                    tool_calls:
                      inputs.length === 1
                        ? [
                            {
                              id: 'provider-id',
                              function: {
                                name: tool.name,
                                arguments: incomplete,
                              },
                            },
                          ]
                        : [],
                  },
                },
              ],
            },
          };
        },
        streamWithTools() {
          assert.fail('chat expected');
        },
      });
      const callTool = async () => {
        assert.fail('incomplete arguments must never execute');
      };
      if (loop === 'self') {
        const ctx: ICoordinatorContext = {
          ...testCallOptions(),
          inputText: 'work',
          registry: new Map(),
          stepResults: {},
          selectedTools: [tool],
          callTool,
        };
        const result = await new SelfDispatch(llm).dispatch(
          { id: 's1', goal: 'work', status: 'pending' },
          ctx,
        );
        if (finishReason === 'length') {
          assert.equal(result.ok, false);
          assert.equal(result.terminalError?.code, 'LLM_OUTPUT_TRUNCATED');
          assert.match(result.error ?? '', /truncated/);
        } else {
          assert.equal(result.ok, true);
          assert.equal(
            result.output,
            finishReason === 'tool_calls' ? 'DONE' : 'PARTIAL',
          );
          assert.equal(result.toolCallCount, 0);
        }
      } else {
        const result = new CyclicReActExecutor({
          llm,
          callMcp: callTool,
          component: 'tool-loop',
        }).execute({
          prompt: 'work',
          tools: [tool],
          toolsRag: { query: async () => [tool], lookup: () => tool },
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
        if (finishReason === 'length') {
          await assert.rejects(result, { code: 'LLM_OUTPUT_TRUNCATED' });
        } else {
          assert.equal((await result).status, 'ok');
        }
      }
      assert.equal(inputs.length, finishReason === 'tool_calls' ? 2 : 1);
      if (finishReason === 'tool_calls') {
        assert.match(JSON.stringify(inputs[1]), /Invalid tool arguments/);
        assertUniqueToolHistory(inputs[1]);
        assert.equal(
          inputs[1].find((message) => message.tool_calls?.length)
            ?.tool_calls?.[0].function.arguments,
          incomplete,
        );
      }
    });
  }
}

for (const finishReason of [
  'length',
  'tool_calls',
] satisfies LlmFinishReason[]) {
  test(`provider bridge retains incomplete arguments through ${finishReason}`, async () => {
    const llm = new LlmAdapter(
      new LlmProviderBridge({
        async chat() {
          assert.fail('stream expected');
        },
        async *streamChat() {
          yield {
            content: 'PARTIAL',
            toolCalls: [
              { index: 0, id: 'call', name: 'Work', arguments: incomplete },
            ],
          };
          yield { content: '', finishReason };
        },
      }),
    );
    const chunks = [];
    for await (const chunk of llm.streamChat([])) {
      assert.ok(chunk.ok);
      chunks.push(chunk.value);
    }
    const call = chunks.flatMap((chunk) => chunk.toolCalls ?? [])[0];
    assert.ok(call && 'rawArguments' in call);
    assert.equal(call.rawArguments, incomplete);
    assert.equal(chunks.at(-1)?.finishReason, finishReason);
  });
}

for (const mode of ['direct', 'pipeline'] as const) {
  for (const transport of ['bridge', 'non-streaming'] as const) {
    test(`${mode}: ${transport} preserves malformed JSON through full-call stream conversion`, async () => {
      const inputs: Message[][] = [];
      const raw = '{"target":"incomplete';
      const { deps } = makeDefaultDeps({
        assembler: makeAssembler([{ role: 'user', content: 'go' }]),
        mcpClients: [
          {
            async listTools() {
              return { ok: true, value: [tool] };
            },
            async callTool() {
              assert.fail('malformed calls must never execute');
            },
          },
        ],
      });
      const adapter = new LlmAdapter(
        transport === 'bridge'
          ? new LlmProviderBridge({
              async chat() {
                assert.fail('stream expected');
              },
              async *streamChat(messages) {
                inputs.push(structuredClone(messages));
                assert.ok(inputs.length <= 2);
                yield inputs.length === 1
                  ? {
                      content: 'MALFORMED',
                      toolCalls: [
                        {
                          index: 0,
                          id: 'provider',
                          name: 'Work',
                          arguments: raw,
                        },
                      ],
                      finishReason: 'tool_calls',
                    }
                  : { content: 'DONE', finishReason: 'stop' };
              },
            })
          : {
              async callWithTools(messages) {
                inputs.push(structuredClone(messages));
                assert.ok(inputs.length <= 2);
                return {
                  content: inputs.length === 1 ? 'MALFORMED' : 'DONE',
                  raw: {
                    choices: [
                      {
                        finish_reason:
                          inputs.length === 1 ? 'tool_calls' : 'stop',
                        message: {
                          tool_calls:
                            inputs.length === 1
                              ? [
                                  {
                                    id: 'provider',
                                    function: { name: 'Work', arguments: raw },
                                  },
                                ]
                              : [],
                        },
                      },
                    ],
                  },
                };
              },
              streamWithTools() {
                assert.fail('chat expected');
              },
            },
      );
      deps.mainLlm =
        transport === 'bridge' ? adapter : new NonStreamingLlm(adapter);
      const config = { refreshToolsPerIteration: false };
      if (mode === 'pipeline') {
        const pipeline = new DefaultPipeline();
        pipeline.initialize({ ...deps, agentConfig: config });
        deps.pipeline = pipeline;
      }
      assert.ok(
        (await new SmartAgent(deps, config).process('go', testCallOptions()))
          .ok,
      );
      assert.equal(inputs.length, 2);
      assert.equal(
        inputs[1].find((message) => message.tool_calls?.length)?.tool_calls?.[0]
          .function.arguments,
        raw,
      );
      assert.match(JSON.stringify(inputs[1]), /Invalid tool arguments/);
      assertUniqueToolHistory(inputs[1]);
    });
  }
}

test('caller cleanup validates JSON tuples and preserves malformed and unrelated keys', () => {
  const session = 's:["quoted"]';
  const removed = [
    session,
    JSON.stringify(['alice', session]),
    JSON.stringify(['bob', session]),
  ];
  const kept = [
    'null',
    '42',
    'true',
    '{}',
    '"s"',
    '[]',
    '["s"]',
    JSON.stringify([null, session]),
    JSON.stringify([1, session]),
    JSON.stringify(['a', session, 3]),
    '{broken',
    JSON.stringify(['alice', `${session}:other`]),
    JSON.stringify({ 0: 'alice', 1: session, length: 2 }),
  ];
  const entries = new Map([...removed, ...kept].map((key) => [key, 1]));
  clearCallerSessionEntries(entries, session);
  assert.deepEqual([...entries.keys()], kept);
});

test('argument validation distinguishes empty objects from malformed JSON and other JSON values', () => {
  const raw = [
    incomplete,
    '',
    'null',
    '[]',
    '"text"',
    '1',
    'true',
    '{}',
    '{"target":"complete"}',
  ];
  const round = new ToolResponseRound(
    'ARGS',
    raw.map((argumentsJson) => ({ name: 'Work', arguments: argumentsJson })),
  );
  const executable = round.executableCalls();
  assert.deepEqual(
    executable.map((call) => call.arguments),
    [{}, { target: 'complete' }],
  );
  for (const call of executable) round.resolve(call, 'RESULT');
  const complete = round.finish();
  assert.deepEqual(
    complete.meta?.map((meta) => meta.isError),
    [true, true, true, true, true, true, true, false, false],
  );
  assert.deepEqual(
    complete.assistant.tool_calls?.map((call) => call.function.arguments),
    raw,
  );
  assertUniqueToolHistory([complete.assistant, ...complete.results]);
});

for (const mode of ['direct', 'pipeline', 'pass'] as const) {
  test(`${mode}: mixed valid and malformed calls retain errors across external continuation`, async () => {
    const inputs: Message[][] = [];
    let executions = 0;
    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([{ role: 'user', content: 'go' }]),
      mcpClients:
        mode === 'pass'
          ? []
          : [
              {
                async listTools() {
                  return { ok: true, value: [tool] };
                },
                async callTool(_name, args) {
                  assert.deepEqual(args, { target: 'valid' });
                  executions++;
                  return { ok: true, value: { content: 'INTERNAL_RESULT' } };
                },
              },
            ],
    });
    deps.mainLlm = {
      async chat() {
        assert.fail('stream expected');
      },
      async *streamChat(messages) {
        inputs.push(structuredClone(messages));
        assert.ok(inputs.length <= 2);
        yield {
          ok: true,
          value:
            inputs.length === 1
              ? {
                  content: 'MIXED',
                  finishReason: 'tool_calls',
                  toolCalls: [
                    { index: 0, name: tool.name, arguments: incomplete },
                    { index: 1, name: 'External', arguments: incomplete },
                    {
                      index: 2,
                      name: 'External',
                      arguments: '{"target":"valid"}',
                    },
                    ...(mode === 'pass'
                      ? []
                      : [
                          {
                            index: 3,
                            name: tool.name,
                            arguments: '{"target":"valid"}',
                          },
                        ]),
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
    const agent = new SmartAgent(deps, config);
    const options = {
      ...testCallOptions(),
      externalTools: [
        { ...tool, name: 'External' },
        ...(mode === 'pass' ? [tool] : []),
      ],
    };
    const first = await agent.process('go', options);
    assert.ok(first.ok);
    assert.equal(first.value.toolCalls?.length, 1);
    const id = first.value.toolCalls[0].id;
    const resumed = await agent.process([], {
      ...options,
      externalResults: new Map([[id, 'EXTERNAL_RESULT']]),
    });
    assert.ok(resumed.ok);
    assert.equal(executions, mode === 'pass' ? 0 : 1);
    assert.equal(inputs.length, 2);
    const assistantIndex = inputs[1].findIndex(
      (message) => message.content === 'MIXED',
    );
    assert.ok(assistantIndex >= 0);
    const exchange = inputs[1].slice(assistantIndex);
    assertUniqueToolHistory(exchange);
    assert.match(String(exchange[1].content), /Invalid tool arguments/);
    assert.match(String(exchange[2].content), /Invalid tool arguments/);
    assert.equal(exchange[3].content, 'EXTERNAL_RESULT');
    if (mode !== 'pass') assert.equal(exchange[4].content, 'INTERNAL_RESULT');
  });
}
