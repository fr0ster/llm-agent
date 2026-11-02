import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, IMcpClient, StreamChunk } from '@mcp-abap-adt/llm-agent';
import { SmartAgent, type SmartAgentConfig } from '../agent.js';
import { DialogueSession } from '../coordinator/dialogue/dialogue-session.js';
import { InMemoryDialogueStateStore } from '../coordinator/dialogue/in-memory-dialogue-state-store.js';
import { PlannerToolsClient } from '../coordinator/dialogue/planner-tools-client.js';
import { TaskBoard } from '../coordinator/dialogue/task-board.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { SmartAgentSubAgent } from '../subagent/smart-agent-subagent.js';
import { makeDefaultDeps } from '../testing/index.js';

function agentFor(
  pipeline: boolean,
  streamMode: 'full' | 'final' = 'full',
  finalAnswer = 'Final answer',
  maxIterations = 3,
  roundText = ['Let me check. ', 'Checking again. '],
): SmartAgent {
  const client: IMcpClient = {
    async listTools() {
      return {
        ok: true,
        value: [{ name: 'check', description: 'Check', inputSchema: {} }],
      };
    },
    async callTool() {
      return { ok: true, value: { content: 'checked' } };
    },
  };
  const { deps } = makeDefaultDeps({
    mcpClients: [client],
    llmResponses: [
      {
        content: roundText[0],
        toolCalls: [{ id: 'a', name: 'check', arguments: { round: 1 } }],
        finishReason: 'tool_calls',
      },
      {
        content: roundText[1],
        toolCalls: [{ id: 'b', name: 'check', arguments: { round: 2 } }],
        finishReason: 'tool_calls',
      },
      { content: finalAnswer, finishReason: 'stop' },
    ],
  });
  const config: SmartAgentConfig = {
    maxIterations,
    streamMode,
    heartbeatIntervalMs: 0,
    refreshToolsPerIteration: false,
  };
  if (pipeline) {
    const implementation = new DefaultPipeline();
    implementation.initialize({ ...deps, agentConfig: config });
    deps.pipeline = implementation;
  }
  return new SmartAgent(deps, config);
}

for (const pipeline of [false, true]) {
  for (const mode of ['full', 'final'] as const) {
    test(`process returns only the final iteration (pipeline=${pipeline}, mode=${mode})`, async () => {
      const result = await agentFor(pipeline, mode).process('check twice');
      assert.ok(result.ok);
      assert.equal(result.value.content, 'Final answer');
      assert.equal(result.value.toolCallCount, 2);
    });

    test(`stream classifies tool rounds and honours mode (pipeline=${pipeline}, mode=${mode})`, async () => {
      const text: string[] = [];
      const ends: string[] = [];
      const partials: StreamChunk[] = [];
      for await (const chunk of agentFor(pipeline, mode).streamProcess(
        'check',
        {
          onPartial: (event) => partials.push(event),
        },
      )) {
        assert.ok(chunk.ok);
        if (chunk.value.content && !chunk.value.ephemeral)
          text.push(chunk.value.content);
        if (chunk.value.iterationEnd) ends.push(chunk.value.iterationEnd);
      }
      assert.deepEqual(ends, ['tool_calls', 'tool_calls', 'final']);
      assert.deepEqual(
        text,
        mode === 'full'
          ? ['Let me check. ', 'Checking again. ', 'Final answer']
          : ['Final answer'],
      );
      assert.deepEqual(
        partials
          .filter((chunk) => chunk.kind === 'iteration-end')
          .map((chunk) => chunk.outcome),
        ends,
      );
    });

    test(`empty final iteration discards progress (pipeline=${pipeline}, mode=${mode})`, async () => {
      const result = await agentFor(pipeline, mode, '').process('check');
      assert.ok(result.ok);
      assert.equal(result.value.content, '');
    });

    test(`iteration limit preserves fallback text (pipeline=${pipeline}, mode=${mode})`, async () => {
      const result = await agentFor(pipeline, mode, '', 2).process('check');
      assert.ok(result.ok);
      assert.equal(result.value.content, 'Let me check. Checking again. ');
    });

    test(`cooperative stop preserves progress fallback (pipeline=${pipeline}, mode=${mode})`, async () => {
      const stop = new AbortController();
      const result = await agentFor(pipeline, mode).process('check', {
        stopSignal: stop.signal,
        onToolCallCount(count) {
          if (count === 2) stop.abort();
        },
      });
      assert.ok(result.ok);
      assert.equal(result.value.content, 'Let me check. Checking again. ');
      assert.equal(result.value.stopped, true);
    });
  }

  test(`task board stores only the worker final answer (pipeline=${pipeline})`, async () => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const board = new TaskBoard({
      workers: new Map([
        ['worker', new SmartAgentSubAgent('worker', agentFor(pipeline))],
      ]),
      onEvent(event) {
        if (event.kind === 'done' || event.kind === 'failed') finish();
      },
    });
    try {
      const task = board.start({ worker: 'worker', goal: 'check' });
      assert.ok(task.ok);
      await done;
      assert.equal(board.get(task.value.id)?.output, 'Final answer');
    } finally {
      await board.stopAll();
    }
  });

  test(`dialogue stores and displays only the coordinator final answer (pipeline=${pipeline})`, async () => {
    const store = new InMemoryDialogueStateStore();
    let receive!: () => void;
    const received = new Promise<void>((resolve) => {
      receive = resolve;
    });
    let finishWorker!: (result: { output: string }) => void;
    const workerResult = new Promise<{ output: string }>((resolve) => {
      finishWorker = resolve;
    });
    let calls = 0;
    const session = await DialogueSession.open({
      id: 'final-iteration',
      store,
      maxCorrections: 0,
      board: {
        workers: new Map([
          [
            'worker',
            {
              name: 'worker',
              capabilities: { contextPolicy: 'optional' },
              run() {
                return workerResult;
              },
            },
          ],
        ]),
      },
      onMessage() {
        receive();
      },
      planner: {
        async process(messages, options) {
          if (calls++ === 0) {
            const tools = new PlannerToolsClient();
            await tools.callTool('plan_update', { plan: 'check' });
            await tools.callTool('delegate_task', {
              worker: 'worker',
              goal: 'check',
            });
          }
          return agentFor(pipeline).process(messages, options);
        },
      },
    });
    const deltas: string[] = [];
    try {
      const reply = await session.send('check', {
        onPartial(chunk) {
          if (chunk.kind === 'content') deltas.push(chunk.delta);
        },
      });
      assert.equal(reply.text, 'Final answer');
      assert.equal(deltas.join(''), pipeline ? 'Final answer' : '');
      assert.equal(
        session.snapshot().conversation.at(-2)?.content,
        'Final answer',
      );
      const saved = await store.load('final-iteration');
      assert.equal(saved?.conversation.at(-2)?.content, 'Final answer');
      finishWorker({ output: 'done' });
      await received;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        (await store.load('final-iteration'))?.pending.at(-1)?.text,
        'Final answer',
      );
      assert.equal(session.takePending().at(-1)?.text, 'Final answer');
    } finally {
      await session.close();
    }
  });
}

