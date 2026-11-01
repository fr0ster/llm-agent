import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_TRACE_RENDER_CHARS,
  type ToolTrace,
} from '@mcp-abap-adt/llm-agent';
import { renderToolTrace } from '../tool-trace-render.js';

test('checker evidence trust tag is outside the escaped raw excerpt', () => {
  const trace: ToolTrace = {
    complete: true,
    omittedCount: 0,
    entries: [
      {
        sequence: 1,
        toolName: 'GetClass',
        arguments: '{}',
        outcome: 'ok',
        resultExcerpt: '[raw]',
      },
    ],
  };
  const rendered = renderToolTrace('t', trace, (name) => ({
    source: `system:${name}`,
    trust: 4.5,
  }));
  assert.match(rendered, /\[source: system:GetClass; trust 4\.5\] result: "/);
  assert.match(rendered, /\\u005braw\\u005d/);
  assert.equal(trace.entries[0].resultExcerpt, '[raw]');
});

test('checker evidence preserves a complete long trust tag within its budget', () => {
  const trace: ToolTrace = {
    complete: true,
    omittedCount: 0,
    entries: [
      {
        sequence: 1,
        toolName: 'x'.repeat(5000),
        arguments: '{}',
        outcome: 'ok',
        resultExcerpt: 'raw',
      },
    ],
  };
  const rendered = renderToolTrace('t', trace, (name) => ({
    source: `system:${name}`,
    trust: 4.5,
  }));
  assert.ok(rendered.length <= TOOL_TRACE_RENDER_CHARS);
  assert.ok(
    rendered.includes(`[source: system:${'x'.repeat(5000)}; trust 4.5]`),
  );
});

import {
  type ILlm,
  type Message,
  type ToolLoopContextStrategyFactory,
  type ToolRound,
  toModelToolMessages,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { SmartAgentBuilder } from '../../../builder.js';
import { LegacyAccumulateContextStrategy } from '../../../pipeline/context/tool-loop-context/legacy-accumulate-context-strategy.js';
import { LegacyTranscriptContextStrategy } from '../../../pipeline/context/tool-loop-context/legacy-transcript-context-strategy.js';
import { RagRecallContextStrategy } from '../../../pipeline/context/tool-loop-context/rag-recall-context-strategy.js';
import { WindowContextStrategy } from '../../../pipeline/context/tool-loop-context/window-context-strategy.js';
import { DefaultPipeline } from '../../../pipeline/default-pipeline.js';
import { injectPendingResults } from '../../../pipeline/handlers/tool-loop-core.js';
import { PendingToolResultsRegistry } from '../../../policy/pending-tool-results-registry.js';
import { makeDefaultDeps } from '../../../testing/index.js';
import { runInPlannerScope } from '../planner-scope.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { TaskBoard } from '../task-board.js';

const toolTrust = (name: string) => ({ source: `system:${name}`, trust: 4.5 });
const rawText = 'raw...[truncated]';
const taggedText = `[source: system:GetClass; trust 4.5]\n${rawText}`;
const assistant: Message = {
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'c',
      type: 'function',
      function: { name: 'GetClass', arguments: '{}' },
    },
  ],
};
const factories: Array<[string, ToolLoopContextStrategyFactory]> = [
  ['accumulate', () => new LegacyAccumulateContextStrategy()],
  [
    'transcript',
    () => new LegacyTranscriptContextStrategy({ rawMessages: [] }),
  ],
  ['window', () => new WindowContextStrategy()],
  [
    'rag',
    () =>
      new RagRecallContextStrategy(
        {
          async record() {},
          async recall() {
            return '';
          },
        },
        { runId: 'trust' },
      ),
  ],
];
for (const path of ['streaming', 'pipeline']) {
  for (const [strategyName, factory] of factories) {
    test(`${path} ${strategyName} tags live and replayed rounds while recording raw text`, async () => {
      const recorded: ToolRound[] = [];
      const capturingFactory: ToolLoopContextStrategyFactory = (deps) => {
        const strategy = factory(deps);
        return {
          record: async (round, options) => {
            recorded.push(round);
            await strategy.record(round, options);
          },
          form: strategy.form.bind(strategy),
          snapshot: strategy.snapshot.bind(strategy),
          restore: strategy.restore.bind(strategy),
        };
      };
      const seen: Message[][] = [];
      const llm: ILlm = {
        async chat() {
          return { ok: true, value: { content: 'done', finishReason: 'stop' } };
        },
        async *streamChat(messages) {
          seen.push(messages);
          yield {
            ok: true,
            value:
              seen.length < 3
                ? {
                    content: '',
                    toolCalls: [
                      {
                        id: `c${seen.length}`,
                        name: 'GetClass',
                        arguments: {},
                      },
                    ],
                    finishReason: 'tool_calls',
                  }
                : { content: 'done', finishReason: 'stop' },
          };
        },
      };
      const client = {
        async listTools() {
          return {
            ok: true as const,
            value: [
              {
                name: 'GetClass',
                description: 'read',
                inputSchema: { type: 'object' },
              },
            ],
          };
        },
        async callTool() {
          return { ok: true as const, value: { content: rawText } };
        },
      };
      let agent: SmartAgent;
      let close = async () => {};
      if (path === 'streaming') {
        const { deps } = makeDefaultDeps({ mcpClients: [client] });
        deps.mainLlm = llm;
        deps.toolLoopContextStrategyFactory = capturingFactory;
        agent = new SmartAgent(deps, { maxIterations: 4, toolTrust });
      } else {
        const handle = await new SmartAgentBuilder({
          skipModelValidation: true,
        })
          .withMainLlm(llm)
          .withMcpClients([client])
          .withToolTrust(toolTrust)
          .withToolLoopContextStrategyFactory(capturingFactory)
          .withMaxIterations(4)
          .setPipeline(new DefaultPipeline())
          .build();
        agent = handle.agent;
        close = () => handle.close();
      }
      try {
        const observations: string[] = [];
        await agent.process('read the class', {
          onToolTrace: (entry) => observations.push(entry.resultExcerpt),
        });
        assert.equal(seen.length, 3);
        for (const messages of seen.slice(1)) {
          for (const message of messages.filter((item) => item.role === 'tool'))
            assert.equal(message.content, taggedText);
        }
        assert.equal(recorded.length, 2);
        for (const round of recorded)
          assert.equal(round.results[0].content, rawText);
        assert.ok(observations.every((text) => !text.includes('[source:')));
      } finally {
        await close();
      }
    });
  }
}

