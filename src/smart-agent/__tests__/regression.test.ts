import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../types.js';
import { SmartAgent } from '../agent.js';
import type { IContextAssembler } from '../interfaces/assembler.js';
import {
  AssemblerError,
  type CallOptions,
  type McpTool,
  type RagResult,
  type Subprompt,
  type ToolCallRecord,
} from '../interfaces/types.js';
import { ToolPolicyGuard } from '../policy/tool-policy-guard.js';
import {
  makeClassifier,
  makeDefaultDeps,
  makeLlm,
  makeMcpClient,
  makeMetadataRag,
  makeRag,
} from '../testing/index.js';

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// Classifier regression
// ---------------------------------------------------------------------------

describe('Regression — 3-type message: fact + state + action', () => {
  it('upserts fact and state stores, processes action', async () => {
    const facts = makeRag();
    const state = makeRag();
    const feedback = makeRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        { type: 'fact', text: 'Paris is the capital of France' },
        { type: 'state', text: 'user mode: dark' },
        { type: 'action', text: 'What is the capital of France?' },
      ]),
      llmResponses: [{ content: 'Paris', finishReason: 'stop' }],
      ragStores: { facts, state, feedback },
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.ok(facts.upsertCalls.includes('Paris is the capital of France'));
    assert.ok(state.upsertCalls.includes('user mode: dark'));
    assert.equal(feedback.upsertCalls.length, 0);
    assert.equal(r.value.content, 'Paris');
  });
});

describe('Regression — feedback subprompt upserted to feedback store', () => {
  it('feedback text goes to ragStores.feedback', async () => {
    const feedback = makeRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([
        { type: 'feedback', text: 'That was wrong' },
      ]),
      ragStores: { feedback },
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');
    assert.ok(feedback.upsertCalls.includes('That was wrong'));
  });
});

describe('Regression — state subprompt only goes to state store', () => {
  it('facts and feedback not touched', async () => {
    const facts = makeRag();
    const feedback = makeRag();
    const state = makeRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([{ type: 'state', text: 'logged_in=true' }]),
      ragStores: { facts, feedback, state },
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    await agent.process('test');
    assert.equal(facts.upsertCalls.length, 0);
    assert.equal(feedback.upsertCalls.length, 0);
    assert.ok(state.upsertCalls.includes('logged_in=true'));
  });
});

// ---------------------------------------------------------------------------
// RAG regression
// ---------------------------------------------------------------------------

describe('Regression — ragQueryK config propagated to all stores', () => {
  it('k=2 passed to all three RAG query calls', async () => {
    const facts = makeMetadataRag();
    const feedback = makeMetadataRag();
    const state = makeMetadataRag();
    const { deps } = makeDefaultDeps({
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
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(r.value.toolCallCount, 1);
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

describe('Regression — denylist policy: denied tool blocked, allowed continues', () => {
  it('two tool calls: first denied, second allowed; toolCallCount=2', async () => {
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
      toolPolicy: new ToolPolicyGuard({ denylist: ['blockedTool'] }),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(r.ok);
    assert.equal(r.value.toolCallCount, 2);
    // blockedTool was denied, should never reach MCP client
    assert.equal(client.callCount, 1, 'only safeTool should call MCP client');
  });
});

describe('Regression — re-assembly error mid-loop → ASSEMBLER_ERROR', () => {
  it('assembler fails on second call; returns ASSEMBLER_ERROR', async () => {
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
        if (assemblerCallCount === 1) {
          return {
            ok: true,
            value: [{ role: 'user', content: 'action text' }],
          };
        }
        return { ok: false, error: new AssemblerError('reassembly failed') };
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
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ASSEMBLER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// SmartAgent config regression
// ---------------------------------------------------------------------------

describe('Regression — sessionPolicy.maxSessionAgeMs sets metadata.ttl', () => {
  it('ttl is a unix timestamp in the future', async () => {
    const facts = makeMetadataRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([{ type: 'fact', text: 'some fact' }]),
      ragStores: { facts },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      sessionPolicy: { maxSessionAgeMs: 60_000 },
    });
    await agent.process('test');
    assert.ok(facts.upsertMetadata.length > 0);
    const ttl = facts.upsertMetadata[0].ttl;
    assert.ok(typeof ttl === 'number', 'ttl should be a number');
    assert.ok(ttl > nowSeconds, 'ttl should be in the future');
  });
});

describe('Regression — sessionPolicy namespace + maxSessionAgeMs both propagated', () => {
  it('metadata has both namespace and ttl', async () => {
    const facts = makeMetadataRag();
    const { deps } = makeDefaultDeps({
      classifier: makeClassifier([{ type: 'fact', text: 'some fact' }]),
      ragStores: { facts },
    });
    const agent = new SmartAgent(deps, {
      ...DEFAULT_CONFIG,
      sessionPolicy: { namespace: 'tenant/user1', maxSessionAgeMs: 30_000 },
    });
    await agent.process('test');
    assert.ok(facts.upsertMetadata.length > 0);
    const meta = facts.upsertMetadata[0];
    assert.equal(meta.namespace, 'tenant/user1');
    assert.ok(typeof meta.ttl === 'number');
  });
});

describe('Regression — helperLlm provided: no error, mainLlm used', () => {
  it('agent constructs and runs normally when helperLlm is set', async () => {
    const helperLlm = makeLlm([
      { content: 'helper response', finishReason: 'stop' },
    ]);
    const { deps } = makeDefaultDeps();
    const agentDeps = { ...deps, helperLlm };
    const agent = new SmartAgent(agentDeps, DEFAULT_CONFIG);
    const r = await agent.process('do something');
    assert.ok(r.ok);
    // helperLlm should not be called (reserved for future use)
    assert.equal(helperLlm.callCount, 0);
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
