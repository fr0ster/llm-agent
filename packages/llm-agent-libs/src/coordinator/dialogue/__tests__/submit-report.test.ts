import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDialogueTaskContext,
  type IMcpClient,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../../agent.js';
import { DefaultPipeline } from '../../../pipeline/default-pipeline.js';
import { SmartAgentSubAgent } from '../../../subagent/smart-agent-subagent.js';
import {
  makeDefaultDeps,
  makeMcpClient,
  makeRag,
} from '../../../testing/index.js';
import { createMemorySignalBus } from '../memory-signal-bus.js';
import {
  createSubmitReportClient,
  resolveVerdictSummary,
  resolveWorkerSummary,
  submitReportTool,
  withSubmitReport,
} from '../submit-report-tool.js';
import { TaskBoard } from '../task-board.js';

test('host tools prevent default registration even when not selected', async () => {
  const task = {
    ...createDialogueTaskContext(createMemorySignalBus(), 's', 't'),
    result: 'report' as const,
  };
  for (const selected of [false, true]) {
    const clients = new Map<string, IMcpClient>();
    const hostTool = { ...submitReportTool, description: 'Host report' };
    const tools = selected ? [submitReportTool, hostTool] : [submitReportTool];
    assert.deepEqual(
      await withSubmitReport(tools, clients, { dialogueTask: task }, [
        submitReportTool,
      ]),
      selected ? [hostTool] : [],
    );
    assert.equal(clients.has('submit_report'), false);
  }
  const clients = new Map<string, IMcpClient>();
  const selected = await withSubmitReport(
    [submitReportTool, submitReportTool],
    clients,
    { dialogueTask: task },
  );
  assert.deepEqual(selected, [submitReportTool]);
  const previous = clients.get('submit_report');
  assert.ok(previous);
  clients.clear();
  assert.deepEqual(
    await withSubmitReport(selected, clients, { dialogueTask: task }),
    [submitReportTool],
  );
  assert.ok(clients.get('submit_report'));
  assert.notEqual(clients.get('submit_report'), previous);
  await withSubmitReport(selected, clients, { dialogueTask: task }, [
    submitReportTool,
  ]);
  assert.equal(clients.has('submit_report'), false);
});

for (const pipeline of [false, true]) {
  for (const external of [false, true]) {
    test(`host submit_report uses only the host path: pipeline=${pipeline}, external=${external}`, async () => {
      const host = makeMcpClient([submitReportTool]);
      const { deps } = makeDefaultDeps({
        mcpClients: external ? [] : [host],
        llmResponses: [
          {
            content: '',
            toolCalls: [
              {
                id: 'host-call',
                name: 'submit_report',
                arguments: {
                  summary: 'Summary',
                  result: 'Default must not finish',
                },
              },
            ],
            finishReason: 'tool_calls',
          },
          { content: 'Host handled report', finishReason: 'stop' },
        ],
      });
      const config = {
        mode: 'hard' as const,
        maxIterations: 3,
        heartbeatIntervalMs: 0,
      };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const task = {
        ...createDialogueTaskContext(createMemorySignalBus(), 's', 't'),
        result: 'report' as const,
      };
      const worker = new SmartAgentSubAgent('w', new SmartAgent(deps, config));
      const response = await worker.run({
        task: 'Write a report',
        dialogueTask: task,
        externalTools: external ? [submitReportTool] : [],
      });
      assert.equal(task.readFinish(), undefined);
      assert.equal(host.callCount, external ? 0 : 1);
      if (external) {
        assert.equal(response.status, 'awaiting-external');
        assert.equal(response.pendingExternalToolCalls?.length, 1);
        assert.equal(
          response.pendingExternalToolCalls?.[0].name,
          'submit_report',
        );
      } else {
        assert.equal(response.output, 'Host handled report');
      }
    });
  }
}

