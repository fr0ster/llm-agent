import assert from 'node:assert/strict';
import { it } from 'node:test';
import type {
  ILlm,
  IMcpClient,
  McpTool,
  RagResult,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { DefaultPipeline } from '../../pipeline/default-pipeline.js';
import {
  makeDefaultDeps,
  makeRag,
  testCallOptions,
} from '../../testing/index.js';
import { ContextAssembler } from '../context-assembler.js';

const action = { type: 'action' as const, text: 'Hi' };
const tools: McpTool[] = [
  {
    name: 'search',
    description: 'Search records',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
];
const facts: RagResult[] = [{ text: 'Fact A', score: 0.9, metadata: {} }];
const toolResults: RagResult[] = [
  {
    text: `Tool: search / Description: ${'Search records. '.repeat(1000)}`,
    score: 0.95,
    metadata: { id: 'tool:search', name: 'search' },
  },
];

for (const maxTokens of [undefined, 7, 1]) {
  it(`excludes the reserved tools store from text and budget (${maxTokens})`, async () => {
    const assembler = new ContextAssembler({
      maxTokens,
      sectionHeaders: { tools: 'Tool Catalogue' },
    });
    const retrieved = {
      // Tools first: counting them would evict facts before removing tools.
      ragResults: { tools: toolResults, facts },
      tools: structuredClone(tools),
    };
    const original = structuredClone(retrieved);
    const result = await assembler.assemble(action, retrieved, []);
    const baseline = await assembler.assemble(
      action,
      { ragResults: { facts }, tools: [] },
      [],
    );
    assert.ok(result.ok);
    assert.ok(baseline.ok);
    assert.deepEqual(result.value, baseline.value);
    assert.deepEqual(retrieved, original);
    const request = result.value.find((message) => message.role === 'user');
    assert.ok(request);
    assert.equal(typeof request.content, 'string');
    assert.ok(request.content !== null);
    assert.ok(!request.content.includes('## Tools'));
    assert.ok(!request.content.includes('Tool Catalogue'));
    assert.ok(!request.content.includes('Tool: search'));
    if (maxTokens !== 1) {
      assert.equal(request.content, '## Known Facts\n- Fact A\n\nHi');
    } else {
      assert.equal(request.content, 'Hi');
    }
  });
}

it('preserves custom text stores and excludes tools even without selected definitions', async () => {
  const result = await new ContextAssembler().assemble(
    action,
    { ragResults: { tools: toolResults, tool_notes: facts }, tools: [] },
    [],
  );
  assert.ok(result.ok);
  const request = result.value.find((message) => message.role === 'user');
  assert.ok(request);
  assert.equal(request.content, '## Tool Notes\n- Fact A\n\nHi');
});

for (const pipeline of [false, true]) {
  it(`offers unchanged definitions without tools text (pipeline=${pipeline})`, async () => {
    const client: IMcpClient = {
      async listTools() {
        return { ok: true, value: structuredClone(tools) };
      },
      async callTool() {
        return { ok: true, value: { content: 'done' } };
      },
    };
    const { deps, llm } = makeDefaultDeps({
      assembler: new ContextAssembler(),
      mcpClients: [client],
      ragStores: {
        tools: makeRag(toolResults),
        facts: makeRag(facts),
      },
    });
    let calls = 0;
    const verifyRequest = (
      messages: Parameters<ILlm['chat']>[0],
      offeredTools: Parameters<ILlm['chat']>[1],
    ): void => {
      calls++;
      assert.deepEqual(offeredTools, tools);
      const text = messages.map((message) => message.content ?? '').join('\n');
      assert.ok(text.includes('## Known Facts\n- Fact A'));
      assert.ok(!text.includes('## Tools'));
      assert.ok(!text.includes('Tool: search'));
    };
    const capturingLlm: ILlm = {
      ...llm,
      async chat(messages, offeredTools, options) {
        verifyRequest(messages, offeredTools);
        return llm.chat(messages, offeredTools, options);
      },
      async *streamChat(messages, offeredTools, options) {
        verifyRequest(messages, offeredTools);
        yield* llm.streamChat(messages, offeredTools, options);
      },
    };
    deps.mainLlm = capturingLlm;
    const config = { maxIterations: 1 };
    if (pipeline) {
      const implementation = new DefaultPipeline();
      implementation.initialize({ ...deps, agentConfig: config });
      deps.pipeline = implementation;
    }
    const result = await new SmartAgent(deps, config).process(
      'Search records',
      testCallOptions(),
    );
    assert.ok(result.ok);
    assert.equal(calls, 1);
  });
}
