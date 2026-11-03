import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  createDialogueTaskContext,
  type DialogueSignals,
  finishDialogueTask,
  type IMcpClient,
  type LlmStreamChunk,
} from '@mcp-abap-adt/llm-agent';
import {
  createSignalBus,
  noopEmitter,
} from '../../../llm-signals/src/index.js';
import { SmartAgent } from '../agent.js';
import { TaskBoard } from '../coordinator/dialogue/task-board.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { SmartAgentSubAgent } from '../subagent/smart-agent-subagent.js';
import { makeAssembler, makeDefaultDeps } from '../testing/index.js';

for (const pipeline of [false, true]) {
  for (const scenario of [
    'finish',
    'empty-output',
    'none',
    'other-task',
    'other-source',
    'stale',
    'noop',
    'no-bus',
  ] as const) {
    for (const streamMode of ['full', 'final'] as const) {
      test(`task finish: ${scenario}, pipeline=${pipeline}, stream=${streamMode}`, async () => {
        const bus = createSignalBus<DialogueSignals>();
        const signals =
          scenario === 'noop' ? noopEmitter<DialogueSignals>() : bus;
        const output = scenario === 'empty-output' ? '' : 'recorded verdict';
        const finishes = scenario === 'finish' || scenario === 'empty-output';
        if (scenario === 'stale') {
          bus.emit(
            'dialogue.task.finish',
            { taskId: 't1', output: 'old' },
            's',
            't1',
          );
        }
        let toolCalls = 0;
        const client: IMcpClient = {
          cacheable: false,
          async listTools() {
            return {
              ok: true,
              value: [{ name: 'Work', description: 'work', inputSchema: {} }],
            };
          },
          async callTool(_name, _args, options) {
            toolCalls++;
            const task = options?.dialogueTask;
            if (scenario === 'no-bus') assert.equal(task, undefined);
            else {
              assert.ok(task);
              assert.equal(task.taskId, 't1');
              assert.equal(task.source, 's');
              assert.equal(task.signals, signals);
              if (finishes || scenario === 'noop')
                finishDialogueTask(task, output, 'Work');
              if (scenario === 'other-task')
                finishDialogueTask(
                  createDialogueTaskContext(bus, 's', 'foreign'),
                  output,
                );
              if (scenario === 'other-source')
                finishDialogueTask(
                  createDialogueTaskContext(bus, 'foreign', 't1'),
                  output,
                );
            }
            return { ok: true, value: { content: 'tool settled' } };
          },
        };
        const { deps, llm } = makeDefaultDeps({
          assembler: makeAssembler([{ role: 'user', content: 'work' }]),
          mcpClients: [client],
          llmResponses: [
            {
              content: 'progress',
              toolCalls: [{ id: 'c1', name: 'Work', arguments: {} }],
              finishReason: 'tool_calls',
            },
            { content: 'normal response', finishReason: 'stop' },
          ],
        });
        const config = {
          streamMode,
          maxIterations: 3,
          heartbeatIntervalMs: 0,
          refreshToolsPerIteration: false,
        };
        if (pipeline) {
          const flow = new DefaultPipeline();
          flow.initialize({ ...deps, agentConfig: config });
          deps.pipeline = flow;
        }
        const agent = new SmartAgent(deps, config);
        const worker = new SmartAgentSubAgent('w', {
          maxToolCalls: agent.maxToolCalls,
          async process(input, options) {
            const result = await agent.process(input, options);
            assert.ok(result.ok);
            assert.equal(result.value.stopReason, 'stop');
            assert.equal(result.value.stopped, undefined);
            assert.equal(result.value.toolCalls, undefined);
            return result;
          },
        });
        let settled!: () => void;
        const done = new Promise<void>((resolve) => {
          settled = resolve;
        });
        const board = new TaskBoard({
          workers: new Map([['w', worker]]),
          signals: scenario === 'no-bus' ? undefined : signals,
          source: 's',
          onEvent(event) {
            if (event.kind === 'done' || event.kind === 'failed') settled();
          },
        });
        const started = board.start({ worker: 'w', goal: 'work' });
        assert.ok(started.ok);
        await done;
        const task = board.get('t1');
        assert.equal(task?.state, 'done');
        assert.equal(task.output, finishes ? output : 'normal response');
        assert.equal(task.toolCalls, 1);
        assert.equal(toolCalls, 1);
        assert.equal(llm.callCount, finishes ? 1 : 2);
        assert.equal(task.toolTrace?.entries.length, 1);
        assert.ok(task.usage);
        await board.stopAll();
      });
    }
  }
}