test('worker without submit_report returns the bounded fallback summary', async () => {
  const output = 'Report text. '.repeat(100);
  const { deps } = makeDefaultDeps({
    llmResponses: [{ content: output, finishReason: 'stop' }],
  });
  const worker = new SmartAgentSubAgent(
    'w',
    new SmartAgent(deps, { maxIterations: 2 }),
  );
  const response = await worker.run({ task: 'Write a report' });
  assert.equal(response.output, output);
  assert.equal(response.summary, output.slice(0, 600));
  assert.equal(resolveWorkerSummary(response.output).truncated, true);
});

test('board supplies report kind to the default worker without host tool setup', async () => {
  const { deps } = makeDefaultDeps({
    llmResponses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'submit_report',
            arguments: { summary: 'Summary', result: 'Report' },
          },
        ],
        finishReason: 'tool_calls',
      },
    ],
  });
  const worker = new SmartAgentSubAgent(
    'w',
    new SmartAgent(deps, { maxIterations: 2 }),
  );
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const board = new TaskBoard({
    signals: createMemorySignalBus(),
    workers: new Map([['w', worker]]),
    onEvent(event) {
      if (event.kind === 'done' || event.kind === 'failed') finish();
    },
  });
  const started = board.start({ worker: 'w', goal: 'Write a report' });
  assert.ok(started.ok);
  await finished;
  assert.equal(board.get(started.value.id)?.state, 'done');
  assert.equal(board.get(started.value.id)?.output, 'Report');
  await board.stopAll();
});

for (const pipeline of [false, true]) {
  test(`default report survives refresh with read-only reselect: pipeline=${pipeline}`, async () => {
    const searchTool = {
      name: 'SearchReport',
      description: 'Read report inputs',
      inputSchema: { type: 'object' },
    };
    const host = makeMcpClient([searchTool]);
    let refreshes = 0;
    const listTools = host.listTools.bind(host);
    host.listTools = async (options) => {
      refreshes++;
      return listTools(options);
    };
    const { deps, llm } = makeDefaultDeps({
      mcpClients: [host],
      ragStores: { tools: makeRag() },
      llmResponses: [
        {
          content: '',
          toolCalls: [{ id: 'search', name: 'SearchReport', arguments: {} }],
          finishReason: 'tool_calls',
        },
        {
          content: '',
          toolCalls: [
            {
              id: 'report',
              name: 'submit_report',
              arguments: { summary: 'Summary', result: 'Report after refresh' },
            },
          ],
          finishReason: 'tool_calls',
        },
      ],
    });
    const offered: string[][] = [];
    const stream = llm.streamChat.bind(llm);
    llm.streamChat = (messages, tools, options) => {
      offered.push((tools ?? []).map((tool) => tool.name));
      return stream(messages, tools, options);
    };
    const config = {
      mode: 'hard' as const,
      maxIterations: 3,
      heartbeatIntervalMs: 0,
      refreshToolsPerIteration: true,
      toolReselectPerIteration: true,
    };
    if (pipeline) {
      const flow = new DefaultPipeline();
      flow.initialize({ ...deps, agentConfig: config });
      deps.pipeline = flow;
    }
    const task = {
      ...createDialogueTaskContext(createMemorySignalBus(), 's', 't'),
      result: 'report' as const,
    };
    const worker = new SmartAgentSubAgent('w', new SmartAgent(deps, config));
    const response = await worker.run({
      task: 'Write a report',
      dialogueTask: task,
    });
    assert.equal(response.output, 'Report after refresh');
    assert.equal(task.readFinish()?.tool, 'submit_report');
    assert.equal(llm.callCount, 2);
    assert.ok(refreshes >= 2);
    assert.equal(offered.length, 2);
    for (const names of offered) {
      assert.equal(names.filter((name) => name === 'submit_report').length, 1);
      assert.equal(new Set(names).size, names.length);
    }
  });
}

