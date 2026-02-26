/**
 * End-to-end pipeline smoke tests using the embedded MCP transport.
 *
 * No external processes or HTTP servers are started. The MCP layer is wired
 * in-process via MCPClientWrapper's listToolsHandler + callToolHandler hooks,
 * wrapped by McpClientAdapter so it satisfies the IMcpClient interface.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MCPClientWrapper } from '../../mcp/client.js';
import { McpClientAdapter } from '../adapters/mcp-client-adapter.js';
import { SmartAgent } from '../agent.js';
import type { IMcpClient } from '../interfaces/mcp-client.js';
import type { McpTool } from '../interfaces/types.js';
import { ToolPolicyGuard } from '../policy/tool-policy-guard.js';
import { SmartAgentServer } from '../server.js';
import {
  makeAssembler,
  makeClassifier,
  makeDefaultDeps,
  makeLlm,
  makeRag,
} from '../testing/index.js';

// ---------------------------------------------------------------------------
// Helper: build an IMcpClient backed by embedded MCPClientWrapper
// ---------------------------------------------------------------------------

async function makeEmbeddedMcpClient(
  tools: McpTool[],
  callHandler: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: string }>,
): Promise<IMcpClient> {
  const wrapper = new MCPClientWrapper({
    listToolsHandler: async () => tools,
    callToolHandler: callHandler,
  });
  await wrapper.connect(); // populates this.tools for embedded mode
  return new McpClientAdapter(wrapper);
}

const DEFAULT_CONFIG = { maxIterations: 5 };

// ---------------------------------------------------------------------------
// E2E: one tool call end-to-end
// ---------------------------------------------------------------------------

describe('E2E — embedded MCP + stub LLM: one tool call', () => {
  it('tool executed via adapter; final response returned', async () => {
    const mcpClient = await makeEmbeddedMcpClient(
      [{ name: 'echo', description: 'Echo the message', inputSchema: {} }],
      async (_name, args) => ({
        content: `echo: ${(args as { message?: string }).message ?? ''}`,
      }),
    );

    const { deps } = makeDefaultDeps({
      mcpClients: [mcpClient],
      llmResponses: [
        {
          content: 'calling echo',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'c1', name: 'echo', arguments: { message: 'hello' } },
          ],
        },
        { content: 'Echo returned: echo: hello', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('say hello');

    assert.ok(r.ok);
    assert.equal(r.value.toolCallCount, 1);
    assert.equal(r.value.content, 'Echo returned: echo: hello');
    assert.equal(r.value.stopReason, 'stop');
  });
});

// ---------------------------------------------------------------------------
// E2E: no tools requested
// ---------------------------------------------------------------------------

describe('E2E — embedded MCP: LLM stops without tool calls', () => {
  it('toolCallCount=0, iterations=1', async () => {
    const mcpClient = await makeEmbeddedMcpClient(
      [{ name: 'echo', description: 'Echo', inputSchema: {} }],
      async () => ({ content: 'unreachable' }),
    );

    const { deps } = makeDefaultDeps({
      mcpClients: [mcpClient],
      llmResponses: [{ content: 'direct answer', finishReason: 'stop' }],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('just answer');

    assert.ok(r.ok);
    assert.equal(r.value.toolCallCount, 0);
    assert.equal(r.value.iterations, 1);
    assert.equal(r.value.content, 'direct answer');
  });
});

// ---------------------------------------------------------------------------
// E2E: tool handler throws → error result, pipeline continues
// ---------------------------------------------------------------------------

describe('E2E — embedded MCP: callToolHandler throws → isError result, pipeline continues', () => {
  it('error injected as tool result; orchestrator recovers', async () => {
    const mcpClient = await makeEmbeddedMcpClient(
      [{ name: 'flaky', description: 'Flaky tool', inputSchema: {} }],
      async () => {
        throw new Error('tool unavailable');
      },
    );

    const { deps } = makeDefaultDeps({
      mcpClients: [mcpClient],
      llmResponses: [
        {
          content: 'calling flaky',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'flaky', arguments: {} }],
        },
        { content: 'recovered', finishReason: 'stop' },
      ],
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');

    assert.ok(r.ok);
    assert.equal(r.value.toolCallCount, 1);
    assert.equal(r.value.content, 'recovered');
  });
});

// ---------------------------------------------------------------------------
// E2E: ToolPolicyGuard blocks tool before it reaches callToolHandler
// ---------------------------------------------------------------------------

describe('E2E — embedded MCP + ToolPolicyGuard: blocked tool never reaches handler', () => {
  it('callToolHandler call count is 0 for blocked tool', async () => {
    let handlerCallCount = 0;
    const mcpClient = await makeEmbeddedMcpClient(
      [{ name: 'restrictedTool', description: 'Restricted', inputSchema: {} }],
      async () => {
        handlerCallCount++;
        return { content: 'should not be called' };
      },
    );

    const { deps } = makeDefaultDeps({
      mcpClients: [mcpClient],
      llmResponses: [
        {
          content: 'calling restricted',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'restrictedTool', arguments: {} }],
        },
        { content: 'blocked and done', finishReason: 'stop' },
      ],
      toolPolicy: new ToolPolicyGuard({ allowlist: ['safeTool'] }),
    });
    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const r = await agent.process('test');

    assert.ok(r.ok);
    assert.equal(
      handlerCallCount,
      0,
      'handler must not be called for blocked tool',
    );
    assert.equal(
      r.value.toolCallCount,
      1,
      'toolCallCount incremented even for blocked',
    );
  });
});

// ---------------------------------------------------------------------------
// E2E: SmartAgentServer HTTP round-trip with embedded MCP
// ---------------------------------------------------------------------------

describe('E2E — SmartAgentServer wraps embedded-MCP SmartAgent: HTTP round-trip', () => {
  it('POST /v1/chat/completions returns 200 with expected content', async () => {
    const mcpClient = await makeEmbeddedMcpClient(
      [{ name: 'greet', description: 'Greet', inputSchema: {} }],
      async (_name, args) => ({
        content: `Hello, ${(args as { name?: string }).name ?? 'world'}!`,
      }),
    );

    const llm = makeLlm([
      {
        content: 'greeting the user',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'greet', arguments: { name: 'Alice' } }],
      },
      { content: 'The greeting was: Hello, Alice!', finishReason: 'stop' },
    ]);

    const facts = makeRag();
    const deps = {
      mainLlm: llm,
      mcpClients: [mcpClient],
      ragStores: { facts, feedback: makeRag(), state: makeRag() },
      classifier: makeClassifier([{ type: 'action', text: 'greet Alice' }]),
      assembler: makeAssembler(),
    };

    const agent = new SmartAgent(deps, DEFAULT_CONFIG);
    const server = new SmartAgentServer(agent, { port: 0 });
    const handle = await server.start();

    try {
      const port = handle.port;
      const response = await fetch(
        `http://localhost:${port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'smart-agent',
            messages: [{ role: 'user', content: 'greet Alice' }],
          }),
        },
      );

      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
      };
      assert.equal(
        body.choices[0].message.content,
        'The greeting was: Hello, Alice!',
      );
      assert.equal(body.choices[0].finish_reason, 'stop');
    } finally {
      await handle.close();
    }
  });
});