test('a fresh emission in the baseline millisecond is accepted, the previous run is ignored', (t) => {
  t.mock.method(Date, 'now', () => 123);
  const bus = createSignalBus<DialogueSignals>();
  finishDialogueTask(createDialogueTaskContext(bus, 's', 't'), 'old');
  const task = createDialogueTaskContext(bus, 's', 't');
  assert.equal(task.readFinish(), undefined);
  finishDialogueTask(task, 'new');
  assert.equal(task.readFinish()?.output, 'new');
  assert.equal(
    createDialogueTaskContext(bus, 's', 't').readFinish(),
    undefined,
  );
});

for (const pipeline of [false, true]) {
  for (const streamMode of ['full', 'final'] as const) {
    test(`finish during catalogue wait: pipeline=${pipeline}, stream=${streamMode}`, async () => {
      const bus = createSignalBus<DialogueSignals>();
      const task = createDialogueTaskContext(bus, 's', 't1');
      let lists = 0;
      const client: IMcpClient = {
        cacheable: false,
        async listTools() {
          if (++lists > 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            finishDialogueTask(task, 'finished during refresh');
          }
          return {
            ok: true,
            value: [{ name: 'Work', description: 'work', inputSchema: {} }],
          };
        },
        async callTool() {
          return { ok: true, value: { content: 'settled' } };
        },
      };
      const { deps, llm } = makeDefaultDeps({
        assembler: makeAssembler([{ role: 'user', content: 'work' }]),
        mcpClients: [client],
        llmResponses: [
          {
            content: '',
            toolCalls: [{ id: 'c', name: 'Work', arguments: {} }],
            finishReason: 'tool_calls',
          },
          { content: 'unexpected', finishReason: 'stop' },
        ],
      });
      let validations = 0;
      deps.outputValidator = {
        async validate() {
          validations++;
          return {
            ok: true,
            value: { valid: false, reason: 'would reprompt' },
          };
        },
      };
      const config = { maxIterations: 3, streamMode, heartbeatIntervalMs: 0 };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const agent = new SmartAgent(deps, config);
      const steps: string[] = [];
      const finalLogs: string[] = [];
      const partials: string[] = [];
      const chunks: LlmStreamChunk[] = [];
      const options: CallOptions = {
        dialogueTask: task,
        sessionLogger: {
          logStep(name, data) {
            steps.push(name);
            if (name === 'final_response') finalLogs.push(JSON.stringify(data));
          },
        },
        onPartial(event) {
          if (event.kind === 'content') partials.push(event.delta);
          if (event.kind === 'iteration-end') partials.push(event.outcome);
        },
      };
      for await (const chunk of agent.streamProcess('work', options)) {
        assert.ok(chunk.ok);
        chunks.push(chunk.value);
      }
      assert.equal(llm.callCount, 1);
      assert.equal(validations, 0);
      assert.equal(finalLogs.length, 1);
      assert.ok(finalLogs[0].includes('"content":"finished during refresh"'));
      assert.ok(finalLogs[0].includes('"usage":'));
      assert.equal(
        chunks.filter((chunk) => chunk.content === 'finished during refresh')
          .length,
        1,
      );
      assert.equal(
        chunks.filter((chunk) => chunk.iterationEnd === 'final').length,
        1,
      );
      assert.equal(steps.filter((step) => step === 'final_response').length, 1);
      assert.ok(partials.includes('finished during refresh'));
      assert.equal(partials.filter((value) => value === 'final').length, 1);
    });
  }
}