test('pending-result injection stores raw text and projects its model copy once', async () => {
  const registry = new PendingToolResultsRegistry();
  const results = [{ toolCallId: 'c', toolName: 'GetClass', text: rawText }];
  registry.set('s', {
    assistantMessage: assistant,
    promise: Promise.resolve(results),
    createdAt: Date.now(),
  });
  const raw = await injectPendingResults([], registry, 's', undefined);
  assert.equal(raw[1].content, rawText);
  assert.equal(toModelToolMessages(raw, toolTrust)[1].content, taggedText);
  assert.equal(toModelToolMessages(raw)[1].content, rawText);
  assert.equal(results[0].text, rawText);
});

test('get_task tags a response copy and preserves the board trace', async () => {
  const board = new TaskBoard({ workers: new Map(), onEvent() {} });
  board.restore([
    {
      id: 't',
      worker: 'reader',
      goal: 'read',
      state: 'done',
      output: 'done',
      createdAt: 0,
      toolTrace: {
        complete: true,
        omittedCount: 0,
        entries: [
          {
            sequence: 1,
            toolName: 'GetClass',
            arguments: '{}',
            outcome: 'ok',
            resultExcerpt: rawText,
          },
        ],
      },
    },
  ]);
  const result = await runInPlannerScope(
    { board, getPlan: () => undefined, setPlan() {} },
    () =>
      new PlannerToolsClient(toolTrust).callTool('get_task', { task_id: 't' }),
  );
  assert.ok(result.ok);
  assert.ok(
    JSON.stringify(result.value.content).includes(
      'source: system:GetClass; trust 4.5',
    ),
  );
  assert.equal(board.get('t')?.toolTrace?.entries[0].resultExcerpt, rawText);
});

test('pass-through and validation project tool messages without changing raw context', async () => {
  const { runPassThrough } = await import(
    '../../../pipeline/handlers/pass-through.js'
  );
  const { runOutputValidationReprompt } = await import(
    '../../../pipeline/handlers/tool-loop-core.js'
  );
  const raw: Message[] = [
    assistant,
    { role: 'tool', tool_call_id: 'c', content: rawText },
  ];
  const llm: ILlm = {
    async chat() {
      return { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
    async *streamChat(messages) {
      assert.equal(messages[1].content, taggedText);
      yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
    },
  };
  const { NoopRequestLogger } = await import(
    '../../../logger/noop-request-logger.js'
  );
  for await (const result of runPassThrough(
    llm,
    new NoopRequestLogger(),
    raw,
    [],
    undefined,
    toolTrust,
  ))
    assert.ok(result.ok);
  const result = await runOutputValidationReprompt(
    {
      async validate(_content, context) {
        assert.equal(context.messages[1].content, taggedText);
        return { ok: true, value: { valid: false, reason: 'retry' } };
      },
    },
    'answer',
    raw,
    [],
    undefined,
    toolTrust,
  );
  assert.equal(result.messages[1].content, rawText);
  assert.equal(raw[1].content, rawText);
});
