import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildNamespacedTools } from './build-namespaced-tools.js';
import type { IMcpClient } from './mcp-client.js';
import { defaultToolNamespace } from './tool-namespace.js';
import type { McpTool } from './types.js';

const tool = (name: string): McpTool =>
  ({ name, description: '', inputSchema: {} }) as McpTool;
const fakeClient = (id: string): IMcpClient =>
  ({
    id,
    async listTools() {
      return { ok: true, value: [] };
    },
    async callTool() {
      return { ok: true, value: { content: '' } };
    },
  }) as unknown as IMcpClient;

describe('buildNamespacedTools', () => {
  it('renames colliding tools with the prefix; bindings call the original name', async () => {
    const c0 = fakeClient('c0');
    const c1 = fakeClient('c1');
    const captured: Array<{ id: string; name: string }> = [];
    const spy = (id: string, c: IMcpClient): IMcpClient =>
      ({
        ...c,
        callTool: async (name: string) => {
          captured.push({ id, name });
          return { ok: true, value: { content: '' } };
        },
      }) as unknown as IMcpClient;
    const { tools, toolClientMap } = buildNamespacedTools(
      [
        {
          slotIndex: 0,
          label: 'primary',
          client: spy('c0', c0),
          tools: [tool('Search')],
        },
        {
          slotIndex: 1,
          label: 'secondary',
          client: spy('c1', c1),
          tools: [tool('Search')],
        },
      ],
      defaultToolNamespace,
    );
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'primary__Search',
      'secondary__Search',
    ]);
    await toolClientMap
      .get('secondary__Search')!
      .callTool('secondary__Search', {});
    assert.deepEqual(captured, [{ id: 'c1', name: 'Search' }]); // original name, correct client
  });

  it('unique names stay bare; value is the real client', () => {
    const c0 = fakeClient('c0');
    const { tools, toolClientMap } = buildNamespacedTools(
      [{ slotIndex: 0, client: c0, tools: [tool('OnlyHere')] }],
      defaultToolNamespace,
    );
    assert.deepEqual(
      tools.map((t) => t.name),
      ['OnlyHere'],
    );
    assert.equal(toolClientMap.get('OnlyHere'), c0);
  });

  it('prefix falls back to s${slotIndex} when no label', () => {
    const { tools } = buildNamespacedTools(
      [
        { slotIndex: 0, client: fakeClient('a'), tools: [tool('Go')] },
        { slotIndex: 3, client: fakeClient('b'), tools: [tool('Go')] },
      ],
      defaultToolNamespace,
    );
    assert.deepEqual(tools.map((t) => t.name).sort(), ['s0__Go', 's3__Go']);
  });

  it('fail-fast: a generated name equal to a real bare name', () => {
    assert.throws(
      () =>
        buildNamespacedTools(
          [
            { slotIndex: 0, client: fakeClient('a'), tools: [tool('Search')] },
            { slotIndex: 1, client: fakeClient('b'), tools: [tool('Search')] },
            {
              slotIndex: 2,
              client: fakeClient('c'),
              tools: [tool('s0__Search')],
            },
          ],
          defaultToolNamespace,
        ),
      /* diagnostic */ /s0__Search|unique|collision/i,
    );
  });

  it('fail-fast: custom strategy returns a provider-invalid name', () => {
    const bad = { expose: () => 'server:Search' };
    assert.throws(
      () =>
        buildNamespacedTools(
          [
            { slotIndex: 0, client: fakeClient('a'), tools: [tool('Search')] },
            { slotIndex: 1, client: fakeClient('b'), tools: [tool('Search')] },
          ],
          bad,
        ),
      /invalid|\^\[a-zA-Z0-9_-\]/i,
    );
  });

  it('fail-fast: custom strategy returns an empty name', () => {
    const bad = { expose: () => '' };
    assert.throws(
      () =>
        buildNamespacedTools(
          [{ slotIndex: 0, client: fakeClient('a'), tools: [tool('X')] }],
          bad,
        ),
      /invalid|empty/i,
    );
  });

  it('fail-fast: duplicate slotIndex in perClient entries', () => {
    assert.throws(
      () =>
        buildNamespacedTools(
          [
            { slotIndex: 0, client: fakeClient('a'), tools: [tool('Search')] },
            { slotIndex: 0, client: fakeClient('b'), tools: [tool('Find')] },
          ],
          defaultToolNamespace,
        ),
      /duplicate slotIndex/i,
    );
  });
});
