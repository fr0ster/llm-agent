import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNamespacedTools } from './build-namespaced-tools.js';
import { collectServerDescriptors } from './collect-server-descriptors.js';
import type { IMcpClient } from './mcp-client.js';
import { resolveClientDescriptors } from './resolve-client-descriptors.js';

const migrationMessage =
  /Multiple MCP clients require a descriptor label for every client.*withMcpClients\(\).*withMcpServers\(\).*label.*named mcp: entries/;

test('multiple clients without descriptors fail with both migration paths', () => {
  for (const count of [2, 3]) {
    assert.throws(
      () => resolveClientDescriptors(count, undefined, 'withMcpClients'),
      migrationMessage,
    );
  }
});

test('multiple descriptors without labels and mixed labels fail', () => {
  for (const descriptors of [
    [{ slotIndex: 0 }, { slotIndex: 1 }],
    [{ slotIndex: 0, label: 'first' }, { slotIndex: 1 }],
    [{ slotIndex: 0 }, { slotIndex: 1, label: 'second' }],
  ]) {
    assert.throws(
      () => resolveClientDescriptors(2, descriptors, 'test'),
      migrationMessage,
    );
  }
});

test('labeled slots preserve identity on reorder', () => {
  const descriptors = [
    { slotIndex: 5, label: 'first' },
    { slotIndex: 2, label: 'second' },
  ];
  assert.deepEqual(
    resolveClientDescriptors(2, descriptors, 'test'),
    descriptors,
  );
  const reversed = [...descriptors].reverse();
  assert.deepEqual(resolveClientDescriptors(2, reversed, 'test'), reversed);
});

test('empty and whitespace-only descriptor labels fail even for one client', () => {
  for (const label of ['', '   ']) {
    assert.throws(
      () => resolveClientDescriptors(1, [{ slotIndex: 0, label }], 'test'),
      /descriptor label must not be empty.*withMcpServers\(\).*named mcp: entries/,
    );
  }
});

test('one unlabeled client resolves to s0 for tool namespacing', () => {
  const client: IMcpClient = {
    async listTools() {
      return { ok: true, value: [] };
    },
    async callTool() {
      return { ok: true, value: { content: [] } };
    },
  };
  const [descriptor] = resolveClientDescriptors(1, undefined, 'test');
  const result = buildNamespacedTools(
    [
      {
        ...descriptor,
        client,
        tools: [{ name: 'Search', description: 'Search', inputSchema: {} }],
      },
    ],
    { expose: ({ prefix, toolName }) => `${prefix}__${toolName}` },
  );
  assert.equal(result.tools[0].name, 's0__Search');
});

test('multiple undescribed servers fail before starting', () => {
  let starts = 0;
  const server = {
    async start(): Promise<IMcpClient> {
      starts++;
      throw new Error('must not start');
    },
    async stop() {},
  };
  assert.throws(
    () => collectServerDescriptors([server, server], 'withMcpServers'),
    migrationMessage,
  );
  assert.equal(starts, 0);
});
