import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  IAuxiliaryMcpTools,
  McpTool,
  McpToolResult,
  Result,
} from '../index.js';

test('IAuxiliaryMcpTools is a narrow listTools/callTool contract (no healthCheck)', () => {
  const aux: IAuxiliaryMcpTools = {
    async listTools(_options?: CallOptions): Promise<Result<McpTool[], never>> {
      return { ok: true, value: [] };
    },
    async callTool(
      _name: string,
      _args: Record<string, unknown>,
      _options?: CallOptions,
    ): Promise<Result<McpToolResult, never>> {
      return { ok: true, value: { content: 'ok' } };
    },
  };
  // Narrow surface: exactly listTools + callTool, no healthCheck.
  assert.equal(typeof aux.listTools, 'function');
  assert.equal(typeof aux.callTool, 'function');
  assert.equal('healthCheck' in aux, false);
});