test('dialogue discards tool-round partials before displaying the final iteration', async () => {
  const session = await DialogueSession.open({
    id: 'interrupted-final',
    maxCorrections: 0,
    board: { workers: new Map() },
    planner: {
      async process(_messages, options) {
        options?.onPartial?.({ kind: 'content', delta: 'Progress' });
        options?.onPartial?.({ kind: 'iteration-end', outcome: 'tool_calls' });
        options?.onPartial?.({ kind: 'content', delta: 'Answer' });
        options?.onPartial?.({ kind: 'iteration-end', outcome: 'final' });
        return { ok: true, value: { content: 'Answer' } };
      },
    },
  });
  const deltas: string[] = [];
  try {
    assert.equal(
      (
        await session.send('go', {
          onPartial(chunk) {
            if (chunk.kind === 'content') deltas.push(chunk.delta);
          },
        })
      ).text,
      'Answer',
    );
    assert.deepEqual(deltas, ['Answer']);
  } finally {
    await session.close();
  }
});

function validationAgent(
  pipeline: boolean,
  streamMode: 'full' | 'final',
): SmartAgent {
  const { deps } = makeDefaultDeps({
    mcpClients: [],
    llmResponses: [
      { content: 'Rejected A', finishReason: 'stop' },
      { content: 'Accepted B', finishReason: 'stop' },
    ],
    outputValidator: {
      async validate(content) {
        return {
          ok: true,
          value: { valid: content === 'Accepted B', reason: 'Try again' },
        };
      },
    },
  });
  const config: SmartAgentConfig = {
    maxIterations: 3,
    streamMode,
    heartbeatIntervalMs: 0,
  };
  if (pipeline) {
    const implementation = new DefaultPipeline();
    implementation.initialize({ ...deps, agentConfig: config });
    deps.pipeline = implementation;
  }
  return new SmartAgent(deps, config);
}

