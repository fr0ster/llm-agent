import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type ICoordinatorContext,
  type ILlm,
  McpError,
  type Message,
  TokenLedger,
  type ToolRound,
} from '@mcp-abap-adt/llm-agent';
import ts from 'typescript';
import { SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { SelfDispatch } from '../coordinator/dispatch/self.js';
import { CyclicReActExecutor } from '../coordinator/stepper/cyclic-react-executor.js';
import { LegacyAccumulateContextStrategy } from '../pipeline/context/tool-loop-context/index.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { makeDefaultDeps, testCallOptions } from '../testing/index.js';

const tool = { name: 'Work', description: 'Work', inputSchema: {} };

// Compile the actual baseline in memory; no checkout or temporary files.
async function mainSelfDispatch(): Promise<typeof SelfDispatch> {
  const sourceUrl = new URL('../coordinator/dispatch/self.ts', import.meta.url);
  const require = createRequire(sourceUrl);
  const source = execFileSync(
    'git',
    [
      'show',
      'origin/main:packages/llm-agent-libs/src/coordinator/dispatch/self.ts',
    ],
    { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' },
  );
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace(/from '([^']+)'/g, (_match, specifier: string) => {
      const resolved = specifier.startsWith('.')
        ? new URL(specifier.replace(/\.js$/, '.ts'), sourceUrl).href
        : pathToFileURL(require.resolve(specifier)).href;
      return `from '${resolved}'`;
    });
  const baseline = (await import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
  )) as { SelfDispatch: typeof SelfDispatch };
  return baseline.SelfDispatch;
}

test('self: terminal exceptions match the real origin/main SelfDispatch', async () => {
  const baseline = await mainSelfDispatch();
  for (const Dispatch of [baseline, SelfDispatch]) {
    const failure = new McpError('TERMINAL_SENTINEL', 'MCP_NOT_CONNECTED');
    const executed: string[] = [];
    let calls = 0;
    const llm: ILlm = {
      streamChat() {
        assert.fail('Expected chat');
      },
      async chat() {
        calls++;
        return {
          ok: true,
          value:
            calls === 1
              ? {
                  content: '',
                  finishReason: 'tool_calls',
                  toolCalls: ['Fail', 'Later'].map((name) => ({
                    id: name,
                    name,
                    arguments: {},
                  })),
                }
              : { content: 'INCORRECT_SUCCESS', finishReason: 'stop' },
        };
      },
    };
    const ctx: ICoordinatorContext = {
      ...testCallOptions(),
      inputText: 'work',
      registry: new Map(),
      stepResults: {},
      selectedTools: [tool],
      async callTool(name) {
        executed.push(name);
        if (name === 'Fail') throw failure;
        return 'SIDE_EFFECT';
      },
    };
    const result = await new Dispatch(llm).dispatch(
      { id: 's1', goal: 'work', status: 'pending' },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, failure.message);
    assert.equal(result.output, '');
    assert.equal(calls, 1);
    assert.deepEqual(executed, ['Fail']);
    assert.equal(ctx.toolCallCount, 1);
  }
});

for (const pipeline of [false, true]) {
  for (const heartbeatIntervalMs of [0, 60_000]) {
    test(`${pipeline ? 'pipeline' : 'direct'}: terminal throw does not wait for a never-resolving sibling (heartbeat=${heartbeatIntervalMs})`, async () => {
      const failure = new McpError('TERMINAL_SENTINEL', 'MCP_NOT_CONNECTED');
      const executed: string[] = [];
      const signal = new AbortController().signal;
      const { deps, llm } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        llmResponses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: ['Fail', 'Hang'].map((name) => ({
              id: name,
              name,
              arguments: {},
            })),
          },
        ],
        mcpClients: [
          {
            async listTools() {
              return {
                ok: true,
                value: ['Fail', 'Hang'].map((name) => ({ ...tool, name })),
              };
            },
            async callTool(name, _args, options) {
              assert.equal(options?.signal, signal);
              executed.push(name);
              if (name === 'Fail') throw failure;
              return new Promise<never>(() => {});
            },
          },
        ],
      });
      const config = { refreshToolsPerIteration: false, heartbeatIntervalMs };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      let settled = false;
      const observed = new SmartAgent(deps, config)
        .process('work', testCallOptions({ signal }))
        .then(
          (result) => {
            settled = true;
            assert.ok(pipeline);
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.error, failure);
          },
          (error: Error) => {
            settled = true;
            assert.equal(pipeline, false);
            assert.equal(error, failure);
          },
        );
      // The real components use promises only here. Drain a complete microtask
      // turn without a wall-clock deadline or releasing the hanging sibling.
      await setImmediate();
      assert.equal(settled, true);
      await observed;
      assert.deepEqual(executed, ['Fail', 'Hang']);
      assert.equal(llm.callCount, 1);
      assert.equal(
        signal.aborted,
        false,
        'origin/main did not abort sibling calls',
      );
    });
  }
}

