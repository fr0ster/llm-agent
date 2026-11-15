import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { unwrapBuilderResult } from '../builder-types.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import {
  makeDefaultDeps,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

function scenario() {
  let rounds = 0;
  let toolCalls = 0;
  const llm: ILlm = {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      throw new Error('The scenario uses streaming');
    },
    async *streamChat(
      _messages: Message[],
      tools?: LlmTool[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      rounds++;
      if (rounds <= 12 && tools?.length) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: Array.from({ length: 3 }, (_, index) => ({
              index,
              id: `call-${rounds}-${index}`,
              name: tools[0].name,
              arguments: JSON.stringify({ round: rounds, index }),
            })),
            finishReason: 'tool_calls',
          },
        };
      } else {
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      }
    },
  };
  const client = {
    async listTools() {
      return {
        ok: true as const,
        value: [{ name: 'Work', description: 'Work', inputSchema: {} }],
      };
    },
    async callTool() {
      toolCalls++;
      return { ok: true as const, value: { content: 'completed' } };
    },
  };
  return { llm, client, rounds: () => rounds, toolCalls: () => toolCalls };
}

for (const field of ['maxIterations', 'maxToolCalls'] as const) {
  test(`builder normalizes ${field} with the shared rules`, async () => {
    const run = scenario();
    const withLimit = (value?: number | string | null) => {
      const builder = new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRequestAccess)
        .withMainLlm(run.llm);
      return field === 'maxIterations'
        ? builder.withMaxIterations(value)
        : builder.withMaxToolCalls(value);
    };
    for (const value of [
      undefined,
      null,
      Infinity,
      2,
      '2',
      ...(field === 'maxToolCalls' ? [0, '0'] : []),
    ]) {
      const handle = await withLimit(value).build().then(unwrapBuilderResult);
      try {
        assert.equal(
          handle.agent.getAgentConfig()[field],
          value == null || value === Infinity ? undefined : Number(value),
        );
      } finally {
        await handle.close();
      }
    }
    for (const value of [
      ...(field === 'maxIterations' ? [0, '0'] : []),
      -1,
      1.5,
      -Infinity,
      'Infinity',
      NaN,
      'abc',
      '',
    ]) {
      assert.throws(() => withLimit(value), new RegExp(`${field}.*integer`));
    }
  });
}

for (const maxIterations of [undefined, Infinity]) {
  test(`direct SmartAgent with maxIterations ${maxIterations} runs unlimited`, async () => {
    const run = scenario();
    const { deps } = makeDefaultDeps({
      mcpClients: [run.client],
      ragStores: {
        tools: makeRag([
          { text: 'Work', score: 1, metadata: { id: 'tool:Work' } },
        ]),
      },
    });
    const agent = new SmartAgent(
      { ...deps, mainLlm: run.llm },
      { maxIterations },
    );
    assert.equal(agent.getAgentConfig().maxIterations, undefined);
    const result = await agent.process('complete the work', testCallOptions());
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.content, 'done');
    assert.equal(run.rounds(), 13);
    assert.equal(run.toolCalls(), 36);
  });
}

for (const field of ['maxIterations', 'maxToolCalls'] as const) {
  test(`builder with ${field} Infinity runs unlimited`, async () => {
    const run = scenario();
    const builder = new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(run.llm)
      .withMcpClients([run.client])
      .setToolsRag(
        makeRag([{ text: 'Work', score: 1, metadata: { id: 'tool:Work' } }]),
      );
    if (field === 'maxIterations') builder.withMaxIterations(Infinity);
    else builder.withMaxToolCalls(Infinity);
    const handle = await builder.build().then(unwrapBuilderResult);
    try {
      assert.equal(handle.agent.getAgentConfig()[field], undefined);
      assert.equal(handle.agent.maxToolCalls, undefined);
      const result = await handle.agent.process(
        'complete the work',
        testCallOptions(),
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value.content, 'done');
        assert.ok(!result.value.budgetExhausted);
      }
      assert.equal(run.rounds(), 13);
      assert.equal(run.toolCalls(), 36);
    } finally {
      await handle.close();
    }
  });
}

