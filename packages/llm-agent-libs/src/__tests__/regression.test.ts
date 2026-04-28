import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AssemblerError,
  CallOptions,
  IContextAssembler,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  McpTool,
  Message,
  RagResult,
  Result,
  Subprompt,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import {
  makeClassifier,
  makeDefaultDeps,
  makeLlm,
  makeMcpClient,
  makeMetadataRag,
  makeRag,
} from '../testing/index.js';

const DEFAULT_CONFIG = { maxIterations: 5 };

// Classifier regression tests for fact/feedback/state upsert removed in 6.0.0
// (RagUpsertHandler removed — consumers now own RAG upsert via IRag)

// ---------------------------------------------------------------------------
// RAG regression
// ---------------------------------------------------------------------------

describe('Regression — ragQueryK config propagated to all stores', () => {
  it('k=2 passed to all three RAG query calls', async () => {
    const facts = makeMetadataRag();
    const feedback = makeMetadataRag();
    const state = makeMetadataRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        { type: 'action', text: 'Find SAP details', context: 'sap-abap' },
      ]),
      ragStores: { facts, feedback, state },
    });
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, ragQueryK: 2 });
    await agent.process('test');
    assert.ok(facts.queryCalls.length > 0);
    assert.equal(facts.queryCalls[0].k, 2);
    assert.equal(feedback.queryCalls[0].k, 2);
    assert.equal(state.queryCalls[0].k, 2);
  });
});

// ---------------------------------------------------------------------------
// Tool loop regression
// ---------------------------------------------------------------------------

describe('Regression — tool call with empty arguments accepted', () => {
  it('tool called with {} args; pipeline succeeds', async () => {
    const client = makeMcpClient(
      [{ name: 'ping', description: 'Ping', inputSchema: {} }],
      new Map([['ping', { content: 'pong' }]]),
    );
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'pinging',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        },
        { content: 'done', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(client.callCount, 1);
    assert.ok(r.value.content.endsWith('done'));
  });
});

describe('Regression — fragmented stream tool arguments are accumulated by index', () => {
  it('assembles partial arguments and executes tool with merged JSON object', async () => {
    let llmCall = 0;
    let capturedArgs: Record<string, unknown> | null = null;
    const streamLlm = {
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        return { ok: true, value: { content: 'unused', finishReason: 'stop' } };
      },
      async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
        llmCall++;
        if (llmCall === 1) {
          yield {
            ok: true,
            value: {
              content: '',
              toolCalls: [
                {
                  index: 0,
                  id: 'c1',
                  name: 'sum',
                  arguments: '{"a":1,',
                },
              ],
            },
          };
          yield {
            ok: true,
            value: {
              content: '',
              toolCalls: [{ index: 0, arguments: '"b":2}' }],
              finishReason: 'tool_calls',
            },
          };
          return;
        }
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      },
    };
    const mcpClient = {
      async listTools() {
        return {
          ok: true as const,
          value: [{ name: 'sum', description: 'sum', inputSchema: {} }],
        };
      },
      async callTool(_name: string, args: Record<string, unknown>) {
        capturedArgs = args;
        return { ok: true as const, value: { content: '3' } };
      },
    };
    const { deps } = makeDefaultDeps({
      mcpClients: [mcpClient],
      llmResponses: [{ content: 'unused', finishReason: 'stop' }],
    });
    deps.mainLlm = streamLlm;
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('sum');
    assert.ok(r.ok);
    assert.deepEqual(capturedArgs, { a: 1, b: 2 });
    assert.ok(r.value.content.endsWith('done'));
  });
});

