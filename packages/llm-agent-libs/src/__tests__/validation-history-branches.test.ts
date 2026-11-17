import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  IMcpClient,
  Message,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { externalToolCallId, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { type AgentCallOptions, SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import {
  LegacyAccumulateContextStrategy,
  WindowContextStrategy,
} from '../pipeline/context/tool-loop-context/index.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { makeDefaultDeps, testCallOptions } from '../testing/index.js';

const BAD_REPLY = 'BAD_REPLY';
const REASON = 'validation-history-regression';
const EXTERNAL = {
  name: 'External',
  description: 'client action',
  inputSchema: { type: 'object' },
};

function assertValidationExchange(messages: Message[]): number {
  const index = messages.findIndex(
    (message) => message.role === 'assistant' && message.content === BAD_REPLY,
  );
  assert.ok(index >= 0, 'rejected assistant reply must remain in context');
  const correction = messages[index + 1];
  assert.equal(correction?.role, 'user');
  assert.match(String(correction.content), /rejected by validation/);
  assert.match(String(correction.content), new RegExp(REASON));
  assert.equal(
    messages.filter((message) => message.content === BAD_REPLY).length,
    1,
    'the validation exchange must not be duplicated',
  );
  return index;
}

// A direct external miss ends the turn without another model call. Observe the
// context formed at that boundary as well as actual subsequent model inputs.
class ObservableMessages extends Array<Message> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  constructor(
    messages: Message[],
    private readonly capture: (messages: Message[]) => void,
  ) {
    super(...messages);
  }

  override concat(...items: (Message | ConcatArray<Message>)[]): Message[] {
    const messages = super.concat(...items);
    this.capture(messages);
    return messages;
  }
}

const scenarios = [
  'blocked tool',
  'rejected external',
  'rejected external with internal',
  'external with unknown',
  'external continuation',
  'internal tool',
  'unknown tool',
] as const;

for (const pipeline of [false, true]) {
  for (const scenario of scenarios) {
    test(`${pipeline ? 'pipeline' : 'direct'}: validation exchange survives ${scenario}`, async () => {
      const inputs: Message[][] = [];
      const formedContexts: Message[][] = [];
      const rounds: ToolRound[] = [];
      const executed: string[] = [];
      const strategy = new LegacyAccumulateContextStrategy();
      const form = strategy.form.bind(strategy);
      const record = strategy.record.bind(strategy);
      strategy.form = async (input) =>
        new ObservableMessages(await form(input), (messages) => {
          formedContexts.push(messages);
        });
      strategy.record = async (round) => {
        rounds.push(round);
        await record(round);
      };

      const names =
        scenario === 'blocked tool'
          ? ['Blocked']
          : scenario === 'rejected external with internal'
            ? ['External', 'Work']
            : scenario === 'external with unknown'
              ? ['External', 'Ghost']
              : scenario === 'internal tool'
                ? ['Work']
                : scenario === 'unknown tool'
                  ? ['Ghost']
                  : ['External'];
      const llm: ILlm = {
        async chat() {
          return {
            ok: true,
            value: { content: 'unused', finishReason: 'stop' },
          };
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          assert.ok(inputs.length <= 3, 'unexpected extra model call');
          if (inputs.length === 2) {
            yield {
              ok: true,
              value: {
                content: '',
                toolCalls: names.map((name, index) => ({
                  index,
                  id: `branch-${index}`,
                  name,
                  arguments: '{}',
                })),
                finishReason: 'tool_calls',
              },
            };
          } else {
            yield {
              ok: true,
              value: {
                content: inputs.length === 1 ? BAD_REPLY : 'DONE',
                finishReason: 'stop',
              },
            };
          }
        },
      };
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: ['Work', 'Blocked'].map((name) => ({
              name,
              description: name,
              inputSchema: { type: 'object' },
            })),
          };
        },
        async callTool(name) {
          executed.push(name);
          return { ok: true, value: { content: 'WORK_RESULT' } };
        },
      };
      const { deps } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        mcpClients: [client],
        outputValidator: {
          async validate(content) {
            return {
              ok: true,
              value: { valid: content !== BAD_REPLY, reason: REASON },
            };
          },
        },
      });
      deps.mainLlm = llm;
      deps.toolCache = new NoopToolCache();
      deps.toolLoopContextStrategyFactory = () => strategy;
      const registry = new ToolAvailabilityRegistry();
      deps.toolAvailabilityRegistry = registry;
      const config = { maxIterations: 5, refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const agent = new SmartAgent(deps, config);
      const sessionId = `validation-${pipeline}-${scenario}`;
      const options: AgentCallOptions = {
        sessionId,
        externalTools: [EXTERNAL],
        externalResults: new Map([
          [externalToolCallId('External', {}), 'EXTERNAL_RESULT'],
        ]),
      };
      if (scenario.startsWith('rejected external')) {
        options.toolRoundGuard = () => new Map([[0, 'external rejected']]);
      }
      if (scenario === 'blocked tool') {
        // Inject the same typed registry into the direct and pipeline paths.
        registry.block(
          JSON.stringify(['test-user', sessionId]),
          'Blocked',
          'blocked for regression',
        );
        options.toolAvailability = registry;
      }

      const first = await agent.process('go', testCallOptions(options));
      assert.ok(first.ok);
      if (first.value.stopReason === 'tool_calls') {
        const pending = first.value.toolCalls ?? [];
        assert.equal(pending.length, 1);
        const resumed = await agent.process([], {
          ...testCallOptions(options),
          externalResults: new Map([[pending[0].id, 'EXTERNAL_RESULT']]),
        });
        assert.ok(resumed.ok);
      }
      assertValidationExchange(inputs[1]);
      assert.equal(inputs.length, 3);
      assertValidationExchange(formedContexts.at(-1) ?? []);
      {
        const validationIndex = assertValidationExchange(inputs[2]);
        const toolIndex = inputs[2].findIndex((message) =>
          message.tool_calls?.some((call) =>
            names.includes(call.function.name),
          ),
        );
        assert.ok(
          toolIndex > validationIndex + 1,
          'BAD_REPLY and correction must precede the tool call',
        );
        if (
          scenario === 'internal tool' ||
          scenario === 'rejected external with internal'
        ) {
          const resultIndex = inputs[2].findIndex(
            (message) => message.content === 'WORK_RESULT',
          );
          assert.ok(
            resultIndex > toolIndex,
            'WORK_RESULT must follow the tool call and validation exchange',
          );
        }
      }

      assert.deepEqual(
        executed,
        scenario === 'internal tool' ||
          scenario === 'rejected external with internal'
          ? ['Work']
          : [],
      );
      const results = inputs[2].filter((message) => message.role === 'tool');
      const branchId = inputs[2].find((message) =>
        message.tool_calls?.some((call) => names.includes(call.function.name)),
      )?.tool_calls?.[0].id;
      assert.ok(branchId);
      const branchResult = results.find(
        (message) => message.tool_call_id === branchId,
      );
      if (scenario === 'blocked tool')
        assert.match(String(branchResult?.content), /temporarily unavailable/);
      if (scenario.startsWith('rejected external'))
        assert.match(String(branchResult?.content), /external rejected/);
      if (scenario === 'external with unknown' || scenario === 'unknown tool')
        assert.ok(
          results.some((message) =>
            String(message.content).includes('Tool "Ghost" not found'),
          ),
        );
      if (
        scenario === 'external continuation' ||
        scenario === 'external with unknown'
      )
        assert.ok(
          inputs[2].some(
            (message) =>
              message.role === 'tool' && message.content === 'EXTERNAL_RESULT',
          ),
        );
    });
  }
}