for (const pipeline of [false, true]) {
  for (const limit of ['default', 'iterations', 'tools'] as const) {
    test(`${pipeline ? 'standalone DefaultPipeline' : 'default build'}: ${limit} tool-loop limits`, async () => {
      const run = scenario();
      const toolsRag = makeRag([
        { text: 'Work', score: 1, metadata: { id: 'tool:Work' } },
      ]);
      const builder = new SmartAgentBuilder({ skipModelValidation: true })
        .withRagAccess(testRequestAccess)
        .withMainLlm(run.llm)
        .withMcpClients([run.client])
        .setToolsRag(toolsRag);
      if (limit === 'iterations') builder.withMaxIterations(10);
      if (limit === 'tools') builder.withMaxToolCalls(30);
      const handle = await builder.build().then(unwrapBuilderResult);
      try {
        const chunks: LlmStreamChunk[] = [];
        if (pipeline) {
          const standalone = new DefaultPipeline();
          standalone.initialize({
            mainLlm: run.llm,
            toolsRag,
            mcpClients: [run.client],
            ragAccess: testRequestAccess,
            ...(limit === 'default'
              ? {}
              : {
                  agentConfig: {
                    maxIterations: limit === 'iterations' ? 10 : undefined,
                    ...(limit === 'tools' ? { maxToolCalls: 30 } : {}),
                  },
                }),
          });
          const result = await standalone.execute(
            'complete the work',
            [],
            testCallOptions(),
            (chunk) => {
              assert.equal(chunk.ok, true);
              if (chunk.ok) chunks.push(chunk.value);
            },
          );
          assert.equal(result.error, undefined);
        } else {
          assert.equal(
            handle.agent.getAgentConfig().maxIterations,
            limit === 'iterations' ? 10 : undefined,
          );
          assert.equal(
            handle.agent.maxToolCalls,
            limit === 'tools' ? 30 : undefined,
          );
          for await (const chunk of handle.agent.streamProcess(
            'complete the work',
            testCallOptions(),
          )) {
            assert.equal(chunk.ok, true);
            if (chunk.ok) chunks.push(chunk.value);
          }
        }
        if (limit === 'default') {
          assert.equal(run.rounds(), 13);
          assert.equal(run.toolCalls(), 36);
          assert.ok(chunks.some((chunk) => chunk.content === 'done'));
          assert.ok(chunks.every((chunk) => !chunk.budgetExhausted));
        } else if (limit === 'iterations') {
          assert.equal(run.rounds(), 10);
          assert.equal(run.toolCalls(), 30);
          assert.equal(chunks.at(-1)?.finishReason, 'length');
        } else {
          assert.equal(run.rounds(), 11);
          assert.equal(run.toolCalls(), 30);
          const exhausted = chunks.find((chunk) => chunk.budgetExhausted);
          assert.ok(exhausted);
          assert.equal(exhausted.maxToolCalls, 30);
          assert.equal(exhausted.toolCallCount, 30);
        }
      } finally {
        await handle.close();
      }
    });
  }
}

for (const limit of ['both', 'iterations', 'tools', 'reset'] as const) {
  test(`builder pipeline reads runtime ${limit} limits`, async () => {
    const run = scenario();
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRequestAccess)
      .withMainLlm(run.llm)
      .withMcpClients([run.client])
      .setToolsRag(
        makeRag([{ text: 'Work', score: 1, metadata: { id: 'tool:Work' } }]),
      )
      .build()
      .then(unwrapBuilderResult);
    try {
      handle.agent.applyConfigUpdate({ maxIterations: 1, maxToolCalls: 1 });
      if (limit === 'iterations') {
        handle.agent.applyConfigUpdate({ maxToolCalls: null });
      } else if (limit === 'tools') {
        handle.agent.applyConfigUpdate({ maxIterations: null });
      } else if (limit === 'reset') {
        handle.agent.applyConfigUpdate({
          maxIterations: null,
          maxToolCalls: null,
        });
      }
      const result = await handle.agent.process(
        'complete the work',
        testCallOptions(),
      );
      assert.equal(result.ok, true);
      assert.equal(
        run.rounds(),
        limit === 'reset' ? 13 : limit === 'tools' ? 2 : 1,
      );
      assert.equal(
        run.toolCalls(),
        limit === 'reset' ? 36 : limit === 'iterations' ? 3 : 1,
      );
      if (result.ok && (limit === 'both' || limit === 'tools')) {
        assert.equal(result.value.budgetExhausted, true);
        assert.equal(result.value.toolCallCount, 1);
        assert.equal(result.value.maxToolCalls, 1);
      }
    } finally {
      await handle.close();
    }
  });
}