describe('Regression — duplicate tool name from two clients: first wins', () => {
  it('second client toolA never called', async () => {
    const client1 = makeMcpClient(
      [{ name: 'toolA', description: 'A from client1', inputSchema: {} }],
      new Map([['toolA', { content: 'client1 result' }]]),
    );
    const client2 = makeMcpClient(
      [{ name: 'toolA', description: 'A from client2', inputSchema: {} }],
      new Map([['toolA', { content: 'client2 result' }]]),
    );
    const { deps } = makeDefaultDeps({
      mcpClients: [client1, client2],
      llmResponses: [
        {
          content: 'calling',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'toolA', arguments: {} }],
        },
        { content: 'done', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(client1.callCount, 1, 'client1 should be called');
    assert.equal(client2.callCount, 0, 'client2 should not be called');
  });
});

describe('Regression — multiple tool calls execute in one iteration', () => {
  it('two tool calls execute; toolCallCount=2', async () => {
    const client = makeMcpClient(
      [
        { name: 'blockedTool', description: 'Blocked', inputSchema: {} },
        { name: 'safeTool', description: 'Safe', inputSchema: {} },
      ],
      new Map([
        ['blockedTool', { content: 'should not reach' }],
        ['safeTool', { content: 'safe result' }],
      ]),
    );
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      llmResponses: [
        {
          content: 'calling both',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', name: 'blockedTool', arguments: {} },
            { id: 'c2', name: 'safeTool', arguments: {} },
          ],
        },
        { content: 'done', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(client.callCount, 2, 'both tools should call MCP client');
  });
});

describe('Regression — context assembled once before tool loop', () => {
  it('assembler is called once; tool loop continues without re-assembly', async () => {
    const client = makeMcpClient([
      { name: 'tool', description: 'T', inputSchema: {} },
    ]);
    let assemblerCallCount = 0;
    const flakyAssembler: IContextAssembler = {
      async assemble(
        _action: Subprompt,
        _retrieved: {
          facts: RagResult[];
          feedback: RagResult[];
          state: RagResult[];
          tools: McpTool[];
        },
        _toolResults: ToolCallRecord[],
        _opts?: CallOptions,
      ): Promise<
        import('../../types.js').Message[] extends never
          ? never
          : import('../interfaces/types.js').Result<Message[], AssemblerError>
      > {
        assemblerCallCount++;
        return {
          ok: true,
          value: [{ role: 'user', content: 'action text' }],
        };
      },
    };
    const { deps } = makeDefaultDeps({
      mcpClients: [client],
      assembler: flakyAssembler,
      llmResponses: [
        {
          content: 'calling',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'tool', arguments: {} }],
        },
        { content: 'done', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(assemblerCallCount, 1);
    assert.equal(r.value.stopReason, 'stop');
  });
});

// ---------------------------------------------------------------------------
// SmartAgent config regression
// ---------------------------------------------------------------------------

// sessionPolicy metadata tests removed in 6.0.0
// (RagUpsertHandler removed — sessionPolicy TTL/namespace are consumer responsibilities)

describe('Regression — helperLlm called for history summarization', () => {
  it('helperLlm called when history exceeds summarizeLimit', async () => {
    const helperLlm = makeLlm([
      { content: 'conversation summary', finishReason: 'stop' },
    ]);
    const { deps } = makeDefaultDeps();
    deps.helperLlm = helperLlm;
    const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      historyAutoSummarizeLimit: 5,
    });
    const r = await agent.process(messages);
    assert.ok(r.ok);
    assert.ok(
      helperLlm.callCount >= 1,
      'helperLlm should be called for summarization',
    );
  });
});

// ---------------------------------------------------------------------------
// helperLlm — summarization
// ---------------------------------------------------------------------------

describe('helperLlm — summarization', () => {
  it('helperLlm NOT called when history is within limit', async () => {
    const helperLlm = makeLlm([
      { content: 'should not be called', finishReason: 'stop' },
    ]);
    const { deps } = makeDefaultDeps();
    deps.helperLlm = helperLlm;
    const messages: Message[] = Array.from({ length: 4 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      historyAutoSummarizeLimit: 5,
    });
    const r = await agent.process(messages);
    assert.ok(r.ok);
    assert.equal(
      helperLlm.callCount,
      0,
      'helperLlm should not be called for short history',
    );
  });

  it('summarization skipped gracefully when no helperLlm provided', async () => {
    const { deps } = makeDefaultDeps();
    const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message ${i}`,
    }));
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      historyAutoSummarizeLimit: 5,
    });
    const r = await agent.process(messages);
    assert.ok(r.ok, 'should succeed without helperLlm');
  });
});

// ---------------------------------------------------------------------------
// helperLlm — RAG translation
// ---------------------------------------------------------------------------

describe('helperLlm — RAG translation', () => {
  it('helperLlm called for non-ASCII text translation', async () => {
    const helperLlm = makeLlm([
      { content: 'Show me transaction SE38 information', finishReason: 'stop' },
    ]);
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        {
          type: 'action',
          text: 'Покажи мне информацию о транзакции SE38',
        },
      ]),
      ragStores: { tools: makeRag() },
    });
    deps.helperLlm = helperLlm;
    deps.translateQueryStores = new Set(['tools']);
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
    const r = await agent.process('Покажи мне информацию о транзакции SE38');
    assert.ok(r.ok);
    assert.ok(
      helperLlm.callCount >= 1,
      'helperLlm should be called for non-ASCII translation',
    );
  });

  it('mainLlm used as fallback when no helperLlm for translation', async () => {
    const { deps, llm } = makeDefaultDeps({
      classifier: makeClassifier([
        {
          type: 'action',
          text: 'Покажи мне информацию о транзакции SE38',
        },
      ]),
      llmResponses: [
        {
          content: 'Show me transaction SE38 information',
          finishReason: 'stop',
        },
        { content: 'Here is the info', finishReason: 'stop' },
      ],
      ragStores: { tools: makeRag() },
    });
    deps.translateQueryStores = new Set(['tools']);
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
    const r = await agent.process('Покажи мне информацию о транзакции SE38');
    assert.ok(r.ok);
    assert.ok(
      llm.callCount >= 2,
      'mainLlm should be called for both translation and chat',
    );
  });

  it('translation skipped for ASCII text', async () => {
    const helperLlm = makeLlm([
      { content: 'should not be called', finishReason: 'stop' },
    ]);
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        {
          type: 'action',
          text: 'Show me transaction SE38 information',
        },
      ]),
    });
    deps.helperLlm = helperLlm;
    const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
    const r = await agent.process('Show me transaction SE38 information');
    assert.ok(r.ok);
    assert.equal(
      helperLlm.callCount,
      0,
      'helperLlm should not be called for ASCII text',
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-action merge regression
// ---------------------------------------------------------------------------

describe('Regression — multiple action subprompts merged into one', () => {
  it('two action subprompts → assembler receives merged text containing both', async () => {
    let capturedAction: Subprompt | null = null;
    const capturingAssembler: IContextAssembler = {
      async assemble(
        action: Subprompt,
        _retrieved: {
          facts: RagResult[];
          feedback: RagResult[];
          state: RagResult[];
          tools: McpTool[];
        },
        _history: Message[],
        _opts?: CallOptions,
      ): Promise<Result<Message[], AssemblerError>> {
        capturedAction = action;
        return {
          ok: true,
          value: [{ role: 'user', content: action.text }],
        };
      },
    };
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        {
          type: 'action',
          text: 'Read content of table T100',
          context: 'sap-abap',
          dependency: 'independent',
        },
        {
          type: 'action',
          text: 'Check transport history of table T100',
          context: 'sap-abap',
          dependency: 'sequential',
        },
      ]),
      assembler: capturingAssembler,
      llmResponses: [{ content: 'done', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process(
      'Read table T100 and check its transport history',
    );
    assert.ok(r.ok);
    assert.ok(capturedAction, 'assembler should have been called');
    assert.equal(capturedAction?.type, 'action');
    assert.ok(
      capturedAction?.text.includes('Read content of table T100'),
      'merged text should contain first action',
    );
    assert.ok(
      capturedAction?.text.includes('Check transport history of table T100'),
      'merged text should contain second action',
    );
    assert.equal(capturedAction?.context, 'sap-abap');
  });

  it('single action subprompt → assembler receives original action unchanged', async () => {
    let capturedAction: Subprompt | null = null;
    const capturingAssembler: IContextAssembler = {
      async assemble(
        action: Subprompt,
        _retrieved: {
          facts: RagResult[];
          feedback: RagResult[];
          state: RagResult[];
          tools: McpTool[];
        },
        _history: Message[],
        _opts?: CallOptions,
      ): Promise<Result<Message[], AssemblerError>> {
        capturedAction = action;
        return {
          ok: true,
          value: [{ role: 'user', content: action.text }],
        };
      },
    };
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        {
          type: 'action',
          text: 'Read content of table T100',
          context: 'sap-abap',
          dependency: 'independent',
        },
      ]),
      assembler: capturingAssembler,
      llmResponses: [{ content: 'done', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('Read table T100');
    assert.ok(r.ok);
    assert.ok(capturedAction, 'assembler should have been called');
    assert.equal(capturedAction?.text, 'Read content of table T100');
    assert.equal(capturedAction?.context, 'sap-abap');
    assert.equal(capturedAction?.dependency, 'independent');
  });
});

describe('Regression — smartAgentEnabled=true behaves identically to undefined', () => {
  it('both return ok=true with same content', async () => {
    const { deps: deps1 } = makeDefaultDeps({
      llmResponses: [{ content: 'result', finishReason: 'stop' }],
    });
    const { deps: deps2 } = makeDefaultDeps({
      llmResponses: [{ content: 'result', finishReason: 'stop' }],
    });

    const r1 = await new SmartAgent(deps1, {
      ...DEFAULT_CONFIG,
      smartAgentEnabled: true,
    }).process('do something');
    const r2 = await new SmartAgent(deps2, DEFAULT_CONFIG).process(
      'do something',
    );

    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.equal(r1.value.content, r2.value.content);
    assert.equal(r1.value.stopReason, r2.value.stopReason);
  });
});

// ---------------------------------------------------------------------------
// DefaultPipeline — ragQueryK propagation
// ---------------------------------------------------------------------------

describe('Regression — ragQueryK propagated through DefaultPipeline', () => {
  it('pipeline context uses agentConfig.ragQueryK when provided', async () => {
    const toolsRag = makeMetadataRag();
    const llm = makeLlm([{ content: 'done', finishReason: 'stop' }]);
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      mainLlm: llm,
      mcpClients: [],
      toolsRag,
      agentConfig: { maxIterations: 10, ragQueryK: 42 },
    });
    const chunks: unknown[] = [];
    await pipeline.execute('test', [], undefined, (chunk) => {
      chunks.push(chunk);
    });
    assert.ok(
      toolsRag.queryCalls.length > 0,
      'toolsRag should have been queried',
    );
    assert.equal(toolsRag.queryCalls[0].k, 42);
  });

  it('pipeline falls back to DEFAULT_CONFIG ragQueryK when no agentConfig', async () => {
    const toolsRag = makeMetadataRag();
    const llm = makeLlm([{ content: 'done', finishReason: 'stop' }]);
    const pipeline = new DefaultPipeline();
    pipeline.initialize({
      mainLlm: llm,
      mcpClients: [],
      toolsRag,
    });
    const chunks: unknown[] = [];
    await pipeline.execute('test', [], undefined, (chunk) => {
      chunks.push(chunk);
    });
    assert.ok(
      toolsRag.queryCalls.length > 0,
      'toolsRag should have been queried',
    );
    assert.equal(toolsRag.queryCalls[0].k, 10);
  });
});