test('legacy finish uses the stream hook and client adapter', async () => {
  const bus = createSignalBus<DialogueSignals>();
  const task = createDialogueTaskContext(bus, 's', 't');
  finishDialogueTask(task, 'verdict');
  const { deps, llm } = makeDefaultDeps({
    mcpClients: [
      {
        cacheable: false,
        async listTools() {
          return {
            ok: true,
            value: [{ name: 'Work', description: 'work', inputSchema: {} }],
          };
        },
        async callTool() {
          return { ok: true, value: { content: 'settled' } };
        },
      },
    ],
    llmResponses: [
      {
        content: '',
        toolCalls: [{ id: 'c', name: 'Work', arguments: {} }],
        finishReason: 'tool_calls',
      },
    ],
  });
  deps.clientAdapters = [
    {
      name: 'test',
      detect: () => true,
      wrapResponse: (content) => `[${content}]`,
    },
  ];
  const hookInputs: string[] = [];
  const agent = new SmartAgent(deps, {
    maxIterations: 3,
    async *onBeforeStream(content, context) {
      hookInputs.push(content);
      assert.ok(context.messages.length);
      yield `hook: ${content}`;
    },
  });
  const contents: string[] = [];
  for await (const chunk of agent.streamProcess(
    [
      { role: 'system', content: 'adapter' },
      { role: 'user', content: 'work' },
    ],
    { dialogueTask: task },
  )) {
    assert.ok(chunk.ok);
    contents.push(chunk.value.content);
  }
  assert.deepEqual(hookInputs, ['verdict']);
  assert.equal(
    contents.filter((content) => content === '[hook: verdict]').length,
    1,
  );
  assert.equal(llm.callCount, 1);
});

for (const pipeline of [false, true]) {
  test(`TaskBoard rerun with the same id ignores previous finish: pipeline=${pipeline}`, async () => {
    const bus = createSignalBus<DialogueSignals>();
    let runs = 0;
    const client: IMcpClient = {
      cacheable: false,
      async listTools() {
        return {
          ok: true,
          value: [{ name: 'Work', description: 'work', inputSchema: {} }],
        };
      },
      async callTool(_name, _args, options) {
        if (runs === 1) {
          assert.ok(options?.dialogueTask);
          finishDialogueTask(options.dialogueTask, 'first run finish');
        }
        return { ok: true, value: { content: 'settled' } };
      },
    };
    const { deps, llm } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: '',
          toolCalls: [{ id: 'c1', name: 'Work', arguments: {} }],
          finishReason: 'tool_calls',
        },
        {
          content: '',
          toolCalls: [{ id: 'c2', name: 'Work', arguments: {} }],
          finishReason: 'tool_calls',
        },
        { content: 'second run normal answer', finishReason: 'stop' },
      ],
    });
    const config = {
      maxIterations: 3,
      heartbeatIntervalMs: 0,
      refreshToolsPerIteration: false,
    };
    if (pipeline) {
      const flow = new DefaultPipeline();
      flow.initialize({ ...deps, agentConfig: config });
      deps.pipeline = flow;
    }
    const agent = new SmartAgent(deps, config);
    const worker = new SmartAgentSubAgent('w', agent);
    for (const expected of ['first run finish', 'second run normal answer']) {
      runs++;
      let settle = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const board = new TaskBoard({
        workers: new Map([['w', worker]]),
        signals: bus,
        source: 's',
        newId: () => 'same-task',
        onEvent(event) {
          if (event.kind === 'done' || event.kind === 'failed') settle();
        },
      });
      assert.ok(board.start({ worker: 'w', goal: 'work' }).ok);
      await done;
      assert.equal(board.get('same-task')?.state, 'done');
      assert.equal(board.get('same-task')?.output, expected);
      await board.stopAll();
    }
    assert.equal(llm.callCount, 3);
  });
}
