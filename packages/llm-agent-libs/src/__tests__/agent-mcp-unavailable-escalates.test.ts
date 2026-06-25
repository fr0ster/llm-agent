import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  IMcpClient,
  LlmError,
  LlmResponse,
  McpError as McpErrorType,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

const TOOL: McpTool = {
  name: 'GetTable',
  description: 'read table',
  inputSchema: {},
};

/** LLM that asks for GetTable once, then (if reached) returns final text. */
function toolThenText(final: string): ILlm {
  let n = 0;
  const first = (): Result<LlmResponse, LlmError> => ({
    ok: true,
    value: {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c0', name: 'GetTable', arguments: {} }],
    },
  });
  const rest = (): Result<LlmResponse, LlmError> => ({
    ok: true,
    value: { content: final, finishReason: 'stop' },
  });
  return {
    async chat() {
      return ++n === 1 ? first() : rest();
    },
    async *streamChat() {
      yield ++n === 1 ? first() : rest();
    },
  } as ILlm;
}

function clientReturning(
  result: Result<McpToolResult, McpErrorType>,
): IMcpClient {
  return {
    async listTools(): Promise<Result<McpTool[], McpErrorType>> {
      return { ok: true, value: [TOOL] };
    },
    async callTool(): Promise<Result<McpToolResult, McpErrorType>> {
      return result;
    },
  } as IMcpClient;
}

test('availability error in the tool loop fails the run (not tool text)', async () => {
  const client = clientReturning({
    ok: false,
    error: new McpError('Not connected', 'MCP_NOT_CONNECTED'),
  });
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  deps.mainLlm = toolThenText('should not be reached');
  const agent = new SmartAgent(deps, { maxIterations: 5, mode: 'hard' });
  const res = await agent.process('read table T');
  assert.equal(res.ok, false, 'run must fail loud on MCP unavailability');
});

test('a tool-level error does NOT fail the run (stays LLM feedback)', async () => {
  const client = clientReturning({
    ok: false,
    error: new McpError('table not found', 'MCP_ERROR'),
  });
  const { deps } = makeDefaultDeps({ mcpClients: [client] });
  deps.mainLlm = toolThenText('the table does not exist');
  const agent = new SmartAgent(deps, { maxIterations: 5, mode: 'hard' });
  const res = await agent.process('read table T');
  assert.equal(res.ok, true, 'a tool-level error must stay LLM feedback');
});