for (const pipeline of [false, true]) {
  for (const mode of ['full', 'final'] as const) {
    test(`validation retry discards rejected answer (pipeline=${pipeline}, mode=${mode})`, async () => {
      const result = await validationAgent(pipeline, mode).process('go');
      assert.ok(result.ok);
      assert.equal(result.value.content, 'Accepted B');
      const worker = new SmartAgentSubAgent(
        'worker',
        validationAgent(pipeline, mode),
      );
      assert.equal((await worker.run({ task: 'go' })).output, 'Accepted B');
      const content: string[] = [];
      const boundaries: string[] = [];
      for await (const chunk of validationAgent(pipeline, mode).streamProcess(
        'go',
      )) {
        assert.ok(chunk.ok);
        if (chunk.value.content && !chunk.value.ephemeral)
          content.push(chunk.value.content);
        if (chunk.value.iterationEnd) boundaries.push(chunk.value.iterationEnd);
      }
      assert.deepEqual(boundaries, ['retry', 'final']);
      assert.equal(
        content.join(''),
        mode === 'final' ? 'Accepted B' : 'Rejected AAccepted B',
      );
    });

    test(`dialogue discards validation retry partials (pipeline=${pipeline}, mode=${mode})`, async () => {
      const session = await DialogueSession.open({
        id: 'validation-retry',
        maxCorrections: 0,
        board: { workers: new Map() },
        planner: validationAgent(pipeline, mode),
      });
      const content: string[] = [];
      try {
        const reply = await session.send('go', {
          onPartial(chunk) {
            if (chunk.kind === 'content') content.push(chunk.delta);
          },
        });
        assert.equal(reply.text, 'Accepted B');
        assert.equal(content.join(''), pipeline ? 'Accepted B' : '');
        assert.equal(
          session.snapshot().conversation.at(-2)?.content,
          'Accepted B',
        );
      } finally {
        await session.close();
      }
    });
  }
}

test('dialogue forwards worker events live without changing coordinator reply buffers', async () => {
  const events: StreamChunk[] = [];
  const session = await DialogueSession.open({
    id: 'worker-boundaries',
    maxCorrections: 0,
    board: { workers: new Map() },
    planner: {
      async process(_messages, options) {
        options?.onPartial?.({ kind: 'content', delta: 'Coordinator ' });
        options?.onPartial?.({
          kind: 'content',
          nodeId: 'worker',
          delta: 'Worker',
        });
        options?.onPartial?.({
          kind: 'iteration-end',
          nodeId: 'worker',
          outcome: 'tool_calls',
        });
        options?.onPartial?.({
          kind: 'iteration-end',
          nodeId: 'worker',
          outcome: 'retry',
        });
        options?.onPartial?.({
          kind: 'iteration-end',
          nodeId: 'worker',
          outcome: 'final',
        });
        options?.onPartial?.({ kind: 'content', delta: 'answer' });
        options?.onPartial?.({ kind: 'iteration-end', outcome: 'final' });
        return { ok: true, value: { content: 'Coordinator answer' } };
      },
    },
  });
  try {
    const reply = await session.send('go', {
      onPartial(chunk) {
        events.push(chunk);
      },
    });
    assert.equal(reply.text, 'Coordinator answer');
    assert.deepEqual(
      events.filter((chunk) => chunk.kind === 'content'),
      [
        { kind: 'content', nodeId: 'worker', delta: 'Worker' },
        { kind: 'content', delta: 'Coordinator ' },
        { kind: 'content', delta: 'answer' },
      ],
    );
    assert.equal(
      session.snapshot().conversation.at(-2)?.content,
      'Coordinator answer',
    );
  } finally {
    await session.close();
  }
});

function resetAgent(
  pipeline: boolean,
  streamMode: 'full' | 'final',
): SmartAgent {
  const { deps } = makeDefaultDeps({ mcpClients: [] });
  deps.mainLlm.streamChat = async function* (): ReturnType<ILlm['streamChat']> {
    yield { ok: true, value: { content: 'Abandoned' } };
    yield { ok: true, value: { content: '', reset: true } };
    yield { ok: true, value: { content: 'Replacement', finishReason: 'stop' } };
  };
  const config: SmartAgentConfig = {
    maxIterations: 5,
    streamMode,
    heartbeatIntervalMs: 0,
  };
  if (pipeline) {
    const implementation = new DefaultPipeline();
    implementation.initialize({ ...deps, agentConfig: config });
    deps.pipeline = implementation;
  }
  return new SmartAgent(deps, config);
}

