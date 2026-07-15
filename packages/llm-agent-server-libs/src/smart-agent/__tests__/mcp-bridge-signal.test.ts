import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { buildMcpBridge } from '../smart-server.js';

test('buildMcpBridge forwards the signal into listTools + callTool', async () => {
  const seen: { list?: AbortSignal; call?: AbortSignal } = {};
  const client = {
    listTools: async (opts?: { signal?: AbortSignal }) => {
      seen.list = opts?.signal;
      return {
        ok: true,
        value: [{ name: 'T', description: '', inputSchema: {} }],
      };
    },
    callTool: async (
      _n: string,
      _a: unknown,
      opts?: { signal?: AbortSignal },
    ) => {
      seen.call = opts?.signal;
      return { ok: true, value: { content: 'r' } };
    },
  } as unknown as IMcpClient;
  const ctrl = new AbortController();
  await buildMcpBridge([client])('T', {}, ctrl.signal);
  assert.equal(seen.list, ctrl.signal);
  assert.equal(seen.call, ctrl.signal);
});