for (const pipeline of [false, true]) {
  for (const thrown of [false, true]) {
    test(`${pipeline ? 'pipeline' : 'direct'}: origin/main terminal MCP contract (thrown=${thrown})`, async () => {
      const failure = new McpError('UNAVAILABLE_SENTINEL', 'MCP_NOT_CONNECTED');
      const rounds: ToolRound[] = [];
      const strategy = new LegacyAccumulateContextStrategy();
      const record = strategy.record.bind(strategy);
      strategy.record = async (round) => {
        rounds.push(structuredClone(round));
        await record(round);
      };
      const { deps, llm } = makeDefaultDeps({
        assembler: new ContextAssembler(),
        llmResponses: [
          {
            content: 'REQUEST',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call', name: 'Work', arguments: {} }],
          },
          { content: 'INCORRECT_SUCCESS' },
        ],
        mcpClients: [
          {
            async listTools() {
              return { ok: true, value: [tool] };
            },
            async callTool() {
              if (thrown) throw failure;
              return { ok: false, error: failure };
            },
          },
        ],
      });
      deps.toolLoopContextStrategyFactory = () => strategy;
      const config = { refreshToolsPerIteration: false };
      if (pipeline) {
        const flow = new DefaultPipeline();
        flow.initialize({ ...deps, agentConfig: config });
        deps.pipeline = flow;
      }
      const run = () =>
        new SmartAgent(deps, config).process('work', testCallOptions());
      // origin/main core awaited rejected call promises without converting them:
      // throws retain their identity; returned availability errors are escalated.
      if (thrown && !pipeline) {
        await assert.rejects(run, (error) => error === failure);
      } else {
        const result = await run();
        assert.equal(result.ok, false);
        if (!result.ok) {
          if (thrown) assert.equal(result.error, failure);
          else assert.equal(result.error.code, 'MCP_UNAVAILABLE');
        }
      }
      assert.equal(failure.code, 'MCP_NOT_CONNECTED');
      assert.equal(
        llm.callCount,
        1,
        'terminal failures must never trigger another LLM call',
      );
      assert.equal(rounds.length, thrown ? 0 : 1);
      if (!thrown)
        assert.deepEqual(
          rounds[0].results.map((message) => message.tool_call_id),
          rounds[0].assistant.tool_calls?.map((call) => call.id),
        );
    });
  }
}

for (const failure of [
  new McpError('UNAVAILABLE_SENTINEL', 'MCP_NOT_CONNECTED'),
  new Error('UNEXPECTED_SENTINEL'),
]) {
  test(`cyclic: origin/main propagates ${failure.name} unchanged after one LLM call`, async () => {
    const inputs: Message[][] = [];
    const llm: ILlm = {
      async chat(messages) {
        inputs.push(structuredClone(messages));
        assert.ok(inputs.length <= 2);
        if (inputs.length === 2)
          return {
            ok: true,
            value: { content: 'INCORRECT_SUCCESS', finishReason: 'stop' },
          };
        assert.ok(
          messages.some((message) => String(message.content).includes('work')),
        );
        return {
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'cyclic-call', name: 'Work', arguments: {} }],
          },
        };
      },
      async *streamChat() {},
    };
    const executor = new CyclicReActExecutor({
      llm,
      component: 'tool-loop',
      async callMcp() {
        throw failure;
      },
    });
    // origin/main called callMcp without a catch: every thrown bridge failure
    // left execute(), including its type/code. Normal tool failures are text.
    await assert.rejects(
      () =>
        executor.execute({
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
        }),
      (error) => error === failure,
    );
    assert.equal(inputs.length, 1);
  });
}