for (const pipeline of [false, true]) {
  for (const keepLastRounds of [undefined, 1]) {
    test(`${pipeline ? 'pipeline' : 'direct'}: interleaved validation exchanges retain their positions through structuredClone (window=${keepLastRounds})`, async () => {
      const strategy =
        keepLastRounds === undefined
          ? new LegacyAccumulateContextStrategy()
          : new WindowContextStrategy({ keepLastRounds });
      const form = strategy.form.bind(strategy);
      strategy.form = async (base) => structuredClone(await form(base));
      const inputs: Message[][] = [];
      const llm: ILlm = {
        async chat() {
          throw new Error('Expected streaming');
        },
        async *streamChat(messages) {
          inputs.push(structuredClone(messages));
          const call = inputs.length;
          assert.ok(call <= 6);
          yield {
            ok: true,
            value:
              call % 2 === 1
                ? {
                    content: `ASSISTANT-${call}`,
                    toolCalls: [
                      {
                        index: 0,
                        id: `call-${call}`,
                        name: 'Work',
                        arguments: JSON.stringify({ call }),
                      },
                    ],
                    finishReason: 'tool_calls',
                  }
                : {
                    content: call < 6 ? `BAD_REPLY-${call}` : 'DONE',
                    finishReason: 'stop',
                  },
          };
        },
      };
      const { deps } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        mcpClients: [
          {
            async listTools() {
              return {
                ok: true,
                value: [{ name: 'Work', description: 'Work', inputSchema: {} }],
              };
            },
            async callTool(_name, args) {
              return {
                ok: true,
                value: { content: `WORK_RESULT-${args.call}` },
              };
            },
          },
        ],
        outputValidator: {
          async validate(content) {
            return {
              ok: true,
              value: {
                valid: !content.startsWith('BAD_REPLY'),
                reason: REASON,
              },
            };
          },
        },
      });
      deps.toolLoopContextStrategyFactory = () => strategy;
      deps.mainLlm = llm;
      deps.toolCache = new NoopToolCache();
      const config = { refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const result = await new SmartAgent(deps, config).process(
        [
          { role: 'user', content: 'OLDER' },
          {
            role: 'assistant',
            content: 'PREFIX_ASSISTANT',
            tool_calls: [
              {
                id: 'prefix',
                type: 'function',
                function: { name: 'Work', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'prefix', content: 'PREFIX_RESULT' },
          { role: 'user', content: 'go' },
        ],
        testCallOptions(),
      );
      assert.ok(result.ok);
      assert.equal(inputs.length, 6);
      const history = inputs[5].slice(inputs[0].length);
      if (keepLastRounds !== undefined) {
        assert.deepEqual(
          history.map((message) => message.role),
          [
            'assistant',
            'user',
            'assistant',
            'user',
            'user',
            'assistant',
            'tool',
          ],
        );
        assert.equal(history[0].content, 'BAD_REPLY-2');
        assert.match(String(history[1].content), /rejected by validation/);
        assert.equal(history[2].content, 'BAD_REPLY-4');
        assert.match(String(history[3].content), /rejected by validation/);
        assert.match(String(history[4].content), /elided/);
        assert.equal(history[5].content, 'ASSISTANT-5');
        assert.equal(history[6].content, 'WORK_RESULT-5');
        return;
      }

      assert.deepEqual(
        history.map((message) => message.role),
        [
          'assistant',
          'tool',
          'assistant',
          'user',
          'assistant',
          'tool',
          'assistant',
          'user',
          'assistant',
          'tool',
        ],
      );
      assert.deepEqual(
        history
          .map((message) => message.content)
          .filter(
            (content) => !String(content).includes('rejected by validation'),
          ),
        [
          'ASSISTANT-1',
          'WORK_RESULT-1',
          'BAD_REPLY-2',
          'ASSISTANT-3',
          'WORK_RESULT-3',
          'BAD_REPLY-4',
          'ASSISTANT-5',
          'WORK_RESULT-5',
        ],
      );
      assert.match(String(history[3].content), /rejected by validation/);
      assert.match(String(history[7].content), /rejected by validation/);
    });
  }
}

for (const pipeline of [false, true]) {
  for (const clone of [false, true]) {
    test(`${pipeline ? 'pipeline' : 'direct'}: repeated call ID after an elided predecessor retains validation order (clone=${clone})`, async () => {
      const inputs: Message[][] = [];
      const { deps } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        llmResponses: [
          {
            content: 'OLDER_TOOL',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'repeated', name: 'Work', arguments: { round: 1 } },
            ],
          },
          { content: BAD_REPLY },
          {
            content: 'NEWER_TOOL',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'repeated', name: 'Work', arguments: { round: 2 } },
            ],
          },
          { content: 'DONE' },
        ],
        mcpClients: [
          {
            async listTools() {
              return {
                ok: true,
                value: [{ name: 'Work', description: 'Work', inputSchema: {} }],
              };
            },
            async callTool(_name, args) {
              return { ok: true, value: { content: `RESULT-${args.round}` } };
            },
          },
        ],
        outputValidator: {
          async validate(content) {
            return {
              ok: true,
              value: { valid: content !== BAD_REPLY, reason: REASON },
            };
          },
        },
      });
      const strategy = new WindowContextStrategy({ keepLastRounds: 1 });
      const form = strategy.form.bind(strategy);
      strategy.form = async (base) => {
        const messages = await form(base);
        return clone ? structuredClone(messages) : messages;
      };
      deps.toolLoopContextStrategyFactory = () => strategy;
      const llm = deps.mainLlm;
      const stream = llm.streamChat?.bind(llm);
      assert.ok(stream);
      deps.mainLlm = {
        chat: llm.chat.bind(llm),
        async *streamChat(messages, tools, options) {
          inputs.push(structuredClone(messages));
          assert.ok(inputs.length <= 4);
          yield* stream(messages, tools, options);
        },
      };
      const config = { refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const result = await new SmartAgent(deps, config).process(
        'work',
        testCallOptions(),
      );
      assert.ok(result.ok);
      assert.equal(inputs.length, 4);
      const history = inputs[3];
      const correction = assertValidationExchange(history);
      const newer = history.findIndex(
        (message) => message.content === 'NEWER_TOOL',
      );
      assert.ok(
        correction + 1 < newer,
        'correction must precede the newer round',
      );
      assert.equal(
        history[newer + 1].tool_call_id,
        history[newer].tool_calls?.[0].id,
      );
      assert.equal(history[newer + 1].content, 'RESULT-2');
      assert.ok(!history.some((message) => message.content === 'OLDER_TOOL'));
      assert.ok(
        history.every((message) => !('toolLoopRoundOrdinal' in message)),
      );
    });
  }
}
