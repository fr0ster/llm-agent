import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgent, SmartServer } from '../smart-server.js';

test('SmartServer accepts BuildAgentDeps and uses the injected makeLlm', async () => {
  let llmCalls = 0;
  const cannedLlm = {
    chat: async () => ({ content: '', toolCalls: [] }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const server = new SmartServer(
    {
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    {
      makeLlm: async () => {
        llmCalls++;
        return cannedLlm;
      },
    },
  );
  assert.ok(server);
  assert.equal(
    typeof (server as unknown as { _deps: unknown })._deps,
    'object',
  );
  // The constructor only CAPTURES the seam; it must not eagerly build an LLM.
  assert.equal(llmCalls, 0);
});

// (a) P1a — the COORDINATED controller agent runs, not the infra passthrough.
test('buildAgent returns the controller pipeline agent (coordinator is exercised)', async () => {
  let plannerSawPlanPrompt = false;
  const cannedLlm = {
    chat: async (msgs: unknown) => {
      const text = JSON.stringify(msgs);
      if (/plan|step|goal/i.test(text)) plannerSawPlanPrompt = true;
      return { ok: true, value: { content: '{"plan":[]}', toolCalls: [] } };
    },
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = {
    embed: async () => ({ vector: [0, 0, 0] }),
  } as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  const { agent, close } = await buildAgent(
    {
      skipModelValidation: true,
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
      pipeline: {
        name: 'controller',
        config: {
          subagents: {
            evaluator: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' },
            planner: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' },
            executor: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' },
          },
        },
      },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    { makeLlm: async () => cannedLlm, embedder: stubEmbedder },
  );
  assert.equal(typeof agent.process, 'function');
  await agent.process('do a task');
  assert.equal(
    plannerSawPlanPrompt,
    true,
    'controller coordinator must invoke the planner LLM',
  );
  await close();
});

// (b) P1b — with mcp in config AND a throwing connectMcp, build still succeeds.
test('buildAgent does NOT connect MCP when connectMcp is stubbed (no real connect)', async () => {
  const cannedLlm = {
    chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = {
    embed: async () => ({ vector: [0] }),
  } as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  const { agent, close } = await buildAgent(
    {
      skipModelValidation: true,
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
      mcp: {
        type: 'http',
        url: 'http://127.0.0.1:9/should-not-connect/mcp/stream/http',
      },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    {
      makeLlm: async () => cannedLlm,
      embedder: stubEmbedder,
      connectMcp: async () => {
        throw new Error('connectMcp must not run when clients are injectable');
      },
      mcpClients: [],
    },
  );
  assert.equal(typeof agent.process, 'function');
  await close();
});

// (c) P1b — WITHOUT mcpClients, the injected connectMcp is the single provisioning point.
test('buildAgent provisions via injected connectMcp when no mcpClients (called once)', async () => {
  const cannedLlm = {
    chat: async () => ({ ok: true, value: { content: 'ok', toolCalls: [] } }),
    model: 'stub',
  } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
  const stubEmbedder = {
    embed: async () => ({ vector: [0] }),
  } as unknown as import('@mcp-abap-adt/llm-agent').IEmbedder;
  let connectCalls = 0;
  const { agent, close } = await buildAgent(
    {
      skipModelValidation: true,
      llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
      mcp: {
        type: 'http',
        url: 'http://127.0.0.1:9/should-not-self-connect/mcp/stream/http',
      },
    } as unknown as import('../smart-server.js').SmartServerConfig,
    {
      makeLlm: async () => cannedLlm,
      embedder: stubEmbedder,
      connectMcp: async () => {
        connectCalls++;
        return [];
      },
    },
  );
  assert.equal(typeof agent.process, 'function');
  assert.equal(
    connectCalls,
    1,
    'injected connectMcp must be the single provisioning point',
  );
  await close();
});
