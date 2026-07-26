import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, McpTool } from './mcp-client.js';
import { bindToolCallName, defaultToolNamespace } from './tool-namespace.js';

describe('defaultToolNamespace', () => {
  it('bare when not colliding', () => {
    assert.equal(
      defaultToolNamespace.expose({
        toolName: 'Search',
        prefix: 's0',
        colliding: false,
      }),
      'Search',
    );
  });
  it('prefixed with `__` when colliding', () => {
    assert.equal(
      defaultToolNamespace.expose({
        toolName: 'Search',
        prefix: 'primary',
        colliding: true,
      }),
      'primary__Search',
    );
  });
});

describe('bindToolCallName', () => {
  it('callTool always uses the original name, ignoring the exposed name passed in', async () => {
    const calls: string[] = [];
    const real = {
      async listTools() {
        return { ok: true, value: [] as McpTool[] };
      },
      async callTool(name: string) {
        calls.push(name);
        return { ok: true, value: { content: name } };
      },
    } as unknown as IMcpClient;
    const bound = bindToolCallName(real, 'Search');
    await bound.callTool('primary__Search', {});
    assert.deepEqual(calls, ['Search']); // original, not the exposed name
  });
  it('proxies listTools (and healthCheck when present) unchanged', async () => {
    let listed = false;
    const real = {
      async listTools() {
        listed = true;
        return { ok: true, value: [] as McpTool[] };
      },
      async callTool() {
        return { ok: true, value: { content: '' } };
      },
    } as unknown as IMcpClient;
    await bindToolCallName(real, 'X').listTools();
    assert.equal(listed, true);
  });
});