for (const scenario of [
  'explicit',
  'collected',
  'empty',
  'long-summary',
] as const) {
  test(`submit_report: ${scenario}`, async () => {
    const task = createDialogueTaskContext(createMemorySignalBus(), 's', 't1');
    const client = createSubmitReportClient();
    const args = {
      summary: scenario === 'long-summary' ? 'S'.repeat(601) : 'Summary',
      ...(scenario === 'explicit' ? { result: 'Full result' } : {}),
    };
    const response = await client.callTool('submit_report', args, {
      dialogueTask: task,
      dialogueReportText: () =>
        scenario === 'collected' ? 'First\n\nSecond' : '',
    });
    assert.ok(response.ok);
    if (scenario === 'empty' || scenario === 'long-summary') {
      assert.equal(response.value.isError, true);
      assert.match(
        String(response.value.content),
        scenario === 'empty' ? /result/ : /summary/,
      );
      assert.equal(task.readFinish(), undefined);
    } else {
      assert.equal(response.value.isError, undefined);
      assert.equal(
        task.readFinish()?.output,
        scenario === 'explicit' ? 'Full result' : 'First\n\nSecond',
      );
      assert.equal(task.readFinish()?.summary, 'Summary');
      assert.equal(task.readFinish()?.tool, 'submit_report');
    }
  });
}

test('fallback summary is the first 600 characters and records truncation', () => {
  assert.deepEqual(resolveWorkerSummary('x'.repeat(700)), {
    summary: 'x'.repeat(600),
    truncated: true,
  });
  assert.deepEqual(resolveWorkerSummary('short'), {
    summary: 'short',
    truncated: false,
  });
  assert.deepEqual(resolveWorkerSummary('full', 'Chosen summary'), {
    summary: 'Chosen summary',
    truncated: false,
  });
});

test('verdict summary keeps verdict and count, cutting the note to 600', () => {
  const prefix = 'fail; count: 12; note: ';
  assert.equal(
    resolveVerdictSummary({
      verdict: 'fail',
      count: 12,
      note: 'n'.repeat(900),
    }),
    prefix + 'n'.repeat(600 - prefix.length),
  );
  assert.equal(resolveVerdictSummary({ verdict: 'pass' }), 'pass');
});

test('host report tool and schema take precedence; verdict and chat get no default', async () => {
  const tool = {
    name: 'submit_report',
    description: 'Host extension',
    inputSchema: { host: true },
  };
  const host = makeMcpClient([tool]);
  const clients = new Map([['submit_report', host]]);
  const task = createDialogueTaskContext(createMemorySignalBus(), 's', 't');
  assert.deepEqual(
    await withSubmitReport([], clients, {
      dialogueTask: { ...task, result: 'report' },
    }),
    [tool],
  );
  assert.equal(clients.get('submit_report'), host);
  assert.deepEqual(
    await withSubmitReport([submitReportTool, tool, tool], clients, {
      dialogueTask: { ...task, result: 'report' },
    }),
    [tool],
  );
  assert.deepEqual(
    await withSubmitReport([], new Map(), {
      dialogueTask: { ...task, result: 'verdict' },
    }),
    [],
  );
  assert.deepEqual(await withSubmitReport([], new Map()), []);
});

for (const pipeline of [false, true]) {
  for (const explicit of [false, true]) {
    test(`default worker report completes through typed finish: pipeline=${pipeline}, explicit=${explicit}`, async () => {
      const { deps, llm } = makeDefaultDeps({
        llmResponses: [
          {
            content: 'Accepted report text',
            toolCalls: [
              {
                id: 'c1',
                name: 'submit_report',
                arguments: {
                  summary: 'Short summary',
                  ...(explicit ? { result: 'Explicit report' } : {}),
                },
              },
            ],
            finishReason: 'tool_calls',
          },
        ],
      });
      const config = {
        mode: 'hard' as const,
        maxIterations: 3,
        heartbeatIntervalMs: 0,
      };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const agent = new SmartAgent(deps, config);
      const worker = new SmartAgentSubAgent('w', agent);
      const task = {
        ...createDialogueTaskContext(createMemorySignalBus(), 's', 't'),
        result: 'report' as const,
      };
      const response = await worker.run({
        task: 'Write a report',
        dialogueTask: task,
      });
      assert.equal(
        response.output,
        explicit ? 'Explicit report' : 'Accepted report text',
      );
      assert.equal(response.summary, 'Short summary');
      assert.equal(task.readFinish()?.summary, 'Short summary');
      assert.equal(llm.callCount, 1);
    });
  }
}