for (const pipeline of [false, true]) {
  for (const mode of ['full', 'final'] as const) {
    test(`provider reset discards abandoned reply (pipeline=${pipeline}, mode=${mode})`, async () => {
      const result = await resetAgent(pipeline, mode).process('go');
      assert.ok(result.ok);
      assert.equal(result.value.content, 'Replacement');
      const boundaries: string[] = [];
      const partials: StreamChunk[] = [];
      for await (const chunk of resetAgent(pipeline, mode).streamProcess('go', {
        onPartial: (event) => partials.push(event),
      })) {
        assert.ok(chunk.ok);
        if (chunk.value.iterationEnd) boundaries.push(chunk.value.iterationEnd);
      }
      assert.deepEqual(boundaries, ['retry', 'final']);
      assert.deepEqual(
        partials
          .filter((event) => event.kind === 'iteration-end')
          .map((event) => event.outcome),
        boundaries,
      );
      const session = await DialogueSession.open({
        id: 'provider-reset',
        maxCorrections: 0,
        board: { workers: new Map() },
        planner: resetAgent(pipeline, mode),
      });
      const displayed: string[] = [];
      try {
        const reply = await session.send('go', {
          onPartial(event) {
            if (event.kind === 'content') displayed.push(event.delta);
          },
        });
        assert.equal(reply.text, 'Replacement');
        assert.equal(displayed.join(''), pipeline ? 'Replacement' : '');
      } finally {
        await session.close();
      }
    });

    test(`final boundary commits validated content (pipeline=${pipeline}, mode=${mode})`, async () => {
      let pending = '';
      const committed: string[] = [];
      let partialPending = '';
      const partialCommitted: string[] = [];
      for await (const chunk of validationAgent(pipeline, mode).streamProcess(
        'go',
        {
          onPartial(event) {
            if (event.kind === 'content') partialPending += event.delta;
            if (event.kind === 'iteration-end') {
              if (event.outcome === 'final')
                partialCommitted.push(partialPending);
              partialPending = '';
            }
          },
        },
      )) {
        assert.ok(chunk.ok);
        if (!chunk.value.ephemeral) pending += chunk.value.content;
        if (chunk.value.iterationEnd) {
          if (chunk.value.iterationEnd === 'final') committed.push(pending);
          pending = '';
        }
      }
      assert.deepEqual(committed, ['Accepted B']);
      assert.equal(pending, '');
      if (pipeline) assert.deepEqual(partialCommitted, ['Accepted B']);
      assert.equal(partialPending, '');
    });
  }
}

for (const mode of ['full', 'final'] as const) {
  for (const hook of [false, true]) {
    test(`legacy final boundary follows wrapped and hook content (mode=${mode}, hook=${hook})`, async () => {
      const { deps } = makeDefaultDeps({
        mcpClients: [],
        llmResponses: [{ content: 'Answer', finishReason: 'stop' }],
      });
      deps.clientAdapters = [
        {
          name: 'test',
          detect: () => true,
          wrapResponse: (content) => `[${content}]`,
        },
      ];
      const agent = new SmartAgent(deps, {
        maxIterations: 5,
        streamMode: mode,
        heartbeatIntervalMs: 0,
        ...(hook
          ? {
              async *onBeforeStream() {
                yield 'First';
                yield 'Second';
              },
            }
          : {}),
      });
      let pending = '';
      const committed: string[] = [];
      const partialCommits: string[] = [];
      for await (const chunk of agent.streamProcess(
        [
          { role: 'system', content: 'adapter' },
          { role: 'user', content: 'go' },
        ],
        {
          onPartial(event) {
            if (event.kind === 'iteration-end' && event.outcome === 'final') {
              partialCommits.push(pending);
            }
          },
        },
      )) {
        assert.ok(chunk.ok);
        if (!chunk.value.ephemeral) pending += chunk.value.content;
        if (chunk.value.iterationEnd === 'final') committed.push(pending);
      }
      const expected = hook ? '[First][Second]' : '[Answer]';
      assert.deepEqual(committed, [expected]);
      assert.deepEqual(partialCommits, [expected]);
      assert.equal(pending, expected);
    });
  }
}

// The legacy loop (pipeline=false) keeps its released stop fallback; the hub uses the pipeline.
for (const pipeline of [true]) {
  for (const roundText of [
    ['Thinking in English.', 'Waiting for the result.'],
    ['Work started.', ''],
  ]) {
    test(`dialogue stop keeps the latest non-empty reply (${roundText[0]}, pipeline=${pipeline})`, async () => {
      const agent = agentFor(pipeline, 'full', '', 3, roundText);
      const expected = roundText[1] || roundText[0];
      const session = await DialogueSession.open({
        id: 'waiting-fallback',
        maxCorrections: 0,
        board: { workers: new Map() },
        planner: {
          async process(messages, options) {
            const stop = new AbortController();
            return agent.process(messages, {
              ...options,
              stopSignal: stop.signal,
              onToolCallCount(count) {
                if (count === 2) stop.abort();
              },
            });
          },
        },
      });
      const displayed: string[] = [];
      try {
        const reply = await session.send('go', {
          onPartial(chunk) {
            if (chunk.kind === 'content') displayed.push(chunk.delta);
          },
        });
        assert.equal(reply.text, expected);
        assert.ok(!reply.text.includes('Thinking in English.'));
        // Live display is asserted for the pipeline path the hub uses; the
        // legacy loop keeps its released partial behaviour.
        if (pipeline) {
          assert.equal(displayed.join(''), expected);
          assert.ok(!displayed.join('').includes('Thinking in English.'));
        }
      } finally {
        await session.close();
      }
    });
  }
}
